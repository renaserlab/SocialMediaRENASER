"""Esquemas de aprendizaje."""

from pydantic import BaseModel


class LessonRead(BaseModel):
    id: str
    title: str
    duration_seconds: int
    sort_order: int
    completed: bool = False


class LessonDetailRead(LessonRead):
    """Una leccion con su contexto, para abrirla por su propio id."""

    course_id: str
    course_title: str
    module_title: str


class ModuleRead(BaseModel):
    id: str
    title: str
    sort_order: int
    lessons: list[LessonRead] = []


class CourseDetailRead(BaseModel):
    id: str
    title: str
    description: str
    cover_path: str | None = None
    price_minor: int
    currency: str
    status: str
    enrolled: bool = False
    progress_percent: int = 0
    lessons_total: int = 0
    lessons_completed: int = 0
    modules: list[ModuleRead] = []
