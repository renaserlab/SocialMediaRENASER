"""Modelos ORM de contenido: posts, media y comentarios.

Coinciden con public.posts / public.post_media / public.comments de la
migracion inicial de Supabase.
"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.shared.database import Base


def _uuid() -> str:
    return str(uuid4())


class Post(Base):
    __tablename__ = "posts"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    author_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        index=True,
    )
    body: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), server_default="published")
    visibility: Mapped[str] = mapped_column(String(20), server_default="public")
    circle_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    media: Mapped[list["PostMedia"]] = relationship(
        back_populates="post",
        cascade="all, delete-orphan",
        order_by="PostMedia.sort_order",
    )


class PostMedia(Base):
    __tablename__ = "post_media"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    post_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("posts.id", ondelete="CASCADE"),
        index=True,
    )
    storage_path: Mapped[str] = mapped_column(Text)
    media_type: Mapped[str] = mapped_column(String(20))  # image|video|audio|document
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    post: Mapped[Post] = relationship(back_populates="media")


class Comment(Base):
    __tablename__ = "comments"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    post_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("posts.id", ondelete="CASCADE"),
        index=True,
    )
    author_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        index=True,
    )
    parent_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    body: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), server_default="published")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
