"""Las tablas propias de Eventos (migración 0060).

POR QUÉ NO SE AÑADEN COLUMNAS A `events`. Porque la regla del proyecto es que
desplegar el código no puede exigir que una migración ya esté aplicada, y una
columna nueva en `events` rompe `select(Event)` en TODAS las pantallas hasta que
alguien pega el SQL en Supabase: el catálogo, Explorar, la búsqueda y el perfil
a la vez. Una tabla nueva no rompe nada: si no está, `esquema.hay_eventos_v2`
dice que no y el módulo entero responde 503.

Es además la separación que se quiere: `events` es la ficha pública que comparte
el catálogo, y lo operativo —ciclo, admisión, versiones, documentos— vive en el
dominio de Eventos.

LO QUE **NO** SE GUARDA AQUÍ, y no es un olvido:

  - Precio, entradas, órdenes y liquidación: no hay cobro de eventos.
  - `SOLD_OUT`, `IN_PROGRESS`, `COMPLETED_PENDING`, `MODIFIED` y `SETTLED`: son
    estados DERIVADOS. Ver `states.py`.
  - Programa, participantes y accesibilidad: no existen todavía en ninguna
    parte y una columna vacía en la ficha invita a rellenarla con algo.
"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.modules.events import admission, states
from app.shared.database import Base

_DOCUMENTO = JSONB().with_variant(JSON, "sqlite")
_LISTA_DE_TEXTO = ARRAY(Text).with_variant(JSON, "sqlite")


def _uuid() -> str:
    return str(uuid4())


def _en_comillas(valores) -> str:
    return ", ".join(f"'{v}'" for v in valores)


class EventOperations(Base):
    """El ciclo operativo de un evento. Una fila por evento, o ninguna.

    NINGUNA significa «evento heredado»: se creó antes de que existiera la
    admisión. No desaparece del catálogo y no recibe el sello Z; ver el backfill
    de la 0060, que le escribe una fila con `origin = 'legacy'` para que se sepa
    por qué está publicado sin haber pasado por curaduría.
    """

    __tablename__ = "event_operations"

    event_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("events.id", ondelete="CASCADE"), primary_key=True
    )
    #: Los siete que se guardan. Los derivados no caben aquí a propósito.
    workflow_status: Mapped[str] = mapped_column(
        String(24), server_default=text(f"'{states.BORRADOR}'")
    )
    #: El sello. `approved` solo lo escribe una decisión de admisión real.
    selection_status: Mapped[str] = mapped_column(
        String(16), server_default=text("'none'")
    )
    category: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: La promesa: qué vivirá quien vaya. Es lo primero de la ficha del
    #: blueprint y hoy no cabe en ninguna columna de `events`.
    promise: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: La zona horaria REAL del evento (`America/Lima`), que `starts_at` no
    #: guarda: un `timestamptz` guarda el instante, no dónde ocurre.
    timezone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: El aforo que la admisión autorizó. Distinto de `events.capacity`, que es
    #: el que el organizador declara: se puede pedir 300 y aprobarse 200.
    approved_capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: La versión vigente (la última congelada). `None` mientras es borrador.
    current_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: `events_v2` para los nacidos con admisión; `legacy` para los de antes.
    origin: Mapped[str] = mapped_column(String(16), server_default=text("'events_v2'"))
    submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    decided_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            f"workflow_status in ({_en_comillas(states.GUARDABLES)})",
            name="event_operations_ciclo",
        ),
        CheckConstraint(
            "selection_status in ('none', 'pending', 'approved', 'rejected')",
            name="event_operations_seleccion",
        ),
        CheckConstraint(
            "origin in ('events_v2', 'legacy')", name="event_operations_origen"
        ),
        CheckConstraint(
            "approved_capacity is null or approved_capacity >= 0",
            name="event_operations_aforo",
        ),
        Index("event_operations_por_estado", "workflow_status"),
    )


class EventVersion(Base):
    """La fotografía inmutable de lo que se comprometió.

    SE CONGELA AL ENVIAR A REVISIÓN. Desde ese momento el organizador sigue
    editando su borrador —que es `events` y `event_operations`—, pero lo que
    curaduría lee es esta fila, y no cambia bajo sus pies. Es lo que impide
    «editar en silencio lo ya aprobado».

    LA INMUTABILIDAD NO LA GUARDA PYTHON. La 0060 pone un disparador que rechaza
    borrar una versión y rechaza reescribir su contenido, igual que hace la 0051
    con las versiones de curso.
    """

    __tablename__ = "event_versions"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    event_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("events.id", ondelete="CASCADE"), index=True
    )
    #: Correlativo por evento: 1, 2, 3…
    version: Mapped[int] = mapped_column(Integer)
    #: `submitted` -> `approved` -> `published`, o `superseded` cuando otra la
    #: sustituye. Solo una NO superada por evento (índice parcial).
    status: Mapped[str] = mapped_column(String(16), server_default=text("'submitted'"))
    snapshot: Mapped[dict] = mapped_column(_DOCUMENTO)
    #: Qué cambió respecto de la anterior. Vacío en la primera.
    changed_fields: Mapped[list | None] = mapped_column(_LISTA_DE_TEXTO, nullable=True)
    reason: Mapped[str] = mapped_column(Text, server_default=text("''"))
    created_by: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("event_id", "version", name="event_versions_correlativa"),
        CheckConstraint("version >= 1", name="event_versions_positiva"),
        CheckConstraint(
            "status in ('submitted', 'approved', 'published', 'superseded')",
            name="event_versions_estado",
        ),
    )


class EventAdmissionReview(Base):
    """La evaluación de curaduría: ocho puntajes, evidencia y falla crítica.

    UNA POR EVENTO Y VERSIÓN. Volver a evaluar la misma versión SUSTITUYE la
    anterior; evaluar otra versión es otra fila. Así el expediente cuenta qué se
    juzgó exactamente, y no una media de cosas distintas.

    NO LLEVA DECISIÓN. Puntuar no es decidir: la decisión está en la tabla de al
    lado, la toma otra capacidad y exige motivo.
    """

    __tablename__ = "event_admission_reviews"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    event_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("events.id", ondelete="CASCADE"), index=True
    )
    version: Mapped[int] = mapped_column(Integer)
    reviewer_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    propuesta: Mapped[int] = mapped_column(SmallInteger)
    trayectoria: Mapped[int] = mapped_column(SmallInteger)
    programa: Mapped[int] = mapped_column(SmallInteger)
    recinto: Mapped[int] = mapped_column(SmallInteger)
    seguridad: Mapped[int] = mapped_column(SmallInteger)
    precio: Mapped[int] = mapped_column(SmallInteger)
    accesibilidad: Mapped[int] = mapped_column(SmallInteger)
    afinidad: Mapped[int] = mapped_column(SmallInteger)
    #: La suma. Guardada Y comprobada por un CHECK contra los ocho sumandos: un
    #: total que no cuadre con sus partes es la forma silenciosa de subir una
    #: nota, y es justo lo que el blueprint prohíbe.
    total: Mapped[int] = mapped_column(SmallInteger)
    critical_failure: Mapped[bool] = mapped_column(
        Boolean, server_default=text("false")
    )
    critical_reason: Mapped[str] = mapped_column(Text, server_default=text("''"))
    #: Evidencia textual breve. Obligatoria: una nota sin por qué no es evidencia.
    evidence: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "event_id", "version", name="event_admission_reviews_una_por_version"
        ),
        *[
            CheckConstraint(
                f"{nombre} between 0 and {tope}",
                name=f"event_admission_reviews_{nombre}",
            )
            for nombre, tope in admission.CRITERIOS.items()
        ],
        CheckConstraint(
            "total = propuesta + trayectoria + programa + recinto + seguridad "
            "+ precio + accesibilidad + afinidad",
            name="event_admission_reviews_total_cuadra",
        ),
        CheckConstraint(
            "length(trim(evidence)) >= 1", name="event_admission_reviews_evidencia"
        ),
        CheckConstraint(
            "critical_failure = false or length(trim(critical_reason)) >= 1",
            name="event_admission_reviews_falla_con_motivo",
        ),
    )


class EventAdmissionDecision(Base):
    """La decisión, con el puntaje que la sostenía y su motivo.

    EL CHECK ES LA REGLA DEL BLUEPRINT, ESCRITA EN LA BASE:

        approved     ->  total >= 85 y sin falla crítica
        conditional  ->  80 <= total <= 84 y sin falla crítica
        rejected / changes_requested -> sin condición de puntaje

    Guarda el total Y la falla del momento en que se decidió, en vez de mirar la
    evaluación: una evaluación posterior no puede cambiar por qué se aprobó algo.
    Es lo que hace que la regla sea comprobable meses después.
    """

    __tablename__ = "event_admission_decisions"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    event_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("events.id", ondelete="CASCADE"), index=True
    )
    version: Mapped[int] = mapped_column(Integer)
    decision: Mapped[str] = mapped_column(String(20))
    #: Motivo obligatorio, y lo que ve el organizador cuando le devuelven el
    #: evento. Las notas internas de curaduría NO viajan aquí.
    reason: Mapped[str] = mapped_column(Text)
    total: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    critical_failure: Mapped[bool] = mapped_column(
        Boolean, server_default=text("false")
    )
    decided_by: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "decision in ('approved', 'conditional', 'rejected', 'changes_requested')",
            name="event_admission_decisions_valores",
        ),
        CheckConstraint("length(trim(reason)) >= 1", name="event_admission_decisions_motivo"),
        CheckConstraint(
            "total is null or total between 0 and 100",
            name="event_admission_decisions_total",
        ),
        CheckConstraint(
            # `total is not null` no sobra: en SQL, comparar contra NULL da
            # NULL, y un CHECK que evalua a NULL SE CUMPLE. Sin eso, `approved`
            # con el total vacio pasaba la restriccion entera.
            "(decision = 'approved' and critical_failure = false "
            f"  and total is not null and total >= {admission.UMBRAL_APROBACION}) "
            "or (decision = 'conditional' and critical_failure = false "
            f"  and total is not null and total between {admission.UMBRAL_CONDICIONAL} "
            f"  and {admission.UMBRAL_APROBACION - 1}) "
            "or decision in ('rejected', 'changes_requested')",
            name="event_admission_decisions_umbral",
        ),
        Index("event_admission_decisions_por_evento", "event_id", "created_at"),
    )


class EventDocument(Base):
    """Un requisito documental y su estado. NO un gestor documental.

    Lo que hace de verdad en este incremento: `blocks_publication` con estado
    distinto de `approved` IMPIDE publicar. Sin OCR, sin firma digital y sin
    validación automática, que es lo que el incremento excluye expresamente.
    """

    __tablename__ = "event_documents"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    event_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("events.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(48))
    status: Mapped[str] = mapped_column(String(16), server_default=text("'pending'"))
    #: Vencimiento. `expired` no se calcula solo: hay que mirarlo al publicar.
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    required: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    blocks_publication: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    note: Mapped[str] = mapped_column(Text, server_default=text("''"))
    #: Ruta en Storage, NUNCA una URL firmada: una URL guardada es una llave que
    #: caduca en la base y sigue pareciendo válida.
    file_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("event_id", "kind", name="event_documents_uno_por_tipo"),
        CheckConstraint(
            "status in ('pending', 'received', 'approved', 'rejected', 'expired')",
            name="event_documents_estado",
        ),
        CheckConstraint("length(trim(kind)) >= 1", name="event_documents_tipo"),
    )
