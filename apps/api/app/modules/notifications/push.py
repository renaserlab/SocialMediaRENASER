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
from sqlalchemy import delete, select
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
    # Venta de un curso. El texto dice QUE paso: quien lo lee en la pantalla
    # de bloqueo tiene que poder decidir si abre la aplicacion sin abrirla.
    "course_purchase": ("Nueva compra de tu curso", "{actor} compró tu curso."),
    # Devoluciones. Moderadas: una al recibir y una por resolucion. Un aviso
    # por cada actualizacion tecnica convierte la bandeja en ruido.
    "refund_requested": ("Solicitud recibida", "Estamos revisando tu solicitud de devolución."),
    "refund_approved": ("Solicitud aprobada", "Tu devolución se está procesando."),
    "refund_rejected": ("Solicitud rechazada", "Revisa el motivo en tus compras."),
    "refund_refunded": ("Devolución completada", "El importe vuelve a tu método de pago."),
    "follow": ("Nuevo seguidor", "{actor} empezó a seguirte."),
    # Un mensaje de chat. SIN EL TEXTO DEL MENSAJE: un push se lee en la
    # pantalla bloqueada. Dice quién escribe; el contenido se lee dentro.
    "message": ("Nuevo mensaje", "{actor} te envió un mensaje."),
    # Alguien a quien sigues empezó un directo (`live/avisos.py`). Como en
    # TikTok: el nombre en el cuerpo, para decidir desde la pantalla de bloqueo.
    "live_started": ("En vivo ahora", "{actor} está transmitiendo en vivo."),
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
    # Decisiones sobre lo que creó cada persona (`decisiones.py`). Sin actor:
    # decide la plataforma. El texto no nombra el elemento porque la plantilla
    # no lo recibe; la bandeja sí lo dice, con su título.
    "event_admission_approved": ("Evento aprobado", "Tu evento pasó la revisión."),
    "event_admission_conditional": ("Evento aprobado con condiciones", "Revisa qué falta en tu evento."),
    "event_admission_rejected": ("Evento no aprobado", "Revisa el motivo en Mis eventos."),
    "event_admission_changes": ("Tu evento necesita cambios", "Revisa las correcciones en Mis eventos."),
    "event_published": ("Evento publicado", "Tu evento ya se ve en Z."),
    "event_suspended": ("Evento suspendido", "Revisa el motivo en Mis eventos."),
    "course_review_approved": ("Curso aprobado", "Ya puedes publicar tu curso."),
    "course_review_rejected": ("Curso no aprobado", "Revisa el motivo en tu curso."),
    "course_published": ("Curso publicado", "Tu curso ya se ve en Z."),
    "seller_application_accepted": ("Postulación aceptada", "Ya puedes crear tus productos."),
    "seller_application_rejected": ("Postulación no aceptada", "Revisa el motivo en tu postulación."),
    "product_published": ("Producto publicado", "Tu producto ya se ve en Z."),
    "product_suspended": ("Producto suspendido", "Revisa el motivo en Mis productos."),
    "product_photo_rejected": ("Foto no aprobada", "Revisa las fotos de tu producto."),
}

#: Canal de Android por tipo. Permite que el usuario silencie las
#: interacciones sin perderse un mensaje directo.
CHANNELS: dict[str, str] = {
    "like": "interacciones",
    "comment": "interacciones",
    "comment_reply": "interacciones",
    "comment_like": "interacciones",
    "course_purchase": "contenido",
    "refund_requested": "contenido",
    "refund_approved": "contenido",
    "refund_rejected": "contenido",
    "refund_refunded": "contenido",
    "follow": "interacciones",
    "message": "mensajes",
    # Con los seguidores y los «me gusta»: es alguien a quien sigues haciendo
    # algo, no una gestion tuya.
    "live_started": "interacciones",
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
    # Decisiones sobre lo propio: «contenido», con las devoluciones y las
    # sesiones. Silenciar los «me gusta» no puede silenciar esto.
    **{
        tipo: "contenido"
        for tipo in (
            "event_admission_approved",
            "event_admission_conditional",
            "event_admission_rejected",
            "event_admission_changes",
            "event_published",
            "event_suspended",
            "course_review_approved",
            "course_review_rejected",
            "course_published",
            "seller_application_accepted",
            "seller_application_rejected",
            "product_published",
            "product_suspended",
            "product_photo_rejected",
        )
    },
}


#: La generación de los canales de Android.
#:
#: Los de la primera se crearon en el teléfono con `sound: null`, que en
#: `expo-notifications` es «sin sonido»: los avisos llegaban mudos. Android no
#: deja cambiar el sonido de un canal ya creado, así que la aplicación estrena
#: ids (`services/notifications.ts`) y aquí se manda a esos mismos. Si algún
#: día hay que volver a cambiar algo de los canales, se sube este sufijo en los
#: DOS sitios a la vez.
SUFIJO_DE_CANAL = "-v2"


