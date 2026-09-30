"""Las tablas de la agenda de Servicios (migración 0092, Incremento 4).

LA AGENDA ES DEL SERVICIO, no de una versión ni del prestador. `services` es
la identidad estable (0090): editar la descripción abre una versión nueva y
no toca ni una regla. La duración, la modalidad y la capacidad del servicio
SÍ viven en la versión, y el cálculo las lee de la PUBLICADA cada vez: si la
siguiente cambia la duración, los horarios cambian con ella sin reescribir la
agenda.

CINCO TABLAS, cada una con un solo trabajo:

  service_schedules            la configuración: zona IANA, estado, preparación,
                               descanso e intervalo entre inicios.
  service_schedule_rules       la semana: día, franja en minutos del día local,
                               modalidad, capacidad y si está activa.
  service_schedule_exceptions  una FECHA local: cerrarla entera o una franja,
                               añadir una franja o sustituir la semana ese día.
  service_schedule_blocks      un INTERVALO REAL (UTC) que el prestador aparta
                               con un motivo privado. No se mueve si cambia la
                               zona.
  service_schedule_events      el historial. Solo se añade; nunca el motivo.

LO QUE DECLARA EL ORM LO DECLARA TAMBIÉN LA BASE, con el mismo nombre y la
misma expresión en funciones de los dos motores, escrita con los límites de
`agenda_politica`. `tests/test_servicios_migracion_0092.py` compara los dos.

LO QUE SOLO DECLARA LA BASE, y se prueba contra PostgreSQL de verdad: las
RESTRICCIONES DE EXCLUSIÓN que impiden dos reglas activas que se cruzan el
mismo día o dos excepciones que se pisan en la misma fecha (son la autoridad
de los cruces), que la zona exista en la base de zonas, el historial que no se
reescribe y el borrado solo en cascada.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    Text,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.modules.events.models import _uuid
from app.modules.services import agenda_politica as limites
from app.modules.services.catalogo_models import MODALIDADES
from app.modules.services.models import _parametros
from app.shared.database import Base

_LETRAS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_MAYUSCULAS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_DE_ZONA = _LETRAS + "0123456789/_+-"


def _lista(valores) -> str:
    return ", ".join(repr(v) for v in valores)


# --------------------------------------------------------------------------- #
# Vocabulario
# --------------------------------------------------------------------------- #
AGENDA_ACTIVA = "active"
AGENDA_EN_PAUSA = "paused"
ESTADOS_DE_LA_AGENDA = (AGENDA_ACTIVA, AGENDA_EN_PAUSA)

#: Una excepción de fecha: cerrar (entera o una franja), añadir una franja o
#: sustituir la semana ese día.
CERRADA = "closed"
EXTRA = "extra"
SUSTITUYE = "replace"
TIPOS_DE_EXCEPCION = (CERRADA, EXTRA, SUSTITUYE)

ACCIONES = (
    "schedule_created",
    "schedule_updated",
    "rule_created",
    "rule_updated",
    "rule_deleted",
    "exception_created",
    "exception_updated",
    "exception_deleted",
    "block_created",
    "block_deleted",
)

_R = limites.REJILLA_MINUTOS
_DIA = limites.MINUTOS_DEL_DIA


def _franja(inicio: str, fin: str) -> str:
    return (
        f"{inicio} between 0 and {_DIA - _R} and {fin} between {_R} and {_DIA}"
        f" and {inicio} < {fin} and {inicio} % {_R} = 0 and {fin} % {_R} = 0"
    )


# --------------------------------------------------------------------------- #
# 1. La configuración
# --------------------------------------------------------------------------- #
class ServiceSchedule(Base):
    __tablename__ = "service_schedules"

    service_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("services.id", ondelete="CASCADE"), primary_key=True
    )
    #: IANA («America/Lima»). Nunca un desplazamiento fijo.
    timezone: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default=text(f"'{AGENDA_ACTIVA}'"))
    buffer_before_minutes: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    buffer_after_minutes: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    #: Cada cuánto empieza un horario. Sin valor: uno detrás de otro
    #: (preparación + duración + descanso).
    slot_interval_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: SIN CLAVE AJENA a propósito (0086, S10).
    created_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            f"length(timezone) between 3 and {limites.ZONA_MAXIMA}"
            f" and ltrim(timezone, '{_DE_ZONA}') = ''"
            f" and ltrim(substr(timezone, 1, 1), '{_MAYUSCULAS}') = ''"
            " and timezone like '%/%'"
            " and timezone not like 'Etc/%'",
            name="service_schedules_zona",
        ),
        CheckConstraint(
            f"status in ({_lista(ESTADOS_DE_LA_AGENDA)})", name="service_schedules_estado"
        ),
        CheckConstraint(
            f"buffer_before_minutes between 0 and {limites.SEPARACION_MAXIMA}"
            f" and buffer_before_minutes % {_R} = 0",
            name="service_schedules_preparacion",
        ),
        CheckConstraint(
            f"buffer_after_minutes between 0 and {limites.SEPARACION_MAXIMA}"
            f" and buffer_after_minutes % {_R} = 0",
            name="service_schedules_descanso",
        ),
        CheckConstraint(
            "slot_interval_minutes is null or (slot_interval_minutes between"
            f" {limites.INTERVALO_MINIMO} and {limites.INTERVALO_MAXIMO}"
            f" and slot_interval_minutes % {_R} = 0)",
            name="service_schedules_intervalo",
        ),
    )


# --------------------------------------------------------------------------- #
# 2. La semana
# --------------------------------------------------------------------------- #
class ServiceScheduleRule(Base):
    __tablename__ = "service_schedule_rules"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    service_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_schedules.service_id", ondelete="CASCADE")
    )
    #: ISO: 1 = lunes … 7 = domingo.
    weekday: Mapped[int] = mapped_column(SmallInteger)
    #: Minutos desde la medianoche LOCAL de la agenda. 1440 es «las 24:00».
    start_minute: Mapped[int] = mapped_column(Integer)
    end_minute: Mapped[int] = mapped_column(Integer)
    modality: Mapped[str] = mapped_column(Text)
    capacity: Mapped[int] = mapped_column(Integer, server_default=text("1"))
    active: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("weekday between 1 and 7", name="service_schedule_rules_dia"),
        CheckConstraint(_franja("start_minute", "end_minute"), name="service_schedule_rules_franja"),
        CheckConstraint(
            f"modality in ({_lista(MODALIDADES)})", name="service_schedule_rules_modalidad"
        ),
        CheckConstraint(
            f"capacity between 1 and {limites.CAPACIDAD_MAXIMA}", name="service_schedule_rules_capacidad"
        ),
        Index("service_schedule_rules_de_la_agenda", "service_id", "weekday", "start_minute"),
    )


# --------------------------------------------------------------------------- #
# 3. Las excepciones de fecha
# --------------------------------------------------------------------------- #
class ServiceScheduleException(Base):
    __tablename__ = "service_schedule_exceptions"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    service_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_schedules.service_id", ondelete="CASCADE")
    )
    #: La fecha LOCAL de la agenda.
    on_date: Mapped[date] = mapped_column(Date)
    kind: Mapped[str] = mapped_column(Text)
    #: Sin franja, solo `closed`: el día entero.
    start_minute: Mapped[int | None] = mapped_column(Integer, nullable=True)
    end_minute: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Solo lo que ABRE lleva modalidad y capacidad.
    modality: Mapped[str | None] = mapped_column(Text, nullable=True)
    capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            f"kind in ({_lista(TIPOS_DE_EXCEPCION)})", name="service_schedule_exceptions_tipo"
        ),
        CheckConstraint(
            "(start_minute is null and end_minute is null)"
            f" or (start_minute is not null and end_minute is not null and {_franja('start_minute', 'end_minute')})",
            name="service_schedule_exceptions_franja",
        ),
        CheckConstraint(
            f"kind = '{CERRADA}' or start_minute is not null",
            name="service_schedule_exceptions_abrir_con_franja",
        ),
        CheckConstraint(
            f"(kind = '{CERRADA}' and modality is null and capacity is null)"
            f" or (kind <> '{CERRADA}' and modality is not null and capacity is not null"
            f" and modality in ({_lista(MODALIDADES)}) and capacity between 1 and {limites.CAPACIDAD_MAXIMA})",
            name="service_schedule_exceptions_lo_que_abre",
        ),
        Index("service_schedule_exceptions_de_la_agenda", "service_id", "on_date"),
    )


# --------------------------------------------------------------------------- #
# 4. Los bloqueos
# --------------------------------------------------------------------------- #
class ServiceScheduleBlock(Base):
    __tablename__ = "service_schedule_blocks"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    service_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_schedules.service_id", ondelete="CASCADE")
    )
    #: Instantes REALES: cambiar la zona de la agenda no los mueve.
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    #: PRIVADO: solo lo ve el prestador. Nunca sale en lo público, en el
    #: historial, en la auditoría ni en un aviso.
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("starts_at < ends_at", name="service_schedule_blocks_orden"),
        CheckConstraint(
            f"reason is null or length(trim(reason)) between 1 and {limites.MOTIVO_MAXIMO}",
            name="service_schedule_blocks_motivo",
        ),
        Index("service_schedule_blocks_de_la_agenda", "service_id", "ends_at"),
    )


# --------------------------------------------------------------------------- #
# 5. El historial
# --------------------------------------------------------------------------- #
class ServiceScheduleEvent(Base):
    __tablename__ = "service_schedule_events"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    service_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("services.id", ondelete="CASCADE")
    )
    action: Mapped[str] = mapped_column(Text)
    #: SIN CLAVE AJENA a propósito (0086, S10).
    actor_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    actor_role: Mapped[str] = mapped_column(Text)
    details: Mapped[dict] = mapped_column(_parametros, server_default=text("'{}'"))
    idempotency_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(f"action in ({_lista(ACCIONES)})", name="service_schedule_events_accion"),
        CheckConstraint(
            "actor_role in ('provider', 'system')", name="service_schedule_events_rol"
        ),
        CheckConstraint(
            "idempotency_key is null or length(idempotency_key) between 8 and 100",
            name="service_schedule_events_clave",
        ),
        Index(
            "service_schedule_events_una_por_clave",
            "service_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key is not null"),
            sqlite_where=text("idempotency_key is not null"),
        ),
        Index("service_schedule_events_del_servicio", "service_id", text("created_at desc"), text("id desc")),
    )


__all__ = [
    "ACCIONES",
    "AGENDA_ACTIVA",
    "AGENDA_EN_PAUSA",
    "CERRADA",
    "ESTADOS_DE_LA_AGENDA",
    "EXTRA",
    "SUSTITUYE",
    "ServiceSchedule",
    "ServiceScheduleBlock",
    "ServiceScheduleEvent",
    "ServiceScheduleException",
    "ServiceScheduleRule",
    "TIPOS_DE_EXCEPCION",
]
