"""Las sesiones 1:1 dentro del chat: cada hecho de una sesion es un mensaje.

LO REPORTADO (04/10/2026). «No hubo manera de aceptar la solicitud de esa sesion
estando en mensajes… deberia aparecer como una opcion de boton en mensajes y
que aparezca tambien si acepte o no. Eso tambien debe quedar registrado ahi».

QUE HABIA. Pedir una sesion creaba la fila en `bookings` y, aparte, el movil
escribia un mensaje de texto normal («Hola Ana, me gustaria agendar…»). Las dos
cosas no se conocian: el mensaje no sabia de que sesion hablaba, asi que el chat
no podia ofrecer «Aceptar», ni enterarse de que ya se habia aceptado.

QUE HAY AHORA. El mensaje lo escribe EL SERVIDOR, en la misma transaccion que
la sesion, y cuelga de el una fila en `message_booking_context` (migracion
0097) que dice de que sesion habla y que paso: se pidio, se acepto, se
rechazo, se cancelo… Es el mismo patron que las respuestas a historias
(`historias.py`): tabla aparte, ninguna columna nueva en `messages`.

  · La SOLICITUD es un mensaje de quien la pide. La aplicacion lo pinta como
    una tarjeta con los botones que le tocan a quien mira.
  · Cada RESPUESTA es otro mensaje, de quien respondio. Es el registro: queda
    en la conversacion, en orden, con su hora.
  · EL ESTADO NO SE COPIA. Cada lectura lo trae de `bookings`. Una tarjeta
    aceptada deja de ofrecer «Aceptar» porque la sesion ya no esta pendiente,
    no porque alguien se acordara de actualizar el mensaje.

EL TEXTO DEL MENSAJE NO ES ADORNO. Es lo que ve la bandeja como resumen, lo que
encuentra el buscador y lo unico que pinta una version de la aplicacion que
todavia no conoce las tarjetas —o esta misma, mientras la 0097 no este
aplicada—. Por eso se escribe entero y legible, no como una marca.

SOLO ESCRIBE EL SERVIDOR. Si el cliente pudiera insertar estas filas, cualquiera
dejaria escrito «sesion aceptada» en un chat sin que nadie aceptara nada.
"""

from __future__ import annotations

from datetime import datetime, timezone as tz
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bookings.models import Booking
from app.modules.messaging import esquema
from app.modules.messaging.models import Conversation, Message, MessageBookingContext
from app.modules.messaging.schemas import BookingContextRead

#: El hecho que deja escrito en el chat cada estado al que pasa una sesion.
#: `pending` solo ocurre al pedirla. `expired` no esta: nadie la provoca.
EVENTO_DEL_ESTADO: dict[str, str] = {
    "pending": "requested",
    "accepted": "accepted",
    "rejected": "rejected",
    "cancelled": "cancelled",
    "reschedule_requested": "reschedule_requested",
    "completed": "completed",
}

EVENTOS: frozenset[str] = frozenset(EVENTO_DEL_ESTADO.values())


def fecha_legible(momento: datetime | None, zona: str | None) -> str | None:
    """«05/10/2026 a las 21:41», en la zona de quien la propuso.

    EN SU ZONA y no en UTC: una sesion a las 21:41 de Lima escrita como «02:41»
    dice otra hora, y otro dia. Si la zona no se conoce —no vino, o este
    servidor no tiene esa entrada— se escribe en UTC Y SE DICE, que es mejor que
    una hora que parece local y no lo es.

    Formato de 24 horas a proposito: «9:41 p. m.» depende del idioma, y este
    texto lo lee tambien quien tiene la aplicacion en ingles o en portugues.
    """
    if momento is None:
        return None
    if momento.tzinfo is None:
        momento = momento.replace(tzinfo=tz.utc)
    try:
        local = momento.astimezone(ZoneInfo(zona)) if zona else None
    except (ZoneInfoNotFoundError, ValueError, OSError):
        local = None
    if local is None:
        return f"{momento.astimezone(tz.utc):%d/%m/%Y a las %H:%M} (UTC)"
    return f"{local:%d/%m/%Y a las %H:%M}"


