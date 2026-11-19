"""Tablas de la migración 0116 que solo toca la API.

`post_media.almacen` NO se mapea en el modelo `PostMedia` a propósito: todo
`select(PostMedia)` de la API nombraría la columna, y desplegar este código
antes de pegar la 0116 tumbaría el muro entero con un 500. La columna se lee y
se escribe con una tabla «ligera» (`esquema.POST_MEDIA_ALMACEN`) y solo cuando
`esquema.hay_almacen` dice que existe.

Estas dos tablas sí tienen modelo: son nuevas, solo las usan los caminos
nuevos (detrás de las banderas) y así las pruebas las tienen con
`create_all`.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Integer, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base


def _uuid() -> str:
    return str(uuid4())


class MedioSubida(Base):
    """Una subida a `pendientes/<uid>/…`, abierta, usada o cerrada."""

    __tablename__ = "medios_subidas"
    __table_args__ = (
        CheckConstraint("tipo in ('video', 'poster')", name="medios_subidas_tipo_check"),
        CheckConstraint(
            "estado in ('abierta', 'subida', 'usada', 'cancelada', 'vencida')",
            name="medios_subidas_estado_check",
        ),
        CheckConstraint("bytes_declarados > 0", name="medios_subidas_bytes_check"),
        CheckConstraint(
            "clave_pendiente like 'pendientes/%'", name="medios_subidas_clave_check"
        ),
    )

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    uid: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    #: El UUID que la app genera por publicación: video y póster cuentan una
    #: vez para el límite por hora.
    grupo: Mapped[str] = mapped_column(Uuid(as_uuid=False))
    tipo: Mapped[str] = mapped_column(Text)
    clave_pendiente: Mapped[str] = mapped_column(Text)
    content_type: Mapped[str] = mapped_column(Text)
    bytes_declarados: Mapped[int] = mapped_column(BigInteger)
    upload_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    partes_totales: Mapped[int | None] = mapped_column(Integer, nullable=True)
    estado: Mapped[str] = mapped_column(Text, default="abierta", server_default="abierta")
    media_id: Mapped[str | None] = mapped_column(Uuid(as_uuid=False), nullable=True)
    creada: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        # Desde Python y en UTC: el límite por hora compara contra esta fecha,
        # y en SQLite (pruebas) `now()` de la base no trae zona.
        default=lambda: datetime.now(timezone.utc),
    )
    expira: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class RespaldoSupabase(Base):
    """Las rutas de Supabase de un video que la fase 4 migró a S3."""

    __tablename__ = "post_media_respaldo_supabase"

    media_id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)
    storage_path: Mapped[str] = mapped_column(Text)
    poster_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    feed_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    stream_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    migrado_en: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
