"""Como se entra a un grupo: su tarjeta, su enlace y las solicitudes.

LO QUE SE PIDIO (10/10/2026). Que quien administra un grupo pueda compartir su
enlace, que en su perfil pueda aparecer «Unete a mi grupo», y que quien quiera
entrar lo PIDA: a quien administra le llega el aviso «X quiere unirse a tu
grupo» y decide. Ademas, que el grupo tenga foto.

NADIE ENTRA SOLO. Ni el enlace ni el perfil añaden a nadie: crean una
SOLICITUD, y solo quien administra la convierte en un miembro. Un enlace que
metiera directamente seria una puerta abierta para cualquiera a quien se lo
reenvien, y saltaria la unica regla que tienen los grupos: que alguien
responde de quien entra.

QUE SE ENSEÑA A QUIEN NO ES MIEMBRO: la TARJETA. Nombre, foto, cuantos son y
quien lo administra. Nunca un mensaje, ni la lista de miembros. Y solo de los
grupos que su administrador decidio enseñar (en su perfil) o cuyo enlace esta
activo y se conoce.

LOS BLOQUEOS CUENTAN, Y NO SE DICE. Con un bloqueo entre quien mira y quien
administra, el grupo «no existe»: ni tarjeta ni solicitud, con el mismo 404
que un enlace inventado. Decir «no puedes» seria contarle a alguien que lo
bloquearon.

LOS TOPES. Una sola solicitud viva por persona y grupo (lo impone la base),
un tope de solicitudes por persona y hora, y un dia de espera tras un rechazo.
Sin eso, «pedir entrar» seria la forma de hacer sonar el telefono de alguien
tantas veces como se quiera.

SIN LA MIGRACION 0104 nada de esto existe: las tarjetas salen vacias y las
escrituras responden 503. Los grupos siguen funcionando igual que antes.
"""

from __future__ import annotations

import logging
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationAppError,
)
from app.core.security import AuthUser, get_current_user
from app.modules.content.schemas import AuthorSummary
from app.modules.messaging import ajustes_de_grupo, avisos, esquema, grupos
from app.modules.messaging.ajustes_de_grupo import AjustesLeidos
from app.modules.messaging.models import (
    Conversation,
    ConversationMember,
    GroupJoinRequest,
    GroupSettings,
)
from app.modules.notifications.push import encolar_push
from app.modules.profiles.models import Profile
from app.modules.social_graph.models import UserBlock
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid

logger = logging.getLogger(__name__)

router = APIRouter(tags=["messaging"])

#: Cuantos grupos de una persona se enseñan en su perfil, como mucho.
MAX_GRUPOS_EN_PERFIL = 20
#: Cuantas solicitudes puede mandar una persona en una hora, a cualquier grupo.
SOLICITUDES_POR_HORA = 20
#: Cuanto hay que esperar para volver a pedirlo tras un rechazo.
ESPERA_TRAS_RECHAZO = timedelta(hours=24)

_CODIGO = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
_NO_ESTA = "Grupo no encontrado."


# --------------------------------------------------------------------------- #
# Esquemas
# --------------------------------------------------------------------------- #
class TarjetaDeGrupo(BaseModel):
    """Lo que ve de un grupo quien todavia no esta dentro."""

    id: str
    title: str
    avatar_path: str | None = None
    members_count: int = 0
    admin: AuthorSummary
    #: `member`: ya esta dentro. `pending`: pidio entrar y espera respuesta.
    my_status: Literal["member", "pending", "none"] = "none"
    is_full: bool = False


