"""Leer conversaciones sin pagar una consulta por conversacion.

EL PROBLEMA QUE RESUELVE ESTE FICHERO, con numeros.

`GET /conversations` construia cada fila por separado. Por CADA conversacion
lanzaba tres consultas: el perfil del otro participante, el ultimo mensaje y la
cuenta de no leidos. Mas la consulta inicial que traia la lista, eso es
`1 + 3N` viajes a la base de datos:

    5 conversaciones  ->  16 consultas
    20 conversaciones ->  61 consultas
    50 conversaciones -> 151 consultas

Y no habia paginacion: se traian TODAS las conversaciones de la persona, no las
que caben en una pantalla. Contra Supabase, con la base al otro lado de la red y
unos 20-30 ms por viaje, eso son varios SEGUNDOS de espera para pintar una lista
de diez filas. Ese era el motivo de que la pantalla de Mensajes tardara: no era
el volumen de datos —son cuatro nombres y cuatro frases— sino el NUMERO DE
IDAS Y VUELTAS.

COMO SE ARREGLA. Las mismas tres cosas se piden para TODAS las conversaciones de
la pagina a la vez: los perfiles con un `IN`, los ultimos mensajes con una
funcion de ventana (`row_number`) y los no leidos con un `GROUP BY`. El total
queda en cuatro consultas, y son cuatro tanto si hay tres conversaciones como si
hay ochenta. El coste deja de crecer con la lista.

POR QUE VIVE EN SU PROPIO FICHERO. Porque el router debe poder leerse como «que
hace este endpoint» y no como «como se evita el N+1». Y porque asi la regla se
puede probar sola: `tests/test_mensajes_rendimiento.py` cuenta las consultas
reales con un escucha de SQLAlchemy y falla si alguien vuelve a meter una
consulta dentro de un bucle.
"""

from __future__ import annotations

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.content.schemas import AuthorSummary
from app.modules.messaging import esquema
from app.modules.messaging.models import (
    ConversationMember,
    Message,
    MessageAttachment,
)
from app.modules.messaging.schemas import AttachmentRead, ConversationRead
from app.modules.profiles.models import Profile

#: Como se resume en la lista de conversaciones un mensaje que no lleva texto.
#: Sin esto, mandar una foto dejaba la fila diciendo «Sin mensajes aun», que es
#: falso: si hay mensaje, y quien lo recibio necesita saber que le ha llegado
#: algo. Texto plano y no un icono: el icono lo pone la pantalla, que es quien
#: sabe como se ve.
_RESUMEN_SIN_TEXTO = {
    "image": "Foto",
    "video": "Vídeo",
    "document": "Archivo",
}


async def otros_participantes(
    db: AsyncSession, conversation_ids: list[str], uid: str
) -> dict[str, AuthorSummary]:
    """El OTRO miembro de cada conversacion, en UNA consulta.

    Con la lista vacia NO se consulta. Es la trampa numero uno de este repo:
    `columna_uuid.in_([])` se suele «arreglar» con `or [""]`, y esa cadena vacia
    cuela en SQLite pero PostgreSQL la rechaza; el manejador de `DBAPIError` la
    convierte en un 404 silencioso. Sin conversaciones no hay a quien preguntar,
    asi que se devuelve el diccionario vacio y se acabo.
    """
    if not conversation_ids:
        return {}
    filas = (
        await db.execute(
            select(
                ConversationMember.conversation_id,
                Profile.id,
                Profile.full_name,
                Profile.username,
                Profile.avatar_path,
            )
            .join(Profile, Profile.id == ConversationMember.user_id)
            .where(
                ConversationMember.conversation_id.in_(conversation_ids),
                ConversationMember.user_id != uid,
            )
        )
    ).all()

    salida: dict[str, AuthorSummary] = {}
    for conv_id, pid, full_name, username, avatar_path in filas:
        # `setdefault`: en un grupo hay varios «otros» y aqui solo cabe uno,
        # igual que hacia el `LIMIT 1` de antes. Para chats directos —el unico
        # sitio donde se usa este campo— siempre hay exactamente uno.
        salida.setdefault(
            conv_id,
            AuthorSummary(
                id=pid,
                full_name=full_name,
                username=username,
                avatar_path=avatar_path,
            ),
        )
    return salida


