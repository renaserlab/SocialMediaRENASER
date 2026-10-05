"""Endpoints de la agenda: pedir una sesion y llevarla por sus estados.

Seguridad: quien pide sale SIEMPRE del token (`current_user.id`), nunca del
cuerpo. Y ninguna peticion puede tocar una sesion en la que no participe.
"""

import logging
from datetime import datetime, timezone as tz

from fastapi import APIRouter, BackgroundTasks, Depends, Query, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError, NotFoundError, ValidationAppError
from app.core.security import AuthUser, get_current_user
from app.modules.bookings.models import Booking
from app.modules.bookings.schemas import (
    BookingCreate,
    BookingRead,
    BookingUpdate,
    es_momento_futuro,
    transicion_permitida,
)
from app.modules.messaging import sesiones
from app.modules.messaging.models import Conversation, ConversationMember
from app.modules.messaging.router import conversacion_directa
from app.modules.notifications.push import encolar_push, nombre_visible
from app.modules.notifications.service import add_notification
from app.modules.profiles.models import Profile
from app.modules.recommendations.signals import registrar_senal
from app.modules.profiles.schemas import ProfileSummary
from app.modules.social_graph.models import UserBlock
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.pagination import Page, pagination_params

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/bookings", tags=["bookings"])

#: Que aviso corresponde a cada estado al que se pasa.
#:
#: Son tipos distintos y no uno solo con el estado dentro porque el aviso se
#: lee de un vistazo en una lista: «Sesión confirmada» y «Solicitud rechazada»
#: tienen que distinguirse sin abrir nada.
TIPO_DE_AVISO: dict[str, str] = {
    "accepted": "session_accepted",
    "rejected": "session_rejected",
    "cancelled": "session_cancelled",
    "reschedule_requested": "session_rescheduled",
    "completed": "session_completed",
}


async def _nombre_del_actor(db: AsyncSession, uid: str) -> str | None:
    """El nombre con el que aparece quien provoca un aviso de la agenda.

    SALE DE `profiles`, NO DE `current_user`. Es la misma regla —y el mismo
    helper, escrito igual— que en `content/router.py`: `AuthUser` es lo que trae
    el JWT (id, correo, rol) y NO tiene `full_name`. Leerlo de ahi lanza un
    AttributeError DESPUES del commit, o sea un 500 con la reserva ya guardada,
    que ademas el navegador reporta como error de CORS porque Starlette no pone
    cabeceras CORS en una excepcion sin capturar.

    UNA consulta y un solo valor: no hace falta la fila entera del perfil, y
    aqui no hay lote que resolver porque el actor de un aviso de agenda es
    siempre una sola persona.

    Devolver None es valido: `push.build_message` escribe «Alguien» y el aviso
    sale igual. Un nombre generico es mejor que ningun aviso. Antes de llegar
    ahi se prueba con el usuario (`nombre_visible`).
    """
    fila = (
        await db.execute(
            select(Profile.full_name, Profile.username).where(Profile.id == uid)
        )
    ).first()
    return nombre_visible(fila[0], fila[1]) if fila else None


async def _conversacion_de(db: AsyncSession, quien_pide: str, quien_da: str) -> str | None:
    """El chat directo de las dos partes, donde queda escrita la sesion.

    SE LLAMA ANTES DE ESCRIBIR NADA DE LA SESION, porque si la conversacion no
    existia la crea y confirma su propia transaccion.

    DEVUELVE None SIN LANZAR si no se puede. La sesion es lo que la persona ha
    pedido; que quede ademas escrita en el chat es lo que la hace comoda. Perder
    lo segundo no puede costar lo primero: la agenda y el aviso siguen saliendo.
    """
    try:
        return await conversacion_directa(db, quien_pide, quien_da)
    except Exception:  # noqa: BLE001 - el chat nunca tumba la agenda
        logger.warning("[agenda] no se pudo abrir el chat de la sesion", exc_info=True)
        await db.rollback()
        return None


