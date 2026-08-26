"""Que partes de las migraciones 0034, 0035 y 0036 estan aplicadas en ESTA base.

Misma leccion —y misma solucion— que `app/modules/recommendations/esquema.py`,
que se escribio despues de que una rama entera dejara de funcionar contra la
base real por dar por aplicada una migracion que todavia esperaba aprobacion.
Cada peticion que tocaba la tabla que faltaba reventaba con un 500, y el
navegador lo reportaba como error de CORS, porque Starlette NO añade cabeceras
CORS a una respuesta que sale de una excepcion sin capturar. Un fallo de esquema
disfrazado de fallo de red.

La regla del proyecto: desplegar codigo no puede exigir que una migracion
concreta ya este puesta. Con la 0035 hay comercio; sin ella, la aplicacion se
comporta EXACTAMENTE como hoy —acceso por curso gratuito, autor,
administracion o compra en `purchases`— y las escrituras del comercio
responden 503.

POR QUE SE COMPARTE EL CACHE CON `recommendations.esquema` Y NO SE HACE OTRO.
Porque la memoria vive en el PROCESO, no en la base, y cada prueba levanta su
propia base en memoria. El `conftest.py` de la suite ya llama a
`recommendations.esquema.olvidar()` antes de CADA prueba, precisamente para que
ninguna herede lo que averiguo la anterior. Un diccionario propio aqui quedaria
fuera de esa limpieza: bastaria que una prueba con las tablas puestas corriera
antes que una sin ellas para que la segunda diera por bueno un esquema que no
tiene, y el fallo apareceria en un sitio que no tiene nada que ver. Compartir el
diccionario hereda esa garantia para toda la suite y sin tocar ningun fichero
ajeno.

CUANDO SE BORRA ESTE FICHERO. Cuando las 0034-0036 lleven aplicadas el tiempo
suficiente en todos los entornos. Entonces es peso muerto.
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

# Los ayudantes y el diccionario son deliberadamente los mismos: ver el porque
# en el docstring de arriba. Se MUTA `_cache`, nunca se reasigna, para que
# `olvidar()` siga vaciando este tambien.
from app.modules.recommendations.esquema import (  # noqa: F401
    _cache,
    _hay_columna,
    _hay_tabla,
    olvidar,
)

logger = logging.getLogger("renaser.commerce")


async def hay_comercio(db: AsyncSession) -> bool:
    """Si estan las tablas del dominio comercial (migracion 0035).

    Se comprueban DOS —`entitlements` y `commerce_products`— y no una. Con solo
    una, conceder un derecho escribiria en una tabla que no existe a mitad de la
    transaccion, y en PostgreSQL eso deja la transaccion inservible: se perderia
    tambien lo bueno que se hubiera hecho antes en la misma peticion.

    Sin ellas el acceso se decide como hoy: gratuito, autor, administracion o
    fila en `purchases`. Nadie pierde nada; simplemente todavia no hay derechos.
    """
    if "entitlements" not in _cache:
        hay = await _hay_tabla(db, "entitlements")
        if hay:
            hay = await _hay_tabla(db, "commerce_products")
        _cache["entitlements"] = hay
        if not _cache["entitlements"]:
            logger.warning(
                "La migracion 0035 no esta aplicada: no hay derechos ni ordenes, "
                "el acceso se decide solo por `purchases` y las escrituras del "
                "comercio responden 503."
            )
    return _cache["entitlements"]


async def hay_matriculas(db: AsyncSession) -> bool:
    """Si existe `course_enrollments` (misma migracion 0035).

    Se pregunta aparte porque se usa aparte: matricular es un efecto secundario
    de conceder un derecho, y que falte la matricula no puede impedir que el
    derecho se conceda. El derecho es lo que da acceso; la matricula solo hace
    que el curso salga en «mis cursos».
    """
    if "course_enrollments" not in _cache:
        _cache["course_enrollments"] = await _hay_tabla(db, "course_enrollments")
    return _cache["course_enrollments"]


async def hay_lecciones_de_muestra(db: AsyncSession) -> bool:
    """Si `course_lessons` tiene la columna `is_preview` (migracion 0034).

    Sin ella no hay muestras: una leccion vale lo que vale su curso, que es
    exactamente lo que pasa hoy. Lo que NO puede ocurrir es que preguntar por
    una columna inexistente tumbe la comprobacion de acceso entera y deje sin
    ver su curso a quien lo compro.
    """
    if "course_lessons.is_preview" not in _cache:
        _cache["course_lessons.is_preview"] = await _hay_columna(
            db, "course_lessons", "is_preview"
        )
    return _cache["course_lessons.is_preview"]
