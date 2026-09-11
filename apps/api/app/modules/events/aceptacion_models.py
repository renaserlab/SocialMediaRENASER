"""La aceptación de una política por una compra (migración 0069)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.modules.events.models import _uuid
from app.shared.database import Base


class EventOrderPolicyAcceptance(Base):
    """Qué versión aceptó ese pedido. NO SE MODIFICA: es un consentimiento."""

    __tablename__ = "event_order_policy_acceptances"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    order_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("event_orders.id", ondelete="CASCADE")
    )
    policy_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("event_policies.id", ondelete="RESTRICT")
    )

    #: Congelados al aceptar. El identificador basta para leerla; el tipo, la
    #: versión y la huella se copian para que la prueba siga en pie sola.
    policy_type: Mapped[str] = mapped_column(Text)
    policy_version: Mapped[str] = mapped_column(String(32))
    params_sha256: Mapped[str] = mapped_column(Text)

    accepted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    accepted_by: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), nullable=True
    )

    __table_args__ = (
        UniqueConstraint(
            "order_id", "policy_type", name="event_order_policy_acceptances_unica"
        ),
        Index(
            "event_order_policy_acceptances_del_pedido", "order_id", "policy_type"
        ),
    )


__all__ = ["EventOrderPolicyAcceptance"]
