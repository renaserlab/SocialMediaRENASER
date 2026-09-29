"""Borrar una cuenta: todo o nada, y los archivos ANTES de confirmar.

LA REGLA (29/09/2026). Al borrar una cuenta se borran sus datos personales y
sus archivos privados, y se conservan los registros históricos necesarios para
seguridad, trazabilidad, operación, disputas y auditoría, sin que sigan
identificando a la persona. La base lo hace sola al borrar el perfil: lo
personal cae en cascada y en los historiales quien actuó pasa a NULL (0089).

EL ORDEN, Y POR QUÉ:

  1. Se apuntan sus conversaciones: sus adjuntos de chat no van bajo su
     carpeta, y después de borrar ya no se podría saber cuáles eran.
  2. Se borra en la base SIN CONFIRMAR, y se fuerzan ya las comprobaciones
     diferidas. Si algo lo impide —una venta, un saldo, un pedido—, la
     transacción se deshace y NO SE HA TOCADO NINGÚN ARCHIVO: 409.
  3. Se borran SUS archivos (los de nadie más). Si Storage falla, la
     transacción se deshace: la cuenta sigue entera y responde 503. Primero
     se lista todo: si Storage no contesta ahí, no se ha borrado ningún
     archivo. Si falla ya borrando, puede faltar alguno de los que sí se
     borraron; repetir la petición termina el trabajo.
  4. Se confirma. Si la confirmación fallara (se cae la conexión), la cuenta
     sigue y sus archivos ya no: repetir la petición la borra.
  5. DESPUÉS de confirmar, lo de las demás personas en las conversaciones que
     creó y que se han ido enteras con ella. Antes de confirmar no: si la baja
     se deshiciera, esas conversaciones volverían sin sus adjuntos. Si esto
     falla, la cuenta YA está borrada (204) y se registra qué conversaciones
     retirar a mano; nadie puede abrir esos archivos desde la aplicación.

Antes era al revés: primero los archivos, sin mirar si fallaban, y después la
base. Una cuenta que la base no dejaba borrar se quedaba viva y sin sus
documentos, y un fallo de Storage dejaba archivos sin dueño con la cuenta ya
borrada y la petición contestando que todo había ido bien.

REPETIR ES SEGURO. Borrar un perfil que ya no está no borra nada, y Storage no
se queja de nombres que ya no existen: la segunda petición responde 204.

La identidad sale del token ya validado, nunca de un id recibido: solo se
puede borrar la cuenta propia.
"""

from __future__ import annotations

import logging

from sqlalchemy import delete, or_, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, ServiceUnavailableError
from app.modules.messaging.models import Conversation, ConversationMember
from app.modules.profiles.models import Profile
from app.shared import storage

logger = logging.getLogger(__name__)


class CuentaConRegistrosQueConservar(ConflictError):
    """La base no deja borrar la cuenta: hay ventas, saldos, pedidos,
    incidencias o disputas que la plataforma tiene que conservar."""

    code = "account_deletion_blocked"
    message = (
        "Tu cuenta tiene ventas, pedidos o reclamos que debemos conservar. "
        "Escríbenos y la cerramos contigo."
    )


class ArchivosSinBorrar(ServiceUnavailableError):
    code = "account_deletion_storage_failed"
    message = "No pudimos borrar tus archivos. Tu cuenta sigue activa: inténtalo de nuevo."


class BajaNoDisponible(ServiceUnavailableError):
    """La base no tiene la 0089: un fallo de restricción puede ser el choque de
    la auditoría que la 0089 resuelve, y no una venta. Decir «tienes ventas»
    sería mentir."""

    code = "account_deletion_unavailable"
    message = "No podemos borrar tu cuenta en este momento. Sigue activa: inténtalo más tarde."


#: De qué área es la fila que impidió el borrado. Solo para decirlo con
#: palabras al móvil y al registro; nunca se devuelve el nombre de una tabla.
_AREAS = (
    ("product", "products"),
    ("owner_", "earnings"),
    ("event_", "events"),
    ("orders", "courses"),
    ("purchases", "courses"),
    ("commerce_", "courses"),
    ("course_", "courses"),
    ("refund_", "courses"),
)


def _area(tabla: str | None) -> str:
    for prefijo, area in _AREAS:
        if (tabla or "").startswith(prefijo):
            return area
    return "records"


