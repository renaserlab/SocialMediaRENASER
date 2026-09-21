"""El pedido físico: reserva, estados y conciliación. Las 0077 y 0078.

QUÉ ORDEN SIGUE UNA COMPRA, Y POR QUÉ ESE:

  1. se bloquea el carrito —es la fila que ordena todo lo de esa persona—;
  2. se relee producto, versión, variante, precio, moneda y publicación;
  3. se comprueba la jurisdicción y que su política esté publicada y vigente;
  4. se crea el pedido con TODO copiado: nombres, precios y condiciones;
  5. se bloquean las filas de inventario EN ORDEN ESTABLE y se reserva;
  6. se confirma la transacción entera;
  7. **y solo entonces** se intenta abrir el cobro en la pasarela.

EL PASO 7 VA FUERA A PROPÓSITO. Abrir el checkout es una llamada HTTP que puede
tardar segundos o no contestar: hacerla dentro dejaría la transacción —y con
ella las filas de inventario bloqueadas— esperando a un tercero. Y si falla, el
pedido existe y sigue pendiente de pago, que es la verdad; no se queda fingiendo
que hay un cobro abierto.

EL ORDEN ESTABLE DEL PASO 5 NO ES ESTÉTICA. Dos compras que tocan las mismas dos
unidades en orden distinto se abrazan: la primera tiene A y quiere B, la segunda
tiene B y quiere A. Ordenar por `(producto, SKU)` hace que ese abrazo no pueda
formarse.

TODO O NADA EN LAS LÍNEAS. Si a la tercera línea le falta una unidad, no se
reserva ninguna: la transacción entera se deshace. Medio pedido reservado es
inventario apartado por una compra que nadie va a completar.

LA RESERVA NO LA GUARDA ESTE MÓDULO: la guarda `product_inventory.reserved`, con
su movimiento en `inventory_movements` y su clave de idempotencia. Aquí solo
viven el HASTA CUÁNDO y el YA SE DECIDIÓ.

Y `reservation_settled_at` SIGNIFICA «ESTA RESERVA YA SE DECIDIÓ», no «se
soltó». Se pone al liberar —cancelación, vencimiento— y también al cobrar: un
pedido pagado deja de estar sujeto al vencimiento y sus unidades quedan
comprometidas hasta que salgan del almacén, que es del Incremento 6. El estado
dice cuál de las dos cosas pasó; la marca sirve para que LIBERAR OCURRA UNA VEZ.

NADIE COBRA AQUÍ. Marcar pagado es cosa de un aviso verificado de la pasarela, y
solo de eso. La vuelta del navegador no confirma dinero, y ningún administrador
puede escribir `PAID`.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.exceptions import (
    AppError,
    ConflictError,
    NotFoundError,
    ValidationAppError,
)
from app.modules.products import carts, esquema, inventory, politicas
from app.modules.products.models import (
    PEDIDO_CANCELADO,
    PEDIDO_EN_CURSO,
    PEDIDO_EN_REVISION,
    PEDIDO_FALLIDO,
    PEDIDO_PAGADO,
    PEDIDO_PENDIENTE,
    PEDIDO_PROCESANDO,
    PEDIDO_RETIENE,
    PEDIDO_VENCIDO,
    ProductCartItem,
    ProductOrder,
    ProductOrderAddress,
    ProductOrderEvent,
    ProductOrderItem,
    ProductSeller,
)

logger = logging.getLogger("renaser.products")

#: El prefijo de las claves de idempotencia con las que este módulo mueve el
#: almacén. Determinista y atado al pedido: un reintento no reserva dos veces, y
#: lo garantiza el índice único de `inventory_movements`, no un `if` nuestro.
CLAVE_DE_RESERVA = "po-res-"
CLAVE_DE_LIBERACION = "po-rel-"

#: Países donde la dirección no se entiende sin distrito. No es una lista de
#: países donde se vende —eso lo dicen las políticas publicadas—: es una regla
#: de formato postal.
PAISES_CON_DISTRITO = frozenset({"PE"})


# --------------------------------------------------------------------------- #
# Los fallos, con su código
# --------------------------------------------------------------------------- #
class VentaNoDisponible(AppError):
    """Hoy no se puede cobrar un producto físico, y se dice por qué.

    503 Y CON LA LISTA DE LO QUE FALTA. Un 403 haría pensar que es un problema
    de permisos de quien pregunta, y no lo es: es que la empresa no ha terminado
    de configurar la venta.
    """

    status_code = 503
    code = "product_sales_not_enabled"

    def __init__(self, faltan: list[str]) -> None:
        super().__init__(
            "La compra de productos todavía no está habilitada.",
            details={"pending": faltan},
        )


class CarritoNoComprable(ConflictError):
    code = "product_cart_not_purchasable"


class VariosProveedores(ConflictError):
    """El carrito mezcla proveedores y nadie ha decidido el checkout conjunto.

    NO SE COBRA EN SILENCIO A VARIOS. Repartir un cobro entre proveedores exige
    saber quién responde de qué y cómo se liquida, y eso no está decidido: se
    pide elegir uno.
    """

    code = "product_cart_multiple_sellers"


class ClaveReutilizada(ConflictError):
    code = "product_order_key_reused"


class YaHayPedido(ConflictError):
    code = "product_order_already_open"


class PedidoNoPagable(ConflictError):
    code = "product_order_not_payable"


class PagoNoCuadra(ConflictError):
    code = "product_order_payment_mismatch"


class DireccionInvalida(ValidationAppError):
    code = "product_address_invalid"


# --------------------------------------------------------------------------- #
# Piezas
# --------------------------------------------------------------------------- #
def ahora() -> datetime:
    return datetime.now(timezone.utc)


def comparable(fecha: datetime | None, referencia: datetime) -> datetime | None:
    """La fecha con zona. SQLite las devuelve sin ella aunque la columna la
    declare, y comparar una con zona contra otra sin ella revienta en medio de
    una compra.

    PÚBLICA porque el envío tiene el mismo problema con las mismas columnas:
    dos copias de esta corrección son dos sitios donde olvidarla."""
    if fecha is None:
        return None
    if fecha.tzinfo is None:
        return fecha.replace(tzinfo=timezone.utc)
    return fecha


def por_que_no_se_puede_vender() -> list[str]:
    """Qué falta, hoy, para poder cobrar un producto. Lista vacía = se puede.

    CINCO COSAS, Y ENCENDER UNA NO BASTA. Se devuelven TODAS las que faltan y
    no la primera: una a una, quien configura enciende una bandera, lo prueba,
    vuelve a fallar y no sabe cuántas quedan.
    """
    ajustes = get_settings()
    faltan: list[str] = []
    if not ajustes.feature_product_sales:
        faltan.append("feature_product_sales")
    if not ajustes.payments_enabled:
        faltan.append("payments_enabled")
    if not ajustes.stripe_payments_enabled:
        faltan.append("stripe_payments_enabled")
    if not ajustes.reserva_de_productos_configurada:
        faltan.append("product_reservation_minutes")
    if not (ajustes.stripe_secret_key or "").strip():
        faltan.append("stripe_secret_key")
    return faltan


def exigir_venta_habilitada() -> None:
    faltan = por_que_no_se_puede_vender()
    if faltan:
        raise VentaNoDisponible(faltan)


def huella_del_cuerpo(cuerpo: dict) -> str:
    """La huella de lo que se pidió, para saber si un reintento es el mismo.

    ORDENADA Y SIN ESPACIOS: dos peticiones idénticas con las claves en otro
    orden son la misma petición, y tratarlas como distintas convertiría un
    reintento legítimo en un conflicto.
    """
    texto = json.dumps(cuerpo, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(texto.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Direccion:
    """La dirección de ESTE envío, ya validada."""

    recipient_name: str
    phone: str
    country_code: str
    region: str
    city: str
    district: str | None
    address_line: str
    reference: str | None
    postal_code: str | None
    instructions: str | None


def validar_direccion(datos: dict) -> Direccion:
    """Comprueba lo obligatorio y las longitudes. NO inventa nada.

    NI COORDENADAS NI DOCUMENTO DE IDENTIDAD. Para entregar un paquete basta la
    dirección escrita; guardar lo que no hace falta es guardar lo que se puede
    filtrar.
    """

    def campo(nombre: str, minimo: int, maximo: int, obligatorio: bool) -> str | None:
        valor = (datos.get(nombre) or "").strip()
        if not valor:
            if obligatorio:
                raise DireccionInvalida(
                    "Falta un dato de la dirección de entrega.",
                    details={"field": nombre},
                )
            return None
        if not (minimo <= len(valor) <= maximo):
            raise DireccionInvalida(
                "Ese dato de la dirección no tiene una longitud válida.",
                details={"field": nombre, "min": minimo, "max": maximo},
            )
        return valor

    pais = politicas.normalizar_pais(datos.get("country_code"))
    if not pais:
        raise DireccionInvalida(
            "Falta el país de la dirección de entrega.",
            details={"field": "country_code"},
        )

    #: EL DISTRITO ES OBLIGATORIO DONDE LA DIRECCIÓN NO SE ENTIENDE SIN ÉL. En
    #: Perú un envío sin distrito no llega; en otros países no existe ese nivel
    #: y exigirlo obligaría a inventárselo.
    distrito = campo("district", 1, 120, pais in PAISES_CON_DISTRITO)

    return Direccion(
        recipient_name=campo("recipient_name", 2, 150, True) or "",
        phone=campo("phone", 5, 30, True) or "",
        country_code=pais,
        region=campo("region", 1, 120, True) or "",
        city=campo("city", 1, 120, True) or "",
        district=distrito,
        address_line=campo("address_line", 5, 300, True) or "",
        reference=campo("reference", 1, 300, False),
        postal_code=campo("postal_code", 2, 20, False),
        instructions=campo("instructions", 1, 500, False),
    )


# --------------------------------------------------------------------------- #
# ¿Se puede comprar? Lo que se pregunta antes de enseñar el checkout
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class GrupoDeProveedor:
    """Lo del carrito que es de un mismo proveedor."""

    seller_id: str
    seller_name: str
    item_ids: list[str]
    units: int
    currency: str | None
    subtotal_minor: int | None
    purchasable: bool
    issues: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Preparacion:
    """Si hoy se puede comprar, y qué falta si no."""

    disponible: bool
    #: Lo que falta del lado de la empresa: banderas y configuración.
    pending_configuration: list[str] = field(default_factory=list)
    #: Dónde hay política publicada y vigente. Vacío = en ningún sitio.
    countries_with_policy: list[str] = field(default_factory=list)
    groups: list[GrupoDeProveedor] = field(default_factory=list)
    #: Un pedido vivo que hay que terminar o cancelar antes de abrir otro.
    open_order_id: str | None = None


async def preparar(db: AsyncSession, *, usuario_id: str) -> Preparacion:
    """Qué se puede comprar hoy, agrupado por proveedor.

    NO RESERVA NADA y no falla por que la venta esté apagada: esta ruta existe
    justamente para contar por qué. Un 503 aquí dejaría a la pantalla sin poder
    explicar nada.
    """
    if not await esquema.hay_pedidos(db):
        return Preparacion(disponible=False, pending_configuration=["migration_0078"])

    faltan = por_que_no_se_puede_vender()
    if not await esquema.hay_politicas(db):
        faltan.append("migration_0077")
    paises = await politicas.paises_con_politica(db)
    if not paises:
        faltan.append("product_policy")

    carrito = await carts.leer(db, usuario_id=usuario_id)
    por_proveedor: dict[str, list] = {}
    nombres: dict[str, str] = {}
    for linea in carrito.items:
        por_proveedor.setdefault(linea.seller_id, []).append(linea)
        nombres[linea.seller_id] = linea.seller_name

    grupos: list[GrupoDeProveedor] = []
    for seller_id, lineas in por_proveedor.items():
        comprables = [l for l in lineas if l.purchasable]
        problemas = sorted({i for l in lineas for i in l.issues if i in carts.BLOQUEANTES})
        monedas = {l.currency for l in comprables if l.currency}
        subtotal = (
            sum(int(l.line_total_minor or 0) for l in comprables) if comprables else None
        )
        grupos.append(
            GrupoDeProveedor(
                seller_id=seller_id,
                seller_name=nombres.get(seller_id, ""),
                item_ids=[l.item_id for l in lineas],
                units=sum(int(l.quantity) for l in lineas),
                currency=next(iter(monedas)) if len(monedas) == 1 else None,
                subtotal_minor=subtotal,
                #: COMPRABLE ES: todas sus líneas comprables, una sola moneda y
                #: nada bloqueado. Un grupo «casi comprable» no existe.
                purchasable=bool(comprables)
                and len(comprables) == len(lineas)
                and len(monedas) == 1
                and not problemas,
                issues=problemas,
            )
        )
    grupos.sort(key=lambda g: g.seller_name.lower())

    #: EL MISMO CRITERIO QUE EL CANDADO DE `crear`: el que todavía aparta.
    abierto = await db.scalar(
        select(ProductOrder.id)
        .where(
            ProductOrder.buyer_id == usuario_id,
            ProductOrder.status.in_(PEDIDO_RETIENE),
            ProductOrder.reservation_settled_at.is_(None),
        )
        .order_by(ProductOrder.created_at.desc())
        .limit(1)
    )

    return Preparacion(
        disponible=not faltan,
        pending_configuration=faltan,
        countries_with_policy=paises,
        groups=grupos,
        open_order_id=abierto,
    )


# --------------------------------------------------------------------------- #
# Crear el pedido y reservar
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class PedidoCreado:
    orden: ProductOrder
    estrenado: bool


async def _anotar(
    db: AsyncSession,
    *,
    orden: ProductOrder,
    desde: str | None,
    hasta: str,
    actor_id: str | None,
    actor_rol: str,
    motivo: str | None = None,
) -> None:
    """Un renglón del historial. SIN DATOS PERSONALES: ni nombre, ni teléfono,
    ni dirección. El historial se lee para auditar un estado, no para recomponer
    a quién se le mandó qué."""
    db.add(
        ProductOrderEvent(
            order_id=orden.id,
            from_status=desde,
            to_status=hasta,
            actor_id=actor_id,
            actor_role=actor_rol,
            reason=(motivo or "").strip()[:500] or None,
            created_at=ahora(),
        )
    )


def por_unidad_de_almacen(lineas) -> list[tuple[str, str, int]]:
    """`(producto, SKU, cantidad)` sumado y EN ORDEN ESTABLE.

    PUBLICA, Y NO POR COMODIDAD. El despacho del Incremento 6 tiene que repartir
    exactamente igual que la reserva: si sumara por línea en vez de por unidad
    de almacén, o si ordenara distinto, sacaría del almacén un reparto que no es
    el que se apartó. Dos copias de esta regla es exactamente cómo se duplica el
    fallo, así que hay una sola y la usan los dos.

    SE SUMA POR (PRODUCTO, SKU) Y NO POR LÍNEA. Dos variantes distintas pueden
    compartir la caja del almacén; reservarlas por separado usaría la misma
    clave de idempotencia dos veces y la segunda se tragaría como si fuera un
    reintento: unidades vendidas que nunca se apartaron.

    Y EN ORDEN ESTABLE porque es lo que impide que dos compras simultáneas sobre
    las mismas dos unidades se abracen.
    """
    suma: dict[tuple[str, str], int] = {}
    for linea in lineas:
        clave = (linea.product_id, (linea.sku or "").strip())
        suma[clave] = suma.get(clave, 0) + int(linea.quantity)
    return [(p, s, c) for (p, s), c in sorted(suma.items())]


async def crear(
    db: AsyncSession,
    *,
    usuario_id: str,
    seller_id: str,
    direccion: dict,
    policy_id: str,
    policy_terms_sha256: str,
    clave: str,
    momento: datetime | None = None,
) -> PedidoCreado:
    """Convierte lo que hay en el carrito de UN proveedor en un pedido reservado.

    UNA SOLA TRANSACCIÓN, y el cobro se abre después. Ver la cabecera.
    """
    await esquema.exigir_pedidos(db)
    await esquema.exigir_politicas(db)
    await esquema.exigir_carrito(db)
    await esquema.exigir_inventario(db)
    exigir_venta_habilitada()

    clave = (clave or "").strip()
    if not clave:
        raise ValidationAppError(
            "Falta la clave de idempotencia.",
            code="product_order_key_missing",
            details={"header": "Idempotency-Key"},
        )

    datos = validar_direccion(direccion)
    momento = momento or ahora()
    ajustes = get_settings()

    #: LA HUELLA DE LO QUE SE PIDIÓ. Reintentar con la misma clave y otro
    #: contenido no es reintentar: es otra compra con la etiqueta de la anterior.
    huella = huella_del_cuerpo(
        {
            "seller_id": seller_id,
            "policy_id": policy_id,
            "policy_terms_sha256": policy_terms_sha256,
            "address": datos.__dict__,
        }
    )

    # --- El cerrojo del carrito, que ordena todo lo de esta persona ------- #
    carrito_fila = await carts._carrito_bloqueado(
        db, usuario_id=usuario_id, crear=False
    )

    # --- Idempotencia, ANTES de mirar nada más --------------------------- #
    ya = await db.scalar(
        select(ProductOrder).where(
            ProductOrder.buyer_id == usuario_id,
            ProductOrder.idempotency_key == clave,
        )
    )
    if ya is not None:
        distinto = (ya.request_fingerprint or "") != huella
        await db.commit()
        if distinto:
            raise ClaveReutilizada(
                "Esa clave ya se usó para otro pedido.",
                details={"order_id": ya.id},
            )
        return PedidoCreado(ya, estrenado=False)

    if carrito_fila is None:
        await db.rollback()
        raise CarritoNoComprable("Tu bolsa está vacía.")

    # --- Un pedido vivo a la vez ----------------------------------------- #
    #: NO ES UNA REGLA COMERCIAL, ES UNA PROTECCIÓN DEL ALMACÉN. Abrir pedidos
    #: sin pagar ninguno apartaría existencias sin límite mientras la reserva
    #: siga viva. Se dice cuál es para poder ir a terminarlo o cancelarlo.
    #:
    #: SE MIRA SI TODAVÍA APARTA, no si todavía se puede pagar. Con
    #: `PEDIDO_EN_CURSO` un pedido fallido no contaba, y el mismo comprador
    #: podía encadenar intentos apartando cada vez más existencias. En cuanto
    #: la reserva se suelta —al cancelar, al vencer— el candado se levanta
    #: solo, porque lo que lo cierra es `reservation_settled_at`.
    abierto = await db.scalar(
        select(ProductOrder).where(
            ProductOrder.buyer_id == usuario_id,
            ProductOrder.status.in_(PEDIDO_RETIENE),
            ProductOrder.reservation_settled_at.is_(None),
        )
    )
    if abierto is not None:
        detalle = {"order_id": abierto.id, "status": abierto.status}
        await db.rollback()
        raise YaHayPedido(
            "Ya tienes un pedido esperando pago.", details=detalle
        )

    # --- El proveedor ----------------------------------------------------- #
    vendedor = await db.get(ProductSeller, seller_id)
    if vendedor is None:
        await db.rollback()
        raise NotFoundError(
            "Proveedor no encontrado.", code="product_seller_not_found"
        )

    # --- El carrito, releído entero -------------------------------------- #
    carrito = await carts.leer(db, usuario_id=usuario_id)
    mias = [l for l in carrito.items if l.seller_id == seller_id]
    ajenas = [l for l in carrito.items if l.seller_id != seller_id]
    if not mias:
        await db.rollback()
        raise CarritoNoComprable(
            "No hay nada de ese proveedor en tu bolsa.",
            details={"seller_id": seller_id},
        )
    if ajenas and not seller_id:
        await db.rollback()
        raise VariosProveedores("Elige de qué proveedor quieres comprar.")

    #: UNA VERSIÓN REPUBLICADA BLOQUEA LA COMPRA, aunque en la bolsa solo
    #: avise. La línea del carrito apunta a la versión con la que se metió, y
    #: `precio_de` lee el precio DE ESA VERSIÓN: si el proveedor republicó, el
    #: pedido se congelaría al precio de una versión que ya no está en catálogo
    #: —ni el que se ofrece hoy ni el que nadie acepta— y el cobro saldría por
    #: ese importe. En la bolsa basta con avisar; para cobrar, no.
    bloqueantes = set(carts.BLOQUEANTES) | {carts.VERSION_CAMBIO}
    bloqueadas = sorted({i for l in mias for i in l.issues if i in bloqueantes})
    if bloqueadas:
        detalle = {"issues": bloqueadas}
        await db.rollback()
        raise CarritoNoComprable(
            "Algo de tu bolsa ya no se puede comprar.", details=detalle
        )
    if not all(l.purchasable for l in mias):
        await db.rollback()
        raise CarritoNoComprable("Algo de tu bolsa ya no se puede comprar.")

    monedas = {l.currency for l in mias if l.currency}
    if len(monedas) != 1:
        detalle = {"currencies": sorted(m for m in monedas if m)}
        await db.rollback()
        raise carts.MonedaIncompatible(
            "Esa bolsa tiene más de una moneda.", details=detalle
        )
    moneda = next(iter(monedas))

    #: NINGUNA LÍNEA SIN PRECIO, y `None` no vale como cero. `purchasable` ya lo
    #: garantiza, pero se comprueba otra vez porque de aquí sale el importe que
    #: se va a cobrar y un `None` convertido en cero es un producto regalado.
    if any(l.unit_price_minor is None or l.line_total_minor is None for l in mias):
        await db.rollback()
        raise CarritoNoComprable("Hay algo sin precio configurado en tu bolsa.")

    subtotal = sum(int(l.line_total_minor) for l in mias)
    from app.modules.products.models import MAXIMO_SEGURO_EN_JS

    if subtotal <= 0 or subtotal > MAXIMO_SEGURO_EN_JS:
        detalle = {"subtotal_minor": subtotal}
        await db.rollback()
        raise CarritoNoComprable(
            "El importe de esa bolsa no es un importe que se pueda cobrar.",
            details=detalle,
        )

    # --- La política de la jurisdicción ---------------------------------- #
    politica = await politicas.exigir_vigente(
        db, pais=datos.country_code, momento=momento
    )
    #: LO QUE SE ACEPTÓ TIENE QUE SER LO QUE RIGE. Entre que se le enseñó el
    #: texto y pulsó comprar pudo publicarse otra versión, y una aceptación de
    #: un texto que ya no rige no es una aceptación.
    if politica.id != policy_id or politica.terms_sha256 != (
        policy_terms_sha256 or ""
    ).strip().lower():
        detalle = {
            "policy_id": politica.id,
            "version": int(politica.version),
            "terms_sha256": politica.terms_sha256,
        }
        await db.rollback()
        raise politicas.PoliticaCambio(
            "Las condiciones de compra cambiaron. Vuelve a leerlas.",
            details=detalle,
        )
    if politica.currency != moneda:
        detalle = {"cart": moneda, "policy": politica.currency}
        await db.rollback()
        raise politicas.MonedaFueraDeLaPolitica(
            "Esa moneda no es la que rige en ese país.", details=detalle
        )

    # --- El pedido -------------------------------------------------------- #
    orden = ProductOrder(
        buyer_id=usuario_id,
        seller_id=seller_id,
        status=PEDIDO_PENDIENTE,
        currency=moneda,
        subtotal_minor=subtotal,
        #: HOY `total = subtotal`. Impuestos, envío y comisión no están
        #: decididos, y escribir aquí otro número sería inventarse un cargo.
        total_minor=subtotal,
        provider="none",
        environment=ajustes.payments_environment,
        idempotency_key=clave,
        request_fingerprint=huella,
        policy_id=politica.id,
        policy_version=int(politica.version),
        policy_terms_sha256=politica.terms_sha256,
        policy_country=politica.country_code,
        policy_accepted_at=momento,
        reserved_until=momento
        + timedelta(minutes=int(ajustes.product_reservation_minutes)),
        created_at=momento,
        updated_at=momento,
    )
    db.add(orden)
    await db.flush()

    db.add(
        ProductOrderAddress(
            order_id=orden.id,
            recipient_name=datos.recipient_name,
            phone=datos.phone,
            country_code=datos.country_code,
            region=datos.region,
            city=datos.city,
            district=datos.district,
            address_line=datos.address_line,
            reference=datos.reference,
            postal_code=datos.postal_code,
            instructions=datos.instructions,
            created_at=momento,
        )
    )

    for linea in mias:
        db.add(
            ProductOrderItem(
                order_id=orden.id,
                product_id=linea.product_id,
                version_id=linea.version_id,
                variant_id=linea.variant_id,
                sku=(linea.sku or "").strip(),
                name_snapshot=linea.name[:300],
                variant_name_snapshot=(linea.variant_name or None),
                unit_price_minor=int(linea.unit_price_minor),
                quantity=int(linea.quantity),
                subtotal_minor=int(linea.line_total_minor),
                created_at=momento,
            )
        )
    await db.flush()

    # --- La reserva, en orden estable ------------------------------------- #
    for product_id, sku, cantidad in por_unidad_de_almacen(mias):
        if not sku:
            await db.rollback()
            raise CarritoNoComprable(
                "Hay algo en tu bolsa sin unidad de almacén.",
                details={"product_id": product_id},
            )
        #: SIN EL IDENTIFICADOR DE QUIEN COMPRA. Firmar el movimiento con su
        #: cuenta lo dejaba a la vista del proveedor: la ruta de movimientos de
        #: un SKU es suya, y devolvía `actor_id`. Con eso sabía quién apartó
        #: qué y cuándo, incluso de pedidos que nunca se pagaron —justo lo que
        #: `del_proveedor` evita al entregar solo los pagados—.
        #:
        #: QUIEN MUEVE ES EL SISTEMA, y es lo que de verdad pasó: nadie tecleó
        #: esta reserva, la hizo el checkout. Quién compró está en el pedido,
        #: que es donde tiene que estar.
        await inventory.reservar(
            db,
            product_id=product_id,
            sku=sku,
            cantidad=cantidad,
            clave=CLAVE_DE_RESERVA + orden.id,
            actor_id=None,
        )

    await _anotar(
        db,
        orden=orden,
        desde=None,
        hasta=PEDIDO_PENDIENTE,
        actor_id=usuario_id,
        actor_rol="buyer",
    )
    await db.commit()
    return PedidoCreado(orden, estrenado=True)


# --------------------------------------------------------------------------- #
# Soltar lo apartado. UNA VEZ.
# --------------------------------------------------------------------------- #
async def _liberar_reserva(
    db: AsyncSession, *, orden: ProductOrder, momento: datetime
) -> None:
    """Devuelve al común lo que este pedido apartaba. EXACTAMENTE UNA VEZ.

    DOS CAPAS, Y LAS DOS HACEN FALTA. Arriba, `reservation_settled_at` bajo el
    cerrojo de la fila del pedido: quien llega segundo ve que ya se decidió y no
    hace nada. Abajo, la clave de idempotencia del movimiento, que es un índice
    único de la base: si dos procesos se colaran a la vez por el primero —otra
    conexión, otro nodo—, el segundo no puede escribir el movimiento.
    """
    if orden.reservation_settled_at is not None:
        return
    lineas = list(
        await db.scalars(
            select(ProductOrderItem).where(ProductOrderItem.order_id == orden.id)
        )
    )
    for product_id, sku, cantidad in por_unidad_de_almacen(lineas):
        #: SIN IDENTIFICADOR, por lo mismo que la reserva.
        await inventory.liberar(
            db,
            product_id=product_id,
            sku=sku,
            cantidad=cantidad,
            clave=CLAVE_DE_LIBERACION + orden.id,
            actor_id=None,
        )
    orden.reservation_settled_at = momento
    orden.reserved_until = None


async def _bloqueado(db: AsyncSession, orden_id: str) -> ProductOrder | None:
    """El pedido, con su fila bloqueada y REFRESCADA.

    `populate_existing` no es un adorno: sin él SQLAlchemy devuelve el objeto
    que ya tiene en el mapa de identidad y el `for update` habría tomado la
    fila para leer una foto anterior.
    """
    return await db.scalar(
        select(ProductOrder)
        .where(ProductOrder.id == orden_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


# --------------------------------------------------------------------------- #
# Cancelar, vencer y fallar
# --------------------------------------------------------------------------- #
async def cancelar(
    db: AsyncSession, *, orden_id: str, usuario_id: str, momento: datetime | None = None
) -> ProductOrder:
    """Cancela un pedido ANTES de pagarlo y suelta lo que apartaba."""
    await esquema.exigir_pedidos(db)
    momento = momento or ahora()
    orden = await _bloqueado(db, orden_id)
    if orden is None or orden.buyer_id != usuario_id:
        #: 404 TAMBIÉN PARA EL AJENO: decir «existe pero no es tuyo» ya cuenta
        #: que alguien más compró eso.
        await db.rollback()
        raise NotFoundError("Pedido no encontrado.", code="product_order_not_found")
    if orden.status == PEDIDO_CANCELADO:
        await db.commit()
        return orden
    if orden.status not in PEDIDO_EN_CURSO:
        #: EL MENSAJE SE COMPONE ANTES DEL `rollback`. Deshacer la transacción
        #: caduca los objetos del ORM, y leer `orden.status` después dispara una
        #: recarga perezosa que en asíncrono revienta con `MissingGreenlet`:
        #: quien pulsaba «cancelar» sobre un pedido ya vencido recibía un 500 en
        #: vez del 409 que la ruta promete.
        estado = orden.status
        detalle = {"status": estado}
        mensaje = f"Ese pedido ya no se puede cancelar: está {estado}."
        await db.rollback()
        raise PedidoNoPagable(mensaje, details=detalle)

    anterior = orden.status
    await _liberar_reserva(db, orden=orden, momento=momento)
    orden.status = PEDIDO_CANCELADO
    orden.cancelled_at = momento
    orden.updated_at = momento
    await _anotar(
        db,
        orden=orden,
        desde=anterior,
        hasta=PEDIDO_CANCELADO,
        actor_id=usuario_id,
        actor_rol="buyer",
    )
    await db.commit()
    return orden


async def vencer(
    db: AsyncSession, *, momento: datetime | None = None, lote: int = 200
) -> int:
    """Cierra los pedidos cuya reserva ya expiró. Idempotente.

    NO HAY NINGÚN TEMPORIZADOR DENTRO DE LA APLICACIÓN, y no es un olvido: la
    API puede correr con varias réplicas, y un temporizador por réplica es el
    mismo barrido ejecutándose tantas veces como procesos haya. Esto lo llama un
    planificador de fuera, por una ruta de administración.

    UNO A UNO Y CON SU CERROJO. Un `update ... where` masivo no puede soltar el
    inventario de cada uno, y soltar el inventario es justo lo que hay que hacer.
    """
    await esquema.exigir_pedidos(db)
    momento = momento or ahora()
    #: SE BUSCA POR LA RESERVA, NO POR EL ESTADO. Buscar por `PEDIDO_EN_CURSO`
    #: dejaba fuera los pedidos fallidos y los que esperan a una persona, que
    #: son exactamente los que se quedaban con las unidades apartadas para
    #: siempre. Lo que hay que soltar es toda reserva vencida que no se haya
    #: decidido ya, sea cual sea el estado del pedido.
    #:
    #: `PAID` no entra: al cobrar, la reserva se consume y `settled` queda
    #: puesto, así que no aparecería igualmente; excluirlo lo dice en voz alta.
    candidatos = list(
        await db.scalars(
            select(ProductOrder.id)
            .where(
                ProductOrder.reservation_settled_at.is_(None),
                ProductOrder.status != PEDIDO_PAGADO,
                ProductOrder.reserved_until.is_not(None),
                ProductOrder.reserved_until <= momento,
            )
            .order_by(ProductOrder.reserved_until)
            .limit(lote)
        )
    )
    vencidos = 0
    for orden_id in candidatos:
        orden = await _bloqueado(db, orden_id)
        if orden is None:
            continue
        #: RECOMPROBADO BAJO EL CERROJO. Entre la lista y el cerrojo puede
        #: haberse pagado, y vencer un pedido pagado le quitaría a alguien lo
        #: que acaba de comprar.
        if orden.status == PEDIDO_PAGADO:
            continue
        if orden.reservation_settled_at is not None:
            continue
        limite = comparable(orden.reserved_until, momento)
        if limite is None or limite > momento:
            continue
        anterior = orden.status
        await _liberar_reserva(db, orden=orden, momento=momento)
        #: UN PEDIDO EN REVISIÓN SUELTA LO QUE APARTABA Y SIGUE EN REVISIÓN.
        #: Ahí hay un cobro que no cuadra y una persona tiene que mirarlo:
        #: marcarlo «vencido» lo sacaría de la cola y haría desaparecer el
        #: problema de la vista sin haberlo resuelto.
        if anterior != PEDIDO_EN_REVISION:
            orden.status = PEDIDO_VENCIDO
            orden.expired_at = momento
        orden.updated_at = momento
        await _anotar(
            db,
            orden=orden,
            desde=anterior,
            hasta=orden.status,
            actor_id=None,
            actor_rol="system",
            motivo="reservation_expired",
        )
        await db.commit()
        vencidos += 1
    return vencidos


async def marcar_fallido(
    db: AsyncSession, *, orden_id: str, motivo: str, momento: datetime | None = None
) -> ProductOrder | None:
    """Un fallo TERMINAL de la pasarela. No suelta la reserva todavía.

    POR QUÉ NO SUELTA. Un pago fallido no es el final: la tarjeta puede
    reintentarse mientras la reserva siga viva, y soltar aquí le quitaría a
    quien lo intenta la última unidad que estaba a punto de pagar. Si no vuelve
    a intentarlo, el vencimiento la suelta sola.
    """
    momento = momento or ahora()
    orden = await _bloqueado(db, orden_id)
    if orden is None:
        return None
    if orden.status not in PEDIDO_EN_CURSO:
        return orden
    anterior = orden.status
    orden.status = PEDIDO_FALLIDO
    orden.failed_at = momento
    orden.updated_at = momento
    await _anotar(
        db,
        orden=orden,
        desde=anterior,
        hasta=PEDIDO_FALLIDO,
        actor_id=None,
        actor_rol="system",
        motivo=motivo,
    )
    await db.flush()
    return orden


async def reintentar(
    db: AsyncSession, *, orden: ProductOrder, momento: datetime
) -> None:
    """Devuelve a `PENDING_PAYMENT` un pedido cuyo cobro falló, si aún aparta."""
    if orden.status != PEDIDO_FALLIDO:
        return
    limite = comparable(orden.reserved_until, momento)
    if orden.reservation_settled_at is not None or limite is None or limite <= momento:
        raise PedidoNoPagable("La reserva de ese pedido ya venció.")
    orden.status = PEDIDO_PENDIENTE
    orden.failed_at = None
    orden.updated_at = momento


# --------------------------------------------------------------------------- #
# Confirmar con la evidencia de un cobro YA VERIFICADO
# --------------------------------------------------------------------------- #
def _por_que_no_cuadra(
    orden: ProductOrder,
    *,
    provider: str,
    environment: str,
    amount_minor: int | None,
    currency: str | None,
) -> str | None:
    """Por qué este aviso NO puede confirmar este pedido, o `None`.

    FALLA EN CERRADO. Cada comprobación es una forma conocida de que a alguien
    le regalen un producto, y LA AUSENCIA DE UN DATO NO VALE COMO COINCIDENCIA:
    sustituirla por lo esperado —un `or`, un `coalesce`— convierte un aviso
    incompleto en una venta.
    """
    if orden.provider != provider:
        #: `none` NO CUENTA. Un pedido con `provider = 'none'` nunca pasó por
        #: `iniciar_pago`: no hay ningún cobro abierto a su nombre.
        return "El cobro es de otra pasarela."
    if (orden.environment or "") != environment:
        return "El cobro es de otro entorno."
    if amount_minor is None:
        return "El aviso no dice cuánto se cobró."
    if currency is None or not currency.strip():
        return "El aviso no dice en qué moneda se cobró."
    if int(amount_minor) != int(orden.total_minor):
        #: NI DE MENOS —un pago parcial no compra— NI DE MÁS.
        return "El importe cobrado no es el del pedido."
    if currency.strip().upper() != (orden.currency or "").strip().upper():
        return "La moneda cobrada no es la del pedido."
    return None


async def confirmar_pago(
    db: AsyncSession,
    *,
    orden_id: str,
    provider: str,
    environment: str,
    external_payment_id: str,
    amount_minor: int | None,
    currency: str | None,
    momento: datetime | None = None,
) -> PedidoCreado:
    """Marca pagado con la evidencia de un aviso verificado. UNA SOLA VEZ.

    NO CONFIRMA NI DESHACE LA TRANSACCIÓN, y no es un descuido: corre dentro del
    savepoint que abre el webhook, y en esa misma transacción vive la fila
    anti-repetición del aviso. Un `rollback` aquí se llevaría por delante justo
    el registro que impide procesar dos veces el mismo cobro.

    LA RESERVA NO SE SUELTA: SE CONSUME. Las unidades siguen comprometidas hasta
    que salgan del almacén —eso es del Incremento 6—, y `reservation_settled_at`
    marca que este pedido ya no está sujeto al vencimiento.
    """
    momento = momento or ahora()
    orden = await _bloqueado(db, orden_id)
    if orden is None:
        raise NotFoundError("Pedido no encontrado.", code="product_order_not_found")

    if orden.status == PEDIDO_PAGADO:
        #: AVISO REPETIDO. Se comprueba que sea EL MISMO cobro: otro cobro sobre
        #: un pedido ya pagado es un problema de conciliación, no una
        #: confirmación.
        if (orden.external_payment_id or "") != external_payment_id:
            raise PagoNoCuadra("Ese pedido ya se pagó con otro cobro.")
        return PedidoCreado(orden, estrenado=False)

    if orden.status not in PEDIDO_EN_CURSO:
        #: EL PAGO TARDÍO. La reserva ya soltó las unidades y otra persona puede
        #: tenerlas. NO SE COBRA EN SILENCIO NI SE NIEGA EN SILENCIO: el pedido
        #: queda explícitamente en revisión y lo resuelve una persona.
        raise PagoNoCuadra(
            f"Ese pedido ya no admite un pago: está {orden.status}."
        )

    fallo = _por_que_no_cuadra(
        orden,
        provider=provider,
        environment=environment,
        amount_minor=amount_minor,
        currency=currency,
    )
    if fallo is not None:
        raise PagoNoCuadra(fallo)

    limite = comparable(orden.reserved_until, momento)
    if orden.reservation_settled_at is not None or limite is None or limite <= momento:
        raise PagoNoCuadra("La reserva venció antes de que llegara el cobro.")

    anterior = orden.status
    orden.provider = provider
    orden.external_payment_id = external_payment_id
    orden.status = PEDIDO_PAGADO
    orden.paid_at = momento
    orden.updated_at = momento
    #: LA RESERVA SE CONSUME: deja de estar sujeta al vencimiento y las unidades
    #: quedan comprometidas. No se suelta y no se despacha todavía.
    orden.reservation_settled_at = momento
    orden.reserved_until = None
    await _anotar(
        db,
        orden=orden,
        desde=anterior,
        hasta=PEDIDO_PAGADO,
        actor_id=None,
        actor_rol="system",
    )

    #: SOLO LAS LÍNEAS COMPRADAS SALEN DE LA BOLSA. Vaciarla entera se llevaría
    #: por delante lo de los demás proveedores, que esa persona no ha comprado.
    await _vaciar_lo_comprado(db, orden=orden)

    await db.flush()
    return PedidoCreado(orden, estrenado=True)


async def _vaciar_lo_comprado(db: AsyncSession, *, orden: ProductOrder) -> int:
    """Quita del carrito exactamente lo que este pedido compró."""
    if not await esquema.hay_carrito(db):
        return 0
    lineas = list(
        await db.scalars(
            select(ProductOrderItem).where(ProductOrderItem.order_id == orden.id)
        )
    )
    quitadas = 0
    for linea in lineas:
        fila = await db.scalar(
            select(ProductCartItem).where(
                ProductCartItem.user_id == orden.buyer_id,
                ProductCartItem.product_id == linea.product_id,
                ProductCartItem.version_id == linea.version_id,
                ProductCartItem.variant_id == linea.variant_id,
            )
        )
        if fila is not None:
            await db.delete(fila)
            quitadas += 1
    return quitadas


async def marcar_en_revision(
    db: AsyncSession, *, orden_id: str, motivo: str, momento: datetime | None = None
) -> ProductOrder | None:
    """Deja el pedido esperando a una persona. El caso es el pago tardío.

    NI SE COBRA EN SILENCIO NI SE NIEGA EN SILENCIO. El dinero entró y la
    reserva ya no está: puede que las unidades sigan ahí y puede que no, y
    decidirlo automáticamente significa o quedarse el dinero sin entregar nada o
    prometer un producto que otra persona ya compró.
    """
    momento = momento or ahora()
    orden = await _bloqueado(db, orden_id)
    if orden is None:
        return None
    if orden.status in (PEDIDO_PAGADO, PEDIDO_EN_REVISION):
        return orden
    anterior = orden.status
    orden.status = PEDIDO_EN_REVISION
    orden.review_reason = (motivo or "").strip()[:500] or "payment_after_expiry"
    orden.updated_at = momento
    await _anotar(
        db,
        orden=orden,
        desde=anterior,
        hasta=PEDIDO_EN_REVISION,
        actor_id=None,
        actor_rol="system",
        motivo=orden.review_reason,
    )
    await db.flush()
    return orden


# --------------------------------------------------------------------------- #
# Leer
# --------------------------------------------------------------------------- #
async def leer(
    db: AsyncSession, *, orden_id: str, usuario_id: str
) -> ProductOrder:
    """El pedido de esta persona. 404 para el ajeno."""
    await esquema.exigir_pedidos(db)
    orden = await db.get(ProductOrder, orden_id)
    if orden is None or orden.buyer_id != usuario_id:
        raise NotFoundError("Pedido no encontrado.", code="product_order_not_found")
    return orden


async def lineas_de(db: AsyncSession, orden_id: str) -> list[ProductOrderItem]:
    return list(
        await db.scalars(
            select(ProductOrderItem)
            .where(ProductOrderItem.order_id == orden_id)
            .order_by(ProductOrderItem.created_at, ProductOrderItem.id)
        )
    )


async def direccion_de(
    db: AsyncSession, orden_id: str
) -> ProductOrderAddress | None:
    return await db.get(ProductOrderAddress, orden_id)


async def historial_de(db: AsyncSession, orden_id: str) -> list[ProductOrderEvent]:
    return list(
        await db.scalars(
            select(ProductOrderEvent)
            .where(ProductOrderEvent.order_id == orden_id)
            .order_by(ProductOrderEvent.created_at, ProductOrderEvent.id)
        )
    )


async def mis_pedidos(
    db: AsyncSession, *, usuario_id: str, limite: int = 20
) -> list[ProductOrder]:
    await esquema.exigir_pedidos(db)
    return list(
        await db.scalars(
            select(ProductOrder)
            .where(ProductOrder.buyer_id == usuario_id)
            .order_by(ProductOrder.created_at.desc(), ProductOrder.id.desc())
            .limit(max(1, min(limite, 100)))
        )
    )


async def del_proveedor(
    db: AsyncSession, *, seller_id: str, limite: int = 20
) -> list[ProductOrder]:
    """SOLO LOS PAGADOS. Un proveedor no tiene por qué ver quién abandonó un
    carrito, ni cuántos lo intentaron: eso no le hace falta para atender."""
    await esquema.exigir_pedidos(db)
    return list(
        await db.scalars(
            select(ProductOrder)
            .where(
                ProductOrder.seller_id == seller_id,
                ProductOrder.status == PEDIDO_PAGADO,
            )
            .order_by(ProductOrder.created_at.desc(), ProductOrder.id.desc())
            .limit(max(1, min(limite, 100)))
        )
    )


async def en_revision(db: AsyncSession, *, limite: int = 50) -> list[ProductOrder]:
    """La cola de conciliación. Administración."""
    await esquema.exigir_pedidos(db)
    return list(
        await db.scalars(
            select(ProductOrder)
            .where(ProductOrder.status == PEDIDO_EN_REVISION)
            .order_by(ProductOrder.created_at.desc(), ProductOrder.id.desc())
            .limit(max(1, min(limite, 200)))
        )
    )


async def por_cobro(
    db: AsyncSession, *, referencia: str, entorno: str
) -> ProductOrder | None:
    """El pedido de un cobro de Stripe, MIRANDO NUESTRAS TABLAS."""
    if not referencia.strip() or not await esquema.hay_pedidos(db):
        return None
    return await db.scalar(
        select(ProductOrder).where(
            ProductOrder.provider == "stripe",
            ProductOrder.external_payment_id == referencia.strip(),
            ProductOrder.environment == entorno,
        )
    )


async def cuantos_en_revision(db: AsyncSession) -> int:
    if not await esquema.hay_pedidos(db):
        return 0
    return int(
        await db.scalar(
            select(func.count())
            .select_from(ProductOrder)
            .where(ProductOrder.status == PEDIDO_EN_REVISION)
        )
        or 0
    )


__all__ = [
    "CLAVE_DE_LIBERACION",
    "CLAVE_DE_RESERVA",
    "CarritoNoComprable",
    "ClaveReutilizada",
    "Direccion",
    "DireccionInvalida",
    "GrupoDeProveedor",
    "PagoNoCuadra",
    "PedidoCreado",
    "PedidoNoPagable",
    "Preparacion",
    "VariosProveedores",
    "VentaNoDisponible",
    "YaHayPedido",
    "ahora",
    "cancelar",
    "comparable",
    "confirmar_pago",
    "crear",
    "cuantos_en_revision",
    "del_proveedor",
    "direccion_de",
    "en_revision",
    "exigir_venta_habilitada",
    "historial_de",
    "huella_del_cuerpo",
    "leer",
    "lineas_de",
    "marcar_en_revision",
    "marcar_fallido",
    "mis_pedidos",
    "por_cobro",
    "por_que_no_se_puede_vender",
    "por_unidad_de_almacen",
    "preparar",
    "reintentar",
    "validar_direccion",
    "vencer",
]
