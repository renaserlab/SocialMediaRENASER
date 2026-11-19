"""Si la migración 0116 está aplicada en ESTA base, y cómo leer `almacen`.

La misma lección de `recommendations/esquema.py`: desplegar código no puede
exigir que una migración concreta ya esté pegada. Sin la 0116 la API se
comporta como antes (todo es Supabase y la subida a S3 responde 503).

A diferencia de aquel, el «no» se vuelve a mirar cada minuto: la 0116 se pega
a mano y conviene que la API la vea sin reiniciar. El «sí» se recuerda para
siempre (una columna no desaparece sola; la vuelta atrás de la 0116 pide
reiniciar la API, y lo dice).
"""

from __future__ import annotations

import logging
import time

from sqlalchemy import Text, Uuid, column, inspect, table
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("renaser.medios")

#: `post_media` vista solo con lo que hace falta para saber de dónde sale cada
#: medio. Es una tabla LIGERA de SQLAlchemy, no el modelo: ver `models.py`.
#: Las columnas van TIPADAS: comparar un uuid contra texto revienta en
#: PostgreSQL («operator does not exist: uuid = character varying»).
POST_MEDIA_ALMACEN = table(
    "post_media",
    column("id", Uuid(as_uuid=False)),
    column("post_id", Uuid(as_uuid=False)),
    column("almacen", Text),
)

#: Cada cuánto se vuelve a mirar un «no».
_REINTENTO_S = 60.0

_hay: bool | None = None
_mirado_en: float = 0.0


async def hay_almacen(db: AsyncSession) -> bool:
    """`post_media.almacen` y las dos tablas nuevas existen."""
    global _hay, _mirado_en
    if _hay is True:
        return True
    ahora = time.monotonic()
    if _hay is False and ahora - _mirado_en < _REINTENTO_S:
        return False
    conexion = await db.connection()

    def _mirar(sync) -> bool:
        inspector = inspect(sync)
        if not inspector.has_table("post_media"):
            return False
        if not any(c["name"] == "almacen" for c in inspector.get_columns("post_media")):
            return False
        return inspector.has_table("medios_subidas") and inspector.has_table(
            "post_media_respaldo_supabase"
        )

    resultado = await conexion.run_sync(_mirar)
    if not resultado and _hay is None:
        logger.warning(
            "La migracion 0116 no esta aplicada: todos los videos se tratan como "
            "Supabase y la subida a S3 queda apagada."
        )
    _hay, _mirado_en = resultado, ahora
    return resultado


def fijar(valor: bool | None) -> None:
    """Para las pruebas: forzar o borrar lo averiguado."""
    global _hay, _mirado_en
    _hay, _mirado_en = valor, 0.0


def olvidar() -> None:
    fijar(None)
