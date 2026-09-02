"""Qué partes de la 0049 están aplicadas en ESTA base.

Misma regla y mismo mecanismo que `commerce/esquema.py`: desplegar código no
puede exigir que una migración concreta ya esté puesta. Con la 0049 hay
garantía y devoluciones; sin ella la aplicación se comporta EXACTAMENTE como
hoy —se compra, se accede, no se puede pedir devolución— y los endpoints
nuevos responden «no disponible» en vez de reventar con un 500 que el navegador
reporta como error de CORS.

Se comparte el diccionario con `recommendations.esquema` a propósito: la
memoria vive en el PROCESO y el `conftest.py` de la suite ya llama a
`olvidar()` antes de cada prueba. Un caché propio se quedaría sucio entre
pruebas que montan bases distintas.
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.recommendations.esquema import (  # noqa: F401
    _cache,
    _hay_tabla,
    olvidar,
)

logger = logging.getLogger("renaser.refunds")


async def hay_devoluciones(db: AsyncSession) -> bool:
    """Si están las tablas de garantía y solicitudes (migración 0049).

    Se comprueban DOS y no una: con solo `refund_requests`, arrancar la
    garantía escribiría en una tabla que no existe justo a mitad de entregar
    una lección, y quien pagó se quedaría sin ver el vídeo por un fallo que no
    tiene nada que ver con su compra.
    """
    if "refund_requests" not in _cache:
        hay = await _hay_tabla(db, "refund_requests") and await _hay_tabla(
            db, "course_refund_windows"
        )
        _cache["refund_requests"] = hay
        if not hay:
            logger.warning(
                "La migracion 0049 no esta aplicada: no hay garantia de "
                "devolucion ni solicitudes, y los endpoints responden vacio."
            )
    return _cache["refund_requests"]


async def hay_liquidaciones(db: AsyncSession) -> bool:
    """Si están las tablas de saldos y transferencias (migración 0049).

    Separado de `hay_devoluciones` porque son dos capacidades distintas: se
    puede querer devoluciones sin pagar todavía a los propietarios, que es
    justo el orden en que se van a encender.
    """
    if "owner_sale_balances" not in _cache:
        hay = await _hay_tabla(db, "owner_sale_balances") and await _hay_tabla(
            db, "owner_transfers"
        )
        _cache["owner_sale_balances"] = hay
        if not hay:
            logger.warning(
                "La migracion 0049 no esta aplicada: no se acumulan saldos de "
                "propietario y las transferencias quedan desactivadas."
            )
    return _cache["owner_sale_balances"]