async def ultimos_mensajes(
    db: AsyncSession, conversation_ids: list[str]
) -> dict[str, Message]:
    """El ultimo mensaje vivo de cada conversacion, en UNA consulta.

    Se numeran los mensajes por conversacion con `row_number()` y se queda con
    el primero de cada grupo. La alternativa —un `LIMIT 1` por conversacion— es
    justo el N+1 que este fichero existe para quitar.

    El desempate por `id` no es adorno: el `now()` de SQLite tiene resolucion de
    SEGUNDO, asi que varios mensajes escritos seguidos comparten marca de tiempo
    y sin un segundo criterio el «ultimo» seria el que quisiera el motor. En
    PostgreSQL cada insercion trae microsegundos y casi nunca empata, pero un
    orden que depende de eso no es un orden.

    Las funciones de ventana estan en SQLite desde la 3.25 (2018) y en
    PostgreSQL desde siempre: no hay motor donde esto no corra.
    """
    if not conversation_ids:
        return {}

    orden = (
        func.row_number()
        .over(
            partition_by=Message.conversation_id,
            order_by=(Message.created_at.desc(), Message.id.desc()),
        )
        .label("posicion")
    )
    numerados = (
        select(
            Message.id.label("id"),
            Message.conversation_id.label("conversation_id"),
            Message.sender_id.label("sender_id"),
            Message.body.label("body"),
            Message.created_at.label("created_at"),
            orden,
        )
        .where(
            Message.conversation_id.in_(conversation_ids),
            Message.deleted_at.is_(None),
        )
        .subquery()
    )
    filas = (
        await db.execute(
            select(
                numerados.c.id,
                numerados.c.conversation_id,
                numerados.c.sender_id,
                numerados.c.body,
                numerados.c.created_at,
            ).where(numerados.c.posicion == 1)
        )
    ).all()
    return {fila.conversation_id: fila for fila in filas}


async def no_leidos(
    db: AsyncSession, conversation_ids: list[str], uid: str
) -> dict[str, int]:
    """Cuantos mensajes sin leer hay en cada conversacion, en UNA consulta.

    El corte es distinto en cada conversacion —cada una tiene su propio
    `last_read_at`— asi que el umbral se trae con un JOIN contra la fila de
    miembro de ESTA persona, en lugar de resolverlo fuera y mandar una consulta
    por umbral.

    `last_read_at` a nulo significa «nunca ha abierto esta conversacion», y
    entonces cuenta todo lo que no haya escrito ella misma.
    """
    if not conversation_ids:
        return {}

    filas = (
        await db.execute(
            select(Message.conversation_id, func.count().label("total"))
            .join(
                ConversationMember,
                and_(
                    ConversationMember.conversation_id == Message.conversation_id,
                    ConversationMember.user_id == uid,
                ),
            )
            .where(
                Message.conversation_id.in_(conversation_ids),
                Message.sender_id != uid,
                Message.deleted_at.is_(None),
                or_(
                    ConversationMember.last_read_at.is_(None),
                    Message.created_at > ConversationMember.last_read_at,
                ),
            )
            .group_by(Message.conversation_id)
        )
    ).all()
    return {conv_id: int(total or 0) for conv_id, total in filas}


