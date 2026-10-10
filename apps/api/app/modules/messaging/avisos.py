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

LO QUE NO VIAJA. Ni el texto del mensaje ni el nombre de un adjunto. El aviso
dice QUIÉN escribe y nada más: un push se lee en la pantalla bloqueada, delante
de quien esté al lado. El contenido se lee dentro, con la sesión abierta.

LOS BLOQUEOS CUENTAN. Bloquear a alguien no borra la conversación que ya
existía, así que esa persona puede seguir escribiendo en ella. Lo que no puede
es hacer sonar el teléfono de quien la bloqueó: sin esto, el push sería la
puerta trasera para seguir llegando a alguien que dijo que no. Se corta en los
dos sentidos, igual que el resto del contenido.
"""

from __future__ import annotations

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.messaging.models import Conversation, ConversationMember
from app.modules.profiles.models import Profile
from app.modules.social_graph.models import UserBlock

#: El tipo del aviso. Tiene su texto y su canal en `notifications/push.py`.
TIPO = "message"

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

    Todos menos quien escribe —nadie se avisa a sí mismo— y menos aquellos con
    los que haya un bloqueo, en cualquiera de los dos sentidos.
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
    return [miembro for miembro in miembros if miembro not in fuera]


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
