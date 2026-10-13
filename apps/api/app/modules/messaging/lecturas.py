"""Quien ha leido cada mensaje: la confirmacion de lectura.

Pedido el 12/10/2026, con WhatsApp de referencia: «que haya feedback de ver si
leyeron o no mi mensaje» y que en los detalles de un mensaje «aparezcan las
personas que leyeron o no».

NO HAY TABLA NUEVA NI MIGRACION. Lo que hace falta ya estaba guardado: cada
miembro de una conversacion tiene `conversation_members.last_read_at`, el
instante en que la abrio por ultima vez, que es lo que sostiene el contador de
no leidos de la bandeja. De ahi sale todo:

    una persona LEYO un mensaje  <=>  su `last_read_at` >= el `created_at` del mensaje

LO QUE ESO PERMITE SABER Y LO QUE NO. Se sabe HASTA DONDE leyo cada persona, no
la hora exacta en que vio cada mensaje: quien abre el chat una vez por la tarde
lee de golpe todo lo anterior, y su marca es la de esa tarde. Por eso aqui no
se devuelve una «hora de lectura» por mensaje; inventarla seria mentir.

DOS RUTAS, las dos de solo lectura:

  · `GET {id}/read-state` — hasta donde ha leido cada una de las OTRAS
    personas. Con eso la aplicacion pinta la marca de cada burbuja propia sin
    preguntar mensaje por mensaje.
  · `GET {id}/messages/{mid}/receipts` — los detalles de UN mensaje propio:
    quien lo leyo y quien todavia no, con nombre y foto.

LOS DETALLES SON DE QUIEN ESCRIBIO EL MENSAJE. Nadie consulta quien leyo lo que
escribio otra persona: no es suyo. A quien lo intenta se le contesta lo mismo
que si el mensaje no existiera.

No se avisa a nadie desde aqui. Quien lee manda un aviso sin contenido por
difusion (lo hace la aplicacion) y los demas vuelven a preguntar a esta ruta,
que es la que decide lo que cada quien puede ver.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError, NotFoundError
from app.core.security import AuthUser, get_current_user
from app.modules.messaging.models import ConversationMember, Message
from app.modules.profiles.models import Profile
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid

router = APIRouter(tags=["messaging"])


class CursorDeLectura(BaseModel):
    """Hasta donde ha leido una persona. `None`: nunca abrio la conversacion."""

    user_id: str
    last_read_at: datetime | None = None


class EstadoDeLectura(BaseModel):
    """Las marcas de lectura de las OTRAS personas de la conversacion."""

    members: list[CursorDeLectura]


class Lector(BaseModel):
    id: str
    full_name: str
    username: str | None = None
    avatar_path: str | None = None


class DetallesDeMensaje(BaseModel):
    """Quien leyo un mensaje y quien no. Las dos listas juntas son los demas."""

    message_id: str
    sent_at: datetime
    read_by: list[Lector]
    pending: list[Lector]


async def _exigir_miembro(db: AsyncSession, conversation_id: str, uid: str) -> None:
    """Quien no es miembro recibe el mismo 403 exista o no la conversacion."""
    ensure_uuid(conversation_id, "Conversacion no encontrada.")
    miembro = await db.get(
        ConversationMember, {"conversation_id": conversation_id, "user_id": uid}
    )
    if miembro is None:
        raise ForbiddenError("No perteneces a esta conversación.")


def lo_leyo(marca: datetime | None, enviado: datetime) -> bool:
    """Si quien tiene esa marca de lectura ya paso por un mensaje de ese instante.

    Sin marca no ha abierto nunca la conversacion. Las dos fechas salen del
    reloj de la base; se comparan sin zona porque SQLite, en las pruebas, las
    devuelve sin ella.
    """
    if marca is None:
        return False
    return marca.replace(tzinfo=None) >= enviado.replace(tzinfo=None)


@router.get("/{conversation_id}/read-state", response_model=EstadoDeLectura)
async def estado_de_lectura(
    conversation_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EstadoDeLectura:
    """Hasta donde ha leido cada una de las otras personas. UNA consulta."""
    await _exigir_miembro(db, conversation_id, current_user.id)
    filas = await db.execute(
        select(ConversationMember.user_id, ConversationMember.last_read_at)
        .where(
            ConversationMember.conversation_id == conversation_id,
            ConversationMember.user_id != current_user.id,
        )
        .order_by(ConversationMember.user_id.asc())
    )
    return EstadoDeLectura(
        members=[
            CursorDeLectura(user_id=str(persona), last_read_at=marca) for persona, marca in filas
        ]
    )


@router.get(
    "/{conversation_id}/messages/{message_id}/receipts", response_model=DetallesDeMensaje
)
async def detalles_de_un_mensaje(
    conversation_id: str,
    message_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DetallesDeMensaje:
    """Quien leyo y quien no un mensaje PROPIO. Dos consultas."""
    await _exigir_miembro(db, conversation_id, current_user.id)
    ensure_uuid(message_id, "Mensaje no encontrado.")
    mensaje = await db.get(Message, message_id)
    # El mismo «no encontrado» si no existe, si es de otra conversacion, si se
    # borro o si lo escribio otra persona: no se confirma nada de lo ajeno.
    if (
        mensaje is None
        or str(mensaje.conversation_id) != conversation_id
        or mensaje.deleted_at is not None
        or str(mensaje.sender_id) != current_user.id
    ):
        raise NotFoundError("Mensaje no encontrado.")

    filas = await db.execute(
        select(
            Profile.id,
            Profile.full_name,
            Profile.username,
            Profile.avatar_path,
            ConversationMember.last_read_at,
        )
        .join(ConversationMember, ConversationMember.user_id == Profile.id)
        .where(
            ConversationMember.conversation_id == conversation_id,
            ConversationMember.user_id != current_user.id,
        )
        .order_by(Profile.full_name.asc(), Profile.id.asc())
    )
    leyeron: list[Lector] = []
    faltan: list[Lector] = []
    for fila in filas:
        lector = Lector(
            id=str(fila.id),
            full_name=fila.full_name or "",
            username=fila.username,
            avatar_path=fila.avatar_path,
        )
        (leyeron if lo_leyo(fila.last_read_at, mensaje.created_at) else faltan).append(lector)
    return DetallesDeMensaje(
        message_id=str(mensaje.id),
        sent_at=mensaje.created_at,
        read_by=leyeron,
        pending=faltan,
    )
