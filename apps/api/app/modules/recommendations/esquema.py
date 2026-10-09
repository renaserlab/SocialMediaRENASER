"""Que partes de las migraciones 0027 a 0032 estan aplicadas en ESTA base.

POR QUE EXISTE ESTE FICHERO, Y ES UNA LECCION CARA.

El codigo de la V1.1 se escribio contra un esquema que todavia no estaba
aplicado en produccion —la 0027 espera aprobacion, como debe ser—. El resultado
fue que la rama entera dejo de funcionar contra la base real: cada peticion que
tocaba `post_topics` o `behavior_events.surface` reventaba con un 500. Y peor
todavia, el navegador lo reportaba como un error de CORS, porque Starlette NO
anade las cabeceras CORS a una respuesta que sale de una excepcion sin capturar.
Un fallo de esquema disfrazado de fallo de red: horas buscando en el sitio
equivocado.

La regla que se rompio es la del propio proyecto: una vuelta atras no puede
exigir borrar informacion, y desplegar codigo no puede exigir que una migracion
concreta ya este puesta. El codigo tiene que funcionar CON la migracion y SIN
ella; con ella hace mas cosas, sin ella hace las de antes.

COMO SE COMPRUEBA. Una sola consulta por proceso y por tabla, con el inspector
de SQLAlchemy —que funciona igual en PostgreSQL y en SQLite— y el resultado
cacheado. No se detecta por excepcion: en PostgreSQL una sentencia fallida deja
la transaccion inservible, asi que descubrirlo «probando» obligaria a
recuperarse de un error en mitad de una operacion buena.

CUANDO SE BORRA ESTE FICHERO. Cuando las migraciones lleven aplicadas el tiempo
suficiente en todos los entornos. Entonces esto es peso muerto y quitarlo es
una linea por sitio. Mientras tanto, es lo que permite que la rama se pueda
probar antes de que la migracion se apruebe.
"""

from __future__ import annotations

import logging

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("renaser.recommendations")

#: Lo averiguado, por proceso. `None` = todavia no se ha mirado.
_cache: dict[str, bool] = {}


async def _hay_tabla(db: AsyncSession, tabla: str) -> bool:
    conexion = await db.connection()
    return await conexion.run_sync(lambda sync: inspect(sync).has_table(tabla))


async def _hay_columna(db: AsyncSession, tabla: str, columna: str) -> bool:
    conexion = await db.connection()

    def _mirar(sync) -> bool:
        inspector = inspect(sync)
        if not inspector.has_table(tabla):
            return False
        return any(c["name"] == columna for c in inspector.get_columns(tabla))

    return await conexion.run_sync(_mirar)


async def hay_temas_de_contenido(db: AsyncSession) -> bool:
    """Si existe `post_topics`.

    Sin ella, una publicacion no puede decir de que trata: se publica igual y
    el recomendador cae al respaldo del autor, que es exactamente lo que hacia
    la V1. Nada se rompe; solo se sabe menos.
    """
    if "post_topics" not in _cache:
        _cache["post_topics"] = await _hay_tabla(db, "post_topics")
        if not _cache["post_topics"]:
            logger.warning(
                "La migracion 0027 no esta aplicada: las publicaciones no pueden "
                "llevar temas propios y el orden usa el respaldo del autor."
            )
    return _cache["post_topics"]


async def hay_atribucion(db: AsyncSession) -> bool:
    """Si `behavior_events` tiene las columnas de contexto de la 0027.

    Sin ellas, las senales se guardan igual pero sin decir de donde venian: se
    sigue aprendiendo, no se puede medir el embudo. Es una perdida de
    informacion, no un fallo.
    """
    if "behavior_events.surface" not in _cache:
        _cache["behavior_events.surface"] = await _hay_columna(
            db, "behavior_events", "surface"
        )
        if not _cache["behavior_events.surface"]:
            logger.warning(
                "La migracion 0027 no esta aplicada: las senales se guardan sin "
                "superficie ni version, asi que el embudo de metricas saldra vacio."
            )
    return _cache["behavior_events.surface"]


async def hay_temas_de_curso(db: AsyncSession) -> bool:
    """Si existe `course_topics` (migracion 0028).

    Sin ella un curso no puede decir de que trata, asi que no se le puede exigir
    un tema para publicarlo ni ordenarlo por afinidad tematica. El catalogo
    sigue funcionando igual que hoy; solo se sabe menos.
    """
    if "course_topics" not in _cache:
        _cache["course_topics"] = await _hay_tabla(db, "course_topics")
        if not _cache["course_topics"]:
            logger.warning(
                "La migracion 0028 no esta aplicada: los cursos no pueden llevar "
                "temas propios y no se exigen para publicar."
            )
    return _cache["course_topics"]


