"""Si la migracion 0034 esta aplicada en ESTA base.

POR QUE EXISTE, y es la misma leccion cara que cuentan
`app/modules/recommendations/esquema.py` y `app/modules/messaging/esquema.py`.

Se escribio codigo contra un esquema que todavia no estaba aplicado —la
migracion esperaba aprobacion, como debe ser— y la rama entera dejo de
funcionar contra la base real: cada peticion que tocaba la columna nueva
reventaba con un 500 que el navegador ademas reportaba como error de CORS,
porque Starlette NO anade cabeceras CORS a una respuesta que sale de una
excepcion sin capturar. Un fallo de esquema disfrazado de fallo de red.

La regla del proyecto: desplegar codigo no puede exigir que una migracion
concreta ya este puesta. Esto tiene que funcionar CON la 0034 y SIN ella.

QUE PASA HOY, SIN LA 0034:

  - Un curso se crea, se edita, se publica y se estudia EXACTAMENTE igual que
    antes. Esto es lo importante: la plataforma no puede degradarse por una
    ficha mas rica que todavia no esta.
  - Los campos nuevos (subtitulo, nivel, idioma, publico, requisitos, categoria
    principal) se devuelven vacios o nulos. No es un error: nadie los ha
    rellenado porque no hay donde.
  - Enviar a revision, aprobar y rechazar responden 503
    `course_review_not_available`. 503 y no 404 —que haria pensar que la ruta
    esta mal escrita— ni 500 —que haria pensar que algo se ha roto—. La funcion
    existe, todavia no esta montada.
  - Las validaciones de publicacion piden lo de siempre (titulo, descripcion,
    tema, un modulo, una leccion) y NO piden lo que no se puede guardar.
  - Sin `is_preview` ninguna leccion es una muestra, asi que el temario entero
    es contenido de pago: la ruta del video solo se entrega a quien tiene
    acceso, que es justo lo que se quiere.

POR QUE UNA SOLA FUNCION Y NO UNA POR COLUMNA. Porque las tres tablas las toca
la MISMA migracion. Una base con `courses.review_status` pero sin
`course_lessons.kind` no es un estado que ocurra: seria una migracion aplicada
a medias, y el editor de Supabase corre el script como una transaccion.

COMO SE COMPRUEBA. Una sola vez por proceso, con el inspector de SQLAlchemy
—que funciona igual en PostgreSQL y en SQLite— y el resultado cacheado. No se
detecta por excepcion: en PostgreSQL una sentencia fallida deja la transaccion
inservible, asi que descubrirlo «probando» obligaria a recuperarse de un error
en mitad de una operacion buena.

CUANDO SE BORRA ESTE FICHERO. Cuando la 0034 lleve aplicada el tiempo
suficiente en todos los entornos. Entonces esto es peso muerto y quitarlo es una
linea por sitio.
"""

from __future__ import annotations

import logging

from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger("renaser.catalog")

#: Lo averiguado, por proceso. Ausente = todavia no se ha mirado.
_cache: dict[str, bool] = {}

#: Lo que la 0034 anade, por tabla. Se comprueba una columna representativa de
#: cada bloque: si esa esta, el bloque entero esta.
_COLUMNAS = (
    ("courses", "review_status"),
    ("course_modules", "description"),
    ("course_lessons", "kind"),
)


async def hay_cursos_v2(db: AsyncSession) -> bool:
    """Si la 0034 esta aplicada: ficha ampliada, revision y tipo de leccion."""
    if "cursos_v2" not in _cache:
        conexion = await db.connection()

        def _mirar(sync) -> bool:  # noqa: ANN001
            inspector = inspect(sync)
            for tabla, columna in _COLUMNAS:
                if not inspector.has_table(tabla):
                    return False
                if not any(c["name"] == columna for c in inspector.get_columns(tabla)):
                    return False
            return True

        _cache["cursos_v2"] = await conexion.run_sync(_mirar)
        if not _cache["cursos_v2"]:
            logger.warning(
                "La migracion 0034 no esta aplicada: los cursos no tienen ficha "
                "ampliada, la revision responde 503 y ninguna leccion es muestra."
            )
    return _cache["cursos_v2"]


async def hay_guardados(db: AsyncSession) -> bool:
    """Si la 0055 esta aplicada: `saved_courses`."""
    if "guardados" not in _cache:
        conexion = await db.connection()
        _cache["guardados"] = await conexion.run_sync(
            lambda sync: inspect(sync).has_table("saved_courses")
        )
    return _cache["guardados"]


def olvidar() -> None:
    """Solo para los tests: que uno no herede el esquema del anterior.

    Cada prueba levanta su propia base en memoria y la memoria de este modulo
    vive en el PROCESO, asi que sin esto la prueba que corre «sin la 0034»
    heredaria el «si» de la anterior y pasaria comprobando otra cosa.
    """
    _cache.clear()
