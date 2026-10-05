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


class DirectConversationPair(Base):
    """La pareja de un chat directo, con la unicidad puesta en la BASE (0039).

    QUE FALLO ARREGLA. `POST /conversations/direct` buscaba la conversacion y,
    si no la encontraba, la creaba. Nada impedia crear dos: dos peticiones
    simultaneas —un doble toque, o un toque mas el reintento de una red lenta—
    hacen las dos el SELECT, las dos no encuentran nada, y las dos insertan. La
    bandeja acababa con la misma persona repetida varias veces.

    POR QUE UNA TABLA APARTE Y NO UNA COLUMNA EN `conversations`. Por lo mismo
    que explica `MessageAttachment`: un `select(Entidad)` de SQLAlchemy pide
    TODAS las columnas mapeadas, asi que anadir una a `conversations` rompe
    produccion en cuanto el modelo se adelanta a la migracion. Una tabla nueva
    solo se consulta cuando existe, y quien lo comprueba es
    `esquema.hay_pares_directos`.

    Y POR QUE NO BASTA UN INDICE SOBRE `conversation_members`. Porque la pareja
    son DOS filas de esa tabla, y un indice unico solo puede hablar de una fila.
    Aqui la pareja es UNA fila, y su clave primaria es la garantia.

    `user_low` / `user_high` son los dos identificadores ORDENADOS. Sin
    normalizar, (Ana, Bruno) y (Bruno, Ana) serian claves distintas y la
    restriccion no impediria nada: quien pulsa primero decide el orden.
    """

    __tablename__ = "direct_conversation_pairs"

    user_low: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_high: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    conversation_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("conversations.id", ondelete="CASCADE"),
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
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
    #: image | video | document | audio. Solo los que la interfaz sabe pintar:
    #: un tipo que nadie sabe mostrar es una fila que miente. `audio` lo anade
    #: la 0044 (notas de voz) y NO se puede escribir antes de que esa migracion
    #: este aplicada: el `CHECK` de la tabla lo rechazaria y eso es un 500. Quien
    #: lo comprueba es `esquema.hay_notas_de_voz`.
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


class MessageStoryContext(Base):
    """A que historia respondia un mensaje (migracion 0044).

    TABLA APARTE Y NINGUNA COLUMNA NUEVA EN `messages`, por lo mismo que explican
    `MessageAttachment` y `DirectConversationPair`: un `select(Message)` de
    SQLAlchemy pide TODAS las columnas mapeadas, y anadir una a la tabla mas
    consultada de la aplicacion rompe produccion en cuanto el modelo se adelanta
    a la migracion. Quien comprueba que esta tabla existe es
    `esquema.hay_respuestas_a_historias`.

    LA CLAVE PRIMARIA ES `message_id`, sin identificador propio: un mensaje
    responde a UNA historia o a ninguna, asi que dos contextos contradictorios
    para el mismo mensaje son imposibles por construccion en vez de por una
    comprobacion que alguien puede olvidar.

    POR QUE `story_id` ES ANULABLE, que es la decision que sostiene todo lo
    demas. Una historia dura un dia; el mensaje que la responde dura para
    siempre. Con `on delete set null` en la base, cuando la historia caduca o su
    autor la borra, el mensaje se queda intacto y esta fila pierde solo el
    puntero. La burbuja pinta entonces un contexto degradado —«Historia no
    disponible»— en vez de desaparecer o reventar. Ese es el caso NORMAL, no la
    excepcion: al dia siguiente lo son todas.

    Y POR ESO `story_owner_id` NO ES ANULABLE. Es lo unico que sigue sabiendo de
    quien era la historia cuando ya no existe. Sin el se podria decir
    «respondiste a una historia», pero no «a la historia de Ana», que es lo que
    hace que el mensaje se siga entendiendo meses despues.
    """

    __tablename__ = "message_story_context"

    message_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("messages.id", ondelete="CASCADE"),
        primary_key=True,
    )
    story_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        # `SET NULL` y no `CASCADE`: ver el docstring. Con `CASCADE`, borrar una
        # historia se llevaria el contexto de todos los mensajes que la
        # respondian y el chat perderia el hilo de la conversacion.
        ForeignKey("stories.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    story_owner_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class MessageBookingContext(Base):
    """De que sesion 1:1 habla un mensaje, y que paso en ella (migracion 0097).

    TABLA APARTE Y NINGUNA COLUMNA NUEVA EN `messages`, por lo mismo que
    `MessageStoryContext`. Quien comprueba que existe es
    `esquema.hay_sesiones_en_el_chat`.

    UNA FILA POR HECHO, no por sesion: pedirla, aceptarla, rechazarla,
    cancelarla… cada uno es un mensaje del chat con su fila aqui. Asi la
    conversacion cuenta lo que paso en orden, y la tarjeta de la solicitud —que
    es el mensaje con `event = 'requested'`— pinta el estado de HOY leyendolo de
    `bookings`, que sigue siendo la unica fuente de verdad.

    SOLO ESCRIBE EL SERVIDOR. La politica de la tabla no deja insertar desde el
    cliente: si no, cualquiera podria dejar escrito en un chat «sesion aceptada»
    sin que nadie hubiera aceptado nada.
    """

    __tablename__ = "message_booking_context"

    message_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("messages.id", ondelete="CASCADE"),
        primary_key=True,
    )
    booking_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("bookings.id", ondelete="CASCADE"),
        index=True,
    )
    #: requested | accepted | rejected | cancelled | reschedule_requested | completed
    event: Mapped[str] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
