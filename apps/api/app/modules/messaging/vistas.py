"""Vistas de una conversacion: categorias automaticas y filtros personalizados.

LO QUE SE PIDIO (09/10/2026). Que los mensajes de un chat se puedan consultar
por lo que son —fotos, videos, archivos, audios, enlaces— y que quien administra
un grupo pueda ademas guardar filtros propios («Material de estudio»).

SON DOS COSAS DISTINTAS QUE COMPARTEN UN SOLO MOTOR.

  * Una CATEGORIA es fija y no se guarda en ningun sitio: «Fotos» es «los
    mensajes con algun adjunto de tipo imagen». Vale para cualquier
    conversacion, tambien las de dos personas, y no depende de que nadie la
    cree.
  * Un FILTRO es una fila de `conversation_filters` (migracion 0102) con unos
    criterios que escribio una persona. Solo existe en los grupos.

Las dos se resuelven igual: unos `Criterios` se traducen a condiciones sobre
`messages` (`_condiciones`). Una categoria es, literalmente, unos criterios con
un solo tipo. Por eso añadir un criterio nuevo es tocar `Criterios` y
`_condiciones`, y nada mas.

UNA VISTA NO ES OTRO CHAT. Lo que devuelve son los MISMOS mensajes, con su
mismo identificador, autor, fecha y adjuntos. Nada se copia: un PDF que sale en
«Archivos» y en «Material de estudio» es una sola fila de `messages`, asi que
borrarlo lo quita de todas partes a la vez y no hay estados de lectura que
puedan separarse.

LA PERTENENCIA SE CALCULA AL LEER, no se guarda. Guardarla obligaria a
mantenerla al llegar cada mensaje, al borrarse y —lo caro— a reclasificar el
historial entero de un grupo cada vez que alguien retoca un filtro. Calculada
al leer no puede quedarse vieja. Lo que la hace asumible:

  * todo va acotado a UNA conversacion, por el indice de
    `messages.conversation_id` y el de `message_attachments.conversation_id`;
  * el tipo de contenido es un `EXISTS` sobre `message_attachments.message_id`,
    que tiene indice;
  * las palabras son un `ILIKE` con los comodines escapados; y exigen tres
    letras, que es lo que el indice trigram de la 0046 sabe aprovechar;
  * «lleva un enlace» tiene su propio indice parcial (0111), que solo guarda
    los mensajes vivos con enlace: contarlos no lee el resto del historial;
  * se pagina siempre, y nunca se trae la conversacion a memoria.

LOS CRITERIOS NO SON CODIGO. Llegan como datos, se validan contra listas
cerradas y con topes, y se convierten en condiciones con parametros. No hay
expresiones regulares, ni SQL escrito por nadie, ni operadores que anidar.

LOS BORRADOS NO SALEN. El chat enseña la lapida de un mensaje eliminado para
que la conversacion no mienta; una vista es una busqueda, y devolver «Mensaje
eliminado» entre las fotos seria ruido.

QUIEN ADMINISTRA. Ver `administra`.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import and_, case, false, func, literal, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
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
from app.modules.messaging import esquema, historias, preferencias, reacciones, sesiones
from app.modules.messaging.lectura import adjuntos_por_mensaje
from app.modules.messaging.models import (
    Conversation,
    ConversationFilter,
    ConversationMember,
    Message,
    MessageAttachment,
)
from app.modules.messaging.schemas import MAX_BUSQUEDA, MessageRead
from app.modules.profiles.models import Profile
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid

router = APIRouter(tags=["messaging"])

# --------------------------------------------------------------------------- #
# Lo que se puede pedir
# --------------------------------------------------------------------------- #
#: Los tipos de contenido que EXISTEN en el chat de Z. Cuatro salen del adjunto
#: (`message_attachments.kind`), uno del texto (`link`) y uno de la ausencia de
#: adjuntos (`text`). No hay encuestas, GIFs ni stickers: el chat no los manda,
#: y una categoria que no puede tener nada dentro es un boton muerto.
TIPOS_DE_ADJUNTO = ("image", "video", "document", "audio")
TIPOS = ("text", *TIPOS_DE_ADJUNTO, "link")

#: Las categorias automaticas, en el orden en que se ofrecen. `all` es la
#: conversacion entera y existe para poder BUSCAR en ella desde la misma
#: pantalla; el chat sigue siendo el sitio donde se lee.
CATEGORIAS = ("all", "media", "image", "video", "document", "audio", "link")

#: «Media» son las fotos y los videos JUNTOS, en una sola cuadricula: es como
#: se miran en cualquier mensajeria. `image` y `video` siguen existiendo para
#: quedarse solo con unas o con otros dentro de ella.
_TIPOS_DE_CATEGORIA = {"media": ["image", "video"]}

#: Con que empieza lo que la aplicacion pinta como enlace (`enlacesEnTexto.ts`).
#: La aplicacion reconoce ademas dominios escritos a pelo («renaser.pe»); aqui
#: no, porque un `LIKE '%.pe%'` confundiria «etc.pero» con un sitio. Quien
#: quiera que su enlace salga en «Enlaces» lo pega como sale al copiarlo.
#:
#: ESTAS TRES MARCAS ESTAN COPIADAS EN LA CONDICION DEL INDICE
#: `messages_con_enlace_idx` (migracion 0111). PostgreSQL solo usa un indice
#: parcial si la consulta pide lo mismo que el guarda, asi que cambiar una aqui
#: sin rehacer el indice no rompe ninguna cuenta: la vuelve lenta, porque
#: contar los enlaces volveria a leer la conversacion entera.
_MARCAS_DE_ENLACE = ("%http://%", "%https://%", "%www.%")

MAX_FILTROS_POR_CONVERSACION = 20
MAX_PALABRAS = 5
MIN_LETRAS_DE_PALABRA = 3
MAX_LETRAS_DE_PALABRA = 40
MAX_AUTORES = 10
MAX_NOMBRE = 40
MAX_DESCRIPCION = 200

#: Los iconos que un filtro puede llevar. Lista cerrada: es el nombre de un
#: icono del juego que ya usa la aplicacion (Feather), y aceptar cualquier
#: texto dejaria filtros con un hueco donde deberia ir el dibujo.
ICONOS = (
    "filter",
    "star",
    "bookmark",
    "flag",
    "bell",
    "book-open",
    "calendar",
    "clipboard",
    "help-circle",
    "bar-chart-2",
    "folder",
    "award",
    "users",
    "message-circle",
    "paperclip",
    "link",
    "mic",
    "image",
    "video",
    "file-text",
)

PAGINA_POR_OMISION = 30
PAGINA_MAXIMA = 60


# --------------------------------------------------------------------------- #
# Criterios
# --------------------------------------------------------------------------- #
class Criterios(BaseModel):
    """Que mensajes pertenecen a una vista.

    TRES EJES, Y UN MENSAJE TIENE QUE CUMPLIR LOS TRES QUE SE HAYAN PUESTO:

      * `types` — de que es el mensaje. Basta con que sea de UNO de los tipos.
      * `keywords` — que dice. `keyword_mode` decide si basta una palabra
        (`any`) o hacen falta todas (`all`).
      * `author_ids` — quien lo escribio. Basta con que sea UNO de ellos.

    Un eje vacio no filtra. Los tres vacios no son un filtro: seria la
    conversacion entera con otro nombre.

    NO HAY MAS, A PROPOSITO. Ni negaciones, ni grupos anidados, ni fechas: con
    esto se escriben «los PDF de la profesora», «lo que diga examen o parcial»
    y «los videos», que es lo que se pide a un grupo. Un constructor de
    consultas completo seria mas dificil de usar que el problema que resuelve.
    """

    model_config = ConfigDict(extra="forbid")

    types: list[str] = Field(default_factory=list, max_length=len(TIPOS))
    keywords: list[str] = Field(default_factory=list, max_length=MAX_PALABRAS)
    keyword_mode: Literal["any", "all"] = "any"
    author_ids: list[str] = Field(default_factory=list, max_length=MAX_AUTORES)

    @field_validator("types")
    @classmethod
    def _tipos_conocidos(cls, v: list[str]) -> list[str]:
        for tipo in v:
            if tipo not in TIPOS:
                raise ValueError(
                    f"Tipo de contenido no admitido: {tipo}. Admitidos: {', '.join(TIPOS)}."
                )
        # Sin repetidos y en el orden canonico: dos filtros iguales se guardan
        # iguales, se escriba la lista en el orden que se escriba.
        return [tipo for tipo in TIPOS if tipo in v]

    @field_validator("keywords")
    @classmethod
    def _palabras_utiles(cls, v: list[str]) -> list[str]:
        limpias: list[str] = []
        for palabra in v:
            texto = " ".join(str(palabra).split())
            if not texto:
                continue
            if not MIN_LETRAS_DE_PALABRA <= len(texto) <= MAX_LETRAS_DE_PALABRA:
                raise ValueError(
                    f"Cada palabra debe tener entre {MIN_LETRAS_DE_PALABRA} y "
                    f"{MAX_LETRAS_DE_PALABRA} caracteres."
                )
            if texto.casefold() not in {otra.casefold() for otra in limpias}:
                limpias.append(texto)
        return limpias

    @field_validator("author_ids")
    @classmethod
    def _autores_bien_escritos(cls, v: list[str]) -> list[str]:
        vistos: list[str] = []
        for autor in v:
            try:
                canonico = str(UUID(str(autor)))
            except ValueError as error:
                raise ValueError("Identificador de autor no válido.") from error
            if canonico not in vistos:
                vistos.append(canonico)
        return vistos

    @model_validator(mode="after")
    def _dice_algo(self) -> "Criterios":
        if not (self.types or self.keywords or self.author_ids):
            raise ValueError(
                "Un filtro necesita al menos un criterio: un tipo de contenido, "
                "una palabra o un autor."
            )
        return self


def _patron(texto: str) -> str:
    """Un texto convertido en patron de `LIKE` sin comodines que muerdan.

    Igual que `_patron_de_busqueda` en el router: `%` y `_` son comodines en
    SQL, y sin escaparlos la palabra «100%» casaria con cualquier mensaje.
    """
    limpio = texto.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{limpio}%"


def _con_adjunto(tipos: list[str] | None = None) -> ColumnElement[bool]:
    """«Este mensaje tiene algun adjunto» (de esos tipos, si se dicen)."""
    consulta = select(MessageAttachment.id).where(
        MessageAttachment.message_id == Message.id
    )
    if tipos is not None:
        consulta = consulta.where(MessageAttachment.kind.in_(tipos))
    return consulta.correlate(Message).exists()


def _con_enlace() -> ColumnElement[bool]:
    """«El texto de este mensaje lleva un enlace». UNA sola definicion.

    La usan la cuenta de «Enlaces» y la lista de esa pestaña, y tienen que
    decir lo mismo: si la cuenta dijera 12 y la lista trajera 11, el numero
    estaria mintiendo.

    LAS MARCAS VAN ESCRITAS EN EL SQL, NO COMO PARAMETROS (`literal_execute`).
    El indice de la 0111 es PARCIAL: guarda solo los mensajes vivos con
    enlace, y PostgreSQL solo lo usa si, al planificar, puede demostrar que la
    consulta pide lo mismo que el guarda. Con `$2`, `$3` y `$4` no puede
    demostrarlo, y asyncpg prepara las sentencias y las reutiliza: en cuanto
    PostgreSQL pasara al plan generico de la sentencia preparada, la cuenta
    volveria a leer la conversacion entera. Son tres textos fijos de este
    fichero —ni una letra la escribe quien usa la aplicacion—, y SQLAlchemy los
    escribe con su propio escapado, asi que no abren ninguna inyeccion. Las
    palabras de un filtro siguen yendo como parametros.
    """
    return or_(
        *(
            Message.body.ilike(literal(marca, literal_execute=True))
            for marca in _MARCAS_DE_ENLACE
        )
    )


def _condiciones(criterios: Criterios, *, con_adjuntos: bool) -> list[ColumnElement[bool]]:
    """Los criterios, como condiciones sobre `messages`.

    `con_adjuntos` es si la 0033 esta aplicada. Sin ella no existe la tabla de
    adjuntos: los tipos que salen de un adjunto no casan con nada y «solo
    texto» es cualquier mensaje con texto.
    """
    condiciones: list[ColumnElement[bool]] = []

    if criterios.types:
        de_alguno: list[ColumnElement[bool]] = []
        de_adjunto = [t for t in criterios.types if t in TIPOS_DE_ADJUNTO]
        if de_adjunto and con_adjuntos:
            de_alguno.append(_con_adjunto(de_adjunto))
        if "link" in criterios.types:
            de_alguno.append(_con_enlace())
        if "text" in criterios.types:
            con_texto = func.length(func.trim(Message.body)) > 0
            de_alguno.append(
                and_(con_texto, ~_con_adjunto()) if con_adjuntos else con_texto
            )
        condiciones.append(or_(*de_alguno) if de_alguno else false())

    if criterios.keywords:
        coincide = [
            Message.body.ilike(_patron(palabra), escape="\\")
            for palabra in criterios.keywords
        ]
        condiciones.append(
            and_(*coincide) if criterios.keyword_mode == "all" else or_(*coincide)
        )

    if criterios.author_ids:
        condiciones.append(Message.sender_id.in_(criterios.author_ids))

    return condiciones


def _criterios_de_categoria(categoria: str) -> Criterios | None:
    """Una categoria ES unos criterios de tipo. `all` no filtra."""
    if categoria == "all":
        return None
    return Criterios(types=_TIPOS_DE_CATEGORIA.get(categoria, [categoria]))


# --------------------------------------------------------------------------- #
# Esquemas de la API
# --------------------------------------------------------------------------- #
def _limpiar_nombre(v: str) -> str:
    limpio = " ".join(v.split())
    if not limpio:
        raise ValueError("El filtro necesita un nombre.")
    return limpio


def _limpiar_descripcion(v: str) -> str:
    return " ".join(v.split())


def _icono_conocido(v: str) -> str:
    if v not in ICONOS:
        raise ValueError("Icono no admitido.")
    return v


class FiltroEscrito(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=MAX_NOMBRE)
    description: str = Field(default="", max_length=MAX_DESCRIPCION)
    icon: str = "filter"
    criteria: Criterios
    enabled: bool = True

    @field_validator("name")
    @classmethod
    def _nombre(cls, v: str) -> str:
        return _limpiar_nombre(v)

    @field_validator("description")
    @classmethod
    def _descripcion(cls, v: str) -> str:
        return _limpiar_descripcion(v)

    @field_validator("icon")
    @classmethod
    def _icono(cls, v: str) -> str:
        return _icono_conocido(v)


class FiltroCambiado(BaseModel):
    """Lo que se quiera cambiar de un filtro. Lo que no viene, no se toca."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=MAX_NOMBRE)
    description: str | None = Field(default=None, max_length=MAX_DESCRIPCION)
    icon: str | None = None
    criteria: Criterios | None = None
    enabled: bool | None = None

    @field_validator("name")
    @classmethod
    def _nombre(cls, v: str | None) -> str | None:
        return None if v is None else _limpiar_nombre(v)

    @field_validator("description")
    @classmethod
    def _descripcion(cls, v: str | None) -> str | None:
        return None if v is None else _limpiar_descripcion(v)

    @field_validator("icon")
    @classmethod
    def _icono(cls, v: str | None) -> str | None:
        return None if v is None else _icono_conocido(v)


