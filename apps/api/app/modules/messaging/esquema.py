"""Que migraciones de mensajeria estan aplicadas en ESTA base (0033, 0039, 0044 y 0045).

POR QUE EXISTE, y es la misma leccion cara que cuenta
`app/modules/recommendations/esquema.py`.

El codigo de la V1.1 se escribio contra un esquema que todavia no estaba
aplicado —la migracion esperaba aprobacion, como debe ser— y la rama entera
dejo de funcionar contra la base real: cada peticion que tocaba la tabla nueva
reventaba con un 500. Y peor, el navegador lo reportaba como un error de CORS,
porque Starlette NO anade cabeceras CORS a una respuesta que sale de una
excepcion sin capturar. Un fallo de esquema disfrazado de fallo de red.

La regla del proyecto: desplegar codigo no puede exigir que una migracion
concreta ya este puesta. El codigo tiene que funcionar CON la 0033 y SIN ella;
con ella se pueden mandar archivos, sin ella se manda texto igual que hoy.

QUE PASA HOY, SIN LA 0033:

  - El historial responde con `attachments: []` en todos los mensajes. No es un
    error: no hay adjuntos, y una lista vacia es exactamente eso.
  - Mandar un mensaje CON archivos responde 503 `chat_attachments_not_available`.
    503 y no 404, que haria pensar que la ruta esta mal escrita, ni 500, que
    haria pensar que algo se ha roto. La funcion existe, todavia no esta puesta.
  - Un mensaje de solo texto sigue funcionando exactamente igual que antes.
  - El texto sigue siendo OBLIGATORIO, porque sin la 0033 la restriccion
    `char_length(body) between 1 and 5000` sigue en la tabla y un mensaje vacio
    no entraria. Con la 0033 el minimo baja a cero y un mensaje puede ser solo
    un archivo.

COMO SE COMPRUEBA. Una sola consulta por proceso, con el inspector de SQLAlchemy
—que funciona igual en PostgreSQL y en SQLite— y el resultado cacheado. No se
detecta por excepcion: en PostgreSQL una sentencia fallida deja la transaccion
inservible, asi que descubrirlo «probando» obligaria a recuperarse de un error
en mitad de una operacion buena.

QUE PASA HOY, SIN LA 0039: abrir un chat directo funciona igual, pero la
unicidad de la pareja no esta garantizada por la base. Ver `hay_pares_directos`.

QUE PASA HOY, SIN LA 0045: la bandeja funciona exactamente igual, porque las
etiquetas del CRM son una capa ENCIMA de las conversaciones y no una parte de
ellas. Listar etiquetas devuelve vacio y crearlas responde 503. Ver
`hay_etiquetas_de_conversacion`.

QUE PASA HOY, SIN LA 0044: responder una historia manda el mensaje igual, pero
sin su referencia estructurada a la historia; y las notas de voz no se ofrecen
siquiera. Ver `hay_respuestas_a_historias` y `hay_notas_de_voz`.

CUANDO SE BORRA ESTE FICHERO. Cuando la 0033, la 0039, la 0044 y la 0045 lleven
aplicadas el tiempo suficiente en todos los entornos. Entonces esto es peso
muerto y quitarlo es una linea por sitio.
"""

from __future__ import annotations

import logging

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("renaser.messaging")

#: Lo averiguado, por proceso. Ausente = todavia no se ha mirado.
_cache: dict[str, bool] = {}


async def hay_adjuntos_de_chat(db: AsyncSession) -> bool:
    """Si existe `message_attachments` (migracion 0033)."""
    if "message_attachments" not in _cache:
        conexion = await db.connection()
        _cache["message_attachments"] = await conexion.run_sync(
            lambda sync: inspect(sync).has_table("message_attachments")
        )
        if not _cache["message_attachments"]:
            logger.warning(
                "La migracion 0033 no esta aplicada: los mensajes solo pueden "
                "llevar texto y el boton de adjuntar responde 503."
            )
    return _cache["message_attachments"]


async def hay_pares_directos(db: AsyncSession) -> bool:
    """Si existe `direct_conversation_pairs` (migracion 0039).

    Es la tabla cuya clave primaria impide que dos peticiones simultaneas creen
    dos conversaciones directas para la MISMA pareja. Mientras la 0039 espere
    aprobacion, crear un chat funciona igual que hoy y la unica proteccion
    contra el doble toque sigue siendo la del cliente: no se degrada nada, pero
    la garantia de verdad —la que no depende de que nadie se equivoque— llega
    con la migracion.
    """
    if "direct_conversation_pairs" not in _cache:
        conexion = await db.connection()
        _cache["direct_conversation_pairs"] = await conexion.run_sync(
            lambda sync: inspect(sync).has_table("direct_conversation_pairs")
        )
        if not _cache["direct_conversation_pairs"]:
            logger.warning(
                "La migracion 0039 no esta aplicada: abrir un chat directo dos "
                "veces a la vez todavia puede crear dos conversaciones."
            )
    return _cache["direct_conversation_pairs"]


