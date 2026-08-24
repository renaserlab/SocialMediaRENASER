"""Esquemas Pydantic del catalogo (lecturas publicas en Fase 1)."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class EventCreate(BaseModel):
    """Alta de evento. Solo para administradores."""

    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    #: Fecha y hora de inicio, ya combinadas por el cliente. Opcional: hay
    #: eventos anunciados "por confirmar".
    starts_at: datetime | None = None
    #: Fin del evento; permite mostrar rangos ("25-26 de agosto").
    ends_at: datetime | None = None
    location: str | None = Field(default=None, max_length=200)
    #: Ruta de la portada en Storage (no una URL): igual que avatar_path.
    cover_path: str | None = Field(default=None, max_length=500)
    #: Invitacion al grupo de WhatsApp del evento.
    whatsapp_url: str | None = Field(default=None, max_length=500)
    #: Valores admitidos por el CHECK de la tabla (0001_initial.sql). No usar
    #: otros: la fila se rechaza con `events_event_type_check`.
    event_type: str = Field(default="presential", pattern="^(online|presential|live)$")


class _PrecioDeCurso(BaseModel):
    """El precio, en la unidad que la base de datos guarda de verdad.

    POR QUE CAMBIA EL CONTRATO. Antes se recibia `price` en la unidad MAYOR
    (soles enteros) y el servidor multiplicaba por 100. Con ese contrato
    «49.90» no se podia expresar: llegaba como 49 y se guardaba 4900, cuarenta
    y nueve soles exactos. Un precio que el creador escribe y el sistema cambia
    en silencio no es un precio, es un error esperando a que alguien compre.

    `price` se sigue aceptando para no romper a los clientes que ya estan
    instalados, pero `price_minor` manda si vienen los dos.
    """

    #: Centavos. 4990 = S/ 49.90. Nunca decimales: en dinero, un flotante es
    #: un descuadre con fecha.
    price_minor: int | None = Field(default=None, ge=0, le=100_000_000)
    #: OBSOLETO: unidad mayor, sin centavos. Se mantiene por compatibilidad.
    price: int | None = Field(default=None, ge=0)

    def centavos(self, por_defecto: int | None = None) -> int | None:
        """El precio en centavos, o `None` si el cliente no menciono ninguno."""
        if self.price_minor is not None:
            return self.price_minor
        if self.price is not None:
            return self.price * 100
        return por_defecto


class CourseCreate(_PrecioDeCurso):
    """Alta de curso. La crea su autor; nace como BORRADOR."""

    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    cover_path: str | None = Field(default=None, max_length=500)
    currency: str = Field(default="PEN", pattern="^[A-Z]{3}$")
    #: Temas del catalogo comun (`topics`, migracion 0026). Opcional al crear
    #: —se puede rellenar despues— pero obligatorio para publicar.
    topic_ids: list[str] = Field(default_factory=list)


class EventUpdate(BaseModel):
    """Edicion de evento. Solo administradores; todos los campos opcionales."""

    title: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    location: str | None = Field(default=None, max_length=200)
    cover_path: str | None = Field(default=None, max_length=500)
    whatsapp_url: str | None = Field(default=None, max_length=500)
    event_type: str | None = Field(default=None, pattern="^(online|presential|live)$")


class CourseUpdate(_PrecioDeCurso):
    """Edicion de curso. Su autor o la administracion; todo opcional."""

    title: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    cover_path: str | None = Field(default=None, max_length=500)
    currency: str | None = Field(default=None, pattern="^[A-Z]{3}$")
    #: Anunciado pero todavia sin contenido. NO es lo mismo que borrador: un
    #: borrador no lo ve nadie mas que su autor (migracion 0014).
    coming_soon: bool | None = None
    #: Ausente deja los temas como estan; presente los REEMPLAZA.
    topic_ids: list[str] | None = None
    #: `status` NO se toca por aqui a proposito: publicar tiene validaciones
    #: propias y vive en /publish y /unpublish.


class EventRead(BaseModel):
    id: str
    organizer_id: str
    title: str
    description: str
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    location: str | None = None
    cover_path: str | None = None
    whatsapp_url: str | None = None
    event_type: str
    status: str
    capacity: int | None = None
    registrations_count: int = 0
    reserved_by_me: bool = False

    model_config = ConfigDict(from_attributes=True)


class CourseRead(BaseModel):
    id: str
    author_id: str
    title: str
    description: str
    cover_path: str | None = None
    price_minor: int
    currency: str
    status: str
    coming_soon: bool = False
    #: Vacio mientras la migracion 0028 no este aplicada: la tabla no existe y
    #: se dice «ninguno», que es la verdad, en lugar de fallar.
    topic_ids: list[str] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class CoursePublishResult(BaseModel):
    """Resultado de intentar publicar, con lo que falta si no se pudo."""

    id: str
    status: str
    published: bool
    #: Frases para ensenar tal cual. Vacio cuando se publico.
    missing: list[str] = Field(default_factory=list)
