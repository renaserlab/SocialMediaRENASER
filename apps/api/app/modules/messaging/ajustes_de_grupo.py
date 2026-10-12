"""Lo que un grupo tiene ademas de sus mensajes: foto, enlace y solicitudes.

Aqui solo hay LECTURAS Y UTILIDADES sobre `group_settings` y
`group_join_requests` (migracion 0104). Las rutas estan en
`entrada_a_grupos.py`; este fichero existe aparte para que `grupos.py` y
`lectura.py` puedan leer la foto de un grupo sin depender de esas rutas.

SIN LA 0104 TODO ESTO DEVUELVE «NADA» SIN TOCAR LA BASE: un grupo sin foto,
sin enlace y sin solicitudes, que es exactamente lo que habia antes.
"""

from __future__ import annotations

import secrets

from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.messaging import esquema
from app.modules.messaging.models import (
    ConversationMember,
    GroupJoinRequest,
    GroupSettings,
)


class AjustesLeidos(BaseModel):
    """Como esta configurada la entrada a un grupo. Solo lo ve quien lo administra."""

    #: Sale en «Unete a mi grupo», en el perfil de quien lo administra.
    listed_on_profile: bool = False
    #: El enlace del grupo esta activo.
    invite_enabled: bool = False
    #: El codigo del enlace. `None` hasta que se activa por primera vez.
    invite_code: str | None = None


def codigo_nuevo() -> str:
    """Un codigo de enlace que no se adivina: 24 caracteres seguros para una URL.

    Sale de `secrets`, no de `random`: quien conoce un enlace no puede deducir
    el de otro grupo. Solo lleva letras, cifras, `-` y `_`, que es lo que
    admite la restriccion de la tabla.
    """
    return secrets.token_urlsafe(18)


async def fila_de(db: AsyncSession, conversation_id: str) -> GroupSettings | None:
    if not await esquema.hay_puertas_de_grupo(db):
        return None
    return (
        await db.execute(
            select(GroupSettings).where(GroupSettings.conversation_id == conversation_id)
        )
    ).scalar_one_or_none()


async def asegurar_fila(db: AsyncSession, conversation_id: str) -> GroupSettings:
    """La fila de ajustes del grupo, creandola si es la primera vez.

    Dos peticiones a la vez pueden intentar crearla: la que pierde se encuentra
    con la clave primaria ocupada y lee la de la ganadora.
    """
    fila = await fila_de(db, conversation_id)
    if fila is not None:
        return fila
    fila = GroupSettings(conversation_id=conversation_id)
    db.add(fila)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        fila = await fila_de(db, conversation_id)
        assert fila is not None  # el conflicto prueba que existe
    return fila


def leer(fila: GroupSettings | None) -> AjustesLeidos:
    if fila is None:
        return AjustesLeidos()
    return AjustesLeidos(
        listed_on_profile=bool(fila.listed_on_profile),
        invite_enabled=bool(fila.invite_enabled),
        invite_code=fila.invite_code,
    )


async def avatares_de(db: AsyncSession, conversation_ids: list[str]) -> dict[str, str]:
    """La foto de VARIOS grupos, en UNA consulta. `{}` sin grupos o sin la 0104.

    Con la lista vacia no se consulta: es lo normal en una bandeja donde todos
    los chats son de dos personas, y no tiene por que costar un viaje a la base.
    """
    if not conversation_ids or not await esquema.hay_puertas_de_grupo(db):
        return {}
    filas = await db.execute(
        select(GroupSettings.conversation_id, GroupSettings.avatar_path).where(
            GroupSettings.conversation_id.in_(conversation_ids),
            GroupSettings.avatar_path.is_not(None),
        )
    )
    return {conversacion: ruta for conversacion, ruta in filas}


async def pendientes_de(db: AsyncSession, conversation_id: str) -> int:
    """Cuantas solicitudes esperan respuesta. No cuenta a quien ya esta dentro.

    Alguien pudo pedir entrar y, antes de que se respondiera, ser añadido a
    mano. Su solicitud sigue «pendiente» en la tabla, pero ya no hay nada que
    decidir: no puede contar como trabajo por hacer.
    """
    if not await esquema.hay_puertas_de_grupo(db):
        return 0
    ya_dentro = (
        select(ConversationMember.user_id)
        .where(
            ConversationMember.conversation_id == conversation_id,
            ConversationMember.user_id == GroupJoinRequest.user_id,
        )
        .correlate(GroupJoinRequest)
        .exists()
    )
    return int(
        await db.scalar(
            select(func.count())
            .select_from(GroupJoinRequest)
            .where(
                GroupJoinRequest.conversation_id == conversation_id,
                GroupJoinRequest.status == "pending",
                ~ya_dentro,
            )
        )
        or 0
    )
