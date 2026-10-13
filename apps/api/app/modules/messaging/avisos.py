"""A quién se avisa de que ha llegado un mensaje, y con qué.

EL HUECO QUE HABÍA. Mandar un mensaje guardaba el mensaje y nada más: quien lo
recibía no se enteraba hasta abrir la aplicación y entrar en Mensajes. El canal
`mensajes` existía en el teléfono desde el principio y ningún aviso del
servidor lo usaba. Se reportó tal cual: «cuando se envía un mensaje a un
usuario… no aparecen las notificaciones».

QUÉ SE HACE. Al guardarse un mensaje se programa un push para los demás
miembros de la conversación. NO se escribe una fila en la bandeja de
notificaciones: un mensaje ya tiene su sitio —la pestaña Mensajes, con su
contador de no leídos— y repetirlo en la bandeja daría dos avisos del mismo
hecho, además de llenarla con una fila por mensaje.

LO QUE DICE EL AVISO (cambió el 13/10/2026). Hasta entonces no llevaba el
texto del mensaje —«Ana te envió un mensaje» y nada más—, porque un push se lee
en la pantalla bloqueada. Visto en teléfono, eso era una casilla por cada
mensaje, todas iguales, sin saber qué se había escrito. Se decidió hacerlo como
WhatsApp:

  · UNA CASILLA POR CONVERSACIÓN. Cada aviso lleva una etiqueta que es la de
    su conversación (`etiqueta_de`), y el teléfono reemplaza con ella el aviso
    anterior del mismo chat en vez de sumar otro. Otra persona, otra casilla.
  · CON LO QUE ESA PERSONA TIENE SIN LEER EN ESE CHAT, de lo más antiguo a lo
    más nuevo, un mensaje por línea. Al desplegar la casilla se leen todos.
    En un grupo cada línea dice quién la escribió.

Es a propósito que el texto viaje: quien no quiera que se lea con el teléfono
bloqueado lo oculta en los ajustes de notificaciones de Android, que es donde
se decide eso para cualquier aplicación. El nombre de un archivo adjunto sigue
sin viajar: una foto es «Foto».

LOS BLOQUEOS CUENTAN. Bloquear a alguien no borra la conversación que ya
existía, así que esa persona puede seguir escribiendo en ella. Lo que no puede
es hacer sonar el teléfono de quien la bloqueó: sin esto, el push sería la
puerta trasera para seguir llegando a alguien que dijo que no. Se corta en los
dos sentidos, igual que el resto del contenido.
"""

from __future__ import annotations

import logging
from datetime import datetime

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.messaging import esquema, preferencias
from app.modules.messaging.models import (
    Conversation,
    ConversationMember,
    Message,
    MessageAttachment,
)
from app.modules.profiles.models import Profile
from app.modules.social_graph.models import UserBlock

logger = logging.getLogger(__name__)

#: El tipo del aviso. Tiene su texto y su canal en `notifications/push.py`.
TIPO = "message"

#: Cuántos mensajes sin leer se enseñan en un aviso, y cuánto de cada uno.
#: Android enseña la primera línea con la casilla plegada y todas al
#: desplegarla; más de seis ya no caben en ningún teléfono.
MENSAJES_EN_EL_AVISO = 6
LARGO_DE_UN_MENSAJE = 160

#: Hasta dónde se mira hacia atrás en la conversación para armarlo. Quien tiene
#: más que esto sin leer no necesita que el aviso se lo cuente uno por uno.
MENSAJES_QUE_SE_MIRAN = 40

#: Cómo se dice un mensaje que no lleva texto. Nunca el nombre del archivo.
_SIN_TEXTO = {
    "image": "📷 Foto",
    "video": "🎥 Video",
    "audio": "🎤 Nota de voz",
    "document": "📎 Archivo",
}

#: El texto del aviso cuando el mensaje va a un GRUPO: «Ana envió un mensaje
#: al grupo «Aula»». Es solo el TEXTO: en los datos del aviso el tipo sigue
#: siendo `message`, porque lleva al mismo sitio —la conversación— y la
#: aplicación decide el destino por ese campo (`rutaDelPush.ts`).
TIPO_EN_GRUPO = "message_group"

#: «Ana te añadió al grupo «Aula»».
TIPO_AL_ANADIR = "group_added"

#: «Ana quiere unirse a tu grupo «Aula»». Le llega a quien lo administra.
TIPO_AL_PEDIR_ENTRAR = "group_join_request"

#: A donde lleva ese aviso al tocarlo: a la ficha del grupo, que es donde se
#: responde. Es un destino propio y no `message`, porque `message` abre el
#: chat y ahi no hay nada que decidir.
DESTINO_DE_SOLICITUD = "group_join"


