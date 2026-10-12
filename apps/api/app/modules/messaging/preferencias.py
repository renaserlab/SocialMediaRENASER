"""Lo que cada persona decide PARA SI sobre una conversacion (migracion 0107).

Pedido el 10/10/2026, con Telegram de referencia: en el menu de un chat faltaban
«Silenciar» y «Vaciar chat».

LAS DOS SON PRIVADAS. Silenciar un grupo no lo silencia a los demas, y vaciar un
chat no le borra nada a nadie: los mensajes siguen en `messages` para el resto.
Aqui solo se anota que quiere quien pregunta, y la identidad sale SIEMPRE de la
sesion; ninguna ruta admite decidir por otra persona.

  · SILENCIAR quita el AVISO, no el mensaje. Sigue llegando, sigue contando
    como no leido y la conversacion sube en la bandeja igual. Lo que cambia es
    `avisos.destinatarios`: quien la silencio no recibe el push.
  · VACIAR anota un instante. El historial, las vistas del contenido y la
    vista previa de la bandeja dejan de enseñarle a ESA persona lo anterior.
    Lo que llegue despues se ve con normalidad.

LEER NUNCA FALLA POR UNA TABLA QUE FALTA. Sin la 0107 todas las lecturas de
este modulo devuelven «nada silenciado, nada vaciado» sin tocar la base, y las
tres rutas de escritura responden 503. La aplicacion lo pregunta antes
(`GET /conversations/availability`) y no las ofrece.

Lo que comprueba que la tabla existe es
`esquema.hay_preferencias_de_conversacion`.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import func, insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError, ServiceUnavailableError
from app.core.security import AuthUser, get_current_user
from app.modules.messaging import esquema
from app.modules.messaging.models import ConversationMember, ConversationPreference
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid

router = APIRouter(tags=["messaging"])


class Preferencia(BaseModel):
    """Lo decidido por una persona sobre una conversacion."""

    muted: bool = False
    cleared_at: datetime | None = None


SIN_PREFERENCIA = Preferencia()


# --------------------------------------------------------------------------- #
# Lectura
# --------------------------------------------------------------------------- #
async def de_la_pagina(
    db: AsyncSession, uid: str, conversation_ids: list[str]
) -> dict[str, Preferencia]:
    """Las preferencias de `uid` en VARIAS conversaciones, en UNA consulta.

    Solo salen las que tienen fila: la que no esta, no esta silenciada ni
    vaciada. `{}` sin conversaciones o sin la 0107, y entonces no se consulta.
    """
    if not conversation_ids or not await esquema.hay_preferencias_de_conversacion(db):
        return {}
    filas = await db.execute(
        select(
            ConversationPreference.conversation_id,
            ConversationPreference.muted,
            ConversationPreference.cleared_at,
        ).where(
            ConversationPreference.user_id == uid,
            ConversationPreference.conversation_id.in_(conversation_ids),
        )
    )
    return {
        str(conversacion): Preferencia(muted=bool(silenciada), cleared_at=vaciada_en)
        for conversacion, silenciada, vaciada_en in filas
    }


async def de_la_conversacion(db: AsyncSession, conversation_id: str, uid: str) -> Preferencia:
    """La preferencia de `uid` en UNA conversacion."""
    return (await de_la_pagina(db, uid, [conversation_id])).get(
        str(conversation_id), SIN_PREFERENCIA
    )


async def vaciado_desde(db: AsyncSession, conversation_id: str, uid: str) -> datetime | None:
    """Desde cuando quiere ver `uid` esta conversacion. `None`: entera."""
    return (await de_la_conversacion(db, conversation_id, uid)).cleared_at


async def quienes_silencian(
    db: AsyncSession, conversation_id: str, user_ids: list[str]
) -> set[str]:
    """Cuales de esas personas tienen silenciada la conversacion. UNA consulta."""
    if not user_ids or not await esquema.hay_preferencias_de_conversacion(db):
        return set()
    filas = await db.scalars(
        select(ConversationPreference.user_id).where(
            ConversationPreference.conversation_id == conversation_id,
            ConversationPreference.user_id.in_(user_ids),
            ConversationPreference.muted.is_(True),
        )
    )
    return {str(persona) for persona in filas}


# --------------------------------------------------------------------------- #
# Escritura
# --------------------------------------------------------------------------- #
async def _exigir(db: AsyncSession, conversation_id: str, uid: str) -> ConversationMember:
    """Que quien pregunta sea miembro, y que el servidor conozca la funcion.

    Pertenecer va PRIMERO: quien no es miembro recibe el mismo 403 exista o no
    la conversacion, y exista o no la tabla.
    """
    ensure_uuid(conversation_id, "Conversacion no encontrada.")
    miembro = await db.get(
        ConversationMember, {"conversation_id": conversation_id, "user_id": uid}
    )
    if miembro is None:
        raise ForbiddenError("No perteneces a esta conversación.")
    if not await esquema.hay_preferencias_de_conversacion(db):
        raise ServiceUnavailableError(
            "Silenciar y vaciar un chat todavía no están disponibles.",
            code="conversation_preferences_not_available",
        )
    return miembro


async def _guardar(db: AsyncSession, conversation_id: str, uid: str, **valores) -> None:
    """Cambia la fila de `uid`, o la crea. Dos toques a la vez no dejan dos.

    Primero se intenta cambiar; si no habia fila se inserta, y si otra peticion
    la creo entretanto —lo dice la clave primaria— se cambia la suya.
    """
    cambiar = (
        update(ConversationPreference)
        .where(
            ConversationPreference.conversation_id == conversation_id,
            ConversationPreference.user_id == uid,
        )
        .values(updated_at=func.now(), **valores)
    )
    hecho = await db.execute(cambiar)
    if hecho.rowcount:
        return
    try:
        await db.execute(
            insert(ConversationPreference).values(
                conversation_id=conversation_id,
                # La identidad sale del JWT. Nunca de la peticion.
                user_id=uid,
                **valores,
            )
        )
    except IntegrityError:
        await db.rollback()
        await db.execute(cambiar)


@router.put("/{conversation_id}/mute", status_code=status.HTTP_204_NO_CONTENT)
async def silenciar(
    conversation_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Quien pregunta deja de recibir avisos de esta conversacion."""
    await _exigir(db, conversation_id, current_user.id)
    await _guardar(db, conversation_id, current_user.id, muted=True)
    await db.commit()