class FiltroLeido(BaseModel):
    id: str
    name: str
    description: str = ""
    icon: str = "filter"
    criteria: Criterios
    enabled: bool = True
    created_at: datetime | None = None
    updated_at: datetime | None = None


class CategoriaLeida(BaseModel):
    key: str
    #: Cuantos mensajes vivos tiene. La aplicacion no ofrece las que estan a
    #: cero: una pestaña que siempre sale vacia es un boton muerto.
    count: int = 0


class VistasLeidas(BaseModel):
    """Que vistas tiene esta conversacion para quien pregunta."""

    kind: str
    categories: list[CategoriaLeida]
    #: Hay filtros personalizados en esta conversacion: es un grupo y la 0102
    #: esta aplicada. Con `false`, la aplicacion no enseña nada de filtros.
    filters_available: bool = False
    filters: list[FiltroLeido] = Field(default_factory=list)
    #: Quien pregunta puede crear, cambiar y borrar filtros aqui. Es COMODIDAD
    #: para no pintar botones que responderian 403: el permiso se comprueba otra
    #: vez en cada escritura.
    can_manage: bool = False
    #: Las listas cerradas, para que la aplicacion no las repita a mano.
    icons: list[str] = Field(default_factory=lambda: list(ICONOS))
    max_filters: int = MAX_FILTROS_POR_CONVERSACION


