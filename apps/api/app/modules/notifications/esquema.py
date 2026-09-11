"""Que partes de la 0043 estan aplicadas en ESTA base.

Mismo patron —y por el mismo motivo— que `recommendations/esquema.py` y
`catalog/esquema.py`: el codigo tiene que funcionar CON la migracion y SIN
ella. Con ella, un aviso repetido lo IMPIDE la base; sin ella, se hace lo que
se puede desde Python y se sigue avisando igual.

Una sola consulta por proceso, con el inspector de SQLAlchemy —que se comporta
igual en PostgreSQL y en SQLite— y el resultado cacheado. No se detecta
probando y capturando la excepcion: en PostgreSQL una sentencia fallida deja la
transaccion inservible, asi que descubrirlo «a ver que pasa» obligaria a
recuperarse de un error en mitad de una operacion que iba bien.
"""

from __future__ import annotations

import logging

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("renaser.notifications")

#: Lo averiguado, por proceso.
_cache: dict[str, bool] = {}


async def hay_clave_de_deduplicacion(db: AsyncSession) -> bool:
    """Si `notifications.dedupe_key` existe (migracion 0043).

    Sin ella no hay indice unico y por tanto no hay garantia: se cae al respaldo
    de `service._ya_existe`, que es una consulta antes de insertar. Ese respaldo
    quita los duplicados que se ven de verdad —seguir, dejar de seguir y volver
    a seguir— pero NO cierra la carrera de dos peticiones simultaneas, porque
    ningun `if` puede cerrarla. Por eso la 0043 existe.
    """
    if "notifications.dedupe_key" not in _cache:
        conexion = await db.connection()

        def _mirar(sync) -> bool:
            inspector = inspect(sync)
            if not inspector.has_table("notifications"):
                return False
            return any(
                c["name"] == "dedupe_key"
                for c in inspector.get_columns("notifications")
            )

        _cache["notifications.dedupe_key"] = await conexion.run_sync(_mirar)
        if not _cache["notifications.dedupe_key"]:
            logger.warning(
                "La migracion 0043 no esta aplicada: los avisos se deduplican "
                "con una consulta previa, no con el indice unico de la base."
            )
    return _cache["notifications.dedupe_key"]


def olvidar() -> None:
    """Solo para los tests: que uno no herede el esquema sondeado por otro."""
    _cache.clear()


_cache_entregas: dict[str, bool] = {}


async def hay_entregas(db) -> bool:
    """Si la 0066 está aplicada: la cola de entregas con reintento.

    SE MIRA TAMBIÉN `device_tokens.locale`, y no solo que la tabla exista. La
    0066 trae las dos cosas y el encolado lee esa columna para saber en qué
    idioma componer; con media migración aplicada la puerta decía que sí, la
    lectura lanzaba, PostgreSQL dejaba la transacción inservible y el `commit`
    de quien provocó el aviso —una devolución ya confirmada— se deshacía.
    """
    if "entregas" not in _cache_entregas:
        from sqlalchemy import inspect

        conexion = await db.connection()

        def _mirar(sync) -> bool:  # noqa: ANN001
            inspector = inspect(sync)
            if not inspector.has_table("notification_deliveries"):
                return False
            columnas = {c["name"] for c in inspector.get_columns("device_tokens")}
            return "locale" in columnas

        _cache_entregas["entregas"] = await conexion.run_sync(_mirar)
    return _cache_entregas["entregas"]


def olvidar_entregas() -> None:
    _cache_entregas.clear()
