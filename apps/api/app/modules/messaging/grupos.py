"""Grupos de mensajeria: crearlos, ver quien esta y cambiar sus miembros.

LO QUE SE DECIDIO (09/10/2026). Grupos libres, como en Telegram: cualquiera
crea uno desde Mensajes, le pone nombre y añade personas. Quien lo crea lo
administra.

NO HACE FALTA NINGUNA TABLA NUEVA. `conversations` admite `kind = 'group'`
desde la 0001, con su `title` y su `created_by`; `conversation_members` ya
guarda quien esta. Lo unico que faltaba era una ruta que los creara. Y por eso
todo lo demas —mandar mensajes, adjuntos, no leidos, borrar, las vistas— ya
funciona en un grupo sin tocarlo: nunca supo cuantos eran.

QUIEN ADMINISTRA: quien lo creo (`vistas.administra`). No hay una segunda
jerarquia: `conversation_members` no guarda rol y no se le añade. Es UNA
persona por grupo, y eso deja un hueco conocido: no puede salirse, porque
dejaria un grupo sin nadie que lo administre. Traspasar la administracion no
esta hecho.

A QUIEN SE PUEDE AÑADIR: a cualquiera con quien no haya un bloqueo, en ninguno
de los dos sentidos. Sin esto un grupo seria la forma de volver a llegar a
quien te bloqueo: le sonaria el telefono con cada mensaje.

LO QUE NO SE DICE. Si no se puede añadir a alguien, la respuesta es la misma
tanto si esa persona bloqueo a quien pregunta como si no existe: decir cual de
las dos seria contarle a alguien que lo han bloqueado.

LOS TOPES. `MAX_MIEMBROS` por grupo y `GRUPOS_POR_HORA` por persona. Un grupo
manda un aviso a cada miembro con cada mensaje: sin tope, crear grupos seria
la herramienta para molestar a cien personas a la vez.

QUITAR A ALGUIEN NO BORRA NADA DE LO QUE ESCRIBIO. Sus mensajes siguen en el
grupo; lo que pierde es el acceso, en el mismo instante: toda ruta de
mensajeria empieza comprobando que quien pregunta es miembro.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictError,
    ForbiddenError,
    NotFoundError,
    ValidationAppError,
)
from app.core.security import AuthUser, get_current_user
from app.modules.messaging import ajustes_de_grupo, avisos, esquema, preferencias
from app.modules.messaging.ajustes_de_grupo import AjustesLeidos
from app.modules.messaging.lectura import leer_conversaciones
from app.modules.messaging.models import Conversation, ConversationMember
from app.modules.messaging.schemas import ConversationRead
from app.modules.messaging.vistas import administra, conversacion_de
from app.modules.notifications.push import encolar_push
from app.modules.profiles.models import Profile
from app.modules.social_graph.models import UserBlock
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid

logger = logging.getLogger(__name__)

router = APIRouter(tags=["messaging"])

#: Cuantas personas caben en un grupo, contando a quien lo crea.
MAX_MIEMBROS = 100
#: Cuantas se pueden añadir de una vez. Menos que el tope del grupo: una lista
#: de noventa y nueve identificadores en una peticion no la escribe una persona.
MAX_POR_TANDA = 50
MAX_TITULO = 60
#: Cuantos grupos puede crear una persona en una hora.
GRUPOS_POR_HORA = 10

_NO_SE_PUEDE_ANADIR = "No se puede añadir a alguna de esas personas."


# --------------------------------------------------------------------------- #
# Esquemas
# --------------------------------------------------------------------------- #
def _titulo_limpio(v: str) -> str:
    limpio = " ".join(v.split())
    if not limpio:
        raise ValueError("El grupo necesita un nombre.")
    return limpio


def _ids_limpios(v: list[str]) -> list[str]:
    """Identificadores bien escritos, en su forma canonica y sin repetir."""
    vistos: list[str] = []
    for bruto in v:
        try:
            canonico = str(UUID(str(bruto)))
        except ValueError as error:
            raise ValueError("Identificador de persona no válido.") from error
        if canonico not in vistos:
            vistos.append(canonico)
    return vistos


class GrupoNuevo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=MAX_TITULO)
    #: A quien se añade. Quien lo crea entra siempre y no hace falta nombrarlo.
    member_ids: list[str] = Field(min_length=1, max_length=MAX_POR_TANDA)

    _titulo = field_validator("title")(_titulo_limpio)
    _ids = field_validator("member_ids")(_ids_limpios)


class GrupoCambiado(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=MAX_TITULO)

    _titulo = field_validator("title")(_titulo_limpio)


class MiembrosNuevos(BaseModel):
    model_config = ConfigDict(extra="forbid")

    user_ids: list[str] = Field(min_length=1, max_length=MAX_POR_TANDA)

    _ids = field_validator("user_ids")(_ids_limpios)


class MiembroLeido(BaseModel):
    id: str
    full_name: str
    username: str | None = None
    avatar_path: str | None = None
    #: Administra el grupo. En un chat de dos, nadie.
    is_admin: bool = False


class InfoDeConversacion(BaseModel):
    """Que es esta conversacion y quien esta en ella.

    Existe porque la aplicacion necesita saberlo para pintar un chat: en uno de
    dos enseña a la otra persona; en un grupo, el nombre del grupo y, en cada
    mensaje, de quien es.
    """

    id: str
    kind: str
    title: str | None = None
    #: Quien pregunta administra el grupo. Comodidad para la pantalla: el
    #: permiso se comprueba otra vez en cada cambio.
    can_manage: bool = False
    members_count: int = 0
    members: list[MiembroLeido] = Field(default_factory=list)
    max_members: int = MAX_MIEMBROS
    #: La foto del grupo: una ruta del almacenamiento, como la de un perfil.
    avatar_path: str | None = None
    #: La foto, el enlace y las solicitudes existen en ESTE servidor (0104).
    #: Con `false`, la aplicacion no enseña nada de eso.
    extras_available: bool = False
    #: Como esta configurada la entrada. SOLO para quien administra: lleva
    #: el codigo del enlace, que es un secreto. A los demas, `None`.
    settings: AjustesLeidos | None = None
    #: Cuantas solicitudes esperan respuesta. Solo para quien administra.
    pending_requests: int = 0
    #: Quien pregunta la tiene silenciada. Es suyo: no dice nada de los demas.
    muted: bool = False


# --------------------------------------------------------------------------- #
# Reglas
# --------------------------------------------------------------------------- #
async def exigir_que_se_puedan_anadir(
    db: AsyncSession, uid: str, ids: list[str]
) -> None:
    """Que todas existan y que no haya bloqueo con ninguna. Una sola respuesta.

    Dos consultas para toda la lista, no dos por persona.
    """
    if not ids:
        return
    existen = set(
        (await db.execute(select(Profile.id).where(Profile.id.in_(ids)))).scalars()
    )
    bloqueo = (
        await db.execute(
            select(UserBlock.blocker_id)
            .where(
                or_(
                    (UserBlock.blocker_id == uid) & (UserBlock.blocked_id.in_(ids)),
                    (UserBlock.blocked_id == uid) & (UserBlock.blocker_id.in_(ids)),
                )
            )
            .limit(1)
        )
    ).first()
    if bloqueo is not None or any(persona not in existen for persona in ids):
        # El mismo texto y el mismo codigo en los dos casos: ver el docstring.
        raise ValidationAppError(_NO_SE_PUEDE_ANADIR, code="group_member_not_allowed")


async def exigir_grupo_administrado(
    db: AsyncSession, conversation_id: str, uid: str
) -> None:
    """Pertenecer, que sea un grupo, y administrarlo. En ese orden."""
    kind, creador = await conversacion_de(db, conversation_id, uid)
    if kind != "group":
        raise ConflictError("Esta conversación no es un grupo.", code="not_a_group")
    if not administra(kind, creador, uid):
        raise ForbiddenError(
            "Solo quien administra el grupo puede hacer esto.",
            code="group_admin_required",
        )


async def nombre_de(db: AsyncSession, uid: str) -> str | None:
    fila = (
        await db.execute(
            select(Profile.full_name, Profile.username).where(Profile.id == uid)
        )
    ).one_or_none()
    if fila is None:
        return None
    return (fila.full_name or "").strip() or fila.username or None


async def avisar_de_que_los_anadieron(
    db: AsyncSession,
    background: BackgroundTasks,
    *,
    conversation_id: str,
    quien: str,
    a_quienes: list[str],
    titulo: str,
) -> None:
    """«Ana te añadió al grupo «Aula»». NUNCA tumba lo que ya se guardo."""
    try:
        encolar_push(
            background,
            user_ids=a_quienes,
            notification_type=avisos.TIPO_AL_ANADIR,
            actor_name=await nombre_de(db, quien),
            # `type: message` en los datos: tocar el aviso abre la conversacion,
            # que es a donde lleva ese tipo en la aplicacion.
            data={"type": avisos.TIPO, "conversationId": conversation_id},
            grupo=titulo,
        )
    except Exception:  # noqa: BLE001 - el aviso nunca tumba el alta
        logger.warning("[grupos] no se pudo programar el aviso", exc_info=True)


# --------------------------------------------------------------------------- #
# Rutas
# --------------------------------------------------------------------------- #
@router.post(
    "/groups", response_model=ConversationRead, status_code=status.HTTP_201_CREATED
)
async def crear_grupo(
    payload: GrupoNuevo,
    background: BackgroundTasks,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ConversationRead:
    """Crea un grupo con quien pregunta y las personas que nombra.

    NO ES IDEMPOTENTE, al reves que el chat de dos: dos grupos con la misma
    gente y el mismo nombre son dos grupos distintos, y eso es lo que alguien
    espera al pulsar «crear» dos veces a proposito. El doble toque lo frena la
    aplicacion; aqui el tope por hora impide que se convierta en otra cosa.
    """
    uid = current_user.id
    otros = [persona for persona in payload.member_ids if persona != uid]
    if not otros:
        raise ValidationAppError(
            "Añade al menos a una persona.", code="group_needs_members"
        )
    if len(otros) + 1 > MAX_MIEMBROS:
        raise ValidationAppError(
            f"Un grupo admite hasta {MAX_MIEMBROS} personas.", code="group_is_full"
        )

    hace_una_hora = datetime.now(timezone.utc) - timedelta(hours=1)
    recientes = await db.scalar(
        select(func.count())
        .select_from(Conversation)
        .where(
            Conversation.created_by == uid,
            Conversation.kind == "group",
            Conversation.created_at >= hace_una_hora,
        )
    )
    if (recientes or 0) >= GRUPOS_POR_HORA:
        raise ConflictError(
            "Has creado muchos grupos seguidos. Inténtalo más tarde.",
            code="group_rate_limited",
        )

    await exigir_que_se_puedan_anadir(db, uid, otros)

    # La identidad sale del JWT. Nunca de la peticion.
    grupo = Conversation(kind="group", title=payload.title, created_by=uid)
    db.add(grupo)
    await db.flush()
    db.add(ConversationMember(conversation_id=grupo.id, user_id=uid))
    for persona in otros:
        db.add(ConversationMember(conversation_id=grupo.id, user_id=persona))
    await db.commit()

    await avisar_de_que_los_anadieron(
        db,
        background,
        conversation_id=grupo.id,
        quien=uid,
        a_quienes=otros,
        titulo=payload.title,
    )

    fila = (
        await db.execute(
            select(
                Conversation.id,
                Conversation.kind,
                Conversation.title,
                Conversation.updated_at,
            ).where(Conversation.id == grupo.id)
        )
    ).one()
    return (await leer_conversaciones(db, [fila], uid))[0]


@router.get("/{conversation_id}/info", response_model=InfoDeConversacion)
async def info_de_la_conversacion(
    conversation_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> InfoDeConversacion:
    """Que es la conversacion y quien esta. Solo para sus miembros.

    Los miembros van TODOS en la respuesta: el tope del grupo es
    `MAX_MIEMBROS`, asi que la lista entera cabe y paginarla seria complicar
    la pantalla para nada. Un numero fijo de consultas, sean cuantos sean.
    """
    kind, creador = await conversacion_de(db, conversation_id, current_user.id)
    titulo = await db.scalar(
        select(Conversation.title).where(Conversation.id == conversation_id)
    )
    filas = (
        await db.execute(
            select(Profile.id, Profile.full_name, Profile.username, Profile.avatar_path)
            .join(ConversationMember, ConversationMember.user_id == Profile.id)
            .where(ConversationMember.conversation_id == conversation_id)
            # Por orden de llegada, y el id desempata: la lista no baila.
            .order_by(ConversationMember.joined_at.asc(), Profile.id.asc())
        )
    ).all()
    es_grupo = kind == "group"
    miembros = [
        MiembroLeido(
            id=fila.id,
            full_name=fila.full_name or "",
            username=fila.username,
            avatar_path=fila.avatar_path,
            is_admin=es_grupo and str(fila.id) == str(creador),
        )
        for fila in filas
    ]
    # Quien administra, el primero: es a quien se busca en esa lista.
    miembros.sort(key=lambda miembro: not miembro.is_admin)
    puede = administra(kind, creador, current_user.id)
    hay_extras = es_grupo and await esquema.hay_puertas_de_grupo(db)
    ajustes = await ajustes_de_grupo.fila_de(db, conversation_id) if hay_extras else None
    return InfoDeConversacion(
        id=conversation_id,
        kind=kind,
        title=titulo,
        can_manage=puede,
        members_count=len(miembros),
        members=miembros,
        avatar_path=ajustes.avatar_path if ajustes is not None else None,
        extras_available=hay_extras,
        # El codigo del enlace solo viaja hacia quien administra.
        settings=ajustes_de_grupo.leer(ajustes) if (puede and hay_extras) else None,
        pending_requests=(
            await ajustes_de_grupo.pendientes_de(db, conversation_id)
            if (puede and hay_extras)
            else 0
        ),
        muted=(
            await preferencias.de_la_conversacion(db, conversation_id, current_user.id)
        ).muted,
    )


@router.patch("/{conversation_id}/group", status_code=status.HTTP_204_NO_CONTENT)
async def renombrar_grupo(
    conversation_id: str,
    payload: GrupoCambiado,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Cambia el nombre. NO toca `updated_at`: renombrar no es actividad, y
    subir el grupo a lo alto de la bandeja de todos por un cambio de nombre
    seria avisar de algo que no ha pasado."""
    await exigir_grupo_administrado(db, conversation_id, current_user.id)
    await db.execute(
        update(Conversation)
        .where(Conversation.id == conversation_id, Conversation.kind == "group")
        .values(title=payload.title)
    )
    await db.commit()


