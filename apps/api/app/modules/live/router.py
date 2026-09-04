"""Endpoints de las transmisiones en vivo: la sala, el chat y las reacciones.

QUE HAY AQUI Y QUE NO. Aqui esta todo lo de una emision MENOS la imagen. El
video en directo lo sirve un proveedor externo que todavia no se ha elegido
(ver `providers.py`), y esa es una decision de negocio como la pasarela de
pago. Mientras tanto la sala se crea, el chat funciona y las reacciones
tambien; lo unico que no hay es imagen, y se dice.

DONDE VIAJA CADA COSA, que es la decision de rendimiento entera:

  * El CHAT y el ESTADO de la sala viajan por Supabase Realtime desde la propia
    base (migracion 0029), igual que la mensajeria privada desde la 0002. La
    aplicacion se suscribe y recibe; este router solo ESCRIBE.
  * Las REACCIONES individuales NO pasan por aqui ni por la base: viajan por
    Realtime Broadcast entre los clientes. Lo unico que llega a este router es
    el RESUMEN acumulado cada pocos segundos, para el contador.

Es decir: en una emision con cien espectadores charlando, este servidor recibe
un puñado de escrituras por segundo, no un chaparron.
"""

from __future__ import annotations

from datetime import datetime, timezone

import json
import logging

from fastapi import APIRouter, Depends, Query, Request, Response, status
from sqlalchemy import func, insert, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.exceptions import (
    ConflictError,
    ForbiddenError,
    NotFoundError,
    ServiceUnavailableError,
)
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.live import limites, providers, roles, webhooks
from app.modules.live.hms_client import ErrorDe100ms
from app.modules.live.proveedor_100ms import traducir_error
from app.modules.live.models import LiveMessage, LiveReactionTotal, LiveSession
from app.modules.live.schemas import (
    REACCIONES,
    LiveCredential,
    LiveMessageCreate,
    LiveMessageRead,
    LiveSessionCreate,
    LiveSessionRead,
    LiveSessionUpdate,
    ReactionFlush,
    ReactionTotals,
)
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.social_graph.models import UserBlock
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.permissions import is_admin

logger = logging.getLogger("renaser.live")

router = APIRouter(prefix="/live", tags=["live"])

#: Cuantos mensajes de historial se entregan al entrar. Los suficientes para
#: entender de que se esta hablando, no tantos como para tener que leer diez
#: minutos de conversacion ajena antes de participar.
HISTORIAL = 50


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


async def _exigir_esquema(db: AsyncSession) -> None:
    """Sin la migracion 0029 no hay emisiones que servir.

    Se responde 503 y no 500: no es que algo se haya roto, es que esta parte
    todavia no esta montada. Los listados responden vacio en vez de fallar (ver
    `listar`), porque «no hay emisiones» es exactamente la verdad.
    """
    if not await esquema.hay_directos(db):
        raise ServiceUnavailableError(
            "Las transmisiones en vivo todavía no están disponibles.",
            code="live_not_available",
        )


async def _bloqueados(db: AsyncSession, user_id: str) -> set[str]:
    """A quien no se puede ver ni por quien se puede ser visto.

    El corte es SIMETRICO, igual que en el resto de Z: cortar un solo sentido
    dejaria que a quien te bloqueo le siga apareciendo tu chat, o al reves.
    """
    filas = (
        await db.execute(
            select(UserBlock.blocker_id, UserBlock.blocked_id).where(
                or_(UserBlock.blocker_id == user_id, UserBlock.blocked_id == user_id)
            )
        )
    ).all()
    salida: set[str] = set()
    for blocker, blocked in filas:
        salida.add(blocked if blocker == user_id else blocker)
    return salida


async def _puede_gestionar(
    db: AsyncSession, uid: str | None, sesion: LiveSession
) -> bool:
    if uid is None:
        return False
    if sesion.host_id == uid:
        return True
    return await is_admin(db, uid)


async def _sesion_visible(
    db: AsyncSession, session_id: str, uid: str | None
) -> LiveSession:
    """La emision, si esta persona tiene algo que hacer con ella.

    Una emision CANCELADA solo la ve quien la creo: para el resto esa emision
    nunca ocurrio, y ensenarla haria pensar que se perdieron algo.
    """
    ensure_uuid(session_id, "Transmisión no encontrada.")
    sesion = await db.get(LiveSession, session_id)
    if sesion is None:
        raise NotFoundError("Transmisión no encontrada.")
    if sesion.status == "cancelled" and not await _puede_gestionar(db, uid, sesion):
        raise NotFoundError("Transmisión no encontrada.")
    return sesion


