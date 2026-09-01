"""Responder una historia desde el visor: el contexto que lleva el mensaje.

QUE PROBLEMA RESUELVE ESTE FICHERO. Alguien ve la historia de Bruno, escribe
desde el visor y le llega a Bruno como un mensaje normal de su chat directo. Lo
que hay que conservar es POR QUE ese mensaje dice lo que dice: leerlo tres dias
despues sin saber que respondia a una historia es leer media conversacion.

LO QUE NO SE HACE, Y ES LA DECISION CENTRAL. No se mete la URL de la historia
dentro del texto. Es lo facil y es lo que rompe cuatro cosas a la vez:

  - El cuerpo del mensaje deja de ser lo que la persona escribio.
  - No hay forma de distinguir una respuesta de verdad de alguien que pego un
    enlace a mano.
  - La bandeja no puede filtrar «Respuestas a historias» sin buscar cadenas
    dentro de los mensajes de todo el mundo, que es caro y ademas se equivoca.
  - En cuanto la historia caduca —o sea, al dia siguiente— queda un enlace
    muerto en mitad de la frase.

El contexto es ESTRUCTURA: una fila en `message_story_context`, por `message_id`
y sin ninguna columna nueva en `messages`.

LA CADUCIDAD NO ES UN CASO RARO, ES EL CASO. Una historia dura 24 horas; el
mensaje que la responde dura para siempre. Asi que casi todas las respuestas a
historias que existen en la base apuntan a una historia que ya no esta. Por eso
`story_id` es anulable con `on delete set null`, por eso `story_owner_id` se
guarda aparte —es lo unico que sigue diciendo de quien era— y por eso todo lo
que hay aqui trata el nulo como un estado normal y no como un error.

QUE PASA SIN LA MIGRACION 0044. El mensaje SE MANDA IGUAL, sin contexto. Se
degrada el adorno, nunca el contenido: perder el texto de alguien porque una
tabla todavia no esta seria mucho peor que perder la miniatura de la historia.

QUE NO HAY AQUI: ningun endpoint nuevo para enviar. La respuesta a una historia
viaja por `POST /conversations/{id}/messages`, el mismo camino que cualquier
otro mensaje, con `story_id` en el cuerpo. Duplicar el envio para este caso
significaria mantener dos rutas que tienen que hacer exactamente lo mismo con
los adjuntos, la validacion, el `updated_at` de la conversacion y Realtime, y
esas dos rutas divergen: una arregla un fallo y la otra no.

Y LA CONVERSACION TAMPOCO SE CREA AQUI. El movil pide `POST
/conversations/direct`, que ya es idempotente porque la clave primaria de
`direct_conversation_pairs` (0039) lo garantiza. Inventar un segundo camino de
obtener-o-crear seria reabrir el fallo que esa migracion cerro: dos
conversaciones con la misma persona.
"""

from __future__ import annotations

import logging

from sqlalchemy import insert, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.content.schemas import AuthorSummary
from app.modules.messaging import esquema
from app.modules.messaging.models import MessageStoryContext
from app.modules.messaging.schemas import StoryContextRead
from app.modules.profiles.models import Profile
from app.modules.stories.models import Story

logger = logging.getLogger("renaser.messaging")


def _autor(perfil_id: str, nombre: str, usuario: str | None, avatar: str | None):
    return AuthorSummary(
        id=perfil_id, full_name=nombre, username=usuario, avatar_path=avatar
    )


