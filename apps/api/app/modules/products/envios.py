"""El envío de un pedido pagado: preparar, despachar y entregar. La 0079.

QUÉ RESUELVE ESTE FICHERO, EN ORDEN DE IMPORTANCIA:

  1. LA RESERVA DE UN PEDIDO PAGADO SE CONSUME EXACTAMENTE UNA VEZ, Y AL SALIR
     DEL ALMACÉN. No al cobrar —las unidades siguen en la caja— y no dos veces
     aunque lleguen dos despachos a la vez.

     TRES CAPAS, Y CADA UNA PARA EN UN SITIO DISTINTO. Se comprobó quitándolas
     de una en una y viendo qué prueba se ponía roja:

       arriba   EL ESTADO, BAJO EL CERROJO DE LA FILA. El segundo despacho
                espera en el `select ... for update`, despierta, relee y ve
                que el envío ya salió. Es la que hace que un reintento sea un
                éxito tranquilo y no un error. Quitar el cerrojo pone roja la
                prueba de concurrencia.
       en medio LA CLAVE DE IDEMPOTENCIA del movimiento, derivada del pedido y
                única en la base. Es la que para cuando quedan unidades
                apartadas POR OTRO PEDIDO del mismo SKU: ahí las cuentas
                cuadran y sin la clave se sacarían cuatro donde se vendieron
                dos. Hacerla aleatoria pone roja esa prueba, y el almacén se
                lleva por delante la reserva de otra persona.
       abajo    LA ARITMÉTICA DE `inventory.mover`: lo comprometido no puede
                quedar negativo. Es la última y no depende de nosotros.

     `dispatch_settled_at` NO ES NINGUNA DE LAS TRES: es la marca que deja
     dicho que esto ya se decidió, y lo que sostiene el CHECK de la 0079 que
     impide un envío despachado sin salida de almacén.

  2. UN PEDIDO QUE NO SE PAGÓ NO SE DESPACHA. Se comprueba en CADA paso, no
     solo en el primero: entre preparar y despachar pasa tiempo, y el día que
     alguien añada un camino nuevo la puerta tiene que seguir ahí.

  3. UN PROVEEDOR NO VE NI TOCA UN PEDIDO AJENO, y el ajeno es un 404. Decir
     «existe pero no es tuyo» ya cuenta que existe, y aquí contaría además que
     alguien compró eso.

  4. MODERACIÓN NO DESPACHA. Despachar mueve inventario, y mover inventario no
     es moderar. Lo mismo que ya vale para el ajuste de existencias: la puerta
     es `puede_intervenir_envios`, que es `admin` y nada más.

  5. EL HISTORIAL NO SE REESCRIBE. Cada salto deja su renglón con actor, rol y
     motivo, y un disparador de la 0079 rechaza cualquier `update` o `delete`.

LO QUE NO SE INVENTA, Y ES LA MITAD DEL TRABAJO:

  * NINGÚN TRANSPORTISTA. La empresa no ha elegido ninguno. `carrier_name` es
    texto libre y opcional, y cuando no se escribe queda NULO: nulo es «no lo
    dijeron», nunca «no hay» ni «N/A».
  * NINGUNA FECHA PREVISTA DE LLEGADA. Calcularla exige plazos de transporte
    que nadie ha fijado.
  * NINGÚN COSTE DE ENVÍO NI IMPUESTO. Siguen sin decidirse, y un cero es una
    promesa de envío gratis.
  * NINGÚN «ATRASADO». No hay plazo de despacho publicado en ninguna política,
    así que la cola de administración ordena por CUÁNTO LLEVA ESPERANDO —que
    es un hecho— y no marca nada como fuera de plazo, que sería un juicio
    contra un plazo que nadie escribió.
  * NINGUNA REPOSICIÓN AUTOMÁTICA. Una unidad entregada, dañada o devuelta no
    vuelve al almacén por su cuenta: eso es inspección de posventa, y es de
    los Incrementos 7 a 9.

Y CANCELAR UN PEDIDO PAGADO NO SE PUEDE. Está declarado en la máquina —quién
podría darlo el día que exista la decisión— y este servicio lo para con su
propio código, porque cancelar lo ya cobrado obliga a devolver el dinero y
ninguna política publicada dice con qué plazo, en qué casos ni quién paga el
porte de vuelta. Inventárselo sería inventarse la política.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import func, null, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    AppError,
    ConflictError,
    ForbiddenError,
    NotFoundError,
    ValidationAppError,
)
from app.modules.gobernanza import auditoria
from app.modules.products import avisos, esquema, estados_de_envio, inventory, pedidos
from app.modules.products.models import (
    ENTREGA_LA_DICE_EL_COMPRADOR,
    ENTREGA_LA_DICE_EL_PROVEEDOR,
    PEDIDO_PAGADO,
    ProductOrder,
    ProductOrderItem,
    ProductSeller,
    ProductShipment,
    ProductShipmentEvent,
    ProductShipmentItem,
)
from app.shared.permissions import FINANCE_ROLES, get_role

logger = logging.getLogger("renaser.products")

#: Los prefijos con los que ESTE módulo mueve el almacén. Deterministas y
#: atados al pedido: un reintento no despacha dos veces, y lo garantiza el
#: índice único de `inventory_movements`, no un `if` nuestro.
#:
#: SON DISTINTOS DE LOS DEL PEDIDO a propósito. `po-rel-` ya se usó para soltar
#: la reserva de un pedido que no se pagó; reutilizarlo aquí haría que el
#: segundo movimiento se tragara como un reintento del primero.
CLAVE_DE_SALIDA = "ps-dis-"
CLAVE_DE_DEVOLUCION_AL_COMUN = "ps-rel-"

#: Cómo se llama cada actor en la auditoría compartida. `audit_events.actor_role`
#: solo admite `user`, `admin`, `moderator` y `system` (0050, aplicada), y no se
#: amplía por esto: quien compra y quien vende actúan como usuarios sobre lo
#: suyo.
ROL_DE_AUDITORIA = {
    estados_de_envio.COMPRADOR: "user",
    estados_de_envio.PROVEEDOR: "user",
    estados_de_envio.ADMINISTRACION: "admin",
    estados_de_envio.SISTEMA: "system",
}


# --------------------------------------------------------------------------- #
# Los fallos, con su código
# --------------------------------------------------------------------------- #
class EnvioNoEncontrado(NotFoundError):
    """404 también para el ajeno. Ver la cabecera, punto 3."""

    code = "product_shipment_not_found"


class PedidoNoPagado(ConflictError):
    """Solo se prepara y se despacha lo que ya se cobró."""

    code = "product_shipment_order_not_paid"


class PreparacionIncompleta(ConflictError):
    """Falta meter unidades en la caja.

    409 Y CON LO QUE FALTA EN LOS DETALLES. Un paquete se cierra entero: no hay
    envíos parciales porque nadie ha decidido quién paga el segundo porte.
    """

    code = "product_shipment_not_fully_prepared"


class LineaAjena(ValidationAppError):
    code = "product_shipment_item_not_in_order"


class CantidadInvalida(ValidationAppError):
    code = "product_shipment_quantity_invalid"


class CancelacionSinPolitica(AppError):
    """Cancelar un pedido pagado exige una decisión que nadie ha tomado.

    409 Y NO 403: no es un permiso de quien pregunta, es que la empresa no ha
    publicado ninguna regla de cancelación. El detalle dice exactamente qué
    falta, para que se pueda pedir a quien decide.
    """

    status_code = 409
    code = "product_shipment_cancellation_not_configured"

    def __init__(self) -> None:
        super().__init__(
            "Todavía no hay política de cancelación de un pedido ya pagado.",
            details={
                "pending": [
                    "refund_policy",
                    "who_pays_return_shipping",
                    "when_stock_goes_back",
                ]
            },
        )


# --------------------------------------------------------------------------- #
# Piezas
# --------------------------------------------------------------------------- #
def ahora() -> datetime:
    return datetime.now(timezone.utc)


def _texto(valor: str | None, maximo: int) -> str | None:
    """Lo que escribieron, limpio. VACÍO ES NULO, nunca cadena vacía.

    Un `carrier_name = ''` guardado se pinta como un transportista sin nombre;
    nulo se pinta como lo que es, que es que no lo dijeron.
    """
    limpio = (valor or "").strip()
    return limpio[:maximo] or None


async def puede_intervenir_envios(db: AsyncSession, user_id: str) -> bool:
    """Quién puede mover un envío desde administración. SOLO `admin`.

    NO `is_admin`, que incluye a moderación. Un despacho mueve inventario, y
    mover inventario no es moderar: es el mismo conjunto —`FINANCE_ROLES`— que
    ya decide quién puede ajustar existencias y quién puede publicar.
    """
    return await get_role(db, user_id) in FINANCE_ROLES


async def exigir_interventor(db: AsyncSession, user_id: str) -> None:
    if not await puede_intervenir_envios(db, user_id):
        raise ForbiddenError(
            "Solo administración puede intervenir un envío.",
            code="product_shipment_intervene_forbidden",
        )


# --------------------------------------------------------------------------- #
# Quién puede mirar qué
# --------------------------------------------------------------------------- #
async def pedido_del_proveedor(
    db: AsyncSession, *, orden_id: str, usuario_id: str
) -> tuple[ProductOrder, ProductSeller]:
    """Un pedido PAGADO de MI tienda. El ajeno es un 404.

    LA DIRECCIÓN SOLO CUANDO HAY QUE ATENDERLO, y por eso se exige `PAID`
    también aquí: un pedido sin pagar no le enseña a nadie dónde vive quien lo
    intentó.
    """
    from app.modules.products import permissions as permisos

    vendedor = await permisos.exigir_vendedor_activo(db, usuario_id)
    await esquema.exigir_pedidos(db)
    orden = await db.get(ProductOrder, orden_id)
    if orden is None or orden.seller_id != vendedor.id:
        raise EnvioNoEncontrado("Pedido no encontrado.")
    if orden.status != PEDIDO_PAGADO:
        raise EnvioNoEncontrado("Pedido no encontrado.")
    return orden, vendedor


async def pedido_del_comprador(
    db: AsyncSession, *, orden_id: str, usuario_id: str
) -> ProductOrder:
    """Un pedido MÍO, en cualquier estado. El ajeno es un 404."""
    return await pedidos.leer(db, orden_id=orden_id, usuario_id=usuario_id)


# --------------------------------------------------------------------------- #
# Leer el envío
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class LineaPreparada:
    """Una línea del pedido con lo que se lleva metido en la caja."""

    order_item_id: str
    sku: str
    name: str
    variant_name: str | None
    ordered_quantity: int
    prepared_quantity: int

    @property
    def completa(self) -> bool:
        return self.prepared_quantity >= self.ordered_quantity


@dataclass(frozen=True)
class Envio:
    """El envío tal como lo lee una pantalla. `existe` distingue dos cosas.

    `existe = False` significa que NADIE LO HA TOCADO TODAVÍA, no que falte
    algo: la fila nace con la primera acción, y hasta entonces un pedido pagado
    está pendiente de preparación, que es exactamente lo que se contesta.
    """

    order_id: str
    status: str
    existe: bool
    carrier_name: str | None
    tracking_reference: str | None
    prepared_at: datetime | None
    ready_at: datetime | None
    dispatched_at: datetime | None
    delivered_at: datetime | None
    failed_at: datetime | None
    cancelled_at: datetime | None
    delivered_source: str | None
    buyer_confirmed_at: datetime | None
    failure_reason: str | None
    cancellation_reason: str | None
    items: list[LineaPreparada] = field(default_factory=list)


def _leido(fila: ProductShipment, lineas: list[LineaPreparada]) -> Envio:
    return Envio(
        order_id=fila.order_id,
        status=fila.status,
        existe=True,
        carrier_name=fila.carrier_name,
        tracking_reference=fila.tracking_reference,
        prepared_at=fila.prepared_at,
        ready_at=fila.ready_at,
        dispatched_at=fila.dispatched_at,
        delivered_at=fila.delivered_at,
        failed_at=fila.failed_at,
        cancelled_at=fila.cancelled_at,
        delivered_source=fila.delivered_source,
        buyer_confirmed_at=fila.buyer_confirmed_at,
        failure_reason=fila.failure_reason,
        cancellation_reason=fila.cancellation_reason,
        items=lineas,
    )


def _sin_fila(orden_id: str, lineas: list[LineaPreparada]) -> Envio:
    """El envío de un pedido pagado que todavía no ha tocado nadie."""
    return Envio(
        order_id=orden_id,
        status=estados_de_envio.PENDIENTE,
        existe=False,
        carrier_name=None,
        tracking_reference=None,
        prepared_at=None,
        ready_at=None,
        dispatched_at=None,
        delivered_at=None,
        failed_at=None,
        cancelled_at=None,
        delivered_source=None,
        buyer_confirmed_at=None,
        failure_reason=None,
        cancellation_reason=None,
        items=lineas,
    )


async def _lineas_con_preparado(
    db: AsyncSession,
    *,
    orden_id: str,
    hay_envios: bool,
    lineas=None,
) -> list[LineaPreparada]:
    """Las líneas del pedido con lo que llevan preparado. UNA consulta cada una.

    Y NO UNA POR LÍNEA. Preguntar el preparado de cada línea por separado es el
    N+1 que convierte un pedido de doce líneas en trece viajes a la base.

    `lineas` SE PUEDE PASAR HECHO, y no es un adorno: quien pinta el pedido del
    proveedor ya las ha leído para el albarán, y sin esto se leían otra vez.
    Lo encontró la revisión independiente contando consultas por pedido.
    """
    if lineas is None:
        lineas = await pedidos.lineas_de(db, orden_id)
    preparado: dict[str, int] = {}
    if hay_envios and lineas:
        filas = await db.execute(
            select(
                ProductShipmentItem.order_item_id,
                ProductShipmentItem.prepared_quantity,
            ).where(ProductShipmentItem.shipment_order_id == orden_id)
        )
        preparado = {fila[0]: int(fila[1]) for fila in filas}
    return [
        LineaPreparada(
            order_item_id=linea.id,
            sku=linea.sku,
            name=linea.name_snapshot,
            variant_name=linea.variant_name_snapshot,
            ordered_quantity=int(linea.quantity),
            prepared_quantity=preparado.get(linea.id, 0),
        )
        for linea in lineas
    ]


async def del_pedido(
    db: AsyncSession, *, orden: ProductOrder, lineas=None
) -> Envio | None:
    """El envío de ese pedido, o `None` si ese pedido no tiene envío.

    `None` SOLO PARA UN PEDIDO QUE NO SE PAGÓ. Un pedido pendiente, vencido o
    cancelado no tiene nada que enviar, y contestar «pendiente de preparación»
    ahí haría creer que va a salir algo.

    `lineas` SE PUEDE PASAR HECHO cuando quien llama ya las tiene delante. Ver
    `_lineas_con_preparado`.
    """
    if orden.status != PEDIDO_PAGADO:
        return None
    hay = await esquema.hay_envios(db)
    lineas = await _lineas_con_preparado(
        db, orden_id=orden.id, hay_envios=hay, lineas=lineas
    )
    if not hay:
        return _sin_fila(orden.id, lineas)
    fila = await db.get(ProductShipment, orden.id)
    return _sin_fila(orden.id, lineas) if fila is None else _leido(fila, lineas)


async def historial(db: AsyncSession, *, orden_id: str) -> list[ProductShipmentEvent]:
    """El historial del envío, del más antiguo al más nuevo."""
    if not await esquema.hay_envios(db):
        return []
    return list(
        await db.scalars(
            select(ProductShipmentEvent)
            .where(ProductShipmentEvent.shipment_order_id == orden_id)
            .order_by(ProductShipmentEvent.created_at, ProductShipmentEvent.id)
        )
    )


# --------------------------------------------------------------------------- #
# La única puerta por la que se mueve un envío
# --------------------------------------------------------------------------- #
async def _bloqueado(
    db: AsyncSession, *, orden_id: str, crear: bool
) -> ProductShipment | None:
    """La fila del envío BLOQUEADA y REFRESCADA, creándola si toca.

    `for update` es lo que ordena dos peticiones simultáneas, y
    `populate_existing` no es un adorno: sin él SQLAlchemy devuelve el objeto
    que ya tiene en el mapa de identidad y el cerrojo habría tomado la fila
    para leer una foto anterior.

    LA CREACIÓN VA CON `on conflict do nothing` Y UNA RELECTURA. Dos primeras
    acciones a la vez no pueden crear dos filas —la clave primaria no lo
    permite— pero sí llegarían las dos al `insert`.
    """

    async def _leer() -> ProductShipment | None:
        return await db.scalar(
            select(ProductShipment)
            .where(ProductShipment.order_id == orden_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )

    fila = await _leer()
    if fila is not None or not crear:
        return fila

    from sqlalchemy.dialects.postgresql import insert as insert_pg
    from sqlalchemy.dialects.sqlite import insert as insert_sqlite

    dialecto = db.bind.dialect.name if db.bind is not None else ""
    constructor = insert_pg if dialecto == "postgresql" else insert_sqlite
    await db.execute(
        constructor(ProductShipment.__table__)
        .values(order_id=orden_id, status=estados_de_envio.PENDIENTE)
        .on_conflict_do_nothing(index_elements=["order_id"])
    )
    await db.flush()
    return await _leer()


async def _anotar(
    db: AsyncSession,
    *,
    orden_id: str,
    desde: str | None,
    hasta: str,
    actor_id: str | None,
    actor_rol: str,
    motivo: str | None,
    momento: datetime,
) -> None:
    """Un renglón del historial. SIN DATOS PERSONALES: ni nombre, ni teléfono,
    ni dirección. Se lee para auditar un estado, no para recomponer a quién se
    le mandó qué."""
    db.add(
        ProductShipmentEvent(
            shipment_order_id=orden_id,
            from_status=desde,
            to_status=hasta,
            actor_id=actor_id,
            actor_role=actor_rol,
            reason=motivo,
            created_at=momento,
        )
    )


async def _consumir_la_reserva(
    db: AsyncSession, *, orden: ProductOrder, envio: ProductShipment, momento: datetime
) -> None:
    """Saca del almacén lo que este pedido tenía comprometido. UNA SOLA VEZ.

    LA MARCA DE ARRIBA ES UN ATAJO, NO LA PROTECCIÓN. `dispatch_settled_at`
    evita el viaje a la base cuando ya se decidió, pero por el camino normal no
    se llega aquí dos veces: el estado, bajo el cerrojo de la fila, ya paró al
    segundo. Lo que protege de verdad si alguien se cuela —otra conexión, otro
    nodo, un camino nuevo— es LA CLAVE DE IDEMPOTENCIA del movimiento, que es
    un índice único de la base y está probada en el único escenario en que
    llega a hacer falta: cuando el mismo SKU tiene unidades apartadas por otro
    pedido y las cuentas, por sí solas, cuadrarían.

    EN ORDEN ESTABLE Y SUMANDO POR (PRODUCTO, SKU), exactamente igual que la
    reserva: es la misma función, no una copia. Dos variantes pueden compartir
    la caja del almacén, y sacarlas por separado usaría la misma clave dos
    veces y la segunda se tragaría como si fuera un reintento.
    """
    if envio.dispatch_settled_at is not None:
        return
    lineas = list(
        await db.scalars(
            select(ProductOrderItem).where(ProductOrderItem.order_id == orden.id)
        )
    )
    for product_id, sku, cantidad in pedidos.por_unidad_de_almacen(lineas):
        #: SIN EL IDENTIFICADOR DE QUIEN VENDE. La ruta de movimientos de un SKU
        #: es suya y devuelve `actor_id`; firmar la salida con su cuenta no
        #: añade nada que el envío no diga mejor. Quien mueve es el sistema, y
        #: es lo que de verdad pasó: lo disparó un despacho, no un teclado.
        await inventory.despachar(
            db,
            product_id=product_id,
            sku=sku,
            cantidad=cantidad,
            clave=CLAVE_DE_SALIDA + orden.id,
            actor_id=None,
        )
    envio.dispatch_settled_at = momento


async def _devolver_al_comun(
    db: AsyncSession, *, orden: ProductOrder, envio: ProductShipment, momento: datetime
) -> None:
    """Suelta lo que este pedido apartaba. UNA SOLA VEZ y con su propia clave.

    HOY NO LO LLAMA NADIE EN PRODUCCIÓN: el único salto que lo usa es cancelar,
    y cancelar un pedido pagado está parado por falta de política. Existe aquí,
    completo y con su marca, porque el día que esa decisión llegue lo que no
    puede faltar es justo esto.
    """
    if envio.release_settled_at is not None or envio.dispatch_settled_at is not None:
        return
    lineas = list(
        await db.scalars(
            select(ProductOrderItem).where(ProductOrderItem.order_id == orden.id)
        )
    )
    for product_id, sku, cantidad in pedidos.por_unidad_de_almacen(lineas):
        await inventory.liberar(
            db,
            product_id=product_id,
            sku=sku,
            cantidad=cantidad,
            clave=CLAVE_DE_DEVOLUCION_AL_COMUN + orden.id,
            actor_id=None,
        )
    envio.release_settled_at = momento


async def mover(
    db: AsyncSession,
    *,
    orden: ProductOrder,
    hasta: str,
    actor_id: str | None,
    actor_rol: str,
    motivo: str | None = None,
    carrier_name: str | None = None,
    tracking_reference: str | None = None,
    momento: datetime | None = None,
) -> Envio:
    """Da un paso del envío. LA ÚNICA FORMA de cambiar su estado.

    REPARTIR ESTAS COMPROBACIONES ENTRE LAS RUTAS ES CÓMO SE DESPACHA ALGO SIN
    COBRAR el día que alguien añade un camino nuevo. Aquí, y en este orden:

      1. la migración está puesta;
      2. el pedido sigue pagado —se comprueba en CADA paso, no solo al empezar—;
      3. la fila del envío, bloqueada y refrescada;
      4. la máquina: ¿existe el salto, es de quien lo pide, lleva motivo?;
      5. el inventario, si ese salto lo toca;
      6. las fechas y el renglón del historial.

    NO CONFIRMA NI DESHACE LA TRANSACCIÓN. Quien llama decide: la ruta hace
    `commit`, y así un aviso encolado vive o muere con el hecho que lo provocó.
    """
    await esquema.exigir_envios(db)
    momento = momento or ahora()

    if orden.status != PEDIDO_PAGADO:
        raise PedidoNoPagado(
            "Ese pedido no está pagado.", details={"status": orden.status}
        )

    envio = await _bloqueado(db, orden_id=orden.id, crear=True)
    if envio is None:  # pragma: no cover - la fila acaba de crearse
        raise EnvioNoEncontrado("Envío no encontrado.")

    desde = envio.status
    limpio = estados_de_envio.exigir(desde, hasta, actor_rol, motivo)

    # --- Un paquete se cierra ENTERO, venga el paso de donde venga --------- #
    # ESTO ESTABA EN `marcar_listo` Y SE PODÍA RODEAR. La ruta de intervención
    # de administración llama aquí directamente, y la máquina le admite el salto
    # a «listo»: el resultado era un paquete cerrado con la caja vacía, y
    # después un despacho que sacaba del almacén unas unidades que nadie había
    # contado. Lo encontró la revisión independiente.
    #
    # Una invariante comprobada en la puerta y no en el paso es una invariante
    # que se rodea el día que alguien añade una puerta nueva. Aquí solo hay un
    # paso, y por eso la comprobación vive aquí.
    if hasta == estados_de_envio.LISTO:
        faltan = await lo_que_falta(db, orden_id=orden.id)
        if faltan:
            raise PreparacionIncompleta(
                "Falta meter unidades en la caja.", details={"missing": faltan}
            )

    # --- El inventario, antes de escribir el estado ----------------------- #
    # PRIMERO EL ALMACÉN Y DESPUÉS EL ESTADO. Si el almacén no cuadra, el
    # estado no debe haberse escrito: un envío «despachado» cuyo movimiento
    # falló diría que algo salió cuando sigue en la caja.
    if estados_de_envio.consume_inventario(desde, hasta):
        await _consumir_la_reserva(db, orden=orden, envio=envio, momento=momento)
    if estados_de_envio.libera_inventario(desde, hasta):
        await _devolver_al_comun(db, orden=orden, envio=envio, momento=momento)

    # --- Las fechas de cada estado ---------------------------------------- #
    envio.status = hasta
    envio.updated_at = momento
    if hasta == estados_de_envio.PREPARANDO and envio.prepared_at is None:
        envio.prepared_at = momento
    elif hasta == estados_de_envio.LISTO:
        envio.ready_at = momento
    elif hasta == estados_de_envio.DESPACHADO:
        envio.dispatched_at = momento
        #: SOLO SE ESCRIBEN SI VIENEN. Un reintento de entrega que no repite el
        #: transportista no puede borrar el que ya estaba.
        if carrier_name is not None:
            envio.carrier_name = _texto(carrier_name, 120)
        if tracking_reference is not None:
            envio.tracking_reference = _texto(tracking_reference, 120)
    elif hasta == estados_de_envio.ENTREGADO:
        envio.delivered_at = momento
        envio.delivered_source = (
            ENTREGA_LA_DICE_EL_COMPRADOR
            if actor_rol == estados_de_envio.COMPRADOR
            else ENTREGA_LA_DICE_EL_PROVEEDOR
        )
        if actor_rol == estados_de_envio.COMPRADOR:
            envio.buyer_confirmed_at = momento
    elif hasta == estados_de_envio.ENTREGA_FALLIDA:
        envio.failed_at = momento
        envio.failure_reason = limpio
    elif hasta == estados_de_envio.CANCELADO:
        envio.cancelled_at = momento
        envio.cancellation_reason = limpio

    await _anotar(
        db,
        orden_id=orden.id,
        desde=desde,
        hasta=hasta,
        actor_id=actor_id,
        actor_rol=actor_rol,
        motivo=limpio,
        momento=momento,
    )
    await db.flush()

    await auditoria.anotar(
        db,
        actor_id=actor_id,
        actor_role=ROL_DE_AUDITORIA[actor_rol],
        action=f"product_shipment.{hasta.lower()}",
        entity_type="product_order",
        entity_id=orden.id,
        #: EL MOTIVO NO VIAJA A LA AUDITORÍA COMPARTIDA, y esto costó
        #: encontrarlo: es TEXTO LIBRE que escribe quien vende, y lo primero
        #: que escribe cualquiera al reportar una entrega fallida es dónde fue
        #: y a quién buscaba. `audit_events` la leen otros módulos y otras
        #: personas, y la regla de la plataforma es que ahí no hay direcciones.
        #:
        #: EL PORQUÉ NO SE PIERDE: vive en `product_shipment_events`, que es de
        #: ESTE pedido y lo leen quien compró y quien vende, que ya conocen esa
        #: dirección porque es la suya. Está a un `join` de distancia de este
        #: rastro, que es lo que hace falta para investigar.
        #:
        #: NI DIRECCIÓN, NI NOMBRE, NI TELÉFONO EN LA CARGA. Lo que hace falta
        #: para auditar un envío es de dónde a dónde se movió y quién lo movió.
        payload={"from": desde, "to": hasta, "had_reason": limpio is not None},
    )

    lineas = await _lineas_con_preparado(db, orden_id=orden.id, hay_envios=True)
    return _leido(envio, lineas)


# --------------------------------------------------------------------------- #
# Lo que hace quien prepara
# --------------------------------------------------------------------------- #
async def anotar_preparado(
    db: AsyncSession,
    *,
    orden: ProductOrder,
    cantidades: dict[str, int],
    actor_id: str,
    actor_rol: str = estados_de_envio.PROVEEDOR,
    momento: datetime | None = None,
) -> Envio:
    """Apunta cuántas unidades de cada línea se llevan metidas en la caja.

    NO ES UN HISTORIAL Y SE CORRIGE. Quien empaqueta se equivoca, saca una
    unidad y la vuelve a meter; obligar a que cada corrección fuera un hecho
    inmutable convertiría la lista de comprobación en un expediente. Lo que sí
    es historial —cada cambio de ESTADO, con su actor y su motivo— está en
    `product_shipment_events`, y ese solo se añade.

    SOLO ANTES DE CERRAR EL PAQUETE. Con el envío ya listo o ya despachado, lo
    que se prepara dejó de ser una lista y pasó a ser lo que va dentro: para
    cambiarlo hay que reabrirlo, que es un salto con motivo.

    Y ENTRAR AQUÍ ARRANCA LA PREPARACIÓN. La primera anotación mueve el envío
    de pendiente a preparando, porque eso es exactamente lo que acaba de pasar.
    """
    await esquema.exigir_envios(db)
    momento = momento or ahora()

    if orden.status != PEDIDO_PAGADO:
        raise PedidoNoPagado(
            "Ese pedido no está pagado.", details={"status": orden.status}
        )

    envio = await _bloqueado(db, orden_id=orden.id, crear=True)
    if envio is None:  # pragma: no cover - la fila acaba de crearse
        raise EnvioNoEncontrado("Envío no encontrado.")

    if envio.status not in (estados_de_envio.PENDIENTE, estados_de_envio.PREPARANDO):
        estado = envio.status
        raise ConflictError(
            f"Ese envío ya no se está preparando: está {estado}.",
            code="product_shipment_not_preparing",
            details={"status": estado},
        )

    lineas = {l.id: l for l in await pedidos.lineas_de(db, orden.id)}
    for item_id, cantidad in cantidades.items():
        linea = lineas.get(item_id)
        if linea is None:
            #: 422 Y NO 404. La ruta existe y el pedido es suyo; lo que no
            #: cuadra es el cuerpo que mandó.
            raise LineaAjena(
                "Esa línea no es de este pedido.",
                details={"order_item_id": item_id},
            )
        valor = int(cantidad)
        if valor < 0 or valor > int(linea.quantity):
            #: NO SE PREPARA MÁS DE LO QUE SE COMPRÓ. Meter siete en la caja de
            #: un pedido de cinco es regalar dos unidades y descuadrar el
            #: almacén, porque lo que sale es lo que se reservó.
            raise CantidadInvalida(
                "Esa cantidad no cabe en la línea.",
                details={
                    "order_item_id": item_id,
                    "min": 0,
                    "max": int(linea.quantity),
                    "requested": valor,
                },
            )
        fila = await db.scalar(
            select(ProductShipmentItem).where(
                ProductShipmentItem.shipment_order_id == orden.id,
                ProductShipmentItem.order_item_id == item_id,
            )
        )
        if fila is None:
            db.add(
                ProductShipmentItem(
                    shipment_order_id=orden.id,
                    order_item_id=item_id,
                    prepared_quantity=valor,
                    created_at=momento,
                    updated_at=momento,
                )
            )
        else:
            fila.prepared_quantity = valor
            fila.updated_at = momento
    await db.flush()

    if envio.status == estados_de_envio.PENDIENTE:
        return await mover(
            db,
            orden=orden,
            hasta=estados_de_envio.PREPARANDO,
            actor_id=actor_id,
            actor_rol=actor_rol,
            momento=momento,
        )

    envio.updated_at = momento
    await db.flush()
    preparadas = await _lineas_con_preparado(db, orden_id=orden.id, hay_envios=True)
    return _leido(envio, preparadas)


async def lo_que_falta(db: AsyncSession, *, orden_id: str) -> list[dict]:
    """Qué líneas no están completas todavía. Vacío = el paquete se puede cerrar."""
    lineas = await _lineas_con_preparado(db, orden_id=orden_id, hay_envios=True)
    return [
        {
            "order_item_id": l.order_item_id,
            "sku": l.sku,
            "ordered_quantity": l.ordered_quantity,
            "prepared_quantity": l.prepared_quantity,
        }
        for l in lineas
        if not l.completa
    ]


async def marcar_listo(
    db: AsyncSession,
    *,
    orden: ProductOrder,
    actor_id: str,
    actor_rol: str = estados_de_envio.PROVEEDOR,
    momento: datetime | None = None,
) -> Envio:
    """Cierra el paquete. EXIGE QUE ESTÉ TODO DENTRO.

    UN PAQUETE SALE ENTERO O NO SALE. Cerrarlo a medias obliga a decidir qué
    pasa con lo que se quedó fuera —¿segundo envío?, ¿devolución parcial?,
    ¿quién paga el porte?— y ninguna política publicada lo dice. Mientras esa
    decisión no exista, lo honesto es no dejar cerrar.

    QUIEN LO EXIGE ES `mover`, no esta función. Estaba aquí y se podía rodear
    por la ruta de intervención de administración; ahora vive en el único paso
    por el que se llega a «listo», venga de donde venga. Esta función sigue
    existiendo porque es el nombre que usa quien prepara.
    """
    return await mover(
        db,
        orden=orden,
        hasta=estados_de_envio.LISTO,
        actor_id=actor_id,
        actor_rol=actor_rol,
        momento=momento,
    )


async def despachar(
    db: AsyncSession,
    *,
    orden: ProductOrder,
    actor_id: str,
    carrier_name: str | None = None,
    tracking_reference: str | None = None,
    momento: datetime | None = None,
) -> Envio:
    """Saca el paquete del almacén y CONSUME LA RESERVA, exactamente una vez.

    REPETIR LA LLAMADA NO VUELVE A DESPACHAR. Un envío ya despachado se
    devuelve tal cual, sin tocar el inventario y sin pisar el transportista que
    ya tenía: repetir un POST que se perdió por el camino no es despachar dos
    veces, y contestar 409 obligaría a quien llama a distinguir su propio
    reintento de un error de verdad.
    """
    await esquema.exigir_envios(db)
    envio = await _bloqueado(db, orden_id=orden.id, crear=False)
    if envio is not None and estados_de_envio.ya_salio(envio.status):
        lineas = await _lineas_con_preparado(db, orden_id=orden.id, hay_envios=True)
        return _leido(envio, lineas)
    return await mover(
        db,
        orden=orden,
        hasta=estados_de_envio.DESPACHADO,
        actor_id=actor_id,
        actor_rol=estados_de_envio.PROVEEDOR,
        carrier_name=carrier_name,
        tracking_reference=tracking_reference,
        momento=momento,
    )


async def registrar_entrega(
    db: AsyncSession,
    *,
    orden: ProductOrder,
    actor_id: str,
    actor_rol: str,
    momento: datetime | None = None,
) -> Envio:
    """Deja constancia de que el paquete llegó.

    QUIÉN LO AFIRMA SE GUARDA, y no es un detalle: el blueprint contempla que
    el transportista marque la entrega y quien compró la niegue. Sin saber
    quién lo dijo, esa discusión —que es del Incremento 7— no se puede tener.

    CONFIRMAR QUE LLEGÓ NO ES DAR LA CONFORMIDAD. Lo segundo libera dinero y no
    existe: no hay transferencias, no hay comisión y no hay plazo aprobado.
    Aquí no se mueve ni un céntimo.
    """
    await esquema.exigir_envios(db)
    momento = momento or ahora()

    #: QUIEN DICE QUE NO LE LLEGÓ NO PUEDE CONFIRMAR QUE LO RECIBIÓ.
    #:
    #: Es el bloqueo cruzado del Incremento 7, y se comprueba aquí y no en la
    #: pantalla: dos afirmaciones contrarias del mismo pedido dejarían un
    #: expediente donde quien reclama se desmiente solo, y eso lo usaría la
    #: otra parte para cerrar el caso sin mirarlo. Si de verdad apareció, lo
    #: que hay que hacer es retirar el caso, que deja rastro de que se retiró.
    if actor_rol == estados_de_envio.COMPRADOR:
        from app.modules.products import incidencias

        if await incidencias.hay_caso_vivo(db, orden_id=orden.id):
            raise ConflictError(
                "Tienes una incidencia abierta sobre este pedido.",
                code="product_shipment_incident_open",
                details={"order_id": orden.id},
            )

    envio = await _bloqueado(db, orden_id=orden.id, crear=False)
    if envio is not None and envio.status == estados_de_envio.ENTREGADO:
        #: YA ESTABA ENTREGADO. Si lo confirma quien compró, se guarda su
        #: confirmación —que es un dato que no teníamos— sin cambiar quién lo
        #: afirmó primero ni tocar el historial: no ha pasado nada nuevo.
        if (
            actor_rol == estados_de_envio.COMPRADOR
            and envio.buyer_confirmed_at is None
        ):
            envio.buyer_confirmed_at = momento
            envio.updated_at = momento
            await db.flush()
        lineas = await _lineas_con_preparado(db, orden_id=orden.id, hay_envios=True)
        return _leido(envio, lineas)
    return await mover(
        db,
        orden=orden,
        hasta=estados_de_envio.ENTREGADO,
        actor_id=actor_id,
        actor_rol=actor_rol,
        momento=momento,
    )


async def registrar_fallo(
    db: AsyncSession,
    *,
    orden: ProductOrder,
    actor_id: str,
    actor_rol: str,
    motivo: str,
    momento: datetime | None = None,
) -> Envio:
    """El intento de entrega no salió. CON MOTIVO, siempre.

    Sin el porqué no le sirve a nadie: ni a quien compró, que no sabe si volver
    a estar en casa, ni a quien vende, que no sabe si reintentar.
    """
    return await mover(
        db,
        orden=orden,
        hasta=estados_de_envio.ENTREGA_FALLIDA,
        actor_id=actor_id,
        actor_rol=actor_rol,
        motivo=motivo,
        momento=momento,
    )


async def reintentar_entrega(
    db: AsyncSession,
    *,
    orden: ProductOrder,
    actor_id: str,
    actor_rol: str,
    motivo: str,
    momento: datetime | None = None,
) -> Envio:
    """El transportista vuelve a intentarlo. NO ES MARCHA ATRÁS.

    El paquete no vuelve al almacén y el inventario no se toca: sigue fuera.
    Es un intento nuevo, y lleva motivo para que se pueda leer por qué falló el
    anterior.
    """
    return await mover(
        db,
        orden=orden,
        hasta=estados_de_envio.DESPACHADO,
        actor_id=actor_id,
        actor_rol=actor_rol,
        motivo=motivo,
        momento=momento,
    )


async def reabrir(
    db: AsyncSession,
    *,
    orden: ProductOrder,
    actor_id: str,
    actor_rol: str,
    motivo: str,
    momento: datetime | None = None,
) -> Envio:
    """Vuelve a abrir un paquete cerrado. Solo antes de que salga.

    Es el único paso atrás de esta máquina, y se permite porque nada ha salido
    y nada se ha consumido. Prohibirlo dejaría un paquete atascado en «listo»
    cuando se rompe algo al embalar, y un estado atascado se acaba resolviendo
    mintiendo en el siguiente.
    """
    return await mover(
        db,
        orden=orden,
        hasta=estados_de_envio.PREPARANDO,
        actor_id=actor_id,
        actor_rol=actor_rol,
        motivo=motivo,
        momento=momento,
    )


async def cancelar(
    db: AsyncSession,
    *,
    orden: ProductOrder,
    actor_id: str,
    motivo: str,
    momento: datetime | None = None,
) -> Envio:
    """Cancela el envío de un pedido YA PAGADO y suelta lo apartado.

    HOY SE PARA SIEMPRE, Y NO POR PRUDENCIA NUESTRA. Cancelar lo ya cobrado
    obliga a devolver el dinero, y `product_policies` no tiene ninguna columna
    que diga con qué plazo, en qué casos, quién paga el porte de vuelta ni
    cuándo se repone el stock. Ejecutarlo igual sería inventarse la política de
    devoluciones de la empresa, en silencio y para siempre.

    LO QUE SÍ EXISTE ES TODO LO DEMÁS: el salto está declarado en la máquina con
    su actor, la liberación del inventario está escrita con su marca y su clave
    de idempotencia, y el CHECK de la base exige que cancelar y soltar vayan
    juntos. El día que esa decisión llegue, lo que falta es quitar esta puerta.
    """
    raise CancelacionSinPolitica()


# --------------------------------------------------------------------------- #
# Los avisos. DESPUÉS del hecho, y sin prometer nada
# --------------------------------------------------------------------------- #
async def avisar(db: AsyncSession, *, orden: ProductOrder, estado: str) -> None:
    """Le cuenta a quien compró lo que acaba de pasar con su paquete.

    NO AVISA DE LO QUE ESA PERSONA ACABA DE HACER. Si confirmó ella misma la
    recepción, mandarle «tu pedido figura entregado» es contarle lo que acaba
    de escribir. La ruta decide; aquí solo está el reparto por estado.

    UNA LIMITACIÓN CONOCIDA, Y SE PREFIERE A LA CONTRARIA. La barrera
    anti-repetición de avisos deduplica por `(persona, tipo, entidad)`, así que
    un SEGUNDO intento de entrega fallido del mismo pedido no vuelve a sonar.
    Aflojarla —metiendo el número de intento en la entidad— haría que un
    webhook reintentado avisara dos veces del mismo hecho, y romper el enlace
    del aviso al pedido. Entre callar una repetición y gritar dos veces lo
    mismo, se calla: el estado del pedido lo dice entero cuando se abre, y la
    pantalla lo enseña. Está anotado en las decisiones pendientes.
    """
    tipo = {
        estados_de_envio.DESPACHADO: avisos.DESPACHADO,
        estados_de_envio.ENTREGADO: avisos.ENTREGADO,
        estados_de_envio.ENTREGA_FALLIDA: avisos.ENTREGA_FALLIDA,
    }.get(estado)
    if tipo is None:
        return
    await avisos.encolar(
        db, usuario_id=orden.buyer_id, tipo=tipo, entidad_id=orden.id
    )


# --------------------------------------------------------------------------- #
# Las listas
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class PendienteDeAtencion:
    """Una fila de la cola de administración. SIN DATOS PERSONALES.

    Ni dirección, ni nombre de quien compró, ni importe. Lo que hace falta para
    saber si un paquete está parado es de quién es, en qué estado está y cuánto
    lleva así.

    Y NI EL MOTIVO DE UNA ENTREGA FALLIDA, que es lo que encontró la revisión
    independiente. Ese motivo es TEXTO LIBRE que escribe quien vende, y lo
    primero que escribe cualquiera al reportar una entrega fallida es dónde fue
    y a quién buscaba: «Nadie en <la calle>; <el nombre> no contesta al
    <teléfono>». Traerlo aquí convertía esta cola en un reparto de domicilios
    —justo lo que esta clase prometía que no era— y encima la lee curaduría,
    que es un conjunto más ancho que administración.

    QUE LA ENTREGA FALLÓ SE SABE POR `status`, que es lo que hace falta para
    decidir si ese paquete necesita a alguien. Para leer el porqué hay que
    entrar al pedido, y esa ruta todavía no existe para administración: cuando
    exista tendrá que exigir `admin` y dejar rastro por pedido, como ya hace la
    cola de conciliación desde que se endureció por esto mismo.
    """

    order_id: str
    seller_id: str
    seller_name: str | None
    status: str
    paid_at: datetime | None
    dispatched_at: datetime | None
    units: int
    #: CUÁNTO LLEVA ESPERANDO, EN HORAS. Es un HECHO, no un juicio: no hay
    #: ningún plazo de despacho publicado contra el que compararlo, así que
    #: esto no dice «atrasado», dice cuánto tiempo ha pasado.
    waiting_hours: int | None


#: NO HAY CONTADOR DE ESTA BANDEJA, y es a propósito. Uno escrito sobre esta
#: misma consulta habría tenido que traerse las filas para contarlas, y con el
#: tope puesto diría «200» habiendo setecientas: un número redondo y falso en
#: un sitio donde se mira para decidir si algo está parado. El día que haga
#: falta, se escribe un `count` de verdad, sin tope y sin traerse las filas.
async def para_administracion(
    db: AsyncSession, *, limite: int = 50
) -> list[PendienteDeAtencion]:
    """Los pedidos pagados cuyo paquete todavía no ha llegado.

    LOS QUE MÁS LLEVAN ESPERANDO, PRIMERO. Y no se marca ninguno como
    «atrasado»: ninguna política publicada fija un plazo de despacho, y
    llamarle tarde a algo sin plazo es inventarse el plazo. Lo que se da es el
    tiempo transcurrido, que es un hecho, y quien mira decide.

    INCLUYE LOS QUE NO TIENEN FILA DE ENVÍO. Son precisamente los que nadie ha
    tocado —los más importantes de esta cola—, y un `join` normal los dejaría
    fuera: es un `left join`.
    """
    await esquema.exigir_pedidos(db)
    hay = await esquema.hay_envios(db)
    momento = ahora()
    tope = max(1, min(int(limite), 200))

    if hay:
        consulta = (
            select(ProductOrder, ProductSeller.display_name, ProductShipment)
            .join(ProductSeller, ProductSeller.id == ProductOrder.seller_id)
            .outerjoin(ProductShipment, ProductShipment.order_id == ProductOrder.id)
            .where(
                ProductOrder.status == PEDIDO_PAGADO,
                (ProductShipment.order_id.is_(None))
                | (
                    ProductShipment.status.not_in(
                        (estados_de_envio.ENTREGADO, estados_de_envio.CANCELADO)
                    )
                ),
            )
        )
    else:
        #: SIN LA 0079 NO HAY ENVÍOS, así que todo pedido pagado está pendiente
        #: de preparación. La cola no se cae: dice la verdad, que es que no ha
        #: salido ninguno.
        consulta = (
            select(ProductOrder, ProductSeller.display_name, null())
            .join(ProductSeller, ProductSeller.id == ProductOrder.seller_id)
            .where(ProductOrder.status == PEDIDO_PAGADO)
        )

    filas = list(
        await db.execute(
            consulta.order_by(ProductOrder.paid_at, ProductOrder.id).limit(tope)
        )
    )
    if not filas:
        return []

    #: LAS UNIDADES DE TODOS LOS PEDIDOS DE GOLPE. Una consulta por pedido
    #: convertiría una cola de cincuenta en cincuenta y un viajes.
    ids = [fila[0].id for fila in filas]
    unidades = {
        f[0]: int(f[1] or 0)
        for f in await db.execute(
            select(
                ProductOrderItem.order_id, func.sum(ProductOrderItem.quantity)
            )
            .where(ProductOrderItem.order_id.in_(ids))
            .group_by(ProductOrderItem.order_id)
        )
    }

    salida: list[PendienteDeAtencion] = []
    for orden, nombre, envio in filas:
        pagado = pedidos.comparable(orden.paid_at, momento)
        salida.append(
            PendienteDeAtencion(
                order_id=orden.id,
                seller_id=orden.seller_id,
                seller_name=nombre,
                status=(
                    envio.status
                    if isinstance(envio, ProductShipment)
                    else estados_de_envio.PENDIENTE
                ),
                paid_at=orden.paid_at,
                dispatched_at=(
                    envio.dispatched_at if isinstance(envio, ProductShipment) else None
                ),
                #: EL MOTIVO DEL FALLO NO VIAJA. Ver la cabecera de la clase.
                units=unidades.get(orden.id, 0),
                waiting_hours=(
                    int((momento - pagado).total_seconds() // 3600)
                    if pagado is not None
                    else None
                ),
            )
        )
    return salida


__all__ = [
    "CLAVE_DE_DEVOLUCION_AL_COMUN",
    "CLAVE_DE_SALIDA",
    "CancelacionSinPolitica",
    "CantidadInvalida",
    "Envio",
    "EnvioNoEncontrado",
    "LineaAjena",
    "LineaPreparada",
    "PedidoNoPagado",
    "PendienteDeAtencion",
    "PreparacionIncompleta",
    "ROL_DE_AUDITORIA",
    "ahora",
    "anotar_preparado",
    "avisar",
    "cancelar",
    "del_pedido",
    "despachar",
    "exigir_interventor",
    "historial",
    "lo_que_falta",
    "marcar_listo",
    "mover",
    "para_administracion",
    "pedido_del_comprador",
    "pedido_del_proveedor",
    "puede_intervenir_envios",
    "reabrir",
    "registrar_entrega",
    "registrar_fallo",
    "reintentar_entrega",
]
