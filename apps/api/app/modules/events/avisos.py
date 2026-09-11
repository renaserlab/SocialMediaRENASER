"""Los avisos de la posventa de eventos.

UN FALLO AQUI NO DESHACE NADA. Se encola dentro de la transaccion que provoco el
hecho —asi un aviso no anuncia algo que no llego a pasar— pero envolviendo cada
encolado en su propio savepoint: si la cola no esta desplegada, o choca una
clave, la devolucion confirmada sigue confirmada.

Y NO SE PROMETE DINERO. Los textos dicen que paso, no cuando llegara: el plazo
bancario no lo decidimos nosotros y la empresa no ha aprobado ninguno.
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("renaser.events")


async def encolar(
    db: AsyncSession,
    *,
    usuario_id: str,
    tipo: str,
    entidad_id: str | None = None,
    correlacion: str | None = None,
) -> bool:
    """Deja el aviso en la cola. Devuelve si se encolo de verdad.

    Nunca lanza: quien llama esta a mitad de una operacion que ya ocurrio.
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
        logger.exception("[eventos] no se pudo encolar el aviso %s", tipo)
        return False


async def _idioma_de(db: AsyncSession, usuario_id: str) -> str | None:
    """El idioma del dispositivo mas reciente de esa persona, si lo dijo."""
    from sqlalchemy import select

    from app.modules.notifications.device_tokens import DeviceToken

    return await db.scalar(
        select(DeviceToken.locale)
        .where(DeviceToken.user_id == usuario_id, DeviceToken.locale.is_not(None))
        .order_by(DeviceToken.last_seen_at.desc())
        .limit(1)
    )


__all__ = ["encolar"]
