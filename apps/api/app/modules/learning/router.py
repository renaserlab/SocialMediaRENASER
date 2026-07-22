"""Endpoints de aprendizaje: detalle del curso, inscripción y progreso."""

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.catalog.models import Course
from app.modules.learning.models import (
    CourseLesson,
    CourseModule,
    LessonProgress,
    Purchase,
)
from app.modules.learning.schemas import (
    CourseDetailRead,
    LessonDetailRead,
    LessonRead,
    ModuleRead,
)
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid

router = APIRouter(prefix="/learning", tags=["learning"])


async def _is_enrolled(db: AsyncSession, uid: str, course_id: str) -> bool:
    value = await db.scalar(
        select(func.count())
        .select_from(Purchase)
        .where(
            Purchase.user_id == uid,
            Purchase.course_id == course_id,
            Purchase.status == "paid",
        )
    )
    return (value or 0) > 0


@router.get("/courses/{course_id}", response_model=CourseDetailRead)
async def get_course_detail(
    course_id: str,
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> CourseDetailRead:
    ensure_uuid(course_id, "Curso no encontrado.")
    course = await db.get(Course, course_id)
    if course is None:
        raise NotFoundError("Curso no encontrado.")
    uid = current_user.id if current_user else None

    modules = (
        await db.scalars(
            select(CourseModule)
            .where(CourseModule.course_id == course_id)
            .order_by(CourseModule.sort_order)
        )
    ).all()

    # Lecciones completadas por el usuario (para marcar cada lección).
    completed_ids: set[str] = set()
    if uid:
        rows = (
            await db.execute(
                select(LessonProgress.lesson_id).where(
                    LessonProgress.user_id == uid,
                    LessonProgress.completed.is_(True),
                )
            )
        ).all()
        completed_ids = {r[0] for r in rows}

    module_reads: list[ModuleRead] = []
    lessons_total = 0
    lessons_completed = 0
    for module in modules:
        lessons = (
            await db.scalars(
                select(CourseLesson)
                .where(CourseLesson.module_id == module.id)
                .order_by(CourseLesson.sort_order)
            )
        ).all()
        lesson_reads: list[LessonRead] = []
        for lesson in lessons:
            done = lesson.id in completed_ids
            lessons_total += 1
            if done:
                lessons_completed += 1
            lesson_reads.append(
                LessonRead(
                    id=lesson.id,
                    title=lesson.title,
                    duration_seconds=lesson.duration_seconds,
                    sort_order=lesson.sort_order,
                    completed=done,
                    media_path=lesson.media_path,
                )
            )
        module_reads.append(
            ModuleRead(
                id=module.id,
                title=module.title,
                sort_order=module.sort_order,
                lessons=lesson_reads,
            )
        )

    percent = (
        round(lessons_completed * 100 / lessons_total) if lessons_total else 0
    )
    return CourseDetailRead(
        id=course.id,
        title=course.title,
        description=course.description,
        cover_path=course.cover_path,
        price_minor=course.price_minor,
        currency=course.currency,
        status=course.status,
        enrolled=bool(uid) and await _is_enrolled(db, uid, course_id),
        progress_percent=percent,
        lessons_total=lessons_total,
        lessons_completed=lessons_completed,
        modules=module_reads,
    )


@router.post("/courses/{course_id}/enroll")
async def enroll_course(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    course = await db.get(Course, course_id)
    if course is None:
        raise NotFoundError("Curso no encontrado.")
    if not await _is_enrolled(db, current_user.id, course_id):
        # Inscripción gratuita: registramos un acceso "manual" pagado.
        db.add(
            Purchase(
                user_id=current_user.id,
                course_id=course_id,
                provider="manual",
                amount_minor=0,
                currency=course.currency,
                status="paid",
            )
        )
        await db.commit()
    return {"enrolled": True}


@router.get("/lessons/{lesson_id}", response_model=LessonDetailRead)
async def get_lesson_detail(
    lesson_id: str,
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> LessonDetailRead:
    """Una leccion por su id.

    La app abre `/lesson/<id>` sin conocer el curso, asi que aqui se resuelve
    el contexto (modulo y curso) con un solo join.
    """
    ensure_uuid(lesson_id, "Lección no encontrada.")
    row = (
        await db.execute(
            select(CourseLesson, CourseModule, Course)
            .join(CourseModule, CourseModule.id == CourseLesson.module_id)
            .join(Course, Course.id == CourseModule.course_id)
            .where(CourseLesson.id == lesson_id)
        )
    ).first()
    if row is None:
        raise NotFoundError("Lección no encontrada.")
    lesson, module, course = row

    completed = False
    if current_user:
        progress = await db.get(
            LessonProgress, {"user_id": current_user.id, "lesson_id": lesson_id}
        )
        completed = bool(progress and progress.completed)

    return LessonDetailRead(
        id=lesson.id,
        title=lesson.title,
        duration_seconds=lesson.duration_seconds,
        sort_order=lesson.sort_order,
        completed=completed,
        media_path=lesson.media_path,
        course_id=course.id,
        course_title=course.title,
        module_title=module.title,
    )


@router.post("/lessons/{lesson_id}/complete")
async def complete_lesson(
    lesson_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    lesson = await db.get(CourseLesson, lesson_id)
    if lesson is None:
        raise NotFoundError("Lección no encontrada.")
    existing = await db.get(
        LessonProgress, {"user_id": current_user.id, "lesson_id": lesson_id}
    )
    if existing is None:
        db.add(
            LessonProgress(
                user_id=current_user.id, lesson_id=lesson_id, completed=True
            )
        )
    else:
        existing.completed = True
    await db.commit()
    return {"completed": True}
