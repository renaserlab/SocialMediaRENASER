"""Como se entra a un grupo: su tarjeta, su enlace y las solicitudes.

LO QUE SE PIDIO (10/10/2026). Que quien administra un grupo pueda compartir su
enlace, que en su perfil pueda aparecer «Unete a mi grupo», y que quien quiera
entrar lo PIDA: a quien administra le llega el aviso «X quiere unirse a tu
grupo» y decide. Ademas, que el grupo tenga foto.

NADIE ENTRA SOLO. Ni el enlace ni el perfil añaden a nadie: crean una
SOLICITUD, y solo quien administra la convierte en un miembro. Un enlace que
metiera directamente seria una puerta abierta para cualquiera a quien se lo
reenvien, y saltaria la unica regla que tienen los grupos: que alguien
responde de quien entra. La excepcion es la que decide quien administra al
ABRIR su comunidad (0112, ver abajo): esa puerta abierta la eligio el.

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

LAS COMUNIDADES DE UN GRUPO (26/10/2026, `subgrupos.py`). A una comunidad
`request` se entra pidiendolo por aqui, como a cualquier grupo, pero lo que da
derecho a pedirlo es SER DEL GRUPO PADRE: una comunidad no tiene enlace ni sale
en ningun perfil (sus ajustes responden 409 `not_a_top_level_group`). El chat
de un tema no admite solicitudes: sus miembros son los del grupo.

COMUNIDADES ABIERTAS Y PERFIL POR PERSONA (30/10/2026, migracion 0112,
`docs/CONTRATOS_COMUNIDADES_EN_EL_PERFIL.md`). Desde aqui la aplicacion llama
COMUNIDAD al chat de grupo de primer nivel y GRUPO a los de dentro (los
`subgroups`); en el codigo y en las rutas los nombres no cambian. Lo nuevo:

  · Quien administra una comunidad elige como se entra (`entrada`): `request`,
    que es lo de siempre y lo que tienen todas las que ya existian, u `open`.
    A una ABIERTA si se entra solo, de un toque (`POST /{id}/join`), desde su
    perfil o desde su enlace: quien la abrio decidio de antemano que no hace
    falta que nadie responda de quien entra. Las demas reglas siguen igual:
    los bloqueos, el tope de miembros, la espera tras un rechazo y el tope de
    intentos por hora. Y SOLO a la comunidad (General y sus temas), nunca a sus
    grupos de dentro: a esos cada uno entra despues, como hasta ahora.
  · `POST /{id}/join-requests` a una abierta mete directamente y responde
    `status = "approved"`. Es lo que hace que una version de la aplicacion
    que no conoce `join`, o el enlace, entren igual en una abierta.
  · Salir en el perfil es de CADA PERSONA (`GroupProfileListing`): el perfil
    lee esas filas, y solo las de comunidades que esa persona administra.

SIN LA MIGRACION 0112 todo responde como antes de ella: cada comunidad es «con
solicitud», el perfil sale de `listed_on_profile` y solo cambiar como se entra
responde 503 `group_extras_not_available` (`esquema.hay_comunidades_en_el_perfil`,
una vez por proceso).
"""

from __future__ import annotations

import logging
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Body, Depends, status
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
    GroupProfileListing,
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
    """Lo que ve de una comunidad quien todavia no esta dentro.

    Los tres ultimos campos son de la 0112. Al final y con valor por defecto:
    una aplicacion que no los conoce los ignora y la tarjeta le sigue
    sirviendo igual.
    """

    id: str
    title: str
    avatar_path: str | None = None
    members_count: int = 0
    admin: AuthorSummary
    #: `member`: ya esta dentro. `pending`: pidio entrar y espera respuesta.
    my_status: Literal["member", "pending", "none"] = "none"
    is_full: bool = False
    #: Como se entra: `open`, de un toque (`POST /{id}/join`); `request`,
    #: pidiendolo. Sin ajustes guardados, `request`, que es lo de siempre.
    entrada: Literal["open", "request"] = "request"
    #: Cuantos grupos VIVOS hay dentro (los `subgroups`). Solo el numero: de
    #: cuales son no se dice nada a quien no esta dentro.
    groups_count: int = 0
    #: Cuantos temas VIVOS tiene.
    topics_count: int = 0


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

    #: Desde la 0112, «en MI perfil»: el de quien hace el cambio.
    listed_on_profile: bool | None = None
    invite_enabled: bool | None = None
    #: Como se entra (0112). Opcional: las aplicaciones de antes no lo mandan.
    entrada: Literal["open", "request"] | None = None


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