async def hay_etiquetas_de_conversacion(db: AsyncSession) -> bool:
    """Si existe `conversation_labels` (migracion 0045, el CRM de etiquetas).

    SE PREGUNTA POR UNA SOLA DE LAS DOS TABLAS y no por las dos, porque las dos
    nacen en la MISMA migracion: si esta una y no la otra, la base esta a medias
    y eso no es un estado del que este codigo pueda recuperarse degradando. Se
    elige `conversation_labels` porque es la que se consulta primero en todos
    los caminos —sin etiquetas no hay asignaciones que mirar—.

    SIN LA 0045: listar etiquetas devuelve `[]` (no hay ninguna, que es la
    verdad) y crear, renombrar, asignar o quitar responden 503
    `conversation_labels_not_available`. Nunca un 500: un 500 sin capturar sale
    por Starlette SIN cabeceras CORS y el navegador lo enseña como un fallo de
    red, que manda a mirar al sitio equivocado.

    La bandeja, mientras tanto, no se entera de nada: las etiquetas son una capa
    encima de las conversaciones, asi que la lista, el chat y los adjuntos
    siguen funcionando igual que hoy.
    """
    if "conversation_labels" not in _cache:
        conexion = await db.connection()
        _cache["conversation_labels"] = await conexion.run_sync(
            lambda sync: inspect(sync).has_table("conversation_labels")
        )
        if not _cache["conversation_labels"]:
            logger.warning(
                "La migracion 0045 no esta aplicada: la bandeja funciona igual, "
                "pero no se pueden crear ni usar etiquetas de conversacion."
            )
    return _cache["conversation_labels"]


async def hay_respuestas_a_historias(db: AsyncSession) -> bool:
    """Si existe `message_story_context` (migracion 0044).

    SIN LA 0044: responder una historia desde el visor sigue MANDANDO EL
    MENSAJE, que es lo que la persona queria; lo unico que no se guarda es la
    referencia estructurada a la historia, asi que la burbuja sale como un
    mensaje normal. Se degrada el adorno, nunca el contenido: perder el texto de
    alguien porque una tabla todavia no esta seria mucho peor que perder la
    miniatura de la historia.

    El historial responde entonces con `story_context: null` en todos los
    mensajes, que es la verdad —no hay contexto guardado— y no un error. Y el
    filtro «Respuestas a historias» de la bandeja no se ofrece: sin la tabla no
    hay nada que filtrar, y un filtro que siempre devuelve vacio es un boton
    muerto.
    """
    if "message_story_context" not in _cache:
        conexion = await db.connection()
        _cache["message_story_context"] = await conexion.run_sync(
            lambda sync: inspect(sync).has_table("message_story_context")
        )
        if not _cache["message_story_context"]:
            logger.warning(
                "La migracion 0044 no esta aplicada: responder una historia "
                "manda el mensaje pero sin su referencia a la historia."
            )
    return _cache["message_story_context"]


async def hay_notas_de_voz(db: AsyncSession) -> bool:
    """Si se puede guardar un adjunto con `kind = 'audio'` (migracion 0044).

    SE PREGUNTA POR LA TABLA `message_story_context` Y NO POR EL `CHECK`, y esto
    necesita explicacion porque no es lo que parece que deberia hacer.

    Lo que de verdad habilita una nota de voz es que el `CHECK` de
    `message_attachments.kind` admita 'audio'. Pero una restriccion no se puede
    consultar de forma portable: el inspector de SQLAlchemy —que es lo que
    permite que esta comprobacion funcione igual en PostgreSQL y en el SQLite de
    las pruebas— sabe de tablas, no de `CHECK`s, y leerlo a mano exigiria una
    consulta a `pg_constraint` que en SQLite no existe. Y descubrirlo
    «probando» a insertar esta descartado: en PostgreSQL una sentencia fallida
    deja la transaccion inservible, asi que averiguarlo costaria recuperarse de
    un error en mitad de una operacion buena.

    Asi que se pregunta por la otra mitad de la MISMA migracion. Las dos cosas
    —la tabla y el `CHECK` ampliado— nacen en la 0044 y no hay forma de aplicar
    media: la propia migracion aborta si el `CHECK` no queda como debe (lleva un
    bloque que lo verifica contra `pg_constraint`). Es el mismo criterio que usa
    `hay_etiquetas_de_conversacion` al preguntar por una sola de las dos tablas
    de la 0045.

    SIN LA 0044: mandar una nota de voz responde 503 `voice_notes_not_available`
    —nunca un 500, que saldria sin cabeceras CORS y en el navegador parece un
    fallo de red— y, sobre todo, la interfaz NO OFRECE grabar, porque lo
    consulta antes por `GET /conversations/availability`. Nunca un boton muerto.
    Lo que NO se hace es guardar el audio como `document` para disimular: seria
    una fila que miente sobre lo que contiene, y la pantalla no sabria que eso
    se reproduce.
    """
    return await hay_respuestas_a_historias(db)


def olvidar() -> None:
    """Solo para los tests: que uno no herede el esquema del anterior.

    Cada prueba levanta su propia base en memoria y la memoria de este modulo
    vive en el PROCESO, asi que sin esto la prueba que corre «sin la 0033»
    heredaria el «si» de la anterior y pasaria comprobando otra cosa.
    """
    _cache.clear()
