"""Modelo ORM de `metricas_de_video`. Mapea la migracion 0115.

El esquema lo posee la migracion; esto solo lo mapea para insertar y leer. En
SQLite (las pruebas) el `bigint` autoincremental se degrada a `integer`, que es
lo unico que SQLite sabe numerar solo.
"""

from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Integer, SmallInteger, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base

_ID = BigInteger().with_variant(Integer, "sqlite")


class MetricaDeVideo(Base):
    """Una medicion: un hito de la carga de Inicio o un tramo de un video.

    UNA FILA POR MEDICION Y NO UNA POR LOTE, a proposito: las medianas y los
    percentiles por plataforma y tramo salen de un `group by` directo, sin
    desarmar JSON en cada consulta.
    """

    __tablename__ = "metricas_de_video"

    id: Mapped[int] = mapped_column(_ID, primary_key=True, autoincrement=True)
    creado_en: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    sesion: Mapped[str] = mapped_column(Text)
    plataforma: Mapped[str] = mapped_column(Text)
    version_app: Mapped[str | None] = mapped_column(Text, nullable=True)
    build: Mapped[str | None] = mapped_column(Text, nullable=True)
    modelo: Mapped[str | None] = mapped_column(Text, nullable=True)
    sistema: Mapped[str | None] = mapped_column(Text, nullable=True)
    red: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: `feed_pedido`, `feed_respuesta`, `urls_firmadas`, `primer_fotograma`,
    #: `primera_reproduccion` (hitos) o `primer_video`, `deslizamiento`, `otro`.
    tramo: Mapped[str] = mapped_column(Text)
    #: Hito: ms desde el arranque. Tramo: ms hasta reproducir (`NULL` = no llego).
    ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fotograma_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    esperas: Mapped[int | None] = mapped_column(SmallInteger, nullable=True)
    espera_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    formato: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: De donde salio el video: 'supabase' (Storage) o 's3' (S3 + CloudFront).
    almacen: Mapped[str | None] = mapped_column(Text, nullable=True)
    bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    error: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
