"""Los avisos de la admisión de Servicios. Reutiliza lo que ya existe.

DOS CANALES, LOS DEL PROYECTO, y ninguno nuevo:

  1. LA BANDEJA de la app (`notifications.service.add_notification`): una fila
     con el `type` y la postulación. El TEXTO lo pone el teléfono en su idioma
     (es/en/pt); el `payload` va vacío a propósito: ni documentos, ni motivos,
     ni notas. Quien lo abre lee el detalle en la postulación.
  2. EL PUSH, por la COLA DE ENTREGAS (`notifications.entregas`), con sus
     reintentos. El texto sale de `notifications.textos` en el idioma del
     DISPOSITIVO (`device_tokens.locale`): el único idioma que el proyecto
     conoce de cada persona es el que eligió en su teléfono.

UN FALLO AQUÍ NO DESHACE NADA. Cada escritura va en su propio savepoint y
dentro de la transacción de la decisión: el aviso existe si y solo si la
decisión se guardó, y si el aviso falla, la decisión sigue en pie.

NO SE DUPLICA: la clave de la entrega es el EVENTO del historial, no la
postulación. Una decisión repetida no crea evento nuevo (idempotencia de las
transiciones) y, por tanto, tampoco aviso nuevo; y dos rondas de correcciones
son dos avisos, como debe ser.
"""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("renaser.services")

ENTIDAD = "service_application"

# A quien postula.
REVISION_INICIADA = "service_application_review_started"
CORRECCIONES_PEDIDAS = "service_application_changes_requested"
APROBADA = "service_application_approved"
RECHAZADA = "service_application_rejected"
SUSPENDIDA = "service_application_suspended"
RETIRADA = "service_application_withdrawn"
DOCUMENTO_OBSERVADO = "service_document_observed"
CREDENCIAL_OBSERVADA = "service_credential_observed"
CREDENCIAL_RECHAZADA = "service_credential_rejected"

# Al equipo de Z.
ENVIADA = "service_application_submitted"
REENVIADA = "service_application_resubmitted"
RETIRADA_EN_REVISION = "service_application_withdrawn_review"

TIPOS = frozenset(
    {
        REVISION_INICIADA,
        CORRECCIONES_PEDIDAS,
        APROBADA,
        RECHAZADA,
        SUSPENDIDA,
        RETIRADA,
        DOCUMENTO_OBSERVADO,
        CREDENCIAL_OBSERVADA,
        CREDENCIAL_RECHAZADA,
        ENVIADA,
        REENVIADA,
        RETIRADA_EN_REVISION,
    }
)

#: Tope de destinatarios del equipo. Hoy hay uno; esto evita que un error de
#: roles convierta un envío en cientos de avisos.
MAXIMO_DEL_EQUIPO = 50


async def _idioma_de(db: AsyncSession, usuario_id: str) -> str | None:
    from app.modules.notifications.device_tokens import DeviceToken

    return await db.scalar(
        select(DeviceToken.locale)
        .where(DeviceToken.user_id == usuario_id, DeviceToken.locale.is_not(None))
        .order_by(DeviceToken.last_seen_at.desc())
        .limit(1)
    )


async def avisar(
    db: AsyncSession,
    *,
    usuario_id: str,
    tipo: str,
    solicitud_id: str,
    suceso_id: str,
) -> bool:
    """Bandeja + push para UNA persona. Nunca lanza. Devuelve si quedó algo."""
    if tipo not in TIPOS or not usuario_id:
        return False
    escrito = False
    try:
        from app.modules.notifications.service import add_notification

        async with db.begin_nested():
            escrito = await add_notification(
                db,
                user_id=usuario_id,
                actor_id=None,
                type=tipo,
                entity_type=ENTIDAD,
                entity_id=solicitud_id,
                payload={},
            )
    except Exception:  # noqa: BLE001
        logger.exception("[servicios] no se pudo escribir el aviso %s", tipo)
    try:
        from app.modules.notifications import entregas, esquema

        if await esquema.hay_entregas(db):
            fila = await entregas.encolar(
                db,
                usuario_id=usuario_id,
                tipo=tipo,
                locale=await _idioma_de(db, usuario_id),
                entidad_id=suceso_id,
                correlacion=solicitud_id,
            )
            escrito = escrito or fila is not None
    except Exception:  # noqa: BLE001
        logger.exception("[servicios] no se pudo encolar el push %s", tipo)
    return escrito


async def equipo(db: AsyncSession, *, excepto: set[str]) -> list[str]:
    """Quién revisa: `admin` y `moderator`, sin el propio interesado."""
    from app.modules.profiles.models import Profile
    from app.shared.permissions import ADMIN_ROLES

    filas = await db.scalars(
        select(Profile.id)
        .where(Profile.role.in_(tuple(ADMIN_ROLES)))
        .order_by(Profile.id)
        .limit(MAXIMO_DEL_EQUIPO)
    )
    return [str(i) for i in filas if str(i) not in excepto]


async def avisar_al_equipo(
    db: AsyncSession,
    *,
    tipo: str,
    solicitud_id: str,
    suceso_id: str,
    excepto: set[str],
) -> int:
    enviados = 0
    for revisor in await equipo(db, excepto=excepto):
        if await avisar(
            db, usuario_id=revisor, tipo=tipo, solicitud_id=solicitud_id, suceso_id=suceso_id
        ):
            enviados += 1
    return enviados


__all__ = [
    "APROBADA",
    "CORRECCIONES_PEDIDAS",
    "CREDENCIAL_OBSERVADA",
    "CREDENCIAL_RECHAZADA",
    "DOCUMENTO_OBSERVADO",
    "ENTIDAD",
    "ENVIADA",
    "RECHAZADA",
    "REENVIADA",
    "RETIRADA",
    "RETIRADA_EN_REVISION",
    "REVISION_INICIADA",
    "SUSPENDIDA",
    "TIPOS",
    "avisar",
    "avisar_al_equipo",
    "equipo",
]
