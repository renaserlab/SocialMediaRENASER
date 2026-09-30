"""La tabla del descubrimiento de Servicios (migración 0091, Incremento 3).

UNA SOLA: la lista de guardados de cada persona. Todo lo demás del
descubrimiento (catálogo, búsqueda, filtros, ficha, perfil del prestador,
sugerencias) LEE las tablas de la 0086–0090. Lo que declara el ORM lo declara
también la base con el mismo nombre; `tests/test_servicios_migracion_0091.py`
compara los dos.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base


class SavedService(Base):
    """Guardar no reserva, no avisa al prestador y no cuenta como popularidad."""

    __tablename__ = "saved_services"

    profile_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), primary_key=True
    )
    service_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("services.id", ondelete="CASCADE"), primary_key=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("saved_services_mios", "profile_id", text("created_at desc"), text("service_id desc")),
        Index("saved_services_del_servicio", "service_id"),
    )


__all__ = ["SavedService"]
