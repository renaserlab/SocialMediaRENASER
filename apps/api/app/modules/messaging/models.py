"""Modelos de mensajería: conversaciones, miembros, mensajes y adjuntos.

Mapean public.conversations / public.conversation_members / public.messages /
public.message_attachments.
"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    BigInteger,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base


def _uuid() -> str:
    return str(uuid4())


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    kind: Mapped[str] = mapped_column(String(16), server_default="direct")
    created_by: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ConversationMember(Base):
    __tablename__ = "conversation_members"

    conversation_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_read_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    conversation_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        index=True,
    )
    sender_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE")
    )
    body: Mapped[str] = mapped_column(Text)
    #: Columna de la 0001 que nunca llego a usarse. Se mantiene porque quitarla
    #: seria una vuelta atras destructiva; lo nuevo vive en `message_attachments`,
    #: que si sabe de que tipo es cada archivo y admite varios por mensaje.
    attachment_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class MessageAttachment(Base):
    """Un archivo colgado de un mensaje (migracion 0033).

    TABLA NUEVA Y NINGUNA COLUMNA NUEVA EN `messages`, a proposito. Un
    `select(Message)` de SQLAlchemy pide TODAS las columnas mapeadas: anadir una
    a una tabla tan usada rompe produccion en cuanto el modelo se adelanta a la
    migracion. Una tabla aparte solo se consulta cuando existe, y quien lo
    comprueba es `esquema.hay_adjuntos_de_chat`.

    `conversation_id` esta repetido aqui —tambien lo sabe el mensaje— porque es
    lo que deja a la politica RLS decidir sin un JOIN, y lo que permite exigir
    que la ruta del fichero y la conversacion del mensaje sean la misma.
    """

    __tablename__ = "message_attachments"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    message_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("messages.id", ondelete="CASCADE"),
        index=True,
    )
    conversation_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        index=True,
    )
    storage_path: Mapped[str] = mapped_column(Text)
    #: image | video | document. Solo tres porque solo tres sabe pintar la
    #: interfaz: un tipo que nadie sabe mostrar es una fila que miente.
    kind: Mapped[str] = mapped_column(String(20))
    mime_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: El nombre original. Para un documento es lo unico que lo identifica: la
    #: ruta lleva un nombre aleatorio para que dos personas no se pisen.
    file_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_s: Mapped[float | None] = mapped_column(Float, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