async def hay_bloqueo(db: AsyncSession, uno: str, otro: str) -> bool:
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

    `filas` trae `id`, `title`, `created_by`, `avatar_path` y `entrada`
    (`None` sin fila de ajustes). Cuantos son, quien administra, si quien mira
    ya esta dentro, si tiene una solicitud viva y cuantos grupos y temas tiene
    dentro se resuelven con un `IN` sobre los identificadores: seis consultas,
    sean dos grupos o veinte (cuatro sin las tablas de la 0108 y la 0109).
    """
    if not filas:
        return []
    ids = [fila.id for fila in filas]
    grupos_dentro, temas_dentro = await _cuantos_dentro(db, ids)

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
                entrada="open" if fila.entrada == "open" else "request",
                groups_count=grupos_dentro.get(str(fila.id), 0),
                topics_count=temas_dentro.get(str(fila.id), 0),
            )
        )
    return salida


async def _cuantos_dentro(
    db: AsyncSession, ids: list[str]
) -> tuple[dict[str, int], dict[str, int]]:
    """Cuantos grupos de dentro y cuantos temas VIVOS tiene cada comunidad.

    Una consulta para cada cosa, sean cuantas sean las comunidades. Sin la
    0109 o sin la 0108 no hay nada que contar y no se pregunta: nombrar una
    tabla que no existe seria un 500 (`esquema.py`). Los modulos se importan
    aqui dentro porque los dos importan, directa o indirectamente, este.
    """
    grupos_dentro: dict[str, int] = {}
    temas_dentro: dict[str, int] = {}
    if await esquema.hay_comunidades(db):
        from app.modules.messaging.subgrupos import GroupSubgroup

        grupos_dentro = {
            str(padre): int(n or 0)
            for padre, n in (
                await db.execute(
                    select(GroupSubgroup.parent_id, func.count())
                    .where(
                        GroupSubgroup.parent_id.in_(ids),
                        GroupSubgroup.deleted_at.is_(None),
                    )
                    .group_by(GroupSubgroup.parent_id)
                )
            ).all()
        }
    if await esquema.hay_temas(db):
        from app.modules.messaging.temas import ConversationTopic

        temas_dentro = {
            str(grupo): int(n or 0)
            for grupo, n in (
                await db.execute(
                    select(ConversationTopic.conversation_id, func.count())
                    .where(
                        ConversationTopic.conversation_id.in_(ids),
                        ConversationTopic.deleted_at.is_(None),
                    )
                    .group_by(ConversationTopic.conversation_id)
                )
            ).all()
        }
    return grupos_dentro, temas_dentro


async def _columnas_de_tarjeta(db: AsyncSession) -> tuple:
    """Lo que trae cada fila de tarjeta: id, nombre, quien la administra, foto y
    como se entra. Sin la 0112, `entrada` es la constante `'request'`: la
    misma forma de fila, sin nombrar una columna que no existe."""
    return (
        Conversation.id,
        Conversation.title,
        Conversation.created_by,
        GroupSettings.avatar_path,
        ajustes_de_grupo.columna_de_entrada(await esquema.hay_comunidades_en_el_perfil(db)),
    )


async def _tarjeta_de(db: AsyncSession, conversation_id: str, uid: str) -> TarjetaDeGrupo:
    """La tarjeta de UNA comunidad tal como la ve `uid`. 404 si no la hay.

    Sin fila de ajustes tambien hay tarjeta (con `entrada = request`): por eso
    el `outerjoin`.
    """
    fila = (
        await db.execute(
            select(*await _columnas_de_tarjeta(db))
            .outerjoin(GroupSettings, GroupSettings.conversation_id == Conversation.id)
            .where(Conversation.id == conversation_id)
        )
    ).one_or_none()
    tarjetas = await _tarjetas(db, [fila], uid) if fila is not None else []
    if not tarjetas:
        raise NotFoundError(_NO_ESTA, code="group_not_found")
    return tarjetas[0]


# --------------------------------------------------------------------------- #
# Tarjetas: lo que ve quien no esta dentro
# --------------------------------------------------------------------------- #
@router.get("/groups/of/{user_id}", response_model=list[TarjetaDeGrupo])
async def grupos_de_un_perfil(
    user_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[TarjetaDeGrupo]:
    """Las comunidades que esta persona enseña en SU perfil.

    Desde la 0112 se leen sus filas de `group_profile_listings`, y de ellas
    solo las de comunidades DE PRIMER NIVEL que ADMINISTRA hoy: si deja de
    administrar una, desaparece de su perfil aunque su fila siga ahi, y si la
    conversacion se borra, la fila se va con ella (`on delete cascade`). Hoy
    administrar es haberla creado (`vistas.administra`); la condicion va en la
    consulta y no despues para que el tope cuente solo lo que se enseña.

    SIN LA 0112, LA CONSULTA DE ANTES, tal cual: las que creo y tienen
    `listed_on_profile`. Es lo que la migracion copia a la tabla al pegarse, asi
    que el perfil enseña lo mismo antes y despues.

    Con un bloqueo entre los dos, o sin la 0104, la lista sale vacia: el perfil
    no pinta la seccion. Mismo tope y mismo orden que antes de la 0112.
    """
    ensure_uuid(user_id, "Perfil no encontrado.")
    if not await esquema.hay_puertas_de_grupo(db):
        return []
    if await hay_bloqueo(db, current_user.id, user_id):
        return []
    columnas = await _columnas_de_tarjeta(db)
    if not await esquema.hay_comunidades_en_el_perfil(db):
        consulta = (
            select(*columnas)
            .join(GroupSettings, GroupSettings.conversation_id == Conversation.id)
            .where(
                Conversation.kind == "group",
                Conversation.created_by == user_id,
                GroupSettings.listed_on_profile.is_(True),
            )
        )
    else:
        condiciones = [
            GroupProfileListing.user_id == user_id,
            Conversation.kind == "group",
            Conversation.created_by == user_id,
        ]
        # Un grupo de dentro o el chat de un tema no pueden tener fila (sus
        # ajustes responden 409), pero lo que no puede pasar no se deja en
        # manos de que no pase: la condicion va dentro de la misma consulta y
        # no cuesta otra.
        if await esquema.hay_comunidades(db):
            from app.modules.messaging import subgrupos

            condiciones.append(subgrupos.condicion_no_es_comunidad(Conversation.id))
        if await esquema.hay_temas(db):
            from app.modules.messaging import temas

            condiciones.append(temas.condicion_no_es_chat_de_tema(Conversation.id))
        consulta = (
            select(*columnas)
            .select_from(GroupProfileListing)
            .join(Conversation, Conversation.id == GroupProfileListing.conversation_id)
            .outerjoin(GroupSettings, GroupSettings.conversation_id == Conversation.id)
            .where(*condiciones)
        )
    filas = (
        await db.execute(
            consulta.order_by(Conversation.created_at.desc(), Conversation.id.desc()).limit(
                MAX_GRUPOS_EN_PERFIL
            )
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
            select(*await _columnas_de_tarjeta(db))
            .join(GroupSettings, GroupSettings.conversation_id == Conversation.id)
            .where(
                Conversation.kind == "group",
                GroupSettings.invite_code == code,
                GroupSettings.invite_enabled.is_(True),
            )
        )
    ).one_or_none()
    if fila is None or await hay_bloqueo(db, current_user.id, fila.created_by):
        raise NotFoundError(_NO_ESTA, code="group_not_found")
    tarjetas = await _tarjetas(db, [fila], current_user.id)
    if not tarjetas:
        raise NotFoundError(_NO_ESTA, code="group_not_found")
    return tarjetas[0]


# --------------------------------------------------------------------------- #
# Pedir entrar, y entrar en una abierta
# --------------------------------------------------------------------------- #
async def _la_puerta(db: AsyncSession, conversation_id: str):
    """La conversacion y sus ajustes. 404 si no es algo a lo que se pueda llamar.

    Al chat de un tema no se pide entrar ni se entra: se entra a su comunidad.
    """
    fila = (
        await db.execute(
            select(
                Conversation.kind,
                Conversation.created_by,
                Conversation.title,
                GroupSettings.listed_on_profile,
                GroupSettings.invite_code,
                GroupSettings.invite_enabled,
                ajustes_de_grupo.columna_de_entrada(
                    await esquema.hay_comunidades_en_el_perfil(db)
                ),
            )
            .outerjoin(GroupSettings, GroupSettings.conversation_id == Conversation.id)
            .where(Conversation.id == conversation_id)
        )
    ).one_or_none()
    if fila is None or fila.kind != "group":
        raise NotFoundError(_NO_ESTA, code="group_not_found")
    if await grupos.tema_del_chat(db, conversation_id) is not None:
        raise NotFoundError(_NO_ESTA, code="group_not_found")
    return fila


async def _por_donde_llega(
    db: AsyncSession, conversation_id: str, fila, code: str | None
) -> bool:
    """Si llega por el enlace (`True`) o por un perfil (`False`). 404 si por ninguno.

    Sin enlace, la comunidad tiene que salir en el perfil de quien la
    administra: con la columna de siempre (la que escribe la API anterior) o
    con su fila de la 0112 (sin la 0112 solo cuenta la columna). Las dos se escriben juntas; mirar las dos es lo
    que deja pasar exactamente lo que pasaba antes, y lo que enseña el perfil.
    La segunda solo se pregunta si la primera no basta.
    """
    por_enlace = bool(
        code
        and fila.invite_enabled
        and fila.invite_code
        # Comparacion de tiempo constante: el codigo es un secreto compartido.
        and secrets.compare_digest(code, fila.invite_code)
    )
    if por_enlace or fila.listed_on_profile:
        return por_enlace
    if await ajustes_de_grupo.esta_en_el_perfil(db, conversation_id, fila.created_by):
        return False
    raise NotFoundError(_NO_ESTA, code="group_not_found")


async def _miembros(db: AsyncSession, conversation_id: str) -> set[str]:
    return {
        str(persona)
        for persona in (
            await db.scalars(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == conversation_id
                )
            )
        )
    }


async def _ultima_solicitud(db: AsyncSession, conversation_id: str, uid: str):
    """`(id, status, resolved_at)` de la ultima vez que pidio entrar, o `None`.

    409 `join_request_too_soon` si esa vez se la rechazaron hace menos de
    `ESPERA_TRAS_RECHAZO`: un «no» vale tambien para una comunidad que despues
    se abrio. Si no, cualquiera a quien echaron atras entraria abriendo y
    cerrando la puerta.
    """
    previa = (
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
    if previa is not None and previa.status == "rejected":
        resuelta = previa.resolved_at
        if resuelta is not None and resuelta.tzinfo is None:
            resuelta = resuelta.replace(tzinfo=timezone.utc)
        if resuelta is not None and datetime.now(timezone.utc) - resuelta < ESPERA_TRAS_RECHAZO:
            raise ConflictError(
                "Ya pediste entrar a este grupo hace poco. Inténtalo más adelante.",
                code="join_request_too_soon",
            )
    return previa


async def _exigir_tope_por_hora(db: AsyncSession, uid: str) -> None:
    """Cuenta TODO lo de la ultima hora: solicitudes y entradas directas.

    Entrar en una abierta tambien deja su fila (aprobada), y cuenta: sin eso,
    entrar y salir sin parar seria gratis.
    """
    recientes = await db.scalar(
        select(func.count())
        .select_from(GroupJoinRequest)
        .where(
            GroupJoinRequest.user_id == uid,
            GroupJoinRequest.created_at >= datetime.now(timezone.utc) - timedelta(hours=1),
        )
    )
    if (recientes or 0) >= SOLICITUDES_POR_HORA:
        raise ConflictError(
            "Enviaste muchas solicitudes seguidas. Inténtalo más tarde.",
            code="join_rate_limited",
        )


async def _entrar_en_una_abierta(
    db: AsyncSession,
    conversation_id: str,
    uid: str,
    *,
    por_enlace: bool,
    pendiente: str | None,
) -> str | None:
    """Mete a `uid` en una comunidad ABIERTA. Devuelve el id de la solicitud que lo
    deja escrito, o `None` si otra peticion lo metio en el mismo instante.

    QUEDA ESCRITO COMO UNA SOLICITUD APROBADA, sin `resolved_by` porque no
    decidio nadie: decidio la comunidad al abrirse. Asi el historial dice como
    entro cada uno, `POST /join-requests` tiene un id que devolver y el tope por
    hora lo cuenta. Si tenia una pendiente de cuando la comunidad era con
    solicitud, es ESA la que se aprueba: no se deja colgando en la lista de
    quien administra algo que ya no hay que decidir.

    SOLO LA COMUNIDAD Y SUS TEMAS (D5): los temas son parte de ella y sus
    miembros son los de la comunidad (`grupos.sincronizar_temas`, solo los
    vivos). En sus grupos de dentro no se mete a nadie: cada uno entra despues.

    Todo en una transaccion: o entra en la comunidad, en sus temas y queda
    escrito, o nada.
    """
    ahora = datetime.now(timezone.utc)
    try:
        if pendiente is not None:
            solicitud = pendiente
            await db.execute(
                update(GroupJoinRequest)
                .where(GroupJoinRequest.id == pendiente, GroupJoinRequest.status == "pending")
                .values(status="approved", resolved_at=ahora)
                .execution_options(synchronize_session=False)
            )
        else:
            solicitud = str(uuid4())
            db.add(
                GroupJoinRequest(
                    id=solicitud,
                    conversation_id=conversation_id,
                    # La identidad sale del JWT. Nunca de la peticion.
                    user_id=uid,
                    status="approved",
                    source="link" if por_enlace else "profile",
                    resolved_at=ahora,
                )
            )
        db.add(ConversationMember(conversation_id=conversation_id, user_id=uid))
        await grupos.sincronizar_temas(db, conversation_id, [uid], dentro=True)
        await db.commit()
    except IntegrityError:
        # Dos toques a la vez: la clave primaria de los miembros deja entrar a
        # uno. Ya esta dentro, que es lo que se queria.
        await db.rollback()
        return None
    return solicitud


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

    UNA COMUNIDAD es la excepcion: a ella se llega por ser miembro de su grupo
    padre, sin enlace ni perfil. Quien no es del grupo recibe el mismo 404.
    Se guarda con `source = 'profile'`, el camino «sin enlace»: la 0104 no
    admite otro valor y una comunidad no justifica tocar su `CHECK`.

    ES IDEMPOTENTE mientras la solicitud siga viva: pedirlo otra vez devuelve
    la misma, sin avisar de nuevo.

    EN UNA COMUNIDAD ABIERTA (0112) NO SE PIDE: SE ENTRA, como con
    `POST /{id}/join`, y responde `status = "approved"` con el mismo 201. Es lo
    que hace que una aplicacion que no conoce `join` —la que ya esta en los
    telefonos— entre en una abierta con el boton de siempre: ignora la
    respuesta, vuelve a leer la tarjeta y la ve como miembro. Sin aviso a quien
    administra: no hay nada que decidir (ver `unirse`). Las comunidades de
    dentro de un grupo (`subgroups`) siguen como antes: tienen su propia
    entrada y su propio `…/subgroups/{id}/join`.
    """
    uid = current_user.id
    ensure_uuid(conversation_id, _NO_ESTA)
    await _exigir_puertas(db)
    fila = await _la_puerta(db, conversation_id)

    from app.modules.messaging import subgrupos

    comunidad = await subgrupos.fila_de(db, conversation_id)
    if comunidad is not None:
        if comunidad.deleted_at is not None:
            raise NotFoundError(_NO_ESTA, code="group_not_found")
        del_padre = await db.get(
            ConversationMember,
            {"conversation_id": str(comunidad.parent_id), "user_id": uid},
        )
        if del_padre is None:
            raise NotFoundError(_NO_ESTA, code="group_not_found")
        por_enlace = False
    else:
        por_enlace = await _por_donde_llega(db, conversation_id, fila, payload.code)
    if await hay_bloqueo(db, uid, fila.created_by):
        raise NotFoundError(_NO_ESTA, code="group_not_found")
    abierta = comunidad is None and fila.entrada == "open"

    miembros = await _miembros(db, conversation_id)
    if str(uid) in miembros:
        raise ConflictError("Ya estás en este grupo.", code="already_member")
    if len(miembros) >= grupos.MAX_MIEMBROS:
        raise ConflictError("El grupo está completo.", code="group_is_full")

    previa = await _ultima_solicitud(db, conversation_id, uid)
    pendiente = previa.id if previa is not None and previa.status == "pending" else None
    if pendiente is not None and not abierta:
        return SolicitudLeida(id=pendiente, status="pending")
    if pendiente is None:
        await _exigir_tope_por_hora(db, uid)

    if abierta:
        hecha = await _entrar_en_una_abierta(
            db, conversation_id, uid, por_enlace=por_enlace, pendiente=pendiente
        )
        if hecha is None:
            hecha = await _la_que_lo_metio(db, conversation_id, uid)
        return SolicitudLeida(id=hecha, status="approved")

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

    # «Ana quiere unirse a tu comunidad «Aula»» (o «a tu grupo», si es uno de
    # dentro). La solicitud YA esta guardada: si el aviso falla, quien
    # administra la vera igual al abrir el grupo.
    try:
        encolar_push(
            background,
            user_ids=[str(fila.created_by)],
            notification_type=avisos.TIPO_AL_PEDIR_ENTRAR,
            actor_name=await grupos.nombre_de(db, uid),
            data={"type": avisos.DESTINO_DE_SOLICITUD, "conversationId": conversation_id},
            grupo=fila.title or "",
            nivel="subgrupo" if comunidad is not None else "comunidad",
        )
    except Exception:  # noqa: BLE001 - el aviso nunca tumba la solicitud
        logger.warning("[grupos] no se pudo avisar de la solicitud", exc_info=True)

    return SolicitudLeida(id=solicitud.id, status="pending")