class PaginaDeVista(BaseModel):
    """Una pagina de una vista, de lo mas reciente a lo mas antiguo.

    `next_before` y `next_before_id` son el cursor de la pagina siguiente, y
    vienen a nulo cuando no hay mas. Van los DOS porque el instante solo no
    basta: dos mensajes pueden compartirlo, y con el instante a secas uno de
    los dos se saltaria o se repetiria al cambiar de pagina.
    """

    items: list[MessageRead]
    next_before: datetime | None = None
    next_before_id: str | None = None


# --------------------------------------------------------------------------- #
# Permisos
# --------------------------------------------------------------------------- #
async def conversacion_de(
    db: AsyncSession, conversation_id: str, uid: str
) -> tuple[str, str]:
    """`(kind, created_by)` de una conversacion A LA QUE SE PERTENECE.

    Pertenecer es lo PRIMERO, antes de decir si la conversacion existe: sin eso
    se podria averiguar que identificadores son de verdad por la diferencia
    entre un 404 y un 403.
    """
    ensure_uuid(conversation_id, "Conversacion no encontrada.")
    miembro = await db.get(
        ConversationMember, {"conversation_id": conversation_id, "user_id": uid}
    )
    if miembro is None:
        raise ForbiddenError("No perteneces a esta conversación.")
    fila = (
        await db.execute(
            select(Conversation.kind, Conversation.created_by).where(
                Conversation.id == conversation_id
            )
        )
    ).one_or_none()
    if fila is None:
        raise NotFoundError("Conversación no encontrada.")
    return fila.kind, fila.created_by


