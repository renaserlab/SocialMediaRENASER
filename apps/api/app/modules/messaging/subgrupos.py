"""Las comunidades de un grupo (migracion 0109). En el codigo, `subgroups`.

LO QUE SE DECIDIO (26/10/2026), con Telegram de referencia. Un grupo puede
tener COMUNIDADES: grupos hijos, cada uno con su chat, su historial y sus
miembros. Estar en el grupo no mete a nadie en ninguna; cada cual entra en las
que quiere. En el codigo se llaman `subgroups` porque `communities` ya es el
modulo de los circulos de Explorar.

UNA COMUNIDAD ES UN GRUPO NORMAL Y CORRIENTE. Una fila de `conversations` con
`kind = 'group'`, creada por quien administra el grupo padre, mas una fila en
`group_subgroups` que dice de quien es hija. Por eso todo lo que ya existia
—mensajes, adjuntos, Realtime, avisos, reacciones, no leidos, borrar, las
vistas— funciona dentro sin tocarlo: nunca supo que tenia padre.

COMO SE ENTRA (D2). Cada comunidad elige:
  · `open`: un toque (`POST …/join`) y dentro;
  · `request`: se pide por la ruta de siempre (`POST /{sub_id}/join-requests`)
    y decide quien administra. Ser miembro del grupo padre es lo que da derecho
    a pedirlo: no hace falta enlace ni perfil.
Quien entra ve el historial entero (D1): la conversacion es de la comunidad,
no de cada uno.

SOLO PARA LOS DEL GRUPO. Ser miembro del padre es requisito para estar en una
comunidad, y deja de cumplirse en cuanto alguien sale de el: quien sale del
grupo, o a quien sacan, sale tambien de todas sus comunidades en la misma
transaccion (D10, ver `sacar_de_todas` y `grupos.quitar_miembro`).

LOS BLOQUEOS CUENTAN, Y NO SE DICE. Con un bloqueo entre quien mira y quien
administra, una comunidad en la que no esta «no existe»: ni sale en la lista
ni se puede entrar, con el mismo 404 que si no existiera. Es la regla de
`entrada_a_grupos.py`.

UN SOLO NIVEL. No hay comunidades dentro de una comunidad ni dentro del chat
de un tema: 409 `not_a_top_level_group`.

ELIMINAR NO BORRA MENSAJES (D5). Se marca `deleted_at` y se quitan todos sus
miembros, asi que nadie vuelve a alcanzar su historial —toda ruta empieza
comprobando que quien pregunta es miembro—. Los mensajes se quedan en la base:
existe para deshacer una comunidad creada por error, no para destruir lo que
otros escribieron.

SIN LA 0109 nada de esto existe: la lista sale vacia con `available: false`,
las escrituras responden 503 `subgroups_unavailable` y los grupos funcionan
igual que antes. Quien lo comprueba es `esquema.hay_comunidades`.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Uuid,
    case,
    delete,
    func,
    select,
    text,
    update,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql.elements import ColumnElement

from app.core.exceptions import (
    ConflictError,
    ForbiddenError,
    NotFoundError,
    ServiceUnavailableError,
)
from app.core.security import AuthUser, get_current_user
from app.modules.messaging import (
    ajustes_de_grupo,
    entrada_a_grupos,
    esquema,
    grupos,
    preferencias,
)
from app.modules.messaging.lectura import adjuntos_por_mensaje, no_leidos, ultimos_mensajes
from app.modules.messaging.models import (
    Conversation,
    ConversationMember,
    GroupJoinRequest,
)
from app.modules.messaging.vistas import administra, conversacion_de
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db
from app.shared.identifiers import ensure_uuid

logger = logging.getLogger(__name__)

router = APIRouter(tags=["messaging"])

#: El mismo tope de nombre que un grupo: una comunidad ES un grupo.
MAX_TITULO = 60
MAX_DESCRIPCION = 200
#: Cuanto texto del ultimo mensaje viaja en la lista. Es un adelanto, no el
#: mensaje: el resto se lee dentro.
MAX_EXTRACTO = 120

_NO_ESTA = "Comunidad no encontrada."

#: Como se resume un ultimo mensaje que no lleva texto. Mismo criterio que la
#: bandeja (`lectura._RESUMEN_SIN_TEXTO`): decir que hay algo, nunca dejar la
#: fila en blanco como si no hubiera nada.
_RESUMEN_SIN_TEXTO = {
    "image": "Foto",
    "video": "Video",
    "document": "Archivo",
    "audio": "Nota de voz",
}

#: Lo que la aplicacion pinta como enlace (ver `vistas._MARCAS_DE_ENLACE`).
_ENLACE = re.compile(r"(https?://|www\.)", re.IGNORECASE)


# --------------------------------------------------------------------------- #
# Modelo
# --------------------------------------------------------------------------- #
class GroupSubgroup(Base):
    """De que grupo es hija una comunidad, y como se entra (migracion 0109).

    TABLA APARTE Y NINGUNA COLUMNA NUEVA EN `conversations`, por lo mismo que
    `GroupSettings`: un `select(Conversation)` pide todas las columnas
    mapeadas, y una columna nueva romperia el codigo desplegado antes que la
    migracion.

    LA CLAVE PRIMARIA ES LA COMUNIDAD: una conversacion es hija de UN grupo o
    de ninguno, por construccion y no por una comprobacion que alguien olvide.

    Los `CHECK` repiten los de la 0109 con el mismo nombre: uno que solo viva
    en el SQL deja pasar en las pruebas lo que produccion rechaza. `length` y
    no `char_length` porque SQLite no conoce la segunda; las dos cuentan
    caracteres.
    """

    __tablename__ = "group_subgroups"
    __table_args__ = (
        CheckConstraint(
            "length(descripcion) <= 200", name="group_subgroups_descripcion_check"
        ),
        CheckConstraint(
            "entrada in ('open', 'request')", name="group_subgroups_entrada_check"
        ),
        CheckConstraint(
            "conversation_id <> parent_id", name="group_subgroups_no_es_su_padre_check"
        ),
        # La unica lectura que se hace: las comunidades vivas de UN grupo.
        Index(
            "group_subgroups_parent_idx",
            "parent_id",
            sqlite_where=text("deleted_at is null"),
            postgresql_where=text("deleted_at is null"),
        ),
    )

    conversation_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        primary_key=True,
    )
    parent_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("conversations.id", ondelete="CASCADE"),
    )
    descripcion: Mapped[str] = mapped_column(Text, default="", server_default="")
    #: open | request (D2).
    entrada: Mapped[str] = mapped_column(String(16), default="open", server_default="open")
    posicion: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    #: Cuando se elimino (D5). Una eliminada no sale en ningun sitio.
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


# --------------------------------------------------------------------------- #
# Lo que usan los demas modulos
# --------------------------------------------------------------------------- #
async def fila_de(db: AsyncSession, conversation_id: str):
    """`(parent_id, entrada, deleted_at)` si la conversacion es una comunidad.

    INCLUIDAS LAS ELIMINADAS: quien pregunta «¿es de primer nivel?» necesita
    saber que una conversacion fue comunidad aunque ya no lo sea, para no
    tratarla como un grupo suelto. `None` si no lo es, o sin la 0109.
    """
    if not await esquema.hay_comunidades(db):
        return None
    return (
        await db.execute(
            select(
                GroupSubgroup.parent_id,
                GroupSubgroup.entrada,
                GroupSubgroup.deleted_at,
            ).where(GroupSubgroup.conversation_id == conversation_id)
        )
    ).one_or_none()


async def padre_de(db: AsyncSession, conversation_id: str) -> str | None:
    """El grupo padre de una comunidad VIVA. `None` en cualquier otro caso."""
    fila = await fila_de(db, conversation_id)
    if fila is None or fila.deleted_at is not None:
        return None
    return str(fila.parent_id)


async def padre_con_titulo(db: AsyncSession, conversation_id: str):
    """`(id, title)` del grupo padre de una comunidad viva, o `None`. UNA consulta."""
    if not await esquema.hay_comunidades(db):
        return None
    return (
        await db.execute(
            select(GroupSubgroup.parent_id, Conversation.title)
            .join(Conversation, Conversation.id == GroupSubgroup.parent_id)
            .where(
                GroupSubgroup.conversation_id == conversation_id,
                GroupSubgroup.deleted_at.is_(None),
            )
        )
    ).one_or_none()


def condicion_no_es_comunidad(columna) -> ColumnElement[bool]:
    """«Esta conversacion no es una comunidad». Para la bandeja agrupada (D12).

    `NOT EXISTS` y no un `NOT IN` con la lista: va dentro de la consulta que
    ya se hace y no cuesta ninguna. Incluye las eliminadas, que de todos modos
    no tienen miembros. QUIEN LA USA COMPRUEBA ANTES `esquema.hay_comunidades`:
    sin la tabla, nombrarla es un 500.
    """
    return ~(
        select(GroupSubgroup.conversation_id)
        .where(GroupSubgroup.conversation_id == columna)
        .exists()
    )


@dataclass
class EnLaPagina:
    """Lo que la bandeja necesita saber de las comunidades de una pagina."""

    #: comunidad -> su grupo padre. Para `ConversationRead.parent_id`.
    padres: dict[str, str] = field(default_factory=dict)
    #: grupo -> cuantas comunidades vivas tiene.
    cuantas: dict[str, int] = field(default_factory=dict)
    #: grupo -> no leidos de las comunidades donde esta quien pregunta.
    no_leidas: dict[str, int] = field(default_factory=dict)


async def de_la_pagina(
    db: AsyncSession, group_ids: list[str], uid: str, *, agrupado: bool
) -> EnLaPagina:
    """Padres, cuentas y no leidos de los grupos de una pagina. CONSULTAS FIJAS.

    Una consulta trae a la vez de quien es hija cada fila y que hijas tiene
    cada una; los no leidos de TODAS las comunidades son otra, con el mismo
    `no_leidos` de la bandeja (que ya solo cuenta donde quien pregunta es
    miembro). Dos consultas con dos grupos y dos con veinte.

    Sin `agrupado` solo hace falta el padre: las comunidades salen como filas
    propias y no se suman a nadie.
    """
    salida = EnLaPagina()
    if not group_ids or not await esquema.hay_comunidades(db):
        return salida
    en_la_pagina = set(group_ids)
    condicion = GroupSubgroup.conversation_id.in_(group_ids)
    if agrupado:
        condicion = condicion | GroupSubgroup.parent_id.in_(group_ids)
    filas = (
        await db.execute(
            select(GroupSubgroup.conversation_id, GroupSubgroup.parent_id).where(
                GroupSubgroup.deleted_at.is_(None), condicion
            )
        )
    ).all()
    salida.padres = {
        str(hija): str(padre) for hija, padre in filas if str(hija) in en_la_pagina
    }
    if not agrupado:
        return salida

    padre_de_la_hija = {
        str(hija): str(padre) for hija, padre in filas if str(padre) in en_la_pagina
    }
    salida.cuantas = dict(Counter(padre_de_la_hija.values()))
    pendientes = await no_leidos(db, list(padre_de_la_hija), uid)
    for hija, cuantos in pendientes.items():
        padre = padre_de_la_hija.get(str(hija))
        if padre is not None:
            salida.no_leidas[padre] = salida.no_leidas.get(padre, 0) + cuantos
    return salida


async def sacar_de_todas(db: AsyncSession, parent_id: str, user_id: str) -> None:
    """D10: quien deja el grupo deja tambien todas sus comunidades. SIN COMMIT.

    Va en la transaccion de quien llama (`grupos.quitar_miembro`): o sale del
    grupo y de sus comunidades, o de nada. Quedarse dentro de una comunidad
    sin estar en el grupo seria una puerta trasera para seguir leyendo a
    quien te saco.

    Y sus solicitudes vivas a esas comunidades se cancelan: ya no podria
    entrar aunque se aceptaran, y dejarlas en la lista de quien administra
    seria ofrecerle un boton que no hace nada.
    """
    if not await esquema.hay_comunidades(db):
        return
    hijas = select(GroupSubgroup.conversation_id).where(
        GroupSubgroup.parent_id == parent_id
    )
    await db.execute(
        delete(ConversationMember)
        .where(
            ConversationMember.conversation_id.in_(hijas),
            ConversationMember.user_id == user_id,
        )
        .execution_options(synchronize_session=False)
    )
    if await esquema.hay_puertas_de_grupo(db):
        await db.execute(
            update(GroupJoinRequest)
            .where(
                GroupJoinRequest.conversation_id.in_(hijas),
                GroupJoinRequest.user_id == user_id,
                GroupJoinRequest.status == "pending",
            )
            .values(status="cancelled", resolved_at=func.now())
            .execution_options(synchronize_session=False)
        )


# --------------------------------------------------------------------------- #
# Esquemas
# --------------------------------------------------------------------------- #
def _titulo_limpio(v: str) -> str:
    limpio = " ".join(v.split())
    if not limpio:
        raise ValueError("La comunidad necesita un nombre.")
    return limpio


def _descripcion_limpia(v: str) -> str:
    return v.strip()


class ComunidadNueva(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=MAX_TITULO)
    description: str = Field(default="", max_length=MAX_DESCRIPCION)
    entry: Literal["open", "request"] = "open"

    _titulo = field_validator("title")(_titulo_limpio)
    _descripcion = field_validator("description")(_descripcion_limpia)


class ComunidadCambiada(BaseModel):
    """Lo que se quiera cambiar. Lo que no viene, no se toca."""

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=MAX_TITULO)
    description: str | None = Field(default=None, max_length=MAX_DESCRIPCION)
    entry: Literal["open", "request"] | None = None
    position: int | None = Field(default=None, ge=0, le=10_000)

    @field_validator("title")
    @classmethod
    def _titulo(cls, v: str | None) -> str | None:
        return None if v is None else _titulo_limpio(v)

    @field_validator("description")
    @classmethod
    def _descripcion(cls, v: str | None) -> str | None:
        return None if v is None else _descripcion_limpia(v)


class UltimoDeLaComunidad(BaseModel):
    """Lo ultimo que se dijo, para la fila. Solo lo ve quien esta dentro."""

    sender_name: str = ""
    excerpt: str = ""
    #: El tipo del primer adjunto; `link` si el texto lleva una direccion;
    #: `text` en otro caso. Con esto la pantalla elige el icono.
    kind: str = "text"
    at: datetime


class ComunidadLeida(BaseModel):
    id: str
    title: str
    #: La foto: una ruta del almacenamiento, como la de un grupo (0104).
    avatar_path: str | None = None
    description: str = ""
    entry: Literal["open", "request"] = "open"
    position: int = 0
    members_count: int = 0
    is_member: bool = False
    #: Quien pregunta pidio entrar y espera respuesta.
    request_pending: bool = False
    #: Cuantas solicitudes esperan. Solo para quien administra; a los demas, 0.
    pending_requests: int = 0
    #: Solo si `is_member`: quien no esta dentro no ve mensajes, ni cuantos.
    unread_count: int = 0
    last: UltimoDeLaComunidad | None = None


class ComunidadesDelGrupo(BaseModel):
    #: Las comunidades existen en ESTE servidor (0109). Con `false`, la
    #: aplicacion no enseña la seccion ni el boton de crear.
    available: bool = False
    #: Quien pregunta administra el grupo. Comodidad para la pantalla: el
    #: permiso se comprueba otra vez en cada cambio.
    can_manage: bool = False
    subgroups: list[ComunidadLeida] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Reglas
# --------------------------------------------------------------------------- #
async def _exigir_tabla(db: AsyncSession) -> None:
    if not await esquema.hay_comunidades(db):
        raise ServiceUnavailableError(
            "Las comunidades de un grupo todavía no están disponibles.",
            code="subgroups_unavailable",
        )


async def _exigir_admin_del_grupo(db: AsyncSession, group_id: str, uid: str) -> None:
    """Pertenecer, que la 0109 este, que sea un grupo de primer nivel y administrarlo.

    Pertenecer va PRIMERO, como en `vistas._exigir_administrar`: quien no es
    miembro recibe el mismo 403 exista o no el grupo, y exista o no la tabla.
    """
    kind, creador = await conversacion_de(db, group_id, uid)
    await _exigir_tabla(db)
    if kind != "group":
        raise ConflictError("Esta conversación no es un grupo.", code="not_a_group")
    if not administra(kind, creador, uid):
        raise ForbiddenError(
            "Solo quien administra el grupo puede hacer esto.",
            code="group_admin_required",
        )
    await grupos.exigir_primer_nivel(db, group_id)


_COLUMNAS = (
    GroupSubgroup.conversation_id,
    Conversation.title,
    Conversation.created_by,
    GroupSubgroup.descripcion,
    GroupSubgroup.entrada,
    GroupSubgroup.posicion,
)


async def _comunidad_viva(db: AsyncSession, group_id: str, sub_id: str):
    """La fila de una comunidad viva DE ESTE grupo. 404 en cualquier otro caso.

    El padre va en el WHERE: quien administra un grupo no alcanza las
    comunidades de otro aunque conozca su identificador.
    """
    ensure_uuid(sub_id, _NO_ESTA)
    fila = (
        await db.execute(
            select(*_COLUMNAS)
            .join(Conversation, Conversation.id == GroupSubgroup.conversation_id)
            .where(
                GroupSubgroup.conversation_id == sub_id,
                GroupSubgroup.parent_id == group_id,
                GroupSubgroup.deleted_at.is_(None),
            )
        )
    ).one_or_none()
    if fila is None:
        raise NotFoundError(_NO_ESTA, code="subgroup_not_found")
    return fila


def _extracto(cuerpo: str) -> str:
    limpio = " ".join((cuerpo or "").split())
    if len(limpio) <= MAX_EXTRACTO:
        return limpio
    return limpio[: MAX_EXTRACTO - 1].rstrip() + "…"


async def _leer(
    db: AsyncSession,
    filas,
    uid: str,
    *,
    puede: bool,
    solo_las_suyas: bool = False,
) -> list[ComunidadLeida]:
    """Las comunidades de una lista, con un numero de consultas CONSTANTE.

    Cuantos son y si quien pregunta esta dentro, en una; la foto, en otra; las
    solicitudes, en dos; y de las que es miembro, los no leidos, lo ultimo, su
    autor y sus adjuntos, en una cada cosa. Nueve como mucho, sean dos
    comunidades o veinte: es lo que pide `lectura.py` para la bandeja.

    `solo_las_suyas`: con un bloqueo entre quien pregunta y quien administra,
    las comunidades donde no esta no existen para el (ver el docstring).
    """
    if not filas:
        return []
    ids = [str(fila.conversation_id) for fila in filas]

    cuantos: dict[str, int] = {}
    dentro: set[str] = set()
    for conversacion, total, mia in (
        await db.execute(
            select(
                ConversationMember.conversation_id,
                func.count(),
                func.sum(case((ConversationMember.user_id == uid, 1), else_=0)),
            )
            .where(ConversationMember.conversation_id.in_(ids))
            .group_by(ConversationMember.conversation_id)
        )
    ).all():
        cuantos[str(conversacion)] = int(total or 0)
        if mia:
            dentro.add(str(conversacion))

    if solo_las_suyas:
        filas = [fila for fila in filas if str(fila.conversation_id) in dentro]
        ids = [str(fila.conversation_id) for fila in filas]
        if not ids:
            return []

    fotos = await ajustes_de_grupo.avatares_de(db, ids)

    esperando: set[str] = set()
    por_decidir: dict[str, int] = {}
    if await esquema.hay_puertas_de_grupo(db):
        fuera = [i for i in ids if i not in dentro]
        if fuera:
            esperando = {
                str(c)
                for c in (
                    await db.scalars(
                        select(GroupJoinRequest.conversation_id).where(
                            GroupJoinRequest.conversation_id.in_(fuera),
                            GroupJoinRequest.user_id == uid,
                            GroupJoinRequest.status == "pending",
                        )
                    )
                )
            }
        if puede:
            # Las de quien ya esta dentro no cuentan: no queda nada que decidir
            # (mismo criterio que `ajustes_de_grupo.pendientes_de`).
            ya_dentro = (
                select(ConversationMember.user_id)
                .where(
                    ConversationMember.conversation_id == GroupJoinRequest.conversation_id,
                    ConversationMember.user_id == GroupJoinRequest.user_id,
                )
                .correlate(GroupJoinRequest)
                .exists()
            )
            por_decidir = {
                str(c): int(n or 0)
                for c, n in (
                    await db.execute(
                        select(GroupJoinRequest.conversation_id, func.count())
                        .where(
                            GroupJoinRequest.conversation_id.in_(ids),
                            GroupJoinRequest.status == "pending",
                            ~ya_dentro,
                        )
                        .group_by(GroupJoinRequest.conversation_id)
                    )
                ).all()
            }

    # Lo de dentro, solo de las que es miembro: quien no esta no ve mensajes.
    mias = [i for i in ids if i in dentro]
    pendientes = await no_leidos(db, mias, uid)
    ultimos = await ultimos_mensajes(db, mias)
    # Si vacio una comunidad, la fila no puede seguir enseñando lo que vacio.
    propias = await preferencias.de_la_pagina(db, uid, mias)
    vigentes = {}
    for conversacion, ultimo in ultimos.items():
        vaciada = propias.get(str(conversacion), preferencias.SIN_PREFERENCIA).cleared_at
        if vaciada is None or ultimo.created_at > vaciada:
            vigentes[str(conversacion)] = ultimo

    autores: dict[str, str] = {}
    remitentes = list({str(u.sender_id) for u in vigentes.values()})
    if remitentes:
        autores = {
            str(pid): ((nombre or "").strip() or usuario or "")
            for pid, nombre, usuario in (
                await db.execute(
                    select(Profile.id, Profile.full_name, Profile.username).where(
                        Profile.id.in_(remitentes)
                    )
                )
            ).all()
        }
    adjuntos = await adjuntos_por_mensaje(db, [str(u.id) for u in vigentes.values()])

    salida: list[ComunidadLeida] = []
    for fila in filas:
        sub = str(fila.conversation_id)
        es_miembro = sub in dentro
        ultimo = vigentes.get(sub) if es_miembro else None
        resumen = None
        if ultimo is not None:
            primeros = adjuntos.get(str(ultimo.id)) or []
            cuerpo = (ultimo.body or "").strip()
            if primeros:
                tipo = primeros[0].kind
            elif _ENLACE.search(cuerpo):
                tipo = "link"
            else:
                tipo = "text"
            resumen = UltimoDeLaComunidad(
                sender_name=autores.get(str(ultimo.sender_id), ""),
                excerpt=(
                    _extracto(cuerpo)
                    if cuerpo
                    else _RESUMEN_SIN_TEXTO.get(tipo, "Archivo")
                ),
                kind=tipo,
                at=ultimo.created_at,
            )
        salida.append(
            ComunidadLeida(
                id=sub,
                title=(fila.title or "").strip(),
                avatar_path=fotos.get(sub),
                description=fila.descripcion or "",
                entry=fila.entrada,
                position=int(fila.posicion or 0),
                members_count=cuantos.get(sub, 0),
                is_member=es_miembro,
                request_pending=(not es_miembro) and sub in esperando,
                pending_requests=por_decidir.get(sub, 0) if puede else 0,
                unread_count=pendientes.get(sub, 0) if es_miembro else 0,
                last=resumen,
            )
        )
    return salida


async def _leer_una(db: AsyncSession, group_id: str, sub_id: str, uid: str) -> ComunidadLeida:
    fila = await _comunidad_viva(db, group_id, sub_id)
    return (await _leer(db, [fila], uid, puede=True))[0]


# --------------------------------------------------------------------------- #
# Rutas
# --------------------------------------------------------------------------- #
@router.get("/{group_id}/subgroups", response_model=ComunidadesDelGrupo)
async def comunidades_del_grupo(
    group_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ComunidadesDelGrupo:
    """Las comunidades vivas del grupo, en su orden. Solo para sus miembros.

    Salen TODAS, tambien aquellas en las que quien pregunta no esta: es la
    forma de descubrirlas. De esas se enseña la tarjeta —nombre, foto,
    cuantos son, como se entra— y nada de lo que se dice dentro.

    En una conversacion que no es un grupo de primer nivel —un chat de dos,
    una comunidad, el chat de un tema— la lista sale vacia y no se ofrece
    crear: alli no caben comunidades.
    """
    uid = current_user.id
    kind, creador = await conversacion_de(db, group_id, uid)
    if not await esquema.hay_comunidades(db):
        return ComunidadesDelGrupo(available=False)
    if kind != "group":
        return ComunidadesDelGrupo(available=True)
    try:
        await grupos.exigir_primer_nivel(db, group_id)
    except ConflictError:
        return ComunidadesDelGrupo(available=True)

    puede = administra(kind, creador, uid)
    filas = (
        await db.execute(
            select(*_COLUMNAS)
            .join(Conversation, Conversation.id == GroupSubgroup.conversation_id)
            .where(
                GroupSubgroup.parent_id == group_id,
                GroupSubgroup.deleted_at.is_(None),
            )
            # El id desempata: la lista no baila entre peticiones.
            .order_by(
                GroupSubgroup.posicion.asc(),
                GroupSubgroup.created_at.asc(),
                GroupSubgroup.conversation_id.asc(),
            )
        )
    ).all()
    con_bloqueo = not puede and await entrada_a_grupos.hay_bloqueo(db, uid, creador)
    return ComunidadesDelGrupo(
        available=True,
        can_manage=puede,
        subgroups=await _leer(db, filas, uid, puede=puede, solo_las_suyas=con_bloqueo),
    )


@router.post(
    "/{group_id}/subgroups",
    response_model=ComunidadLeida,
    status_code=status.HTTP_201_CREATED,
)
async def crear_comunidad(
    group_id: str,
    payload: ComunidadNueva,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ComunidadLeida:
    """Crea una comunidad con quien administra el grupo como unico miembro.

    VALE EL MISMO TOPE QUE CREAR UN GRUPO (`grupos.GRUPOS_POR_HORA`): una
    comunidad es un grupo, y sin el tope seria la forma de saltarselo.

    No avisa a nadie: los del grupo la veran en la lista y entraran si
    quieren. Un aviso por cada comunidad nueva seria ruido para quien no le
    interesa.
    """
    uid = current_user.id
    await _exigir_admin_del_grupo(db, group_id, uid)

    if await grupos.creados_en_la_ultima_hora(db, uid) >= grupos.GRUPOS_POR_HORA:
        raise ConflictError(
            "Creaste muchos grupos seguidos. Inténtalo más tarde.",
            code="group_rate_limited",
        )

    ultima = await db.scalar(
        select(func.coalesce(func.max(GroupSubgroup.posicion), -1)).where(
            GroupSubgroup.parent_id == group_id,
            GroupSubgroup.deleted_at.is_(None),
        )
    )
    # La identidad sale del JWT. Nunca de la peticion.
    comunidad = Conversation(kind="group", title=payload.title, created_by=uid)
    db.add(comunidad)
    await db.flush()
    db.add(ConversationMember(conversation_id=comunidad.id, user_id=uid))
    db.add(
        GroupSubgroup(
            conversation_id=comunidad.id,
            parent_id=group_id,
            descripcion=payload.description,
            entrada=payload.entry,
            posicion=int(ultima if ultima is not None else -1) + 1,
        )
    )
    await db.commit()
    return await _leer_una(db, group_id, comunidad.id, uid)


@router.patch("/{group_id}/subgroups/{sub_id}", response_model=ComunidadLeida)
async def cambiar_comunidad(
    group_id: str,
    sub_id: str,
    payload: ComunidadCambiada,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ComunidadLeida:
    """Nombre, descripcion, como se entra y posicion.

    Renombrar NO toca `updated_at`, por lo mismo que `grupos.renombrar_grupo`:
    no es actividad. Pasar de `request` a `open` no mete a nadie: las
    solicitudes que esperaban siguen ahi para que quien administra las acepte.
    """
    uid = current_user.id
    await _exigir_admin_del_grupo(db, group_id, uid)
    await _comunidad_viva(db, group_id, sub_id)

    cambios = {}
    if payload.description is not None:
        cambios["descripcion"] = payload.description
    if payload.entry is not None:
        cambios["entrada"] = payload.entry
    if payload.position is not None:
        cambios["posicion"] = payload.position
    if cambios:
        await db.execute(
            update(GroupSubgroup)
            .where(GroupSubgroup.conversation_id == sub_id)
            .values(**cambios)
            .execution_options(synchronize_session=False)
        )
    if payload.title is not None:
        await db.execute(
            update(Conversation)
            .where(Conversation.id == sub_id)
            .values(title=payload.title)
            .execution_options(synchronize_session=False)
        )
    await db.commit()
    return await _leer_una(db, group_id, sub_id, uid)


@router.delete(
    "/{group_id}/subgroups/{sub_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def eliminar_comunidad(
    group_id: str,
    sub_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """D5: borrado suave. Se marca, se quitan TODOS sus miembros y ya.

    Quitar a los miembros es lo que la hace desaparecer de verdad: deja de
    salir en la bandeja de cada uno y su historial deja de poder leerse,
    porque toda ruta de mensajeria empieza comprobando que quien pregunta es
    miembro. Los mensajes NO se borran: se quedan en la base, inaccesibles,
    por si hay que responder de ellos.

    Las solicitudes que esperaban se cancelan: no queda nada a lo que entrar.
    """
    uid = current_user.id
    await _exigir_admin_del_grupo(db, group_id, uid)
    await _comunidad_viva(db, group_id, sub_id)

    await db.execute(
        update(GroupSubgroup)
        .where(GroupSubgroup.conversation_id == sub_id, GroupSubgroup.deleted_at.is_(None))
        .values(deleted_at=datetime.now(timezone.utc))
        .execution_options(synchronize_session=False)
    )
    await db.execute(
        delete(ConversationMember)
        .where(ConversationMember.conversation_id == sub_id)
        .execution_options(synchronize_session=False)
    )
    if await esquema.hay_puertas_de_grupo(db):
        await db.execute(
            update(GroupJoinRequest)
            .where(
                GroupJoinRequest.conversation_id == sub_id,
                GroupJoinRequest.status == "pending",
            )
            .values(status="cancelled", resolved_at=func.now())
            .execution_options(synchronize_session=False)
        )
    await db.commit()


@router.post(
    "/{group_id}/subgroups/{sub_id}/join", status_code=status.HTTP_204_NO_CONTENT
)
async def unirse_a_la_comunidad(
    group_id: str,
    sub_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Entrar de un toque en una comunidad `open` (D2).

    A quien no es del grupo, o tiene un bloqueo con quien lo administra, se le
    responde 404, el mismo que si la comunidad no existiera: distinguirlo le
    contaria que existe o que lo bloquearon.

    Una comunidad `request` responde 409 `subgroup_requires_request`: se pide
    por `POST /{sub_id}/join-requests`, que es la ruta de siempre.

    IDEMPOTENTE: quien ya esta dentro recibe 204 y se queda como estaba.
    """
    uid = current_user.id
    ensure_uuid(group_id, _NO_ESTA)
    ensure_uuid(sub_id, _NO_ESTA)
    del_grupo = await db.get(
        ConversationMember, {"conversation_id": group_id, "user_id": uid}
    )
    if del_grupo is None:
        raise NotFoundError(_NO_ESTA, code="subgroup_not_found")
    await _exigir_tabla(db)
    fila = await _comunidad_viva(db, group_id, sub_id)
    if await entrada_a_grupos.hay_bloqueo(db, uid, fila.created_by):
        raise NotFoundError(_NO_ESTA, code="subgroup_not_found")

    miembros = set(
        str(m)
        for m in (
            await db.scalars(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == sub_id
                )
            )
        )
    )
    if str(uid) in miembros:
        return
    if fila.entrada != "open":
        raise ConflictError(
            "Para entrar en esta comunidad hay que pedirlo.",
            code="subgroup_requires_request",
        )
    if len(miembros) >= grupos.MAX_MIEMBROS:
        raise ConflictError("La comunidad está completa.", code="group_is_full")

    db.add(ConversationMember(conversation_id=sub_id, user_id=uid))
    try:
        await db.commit()
    except IntegrityError:
        # Dos toques a la vez: ya esta dentro, que es lo que se queria.
        await db.rollback()
