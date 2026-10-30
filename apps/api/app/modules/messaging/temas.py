"""Los temas de un grupo (migracion 0108).

LO QUE SE PIDIO (26/10/2026, con Telegram de referencia). Que quien administra
un grupo pueda ordenarlo en TEMAS —«Anuncios», «Material», «Grabaciones»— que
ven todos los miembros sin tener que unirse. El contrato entero esta en
`docs/CONTRATOS_TEMAS_Y_COMUNIDADES.md` (§ 1 y § 4.1); aqui se explica el
porque de lo que no se ve en el.

EN UN TEMA HAY DOS COSAS, Y NINGUNA ES UNA COPIA:

  * REFERENCIAS a mensajes de General (`conversation_topic_items`). Es el
    MISMO mensaje: si su autor lo borra, desaparece tambien del tema; si
    alguien reacciona en el tema, reacciona al original. Por eso cada mensaje
    que se entrega lleva su `conversation_id` DE VERDAD, que es el que la
    aplicacion usa para reaccionar y para borrar.
  * MENSAJES PROPIOS, que escribe solo la administracion y que NO salen en
    General. Viven en el CHAT PROPIO del tema (`chat_id`): una conversacion
    normal, `kind = 'group'`, con los mismos miembros que el grupo. Asi
    funcionan sin tocarlos los adjuntos, el almacenamiento, la RLS de lectura,
    el tiempo real, los avisos y las reacciones. Guardarlos en General con una
    marca se descarto: la aplicacion pinta al instante la fila que llega por
    tiempo real, antes de preguntar a la API, y el anuncio se colaria en
    General.

LOS MIEMBROS DEL CHAT DE UN TEMA SON LOS DEL GRUPO. Al crear el tema se copian
en la misma transaccion; despues los mantiene `sincronizar_miembros`, que
llama quien cambia los miembros del grupo (`grupos.py`, `entrada_a_grupos.py`)
dentro de SU transaccion. Eliminar un tema los quita a todos (D15).

QUIEN ADMINISTRA: quien creo el grupo, y lo decide `vistas.administra`, que
es la unica fuente de esa respuesta en todo el modulo (D6).

UN SOLO NIVEL. No hay temas en un chat de dos, ni en una comunidad, ni en el
chat de otro tema: 409 `not_a_top_level_group`.

SIN LA 0108 NO SE ROMPE NADA. Las lecturas responden vacio (`available:
false`), las escrituras 503 `topics_unavailable` y las funciones que usan
otros modulos devuelven `None`, `[]` o `0` sin tocar la base. Nunca un 500: un
500 sin capturar sale sin cabeceras CORS y el navegador lo enseña como un
fallo de red.

POR QUE SE IMPORTAN MODULOS Y NO NOMBRES de `vistas`, `lectura` y los demas
vecinos. `grupos.py` y otros importaran este fichero para sincronizar
miembros, y estos vecinos pueden acabar importandolo tambien. Con
`from modulo import funcion`, el primer ciclo de importacion revienta al
arrancar; con `from paquete import modulo` y el atributo leido al llamar, el
ciclo es inofensivo. `schemas` es la excepcion porque `TemaMensaje` hereda de
`MessageRead` al definirse, y `schemas` no importa nada de mensajeria que
pueda volver aqui.
"""

from __future__ import annotations

import re
from datetime import datetime
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Query, status
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
    and_,
    column,
    delete,
    func,
    insert,
    or_,
    select,
    table,
    text,
    union_all,
    update,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, aliased, mapped_column
from sqlalchemy.sql.elements import ColumnElement

from app.core.exceptions import (
    ConflictError,
    ForbiddenError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationAppError,
)
from app.core.security import AuthUser, get_current_user
from app.modules.content.schemas import AuthorSummary
from app.modules.messaging import (
    esquema,
    etiquetas,
    historias,
    lectura,
    reacciones,
    sesiones,
    vistas,
)
from app.modules.messaging.models import (
    ES_NOTA_DE_VOZ,
    TITULO_DE_ADJUNTO,
    Conversation,
    ConversationMember,
    Message,
    MessageAttachment,
)
from app.modules.messaging.schemas import MessageRead, TemaBreve
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db
from app.shared.identifiers import ensure_uuid

router = APIRouter(tags=["messaging"])


def _uuid() -> str:
    return str(uuid4())


#: Los iconos que puede llevar un tema. Lista CERRADA: es el nombre de un icono
#: del juego que ya usa la aplicacion (Feather), y un texto cualquiera dejaria
#: un hueco donde deberia ir el dibujo. Uno desconocido NO es un error: se
#: guarda como `folder`, para que una version de la aplicacion con un icono
#: nuevo no se quede sin poder crear temas contra un servidor antiguo.
ICONOS = (
    "folder",
    "bell",
    "video",
    "mic",
    "link",
    "image",
    "file-text",
    "star",
    "book",
    "calendar",
)
ICONO_POR_OMISION = "folder"

#: Cuantos temas vivos puede tener un grupo. La lista se pinta entera, sin
#: paginar, encima del chat: a partir de veinte deja de ser un indice.
MAX_TEMAS_POR_GRUPO = 20

#: El mismo numero que el `check` de la 0108. Si aqui subiera, la base
#: rechazaria el nombre y saldria un 500 en vez del 422 que corresponde.
MAX_NOMBRE = 40

PAGINA_POR_OMISION = 30
PAGINA_MAXIMA = 60

#: Cuantos mensajes se pueden añadir a un tema de una vez (`PUT …/items`).
#: Es lo que cabe elegir con holgura en Contenido sin que una sola peticion
#: tenga que comprobar cientos de mensajes dentro de una transaccion.
MAX_REFERENCIAS_POR_LOTE = 50

#: De cuantos mensajes se pueden pedir los temas de una vez
#: (`GET …/topics/of-messages`): una pantalla de chat con holgura, como
#: `reacciones.MAX_CONSULTA`.
MAX_MENSAJES_POR_CONSULTA = 100

#: Cuanto texto viaja en `last.excerpt`. Es una linea de la lista de temas.
MAX_EXTRACTO = 120

#: Lo que la aplicacion pinta como enlace, igual que `vistas._MARCAS_DE_ENLACE`
#: (que lo hace en SQL). Aqui se mira un solo texto ya leido.
_ENLACE = re.compile(r"https?://|www\.", re.IGNORECASE)


