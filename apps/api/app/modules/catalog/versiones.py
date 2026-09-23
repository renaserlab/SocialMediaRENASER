"""La fotografía de un curso al publicarse, y cuándo hace falta una nueva.

QUÉ ENTRA EN LA FOTOGRAFÍA Y QUÉ NO. Entra lo que alguien mira ANTES de pagar y
que, si cambia, cambia lo que compró: título, descripción, puntos destacados, la
ficha de la 0034 y el temario con su orden, su duración y qué lecciones son
muestra. No entra:

  * **El precio.** Es oferta, no contenido. Cambiarlo no puede invalidar el
    temario que alguien está viendo; va congelado en la orden.
  * **El estado de revisión.** Es un eje aparte y vive en `courses`.
  * **Las rutas de los medios.** Apuntan a Storage, que es mutable por fuera:
    guardarlas prometería una inmutabilidad que no se tiene.
  * **El cuerpo de las lecciones.** Corregir una errata generaría una versión
    nueva y, con ella, ruido sobre las garantías vivas.

`is_preview` SÍ ENTRA, y es lo menos evidente de la lista: decide qué se ve sin
pagar. Convertir en muestra la única lección de pago de un curso ya vendido
cambia el producto sin tocar ni una palabra del temario.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.catalog import cursos_v2
from app.modules.catalog.models import Course, CourseVersion
from app.modules.gobernanza import esquema as esquema_gobernanza
from app.modules.learning.models import CourseLesson, CourseModule

logger = logging.getLogger("renaser.catalog")


def _canonico(snapshot: dict[str, Any]) -> str:
    """El documento en una forma estable, para poder compararlo.

    Claves ordenadas y sin espacios: sin esto, el mismo contenido daría dos
    huellas distintas según el orden en que Python construyera el diccionario, y
    republicar sin cambios crearía una versión nueva cada vez.
    """
    return json.dumps(snapshot, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def huella(snapshot: dict[str, Any]) -> str:
    return hashlib.sha256(_canonico(snapshot).encode("utf-8")).hexdigest()


async def construir_snapshot(db: AsyncSession, curso: Course) -> dict[str, Any]:
    """Reúne las tres fuentes en un solo documento.

    SON TRES SITIOS FÍSICOS DISTINTOS: la tabla `courses`, las columnas que la
    0034 añadió a esa misma tabla pero que viven fuera del ORM, y el temario.
    Construirlo con un `select(Course)` a secas dejaría fuera siete campos en
    silencio, que es la clase de fallo que solo se ve meses después.
    """
    ficha = await cursos_v2.leer_una(db, curso.id)

    modulos = list(
        await db.scalars(
            select(CourseModule)
            .where(CourseModule.course_id == curso.id)
            .order_by(CourseModule.sort_order, CourseModule.id)
        )
    )
    lecciones_por_modulo: dict[str, list[CourseLesson]] = {}
    todas: list[CourseLesson] = []
    if modulos:
        for leccion in await db.scalars(
            select(CourseLesson)
            .where(CourseLesson.module_id.in_([m.id for m in modulos]))
            .order_by(CourseLesson.sort_order, CourseLesson.id)
        ):
            lecciones_por_modulo.setdefault(leccion.module_id, []).append(leccion)
            todas.append(leccion)

    # `kind` e `is_preview` NO ESTÁN EN EL ORM: viven en las columnas que la
    # 0034 añadió a `course_lessons` y que se leen por un `MetaData` aparte.
    # Sacarlos con `getattr(leccion, "is_preview", False)` habría devuelto
    # siempre `False` y el snapshot habría perdido, en silencio, justo el campo
    # que decide qué se ve sin pagar.
    tipos = await cursos_v2.tipos_de_lecciones(db, [x.id for x in todas])

    return {
        "title": curso.title or "",
        "description": curso.description or "",
        "highlights": list(curso.highlights or []),
        "subtitle": ficha.subtitle,
        "language": ficha.language,
        "level": ficha.level,
        "target_audience": list(ficha.target_audience or []),
        "prerequisites": list(ficha.prerequisites or []),
        "modules": [
            {
                "title": m.title or "",
                "sort_order": m.sort_order,
                "lessons": [
                    {
                        "title": leccion.title or "",
                        "sort_order": leccion.sort_order,
                        "duration_seconds": leccion.duration_seconds,
                        "kind": tipos.get(leccion.id, ("video", False))[0],
                        # Decide qué se ve sin pagar: cambiarlo cambia el producto.
                        "is_preview": tipos.get(leccion.id, ("video", False))[1],
                    }
                    for leccion in lecciones_por_modulo.get(m.id, [])
                ],
            }
            for m in modulos
        ],
    }


async def vigente(db: AsyncSession, course_id: str) -> CourseVersion | None:
    """La versión publicada de un curso, o `None` si todavía no tiene."""
    if not await esquema_gobernanza.hay_versiones_de_curso(db):
        return None
    return await db.scalar(
        select(CourseVersion).where(
            CourseVersion.course_id == course_id,
            CourseVersion.status == "published",
        )
    )


async def asegurar_version(
    db: AsyncSession, curso: Course, *, publicada_por: str | None = None
) -> CourseVersion | None:
    """La versión vigente del curso después de publicar. Crea una si hace falta.

    TRES CAMINOS Y NINGUNO SOBRA:

    1. No hay versión: se crea la 1.
    2. La hay y el contenido NO ha cambiado: se devuelve la misma. Republicar no
       es versionar, y una versión nueva idéntica solo ensucia el historial y
       confunde a quien mire «¿qué compré?».
    3. La hay y el contenido cambió: la anterior pasa a `superseded` y nace la
       siguiente. Las compras antiguas siguen apuntando a la suya.

    NO HACE `commit`: lo hace quien llama, para que la versión y el cambio de
    estado del curso vivan o mueran juntos.

    Devuelve `None` si la 0050 no está aplicada, y publicar sigue funcionando
    como antes. Ojo con lo que eso NO significa: el módulo de versiones aguanta
    un despliegue adelantado, pero las columnas que la 0050 añade a `orders` no,
    porque están en el modelo sin guarda. La migración va antes que el código.
    """
    if not await esquema_gobernanza.hay_versiones_de_curso(db):
        return None

    snapshot = await construir_snapshot(db, curso)
    firma = huella(snapshot)

    # LA ÚLTIMA DE TODAS, esté vigente o retirada. Mirar solo la vigente sería
    # un error concreto: retirar un curso y volver a publicarlo sin haberlo
    # tocado creaba una versión 2 idéntica a la 1. Quien comprara después vería
    # «versión 2» de un contenido que no ha cambiado nunca, y el historial
    # contaría un cambio que no ocurrió.
    ultima = await db.scalar(
        select(CourseVersion)
        .where(CourseVersion.course_id == curso.id)
        .order_by(CourseVersion.version.desc())
        .limit(1)
    )

    # UNA VERSIÓN RECONSTRUIDA NUNCA VA A COINCIDIR, Y ESTÁ BIEN QUE ASÍ SEA.
    #
    # El backfill de la 0050 arma su documento en SQL y solo puede reunir cinco
    # campos: título, descripción, puntos destacados, el temario básico y la
    # marca de reconstruido. Le faltan el subtítulo, el idioma, el nivel, el
    # público, los requisitos, y el tipo y la condición de muestra de cada
    # lección. Es una fotografía PARCIAL, y no puede ser otra cosa: reproducir
    # en SQL la forma canónica del documento sería mantener dos veces la misma
    # decisión, y se separarían al primer cambio.
    #
    # Por eso la primera publicación real crea una versión 2 CON LA FOTOGRAFÍA
    # COMPLETA, y eso no es ruido en el historial: es la diferencia entre «esto
    # es lo que reconstruimos» y «esto es lo que se publicó». La v1 se queda
    # como lo que es, marcada `backfill`.
    #
    # HUBO AQUÍ UN INTENTO DE «ADOPTAR» LA FILA reescribiéndole la huella para
    # evitar esa v2. Era doblemente erróneo: dejaba una fotografía incompleta
    # haciéndose pasar por la vigente, y además el disparador
    # `course_versions_inmutable` RECHAZA cualquier cambio de `content_hash`.
    # No lo cazó ninguna prueba porque SQLite no ejecuta disparadores; lo cazó
    # mirar la base de verdad.
    if ultima is not None and ultima.content_hash == firma:
        # El mismo contenido. Si estaba retirada, vuelve a ser la vigente.
        if ultima.status != "published":
            ultima.status = "published"
            await db.flush()
        return ultima

    siguiente = (ultima.version + 1) if ultima is not None else 1
    actual = await vigente(db, curso.id)

    nueva = CourseVersion(
        course_id=curso.id,
        version=siguiente,
        status="published",
        content_hash=firma,
        snapshot=snapshot,
        published_by=publicada_por,
        origin="publish",
    )
    try:
        # TODO DENTRO DEL SAVEPOINT: retirar la anterior Y añadir la nueva.
        #
        # Es el mismo error que `consentimientos.py` documenta y que aquí estaba
        # cometido: con el `add` fuera, el objeto pertenece a la transacción
        # exterior y deshacer el savepoint no lo saca. Y con el paso a
        # `superseded` fuera, una publicación rival que gane la carrera dejaba la
        # anterior retirada y ninguna vigente —el curso publicado sin versión—,
        # que es peor que el problema que se quería evitar.
        async with db.begin_nested():
            if actual is not None:
                actual.status = "superseded"
            db.add(nueva)
            await db.flush()
    except IntegrityError:
        # Otra publicación llegó antes. La suya es la buena.
        ganadora = await vigente(db, curso.id)
        if ganadora is None:
            # No hay vigente y tampoco pudimos crearla: el curso quedaría
            # publicado sin versión. Es un fallo, no un final feliz, y quien
            # llama tiene que enterarse en vez de confirmar ese estado.
            raise
        logger.info(
            "[catalog] otra publicacion del curso %s llego antes; se usa la suya",
            curso.id,
        )
        return ganadora
    return nueva


async def retirar_vigente(db: AsyncSession, course_id: str) -> bool:
    """Al despublicar, la versión deja de ser la vigente. NO SE BORRA.

    Es lo que alguien compró: borrarla dejaría órdenes apuntando a nada, y la
    0050 lo impide además con un disparador. Pasa a `superseded`, que es historia.
    """
    actual = await vigente(db, course_id)
    if actual is None:
        return False
    actual.status = "superseded"
    await db.flush()
    return True
