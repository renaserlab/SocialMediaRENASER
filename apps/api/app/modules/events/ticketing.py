"""Entradas, inventario y reservas temporales.

QUÉ ES UNA RESERVA TEMPORAL (un *hold*) Y QUÉ NO ES. Es «estas cuatro entradas
quedan apartadas para ti durante diez minutos». No es una compra, no es una
orden, no es una entrada emitida y no mueve un céntimo. Este incremento llega
hasta aquí a propósito: el cobro necesita decisiones de la empresa que todavía
no están tomadas —quién figura como vendedor, la comisión, los impuestos, los
comprobantes— y un carrito que no lleva a ninguna parte es peor que no tenerlo.

EL DINERO, EN ENTEROS Y EN UNIDAD MENOR. 4900 son S/ 49.00. Nunca un flotante:
en dinero, un flotante es un descuadre con fecha. Y los precios los pone el
SERVIDOR leyéndolos de la base; el cliente manda tipo y cantidad, nada más.

LA DISPONIBILIDAD SE CALCULA, NO SE GUARDA. Un contador es una copia que se
desincroniza en cuanto una transacción se deshace. La cuenta es:

    aforo aprobado
      - reservas gratuitas confirmadas
      - lo apartado en holds ACTIVOS y no vencidos
      - entradas vendidas          <- no existen todavía, y no se inventan

El tercer sumando está en la fórmula pero vale cero porque no hay ninguna tabla
de entradas vendidas. Se deja escrito para que añadirla no obligue a rehacer el
cálculo.

UN HOLD VENCIDO NO OCUPA, aunque su fila siga diciendo `ACTIVE`. La limpieza que
los pasa a `EXPIRED` puede no haber corrido; la disponibilidad no la espera.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.exceptions import AppError, ConflictError, NotFoundError
from app.modules.catalog.models import Event
from app.modules.events import esquema, inventory, states
from app.modules.events.models import (
    EventTicket,
    CON_ENTRADAS,
    LIBRE,
    EventOperations,
    EventTicketHold,
    EventTicketHoldItem,
    EventTicketingSettings,
    EventTicketType,
)

#: Cuánto dura una reserva temporal. Diez minutos, del blueprint §9.
DURACION_DEL_HOLD = timedelta(minutes=10)

#: Los tipos que se pueden comprar. `draft`, `paused` y `retired` no.
A_LA_VENTA = "on_sale"

ACTIVO = "ACTIVE"
VENCIDO = "EXPIRED"
LIBERADO = "RELEASED"
CONSUMIDO = "CONSUMED"


# --------------------------------------------------------------------------- #
# Errores, con código estable. Nadie los distingue por el texto.
# --------------------------------------------------------------------------- #


class _ErrorDeEntradas(AppError):
    status_code = 409


class EventoSinEntradas(_ErrorDeEntradas):
    code = "event_not_ticketed"
    message = "Este evento no vende entradas."


class VentaSinAbrir(_ErrorDeEntradas):
    code = "event_sales_not_open"
    message = "La venta de entradas todavía no ha empezado."


class VentaCerrada(_ErrorDeEntradas):
    code = "event_sales_closed"
    message = "La venta de entradas ya cerró."


class TipoNoDisponible(_ErrorDeEntradas):
    code = "ticket_type_unavailable"
    message = "Ese tipo de entrada no está a la venta."


class CantidadInvalida(AppError):
    status_code = 422
    code = "ticket_quantity_invalid"
    message = "La cantidad pedida no es válida."


class LimiteSuperado(_ErrorDeEntradas):
    code = "ticket_limit_exceeded"
    message = "Pediste más entradas de las permitidas."


class SinCupo(_ErrorDeEntradas):
    code = "event_capacity_exceeded"
    message = "No quedan entradas suficientes."


class HoldVencido(_ErrorDeEntradas):
    code = "ticket_hold_expired"
    message = "Tu reserva venció. Vuelve a elegir las entradas."


class HoldConsumido(_ErrorDeEntradas):
    code = "ticket_hold_already_consumed"
    message = "Esa reserva ya se usó."


class ClaveReutilizada(_ErrorDeEntradas):
    code = "ticket_hold_conflict"
    message = "Esa clave de idempotencia ya se usó para otra petición."


class YaTienesUnaReserva(_ErrorDeEntradas):
    """Ya hay una reserva en curso de esta persona para este evento.

    Es la regla que impide evadir los topes: sin ella, pedir cuatro con una
    clave y cuatro con otra sería pedir ocho. La sostiene el índice parcial de
    la 0061; aquí se explica antes de que la base tenga que rechazarlo, porque
    una violación de índice llega al cliente como un 500 y esto es una
    situación normal que merece una frase.
    """

    code = "ticket_hold_already_active"

    #: `details` lleva `{"hold_id": ...}`: es la reserva a la que hay que ir.
    message = (
        "Ya tienes una reserva en curso para este evento. Libérala o espera a "
        "que venza."
    )


# --------------------------------------------------------------------------- #
# Configuración del evento
# --------------------------------------------------------------------------- #


def ahora() -> datetime:
    return datetime.now(timezone.utc)


def _comparable(valor: datetime, referencia: datetime) -> datetime:
    """La misma forma de zona que `referencia`.

    PostgreSQL devuelve `timestamptz` con zona y SQLite sin ella; comparar las
    dos directamente lanza `TypeError`, y ese error solo aparecería en uno de
    los dos entornos.
    """
    if valor.tzinfo is None and referencia.tzinfo is not None:
        return valor.replace(tzinfo=timezone.utc)
    if valor.tzinfo is not None and referencia.tzinfo is None:
        return valor.replace(tzinfo=None)
    return valor


async def configuracion(db: AsyncSession, evento_id: str) -> EventTicketingSettings | None:
    return await db.get(EventTicketingSettings, evento_id)


def modo_de_acceso(ajustes: EventTicketingSettings | None) -> str:
    """SIN FILA SIGNIFICA `FREE_RSVP`.

    Es lo que son todos los eventos que existen: la ausencia de configuración no
    es un hueco, es la respuesta. Por eso la 0061 no escribe ninguna fila.
    """
    return ajustes.access_mode if ajustes is not None else LIBRE


def vende_entradas(ajustes: EventTicketingSettings | None) -> bool:
    return modo_de_acceso(ajustes) == CON_ENTRADAS


def motivo_para_no_vender(
    ajustes: EventTicketingSettings | None, momento: datetime
) -> AppError | None:
    """Por qué este evento no admite elegir entradas ahora mismo."""
    if not vende_entradas(ajustes):
        return EventoSinEntradas()
    assert ajustes is not None
    if ajustes.sales_open_at is not None:
        if momento < _comparable(ajustes.sales_open_at, momento):
            return VentaSinAbrir()
    if ajustes.sales_close_at is not None:
        if momento >= _comparable(ajustes.sales_close_at, momento):
            return VentaCerrada()
    return None


# --------------------------------------------------------------------------- #
# Tipos de entrada
# --------------------------------------------------------------------------- #


async def tipos_de(
    db: AsyncSession, evento_id: str, *, solo_a_la_venta: bool = False
) -> list[EventTicketType]:
    """Los tipos, en un orden ESTABLE.

    `sort_order` puede empatar —el organizador arrastra dos al mismo sitio— y
    sin el desempate la lista cambia de orden entre dos cargas.
    """
    consulta = select(EventTicketType).where(EventTicketType.event_id == evento_id)
    if solo_a_la_venta:
        consulta = consulta.where(EventTicketType.status == A_LA_VENTA)
    consulta = consulta.order_by(
        EventTicketType.sort_order.asc(),
        EventTicketType.created_at.asc(),
        EventTicketType.id.asc(),
    )
    return list(await db.scalars(consulta))


def precio_desde(
    tipos: list[EventTicketType], disponibles: dict[str, int] | None = None
) -> int | None:
    """El precio mínimo REAL de los tipos a la venta QUE QUEDAN, o `None`.

    Con `disponibles` se descartan los agotados, y eso importa: «Desde S/ 49»
    de un tipo del que no queda ninguna entrada es un precio que nadie puede
    pagar. Sin el diccionario se mira solo el estado, que es lo que se puede
    afirmar cuando no se ha calculado la disponibilidad.

    `None` cuando no queda ninguno: entonces la ficha no escribe «Desde», que
    sería un precio sobre una lista vacía.
    """
    candidatos = [t for t in tipos if t.status == A_LA_VENTA]
    if disponibles is not None:
        candidatos = [t for t in candidatos if disponibles.get(t.id, 0) > 0]
    return min((t.price_minor for t in candidatos), default=None)


# --------------------------------------------------------------------------- #
# Disponibilidad
# --------------------------------------------------------------------------- #


@dataclass
class Disponibilidad:
    """Lo que queda, en general y por tipo."""

    #: `None` cuando el evento no tiene aforo: entonces solo mandan los cupos.
    general: int | None
    por_tipo: dict[str, int] = field(default_factory=dict)
    #: Cuánto se pasa del aforo lo ya comprometido. Cero salvo que alguien haya
    #: BAJADO el aforo aprobado con entradas ya apartadas o vendidas encima.
    #: `general` no puede decirlo porque nunca baja de cero.
    exceso: int = 0


async def cuantas_apartadas(
    db: AsyncSession, evento_id: str, momento: datetime | None = None
) -> int:
    """Entradas APARTADAS ahora: reservas vivas y sin vencer.

    Es un número distinto de las vendidas y de las válidas, y mezclarlos es lo
    que hace que un organizador crea que ya vendió lo que todavía está en la
    cesta de alguien.
    """
    return sum((await _apartado_por_tipo(db, evento_id, momento or ahora())).values())


async def _apartado_por_tipo(
    db: AsyncSession, evento_id: str, momento: datetime
) -> dict[str, int]:
    """Cuántas entradas de cada tipo están apartadas AHORA.

    Solo holds `ACTIVE` y NO VENCIDOS. Un hold que pasó de hora deja de ocupar
    aunque su fila siga diciendo `ACTIVE`: la limpieza puede no haber corrido, y
    la disponibilidad no la espera.
    """
    filas = await db.execute(
        select(
            EventTicketHoldItem.ticket_type_id,
            func.coalesce(func.sum(EventTicketHoldItem.quantity), 0),
        )
        .join(EventTicketHold, EventTicketHold.id == EventTicketHoldItem.hold_id)
        .where(
            EventTicketHold.event_id == evento_id,
            EventTicketHold.status == ACTIVO,
            EventTicketHold.expires_at > momento,
        )
        .group_by(EventTicketHoldItem.ticket_type_id)
    )
    return {fila[0]: int(fila[1]) for fila in filas.all()}


async def _emitido_por_tipo(
    db: AsyncSession, evento_id: str
) -> dict[str, int]:
    """Cuántas entradas EMITIDAS ocupan sitio, por tipo.

    ESTE SUMANDO FALTABA, y era el agujero. Al pagar, la reserva pasa a
    `CONSUMED` y deja de contar como apartada; si lo emitido tampoco cuenta, el
    aforo vuelve entero al común y el siguiente comprador ve la sala vacía. Con
    aforo 3 se vendían 3, y otras 3, y otras 3, sin límite y sin concurrencia.

    `REVOKED` no cuenta: una entrada retirada deja de ocupar, o el aforo se iría
    agotando con entradas que ya no existen. `USED` sí: quien ya entró ocupa el
    sitio más que nadie.

    Devuelve vacío sin la 0062 aplicada: entonces no hay ninguna entrada emitida
    y la fórmula vale igual.
    """
    if not await esquema.hay_ordenes(db):
        return {}
    filas = await db.execute(
        select(
            EventTicket.ticket_type_id,
            func.count(),
        )
        .where(
            EventTicket.event_id == evento_id,
            EventTicket.status.in_(("VALID", "USED")),
        )
        .group_by(EventTicket.ticket_type_id)
    )
    return {fila[0]: int(fila[1]) for fila in filas.all()}


async def _reservas_gratuitas(db: AsyncSession, evento_id: str) -> int:
    """Las reservas gratuitas confirmadas.

    En un evento `TICKETED` deberían ser cero —no se puede pasar de gratuito a
    con entradas con reservas encima—, pero se restan igual: la fórmula tiene
    que valer para los dos modos y para el día en que se permita convertir.
    """
    return await inventory.contar(db, evento_id)


async def disponibilidad(
    db: AsyncSession,
    evento: Event,
    momento: datetime | None = None,
    *,
    solo_a_la_venta: bool = False,
) -> Disponibilidad:
    """Cuánto queda. Se CALCULA; no hay ningún contador que mantener.

    `solo_a_la_venta` es para la RUTA PÚBLICA, y no es cosmético: sin él,
    `por_tipo` llevaba también los tipos en borrador, pausados y retirados. Una
    petición sin sesión devolvía sus identificadores y, en un evento sin aforo,
    su cupo en crudo —`quota` menos lo apartado—, que es justo el dato que el
    contrato público se molesta en no llevar. Alguien preparando un tipo «VIP»
    para lanzarlo la semana que viene lo tenía publicado sin saberlo.

    Lo apartado se cuenta SIEMPRE contra todos los tipos: una entrada apartada
    de un tipo que se pausó después sigue ocupando sitio en la sala.
    """
    momento = momento or ahora()
    operacion = await db.get(EventOperations, evento.id)
    aforo = inventory.aforo_de(
        evento, operacion.approved_capacity if operacion else None
    )
    apartado = await _apartado_por_tipo(db, evento.id, momento)
    apartado_total = sum(apartado.values())
    emitido = await _emitido_por_tipo(db, evento.id)
    emitido_total = sum(emitido.values())

    general: int | None = None
    exceso = 0
    if aforo is not None:
        comprometido = (
            await _reservas_gratuitas(db, evento.id) + apartado_total + emitido_total
        )
        # DOS NÚMEROS, NO UNO. `general` es lo que se puede ofrecer y nunca baja
        # de cero: un número negativo en una pantalla no significa nada. `exceso`
        # es cuánto se pasa lo ya comprometido del aforo, y sí puede ser mayor
        # que cero: es lo que pasa cuando alguien BAJA el aforo aprobado con
        # entradas ya vendidas encima. Sin él, la recomprobación bajo cerrojo
        # comparaba contra un valor recortado y no detectaba nada.
        general = max(0, aforo - comprometido)
        exceso = max(0, comprometido - aforo)

    por_tipo: dict[str, int] = {}
    for tipo in await tipos_de(db, evento.id, solo_a_la_venta=solo_a_la_venta):
        ocupado = apartado.get(tipo.id, 0) + emitido.get(tipo.id, 0)
        queda = max(0, tipo.quota - ocupado)
        # Un tipo nunca ofrece más de lo que cabe en el evento entero.
        por_tipo[tipo.id] = queda if general is None else min(queda, general)
    return Disponibilidad(general=general, por_tipo=por_tipo, exceso=exceso)


# --------------------------------------------------------------------------- #
# Reservas temporales
# --------------------------------------------------------------------------- #


def huella(lineas: list[tuple[str, int]]) -> str:
    """La huella de lo pedido, para distinguir un reintento de otra cosa.

    Se ordena antes de firmar: pedir A y B es lo mismo que pedir B y A, y sin
    ordenar el mismo carrito daría dos huellas distintas según cómo lo pintara
    la pantalla.
    """
    normal = sorted((str(t), int(c)) for t, c in lineas)
    return hashlib.sha256(json.dumps(normal, separators=(",", ":")).encode()).hexdigest()


async def _vencer_los_mios(
    db: AsyncSession, evento_id: str, usuario_id: str, momento: datetime
) -> None:
    """Marca como vencidos los holds pasados de hora de ESTA persona.

    Hace falta antes de crear otro: el índice parcial exige un solo `ACTIVE` por
    persona y evento, y no puede mirar el reloj —`now()` no es inmutable y un
    índice no puede llamarlo—. Aquí sí se mira, y así el índice sostiene la
    invariante sin depender de que la limpieza haya corrido.
    """
    filas = await db.scalars(
        select(EventTicketHold).where(
            EventTicketHold.event_id == evento_id,
            EventTicketHold.user_id == usuario_id,
            EventTicketHold.status == ACTIVO,
        )
    )
    for hold in filas:
        if _comparable(hold.expires_at, momento) <= momento:
            hold.status = VENCIDO
            hold.updated_at = momento


async def lineas_de(db: AsyncSession, hold_id: str) -> list[EventTicketHoldItem]:
    return list(
        await db.scalars(
            select(EventTicketHoldItem)
            .where(EventTicketHoldItem.hold_id == hold_id)
            .order_by(EventTicketHoldItem.created_at.asc(), EventTicketHoldItem.id.asc())
        )
    )


def esta_vencido(hold: EventTicketHold, momento: datetime) -> bool:
    return _comparable(hold.expires_at, momento) <= momento


def estado_efectivo(hold: EventTicketHold, momento: datetime) -> str:
    """El estado que vale, con el reloj ya aplicado.

    Un hold `ACTIVE` pasado de hora está vencido aunque su fila no lo diga: la
    limpieza es una comodidad, no la fuente de verdad.
    """
    if hold.status == ACTIVO and esta_vencido(hold, momento):
        return VENCIDO
    return hold.status


async def crear_hold(
    db: AsyncSession,
    *,
    evento_id: str,
    usuario_id: str,
    pedido: list[tuple[str, int]],
    clave: str,
    momento: datetime | None = None,
) -> EventTicketHold:
    """Aparta entradas durante diez minutos. Una transacción, en este orden.

    El paso que sostiene todo es el bloqueo de la fila del evento: es el MISMO
    cerrojo que usa la reserva gratuita, así que un evento no puede estar
    repartiendo aforo por dos caminos a la vez y no hay dos órdenes de bloqueo
    que puedan invertirse.

    Los tipos se leen DESPUÉS y en orden de identificador, que es determinista:
    dos peticiones con los mismos tipos en distinto orden no se cruzan.
    """
    if not pedido:
        raise CantidadInvalida("No pediste ninguna entrada.")

    evento = await inventory.bloquear_evento(db, evento_id)
    # EL RELOJ, DESPUES DEL CERROJO. Esperar la fila del evento puede llevar
    # segundos —es el punto donde se serializa todo el modulo—, y con la hora
    # leida antes de entrar, una reserva propia que caduco durante esa espera no
    # se marcaba vencida: la persona recibia «ya tienes una reserva» sobre una
    # que ya estaba muerta, y la nueva nacia con menos de diez minutos reales.
    #
    # Quien pasa `momento` lo hace para fijar la hora en una prueba; en la ruta
    # no se pasa.
    momento = momento or ahora()
    operacion = await db.get(EventOperations, evento_id)
    workflow = operacion.workflow_status if operacion else None
    if not states.se_puede_saber_que_existe(workflow, evento.status):
        await db.rollback()
        raise NotFoundError("Evento no encontrado.")
    if not states.admite_reservas(workflow or "PUBLISHED"):
        await db.rollback()
        raise ConflictError("Ese evento no admite reservas.")
    if inventory.es_pasado(evento, momento):
        await db.rollback()
        raise ConflictError("Ese evento ya terminó.")

    ajustes = await configuracion(db, evento_id)
    firma = huella(pedido)

    # IDEMPOTENCIA, Y ANTES DE MIRAR EL RELOJ DE LA VENTA. La misma clave
    # devuelve la MISMA reserva; la misma clave con otra cosa dentro es un error
    # del cliente y merece un conflicto, no una reserva que no pidió.
    #
    # El orden importa: si se comprobara después, un reintento de red del mismo
    # pedido que llega justo pasado `sales_close_at` recibiría «la venta cerró»
    # en vez de la reserva que ya tiene. El mismo pedido no puede dar dos
    # respuestas distintas según el segundo en que llegue.
    ya = await db.scalar(
        select(EventTicketHold).where(
            EventTicketHold.event_id == evento_id,
            EventTicketHold.user_id == usuario_id,
            EventTicketHold.idempotency_key == clave,
        )
    )
    if ya is not None:
        if ya.request_fingerprint != firma:
            await db.rollback()
            raise ClaveReutilizada()
        await db.commit()
        return ya

    fallo = motivo_para_no_vender(ajustes, momento)
    if fallo is not None:
        await db.rollback()
        raise fallo
    assert ajustes is not None

    await _vencer_los_mios(db, evento_id, usuario_id, momento)
    # AQUÍ SE PUEDE ESPERAR. Las reservas propias que caducaron pueden estar
    # dentro del lote que la limpieza masiva tiene bloqueado en este instante.
    async with inventory.espera_traducida(db):
        await db.flush()

    # UNA RESERVA EN CURSO POR PERSONA Y EVENTO. Lo sostiene el índice parcial
    # de la 0061; se comprueba aquí para que llegue como un conflicto explicado
    # y no como una violación de índice, que el cliente vería como un 500.
    en_curso = await db.scalar(
        select(EventTicketHold).where(
            EventTicketHold.event_id == evento_id,
            EventTicketHold.user_id == usuario_id,
            EventTicketHold.status == ACTIVO,
        )
    )
    if en_curso is not None:
        # EL IDENTIFICADOR VIAJA EN EL ERROR, y no es un adorno: sin él la
        # persona que cierra la aplicación con una reserva viva y vuelve a
        # entrar no tiene forma de llegar a ella ni de liberarla. Se quedaba
        # diez minutos bloqueada, con la única salida de esperar.
        #
        # Se lee ANTES del `rollback`, que expira los objetos de la sesión.
        estorba = {"hold_id": en_curso.id}
        await db.rollback()
        raise YaTienesUnaReserva(details=estorba)

    # Los tipos pedidos, en orden determinista.
    pedido_normal = sorted((str(t), int(c)) for t, c in pedido)
    ids = [t for t, _ in pedido_normal]
    if len(set(ids)) != len(ids):
        await db.rollback()
        raise CantidadInvalida("Pediste el mismo tipo dos veces.")

    tipos = {
        t.id: t
        for t in await db.scalars(
            select(EventTicketType)
            .where(
                EventTicketType.event_id == evento_id,
                EventTicketType.id.in_(ids),
            )
            .order_by(EventTicketType.id.asc())
        )
    }
    for tipo_id in ids:
        if tipo_id not in tipos:
            await db.rollback()
            raise NotFoundError("Ese tipo de entrada no existe.", code="ticket_type_not_found")
        if tipos[tipo_id].status != A_LA_VENTA:
            await db.rollback()
            raise TipoNoDisponible()

    libre = await disponibilidad(db, evento, momento)
    total_pedido = sum(c for _, c in pedido_normal)

    if ajustes.max_per_order is not None and total_pedido > ajustes.max_per_order:
        # EL MENSAJE, ANTES DEL ROLLBACK. `rollback()` expira todos los objetos
        # de la sesión, así que leer `ajustes.max_per_order` después dispara una
        # recarga perezosa fuera del greenlet: `MissingGreenlet`, y la persona
        # recibe un 500 en vez del 409 que explica el tope. Es la misma trampa
        # que ya se esquiva veinte líneas más abajo con `aviso`.
        aviso = f"Como mucho {ajustes.max_per_order} entradas por operación."
        await db.rollback()
        raise LimiteSuperado(aviso)

    lineas: list[EventTicketHoldItem] = []
    subtotal = 0
    for tipo_id, cantidad in pedido_normal:
        tipo = tipos[tipo_id]
        if cantidad < tipo.min_per_order or cantidad > tipo.max_per_order:
            # EL MENSAJE, ANTES DEL ROLLBACK. Deshacer la transacción expira los
            # objetos del ORM, y leer `tipo.name` después dispara una carga
            # perezosa que en asíncrono revienta con `MissingGreenlet`: el
            # cliente recibiría un 500 en lugar del límite que se pasó.
            aviso = (
                f"«{tipo.name}»: de {tipo.min_per_order} a {tipo.max_per_order} "
                "entradas por operación."
            )
            await db.rollback()
            raise LimiteSuperado(aviso)
        if cantidad > libre.por_tipo.get(tipo_id, 0):
            aviso = f"No quedan {cantidad} entradas de «{tipo.name}»."
            await db.rollback()
            raise SinCupo(aviso)
        # EL PRECIO SALE DE LA BASE. El cliente manda tipo y cantidad; lo que
        # cuesta lo decide el servidor, y se congela aquí.
        linea = EventTicketHoldItem(
            event_id=evento_id,
            ticket_type_id=tipo_id,
            quantity=cantidad,
            unit_price_minor=tipo.price_minor,
            subtotal_minor=cantidad * tipo.price_minor,
            ticket_type_name_snapshot=tipo.name,
        )
        subtotal += linea.subtotal_minor
        lineas.append(linea)

    if libre.general is not None and total_pedido > libre.general:
        await db.rollback()
        raise SinCupo()

    hold = EventTicketHold(
        event_id=evento_id,
        user_id=usuario_id,
        idempotency_key=clave,
        request_fingerprint=firma,
        status=ACTIVO,
        currency=ajustes.currency,
        subtotal_minor=subtotal,
        expires_at=momento + DURACION_DEL_HOLD,
    )
    db.add(hold)
    async with inventory.espera_traducida(db):
        await db.flush()
        for linea in lineas:
            linea.hold_id = hold.id
            db.add(linea)
        await db.commit()
    return hold


async def leer_hold(
    db: AsyncSession, *, hold_id: str, usuario_id: str
) -> EventTicketHold:
    """La reserva de QUIEN PREGUNTA. La de otra persona no existe."""
    hold = await db.get(EventTicketHold, hold_id)
    if hold is None or hold.user_id != usuario_id:
        # 404 y no 403: confirmar que existe ya cuenta que alguien la tiene.
        raise NotFoundError("Reserva no encontrada.", code="ticket_hold_not_found")
    return hold


async def liberar_hold(
    db: AsyncSession, *, hold_id: str, usuario_id: str, momento: datetime | None = None
) -> EventTicketHold:
    """Devuelve las entradas apartadas. Liberar dos veces no es un error.

    Un hold consumido NO se libera: si algún día existe la orden que lo consume,
    soltar su inventario sería vender dos veces lo mismo.
    """
    momento = momento or ahora()
    hold = await leer_hold(db, hold_id=hold_id, usuario_id=usuario_id)
    if hold.status == CONSUMIDO:
        raise HoldConsumido()
    if hold.status == ACTIVO:
        # Se marca `RELEASED` incluso si ya venció: quien pulsa liberar está
        # diciendo que no lo quiere, y esa intención es más precisa que el
        # reloj.
        hold.status = LIBERADO
        hold.updated_at = momento
        await db.commit()
    return hold


async def vencer_holds(
    db: AsyncSession,
    *,
    momento: datetime | None = None,
    lote: int = 500,
    usuario=None,
) -> int:
    """Pasa a `EXPIRED` los holds vencidos. Idempotente y por lotes.

    NO ES LO QUE LIBERA EL INVENTARIO: la disponibilidad ya ignora los vencidos.
    Esto es limpieza, para que la tabla diga lo que pasa y los índices no se
    llenen de filas que fingen estar activas.

    Por lotes y sin bucle infinito: devuelve cuántas tocó y quien la llame
    decide si vuelve a llamar.
    """
    momento = momento or ahora()
    filas = list(
        await db.scalars(
            select(EventTicketHold)
            .where(
                EventTicketHold.status == ACTIVO,
                EventTicketHold.expires_at <= momento,
            )
            .order_by(EventTicketHold.expires_at.asc())
            .limit(max(1, min(lote, 5000)))
        )
    )
    # CON TIEMPO LÍMITE TAMBIÉN AQUÍ. Es la transacción más larga del módulo
    # —hasta `lote` filas— y sin límite se queda esperando a una reserva que
    # alguien está creando, ocupando una conexión del pool mientras tanto.
    await inventory.limitar_la_espera(db)
    for hold in filas:
        hold.status = VENCIDO
        hold.updated_at = momento
    if filas:
        # UNA OPERACIÓN MASIVA DEJA RASTRO, aunque no libere nada por sí sola:
        # es la única forma de saber después si la limpieza corrió, cuándo y
        # cuánto tocó. No se archiva qué reservas: son efímeras y sin dinero.
        if usuario is not None:
            from app.modules.gobernanza import auditoria

            await auditoria.anotar(
                db,
                actor_id=usuario.id,
                action="event.ticket_holds_expired",
                entity_type="event_ticket_holds",
                entity_id=filas[0].event_id,
                payload={"procesados": len(filas), "lote": lote},
            )
        await db.commit()
    return len(filas)


# --------------------------------------------------------------------------- #
# La bandera
# --------------------------------------------------------------------------- #


async def exigir_entradas_disponibles(db: AsyncSession) -> None:
    """La migración Y la bandera. Las dos fallan igual de explícito.

    Sin la 0061 no hay dónde guardar nada; con la bandera apagada, el flujo
    existe pero no se ofrece. Las dos responden 503 con el mismo código porque
    para quien llama significan lo mismo: esto todavía no está.
    """
    if not get_settings().feature_event_ticketing or not await esquema.hay_entradas(db):
        from app.core.exceptions import ServiceUnavailableError

        raise ServiceUnavailableError(
            "La venta de entradas todavía no está disponible.",
            code="event_ticketing_not_available",
        )


# --------------------------------------------------------------------------- #
# Administración del organizador
# --------------------------------------------------------------------------- #


class ModoIncompatible(_ErrorDeEntradas):
    code = "event_mode_conflict"
    message = "No se puede cambiar el modo de acceso con reservas encima."


class CupoImposible(AppError):
    status_code = 422
    code = "ticket_quota_invalid"
    message = "El cupo no cabe en el aforo aprobado."


class TipoEnUso(_ErrorDeEntradas):
    code = "ticket_type_in_use"
    message = "Ese tipo tiene reservas activas."


async def _aforo_del_evento(db: AsyncSession, evento: Event) -> int | None:
    operacion = await db.get(EventOperations, evento.id)
    return inventory.aforo_de(
        evento, operacion.approved_capacity if operacion else None
    )


async def guardar_configuracion(
    db: AsyncSession, *, evento: Event, datos: dict, usuario
) -> EventTicketingSettings:
    """Fija el modo de acceso y la moneda.

    NO SE PASA DE GRATUITO A CON ENTRADAS CON GENTE APUNTADA. Convertir las
    reservas existentes en compradas sería regalar entradas que nadie pagó, y
    borrarlas sería echar a quien ya se apuntó. La conversión necesita decidir
    qué pasa con cada una, y eso no es este incremento.
    """
    from app.modules.gobernanza import auditoria

    # EL MISMO CERROJO QUE EL COMPRADOR, y por la misma razón. Todo lo que
    # sigue es comprobar-y-luego-escribir sobre el inventario: sin la fila del
    # evento tomada, una reserva que entra entremedias hace que la comprobación
    # decida sobre un estado que ya no existe. Se pide primero, como en todos
    # los demás caminos, que es lo que impide que dos se esperen en cruz.
    await inventory.bloquear_evento(db, evento.id)

    modo = datos.get("access_mode", LIBRE)
    ajustes = await configuracion(db, evento.id)
    anterior = modo_de_acceso(ajustes)

    if anterior == LIBRE and modo == CON_ENTRADAS:
        if await _reservas_gratuitas(db, evento.id) > 0:
            raise ModoIncompatible(
                "Este evento ya tiene reservas gratuitas. Convertirlo a entradas "
                "exige decidir qué pasa con cada una."
            )
    if anterior == CON_ENTRADAS and modo != CON_ENTRADAS:
        activos = await db.scalar(
            select(func.count())
            .select_from(EventTicketHold)
            .where(
                EventTicketHold.event_id == evento.id,
                EventTicketHold.status == ACTIVO,
                EventTicketHold.expires_at > ahora(),
            )
        )
        if activos:
            raise ModoIncompatible("Hay reservas temporales en curso.")

    if ajustes is None:
        ajustes = EventTicketingSettings(event_id=evento.id)
        db.add(ajustes)
    # LA MONEDA NO CAMBIA CON TIPOS CREADOS. La clave ajena compuesta de la 0061
    # los arrastraría, y un precio no cambia de divisa por tocar un desplegable:
    # 4900 soles no son 4900 dólares.
    nueva_moneda = datos.get("currency") or ajustes.currency or "PEN"
    if ajustes.currency and nueva_moneda != ajustes.currency:
        if await tipos_de(db, evento.id):
            raise ModoIncompatible(
                "No se cambia la moneda con tipos de entrada creados."
            )
    ajustes.access_mode = modo
    ajustes.currency = nueva_moneda
    # LO QUE NO SE MANDA NO SE TOCA. Se escribían los cuatro campos siempre, así
    # que pulsar el conmutador de modo desde la aplicación —que solo manda el
    # modo, la moneda y el tope— BORRABA en silencio la ventana de venta que
    # alguien hubiera configurado por API, y el evento se quedaba vendiendo sin
    # fecha de cierre.
    for campo in ("max_per_order", "sales_open_at", "sales_close_at"):
        if campo in datos:
            setattr(ajustes, campo, datos[campo])
    ajustes.updated_at = ahora()

    await auditoria.anotar(
        db,
        actor_id=usuario.id,
        action="event.ticketing_configured",
        entity_type="event",
        entity_id=evento.id,
        previous_state=anterior,
        new_state=modo,
        payload={"currency": ajustes.currency},
    )
    await db.commit()
    await db.refresh(ajustes)
    return ajustes


async def _exigir_modo_con_entradas(
    db: AsyncSession, evento: Event
) -> EventTicketingSettings:
    ajustes = await configuracion(db, evento.id)
    if not vende_entradas(ajustes):
        raise EventoSinEntradas(
            "Configura el evento como TICKETED antes de crear tipos de entrada."
        )
    assert ajustes is not None
    return ajustes


async def _exigir_cupo_posible(db: AsyncSession, evento: Event, cupo: int) -> None:
    """Un cupo no puede prometer más asientos de los que el evento tiene.

    Es el aforo APROBADO el que manda, no el declarado: un evento que pidió 300
    y recibió permiso para 200 no puede vender 300 entradas de un solo tipo.
    """
    aforo = await _aforo_del_evento(db, evento)
    if aforo is not None and cupo > aforo:
        raise CupoImposible(f"El cupo ({cupo}) no cabe en el aforo aprobado ({aforo}).")


async def crear_tipo(
    db: AsyncSession, *, evento: Event, datos: dict, usuario
) -> EventTicketType:
    from app.modules.gobernanza import auditoria

    # EL CERROJO TAMBIEN AQUI: `_exigir_cupo_posible` suma los cupos de todos
    # los tipos y los compara con el aforo. Dos creaciones a la vez leen la
    # misma suma y las dos pasan, y el aforo aprobado queda repartido de mas.
    await inventory.bloquear_evento(db, evento.id)

    ajustes = await _exigir_modo_con_entradas(db, evento)
    await _exigir_cupo_posible(db, evento, int(datos["quota"]))
    if int(datos["max_per_order"]) < int(datos["min_per_order"]):
        raise CupoImposible("El máximo por operación no puede ser menor que el mínimo.")

    # LA MONEDA LA PONE EL EVENTO, no el formulario. Es lo que hace que la clave
    # ajena compuesta de la 0061 no tenga nada que rechazar.
    tipo = EventTicketType(
        event_id=evento.id,
        currency=ajustes.currency,
        **{k: v for k, v in datos.items() if k != "currency"},
    )
    db.add(tipo)
    await auditoria.anotar(
        db,
        actor_id=usuario.id,
        action="event.ticket_type_created",
        entity_type="event",
        entity_id=evento.id,
        payload={
            "name": tipo.name,
            "price_minor": tipo.price_minor,
            "quota": tipo.quota,
        },
    )
    await db.commit()
    await db.refresh(tipo)
    return tipo


async def _apartadas_de(db: AsyncSession, tipo_id: str, momento: datetime) -> int:
    valor = await db.scalar(
        select(func.coalesce(func.sum(EventTicketHoldItem.quantity), 0))
        .join(EventTicketHold, EventTicketHold.id == EventTicketHoldItem.hold_id)
        .where(
            EventTicketHoldItem.ticket_type_id == tipo_id,
            EventTicketHold.status == ACTIVO,
            EventTicketHold.expires_at > momento,
        )
    )
    return int(valor or 0)


async def _tipo_propio(db: AsyncSession, evento: Event, tipo_id: str) -> EventTicketType:
    tipo = await db.get(EventTicketType, tipo_id)
    if tipo is None or tipo.event_id != evento.id:
        # 404 también para el tipo de OTRO evento: decir «existe pero no es
        # tuyo» cuenta qué está montando la competencia.
        raise NotFoundError(
            "Tipo de entrada no encontrado.", code="ticket_type_not_found"
        )
    return tipo


async def editar_tipo(
    db: AsyncSession, *, evento: Event, tipo_id: str, datos: dict, usuario
) -> EventTicketType:
    """Edita un tipo. Lo DESTRUCTIVO se bloquea si hay reservas encima.

    Cambiar el precio o bajar el cupo por debajo de lo ya apartado cambiaría lo
    que alguien tiene reservado ahora mismo. El nombre y la descripción sí se
    tocan: cada reserva guarda su propia copia del nombre.
    """
    from app.modules.gobernanza import auditoria

    # EL MISMO CERROJO QUE EL COMPRADOR, y por la misma razón. Todo lo que
    # sigue es comprobar-y-luego-escribir sobre el inventario: sin la fila del
    # evento tomada, una reserva que entra entremedias hace que la comprobación
    # decida sobre un estado que ya no existe. Se pide primero, como en todos
    # los demás caminos, que es lo que impide que dos se esperen en cruz.
    await inventory.bloquear_evento(db, evento.id)

    tipo = await _tipo_propio(db, evento, tipo_id)
    momento = ahora()
    apartadas = await _apartadas_de(db, tipo_id, momento)

    if apartadas:
        if "price_minor" in datos and datos["price_minor"] != tipo.price_minor:
            raise TipoEnUso("No se cambia el precio con reservas activas encima.")
        if "quota" in datos and int(datos["quota"]) < apartadas:
            raise TipoEnUso(
                f"Hay {apartadas} entradas apartadas: el cupo no puede bajar de ahí."
            )

    if "quota" in datos:
        await _exigir_cupo_posible(db, evento, int(datos["quota"]))

    minimo = datos.get("min_per_order", tipo.min_per_order)
    maximo = datos.get("max_per_order", tipo.max_per_order)
    if maximo < minimo:
        raise CupoImposible("El máximo por operación no puede ser menor que el mínimo.")

    antes = {
        "price_minor": tipo.price_minor,
        "quota": tipo.quota,
        "status": tipo.status,
    }
    for campo, valor in datos.items():
        setattr(tipo, campo, valor)
    tipo.updated_at = momento

    await auditoria.anotar(
        db,
        actor_id=usuario.id,
        action="event.ticket_type_updated",
        entity_type="event",
        entity_id=evento.id,
        payload={"tipo": tipo_id, "campos": sorted(datos), "antes": antes},
    )
    await db.commit()
    await db.refresh(tipo)
    return tipo


async def retirar_tipo(
    db: AsyncSession, *, evento: Event, tipo_id: str, usuario
) -> EventTicketType:
    """RETIRA, no borra.

    Una reserva puede estar apuntando a este tipo y su resumen tiene que seguir
    contando lo mismo. `retired` lo saca de la venta y lo deja donde está; la
    clave ajena `on delete restrict` de las líneas dice lo mismo desde la base.
    """
    from app.modules.gobernanza import auditoria

    # EL MISMO CERROJO QUE EL COMPRADOR, y por la misma razón. Todo lo que
    # sigue es comprobar-y-luego-escribir sobre el inventario: sin la fila del
    # evento tomada, una reserva que entra entremedias hace que la comprobación
    # decida sobre un estado que ya no existe. Se pide primero, como en todos
    # los demás caminos, que es lo que impide que dos se esperen en cruz.
    await inventory.bloquear_evento(db, evento.id)

    tipo = await _tipo_propio(db, evento, tipo_id)
    tipo.status = "retired"
    tipo.updated_at = ahora()
    await auditoria.anotar(
        db,
        actor_id=usuario.id,
        action="event.ticket_type_retired",
        entity_type="event",
        entity_id=evento.id,
        payload={"tipo": tipo_id, "name": tipo.name},
    )
    await db.commit()
    await db.refresh(tipo)
    return tipo