async def _dejar_en_el_chat(
    db: AsyncSession, *, conversacion_id: str | None, quien: str, reserva: Booking
) -> None:
    """Escribe en el chat lo que acaba de pasar con la sesion. No hace commit.

    DENTRO DE UN PUNTO DE GUARDADO: si escribir el mensaje falla, se deshace el
    mensaje y nada mas. Sin el, un fallo aqui dejaria la transaccion inservible
    y se llevaria por delante la sesion que se estaba guardando.
    """
    if conversacion_id is None:
        return
    try:
        async with db.begin_nested():
            await sesiones.anotar(
                db,
                conversation_id=conversacion_id,
                sender_id=quien,
                reserva=reserva,
                evento=sesiones.EVENTO_DEL_ESTADO[reserva.status],
            )
    except Exception:  # noqa: BLE001 - el chat nunca tumba la agenda
        logger.warning("[agenda] no se pudo dejar la sesion en el chat", exc_info=True)


def _exigir_momento_futuro(scheduled_at: datetime | None) -> None:
    """Una sesion no se agenda para una fecha que ya paso.

    LA HORA LA PONE EL SERVIDOR (`datetime.now(utc)`), no la peticion. El reloj
    del telefono lo elige quien lo lleva: atrasarlo un dia seria todo lo que
    hace falta para colar una fecha pasada si la comprobacion viviera alli. El
    movil lo comprueba tambien, pero para no dejar escribir algo que se va a
    rechazar — no es donde se decide.

    Sin fecha no se valida nada: acordarla por chat es un caso legitimo y es lo
    unico que habia antes de que existiera el selector.
    """
    if not es_momento_futuro(scheduled_at, datetime.now(tz.utc)):
        raise ValidationAppError(
            "Esa fecha ya pasó. Elige un momento futuro para la sesión.",
            code="booking_date_in_past",
        )


def _resumen(perfil: Profile) -> ProfileSummary:
    return ProfileSummary(
        id=perfil.id,
        full_name=perfil.full_name,
        username=perfil.username,
        avatar_path=perfil.avatar_path,
        bio=perfil.bio,
    )


def _leer(reserva: Booking, quien_pide: Profile, quien_da: Profile, uid: str) -> BookingRead:
    return BookingRead(
        id=reserva.id,
        topic=reserva.topic,
        note=reserva.note or "",
        status=reserva.status,
        scheduled_at=reserva.scheduled_at,
        timezone=reserva.timezone,
        conversation_id=reserva.conversation_id,
        completed_at=reserva.completed_at,
        created_at=reserva.created_at,
        updated_at=reserva.updated_at,
        requester=_resumen(quien_pide),
        provider=_resumen(quien_da),
        my_role="provider" if reserva.provider_id == uid else "requester",
    )


async def _leer_varias(db: AsyncSession, reservas: list[Booking], uid: str) -> list[BookingRead]:
    """Varias sesiones con los perfiles de sus dos partes, en UNA consulta.

    No una por fila: con veinte solicitudes eso eran cuarenta viajes a la base.
    """
    if not reservas:
        return []
    ids = {r.requester_id for r in reservas} | {r.provider_id for r in reservas}
    perfiles = (
        (await db.execute(select(Profile).where(Profile.id.in_(ids)))).scalars().all()
    )
    por_id = {p.id: p for p in perfiles}
    salida: list[BookingRead] = []
    for r in reservas:
        quien_pide = por_id.get(r.requester_id)
        quien_da = por_id.get(r.provider_id)
        if quien_pide is None or quien_da is None:
            # Un perfil borrado no debe tumbar la agenda entera.
            continue
        salida.append(_leer(r, quien_pide, quien_da, uid))
    return salida


async def _cargar(db: AsyncSession, reserva: Booking, uid: str) -> BookingRead:
    """Los dos perfiles de una reserva, en UNA consulta."""
    perfiles = (
        (
            await db.execute(
                select(Profile).where(
                    Profile.id.in_([reserva.requester_id, reserva.provider_id])
                )
            )
        )
        .scalars()
        .all()
    )
    por_id = {p.id: p for p in perfiles}
    quien_pide = por_id.get(reserva.requester_id)
    quien_da = por_id.get(reserva.provider_id)
    if quien_pide is None or quien_da is None:
        raise NotFoundError("Perfil no encontrado.")
    return _leer(reserva, quien_pide, quien_da, uid)


