"""Avisar a quien sigue a alguien de que ese alguien esta en directo.

LO QUE SE PIDIO (25/09/2026), como en TikTok: si sigues a Juan y Juan empieza
un directo, te enteras. Son tres piezas y solo dos salen de aqui:

  1. La fila en `notifications` de cada seguidor: el aviso QUEDA en la bandeja
     («Juan está transmitiendo en vivo»), y tocarlo abre la emision.
  2. El push al telefono. Lo manda el router con `encolar_push`, DESPUES de
     responder, con los destinatarios que devuelve `avisar_a_seguidores`.
  3. El aviso emergente al entrar en la aplicacion. Ese no se escribe en
     ningun sitio: la aplicacion pregunta `GET /live/sessions/following` —que
     emisiones de gente a la que sigue estan vivas AHORA— al abrirse y al
     volver del segundo plano. Asi nunca anuncia un directo que ya termino.

LAS REGLAS, y por que:

  * SOLO AL PASAR A EMITIENDO: crear sin fecha (nace en directo) o empezar una
    programada. Anunciar una emision para el jueves no hace sonar ningun
    telefono; el aviso es «esta pasando», no «pasara».
  * UN AVISO POR PERSONA CADA 30 MINUTOS. Cortar y volver a empezar —se cae la
    conexion, se equivoca de titulo— no puede hacer sonar tres veces el
    telefono de todos sus seguidores. Se mira en `live_sessions` (si esta
    persona empezo OTRA emision hace menos de media hora), que es una tabla
    pequena, y no en `notifications`, que es de las mas grandes.
  * BLOQUEOS EN LOS DOS SENTIDOS, como en el resto de Z: ni a quien bloqueo a
    quien emite ni a quien este bloqueo.
  * NUNCA TUMBA LA EMISION. Se llama despues de guardarla, y cualquier fallo
    se registra y se devuelve «nadie»: un directo que no empieza porque fallo
    un aviso es mucho peor que un aviso que no llega.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.live.models import LiveSession
from app.modules.notifications.models import Notification
from app.modules.social_graph.models import Follow, UserBlock

logger = logging.getLogger("renaser.live")

#: El `type` del aviso. Lo conocen el push (`push.TEMPLATES`) y la aplicacion.
TIPO = "live_started"

#: Cuanto tiene que pasar entre dos emisiones de la misma persona para volver
#: a avisar a sus seguidores.
ESPERA_ENTRE_AVISOS = timedelta(minutes=30)

#: Cuantas filas se escriben de una vez. Alguien con muchos seguidores no puede
#: convertir esto en una sola sentencia gigante.
LOTE = 500


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


async def _emitio_hace_poco(db: AsyncSession, sesion: LiveSession) -> bool:
    """Si esta persona empezo OTRA emision hace menos de `ESPERA_ENTRE_AVISOS`."""
    otra = await db.scalar(
        select(LiveSession.id)
        .where(
            LiveSession.host_id == sesion.host_id,
            LiveSession.id != sesion.id,
            LiveSession.started_at.is_not(None),
            LiveSession.started_at >= _ahora() - ESPERA_ENTRE_AVISOS,
        )
        .limit(1)
    )
    return otra is not None


async def seguidores_a_avisar(db: AsyncSession, host_id: str) -> list[str]:
    """Quien sigue a `host_id`, sin bloqueos en ningun sentido y sin el mismo."""
    bloquea = select(UserBlock.blocked_id).where(UserBlock.blocker_id == host_id)
    le_bloquearon = select(UserBlock.blocker_id).where(UserBlock.blocked_id == host_id)
    filas = await db.scalars(
        select(Follow.follower_id).where(
            Follow.following_id == host_id,
            Follow.follower_id != host_id,
            Follow.follower_id.not_in(bloquea),
            Follow.follower_id.not_in(le_bloquearon),
        )
    )
    # Sin repetidos y en un orden estable (el de la base).
    return list(dict.fromkeys(filas))


async def avisar_a_seguidores(db: AsyncSession, *, sesion: LiveSession) -> list[str]:
    """Deja el aviso en la bandeja de cada seguidor y HACE COMMIT.

    Devuelve a quien se aviso, para mandarle el push. Una lista vacia es
    «a nadie»: no hay seguidores, la persona emitio hace poco o algo fallo.

    NO LANZA (ver el docstring del modulo). Se llama con la emision ya guardada,
    asi que un `rollback` aqui solo deshace los avisos.
    """
    try:
        if sesion.status != "live":
            return []
        if await _emitio_hace_poco(db, sesion):
            return []
        destinatarios = await seguidores_a_avisar(db, sesion.host_id)
        if not destinatarios:
            return []
        for inicio in range(0, len(destinatarios), LOTE):
            db.add_all(
                [
                    Notification(
                        user_id=usuario,
                        actor_id=sesion.host_id,
                        type=TIPO,
                        entity_type="live",
                        entity_id=sesion.id,
                        payload={"title": (sesion.title or "")[:120]},
                    )
                    for usuario in destinatarios[inicio : inicio + LOTE]
                ]
            )
            await db.flush()
        await db.commit()
        return destinatarios
    except Exception:  # noqa: BLE001 - un aviso nunca tumba la emision
        logger.exception("[live] no se pudo avisar a los seguidores de %s", sesion.id)
        await db.rollback()
        return []
