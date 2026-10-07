"""El escenario de una emisión: a quién se ha invitado a salir con su cámara.

LO QUE SE PIDIÓ (07/10/2026), como en TikTok: quien emite invita a otras
personas, estas aceptan, salen con su cámara y la pantalla se reparte.

EL PAPEL YA EXISTÍA. `roles.resolver` sabe desde el primer día que un invitado
publica y no manda, y la plantilla del proveedor tiene su rol. Lo que faltaba
era la lista: QUIÉN está invitado y qué contestó. Eso es este fichero, sobre la
tabla `live_guests` (migración 0098).

LAS REGLAS, y por qué:

  * LO DECIDE EL SERVIDOR. Nadie sale en la emisión de otro porque su teléfono
    lo diga: hace falta una fila `accepted` aquí, y solo se llega a ella
    aceptando una invitación que puso quien gestiona la emisión.
  * UNA FILA POR PERSONA Y EMISIÓN. Guarda lo ÚLTIMO que pasó. Volver a invitar
    a quien dijo que no reutiliza su fila.
  * LA PLAZA SE OCUPA AL INVITAR, no al aceptar. Así el tope se comprueba en un
    solo sitio y con un solo actor —quien invita—, y aceptar no puede fallar
    por «ya no cabes» delante de quien acaba de decir que sí.
  * BAJARSE SIEMPRE SE PUEDE, también con la emisión terminada: es renunciar a
    un permiso, y renunciar no necesita condiciones.
  * NADA DE ESTO TOCA LA EMISIÓN. Si la tabla no existe todavía, el router
    contesta 503 a lo de invitados y lo demás sigue igual.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError
from app.modules.live.models import LiveGuest, LiveSession

#: Los estados. Coinciden con el CHECK de `live_guests` (migración 0098).
INVITADA = "invited"
ACEPTADA = "accepted"
RECHAZADA = "declined"
SE_FUE = "left"
QUITADA = "removed"

ESTADOS = (INVITADA, ACEPTADA, RECHAZADA, SE_FUE, QUITADA)

#: Quién cuenta para el tope: quien está en pantalla y quien todavía puede
#: aceptar. Una invitación sin contestar reserva su sitio.
OCUPAN_PLAZA = (INVITADA, ACEPTADA)


def _ahora() -> datetime:
    return datetime.now(timezone.utc)


async def fila(db: AsyncSession, session_id: str, user_id: str) -> LiveGuest | None:
    return await db.scalar(
        select(LiveGuest).where(
            LiveGuest.session_id == session_id, LiveGuest.user_id == user_id
        )
    )


async def filas(db: AsyncSession, session_id: str) -> list[LiveGuest]:
    """Todas las de una emisión, en el orden en que se invitó."""
    return list(
        await db.scalars(
            select(LiveGuest)
            .where(LiveGuest.session_id == session_id)
            .order_by(LiveGuest.invited_at, LiveGuest.user_id)
        )
    )


async def en_pantalla(db: AsyncSession, session_id: str) -> set[str]:
    """Quién ha aceptado y sigue arriba. Es lo que mira la credencial."""
    return set(
        await db.scalars(
            select(LiveGuest.user_id).where(
                LiveGuest.session_id == session_id, LiveGuest.status == ACEPTADA
            )
        )
    )


def _exigir_en_directo(sesion: LiveSession) -> None:
    if sesion.status != "live":
        raise ConflictError(
            "Solo se puede invitar mientras la transmisión está en vivo.",
            code="live_guests_not_live",
        )


async def invitar(
    db: AsyncSession, *, sesion: LiveSession, por: str, user_id: str, maximo: int
) -> tuple[LiveGuest, bool]:
    """Deja a `user_id` invitado. Devuelve la fila y si la invitación es NUEVA.

    Invitar dos veces a la misma persona no es un error ni manda dos avisos: la
    segunda vez devuelve lo que ya había (`False`).
    """
    _exigir_en_directo(sesion)
    if user_id == sesion.host_id:
        raise ConflictError(
            "Quien emite ya está en pantalla.", code="live_guest_is_host"
        )

    # SE BLOQUEA LA EMISIÓN mientras se cuenta. Dos invitaciones a la vez
    # —dos toques, o administración y quien emite— contarían las dos «queda un
    # sitio» y entrarían las dos.
    await db.execute(
        select(LiveSession.id).where(LiveSession.id == sesion.id).with_for_update()
    )

    actual = await fila(db, sesion.id, user_id)
    if actual is not None and actual.status in OCUPAN_PLAZA:
        return actual, False

    ocupadas = await db.scalar(
        select(func.count())
        .select_from(LiveGuest)
        .where(LiveGuest.session_id == sesion.id, LiveGuest.status.in_(OCUPAN_PLAZA))
    )
    if int(ocupadas or 0) >= maximo:
        raise ConflictError(
            "Ya no caben más personas invitadas en esta transmisión.",
            code="live_guests_full",
        )

    if actual is None:
        actual = LiveGuest(
            session_id=sesion.id,
            user_id=user_id,
            status=INVITADA,
            invited_by=por,
            invited_at=_ahora(),
        )
        db.add(actual)
    else:
        actual.status = INVITADA
        actual.invited_by = por
        actual.invited_at = _ahora()
        actual.responded_at = None
        actual.ended_at = None
    await db.flush()
    return actual, True


async def responder(
    db: AsyncSession, *, sesion: LiveSession, user_id: str, acepta: bool
) -> LiveGuest:
    """Aceptar o rechazar la invitación PROPIA.

    Repetir la misma respuesta no es un error: una red lenta reenvía. Lo que sí
    lo es: contestar a una invitación que ya no existe —la retiraron, o nunca
    la hubo—, que es justo lo que intentaría quien quiere colarse.
    """
    _exigir_en_directo(sesion)
    actual = await fila(db, sesion.id, user_id)
    destino = ACEPTADA if acepta else RECHAZADA
    if actual is not None and actual.status == destino:
        return actual
    if actual is None or actual.status != INVITADA:
        raise ConflictError(
            "Esta invitación ya no está disponible.", code="live_guest_not_invited"
        )
    actual.status = destino
    actual.responded_at = _ahora()
    await db.flush()
    return actual


async def dejar(db: AsyncSession, *, sesion: LiveSession, user_id: str) -> bool:
    """Bajarse por decisión propia. `True` si estaba arriba.

    NO LANZA y no exige emisión en vivo: quien no estaba, sigue sin estar.
    """
    actual = await fila(db, sesion.id, user_id)
    if actual is None or actual.status != ACEPTADA:
        return False
    actual.status = SE_FUE
    actual.ended_at = _ahora()
    await db.flush()
    return True


async def quitar(db: AsyncSession, *, sesion: LiveSession, user_id: str) -> bool:
    """Quien gestiona retira a alguien: de la pantalla o de la lista de espera.

    Devuelve si hay que bajarla TAMBIÉN en el proveedor de vídeo: estaba
    arriba, o dijo que se iba —su aplicación pudo no cumplirlo—.
    """
    actual = await fila(db, sesion.id, user_id)
    if actual is None:
        raise NotFoundError("Esa persona no está invitada a esta transmisión.")
    estaba_arriba = actual.status in (ACEPTADA, SE_FUE)
    if actual.status != QUITADA:
        actual.status = QUITADA
        actual.ended_at = _ahora()
        await db.flush()
    return estaba_arriba
