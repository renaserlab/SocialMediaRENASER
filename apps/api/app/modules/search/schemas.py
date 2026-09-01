"""El contrato de la busqueda global.

DOS DECISIONES QUE MARCAN TODO LO DEMAS:

1. LA RESPUESTA VA AGRUPADA POR TIPO, no en una lista unica mezclada. Una
   persona, una publicacion y un curso no se pintan igual ni se abren igual: en
   una lista mezclada, cada fila tendria que llevar un `type` y la union de
   todos los campos de todos los tipos, casi todos vacios. Agrupada, cada
   seccion tiene su forma exacta, la pantalla las pinta en el orden que quiera
   y puede ensenar lo que ya llego mientras el resto sigue vacio.

2. SON FILAS DE RESUMEN, NO OBJETOS COMPLETOS. Una publicacion aqui no trae sus
   medios, ni sus comentarios, ni si le diste like; un curso no trae su
   temario. Buscar es decidir a donde entrar, y para eso hace falta un titulo y
   una linea. Lo demas se pide al abrir, que es cuando de verdad se necesita:
   devolverlo aqui multiplicaria por diez el tamano de una respuesta que en el
   90% de los casos se descarta porque quien buscaba sigue escribiendo.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

#: Los grupos que devuelve la busqueda. Es el mismo vocabulario del parametro
#: `type` y de las claves de `next_offset`: un solo nombre por cosa.
TIPOS = ("people", "posts", "hashtags", "courses", "events")


class TopicHit(BaseModel):
    """Un tema que la consulta activo.

    Se devuelve para que la pantalla pueda decir «buscando en Carpintería» y,
    sobre todo, para que se entienda POR QUE aparecen resultados que no llevan
    la palabra escrita. Un buscador que encuentra cosas sin explicar por que
    parece averiado.
    """

    id: str
    slug: str
    name: str


class PersonHit(BaseModel):
    """Una persona, con lo que declara PODER APORTAR. Nunca lo que busca.

    `offer_topics` sale exclusivamente de `RELACIONES_DE_OFERTA`
    (`can_help` / `teach` / `experienced`). Este esquema no tiene ningun campo
    para la demanda —`interest`, `learn`, `seek_guidance`— y eso no es un olvido:
    es la misma garantia que ya usa `ProfileOffer` en el recomendador. Si la
    demanda no cabe en el contrato, no puede escaparse aunque alguien se
    equivoque mas abajo.
    """

    id: str
    full_name: str
    username: str | None = None
    avatar_path: str | None = None
    #: Recortada. La biografia completa se lee en el perfil.
    bio: str = ""
    offer_topics: list[str] = Field(default_factory=list)


class PostHit(BaseModel):
    """Una publicacion encontrada, con lo justo para decidir si abrirla."""

    id: str
    #: El cuerpo recortado. Ver el docstring del modulo.
    body: str
    author_id: str
    author_name: str
    author_username: str | None = None
    author_avatar_path: str | None = None
    created_at: datetime | None = None
    topics: list[str] = Field(default_factory=list)


class HashtagHit(BaseModel):
    """Una etiqueta y cuantas publicaciones PUBLICADAS tiene de verdad."""

    tag: str
    display_tag: str
    posts_count: int = 0


class CourseHit(BaseModel):
    """Un curso del catalogo visible para quien pregunta."""

    id: str
    title: str
    subtitle: str | None = None
    level: str | None = None
    cover_path: str | None = None
    price_minor: int = 0
    currency: str = "PEN"
    coming_soon: bool = False
    author_id: str
    author_name: str = ""
    topics: list[str] = Field(default_factory=list)


class EventHit(BaseModel):
    """Un evento publicado.

    `time_state` viaja YA RESUELTO desde el servidor —`upcoming`, `past` o
    `undated`— por la misma razon que en el catalogo: decidirlo en el movil
    obligaria a comparar el texto ya formateado, que esta pensado para leerse y
    no para compararse.

    Y hace falta aqui, no solo en el catalogo: el encargo pide que la busqueda
    pueda encontrar un evento terminado —esconder lo historico no ayuda a
    nadie— pero que lo diga claramente. Sin este campo, un evento del mes
    pasado salia en los resultados exactamente igual que uno de la semana que
    viene.

    `ends_at` va tambien porque sin el no se puede decir la verdad: un congreso
    de tres dias que empezo ayer y termina mañana esta ocurriendo. Con solo
    `starts_at` la busqueda lo habria llamado terminado justo el dia que mas
    importa.
    """

    id: str
    title: str
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    location: str | None = None
    cover_path: str | None = None
    #: `upcoming` | `past` | `undated`. Lo calcula `catalog.eventos`, que es la
    #: MISMA funcion que usa el catalogo: dos reglas para lo mismo acabarian
    #: contestando distinto.
    time_state: str = "undated"


class SearchResults(BaseModel):
    """Todo lo que encontro una consulta, por grupos.

    `next_offset` lleva, por grupo, el `offset` con el que pedir la pagina
    siguiente, o `null` cuando ya no queda nada. Se calcula pidiendo un
    resultado mas del limite y mirando si llego: asi «hay mas» es un hecho
    comprobado y no una suposicion del cliente a partir de si la pagina vino
    llena, que es como se acaba pintando un boton «ver mas» que no lleva a nada.
    """

    query: str
    topics: list[TopicHit] = Field(default_factory=list)
    people: list[PersonHit] = Field(default_factory=list)
    posts: list[PostHit] = Field(default_factory=list)
    hashtags: list[HashtagHit] = Field(default_factory=list)
    courses: list[CourseHit] = Field(default_factory=list)
    events: list[EventHit] = Field(default_factory=list)
    next_offset: dict[str, int | None] = Field(default_factory=dict)
