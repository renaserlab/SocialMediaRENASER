"""Órdenes de evento: de una reserva vigente a una compra confirmada.

EL CAMINO ENTERO, y dónde se corta:

    hold vigente -> orden -> intento de pago -> aviso verificado -> entradas

QUIÉN DECIDE QUE HUBO UN COBRO. El webhook verificado del proveedor, y nadie
más. Ni que el navegador vuelva de la pasarela, ni que el móvil diga que pagó,
ni que la orden lleve un rato en `PAYMENT_PROCESSING`. La única excepción es la
orden de total CERO, que no necesita a nadie: no hay dinero que confirmar.

DÓNDE SE SERIALIZA. En la misma fila de siempre: `events`, con `select ... for
update`. Es el cerrojo que ya usan la reserva gratuita y el hold, así que un
evento no reparte aforo por tres caminos a la vez y no hay dos órdenes de
bloqueo que puedan invertirse. Después se toma la fila del hold, y solo
después. Ese orden no cambia en ninguna función de este módulo.

EL INVENTARIO SIGUE SIENDO DEL HOLD. Crear una orden NO consume la reserva: la
reserva sigue apartando las entradas mientras se prepara el pago, y si vence,
vence con la orden dentro. Un pago que llega tarde no concede aforo: falla en
cerrado y queda para conciliar a mano. Inventar capacidad para no dar una mala
noticia es la forma de meter a 210 personas en una sala de 200.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.exceptions import AppError, ConflictError, NotFoundError
from app.modules.events import esquema, inventory, states, ticketing
from app.modules.events.models import (
    ENTRADA_VALIDA,
    ORDEN_CANCELADA,
    ORDEN_EN_CURSO,
    ORDEN_FALLIDA,
    ORDEN_PAGADA,
    ORDEN_PENDIENTE,
    ORDEN_VENCIDA,
    EventOperations,
    EventOrder,
    EventOrderItem,
    EventTicket,
    EventTicketHold,
)

ACTIVO = "ACTIVE"
CONSUMIDO = "CONSUMED"


def ahora() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Errores, con código estable. La pantalla se ramifica por el código, nunca por
# el texto: el texto está en español y cambia; el código es el contrato.
# --------------------------------------------------------------------------- #
class _ErrorDeOrden(ConflictError):
    pass


class ReservaNoUtilizable(_ErrorDeOrden):
    """La reserva ya no aparta nada: venció, se liberó o ya se consumió."""

    code = "ticket_hold_not_usable"
    message = "Esa reserva ya no está en pie. Vuelve a elegir tus entradas."


class YaHayUnaOrden(_ErrorDeOrden):
    """Esa reserva ya tiene su orden. Se vuelve a ella, no se crea otra."""

    code = "event_order_already_exists"
    message = "Esta reserva ya tiene un pedido en curso."

    #: `details` lleva `{"order_id": ...}`: es el pedido al que hay que ir.


class ClaveReutilizada(_ErrorDeOrden):
    code = "event_order_conflict"
    message = "Esa clave de idempotencia ya se usó para otro pedido."


class OrdenNoPagable(_ErrorDeOrden):
    code = "event_order_not_payable"
    message = "Este pedido ya no admite un pago."


class PagosNoDisponibles(AppError):
    status_code = 503
    code = "event_payments_not_available"
    message = "El cobro de entradas todavía no está disponible."


class OrdenesNoDisponibles(AppError):
    status_code = 503
    code = "event_orders_not_available"
    message = "La compra de entradas todavía no está disponible."


class PagoNoCuadra(_ErrorDeOrden):
    """El aviso del proveedor no coincide con lo que dice la orden."""

    code = "event_payment_mismatch"
    message = "El cobro no coincide con el pedido."


async def exigir_ordenes_disponibles(db: AsyncSession) -> None:
    """La migración 0062 Y la bandera de entradas.

    Sin la 0062 no hay dónde anotar una orden; con `FEATURE_EVENT_TICKETING`
    apagada no se ofrece el flujo comercial. Las dos responden 503 con el mismo
    código porque para quien llama significan lo mismo: esto todavía no está.
    """
    if not get_settings().feature_event_ticketing or not await esquema.hay_ordenes(db):
        raise OrdenesNoDisponibles()


# --------------------------------------------------------------------------- #
# Crear la orden
# --------------------------------------------------------------------------- #
@dataclass
class OrdenCreada:
    """La orden y si acaba de nacer.

    `estrenada` en falso significa que se devolvió la que ya existía: un
    reintento no cobra dos veces ni emite dos juegos de entradas.
    """

    orden: EventOrder
    estrenada: bool


async def crear_orden(
    db: AsyncSession,
    *,
    hold_id: str,
    usuario_id: str,
    clave: str,
    momento: datetime | None = None,
) -> OrdenCreada:
    """Convierte una reserva vigente en una orden. Una transacción.

    NO CONSUME LA RESERVA. El inventario lo sigue apartando el hold hasta que
    el pago se confirma; consumirlo aquí dejaría entradas apartadas por una
    orden que puede no pagarse nunca.
    """
    hold = await db.get(EventTicketHold, hold_id)
    if hold is None or hold.user_id != usuario_id:
        # 404 TAMBIÉN PARA LA RESERVA AJENA: decir «existe pero no es tuya» ya
        # cuenta que alguien más está comprando ese evento.
        await db.rollback()
        raise NotFoundError("Reserva no encontrada.", code="ticket_hold_not_found")

    evento_id = hold.event_id
    # EL CERROJO, Y EN EL ORDEN DE SIEMPRE: primero el evento, después el hold.
    evento = await inventory.bloquear_evento(db, evento_id)
    momento = momento or ahora()

    # `populate_existing`: SIN ESTO EL CERROJO NO SIRVE DE NADA. El objeto ya
    # está en el mapa de identidad —se leyó unas líneas más arriba para saber de
    # qué evento es—, y SQLAlchemy devuelve el que tiene sin refrescarlo. El
    # `for update` toma la fila, sí, pero lo que se comprueba debajo es la foto
    # anterior: una reserva liberada mientras se esperaba el cerrojo seguiría
    # pareciendo `ACTIVE`.
    async with inventory.espera_traducida(db):
        hold = await db.scalar(
            select(EventTicketHold)
            .where(EventTicketHold.id == hold_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    if hold is None:
        await db.rollback()
        raise NotFoundError("Reserva no encontrada.", code="ticket_hold_not_found")

    firma = hold.request_fingerprint or ""

    # IDEMPOTENCIA, Y ANTES DE MIRAR SI LA RESERVA SIGUE VIVA. El mismo pedido
    # no puede dar dos respuestas distintas según el segundo en que llegue: un
    # reintento de red que aterriza un instante después de que el hold venza
    # tiene que recibir la orden que ya se creó, no «tu reserva caducó».
    ya = await db.scalar(
        select(EventOrder).where(
            EventOrder.event_id == evento_id,
            EventOrder.buyer_id == usuario_id,
            EventOrder.idempotency_key == clave,
        )
    )
    if ya is not None:
        distinta = ya.hold_id != hold_id
        await db.commit()
        if distinta:
            raise ClaveReutilizada()
        return OrdenCreada(ya, estrenada=False)

    # Esa reserva ya tiene orden, con otra clave. Se dice cuál para poder ir.
    suya = await db.scalar(select(EventOrder).where(EventOrder.hold_id == hold_id))
    if suya is not None:
        detalle = {"order_id": suya.id}
        await db.rollback()
        raise YaHayUnaOrden(details=detalle)

    # --- La reserva tiene que estar EN PIE ------------------------------- #
    if hold.status != ACTIVO or ticketing._comparable(hold.expires_at, momento) <= momento:
        await db.rollback()
        raise ReservaNoUtilizable()

    lineas = await ticketing.lineas_de(db, hold.id)
    if not lineas:
        await db.rollback()
        raise ReservaNoUtilizable()

    suma = sum(int(l.subtotal_minor) for l in lineas)
    if suma != int(hold.subtotal_minor):
        # No debería poder ocurrir —lo sostiene el disparador de la 0061— pero
        # si ocurriera, cobrar un importe que no cuadra con sus líneas es
        # exactamente lo que no se puede hacer.
        await db.rollback()
        raise ReservaNoUtilizable()

    # --- El evento tiene que admitir la venta ---------------------------- #
    operacion = await db.get(EventOperations, evento_id)
    workflow = operacion.workflow_status if operacion else None
    if not states.se_puede_saber_que_existe(workflow, evento.status):
        await db.rollback()
        raise NotFoundError("Evento no encontrado.")
    if not states.admite_reservas(workflow or "PUBLISHED"):
        await db.rollback()
        raise ConflictError("Ese evento no admite compras.")
    if inventory.es_pasado(evento, momento):
        await db.rollback()
        raise ConflictError("Ese evento ya terminó.")

    ajustes = await ticketing.configuracion(db, evento_id)
    fallo = ticketing.motivo_para_no_vender(ajustes, momento)
    if fallo is not None:
        await db.rollback()
        raise fallo

    # --- La orden, con TODO copiado ------------------------------------- #
    orden = EventOrder(
        event_id=evento_id,
        buyer_id=usuario_id,
        hold_id=hold_id,
        status=ORDEN_PENDIENTE,
        currency=hold.currency,
        subtotal_minor=suma,
        # HOY `total = subtotal`. Comisión e impuestos son un incremento
        # posterior; escribir aquí un total distinto sería inventarse un cargo.
        total_minor=suma,
        provider="none",
        environment=get_settings().payments_environment,
        idempotency_key=clave,
        request_fingerprint=firma,
        created_at=momento,
        updated_at=momento,
    )
    db.add(orden)
    await db.flush()

    for linea in lineas:
        db.add(
            EventOrderItem(
                order_id=orden.id,
                event_id=evento_id,
                ticket_type_id=linea.ticket_type_id,
                # CONGELADO DEL HOLD, no releído del tipo: entre apartar y pagar
                # el organizador puede haber renombrado o subido el precio, y lo
                # que se cobra es lo que se enseñó.
                ticket_type_name_snapshot=linea.ticket_type_name_snapshot,
                unit_price_minor=linea.unit_price_minor,
                quantity=linea.quantity,
                subtotal_minor=linea.subtotal_minor,
                created_at=momento,
            )
        )

    if suma == 0:
        # GRATUITA: no hay nada que cobrar y no hay a quién preguntar. Se
        # confirma aquí mismo, con el cerrojo del evento todavía puesto.
        await _confirmar(db, orden=orden, hold=hold, momento=momento)
    await db.commit()
    return OrdenCreada(orden, estrenada=True)


# --------------------------------------------------------------------------- #
# Confirmar y emitir. UNA sola operación interna, y todo o nada.
# --------------------------------------------------------------------------- #
async def _confirmar(
    db: AsyncSession, *, orden: EventOrder, hold: EventTicketHold, momento: datetime
) -> list[EventTicket]:
    """Marca pagada, consume la reserva y emite. Sin `commit`: lo hace quien llama.

    EL ORDEN IMPORTA. Se emite DESPUÉS de marcar `PAID` porque el disparador
    diferido de la 0062 comprueba al confirmar que una orden pagada tiene
    exactamente las entradas compradas: si algo de esto falla a medias, no queda
    una orden pagada sin entradas ni entradas de una orden pendiente. Lo
    garantiza la transacción, no el orden de las líneas.
    """
    from app.modules.events import tickets as emision

    orden.status = ORDEN_PAGADA
    orden.paid_at = momento
    orden.updated_at = momento

    hold.status = CONSUMIDO
    hold.updated_at = momento

    return await emision.emitir(db, orden=orden, momento=momento)


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
) -> OrdenCreada:
    """Confirma una orden con la evidencia de un cobro YA VERIFICADO.

    Quien llama tiene que haber comprobado la firma del aviso. Esta función no
    puede hacerlo: no ve la petición. Lo que sí hace es negarse a confirmar
    cualquier cosa que no cuadre EXACTAMENTE con lo que la orden dice.

    FALLA EN CERRADO. Un importe ausente, una moneda ausente, un entorno
    distinto o un proveedor distinto no confirman nada. La ausencia de un dato
    no vale como coincidencia: sustituirla por el valor esperado —un `or`, un
    `coalesce`— convierte un aviso incompleto en una entrada regalada.

    NO CONFIRMA NI DESHACE LA TRANSACCIÓN, y no es un descuido: esto corre
    dentro del SAVEPOINT que abre el webhook, y en esa misma transacción vive la
    fila anti-repetición del aviso. Un `rollback` aquí se llevaría por delante
    justo el registro que impide procesar dos veces el mismo cobro. Quien llama
    decide: el webhook confirma una vez al final, y si algo falla el savepoint
    deshace solo esto y el error queda anotado.
    """
    momento = momento or ahora()

    # EL EVENTO PRIMERO, COMO EN TODOS LOS DEMÁS CAMINOS. Tomar antes la fila de
    # la orden invertía el orden de bloqueo del módulo, y además ese `for update`
    # corría sin tiempo límite —`set local lock_timeout` lo pone
    # `bloquear_evento`—: un webhook podía quedarse esperando indefinidamente
    # con una conexión del pool ocupada mientras la pasarela reintentaba.
    #
    # `deshacer=False`: esto corre dentro del savepoint del webhook.
    cabecera = await db.get(EventOrder, orden_id)
    if cabecera is None:
        raise NotFoundError("Pedido no encontrado.", code="event_order_not_found")
    evento = await inventory.bloquear_evento(db, cabecera.event_id, deshacer=False)

    async with inventory.espera_traducida(db, deshacer=False):
        orden = await db.scalar(
            select(EventOrder)
            .where(EventOrder.id == orden_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    if orden is None:
        raise NotFoundError("Pedido no encontrado.", code="event_order_not_found")

    # YA PAGADA: un aviso repetido no emite otro juego de entradas. Se comprueba
    # que sea el MISMO cobro; otro cobro sobre una orden ya pagada es un
    # problema de conciliación, no una confirmación.
    if orden.status == ORDEN_PAGADA:
        if (orden.external_payment_id or "") != external_payment_id:
            raise PagoNoCuadra("Ese pedido ya se pagó con otro cobro.")
        return OrdenCreada(orden, estrenada=False)

    if orden.status not in ORDEN_EN_CURSO:
        # Vencida, cancelada o fallida. UN PAGO TARDÍO NO CONCEDE AFORO: la
        # reserva ya soltó las entradas y otra persona puede tenerlas. Se deja
        # constancia y lo resuelve una persona; inventarse capacidad para no dar
        # una mala noticia es meter a 210 en una sala de 200.
        raise PagoNoCuadra(f"Ese pedido ya no admite un pago: está {orden.status}.")

    fallo = _por_que_no_cuadra(
        orden,
        provider=provider,
        environment=environment,
        amount_minor=amount_minor,
        currency=currency,
    )
    if fallo is not None:
        raise PagoNoCuadra(fallo)

    # El del hold, después del evento y de la orden. `populate_existing` por lo
    # mismo que en `crear_orden`.
    async with inventory.espera_traducida(db, deshacer=False):
        hold = await db.scalar(
            select(EventTicketHold)
            .where(EventTicketHold.id == orden.hold_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    if hold is None:
        raise PagoNoCuadra("El pedido no tiene reserva que consumir.")

    if hold.status == CONSUMIDO:
        # La reserva ya se consumió y la orden no está pagada: no cuadra, y no
        # se arregla adivinando.
        raise PagoNoCuadra("La reserva de ese pedido ya se consumió.")
    if hold.status != ACTIVO or ticketing._comparable(hold.expires_at, momento) <= momento:
        # PAGO TARDÍO. La reserva venció mientras se pagaba: el aforo volvió al
        # común y puede estar vendido. No se emite nada.
        raise PagoNoCuadra("La reserva venció antes de que llegara el cobro.")

    # EL AFORO, OTRA VEZ Y BAJO EL CERROJO. El hold sigue vivo, así que sus
    # entradas siguen contadas como apartadas; esto comprueba que el evento no
    # se haya quedado sin sitio por otra vía —una reducción del aforo aprobado,
    # por ejemplo— entre apartar y pagar.
    libre = await ticketing.disponibilidad(db, evento, momento)
    if libre.exceso > 0:
        # `general < 0` era imposible: `disponibilidad` lo recorta a cero, así
        # que la comprobación que había aquí no detectaba nada. `exceso` sí lo
        # dice: es lo que ocurre cuando alguien baja el aforo aprobado con
        # entradas ya apartadas o vendidas encima. Se falla en cerrado y lo
        # resuelve una persona; emitir de todas formas es prometer un asiento
        # que no existe.
        raise PagoNoCuadra("El evento ya no tiene sitio para ese pedido.")

    orden.provider = provider
    orden.external_payment_id = external_payment_id
    entradas = await _confirmar(db, orden=orden, hold=hold, momento=momento)
    await db.flush()
    return OrdenCreada(orden, estrenada=bool(entradas))


def _por_que_no_cuadra(
    orden: EventOrder,
    *,
    provider: str,
    environment: str,
    amount_minor: int | None,
    currency: str | None,
) -> str | None:
    """Por qué este aviso NO puede confirmar esta orden, o `None`.

    Cada comprobación es una forma conocida de que a alguien le regalen una
    entrada, y ninguna admite la ausencia del dato como equivalente.
    """
    if orden.provider != provider:
        # `none` NO CUENTA COMO COINCIDENCIA. Una orden con `provider = 'none'`
        # es una que nunca pasó por `iniciar_pago`: no hay ningún cobro abierto
        # a su nombre, así que ningún aviso puede ser suyo. Admitirlo dejaba
        # confirmar con el aviso de otra cosa una orden que nadie inició.
        return "El cobro es de otra pasarela."
    if (orden.environment or "") != environment:
        # Un aviso de pruebas NO concede nada en producción, ni al revés.
        return "El cobro es de otro entorno."
    if amount_minor is None:
        return "El aviso no dice cuánto se cobró."
    if currency is None or not currency.strip():
        return "El aviso no dice en qué moneda se cobró."
    if int(amount_minor) != int(orden.total_minor):
        # Ni de menos —un pago parcial no compra— ni de más.
        return "El importe cobrado no es el del pedido."
    if currency.strip().upper() != (orden.currency or "").strip().upper():
        return "La moneda cobrada no es la del pedido."
    return None


# --------------------------------------------------------------------------- #
# Vencer y cancelar
# --------------------------------------------------------------------------- #
async def vencer_ordenes(
    db: AsyncSession,
    *,
    momento: datetime | None = None,
    lote: int = 500,
    usuario=None,
) -> int:
    """Cierra las órdenes cuya reserva ya no aparta nada.

    LA ORDEN NO SOBREVIVE A SU RESERVA. El inventario es del hold: una orden
    pendiente cuyo hold venció está prometiendo un aforo que ya se soltó, y
    dejarla abierta es lo que hace que un pago tardío parezca aceptable.
    """
    momento = momento or ahora()
    await inventory.limitar_la_espera(db)
    candidatas = list(
        await db.scalars(
            select(EventOrder.id)
            .join(EventTicketHold, EventTicketHold.id == EventOrder.hold_id)
            .where(
                EventOrder.status.in_(ORDEN_EN_CURSO),
                (EventTicketHold.status != ACTIVO)
                | (EventTicketHold.expires_at <= momento),
            )
            .order_by(EventOrder.created_at.asc())
            .limit(max(1, min(int(lote), 5000)))
        )
    )
    if not candidatas:
        return 0

    # SE ESCRIBE CON CONDICIÓN, no sobre lo que se leyó. Entre el `select` y el
    # `update` cabe un webhook que confirme una de estas órdenes: escribirle
    # `EXPIRED` encima dejaba `paid_at` puesto, violaba el CHECK que exige que
    # el estado y la fecha digan lo mismo, y tumbaba el LOTE ENTERO con un 500.
    # Con el `where` en la propia escritura, esa fila simplemente no se toca.
    primer_evento = None
    async with inventory.espera_traducida(db):
        resultado = await db.execute(
            update(EventOrder)
            .where(
                EventOrder.id.in_(candidatas),
                EventOrder.status.in_(ORDEN_EN_CURSO),
            )
            .values(status=ORDEN_VENCIDA, cancelled_at=momento, updated_at=momento)
        )
        cuantas = resultado.rowcount or 0
        if cuantas:
            primer_evento = await db.scalar(
                select(EventOrder.event_id).where(EventOrder.id == candidatas[0])
            )
    if not cuantas:
        await db.rollback()
        return 0

    if usuario is not None and primer_evento is not None:
        from app.modules.gobernanza import auditoria

        await auditoria.anotar(
            db,
            actor_id=usuario.id,
            action="event.orders_expired",
            entity_type="event_orders",
            # El evento de la PRIMERA del lote. Un lote puede abarcar varios, y
            # el recuento del payload es lo que de verdad se investiga.
            entity_id=primer_evento,
            payload={"procesados": cuantas, "lote": lote},
        )
    await db.commit()
    return cuantas


async def cancelar_orden(
    db: AsyncSession, *, orden_id: str, usuario_id: str, momento: datetime | None = None
) -> EventOrder:
    """Quien compra se arrepiente antes de pagar. No libera la reserva.

    La reserva sigue siendo suya hasta que venza: liberarla aquí dejaría a otra
    persona quedarse con las entradas de alguien que solo cerró la pantalla.
    """
    momento = momento or ahora()
    orden = await db.scalar(
        select(EventOrder).where(EventOrder.id == orden_id).with_for_update()
    )
    if orden is None or orden.buyer_id != usuario_id:
        await db.rollback()
        raise NotFoundError("Pedido no encontrado.", code="event_order_not_found")
    if orden.status == ORDEN_CANCELADA:
        await db.commit()
        return orden
    if orden.status not in ORDEN_EN_CURSO:
        estado = orden.status
        await db.rollback()
        raise OrdenNoPagable(f"Ese pedido ya no se puede cancelar: está {estado}.")

    orden.status = ORDEN_CANCELADA
    orden.cancelled_at = momento
    orden.updated_at = momento
    await db.commit()
    return orden


async def marcar_fallida(
    db: AsyncSession, *, orden_id: str, motivo: str, momento: datetime | None = None
) -> EventOrder | None:
    """Un fallo TERMINAL del proveedor. Ni un timeout ni un error de red.

    Un `4xx`, un corte o una espera agotada no son una declinación: el cobro
    puede estar en curso, y darlo por muerto es lo que hace que se cobre dos
    veces al reintentar.

    Como `confirmar_pago`, no confirma la transacción: corre dentro del
    savepoint del webhook.
    """
    momento = momento or ahora()
    orden = await db.scalar(
        select(EventOrder).where(EventOrder.id == orden_id).with_for_update()
    )
    if orden is None:
        return None
    if orden.status not in ORDEN_EN_CURSO:
        return orden
    orden.status = ORDEN_FALLIDA
    orden.updated_at = momento
    await db.flush()
    return orden


# --------------------------------------------------------------------------- #
# Lectura
# --------------------------------------------------------------------------- #
async def leer_orden(db: AsyncSession, *, orden_id: str, usuario_id: str) -> EventOrder:
    orden = await db.get(EventOrder, orden_id)
    if orden is None or orden.buyer_id != usuario_id:
        raise NotFoundError("Pedido no encontrado.", code="event_order_not_found")
    return orden


async def lineas_de(db: AsyncSession, orden_id: str) -> list[EventOrderItem]:
    return list(
        await db.scalars(
            select(EventOrderItem)
            .where(EventOrderItem.order_id == orden_id)
            .order_by(EventOrderItem.ticket_type_id.asc())
        )
    )


async def lineas_de_varias(
    db: AsyncSession, ordenes: list[str]
) -> dict[str, list[EventOrderItem]]:
    """Las líneas de VARIAS órdenes, en una consulta."""
    if not ordenes:
        return {}
    filas = await db.scalars(
        select(EventOrderItem)
        .where(EventOrderItem.order_id.in_(ordenes))
        .order_by(EventOrderItem.order_id.asc(), EventOrderItem.ticket_type_id.asc())
    )
    agrupadas: dict[str, list[EventOrderItem]] = {}
    for linea in filas:
        agrupadas.setdefault(linea.order_id, []).append(linea)
    return agrupadas


async def vencimientos_de(
    db: AsyncSession, holds: list[str]
) -> dict[str, datetime]:
    """Cuándo vence cada reserva, en una consulta."""
    if not holds:
        return {}
    filas = await db.execute(
        select(EventTicketHold.id, EventTicketHold.expires_at).where(
            EventTicketHold.id.in_(holds)
        )
    )
    return {fila[0]: fila[1] for fila in filas.all()}


async def mis_ordenes(
    db: AsyncSession, *, usuario_id: str, limite: int = 20, cursor: str | None = None
) -> list[EventOrder]:
    """Las órdenes de quien pregunta, de la más reciente a la más antigua.

    ORDEN ESTABLE CON DESEMPATE por `id`: dos órdenes creadas en el mismo
    milisegundo no pueden intercambiarse entre páginas y hacer que una se
    repita y otra se pierda.
    """
    consulta = select(EventOrder).where(EventOrder.buyer_id == usuario_id)
    if cursor:
        fecha, ident = _cursor_partido(cursor)
        consulta = consulta.where(
            (EventOrder.created_at < fecha)
            | ((EventOrder.created_at == fecha) & (EventOrder.id < ident))
        )
    consulta = consulta.order_by(
        EventOrder.created_at.desc(), EventOrder.id.desc()
    ).limit(max(1, min(int(limite), 100)))
    return list(await db.scalars(consulta))


def cursor_de(fecha: datetime, ident: str) -> str:
    return f"{fecha.isoformat()}|{ident}"


def _cursor_partido(cursor: str) -> tuple[datetime, str]:
    """La fecha Y el identificador. Los dos se validan.

    El identificador va a una columna `uuid`: dejar pasar cualquier cosa hace que
    la comparación falle dentro de la base, y eso llega como un 500 por un
    parámetro mal escrito.
    """
    fecha, _, ident = cursor.partition("|")
    try:
        momento = datetime.fromisoformat(fecha)
        UUID(ident)
    except ValueError:
        raise NotFoundError("Cursor no válido.", code="invalid_cursor") from None
    if momento.tzinfo is None:
        momento = momento.replace(tzinfo=timezone.utc)
    return momento, ident


# --------------------------------------------------------------------------- #
# Resumen para el organizador
# --------------------------------------------------------------------------- #
@dataclass
class ResumenDeVentas:
    """Lo que el organizador puede afirmar, y nada más.

    `ingresos_brutos_minor` cuenta SOLO órdenes pagadas. No es lo que el
    organizador va a cobrar: faltan comisión, impuestos y liquidación, que son
    decisiones que la empresa no ha tomado. La pantalla lo dice.
    """

    entradas_emitidas: int
    entradas_usadas: int
    entradas_revocadas: int
    ordenes_pagadas: int
    ordenes_pendientes: int
    ingresos_brutos_minor: int
    currency: str | None


async def resumen_de_ventas(db: AsyncSession, evento_id: str) -> ResumenDeVentas:
    """Un recuento por consulta agregada, no una lista traída a memoria."""
    por_estado = {
        f[0]: f[1]
        for f in (
            await db.execute(
                select(EventTicket.status, func.count())
                .where(EventTicket.event_id == evento_id)
                .group_by(EventTicket.status)
            )
        ).all()
    }
    ordenes = {
        f[0]: (f[1], f[2] or 0)
        for f in (
            await db.execute(
                select(
                    EventOrder.status,
                    func.count(),
                    func.coalesce(func.sum(EventOrder.total_minor), 0),
                )
                .where(EventOrder.event_id == evento_id)
                .group_by(EventOrder.status)
            )
        ).all()
    }
    pendientes = sum(ordenes.get(e, (0, 0))[0] for e in ORDEN_EN_CURSO)
    pagadas, ingresos = ordenes.get(ORDEN_PAGADA, (0, 0))
    ajustes = await ticketing.configuracion(db, evento_id)
    return ResumenDeVentas(
        entradas_emitidas=sum(por_estado.values()),
        entradas_usadas=por_estado.get("USED", 0),
        entradas_revocadas=por_estado.get("REVOKED", 0),
        ordenes_pagadas=pagadas,
        ordenes_pendientes=pendientes,
        ingresos_brutos_minor=int(ingresos),
        currency=ajustes.currency if ajustes else None,
    )


__all__ = [
    "ClaveReutilizada",
    "ENTRADA_VALIDA",
    "OrdenCreada",
    "OrdenNoPagable",
    "OrdenesNoDisponibles",
    "PagoNoCuadra",
    "PagosNoDisponibles",
    "ReservaNoUtilizable",
    "ResumenDeVentas",
    "YaHayUnaOrden",
    "ahora",
    "cancelar_orden",
    "confirmar_pago",
    "crear_orden",
    "cursor_de",
    "exigir_ordenes_disponibles",
    "leer_orden",
    "lineas_de",
    "lineas_de_varias",
    "marcar_fallida",
    "mis_ordenes",
    "resumen_de_ventas",
    "vencimientos_de",
    "vencer_ordenes",
]