def _origen(error: DBAPIError) -> tuple[str | None, str | None, str | None]:
    """`(sqlstate, tabla, restricción)` del error de PostgreSQL, si lo dice."""
    original = getattr(error, "orig", None)
    causa = getattr(original, "__cause__", None) or original
    return (
        getattr(original, "sqlstate", None) or getattr(causa, "sqlstate", None),
        getattr(causa, "table_name", None),
        getattr(causa, "constraint_name", None),
    )


async def _conversaciones(db: AsyncSession, usuario_id: str) -> tuple[list[str], list[str]]:
    """`(donde está, las que creó)`. Las que creó se van enteras con la cuenta
    (`conversations.created_by` es `on delete cascade`)."""
    filas = (
        await db.execute(
            select(Conversation.id, Conversation.created_by)
            .outerjoin(
                ConversationMember,
                (ConversationMember.conversation_id == Conversation.id)
                & (ConversationMember.user_id == usuario_id),
            )
            .where(
                or_(
                    Conversation.created_by == usuario_id,
                    ConversationMember.user_id == usuario_id,
                )
            )
        )
    ).all()
    enteras = sorted({str(c) for c, creador in filas if str(creador) == usuario_id})
    suyas = sorted({str(c) for c, _ in filas} - set(enteras))
    return suyas, enteras


async def _hay_0089(db: AsyncSession) -> bool:
    if (await db.connection()).dialect.name != "postgresql":
        return True
    return bool(
        await db.scalar(
            text(
                "select to_regprocedure("
                "'public.es_anonimizacion_por_baja(jsonb, jsonb, text[])') is not null"
            )
        )
    )


async def borrar_cuenta(db: AsyncSession, usuario_id: str) -> None:
    suyas, enteras = await _conversaciones(db, usuario_id)
    postgres = (await db.connection()).dialect.name == "postgresql"

    try:
        await db.execute(delete(Profile).where(Profile.id == usuario_id))
        if postgres:
            # Cross-schema y sin modelo ORM: SQL parametrizado. `profiles`
            # cuelga de `auth.users` en cascada; se borra aparte igualmente para
            # no depender de esa clave. Solo existe en PostgreSQL (Supabase).
            await db.execute(text("DELETE FROM auth.users WHERE id = :uid"), {"uid": usuario_id})
            # Lo diferido (cuadres de órdenes, coherencia de Servicios) se
            # comprueba AHORA, antes de tocar los archivos: si no, podría fallar
            # al confirmar con los archivos ya borrados.
            await db.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
    except DBAPIError as error:
        await db.rollback()
        sqlstate, tabla, restriccion = _origen(error)
        # 23xxx: una restricción (clave ajena `restrict`, disparador de
        # historial, CHECK). Cualquier otra cosa es un fallo de verdad: 500.
        if not (sqlstate or "").startswith("23"):
            raise
        logger.warning(
            "La cuenta %s no se puede borrar sola: %s (%s, %s)",
            usuario_id, sqlstate, tabla or "?", restriccion or "?",
        )
        if not await _hay_0089(db):
            raise BajaNoDisponible() from None
        raise CuentaConRegistrosQueConservar(details={"reason": _area(tabla)}) from None

    try:
        # Lo suyo en TODAS sus conversaciones, también en las que creó.
        await storage.delete_user_files(usuario_id, conversaciones=suyas + enteras)
    except (storage.StorageFallo, storage.StorageNoConfigurado):
        await db.rollback()
        logger.warning("Baja de %s deshecha: no se pudieron borrar sus archivos", usuario_id)
        raise ArchivosSinBorrar() from None

    await db.commit()

    try:
        await storage.borrar_conversaciones(enteras)
    except (storage.StorageFallo, storage.StorageNoConfigurado):
        # La cuenta ya no existe; lo que queda son adjuntos de otras personas
        # en conversaciones borradas, que nadie puede abrir. Se dice cuáles
        # (identificadores, nunca rutas) para retirarlos a mano.
        logger.error(
            "Baja de %s hecha, pero quedan adjuntos de %d conversaciones borradas "
            "por retirar de message-media: %s",
            usuario_id, len(enteras), ", ".join(enteras),
        )
