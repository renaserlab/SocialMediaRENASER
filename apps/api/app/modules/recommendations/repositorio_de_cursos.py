"""Todo lo que hay que leer de la base para ordenar cursos.

Aparte de `repository.py` por lo mismo que `temas_de_curso.py`: aqui se tocan
las tablas de CATALOGO y de APRENDIZAJE, que no son del recomendador. Tenerlo
junto evita que `repository.py` acabe conociendo medio sistema.

NUMERO DE CONSULTAS CONSTANTE. Cada funcion resuelve TODOS los cursos de una
vez. Una consulta por candidato convertiria una pagina de veinte cursos en
sesenta viajes a la base, y eso no se nota con tres cursos: se nota cuando ya
es tarde.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.catalog.models import Course
from app.modules.learning.models import (
    CourseLesson,
    CourseModule,
    LessonProgress,
    Purchase,
)


@dataclass(frozen=True)
class FilaDeCurso:
    """Lo minimo del curso para poder ordenarlo. El detalle se pide despues."""

    id: str
    author_id: str
    creado: datetime | None


@dataclass(frozen=True)
class MisCursos:
    """Que relacion tiene ya esta persona con cada curso.

    Los tres conjuntos son distintos y se usan para cosas distintas: lo
    empezado se aparta del descubrimiento porque su sitio es «Continúa
    aprendiendo», y lo terminado porque volver a proponerlo es no haber
    entendido nada.
    """

    empezados: set[str]
    completados: set[str]


async def candidatos(
    db: AsyncSession,
    *,
    autor_excluido: str,
    autores_bloqueados: set[str],
    cursos_excluidos: set[str],
    limite: int,
) -> list[FilaDeCurso]:
    """Los cursos que PUEDEN recomendarse. Todo lo demas se filtra en SQL.

    Filtrar en Python obligaria a traer el catalogo entero para tirar la mayor
    parte, y ademas dejaria paginas de tamano imprevisible: pides veinte y
    llegan seis porque catorce estaban descartados.

    QUE QUEDA FUERA, y por que:

    - Lo no publicado. Un borrador es de su autor y de nadie mas.
    - `coming_soon`. Recomendar algo que todavia no se puede consumir es
      mandar a alguien a una puerta cerrada. Su sitio sera una seccion de
      «Proximamente», no esta.
    - Los cursos de quien mira. Los suyos viven en su gestion; que Z le
      descubra su propio curso no le aporta nada. Vale igual para
      administracion: cuando alguien consume, consume.
    - Autores bloqueados en cualquiera de los dos sentidos.
    - Lo que ya descarto, lo que ya empezo y lo que ya termino.
    """
    consulta = (
        select(Course.id, Course.author_id, Course.created_at)
        .where(
            Course.status == "published",
            Course.coming_soon.is_(False),
            Course.author_id != autor_excluido,
        )
        .order_by(Course.created_at.desc())
        .limit(limite)
    )
    if autores_bloqueados:
        consulta = consulta.where(Course.author_id.not_in(list(autores_bloqueados)))
    if cursos_excluidos:
        consulta = consulta.where(Course.id.not_in(list(cursos_excluidos)))

    filas = (await db.execute(consulta)).all()
    return [FilaDeCurso(id=f[0], author_id=f[1], creado=f[2]) for f in filas]


async def accesos_por_curso(
    db: AsyncSession, course_ids: list[str]
) -> dict[str, int]:
    """Cuanta gente tiene acceso a cada curso, en UNA consulta.

    Es lo unico parecido a popularidad que existe hoy, y pesa poco a proposito:
    mas alumnos no hace un curso mas util para TI. Se cuentan solo los accesos
    `paid` —los gratuitos tambien lo son— porque una compra iniciada y no
    completada no es nadie.
    """
    if not course_ids:
        return {}
    filas = (
        await db.execute(
            select(Purchase.course_id, func.count())
            .where(Purchase.course_id.in_(course_ids), Purchase.status == "paid")
            .group_by(Purchase.course_id)
        )
    ).all()
    return {course_id: int(total) for course_id, total in filas}


async def mis_cursos(db: AsyncSession, user_id: str) -> MisCursos:
    """Que ha empezado y que ha terminado esta persona, en DOS consultas.

    «Terminado» se DERIVA de las lecciones, no se guarda en el curso. No hace
    falta una columna `completed`: seria un dato duplicado que se puede quedar
    desfasado en cuanto alguien anada una leccion nueva a un curso que ya
    estaba dado por acabado.
    """
    # Lecciones por curso, para saber cuantas hacen falta.
    totales = dict(
        (
            await db.execute(
                select(CourseModule.course_id, func.count(CourseLesson.id))
                .join(CourseLesson, CourseLesson.module_id == CourseModule.id)
                .group_by(CourseModule.course_id)
            )
        ).all()
    )
    if not totales:
        return MisCursos(empezados=set(), completados=set())

    # Lo que esta persona ha tocado, por curso: cuantas empezadas y cuantas
    # terminadas.
    filas = (
        await db.execute(
            select(
                CourseModule.course_id,
                func.count(LessonProgress.lesson_id),
                func.sum(case((LessonProgress.completed.is_(True), 1), else_=0)),
            )
            .select_from(LessonProgress)
            .join(CourseLesson, CourseLesson.id == LessonProgress.lesson_id)
            .join(CourseModule, CourseModule.id == CourseLesson.module_id)
            .where(LessonProgress.user_id == user_id)
            .group_by(CourseModule.course_id)
        )
    ).all()

    empezados: set[str] = set()
    completados: set[str] = set()
    for course_id, tocadas, terminadas in filas:
        if not tocadas:
            continue
        hechas = int(terminadas or 0)
        if hechas and hechas >= int(totales.get(course_id, 0)):
            completados.add(course_id)
        else:
            empezados.add(course_id)
    return MisCursos(empezados=empezados, completados=completados)


async def resumen(db: AsyncSession, course_ids: list[str]) -> dict[str, Course]:
    """Los cursos completos, en una consulta, para pintar la tarjeta."""
    if not course_ids:
        return {}
    filas = (
        await db.scalars(select(Course).where(Course.id.in_(course_ids)))
    ).all()
    return {curso.id: curso for curso in filas}


async def tamano_de_cursos(
    db: AsyncSession, course_ids: list[str]
) -> dict[str, tuple[int, int]]:
    """Modulos y lecciones de cada curso, en UNA consulta.

    Va en la tarjeta porque es informacion real y util para decidir —«ocho
    modulos, veinticuatro lecciones»— al contrario que una valoracion que no
    existe o un numero de alumnos inflado.
    """
    if not course_ids:
        return {}
    filas = (
        await db.execute(
            select(
                CourseModule.course_id,
                func.count(func.distinct(CourseModule.id)),
                func.count(CourseLesson.id),
            )
            .outerjoin(CourseLesson, CourseLesson.module_id == CourseModule.id)
            .where(CourseModule.course_id.in_(course_ids))
            .group_by(CourseModule.course_id)
        )
    ).all()
    return {
        course_id: (int(modulos or 0), int(lecciones or 0))
        for course_id, modulos, lecciones in filas
    }