async def grupo_de(db: AsyncSession, conversation_id: str) -> str | None:
    """El nombre del grupo, o `None` si la conversación es de dos personas.

    Un grupo sin título —no debería haberlos: crear uno lo exige— devuelve
    la cadena vacía, que sigue siendo «es un grupo»; la plantilla pone
    entonces «un grupo». Lo que no puede pasar es avisar «te envió un
    mensaje» de algo que se mandó a veinte personas.
    """
    fila = (
        await db.execute(
            select(Conversation.kind, Conversation.title).where(
                Conversation.id == conversation_id
            )
        )
    ).one_or_none()
    if fila is None or fila.kind != "group":
        return None
    return (fila.title or "").strip()


async def destinatarios(
    db: AsyncSession, *, conversation_id: str, remitente_id: str
) -> list[str]:
    """Los miembros de la conversación a los que hay que avisar.

    Todos menos quien escribe —nadie se avisa a sí mismo—, menos aquellos con
    los que haya un bloqueo, en cualquiera de los dos sentidos, y menos quien
    tenga la conversación SILENCIADA: el mensaje le llega igual y le cuenta
    como no leído; lo que no le llega es el aviso.
    """
    miembros = list(
        await db.scalars(
            select(ConversationMember.user_id).where(
                ConversationMember.conversation_id == conversation_id,
                ConversationMember.user_id != remitente_id,
            )
        )
    )
    if not miembros:
        return []

    bloqueos = (
        await db.execute(
            select(UserBlock.blocker_id, UserBlock.blocked_id).where(
                or_(
                    (UserBlock.blocker_id == remitente_id)
                    & (UserBlock.blocked_id.in_(miembros)),
                    (UserBlock.blocked_id == remitente_id)
                    & (UserBlock.blocker_id.in_(miembros)),
                )
            )
        )
    ).all()
    fuera = {
        (bloqueado if bloqueador == remitente_id else bloqueador)
        for bloqueador, bloqueado in bloqueos
    }
    avisables = [miembro for miembro in miembros if miembro not in fuera]
    en_silencio = await preferencias.quienes_silencian(db, conversation_id, avisables)
    return [miembro for miembro in avisables if miembro not in en_silencio]


def nombre_para_el_aviso(perfil: Profile | None) -> str | None:
    """Cómo se nombra a quien escribe. `None` deja el «Alguien» de la plantilla."""
    if perfil is None:
        return None
    return (perfil.full_name or "").strip() or perfil.username or None


def datos_del_aviso(conversation_id: str, message_id: str) -> dict[str, str]:
    """Lo que viaja en el push para poder abrir la conversación.

    Un tipo y dos identificadores, nada más. La aplicación decide a qué
    pantalla lleva con un mapa cerrado de destinos; aquí no viaja ninguna ruta
    ni ninguna dirección que el teléfono tenga que creerse.

    EL IDENTIFICADOR DEL MENSAJE es para no avisar dos veces. Con la
    aplicación abierta, el mismo mensaje llega por dos caminos —en tiempo real
    y por push— y sin algo que diga «son el mismo» salían dos avisos. No dice
    nada del contenido: es un UUID.
    """
    return {"type": TIPO, "conversationId": conversation_id, "messageId": message_id}


def etiqueta_de(conversation_id: str) -> str:
    """La etiqueta del aviso: una por conversación.

    Con ella el teléfono REEMPLAZA el aviso que ya enseñaba de ese chat en vez
    de añadir otra casilla. Es el campo `tag` de Expo, solo para Android.
    """
    return f"chat-{conversation_id}"


def en_una_linea(texto: str | None, largo: int = LARGO_DE_UN_MENSAJE) -> str:
    """El texto de un mensaje, en una sola línea y sin pasarse de largo."""
    plano = " ".join((texto or "").split())
    if len(plano) <= largo:
        return plano
    return plano[: largo - 1].rstrip() + "…"


def nombre_de_pila(nombre: str | None) -> str:
    """«Ana», de «Ana Pérez Soto»: delante de cada línea no cabe más."""
    partes = (nombre or "").split()
    return partes[0] if partes else ""


