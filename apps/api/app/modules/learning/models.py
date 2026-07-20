"""Modelos de aprendizaje: módulos, lecciones, inscripción y progreso.

Mapean public.course_modules, public.course_lessons, public.purchases
(acceso al curso) y public.lesson_progress.
"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base


def _uuid() -> str:
    return str(uuid4())


class CourseModule(Base):
    __tablename__ = "course_modules"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    course_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("courses.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(Text)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class CourseLesson(Base):
    __tablename__ = "course_lessons"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    module_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("course_modules.id", ondelete="CASCADE"),
        index=True,
    )
    title: Mapped[str] = mapped_column(Text)
    body: Mapped[str] = mapped_column(Text, default="", server_default="")
    media_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    duration_seconds: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0"
    )
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class Purchase(Base):
    __tablename__ = "purchases"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    course_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("courses.id", ondelete="RESTRICT")
    )
    provider: Mapped[str] = mapped_column(String(16))
    provider_transaction_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    amount_minor: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    currency: Mapped[str] = mapped_column(String(3), server_default="PEN")
    status: Mapped[str] = mapped_column(String(16), server_default="pending")
    purchased_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class LessonProgress(Base):
    __tablename__ = "lesson_progress"

    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    lesson_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("course_lessons.id", ondelete="CASCADE"),
        primary_key=True,
    )
    completed: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    progress_seconds: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0"
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