# --------------------------------------------------------------------------- #
# Modelos
# --------------------------------------------------------------------------- #
# Viven AQUI y no en `models.py` por el reparto de la ronda (§ 5 del
# contrato), igual que las etiquetas en `etiquetas.py`. Las restricciones van
# tambien en el modelo y no solo en la 0108: el SQLite de las pruebas crea las
# tablas desde aqui, y una unicidad que existe en produccion y no donde se
# prueba es la peor forma de tenerla.
class ConversationTopic(Base):
    """Un tema de un grupo, con su chat propio (migracion 0108).

    `nombre_normalizado` no se pinta: existe para que «Anuncios» y
    « anuncios » sean el mismo tema. El indice unico solo mira los VIVOS, asi
    que borrar un tema libera su nombre.

    `deleted_at`: eliminar un tema es un borrado suave (D15). La fila se queda
    para que el chat del tema siga sabiendo que lo fue: ver
    `condicion_no_es_chat_de_tema`.
    """

    __tablename__ = "conversation_topics"
    __table_args__ = (
        CheckConstraint(
            "chat_id <> conversation_id", name="conversation_topics_chat_distinto_check"
        ),
        # `length` y no `char_length`, que SQLite no conoce; sobre `text` las
        # dos cuentan caracteres en PostgreSQL. Producción usa los de la 0108.
        CheckConstraint(
            "length(nombre) between 1 and 40", name="conversation_topics_nombre_check"
        ),
        CheckConstraint(
            "length(icono) between 1 and 32", name="conversation_topics_icono_check"
        ),
        Index(
            "conversation_topics_nombre_uidx",
            "conversation_id",
            "nombre_normalizado",
            unique=True,
            sqlite_where=text("deleted_at is null"),
            postgresql_where=text("deleted_at is null"),
        ),
        Index(
            "conversation_topics_conversation_idx",
            "conversation_id",
            sqlite_where=text("deleted_at is null"),
            postgresql_where=text("deleted_at is null"),
        ),
    )

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    #: El grupo.
    conversation_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("conversations.id", ondelete="CASCADE")
    )
    #: El chat propio del tema: donde escribe la administracion.
    chat_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        unique=True,
    )
    nombre: Mapped[str] = mapped_column(String(MAX_NOMBRE))
    nombre_normalizado: Mapped[str] = mapped_column(Text)
    icono: Mapped[str] = mapped_column(
        String(32), default=ICONO_POR_OMISION, server_default=ICONO_POR_OMISION
    )
    posicion: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_by: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class ConversationTopicItem(Base):
    """Una referencia de un tema a un mensaje de General (migracion 0108).

    LA CLAVE PRIMARIA COMPUESTA ES LO QUE HACE IDEMPOTENTE AÑADIR DOS VECES el
    mismo mensaje: el segundo intento no escribe nada, sin un `select` previo
    que deje una ventana para el doble toque.

    `conversation_id` es el grupo, repetido —tambien lo sabe el tema— para
    acotar por grupo sin pasar por `conversation_topics`.
    """

    __tablename__ = "conversation_topic_items"
    __table_args__ = (
        Index("conversation_topic_items_topic_idx", "topic_id", "added_at"),
        Index("conversation_topic_items_message_idx", "message_id"),
    )

    topic_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("conversation_topics.id", ondelete="CASCADE"),
        primary_key=True,
    )
    message_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("messages.id", ondelete="CASCADE"),
        primary_key=True,
    )
    conversation_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("conversations.id", ondelete="CASCADE")
    )
    added_by: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="SET NULL"),
        nullable=True,
    )
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ConversationTopicView(Base):
    """Hasta cuando vio una persona las REFERENCIAS de un tema (migracion 0108).

    Los mensajes propios no lo necesitan: su chat ya tiene
    `conversation_members.last_read_at`. Las referencias no viven en ese chat,
    y por eso llevan su propia marca.
    """

    __tablename__ = "conversation_topic_views"
    __table_args__ = (Index("conversation_topic_views_user_idx", "user_id"),)

    topic_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("conversation_topics.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    visto_hasta: Mapped[datetime] = mapped_column(DateTime(timezone=True))


#: `group_subgroups` (la 0109) es del Agente C y su modelo vive en
#: `subgrupos.py`. Aqui solo hace falta saber si una conversacion ES una
#: comunidad, y para eso basta esta descripcion minima de la tabla: importar
#: su modelo ataria este fichero al otro. El tipo `Uuid` no es adorno: en el
#: SQLite de las pruebas un identificador se guarda sin guiones, y una columna
#: sin tipo lo compararia con guiones y no encontraria nada.
_COMUNIDADES = table("group_subgroups", column("conversation_id", Uuid(as_uuid=False)))


# --------------------------------------------------------------------------- #
# Esquemas de la API
# --------------------------------------------------------------------------- #
def _icono(v: str | None) -> str:
    """Un icono de la lista, o `folder`. Nunca un error: ver `ICONOS`."""
    return v if v in ICONOS else ICONO_POR_OMISION


def _nombre_limpio(v: str) -> str:
    """El nombre como se guarda y se pinta: sin espacios de sobra.

    Es la MISMA limpieza que las etiquetas del CRM (`etiquetas.mostrar`), para
    que «Material  de clase» y «Material de clase» no sean dos temas.
    """
    limpio = etiquetas.mostrar(v)
    if not limpio:
        raise ValueError("El tema necesita un nombre.")
    if len(limpio) > MAX_NOMBRE:
        raise ValueError(f"El nombre de un tema tiene como mucho {MAX_NOMBRE} caracteres.")
    return limpio


class TemaNuevo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: El tope de verdad es `MAX_NOMBRE` DESPUES de limpiar; este solo impide
    #: que alguien mande diez kilobytes de espacios.
    name: str = Field(min_length=1, max_length=200)
    icon: str | None = None

    @field_validator("name")
    @classmethod
    def _nombre(cls, v: str) -> str:
        return _nombre_limpio(v)


class TemaCambiado(BaseModel):
    """Lo que se quiera cambiar de un tema. Lo que no viene, no se toca."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=200)
    icon: str | None = None
    position: int | None = Field(default=None, ge=0, le=10_000)

    @field_validator("name")
    @classmethod
    def _nombre(cls, v: str | None) -> str | None:
        return None if v is None else _nombre_limpio(v)


class UltimoDelTema(BaseModel):
    """Lo ultimo que llego a un tema, para la fila de la lista."""

    sender_name: str = ""
    excerpt: str = ""
    #: El tipo del primer adjunto, `link` si el texto lleva una URL, o `text`.
    kind: str = "text"
    #: Con `kind == "audio"`: si es una nota de voz (`true`, «Nota de voz») o
    #: un archivo de audio (`false`, «Audio»). `excerpt` va vacio en un
    #: mensaje sin texto ni nombre y la etiqueta la pone la aplicacion,
    #: traducida; con solo `kind` no podria distinguir las dos (30/10/2026).
    #: `false` en lo que no es audio; sin la 0113, todo audio es nota de voz.
    voice_note: bool = False
    at: datetime
    #: Es un mensaje propio del tema (`true`) o una referencia a General.
    own: bool = False


class TemaLeido(BaseModel):
    id: str
    name: str
    icon: str = ICONO_POR_OMISION
    position: int = 0
    chat_id: str
    #: Referencias a mensajes VIVOS de General.
    references: int = 0
    #: Mensajes propios VIVOS.
    own: int = 0
    #: Lo que quien pregunta no ha visto. Ver `_leer_temas`.
    unseen: int = 0
    #: Solo si se pregunto por `message_id`: si ese mensaje esta en este tema.
    contains: bool | None = None
    last: UltimoDelTema | None = None


class TemasLeidos(BaseModel):
    #: Hay temas en ESTA conversacion: la 0108 esta aplicada y es un grupo de
    #: primer nivel. Con `false`, la aplicacion no enseña nada de temas.
    available: bool = False
    #: Quien pregunta puede crear, cambiar y borrar temas. Es COMODIDAD para no
    #: pintar botones que responderian 403: el permiso se comprueba otra vez
    #: en cada escritura.
    can_manage: bool = False
    topics: list[TemaLeido] = Field(default_factory=list)


class TemaMensaje(MessageRead):
    """Un mensaje dentro de un tema: `MessageRead` y de donde viene.

    `conversation_id` (heredado) es el DE VERDAD: General si es una
    referencia, el chat del tema si es propio.
    """

    own: bool = False
    #: Quien lo añadio al tema. Solo en las referencias.
    added_by: AuthorSummary | None = None
    added_at: datetime | None = None
    #: Por lo que se ordena: `added_at` en una referencia, `created_at` en uno
    #: propio. Es tambien el cursor (`before`) de la pagina siguiente.
    order_at: datetime


class PaginaDeTema(BaseModel):
    items: list[TemaMensaje] = Field(default_factory=list)
    has_more: bool = False


class ReferenciasNuevas(BaseModel):
    """`PUT …/topics/{topic_id}/items`: varios mensajes de General a la vez."""

    message_ids: list[str] = Field(min_length=1, max_length=MAX_REFERENCIAS_POR_LOTE)

    @field_validator("message_ids")
    @classmethod
    def _sin_repetidos(cls, v: list[str]) -> list[str]:
        # Un repetido no es inofensivo aunque la clave primaria lo absorba: la
        # respuesta diria «1 ya estaba» de algo que nunca estuvo, y la
        # aplicacion contaria mal lo que acaba de hacer. Se comparan en su
        # forma canonica, que el mismo identificador se escribe de varias.
        vistos: set[str] = set()
        for crudo in v:
            clave = str(UUID(str(crudo))) if _es_uuid(crudo) else str(crudo).lower()
            if clave in vistos:
                raise ValueError("Hay mensajes repetidos en la lista.")
            vistos.add(clave)
        return v


class ReferenciasAnadidas(BaseModel):
    #: Los que se acaban de añadir.
    added: int = 0
    #: Los que ya estaban en el tema (no se tocan: conservan su fecha).
    already: int = 0


# --------------------------------------------------------------------------- #
# Ayudantes
# --------------------------------------------------------------------------- #
def _es_uuid(texto: object) -> bool:
    """Si es un identificador bien escrito.

    Las funciones que llaman otros modulos no lanzan: un identificador con
    otro formato llegaria hasta el driver y asyncpg lo convertiria en un 500.
    """
    try:
        UUID(str(texto))
    except (ValueError, AttributeError, TypeError):
        return False
    return True


def _insert_con_conflicto(db: AsyncSession):
    """El `insert` del dialecto, que es el que sabe `on conflict`.

    Igual que `etiquetas._insert_con_conflicto`, y por lo mismo: la
    idempotencia de añadir una referencia o un miembro la da la clave primaria,
    no una comprobacion previa que deja una ventana para el doble toque.
    """
    nombre = db.get_bind().dialect.name
    if nombre == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as insert_pg

        return insert_pg
    if nombre == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as insert_sqlite

        return insert_sqlite
    raise RuntimeError(
        f"Dialecto '{nombre}' sin soporte de `on conflict`: la idempotencia de "
        "los temas depende de el."
    )


async def _exigir_esquema(db: AsyncSession) -> None:
    """503 mientras la 0108 espere aprobacion, nunca un 500."""
    if not await esquema.hay_temas(db):
        raise ServiceUnavailableError(
            "Los temas todavía no están disponibles.", code="topics_unavailable"
        )


async def _es_de_primer_nivel(db: AsyncSession, conversation_id: str, kind: str) -> bool:
    """Si esta conversacion puede tener temas: un grupo que no cuelga de otro.

    No lo es un chat de dos, ni el chat de un tema, ni una comunidad. El chat
    de un tema ELIMINADO tampoco: una vez fue de un tema, no vuelve a ser un
    grupo suelto (no tiene miembros, asi que nadie llega aqui con el, pero la
    regla no depende de eso).
    """
    if kind != "group":
        return False
    if await esquema.hay_temas(db):
        es_chat = (
            await db.execute(
                select(ConversationTopic.id)
                .where(ConversationTopic.chat_id == conversation_id)
                .limit(1)
            )
        ).first()
        if es_chat is not None:
            return False
    if await esquema.hay_comunidades(db):
        es_comunidad = (
            await db.execute(
                select(_COMUNIDADES.c.conversation_id)
                .where(_COMUNIDADES.c.conversation_id == conversation_id)
                .limit(1)
            )
        ).first()
        if es_comunidad is not None:
            return False
    return True


async def _exigir_administrar(db: AsyncSession, group_id: str, uid: str) -> str:
    """Pertenecer, que la 0108 este, que sea de primer nivel y administrarlo.

    En ESE orden. Pertenecer es lo primero: sin eso se podria averiguar que
    identificadores son grupos de verdad por la diferencia entre respuestas.
    Devuelve quien creo el grupo, que es tambien quien firma el chat del tema.
    """
    kind, creador = await vistas.conversacion_de(db, group_id, uid)
    await _exigir_esquema(db)
    if not await _es_de_primer_nivel(db, group_id, kind):
        raise ConflictError(
            "Solo un grupo puede tener temas: no un chat de dos, ni una "
            "comunidad, ni el chat de otro tema.",
            code="not_a_top_level_group",
        )
    if not vistas.administra(kind, creador, uid):
        raise ForbiddenError(
            "Solo quien administra el grupo puede cambiar sus temas.",
            code="topic_admin_only",
        )
    return str(creador)


#: Las columnas de un tema que se leen. EXPLICITAS y no `select(ConversationTopic)`
#: para no depender del mapa de identidad de la sesion: despues de un `update`
#: se quiere lo que dice la base, no el objeto que la sesion ya tenia.
_COLUMNAS = (
    ConversationTopic.id,
    ConversationTopic.conversation_id,
    ConversationTopic.chat_id,
    ConversationTopic.nombre,
    ConversationTopic.nombre_normalizado,
    ConversationTopic.icono,
    ConversationTopic.posicion,
    ConversationTopic.created_at,
    ConversationTopic.deleted_at,
)


async def _tema_vivo(db: AsyncSession, group_id: str, topic_id: str):
    """El tema, si es de ESTE grupo y sigue vivo. Si no, 404.

    El grupo va en el `WHERE` y no en una comprobacion de despues: el tema de
    otro grupo no llega ni a leerse, aunque se conozca su identificador.
    """
    ensure_uuid(topic_id, "Tema no encontrado.")
    fila = (
        await db.execute(
            select(*_COLUMNAS).where(
                ConversationTopic.id == topic_id,
                ConversationTopic.conversation_id == group_id,
                ConversationTopic.deleted_at.is_(None),
            )
        )
    ).one_or_none()
    if fila is None:
        raise NotFoundError("Tema no encontrado.", code="topic_not_found")
    return fila


async def _temas_vivos(db: AsyncSession, group_id: str, *, solo: str | None = None):
    consulta = select(*_COLUMNAS).where(
        ConversationTopic.conversation_id == group_id,
        ConversationTopic.deleted_at.is_(None),
    )
    if solo is not None:
        consulta = consulta.where(ConversationTopic.id == solo)
    return (
        await db.execute(
            consulta.order_by(
                ConversationTopic.posicion.asc(),
                ConversationTopic.created_at.asc(),
                ConversationTopic.id.asc(),
            )
        )
    ).all()


async def _nombre_repetido(
    db: AsyncSession, group_id: str, normalizado: str, *, salvo: str | None = None
) -> bool:
    consulta = select(ConversationTopic.id).where(
        ConversationTopic.conversation_id == group_id,
        ConversationTopic.nombre_normalizado == normalizado,
        ConversationTopic.deleted_at.is_(None),
    )
    if salvo is not None:
        consulta = consulta.where(ConversationTopic.id != salvo)
    return (await db.execute(consulta.limit(1))).first() is not None


_NOMBRE_REPETIDO = "Ya hay un tema con ese nombre en este grupo."


def _extracto(texto: str | None) -> str:
    limpio = " ".join((texto or "").split())
    if len(limpio) <= MAX_EXTRACTO:
        return limpio
    return limpio[: MAX_EXTRACTO - 1].rstrip() + "…"


def _nombre_visible(full_name: str | None, username: str | None) -> str:
    return (full_name or "").strip() or username or ""


async def _primer_adjunto(
    db: AsyncSession, message_ids: list[str]
) -> dict[str, tuple[str, str | None, bool]]:
    """Tipo, nombre y si es nota de voz (0113) del PRIMER adjunto de cada mensaje. Una consulta.

    Sin la 0113 el nombre es `None` y todo audio es nota de voz: las columnas
    no se nombran.
    """
    if not message_ids or not await esquema.hay_adjuntos_de_chat(db):
        return {}
    con_nombres = await esquema.hay_nombres_de_adjuntos(db)
    filas = await db.execute(
        select(
            MessageAttachment.message_id,
            MessageAttachment.kind,
            *((TITULO_DE_ADJUNTO, ES_NOTA_DE_VOZ) if con_nombres else ()),
        )
        .where(MessageAttachment.message_id.in_(message_ids))
        .order_by(MessageAttachment.sort_order.asc(), MessageAttachment.id.asc())
    )
    salida: dict[str, tuple[str, str | None, bool]] = {}
    for fila in filas:
        salida.setdefault(
            fila.message_id,
            (
                fila.kind,
                fila.title if con_nombres else None,
                bool(fila.voice_note) if con_nombres else fila.kind == "audio",
            ),
        )
    return salida


def _consulta_no_vistos_propios(uid: str):
    """«Mensajes propios de temas vivos que esta persona no ha visto», por chat.

    LA REGLA (§ 4.1): de OTRA persona, vivos, y posteriores a su
    `last_read_at` en el chat del tema. Si nunca lo abrio, cuenta desde que
    entro (`joined_at`): quien llega nuevo empieza en cero y no hereda como
    «no leido» todo lo que se escribio antes de que estuviera.

    ES LA MISMA REGLA, LETRA POR LETRA, QUE `lectura.temas_de_la_pagina`, que
    suma esto mismo a `total_unread` en la bandeja por lotes. Si divergieran,
    el numero del grupo en la bandeja y el de sus temas dentro no cuadrarian.
    Por eso:

      * el `joined_at` es el de su fila en el CHAT DEL TEMA. Es el mismo
        instante que su entrada al grupo —se copia al crear el tema y lo pone
        `sincronizar_miembros` al entrar, en la misma transaccion— y no
        obliga a otro JOIN;
      * con `>=` y no `>`: en SQLite la marca tiene resolucion de segundo, y
        lo escrito en el mismo segundo en que se entro se perderia;
      * sin fila en el chat no se cuenta nada. Si faltara, `seen` la repone.
    """
    return (
        select(Message.conversation_id, func.count().label("total"))
        .join(ConversationTopic, ConversationTopic.chat_id == Message.conversation_id)
        .join(
            ConversationMember,
            and_(
                ConversationMember.conversation_id == Message.conversation_id,
                ConversationMember.user_id == uid,
            ),
        )
        .where(
            ConversationTopic.deleted_at.is_(None),
            Message.sender_id != uid,
            Message.deleted_at.is_(None),
            or_(
                and_(
                    ConversationMember.last_read_at.is_(None),
                    Message.created_at >= ConversationMember.joined_at,
                ),
                Message.created_at > ConversationMember.last_read_at,
            ),
        )
        .group_by(Message.conversation_id)
    )


async def _leer_temas(
    db: AsyncSession, group_id: str, uid: str, filas, message_id: str | None = None
) -> list[TemaLeido]:
    """Las filas de tema, como respuesta. Consultas CONSTANTES, no por tema.

    Cuentas, no vistos, lo ultimo de cada tema y `contains` salen con un `IN`
    o un `GROUP BY` sobre todos los temas a la vez: la lista cuesta lo mismo
    con un tema que con veinte. Es la leccion de `lectura.py`.

    `unseen` suma (§ 4.1):
      * las referencias que añadio OTRA persona despues de su `visto_hasta`
        —o, si nunca abrio el tema, despues de entrar al grupo—;
      * los mensajes propios de OTRA persona que no ha leido
        (`_consulta_no_vistos_propios`).
    """
    if not filas:
        return []
    ids = [str(fila.id) for fila in filas]
    chats = [str(fila.chat_id) for fila in filas]
    item = ConversationTopicItem

    # Cuantas referencias VIVAS tiene cada tema. El grupo va en el WHERE por
    # si alguna vez una fila apuntara fuera de General: no se cuenta.
    referencias = {
        str(topic): int(total)
        for topic, total in await db.execute(
            select(item.topic_id, func.count())
            .join(Message, Message.id == item.message_id)
            .where(
                item.topic_id.in_(ids),
                Message.conversation_id == group_id,
                Message.deleted_at.is_(None),
            )
            .group_by(item.topic_id)
        )
    }

    # Cuantos mensajes propios VIVOS tiene cada chat de tema. EXACTO, sin tope:
    # la aplicacion lo escribe tal cual («37 escritos aqui») y lo repite al
    # pedir confirmacion para eliminar el tema.
    #
    # Lo contesta el indice parcial `messages_vivos_idx` (0111) sin abrir la
    # tabla: guarda `(conversation_id, created_at)` de los mensajes vivos, que
    # es todo lo que esta consulta mira. Una condicion mas sobre otra columna
    # (el autor, el texto) obligaria a visitar cada fila del chat otra vez.
    propios = {
        str(chat): int(total)
        for chat, total in await db.execute(
            select(Message.conversation_id, func.count())
            .where(Message.conversation_id.in_(chats), Message.deleted_at.is_(None))
            .group_by(Message.conversation_id)
        )
    }

    # Las referencias que no ha visto: de otra persona y posteriores a su
    # marca, o a su entrada al GRUPO si nunca abrio el tema (las referencias
    # no viven en el chat del tema, asi que aqui la fila es la del grupo). El
    # `>=` con `joined_at`, por lo mismo que en `_consulta_no_vistos_propios`.
    # `added_by` nulo (el perfil que la añadio ya no existe) cuenta como «otra
    # persona».
    en_el_grupo = aliased(ConversationMember)
    no_vistas = {
        str(topic): int(total)
        for topic, total in await db.execute(
            select(item.topic_id, func.count())
            .join(Message, Message.id == item.message_id)
            .join(
                en_el_grupo,
                and_(
                    en_el_grupo.conversation_id == item.conversation_id,
                    en_el_grupo.user_id == uid,
                ),
            )
            .outerjoin(
                ConversationTopicView,
                and_(
                    ConversationTopicView.topic_id == item.topic_id,
                    ConversationTopicView.user_id == uid,
                ),
            )
            .where(
                item.topic_id.in_(ids),
                Message.conversation_id == group_id,
                Message.deleted_at.is_(None),
                or_(item.added_by.is_(None), item.added_by != uid),
                or_(
                    and_(
                        ConversationTopicView.visto_hasta.is_(None),
                        item.added_at >= en_el_grupo.joined_at,
                    ),
                    item.added_at > ConversationTopicView.visto_hasta,
                ),
            )
            .group_by(item.topic_id)
        )
    }

    propios_no_vistos = {
        str(chat): int(total)
        for chat, total in await db.execute(
            _consulta_no_vistos_propios(uid).where(Message.conversation_id.in_(chats))
        )
    }

    # La ultima referencia viva de cada tema, con una ventana: un `LIMIT 1`
    # por tema seria el N+1 de siempre.
    orden = (
        func.row_number()
        .over(
            partition_by=item.topic_id,
            order_by=(item.added_at.desc(), item.message_id.desc()),
        )
        .label("posicion")
    )
    numeradas = (
        select(
            item.topic_id.label("topic_id"),
            item.message_id.label("message_id"),
            item.added_at.label("at"),
            orden,
        )
        .join(Message, Message.id == item.message_id)
        .where(
            item.topic_id.in_(ids),
            Message.conversation_id == group_id,
            Message.deleted_at.is_(None),
        )
        .subquery()
    )
    ultima_referencia = {
        str(fila.topic_id): fila
        for fila in await db.execute(
            select(numeradas.c.topic_id, numeradas.c.message_id, numeradas.c.at).where(
                numeradas.c.posicion == 1
            )
        )
    }
    # Y el ultimo mensaje propio de cada chat, con el mismo lector que la
    # bandeja (ya ignora los borrados).
    ultimo_propio = {
        str(chat): fila for chat, fila in (await lectura.ultimos_mensajes(db, chats)).items()
    }

    # De cada tema, lo mas reciente de las dos cosas. Despues, el texto, el
    # autor y el primer adjunto de esos mensajes, con un `IN` cada uno.
    elegidos: dict[str, tuple[str, datetime, bool]] = {}
    for fila in filas:
        ref = ultima_referencia.get(str(fila.id))
        suyo = ultimo_propio.get(str(fila.chat_id))
        if suyo is not None and (ref is None or suyo.created_at >= ref.at):
            elegidos[str(fila.id)] = (str(suyo.id), suyo.created_at, True)
        elif ref is not None:
            elegidos[str(fila.id)] = (str(ref.message_id), ref.at, False)

    mensajes_ultimos = [mid for mid, _, _ in elegidos.values()]
    textos: dict[str, tuple[str, str]] = {}
    if mensajes_ultimos:
        for mid, body, full_name, username in await db.execute(
            select(Message.id, Message.body, Profile.full_name, Profile.username)
            .join(Profile, Profile.id == Message.sender_id)
            .where(Message.id.in_(mensajes_ultimos))
        ):
            textos[str(mid)] = (body or "", _nombre_visible(full_name, username))
    tipos = await _primer_adjunto(db, mensajes_ultimos)

    # `contains`: en que temas esta ese mensaje. Un identificador mal escrito
    # no es un error aqui: simplemente no esta en ninguno.
    contiene: set[str] | None = None
    if message_id is not None:
        contiene = set()
        if _es_uuid(message_id):
            contiene = {
                str(topic)
                for topic in (
                    await db.execute(
                        select(item.topic_id).where(
                            item.message_id == message_id, item.topic_id.in_(ids)
                        )
                    )
                ).scalars()
            }

    salida: list[TemaLeido] = []
    for fila in filas:
        tid, chat = str(fila.id), str(fila.chat_id)
        ultimo: UltimoDelTema | None = None
        if tid in elegidos and elegidos[tid][0] in textos:
            mid, cuando, es_propio = elegidos[tid]
            cuerpo, quien = textos[mid]
            primer, titulo, de_voz = tipos.get(mid, (None, None, False))
            ultimo = UltimoDelTema(
                sender_name=quien,
                # Sin texto, el nombre del archivo (0113): «Respiración 4-7-8»
                # en vez de una fila que solo dice el tipo. La misma regla que
                # la bandeja (`lectura._resumen_de_los_sin_texto`).
                excerpt=_extracto(cuerpo) or _extracto(titulo),
                kind=primer or ("link" if _ENLACE.search(cuerpo) else "text"),
                voice_note=primer == "audio" and de_voz,
                at=cuando,
                own=es_propio,
            )
        salida.append(
            TemaLeido(
                id=tid,
                name=fila.nombre,
                icon=_icono(fila.icono),
                position=int(fila.posicion or 0),
                chat_id=chat,
                references=referencias.get(tid, 0),
                own=propios.get(chat, 0),
                unseen=no_vistas.get(tid, 0) + propios_no_vistos.get(chat, 0),
                contains=None if contiene is None else tid in contiene,
                last=ultimo,
            )
        )
    return salida


async def _leer_uno(db: AsyncSession, group_id: str, uid: str, topic_id: str) -> TemaLeido:
    """Un tema recien creado o cambiado, por el MISMO camino que la lista."""
    filas = await _temas_vivos(db, group_id, solo=topic_id)
    if not filas:
        raise NotFoundError("Tema no encontrado.", code="topic_not_found")
    return (await _leer_temas(db, group_id, uid, filas))[0]


# --------------------------------------------------------------------------- #
# Lo que este fichero ofrece a los demas modulos (§ 4.1, firmas cerradas)
# --------------------------------------------------------------------------- #
async def tema_de_chat(db: AsyncSession, conversation_id: str) -> tuple[str, str] | None:
    """(group_id, topic_id) si es el chat de un tema vivo; si no, None. Sin la 0108, None.

    Lo usan quien decide si se puede escribir en una conversacion (solo la
    administracion escribe en un tema) y quien arma `GET /{id}/info`, para que
    un aviso abra el tema y no un chat suelto. Un identificador mal escrito es
    `None`, no un error.
    """
    if not _es_uuid(conversation_id) or not await esquema.hay_temas(db):
        return None
    fila = (
        await db.execute(
            select(ConversationTopic.conversation_id, ConversationTopic.id)
            .where(
                ConversationTopic.chat_id == conversation_id,
                ConversationTopic.deleted_at.is_(None),
            )
            .limit(1)
        )
    ).first()
    if fila is None:
        return None
    return str(fila[0]), str(fila[1])


async def chats_de_temas(db: AsyncSession, group_id: str) -> list[str]:
    """chat_id de los temas vivos del grupo. Sin la 0108, [].

    En el orden de la lista de temas, para que quien los recorra lo haga
    siempre igual.
    """
    if not _es_uuid(group_id) or not await esquema.hay_temas(db):
        return []
    filas = await db.execute(
        select(ConversationTopic.chat_id)
        .where(
            ConversationTopic.conversation_id == group_id,
            ConversationTopic.deleted_at.is_(None),
        )
        .order_by(
            ConversationTopic.posicion.asc(),
            ConversationTopic.created_at.asc(),
            ConversationTopic.id.asc(),
        )
    )
    return [str(chat) for chat in filas.scalars()]


def condicion_no_es_chat_de_tema(columna) -> ColumnElement[bool]:
    """NOT EXISTS sobre conversation_topics.chat_id. Quien la usa comprueba antes hay_temas().

    Es una CONDICION y no una lista, como `etiquetas.condicion_de_etiqueta`:
    entra en el `WHERE` de quien la usa (la bandeja) y la paginacion sigue
    contando las filas que de verdad quedan.

    NO MIRA `deleted_at`, a proposito: el chat de un tema eliminado tampoco es
    un grupo suelto. Se queda sin miembros al eliminarlo, asi que no saldria
    en ninguna bandeja de todas formas; esto lo asegura aunque algo fallara.

    Sin la 0108 la tabla no existe y esta condicion reventaria: por eso quien
    la usa pregunta antes `esquema.hay_temas()`, igual que con cualquier otra
    tabla nueva.
    """
    return ~(
        select(ConversationTopic.chat_id)
        .where(ConversationTopic.chat_id == columna)
        .exists()
    )


async def sincronizar_miembros(
    db: AsyncSession, group_id: str, user_ids: list[str], dentro: bool
) -> None:
    """Mete o saca a esas personas de los chats de TODOS los temas vivos del grupo.
    Sin commit: lo hace quien llama, en su transaccion. Sin la 0108, no hace nada.

    POR QUE EN LA TRANSACCION DE QUIEN LLAMA. Entrar al grupo y entrar a sus
    temas son UN hecho: si se guardara uno y no el otro, quedaria alguien en
    el grupo sin poder reaccionar en sus temas, o —peor— alguien fuera del
    grupo que sigue recibiendo los avisos de sus temas (D10).

    METER ES IDEMPOTENTE (`on conflict do nothing`): quien ya estaba se queda
    como estaba, con su `last_read_at`. Quien entra lo hace sin
    `last_read_at`, y sus no leidos cuentan desde que entro al grupo (ver
    `_consulta_no_vistos_propios`): empieza en cero.

    SACAR NO TOCA SUS MENSAJES, igual que salir de un grupo.
    """
    personas = [str(p) for p in dict.fromkeys(user_ids) if _es_uuid(p)]
    if not personas:
        return
    chats = await chats_de_temas(db, group_id)
    if not chats:
        return
    if dentro:
        inserta = _insert_con_conflicto(db)
        await db.execute(
            # La TABLA y no la entidad: es un `insert` de Core con su
            # `on conflict`, sin el camino de las altas por lotes del ORM.
            inserta(ConversationMember.__table__)
            .values(
                [
                    {"conversation_id": chat, "user_id": persona}
                    for chat in chats
                    for persona in personas
                ]
            )
            .on_conflict_do_nothing(index_elements=["conversation_id", "user_id"])
        )
    else:
        await db.execute(
            delete(ConversationMember).where(
                ConversationMember.conversation_id.in_(chats),
                ConversationMember.user_id.in_(personas),
            )
        )


async def no_leidos_de_temas(db: AsyncSession, group_id: str, uid: str) -> int:
    """Mensajes propios de temas, de otras personas, posteriores a su last_read_at. Sin la 0108, 0.

    Es lo que la bandeja suma al `total_unread` de un grupo. Las REFERENCIAS no
    cuentan aqui: no son mensajes nuevos, son mensajes de General que ya
    contaron alli. Quien nunca abrio un tema cuenta desde que entro al grupo,
    con la misma regla que `unseen` (`_consulta_no_vistos_propios`).
    """
    if not _es_uuid(group_id) or not await esquema.hay_temas(db):
        return 0
    por_chat = _consulta_no_vistos_propios(uid).where(
        ConversationTopic.conversation_id == group_id
    ).subquery()
    total = await db.scalar(select(func.coalesce(func.sum(por_chat.c.total), 0)))
    return int(total or 0)


async def temas_por_mensaje(
    db: AsyncSession, group_id: str, message_ids: list[str]
) -> dict[str, list[TemaBreve]]:
    """En que temas VIVOS esta cada mensaje de General. UNA consulta. Sin la 0108, {}.

    Es lo que pinta la etiqueta bajo cada burbuja (`MessageRead.topics`). Se
    pide para la PAGINA ENTERA con un `IN`, por el indice
    `conversation_topic_items_message_idx`, como los adjuntos y las
    reacciones: una consulta por burbuja convertiria abrir General en treinta
    viajes a la base.

    EL GRUPO VA EN EL `WHERE` DOS VECES —la referencia y el tema—, y no es
    redundancia: aunque alguien pidiera aqui mensajes de otra conversacion,
    los temas de otra comunidad no llegan ni a leerse. Un tema eliminado no
    cuenta. Cada lista sale en el orden de la lista de temas, para que «En 2
    temas» los enseñe siempre igual.

    Un mensaje sin temas no sale en el diccionario: quien lo usa pone `[]`.
    """
    ids = [str(m) for m in dict.fromkeys(message_ids) if _es_uuid(m)]
    if not ids or not _es_uuid(group_id) or not await esquema.hay_temas(db):
        return {}
    item = ConversationTopicItem
    filas = await db.execute(
        select(item.message_id, ConversationTopic.id, ConversationTopic.nombre)
        .join(ConversationTopic, ConversationTopic.id == item.topic_id)
        # El mensaje, por su clave primaria: que sea de General y siga vivo.
        # Un mensaje borrado sale como lapida y una lapida no lleva etiqueta,
        # igual que no lleva adjuntos; y dentro del tema ya no aparece.
        .join(Message, Message.id == item.message_id)
        .where(
            item.message_id.in_(ids),
            item.conversation_id == group_id,
            ConversationTopic.conversation_id == group_id,
            ConversationTopic.deleted_at.is_(None),
            Message.conversation_id == group_id,
            Message.deleted_at.is_(None),
        )
        .order_by(
            ConversationTopic.posicion.asc(),
            ConversationTopic.created_at.asc(),
            ConversationTopic.id.asc(),
        )
    )
    salida: dict[str, list[TemaBreve]] = {}
    for mensaje, tema, nombre in filas:
        salida.setdefault(str(mensaje), []).append(TemaBreve(id=str(tema), name=nombre))
    return salida


def condicion_en_el_tema(topic_id: str) -> ColumnElement[bool]:
    """EXISTS: el mensaje (`Message`, de la consulta de fuera) esta en ese tema.

    Para el filtro por tema de Contenido (`vistas.py`). Quien la usa ya
    comprobo que el tema es de su grupo y esta vivo.
    """
    return (
        select(ConversationTopicItem.message_id)
        .where(
            ConversationTopicItem.topic_id == topic_id,
            ConversationTopicItem.message_id == Message.id,
        )
        .correlate(Message)
        .exists()
    )


def condicion_sin_tema(group_id: str) -> ColumnElement[bool]:
    """NOT EXISTS: el mensaje no esta en NINGUN tema vivo de ese grupo.

    UNA SOLA DEFINICION para la lista «Sin tema» y para su cuenta: si la cuenta
    dijera 3 y la lista trajera 4, el numero estaria mintiendo (lo mismo que
    `vistas._con_enlace`). Un mensaje que solo estaba en un tema eliminado
    vuelve a estar «sin tema»: ese tema ya no lo ordena. Quien la usa pregunta
    antes `esquema.hay_temas`.
    """
    return ~(
        select(ConversationTopicItem.message_id)
        .join(ConversationTopic, ConversationTopic.id == ConversationTopicItem.topic_id)
        .where(
            ConversationTopicItem.message_id == Message.id,
            ConversationTopicItem.conversation_id == group_id,
            ConversationTopic.deleted_at.is_(None),
        )
        .correlate(Message)
        .exists()
    )


async def tema_vivo_del_grupo(db: AsyncSession, group_id: str, topic_id: str):
    """El tema, si es de ese grupo y sigue vivo; si no, 404 `topic_not_found`.

    Para quien filtra por tema desde fuera de este fichero. Sin la 0108
    tampoco hay ninguno: el mismo 404, no un 500.
    """
    if not _es_uuid(topic_id) or not await esquema.hay_temas(db):
        raise NotFoundError("Tema no encontrado.", code="topic_not_found")
    return await _tema_vivo(db, group_id, topic_id)


# --------------------------------------------------------------------------- #
# Rutas — los temas
# --------------------------------------------------------------------------- #
@router.get("/{group_id}/topics", response_model=TemasLeidos)
async def listar_temas(
    group_id: str,
    message_id: str | None = Query(default=None, max_length=64),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TemasLeidos:
    """Los temas vivos del grupo, en su orden. Para todos sus miembros.

    Sin paginar, como las etiquetas: `MAX_TEMAS_POR_GRUPO` ata la lista, asi
    que la respuesta ES la lista entera.

    Con `message_id`, cada tema dice si ese mensaje esta en el (`contains`):
    es lo que pinta las marcas del menú «Añadir a un tema» de un mensaje.

    SIN LA 0108, o si la conversacion no puede tener temas (un chat de dos,
    una comunidad, el chat de un tema), responde vacio con `available: false`.
    No es un error: aqui no hay temas, y eso es lo que significa.
    """
    uid = current_user.id
    kind, creador = await vistas.conversacion_de(db, group_id, uid)
    if not await esquema.hay_temas(db) or not await _es_de_primer_nivel(db, group_id, kind):
        return TemasLeidos(available=False)
    filas = await _temas_vivos(db, group_id)
    return TemasLeidos(
        available=True,
        can_manage=vistas.administra(kind, creador, uid),
        topics=await _leer_temas(db, group_id, uid, filas, message_id),
    )


@router.get("/{group_id}/topics/of-messages", response_model=dict[str, list[TemaBreve]])
async def temas_de_los_mensajes(
    group_id: str,
    ids: str = Query(default="", max_length=4000),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, list[TemaBreve]]:
    """En que temas esta cada uno de esos mensajes: `{"<message_id>": [{id, name}]}`.

    PARA REFRESCAR LAS ETIQUETAS de lo que ya esta en pantalla cuando llega
    el aviso `chat-temas:{grupo}` (alguien añadio o quito un mensaje de un
    tema), sin volver a pedir el historial. Lo puede pedir cualquier miembro:
    las etiquetas las ven todos.

    TODOS LOS PEDIDOS SALEN EN LA RESPUESTA, con `[]` si no estan en ningun
    tema: es lo que le dice a la aplicacion que quite una etiqueta. Y salen
    igual de vacios los que no son de General de esta comunidad (de otro
    chat, de otro grupo, borrados o inventados): la respuesta no distingue
    «no esta en ningun tema» de «no es de aqui», asi que no sirve para
    averiguar nada de otra conversacion. Un identificador mal escrito se
    ignora. Las claves van en su forma canonica (minusculas, con guiones),
    que es como la API escribe los identificadores.

    Hasta `MAX_MENSAJES_POR_CONSULTA` identificadores separados por comas; mas,
    422. Sin la 0108, todos con `[]`: no hay temas.
    """
    await vistas.conversacion_de(db, group_id, current_user.id)
    pedidos = [p.strip() for p in ids.split(",") if p.strip()]
    if len(pedidos) > MAX_MENSAJES_POR_CONSULTA:
        raise ValidationAppError(
            f"Se pueden consultar hasta {MAX_MENSAJES_POR_CONSULTA} mensajes a la vez."
        )
    validos = list(dict.fromkeys(str(UUID(p)) for p in pedidos if _es_uuid(p)))
    encontrados = await temas_por_mensaje(db, group_id, validos)
    return {mid: encontrados.get(mid, []) for mid in validos}


@router.post(
    "/{group_id}/topics",
    response_model=TemaLeido,
    status_code=status.HTTP_201_CREATED,
)
async def crear_tema(
    group_id: str,
    payload: TemaNuevo,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TemaLeido:
    """Crea un tema y su chat propio, con los miembros del grupo dentro.

    TODO EN UNA TRANSACCION: el chat, sus miembros y la fila del tema. Un chat
    sin tema saldria suelto en la bandeja de todos como un grupo mas; un tema
    sin miembros en su chat no dejaria reaccionar a nadie.

    El chat lo firma quien CREO EL GRUPO (`created_by`), que es quien
    administra: asi `vistas.administra` sobre el chat del tema dice lo mismo
    que sobre el grupo, sin una regla aparte.

    EL NOMBRE REPETIDO LO DECIDE AL FINAL LA BASE: la comprobacion de antes da
    un mensaje legible, y dos altas a la vez con el mismo nombre las para el
    indice unico de la 0108.
    """
    uid = current_user.id
    creador = await _exigir_administrar(db, group_id, uid)
    nombre = payload.name
    normalizado = etiquetas.normalizar(nombre)

    cuantos, ultima = (
        await db.execute(
            select(
                func.count(ConversationTopic.id),
                func.coalesce(func.max(ConversationTopic.posicion), -1),
            ).where(
                ConversationTopic.conversation_id == group_id,
                ConversationTopic.deleted_at.is_(None),
            )
        )
    ).one()
    if cuantos >= MAX_TEMAS_POR_GRUPO:
        raise ConflictError(
            f"Un grupo puede tener hasta {MAX_TEMAS_POR_GRUPO} temas.",
            code="topics_limit",
        )
    if await _nombre_repetido(db, group_id, normalizado):
        raise ConflictError(_NOMBRE_REPETIDO, code="topic_name_taken")

    miembros = list(
        (
            await db.execute(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == group_id
                )
            )
        ).scalars()
    )
    chat_id = _uuid()
    topic_id = _uuid()
    try:
        # `insert().values()` y no `db.add(Conversation(...))`: el segundo
        # inserta TODAS las columnas mapeadas, y el dia que el modelo se
        # adelante a una migracion dejaria de poder escribir.
        await db.execute(
            insert(Conversation).values(
                id=chat_id, kind="group", title=nombre, created_by=creador
            )
        )
        if miembros:
            await db.execute(
                insert(ConversationMember.__table__).values(
                    [{"conversation_id": chat_id, "user_id": m} for m in miembros]
                )
            )
        await db.execute(
            insert(ConversationTopic).values(
                id=topic_id,
                conversation_id=group_id,
                chat_id=chat_id,
                nombre=nombre,
                nombre_normalizado=normalizado,
                icono=_icono(payload.icon),
                posicion=int(ultima) + 1,
                # La identidad sale del JWT. Nunca de la peticion.
                created_by=uid,
            )
        )
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise ConflictError(_NOMBRE_REPETIDO, code="topic_name_taken") from None

    return await _leer_uno(db, group_id, uid, topic_id)


@router.patch("/{group_id}/topics/{topic_id}", response_model=TemaLeido)
async def cambiar_tema(
    group_id: str,
    topic_id: str,
    payload: TemaCambiado,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TemaLeido:
    """Cambia el nombre, el icono o la posicion de un tema.

    Renombrar cambia TAMBIEN el titulo de su chat: es el que sale en el aviso
    de un mensaje del tema («Ana envio un mensaje al grupo «Anuncios»»), y un
    aviso con el nombre viejo mandaria a buscar un tema que ya no se llama asi.
    En produccion el trigger `conversations_set_updated_at` (0001) sube el
    `updated_at` del chat con cualquier cambio; aqui da igual, porque el chat
    de un tema no sale en la bandeja y nada se ordena por esa fecha.
    """
    uid = current_user.id
    await _exigir_administrar(db, group_id, uid)
    tema = await _tema_vivo(db, group_id, topic_id)

    cambios: dict[str, object] = {}
    nuevo_nombre: str | None = None
    if payload.name is not None and payload.name != tema.nombre:
        normalizado = etiquetas.normalizar(payload.name)
        if normalizado != tema.nombre_normalizado and await _nombre_repetido(
            db, group_id, normalizado, salvo=str(tema.id)
        ):
            raise ConflictError(_NOMBRE_REPETIDO, code="topic_name_taken")
        nuevo_nombre = payload.name
        cambios["nombre"] = payload.name
        cambios["nombre_normalizado"] = normalizado
    if payload.icon is not None:
        cambios["icono"] = _icono(payload.icon)
    if payload.position is not None:
        cambios["posicion"] = payload.position

    if cambios:
        try:
            await db.execute(
                update(ConversationTopic)
                .where(
                    ConversationTopic.id == tema.id,
                    ConversationTopic.conversation_id == group_id,
                )
                .values(**cambios)
            )
            if nuevo_nombre is not None:
                await db.execute(
                    update(Conversation)
                    .where(Conversation.id == tema.chat_id)
                    .values(title=nuevo_nombre)
                )
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise ConflictError(_NOMBRE_REPETIDO, code="topic_name_taken") from None

    return await _leer_uno(db, group_id, uid, str(tema.id))


@router.delete(
    "/{group_id}/topics/{topic_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def eliminar_tema(
    group_id: str,
    topic_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Elimina un tema (D15). Borrado suave, todo en una transaccion.

    Tres cosas, y ninguna toca General:
      * se marca `deleted_at` en el tema;
      * se borran EN SUAVE los mensajes de su chat: lo escrito solo en el tema
        se queda en la base, como cualquier mensaje borrado, pero ya no se
        entrega;
      * se quitan todos los miembros de su chat, para que nadie siga
        recibiendo sus avisos ni pueda escribir en el.

    Las referencias se quedan como estaban: el tema ya no se lee, y los
    mensajes de General a los que apuntaban siguen en General.

    IDEMPOTENTE: eliminar un tema ya eliminado responde 204. Uno que nunca fue
    de este grupo es 404.
    """
    uid = current_user.id
    await _exigir_administrar(db, group_id, uid)
    ensure_uuid(topic_id, "Tema no encontrado.")
    tema = (
        await db.execute(
            select(ConversationTopic.chat_id, ConversationTopic.deleted_at).where(
                ConversationTopic.id == topic_id,
                ConversationTopic.conversation_id == group_id,
            )
        )
    ).one_or_none()
    if tema is None:
        raise NotFoundError("Tema no encontrado.", code="topic_not_found")
    if tema.deleted_at is not None:
        return

    await db.execute(
        update(ConversationTopic)
        .where(ConversationTopic.id == topic_id, ConversationTopic.deleted_at.is_(None))
        .values(deleted_at=func.now())
    )
    await db.execute(
        update(Message)
        .where(Message.conversation_id == tema.chat_id, Message.deleted_at.is_(None))
        .values(deleted_at=func.now())
    )
    await db.execute(
        delete(ConversationMember).where(ConversationMember.conversation_id == tema.chat_id)
    )
    await db.commit()


# --------------------------------------------------------------------------- #
# Rutas — leer un tema
# --------------------------------------------------------------------------- #
@router.get("/{group_id}/topics/{topic_id}/messages", response_model=PaginaDeTema)
async def mensajes_del_tema(
    group_id: str,
    topic_id: str,
    before: datetime | None = Query(default=None),
    limit: int = Query(default=PAGINA_POR_OMISION, ge=1, le=PAGINA_MAXIMA),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeTema:
    """Lo que hay en un tema: referencias y mensajes propios, MEZCLADOS.

    El orden es el de llegada al tema (`order_at`): `added_at` en una
    referencia —cuando se añadio, no cuando se escribio— y `created_at` en un
    mensaje propio. Se devuelven los `limit` mas recientes con
    `order_at < before`, de antiguo a reciente, como el historial del chat.

    LA MEZCLA SE HACE EN LA BASE, con un `UNION ALL` de las dos partes, cada
    una ya recortada a `limit + 1` por su indice. Mezclar en Python obligaria a
    traer las dos listas enteras para poder paginar.

    LO BORRADO NO SALE: ni una referencia a un mensaje que su autor borro en
    General, ni un mensaje propio borrado. Un tema es una seleccion, y una
    lapida en ella seria ruido.

    NO SE APLICA EL VACIADO DE GENERAL (D3): quien vacio General para si lo
    hizo para ese chat, no para los temas.

    Sin la 0108 responde vacio: no hay temas que leer.
    """
    uid = current_user.id
    await vistas.conversacion_de(db, group_id, uid)
    if not await esquema.hay_temas(db):
        return PaginaDeTema()
    tema = await _tema_vivo(db, group_id, topic_id)
    item = ConversationTopicItem

    # Las dos partes dan solo (mensaje, instante). De cual viene cada fila se
    # sabe despues por su `conversation_id`, que es General o el chat del tema:
    # una columna constante dentro de un UNION llega a PostgreSQL como un
    # parametro sin tipo, que se lee como texto, y `'0'` en Python es verdad.
    referencias = (
        select(Message.id.label("mid"), item.added_at.label("order_at"))
        .select_from(item)
        .join(Message, Message.id == item.message_id)
        .where(
            item.topic_id == tema.id,
            # Solo mensajes de General: por si alguna fila apuntara fuera.
            Message.conversation_id == group_id,
            Message.deleted_at.is_(None),
        )
    )
    propios = select(
        Message.id.label("mid"), Message.created_at.label("order_at")
    ).where(Message.conversation_id == tema.chat_id, Message.deleted_at.is_(None))
    if before is not None:
        referencias = referencias.where(item.added_at < before)
        propios = propios.where(Message.created_at < before)

    # Cada parte ya ordenada y recortada: la pagina no puede necesitar mas de
    # `limit + 1` filas de ninguna de las dos. Van en subconsultas porque
    # SQLite no admite `ORDER BY` / `LIMIT` dentro de las ramas de un UNION.
    de_referencias = referencias.order_by(
        item.added_at.desc(), Message.id.desc()
    ).limit(limit + 1).subquery()
    de_propios = propios.order_by(
        Message.created_at.desc(), Message.id.desc()
    ).limit(limit + 1).subquery()
    mezcla = union_all(
        select(de_referencias.c.mid, de_referencias.c.order_at),
        select(de_propios.c.mid, de_propios.c.order_at),
    ).subquery()
    filas = (
        await db.execute(
            select(mezcla.c.mid, mezcla.c.order_at)
            # El identificador desempata: dos cosas con el mismo instante no
            # pueden cambiar de orden entre una peticion y la siguiente.
            .order_by(mezcla.c.order_at.desc(), mezcla.c.mid.desc())
            # Uno de mas: es lo que dice si hay pagina siguiente sin contar.
            .limit(limit + 1)
        )
    ).all()
    has_more = len(filas) > limit
    filas = filas[:limit]
    if not filas:
        return PaginaDeTema(has_more=False)

    ids = [str(fila.mid) for fila in filas]
    mensajes = {
        str(fila.id): fila
        for fila in await db.execute(
            select(
                Message.id,
                Message.conversation_id,
                Message.body,
                Message.created_at,
                Profile.id.label("pid"),
                Profile.full_name,
                Profile.username,
                Profile.avatar_path,
            )
            .join(Profile, Profile.id == Message.sender_id)
            .where(Message.id.in_(ids))
        )
    }
    # Propio es lo que vive en el chat del tema; lo demas viene de General.
    chat_del_tema = str(tema.chat_id)
    de_referencia = [
        mid
        for mid, mensaje in mensajes.items()
        if str(mensaje.conversation_id) != chat_del_tema
    ]

    # Quien añadio cada referencia y cuando. `outer join`: si su perfil ya no
    # existe, la referencia sigue saliendo, sin autor.
    anadidas: dict[str, tuple[AuthorSummary | None, datetime]] = {}
    if de_referencia:
        for fila in await db.execute(
            select(
                item.message_id,
                item.added_at,
                Profile.id.label("pid"),
                Profile.full_name,
                Profile.username,
                Profile.avatar_path,
            )
            .outerjoin(Profile, Profile.id == item.added_by)
            .where(item.topic_id == tema.id, item.message_id.in_(de_referencia))
        ):
            autor = (
                AuthorSummary(
                    id=fila.pid,
                    full_name=fila.full_name or "",
                    username=fila.username,
                    avatar_path=fila.avatar_path,
                )
                if fila.pid is not None
                else None
            )
            anadidas[str(fila.message_id)] = (autor, fila.added_at)

    # Lo que cuelga de los mensajes, en UNA consulta por cosa para toda la
    # pagina, con los mismos lectores que el historial del chat.
    adjuntos = await lectura.adjuntos_por_mensaje(db, ids)
    de_historia = await historias.contextos_por_mensaje(db, ids)
    de_sesion = await sesiones.contextos_por_mensaje(db, ids, uid)
    reacciones_de = await reacciones.reacciones_por_mensaje(db, ids, uid)
    citas = await reacciones.respuestas_por_mensaje(db, ids)
    # En que temas esta cada REFERENCIA (las de General), para que su
    # etiqueta diga tambien aqui «En 2 temas». Los propios no estan en ninguno:
    # un tema solo referencia mensajes de General. Sin referencias, ni se pide.
    de_temas = await temas_por_mensaje(db, group_id, de_referencia)

    items: list[TemaMensaje] = []
    for fila in reversed(filas):
        mid = str(fila.mid)
        mensaje = mensajes.get(mid)
        if mensaje is None:
            # Sin perfil de autor no hay burbuja que pintar; el historial del
            # chat hace lo mismo (su JOIN con `profiles` es interior).
            continue
        es_propio = str(mensaje.conversation_id) == chat_del_tema
        autor, anadida = (None, None) if es_propio else anadidas.get(mid, (None, None))
        items.append(
            TemaMensaje(
                id=mid,
                conversation_id=str(mensaje.conversation_id),
                sender=AuthorSummary(
                    id=mensaje.pid,
                    full_name=mensaje.full_name or "",
                    username=mensaje.username,
                    avatar_path=mensaje.avatar_path,
                ),
                body=mensaje.body,
                created_at=mensaje.created_at,
                attachments=adjuntos.get(mid, []),
                story_context=de_historia.get(mid),
                booking_context=de_sesion.get(mid),
                reactions=reacciones_de.get(mid, []),
                reply_to=citas.get(mid),
                topics=de_temas.get(mid, []),
                own=es_propio,
                added_by=autor,
                added_at=anadida,
                order_at=fila.order_at,
            )
        )
    return PaginaDeTema(items=items, has_more=has_more)


@router.post(
    "/{group_id}/topics/{topic_id}/seen", status_code=status.HTTP_204_NO_CONTENT
)
async def marcar_tema_visto(
    group_id: str,
    topic_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Quien pregunta ha visto el tema hasta ahora. Pone a cero su `unseen`.

    Dos marcas, porque lo que hay en un tema vive en dos sitios: `visto_hasta`
    para las referencias y `last_read_at` en el chat del tema para los
    mensajes propios —la misma que pone abrir cualquier chat—.

    SI LE FALTA LA FILA EN EL CHAT DEL TEMA, SE LE PONE. Es miembro del grupo
    (se acaba de comprobar), y los miembros del chat de un tema son los del
    grupo; si falta es porque entro por un camino que aun no sincronizaba, y
    sin esa fila no podria reaccionar en el tema.
    """
    uid = current_user.id
    await vistas.conversacion_de(db, group_id, uid)
    await _exigir_esquema(db)
    tema = await _tema_vivo(db, group_id, topic_id)
    inserta = _insert_con_conflicto(db)

    await db.execute(
        inserta(ConversationTopicView.__table__)
        .values(topic_id=tema.id, user_id=uid, visto_hasta=func.now())
        .on_conflict_do_update(
            index_elements=["topic_id", "user_id"], set_={"visto_hasta": func.now()}
        )
    )
    await db.execute(
        inserta(ConversationMember.__table__)
        .values(conversation_id=tema.chat_id, user_id=uid, last_read_at=func.now())
        .on_conflict_do_update(
            index_elements=["conversation_id", "user_id"],
            set_={"last_read_at": func.now()},
        )
    )
    await db.commit()


# --------------------------------------------------------------------------- #
# Rutas — las referencias
# --------------------------------------------------------------------------- #
def _exigir_id_de_mensaje(message_id: str) -> None:
    if not _es_uuid(message_id):
        raise NotFoundError(
            "Ese mensaje no está en el chat del grupo.", code="message_not_in_group"
        )


@router.put(
    "/{group_id}/topics/{topic_id}/items",
    response_model=ReferenciasAnadidas,
)
async def anadir_referencias(
    group_id: str,
    topic_id: str,
    payload: ReferenciasNuevas,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ReferenciasAnadidas:
    """Añade VARIOS mensajes de General a un tema de una vez. Sin aviso (D9).

    Es «Agregar N a un tema» de Contenido. LAS MISMAS COMPROBACIONES QUE EL DE
    UNO (`anadir_referencia`): administrar el grupo, el tema vivo y de este
    grupo, y cada mensaje de General y vivo.

    TODO O NADA. Si uno solo no vale, 404 `message_not_in_group` y no se añade
    ninguno: quien eligio quince en la pantalla no puede quedarse con doce
    dentro sin saber cuales. La misma respuesta para todos los casos, como en
    el de uno, para que no sirva para averiguar que mensajes existen fuera.

    IDEMPOTENTE: los que ya estaban no se tocan (conservan su fecha y quien los
    añadio) y se cuentan en `already`. Lo garantiza la clave primaria con
    `on conflict do nothing`, y el `returning` dice cuales entraron DE VERDAD:
    si dos personas añaden a la vez, cada una cuenta solo los suyos, sin un
    `select` previo que deje una ventana.

    Tres consultas sea uno o cincuenta: comprobar los mensajes con un `IN`,
    insertar todos con un solo `INSERT` y confirmar.
    """
    uid = current_user.id
    await _exigir_administrar(db, group_id, uid)
    tema = await _tema_vivo(db, group_id, topic_id)
    for crudo in payload.message_ids:
        _exigir_id_de_mensaje(crudo)
    ids = [str(UUID(crudo)) for crudo in payload.message_ids]
    vivos = {
        str(mid)
        for mid in (
            await db.execute(
                select(Message.id).where(
                    Message.id.in_(ids),
                    # En el WHERE: el mensaje de otra conversacion no se alcanza.
                    Message.conversation_id == group_id,
                    Message.deleted_at.is_(None),
                )
            )
        ).scalars()
    }
    if len(vivos) != len(ids):
        raise NotFoundError(
            "Ese mensaje no está en el chat del grupo.", code="message_not_in_group"
        )

    inserta = _insert_con_conflicto(db)
    entraron = (
        await db.execute(
            inserta(ConversationTopicItem.__table__)
            .values(
                [
                    {
                        "topic_id": tema.id,
                        "message_id": mid,
                        "conversation_id": group_id,
                        # La identidad sale del JWT. Nunca de la peticion.
                        "added_by": uid,
                    }
                    for mid in ids
                ]
            )
            .on_conflict_do_nothing(index_elements=["topic_id", "message_id"])
            .returning(ConversationTopicItem.__table__.c.message_id)
        )
    ).scalars().all()
    await db.commit()
    return ReferenciasAnadidas(added=len(entraron), already=len(ids) - len(entraron))


@router.put(
    "/{group_id}/topics/{topic_id}/items/{message_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def anadir_referencia(
    group_id: str,
    topic_id: str,
    message_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Añade un mensaje de General a un tema. IDEMPOTENTE. Sin aviso (D9).

    El mensaje tiene que ser de ESTE grupo —de General, no del chat de otro
    tema ni de otro grupo— y estar vivo. Si no, 404 `message_not_in_group`, con
    la misma respuesta en todos los casos: no se puede usar esta ruta para
    averiguar si un identificador de mensaje existe en otra parte.

    `PUT` porque pulsarlo dos veces deja lo mismo: lo garantiza la clave
    primaria, y la fecha de la primera vez no se sobrescribe.
    """
    uid = current_user.id
    await _exigir_administrar(db, group_id, uid)
    tema = await _tema_vivo(db, group_id, topic_id)
    _exigir_id_de_mensaje(message_id)
    vivo = (
        await db.execute(
            select(Message.id).where(
                Message.id == message_id,
                # En el WHERE: el mensaje de otra conversacion no se alcanza.
                Message.conversation_id == group_id,
                Message.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if vivo is None:
        raise NotFoundError(
            "Ese mensaje no está en el chat del grupo.", code="message_not_in_group"
        )

    inserta = _insert_con_conflicto(db)
    await db.execute(
        inserta(ConversationTopicItem.__table__)
        .values(
            topic_id=tema.id,
            message_id=message_id,
            conversation_id=group_id,
            # La identidad sale del JWT. Nunca de la peticion.
            added_by=uid,
        )
        .on_conflict_do_nothing(index_elements=["topic_id", "message_id"])
    )
    await db.commit()


@router.delete(
    "/{group_id}/topics/{topic_id}/items/{message_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def quitar_referencia(
    group_id: str,
    topic_id: str,
    message_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Quita un mensaje de un tema. El mensaje sigue en General, intacto.

    IDEMPOTENTE: quitar lo que no estaba responde 204 igual.
    """
    uid = current_user.id
    await _exigir_administrar(db, group_id, uid)
    tema = await _tema_vivo(db, group_id, topic_id)
    _exigir_id_de_mensaje(message_id)
    await db.execute(
        delete(ConversationTopicItem).where(
            ConversationTopicItem.topic_id == tema.id,
            ConversationTopicItem.message_id == message_id,
        )
    )
    await db.commit()