async def _totales(db: AsyncSession, session_ids: list[str]) -> dict[str, dict[str, int]]:
    """Los contadores de reaccion de varias emisiones, en UNA consulta.

    Los tipos que nadie ha pulsado salen a CERO y no ausentes: un hueco se lee
    como «esto no se mide», que es otra cosa muy distinta de «nadie lo pulso».
    """
    base = {sid: {tipo: 0 for tipo in REACCIONES} for sid in session_ids}
    if not session_ids:
        return base
    filas = (
        await db.execute(
            select(
                LiveReactionTotal.session_id,
                LiveReactionTotal.kind,
                LiveReactionTotal.total,
            ).where(LiveReactionTotal.session_id.in_(session_ids))
        )
    ).all()
    for session_id, kind, total in filas:
        if session_id in base and kind in base[session_id]:
            base[session_id][kind] = int(total or 0)
    return base


async def _leer(
    db: AsyncSession, sesiones: list[LiveSession], uid: str | None
) -> list[LiveSessionRead]:
    """Las emisiones con su anfitrion y sus contadores. Consultas constantes."""
    if not sesiones:
        return []
    ids = [s.id for s in sesiones]
    anfitriones = {
        p.id: p
        for p in (
            await db.scalars(
                select(Profile).where(Profile.id.in_([s.host_id for s in sesiones]))
            )
        ).all()
    }
    totales = await _totales(db, ids)
    admin = bool(uid) and await is_admin(db, uid)

    hay_proveedor = providers.hay_proveedor_real()
    salida: list[LiveSessionRead] = []
    for sesion in sesiones:
        anfitrion = anfitriones.get(sesion.host_id)
        salida.append(
            LiveSessionRead(
                id=sesion.id,
                host_id=sesion.host_id,
                host_name=anfitrion.full_name if anfitrion else "",
                host_username=anfitrion.username if anfitrion else None,
                host_avatar_path=anfitrion.avatar_path if anfitrion else None,
                title=sesion.title,
                description=sesion.description,
                status=sesion.status,
                scheduled_for=sesion.scheduled_for,
                started_at=sesion.started_at,
                ended_at=sesion.ended_at,
                provider=sesion.provider,
                # La verdad sobre si hoy se puede ver algo. Sin esto la
                # aplicacion dejaria un reproductor girando para siempre
                # esperando una imagen que no va a llegar.
                playback_available=hay_proveedor
                and sesion.provider != "none"
                and bool(sesion.provider_room_id),
                recording_path=sesion.recording_path,
                viewer_peak=sesion.viewer_peak,
                reactions=totales.get(sesion.id, {}),
                can_manage=bool(uid) and (admin or sesion.host_id == uid),
            )
        )
    return salida


