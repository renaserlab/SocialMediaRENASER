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

    model_config = ConfigDict(from_attributes=True)


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
