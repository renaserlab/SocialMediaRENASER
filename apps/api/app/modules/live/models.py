"""Modelos de las transmisiones en vivo.

Mapean public.live_sessions / public.live_messages / public.live_reaction_totals
de la migracion 0029.
"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base


def _uuid() -> str:
    return str(uuid4())


class LiveSession(Base):
    """Una emision: quien, cuando, en que estado y donde vive su video."""

    __tablename__ = "live_sessions"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    host_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, default="", server_default="")

    #: `scheduled` | `live` | `ended` | `cancelled`. Es un CHECK en la base, no
    #: un enum de Postgres: ampliar un CHECK es una linea y ampliar un enum
    #: arrastra su propia migracion.
    status: Mapped[str] = mapped_column(
        String(16), default="scheduled", server_default="scheduled"
    )

    scheduled_for: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    #: Quien sirve el video. `none` mientras no haya proveedor elegido: la sala
    #: existe y el chat funciona; lo unico que falta es la imagen.
    provider: Mapped[str] = mapped_column(
        String(24), default="none", server_default="none"
    )
    provider_room_id: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: Ruta de la grabacion en Storage, no URL: las firmas caducan.
    recording_path: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: El PICO de espectadores, no el instantaneo. El instantaneo deja de
    #: significar nada en cuanto la emision termina.
    viewer_peak: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class LiveMessage(Base):
    """Un mensaje del chat. Se esconde al moderar; nunca se borra."""

    __tablename__ = "live_messages"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    session_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("live_sessions.id", ondelete="CASCADE"),
        index=True,
    )
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    #: Moderacion. Esconder y no borrar: borrar deja al moderador sin poder
    #: explicar por que lo hizo y a quien escribio sin saber que paso.
    hidden_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    hidden_by: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )


class LiveReactionTotal(Base):
    """El total acumulado por tipo de reaccion.

    NO hay una fila por corazon, y esa es la decision de rendimiento entera:
    en una emision animada se pulsan cientos por segundo. Los corazones que
    flotan por la pantalla viajan por Realtime Broadcast y no tocan la base;
    aqui solo queda el total, que es lo unico que sobrevive a la emision.
    """

    __tablename__ = "live_reaction_totals"

    session_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("live_sessions.id", ondelete="CASCADE"),
        primary_key=True,
    )
    kind: Mapped[str] = mapped_column(String(16), primary_key=True)
    total: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
