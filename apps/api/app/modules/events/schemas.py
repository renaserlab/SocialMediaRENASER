"""Contratos de Eventos: los del organizador y los de la revisión.

DOS FAMILIAS SEPARADAS, como en la evaluación de cursos, y por la misma razón
estructural: `EventoDelOrganizador` NO declara los ocho puntajes. No es que se
filtren y se quiten; es que no caben. Así, añadir un campo al expediente interno
no puede publicarlo por descuido en la respuesta que ve quien organiza.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.modules.events import admission

MODALIDAD = "^(online|presential|live)$"


class BorradorCreate(BaseModel):
    """Lo que hace falta para empezar. Casi todo opcional a propósito.

    Un borrador se guarda a medias: obligar a rellenarlo entero para poder
    guardar es lo que hace que la gente escriba el evento en otro sitio y lo
    pegue de una vez.
    """

    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    #: Qué vivirá quien vaya. Es lo segundo de la ficha del blueprint.
    promise: str | None = Field(default=None, max_length=200)
    category: str | None = Field(default=None, max_length=48)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    #: La zona horaria REAL del evento (`America/Lima`). `starts_at` guarda el
    #: instante; sin esto no se puede escribir «19:00 hora de Lima» sin mentir.
    timezone: str | None = Field(default=None, max_length=64)
    location: str | None = Field(default=None, max_length=200)
    cover_path: str | None = Field(default=None, max_length=500)
    whatsapp_url: str | None = Field(default=None, max_length=500)
    event_type: str = Field(default="presential", pattern=MODALIDAD)
    capacity: int | None = Field(default=None, ge=0, le=1_000_000)


class BorradorUpdate(BaseModel):
    """Todo opcional: un PATCH cambia lo que trae y deja lo demás."""

    title: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    promise: str | None = Field(default=None, max_length=200)
    category: str | None = Field(default=None, max_length=48)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    timezone: str | None = Field(default=None, max_length=64)
    location: str | None = Field(default=None, max_length=200)
    cover_path: str | None = Field(default=None, max_length=500)
    whatsapp_url: str | None = Field(default=None, max_length=500)
    event_type: str | None = Field(default=None, pattern=MODALIDAD)
    capacity: int | None = Field(default=None, ge=0, le=1_000_000)
    #: `workflow_status` y `selection_status` NO están, y no es un olvido: el
    #: ciclo se mueve con acciones con nombre, no con un campo editable.


class EnvioARevision(BaseModel):
    motivo: str = Field(default="", max_length=500)


class VersionRead(BaseModel):
    version: int
    status: str
    reason: str = ""
    changed_fields: list[str] = Field(default_factory=list)
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ObservacionRead(BaseModel):
    """Lo que el organizador ve de una decisión: qué pasó y por qué.

    NO LLEVA LOS PUNTAJES. La evaluación interna es la deliberación de
    curaduría; enseñarla convierte la revisión en un regateo por dos puntos.
    """

    decision: str
    reason: str
    version: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class EventoDelOrganizador(BaseModel):
    """Su evento, tal y como lo ve quien lo organiza."""

    id: str
    title: str
    description: str
    promise: str | None = None
    category: str | None = None
    timezone: str | None = None
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    location: str | None = None
    cover_path: str | None = None
    whatsapp_url: str | None = None
    event_type: str
    capacity: int | None = None
    approved_capacity: int | None = None
    #: El estado con los derivados resueltos (`SOLD_OUT`, `COMPLETED_PENDING`).
    workflow_status: str
    #: `none`, `pending`, `approved` o `rejected`. El sello solo con `approved`.
    selection_status: str
    #: Verdadero solo si el servidor lo confirma. La app NO lo deduce.
    seleccionado_por_z: bool = False
    current_version: int | None = None
    registrations_count: int = 0
    #: Por qué no se puede enviar todavía. `None` cuando sí se puede.
    motivo_para_no_enviar: str | None = None
    #: Si el evento admite edición ahora mismo.
    editable: bool = False
    ultima_observacion: ObservacionRead | None = None


class PuntajesDeAdmision(BaseModel):
    """Los ocho criterios del blueprint, cada uno con su tope."""

    propuesta: int = Field(ge=0, le=admission.CRITERIOS["propuesta"])
    trayectoria: int = Field(ge=0, le=admission.CRITERIOS["trayectoria"])
    programa: int = Field(ge=0, le=admission.CRITERIOS["programa"])
    recinto: int = Field(ge=0, le=admission.CRITERIOS["recinto"])
    seguridad: int = Field(ge=0, le=admission.CRITERIOS["seguridad"])
    precio: int = Field(ge=0, le=admission.CRITERIOS["precio"])
    accesibilidad: int = Field(ge=0, le=admission.CRITERIOS["accesibilidad"])
    afinidad: int = Field(ge=0, le=admission.CRITERIOS["afinidad"])


class EvaluacionCreate(PuntajesDeAdmision):
    #: Evidencia obligatoria: una nota sin por qué no es evidencia.
    evidencia: str = Field(min_length=1, max_length=2000)
    falla_critica: bool = False
    motivo_de_la_falla: str = Field(default="", max_length=500)


class EvaluacionRead(PuntajesDeAdmision):
    version: int
    total: int
    falla_critica: bool
    motivo_de_la_falla: str = ""
    evidencia: str
    #: Hasta dónde permite llegar este puntaje. No es la decisión.
    decision_posible: str
    updated_at: datetime


class DecisionCreate(BaseModel):
    decision: str = Field(pattern="^(approved|conditional|rejected|changes_requested)$")
    #: Obligatorio. Sin motivo no hay decisión de admisión.
    motivo: str = Field(min_length=1, max_length=1000)


class MotivoObligatorio(BaseModel):
    motivo: str = Field(min_length=1, max_length=1000)


class DocumentoUpsert(BaseModel):
    kind: str = Field(min_length=1, max_length=48)
    status: str = Field(
        default="pending", pattern="^(pending|received|approved|rejected|expired)$"
    )
    expires_at: datetime | None = None
    required: bool = True
    blocks_publication: bool = True
    note: str = Field(default="", max_length=500)
    file_path: str | None = Field(default=None, max_length=500)


class DocumentoRead(BaseModel):
    kind: str
    status: str
    expires_at: datetime | None = None
    required: bool
    blocks_publication: bool
    note: str = ""

    model_config = ConfigDict(from_attributes=True)


class ExpedienteRead(EventoDelOrganizador):
    """La ficha de revisión. Añade lo que solo ve quien revisa."""

    organizer_id: str
    origin: str
    submitted_at: datetime | None = None
    evaluacion: EvaluacionRead | None = None
    documentos: list[DocumentoRead] = Field(default_factory=list)
    #: Los requisitos que hoy impedirían publicar.
    bloqueos_para_publicar: list[str] = Field(default_factory=list)
