"""Tokens de dispositivo para notificaciones push. Mapea public.device_tokens."""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base


class DeviceToken(Base):
    __tablename__ = "device_tokens"

    # El token identifica al DISPOSITIVO, no a la persona: por eso es la clave.
    # El mismo telefono puede cambiar de cuenta, y la misma cuenta tener varios
    # telefonos.
    token: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    platform: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
