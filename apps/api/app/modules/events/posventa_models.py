"""Posventa de eventos: políticas, cambios y expedientes.

VACÍO SIGNIFICA BLOQUEADO. Ninguna de estas tablas nace con una decisión
dentro. Sin una política publicada no se ejecuta dinero, no se revoca una
entrada y no se aprueba nada: la operación falla en cerrado y dice que la
función todavía no está configurada. Un valor por defecto «razonable» —siete
días, cero por ciento, aprobación automática— es una decisión de la empresa
tomada por descuido, y ninguna prueba la delata porque el resultado cuadra.

Esquema: migración 0064, entregada SIN aplicar.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from sqlalchemy import JSON
from sqlalchemy.dialects.postgresql import JSONB

from app.modules.events.models import _uuid
from app.shared.database import Base

#: JSONB en PostgreSQL, JSON en SQLite. Igual que en comercio.
_parametros = JSON().with_variant(JSONB, "postgresql")

# --------------------------------------------------------------------------- #
# Políticas
# --------------------------------------------------------------------------- #
#: Cada tipo es una decisión distinta de la empresa. Separados a propósito:
#: publicar la de elegibilidad no puede encender la de transferencias.
POLITICA_ELEGIBILIDAD = "aftersale_eligibility"
POLITICA_EJECUCION = "refund_execution"
POLITICA_EFECTO_ENTRADA = "ticket_effect"
POLITICA_RESENAS = "review_window"
POLITICA_RESPUESTA = "organizer_reply"
POLITICA_RETENCION = "settlement_hold"
POLITICA_RESERVA = "settlement_reserve"
POLITICA_DISPUTA = "dispute_liability"
POLITICA_SALDO_NEGATIVO = "negative_balance"

TIPOS_DE_POLITICA = (
    POLITICA_ELEGIBILIDAD,
    POLITICA_EJECUCION,
    POLITICA_EFECTO_ENTRADA,
    POLITICA_RESENAS,
    POLITICA_RESPUESTA,
    POLITICA_RETENCION,
    POLITICA_RESERVA,
    POLITICA_DISPUTA,
    POLITICA_SALDO_NEGATIVO,
)

BORRADOR = "draft"
PUBLICADA = "published"
SUPERADA = "superseded"


class EventPolicy(Base):
    """Una decisión de la empresa, versionada y publicada.

    `params` son los números; `body` es el texto que lee la persona. Separados
    porque uno se calcula y el otro se enseña, y mezclarlos hace que cambiar
    una coma reescriba una regla.
    """

    __tablename__ = "event_policies"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    policy_type: Mapped[str] = mapped_column(Text)
    scope: Mapped[str] = mapped_column(String(8), server_default=text("'global'"))
    event_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    jurisdiction: Mapped[str] = mapped_column(String(8), server_default=text("'PE'"))
    version: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16), server_default=text("'draft'"))

    #: `{}` NO es «todo en cero»: es «nada decidido». Quien lo lea tiene que
    #: tratarlo como una política que no habilita nada.
    params: Mapped[dict] = mapped_column(_parametros, default=dict)
    params_sha256: Mapped[str] = mapped_column(Text)

    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    locale: Mapped[str] = mapped_column(String(4), server_default=text("'es'"))

    effective_from: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    effective_to: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    published_by: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    created_by: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )

    __table_args__ = (
        CheckConstraint(
            f"policy_type in ({', '.join(repr(t) for t in TIPOS_DE_POLITICA)})",
            name="event_policies_tipo",
        ),
        CheckConstraint("scope in ('global', 'event')", name="event_policies_alcance"),
        CheckConstraint(
            f"status in ('{BORRADOR}', '{PUBLICADA}', '{SUPERADA}')",
            name="event_policies_estado",
        ),
        CheckConstraint(
            "(scope = 'event') = (event_id is not null)",
            name="event_policies_alcance_coherente",
        ),
        # NO es una equivalencia: una política superada conserva su fecha,
        # porque esa fecha es su historia.
        CheckConstraint(
            f"status <> '{PUBLICADA}' or published_at is not null",
            name="event_policies_publicada_con_fecha",
        ),
        UniqueConstraint(
            "policy_type",
            "scope",
            "event_id",
            "jurisdiction",
            "locale",
            "version",
            name="event_policies_version_unica",
        ),
        Index(
            "event_policies_vigente_global",
            "policy_type",
            "jurisdiction",
            "locale",
            unique=True,
            postgresql_where=text(
                "status = 'published' and effective_to is null and scope = 'global'"
            ),
            sqlite_where=text(
                "status = 'published' and effective_to is null and scope = 'global'"
            ),
        ),
        # UN BORRADOR POR EVENTO Y TIPO (0069). Dos peticiones a la vez creaban
        # dos, y el servicio leía una con `scalar()`: la otra quedaba huérfana.
        Index(
            "event_policies_un_borrador_de_evento",
            "policy_type",
            "event_id",
            "jurisdiction",
            "locale",
            unique=True,
            postgresql_where=text("status = 'draft' and scope = 'event'"),
            sqlite_where=text("status = 'draft' and scope = 'event'"),
        ),
        Index(
            "event_policies_vigente_de_evento",
            "policy_type",
            "event_id",
            "jurisdiction",
            "locale",
            unique=True,
            postgresql_where=text(
                "status = 'published' and effective_to is null and scope = 'event'"
            ),
            sqlite_where=text(
                "status = 'published' and effective_to is null and scope = 'event'"
            ),
        ),
    )


# --------------------------------------------------------------------------- #
# Cambios del evento
# --------------------------------------------------------------------------- #
SIN_CLASIFICAR = "pending"
CLASIFICACIONES = (
    SIN_CLASIFICAR,
    "editorial",
    "operational",
    "possibly_essential",
    "essential",
    "not_essential",
)


class EventChange(Base):
    """Qué cambió después de publicar, y qué decía antes.

    REGISTRAR NO ES CLASIFICAR. `pending` no es «no esencial»: es «nadie lo ha
    mirado». Tratarlos igual es exactamente cómo un cambio material reescribe
    en silencio lo que la gente compró.
    """

    __tablename__ = "event_changes"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    event_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("events.id", ondelete="CASCADE")
    )
    field: Mapped[str] = mapped_column(String(64))
    previous_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    new_value: Mapped[str | None] = mapped_column(Text, nullable=True)

    classification: Mapped[str] = mapped_column(
        String(24), server_default=text(f"'{SIN_CLASIFICAR}'")
    )
    classified_by: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    classified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    classification_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    changed_by: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            f"classification in ({', '.join(repr(c) for c in CLASIFICACIONES)})",
            name="event_changes_clasificacion",
        ),
        CheckConstraint(
            f"(classification = '{SIN_CLASIFICAR}') = (classified_at is null)",
            name="event_changes_clasificada_con_fecha",
        ),
        CheckConstraint(
            "previous_value is distinct from new_value",
            name="event_changes_algo_cambio",
        ),
        Index("event_changes_del_evento", "event_id", text("created_at desc")),
    )


# --------------------------------------------------------------------------- #
# Expedientes
# --------------------------------------------------------------------------- #
ENVIADO = "submitted"
EN_REVISION = "under_review"
ESPERANDO = "awaiting_information"
APROBADO = "approved"
RECHAZADO = "rejected"
DEVOLUCION_PENDIENTE = "refund_pending"
DEVOLUCION_EN_CURSO = "refund_processing"
RESUELTO = "resolved"
CANCELADO = "cancelled"
FALLIDO = "failed"

ESTADOS_DE_EXPEDIENTE = (
    ENVIADO,
    EN_REVISION,
    ESPERANDO,
    APROBADO,
    RECHAZADO,
    DEVOLUCION_PENDIENTE,
    DEVOLUCION_EN_CURSO,
    RESUELTO,
    CANCELADO,
    FALLIDO,
)

#: Los que ocupan sitio: mientras uno esté así, no se abre otro sobre el mismo
#: pedido. Tiene que coincidir letra por letra con el índice parcial de la 0064.
EXPEDIENTES_VIVOS = (
    ENVIADO,
    EN_REVISION,
    ESPERANDO,
    APROBADO,
    DEVOLUCION_PENDIENTE,
    DEVOLUCION_EN_CURSO,
    FALLIDO,
)

TIPOS_DE_EXPEDIENTE = (
    "buyer_cancellation",
    "event_cancelled",
    "event_rescheduled",
    "essential_change",
    "refund_request",
    "exception",
    "dispute",
)


class EventAftersaleCase(Base):
    """El expediente. Lo que pidió el comprador y lo que decidió quien revisa.

    EL MOTIVO DEL COMPRADOR Y LA NOTA INTERNA VAN EN COLUMNAS DISTINTAS. Es lo
    que hace imposible que una respuesta al comprador lleve dentro lo que
    alguien anotó para uso interno.
    """

    __tablename__ = "event_aftersale_cases"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    event_id: Mapped[str] = mapped_column(Uuid(as_uuid=False))
    order_id: Mapped[str] = mapped_column(Uuid(as_uuid=False))
    buyer_id: Mapped[str] = mapped_column(Uuid(as_uuid=False))
    organizer_id: Mapped[str] = mapped_column(Uuid(as_uuid=False))

    kind: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(24), server_default=text(f"'{ENVIADO}'"))
    origin: Mapped[str] = mapped_column(String(16), server_default=text("'buyer'"))

    buyer_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    internal_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    assignee_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)

    #: NULA mientras no haya decisión: es lo que permite decir después con qué
    #: reglas exactas se resolvió esto.
    policy_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    outcome: Mapped[str | None] = mapped_column(String(24), nullable=True)

    #: NULOS, nunca cero. Un cero se lee como «se decidió no devolver nada».
    refund_amount_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    currency: Mapped[str | None] = mapped_column(String(3), nullable=True)

    provider: Mapped[str] = mapped_column(String(24), server_default=text("'none'"))
    environment: Mapped[str] = mapped_column(String(16), server_default=text("'sandbox'"))
    external_refund_id: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        CheckConstraint(
            f"status in ({', '.join(repr(e) for e in ESTADOS_DE_EXPEDIENTE)})",
            name="event_aftersale_cases_estado",
        ),
        CheckConstraint(
            f"kind in ({', '.join(repr(k) for k in TIPOS_DE_EXPEDIENTE)})",
            name="event_aftersale_cases_tipo",
        ),
        CheckConstraint(
            "outcome is null or policy_id is not null",
            name="event_aftersale_cases_resultado_con_politica",
        ),
        CheckConstraint(
            "(refund_amount_minor is null) = (currency is null)",
            name="event_aftersale_cases_importe_con_moneda",
        ),
        UniqueConstraint("id", "event_id", name="event_aftersale_cases_de_su_evento"),
        Index(
            "event_aftersale_cases_vivo_por_pedido",
            "order_id",
            unique=True,
            postgresql_where=text(
                "status in (" + ", ".join(repr(e) for e in EXPEDIENTES_VIVOS) + ")"
            ),
            sqlite_where=text(
                "status in (" + ", ".join(repr(e) for e in EXPEDIENTES_VIVOS) + ")"
            ),
        ),
        Index(
            "event_aftersale_cases_del_comprador",
            "buyer_id",
            text("created_at desc"),
            text("id desc"),
        ),
    )


class EventAftersaleCaseTicket(Base):
    """Qué entradas toca el expediente, y cómo estaban al abrirlo."""

    __tablename__ = "event_aftersale_case_tickets"

    case_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("event_aftersale_cases.id", ondelete="CASCADE"),
        primary_key=True,
    )
    ticket_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("event_tickets.id", ondelete="RESTRICT"),
        primary_key=True,
    )
    #: Congelado: si la entrada se usa o se revoca después, sigue constando qué
    #: había cuando se pidió.
    status_at_open: Mapped[str] = mapped_column(String(16))

    #: Qué se le hizo POR ESTE EXPEDIENTE. `none` es «nada todavía»; retener es
    #: reversible y revocar no.
    effect: Mapped[str] = mapped_column(String(16), server_default=text("'none'"))
    effect_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    effect_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    effect_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "effect in ('none', 'under_review', 'blocked', 'cancelled',"
            " 'revoked', 'restored')",
            name="event_aftersale_case_tickets_efecto",
        ),
        CheckConstraint(
            "(effect = 'none') = (effect_at is null)",
            name="event_aftersale_case_tickets_efecto_con_fecha",
        ),
        # UNA SOLA RETENCION POR ENTRADA. Dos a la vez serian dos motivos
        # distintos para lo mismo y nadie sabria cual levantar.
        Index(
            "event_aftersale_case_tickets_retencion_unica",
            "ticket_id",
            unique=True,
            postgresql_where=text("effect in ('under_review', 'blocked')"),
            sqlite_where=text("effect in ('under_review', 'blocked')"),
        ),
    )


class EventAftersaleCaseEvent(Base):
    """El historial. SOLO AÑADIR, y lo impone un disparador de la 0064."""

    __tablename__ = "event_aftersale_case_events"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    case_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("event_aftersale_cases.id", ondelete="CASCADE")
    )
    from_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    to_status: Mapped[str] = mapped_column(String(32))
    actor_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    actor_role: Mapped[str] = mapped_column(String(16), server_default=text("'system'"))
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    external_reference: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "actor_role in ('buyer', 'organizer', 'support', 'admin', 'system')",
            name="event_aftersale_case_events_rol",
        ),
        Index("event_aftersale_case_events_del_caso", "case_id", "created_at", "id"),
    )
