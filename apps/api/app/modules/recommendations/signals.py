"""Registro de senales desde OTROS modulos.

Lo que hace este fichero es dejar que `social_graph`, `bookings` o `messaging`
anoten lo que acaba de pasar sin conocer el recomendador. Se importa una
funcion y se llama; nada mas.

DOS REGLAS QUE NO SE NEGOCIAN:

1. Las senales fuertes las escribe el SERVIDOR. Que alguien haya seguido a otra
   persona, pedido una sesion o abierto una conversacion es algo que el backend
   SABE porque acaba de ocurrir dentro de una de sus operaciones. Pedirselo al
   movil seria fiarse de que un cliente diga la verdad sobre lo que mas pesa en
   el orden, y eso es justamente lo que se puede falsificar.

2. Registrar una senal NUNCA puede tumbar la operacion que la provoco. Seguir a
   alguien tiene que funcionar aunque la anotacion falle. Por eso se anade a la
   sesion que ya esta abierta —el commit lo hace quien origina la accion, igual
   que con las notificaciones— y por eso los fallos se registran y se tragan.
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.recommendations.models import BehaviorEvent

logger = logging.getLogger("renaser.recommendations")

#: Los tipos que solo el servidor puede afirmar. Estan aqui y no en los
#: esquemas de entrada a proposito: el cliente no puede declararlos.
EVENTOS_DE_SERVIDOR = frozenset(
    {"follow", "message_started", "booking_requested", "booking_completed"}
)


def registrar_senal(
    db: AsyncSession,
    *,
    user_id: str,
    event_type: str,
    entity_type: str,
    entity_id: str | None = None,
    topic_ids: list[str] | None = None,
) -> None:
    """Anota una senal en la sesion en curso. No hace commit.

    Si el tipo no es de servidor, no se anota: es un error de programacion y es
    preferible que no se guarde nada a que una senal de cliente entre por la
    puerta de atras marcada como verificada.
    """
    if event_type not in EVENTOS_DE_SERVIDOR:
        logger.warning(
            "Se intento registrar '%s' como senal de servidor; se ignora.", event_type
        )
        return
    try:
        db.add(
            BehaviorEvent(
                user_id=user_id,
                event_type=event_type,
                entity_type=entity_type,
                entity_id=entity_id,
                topic_ids=topic_ids,
                source="server",
            )
        )
    except Exception:  # pragma: no cover - defensa, no logica
        # Deliberadamente ancho y CON registro: una senal perdida es un dato
        # menos; una excepcion aqui seria una accion del usuario que falla.
        logger.exception("No se pudo registrar la senal '%s'.", event_type)
