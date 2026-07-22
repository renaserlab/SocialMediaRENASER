"""Esquemas Pydantic de contenido."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class AuthorSummary(BaseModel):
    id: str
    full_name: str
    username: str | None = None
    avatar_path: str | None = None


class PostMediaRead(BaseModel):
    storage_path: str
    media_type: str
    sort_order: int = 0


class PostMediaInput(BaseModel):
    """Medio ya subido a Storage por el cliente (bucket post-media)."""

    storage_path: str = Field(min_length=1, max_length=500)
    media_type: str = Field(pattern=r"^(image|video|audio|document)$")


class PostCreate(BaseModel):
    # OJO: sin author_id. El autor se toma del JWT (current_user.id).
    body: str = Field(min_length=1, max_length=3000)
    visibility: str = Field(default="public", pattern=r"^(public|followers|circle)$")
    # Medios (imagen/video/audio) ya subidos a Storage.
    media: list[PostMediaInput] = Field(default_factory=list, max_length=4)
    # Compatibilidad: rutas de imagen sin tipo explícito.
    image_paths: list[str] = Field(default_factory=list, max_length=4)


class PostUpdate(BaseModel):
    """Edicion de una publicacion propia. Todo opcional.

    `media` ausente = no se toca el adjunto actual. `media` presente (aunque
    sea vacio) = se reemplaza por lo que llegue, lo que permite quitarlo.
    """

    body: str | None = Field(default=None, min_length=1, max_length=3000)
    visibility: str | None = Field(default=None, pattern=r"^(public|followers|circle)$")
    media: list[PostMediaInput] | None = Field(default=None, max_length=4)


class PostRead(BaseModel):
    id: str
    author: AuthorSummary
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
