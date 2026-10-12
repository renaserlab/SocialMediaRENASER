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
import time

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("renaser.messaging")

#: Lo averiguado, por proceso. Ausente = todavia no se ha mirado.
_cache: dict[str, bool] = {}

#: Cuanto vale un «no», en segundos. UN «SI» VALE SIEMPRE: una tabla no
#: desaparece. UN «NO» CADUCA, porque las migraciones se aplican a mano y
#: pueden llegar DESPUES de que la API haya arrancado. Sin esto, una API que
#: miro antes de tiempo se quedaba con el «no» hasta que alguien la
#: reiniciaba, y la funcion recien migrada no aparecia en la aplicacion sin
#: que nada dijera por que. Cuesta una consulta al catalogo por minuto y por
#: funcion, y solo mientras la migracion falta.
SEGUNDOS_DE_UN_NO = 60.0

#: Hasta que instante (reloj monotono) vale cada «no». Uno sin fecha —lo que
#: deja una prueba que escribe en `_cache` a mano— vale siempre.
_no_hasta: dict[str, float] = {}

#: De cuales se ha avisado ya en el registro: el aviso sale una vez, no cada
#: minuto.
_avisados: set[str] = set()


def _sabido(clave: str) -> bool:
    """Si lo averiguado sobre `clave` sigue valiendo."""
    if clave not in _cache:
        return False
    if _cache[clave]:
        return True
    return time.monotonic() < _no_hasta.get(clave, float("inf"))


def _caduca(clave: str) -> bool:
    """Pone fecha al «no» recien averiguado. `True` la primera vez: toca avisar."""
    _no_hasta[clave] = time.monotonic() + SEGUNDOS_DE_UN_NO
    if clave in _avisados:
        return False
    _avisados.add(clave)
    return True


async def hay_adjuntos_de_chat(db: AsyncSession) -> bool:
    """Si existe `message_attachments` (migracion 0033)."""
    if not _sabido("message_attachments"):
        conexion = await db.connection()
        _cache["message_attachments"] = await conexion.run_sync(
            lambda sync: inspect(sync).has_table("message_attachments")
        )
        if not _cache["message_attachments"] and _caduca("message_attachments"):
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
    if not _sabido("direct_conversation_pairs"):
        conexion = await db.connection()
        _cache["direct_conversation_pairs"] = await conexion.run_sync(
            lambda sync: inspect(sync).has_table("direct_conversation_pairs")
        )
        if not _cache["direct_conversation_pairs"] and _caduca("direct_conversation_pairs"):
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
    if not _sabido("conversation_labels"):
        conexion = await db.connection()
        _cache["conversation_labels"] = await conexion.run_sync(
            lambda sync: inspect(sync).has_table("conversation_labels")
        )
        if not _cache["conversation_labels"] and _caduca("conversation_labels"):
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
    if not _sabido("message_story_context"):
        conexion = await db.connection()
        _cache["message_story_context"] = await conexion.run_sync(
            lambda sync: inspect(sync).has_table("message_story_context")
        )
        if not _cache["message_story_context"] and _caduca("message_story_context"):
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


#: Nombre del indice trigram que crea la 0046. Vive aqui, junto a quien lo
#: pregunta, y no repartido por el codigo: si la migracion lo renombra, este es
#: el unico sitio que hay que tocar.
INDICE_DE_BUSQUEDA_EN_MENSAJES = "messages_body_trgm_idx"


async def hay_busqueda_en_mensajes(db: AsyncSession) -> bool:
    """Si existe el indice trigram sobre `messages.body` (migracion 0046).

    SE PREGUNTA POR EL INDICE Y NO POR LA EXTENSION, y no es un capricho. La
    consulta funciona sin `pg_trgm`: `ILIKE '%algo%'` es SQL corriente y
    devolveria exactamente los mismos resultados. Lo que cambia es el COSTE —sin
    indice es un recorrido secuencial de la tabla mas grande de la aplicacion, en
    cada tecleo— asi que lo que hay que comprobar antes de encender la funcion no
    es si se PUEDE hacer, sino si se puede hacer BARATO.

    Es distinto del resto de comprobaciones de este fichero: las otras preguntan
    «¿existe esto?» porque sin ello la consulta reventaria. Esta pregunta
    «¿merece la pena?».

    SIN LA 0046: la busqueda de la bandeja sigue encontrando por NOMBRE y por
    USUARIO, que es lo que hace hoy y lo que se pidio como minimo. No hay error,
    no hay consulta de mas y no cambia ni un resultado de los que ya salian.

    El inspector de SQLAlchemy sabe de indices en PostgreSQL y en SQLite, asi
    que esto funciona igual en los dos. Si por lo que sea no pudiera mirarlos, se
    responde que no: quedarse con la busqueda de siempre es el lado seguro.
    """
    if not _sabido("indice_busqueda_mensajes"):

        def _mirar(sync) -> bool:  # noqa: ANN001
            try:
                indices = inspect(sync).get_indexes("messages")
            except Exception:  # noqa: BLE001
                # Reflejar indices puede fallar por permisos o por un tipo que el
                # dialecto no entiende. Ninguno de los dos casos justifica tumbar
                # la bandeja: se busca como hasta ahora.
                return False
            return any(
                indice.get("name") == INDICE_DE_BUSQUEDA_EN_MENSAJES
                for indice in indices
            )

        conexion = await db.connection()
        _cache["indice_busqueda_mensajes"] = await conexion.run_sync(_mirar)
        if not _cache["indice_busqueda_mensajes"] and _caduca("indice_busqueda_mensajes"):
            logger.info(
                "La migracion 0046 no esta aplicada: la busqueda de la bandeja "
                "encuentra por nombre y por usuario, no por el texto de los "
                "mensajes."
            )
    return _cache["indice_busqueda_mensajes"]