def administra(kind: str, created_by: str, uid: str) -> bool:
    """Si esta persona administra la conversacion: sus filtros, sus miembros y,
    desde el 26/10/2026 (D4), borrar mensajes de otros en ella.

    HOY: QUIEN CREO EL GRUPO. Es el unico dato de autoridad que la base tiene
    sobre una conversacion: `conversation_members` no guarda ningun rol. Los
    filtros solo existen en los grupos; en un chat de dos personas no hay
    «administrador» y las categorias automaticas ya cubren lo que hace falta.
    Una comunidad y el chat de un tema los crea quien administra el grupo, asi
    que esta misma regla le da tambien su administracion.

    Es UNA funcion a proposito: el dia que los miembros de un grupo tengan rol,
    se cambia aqui y lo aprenden a la vez la lectura (`can_manage`) y todas
    las escrituras.
    """
    return kind == "group" and str(created_by) == str(uid)


async def _exigir_administrar(
    db: AsyncSession, conversation_id: str, uid: str
) -> None:
    """Pertenecer, que sea un grupo, que la 0102 este, y poder administrar.

    Y que sea un grupo DE PRIMER NIVEL: ni una comunidad ni el chat de un tema
    tienen filtros propios (contrato de temas y comunidades, «un solo nivel»).
    Sus categorias automaticas si funcionan, porque no se guardan en ningun
    sitio.
    """
    kind, creador = await conversacion_de(db, conversation_id, uid)
    if kind != "group":
        raise ConflictError(
            "Los filtros personalizados son de los grupos.",
            code="filters_only_in_groups",
        )
    # Aqui dentro: `grupos.py` importa este fichero.
    from app.modules.messaging import grupos

    await grupos.exigir_primer_nivel(db, conversation_id)
    if not await esquema.hay_filtros_de_conversacion(db):
        raise ServiceUnavailableError(
            "Los filtros personalizados todavía no están disponibles.",
            code="conversation_filters_not_available",
        )
    if not administra(kind, creador, uid):
        raise ForbiddenError(
            "Solo quien administra el grupo puede cambiar sus filtros.",
            code="filters_not_allowed",
        )


