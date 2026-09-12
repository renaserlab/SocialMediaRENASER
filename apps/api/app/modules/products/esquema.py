"""Si las migraciones de Productos están aplicadas en ESTA base.

Misma regla que en Eventos y por la misma razón cara: desplegar código no puede
exigir que una migración concreta ya esté puesta. La 0070, la 0071 y la 0072 se
entregan escritas y SIN aplicar.

QUÉ PASA SIN ELLAS. Cada ruta contesta **503 con su propio código**, y no 404
—que haría pensar que la ruta está mal escrita— ni 500 —que haría pensar que
algo se rompió—. Tres puertas y no una, porque las migraciones se aplican en
orden y con la 0070 puesta el dominio ya funciona aunque la admisión no esté.

Y EL ROL SE COMPRUEBA ANTES QUE LA PUERTA en las rutas de administración: si
fuera al revés, una cuenta sin permisos distinguiría un 503 de un 403 y
averiguaría qué migraciones están aplicadas en producción.
"""

from __future__ import annotations

import logging

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ServiceUnavailableError

logger = logging.getLogger("renaser.products")

_cache: dict[str, bool] = {}

#: Las seis de la 0070. Se comprueban TODAS: una base con `products` pero sin
#: `product_versions` sería una migración aplicada a medias.
_DOMINIO = (
    "product_sellers",
    "product_categories",
    "products",
    "product_versions",
    "product_variants",
    "product_media",
)

#: Las seis de la 0071.
_ADMISION = (
    "seller_applications",
    "seller_application_documents",
    "product_evaluations",
    "product_evaluation_scores",
    "product_evaluation_evidence",
    "product_approval_reasons",
)

#: La de la 0072.
_GUARDADOS = ("saved_products",)


async def _hay(db: AsyncSession, clave: str, tablas: tuple[str, ...]) -> bool:
    if clave not in _cache:
        conexion = await db.connection()

        def _mirar(sync) -> bool:  # noqa: ANN001
            inspector = inspect(sync)
            return all(inspector.has_table(t) for t in tablas)

        _cache[clave] = await conexion.run_sync(_mirar)
        if not _cache[clave]:
            logger.warning(
                "Productos: falta el esquema de %s. Las rutas que lo necesitan "
                "contestan 503 y el catálogo se queda vacío.",
                clave,
            )
    return _cache[clave]


async def hay_dominio(db: AsyncSession) -> bool:
    """Si la 0070 está aplicada: responsable, producto, versión, variantes y
    galería."""
    return await _hay(db, "dominio", _DOMINIO)


async def hay_admision(db: AsyncSession) -> bool:
    """Si la 0071 está aplicada: postulación, evaluación, evidencia y razones."""
    return await _hay(db, "admision", _ADMISION)


async def hay_guardados(db: AsyncSession) -> bool:
    """Si la 0072 está aplicada: productos guardados."""
    return await _hay(db, "guardados", _GUARDADOS)


async def exigir_dominio(db: AsyncSession) -> None:
    if not await hay_dominio(db):
        raise ServiceUnavailableError(
            "Productos todavía no está disponible.",
            code="products_not_available",
        )


async def exigir_admision(db: AsyncSession) -> None:
    if not await hay_admision(db):
        raise ServiceUnavailableError(
            "La admisión de productos todavía no está disponible.",
            code="product_admission_not_available",
        )


async def exigir_guardados(db: AsyncSession) -> None:
    if not await hay_guardados(db):
        raise ServiceUnavailableError(
            "Guardar productos todavía no está disponible.",
            code="product_saves_not_available",
        )


def olvidar() -> None:
    """Tira la caché. Para las pruebas, que montan y tiran esquemas."""
    _cache.clear()


__all__ = [
    "exigir_admision",
    "exigir_dominio",
    "exigir_guardados",
    "hay_admision",
    "hay_dominio",
    "hay_guardados",
    "olvidar",
]
