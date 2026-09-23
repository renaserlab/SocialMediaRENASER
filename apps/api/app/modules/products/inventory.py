"""El inventario físico de un producto. Incremento 4.

LA UNIDAD DE ALMACÉN ES EL SKU, NO LA FILA DE LA VARIANTE. Una variante
pertenece a una versión inmutable: publicar la siguiente crea filas nuevas, con
identificadores nuevos, para las mismas cajas del mismo almacén. Si el
inventario colgara de esas filas, cada publicación lo dejaría huérfano y el
producto aparecería agotado sin que nadie hubiera vendido nada. El SKU —«stock
keeping unit»— es lo único estable entre una versión y la siguiente.

DOS TABLAS Y UNA SOLA PUERTA. `product_inventory` dice cuántas hay ahora;
`inventory_movements` dice cómo se llegó hasta ahí y SOLO SE AÑADE. Todo pasa
por `mover`: repartir las sumas entre varias funciones es cómo una de ellas
acaba olvidando el bloqueo, y ese olvido no lo delata ninguna prueba secuencial.

LO QUE DEFIENDE ESTE FICHERO, EN ORDEN DE IMPORTANCIA:

  1. DOS PETICIONES NO RESERVAN LA MISMA ÚLTIMA UNIDAD. La fila se bloquea con
     `select ... for update` y la decisión se toma con el número ya bloqueado.
     NO HAY NINGÚN `asyncio.Lock`: hay más de un proceso, y un candado en la
     memoria de uno no ordena nada entre ellos. Se prueba contra PostgreSQL de
     verdad, porque en SQLite dos transacciones no se pisan.
  2. LO DISPONIBLE NO SE GUARDA. Es `on_hand - reserved`. Guardarlo además
     crearía dos verdades que divergen la primera vez que alguien escriba una y
     olvide la otra; lo impide también la 0074, que no tiene esa columna.
  3. NUNCA QUEDA NEGATIVO. Lo comprueba el código para dar un error que se
     entiende, y lo impone la base con tres CHECK para que ninguna otra vía lo
     salte.
  4. SIN FILA NO ES CERO. Un SKU sin inventario cargado no tiene cero unidades:
     tiene un inventario que nadie ha cargado. Son dos cosas distintas y se
     contestan distinto, porque decir «agotado» de algo que nunca se inventarió
     manda a quien vende a buscar un problema que no existe.
  5. UN DOBLE TOQUE NO MUEVE DOS VECES. El identificador del movimiento se
     DERIVA de la clave de idempotencia, así que el reintento choca contra la
     clave primaria antes de tocar ningún número. No es un «mira si ya existe»,
     que dos peticiones simultáneas se pasan por delante.
  6. EDITAR UN PRODUCTO NO REESCRIBE EL HISTORIAL. Guardar el borrador rehace
     las filas de variante; el inventario no se entera, porque no cuelga de
     ellas.

LO QUE NO HAY, Y ES DELIBERADO:

  * NINGÚN LOTE. La arquitectura propone `inventory_lots`; el lote sirve para
    trazar el origen, no para saber cuántas quedan, y hoy no lo consulta nadie.
  * NINGÚN UMBRAL DE «POCAS UNIDADES». Cuándo avisar es una decisión comercial
    que la empresa no ha tomado, y elegir un número aquí sería tomarla.
QUIÉN LLAMA A CADA MOVIMIENTO, Y QUIÉN NO:

  * `entrada` y `ajustar` los llama quien vende, y `ajustar` también
    administración, desde la pantalla de inventario.
  * `reservar` y `liberar` los llama el pedido (Incremento 5): reservar al
    crearlo, liberar al cancelarlo o al vencer su reserva. NUNCA LOS LLAMA EL
    CARRITO, y eso es una decisión, no un olvido: tener algo en la bolsa no se
    lo quita a nadie.
  * `despachar` no lo llama todavía nadie: sacar del almacén es del Incremento
    6, y hacerlo al cobrar diría que algo salió cuando sigue en la caja.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Iterable

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError, ValidationAppError
from app.modules.gobernanza import auditoria
from app.modules.products import esquema
from app.modules.products.models import (
    ACTOR_ADMINISTRACION,
    ACTOR_PROVEEDOR,
    ACTOR_SISTEMA,
    AJUSTE,
    ENTRADA,
    LIBERACION,
    MAXIMO_DEL_MOVIMIENTO,
    RESERVA,
    SALIDA,
    InventoryMovement,
    Product,
    ProductInventory,
    ProductVariant,
)

#: Espacio de nombres de los identificadores derivados. ES UNA CONSTANTE Y NO SE
#: CAMBIA: cambiarlo haría que la misma clave produjera otro id, y el reintento
#: que llega después de un despliegue movería el inventario dos veces.
_ESPACIO = uuid.UUID("7a1b93c4-52de-5f08-8c37-1e6f0d4ab925")

#: Cómo se llama cada actor en la auditoría. `audit_events.actor_role` solo
#: admite `user`, `admin`, `moderator` y `system` (0050, aplicada), y no se
#: amplía por esto: quien vende actúa como usuario sobre lo suyo.
ROL_DE_AUDITORIA = {
    ACTOR_PROVEEDOR: "user",
    ACTOR_ADMINISTRACION: "admin",
    ACTOR_SISTEMA: "system",
}


class SinInventario(NotFoundError):
    """Ese SKU no tiene inventario cargado. NO es «cero unidades»."""

    code = "product_inventory_not_configured"


class UnidadNoEncontrada(NotFoundError):
    code = "product_variant_not_found"


class NoAlcanza(ConflictError):
    """No hay bastante. Lleva en los detalles cuánto hay de verdad."""

    code = "product_inventory_insufficient"


class MovimientoInvalido(ValidationAppError):
    code = "product_inventory_movement_invalid"


class ClaveReutilizada(ConflictError):
    """Esa clave ya se usó para OTRA operación sobre esta misma unidad.

    No es un reintento: un reintento repite la misma petición. Devolver el
    movimiento anterior con un 200 haría que quien pidió el ajuste viera
    «hecho» sobre un almacén que no se movió, y sin rastro del intento.
    """

    code = "product_inventory_key_reused"


@dataclass(frozen=True)
class Existencias:
    """Lo que hay. `available` SE CALCULA: no existe esa columna."""

    product_id: str
    sku: str
    on_hand: int
    reserved: int

    @property
    def available(self) -> int:
        return self.on_hand - self.reserved


def _leido(fila: ProductInventory) -> Existencias:
    return Existencias(
        product_id=fila.product_id,
        sku=fila.sku,
        on_hand=int(fila.on_hand),
        reserved=int(fila.reserved),
    )


def id_del_movimiento(product_id: str, sku: str, clave: str) -> str:
    """El identificador que le toca a este movimiento.

    LA HUELLA ES (PRODUCTO, SKU, CLAVE), Y NADA MÁS, porque eso es exactamente
    lo que declara única la 0074. El actor estuvo aquí y era un error: el
    identificador no chocaba pero la restricción de la base sí, y el resultado
    era un 500 en vez de un conflicto que se entiende.

    Sin el producto, la misma clave reusada en otro devolvería el movimiento del
    primero. Con él, una clave significa UNA operación sobre UNA unidad de
    almacén, venga de quien venga.
    """
    return str(uuid.uuid5(_ESPACIO, f"{product_id}:{sku}:{clave.strip()}"))


# --------------------------------------------------------------------------- #
# Leer
# --------------------------------------------------------------------------- #
async def de_la_unidad(
    db: AsyncSession, *, product_id: str, sku: str
) -> Existencias | None:
    """Lo que hay, o `None` si nadie cargó inventario. `None` NO ES CERO."""
    if not await esquema.hay_inventario(db):
        return None
    fila = await db.get(ProductInventory, (product_id, sku))
    return _leido(fila) if fila is not None else None


async def del_producto(db: AsyncSession, *, product_id: str) -> dict[str, Existencias]:
    """`sku -> existencias` de lo que tenga inventario cargado.

    Los SKU que no aparecen NO tienen cero: no tienen inventario, y quien llama
    lo distingue porque la clave no está.
    """
    if not await esquema.hay_inventario(db):
        return {}
    filas = await db.scalars(
        select(ProductInventory).where(ProductInventory.product_id == product_id)
    )
    return {f.sku: _leido(f) for f in filas}


async def de_varios(
    db: AsyncSession, *, unidades: Iterable[tuple[str, str]]
) -> dict[tuple[str, str], Existencias]:
    """Lo mismo para varias `(producto, sku)`. UNA consulta, no una por línea."""
    pares = [p for p in dict.fromkeys(unidades) if p and p[0] and p[1]]
    if not pares or not await esquema.hay_inventario(db):
        return {}
    filas = await db.scalars(
        select(ProductInventory).where(
            ProductInventory.product_id.in_({p for p, _ in pares}),
            ProductInventory.sku.in_({s for _, s in pares}),
        )
    )
    todas = {(f.product_id, f.sku): _leido(f) for f in filas}
    return {p: todas[p] for p in pares if p in todas}


async def movimientos(
    db: AsyncSession, *, product_id: str, sku: str, limite: int = 50
) -> list[InventoryMovement]:
    """El historial de un SKU, lo más reciente primero."""
    await esquema.exigir_inventario(db)
    return list(
        await db.scalars(
            select(InventoryMovement)
            .where(
                InventoryMovement.product_id == product_id,
                InventoryMovement.sku == sku,
            )
            .order_by(
                InventoryMovement.created_at.desc(), InventoryMovement.id.desc()
            )
            .limit(max(1, min(int(limite), 200)))
        )
    )


# --------------------------------------------------------------------------- #
# La única puerta
# --------------------------------------------------------------------------- #
async def _bloqueada(
    db: AsyncSession, *, product_id: str, sku: str, crear: bool
) -> ProductInventory | None:
    """La fila de inventario BLOQUEADA, creándola si toca.

    `for update` es lo que ordena dos peticiones simultáneas. La creación va con
    `on conflict do nothing` y una relectura: dos primeras entradas a la vez no
    pueden crear dos filas —la clave primaria no lo permite— pero sí llegarían
    las dos a la vez al `insert`.
    """
    fila = await db.scalar(
        select(ProductInventory)
        .where(
            ProductInventory.product_id == product_id, ProductInventory.sku == sku
        )
        .with_for_update()
    )
    if fila is not None or not crear:
        return fila

    from sqlalchemy.dialects.postgresql import insert as insert_pg
    from sqlalchemy.dialects.sqlite import insert as insert_sqlite

    dialecto = db.bind.dialect.name if db.bind is not None else ""
    constructor = insert_pg if dialecto == "postgresql" else insert_sqlite
    await db.execute(
        constructor(ProductInventory.__table__)
        .values(product_id=product_id, sku=sku, on_hand=0, reserved=0)
        .on_conflict_do_nothing(index_elements=["product_id", "sku"])
    )
    await db.flush()
    return await db.scalar(
        select(ProductInventory)
        .where(
            ProductInventory.product_id == product_id, ProductInventory.sku == sku
        )
        .with_for_update()
    )


def _aplicar(kind: str, cantidad: int, on_hand: int, reserved: int) -> tuple[int, int]:
    """Cómo queda tras el movimiento. Lógica pura: se puede leer y probar sola."""
    if kind in (ENTRADA, AJUSTE):
        return on_hand + cantidad, reserved
    if kind == RESERVA:
        return on_hand, reserved + cantidad
    if kind == LIBERACION:
        return on_hand, reserved - cantidad
    if kind == SALIDA:
        return on_hand - cantidad, reserved - cantidad
    raise MovimientoInvalido(f"Movimiento desconocido: {kind}")


async def sku_de_la_variante(db: AsyncSession, *, variante_id: str) -> tuple[str, str]:
    """`(producto, sku)` de una variante. Es el puente entre versión y almacén."""
    from app.modules.products.models import ProductVersion

    fila = (
        await db.execute(
            select(ProductVariant.sku, ProductVersion.product_id)
            .join(ProductVersion, ProductVersion.id == ProductVariant.version_id)
            .where(ProductVariant.id == variante_id)
        )
    ).first()
    if fila is None:
        raise UnidadNoEncontrada("Variante no encontrada.")
    return fila[1], fila[0]


async def mover(
    db: AsyncSession,
    *,
    product_id: str,
    sku: str,
    kind: str,
    cantidad: int,
    clave: str,
    actor_id: str | None,
    actor_rol: str,
    motivo: str | None = None,
) -> tuple[Existencias, InventoryMovement]:
    """Aplica un movimiento. LA ÚNICA FORMA de cambiar el inventario.

    Bloquea, comprueba, ESCRIBE EL MOVIMIENTO PRIMERO y luego los números: si la
    clave de idempotencia ya se usó, el choque contra la clave primaria ocurre
    antes de que nada se haya movido.
    """
    await esquema.exigir_inventario(db)

    cantidad = int(cantidad)
    sku = (sku or "").strip()
    if not sku:
        raise MovimientoInvalido("Falta el SKU.", details={"field": "sku"})
    if cantidad == 0:
        raise MovimientoInvalido("Un movimiento de cero no es un movimiento.")
    if abs(cantidad) > MAXIMO_DEL_MOVIMIENTO:
        raise MovimientoInvalido(
            "La cantidad es demasiado grande.",
            details={"max": MAXIMO_DEL_MOVIMIENTO},
        )
    if kind != AJUSTE and cantidad < 0:
        raise MovimientoInvalido("Solo un ajuste puede restar.", details={"kind": kind})
    if kind == AJUSTE and len((motivo or "").strip()) < 3:
        raise MovimientoInvalido(
            "Un ajuste lleva motivo: es lo único que permite auditarlo.",
            details={"field": "reason"},
        )
    if not (clave or "").strip():
        raise MovimientoInvalido(
            "Falta la clave de idempotencia.", details={"field": "idempotency_key"}
        )
    if actor_rol not in ROL_DE_AUDITORIA:
        raise MovimientoInvalido(f"Actor desconocido: {actor_rol}")

    if await db.get(Product, product_id) is None:
        raise UnidadNoEncontrada("Producto no encontrado.")

    #: Y EL SKU TIENE QUE SER EL DE UNA VARIANTE DE ESE PRODUCTO. Sin esto, una
    #: errata de mayúsculas —`cuch-20` por `CUCH-20`— creaba una fila de
    #: inventario que ninguna pantalla enseña nunca: siete unidades pagadas
    #: invisibles, y la variante diciendo «sin cargar» para siempre. Solo se
    #: inventaría lo que se ofrece.
    #:
    #: Se mira en TODAS las versiones del producto, no solo en la publicada: el
    #: almacén existe antes de publicar y sigue existiendo después.
    from app.modules.products.models import ProductVersion as _Version

    existe = await db.scalar(
        select(func.count())
        .select_from(ProductVariant)
        .join(_Version, _Version.id == ProductVariant.version_id)
        .where(_Version.product_id == product_id, ProductVariant.sku == sku)
    )
    if not existe:
        raise UnidadNoEncontrada(
            "Ese SKU no es el de ninguna variante de este producto.",
            details={"product_id": product_id, "sku": sku},
        )

    #: SOLO LA ENTRADA CREA LA FILA. Ajustar, reservar o despachar sobre un SKU
    #: que nadie inventarió no es «cero»: es que falta cargarlo.
    fila = await _bloqueada(
        db, product_id=product_id, sku=sku, crear=(kind == ENTRADA)
    )
    if fila is None:
        raise SinInventario(
            "Este SKU todavía no tiene inventario cargado.",
            details={"product_id": product_id, "sku": sku},
        )

    on_hand, reserved = _aplicar(kind, cantidad, int(fila.on_hand), int(fila.reserved))
    detalles = {
        "on_hand": int(fila.on_hand),
        "reserved": int(fila.reserved),
        "available": int(fila.on_hand) - int(fila.reserved),
        "requested": abs(cantidad),
        "sku": sku,
    }
    if on_hand < 0:
        raise NoAlcanza("No hay tantas unidades.", details=detalles)
    if reserved < 0:
        raise NoAlcanza("No hay tantas unidades comprometidas.", details=detalles)
    if reserved > on_hand:
        raise NoAlcanza("No queda bastante disponible.", details=detalles)

    identificador = id_del_movimiento(product_id, sku, clave)
    movimiento = InventoryMovement(
        id=identificador,
        product_id=product_id,
        sku=sku,
        kind=kind,
        quantity=cantidad,
        on_hand_after=on_hand,
        reserved_after=reserved,
        reason=(motivo or "").strip() or None,
        actor_id=actor_id,
        actor_role=actor_rol,
        idempotency_key=clave.strip(),
    )
    try:
        async with db.begin_nested():
            db.add(movimiento)
            await db.flush()
    except IntegrityError:
        #: LA MISMA CLAVE OTRA VEZ. Puede ser un REINTENTO —la misma petición,
        #: que no debe mover nada dos veces— o una clave REUTILIZADA para otra
        #: cosa, que es un error de quien llama y no puede contestarse con un
        #: «hecho» sobre un almacén que no se movió.
        anterior = await db.get(InventoryMovement, identificador)
        if anterior is None:
            raise
        mismo = (
            anterior.kind == kind
            and int(anterior.quantity) == cantidad
            and (anterior.reason or "") == ((motivo or "").strip() or "")
        )
        if not mismo:
            raise ClaveReutilizada(
                "Esa clave ya se usó para otra operación sobre esta unidad.",
                details={
                    "sku": sku,
                    "idempotency_key": clave.strip(),
                    "previous_kind": anterior.kind,
                    "previous_quantity": int(anterior.quantity),
                    "requested_kind": kind,
                    "requested_quantity": cantidad,
                },
            ) from None
        actual = await db.get(ProductInventory, (product_id, sku))
        return _leido(actual), anterior

    fila.on_hand = on_hand
    fila.reserved = reserved
    fila.updated_at = func.now()
    await db.flush()

    await auditoria.anotar(
        db,
        actor_id=actor_id,
        actor_role=ROL_DE_AUDITORIA[actor_rol],
        action=f"product_inventory.{kind}",
        entity_type="product",
        entity_id=product_id,
        reason=(motivo or "").strip() or None,
        payload={
            "sku": sku,
            "quantity": cantidad,
            "on_hand_after": on_hand,
            "reserved_after": reserved,
            "available_after": on_hand - reserved,
        },
    )
    return _leido(fila), movimiento


# --------------------------------------------------------------------------- #
# Los cinco movimientos
# --------------------------------------------------------------------------- #
async def entrada(
    db: AsyncSession,
    *,
    product_id: str,
    sku: str,
    cantidad: int,
    clave: str,
    actor_id: str,
    actor_rol: str = ACTOR_PROVEEDOR,
    motivo: str | None = None,
) -> tuple[Existencias, InventoryMovement]:
    """Entran unidades. Es el único movimiento que crea la fila de inventario."""
    if int(cantidad) <= 0:
        raise MovimientoInvalido("Una entrada suma: la cantidad es positiva.")
    return await mover(
        db,
        product_id=product_id,
        sku=sku,
        kind=ENTRADA,
        cantidad=cantidad,
        clave=clave,
        actor_id=actor_id,
        actor_rol=actor_rol,
        motivo=motivo,
    )


async def ajustar(
    db: AsyncSession,
    *,
    product_id: str,
    sku: str,
    cantidad: int,
    motivo: str,
    clave: str,
    actor_id: str,
    actor_rol: str = ACTOR_PROVEEDOR,
) -> tuple[Existencias, InventoryMovement]:
    """Corrige la existencia, con signo y CON MOTIVO.

    Es el único movimiento que cambia el número sin que haya ocurrido nada fuera
    del sistema, y por eso es el único que exige explicar por qué.
    """
    return await mover(
        db,
        product_id=product_id,
        sku=sku,
        kind=AJUSTE,
        cantidad=cantidad,
        clave=clave,
        actor_id=actor_id,
        actor_rol=actor_rol,
        motivo=motivo,
    )


async def reservar(
    db: AsyncSession,
    *,
    product_id: str,
    sku: str,
    cantidad: int,
    clave: str,
    actor_id: str | None = None,
    actor_rol: str = ACTOR_SISTEMA,
) -> tuple[Existencias, InventoryMovement]:
    """Compromete unidades. NO LO LLAMA EL CARRITO: ver la cabecera."""
    return await mover(
        db,
        product_id=product_id,
        sku=sku,
        kind=RESERVA,
        cantidad=cantidad,
        clave=clave,
        actor_id=actor_id,
        actor_rol=actor_rol,
    )


async def liberar(
    db: AsyncSession,
    *,
    product_id: str,
    sku: str,
    cantidad: int,
    clave: str,
    actor_id: str | None = None,
    actor_rol: str = ACTOR_SISTEMA,
) -> tuple[Existencias, InventoryMovement]:
    """Suelta lo comprometido. Vuelve a estar disponible."""
    return await mover(
        db,
        product_id=product_id,
        sku=sku,
        kind=LIBERACION,
        cantidad=cantidad,
        clave=clave,
        actor_id=actor_id,
        actor_rol=actor_rol,
    )


async def despachar(
    db: AsyncSession,
    *,
    product_id: str,
    sku: str,
    cantidad: int,
    clave: str,
    actor_id: str | None = None,
    actor_rol: str = ACTOR_SISTEMA,
) -> tuple[Existencias, InventoryMovement]:
    """Sale del almacén lo que estaba comprometido. Baja las dos cuentas."""
    return await mover(
        db,
        product_id=product_id,
        sku=sku,
        kind=SALIDA,
        cantidad=cantidad,
        clave=clave,
        actor_id=actor_id,
        actor_rol=actor_rol,
    )


# --------------------------------------------------------------------------- #
# Para las pantallas
# --------------------------------------------------------------------------- #
async def de_la_version(
    db: AsyncSession, *, product_id: str, version_id: str
) -> list[tuple[ProductVariant, Existencias | None]]:
    """Las variantes de una versión con lo que hay de cada SKU.

    `None` cuando ese SKU no tiene inventario cargado, y la pantalla lo dice con
    esas palabras en vez de pintar un cero.
    """
    variantes = list(
        await db.scalars(
            select(ProductVariant)
            .where(ProductVariant.version_id == version_id)
            .order_by(ProductVariant.position, ProductVariant.sku)
        )
    )
    existencias = await del_producto(db, product_id=product_id)
    return [(v, existencias.get(v.sku)) for v in variantes]


__all__ = [
    "Existencias",
    "MovimientoInvalido",
    "NoAlcanza",
    "ROL_DE_AUDITORIA",
    "SinInventario",
    "ClaveReutilizada",
    "UnidadNoEncontrada",
    "ajustar",
    "de_la_unidad",
    "de_la_version",
    "de_varios",
    "del_producto",
    "despachar",
    "entrada",
    "id_del_movimiento",
    "liberar",
    "mover",
    "movimientos",
    "reservar",
    "sku_de_la_variante",
]