async def hay_directos(db: AsyncSession) -> bool:
    """Si existen las tablas de transmisiones en vivo (migracion 0029).

    Sin ellas no hay emisiones, ni chat de emision, ni reacciones. La pestana
    «Live» sigue existiendo y sigue diciendo la verdad —que no hay nada
    emitiendo— igual que decia antes de que existiera el modulo.
    """
    if "live_sessions" not in _cache:
        _cache["live_sessions"] = await _hay_tabla(db, "live_sessions")
        if not _cache["live_sessions"]:
            logger.warning(
                "La migracion 0029 no esta aplicada: las transmisiones en vivo "
                "responden vacio."
            )
    return _cache["live_sessions"]


async def hay_invitados_de_directo(db: AsyncSession) -> bool:
    """Si existe `live_guests` (migracion 0098).

    SIN LA 0098 el directo funciona entero y como siempre; lo unico que no hay
    es donde apuntar a quien se invita, asi que no se puede invitar. Nadie se
    queda sin emitir ni sin mirar por esto: se degrada lo nuevo, nunca lo que ya
    habia.
    """
    if "live_guests" not in _cache:
        _cache["live_guests"] = await _hay_tabla(db, "live_guests")
        if not _cache["live_guests"]:
            logger.warning(
                "La migracion 0098 no esta aplicada: en los directos no se "
                "puede invitar a nadie."
            )
    return _cache["live_guests"]


async def hay_destacado_de_directo(db: AsyncSession) -> bool:
    """Si existe `live_spotlights` (migracion 0099).

    SIN LA 0099 el directo funciona entero y como siempre; lo unico que no hay
    es donde guardar el mensaje fijado y el rotulo de quien emite. Se degrada
    lo nuevo, nunca lo que ya habia.
    """
    if "live_spotlights" not in _cache:
        _cache["live_spotlights"] = await _hay_tabla(db, "live_spotlights")
        if not _cache["live_spotlights"]:
            logger.warning(
                "La migracion 0099 no esta aplicada: en los directos no se "
                "puede fijar un mensaje ni poner un rotulo."
            )
    return _cache["live_spotlights"]


async def hay_grabaciones_de_directo(db: AsyncSession) -> bool:
    """Si existe `live_recordings` (migracion 0101).

    Sin ella el aviso de «grabacion lista» se ignora y nadie ve una descarga.
    """
    if "live_recordings" not in _cache:
        _cache["live_recordings"] = await _hay_tabla(db, "live_recordings")
        if not _cache["live_recordings"]:
            logger.warning(
                "La migracion 0101 no esta aplicada: no se guarda la grabacion "
                "de los directos."
            )
    return _cache["live_recordings"]


async def hay_disponibilidad(db: AsyncSession) -> bool:
    """Si existe `availability_slots` (migracion 0100).

    Sin ella nadie puede decir cuando esta disponible; pedir una sesion sigue
    funcionando como siempre, proponiendo el momento a mano.
    """
    if "availability_slots" not in _cache:
        _cache["availability_slots"] = await _hay_tabla(db, "availability_slots")
        if not _cache["availability_slots"]:
            logger.warning(
                "La migracion 0100 no esta aplicada: no hay disponibilidad "
                "para las sesiones 1:1."
            )
    return _cache["availability_slots"]


async def hay_resenas_de_perfil(db: AsyncSession) -> bool:
    """Si existe `profile_reviews` (migracion 0030).

    Sin ella no se puede opinar de nadie: no hay donde guardar sobre QUIEN se
    opina, que es la columna que `testimonials` nunca tuvo. La seccion de un
    perfil sigue mostrando lo de siempre —su galeria— y el boton de escribir no
    aparece, en vez de aparecer y fallar al pulsarlo.

    Es la misma regla de las 0027, 0028 y 0029: desplegar codigo no puede exigir
    que una migracion concreta ya este puesta. Este modulo se puede subir hoy y
    la 0030 aplicarse el dia que la aprueben.
    """
    if "profile_reviews" not in _cache:
        _cache["profile_reviews"] = await _hay_tabla(db, "profile_reviews")
        if not _cache["profile_reviews"]:
            logger.warning(
                "La migracion 0030 no esta aplicada: no se pueden publicar "
                "resenas entre personas y los listados responden vacio."
            )
    return _cache["profile_reviews"]


