"""Modelos ORM de contenido: posts, media y comentarios.

Coinciden con public.posts / public.post_media / public.comments de la
migracion inicial de Supabase.
"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import BigInteger, DateTime, Float, ForeignKey, Integer, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.shared.database import Base
from app.shared.enums import content_status


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
    status: Mapped[str] = mapped_column(content_status, server_default="published")
    visibility: Mapped[str] = mapped_column(String(20), server_default="public")
    circle_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    # Etiqueta tematica; alimenta los filtros del podcast.
    category: Mapped[str | None] = mapped_column(Text, nullable=True)
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
    # Metadata del medio (migracion 0021). Todo opcional: el contenido anterior
    # funciona con el original y sin medidas, como hasta ahora.
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # Rutas derivadas: poster (imagen), version optimizada del feed y HLS.
    # El original de `storage_path` nunca se sobreescribe.
    poster_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    feed_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    stream_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    processing_status: Mapped[str] = mapped_column(
        String(20), default="ready", server_default="ready"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    post: Mapped[Post] = relationship(back_populates="media")


class PostLike(Base):
    __tablename__ = "post_likes"

    post_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("posts.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class SavedPost(Base):
    __tablename__ = "saved_posts"

    post_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("posts.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


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
    status: Mapped[str] = mapped_column(content_status, server_default="published")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