@router.post("/{conversation_id}/members", response_model=InfoDeConversacion)
async def anadir_miembros(
    conversation_id: str,
    payload: MiembrosNuevos,
    background: BackgroundTasks,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> InfoDeConversacion:
    """Añade personas al grupo. Quien ya estaba, se queda como estaba.

    Ven el historial entero: la conversacion es del grupo, no de cada uno.
    """
    uid = current_user.id
    await exigir_grupo_administrado(db, conversation_id, uid)

    ya_dentro = set(
        (
            await db.execute(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == conversation_id
                )
            )
        ).scalars()
    )
    nuevos = [persona for persona in payload.user_ids if persona not in ya_dentro]
    if len(ya_dentro) + len(nuevos) > MAX_MIEMBROS:
        raise ConflictError(
            f"Un grupo admite hasta {MAX_MIEMBROS} personas.", code="group_is_full"
        )
    await exigir_que_se_puedan_anadir(db, uid, nuevos)

    if nuevos:
        for persona in nuevos:
            db.add(ConversationMember(conversation_id=conversation_id, user_id=persona))
        try:
            await db.commit()
        except IntegrityError:
            # Dos altas a la vez de la misma persona: ya esta dentro, que es lo
            # que se queria.
            await db.rollback()
            nuevos = []
        titulo = await db.scalar(
            select(Conversation.title).where(Conversation.id == conversation_id)
        )
        if nuevos:
            await avisar_de_que_los_anadieron(
                db,
                background,
                conversation_id=conversation_id,
                quien=uid,
                a_quienes=nuevos,
                titulo=titulo or "",
            )

    return await info_de_la_conversacion(conversation_id, current_user, db)


