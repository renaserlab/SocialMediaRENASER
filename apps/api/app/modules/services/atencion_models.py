"""Las tablas de la atención y la posventa de Servicios (migración 0094,
Incremento 6).

CUATRO TABLAS, cada una con un solo trabajo:

  service_attendances       LA ATENCIÓN de una reserva: el código de asistencia,
                            el inicio, el fin, la confirmación, el cierre y la
                            inasistencia. Una por reserva, y solo cuando algo
                            de la atención ocurre.
  service_incidents         EL CASO: uno por reserva. Su estado, lo resuelto y
                            el efecto económico SOLICITADO (nunca ejecutado).
  service_incident_entries  EL EXPEDIENTE: mensajes, evidencias privadas,
                            resoluciones, la apelación y las notas internas.
                            Solo se añade.
  service_reviews           LA RESEÑA VERIFICADA: una por reserva, de una
                            atención cerrada. Con la respuesta del prestador.

CANCELAR Y REPROGRAMAR NO TIENEN TABLA: son un cambio controlado de la reserva
(0093) y su línea en `service_booking_events`.

LO QUE DECLARA EL ORM LO DECLARA TAMBIÉN LA BASE, con el mismo nombre y la
misma expresión en funciones de los dos motores.
`tests/test_servicios_migracion_0094.py` compara los dos.

LO QUE SOLO DECLARA LA BASE: los saltos de la atención y del caso, la reseña
que solo se guarda con su atención cerrada, el expediente que no se reescribe
y el borrado solo en cascada.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.modules.events.models import _uuid
from app.modules.services import reserva_politica as limites
from app.modules.services.reserva_models import ADMINISTRACION, CLIENTE, PRESTADOR, SISTEMA, _lista
from app.shared.database import Base

# --------------------------------------------------------------------------- #
# Vocabulario
# --------------------------------------------------------------------------- #
#: La atención.
CON_CODIGO = "code_issued"
EN_CURSO = "in_progress"
TERMINADA = "completed"
CERRADA = "closed"
AUSENTE_EL_CLIENTE = "no_show_client"
AUSENTE_EL_PRESTADOR = "no_show_provider"
ESTADOS_DE_ATENCION = (CON_CODIGO, EN_CURSO, TERMINADA, CERRADA, AUSENTE_EL_CLIENTE, AUSENTE_EL_PRESTADOR)
#: Quién cerró: quien contrata (confirmó), el sistema (plazo vencido con
#: señal fuerte) o administración (al resolver un caso).
CIERRES = (CLIENTE, SISTEMA, ADMINISTRACION)

#: El caso.
MOTIVOS = (
    "provider_absent", "client_absent", "incomplete", "different_service",
    "quality", "safety", "technical", "other",
)
#: El que se puede reportar aunque el plazo ordinario haya pasado.
MOTIVO_DE_SEGURIDAD = "safety"
CASO_EN_CURSO = "open"
CASO_RESUELTO = "resolved"
CASO_APELADO = "appealed"
CASO_CERRADO = "closed"
CASO_RETIRADO = "withdrawn"
ESTADOS_DE_CASO = (CASO_EN_CURSO, CASO_RESUELTO, CASO_APELADO, CASO_CERRADO, CASO_RETIRADO)
#: Los que impiden cerrar la atención sola.
CASOS_VIVOS = (CASO_EN_CURSO, CASO_APELADO)
RESULTADOS = ("upheld", "partially_upheld", "rejected")
EFECTOS_EN_LA_ATENCION = ("none", "completed", "provider_no_show", "client_no_show")
#: EL DINERO: lo que se SOLICITA y su estado. Ningún valor dice «ejecutado».
SIN_EFECTO = "none"
EFECTOS_ECONOMICOS = (SIN_EFECTO, "full_refund", "partial_refund")
EFECTO_NO_APLICA = "not_applicable"
EFECTO_PENDIENTE = "pending"
EFECTO_BLOQUEADO = "blocked"
ESTADOS_DEL_EFECTO = (EFECTO_NO_APLICA, EFECTO_PENDIENTE, EFECTO_BLOQUEADO)
PARTES = (CLIENTE, PRESTADOR)

#: El expediente.
MENSAJE = "message"
EVIDENCIA = "evidence"
RESOLUCION = "resolution"
APELACION = "appeal"
NOTA_INTERNA = "internal_note"
TIPOS_DE_ENTRADA = (MENSAJE, EVIDENCIA, RESOLUCION, APELACION, NOTA_INTERNA)
ROLES_DE_ENTRADA = (CLIENTE, PRESTADOR, ADMINISTRACION)

#: La reseña.
RESENA_PENDIENTE = "pending"
RESENA_PUBLICADA = "published"
RESENA_ESCONDIDA = "hidden"
ESTADOS_DE_RESENA = (RESENA_PENDIENTE, RESENA_PUBLICADA, RESENA_ESCONDIDA)
EJES_DE_RESENA = ("fulfillment", "quality", "punctuality", "clarity")

_HEXADECIMAL = "0123456789abcdef"
_PESO_MAXIMO = 10 * 1024 * 1024


def _entre(columna: str, minimo: int, maximo: int, *, nulo: bool = False) -> str:
    base = f"{columna} between {minimo} and {maximo}"
    return f"{columna} is null or {base}" if nulo else base


def _texto(columna: str, minimo: int, maximo: int, *, nulo: bool = False) -> str:
    base = f"length(trim({columna})) between {minimo} and {maximo}"
    return f"{columna} is null or {base}" if nulo else base


def _en(columna: str, valores, *, nulo: bool = False) -> str:  # noqa: ANN001
    base = f"{columna} in ({_lista(valores)})"
    return f"{columna} is null or {base}" if nulo else base


# --------------------------------------------------------------------------- #
# 1. La atención
# --------------------------------------------------------------------------- #
class ServiceAttendance(Base):
    __tablename__ = "service_attendances"

    booking_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_bookings.id", ondelete="CASCADE"), primary_key=True
    )
    status: Mapped[str] = mapped_column(Text)
    #: El código que quien contrata enseña y el prestador escribe.
    checkin_code: Mapped[str | None] = mapped_column(Text, nullable=True)
    checkin_attempts: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    #: LA SEÑAL FUERTE: empezó con el código de quien contrata.
    started_with_code: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_by: Mapped[str | None] = mapped_column(Text, nullable=True)
    no_show_reported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(_en("status", ESTADOS_DE_ATENCION), name="service_attendances_estado"),
        CheckConstraint(
            f"checkin_code is null or (length(checkin_code) = {limites.CODIGO_DE_ASISTENCIA_CIFRAS}"
            " and ltrim(checkin_code, '0123456789') = '')",
            name="service_attendances_codigo",
        ),
        CheckConstraint(
            _entre("checkin_attempts", 0, limites.INTENTOS_DEL_CODIGO), name="service_attendances_intentos"
        ),
        CheckConstraint(_en("closed_by", CIERRES, nulo=True), name="service_attendances_cierre_de"),
        CheckConstraint(
            "(status = 'closed') = (closed_at is not null) and (closed_at is null) = (closed_by is null)",
            name="service_attendances_cierre",
        ),
        CheckConstraint(
            "(status not in ('in_progress', 'completed') or started_at is not null)"
            " and (not started_with_code or started_at is not null)"
            " and (status <> 'completed' or completed_at is not null)",
            name="service_attendances_inicio",
        ),
        CheckConstraint(
            "status not in ('no_show_client', 'no_show_provider') or no_show_reported_at is not null",
            name="service_attendances_ausencia",
        ),
        Index(
            "service_attendances_por_cerrar", "completed_at",
            postgresql_where=text("status = 'completed'"), sqlite_where=text("status = 'completed'"),
        ),
    )


# --------------------------------------------------------------------------- #
# 2. El caso
# --------------------------------------------------------------------------- #
class ServiceIncident(Base):
    __tablename__ = "service_incidents"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    booking_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_bookings.id", ondelete="CASCADE")
    )
    #: SIN CLAVE AJENA a propósito (0086, S10).
    opened_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    reason: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, server_default=text(f"'{CASO_EN_CURSO}'"))
    outcome: Mapped[str | None] = mapped_column(Text, nullable=True)
    attention_effect: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Lo que se SOLICITA, y su estado. Nunca «ejecutado».
    financial_effect: Mapped[str | None] = mapped_column(Text, nullable=True)
    financial_effect_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolved_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    resolutions: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    appealed_by: Mapped[str | None] = mapped_column(Text, nullable=True)
    appealed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(_en("reason", MOTIVOS), name="service_incidents_motivo"),
        CheckConstraint(_texto("description", *limites.DESCRIPCION_DEL_CASO), name="service_incidents_descripcion"),
        CheckConstraint(_en("status", ESTADOS_DE_CASO), name="service_incidents_estado"),
        CheckConstraint(_en("outcome", RESULTADOS, nulo=True), name="service_incidents_resultado"),
        CheckConstraint(
            _en("attention_effect", EFECTOS_EN_LA_ATENCION, nulo=True),
            name="service_incidents_efecto_en_la_atencion",
        ),
        CheckConstraint(
            _en("financial_effect", EFECTOS_ECONOMICOS, nulo=True), name="service_incidents_efecto_economico"
        ),
        CheckConstraint(
            _en("financial_effect_status", ESTADOS_DEL_EFECTO, nulo=True),
            name="service_incidents_estado_del_efecto",
        ),
        CheckConstraint(_entre("resolutions", 0, 2), name="service_incidents_resoluciones"),
        CheckConstraint(_en("appealed_by", PARTES, nulo=True), name="service_incidents_apela"),
        UniqueConstraint("booking_id", name="service_incidents_una_por_reserva"),
        CheckConstraint(
            "(resolutions = 0) = (outcome is null)"
            " and (outcome is null) = (resolved_at is null)"
            " and (outcome is null) = (attention_effect is null)"
            " and (outcome is null) = (financial_effect is null)"
            " and (outcome is null) = (financial_effect_status is null)",
            name="service_incidents_resuelta",
        ),
        CheckConstraint(
            "(status not in ('open', 'withdrawn') or resolutions = 0)"
            " and (status not in ('resolved', 'appealed') or resolutions = 1)"
            " and (status <> 'closed' or resolutions = 2)",
            name="service_incidents_estado_y_resoluciones",
        ),
        CheckConstraint(
            "(appealed_by is null) = (appealed_at is null)"
            " and (status <> 'appealed' or appealed_by is not null)"
            " and (resolutions < 2 or appealed_by is not null)",
            name="service_incidents_apelacion",
        ),
        CheckConstraint(
            "financial_effect is null or financial_effect <> 'none' or financial_effect_status = 'not_applicable'",
            name="service_incidents_sin_efecto",
        ),
        Index("service_incidents_por_estado", "status", text("created_at desc"), text("id desc")),
    )


# --------------------------------------------------------------------------- #
# 3. El expediente
# --------------------------------------------------------------------------- #
class ServiceIncidentEntry(Base):
    __tablename__ = "service_incident_entries"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    incident_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_incidents.id", ondelete="CASCADE")
    )
    author_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    author_role: Mapped[str] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(Text)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: La evidencia: ruta generada por el servidor, en el depósito privado.
    storage_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    content_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    byte_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sha256: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(_en("author_role", ROLES_DE_ENTRADA), name="service_incident_entries_rol"),
        CheckConstraint(_en("kind", TIPOS_DE_ENTRADA), name="service_incident_entries_tipo"),
        CheckConstraint(_texto("body", 1, limites.ENTRADA_MAXIMA, nulo=True), name="service_incident_entries_texto"),
        CheckConstraint(
            "storage_path is null or length(storage_path) between 10 and 300",
            name="service_incident_entries_ruta",
        ),
        CheckConstraint(_entre("byte_size", 1, _PESO_MAXIMO, nulo=True), name="service_incident_entries_peso"),
        CheckConstraint(
            f"sha256 is null or (length(sha256) = 64 and ltrim(sha256, '{_HEXADECIMAL}') = '')",
            name="service_incident_entries_huella",
        ),
        CheckConstraint(
            "(kind = 'evidence') = (storage_path is not null)"
            " and (storage_path is null) = (content_type is null)"
            " and (storage_path is null) = (byte_size is null)"
            " and (storage_path is null) = (sha256 is null)"
            " and (kind = 'evidence' or body is not null)",
            name="service_incident_entries_forma",
        ),
        CheckConstraint(
            "(kind not in ('internal_note', 'resolution') or author_role = 'admin')"
            " and (kind <> 'appeal' or author_role in ('client', 'provider'))",
            name="service_incident_entries_quien",
        ),
        Index("service_incident_entries_del_caso", "incident_id", "created_at", "id"),
        Index(
            "service_incident_entries_un_archivo", "incident_id", "sha256", unique=True,
            postgresql_where=text("sha256 is not null"), sqlite_where=text("sha256 is not null"),
        ),
    )


# --------------------------------------------------------------------------- #
# 4. La reseña verificada
# --------------------------------------------------------------------------- #
class ServiceReview(Base):
    __tablename__ = "service_reviews"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    booking_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("service_bookings.id", ondelete="CASCADE")
    )
    #: No borra nada y se comprueba al confirmar: la reseña se va por UN
    #: camino, el de su reserva.
    service_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("services.id", deferrable=True, initially="DEFERRED")
    )
    author_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    rating: Mapped[int] = mapped_column(Integer)
    fulfillment: Mapped[int | None] = mapped_column(Integer, nullable=True)
    quality: Mapped[int | None] = mapped_column(Integer, nullable=True)
    punctuality: Mapped[int | None] = mapped_column(Integer, nullable=True)
    clarity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    recommends: Mapped[bool] = mapped_column(Boolean)
    comment: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text)
    reply: Mapped[str | None] = mapped_column(Text, nullable=True)
    replied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint(_entre("rating", 1, 5), name="service_reviews_calificacion"),
        CheckConstraint(_entre("fulfillment", 1, 5, nulo=True), name="service_reviews_cumplimiento"),
        CheckConstraint(_entre("quality", 1, 5, nulo=True), name="service_reviews_calidad"),
        CheckConstraint(_entre("punctuality", 1, 5, nulo=True), name="service_reviews_puntualidad"),
        CheckConstraint(_entre("clarity", 1, 5, nulo=True), name="service_reviews_claridad"),
        CheckConstraint(_texto("comment", *limites.COMENTARIO_DE_RESENA), name="service_reviews_comentario"),
        CheckConstraint(_en("status", ESTADOS_DE_RESENA), name="service_reviews_estado"),
        CheckConstraint(_texto("reply", 1, limites.RESPUESTA_MAXIMA, nulo=True), name="service_reviews_respuesta"),
        UniqueConstraint("booking_id", name="service_reviews_una_por_reserva"),
        CheckConstraint("(reply is null) = (replied_at is null)", name="service_reviews_respondida"),
        Index("service_reviews_del_servicio", "service_id", "status", text("created_at desc"), text("id desc")),
    )


TABLAS = ("service_attendances", "service_incidents", "service_incident_entries", "service_reviews")

__all__ = [
    "APELACION",
    "AUSENTE_EL_CLIENTE",
    "AUSENTE_EL_PRESTADOR",
    "CASOS_VIVOS",
    "CASO_APELADO",
    "CASO_CERRADO",
    "CASO_EN_CURSO",
    "CASO_RESUELTO",
    "CASO_RETIRADO",
    "CERRADA",
    "CIERRES",
    "CON_CODIGO",
    "EFECTOS_ECONOMICOS",
    "EFECTOS_EN_LA_ATENCION",
    "EFECTO_BLOQUEADO",
    "EFECTO_NO_APLICA",
    "EFECTO_PENDIENTE",
    "EJES_DE_RESENA",
    "EN_CURSO",
    "ESTADOS_DEL_EFECTO",
    "ESTADOS_DE_ATENCION",
    "ESTADOS_DE_CASO",
    "ESTADOS_DE_RESENA",
    "EVIDENCIA",
    "MENSAJE",
    "MOTIVOS",
    "MOTIVO_DE_SEGURIDAD",
    "NOTA_INTERNA",
    "PARTES",
    "RESENA_ESCONDIDA",
    "RESENA_PENDIENTE",
    "RESENA_PUBLICADA",
    "RESOLUCION",
    "RESULTADOS",
    "ROLES_DE_ENTRADA",
    "SIN_EFECTO",
    "ServiceAttendance",
    "ServiceIncident",
    "ServiceIncidentEntry",
    "ServiceReview",
    "TABLAS",
    "TERMINADA",
    "TIPOS_DE_ENTRADA",
]
