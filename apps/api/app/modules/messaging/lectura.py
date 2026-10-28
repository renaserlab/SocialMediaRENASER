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

from collections import Counter

from sqlalchemy import DateTime, Uuid, and_, column, func, or_, select, table
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.content.schemas import AuthorSummary
from app.modules.messaging import ajustes_de_grupo, esquema, preferencias
from app.modules.messaging.etiquetas import etiquetas_por_conversacion
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
    "video": "Video",
    "document": "Archivo",
}

#: Las tres columnas de `conversation_topics` (0108) que necesita la bandeja
#: agrupada, por su NOMBRE DEL CONTRATO (`docs/CONTRATOS_TEMAS_Y_COMUNIDADES.md`
#: § 2) y no por el modelo de `temas.py`: la tabla es del modulo de temas y lo
#: unico fijo entre los dos es el contrato. Con su TIPO, que no es adorno: en
#: SQLite un UUID se guarda sin guiones y sin el tipo la comparacion fallaria
#: en silencio.
_TEMAS = table(
    "conversation_topics",
    column("conversation_id", Uuid(as_uuid=False)),
    column("chat_id", Uuid(as_uuid=False)),
    column("deleted_at", DateTime(timezone=True)),
)


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


async def miembros_por_grupo(db: AsyncSession, group_ids: list[str]) -> dict[str, int]:
    """Cuántas personas hay en cada grupo de la página, en UNA consulta.

    Un `GROUP BY` sobre la clave primaria de `conversation_members`
    (`conversation_id`, `user_id`): se cuenta sobre el índice, sin leer
    perfiles. Lo usa la bandeja del teléfono para decidir si atiende «está
    escribiendo» en la fila de un grupo (ver `ConversationRead.members_count`).

    Sin grupos en la página no se consulta nada: la trampa de `in_([])` de
    siempre, y además lo normal en una bandeja de chats de dos.
    """
    if not group_ids:
        return {}
    filas = (
        await db.execute(
            select(ConversationMember.conversation_id, func.count())
            .where(ConversationMember.conversation_id.in_(group_ids))
            .group_by(ConversationMember.conversation_id)
        )
    ).all()
    return {str(conversacion): int(total or 0) for conversacion, total in filas}


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


async def temas_de_la_pagina(
    db: AsyncSession, group_ids: list[str], uid: str
) -> tuple[dict[str, int], dict[str, int]]:
    """Cuantos temas tiene cada grupo y cuanto hay sin leer en ellos. DOS consultas.

    POR LOTES Y NO CON `temas.no_leidos_de_temas`, que es de UN grupo: llamarla
    por fila seria el N+1 que este fichero existe para impedir. La primera
    consulta trae los chats de los temas vivos de todos los grupos de la
    pagina; la segunda, los no leidos de todos esos chats a la vez.

    QUE CUENTA COMO NO LEIDO: lo escrito en el chat de un tema por OTRA persona
    despues de su `last_read_at` en ese chat. Si nunca lo abrio, lo escrito
    desde que entro (`joined_at`): quien llega nuevo al grupo empieza en cero,
    que es el criterio de `unseen` en el contrato (§ 4.1). `>=` con `joined_at`
    porque en SQLite la marca tiene resolucion de segundo y lo escrito justo al
    crear el tema se perderia. El `cleared_at` de General no se aplica (D3).
    Es la MISMA regla que `temas.no_leidos_de_temas`: si divergieran, el numero
    del grupo en la bandeja y el de sus temas dentro no cuadrarian.

    Sin la 0108, o sin grupos en la pagina, no se consulta nada.
    """
    if not group_ids or not await esquema.hay_temas(db):
        return {}, {}
    filas = (
        await db.execute(
            select(_TEMAS.c.conversation_id, _TEMAS.c.chat_id).where(
                _TEMAS.c.conversation_id.in_(group_ids),
                _TEMAS.c.deleted_at.is_(None),
            )
        )
    ).all()
    grupo_del_chat = {str(chat): str(grupo) for grupo, chat in filas}
    cuantos = dict(Counter(grupo_del_chat.values()))
    if not grupo_del_chat:
        return cuantos, {}

    pendientes = (
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
                Message.conversation_id.in_(list(grupo_del_chat)),
                Message.sender_id != uid,
                Message.deleted_at.is_(None),
                or_(
                    and_(
                        ConversationMember.last_read_at.is_(None),
                        Message.created_at >= ConversationMember.joined_at,
                    ),
                    Message.created_at > ConversationMember.last_read_at,
                ),
            )
            .group_by(Message.conversation_id)
        )
    ).all()
    no_leidos_por_grupo: dict[str, int] = {}
    for chat, total in pendientes:
        grupo = grupo_del_chat.get(str(chat))
        if grupo is not None:
            no_leidos_por_grupo[grupo] = no_leidos_por_grupo.get(grupo, 0) + int(total or 0)
    return cuantos, no_leidos_por_grupo