async def _exigir_autores_del_grupo(
    db: AsyncSession, conversation_id: str, criterios: Criterios
) -> None:
    """Que los autores de un filtro sean miembros de ESTE grupo.

    Sin esto se podria guardar el identificador de cualquier persona: no
    filtraria nada —la consulta va acotada a la conversacion— pero la lista de
    autores del filtro la ven todos los miembros, y no tiene por que nombrar a
    alguien de fuera.
    """
    if not criterios.author_ids:
        return
    dentro = set(
        (
            await db.execute(
                select(ConversationMember.user_id).where(
                    ConversationMember.conversation_id == conversation_id,
                    ConversationMember.user_id.in_(criterios.author_ids),
                )
            )
        ).scalars()
    )
    if any(autor not in dentro for autor in criterios.author_ids):
        raise ValidationAppError(
            "Un filtro solo puede nombrar a miembros del grupo.",
            code="filter_author_not_member",
        )


# --------------------------------------------------------------------------- #
# Lectura
# --------------------------------------------------------------------------- #
def _leer_filtro(fila: ConversationFilter) -> FiltroLeido | None:
    """Una fila, como respuesta. `None` si sus criterios ya no se entienden.

    Los criterios se validan al guardar, asi que esto no deberia pasar. Pero es
    un `jsonb`: si un dia se quita un tipo de `TIPOS`, una fila vieja dejaria
    de validar, y eso no puede tumbar la lista entera de filtros del grupo.
    """
    try:
        criterios = Criterios.model_validate(fila.criteria)
    except ValueError:
        return None
    return FiltroLeido(
        id=fila.id,
        name=fila.name,
        description=fila.description or "",
        icon=fila.icon if fila.icon in ICONOS else "filter",
        criteria=criterios,
        enabled=bool(fila.enabled),
        created_at=fila.created_at,
        updated_at=fila.updated_at,
    )


async def _filtros(
    db: AsyncSession, conversation_id: str, *, tambien_apagados: bool
) -> list[FiltroLeido]:
    consulta = select(ConversationFilter).where(
        ConversationFilter.conversation_id == conversation_id
    )
    if not tambien_apagados:
        consulta = consulta.where(ConversationFilter.enabled.is_(True))
    filas = (
        await db.execute(
            consulta.order_by(
                ConversationFilter.position.asc(),
                ConversationFilter.created_at.asc(),
                ConversationFilter.id.asc(),
            )
        )
    ).scalars()
    return [leido for fila in filas if (leido := _leer_filtro(fila)) is not None]


def _mensajes_con(*tipos: str):
    """Cuantos MENSAJES distintos llevan algun adjunto de esos tipos."""
    return func.count(
        func.distinct(
            case((MessageAttachment.kind.in_(tipos), MessageAttachment.message_id))
        )
    )


async def _cuentas(
    db: AsyncSession, conversation_id: str, desde: datetime | None = None
) -> dict[str, int]:
    """Cuantos mensajes vivos hay de cada categoria. DOS consultas, siempre.

    Una cuenta los adjuntos por tipo —contando MENSAJES, no archivos: diez
    fotos en un mensaje son un mensaje, y uno con foto y video cuenta una vez
    en «media»— y la otra cuenta los que llevan un enlace. Las dos van
    acotadas a la conversacion por su indice.

    `desde` es el instante en que quien pregunta vacio el chat: lo anterior
    no se le cuenta.
    """
    cuentas = dict.fromkeys(CATEGORIAS, 0)
    vivos = [Message.deleted_at.is_(None)]
    if desde is not None:
        vivos.append(Message.created_at > desde)

    if await esquema.hay_adjuntos_de_chat(db):
        fila = (
            await db.execute(
                select(
                    *(_mensajes_con(tipo) for tipo in TIPOS_DE_ADJUNTO),
                    _mensajes_con(*_TIPOS_DE_CATEGORIA["media"]),
                )
                .select_from(MessageAttachment)
                .join(Message, Message.id == MessageAttachment.message_id)
                .where(MessageAttachment.conversation_id == conversation_id, *vivos)
            )
        ).one()
        for tipo, cuantos in zip((*TIPOS_DE_ADJUNTO, "media"), fila, strict=True):
            cuentas[tipo] = int(cuantos or 0)

    # LA CUENTA ES EXACTA Y SE QUEDA EXACTA. La pantalla «Contenido» del 09/10
    # (1fcaf49, aplicacion 1.2.1) la pinta tal cual en la pestaña («Enlaces ·
    # 1234»), y un telefono puede seguir con ese codigo: un tope tipo «99+»
    # cambiaria lo que ve. La de hoy solo mira si es cero.
    #
    # Lo que la hace barata es el indice parcial de la 0111: sus condiciones
    # son exactamente estas —conversacion, vivo, fecha y `_con_enlace()`—, y
    # PostgreSQL la contesta leyendo solo el indice, que guarda los mensajes
    # con enlace y nada mas. Antes recorria todos los enlaces de la base, o la
    # conversacion entera.
    cuentas["link"] = int(
        await db.scalar(
            select(func.count())
            .select_from(Message)
            .where(Message.conversation_id == conversation_id, *vivos, _con_enlace())
        )
        or 0
    )
    return cuentas


