"""El carrito de Productos. Incremento 4.

NO ES «GUARDADOS», Y NO SE PARECE. Guardar (0072) es un marcador: sin cantidad,
sin variante y sin precio. El carrito tiene cantidad, variante, moneda y un
total que calcula el servidor. Son dos contadores distintos en el encabezado
porque significan dos cosas distintas, y juntarlos haría que el número de la
bolsa no quisiera decir nada concreto.

TODAVÍA NO SE COMPRA. No hay pedido, ni dirección, ni cobro, ni transferencia.
`purchasable` viaja SIEMPRE en `false` y la pantalla lo dice con esas palabras:
un botón de pagar sin recorrido detrás cuesta más confianza que su ausencia.

EL CARRITO NO RESERVA EXISTENCIAS, Y ES UNA DECISIÓN. Tener algo en la bolsa no
se lo quita a nadie: una reserva sin caducidad convierte un carrito olvidado en
un producto agotado. Reservar es del checkout. Por eso este fichero LEE el
inventario y no lo mueve nunca.

EL PRECIO DE LA LÍNEA NO ES EL PRECIO. `seen_price_minor` es lo que se veía al
añadir y existe para AVISAR de que cambió. El total lo calcula el servidor con
el precio de AHORA, porque congelar el precio ocurre al crear el pedido: si se
congelara aquí, un carrito de hace tres semanas pagaría un importe que ya no
existe.

LOS IMPORTES NO LOS MANDA EL CLIENTE. Ni el precio, ni el subtotal, ni el total.
Lo único que viaja desde la aplicación es qué producto, qué variante y cuántas.

UNA PERSONA, UN CARRITO, Y ES LA FILA QUE SE BLOQUEA. Cualquier cambio toma
`select ... for update` sobre `product_carts`: es lo que ordena dos peticiones
simultáneas y lo que hace que un doble toque no sume dos.

UN CARRITO VACÍO NO ENSEÑA «S/ 0». `subtotal_minor` viaja `null` cuando no hay
nada comprable: un cero con moneda parece una compra de cero soles.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError, ValidationAppError
from app.modules.products import esquema, inventory
from app.modules.products.models import (
    MAXIMO_POR_LINEA,
    Product,
    ProductCart,
    ProductCartItem,
    ProductMedia,
    ProductSeller,
    ProductVariant,
    ProductVersion,
    FOTO_APROBADA,
)
from app.modules.products.states import EN_CATALOGO

#: Lo que puede ir mal en una línea. SON CÓDIGOS, no frases: la pantalla los
#: traduce, y así tres pantallas no dicen tres cosas parecidas.
PRECIO_CAMBIO = "price_changed"
VERSION_CAMBIO = "version_changed"
NO_DISPONIBLE = "product_unavailable"
VARIANTE_FUERA = "variant_missing"
SIN_PRECIO = "price_not_configured"
SIN_INVENTARIO = "inventory_not_configured"
NO_ALCANZA = "insufficient_stock"

AVISOS = (
    PRECIO_CAMBIO,
    VERSION_CAMBIO,
    NO_DISPONIBLE,
    VARIANTE_FUERA,
    SIN_PRECIO,
    SIN_INVENTARIO,
    NO_ALCANZA,
)

#: Los que impiden comprar esa línea. `price_changed` NO está: un precio que
#: subió sigue siendo comprable, y lo que hay que hacer es decirlo, no bloquear.
BLOQUEANTES = frozenset(
    {NO_DISPONIBLE, VARIANTE_FUERA, SIN_PRECIO, SIN_INVENTARIO, NO_ALCANZA}
)


class ProductoNoDisponible(NotFoundError):
    code = "product_not_found"


class VarianteNoValida(NotFoundError):
    code = "product_variant_not_found"


class SinPrecio(ConflictError):
    """El producto no tiene precio configurado. NO es gratis."""

    code = "product_price_not_configured"


class MonedaIncompatible(ConflictError):
    code = "product_cart_currency_mismatch"


class CantidadInvalida(ValidationAppError):
    code = "product_cart_quantity_invalid"


class LineaNoEncontrada(NotFoundError):
    code = "product_cart_item_not_found"


@dataclass(frozen=True)
class Linea:
    """Una línea, con lo que el servidor sabe de ella AHORA."""

    item_id: str
    product_id: str
    version_id: str
    variant_id: str

    name: str
    variant_name: str | None
    sku: str | None
    seller_id: str
    seller_name: str
    image_path: str | None
    image_url: str | None
    alt_text: str | None

    quantity: int
    #: El precio de AHORA, calculado por el servidor. `null` si no hay ninguno
    #: configurado, y nulo NO es gratis.
    unit_price_minor: int | None
    currency: str | None
    line_total_minor: int | None

    #: Lo que se veía al añadir. Solo para avisar.
    seen_price_minor: int
    seen_currency: str

    #: Cuántas se pueden vender. `null` cuando la variante NO TIENE INVENTARIO
    #: CARGADO, que no es lo mismo que cero.
    available: int | None

    issues: list[str] = field(default_factory=list)
    purchasable: bool = False
    added_at: datetime | None = None


@dataclass(frozen=True)
class Carrito:
    """La bolsa entera. TODO lo calcula el servidor."""

    disponible: bool = True
    items: list[Linea] = field(default_factory=list)
    currency: str | None = None
    #: Suma de las líneas comprables. `null` si no hay ninguna: un cero con
    #: moneda parecería una compra de cero.
    subtotal_minor: int | None = None
    #: Unidades, no líneas. Es lo que enseña el contador de la bolsa.
    units: int = 0
    lines: int = 0
    blocked_lines: int = 0
    #: SI HAY ALGO QUE COMPRAR EN ESTA BOLSA: al menos una línea comprable y
    #: una sola moneda. NO DICE QUE LA COMPRA ESTÉ HABILITADA —eso son cinco
    #: banderas y una política publicada, y lo contesta `pedidos.preparar`—:
    #: dice que el carrito, por su parte, no lo impide.
    purchasable: bool = False


# --------------------------------------------------------------------------- #
# Piezas
# --------------------------------------------------------------------------- #
def precio_de(version: ProductVersion, variante: ProductVariant) -> int | None:
    """El precio de esa variante, en la unidad menor. `None` si no hay.

    LO SUMA EL SERVIDOR. El recargo de la variante llega de la base, no del
    cliente, y sin precio de versión no hay precio: un recargo suelto no es un
    importe.
    """
    if version.price_minor is None or version.currency is None:
        return None
    efectivo = int(version.price_minor) + int(variante.price_delta_minor or 0)
    #: UN PRECIO NEGATIVO NO ES UN PRECIO. Un recargo por debajo del precio de
    #: la versión lo dejaba en negativo, y como no era `None` pasaba el guardián
    #: de «sin precio» y se estrellaba contra el CHECK de la base con un 500.
    #: La línea se marca como sin precio, que es lo que de verdad le pasa.
    return efectivo if efectivo >= 0 else None


def _en_catalogo():
    return (
        Product.status.in_(tuple(EN_CATALOGO)),
        Product.published_version_id.is_not(None),
    )


async def _carrito_bloqueado(
    db: AsyncSession, *, usuario_id: str, crear: bool
) -> ProductCart | None:
    """El carrito de esta persona, BLOQUEADO. Es lo que ordena los cambios."""
    fila = await db.scalar(
        select(ProductCart)
        .where(ProductCart.user_id == usuario_id)
        .with_for_update()
    )
    if fila is not None or not crear:
        return fila

    #: LA CREACIÓN TAMBIÉN ES UNA CARRERA, y esta se escapaba. Un
    #: `select ... for update` sobre CERO filas no bloquea nada, así que cuatro
    #: primeros toques simultáneos llegaban los cuatro al `insert` y tres se
    #: estrellaban contra la clave primaria con un 500, perdiendo tres unidades.
    #: Es la misma solución que ya usaba el inventario.
    from sqlalchemy.dialects.postgresql import insert as insert_pg
    from sqlalchemy.dialects.sqlite import insert as insert_sqlite

    dialecto = db.bind.dialect.name if db.bind is not None else ""
    constructor = insert_pg if dialecto == "postgresql" else insert_sqlite
    await db.execute(
        constructor(ProductCart.__table__)
        .values(user_id=usuario_id)
        .on_conflict_do_nothing(index_elements=["user_id"])
    )
    await db.flush()
    return await db.scalar(
        select(ProductCart)
        .where(ProductCart.user_id == usuario_id)
        .with_for_update()
    )


# --------------------------------------------------------------------------- #
# Leer
# --------------------------------------------------------------------------- #
async def leer(db: AsyncSession, *, usuario_id: str, firmar=None) -> Carrito:
    """La bolsa, con los avisos de lo que cambió desde que se metió.

    UNA CONSULTA PARA TODO, no una por línea: pintar el carrito no puede costar
    tantos viajes como artículos tenga.
    """
    if not await esquema.hay_carrito(db):
        return Carrito(disponible=False)

    filas = list(
        (
            await db.execute(
                select(ProductCartItem, Product, ProductVersion, ProductVariant, ProductSeller)
                .join(Product, Product.id == ProductCartItem.product_id)
                .join(ProductVersion, ProductVersion.id == ProductCartItem.version_id)
                .join(ProductVariant, ProductVariant.id == ProductCartItem.variant_id)
                .join(ProductSeller, ProductSeller.id == Product.seller_id)
                .where(ProductCartItem.user_id == usuario_id)
                .order_by(ProductCartItem.created_at, ProductCartItem.id)
            )
        ).all()
    )
    carrito = await db.get(ProductCart, usuario_id)
    if not filas:
        return Carrito(currency=None)

    #: EL INVENTARIO SE MIRA POR (PRODUCTO, SKU), que es la unidad de almacén.
    #: La variante dice qué se ofrece en esta versión; el SKU, qué hay guardado.
    existencias = await inventory.de_varios(
        db, unidades=[(f[0].product_id, f[3].sku) for f in filas]
    )
    #: La primera foto APROBADA de cada versión, en una sola consulta.
    portadas: dict[str, tuple[str, str | None]] = {}
    for version_id, ruta, alt in (
        await db.execute(
            select(ProductMedia.version_id, ProductMedia.storage_path, ProductMedia.alt_text)
            .where(
                ProductMedia.version_id.in_([f[0].version_id for f in filas]),
                ProductMedia.status == FOTO_APROBADA,
            )
            .order_by(ProductMedia.version_id, ProductMedia.position, ProductMedia.id)
        )
    ).all():
        portadas.setdefault(version_id, (ruta, alt))

    firmadas: dict[str, str] = {}
    if firmar is not None and portadas:
        firmadas = await firmar([r for r, _ in portadas.values()])

    lineas: list[Linea] = []
    for item, producto, version, variante, vendedor in filas:
        avisos: list[str] = []

        if producto.status not in EN_CATALOGO or producto.published_version_id is None:
            avisos.append(NO_DISPONIBLE)
        elif producto.published_version_id != item.version_id:
            #: SE REPUBLICÓ. La línea sigue identificable —es lo que se metió—
            #: pero el precio y la descripción de ahora son otros.
            avisos.append(VERSION_CAMBIO)

        if variante.version_id != item.version_id:
            avisos.append(VARIANTE_FUERA)

        precio = precio_de(version, variante)
        if precio is None or version.currency is None:
            avisos.append(SIN_PRECIO)
        elif precio != int(item.seen_price_minor) or version.currency != item.seen_currency:
            avisos.append(PRECIO_CAMBIO)

        hay = existencias.get((item.product_id, variante.sku))
        if hay is None:
            avisos.append(SIN_INVENTARIO)
        elif hay.available < int(item.quantity):
            avisos.append(NO_ALCANZA)

        ruta, alt = portadas.get(item.version_id, (None, None))
        comprable = not (set(avisos) & BLOQUEANTES)
        lineas.append(
            Linea(
                item_id=item.id,
                product_id=item.product_id,
                version_id=item.version_id,
                variant_id=item.variant_id,
                name=version.name,
                variant_name=variante.name,
                sku=variante.sku,
                seller_id=vendedor.id,
                seller_name=vendedor.display_name,
                image_path=ruta,
                image_url=firmadas.get(ruta) if ruta else None,
                alt_text=alt,
                quantity=int(item.quantity),
                unit_price_minor=precio,
                currency=version.currency,
                line_total_minor=(
                    precio * int(item.quantity) if precio is not None else None
                ),
                seen_price_minor=int(item.seen_price_minor),
                seen_currency=item.seen_currency,
                available=hay.available if hay is not None else None,
                issues=avisos,
                purchasable=comprable,
                added_at=item.created_at,
            )
        )

    comprables = [l for l in lineas if l.purchasable and l.line_total_minor is not None]
    subtotal = sum(l.line_total_minor or 0 for l in comprables) if comprables else None
    return Carrito(
        items=lineas,
        currency=carrito.currency if carrito is not None else None,
        subtotal_minor=subtotal,
        units=sum(l.quantity for l in lineas),
        lines=len(lineas),
        blocked_lines=sum(1 for l in lineas if not l.purchasable),
        #: UNA SOLA MONEDA, ADEMÁS DE HABER ALGO COMPRABLE. Dos monedas no se
        #: suman, así que una bolsa mezclada no tiene un total que cobrar.
        purchasable=bool(comprables)
        and len({l.currency for l in comprables if l.currency}) == 1,
    )


async def cuantas_unidades(db: AsyncSession, *, usuario_id: str) -> int:
    """El contador de la bolsa. UNIDADES, y SEPARADO del de guardados."""
    if not await esquema.hay_carrito(db):
        return 0
    return int(
        await db.scalar(
            select(func.coalesce(func.sum(ProductCartItem.quantity), 0)).where(
                ProductCartItem.user_id == usuario_id
            )
        )
        or 0
    )


# --------------------------------------------------------------------------- #
# Escribir
# --------------------------------------------------------------------------- #
async def anadir(
    db: AsyncSession,
    *,
    usuario_id: str,
    producto_id: str,
    variante_id: str,
    cantidad: int = 1,
    clave: str | None = None,
) -> ProductCartItem:
    """Añade unidades a la bolsa. AÑADIR DOS VECES AJUSTA, NO DUPLICA.

    Y un reintento con la misma clave NO VUELVE A SUMAR: es la diferencia entre
    un doble toque y dos toques.
    """
    await esquema.exigir_carrito(db)
    cantidad = int(cantidad)
    if cantidad < 1 or cantidad > MAXIMO_POR_LINEA:
        raise CantidadInvalida(
            "La cantidad tiene que estar entre 1 y el tope de la línea.",
            details={"min": 1, "max": MAXIMO_POR_LINEA},
        )

    carrito = await _carrito_bloqueado(db, usuario_id=usuario_id, crear=True)

    fila = (
        await db.execute(
            select(Product, ProductVersion)
            .join(ProductVersion, ProductVersion.id == Product.published_version_id)
            .where(Product.id == producto_id, *_en_catalogo())
        )
    ).first()
    if fila is None:
        raise ProductoNoDisponible("Producto no encontrado.")
    producto, version = fila

    variante = await db.scalar(
        select(ProductVariant).where(
            ProductVariant.id == variante_id,
            ProductVariant.version_id == version.id,
        )
    )
    if variante is None:
        raise VarianteNoValida("Esa opción no existe en este producto.")

    precio = precio_de(version, variante)
    if precio is None or version.currency is None:
        raise SinPrecio(
            "Este producto todavía no tiene precio configurado.",
            details={"product_id": producto.id},
        )

    #: MONEDAS INCOMPATIBLES NO SE SUMAN. Sumar soles con euros da un número que
    #: no es dinero, y el carrito prefiere no dejar meter la segunda.
    #:
    #: PERO UNA BOLSA VACÍA NO TIENE MONEDA, aunque la columna la conserve: las
    #: líneas pueden irse por cascada —al borrar un producto o una versión— sin
    #: pasar por `quitar`, y entonces la moneda guardada rechazaría todo sobre
    #: una bolsa donde no hay nada.
    if carrito.currency and not await db.scalar(
        select(func.count())
        .select_from(ProductCartItem)
        .where(ProductCartItem.user_id == usuario_id)
    ):
        carrito.currency = None
    if carrito.currency and carrito.currency != version.currency:
        raise MonedaIncompatible(
            "Tu bolsa está en otra moneda.",
            details={"cart": carrito.currency, "product": version.currency},
        )

    existente = await db.scalar(
        select(ProductCartItem).where(
            ProductCartItem.user_id == usuario_id,
            ProductCartItem.product_id == producto.id,
            ProductCartItem.version_id == version.id,
            ProductCartItem.variant_id == variante.id,
        )
    )
    limpia = (clave or "").strip() or None
    if existente is not None and limpia and existente.last_operation_key == limpia:
        #: EL MISMO TOQUE OTRA VEZ. No se suma nada.
        return existente

    destino = int(existente.quantity) + cantidad if existente is not None else cantidad
    if destino > MAXIMO_POR_LINEA:
        raise CantidadInvalida(
            "No caben tantas unidades en una línea.",
            details={"max": MAXIMO_POR_LINEA, "current": destino},
        )

    await _exigir_que_alcance(
        db, product_id=producto.id, sku=variante.sku, cantidad=destino
    )

    if existente is None:
        existente = ProductCartItem(
            user_id=usuario_id,
            product_id=producto.id,
            version_id=version.id,
            variant_id=variante.id,
            quantity=destino,
            seen_price_minor=precio,
            seen_currency=version.currency,
            last_operation_key=limpia,
        )
        db.add(existente)
    else:
        existente.quantity = destino
        existente.last_operation_key = limpia
        existente.updated_at = func.now()

    if not carrito.currency:
        carrito.currency = version.currency
    carrito.updated_at = func.now()
    await db.flush()
    return existente


async def _exigir_que_alcance(
    db: AsyncSession, *, product_id: str, sku: str, cantidad: int
) -> None:
    """Que haya bastante para esa cantidad. NO RESERVA NADA.

    SIN INVENTARIO NO ES CERO: un SKU que nadie cargó se contesta con su propio
    código, porque decir «agotado» manda a quien vende a buscar un problema que
    no existe.
    """
    hay = await inventory.de_la_unidad(db, product_id=product_id, sku=sku)
    if hay is None:
        raise inventory.SinInventario(
            "Esta opción todavía no tiene existencias cargadas.",
            details={"product_id": product_id, "sku": sku},
        )
    if hay.available < cantidad:
        raise inventory.NoAlcanza(
            "No quedan tantas unidades.",
            details={"available": hay.available, "requested": cantidad},
        )


async def cambiar_cantidad(
    db: AsyncSession, *, usuario_id: str, item_id: str, cantidad: int
) -> ProductCartItem | None:
    """Deja la línea en esa cantidad. IDEMPOTENTE: es un destino, no un paso.

    Cero la quita, y pedir cero dos veces tampoco es un error.
    """
    await esquema.exigir_carrito(db)
    cantidad = int(cantidad)
    if cantidad < 0 or cantidad > MAXIMO_POR_LINEA:
        raise CantidadInvalida(
            "La cantidad tiene que estar entre 0 y el tope de la línea.",
            details={"min": 0, "max": MAXIMO_POR_LINEA},
        )
    carrito = await _carrito_bloqueado(db, usuario_id=usuario_id, crear=False)
    if carrito is None:
        raise LineaNoEncontrada("Esa línea no está en tu bolsa.")

    linea = await db.get(ProductCartItem, item_id)
    if linea is None or linea.user_id != usuario_id:
        raise LineaNoEncontrada("Esa línea no está en tu bolsa.")

    if cantidad == 0:
        await db.delete(linea)
        await db.flush()
        await _moneda_al_dia(db, carrito=carrito)
        return None

    if cantidad > int(linea.quantity):
        _, sku = await inventory.sku_de_la_variante(db, variante_id=linea.variant_id)
        await _exigir_que_alcance(
            db, product_id=linea.product_id, sku=sku, cantidad=cantidad
        )

    linea.quantity = cantidad
    linea.updated_at = func.now()
    carrito.updated_at = func.now()
    await db.flush()
    return linea


async def quitar(db: AsyncSession, *, usuario_id: str, item_id: str) -> bool:
    """Quita la línea. QUITAR LO QUE YA NO ESTÁ tampoco es un error."""
    await esquema.exigir_carrito(db)
    carrito = await _carrito_bloqueado(db, usuario_id=usuario_id, crear=False)
    if carrito is None:
        return False
    linea = await db.get(ProductCartItem, item_id)
    if linea is None or linea.user_id != usuario_id:
        return False
    await db.delete(linea)
    await db.flush()
    await _moneda_al_dia(db, carrito=carrito)
    return True


async def vaciar(db: AsyncSession, *, usuario_id: str) -> int:
    """Deja la bolsa vacía. Devuelve cuántas líneas se fueron."""
    await esquema.exigir_carrito(db)
    carrito = await _carrito_bloqueado(db, usuario_id=usuario_id, crear=False)
    if carrito is None:
        return 0
    lineas = list(
        await db.scalars(
            select(ProductCartItem).where(ProductCartItem.user_id == usuario_id)
        )
    )
    for linea in lineas:
        await db.delete(linea)
    carrito.currency = None
    carrito.updated_at = func.now()
    await db.flush()
    return len(lineas)


async def _moneda_al_dia(db: AsyncSession, *, carrito: ProductCart) -> None:
    """Si la bolsa se quedó vacía, su moneda vuelve a ser NINGUNA.

    Dejar la última moneda puesta impediría meter algo en otra en una bolsa que
    ya no tiene nada, y el error diría que hay algo dentro que no hay.
    """
    quedan = await db.scalar(
        select(func.count())
        .select_from(ProductCartItem)
        .where(ProductCartItem.user_id == carrito.user_id)
    )
    if not quedan:
        carrito.currency = None
    carrito.updated_at = func.now()
    await db.flush()


__all__ = [
    "AVISOS",
    "BLOQUEANTES",
    "CantidadInvalida",
    "Carrito",
    "Linea",
    "LineaNoEncontrada",
    "MonedaIncompatible",
    "NO_ALCANZA",
    "NO_DISPONIBLE",
    "PRECIO_CAMBIO",
    "ProductoNoDisponible",
    "SIN_INVENTARIO",
    "SIN_PRECIO",
    "SinPrecio",
    "VARIANTE_FUERA",
    "VERSION_CAMBIO",
    "VarianteNoValida",
    "anadir",
    "cambiar_cantidad",
    "cuantas_unidades",
    "leer",
    "precio_de",
    "quitar",
    "vaciar",
]
