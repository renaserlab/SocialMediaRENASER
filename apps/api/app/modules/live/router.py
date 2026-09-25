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

from datetime import datetime, timedelta, timezone

import json
import logging
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request, Response, status
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
from app.modules.live import avisos, limites, providers, roles, webhooks
from app.modules.live.models import LiveMessage, LiveReactionTotal, LiveSession
from app.modules.live.schemas import (
    REACCIONES,
    LiveAvailability,
    LiveCredential,
    LiveMessageCreate,
    LiveMessageRead,
    LiveSessionCreate,
    LiveSessionRead,
    LiveSessionUpdate,
    ReactionFlush,
    ReactionTotals,
)
from app.modules.notifications.push import encolar_push
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.social_graph.models import Follow, UserBlock
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
@router.get("/availability", response_model=LiveAvailability)
async def disponibilidad() -> LiveAvailability:
    """Si hay proveedor de video real ahora mismo.

    SIN SESION Y SIN BASE. Solo mira que proveedor se registro al arrancar, que
    es lo mismo que decide si `/credential` puede firmar. Asi encender o apagar
    los directos es cambiar la configuracion del servidor y reiniciar, sin
    publicar otra version de la app.
    """
    activo = providers.proveedor_activo()
    return LiveAvailability(
        video=activo is not None,
        provider=activo.nombre if activo is not None else "none",
    )


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


