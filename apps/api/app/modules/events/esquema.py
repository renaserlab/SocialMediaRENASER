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


#: Las cuatro que añade la 0061.
_TABLAS_DE_ENTRADAS = (
    "event_ticketing_settings",
    "event_ticket_types",
    "event_ticket_holds",
    "event_ticket_hold_items",
)


async def hay_entradas(db: AsyncSession) -> bool:
    """Si la 0061 está aplicada: tipos de entrada, inventario y reservas."""
    if "entradas" not in _cache:
        conexion = await db.connection()

        def _mirar(sync) -> bool:  # noqa: ANN001
            inspector = inspect(sync)
            return all(inspector.has_table(t) for t in _TABLAS_DE_ENTRADAS)

        _cache["entradas"] = await conexion.run_sync(_mirar)
    return _cache["entradas"]


#: Las cuatro que añade la 0062.
_TABLAS_DE_ORDENES = (
    "event_orders",
    "event_order_items",
    "event_tickets",
    "event_checkins",
)


async def hay_ordenes(db: AsyncSession) -> bool:
    """Si están la 0062 Y la 0063: órdenes, entradas, check-in y el resumen.

    LAS DOS JUNTAS, y no una puerta por migración. Sin `code_hash` la puerta no
    puede reconocer un código tecleado, así que responder 503 es lo mismo que
    responder por la 0062 ausente: la función todavía no está desplegada. Una
    puerta aparte solo añadiría un código de error que nadie sabría distinguir.
    """
    if "ordenes" not in _cache:
        conexion = await db.connection()

        def _mirar(sync) -> bool:  # noqa: ANN001
            inspector = inspect(sync)
            if not all(inspector.has_table(t) for t in _TABLAS_DE_ORDENES):
                return False
            columnas = {c["name"] for c in inspector.get_columns("event_tickets")}
            return "code_hash" in columnas

        _cache["ordenes"] = await conexion.run_sync(_mirar)
    return _cache["ordenes"]


_TABLAS_DE_POSVENTA = (
    "event_policies",
    "event_changes",
    "event_aftersale_cases",
    "event_aftersale_case_tickets",
    "event_aftersale_case_events",
)


async def hay_posventa(db: AsyncSession) -> bool:
    """Si están la 0064 Y la 0065: políticas, cambios, expedientes y efectos.

    LAS DOS, Y NO SOLO LAS TABLAS. Mirar solo las cinco tablas dejaba pasar el
    estado intermedio —0064 aplicada, 0065 no— en el que la PUERTA consulta la
    columna `effect` para saber si una entrada está retenida y se encuentra con
    que no existe: 500 en cada escaneo, y sin dejar ni rastro del intento. Es el
    mismo motivo por el que `hay_ordenes` comprueba la columna `code_hash` y no
    solo sus cuatro tablas.
    """
    if "posventa" not in _cache:
        conexion = await db.connection()

        def _mirar(sync) -> bool:  # noqa: ANN001
            inspector = inspect(sync)
            if not all(inspector.has_table(t) for t in _TABLAS_DE_POSVENTA):
                return False
            columnas = {
                c["name"]
                for c in inspector.get_columns("event_aftersale_case_tickets")
            }
            return "effect" in columnas

        _cache["posventa"] = await conexion.run_sync(_mirar)
    return _cache["posventa"]


async def exigir_posventa(db: AsyncSession) -> None:
    """Sin la 0064, 503 con un código estable. No 404 ni 500."""
    if not await hay_posventa(db):
        raise ServiceUnavailableError(
            "La posventa de eventos todavía no está disponible.",
            code="event_aftersale_not_available",
        )


async def exigir_eventos_v2(db: AsyncSession) -> None:
    if not await hay_eventos_v2(db):
        raise ServiceUnavailableError(
            "La gestión de eventos todavía no está disponible.",
            code="events_workflow_not_available",
        )


def olvidar() -> None:
    """Solo para los tests: que uno no herede el esquema del anterior."""
    _cache.clear()