async def hay_curso_en_resena(db: AsyncSession) -> bool:
    """Si existe `review_course` (migracion 0041).

    Sin ella una resena no puede decir de que curso habla: se publica IGUAL, con
    su texto y sus archivos, y `course_id` se ignora en silencio. Publicar una
    opinion no puede fallar por un adorno.

    Es la misma regla de las 0027 a 0033: desplegar codigo no puede exigir que
    una migracion concreta ya este puesta. Con la 0041 se sabe mas; sin ella se
    resena como hasta hoy.
    """
    if "review_course" not in _cache:
        _cache["review_course"] = await _hay_tabla(db, "review_course")
        if not _cache["review_course"]:
            logger.warning(
                "La migracion 0041 no esta aplicada: una resena no puede decir a "
                "que curso se refiere y el selector no se ofrece."
            )
    return _cache["review_course"]


async def hay_hashtags(db: AsyncSession) -> bool:
    """Si existen `hashtags` y `post_hashtags` (migracion 0031).

    Sin ellas una publicacion se guarda IGUAL —el texto con sus almohadillas
    incluido, que es lo que la persona escribio— pero nada queda indexado: las
    etiquetas no se extraen, `/hashtags/...` responde vacio y buscar por
    etiqueta no encuentra nada. Es exactamente lo que hace la aplicacion hoy.

    Se comprueban LAS DOS. Con solo una, extraer etiquetas escribiria en una
    tabla que no existe a mitad de la transaccion de publicar, y en PostgreSQL
    eso deja la transaccion inservible: se perderia la publicacion entera por
    un adorno.
    """
    if "post_hashtags" not in _cache:
        _cache["post_hashtags"] = await _hay_tabla(db, "hashtags") and await _hay_tabla(
            db, "post_hashtags"
        )
        if not _cache["post_hashtags"]:
            logger.warning(
                "La migracion 0031 no esta aplicada: las publicaciones se guardan "
                "sin extraer sus etiquetas y la busqueda por hashtag va vacia."
            )
    return _cache["post_hashtags"]


async def hay_menciones(db: AsyncSession) -> bool:
    """Si existe `post_mentions` (migracion 0032).

    Sin ella no se puede etiquetar a nadie: la publicacion se guarda igual y no
    sale ninguna notificacion de mencion. Lo que NO puede pasar es que no se
    pueda publicar por esto, ni que se avise a alguien de una mencion que no
    llego a guardarse.
    """
    if "post_mentions" not in _cache:
        _cache["post_mentions"] = await _hay_tabla(db, "post_mentions")
        if not _cache["post_mentions"]:
            logger.warning(
                "La migracion 0032 no esta aplicada: no se puede etiquetar a nadie "
                "en una publicacion y no se envian avisos de mencion."
            )
    return _cache["post_mentions"]


def olvidar() -> None:
    """Solo para los tests: que uno no herede el esquema del anterior."""
    _cache.clear()


async def hay_republicaciones(db: AsyncSession) -> bool:
    """Si existe `post_reposts` (migracion 0042).

    Sin ella no se puede republicar: las listas responden vacio y el boton de
    republicar contesta que la funcion no esta disponible, en vez de reventar.
    Las publicaciones se siguen leyendo, comentando y guardando igual que hoy.

    Misma regla de las 0027 a 0030: desplegar codigo no puede exigir que una
    migracion concreta ya este puesta.
    """
    if "post_reposts" not in _cache:
        _cache["post_reposts"] = await _hay_tabla(db, "post_reposts")
        if not _cache["post_reposts"]:
            logger.warning(
                "La migracion 0042 no esta aplicada: republicar no esta disponible."
            )
    return _cache["post_reposts"]


async def hay_reacciones_a_comentarios(db: AsyncSession) -> bool:
    """Si existe `comment_likes` (migracion 0048).

    Sin ella no se puede reaccionar a un comentario: no hay donde guardarlo. El
    contador sale 0, `viewer_reacted` sale false y el corazon no se pinta —en
    vez de pintarse y fallar al pulsarlo—.

    Misma regla que las anteriores: desplegar codigo no puede exigir que una
    migracion concreta ya este puesta.
    """
    if "comment_likes" not in _cache:
        _cache["comment_likes"] = await _hay_tabla(db, "comment_likes")
        if not _cache["comment_likes"]:
            logger.warning(
                "La migracion 0048 no esta aplicada: no se puede reaccionar a "
                "los comentarios y los contadores responden 0."
            )
    return _cache["comment_likes"]

