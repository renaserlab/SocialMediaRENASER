"""Creación de notificaciones (usada por otros módulos).

Añade la notificación a la sesión; el commit lo hace quien la origina, para
que la operación principal y su notificación se persistan juntas.
"""

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notifications.models import Notification


def add_notification(
    db: AsyncSession,
    *,
    user_id: str,
    actor_id: str | None,
    type: str,
    entity_type: str | None = None,
    entity_id: str | None = None,
    payload: dict | None = None,
) -> None:
    # No notificar acciones sobre uno mismo.
    if actor_id is not None and actor_id == user_id:
        return
    db.add(
        Notification(
            user_id=user_id,
            actor_id=actor_id,
            type=type,
            entity_type=entity_type,
            entity_id=entity_id,
            payload=payload or {},
        )
    )
