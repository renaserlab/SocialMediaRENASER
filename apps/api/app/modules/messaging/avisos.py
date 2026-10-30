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

LOS TEMAS DE UN GRUPO (D14, 26/10/2026). Lo que la administración escribe en
un tema va al chat propio del tema, cuyos miembros son los del grupo: avisa a
todos ellos MENOS a quien tenga silenciado el GRUPO, además de a quien tenga
silenciado el propio chat. Quien silencia un grupo no sabe que sus temas son
otras conversaciones, ni tiene por qué saberlo: silenció el grupo entero.
"""

from __future__ import annotations

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.messaging import esquema, preferencias
from app.modules.messaging.models import Conversation, ConversationMember
from app.modules.profiles.models import Profile
from app.modules.social_graph.models import UserBlock

#: El tipo del aviso. Tiene su texto y su canal en `notifications/push.py`.
TIPO = "message"

#: El texto del aviso cuando el mensaje va a un chat de grupo: «Ana envió un
#: mensaje a la comunidad «Aula»» (o «al grupo «Valorant»» si es uno de dentro,
#: o «en el tema «Anuncios»»: ver `nivel_de`). Es solo el TEXTO: en los datos del aviso el tipo sigue
#: siendo `message`, porque lleva al mismo sitio —la conversación— y la
#: aplicación decide el destino por ese campo (`rutaDelPush.ts`).
TIPO_EN_GRUPO = "message_group"

#: «Ana te agregó a la comunidad «Aula»».
TIPO_AL_ANADIR = "group_added"

#: «Ana quiere unirse a tu comunidad «Aula»». Le llega a quien la administra.
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


async def nivel_de(db: AsyncSession, conversation_id: str) -> str:
    """Dónde pasa lo que se avisa: `comunidad`, `subgrupo` o `tema`.

    Para elegir la palabra del aviso (`push.TEMPLATES_POR_NIVEL`): desde el
    30/10/2026 la aplicación llama «comunidad» al chat padre y «grupo» a los
    de dentro, y el chat de un tema se nombra como tema («en el tema
    «Anuncios»»), no como si el tema fuera una comunidad. El aviso tiene que
    decir lo mismo que la pantalla que abre.

    UNA CONSULTA, con los dos `EXISTS` juntos; sin la 0108 ni la 0109,
    ninguna. Solo cuentan los vivos: un tema o un grupo eliminado se queda sin
    miembros, así que no hay a quién avisar.

    `temas.py` y `subgrupos.py` se importan aquí dentro porque, a través de
    `grupos.py`, importan este fichero.
    """
    preguntas = []
    if await esquema.hay_temas(db):
        from app.modules.messaging.temas import ConversationTopic

        preguntas.append(
            select(ConversationTopic.id)
            .where(
                ConversationTopic.chat_id == conversation_id,
                ConversationTopic.deleted_at.is_(None),
            )
            .exists()
            .label("tema")
        )
    if await esquema.hay_comunidades(db):
        from app.modules.messaging.subgrupos import GroupSubgroup

        preguntas.append(
            select(GroupSubgroup.conversation_id)
            .where(
                GroupSubgroup.conversation_id == conversation_id,
                GroupSubgroup.deleted_at.is_(None),
            )
            .exists()
            .label("subgrupo")
        )
    if not preguntas:
        return "comunidad"
    respuesta = (await db.execute(select(*preguntas))).one()._mapping
    if respuesta.get("tema"):
        return "tema"
    if respuesta.get("subgrupo"):
        return "subgrupo"
    return "comunidad"


async def destinatarios(
    db: AsyncSession, *, conversation_id: str, remitente_id: str
) -> list[str]:
    """Los miembros de la conversación a los que hay que avisar.

    Todos menos quien escribe —nadie se avisa a sí mismo—, menos aquellos con
    los que haya un bloqueo, en cualquiera de los dos sentidos, y menos quien
    tenga la conversación SILENCIADA: el mensaje le llega igual y le cuenta
    como no leído; lo que no le llega es el aviso.

    Si la conversación es el chat de un tema, también menos quien tenga
    silenciado el GRUPO del tema (D14, ver el docstring del módulo).
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
    grupo_del_tema = await _grupo_del_tema(db, conversation_id)
    if grupo_del_tema is not None:
        en_silencio |= await preferencias.quienes_silencian(db, grupo_del_tema, avisables)
    return [miembro for miembro in avisables if miembro not in en_silencio]


async def _grupo_del_tema(db: AsyncSession, conversation_id: str) -> str | None:
    """El grupo, si la conversación es el chat de un tema. Sin la 0108, `None`.

    `grupos.py` se importa aquí dentro porque importa este fichero.
    """
    from app.modules.messaging import grupos

    tema = await grupos.tema_del_chat(db, conversation_id)
    return str(tema[0]) if tema is not None else None


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
