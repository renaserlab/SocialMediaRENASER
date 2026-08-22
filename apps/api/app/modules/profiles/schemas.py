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
    #: Nulo hasta que la persona abre el podcast por primera vez.
    podcast_started_at: datetime | None = None
    role: str = "user"
    is_featured: bool = False
    is_private: bool = False
    created_at: datetime
    followers_count: int = 0
    following_count: int = 0
    posts_count: int = 0
    #: "Me gusta" del perfil = los que ha RECIBIDO en sus publicaciones.
    #: No los que ha dado: lo que dice algo de alguien es cuanta gente ha
    #: valorado lo que comparte, no cuanto ha valorado el a otros.
    likes_count: int = 0
    #: Audio de presentacion. Ruta en Storage; el movil la firma para oirla.
    intro_audio_path: str | None = None
    intro_audio_duration_s: float | None = None
    intro_audio_updated_at: datetime | None = None
    # Si el usuario autenticado sigue a este perfil (false para el perfil propio).
    is_following: bool = False
    #: Si el usuario autenticado ha bloqueado a este perfil.
    is_blocked: bool = False

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


class FeaturedProfile(ProfileSummary):
    """Perfil sugerido al registrarse. Lleva contadores para dar contexto."""

    role: str = "user"
    followers_count: int = 0
    posts_count: int = 0


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
    # Igual que las imagenes: cadena vacia = quitar el audio (a null).
    intro_audio_path: str | None = Field(default=None, max_length=500)
    # Tope generoso; el limite util lo pone el movil (ver MAX_INTRO_MS).
    intro_audio_duration_s: float | None = Field(default=None, ge=0, le=600)
