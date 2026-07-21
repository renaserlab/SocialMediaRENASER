"""Modelos ORM de historias: contenido efimero de 24 h.

Coinciden con public.stories / public.story_views de la migracion
0003_stories.sql.
"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base


def _uuid() -> str:
    return str(uuid4())


class Story(Base):
    __tablename__ = "stories"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    author_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        index=True,
    )
    storage_path: Mapped[str] = mapped_column(Text)
    media_type: Mapped[str] = mapped_column(String(20))  # image|video
    duration_ms: Mapped[int] = mapped_column(Integer, default=5000, server_default="5000")
    caption: Mapped[str] = mapped_column(Text, default="", server_default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    # El valor por defecto lo pone la base (now() + 24 h), no la aplicacion.
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class StoryView(Base):
    __tablename__ = "story_views"

    story_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("stories.id", ondelete="CASCADE"),
        primary_key=True,
    )
    viewer_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    viewed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