async def guardar_contexto(
    db: AsyncSession, message_id: str, story_id: str
) -> StoryContextRead | None:
    """Ata un mensaje ya insertado a la historia que respondia.

    DEVUELVE `None` —y no lanza— en los tres casos en que no se puede guardar,
    porque en los tres el mensaje ya esta escrito y quitarselo a quien lo mando
    seria el peor de los desenlaces posibles:

      1. La 0044 todavia no esta aplicada. No hay tabla donde guardarlo.
      2. La historia ya no existe. Entre abrir el visor y pulsar «enviar» pueden
         pasar minutos, y en ese hueco su autor ha podido borrarla o el barrido
         de caducadas llevarsela. El texto es de quien lo escribio; se manda.
      3. La fila ya estaba (reintento de una red lenta). Es idempotente: no se
         duplica ni se pisa, se lee la que hay.

    NO SE EXIGE QUE LA HISTORIA ESTE VIGENTE, solo que la fila exista. Una
    historia caducada pero aun no barrida sigue diciendo la verdad sobre a que
    se respondia, y registrarlo es mas fiel que descartarlo. La vigencia decide
    si la historia SE VE, no si el hecho ocurrio.

    `story_owner_id` SALE DE LA FILA, NUNCA DE LA PETICION —y por eso esta
    funcion no recibe quien escribe: no hay ningun dato del contexto que dependa
    de el—. Aceptarlo del cuerpo dejaria que cualquiera atribuyera su mensaje a
    la historia de otra persona, y ese dato es justo el que sobrevive cuando la
    historia desaparece: mentir ahi seria mentir para siempre.

    QUIEN PUEDE ESCRIBIR AQUI ya esta decidido antes de llegar: el router exige
    ser miembro de la conversacion, y el mensaje del que cuelga esto lo acaba de
    insertar la misma peticion con el remitente sacado del JWT.
    """
    if not await esquema.hay_respuestas_a_historias(db):
        return None

    fila = (
        await db.execute(
            select(
                Story.id,
                Story.author_id,
                Story.storage_path,
                Story.media_type,
                Story.caption,
                Profile.full_name,
                Profile.username,
                Profile.avatar_path,
            )
            .join(Profile, Profile.id == Story.author_id)
            .where(Story.id == story_id)
        )
    ).one_or_none()
    if fila is None:
        # La historia se borro o caduco y ya la barrieron. El mensaje se queda
        # sin contexto, pero se queda.
        return None

    (
        sid,
        autor_id,
        ruta,
        tipo,
        pie,
        nombre,
        usuario,
        avatar,
    ) = fila

    # EL SAVEPOINT NO ES ADORNO, y es la parte menos obvia de esta funcion.
    #
    # Entre el `select` de arriba y este `insert` hay una ventana —estrecha,
    # pero real— en la que el autor puede borrar su historia. Si eso ocurre, la
    # clave ajena de `story_id` salta con un `IntegrityError`. Y en PostgreSQL
    # una sentencia fallida deja la transaccion ENTERA inservible: sin aislar
    # esto, el error se llevaria por delante el mensaje que ya estaba insertado
    # —el `commit` de `send_message` moriria con `PendingRollbackError`— y quien
    # escribio se quedaria sin su texto por una historia que alguien borro medio
    # segundo antes.
    #
    # `begin_nested()` emite un SAVEPOINT: si el insert falla, se deshace SOLO
    # el insert y la transaccion de fuera sigue viva con el mensaje dentro. Es
    # la misma leccion que dejo escrita `_crear_directa` en `router.py` sobre el
    # flush antes de `registrar_senal`, aprendida alli a base de un fallo real.
    try:
        async with db.begin_nested():
            await db.execute(
                insert(MessageStoryContext).values(
                    message_id=message_id, story_id=sid, story_owner_id=autor_id
                )
            )
    except IntegrityError:
        # Dos causas posibles, y en las dos el mensaje se queda como esta:
        #  - La historia se borro en la ventana descrita arriba. No hay contexto
        #    que guardar; el mensaje se manda igual.
        #  - Ya habia contexto (reintento de una red lenta). La clave primaria es
        #    `message_id`, asi que un segundo contexto es imposible. No se pisa
        #    el que hay: a que historia respondia un mensaje es un hecho del
        #    pasado, no algo que se reescriba.
        logger.info(
            "No se pudo guardar el contexto de historia del mensaje %s; "
            "el mensaje se manda sin el.",
            message_id,
        )
        return None

    return StoryContextRead(
        story_id=sid,
        story_owner=_autor(autor_id, nombre, usuario, avatar),
        available=True,
        media_path=ruta,
        media_type=tipo,
        caption=pie or None,
    )


async def contextos_por_mensaje(
    db: AsyncSession, message_ids: list[str]
) -> dict[str, StoryContextRead]:
    """El contexto de historia de TODOS los mensajes de una pagina, de una vez.

    UNA CONSULTA PARA LA PAGINA ENTERA, igual que `adjuntos_por_mensaje` en
    `lectura.py` y por el mismo motivo: pedirlo por burbuja convertiria abrir un
    chat en treinta viajes a la base. El historial no puede crecer en consultas
    con el numero de mensajes.

    EL `LEFT JOIN` CONTRA `stories` NO ES OPCIONAL. La inmensa mayoria de estas
    filas apuntan a una historia que ya no existe —duran un dia—, asi que un
    `join` normal las dejaria fuera y el contexto degradado, que es el caso
    frecuente, no llegaria nunca a la pantalla. El `join` con `profiles` SI es
    normal: `story_owner_id` es `not null` y su perfil no desaparece sin
    llevarse la fila por `cascade`.

    Sin la 0044 devuelve `{}`: no hay contextos guardados, que es la verdad.
    """
    # Lista vacia = no se consulta. Y NUNCA `in_(lista or [""])`: la cadena vacia
    # pasa en SQLite y asyncpg la rechaza, y ese error acaba convertido en un 404
    # silencioso. Es una regla del proyecto.
    if not message_ids:
        return {}
    if not await esquema.hay_respuestas_a_historias(db):
        return {}

    filas = (
        await db.execute(
            select(
                MessageStoryContext.message_id,
                MessageStoryContext.story_id,
                MessageStoryContext.story_owner_id,
                Profile.full_name,
                Profile.username,
                Profile.avatar_path,
                Story.storage_path,
                Story.media_type,
                Story.caption,
            )
            .join(Profile, Profile.id == MessageStoryContext.story_owner_id)
            .outerjoin(Story, Story.id == MessageStoryContext.story_id)
            .where(MessageStoryContext.message_id.in_(message_ids))
        )
    ).all()

    salida: dict[str, StoryContextRead] = {}
    for (
        mensaje_id,
        story_id,
        owner_id,
        nombre,
        usuario,
        avatar,
        ruta,
        tipo,
        pie,
    ) in filas:
        # `story_id` a nulo es LA señal de que la historia ya no esta. El medio y
        # el pie tampoco viajan entonces: no hay nada que enseñar, y mandar los
        # de una fila fantasma seria peor que no mandar nada.
        disponible = story_id is not None
        salida[mensaje_id] = StoryContextRead(
            story_id=story_id,
            story_owner=_autor(owner_id, nombre, usuario, avatar),
            available=disponible,
            media_path=ruta if disponible else None,
            media_type=tipo if disponible else None,
            caption=(pie or None) if disponible else None,
        )
    return salida