@router.get("", response_model=list[BookingRead])
async def list_bookings(
    role: str = Query(default="all", pattern="^(all|received|sent)$"),
    status_filter: str | None = Query(default=None, alias="status"),
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[BookingRead]:
    """Las sesiones en las que participa quien pregunta.

    `received` = «me las piden a mi» (la bandeja de solicitudes);
    `sent` = «las he pedido yo». Se separan porque son dos lecturas distintas
    de la misma tabla y mezclarlas obliga a quien mira a averiguar en cada fila
    de que lado esta.
    """
    uid = current_user.id
    consulta = select(Booking)
    if role == "received":
        consulta = consulta.where(Booking.provider_id == uid)
    elif role == "sent":
        consulta = consulta.where(Booking.requester_id == uid)
    else:
        consulta = consulta.where(
            or_(Booking.provider_id == uid, Booking.requester_id == uid)
        )
    if status_filter:
        consulta = consulta.where(Booking.status == status_filter)

    reservas = (
        (
            await db.execute(
                consulta.order_by(Booking.created_at.desc())
                .limit(page.limit)
                .offset(page.offset)
            )
        )
        .scalars()
        .all()
    )
    return await _leer_varias(db, list(reservas), uid)


@router.get("/conversation/{conversation_id}", response_model=list[BookingRead])
async def bookings_of_conversation(
    conversation_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[BookingRead]:
    """Las sesiones entre las dos personas de UN chat directo.

    PARA QUE. Es lo que deja a la conversacion ofrecer los botones de una sesion
    aunque el mensaje que la pidio no este a la vista —mas arriba en el
    historial, de antes de este cambio, o texto normal mientras la 0097 espere—
    y lo que pone al dia una tarjeta vieja.

    SE BUSCAN POR LAS DOS PERSONAS, NO POR `bookings.conversation_id`. Esa
    columna no sirve para esto por dos motivos: las sesiones de antes la tienen
    vacia, y la politica de la tabla (0025) deja a las partes escribirla desde
    el cliente, asi que no se puede dar por buena. Quienes son las dos personas
    de un chat directo si lo sabe el servidor.

    NO ABRE NADA. Si quien pregunta no es miembro de esa conversacion, o no es
    un chat directo, la respuesta es una lista vacia: ni un 404 que confirme
    que el identificador existe.
    """
    ensure_uuid(conversation_id, "Conversación no encontrada.")
    uid = current_user.id
    miembros = (
        (
            await db.execute(
                select(ConversationMember.user_id)
                .join(Conversation, Conversation.id == ConversationMember.conversation_id)
                .where(
                    ConversationMember.conversation_id == conversation_id,
                    Conversation.kind == "direct",
                )
            )
        )
        .scalars()
        .all()
    )
    if uid not in miembros or len(miembros) != 2:
        return []
    otro = next(m for m in miembros if m != uid)

    reservas = (
        (
            await db.execute(
                select(Booking)
                .where(
                    or_(
                        (Booking.requester_id == uid) & (Booking.provider_id == otro),
                        (Booking.requester_id == otro) & (Booking.provider_id == uid),
                    )
                )
                .order_by(Booking.created_at.desc())
                .limit(50)
            )
        )
        .scalars()
        .all()
    )
    return await _leer_varias(db, list(reservas), uid)


@router.post("", response_model=BookingRead, status_code=status.HTTP_201_CREATED)
async def create_booking(
    payload: BookingCreate,
    background: BackgroundTasks,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> BookingRead:
    """Pide una sesion a otra persona."""
    ensure_uuid(payload.provider_id, "Perfil no encontrado.")
    if payload.provider_id == current_user.id:
        # AUTO-AGENDA: fuera. Una sesion son dos personas, y una fila donde
        # quien pide y quien da son la misma cuenta no significa nada: se podria
        # aceptar a si misma, completarse sola y acabar dando el sello de
        # «interaccion verificada» a una resena que nadie ha vivido.
        raise ValidationAppError(
            "No puedes agendar una sesión contigo mismo.",
            code="booking_self_not_allowed",
        )
    _exigir_momento_futuro(payload.scheduled_at)

    quien_da = await db.get(Profile, payload.provider_id)
    if quien_da is None:
        raise NotFoundError("Perfil no encontrado.")

    # Bloquear tiene que servir de algo tambien aqui: sin esto, la agenda seria
    # una puerta trasera para llegar a alguien que te ha bloqueado.
    bloqueo = (
        await db.execute(
            select(UserBlock.blocker_id).where(
                or_(
                    (UserBlock.blocker_id == current_user.id)
                    & (UserBlock.blocked_id == payload.provider_id),
                    (UserBlock.blocker_id == payload.provider_id)
                    & (UserBlock.blocked_id == current_user.id),
                )
            )
        )
    ).first()
    if bloqueo:
        raise ForbiddenError("No puedes agendar una sesión con esta persona.")

    # El chat de las dos partes, ANTES de escribir nada de la sesion: si no
    # existia lo crea y confirma su propia transaccion, y eso soltaria el
    # cerrojo de abajo.
    conversacion_id = await _conversacion_de(db, current_user.id, payload.provider_id)

    # UNA PETICION A LA VEZ POR QUIEN PIDE. Sin este cerrojo, dos solicitudes
    # simultaneas —dos toques muy seguidos, o un toque mas el reintento de una
    # red lenta— leian las dos «no hay ninguna pendiente» y creaban dos
    # sesiones, dos avisos y dos tarjetas en el chat. La segunda espera aqui a
    # que la primera confirme y entonces encuentra la suya. (SQLite ignora el
    # cerrojo; en las pruebas no hay dos conexiones a la vez.)
    await db.execute(
        select(Profile.id).where(Profile.id == current_user.id).with_for_update()
    )

    # Una solicitud pendiente a la vez con la misma persona.
    #
    # Sin esto, tocar dos veces «Agendar» —o volver atras y repetir— dejaba dos
    # solicitudes identicas en la bandeja de la otra persona, que tendria que
    # responder a las dos sin saber cual es cual. Se devuelve la que ya existe
    # en vez de un error: el resultado que la persona buscaba ya esta.
    existente = (
        await db.execute(
            select(Booking).where(
                Booking.requester_id == current_user.id,
                Booking.provider_id == payload.provider_id,
                Booking.status.in_(["pending", "reschedule_requested"]),
            )
        )
    ).scalars().first()
    if existente is not None:
        return await _cargar(db, existente, current_user.id)

    reserva = Booking(
        requester_id=current_user.id,
        provider_id=payload.provider_id,
        topic=payload.topic.strip(),
        note=(payload.note or "").strip(),
        scheduled_at=payload.scheduled_at,
        timezone=payload.timezone,
        status="pending",
        # La sesion sabe en que conversacion vive: es lo que deja a la agenda
        # abrir el chat, y al movil saber que el mensaje ya lo escribio el
        # servidor (y no mandar otro encima).
        conversation_id=conversacion_id,
    )
    db.add(reserva)
    await db.flush()

    # LA SOLICITUD QUEDA EN EL CHAT, escrita por el servidor y en esta misma
    # transaccion. Antes la escribia el movil despues, como un mensaje de texto
    # que no sabia de que sesion hablaba: por eso en Mensajes no se podia
    # aceptar nada. Ver `messaging/sesiones.py`.
    #
    # SOLO SI LA APLICACION LO PIDE (`announce_in_chat`). Las versiones
    # instaladas antes de este cambio siguen mandando su propio texto despues
    # de crear la sesion; si el servidor escribiera ademas el suyo, a quien
    # recibe le llegaria la misma solicitud dos veces. La que lo pide es la que
    # ya no manda el texto.
    if payload.announce_in_chat:
        await _dejar_en_el_chat(
            db, conversacion_id=conversacion_id, quien=current_user.id, reserva=reserva
        )

    # El aviso lo crea el SERVIDOR, no el movil.
    #
    # La migracion 0019 tuvo que abrir la insercion de `session_booked` desde el
    # cliente porque no habia backend que lo hiciera. Ahora si lo hay, y con
    # `entity_type='booking'` y el id dentro: por eso tocar el aviso abre la
    # AGENDA y no el perfil de quien lo mando, que es donde caian todos antes.
    estrenado = await add_notification(
        db,
        user_id=payload.provider_id,
        actor_id=current_user.id,
        type="session_booked",
        entity_type="booking",
        entity_id=reserva.id,
        payload={"topic": reserva.topic},
    )
    # Pedir una sesion es la senal mas fuerte que hay hoy: alguien ha decidido
    # dedicarle tiempo a otra persona. La escribe el servidor, en el mismo
    # commit que la reserva.
    await registrar_senal(
        db,
        user_id=current_user.id,
        event_type="booking_requested",
        entity_type="profile",
        entity_id=payload.provider_id,
    )
    await db.commit()
    await db.refresh(reserva)

    if estrenado:
        encolar_push(
            background,
            user_ids=[payload.provider_id],
            notification_type="session_booked",
            # SIN ESTO el aviso decia «Alguien quiere agendar contigo».
            # `push.build_message` sustituye `{actor}` por «Alguien» cuando no
            # le dan nombre, asi que faltaba justo lo que hace util el aviso:
            # saber QUIEN pide la sesion sin abrir la aplicacion. El nombre sale
            # de `profiles`, nunca del token (ver `_nombre_del_actor`).
            actor_name=await _nombre_del_actor(db, current_user.id),
            data={"type": "booking", "id": reserva.id},
        )
    return await _cargar(db, reserva, current_user.id)


@router.patch("/{booking_id}", response_model=BookingRead)
async def update_booking(
    booking_id: str,
    payload: BookingUpdate,
    background: BackgroundTasks,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> BookingRead:
    """Acepta, rechaza, cancela, reprograma o da por hecha una sesion.

    QUE transicion vale lo decide la tabla de `schemas.TRANSICIONES`, no una
    cadena de `if` repartida por aqui: son reglas de producto —quien recibe
    acepta, quien pide no se acepta a si mismo, de un estado final no se sale— y
    tienen que poder leerse de un vistazo.
    """
    ensure_uuid(booking_id, "Sesión no encontrada.")
    reserva = await db.get(Booking, booking_id)
    if reserva is None:
        raise NotFoundError("Sesión no encontrada.")

    if current_user.id == reserva.provider_id:
        rol = "provider"
    elif current_user.id == reserva.requester_id:
        rol = "requester"
    else:
        # Ni siquiera se le dice que existe: no es asunto suyo.
        raise NotFoundError("Sesión no encontrada.")


    # Lo que no vale se rechaza YA, antes de buscar o crear nada. La
    # comprobacion que decide es la de abajo, con cerrojo; esta evita que una
    # peticion que no va a ninguna parte deje abierta una conversacion.
    if not transicion_permitida(reserva.status, payload.status, rol):
        raise ValidationAppError(
            "Esa acción ya no es posible sobre esta sesión.",
            code="booking_transition_not_allowed",
        )

    # Reprogramar tampoco vale hacia atras. Sin esto, la comprobacion de crear
    # se saltaba en un paso: se pedia la sesion para manana y acto seguido se
    # «reprogramaba» al mes pasado.
    #
    # Solo cuando la peticion trae fecha: aceptar o completar no la tocan, y
    # exigirla ahi impediria dar por hecha una sesion que ya ocurrio, que es
    # justamente lo que da el sello a una resena.
    if payload.scheduled_at is not None:
        _exigir_momento_futuro(payload.scheduled_at)

    # Donde queda escrito: EL CHAT DIRECTO DE LAS DOS PARTES, buscado ahora.
    #
    # NO SE USA `reserva.conversation_id`, aunque este puesto. La politica de la
    # tabla (0025) deja a las partes escribir esa columna desde el cliente:
    # quien la apuntara a un chat ajeno haria que el servidor escribiera ahi,
    # con su firma, «Sesion cancelada: <lo que quiera>», y que los de ese chat
    # leyeran los datos de una sesion que no es suya. De quien es la sesion si
    # lo sabe el servidor, y de ahi sale la conversacion.
    #
    # Se busca —o se crea— AHORA, antes de tocar nada, porque crearla confirma
    # su propia transaccion. Por eso la reserva se vuelve a leer despues.
    conversacion_id = await _conversacion_de(db, reserva.requester_id, reserva.provider_id)

    # LA SESION SE VUELVE A LEER CON CERROJO, y lo que vale se decide DESPUES.
    #
    # Sin el, dos respuestas a la vez —un doble toque en «Aceptar», o aceptar en
    # el chat mientras la otra persona cancela— leian las dos el mismo estado,
    # las dos pasaban la comprobacion y las dos escribian: la sesion quedaba
    # con el estado de la ultima y el chat con dos registros contradictorios.
    # Con el cerrojo la segunda espera, lee el estado que dejo la primera y
    # recibe «eso ya no es posible», que el movil trata como «vuelve a leer».
    # (SQLite ignora el cerrojo; en las pruebas no hay dos conexiones a la vez.)
    await db.refresh(reserva, with_for_update=True)
    if conversacion_id is not None and reserva.conversation_id != conversacion_id:
        # Tambien corrige una apuntada a mano a otro sitio.
        reserva.conversation_id = conversacion_id

    if not transicion_permitida(reserva.status, payload.status, rol):
        raise ValidationAppError(
            "Esa acción ya no es posible sobre esta sesión.",
            # Con codigo: el movil lo distingue de un fallo cualquiera y, en vez
            # de quedarse con un boton que ya no vale, vuelve a leer la sesion.
            code="booking_transition_not_allowed",
        )

    reserva.status = payload.status
    if payload.status == "completed":
        reserva.completed_at = datetime.now(tz.utc)
        # La sesion OCURRIO. Es la senal mas fuerte del sistema y se anota para
        # las DOS partes: cada una aprendio algo de la otra, y manana sera
        # ademas lo que permita verificar una resena.
        for quien, con_quien in (
            (reserva.requester_id, reserva.provider_id),
            (reserva.provider_id, reserva.requester_id),
        ):
            await registrar_senal(
                db,
                user_id=quien,
                event_type="booking_completed",
                entity_type="profile",
                entity_id=con_quien,
            )
    if payload.scheduled_at is not None:
        reserva.scheduled_at = payload.scheduled_at
    if payload.timezone is not None:
        reserva.timezone = payload.timezone
    reserva.updated_at = datetime.now(tz.utc)

    # A quien hay que avisar: siempre a la OTRA parte.
    #
    # Y con un tipo POR RESPUESTA, no uno solo para todo: con un unico
    # `session_booked`, a quien le rechazaban una sesion le llegaba «reservó una
    # sesión contigo», que dice justo lo contrario de lo que paso.
    otra_parte = reserva.requester_id if rol == "provider" else reserva.provider_id
    tipo = TIPO_DE_AVISO.get(reserva.status, "session_booked")
    estrenado = await add_notification(
        db,
        user_id=otra_parte,
        actor_id=current_user.id,
        type=tipo,
        entity_type="booking",
        entity_id=reserva.id,
        payload={"topic": reserva.topic, "status": reserva.status},
    )
    # Y EL REGISTRO EN EL CHAT: quien respondio, que respondio y cuando. Es lo
    # que hace que la tarjeta de la solicitud y la agenda cuenten lo mismo.
    await db.flush()
    await _dejar_en_el_chat(
        db, conversacion_id=conversacion_id, quien=current_user.id, reserva=reserva
    )
    await db.commit()
    await db.refresh(reserva)

    # El push tambien: sin el, quien pidio la sesion no se enteraba de que se la
    # habian aceptado hasta que volviera a abrir la aplicacion por su cuenta.
    # Con el nombre de quien respondio: «Alguien aceptó tu solicitud» obliga a
    # abrir la aplicacion para saber lo unico que hacia falta saber.
    if estrenado:
        encolar_push(
            background,
            user_ids=[otra_parte],
            notification_type=tipo,
            actor_name=await _nombre_del_actor(db, current_user.id),
            data={"type": "booking", "id": reserva.id},
        )
    return await _cargar(db, reserva, current_user.id)