# --------------------------------------------------------------------------- #
# La sala
# --------------------------------------------------------------------------- #
@router.get("/sessions", response_model=list[LiveSessionRead])
async def listar(
    include_ended: bool = Query(default=False),
    limit: int = Query(default=20, ge=1, le=50),
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> list[LiveSessionRead]:
    """Que hay emitiendo ahora, y que hay anunciado.

    Una lista VACIA no es un error: es que nadie esta emitiendo. Es la
    respuesta correcta y la pantalla la cuenta tal cual, sin rellenar con nada.

    Sin la migracion 0029 devuelve vacio en vez de fallar, por la misma razon:
    no hay emisiones, y eso es exactamente lo que significa la lista vacia.
    """
    if not await esquema.hay_directos(db):
        return []

    uid = current_user.id if current_user else None
    estados = ["live", "scheduled"] + (["ended"] if include_ended else [])

    consulta = select(LiveSession).where(LiveSession.status.in_(estados))
    if uid:
        bloqueados = await _bloqueados(db, uid)
        if bloqueados:
            consulta = consulta.where(LiveSession.host_id.not_in(list(bloqueados)))

    # Primero lo que esta emitiendo AHORA. Una emision en curso es informacion
    # perecedera —termina— y una anunciada para el jueves puede esperar.
    filas = list(
        await db.scalars(
            consulta.order_by(
                (LiveSession.status == "live").desc(),
                LiveSession.started_at.desc().nulls_last(),
                LiveSession.scheduled_for.asc().nulls_last(),
            ).limit(limit)
        )
    )
    return await _leer(db, filas, uid)


@router.post(
    "/sessions", response_model=LiveSessionRead, status_code=status.HTTP_201_CREATED
)
async def crear(
    payload: LiveSessionCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LiveSessionRead:
    """Anuncia una emision, o la empieza directamente.

    Sin `scheduled_for` nace ya EMITIENDO: es el camino frecuente —alguien
    pulsa «emitir» y emite— y obligar a programar antes seria un paso de mas
    para el caso normal.

    Si hay proveedor se abre la sala; si no, la emision existe igual y su chat
    funciona. Que no haya imagen no puede impedir que la sala exista: es lo que
    permite tener esto montado y probado ANTES de pagar un proveedor.
    """
    await _exigir_esquema(db)

    programada = payload.scheduled_for is not None
    sesion = LiveSession(
        host_id=current_user.id,
        title=payload.title.strip(),
        description=payload.description.strip(),
        status="scheduled" if programada else "live",
        scheduled_for=payload.scheduled_for,
        started_at=None if programada else _ahora(),
    )
    db.add(sesion)
    await db.flush()

    if not programada:
        await _abrir_sala(sesion)

    await db.commit()
    await db.refresh(sesion)
    return (await _leer(db, [sesion], current_user.id))[0]


async def _abrir_sala(sesion: LiveSession) -> None:
    """Pide la sala al proveedor, si lo hay.

    Un fallo del proveedor NO impide emitir: la sala queda sin imagen y se dice
    (`playback_available: false`). Dejar la emision a medio crear por un error
    de red de un tercero seria trasladar su problema a quien iba a emitir.
    """
    # El proveedor ACTIVO, no uno buscado por nombre: quien abre una sala
    # todavia no sabe como se llama el que va a servirla.
    proveedor = providers.proveedor_activo()
    if proveedor is None:
        return
    try:
        sala = await proveedor.abrir_sala(session_id=sesion.id, titulo=sesion.title)
        sesion.provider = proveedor.nombre
        sesion.provider_room_id = sala.room_id
    except NotImplementedError:
        # No hay proveedor de verdad. Es el estado normal hoy.
        return


@router.get("/sessions/{session_id}", response_model=LiveSessionRead)
async def detalle(
    session_id: str,
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> LiveSessionRead:
    await _exigir_esquema(db)
    uid = current_user.id if current_user else None
    sesion = await _sesion_visible(db, session_id, uid)
    return (await _leer(db, [sesion], uid))[0]


@router.patch("/sessions/{session_id}", response_model=LiveSessionRead)
async def editar(
    session_id: str,
    payload: LiveSessionUpdate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LiveSessionRead:
    await _exigir_esquema(db)
    sesion = await _sesion_visible(db, session_id, current_user.id)
    if not await _puede_gestionar(db, current_user.id, sesion):
        raise ForbiddenError("No puedes editar esta transmisión.")
    for campo, valor in payload.model_dump(exclude_unset=True).items():
        setattr(sesion, campo, valor)
    await db.commit()
    await db.refresh(sesion)
    return (await _leer(db, [sesion], current_user.id))[0]


@router.post("/sessions/{session_id}/start", response_model=LiveSessionRead)
async def empezar(
    session_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LiveSessionRead:
    """Pasa una emision anunciada a EMITIENDO.

    Solo desde `scheduled`. Volver a empezar algo terminado tendria que ser una
    emision nueva: si se reutilizara la misma, su chat mezclaria dos
    conversaciones de dos dias distintos como si fueran una.
    """
    await _exigir_esquema(db)
    sesion = await _sesion_visible(db, session_id, current_user.id)
    if not await _puede_gestionar(db, current_user.id, sesion):
        raise ForbiddenError("No puedes iniciar esta transmisión.")
    if sesion.status == "live":
        # Idempotente: pulsar dos veces «emitir» no puede ser un error.
        return (await _leer(db, [sesion], current_user.id))[0]
    if sesion.status != "scheduled":
        raise ConflictError(
            "Esta transmisión ya terminó. Crea una nueva.",
            code="live_already_finished",
        )

    sesion.status = "live"
    sesion.started_at = _ahora()
    await _abrir_sala(sesion)
    await db.commit()
    await db.refresh(sesion)
    return (await _leer(db, [sesion], current_user.id))[0]


@router.post("/sessions/{session_id}/end", response_model=LiveSessionRead)
async def terminar(
    session_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LiveSessionRead:
    """Termina la emision.

    TERMINAR NO PUEDE FALLAR POR CULPA DEL PROVEEDOR. Se le pide cerrar la sala,
    pero si no responde se marca igualmente como terminada: si un error de red
    de un tercero impidiera cerrar, la emision se quedaria «en directo» para
    siempre en la pantalla de todo el mundo.
    """
    await _exigir_esquema(db)
    sesion = await _sesion_visible(db, session_id, current_user.id)
    if not await _puede_gestionar(db, current_user.id, sesion):
        raise ForbiddenError("No puedes terminar esta transmisión.")
    if sesion.status == "ended":
        return (await _leer(db, [sesion], current_user.id))[0]

    proveedor = providers.obtener_proveedor(sesion.provider)
    if proveedor is not None and sesion.provider_room_id:
        try:
            await proveedor.cerrar_sala(room_id=sesion.provider_room_id)
        except Exception:  # pragma: no cover - defensa, no logica
            # Deliberadamente ancho: cerrar la sala del proveedor es limpieza,
            # y no puede impedir que la emision conste como terminada.
            pass

    sesion.status = "ended"
    sesion.ended_at = _ahora()
    await db.commit()
    await db.refresh(sesion)
    return (await _leer(db, [sesion], current_user.id))[0]


@router.post("/sessions/{session_id}/cancel", response_model=LiveSessionRead)
async def cancelar(
    session_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LiveSessionRead:
    """Cancela una emision ANUNCIADA que no llego a ocurrir.

    Es distinto de terminar, y la diferencia importa: `ended` dice «esto
    ocurrio y ya paso», `cancelled` dice «esto no llego a ocurrir». Meterlas en
    el mismo estado haria que quien no pudo verla creyera que se la perdio.
    """
    await _exigir_esquema(db)
    sesion = await _sesion_visible(db, session_id, current_user.id)
    if not await _puede_gestionar(db, current_user.id, sesion):
        raise ForbiddenError("No puedes cancelar esta transmisión.")
    if sesion.status != "scheduled":
        raise ConflictError(
            "Solo se puede cancelar una transmisión que aún no ha empezado.",
            code="live_not_cancellable",
        )
    sesion.status = "cancelled"
    await db.commit()
    await db.refresh(sesion)
    return (await _leer(db, [sesion], current_user.id))[0]


@router.post("/sessions/{session_id}/viewers", response_model=LiveSessionRead)
async def informar_espectadores(
    session_id: str,
    count: int = Query(ge=0, le=1_000_000),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LiveSessionRead:
    """Guarda el PICO de espectadores.

    Lo informa quien EMITE y solo quien emite: es el unico que sabe cuanta
    gente hay en su sala (se lo dice el proveedor), y dejar que lo informe
    cualquiera convertiria el numero en lo que quisiera escribir el ultimo.

    Se guarda el maximo, nunca el ultimo: el instantaneo deja de significar
    nada en cuanto la emision termina.
    """
    await _exigir_esquema(db)
    sesion = await _sesion_visible(db, session_id, current_user.id)
    if sesion.host_id != current_user.id:
        raise ForbiddenError("Solo quien emite informa de su audiencia.")
    if count > sesion.viewer_peak:
        sesion.viewer_peak = count
        await db.commit()
        await db.refresh(sesion)
    return (await _leer(db, [sesion], current_user.id))[0]


# --------------------------------------------------------------------------- #
# El chat
# --------------------------------------------------------------------------- #
@router.get("/sessions/{session_id}/messages", response_model=list[LiveMessageRead])
async def historial(
    session_id: str,
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> list[LiveMessageRead]:
    """Los ultimos mensajes, para quien entra a mitad de emision.

    A partir de aqui los nuevos llegan solos por Realtime; esto es solo el
    arranque. Sin el, entrar a una emision seria entrar a una sala en silencio
    donde aparentemente nadie habla.
    """
    if not await esquema.hay_directos(db):
        return []
    uid = current_user.id if current_user else None
    sesion = await _sesion_visible(db, session_id, uid)

    consulta = select(LiveMessage).where(LiveMessage.session_id == sesion.id)

    # Lo escondido no se entrega, salvo a quien lo escribio —para que no le
    # desaparezca sin explicacion— y a quien modera.
    if not await _puede_gestionar(db, uid, sesion):
        if uid:
            consulta = consulta.where(
                or_(LiveMessage.hidden_at.is_(None), LiveMessage.user_id == uid)
            )
        else:
            consulta = consulta.where(LiveMessage.hidden_at.is_(None))

    if uid:
        bloqueados = await _bloqueados(db, uid)
        if bloqueados:
            consulta = consulta.where(LiveMessage.user_id.not_in(list(bloqueados)))

    filas = list(
        await db.scalars(consulta.order_by(LiveMessage.created_at.desc()).limit(HISTORIAL))
    )
    filas.reverse()  # se leen en el orden en que se dijeron

    # Sin mensajes no se pregunta por ningun autor. El `or [""]` que habia aqui
    # mandaba la cadena vacia a una columna `uuid`: en SQLite colaba, y en
    # PostgreSQL asyncpg la rechaza y el manejador de errores lo convertia en
    # un 404. Es decir, el historial de una emision recien empezada —o de una
    # donde todo lo escrito quedo filtrado por bloqueos— respondia «no
    # encontrado» en vez de una lista vacia.
    autores: dict[str, Profile] = {}
    if filas:
        autores = {
            p.id: p
            for p in (
                await db.scalars(
                    select(Profile).where(
                        Profile.id.in_({m.user_id for m in filas})
                    )
                )
            ).all()
        }
    return [
        LiveMessageRead(
            id=m.id,
            session_id=m.session_id,
            user_id=m.user_id,
            user_name=autores[m.user_id].full_name if m.user_id in autores else "",
            user_avatar_path=(
                autores[m.user_id].avatar_path if m.user_id in autores else None
            ),
            body=m.body,
            created_at=m.created_at,
            hidden=m.hidden_at is not None,
        )
        for m in filas
    ]


@router.post(
    "/sessions/{session_id}/messages",
    response_model=LiveMessageRead,
    status_code=status.HTTP_201_CREATED,
)
async def escribir(
    session_id: str,
    payload: LiveMessageCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LiveMessageRead:
    """Escribe en el chat de una emision EN CURSO.

    El limite de ritmo esta aqui, en el servidor (ver `limites.py`): el chat de
    un directo es el sitio de Z donde mas barato sale hacer ruido, y un limite
    solo en el boton no es un limite.
    """
    await _exigir_esquema(db)
    sesion = await _sesion_visible(db, session_id, current_user.id)

    if sesion.status != "live":
        raise ConflictError(
            "El chat solo está abierto mientras la transmisión está en directo.",
            code="live_chat_closed",
        )

    # Nadie escribe en la sala de quien le bloqueo, ni en la de alguien a quien
    # bloqueo. La RLS lo impone tambien; aqui se responde con un motivo claro
    # en lugar de con un error de base de datos.
    if sesion.host_id != current_user.id:
        if sesion.host_id in await _bloqueados(db, current_user.id):
            raise ForbiddenError("No puedes escribir en esta transmisión.")

    if not limites.chat.permitido(f"{sesion.id}|{current_user.id}"):
        raise ConflictError(
            "Vas demasiado rápido. Espera unos segundos.",
            code="live_chat_rate_limited",
        )

    mensaje = LiveMessage(
        session_id=sesion.id, user_id=current_user.id, body=payload.body
    )
    db.add(mensaje)
    await db.commit()
    await db.refresh(mensaje)

    perfil = await db.get(Profile, current_user.id)
    return LiveMessageRead(
        id=mensaje.id,
        session_id=mensaje.session_id,
        user_id=mensaje.user_id,
        user_name=perfil.full_name if perfil else "",
        user_avatar_path=perfil.avatar_path if perfil else None,
        body=mensaje.body,
        created_at=mensaje.created_at,
        hidden=False,
    )


@router.post("/messages/{message_id}/hide", response_model=LiveMessageRead)
async def esconder(
    message_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LiveMessageRead:
    """Esconde un mensaje. Lo hace quien emite, en su sala, o la administracion.

    Se esconde y no se borra: borrar deja al moderador sin poder explicar por
    que lo hizo, y a quien lo escribio sin saber que paso con su mensaje.
    """
    await _exigir_esquema(db)
    ensure_uuid(message_id, "Mensaje no encontrado.")
    mensaje = await db.get(LiveMessage, message_id)
    if mensaje is None:
        raise NotFoundError("Mensaje no encontrado.")
    sesion = await db.get(LiveSession, mensaje.session_id)
    if sesion is None:
        raise NotFoundError("Mensaje no encontrado.")
    if not await _puede_gestionar(db, current_user.id, sesion):
        raise ForbiddenError("No puedes moderar esta transmisión.")

    mensaje.hidden_at = _ahora()
    mensaje.hidden_by = current_user.id
    await db.commit()
    await db.refresh(mensaje)

    perfil = await db.get(Profile, mensaje.user_id)
    return LiveMessageRead(
        id=mensaje.id,
        session_id=mensaje.session_id,
        user_id=mensaje.user_id,
        user_name=perfil.full_name if perfil else "",
        user_avatar_path=perfil.avatar_path if perfil else None,
        body=mensaje.body,
        created_at=mensaje.created_at,
        hidden=True,
    )


# --------------------------------------------------------------------------- #
# Las reacciones
# --------------------------------------------------------------------------- #
@router.post("/sessions/{session_id}/reactions", response_model=ReactionTotals)
async def sumar_reacciones(
    session_id: str,
    payload: ReactionFlush,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ReactionTotals:
    """Suma al contador las reacciones acumuladas del cliente.

    ESTO NO ES UNA REACCION: es el resumen de las que se pulsaron desde el
    ultimo envio. Los corazones que flotan por la pantalla ya viajaron por
    Realtime Broadcast entre los clientes y no tocaron la base. Aqui solo se
    actualiza el numero que sobrevive a la emision.

    POR QUE SE ACOTA. El cliente cuenta, asi que el cliente puede mentir. Sin
    tope, «he pulsado el corazon» y «he pulsado el corazon nueve millones de
    veces» serian la misma peticion y el contador dejaria de significar nada.
    Se RECORTA en vez de rechazarse: quien pulso ciento noventa y manda
    doscientas diez no esta atacando nada.
    """
    await _exigir_esquema(db)
    sesion = await _sesion_visible(db, session_id, current_user.id)
    if sesion.status != "live":
        raise ConflictError(
            "Solo se puede reaccionar mientras la transmisión está en directo.",
            code="live_reactions_closed",
        )
    if not limites.reacciones.permitido(f"{sesion.id}|{current_user.id}"):
        raise ConflictError(
            "Vas demasiado rápido. Espera unos segundos.",
            code="live_reactions_rate_limited",
        )

    for tipo, cuantas in limites.acotar_envio(payload.counts).items():
        # UPDATE primero y INSERT si no habia fila: es lo que permite que dos
        # personas sumando a la vez no se pisen. Hacerlo leyendo el total,
        # sumando en Python y escribiendo perderia reacciones en cuanto
        # coincidan dos envios, que en un directo es constantemente.
        resultado = await db.execute(
            update(LiveReactionTotal)
            .where(
                LiveReactionTotal.session_id == sesion.id,
                LiveReactionTotal.kind == tipo,
            )
            .values(
                total=LiveReactionTotal.total + cuantas,
                updated_at=_ahora(),
            )
        )
        if resultado.rowcount == 0:
            await db.execute(
                insert(LiveReactionTotal).values(
                    session_id=sesion.id, kind=tipo, total=cuantas
                )
            )
    await db.commit()

    totales = await _totales(db, [sesion.id])
    return ReactionTotals(session_id=sesion.id, totals=totales[sesion.id])


# --------------------------------------------------------------------------- #
# El proveedor
# --------------------------------------------------------------------------- #
@router.post("/sessions/{session_id}/credential", response_model=LiveCredential)
async def credencial(
    session_id: str,
    current_user: AuthUser = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
    db: AsyncSession = Depends(get_db),
) -> LiveCredential:
    """El permiso para entrar en la sala del proveedor.

    SE EMITE AQUI, SIEMPRE. La clave secreta del proveedor no puede vivir en la
    aplicacion: un `.apk` se abre con un editor de texto. Y aunque no se
    pudiera, el permiso de EMITIR depende de quien pregunta, y eso solo lo sabe
    con certeza quien verifico el token de sesion.

    Quien emite recibe permiso de publicacion; todos los demas, de visionado.
    Deducirlo en el cliente seria dejar que cualquier espectador se pusiera a
    emitir en la sala de otra persona.
    """
    await _exigir_esquema(db)

    # EL LIMITE VA ANTES DE MIRAR NADA. Firmar cuesta y consultar tambien, y lo
    # que se protege es justo el bucle que pide credenciales sin parar. Una
    # reconexion legitima cabe de sobra dentro de la ventana.
    if not limites.credenciales.permitido(f"{current_user.id}|{session_id}"):
        raise ConflictError(
            "Demasiadas peticiones seguidas. Espera unos segundos.",
            code="live_credential_rate_limited",
        )

    sesion = await _sesion_visible(db, session_id, current_user.id)

    # UNA EMISION CERRADA NO REPARTE PERMISOS. Ni de emitir ni de ver: la sala
    # del proveedor ya no existe y el token solo serviria para que el SDK diera
    # vueltas contra una puerta cerrada.
    if sesion.status in ("ended", "cancelled"):
        raise ConflictError("Esta transmisión ya terminó.", code="live_not_joinable")

    if not providers.hay_proveedor_real() or not sesion.provider_room_id:
        raise ServiceUnavailableError(
            "Todavía no hay proveedor de vídeo configurado.",
            code="live_provider_not_configured",
        )

    proveedor = providers.obtener_proveedor(sesion.provider)
    if proveedor is None:
        raise ServiceUnavailableError(
            "El proveedor de esta transmisión ya no está disponible.",
            code="live_provider_missing",
        )

    # EL ROL LO DECIDE EL SERVIDOR. No llega en la peticion, no se deduce en la
    # pantalla y no se hereda de ser administracion: hay que preguntarlo.
    rol = roles.resolver(
        user_id=current_user.id,
        host_id=sesion.host_id,
        es_admin=await is_admin(db, current_user.id),
    )
    try:
        credencial = await proveedor.credencial(
            room_id=sesion.provider_room_id,
            user_id=current_user.id,
            puede_emitir=roles.puede_publicar(rol),
            rol=roles.nombre_en_el_proveedor(rol),
        )
    except NotImplementedError:
        raise ServiceUnavailableError(
            "Todavía no hay proveedor de vídeo configurado.",
            code="live_provider_not_configured",
        ) from None
    except ErrorDe100ms as error:
        codigo, mensaje = traducir_error(error)
        raise ServiceUnavailableError(mensaje, code=codigo) from None

    logger.info(
        "[live] credencial emitida sesion=%s usuario=%s rol=%s",
        sesion.id,
        current_user.id,
        rol.value,
    )
    return LiveCredential(
        provider=proveedor.nombre,
        token=credencial.token,
        url=credencial.url,
        expires_in=credencial.expira_en,
        can_publish=credencial.puede_emitir,
        role=credencial.rol,
        room_id=credencial.room_id,
    )


# --------------------------------------------------------------------------- #
# Avisos del proveedor
# --------------------------------------------------------------------------- #
#
# QUE PUEDE Y QUE NO PUEDE HACER UN AVISO. Puede CONFIRMAR lo que Z ya sabia:
# que una sala se cerro, que una sesion fallo. No puede crear una emision, ni
# cambiarle el dueño, ni marcar como viva una que nadie inicio desde aqui. 100ms
# sirve el video; quien manda sobre el producto es Z.
#
# SE RESPONDE 204 CASI SIEMPRE, a proposito. Un error hace que el proveedor
# reintente en bucle, y hay avisos que nunca van a cuadrar —una sala de otro
# entorno, una emision borrada— y reintentarlos no arregla nada. Lo unico que se
# rechaza es una autorizacion que no cuadra: eso si hay que verlo.

#: Avisos ya procesados, para no repetir efectos.
#:
#: EN MEMORIA, con la misma limitacion que el limitador de ritmo y por el mismo
#: motivo: con dos trabajadores, cada uno lleva su lista. Es aceptable porque la
#: proteccion de verdad NO es esta lista sino que el efecto sea idempotente —el
#: UPDATE es condicional, asi que aplicarlo dos veces no cambia nada la
#: segunda—. Esta lista solo evita el trabajo repetido y el ruido en el registro.
#:
#: Un deduplicado persistente exigiria una tabla nueva, o sea una migracion, y
#: eso esta pendiente de autorizacion (ver `docs/Z_DIRECTOS_100MS.md`).
_VISTOS: dict[str, None] = {}
_MAXIMO_VISTOS = 2048


def _evento_ya_visto(event_id: str) -> bool:
    if not event_id:
        return False
    if event_id in _VISTOS:
        return True
    if len(_VISTOS) >= _MAXIMO_VISTOS:
        _VISTOS.pop(next(iter(_VISTOS)), None)
    _VISTOS[event_id] = None
    return False


@router.post("/webhook/100ms", status_code=status.HTTP_204_NO_CONTENT)
async def webhook_100ms(
    request: Request,
    settings: Settings = Depends(get_settings),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """Recibe los avisos de 100ms."""
    # EL CUERPO CRUDO PRIMERO, y sin tocarlo. Aunque hoy la comprobacion sea de
    # cabecera, el orden importa: el dia que haya firma, parsear antes de
    # verificar es exactamente como se cuela un cuerpo modificado.
    crudo = await request.body()
    try:
        webhooks.verificar(
            cabeceras=dict(request.headers), secreto=settings.hms_webhook_secret
        )
    except webhooks.WebhookInvalido:
        # No se detalla el motivo: ayudaria a quien este probando a acertar.
        logger.warning("[live] aviso de 100ms rechazado")
        raise ForbiddenError("Aviso no válido.") from None

    try:
        cuerpo = json.loads(crudo or b"{}")
    except ValueError:
        logger.warning("[live] aviso de 100ms con cuerpo ilegible")
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    if not isinstance(cuerpo, dict):
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    proveedor = providers.obtener_proveedor("100ms")
    if proveedor is None:
        # Llega un aviso y el proveedor no esta registrado: la configuracion
        # cambio bajo los pies. Se anota y se acepta para que no reintente.
        logger.error("[live] aviso de 100ms sin el proveedor registrado")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    evento = proveedor.interpretar_evento(cuerpo)
    if evento is None:
        # No nos incumbe. Ignorar no es fallar.
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    if _evento_ya_visto(evento.event_id):
        logger.info("[live] aviso repetido %s; no se repite el efecto", evento.event_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    await _aplicar_evento_de_directo(db, evento)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _aplicar_evento_de_directo(db: AsyncSession, evento) -> None:
    """El efecto, y solo sobre una emision que ya existe.

    TODO CON UPDATE CONDICIONAL. Un aviso tardio, uno desordenado o uno repetido
    afectan a cero filas y no cambian nada: la idempotencia esta en la sentencia,
    no en haber recordado que ya lo vimos.
    """
    if not evento.session_id:
        logger.warning("[live] aviso %s sin emision atribuible", evento.tipo)
        return

    sesion = await db.get(LiveSession, evento.session_id)
    if sesion is None or sesion.provider != "100ms":
        # De otro entorno, de otra cuenta, o de una emision borrada.
        logger.warning("[live] aviso %s de una emision desconocida", evento.tipo)
        return

    if evento.significado in ("sesion_cerrada", "sala_cerrada"):
        # SOLO desde `live`. Una emision programada que nunca empezo no se
        # termina porque el proveedor cierre una sala vacia.
        resultado = await db.execute(
            update(LiveSession)
            .where(LiveSession.id == sesion.id, LiveSession.status == "live")
            .values(status="ended", ended_at=_ahora(), updated_at=_ahora())
        )
        await db.commit()
        if resultado.rowcount:
            logger.info("[live] emision %s cerrada por aviso del proveedor", sesion.id)
        return

    if evento.significado == "fallo":
        # NO se cierra la emision. Un fallo del proveedor puede ser pasajero y
        # el anfitrion puede estar reconectando; cerrarla le quitaria la sala
        # debajo. Se deja constancia y lo resuelve la conciliacion o el propio
        # anfitrion al terminar.
        logger.error(
            "[live] el proveedor informa de un fallo en la emision %s (%s)",
            sesion.id,
            evento.tipo,
        )
        return

    # `sesion_abierta`, `participante_entro` y `participante_salio` se registran
    # y no mueven nada: quien decide que una emision esta viva es quien pulso
    # «empezar» en Z, no el proveedor.
    logger.info("[live] aviso %s en la emision %s", evento.tipo, sesion.id)
