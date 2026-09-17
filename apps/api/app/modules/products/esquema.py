"""Si las migraciones de Productos están aplicadas en ESTA base.

Misma regla que en Eventos y por la misma razón cara: desplegar código no puede
exigir que una migración concreta ya esté puesta. De la 0070 a la 0075 están
aplicadas y verificadas; la 0076, la 0077 y la 0078 se entregan escritas y SIN
aplicar.

QUÉ PASA SIN ELLAS. Cada ruta contesta **503 con su propio código**, y no 404
—que haría pensar que la ruta está mal escrita— ni 500 —que haría pensar que
algo se rompió—. Una puerta por migración y no una sola, porque se aplican en
orden: con la 0074 puesta el inventario ya funciona aunque el carrito no esté, y
quien vende puede seguir cargando existencias mientras tanto. Lo mismo vale para
las dos últimas: con la 0077 puesta se pueden leer y publicar las condiciones de
venta aunque no exista todavía la tabla de pedidos.

LA DE LAS FOTOGRAFÍAS MIRA UNA COLUMNA, no una tabla. La 0073 no crea ninguna:
le añade estado y medidas a `product_media`, así que preguntar por la tabla
diría que sí sin que exista nada de lo que hace falta.

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

#: Las dos de la 0074.
_INVENTARIO = ("product_inventory", "inventory_movements")

#: Las dos de la 0075.
_CARRITO = ("product_carts", "product_cart_items")

#: La de la 0077.
_POLITICAS = ("product_policies",)

#: Las cuatro de la 0078. Se comprueban TODAS: un pedido sin su direccion seria
#: un envio sin a donde, y sin su historial no habria como auditar un estado.
_PEDIDOS = (
    "product_orders",
    "product_order_items",
    "product_order_addresses",
    "product_order_events",
)

#: Lo que la 0073 le añade a `product_media`. Se comprueban TODAS: una tabla con
#: `status` pero sin `content_type` sería una migración aplicada a medias, y el
#: catálogo firmaría rutas de archivos que nadie midió.
_FOTOGRAFIAS = (
    "status",
    "content_type",
    "byte_size",
    "checksum_sha256",
    "reviewed_at",
    "reviewed_by",
    "rejection_reason",
)


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


async def hay_fotografias(db: AsyncSession) -> bool:
    """Si la 0073 está aplicada: estado, medidas y huella de la galería."""
    if "fotografias" not in _cache:
        conexion = await db.connection()

        def _mirar(sync) -> bool:  # noqa: ANN001
            inspector = inspect(sync)
            if not inspector.has_table("product_media"):
                return False
            columnas = {c["name"] for c in inspector.get_columns("product_media")}
            return all(c in columnas for c in _FOTOGRAFIAS)

        _cache["fotografias"] = await conexion.run_sync(_mirar)
        if not _cache["fotografias"]:
            logger.warning(
                "Productos: falta la 0073. Las fotografías no se pueden subir "
                "ni aprobar, y el catálogo no firma ninguna."
            )
    return _cache["fotografias"]


async def hay_inventario(db: AsyncSession) -> bool:
    """Si la 0074 está aplicada: existencias y movimientos."""
    return await _hay(db, "inventario", _INVENTARIO)


async def hay_carrito(db: AsyncSession) -> bool:
    """Si la 0075 está aplicada: carrito y sus líneas."""
    return await _hay(db, "carrito", _CARRITO)


async def hay_politicas(db: AsyncSession) -> bool:
    """Si la 0077 esta aplicada: la politica de venta por jurisdiccion."""
    return await _hay(db, "politicas", _POLITICAS)


async def hay_pedidos(db: AsyncSession) -> bool:
    """Si la 0078 esta aplicada: pedido, lineas, direccion e historial."""
    return await _hay(db, "pedidos", _PEDIDOS)


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


async def exigir_fotografias(db: AsyncSession) -> None:
    if not await hay_fotografias(db):
        raise ServiceUnavailableError(
            "Las fotografías de producto todavía no están disponibles.",
            code="product_media_not_available",
        )


async def exigir_inventario(db: AsyncSession) -> None:
    if not await hay_inventario(db):
        raise ServiceUnavailableError(
            "El inventario de productos todavía no está disponible.",
            code="product_inventory_not_available",
        )


async def exigir_carrito(db: AsyncSession) -> None:
    if not await hay_carrito(db):
        raise ServiceUnavailableError(
            "El carrito de productos todavía no está disponible.",
            code="product_cart_not_available",
        )


async def exigir_politicas(db: AsyncSession) -> None:
    if not await hay_politicas(db):
        raise ServiceUnavailableError(
            "Las condiciones de venta todavia no estan disponibles.",
            code="product_policies_not_available",
        )


async def exigir_pedidos(db: AsyncSession) -> None:
    if not await hay_pedidos(db):
        raise ServiceUnavailableError(
            "Los pedidos de productos todavia no estan disponibles.",
            code="product_orders_not_available",
        )


def olvidar() -> None:
    """Tira la caché. Para las pruebas, que montan y tiran esquemas."""
    _cache.clear()


__all__ = [
    "exigir_admision",
    "exigir_carrito",
    "exigir_dominio",
    "exigir_fotografias",
    "exigir_guardados",
    "exigir_inventario",
    "exigir_pedidos",
    "exigir_politicas",
    "hay_admision",
    "hay_carrito",
    "hay_dominio",
    "hay_fotografias",
    "hay_guardados",
    "hay_inventario",
    "hay_pedidos",
    "hay_politicas",
    "olvidar",
]
