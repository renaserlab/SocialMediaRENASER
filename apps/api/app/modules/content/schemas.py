"""Esquemas Pydantic de contenido."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator


class AuthorSummary(BaseModel):
    id: str
    full_name: str
    username: str | None = None
    avatar_path: str | None = None


class PostMediaRead(BaseModel):
    # Identificador del medio: lo usa el movil para pedir la playlist HLS
    # (/media/{id}/hls/...). Opcional por compatibilidad con filas al vuelo.
    id: str | None = None
    storage_path: str
    media_type: str
    sort_order: int = 0
    # Metadata (migracion 0021). Opcional: los medios anteriores no la tienen y
    # el movil sabe pintar sin ella, como hasta ahora.
    width: int | None = None
    height: int | None = None
    duration_s: float | None = None
    bytes: int | None = None
    poster_path: str | None = None
    feed_path: str | None = None
    stream_path: str | None = None
    processing_status: str | None = None


class PostMediaInput(BaseModel):
    """Medio ya subido a Storage por el cliente (bucket post-media)."""

    storage_path: str = Field(min_length=1, max_length=500)
    media_type: str = Field(pattern=r"^(image|video|audio|document)$")
    # Metadata calculada en el dispositivo al subir. Un movil anterior no la
    # manda y el pipeline del backend puede completarla despues.
    width: int | None = Field(default=None, ge=1, le=20000)
    height: int | None = Field(default=None, ge=1, le=20000)
    duration_s: float | None = Field(default=None, ge=0, le=24 * 3600)
    bytes: int | None = Field(default=None, ge=0)
    # El poster tambien lo sube el cliente a su carpeta del bucket; aqui llega
    # solo la ruta. La RLS de Storage ya impide escribir fuera de la propia.
    poster_path: str | None = Field(default=None, max_length=500)


class PostCreate(BaseModel):
    # OJO: sin author_id. El autor se toma del JWT (current_user.id).
    #
    # El texto puede ir vacio SI la publicacion lleva algun medio: un reel o una
    # foto se explican solos y exigir una descripcion era un requisito nuestro,
    # no de quien publica. Que no llegue todo vacio se comprueba abajo, porque
    # es la unica capa que ve el texto y los medios a la vez (un CHECK de tabla
    # no puede mirar `post_media`, que se inserta despues).
    body: str = Field(default="", max_length=3000)
    visibility: str = Field(default="public", pattern=r"^(public|followers|circle)$")
    # Medios (imagen/video/audio) ya subidos a Storage.
    media: list[PostMediaInput] = Field(default_factory=list, max_length=4)
    # Compatibilidad: rutas de imagen sin tipo explícito.
    image_paths: list[str] = Field(default_factory=list, max_length=4)
    # Etiqueta tematica (los filtros del podcast). Libre pero acotada.
    category: str | None = Field(default=None, max_length=40)
    # De que TRATA la publicacion (migracion 0027). Son ids de `topics`, la
    # misma taxonomia que usan las personas: por eso se pueden cruzar «quiero
    # aprender carpinteria» con «este video trata de carpinteria».
    #
    # No confundir con `category`, que es la carpeta con la que un creador
    # ordena SUS audios. Una es de quien publica; la otra, del producto.
    #
    # El maximo real lo comprueba el servidor (MAX_TEMAS_POR_PUBLICACION); aqui
    # solo se acota el tamano de la peticion.
    topic_ids: list[str] = Field(default_factory=list, max_length=10)
    # A QUIEN se etiqueta (migracion 0032). Son ids de perfiles elegidos de una
    # lista, no nombres escritos: «@ana» es ambiguo y aqui hay una notificacion
    # de por medio.
    #
    # OJO: NO hay campo para los hashtags. Esos los extrae el SERVIDOR de
    # `body`, porque si el cliente mandara la lista se podria colgar una
    # publicacion de #python sin que la palabra aparezca en el texto.
    #
    # El maximo real lo comprueba el servidor (MAX_MENCIONES_POR_PUBLICACION);
    # aqui solo se acota el tamano de la peticion.
    mentioned_user_ids: list[str] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def _algo_que_publicar(self) -> "PostCreate":
        if not self.body.strip() and not self.media and not self.image_paths:
            raise ValueError("Escribe algo o adjunta una foto, un video o un audio.")
        return self


class PostUpdate(BaseModel):
    """Edicion de una publicacion propia. Todo opcional.

    `media` ausente = no se toca el adjunto actual. `media` presente (aunque
    sea vacio) = se reemplaza por lo que llegue, lo que permite quitarlo.
    """

    body: str | None = Field(default=None, min_length=1, max_length=3000)
    visibility: str | None = Field(default=None, pattern=r"^(public|followers|circle)$")
    media: list[PostMediaInput] | None = Field(default=None, max_length=4)
    category: str | None = Field(default=None, max_length=40)
    # Ausente = no se tocan los temas. Presente (aunque sea vacio) = se
    # reemplazan por lo que llegue, lo que permite QUITAR uno mal elegido.
    topic_ids: list[str] | None = Field(default=None, max_length=10)
    # Ausente = no se tocan las etiquetas de personas. Presente (aunque sea
    # vacio) = se reemplazan, lo que permite DESETIQUETAR a alguien.
    #
    # Al reemplazar solo se avisa a QUIEN NO ESTABA ANTES: corregir una falta de
    # ortografia en una publicacion con cinco personas etiquetadas no puede
    # volver a hacer sonar cinco telefonos.
    mentioned_user_ids: list[str] | None = Field(default=None, max_length=10)


class RepostRead(BaseModel):
    """Quien republico una publicacion, y cuando.

    Vive aqui y no en `content/reposts.py` porque `PostRead` la necesita, y ese
    modulo importa este: al reves seria un ciclo de importacion.
    """

    id: str
    #: QUIEN comparte. Nunca sustituye al autor original de `PostRead.author`.
    author: AuthorSummary
    comentario: str = ""
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class PostRead(BaseModel):
    id: str
    author: AuthorSummary
    category: str | None = None
    body: str
    status: str
    visibility: str
    created_at: datetime
    media: list[PostMediaRead] = Field(default_factory=list)
    likes_count: int = 0
    comments_count: int = 0
    liked_by_me: bool = False
    saved_by_me: bool = False
    #: CUANTAS personas la han guardado. Solo el numero: quien guardo no se
    #: expone en ninguna parte, ni aqui ni en una ruta aparte. Guardar es un
    #: gesto privado —se aparta algo para uno mismo— y publicar la lista seria
    #: delatar algo que nadie eligio contar. `saved_by_me` sigue siendo la
    #: unica pista sobre una persona concreta, y esa persona es quien pregunta.
    saves_count: int = 0
    #: De que trata. Vacio en el contenido anterior a la 0027 y en el que nadie
    #: etiqueto: para ese, el recomendador cae a los temas del autor.
    topic_ids: list[str] = Field(default_factory=list)
    #: Las etiquetas sociales del texto, TAL Y COMO SE ESCRIBIERON la primera
    #: vez («#MiNegocio», no «#minegocio»). Vacio sin la migracion 0031 y en
    #: todo lo publicado antes de ella: el texto sigue mostrandose igual, lo que
    #: no hay es nada que tocar.
    hashtags: list[str] = Field(default_factory=list)
    #: A quien etiqueta. Vacio sin la migracion 0032.
    mentions: list[AuthorSummary] = Field(default_factory=list)
    #: Cuantas veces se ha republicado. Cero sin la migracion 0042.
    reposts_count: int = 0
    #: Si quien mira ya la republico. Sirve para que el boton diga «deshacer».
    reposted_by_me: bool = False
    #: QUIEN la esta compartiendo, cuando la publicacion llega por una
    #: republicacion. `None` en una publicacion normal.
    #:
    #: Va APARTE de `author` a proposito, y nunca lo sustituye: `author` es y
    #: sigue siendo el autor ORIGINAL. Si republicar cambiara el autor, seria
    #: una forma comoda de apropiarse del trabajo ajeno.
    repost: RepostRead | None = None

    model_config = ConfigDict(from_attributes=True)


class HashtagRead(BaseModel):
    """Una etiqueta y cuantas publicaciones tiene DE VERDAD.

    `posts_count` cuenta solo lo publicado. Si contara borradores y contenido
    retirado, la pantalla diria «12 publicaciones» y ensenaria ocho, que es
    peor que no poner numero.
    """

    #: Forma normalizada. Es la que va en la URL de /hashtag/[name].
    tag: str
    #: Como se escribio la primera vez. Es la que se pinta.
    display_tag: str
    posts_count: int = 0


class CommentCreate(BaseModel):
    body: str = Field(min_length=1, max_length=1200)
    parent_id: str | None = None


class CommentRead(BaseModel):
    id: str
    post_id: str
    author: AuthorSummary
    parent_id: str | None
    body: str
    created_at: datetime
    # Reacciones al COMENTARIO (migracion 0048). Van en el DTO y no en una ruta
    # aparte: una peticion por comentario serian veinte por pagina. Sin la
    # migracion valen 0 y false, que es como se pintaba antes.
    likes_count: int = 0
    viewer_reacted: bool = False

    model_config = ConfigDict(from_attributes=True)


class PodcastCategoryRead(BaseModel):
    id: str
    owner_id: str
    name: str
    position: int = 0
    #: Cuantos audios tiene asignados. Evita que el movil pida la lista entera
    #: solo para saber si una categoria esta vacia.
    episodes_count: int = 0

    model_config = ConfigDict(from_attributes=True)


class PodcastCategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class PodcastCategoryUpdate(BaseModel):
    """Renombrar o reordenar. Todo opcional."""

    name: str | None = Field(default=None, min_length=1, max_length=40)
    position: int | None = Field(default=None, ge=0, le=999)