class SolicitudNueva(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: El codigo del enlace, cuando se llega por el. Sin el, solo se puede
    #: pedir entrar a un grupo que su administrador enseña en su perfil.
    code: str | None = Field(default=None, max_length=64)


class SolicitudLeida(BaseModel):
    id: str
    status: str


class SolicitudPendiente(BaseModel):
    id: str
    user: AuthorSummary
    source: str
    created_at: datetime | None = None


class AjustesCambiados(BaseModel):
    """Lo que se quiera cambiar. Lo que no viene, no se toca."""

    model_config = ConfigDict(extra="forbid")

    listed_on_profile: bool | None = None
    invite_enabled: bool | None = None


class FotoNueva(BaseModel):
    model_config = ConfigDict(extra="forbid")

    avatar_path: str = Field(min_length=1, max_length=512)

    @field_validator("avatar_path")
    @classmethod
    def _sin_trampas(cls, v: str) -> str:
        if ".." in v or v.startswith("/") or "\\" in v:
            raise ValueError("La ruta de la foto no es válida.")
        return v


# --------------------------------------------------------------------------- #
# Reglas
# --------------------------------------------------------------------------- #
async def _exigir_puertas(db: AsyncSession) -> None:
    if not await esquema.hay_puertas_de_grupo(db):
        raise ServiceUnavailableError(
            "La foto, el enlace y las solicitudes de grupo todavía no están disponibles.",
            code="group_extras_not_available",
        )


async def _hay_bloqueo(db: AsyncSession, uno: str, otro: str) -> bool:
    """Si alguno de los dos bloqueo al otro. Consigo mismo, nunca."""
    if str(uno) == str(otro):
        return False
    fila = (
        await db.execute(
            select(UserBlock.blocker_id)
            .where(
                or_(
                    (UserBlock.blocker_id == uno) & (UserBlock.blocked_id == otro),
                    (UserBlock.blocker_id == otro) & (UserBlock.blocked_id == uno),
                )
            )
            .limit(1)
        )
    ).first()
    return fila is not None


async def _tarjetas(db: AsyncSession, filas, uid: str) -> list[TarjetaDeGrupo]:
    """Las tarjetas de VARIOS grupos, con un numero de consultas CONSTANTE.

    `filas` trae `id`, `title`, `created_by` y `avatar_path`. Cuantos son, quien
    administra, si quien mira ya esta dentro y si tiene una solicitud viva se
    resuelven con un `IN` sobre los identificadores: cuatro consultas, sean dos
    grupos o veinte.
    """
    if not filas:
        return []
    ids = [fila.id for fila in filas]

    cuantos = dict(
        (
            await db.execute(
                select(ConversationMember.conversation_id, func.count())
                .where(ConversationMember.conversation_id.in_(ids))
                .group_by(ConversationMember.conversation_id)
            )
        ).all()
    )
    dentro = set(
        (
            await db.execute(
                select(ConversationMember.conversation_id).where(
                    ConversationMember.conversation_id.in_(ids),
                    ConversationMember.user_id == uid,
                )
            )
        ).scalars()
    )
    esperando = set(
        (
            await db.execute(
                select(GroupJoinRequest.conversation_id).where(
                    GroupJoinRequest.conversation_id.in_(ids),
                    GroupJoinRequest.user_id == uid,
                    GroupJoinRequest.status == "pending",
                )
            )
        ).scalars()
    )
    creadores = {str(fila.created_by) for fila in filas}
    perfiles = {
        str(p.id): p
        for p in (
            await db.execute(
                select(
                    Profile.id, Profile.full_name, Profile.username, Profile.avatar_path
                ).where(Profile.id.in_(creadores))
            )
        ).all()
    }

    salida: list[TarjetaDeGrupo] = []
    for fila in filas:
        admin = perfiles.get(str(fila.created_by))
        if admin is None:
            continue
        miembros = int(cuantos.get(fila.id, 0))
        salida.append(
            TarjetaDeGrupo(
                id=fila.id,
                title=(fila.title or "").strip(),
                avatar_path=fila.avatar_path,
                members_count=miembros,
                admin=AuthorSummary(
                    id=admin.id,
                    full_name=admin.full_name or "",
                    username=admin.username,
                    avatar_path=admin.avatar_path,
                ),
                my_status=(
                    "member"
                    if fila.id in dentro
                    else "pending"
                    if fila.id in esperando
                    else "none"
                ),
                is_full=miembros >= grupos.MAX_MIEMBROS,
            )
        )
    return salida


_COLUMNAS_DE_TARJETA = (
    Conversation.id,
    Conversation.title,
    Conversation.created_by,
    GroupSettings.avatar_path,
)


# --------------------------------------------------------------------------- #
# Tarjetas: lo que ve quien no esta dentro
# --------------------------------------------------------------------------- #
@router.get("/groups/of/{user_id}", response_model=list[TarjetaDeGrupo])
async def grupos_de_un_perfil(
    user_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[TarjetaDeGrupo]:
    """«Unete a mi grupo»: los grupos que esta persona enseña en su perfil.

    Solo los que ADMINISTRA y marco para enseñar. Con un bloqueo entre los dos,
    o sin la 0104, la lista sale vacia: el perfil no pinta la seccion.
    """
    ensure_uuid(user_id, "Perfil no encontrado.")
    if not await esquema.hay_puertas_de_grupo(db):
        return []
    if await _hay_bloqueo(db, current_user.id, user_id):
        return []
    filas = (
        await db.execute(
            select(*_COLUMNAS_DE_TARJETA)
            .join(GroupSettings, GroupSettings.conversation_id == Conversation.id)
            .where(
                Conversation.kind == "group",
                Conversation.created_by == user_id,
                GroupSettings.listed_on_profile.is_(True),
            )
            .order_by(Conversation.created_at.desc(), Conversation.id.desc())
            .limit(MAX_GRUPOS_EN_PERFIL)
        )
    ).all()
    return await _tarjetas(db, filas, current_user.id)


@router.get("/groups/invite/{code}", response_model=TarjetaDeGrupo)
async def grupo_de_un_enlace(
    code: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TarjetaDeGrupo:
    """La tarjeta del grupo al que lleva un enlace. 404 si el enlace no vale.

    Un enlace desactivado, uno cambiado, uno inventado y el de un grupo cuyo
    administrador tiene un bloqueo con quien mira responden LO MISMO.
    """
    if not _CODIGO.match(code) or not await esquema.hay_puertas_de_grupo(db):
        raise NotFoundError(_NO_ESTA, code="group_not_found")
    fila = (
        await db.execute(
            select(*_COLUMNAS_DE_TARJETA)
            .join(GroupSettings, GroupSettings.conversation_id == Conversation.id)
            .where(
                Conversation.kind == "group",
                GroupSettings.invite_code == code,
                GroupSettings.invite_enabled.is_(True),
            )
        )
    ).one_or_none()
    if fila is None or await _hay_bloqueo(db, current_user.id, fila.created_by):
        raise NotFoundError(_NO_ESTA, code="group_not_found")
    tarjetas = await _tarjetas(db, [fila], current_user.id)
    if not tarjetas:
        raise NotFoundError(_NO_ESTA, code="group_not_found")
    return tarjetas[0]


# --------------------------------------------------------------------------- #
# Pedir entrar
# --------------------------------------------------------------------------- #
@router.post(
    "/{conversation_id}/join-requests",
    response_model=SolicitudLeida,
    status_code=status.HTTP_201_CREATED,
)
async def pedir_entrar(
    conversation_id: str,
    payload: SolicitudNueva,
    background: BackgroundTasks,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SolicitudLeida:
    """Pide entrar a un grupo. NO entra: deja la solicitud y avisa a quien administra.

    Solo vale para un grupo que se enseña en el perfil de su administrador, o
    con el codigo de su enlace activo. Con cualquier otro —aunque exista y se
    conozca su identificador— responde el mismo 404 que si no existiera.

    ES IDEMPOTENTE mientras la solicitud siga viva: pedirlo otra vez devuelve
    la misma, sin avisar de nuevo.
    """
    uid = current_user.id
    ensure_uuid(conversation_id, _NO_ESTA)
    await _exigir_puertas(db)

    fila = (
        await db.execute(
            select(
                Conversation.kind,
                Conversation.created_by,
                Conversation.title,
                GroupSettings.listed_on_profile,
                GroupSettings.invite_code,
                GroupSettings.invite_enabled,
            )
            .outerjoin(GroupSettings, GroupSettings.conversation_id == Conversation.id)
            .where(Conversation.id == conversation_id)
        )
    ).one_or_none()
    if fila is None or fila.kind != "group":
        raise NotFoundError(_NO_ESTA, code="group_not_found")

    por_enlace = bool(
        payload.code
        and fila.invite_enabled
        and fila.invite_code
        # Comparacion de tiempo constante: el codigo es un secreto compartido.
        and secrets.compare_digest(payload.code, fila.invite_code)
    )
    if not (por_enlace or fila.listed_on_profile):
        raise NotFoundError(_NO_ESTA, code="group_not_found")
    if await _hay_bloqueo(db, uid, fila.created_by):
        raise NotFoundError(_NO_ESTA, code="group_not_found")

    miembros = set(
        (
            await db.execute(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == conversation_id
                )
            )
        ).scalars()
    )
    if uid in miembros:
        raise ConflictError("Ya estás en este grupo.", code="already_member")
    if len(miembros) >= grupos.MAX_MIEMBROS:
        raise ConflictError("El grupo está completo.", code="group_is_full")

    previas = (
        await db.execute(
            select(
                GroupJoinRequest.id, GroupJoinRequest.status, GroupJoinRequest.resolved_at
            )
            .where(
                GroupJoinRequest.conversation_id == conversation_id,
                GroupJoinRequest.user_id == uid,
            )
            .order_by(GroupJoinRequest.created_at.desc(), GroupJoinRequest.id.desc())
            .limit(1)
        )
    ).one_or_none()
    ahora = datetime.now(timezone.utc)
    if previas is not None:
        if previas.status == "pending":
            return SolicitudLeida(id=previas.id, status="pending")
        resuelta = previas.resolved_at
        if resuelta is not None and resuelta.tzinfo is None:
            resuelta = resuelta.replace(tzinfo=timezone.utc)
        if (
            previas.status == "rejected"
            and resuelta is not None
            and ahora - resuelta < ESPERA_TRAS_RECHAZO
        ):
            raise ConflictError(
                "Ya pediste entrar a este grupo hace poco. Inténtalo más adelante.",
                code="join_request_too_soon",
            )

    recientes = await db.scalar(
        select(func.count())
        .select_from(GroupJoinRequest)
        .where(
            GroupJoinRequest.user_id == uid,
            GroupJoinRequest.created_at >= ahora - timedelta(hours=1),
        )
    )
    if (recientes or 0) >= SOLICITUDES_POR_HORA:
        raise ConflictError(
            "Enviaste muchas solicitudes seguidas. Inténtalo más tarde.",
            code="join_rate_limited",
        )

    solicitud = GroupJoinRequest(
        conversation_id=conversation_id,
        # La identidad sale del JWT. Nunca de la peticion.
        user_id=uid,
        source="link" if por_enlace else "profile",
    )
    db.add(solicitud)
    try:
        await db.commit()
    except IntegrityError:
        # Dos toques a la vez: el indice unico deja una, y se devuelve esa.
        await db.rollback()
        viva = (
            await db.execute(
                select(GroupJoinRequest.id).where(
                    GroupJoinRequest.conversation_id == conversation_id,
                    GroupJoinRequest.user_id == uid,
                    GroupJoinRequest.status == "pending",
                )
            )
        ).scalar_one_or_none()
        if viva is None:
            raise ConflictError(
                "No se pudo enviar la solicitud. Inténtalo de nuevo.",
                code="join_request_race",
            ) from None
        return SolicitudLeida(id=viva, status="pending")

    # «Ana quiere unirse a tu grupo «Aula»». La solicitud YA esta guardada: si
    # el aviso falla, quien administra la vera igual al abrir el grupo.
    try:
        encolar_push(
            background,
            user_ids=[str(fila.created_by)],
            notification_type=avisos.TIPO_AL_PEDIR_ENTRAR,
            actor_name=await grupos.nombre_de(db, uid),
            data={"type": avisos.DESTINO_DE_SOLICITUD, "conversationId": conversation_id},
            grupo=fila.title or "",
        )
    except Exception:  # noqa: BLE001 - el aviso nunca tumba la solicitud
        logger.warning("[grupos] no se pudo avisar de la solicitud", exc_info=True)

    return SolicitudLeida(id=solicitud.id, status="pending")


@router.delete(
    "/{conversation_id}/join-requests/mine", status_code=status.HTTP_204_NO_CONTENT
)
async def retirar_mi_solicitud(
    conversation_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Retira la solicitud propia que siga viva. Sin ella, no hace nada."""
    ensure_uuid(conversation_id, _NO_ESTA)
    if not await esquema.hay_puertas_de_grupo(db):
        return
    await db.execute(
        update(GroupJoinRequest)
        .where(
            GroupJoinRequest.conversation_id == conversation_id,
            GroupJoinRequest.user_id == current_user.id,
            GroupJoinRequest.status == "pending",
        )
        .values(status="cancelled", resolved_at=func.now())
    )
    await db.commit()


# --------------------------------------------------------------------------- #
# Responder: solo quien administra
# --------------------------------------------------------------------------- #
@router.get(
    "/{conversation_id}/join-requests", response_model=list[SolicitudPendiente]
)
async def solicitudes_pendientes(
    conversation_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[SolicitudPendiente]:
    """Quien espera respuesta, por orden de llegada. No sale quien ya esta dentro."""
    await grupos.exigir_grupo_administrado(db, conversation_id, current_user.id)
    if not await esquema.hay_puertas_de_grupo(db):
        return []
    ya_dentro = (
        select(ConversationMember.user_id)
        .where(
            ConversationMember.conversation_id == conversation_id,
            ConversationMember.user_id == GroupJoinRequest.user_id,
        )
        .correlate(GroupJoinRequest)
        .exists()
    )
    filas = (
        await db.execute(
            select(
                GroupJoinRequest.id,
                GroupJoinRequest.source,
                GroupJoinRequest.created_at,
                Profile.id.label("perfil"),
                Profile.full_name,
                Profile.username,
                Profile.avatar_path,
            )
            .join(Profile, Profile.id == GroupJoinRequest.user_id)
            .where(
                GroupJoinRequest.conversation_id == conversation_id,
                GroupJoinRequest.status == "pending",
                ~ya_dentro,
            )
            .order_by(GroupJoinRequest.created_at.asc(), GroupJoinRequest.id.asc())
            .limit(grupos.MAX_MIEMBROS)
        )
    ).all()
    return [
        SolicitudPendiente(
            id=fila.id,
            user=AuthorSummary(
                id=fila.perfil,
                full_name=fila.full_name or "",
                username=fila.username,
                avatar_path=fila.avatar_path,
            ),
            source=fila.source,
            created_at=fila.created_at,
        )
        for fila in filas
    ]


async def _solicitud_viva(
    db: AsyncSession, conversation_id: str, request_id: str
) -> GroupJoinRequest:
    ensure_uuid(request_id, "Solicitud no encontrada.")
    fila = (
        await db.execute(
            select(GroupJoinRequest).where(
                GroupJoinRequest.id == request_id,
                # En el WHERE: la solicitud de otro grupo no se alcanza.
                GroupJoinRequest.conversation_id == conversation_id,
                GroupJoinRequest.status == "pending",
            )
        )
    ).scalar_one_or_none()
    if fila is None:
        raise NotFoundError("Solicitud no encontrada.", code="join_request_not_found")
    return fila


@router.post(
    "/{conversation_id}/join-requests/{request_id}/approve",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def aceptar_solicitud(
    conversation_id: str,
    request_id: str,
    background: BackgroundTasks,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Acepta la solicitud: la persona pasa a ser miembro y se le avisa.

    Valen las mismas reglas que al añadir a mano: el tope del grupo y los
    bloqueos. Si entre que lo pidio y que se responde aparecio un bloqueo, no
    entra.
    """
    uid = current_user.id
    await grupos.exigir_grupo_administrado(db, conversation_id, uid)
    await _exigir_puertas(db)
    solicitud = await _solicitud_viva(db, conversation_id, request_id)
    persona = str(solicitud.user_id)

    miembros = set(
        (
            await db.execute(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == conversation_id
                )
            )
        ).scalars()
    )
    entra = persona not in miembros
    if entra:
        if len(miembros) >= grupos.MAX_MIEMBROS:
            raise ConflictError("El grupo está completo.", code="group_is_full")
        await grupos.exigir_que_se_puedan_anadir(db, uid, [persona])
        db.add(ConversationMember(conversation_id=conversation_id, user_id=persona))

    solicitud.status = "approved"
    solicitud.resolved_at = datetime.now(timezone.utc)
    solicitud.resolved_by = uid
    try:
        await db.commit()
    except IntegrityError:
        # Se le añadio a mano en el mismo instante: ya esta dentro.
        await db.rollback()
        await db.execute(
            update(GroupJoinRequest)
            .where(GroupJoinRequest.id == request_id, GroupJoinRequest.status == "pending")
            .values(status="approved", resolved_at=func.now(), resolved_by=uid)
        )
        await db.commit()
        entra = False

    if entra:
        titulo = await db.scalar(
            select(Conversation.title).where(Conversation.id == conversation_id)
        )
        await grupos.avisar_de_que_los_anadieron(
            db,
            background,
            conversation_id=conversation_id,
            quien=uid,
            a_quienes=[persona],
            titulo=titulo or "",
        )


@router.post(
    "/{conversation_id}/join-requests/{request_id}/reject",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def rechazar_solicitud(
    conversation_id: str,
    request_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Rechaza la solicitud. SIN AVISO a quien la mando: un «no» no se anuncia."""
    await grupos.exigir_grupo_administrado(db, conversation_id, current_user.id)
    await _exigir_puertas(db)
    solicitud = await _solicitud_viva(db, conversation_id, request_id)
    solicitud.status = "rejected"
    solicitud.resolved_at = datetime.now(timezone.utc)
    solicitud.resolved_by = current_user.id
    await db.commit()


# --------------------------------------------------------------------------- #
# Ajustes del grupo: solo quien administra
# --------------------------------------------------------------------------- #
@router.patch("/{conversation_id}/group/settings", response_model=AjustesLeidos)
async def cambiar_ajustes(
    conversation_id: str,
    payload: AjustesCambiados,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AjustesLeidos:
    """Enseñar o no el grupo en el perfil, y activar o no su enlace.

    Activar el enlace por primera vez le crea su codigo. Desactivarlo NO lo
    borra: al volver a activarlo es el mismo enlace, y para cambiarlo esta
    `…/invite/rotate`.
    """
    await grupos.exigir_grupo_administrado(db, conversation_id, current_user.id)
    await _exigir_puertas(db)
    fila = await ajustes_de_grupo.asegurar_fila(db, conversation_id)

    if payload.listed_on_profile is not None:
        fila.listed_on_profile = payload.listed_on_profile
    if payload.invite_enabled is not None:
        if payload.invite_enabled and not fila.invite_code:
            fila.invite_code = ajustes_de_grupo.codigo_nuevo()
        fila.invite_enabled = payload.invite_enabled
    fila.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(fila)
    return ajustes_de_grupo.leer(fila)


@router.post("/{conversation_id}/group/invite/rotate", response_model=AjustesLeidos)
async def cambiar_enlace(
    conversation_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> AjustesLeidos:
    """Cambia el codigo del enlace. El anterior DEJA DE VALER en el acto.

    Es la forma de retirar un enlace que se difundio mas de la cuenta sin
    cerrar la puerta: se comparte el nuevo con quien se quiera.
    """
    await grupos.exigir_grupo_administrado(db, conversation_id, current_user.id)
    await _exigir_puertas(db)
    fila = await ajustes_de_grupo.asegurar_fila(db, conversation_id)
    fila.invite_code = ajustes_de_grupo.codigo_nuevo()
    fila.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(fila)
    return ajustes_de_grupo.leer(fila)


@router.put("/{conversation_id}/group/photo", status_code=status.HTTP_204_NO_CONTENT)
async def poner_foto(
    conversation_id: str,
    payload: FotoNueva,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Pone la foto del grupo. Los bytes ya estan subidos: aqui llega la RUTA.

    LA RUTA TIENE QUE ESTAR EN LA CARPETA DE QUIEN LA PONE (`<su id>/…`), que
    es donde el almacenamiento le deja escribir. Sin esta comprobacion se
    podria poner como foto del grupo el fichero de otra persona.
    """
    await grupos.exigir_grupo_administrado(db, conversation_id, current_user.id)
    await _exigir_puertas(db)
    prefijo = f"{current_user.id}/"
    if not payload.avatar_path.startswith(prefijo) or len(payload.avatar_path) <= len(prefijo):
        raise ValidationAppError(
            "La foto no está en tu carpeta de imágenes.", code="group_photo_path_invalid"
        )
    fila = await ajustes_de_grupo.asegurar_fila(db, conversation_id)
    fila.avatar_path = payload.avatar_path
    fila.updated_at = datetime.now(timezone.utc)
    await db.commit()


@router.delete("/{conversation_id}/group/photo", status_code=status.HTTP_204_NO_CONTENT)
async def quitar_foto(
    conversation_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Quita la foto. El fichero no se borra aqui: lo limpia el almacenamiento."""
    await grupos.exigir_grupo_administrado(db, conversation_id, current_user.id)
    await _exigir_puertas(db)
    fila = await ajustes_de_grupo.fila_de(db, conversation_id)
    if fila is not None and fila.avatar_path is not None:
        fila.avatar_path = None
        fila.updated_at = datetime.now(timezone.utc)
        await db.commit()