@router.get("/{conversation_id}/views", response_model=VistasLeidas)
async def vistas_de_la_conversacion(
    conversation_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> VistasLeidas:
    """Las categorias con contenido y los filtros del grupo, de una vez.

    Un numero de consultas CONSTANTE: pertenencia, conversacion, dos de
    cuentas y, en un grupo, los filtros. No crece con los mensajes ni con los
    filtros.

    `all` no lleva cuenta: contar la conversacion entera cada vez que se abre
    esta pantalla seria pagar por un numero que nadie mira.
    """
    kind, creador = await conversacion_de(db, conversation_id, current_user.id)
    # Lo que quien pregunta vacio no se le cuenta ni se le enseña.
    vaciado = await preferencias.vaciado_desde(db, conversation_id, current_user.id)
    cuentas = await _cuentas(db, conversation_id, vaciado)

    puede = administra(kind, creador, current_user.id)
    hay_filtros = kind == "group" and await esquema.hay_filtros_de_conversacion(db)
    filtros = (
        # Quien administra ve tambien los apagados, para poder encenderlos. Los
        # demas no saben ni que existen.
        await _filtros(db, conversation_id, tambien_apagados=puede)
        if hay_filtros
        else []
    )
    return VistasLeidas(
        kind=kind,
        categories=[CategoriaLeida(key=c, count=cuentas[c]) for c in CATEGORIAS],
        filters_available=hay_filtros,
        filters=filtros,
        can_manage=puede and hay_filtros,
    )


@router.get("/{conversation_id}/views/messages", response_model=PaginaDeVista)
async def mensajes_de_una_vista(
    conversation_id: str,
    category: str | None = Query(default=None, max_length=16),
    filter_id: str | None = Query(default=None, max_length=64),
    q: str | None = Query(default=None, max_length=MAX_BUSQUEDA),
    before: datetime | None = Query(default=None),
    before_id: str | None = Query(default=None, max_length=64),
    limit: int = Query(default=PAGINA_POR_OMISION, ge=1, le=PAGINA_MAXIMA),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeVista:
    """Los mensajes de UNA vista: una categoria o un filtro. Paginado.

    O `category` O `filter_id`, nunca los dos: son dos preguntas distintas y
    combinarlas aqui convertiria la ruta en el constructor de consultas que no
    se quiere. `q` busca DENTRO de la vista, en el texto y en el nombre de los
    archivos.

    EL CURSOR ES `(before, before_id)`: el instante y el identificador del
    ultimo mensaje de la pagina anterior. Es estable aunque entren mensajes
    nuevos mientras se pagina —lo que ya paso no se mueve— y no se salta ni
    repite filas cuando dos comparten instante.

    UN FILTRO APAGADO, O DE OTRA CONVERSACION, ES UN 404, para todo el mundo
    que no lo administre. No se dice «existe pero no puedes»: eso seria
    confirmar que existe.
    """
    kind, creador = await conversacion_de(db, conversation_id, current_user.id)

    if (category is None) == (filter_id is None):
        raise ValidationAppError(
            "Indica una categoría o un filtro, y solo uno.",
            code="view_selector_invalid",
        )

    if category is not None:
        if category not in CATEGORIAS:
            raise ValidationAppError("Categoría no admitida.", code="view_category_invalid")
        criterios = _criterios_de_categoria(category)
    else:
        ensure_uuid(filter_id, "Filtro no encontrado.")
        if kind != "group" or not await esquema.hay_filtros_de_conversacion(db):
            raise NotFoundError("Filtro no encontrado.", code="filter_not_found")
        fila = (
            await db.execute(
                select(ConversationFilter).where(
                    ConversationFilter.id == filter_id,
                    # La conversacion va en el WHERE, no en una comprobacion de
                    # despues: el filtro de otro grupo no llega ni a leerse.
                    ConversationFilter.conversation_id == conversation_id,
                )
            )
        ).scalar_one_or_none()
        leido = _leer_filtro(fila) if fila is not None else None
        if leido is None or (
            not leido.enabled and not administra(kind, creador, current_user.id)
        ):
            raise NotFoundError("Filtro no encontrado.", code="filter_not_found")
        criterios = leido.criteria

    con_adjuntos = await esquema.hay_adjuntos_de_chat(db)
    condiciones: list[ColumnElement[bool]] = [
        Message.conversation_id == conversation_id,
        Message.deleted_at.is_(None),
    ]
    if criterios is not None:
        condiciones.extend(_condiciones(criterios, con_adjuntos=con_adjuntos))

    # Lo que quien pregunta vacio no sale en ninguna vista. Es suyo: a los
    # demas miembros les sigue saliendo. Ver `preferencias.py`.
    vaciado = await preferencias.vaciado_desde(db, conversation_id, current_user.id)
    if vaciado is not None:
        condiciones.append(Message.created_at > vaciado)

    texto = (q or "").strip()
    if texto:
        patron = _patron(texto)
        en_el_texto = Message.body.ilike(patron, escape="\\")
        if con_adjuntos:
            # Un PDF se busca por su nombre: es lo unico que lo identifica.
            en_el_nombre = (
                select(MessageAttachment.id)
                .where(
                    MessageAttachment.message_id == Message.id,
                    MessageAttachment.file_name.ilike(patron, escape="\\"),
                )
                .correlate(Message)
                .exists()
            )
            condiciones.append(or_(en_el_texto, en_el_nombre))
        else:
            condiciones.append(en_el_texto)

    if before is not None:
        if before_id:
            ensure_uuid(before_id, "Cursor no válido.")
            condiciones.append(
                or_(
                    Message.created_at < before,
                    and_(Message.created_at == before, Message.id < before_id),
                )
            )
        else:
            condiciones.append(Message.created_at < before)

    filas = (
        await db.execute(
            select(
                Message.id,
                Message.conversation_id,
                Message.body,
                Message.created_at,
                Profile.id,
                Profile.full_name,
                Profile.username,
                Profile.avatar_path,
            )
            .join(Profile, Profile.id == Message.sender_id)
            .where(*condiciones)
            .order_by(Message.created_at.desc(), Message.id.desc())
            # Uno de mas: es lo que dice si hay pagina siguiente sin contar.
            .limit(limit + 1)
        )
    ).all()

    hay_mas = len(filas) > limit
    filas = filas[:limit]
    ids = [fila[0] for fila in filas]

    # Lo que cuelga de los mensajes, en UNA consulta por cosa para toda la
    # pagina: igual que el historial del chat, y por lo mismo.
    adjuntos = await adjuntos_por_mensaje(db, ids)
    de_historia = await historias.contextos_por_mensaje(db, ids)
    de_sesion = await sesiones.contextos_por_mensaje(db, ids, current_user.id)
    reacciones_de = await reacciones.reacciones_por_mensaje(db, ids, current_user.id)
    citas = await reacciones.respuestas_por_mensaje(db, ids)

    items = [
        MessageRead(
            id=msg_id,
            conversation_id=conv_id,
            sender=AuthorSummary(
                id=pid, full_name=full_name, username=username, avatar_path=avatar_path
            ),
            body=body,
            created_at=created_at,
            attachments=adjuntos.get(msg_id, []),
            story_context=de_historia.get(msg_id),
            booking_context=de_sesion.get(msg_id),
            reactions=reacciones_de.get(msg_id, []),
            reply_to=citas.get(msg_id),
        )
        for (
            msg_id,
            conv_id,
            body,
            created_at,
            pid,
            full_name,
            username,
            avatar_path,
        ) in filas
    ]
    ultimo = filas[-1] if (hay_mas and filas) else None
    return PaginaDeVista(
        items=items,
        next_before=ultimo[3] if ultimo else None,
        next_before_id=ultimo[0] if ultimo else None,
    )


# --------------------------------------------------------------------------- #
# Administrar los filtros
# --------------------------------------------------------------------------- #
async def _nombre_repetido(
    db: AsyncSession, conversation_id: str, nombre: str, *, salvo: str | None = None
) -> bool:
    consulta = select(ConversationFilter.id).where(
        ConversationFilter.conversation_id == conversation_id,
        func.lower(func.trim(ConversationFilter.name)) == nombre.lower(),
    )
    if salvo is not None:
        consulta = consulta.where(ConversationFilter.id != salvo)
    return (await db.execute(consulta.limit(1))).first() is not None


_NOMBRE_REPETIDO = "Ya hay un filtro con ese nombre en este grupo."


@router.get("/{conversation_id}/filters", response_model=list[FiltroLeido])
async def listar_filtros(
    conversation_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[FiltroLeido]:
    """Los filtros del grupo. Quien no administra solo ve los encendidos."""
    kind, creador = await conversacion_de(db, conversation_id, current_user.id)
    if kind != "group" or not await esquema.hay_filtros_de_conversacion(db):
        return []
    return await _filtros(
        db,
        conversation_id,
        tambien_apagados=administra(kind, creador, current_user.id),
    )


@router.post(
    "/{conversation_id}/filters",
    response_model=FiltroLeido,
    status_code=status.HTTP_201_CREATED,
)
async def crear_filtro(
    conversation_id: str,
    payload: FiltroEscrito,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FiltroLeido:
    await _exigir_administrar(db, conversation_id, current_user.id)
    await _exigir_autores_del_grupo(db, conversation_id, payload.criteria)

    cuantos, ultima = (
        await db.execute(
            select(
                func.count(ConversationFilter.id),
                func.coalesce(func.max(ConversationFilter.position), -1),
            ).where(ConversationFilter.conversation_id == conversation_id)
        )
    ).one()
    if cuantos >= MAX_FILTROS_POR_CONVERSACION:
        raise ConflictError(
            f"Un grupo puede tener hasta {MAX_FILTROS_POR_CONVERSACION} filtros.",
            code="filters_limit_reached",
        )
    if await _nombre_repetido(db, conversation_id, payload.name):
        raise ConflictError(_NOMBRE_REPETIDO, code="filter_name_taken")

    fila = ConversationFilter(
        conversation_id=conversation_id,
        name=payload.name,
        description=payload.description,
        icon=payload.icon,
        criteria=payload.criteria.model_dump(),
        enabled=payload.enabled,
        position=int(ultima) + 1,
        # La identidad sale del JWT. Nunca de la peticion.
        created_by=current_user.id,
    )
    db.add(fila)
    try:
        await db.commit()
    except IntegrityError:
        # Dos altas a la vez con el mismo nombre: la comprobacion de arriba la
        # pasan las dos y decide el indice unico de la 0102.
        await db.rollback()
        raise ConflictError(_NOMBRE_REPETIDO, code="filter_name_taken") from None
    await db.refresh(fila)
    leido = _leer_filtro(fila)
    assert leido is not None  # se acaba de validar
    return leido


async def _filtro_del_grupo(
    db: AsyncSession, conversation_id: str, filter_id: str
) -> ConversationFilter:
    ensure_uuid(filter_id, "Filtro no encontrado.")
    fila = (
        await db.execute(
            select(ConversationFilter).where(
                ConversationFilter.id == filter_id,
                # En el WHERE: quien administra un grupo no alcanza los filtros
                # de otro aunque conozca su identificador.
                ConversationFilter.conversation_id == conversation_id,
            )
        )
    ).scalar_one_or_none()
    if fila is None:
        raise NotFoundError("Filtro no encontrado.", code="filter_not_found")
    return fila


@router.patch("/{conversation_id}/filters/{filter_id}", response_model=FiltroLeido)
async def cambiar_filtro(
    conversation_id: str,
    filter_id: str,
    payload: FiltroCambiado,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FiltroLeido:
    await _exigir_administrar(db, conversation_id, current_user.id)
    fila = await _filtro_del_grupo(db, conversation_id, filter_id)

    cambios: dict[str, object] = {}
    if payload.name is not None and payload.name != fila.name:
        if await _nombre_repetido(db, conversation_id, payload.name, salvo=fila.id):
            raise ConflictError(_NOMBRE_REPETIDO, code="filter_name_taken")
        cambios["name"] = payload.name
    if payload.description is not None:
        cambios["description"] = payload.description
    if payload.icon is not None:
        cambios["icon"] = payload.icon
    if payload.criteria is not None:
        await _exigir_autores_del_grupo(db, conversation_id, payload.criteria)
        cambios["criteria"] = payload.criteria.model_dump()
    if payload.enabled is not None:
        cambios["enabled"] = payload.enabled

    if cambios:
        try:
            await db.execute(
                update(ConversationFilter)
                .where(
                    ConversationFilter.id == fila.id,
                    ConversationFilter.conversation_id == conversation_id,
                )
                .values(**cambios, updated_at=func.now())
            )
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise ConflictError(_NOMBRE_REPETIDO, code="filter_name_taken") from None
        await db.refresh(fila)

    leido = _leer_filtro(fila)
    if leido is None:
        raise NotFoundError("Filtro no encontrado.", code="filter_not_found")
    return leido


@router.delete(
    "/{conversation_id}/filters/{filter_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def borrar_filtro(
    conversation_id: str,
    filter_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Borra la DEFINICION del filtro. Ningun mensaje se toca.

    No hay nada que arrastrar: ninguna tabla apunta a `conversation_filters`.
    Los mensajes que el filtro enseñaba siguen en el chat y en sus categorias.
    """
    await _exigir_administrar(db, conversation_id, current_user.id)
    fila = await _filtro_del_grupo(db, conversation_id, filter_id)
    await db.delete(fila)
    await db.commit()
