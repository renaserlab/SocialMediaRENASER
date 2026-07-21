"""Modelo ORM de perfiles. Mapea public.profiles (ligada a auth.users)."""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base
from app.shared.enums import app_role


class Profile(Base):
    __tablename__ = "profiles"

    # id == auth.users.id (lo crea el trigger handle_new_user en Supabase).
    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    email: Mapped[str | None] = mapped_column(Text, nullable=True)
    full_name: Mapped[str] = mapped_column(Text, default="", server_default="")
    username: Mapped[str | None] = mapped_column(Text, unique=True, nullable=True)
    bio: Mapped[str] = mapped_column(Text, default="", server_default="")
    avatar_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Ruta dentro del bucket `avatars` (no una URL), igual que avatar_path.
    cover_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    role: Mapped[str] = mapped_column(app_role, default="user", server_default="user")
    is_private: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