@router.delete(
    "/{conversation_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def quitar_miembro(
    conversation_id: str,
    user_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Salir del grupo (uno mismo) o sacar a alguien (quien administra).

    QUIEN ADMINISTRA NO PUEDE SALIRSE: es el unico que puede cambiar los
    miembros y los filtros, y el grupo se quedaria sin nadie que lo haga.
    Traspasar la administracion no esta hecho; es 409, no 403.

    Los mensajes de quien sale se quedan: son del grupo.
    """
    uid = current_user.id
    ensure_uuid(user_id, "Persona no encontrada.")
    kind, creador = await conversacion_de(db, conversation_id, uid)
    if kind != "group":
        raise ConflictError("Esta conversación no es un grupo.", code="not_a_group")

    objetivo = str(UUID(user_id))
    se_va_sola = objetivo == str(uid)
    if not se_va_sola and not administra(kind, creador, uid):
        raise ForbiddenError(
            "Solo quien administra el grupo puede sacar a alguien.",
            code="group_admin_required",
        )
    if objetivo == str(creador):
        raise ConflictError(
            "Quien administra el grupo no puede salir de él.",
            code="group_admin_cannot_leave",
        )

    borradas = await db.execute(
        delete(ConversationMember).where(
            ConversationMember.conversation_id == conversation_id,
            ConversationMember.user_id == objetivo,
        )
    )
    if not borradas.rowcount:
        raise NotFoundError("Esa persona no está en el grupo.", code="group_member_not_found")
    await db.commit()
