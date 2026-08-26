"""Esquemas de mensajería."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.modules.content.schemas import AuthorSummary

#: Los tipos de adjunto que la interfaz sabe pintar: una foto, un vídeo o un
#: archivo que se descarga. Aceptar un cuarto tipo aquí sería guardar filas que
#: ninguna pantalla puede mostrar.
TIPOS_DE_ADJUNTO = ("image", "video", "document")

#: Cuántos archivos caben en un mensaje. Diez es holgado para mandar un puñado
#: de fotos de una vez y evita que una sola petición encole cien subidas.
MAX_ADJUNTOS = 10


class DirectConversationCreate(BaseModel):
    user_id: str


class ConversationRead(BaseModel):
    id: str
    kind: str
    title: str | None = None
    # Para chats directos: el otro participante.
    other: AuthorSummary | None = None
    last_message: str | None = None
    last_message_at: datetime | None = None
    unread_count: int = 0
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AttachmentCreate(BaseModel):
    """Un archivo YA SUBIDO a Storage que se quiere colgar de un mensaje.

    Los bytes NO pasan por el backend: la aplicación sube directamente al bucket
    `message-media` con su propio token, igual que hace con las publicaciones, y
    aquí solo llega la ruta. Es lo que permite subir un vídeo grande por trozos
    reanudables sin que la API tenga que sostener la conexión mientras tanto.

    Que la ruta sea legítima —que apunte a ESTA conversación y a la carpeta de
    quien la manda— lo comprueba el router antes de guardar nada.
    """

    storage_path: str = Field(min_length=1, max_length=512)
    kind: str
    mime_type: str | None = Field(default=None, max_length=255)
    file_name: str | None = Field(default=None, max_length=255)
    bytes: int | None = Field(default=None, ge=0)
    width: int | None = Field(default=None, ge=0)
    height: int | None = Field(default=None, ge=0)
    duration_s: float | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _tipo_conocido(self) -> "AttachmentCreate":
        if self.kind not in TIPOS_DE_ADJUNTO:
            raise ValueError(
                f"Tipo de adjunto no admitido: {self.kind}. "
                f"Admitidos: {', '.join(TIPOS_DE_ADJUNTO)}."
            )
        return self


class AttachmentRead(BaseModel):
    id: str
    storage_path: str
    kind: str
    mime_type: str | None = None
    file_name: str | None = None
    bytes: int | None = None
    width: int | None = None
    height: int | None = None
    duration_s: float | None = None

    model_config = ConfigDict(from_attributes=True)


class MessageCreate(BaseModel):
    """Un mensaje: solo texto, solo archivo, o texto y archivo.

    `body` admite la cadena vacía —antes exigía al menos un carácter— porque
    mandar una foto sin escribir nada es lo normal en un chat. Lo que NO se
    admite es un mensaje que no diga nada: sin texto y sin archivos no hay nada
    que entregar, y guardar una burbuja vacía solo sirve para confundir a quien
    la recibe.
    """

    body: str = Field(default="", max_length=5000)
    attachments: list[AttachmentCreate] = Field(
        default_factory=list, max_length=MAX_ADJUNTOS
    )

    @model_validator(mode="after")
    def _no_vacio(self) -> "MessageCreate":
        if not self.body.strip() and not self.attachments:
            raise ValueError("Escribe algo o adjunta un archivo.")
        return self


class MessageRead(BaseModel):
    id: str
    conversation_id: str
    sender: AuthorSummary
    body: str
    created_at: datetime
    #: Vacía cuando el mensaje es solo texto, y también mientras la migración
    #: 0033 espere aprobación: sin la tabla no hay adjuntos que devolver.
    attachments: list[AttachmentRead] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)
