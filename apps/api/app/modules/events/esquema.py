"""Si la migración 0060 está aplicada en ESTA base.

Misma regla que `catalog/esquema.py` y por la misma razón cara: desplegar código
no puede exigir que una migración concreta ya esté puesta. La 0060 se entrega
escrita y SIN aplicar, así que todo esto tiene que funcionar con ella y sin ella.

QUÉ PASA SIN LA 0060:

  - El catálogo, la ficha y la reserva funcionan EXACTAMENTE igual que hoy,
    incluida la corrección del aforo: el bloqueo de la fila del evento no
    necesita ninguna tabla nueva.
  - Las rutas de organizador y de admisión responden 503
    `events_workflow_not_available`. No 404, que haría pensar que la ruta está
    mal escrita, ni 500, que haría pensar que algo se rompió.
  - Ningún evento lleva sello Z, porque no hay dónde guardar una aprobación.
"""

from __future__ import annotations

import logging

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ServiceUnavailableError

logger = logging.getLogger("renaser.events")

_cache: dict[str, bool] = {}

#: Las cinco que añade la 0060. Se comprueban todas: una base con
#: `event_operations` pero sin `event_versions` sería una migración aplicada a
#: medias, y el editor de Supabase la corre como una transacción.
_TABLAS = (
    "event_operations",
    "event_versions",
    "event_admission_reviews",
    "event_admission_decisions",
    "event_documents",
)


async def hay_eventos_v2(db: AsyncSession) -> bool:
    """Si la 0060 está aplicada: ciclo, versiones, admisión y documentos."""
    if "eventos_v2" not in _cache:
        conexion = await db.connection()

        def _mirar(sync) -> bool:  # noqa: ANN001
            inspector = inspect(sync)
            return all(inspector.has_table(t) for t in _TABLAS)

        _cache["eventos_v2"] = await conexion.run_sync(_mirar)
        if not _cache["eventos_v2"]:
            logger.warning(
                "La migracion 0060 no esta aplicada: los eventos no tienen ciclo "
                "operativo, la admision responde 503 y nadie lleva sello Z."
            )
    return _cache["eventos_v2"]


async def exigir_eventos_v2(db: AsyncSession) -> None:
    if not await hay_eventos_v2(db):
        raise ServiceUnavailableError(
            "La gestión de eventos todavía no está disponible.",
            code="events_workflow_not_available",
        )


def olvidar() -> None:
    """Solo para los tests: que uno no herede el esquema del anterior."""
    _cache.clear()
