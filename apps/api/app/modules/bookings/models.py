"""Modelos ORM de la agenda. Mapean public.bookings (migracion 0025) y
public.availability_slots (migracion 0100)."""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, SmallInteger, Text, Uuid, func
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


class AvailabilitySlot(Base):
    """Una franja de la semana tipo de una persona («martes de 9 a 12»).

    Las reglas estan en `disponibilidad.py`; aqui solo la forma de la tabla.
    En su tabla y no en `profiles` a proposito: una columna nueva en `Profile`
    haria que este codigo, desplegado antes que la migracion, no pudiera leer
    ningun perfil.
    """

    __tablename__ = "availability_slots"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    #: 0 = lunes … 6 = domingo.
    weekday: Mapped[int] = mapped_column(SmallInteger)
    #: Minutos desde las 00:00, en la zona horaria de la persona.
    starts_minute: Mapped[int] = mapped_column(SmallInteger)
    ends_minute: Mapped[int] = mapped_column(SmallInteger)
    timezone: Mapped[str] = mapped_column(
        Text, default="America/Lima", server_default="America/Lima"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
