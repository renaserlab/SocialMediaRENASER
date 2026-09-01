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
from fastapi import BackgroundTasks
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.notifications.device_tokens import DeviceToken
from app.shared.database import SessionLocal

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
    # Responder a un comentario tiene su propio texto: a quien le responden
    # no le comentaron la publicación, y con el texto de arriba parecía que
    # el aviso era de otra cosa.
    "comment_reply": ("Nueva respuesta", "{actor} respondió a tu comentario."),
    "comment_like": ("Nueva reacción", "A {actor} le gustó tu comentario."),
    "follow": ("Nuevo seguidor", "{actor} empezó a seguirte."),
    "session_booked": ("Nueva solicitud de sesión", "{actor} quiere agendar contigo."),
    # Cada respuesta lleva su propio texto. Con un unico tipo para todo, a
    # quien le rechazaban una sesion le llegaba «reservó una sesión contigo».
    "session_accepted": ("Sesión confirmada", "{actor} aceptó tu solicitud."),
    "session_rejected": ("Solicitud rechazada", "{actor} no puede en esta ocasión."),
    "session_cancelled": ("Sesión cancelada", "{actor} canceló la sesión."),
    "session_rescheduled": ("Nueva fecha propuesta", "{actor} propone otra fecha."),
    "session_completed": ("Sesión realizada", "{actor} dio la sesión por hecha."),
    # Etiquetar a alguien (migracion 0032). El texto dice QUE pasó y no «tienes
    # una notificación»: quien lo lee en la pantalla de bloqueo tiene que poder
    # decidir si abre la aplicación sin abrirla.
    "post_mention": ("Te etiquetaron", "{actor} te etiquetó en una publicación."),
}

#: Canal de Android por tipo. Permite que el usuario silencie las
#: interacciones sin perderse un mensaje directo.
CHANNELS: dict[str, str] = {
    "like": "interacciones",
    "comment": "interacciones",
    "comment_reply": "interacciones",
    "comment_like": "interacciones",
    "follow": "interacciones",
    "session_booked": "contenido",
    "session_accepted": "contenido",
    "session_rejected": "contenido",
    "session_cancelled": "contenido",
    "session_rescheduled": "contenido",
    "session_completed": "contenido",
    # Va en «interacciones» con los «me gusta» y los comentarios: es alguien
    # actuando sobre contenido, y quien silencie ese canal espera silenciar
    # tambien esto.
    "post_mention": "interacciones",
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
    await send_push_many(
        db,
        user_ids=[user_id],
        notification_type=notification_type,
        actor_name=actor_name,
        data=data,
    )


async def send_push_many(
    db: AsyncSession,
    *,
    user_ids: list[str],
    notification_type: str,
    actor_name: str | None = None,
    data: dict | None = None,
) -> None:
    """El mismo aviso para VARIAS personas, con una consulta y un envío.

    Existe por las menciones: etiquetar a diez personas en una publicación
    hacía diez lecturas de tokens y diez peticiones a Expo, en fila. Expo
    admite 100 mensajes por petición (`BATCH_SIZE`), así que lo normal es que
    todo salga en una sola.
    """
    if not user_ids:
        return
    message = build_message(notification_type, actor_name)
    if message is None:
        return
    title, body = message

    try:
        result = await db.execute(
            select(DeviceToken.token).where(DeviceToken.user_id.in_(user_ids))
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


async def _enviar_con_sesion_propia(
    user_ids: list[str],
    notification_type: str,
    actor_name: str | None,
    data: dict | None,
) -> None:
    """El envío real, ya fuera de la petición y con su propia sesión."""
    async with SessionLocal() as db:
        await send_push_many(
            db,
            user_ids=user_ids,
            notification_type=notification_type,
            actor_name=actor_name,
            data=data,
        )


def encolar_push(
    background: BackgroundTasks,
    *,
    user_ids: list[str],
    notification_type: str,
    actor_name: str | None = None,
    data: dict | None = None,
) -> None:
    """Programa el aviso para DESPUÉS de responder. Úsese siempre esto.

    POR QUE NO SE ENVIA DENTRO DE LA PETICION.

    `send_push` lee los tokens y luego habla con `exp.host` con una espera de
    hasta 10 segundos. Llamándolo con un `await` dentro del handler pasaban dos
    cosas, y la segunda es la grave:

      1. Quien daba un «me gusta» esperaba a que Expo contestara para ver su
         propio «me gusta». La respuesta iba detrás de un servicio de terceros.

      2. La sesión de la petición mantiene su conexión OCUPADA durante toda esa
         llamada de red. El pool son 5 conexiones más 5 de reserva
         (`shared/database.py`): con diez interacciones a la vez y Expo lento,
         el pool se agota y CUALQUIER otra petición de la aplicación —el muro,
         el perfil, los mensajes— se queda esperando turno. Un aviso que no le
         importa a nadie tumbaba cosas que sí.

    En segundo plano el aviso sale igual, con su propia sesión, y si Expo tarda
    o falla no se entera nadie más.
    """
    if not user_ids:
        return
    background.add_task(
        _enviar_con_sesion_propia,
        list(user_ids),
        notification_type,
        actor_name,
        data,
    )