@router.get("/sessions/following", response_model=list[LiveSessionRead])
async def en_vivo_de_quien_sigo(
    limit: int = Query(default=5, ge=1, le=20),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[LiveSessionRead]:
    """Quien de las personas a las que sigo esta emitiendo AHORA.

    Es lo que pregunta la aplicacion al abrirse y al volver del segundo plano
    para ensenar el aviso «Juan está transmitiendo en vivo», como en TikTok
    (ver `avisos.py`). Por eso solo `live`: una emision anunciada no se puede
    ver todavia, y una terminada ya no.

    DECLARADA ANTES de `/sessions/{session_id}`: FastAPI prueba las rutas en
    orden, y al reves «following» se tomaria por el identificador de una
    emision.
    """
    if not await esquema.hay_directos(db):
        return []

    uid = current_user.id
    consulta = select(LiveSession).where(
        LiveSession.status == "live",
        LiveSession.host_id.in_(
            select(Follow.following_id).where(Follow.follower_id == uid)
        ),
    )
    bloqueados = await _bloqueados(db, uid)
    if bloqueados:
        consulta = consulta.where(LiveSession.host_id.not_in(list(bloqueados)))

    candidatas = list(
        await db.scalars(
            consulta.order_by(LiveSession.started_at.desc().nulls_last()).limit(limit)
        )
    )
    # Una emision abandonada (el movil de quien emitia se quedo sin bateria)
    # sigue `live` hasta que alguien la mira: aqui se la mira, y si se paso del
    # tope se cierra en vez de anunciarla.
    vivas = [s for s in candidatas if not await _caducar_si_toca(db, s)]
    return await _leer(db, vivas, uid)


async def _avisar_de_que_empieza(
    db: AsyncSession, background: BackgroundTasks, sesion: LiveSession
) -> None:
    """Aviso en la bandeja de cada seguidor y push, cuando una emision EMPIEZA.

    Va DESPUES de guardar la emision y de construir la respuesta: los avisos
    hacen su propio commit (o rollback) y no pueden tocar ni lo guardado ni lo
    que se devuelve. Las reglas —cada cuanto, a quien, que pasa si falla— estan
    en `avisos.py`.
    """
    destinatarios = await avisos.avisar_a_seguidores(db, sesion=sesion)
    if not destinatarios:
        return
    anfitrion = await db.get(Profile, sesion.host_id)
    encolar_push(
        background,
        user_ids=destinatarios,
        notification_type=avisos.TIPO,
        actor_name=anfitrion.full_name if anfitrion else None,
        data={"type": avisos.TIPO, "liveId": sesion.id},
    )


@router.post(
    "/sessions", response_model=LiveSessionRead, status_code=status.HTTP_201_CREATED
)
async def crear(
    payload: LiveSessionCreate,
    background: BackgroundTasks,
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
    if not programada:
        # El mismo techo que `/start`. Antes solo lo miraba empezar una
        # programada, y el camino frecuente —pulsar «emitir» y nacer ya en
        # directo, que es el de «Vivo» en la app— se lo saltaba entero.
        await _exigir_hueco_para_emitir(db)
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
    respuesta = (await _leer(db, [sesion], current_user.id))[0]
    # Nace emitiendo: se avisa a quien sigue a esta persona. Una programada no
    # avisa aqui, sino al empezar (ver `empezar`).
    if not programada:
        await _avisar_de_que_empieza(db, background, sesion)
    return respuesta


async def _caducar_si_toca(db: AsyncSession, sesion: LiveSession) -> bool:
    """Cierra una emision que lleva emitiendo mas de lo permitido.

    POR QUE HACE FALTA. El movil del anfitrion se queda sin bateria en mitad de
    una emision. El proveedor manda `session.failure`, que a proposito NO cierra
    nada —puede estar reconectando—, y nadie pulsa «terminar». La emision se
    queda `live` para siempre y la sala del proveedor, habilitada y facturando.

    SE COMPRUEBA AL MIRARLA, no con una tarea programada. El proyecto no tiene
    ninguna, y montar un planificador entero por esto seria pagar una
    infraestructura por un problema que se resuelve aqui: cualquiera que abra la
    ficha o pida credencial la cierra. Una emision que nadie mira nunca no
    cuesta nada tenerla abierta en nuestra base; lo que cuesta es la sala, y esa
    se cierra en cuanto alguien pasa.
    """
    ajustes = get_settings()
    tope = ajustes.live_max_duration_minutes
    if tope <= 0 or sesion.status != "live" or sesion.started_at is None:
        return False

    empezo = sesion.started_at
    if empezo.tzinfo is None:
        empezo = empezo.replace(tzinfo=timezone.utc)
    if _ahora() - empezo < timedelta(minutes=tope):
        return False

    logger.warning(
        "[live] la emision %s supero el tope de %s minutos; se cierra",
        sesion.id,
        tope,
    )
    proveedor = providers.obtener_proveedor(sesion.provider)
    if proveedor is not None and sesion.provider_room_id:
        try:
            await proveedor.cerrar_sala(room_id=sesion.provider_room_id)
        except Exception:  # pragma: no cover - limpieza, no logica
            pass
    return await _mover_estado(db, sesion, desde="live", hasta="ended", ended=True)


async def _emisiones_vivas(db: AsyncSession) -> int:
    return int(
        await db.scalar(
            select(func.count(LiveSession.id)).where(LiveSession.status == "live")
        )
        or 0
    )


async def _exigir_hueco_para_emitir(db: AsyncSession) -> None:
    """EL TECHO DE EMISIONES SIMULTANEAS, antes de que nazca una mas en directo.

    Cada sala viva cuesta minutos de proveedor, asi que un fallo o un abuso no
    puede traducirse en una factura. Se cuenta despues de caducar las que se
    pasaron de tiempo: una emision abandonada no puede bloquear a las demas
    para siempre.
    """
    ajustes = get_settings()
    if ajustes.live_max_concurrent <= 0:
        return
    vivas = await db.scalars(select(LiveSession).where(LiveSession.status == "live"))
    for otra in vivas.all():
        await _caducar_si_toca(db, otra)
    if await _emisiones_vivas(db) >= ajustes.live_max_concurrent:
        raise ConflictError(
            "Hay demasiadas transmisiones en directo ahora mismo. "
            "Inténtalo en unos minutos.",
            code="live_too_many_concurrent",
        )


async def _mover_estado(
    db: AsyncSession,
    sesion: LiveSession,
    *,
    desde: str,
    hasta: str,
    started: bool = False,
    ended: bool = False,
) -> bool:
    """Cambia el estado SOLO si sigue siendo el que leimos. Hace commit.

    UPDATE CONDICIONAL, y no leer-modificar-escribir. Antes los tres cambios que
    dispara el cliente —empezar, terminar, cancelar— asignaban el atributo y
    comiteaban, asi que dos peticiones simultaneas se pisaban: el anfitrion pulsa
    «empezar» y administracion «cancelar» en el mismo instante, los dos leen
    `scheduled`, empezar abre la sala en el proveedor y escribe `live`, cancelar
    escribe `cancelled` encima. La fila queda cancelada CON sala abierta, y
    cancelar no cierra ninguna: una sala facturando que ya no aparece para nadie.

    Comparar y escribir en la MISMA sentencia no deja hueco por el que colarse.
    """
    valores: dict[str, object] = {"status": hasta, "updated_at": _ahora()}
    if started:
        valores["started_at"] = _ahora()
    if ended:
        valores["ended_at"] = _ahora()
    resultado = await db.execute(
        update(LiveSession)
        .where(LiveSession.id == sesion.id, LiveSession.status == desde)
        .values(**valores)
    )
    await db.commit()
    await db.refresh(sesion)
    return resultado.rowcount > 0


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
    except providers.ErrorDeProveedor as error:
        # LO QUE EL DOCSTRING PROMETE Y NO CUMPLIA. Solo se recogia
        # `NotImplementedError`, asi que un 429 de cuota o un tiempo de espera
        # agotado subian hasta `crear` y devolvian un 500: la emision no llegaba
        # a existir, ni siquiera con chat.
        #
        # Y en el caso peor —el proveedor SI creo la sala pero no nos llego la
        # respuesta— el rollback dejaba una sala huerfana con el nombre de una
        # emision que ya no existe, que nadie volveria a consultar ni cerrar. Es
        # la unica forma de que quede una sala facturando sin dueño.
        #
        # La sala se recupera sola en el siguiente intento: `abrir_sala` es
        # idempotente por nombre, asi que empezar de nuevo la encuentra.
        logger.error(
            "[live] no se pudo abrir la sala de %s (%s); la emision sigue sin video",
            sesion.id,
            error.codigo,
        )
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
    background: BackgroundTasks,
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

    await _exigir_hueco_para_emitir(db)

    # LA SALA PRIMERO. Si se abriera despues del cambio de estado, una emision
    # podria quedar `live` sin sala y con el proveedor no notandolo.
    await _abrir_sala(sesion)
    if not await _mover_estado(
        db, sesion, desde="scheduled", hasta="live", started=True
    ):
        raise ConflictError(
            "Esta transmisión ya cambió de estado.", code="live_state_changed"
        )
    respuesta = (await _leer(db, [sesion], current_user.id))[0]
    # Solo quien de verdad la paso a emitir llega aqui (el UPDATE condicional
    # de arriba): dos «empezar» a la vez no avisan dos veces.
    await _avisar_de_que_empieza(db, background, sesion)
    return respuesta


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
    if sesion.status != "live":
        # SOLO SE TERMINA LO QUE ESTABA EMITIENDO. Antes se aceptaba desde
        # cualquier estado, asi que una emision CANCELADA —«esto no llego a
        # ocurrir»— se podia marcar como terminada desde una pestaña vieja y
        # reaparecia en el listado publico como un directo que nunca existio.
        raise ConflictError(
            "Esta transmisión no está en directo.", code="live_not_live"
        )

    proveedor = providers.obtener_proveedor(sesion.provider)
    if proveedor is not None and sesion.provider_room_id:
        try:
            await proveedor.cerrar_sala(room_id=sesion.provider_room_id)
        except Exception:  # pragma: no cover - defensa, no logica
            # Deliberadamente ancho: cerrar la sala del proveedor es limpieza,
            # y no puede impedir que la emision conste como terminada.
            pass

    if not await _mover_estado(db, sesion, desde="live", hasta="ended", ended=True):
        # Otro la movio entre que la leimos y ahora: administracion cancelando a
        # la vez, o el aviso del proveedor. Gana quien llego antes.
        await db.refresh(sesion)
        raise ConflictError(
            "Esta transmisión ya cambió de estado.", code="live_state_changed"
        )
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
    if not await _mover_estado(db, sesion, desde="scheduled", hasta="cancelled"):
        raise ConflictError(
            "Esta transmisión ya cambió de estado.", code="live_state_changed"
        )
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

    # Si se paso de tiempo, se cierra ANTES de repartir nada: pedir credencial
    # es el momento en que mas gente pasa por aqui.
    await _caducar_si_toca(db, sesion)

    # UNA EMISION CERRADA NO REPARTE PERMISOS. Ni de emitir ni de ver: la sala
    # del proveedor ya no existe y el token solo serviria para que el SDK diera
    # vueltas contra una puerta cerrada.
    if sesion.status in ("ended", "cancelled"):
        raise ConflictError("Esta transmisión ya terminó.", code="live_not_joinable")

    # UNA EMISION EN DIRECTO SIN SALA SE REPARA AQUI. `_abrir_sala` no deja que
    # un fallo del proveedor impida emitir, y promete que la sala «se recupera
    # sola en el siguiente intento»; pero una emision que nacio en directo no
    # vuelve a pasar por `/start`, asi que ese intento no llegaba nunca y la
    # credencial contestaba 503 para siempre. Pedir credencial es justo el
    # momento: el anfitrion y el publico pasan por aqui al abrir la pantalla.
    if (
        sesion.status == "live"
        and not sesion.provider_room_id
        and providers.hay_proveedor_real()
    ):
        await _abrir_sala(sesion)
        if sesion.provider_room_id:
            await db.commit()
            await db.refresh(sesion)

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

    # EL ROL LO DECIDE EL SERVIDOR. No llega en la peticion y no se deduce en la
    # pantalla: se resuelve aqui, con lo que el servidor sabe de quien pregunta.
    #
    # ADMINISTRACION ENTRA COMO MODERADORA EN CUALQUIER SALA, y por tanto puede
    # publicar. Es coherente con el resto del modulo —`_puede_gestionar` ya deja
    # a administracion esconder mensajes y cerrar cualquier emision— pero hay
    # que decirlo: hoy no existe un permiso de moderacion de directos separado
    # del rol general. El dia que lo haya, se cambia el argumento de aqui y
    # `roles.resolver` no se entera.
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
    except providers.ErrorDeProveedor as error:
        # El error se recoge por el tipo del CONTRATO y lo traduce el propio
        # proveedor: asi el router no sabe cual es ni que codigos usa.
        codigo, mensaje = proveedor.traducir_error(error)
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

#: Lo mas grande que puede ser un aviso. Los de 100ms son unos pocos kilobytes;
#: 256 KB deja margen de sobra y no permite que alguien sin sesion nos haga
#: reservar memoria a voluntad.
MAXIMO_DEL_AVISO = 256 * 1024


def _evento_ya_visto(event_id: str) -> bool:
    """Solo CONSULTA. Apuntar es otra cosa y va despues de aplicar."""
    return bool(event_id) and event_id in _VISTOS


def _apuntar_evento(event_id: str) -> None:
    if not event_id:
        return
    if len(_VISTOS) >= _MAXIMO_VISTOS:
        _VISTOS.pop(next(iter(_VISTOS)), None)
    _VISTOS[event_id] = None


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
    # EL TAMAÑO PRIMERO. Es el unico POST del modulo alcanzable sin sesion, y
    # sin esto `request.body()` bufferiza en memoria lo que le manden —medio
    # giga— antes de llegar a rechazarlo por autorizacion.
    declarado = request.headers.get("content-length")
    if declarado and declarado.isdigit() and int(declarado) > MAXIMO_DEL_AVISO:
        logger.warning("[live] aviso de 100ms descartado por tamaño")
        raise ForbiddenError("Aviso no válido.")

    crudo = await request.body()
    if len(crudo) > MAXIMO_DEL_AVISO:
        # Sin `Content-Length` fiable: se corta igual al leerlo.
        logger.warning("[live] aviso de 100ms descartado por tamaño")
        raise ForbiddenError("Aviso no válido.")
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

    # SE APLICA Y DESPUES SE APUNTA. Al reves, un fallo al aplicarlo —la base
    # saturada en un pico— dejaba el aviso marcado como visto: el reintento del
    # proveedor se descartaba por repetido y el efecto se perdia para siempre.
    # La emision se quedaba «en directo» con la sala abierta y facturando.
    await _aplicar_evento_de_directo(db, evento)
    _apuntar_evento(evento.event_id)
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

    # SE VALIDA EL FORMATO ANTES DE TOCAR LA BASE. `session_id` sale del cuerpo
    # del aviso y la columna es `uuid`: una sala creada a mano desde el panel
    # —el paso 3 del plan de activacion— llega con un nombre cualquiera, y en
    # PostgreSQL eso es un error de tipo que acaba en 404 en vez del 204 que
    # este endpoint debe dar para que el proveedor no reintente en bucle. En
    # SQLite no se reproduce, asi que las pruebas no lo verian.
    try:
        UUID(evento.session_id)
    except (ValueError, AttributeError, TypeError):
        logger.warning("[live] aviso %s con una sala que no es nuestra", evento.tipo)
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
