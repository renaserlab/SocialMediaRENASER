"""Los avisos de Productos. Mismo patrón que los de Eventos, y por lo mismo.

UN FALLO AQUÍ NO DESHACE NADA. Se encola dentro de la transacción que provocó
el hecho —así un aviso no anuncia algo que no llegó a pasar— pero envolviendo
cada encolado en su propio savepoint: si la cola no está desplegada, o choca
una clave, el despacho confirmado sigue confirmado.

Y NO SE PROMETE NADA QUE NO EXISTA. Ningún texto dice cuándo llegará el
paquete: no hay transportista, no hay cobertura y no hay plazo aprobado.
Dicen qué pasó, que es lo único que sabemos.
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("renaser.products")

#: EL PAQUETE SALIÓ DEL ALMACÉN.
DESPACHADO = "product_shipment_dispatched"
#: ALGUIEN AFIRMA QUE LLEGÓ. Se le avisa a quien compró aunque lo haya dicho
#: quien vende: es la única forma de que pueda desmentirlo si no es verdad.
ENTREGADO = "product_shipment_delivered"
#: EL INTENTO DE ENTREGA FALLÓ.
ENTREGA_FALLIDA = "product_shipment_failed"


async def encolar(
    db: AsyncSession,
    *,
    usuario_id: str,
    tipo: str,
    entidad_id: str | None = None,
    correlacion: str | None = None,
) -> bool:
    """Deja el aviso en la cola. Devuelve si se encoló de verdad.

    NUNCA LANZA: quien llama está a mitad de una operación que ya ocurrió, y
    un aviso que no sale no puede deshacer un paquete que ya salió.
    """
    from app.modules.notifications import entregas, esquema

    try:
        if not await esquema.hay_entregas(db):
            return False
        locale = await _idioma_de(db, usuario_id)
        fila = await entregas.encolar(
            db,
            usuario_id=usuario_id,
            tipo=tipo,
            locale=locale,
            entidad_id=entidad_id,
            correlacion=correlacion,
        )
        return fila is not None
    except Exception:  # noqa: BLE001
        logger.exception("[productos] no se pudo encolar el aviso %s", tipo)
        return False


async def _idioma_de(db: AsyncSession, usuario_id: str) -> str | None:
    """El idioma del dispositivo más reciente de esa persona, si lo dijo."""
    from sqlalchemy import select

    from app.modules.notifications.device_tokens import DeviceToken

    return await db.scalar(
        select(DeviceToken.locale)
        .where(DeviceToken.user_id == usuario_id, DeviceToken.locale.is_not(None))
        .order_by(DeviceToken.last_seen_at.desc())
        .limit(1)
    )


__all__ = ["DESPACHADO", "ENTREGADO", "ENTREGA_FALLIDA", "encolar"]