@router.delete("/{conversation_id}/mute", status_code=status.HTTP_204_NO_CONTENT)
async def quitar_el_silencio(
    conversation_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Vuelven los avisos. Pedirlo sin haberla silenciado no es un error."""
    await _exigir(db, conversation_id, current_user.id)
    await _guardar(db, conversation_id, current_user.id, muted=False)
    await db.commit()


@router.post("/{conversation_id}/clear", status_code=status.HTTP_204_NO_CONTENT)
async def vaciar(
    conversation_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Quien pregunta deja de ver lo escrito hasta ahora. SOLO ELLA.

    No se borra ningun mensaje. Y la conversacion queda LEIDA: quien la vacia
    acaba de verla, y dejarle un contador de no leidos sobre un chat que se le
    enseña vacio seria una mentira.

    El instante lo pone la BASE (`now()`), no el telefono: es el mismo reloj
    que fecha los mensajes, que es contra lo que se compara.
    """
    await _exigir(db, conversation_id, current_user.id)
    await _guardar(db, conversation_id, current_user.id, cleared_at=func.now())
    await db.execute(
        update(ConversationMember)
        .where(
            ConversationMember.conversation_id == conversation_id,
            ConversationMember.user_id == current_user.id,
        )
        .values(last_read_at=func.now())
    )
    await db.commit()