def canal_android(nombre: str) -> str:
    """El id del canal tal como existe en el teléfono."""
    return f"{nombre}{SUFIJO_DE_CANAL}"


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

    tokens = await _leer_tokens(db, user_ids)
    await _enviar_a(
        tokens,
        title=title,
        body=body,
        channel=CHANNELS.get(notification_type, "interacciones"),
        data=data,
    )


async def _leer_tokens(db: AsyncSession, user_ids: list[str]) -> list[str]:
    """Los aparatos registrados de esas personas. NUNCA LANZA."""
    try:
        result = await db.execute(
            select(DeviceToken.token).where(DeviceToken.user_id.in_(user_ids))
        )
        return [row[0] for row in result.all()]
    except Exception:  # noqa: BLE001 - un fallo aquí no debe romper la petición
        logger.warning("[push] no se pudieron leer los tokens", exc_info=True)
        return []


async def _enviar_a(
    tokens: list[str],
    *,
    title: str,
    body: str,
    channel: str,
    data: dict | None,
) -> None:
    """Habla con Expo. NO TOCA LA BASE DE DATOS mientras lo hace.

    Recibe los tokens ya leídos, a propósito: quien llama puede haber soltado
    su conexión antes de entrar aquí, y esta función puede tardar hasta diez
    segundos por lote sin tener ninguna ocupada.
    """
    if not tokens:
        # Nadie ha registrado un dispositivo todavía; no es un error.
        return

    messages = [
        {
            "to": token,
            "title": title,
            "body": body,
            # "default" = el sonido de notificación del propio teléfono.
            "sound": "default",
            "channelId": canal_android(channel),
            # Sin esto Android puede retener el aviso hasta que el teléfono
            # despierte por otra cosa: con el aparato en reposo, un mensaje
            # llegaba minutos tarde o al desbloquear.
            "priority": "high",
            "data": data or {},
        }
        for token in tokens
    ]

    muertos: list[str] = []
    for start in range(0, len(messages), BATCH_SIZE):
        batch = messages[start : start + BATCH_SIZE]
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.post(EXPO_PUSH_URL, json=batch)
                response.raise_for_status()
                muertos.extend(tokens_muertos(batch, _cuerpo(response)))
        except Exception:  # noqa: BLE001
            logger.warning("[push] fallo al enviar un lote", exc_info=True)

    await olvidar_tokens(muertos)


def _cuerpo(respuesta) -> object:
    """El JSON de la respuesta de Expo, o `None` si no se entiende."""
    try:
        return respuesta.json()
    except Exception:  # noqa: BLE001 - un cuerpo raro no es motivo para fallar
        return None


def tokens_muertos(lote: list[dict], cuerpo: object) -> list[str]:
    """Los tokens de un lote que Expo dice que ya no existen.

    Expo contesta 200 y mete dentro un resultado POR MENSAJE, en el mismo orden
    en que se mandaron. Una aplicación desinstalada, o un token caducado, llega
    como `{"status": "error", "details": {"error": "DeviceNotRegistered"}}`.

    Antes no se miraba: el token se quedaba en la tabla para siempre y cada
    aviso volvía a mandarse a un teléfono que ya no estaba. No hace daño a
    nadie, pero Expo penaliza a quien insiste, y la tabla solo crecía.

    SOLO `DeviceNotRegistered`. Otros errores —límite de mensajes, credenciales
    del proyecto— no dicen nada del token y borrarlo dejaría sin avisos a
    alguien que sí tiene la aplicación.

    Función pura, para poder probarla sin red.
    """
    if not isinstance(cuerpo, dict):
        return []
    recibos = cuerpo.get("data")
    if not isinstance(recibos, list) or len(recibos) != len(lote):
        # Sin correspondencia uno a uno no se sabe de quién es cada resultado.
        return []
    muertos: list[str] = []
    for mensaje, recibo in zip(lote, recibos, strict=True):
        if not isinstance(recibo, dict) or recibo.get("status") != "error":
            continue
        detalles = recibo.get("details")
        if isinstance(detalles, dict) and detalles.get("error") == "DeviceNotRegistered":
            token = mensaje.get("to")
            if isinstance(token, str):
                muertos.append(token)
    return muertos


async def olvidar_tokens(tokens: list[str]) -> None:
    """Borra los tokens que ya no existen. NUNCA LANZA.

    Con sesión PROPIA: quien llama puede estar usando la de una petición, y
    hacer `commit` sobre ella desde aquí cerraría una transacción que no es
    nuestra.
    """
    if not tokens:
        return
    try:
        async with SessionLocal() as db:
            await db.execute(delete(DeviceToken).where(DeviceToken.token.in_(tokens)))
            await db.commit()
        # Cuántos, nunca cuáles: un token es una credencial de envío.
        logger.info("[push] %s token(s) dados de baja por Expo", len(tokens))
    except Exception:  # noqa: BLE001
        logger.warning("[push] no se pudieron borrar los tokens caducados", exc_info=True)


