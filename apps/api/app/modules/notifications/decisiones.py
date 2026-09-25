"""Avisos al CREADOR cuando se decide sobre lo suyo.

POR QUÉ EXISTE. Hasta el 24/09/2026 quien enviaba un evento, un curso, una
postulación de proveedor o un producto no se enteraba de nada: ni de que lo
aprobaron, ni de que lo rechazaron y por qué. Las pantallas decían «te
avisaremos» y nadie avisaba.

DOS PASOS, COMO EL RESTO DE AVISOS DEL PROYECTO:

1. `avisar` escribe la fila de la bandeja DENTRO de la transacción de la
   decisión y sin hacer commit: el aviso existe si y solo si la decisión se
   guardó. Va en un `SAVEPOINT` y NUNCA lanza: un fallo al avisar no puede
   deshacer una aprobación.
2. `empujar` programa la notificación push para DESPUÉS de responder
   (`encolar_push`), solo cuando ya hubo commit.

SIN ACTOR (`actor_id=None`): el creador no ve el nombre ni la foto de quien
revisó, igual que en las devoluciones. La decisión es de la plataforma.

El texto lo compone el teléfono con el `type` y el `payload` (título del
elemento y, en los rechazos, el motivo PÚBLICO; nunca notas internas). El push
lleva su propio texto en `push.TEMPLATES`.
"""

from __future__ import annotations

import logging

from fastapi import BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notifications.push import encolar_push
from app.modules.notifications.service import add_notification

logger = logging.getLogger(__name__)

#: Los tipos de este módulo. Distintos de `event_case_*` (posventa del
#: comprador) a propósito: comparten palabra y no significado.
TIPOS: frozenset[str] = frozenset(
    {
        "event_admission_approved",
        "event_admission_conditional",
        "event_admission_rejected",
        "event_admission_changes",
        "event_published",
        "event_suspended",
        "course_review_approved",
        "course_review_rejected",
        "course_published",
        "seller_application_accepted",
        "seller_application_rejected",
        "product_published",
        "product_suspended",
        "product_photo_rejected",
    }
)


async def avisar(
    db: AsyncSession,
    *,
    user_id: str | None,
    tipo: str,
    entidad: str,
    entidad_id: str,
    titulo: str | None = None,
    motivo: str | None = None,
    automatico: bool = False,
) -> bool:
    """Escribe el aviso en la bandeja. No hace commit. Nunca lanza.

    Devuelve si se escribió, para que quien llama decida si manda el push.
    """
    if not user_id or tipo not in TIPOS:
        return False
    payload: dict[str, object] = {}
    if titulo:
        payload["title"] = titulo[:160]
    if motivo:
        payload["reason"] = motivo.strip()[:500]
    if automatico:
        # Publicado al instante por el modo flexible: el teléfono lo dice
        # distinto («ya está publicado») que una decisión de administración.
        payload["automatic"] = True
    try:
        async with db.begin_nested():
            return await add_notification(
                db,
                user_id=user_id,
                actor_id=None,
                type=tipo,
                entity_type=entidad,
                entity_id=entidad_id,
                payload=payload,
            )
    except Exception:  # pragma: no cover - defensa: avisar nunca tumba la decisión
        logger.exception("[avisos] no se pudo avisar %s a %s", tipo, user_id)
        return False


def empujar(
    background: BackgroundTasks | None,
    *,
    user_id: str | None,
    tipo: str,
    entidad: str,
    entidad_id: str,
) -> None:
    """La notificación push, para después de responder. Solo tras el commit."""
    if background is None or not user_id or tipo not in TIPOS:
        return
    encolar_push(
        background,
        user_ids=[user_id],
        notification_type=tipo,
        data={"type": tipo, "entityType": entidad, "entityId": entidad_id},
    )
