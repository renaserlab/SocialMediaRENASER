"""Borrar una cuenta: todo o nada, y los archivos ANTES de confirmar.

LA REGLA (29/09/2026). Al borrar una cuenta se borran sus datos personales y
sus archivos privados, y se conservan los registros históricos necesarios para
seguridad, trazabilidad, operación, disputas y auditoría, sin que sigan
identificando a la persona. La base lo hace sola al borrar el perfil: lo
personal cae en cascada y en los historiales quien actuó pasa a NULL (0089).

EL ORDEN, Y POR QUÉ:

  0. Se comprueba que la base tiene la 0089 COMPLETA (`_hay_0089`). Si no, o
     si no se puede comprobar, 503 y no se toca nada: con la versión a medias
     de la 0089 borrar se llevaba en cascada órdenes en las que se movió dinero.
  0b. Se mira si la persona tiene HISTORIA CONTRACTUAL en Servicios
     (`_sin_historia_de_servicios`, F21): un pedido, una reserva o lo que
     cuelga de ellos, como quien contrató o como quien prestó, vivo o cerrado.
     Si la tiene, 409 `service_history_requires_support`: la cuenta la cierra
     soporte. Si no se puede mirar, 503. En los dos casos no se ha borrado ni
     apuntado nada, ni se ha llamado a Storage. Es una decisión PROVISIONAL:
     ver `services/conservacion.py`.
  1. Se apuntan sus conversaciones: sus adjuntos de chat no van bajo su
     carpeta, y después de borrar ya no se podría saber cuáles eran. Y, por lo
     mismo, los servicios que ofrecía: las imágenes de su catálogo van bajo la
     carpeta de cada servicio, sin su perfil en la ruta (0096).
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
  5. DESPUÉS de confirmar, y en segundo plano cuando ya se ha contestado 204,
     lo de las demás personas en las conversaciones que creó y que se han ido
     enteras con ella (`retirar_conversaciones`). Antes de confirmar no: si la
     baja se deshiciera, esas conversaciones volverían sin sus adjuntos. En
     segundo plano porque la respuesta tiene que llegar antes de que el CDN
     corte (60 s). Si falla, la cuenta YA está borrada y se registra qué
     conversaciones retirar a mano; nadie puede abrir esos archivos desde la
     aplicación.

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
from app.modules.services import conservacion
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


class HistoriaDeServicios(ConflictError):
    """F21: la persona es parte de un pedido o de una reserva de Servicios (o
    de lo que cuelga de ellos). La baja automática no la toca: la atiende
    soporte. No dice qué tiene ni cuánto, y NO PROMETE CERRARLA: mientras no
    exista la anonimización, nadie puede cerrar esa cuenta sin destruir su
    historia."""

    code = "service_history_requires_support"
    message = (
        "Tu cuenta tiene reservas o atenciones de Z Servicios que debemos conservar, "
        "y no se puede eliminar de forma automática. Escribe a soporte para atender tu solicitud."
    )


class ArchivosSinBorrar(ServiceUnavailableError):
    code = "account_deletion_storage_failed"
    message = "No pudimos borrar tus archivos. Tu cuenta sigue activa: inténtalo de nuevo."


class BajaNoDisponible(ServiceUnavailableError):
    """La base no tiene la 0089 COMPLETA (o no se pudo comprobar). Sin ella,
    borrar puede chocar con un historial —y un choque no es una venta: decir
    «tienes ventas» sería mentir— o, peor, llevarse en cascada una orden en la
    que se movió dinero. No se toca nada.

    También cuando no se pudo mirar la historia de Servicios (F21): una cuenta
    que no se pudo mirar no se da por limpia."""

    code = "account_deletion_unavailable"
    message = "No podemos borrar tu cuenta en este momento. Sigue activa: inténtalo más tarde."


#: Un interbloqueo que PostgreSQL deshizo y un cerrojo que no llegó a tiempo.
_ESPERAS_FALLIDAS = ("40P01", "55P03")

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


async def _servicios(db: AsyncSession, usuario_id: str) -> list[str]:
    """Los servicios que esta persona ofrecía. Se van en cascada con su
    perfil, y con ellos el único sitio donde consta qué carpetas de
    `service-media` eran suyas.

    SI LAS TABLAS NO EXISTEN, NINGUNO: una base anterior al catálogo de
    Servicios no tiene esas tablas ni esas imágenes, y la baja no puede
    romperse por eso. El punto de guardado deja la transacción como estaba.

    CUALQUIER OTRO FALLO SÍ LA ROMPE (500, y se reintenta). Seguir sin la
    lista borraría los servicios en cascada y dejaría sus imágenes en el
    depósito para siempre, sin nada que diga de quién eran.
    """
    try:
        async with db.begin_nested():
            filas = await db.execute(
                text(
                    "select s.id from services s join service_providers p on p.id = s.provider_id "
                    "where p.profile_id = :perfil"
                ),
                {"perfil": usuario_id},
            )
            return sorted({str(f[0]) for f in filas})
    except DBAPIError as error:
        # 42P01: «no existe la relación». SQLite (pruebas) no da código: lo dice.
        if _origen(error)[0] == "42P01" or "no such table" in str(error).lower():
            return []
        raise


#: Lo que la baja necesita de la base, mirado en el catálogo pieza a pieza: no
#: el número de la migración ni una fila de un historial de migraciones, sino
#: cada protección de la 0089 de la que depende que borrar sea seguro. Una base
#: con la 0089 a medias (la versión de `c6d3cd6` no traía los frenos de las
#: órdenes con dinero) tiene que dar NO.
_LO_QUE_NECESITA_LA_BAJA = text(
    """
    select
      -- La excepción que deja anular a la persona en los historiales.
      to_regprocedure('public.es_anonimizacion_por_baja(jsonb, jsonb, text[])') is not null
      -- Cada disparador en SU tabla, llamando a SU función, con su forma
      -- (27 = before update or delete, por fila; 11 = before delete, por fila)
      -- y activo en las sesiones normales ('O' u 'A'; no 'D' ni 'R').
      and (
        select count(*)
          from (values
            ('public.audit_events', 'audit_events_solo_anadir',
             'public.auditoria_solo_anadir()', 27),
            ('public.event_orders', 'event_orders_con_dinero_no_se_borran',
             'public.event_orders_con_dinero_no_se_borran()', 11),
            ('public.orders', 'orders_con_dinero_no_se_borran',
             'public.orders_con_dinero_no_se_borran()', 11)
          ) as e(tabla, disparador, funcion, tipo)
         where exists (
           select 1
             from pg_catalog.pg_trigger t
            where t.tgrelid = to_regclass(e.tabla)
              and t.tgname = e.disparador
              and t.tgfoid = to_regprocedure(e.funcion)
              and t.tgtype = e.tipo
              and t.tgenabled in ('O', 'A')
              and not t.tgisinternal
         )
      ) = 3
      -- El consentimiento: admite NULL, y TODA clave sobre su sujeto va a
      -- `profiles` con `on delete set null`.
      and exists (
        select 1
          from pg_catalog.pg_attribute a
         where a.attrelid = to_regclass('public.consent_records')
           and a.attname = 'subject_id'
           and not a.attisdropped
           and not a.attnotnull
      )
      and coalesce((
        select bool_and(c.confdeltype = 'n' and c.confrelid = to_regclass('public.profiles'))
          from pg_catalog.pg_constraint c
          join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
         where c.contype = 'f'
           and c.conrelid = to_regclass('public.consent_records')
           and a.attname = 'subject_id'
      ), false)
    """
)

#: La respuesta se guarda en la memoria del proceso, también el «no», como la
#: puerta de Servicios (`services/esquema.py`). SE INVALIDA AL REINICIAR LA
#: API: después de aplicar una migración (o de tocar el esquema a mano) hay que
#: reiniciarla. Un error al mirar NO se guarda: ni se da por buena la base ni
#: se deja la baja cerrada hasta el próximo reinicio por un fallo pasajero.
_cache: dict[str, bool] = {}


def olvidar() -> None:
    """Para las pruebas: cada una monta (o desmonta) su propia base."""
    _cache.clear()


async def _hay_0089(db: AsyncSession) -> bool:
    """¿Tiene la base TODO lo de la 0089 que la baja necesita? Ante la duda, no."""
    try:
        if (await db.connection()).dialect.name != "postgresql":
            return True  # SQLite (pruebas): no hay disparadores que proteger
        if "baja" not in _cache:
            _cache["baja"] = bool(await db.scalar(_LO_QUE_NECESITA_LA_BAJA))
            if not _cache["baja"]:
                logger.warning("La base no tiene la 0089 completa: la baja de cuentas contesta 503.")
        return _cache["baja"]
    except Exception:  # noqa: BLE001 - cerrada ante cualquier fallo al mirar
        logger.warning("No se pudo comprobar la 0089: la baja de cuentas contesta 503.", exc_info=True)
        return False


async def _sin_historia_de_servicios(db: AsyncSession, usuario_id: str) -> None:
    """F21. Antes de apuntar, borrar o tocar un archivo: si la persona tiene
    historia contractual en Servicios, 409; si no se puede mirar, 503. En los
    dos casos la transacción se deshace (solo tenía cerrojos) y la cuenta
    sigue como estaba. Si pasa, sus servicios y su perfil quedan en fila hasta
    que la baja termine: no puede nacer una reserva entre mirar y borrar."""
    try:
        conserva = await conservacion.de_la_persona(db, usuario_id)
    except Exception:  # noqa: BLE001 - cerrada ante cualquier fallo al mirar
        await db.rollback()
        logger.warning(
            "No se pudo mirar la historia de Servicios de %s: la baja contesta 503.", usuario_id, exc_info=True
        )
        raise BajaNoDisponible() from None
    if conserva:
        await db.rollback()
        # Qué familias, nunca cuántas filas: es lo que soporte necesita saber.
        logger.warning(
            "La cuenta %s tiene historia contractual de Servicios (%s): la cierra soporte.",
            usuario_id, ", ".join(conserva),
        )
        raise HistoriaDeServicios()


async def borrar_cuenta(db: AsyncSession, usuario_id: str) -> list[str]:
    """Borra la cuenta. Devuelve las conversaciones que se fueron enteras con
    ella, para `retirar_conversaciones` después de contestar."""
    if not await _hay_0089(db):
        raise BajaNoDisponible()
    await _sin_historia_de_servicios(db, usuario_id)
    suyas, enteras = await _conversaciones(db, usuario_id)
    servicios = await _servicios(db, usuario_id)
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
        if sqlstate in _ESPERAS_FALLIDAS:
            # La baja y otra operación de la misma cuenta se esperaban la una
            # a la otra y PostgreSQL deshizo esta. No se borró nada ni se tocó
            # un archivo: 503, y repetir la petición la termina.
            logger.warning("Baja de %s deshecha por un cerrojo (%s): se puede reintentar", usuario_id, sqlstate)
            raise BajaNoDisponible() from None
        # 23xxx: una restricción (clave ajena `restrict`, disparador de
        # historial, CHECK). Cualquier otra cosa es un fallo de verdad: 500.
        if not (sqlstate or "").startswith("23"):
            raise
        logger.warning(
            "La cuenta %s no se puede borrar sola: %s (%s, %s)",
            usuario_id, sqlstate, tabla or "?", restriccion or "?",
        )
        # Con la 0089 completa (comprobado arriba), un choque así es un
        # registro que hay que conservar, no el de la auditoría.
        raise CuentaConRegistrosQueConservar(details={"reason": _area(tabla)}) from None

    try:
        # Lo suyo en TODAS sus conversaciones, también en las que creó, y las
        # imágenes de los servicios que ofrecía.
        await storage.delete_user_files(usuario_id, conversaciones=suyas + enteras, servicios=servicios)
    except (storage.StorageFallo, storage.StorageNoConfigurado):
        await db.rollback()
        logger.warning("Baja de %s deshecha: no se pudieron borrar sus archivos", usuario_id)
        raise ArchivosSinBorrar() from None

    await db.commit()
    return enteras


async def retirar_conversaciones(usuario_id: str, conversaciones: list[str]) -> None:
    """Lo de las demás personas en las conversaciones que se fueron enteras
    con la cuenta. Corre DESPUÉS de contestar: la cuenta ya no existe, y nada
    de aquí puede convertirse en un error para quien la borró."""
    if not conversaciones:
        return
    try:
        fallidas = await storage.borrar_conversaciones(conversaciones)
    except Exception:  # noqa: BLE001 - cualquier fallo: la baja ya está hecha
        fallidas = list(conversaciones)
    if fallidas:
        # Adjuntos de otras personas en conversaciones borradas, que nadie
        # puede abrir. Se dice cuáles (identificadores, nunca rutas) para
        # retirarlos a mano.
        logger.error(
            "Baja de %s hecha, pero quedan adjuntos de %d conversaciones borradas "
            "por retirar de message-media: %s",
            usuario_id, len(fallidas), ", ".join(fallidas),
        )
