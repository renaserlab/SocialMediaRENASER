"""Modelo de notificaciones in-app. Mapea public.notifications."""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base


def _uuid() -> str:
    return str(uuid4())


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    actor_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    type: Mapped[str] = mapped_column(Text)
    entity_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    entity_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict, server_default="{}")
    read_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class NotificationDelivery(Base):
    """Una entrega, con su estado, sus intentos y cuándo toca el siguiente.

    Esquema: migración 0066. Un aviso que falla ya no se pierde en un log.
    """

    __tablename__ = "notification_deliveries"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    notification_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("notifications.id", ondelete="CASCADE"),
        nullable=True,
    )
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE")
    )
    type: Mapped[str] = mapped_column(Text)
    locale: Mapped[str] = mapped_column(String(4), server_default=text("'es'"))
    status: Mapped[str] = mapped_column(String(16), server_default=text("'pending'"))
    attempts: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    max_attempts: Mapped[int] = mapped_column(Integer, server_default=text("5"))
    next_attempt_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    correlation_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Qué suceso de negocio es. Índice único parcial: uno por suceso.
    dedupe_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    sent_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        CheckConstraint(
            "status in ('pending', 'sent', 'failed')",
            name="notification_deliveries_estado",
        ),
        CheckConstraint(
            "(status = 'sent') = (sent_at is not null)",
            name="notification_deliveries_enviada_con_fecha",
        ),
        Index(
            "notification_deliveries_suceso_unico",
            "dedupe_key",
            unique=True,
            postgresql_where=text("dedupe_key is not null"),
            sqlite_where=text("dedupe_key is not null"),
        ),
        Index(
            "notification_deliveries_pendientes",
            "next_attempt_at",
            "id",
            postgresql_where=text("status = 'pending'"),
            sqlite_where=text("status = 'pending'"),
        ),
    )