def componer(
    sin_leer: list[tuple[str | None, str]],
    *,
    grupo: str | None,
    remitente: str | None,
) -> tuple[str, str] | None:
    """Título y cuerpo del aviso a partir de lo que una persona tiene sin leer.

    `sin_leer` son pares (quién lo escribió, qué dice), de lo más antiguo a lo
    más nuevo. Sin nada que decir devuelve `None` y el aviso sale con el texto
    de siempre.

    EL TÍTULO ES DE QUIÉN: la persona en un chat de dos, el grupo en un grupo;
    y cuántos, si es más de uno. EL CUERPO ES QUÉ: un mensaje por línea, los
    últimos, y delante cuántos se quedan fuera.
    """
    if not sin_leer:
        return None
    cuantos = len(sin_leer)
    a_la_vista = sin_leer[-MENSAJES_EN_EL_AVISO:]
    if grupo is not None:
        nombre = grupo.strip() or "Grupo"
        lineas = [f"{nombre_de_pila(autor) or 'Alguien'}: {texto}" for autor, texto in a_la_vista]
    else:
        nombre = (remitente or "").strip() or "Nuevo mensaje"
        lineas = [texto for _, texto in a_la_vista]
    fuera = cuantos - len(a_la_vista)
    if fuera > 0:
        lineas.insert(0, f"… y {fuera} {'anterior' if fuera == 1 else 'anteriores'}")
    titulo = nombre if cuantos == 1 else f"{nombre} ({cuantos} mensajes)"
    return titulo, "\n".join(lineas)


def _sin_leer(marca: datetime | None, enviado: datetime) -> bool:
    """Si quien tiene esa marca de lectura todavía no pasó por ese mensaje.

    Se compara sin zona porque SQLite, en las pruebas, devuelve las fechas sin
    ella; las dos salen del reloj de la base.
    """
    if marca is None:
        return True
    return marca.replace(tzinfo=None) < enviado.replace(tzinfo=None)


async def _de_los_sin_texto(db: AsyncSession, message_ids: list[str]) -> dict[str, str]:
    """Cómo se dice cada mensaje que solo lleva archivos: por su primer adjunto."""
    if not message_ids or not await esquema.hay_adjuntos_de_chat(db):
        return {}
    filas = (
        await db.execute(
            select(MessageAttachment.message_id, MessageAttachment.kind)
            .where(MessageAttachment.message_id.in_(message_ids))
            .order_by(MessageAttachment.sort_order.asc(), MessageAttachment.id.asc())
        )
    ).all()
    salida: dict[str, str] = {}
    for message_id, kind in filas:
        salida.setdefault(str(message_id), _SIN_TEXTO.get(kind, _SIN_TEXTO["document"]))
    return salida


async def textos_para(
    db: AsyncSession,
    *,
    conversation_id: str,
    destinatarios: list[str],
    grupo: str | None,
    remitente: str | None,
) -> dict[str, tuple[str, str]]:
    """El título y el cuerpo del aviso PARA CADA destinatario.

    Cada quien tiene sin leer una cosa distinta —depende de hasta dónde leyó—,
    así que el aviso no puede ser el mismo para todos. Son tres consultas para
    toda la conversación, no tres por persona.

    NUNCA LANZA. Si algo falla devuelve lo que tenga —o nada— y el aviso sale
    con el texto de siempre: peor es no avisar.
    """
    if not destinatarios:
        return {}
    try:
        marcas = {
            str(persona): marca
            for persona, marca in (
                await db.execute(
                    select(ConversationMember.user_id, ConversationMember.last_read_at).where(
                        ConversationMember.conversation_id == conversation_id,
                        ConversationMember.user_id.in_(destinatarios),
                    )
                )
            ).all()
        }
        mensajes = list(
            (
                await db.execute(
                    select(Message.id, Message.sender_id, Message.body, Message.created_at)
                    .where(
                        Message.conversation_id == conversation_id,
                        Message.deleted_at.is_(None),
                    )
                    .order_by(Message.created_at.desc(), Message.id.desc())
                    .limit(MENSAJES_QUE_SE_MIRAN)
                )
            ).all()
        )
        mensajes.reverse()
        sin_texto = await _de_los_sin_texto(
            db, [str(m.id) for m in mensajes if not (m.body or "").strip()]
        )
        autores: dict[str, str] = {}
        if grupo is not None and mensajes:
            autores = {
                str(perfil_id): (nombre or "").strip() or (usuario or "").strip()
                for perfil_id, nombre, usuario in (
                    await db.execute(
                        select(Profile.id, Profile.full_name, Profile.username).where(
                            Profile.id.in_({m.sender_id for m in mensajes})
                        )
                    )
                ).all()
            }

        salida: dict[str, tuple[str, str]] = {}
        for persona in destinatarios:
            marca = marcas.get(str(persona))
            lo_suyo = [
                (
                    autores.get(str(m.sender_id)),
                    en_una_linea(m.body) or sin_texto.get(str(m.id), _SIN_TEXTO["document"]),
                )
                for m in mensajes
                if str(m.sender_id) != str(persona) and _sin_leer(marca, m.created_at)
            ]
            compuesto = componer(lo_suyo, grupo=grupo, remitente=remitente)
            if compuesto is not None:
                salida[str(persona)] = compuesto
        return salida
    except Exception:  # noqa: BLE001 - el aviso sale igual, con el texto de siempre
        logger.warning("[mensajes] no se pudo armar el texto del aviso", exc_info=True)
        return {}
