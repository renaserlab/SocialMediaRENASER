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
    role: str = "user"
    is_private: bool = False
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ProfileUpdate(BaseModel):
    """Actualizacion parcial del perfil propio. Todos los campos opcionales."""

    full_name: str | None = Field(default=None, min_length=1, max_length=120)
    username: str | None = Field(
        default=None, min_length=3, max_length=50, pattern=r"^[a-zA-Z0-9_.-]+$"
    )
    bio: str | None = Field(default=None, max_length=600)
    avatar_path: str | None = Field(default=None, max_length=500)
    is_private: bool | None = None