async def _enviar_con_sesion_propia(
    user_ids: list[str],
    notification_type: str,
    actor_name: str | None,
    data: dict | None,
) -> None:
    """El envío real, ya fuera de la petición y con su propia sesión.

    LA CONEXIÓN SE SUELTA ANTES DE HABLAR CON EXPO. Antes se leían los tokens y
    se hacía el POST —con hasta diez segundos de espera— dentro del mismo
    `async with`: la transacción seguía abierta y la conexión ocupada todo ese
    tiempo. El pool son cinco conexiones más cinco de reserva
    (`shared/database.py`); con Expo lento y diez avisos a la vez se agotaba y
    se paraba la API entera, que es justo lo que `encolar_push` existe para
    evitar. Desde que cada mensaje de chat manda un aviso, eso dejó de ser un
    caso raro.

    Ahora la sesión vive lo que tarda UNA consulta. El envío va después, sin
    ninguna conexión cogida.
    """
    if not user_ids:
        return
    message = build_message(notification_type, actor_name)
    if message is None:
        return
    title, body = message

    async with SessionLocal() as db:
        tokens = await _leer_tokens(db, user_ids)

    await _enviar_a(
        tokens,
        title=title,
        body=body,
        channel=CHANNELS.get(notification_type, "interacciones"),
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


class EnvioRechazado(Exception):
    """Expo aceptó la petición y rechazó el mensaje. Es un fallo de envío."""


async def enviar_de_la_cola(
    db: AsyncSession, *, usuario_id: str, tipo: str, locale: str
) -> bool:
    """Envía un aviso de la cola, con el texto en el idioma que se guardó.

    LANZA SI NO SE PUDO. Quien llama es `entregas.procesar`, que traduce la
    excepción en un reintento: tragársela aquí marcaría como enviada una
    notificación que no salió.

    DEVUELVE `False` CUANDO NO HABÍA A DÓNDE MANDARLA —sin texto para ese tipo,
    sin ningún aparato registrado—. No es un fallo y no se reintenta, pero
    tampoco es un envío: contarlo como tal hacía que el panel de operación
    dijera «enviadas» de avisos que nunca salieron de aquí.
    """
    from app.modules.notifications import textos

    par = textos.texto(tipo, locale=locale)
    if par is None:
        # Un tipo sin texto no es un fallo de envío: no hay nada que mandar.
        return False
    titulo, cuerpo = par

    tokens = list(
        await db.scalars(
            select(DeviceToken.token).where(DeviceToken.user_id == usuario_id)
        )
    )
    if not tokens:
        # Sin aparato registrado no hay push. Tampoco es un fallo: el aviso
        # in-app ya está, y reintentar no va a hacer aparecer un teléfono.
        return False

    mensajes = [
        {
            "to": token,
            "title": titulo,
            "body": cuerpo,
            "sound": "default",
            "channelId": canal_android(textos.CANALES.get(tipo, "contenido")),
            "priority": "high",
        }
        for token in tokens
    ]
    # NO SE USA EL ENVIO DE SIEMPRE: aquel se traga el error a proposito —es
    # «mejor esfuerzo»— y aqui hace falta lo contrario. Si esto no lanza, la
    # entrega se marca enviada sin haber salido.
    for inicio in range(0, len(mensajes), BATCH_SIZE):
        async with httpx.AsyncClient(timeout=10) as cliente:
            respuesta = await cliente.post(
                EXPO_PUSH_URL, json=mensajes[inicio : inicio + BATCH_SIZE]
            )
            respuesta.raise_for_status()
            _exigir_recibos(respuesta)
    return True


def _exigir_recibos(respuesta) -> None:
    """Mira el CUERPO, no solo el código HTTP.

    Expo contesta 200 y mete el resultado de cada mensaje dentro: un token que
    ya no existe llega como `{"status": "error"}` en un 200. Mirar solo
    `raise_for_status()` marcaba como enviada una entrega que Expo rechazó.

    Un cuerpo que no se entiende NO se trata como fallo: la petición salió y el
    formato de la respuesta no es algo que deba reintentarse en bucle.
    """
    try:
        cuerpo = respuesta.json()
    except Exception:  # noqa: BLE001
        return
    if not isinstance(cuerpo, dict):
        return
    recibos = cuerpo.get("data")
    if not isinstance(recibos, list):
        return
    fallos = [
        str(r.get("message") or r.get("details") or "rechazado")
        for r in recibos
        if isinstance(r, dict) and r.get("status") == "error"
    ]
    # SI ALGUNO SALIÓ, LA ENTREGA SALIÓ. Un móvil viejo desinstalado hacía
    # fallar el lote entero, y el reintento repetía el aviso en los aparatos
    # que sí lo habían recibido: hasta cinco veces, por las cinco esperas.
    # Reintentar no va a resucitar un token que ya no existe.
    if fallos and len(fallos) < len(recibos):
        logger.warning(
            "[push] %s de %s destinos rechazados: %s",
            len(fallos),
            len(recibos),
            fallos[0][:200],
        )
        return
    if fallos:
        # SIN EL TOKEN NI EL CUERPO ENTERO: solo cuántos y el primer motivo.
        raise EnvioRechazado(f"{len(fallos)} de {len(recibos)}: {fallos[0]}"[:400])
