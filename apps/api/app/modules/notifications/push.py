"""Envío de notificaciones push a través del servicio de Expo.

Por qué Expo y no Firebase/APNs directamente: la aplicación se compila con EAS,
así que Expo ya gestiona los certificados de Apple y las claves de Google. Su
endpoint recibe un token propio y se encarga de hablar con cada plataforma, de
modo que aquí no hay credenciales que rotar ni dos integraciones que mantener.

El envío NUNCA debe tumbar la operación que lo provocó: si el servicio de Expo
está caído, el «me gusta» tiene que guardarse igual. Por eso todo va dentro de
un try y los fallos solo se registran.
"""

from __future__ import annotations

import logging

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notifications.device_tokens import DeviceToken

logger = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"

#: Expo acepta como máximo 100 mensajes por petición.
BATCH_SIZE = 100

#: Textos de cada tipo de notificación. La clave es el `type` que ya usan los
#: routers, así que añadir un tipo nuevo aquí es lo único que hace falta.
#: `{actor}` se sustituye por el nombre de quien provocó el aviso.
TEMPLATES: dict[str, tuple[str, str]] = {
    "like": ("Nueva reacción", "A {actor} le gustó tu publicación."),
    "comment": ("Nuevo comentario", "{actor} comentó tu publicación."),
    "follow": ("Nuevo seguidor", "{actor} empezó a seguirte."),
    "session_booked": ("Nueva solicitud de sesión", "{actor} quiere agendar contigo."),
    # Cada respuesta lleva su propio texto. Con un unico tipo para todo, a
    # quien le rechazaban una sesion le llegaba «reservó una sesión contigo».
    "session_accepted": ("Sesión confirmada", "{actor} aceptó tu solicitud."),
    "session_rejected": ("Solicitud rechazada", "{actor} no puede en esta ocasión."),
    "session_cancelled": ("Sesión cancelada", "{actor} canceló la sesión."),
    "session_rescheduled": ("Nueva fecha propuesta", "{actor} propone otra fecha."),
    "session_completed": ("Sesión realizada", "{actor} dio la sesión por hecha."),
}

#: Canal de Android por tipo. Permite que el usuario silencie las
#: interacciones sin perderse un mensaje directo.
CHANNELS: dict[str, str] = {
    "like": "interacciones",
    "comment": "interacciones",
    "follow": "interacciones",
    "session_booked": "contenido",
    "session_accepted": "contenido",
    "session_rejected": "contenido",
    "session_cancelled": "contenido",
    "session_rescheduled": "contenido",
    "session_completed": "contenido",
}


def build_message(notification_type: str, actor_name: str | None) -> tuple[str, str] | None:
    """Título y cuerpo del aviso, o None si el tipo no tiene texto definido."""
    template = TEMPLATES.get(notification_type)
    if template is None:
        return None
    title, body = template
    # Sin nombre se usa un genérico: es preferible a un aviso que diga
    # «None comentó tu publicación».
    return title, body.format(actor=actor_name or "Alguien")


async def send_push(
    db: AsyncSession,
    *,
    user_id: str,
    notification_type: str,
    actor_name: str | None = None,
    data: dict | None = None,
) -> None:
    """Envía el aviso a todos los dispositivos registrados de un usuario."""
    message = build_message(notification_type, actor_name)
    if message is None:
        return
    title, body = message

    try:
        result = await db.execute(
            select(DeviceToken.token).where(DeviceToken.user_id == user_id)
        )
        tokens = [row[0] for row in result.all()]
    except Exception:  # noqa: BLE001 - un fallo aquí no debe romper la petición
        logger.warning("[push] no se pudieron leer los tokens", exc_info=True)
        return

    if not tokens:
        # Nadie ha registrado un dispositivo todavía; no es un error.
        return

    channel = CHANNELS.get(notification_type, "interacciones")
    messages = [
        {
            "to": token,
            "title": title,
            "body": body,
            # "default" = el sonido de notificación del propio teléfono.
            "sound": "default",
            "channelId": channel,
            "data": data or {},
        }
        for token in tokens
    ]

    for start in range(0, len(messages), BATCH_SIZE):
        batch = messages[start : start + BATCH_SIZE]
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.post(EXPO_PUSH_URL, json=batch)
                response.raise_for_status()
        except Exception:  # noqa: BLE001
            logger.warning("[push] fallo al enviar un lote", exc_info=True)