async def hay_sesiones_en_el_chat(db: AsyncSession) -> bool:
    """Si existe `message_booking_context` (migracion 0097).

    SIN LA 0097: pedir una sesion sigue dejando su mensaje en el chat, y
    responderla tambien, pero como texto normal: no hay tarjeta ni botones
    porque no hay donde guardar de que sesion habla cada mensaje. La agenda y
    los avisos funcionan igual. Se degrada el adorno, nunca la sesion.
    """
    if not _sabido("message_booking_context"):
        conexion = await db.connection()
        _cache["message_booking_context"] = await conexion.run_sync(
            lambda sync: inspect(sync).has_table("message_booking_context")
        )
        if not _cache["message_booking_context"] and _caduca("message_booking_context"):
            logger.warning(
                "La migracion 0097 no esta aplicada: las sesiones salen en el "
                "chat como texto, sin tarjeta ni botones."
            )
    return _cache["message_booking_context"]


async def hay_filtros_de_conversacion(db: AsyncSession) -> bool:
    """Si existe `conversation_filters` (migracion 0102).

    SIN LA 0102: las categorias automaticas de un chat (fotos, videos, archivos,
    audios, enlaces) funcionan igual, porque salen de `messages` y de
    `message_attachments`. Lo que no hay son filtros personalizados: listarlos
    devuelve vacio y crearlos responde 503.
    """
    if not _sabido("conversation_filters"):
        conexion = await db.connection()
        _cache["conversation_filters"] = await conexion.run_sync(
            lambda sync: inspect(sync).has_table("conversation_filters")
        )
        if not _cache["conversation_filters"] and _caduca("conversation_filters"):
            logger.warning(
                "La migracion 0102 no esta aplicada: los grupos no tienen "
                "filtros personalizados; las categorias automaticas si."
            )
    return _cache["conversation_filters"]


async def hay_puertas_de_grupo(db: AsyncSession) -> bool:
    """Si existen `group_settings` y `group_join_requests` (migracion 0104).

    SIN LA 0104: los grupos funcionan igual, pero sin foto, sin enlace y sin
    solicitudes. Solo se entra a uno cuando quien lo administra te añade.
    Las dos tablas llegan en la misma migracion: se mira una.
    """
    if not _sabido("group_settings"):
        conexion = await db.connection()
        _cache["group_settings"] = await conexion.run_sync(
            lambda sync: inspect(sync).has_table("group_settings")
        )
        if not _cache["group_settings"] and _caduca("group_settings"):
            logger.warning(
                "La migracion 0104 no esta aplicada: los grupos no tienen foto, "
                "enlace ni solicitudes para entrar."
            )
    return _cache["group_settings"]


async def hay_reacciones_y_respuestas(db: AsyncSession) -> bool:
    """Si existen `message_reactions` y `message_replies` (migracion 0106).

    SIN LA 0106: el chat funciona igual, sin reacciones y sin citas. Un
    mensaje que responde a otro se manda igual, como un mensaje normal.
    Las dos tablas llegan en la misma migracion: se mira una.
    """
    if not _sabido("message_reactions"):
        conexion = await db.connection()
        _cache["message_reactions"] = await conexion.run_sync(
            lambda sync: inspect(sync).has_table("message_reactions")
        )
        if not _cache["message_reactions"] and _caduca("message_reactions"):
            logger.warning(
                "La migracion 0106 no esta aplicada: no hay reacciones ni "
                "respuestas a un mensaje concreto."
            )
    return _cache["message_reactions"]


async def hay_preferencias_de_conversacion(db: AsyncSession) -> bool:
    """Si existe `conversation_preferences` (migracion 0107).

    SIN LA 0107: el chat funciona igual. Lo que no hay es silenciar una
    conversacion ni vaciarla para uno mismo: las dos rutas responden 503 y la
    aplicacion no las ofrece (`GET /conversations/availability`).
    """
    if not _sabido("conversation_preferences"):
        conexion = await db.connection()
        _cache["conversation_preferences"] = await conexion.run_sync(
            lambda sync: inspect(sync).has_table("conversation_preferences")
        )
        if not _cache["conversation_preferences"] and _caduca("conversation_preferences"):
            logger.warning(
                "La migracion 0107 no esta aplicada: no se puede silenciar ni "
                "vaciar una conversacion."
            )
    return _cache["conversation_preferences"]


def olvidar() -> None:
    """Solo para los tests: que uno no herede el esquema del anterior.

    Cada prueba levanta su propia base en memoria y la memoria de este modulo
    vive en el PROCESO, asi que sin esto la prueba que corre «sin la 0033»
    heredaria el «si» de la anterior y pasaria comprobando otra cosa.
    """
    _cache.clear()
    _no_hasta.clear()
    _avisados.clear()
