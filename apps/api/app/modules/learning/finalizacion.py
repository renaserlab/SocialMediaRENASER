"""Cuándo un curso está terminado, y qué se guarda de ese momento.

LA REGLA, ENTERA Y EN UN SITIO:

    Un curso está terminado cuando TODAS sus lecciones están completadas y,
    si tiene evaluación final publicada, hay un intento aprobado.

Sin evaluación, completar las lecciones basta.

LO QUE **NO** CUENTA, y cada exclusión es una decisión:

  * Un porcentaje que declare el cliente. Sería el propio interesado firmando
    su certificado.
  * Tiempo reproducido inventado. Los segundos ya los acota el servidor contra
    la duración real (`progreso.py`); lo que no se hace es deducir de ellos un
    «ya lo vio» que la lección no declaró.
  * Haber abierto la pantalla de la última lección. Visitar no es completar.

UN CURSO SIN LECCIONES NO ESTÁ TERMINADO. Es la trampa evidente: cero de cero
es el 100 % en aritmética y una afirmación falsa en producto.

LA FECHA SE GUARDA UNA VEZ. Recalcular no la mueve: la clave primaria de
`course_completions` rechaza la segunda inserción, así que añadir una lección
al curso no cambia el día en que alguien lo terminó ni invalida su certificado.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.learning import esquema as esquema_aprendizaje
from app.modules.learning.models import (
    CourseCompletion,
    CourseLesson,
    CourseModule,
    CourseQuiz,
    LessonProgress,
    QuizAttempt,
)


def esta_terminado(
    *,
    lecciones_totales: int,
    lecciones_hechas: int,
    exige_evaluacion: bool,
    evaluacion_aprobada: bool,
) -> bool:
    """La regla. Sin base de datos, para que se pueda leer y probar de un vistazo."""
    if lecciones_totales <= 0:
        return False
    if lecciones_hechas < lecciones_totales:
        return False
    if exige_evaluacion and not evaluacion_aprobada:
        return False
    return True


@dataclass(frozen=True)
class Estado:
    """Lo que se sabe hoy del avance de alguien en un curso."""

    lecciones_totales: int
    lecciones_hechas: int
    porcentaje: int
    #: Si el curso tiene evaluación final publicada.
    exige_evaluacion: bool
    #: El mejor intento enviado, si lo hay.
    mejor_nota: int | None
    evaluacion_aprobada: bool
    terminado: bool
    #: Cuándo se registró. `None` mientras no esté terminado o falte la 0059.
    terminado_en: datetime | None
    #: El intento que lo cerró, para dejarlo anotado en la finalización.
    intento_id: str | None


async def calcular(db: AsyncSession, *, user_id: str, course_id: str) -> Estado:
    """El estado de finalización de alguien en un curso. Cuatro consultas."""
    from app.modules.learning import progreso

    lecciones = list(
        await db.scalars(
            select(CourseLesson.id)
            .join(CourseModule, CourseModule.id == CourseLesson.module_id)
            .where(CourseModule.course_id == course_id)
        )
    )
    hechas: set[str] = set()
    if lecciones:
        hechas = set(
            await db.scalars(
                select(LessonProgress.lesson_id).where(
                    LessonProgress.user_id == user_id,
                    LessonProgress.completed.is_(True),
                    LessonProgress.lesson_id.in_(lecciones),
                )
            )
        )

    exige, mejor = False, None
    if await esquema_aprendizaje.hay_evaluaciones(db):
        quiz = await db.scalar(
            select(CourseQuiz).where(
                CourseQuiz.course_id == course_id, CourseQuiz.status == "published"
            )
        )
        if quiz is not None:
            exige = True
            mejor = await db.scalar(
                select(QuizAttempt)
                .where(
                    QuizAttempt.quiz_id == quiz.id,
                    QuizAttempt.user_id == user_id,
                    QuizAttempt.status == "submitted",
                )
                .order_by(
                    QuizAttempt.score_percent.desc(), QuizAttempt.submitted_at.desc()
                )
                .limit(1)
            )

    aprobada = bool(mejor is not None and mejor.passed)
    terminado = esta_terminado(
        lecciones_totales=len(lecciones),
        lecciones_hechas=len(hechas),
        exige_evaluacion=exige,
        evaluacion_aprobada=aprobada,
    )

    fecha = None
    if await esquema_aprendizaje.hay_certificados(db):
        fila = await db.get(
            CourseCompletion, {"user_id": user_id, "course_id": course_id}
        )
        fecha = fila.completed_at if fila is not None else None

    return Estado(
        lecciones_totales=len(lecciones),
        lecciones_hechas=len(hechas),
        porcentaje=progreso.porcentaje(len(hechas), len(lecciones)),
        exige_evaluacion=exige,
        mejor_nota=mejor.score_percent if mejor is not None else None,
        evaluacion_aprobada=aprobada,
        terminado=terminado,
        terminado_en=fecha,
        intento_id=mejor.id if (mejor is not None and mejor.passed) else None,
    )


async def registrar(db: AsyncSession, *, user_id: str, course_id: str) -> Estado:
    """Anota la finalización si toca. Idempotente, y lo sostiene la base.

    NO se hace `if existe: ...` — dos peticiones a la vez pasarían las dos por
    ese `if`. Se intenta insertar y se recoge el choque contra la clave
    primaria: la fecha original se queda como estaba.

    Sin la 0059 aplicada no se guarda nada y no se rompe nada: el estado se
    sigue calculando, lo que falta es la fecha.
    """
    estado = await calcular(db, user_id=user_id, course_id=course_id)
    if not estado.terminado or estado.terminado_en is not None:
        return estado
    if not await esquema_aprendizaje.hay_certificados(db):
        return estado

    from app.modules.catalog import versiones

    version = await versiones.vigente(db, course_id)
    db.add(
        CourseCompletion(
            user_id=user_id,
            course_id=course_id,
            quiz_attempt_id=estado.intento_id,
            course_version_id=version.id if version is not None else None,
        )
    )
    try:
        await db.flush()
    except IntegrityError:
        # Otra petición la anotó primero. Su fecha es tan buena como esta.
        await db.rollback()
        return await calcular(db, user_id=user_id, course_id=course_id)
    return await calcular(db, user_id=user_id, course_id=course_id)
