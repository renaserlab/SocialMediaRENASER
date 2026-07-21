"""Esquemas Pydantic de perfiles (formato que consume la app movil)."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ProfileRead(BaseModel):
    id: str
    email: str | None = None
    full_name: str = ""
    username: str | None = None
    bio: str = ""
    avatar_path: str | None = None
    cover_path: str | None = None
    role: str = "user"
    is_private: bool = False
    created_at: datetime
    followers_count: int = 0
    following_count: int = 0
    posts_count: int = 0
    # Si el usuario autenticado sigue a este perfil (false para el perfil propio).
    is_following: bool = False

    model_config = ConfigDict(from_attributes=True)


class ProfileSummary(BaseModel):
    """Perfil compacto para listas (búsqueda, seguidores)."""

    id: str
    full_name: str = ""
    username: str | None = None
    avatar_path: str | None = None
    bio: str = ""
    is_following: bool = False

    model_config = ConfigDict(from_attributes=True)


class ProfileUpdate(BaseModel):
    """Actualizacion parcial del perfil propio. Todos los campos opcionales."""

    full_name: str | None = Field(default=None, min_length=1, max_length=120)
    username: str | None = Field(
        default=None, min_length=3, max_length=50, pattern=r"^[a-zA-Z0-9_.-]+$"
    )
    bio: str | None = Field(default=None, max_length=600)
    # Cadena vacia = quitar la foto (a null). Es lo que distingue "no tocar este
    # campo" (ausente/None) de "borrar la imagen".
    avatar_path: str | None = Field(default=None, max_length=500)
    cover_path: str | None = Field(default=None, max_length=500)
    is_private: bool | None = None