def texto_del_evento(evento: str, reserva: Booking) -> str:
    """Lo que dice el mensaje. Ver la cabecera: no es adorno."""
    tema = (reserva.topic or "").strip()
    cuando = fecha_legible(reserva.scheduled_at, reserva.timezone)
    if evento == "requested":
        lineas = ["Solicitud de sesión 1:1"]
        if tema:
            lineas.append(f"Tema: {tema}")
        if cuando:
            lineas.append(f"Fecha propuesta: {cuando}")
        return "\n".join(lineas)
    if evento == "reschedule_requested":
        return (
            f"Nueva fecha propuesta para la sesión: {cuando}"
            if cuando
            else "Se propuso cambiar la fecha de la sesión"
        )
    titulo = {
        "accepted": "Sesión aceptada",
        "rejected": "Solicitud de sesión rechazada",
        "cancelled": "Sesión cancelada",
        "completed": "Sesión realizada",
    }.get(evento, "Sesión actualizada")
    return f"{titulo}: {tema}" if tema else titulo


async def anotar(
    db: AsyncSession,
    *,
    conversation_id: str,
    sender_id: str,
    reserva: Booking,
    evento: str,
) -> str:
    """Deja en el chat el mensaje de un hecho de la sesion. NO HACE COMMIT.

    Va en la transaccion de quien llama: o se guardan la sesion y su mensaje, o
    ninguno. Un «sesion aceptada» en el chat con la sesion todavia pendiente
    seria justo la mentira que esto viene a quitar.

    SIN LA 0097 el mensaje se escribe igual, sin su fila de contexto: la
    conversacion sigue contando lo que paso, en texto.
    """
    if evento not in EVENTOS:
        raise ValueError(f"Hecho de sesion desconocido: {evento!r}")

    # `insert().values()` y no `db.add(Message(...))`, igual que `send_message`:
    # el segundo escribe TODAS las columnas mapeadas.
    message_id = (
        await db.execute(
            insert(Message)
            .values(
                conversation_id=conversation_id,
                sender_id=sender_id,
                body=texto_del_evento(evento, reserva),
            )
            .returning(Message.id)
        )
    ).scalar_one()

    if await esquema.hay_sesiones_en_el_chat(db):
        await db.execute(
            insert(MessageBookingContext).values(
                message_id=message_id, booking_id=reserva.id, event=evento
            )
        )

    # Lo que sube la conversacion en la bandeja, como cualquier mensaje.
    await db.execute(
        update(Conversation)
        .where(Conversation.id == conversation_id)
        .values(updated_at=func.now())
    )
    return str(message_id)


async def contextos_por_mensaje(
    db: AsyncSession, message_ids: list[str], uid: str
) -> dict[str, BookingContextRead]:
    """La sesion de TODOS los mensajes de una pagina, en UNA consulta.

    Con el estado de la sesion leido AHORA de `bookings`: es lo que hace que la
    tarjeta diga la verdad sin que nadie tenga que reescribir mensajes viejos.

    Sin la 0097 devuelve `{}`.
    """
    # Lista vacia = no se consulta. Y NUNCA `in_(lista or [""])`: regla del
    # proyecto (asyncpg rechaza la cadena vacia como uuid).
    if not message_ids:
        return {}
    if not await esquema.hay_sesiones_en_el_chat(db):
        return {}

    filas = (
        await db.execute(
            select(
                MessageBookingContext.message_id,
                MessageBookingContext.event,
                Booking.id,
                Booking.status,
                Booking.topic,
                Booking.note,
                Booking.scheduled_at,
                Booking.timezone,
                Booking.provider_id,
                Booking.updated_at,
            )
            .join(Booking, Booking.id == MessageBookingContext.booking_id)
            .where(MessageBookingContext.message_id.in_(message_ids))
        )
    ).all()

    return {
        mensaje_id: BookingContextRead(
            booking_id=reserva_id,
            event=evento,
            status=estado,
            topic=tema,
            note=nota or "",
            scheduled_at=cuando,
            timezone=zona,
            my_role="provider" if quien_da == uid else "requester",
            updated_at=actualizada,
        )
        for (
            mensaje_id,
            evento,
            reserva_id,
            estado,
            tema,
            nota,
            cuando,
            zona,
            quien_da,
            actualizada,
        ) in filas
    }


async def es_registro_de_sesion(db: AsyncSession, message_id: str) -> bool:
    """Si este mensaje es el registro de un hecho de una sesion.

    Esos mensajes no se borran: son lo que deja constancia de que algo se pidio
    o se acepto. Quitar uno dejaria una sesion aceptada sin rastro de quien la
    acepto. La sesion se cancela; el registro se queda.
    """
    if not await esquema.hay_sesiones_en_el_chat(db):
        return False
    fila = await db.scalar(
        select(MessageBookingContext.message_id)
        .where(MessageBookingContext.message_id == message_id)
        .limit(1)
    )
    return fila is not None
