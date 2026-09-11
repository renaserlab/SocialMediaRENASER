"""Reserva y disputa (migración 0068).

El saldo en sí NO se redefine aquí: es `commerce.OwnerSaleBalance`, al que la
0068 le añade `event_id` y `event_order_id`. Duplicar el modelo sería tener dos
verdades sobre la misma tabla.
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

from app.modules.events.models import _uuid
from app.shared.database import Base

MOTIVOS_DE_RESERVA = (
    "aftersale_case",
    "refund",
    "cancellation",
    "essential_change",
    "dispute",
    "operational_risk",
)


class OwnerSaleReserve(Base):
    """Parte del saldo, retenida por un motivo concreto.

    NO TRAE NINGÚN PORCENTAJE. Cuánto reservar lo decide una política publicada;
    esta tabla solo sabe representar el importe que le den.
    """

    __tablename__ = "owner_sale_reserves"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    balance_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("owner_sale_balances.id", ondelete="RESTRICT"),
    )
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    currency: Mapped[str] = mapped_column(String(3))
    reason: Mapped[str] = mapped_column(String(32))
    case_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    status: Mapped[str] = mapped_column(String(16), server_default=text("'held'"))
    #: La política que la calculó. Nula = una retención que nadie decidió.
    policy_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    created_by: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    released_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    release_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        CheckConstraint("amount_minor > 0", name="owner_sale_reserves_importe"),
        CheckConstraint(
            f"reason in ({', '.join(repr(m) for m in MOTIVOS_DE_RESERVA)})",
            name="owner_sale_reserves_motivo",
        ),
        CheckConstraint(
            "status in ('held', 'released', 'consumed')",
            name="owner_sale_reserves_estado",
        ),
        CheckConstraint(
            "(status = 'held') = (released_at is null)",
            name="owner_sale_reserves_liberada_con_fecha",
        ),
        # UNA VIVA POR SALDO Y MOTIVO: dos por lo mismo serían el mismo dinero
        # retenido dos veces.
        Index(
            "owner_sale_reserves_viva_unica",
            "balance_id",
            "reason",
            unique=True,
            postgresql_where=text("status = 'held'"),
            sqlite_where=text("status = 'held'"),
        ),
    )


class EventDispute(Base):
    """Una reclamación del banco del titular. NO es una devolución."""

    __tablename__ = "event_disputes"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    provider: Mapped[str] = mapped_column(String(24))
    environment: Mapped[str] = mapped_column(String(16))
    external_id: Mapped[str] = mapped_column(Text)

    event_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    order_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    organizer_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    balance_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)

    amount_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[str] = mapped_column(String(24), server_default=text("'open'"))
    evidence_due_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    evidence_required: Mapped[str | None] = mapped_column(Text, nullable=True)
    assignee_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)

    #: QUIÉN ASUME LA PÉRDIDA. Nulo hasta que haya política: decidirlo sin regla
    #: aprobada es inventarse la regla.
    liability: Mapped[str | None] = mapped_column(String(16), nullable=True)
    policy_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)

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
            "status in ('open', 'needs_response', 'under_review', 'won', 'lost',"
            " 'closed')",
            name="event_disputes_estado",
        ),
        CheckConstraint(
            "liability is null or policy_id is not null",
            name="event_disputes_responsable_con_politica",
        ),
        UniqueConstraint(
            "provider", "environment", "external_id", name="event_disputes_referencia_unica"
        ),
    )


class EventDisputeEvent(Base):
    """El historial. SOLO AÑADIR, y lo impone un disparador de la 0068."""

    __tablename__ = "event_dispute_events"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    dispute_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("event_disputes.id", ondelete="CASCADE")
    )
    from_status: Mapped[str | None] = mapped_column(Text, nullable=True)
    to_status: Mapped[str] = mapped_column(Text)
    actor_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    actor_role: Mapped[str] = mapped_column(String(16), server_default=text("'system'"))
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
