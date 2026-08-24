"""Que partes de las migraciones 0027 y 0028 estan aplicadas en ESTA base.

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


def olvidar() -> None:
    """Solo para los tests: que uno no herede el esquema del anterior."""
    _cache.clear()
