"""Creacion de notificaciones (usada por otros modulos).

Anade la notificacion a la sesion; el commit lo hace quien la origina, para que
la operacion principal y su notificacion se persistan juntas.

UNA ACCION LOGICA, UN AVISO LOGICO.

La bandeja mostraba dos veces «Luis empezo a seguirte». No era un fallo de
pintado: eran DOS FILAS en `notifications`, y llegaban por dos caminos que
ningun `unique()` en el cliente arregla:

  1. Seguir, dejar de seguir y volver a seguir. `follow_profile` comprueba
     `if existing is None` sobre la tabla `follows`, y al dejar de seguir esa
     fila SE BORRA: la siguiente vez la comprobacion vuelve a decir que no hay
     nada y se escribe otro aviso. El de la primera vez sigue en la bandeja.
  2. Dos peticiones a la vez —doble toque, reintento del movil al cambiar de
     red—. Las dos leen la tabla antes de que ninguna escriba, las dos ven que
     no hay nada y las dos insertan.

El caso 2 es la razon por la que esto NO se arregla con un `if` mejor: entre
comprobar y escribir siempre queda una ventana. La idempotencia la tiene que
garantizar la BASE, y eso es lo que hace la 0043: una columna `dedupe_key` con
indice unico. Aqui solo se calcula esa clave.

QUE SE DEDUPLICA Y QUE NO, que es la parte de producto:

  · `follow` y `like` son ESTADOS, no sucesos. «Luis te sigue» es verdad una vez
    o ninguna; decirlo dos veces no anade informacion, y el segundo aviso solo
    aparece porque la fila de `follows` (o de `post_likes`) se borro por el
    camino.
  · Los avisos de la agenda van por (sesion, respuesta): una reserva solo se
    acepta una vez, y el segundo toque del boton no puede sonar otra vez.
  · `comment` NO se deduplica. Dos comentarios de la misma persona en la misma
    publicacion son dos cosas distintas que han pasado, y colapsarlos seria
    esconder el segundo. Su clave es `None`, y una clave nula nunca choca.
  · `post_mention` TAMPOCO, y no es un olvido: desetiquetar a alguien y volver a
    etiquetarlo es una mencion NUEVA sobre la misma publicacion, y asi esta
    decidido y probado (`test_desetiquetar_y_volver_a_etiquetar_si_vuelve_a_avisar`).
    Ademas no hace falta: `menciones.fijar` compara con las anteriores y solo
    devuelve a quien hay que avisar, asi que editar el texto de una publicacion
    con cinco personas etiquetadas ya no vuelve a hacer sonar cinco telefonos.
    Deduplicar aqui no habria quitado un duplicado: habria escondido un aviso
    legitimo.
"""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notifications import deduplicacion, esquema
from app.modules.notifications.models import Notification

logger = logging.getLogger("renaser.notifications")

#: Los tipos en los que repetir el aviso no anade nada. Ver el docstring.
#:
#: Se enumeran en POSITIVO —lo que se deduplica— y no al reves: un tipo nuevo
#: entra por defecto como suceso distinto, que es lo conservador. Perder un
#: aviso es peor que mostrar uno de mas.
TIPOS_IDEMPOTENTES: frozenset[str] = frozenset(
    {
        "follow",
        "like",
        "session_booked",
        "session_accepted",
        "session_rejected",
        "session_cancelled",
        "session_rescheduled",
        "session_completed",
    }
)


def clave_de_aviso(
    *, user_id: str, actor_id: str | None, type: str, entity_id: str | None
) -> str | None:
    """Que identifica a este aviso como «el mismo», o None si no se deduplica.

    Es texto y no una tupla porque va a una columna con indice unico. Los
    guiones bajos separan los campos y el hueco vacio se escribe como `-`: sin
    un separador fijo, un `entity_id` ausente haria que dos claves distintas se
    pudieran escribir igual.
    """
    if type not in TIPOS_IDEMPOTENTES:
        return None
    return f"{user_id}|{type}|{actor_id or '-'}|{entity_id or '-'}"


async def _ya_existe(db: AsyncSession, clave: str) -> bool:
    """Respaldo SIN la 0043: mirar si ya hay un aviso equivalente.

    Se reconstruye la clave a partir de las columnas que si existen. Quita los
    duplicados que se ven de verdad en la bandeja —el seguir/dejar de
    seguir/volver a seguir— pero NO cierra la carrera de dos peticiones
    simultaneas. Eso solo lo cierra el indice unico; esto es lo mejor que se
    puede hacer mientras la migracion espera aprobacion.
    """
    user_id, type, actor_id, entity_id = clave.split("|")
    condiciones = [Notification.user_id == user_id, Notification.type == type]
    condiciones.append(
        Notification.actor_id.is_(None) if actor_id == "-" else Notification.actor_id == actor_id
    )
    condiciones.append(
        Notification.entity_id.is_(None)
        if entity_id == "-"
        else Notification.entity_id == entity_id
    )
    fila = await db.scalar(select(Notification.id).where(*condiciones).limit(1))
    return fila is not None


async def add_notification(
    db: AsyncSession,
    *,
    user_id: str,
    actor_id: str | None,
    type: str,
    entity_type: str | None = None,
    entity_id: str | None = None,
    payload: dict | None = None,
) -> bool:
    """Crea el aviso si de verdad es nuevo. Devuelve si lo ha creado.

    QUIEN LLAMA TIENE QUE MIRAR EL RESULTADO antes de mandar el push. Un aviso
    que no se ha escrito porque ya estaba no puede hacer sonar un telefono: era
    la otra mitad del mismo fallo —la bandeja tenia dos filas y el telefono
    sonaba dos veces— y arreglar solo una deja la queja intacta.

    NO HACE COMMIT, igual que antes.
    """
    # No notificar acciones sobre uno mismo.
    if actor_id is not None and actor_id == user_id:
        return False

    clave = clave_de_aviso(
        user_id=user_id, actor_id=actor_id, type=type, entity_id=entity_id
    )
    if clave is None:
        # Un suceso distinto cada vez (un comentario). Se escribe y ya esta.
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
        return True

    if await esquema.hay_clave_de_deduplicacion(db):
        return await deduplicacion.insertar(
            db,
            user_id=user_id,
            actor_id=actor_id,
            type=type,
            entity_type=entity_type,
            entity_id=entity_id,
            payload=payload or {},
            clave=clave,
        )

    # Sin la 0043: se comprueba antes de escribir. Ver `_ya_existe`.
    if await _ya_existe(db, clave):
        return False
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
    return True
