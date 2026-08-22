"""Modelo ORM de la agenda. Mapea public.bookings (migracion 0025)."""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base


def _uuid() -> str:
    return str(uuid4())


class Booking(Base):
    __tablename__ = "bookings"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    # Nombres explicitos a proposito: con "user_a" y "user_b" cualquier consulta
    # futura tendria que adivinar quien pide y quien da la sesion.
    requester_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    provider_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    topic: Mapped[str] = mapped_column(Text)
    note: Mapped[str] = mapped_column(Text, default="", server_default="")
    # Momento propuesto. Nulo mientras se acuerda por chat.
    scheduled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Zona horaria IANA de quien propuso ("America/Lima"). Sin ella, "5:00 PM"
    # no significa lo mismo para las dos partes.
    timezone: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(Text, default="pending", server_default="pending")
    conversation_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), nullable=True
    )
    # Cuando ocurrio. Es lo que permitira verificar una resena posterior.
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
