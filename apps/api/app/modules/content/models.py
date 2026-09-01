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


class CommentLike(Base):
    """Un «me gusta» a un COMENTARIO (migracion 0048, sin aplicar).

    Es `post_likes` con la clave apuntando a `comments`, y no una columna
    `entity_type` en aquella: `post_likes.post_id` tiene foranea a `posts`, y
    para que sirviera para las dos cosas habria que quitarla. La integridad la
    lleva la base o no la lleva nadie.

    La clave es `(comment_id, user_id)`: reaccionar dos veces es la misma fila.
    """

    __tablename__ = "comment_likes"

    comment_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("comments.id", ondelete="CASCADE"),
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


class Hashtag(Base):
    """Una etiqueta social, como entidad (migracion 0031).

    NO CONFUNDIR CON `Topic`. `topics` es la taxonomia cerrada del producto —25
    temas sembrados— y es lo que cruza el recomendador con lo que cada persona
    dijo que busca. `hashtags` es vocabulario abierto: nace cuando alguien lo
    escribe y no lo valida nadie. Conviven; ninguna sustituye a la otra.

    Es una tabla y no una columna de texto en `posts` porque una etiqueta tiene
    que poder responder «¿cuantas publicaciones tengo?» con un COUNT sobre un
    indice, y no con un LIKE sobre la tabla entera que ademas confundiria
    «#python» con «#pythonista».
    """

    __tablename__ = "hashtags"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    #: Forma normalizada, sin almohadilla. UNICA: es lo que hace que #IA, #ia y
    #: #Ia sean una sola etiqueta y no tres con un tercio de publicaciones cada
    #: una. La normaliza `hashtags.normalizar`, nunca la base.
    tag: Mapped[str] = mapped_column(Text, unique=True, index=True)
    #: Como se escribio la PRIMERA vez. Solo se pinta; nunca se busca por aqui.
    #: No se reescribe con cada uso: si no, la etiqueta cambiaria de aspecto
    #: sola en la pantalla de todo el mundo.
    display_tag: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class PostHashtag(Base):
    """Que publicacion lleva que etiqueta (migracion 0031).

    La clave es el par: escribir «#ia» dos veces en el mismo texto es enfasis,
    no dos etiquetas. Sin eso, la cuenta de publicaciones de una etiqueta
    mentiria a favor de quien la repite.
    """

    __tablename__ = "post_hashtags"

    post_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("posts.id", ondelete="CASCADE"),
        primary_key=True,
    )
    hashtag_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("hashtags.id", ondelete="CASCADE"),
        primary_key=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class PostMention(Base):
    """A quien etiqueta una publicacion (migracion 0032).

    A diferencia de un hashtag, esto NO se extrae del texto: lo elige quien
    publica de una lista de perfiles reales. El motivo es que una mencion manda
    una notificacion, y «@ana» es ambiguo —hay varias Anas y los nombres de
    usuario cambian—. Adivinar aqui significa avisar a la persona equivocada.

    La clave es el par, y eso es lo que garantiza —en la base, no en el
    codigo— que nadie reciba dos avisos por una sola publicacion.
    """

    __tablename__ = "post_mentions"

    post_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("posts.id", ondelete="CASCADE"),
        primary_key=True,
    )
    mentioned_user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class PodcastCategory(Base):
    """Categoria con la que un creador organiza sus audios (migracion 0024).

    Vive en este modulo, y no en uno propio, porque lo que agrupa son
    publicaciones: `posts.category` guarda el ID de una de estas filas. Sacarla
    a otro modulo habria separado la etiqueta de lo etiquetado.

    Las etiquetas antiguas ('mente', 'cuerpo', 'dinero') y la reservada del
    audio privado ('privado') siguen siendo validas en esa misma columna: por
    eso el contenido ya publicado no necesito ninguna conversion.
    """

    __tablename__ = "podcast_categories"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    owner_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        index=True,
    )
    name: Mapped[str] = mapped_column(Text)
    # Orden elegido por su dueno; empata por fecha de creacion.
    position: Mapped[int] = mapped_column(Integer, server_default="0", default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