async def leer_conversaciones(
    db: AsyncSession, filas, uid: str, *, agrupado: bool = False
) -> list[ConversationRead]:
    """Convierte las filas de conversacion en respuesta. Consultas CONSTANTES.

    `filas` son tuplas con `id`, `kind`, `title` y `updated_at` —lo que ya se
    trajo al listar—, de modo que esta funcion no vuelve a pedir la conversacion
    en si. Sirve igual para una sola (abrir un chat directo) que para la pagina
    entera, y en los dos casos gasta el mismo numero de consultas.

    LAS ETIQUETAS DEL CRM SON UNA CONSULTA MAS, NO UNA POR FILA. Se piden con un
    `IN` sobre los identificadores de la pagina, exactamente igual que los
    perfiles y los no leidos, asi que el coste sigue sin crecer con la lista:
    cinco consultas con tres conversaciones y cinco con ochenta. Resolverlas por
    fila serian veinticuatro con veinte filas, que es el N+1 que este fichero
    existe para impedir. Sin la 0045 son cuatro: `etiquetas_por_conversacion`
    devuelve `{}` sin tocar la base.

    TEMAS Y COMUNIDADES, TAMBIEN POR LOTES. Si en la pagina hay grupos, una
    consulta dice cuales son comunidades (`parent_id`). Con `agrupado` —la
    bandeja de la aplicacion nueva, donde las comunidades viven dentro de su
    grupo (D12)— se añaden como mucho cuatro mas, sean dos grupos o veinte:
    las comunidades de esos grupos y sus no leidos, y sus temas y los suyos.
    Sin grupos en la pagina, ninguna: lo normal en una bandeja de chats de dos.
    """
    if not filas:
        return []

    ids = [fila.id for fila in filas]
    otros = await otros_participantes(db, ids, uid)
    ultimos = await ultimos_mensajes(db, ids)
    pendientes = await no_leidos(db, ids, uid)
    # `uid` y no «los miembros»: lo que decide que la etiqueta de Ana no la vea
    # Bruno es este dueño. Ver `etiquetas_por_conversacion`.
    etiquetas = await etiquetas_por_conversacion(db, uid=uid, conversation_ids=ids)

    # Los ultimos mensajes que no llevan texto: solo de esos hay que averiguar
    # que archivo son. Si no hay ninguno —el caso normal— no se consulta nada.
    sin_texto = [
        ultimo.id for ultimo in ultimos.values() if not (ultimo.body or "").strip()
    ]
    resumenes = await _resumen_de_los_sin_texto(db, sin_texto)

    # La foto de los GRUPOS de la pagina, con un `IN` como todo lo demas. Si
    # en la pagina no hay ningun grupo —lo normal— no se consulta nada.
    fotos = await ajustes_de_grupo.avatares_de(
        db, [fila.id for fila in filas if fila.kind == "group"]
    )

    # Lo que quien pregunta decidio PARA SI: cuales tiene silenciadas y desde
    # cuando quiere ver cada una. Una consulta con un `IN`, como lo demas.
    propias = await preferencias.de_la_pagina(db, uid, ids)

    # La jerarquia de los grupos de la pagina. `subgrupos.py` se importa aqui
    # dentro porque importa este fichero.
    from app.modules.messaging import subgrupos

    de_grupo = [str(fila.id) for fila in filas if fila.kind == "group"]
    comunidades = await subgrupos.de_la_pagina(db, de_grupo, uid, agrupado=agrupado)
    # El tamaño de cada grupo: el teléfono decide con él si atiende «está
    # escribiendo» en su fila sin pedir la ficha del grupo. Ver el esquema.
    tamanos = await miembros_por_grupo(db, de_grupo)
    temas_por_grupo, no_leidos_de_temas = (
        await temas_de_la_pagina(db, de_grupo, uid) if agrupado else ({}, {})
    )

    salida: list[ConversationRead] = []
    for fila in filas:
        propia = propias.get(str(fila.id), preferencias.SIN_PREFERENCIA)
        ultimo = ultimos.get(fila.id)
        # Si vacio el chat y no ha llegado nada despues, para ELLA no hay
        # ultimo mensaje: la fila no puede seguir enseñando lo que vacio.
        if (
            ultimo is not None
            and propia.cleared_at is not None
            and ultimo.created_at <= propia.cleared_at
        ):
            ultimo = None
        if ultimo is None:
            resumen = None
        elif (ultimo.body or "").strip():
            resumen = ultimo.body
        else:
            # Un mensaje sin texto y sin adjunto legible no deberia existir,
            # pero si aparece se dice «Archivo» y no una cadena vacia, que la
            # pantalla pintaria como «Sin mensajes aun»: una mentira.
            resumen = resumenes.get(ultimo.id, "Archivo")
        sin_leer = pendientes.get(fila.id, 0)
        clave = str(fila.id)
        salida.append(
            ConversationRead(
                id=fila.id,
                kind=fila.kind,
                title=fila.title,
                # Solo los chats directos tienen «el otro»; en un grupo el
                # nombre lo pone el titulo.
                other=otros.get(fila.id) if fila.kind == "direct" else None,
                avatar_path=fotos.get(fila.id),
                last_message=resumen,
                last_message_at=ultimo.created_at if ultimo is not None else None,
                unread_count=sin_leer,
                muted=propia.muted,
                updated_at=fila.updated_at,
                labels=etiquetas.get(fila.id, []),
                parent_id=comunidades.padres.get(clave),
                topics_count=temas_por_grupo.get(clave, 0),
                subgroups_count=comunidades.cuantas.get(clave, 0),
                # Sin `agrupado` los dos diccionarios vienen vacios y el total
                # es exactamente `unread_count`.
                total_unread=(
                    sin_leer
                    + comunidades.no_leidas.get(clave, 0)
                    + no_leidos_de_temas.get(clave, 0)
                ),
                members_count=tamanos.get(clave) if fila.kind == "group" else None,
            )
        )
    return salida
