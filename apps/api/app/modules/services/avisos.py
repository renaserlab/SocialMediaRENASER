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
#: El catálogo (Incremento 2): el aviso apunta al SERVICIO, no a la versión.
ENTIDAD_SERVICIO = "service"
#: La reserva (Incremento 5): el aviso apunta a la RESERVA. No es `booking`:
#: ese nombre es de la agenda de sesiones del prototipo (0025).
ENTIDAD_RESERVA = "service_booking"

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

# EL CATÁLOGO (Incremento 2). Al prestador, sobre su servicio:
SERVICIO_EN_REVISION = "service_catalog_review_started"
SERVICIO_CAMBIOS_PEDIDOS = "service_catalog_changes_requested"
SERVICIO_APROBADO = "service_catalog_approved"
SERVICIO_PUBLICADO = "service_catalog_published"
SERVICIO_SUSPENDIDO = "service_catalog_suspended"
SERVICIO_REACTIVADO = "service_catalog_reinstated"
SERVICIO_RETIRADO = "service_catalog_retired"
#: Se publicó una versión nueva de un servicio que sigue SUSPENDIDO.
SERVICIO_PUBLICADO_EN_SUSPENSO = "service_catalog_published_suspended"
# Y al equipo de Z:
SERVICIO_ENVIADO = "service_catalog_submitted"
SERVICIO_REENVIADO = "service_catalog_resubmitted"
SERVICIO_RETIRADO_EN_REVISION = "service_catalog_withdrawn_review"

# LA RESERVA (Incremento 5). A quien contrata, y al prestador. Sin la fecha,
# la dirección ni la nota: quien lo abre lee el detalle en la reserva.
RESERVA_CONFIRMADA = "service_booking_confirmed"
RESERVA_RECIBIDA = "service_booking_received"
TIPOS_DE_LA_RESERVA = frozenset({RESERVA_CONFIRMADA, RESERVA_RECIBIDA})

# LA ATENCIÓN Y LA POSVENTA (Incremento 6). Como los de la reserva: sin fecha,
# dirección, nota, motivo ni evidencia. EL TIPO DICE A QUIÉN VA (`_client` a
# quien contrata, `_provider` al prestador, `_team` al equipo de Z): con él
# decide el teléfono a qué pantalla lleva, porque el `payload` va vacío.
CANCELADA_POR_QUIEN_CONTRATA = "service_booking_cancelled_provider"
CANCELADA_POR_EL_PRESTADOR = "service_booking_cancelled_client"
REPROGRAMADA = "service_booking_rescheduled_provider"
RECORDATORIO_A_QUIEN_CONTRATA = "service_booking_reminder_client"
RECORDATORIO_AL_PRESTADOR = "service_booking_reminder_provider"
ATENCION_POR_CONFIRMAR = "service_attention_completed_client"
AUSENCIA_DE_QUIEN_CONTRATA = "service_attention_absent_client"
AUSENCIA_DEL_PRESTADOR = "service_attention_absent_provider"
CASO_ABIERTO_A_QUIEN_CONTRATA = "service_incident_opened_client"
CASO_ABIERTO_AL_PRESTADOR = "service_incident_opened_provider"
CASO_ABIERTO_AL_EQUIPO = "service_incident_opened_team"
CASO_NOVEDAD_A_QUIEN_CONTRATA = "service_incident_updated_client"
CASO_NOVEDAD_AL_PRESTADOR = "service_incident_updated_provider"
CASO_RESUELTO_A_QUIEN_CONTRATA = "service_incident_resolved_client"
CASO_RESUELTO_AL_PRESTADOR = "service_incident_resolved_provider"
CASO_APELADO_AL_EQUIPO = "service_incident_appealed_team"
RESENA_DISPONIBLE = "service_review_available_client"
RESENA_RECIBIDA = "service_review_received_provider"
RESENA_RESPONDIDA = "service_review_replied_client"
#: El aviso de un caso al EQUIPO apunta al CASO; los demás, a la reserva.
ENTIDAD_CASO = "service_incident"
TIPOS_DE_LA_ATENCION = frozenset(
    {
        CANCELADA_POR_QUIEN_CONTRATA,
        CANCELADA_POR_EL_PRESTADOR,
        REPROGRAMADA,
        RECORDATORIO_A_QUIEN_CONTRATA,
        RECORDATORIO_AL_PRESTADOR,
        ATENCION_POR_CONFIRMAR,
        AUSENCIA_DE_QUIEN_CONTRATA,
        AUSENCIA_DEL_PRESTADOR,
        CASO_ABIERTO_A_QUIEN_CONTRATA,
        CASO_ABIERTO_AL_PRESTADOR,
        CASO_ABIERTO_AL_EQUIPO,
        CASO_NOVEDAD_A_QUIEN_CONTRATA,
        CASO_NOVEDAD_AL_PRESTADOR,
        CASO_RESUELTO_A_QUIEN_CONTRATA,
        CASO_RESUELTO_AL_PRESTADOR,
        CASO_APELADO_AL_EQUIPO,
        RESENA_DISPONIBLE,
        RESENA_RECIBIDA,
        RESENA_RESPONDIDA,
    }
)

TIPOS_DEL_CATALOGO = frozenset(
    {
        SERVICIO_EN_REVISION,
        SERVICIO_CAMBIOS_PEDIDOS,
        SERVICIO_APROBADO,
        SERVICIO_PUBLICADO,
        SERVICIO_SUSPENDIDO,
        SERVICIO_REACTIVADO,
        SERVICIO_RETIRADO,
        SERVICIO_PUBLICADO_EN_SUSPENSO,
        SERVICIO_ENVIADO,
        SERVICIO_REENVIADO,
        SERVICIO_RETIRADO_EN_REVISION,
    }
)

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
    | TIPOS_DEL_CATALOGO
    | TIPOS_DE_LA_RESERVA
    | TIPOS_DE_LA_ATENCION
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
    entidad: str = ENTIDAD,
) -> bool:
    """Bandeja + push para UNA persona. Nunca lanza. Devuelve si quedó algo.

    `solicitud_id` es la entidad a la que lleva el aviso: la postulación o,
    en el catálogo (`entidad=ENTIDAD_SERVICIO`), el servicio."""
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
                entity_type=entidad,
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
    entidad: str = ENTIDAD,
) -> int:
    enviados = 0
    for revisor in await equipo(db, excepto=excepto):
        if await avisar(
            db,
            usuario_id=revisor,
            tipo=tipo,
            solicitud_id=solicitud_id,
            suceso_id=suceso_id,
            entidad=entidad,
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
    "ENTIDAD_SERVICIO",
    "ENVIADA",
    "RECHAZADA",
    "REENVIADA",
    "RETIRADA",
    "RETIRADA_EN_REVISION",
    "REVISION_INICIADA",
    "SERVICIO_APROBADO",
    "SERVICIO_CAMBIOS_PEDIDOS",
    "SERVICIO_ENVIADO",
    "SERVICIO_EN_REVISION",
    "SERVICIO_PUBLICADO",
    "SERVICIO_REACTIVADO",
    "SERVICIO_REENVIADO",
    "SERVICIO_RETIRADO",
    "SERVICIO_RETIRADO_EN_REVISION",
    "SERVICIO_SUSPENDIDO",
    "SUSPENDIDA",
    "TIPOS",
    "TIPOS_DEL_CATALOGO",
    "avisar",
    "avisar_al_equipo",
    "equipo",
]