async def adjuntos_por_mensaje(
    db: AsyncSession, message_ids: list[str]
) -> dict[str, list[AttachmentRead]]:
    """Los adjuntos de VARIOS mensajes, en UNA consulta.

    Sin la migracion 0033 devuelve el diccionario vacio sin tocar la base: la
    tabla no existe todavia y preguntar por ella seria un 500 que el navegador
    ademas reportaria como error de CORS. Que no haya adjuntos no es un fallo,
    es el estado de hoy.

    Con la lista vacia tampoco se consulta, por la trampa de siempre:
    `columna_uuid.in_([])` acaba «arreglandose» con `or [""]` y esa cadena vacia
    cuela en SQLite pero PostgreSQL la rechaza, convirtiendose en un 404 mudo.
    """
    if not message_ids or not await esquema.hay_adjuntos_de_chat(db):
        return {}

    filas = (
        await db.execute(
            select(
                MessageAttachment.id,
                MessageAttachment.message_id,
                MessageAttachment.storage_path,
                MessageAttachment.kind,
                MessageAttachment.mime_type,
                MessageAttachment.file_name,
                MessageAttachment.bytes,
                MessageAttachment.width,
                MessageAttachment.height,
                MessageAttachment.duration_s,
            )
            .where(MessageAttachment.message_id.in_(message_ids))
            # El orden que eligio quien los mando; el id desempata para que dos
            # archivos con el mismo `sort_order` no bailen entre peticiones.
            .order_by(MessageAttachment.sort_order.asc(), MessageAttachment.id.asc())
        )
    ).all()

    salida: dict[str, list[AttachmentRead]] = {}
    for fila in filas:
        salida.setdefault(fila.message_id, []).append(
            AttachmentRead(
                id=fila.id,
                storage_path=fila.storage_path,
                kind=fila.kind,
                mime_type=fila.mime_type,
                file_name=fila.file_name,
                bytes=fila.bytes,
                width=fila.width,
                height=fila.height,
                duration_s=fila.duration_s,
            )
        )
    return salida


async def _resumen_de_los_sin_texto(
    db: AsyncSession, message_ids: list[str]
) -> dict[str, str]:
    """Que poner de resumen en los mensajes que solo llevan archivos.

    Solo se pregunta por los mensajes que de verdad no tienen texto, que son los
    pocos: en una lista normal esta consulta ni llega a lanzarse.
    """
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
        # El primero manda: un mensaje con tres fotos se resume como «Foto».
        salida.setdefault(message_id, _RESUMEN_SIN_TEXTO.get(kind, "Archivo"))
    return salida


async def leer_conversaciones(
    db: AsyncSession, filas, uid: str
) -> list[ConversationRead]:
    """Convierte las filas de conversacion en respuesta. Consultas CONSTANTES.

    `filas` son tuplas con `id`, `kind`, `title` y `updated_at` —lo que ya se
    trajo al listar—, de modo que esta funcion no vuelve a pedir la conversacion
    en si. Sirve igual para una sola (abrir un chat directo) que para la pagina
    entera, y en los dos casos gasta el mismo numero de consultas.
    """
    if not filas:
        return []

    ids = [fila.id for fila in filas]
    otros = await otros_participantes(db, ids, uid)
    ultimos = await ultimos_mensajes(db, ids)
    pendientes = await no_leidos(db, ids, uid)

    # Los ultimos mensajes que no llevan texto: solo de esos hay que averiguar
    # que archivo son. Si no hay ninguno —el caso normal— no se consulta nada.
    sin_texto = [
        ultimo.id for ultimo in ultimos.values() if not (ultimo.body or "").strip()
    ]
    resumenes = await _resumen_de_los_sin_texto(db, sin_texto)

    salida: list[ConversationRead] = []
    for fila in filas:
        ultimo = ultimos.get(fila.id)
        if ultimo is None:
            resumen = None
        elif (ultimo.body or "").strip():
            resumen = ultimo.body
        else:
            # Un mensaje sin texto y sin adjunto legible no deberia existir,
            # pero si aparece se dice «Archivo» y no una cadena vacia, que la
            # pantalla pintaria como «Sin mensajes aun»: una mentira.
            resumen = resumenes.get(ultimo.id, "Archivo")
        salida.append(
            ConversationRead(
                id=fila.id,
                kind=fila.kind,
                title=fila.title,
                # Solo los chats directos tienen «el otro»; en un grupo el
                # nombre lo pone el titulo.
                other=otros.get(fila.id) if fila.kind == "direct" else None,
                last_message=resumen,
                last_message_at=ultimo.created_at if ultimo is not None else None,
                unread_count=pendientes.get(fila.id, 0),
                updated_at=fila.updated_at,
            )
        )
    return salida
