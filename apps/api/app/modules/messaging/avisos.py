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

from app.modules.messaging.models import ConversationMember
from app.modules.profiles.models import Profile
from app.modules.social_graph.models import UserBlock

#: El tipo del aviso. Tiene su texto y su canal en `notifications/push.py`.
TIPO = "message"


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