async def _la_que_lo_metio(db: AsyncSession, conversation_id: str, uid: str) -> str:
    """Tras perder la carrera de entrar: la solicitud aprobada de la peticion que gano.

    Si ni esta dentro ni hay una aprobada, no entro nadie (el conflicto era
    otro): 409 `join_request_race`, el mismo que cuando se pierde la de pedir.
    """
    dentro = await db.get(
        ConversationMember, {"conversation_id": conversation_id, "user_id": uid}
    )
    aprobada = await db.scalar(
        select(GroupJoinRequest.id)
        .where(
            GroupJoinRequest.conversation_id == conversation_id,
            GroupJoinRequest.user_id == uid,
            GroupJoinRequest.status == "approved",
        )
        .order_by(GroupJoinRequest.created_at.desc(), GroupJoinRequest.id.desc())
        .limit(1)
    )
    if dentro is None or aprobada is None:
        raise ConflictError(
            "No se pudo entrar. Inténtalo de nuevo.", code="join_request_race"
        )
    return str(aprobada)


@router.post("/{conversation_id}/join", response_model=TarjetaDeGrupo)
async def unirse(
    conversation_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    payload: SolicitudNueva | None = Body(default=None),
) -> TarjetaDeGrupo:
    """Entra de un toque en una comunidad ABIERTA (0112). Devuelve su tarjeta.

    El cuerpo es opcional: `{"code": …}` cuando se llega por el enlace, como en
    `join-requests`. Las mismas puertas y los mismos errores que pedir entrar:
    tiene que salir en el perfil de quien la administra o llegarse con su
    enlace activo; con un bloqueo entre los dos, el mismo 404 que si no
    existiera; 409 `group_is_full`, `join_request_too_soon` y
    `join_rate_limited`. Lo unico propio: con solicitud, 409
    `group_requires_request` (se pide por `join-requests`).

    SOLO UNA COMUNIDAD, es decir, un chat de grupo de primer nivel. Un grupo de
    dentro tiene su propia ruta (`…/subgroups/{id}/join`) y el chat de un tema
    no se toca por separado: 404, sin decir que existen.

    IDEMPOTENTE: quien ya esta dentro recibe 200 con su tarjeta, sin repetir
    nada. Se mira antes que la puerta: quien esta dentro ya sabe que existe, y
    que su comunidad haya dejado de salir en el perfil no lo vuelve un 404.

    SIN AVISO A QUIEN ADMINISTRA, a proposito. Una comunidad abierta es la
    forma de decir «no hace falta que yo responda de quien entra»; un aviso por
    cada entrada seria ruido, y entrar y salir haria sonar su telefono tantas
    veces como se quisiera. Lo ve en la lista de miembros.
    """
    uid = current_user.id
    ensure_uuid(conversation_id, _NO_ESTA)
    await _exigir_puertas(db)
    fila = await _la_puerta(db, conversation_id)

    from app.modules.messaging import subgrupos

    # Cualquier fila de `group_subgroups`, viva o eliminada: tampoco una
    # eliminada es una comunidad (`grupos.exigir_primer_nivel`).
    if await subgrupos.fila_de(db, conversation_id) is not None:
        raise NotFoundError(_NO_ESTA, code="group_not_found")

    miembros = await _miembros(db, conversation_id)
    if str(uid) in miembros:
        return await _tarjeta_de(db, conversation_id, uid)

    por_enlace = await _por_donde_llega(
        db, conversation_id, fila, payload.code if payload is not None else None
    )
    if await hay_bloqueo(db, uid, fila.created_by):
        raise NotFoundError(_NO_ESTA, code="group_not_found")
    if fila.entrada != "open":
        raise ConflictError(
            "Para entrar en esta comunidad hay que pedirlo.",
            code="group_requires_request",
        )
    if len(miembros) >= grupos.MAX_MIEMBROS:
        raise ConflictError("El grupo está completo.", code="group_is_full")

    previa = await _ultima_solicitud(db, conversation_id, uid)
    pendiente = previa.id if previa is not None and previa.status == "pending" else None
    if pendiente is None:
        await _exigir_tope_por_hora(db, uid)

    hecha = await _entrar_en_una_abierta(
        db, conversation_id, uid, por_enlace=por_enlace, pendiente=pendiente
    )
    # Perdio la carrera: si otra peticion lo metio, ya esta dentro, que es lo
    # que se queria. Si no entro nadie, el conflicto era otro.
    if hecha is None and (
        await db.get(ConversationMember, {"conversation_id": conversation_id, "user_id": uid})
    ) is None:
        raise ConflictError("No se pudo entrar. Inténtalo de nuevo.", code="join_request_race")
    return await _tarjeta_de(db, conversation_id, uid)


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
    entra. En una comunidad, ademas, tiene que seguir siendo del grupo padre.

    Entrar a un grupo con temas es entrar tambien a los chats de sus temas, en
    la misma transaccion (`grupos.sincronizar_temas`).
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
        from app.modules.messaging import subgrupos

        padre = await subgrupos.padre_de(db, conversation_id)
        if padre is not None:
            await grupos.exigir_que_sean_del_padre(db, padre, [persona])
        db.add(ConversationMember(conversation_id=conversation_id, user_id=persona))
        await grupos.sincronizar_temas(db, conversation_id, [persona], dentro=True)

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
    """Enseñar o no el grupo en el perfil, activar o no su enlace y como se entra.

    Activar el enlace por primera vez le crea su codigo. Desactivarlo NO lo
    borra: al volver a activarlo es el mismo enlace, y para cambiarlo esta
    `…/invite/rotate`.

    `listed_on_profile` (0112) es «en MI perfil»: crea o borra la fila de quien
    llama en `group_profile_listings`, y ademas escribe la columna de siempre,
    para que volver a la API anterior no quite la comunidad de ningun perfil.

    `entrada` (0112): pasar de abierta a con solicitud no saca a nadie (D6), y
    de con solicitud a abierta no mete a nadie: quien esperaba respuesta sigue
    esperando hasta que quien administra decida o hasta que vuelva a tocar el
    boton, que entonces si entra.

    UNA COMUNIDAD NO TIENE ENLACE NI SALE EN EL PERFIL: a ella se llega por ser
    del grupo, y un enlace llevaria a una solicitud que nunca se podria
    aceptar. Tampoco el chat de un tema. Las dos, 409.
    """
    await grupos.exigir_grupo_administrado(db, conversation_id, current_user.id)
    await grupos.exigir_primer_nivel(db, conversation_id)
    await _exigir_puertas(db)
    # Sin la 0112 no hay donde guardar como se entra: 503, el mismo que sin la
    # 0104, y ANTES de escribir nada. Lo demas funciona como antes de la 0112.
    if payload.entrada is not None and not await esquema.hay_comunidades_en_el_perfil(db):
        raise ServiceUnavailableError(
            "Elegir cómo se entra todavía no está disponible.",
            code="group_extras_not_available",
        )
    fila = await ajustes_de_grupo.asegurar_fila(db, conversation_id)

    if payload.listed_on_profile is not None:
        await ajustes_de_grupo.poner_en_mi_perfil(
            db, conversation_id, current_user.id, si=payload.listed_on_profile
        )
        fila.listed_on_profile = payload.listed_on_profile
    if payload.invite_enabled is not None:
        if payload.invite_enabled and not fila.invite_code:
            fila.invite_code = ajustes_de_grupo.codigo_nuevo()
        fila.invite_enabled = payload.invite_enabled
    if payload.entrada is not None:
        await ajustes_de_grupo.poner_entrada(db, conversation_id, payload.entrada)
    fila.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(fila)
    # Como los ve quien los cambio: «en mi perfil» es el SUYO.
    return await ajustes_de_grupo.leer_para(db, fila, conversation_id, current_user.id)


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
    await grupos.exigir_primer_nivel(db, conversation_id)
    await _exigir_puertas(db)
    fila = await ajustes_de_grupo.asegurar_fila(db, conversation_id)
    fila.invite_code = ajustes_de_grupo.codigo_nuevo()
    fila.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(fila)
    return await ajustes_de_grupo.leer_para(db, fila, conversation_id, current_user.id)


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

    Una comunidad SI tiene foto; el chat de un tema no (409): lo que lo
    representa es el icono del tema.
    """
    await grupos.exigir_grupo_administrado(db, conversation_id, current_user.id)
    await grupos.exigir_primer_nivel(db, conversation_id, comunidad_vale=True)
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
    await grupos.exigir_primer_nivel(db, conversation_id, comunidad_vale=True)
    await _exigir_puertas(db)
    fila = await ajustes_de_grupo.fila_de(db, conversation_id)
    if fila is not None and fila.avatar_path is not None:
        fila.avatar_path = None
        fila.updated_at = datetime.now(timezone.utc)
        await db.commit()
