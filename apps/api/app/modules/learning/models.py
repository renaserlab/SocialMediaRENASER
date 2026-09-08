"""Modelos de aprendizaje: módulos, lecciones, inscripción, progreso y notas.

Mapean public.course_modules, public.course_lessons, public.purchases
(acceso al curso), public.lesson_progress y public.lesson_notes.
"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base
from app.shared.enums import purchase_status


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
    # Es un ENUM de Postgres, no VARCHAR: comparar con una cadena sin tipar
    # rompia con 'operator does not exist: purchase_status = character varying'.
    status: Mapped[str] = mapped_column(purchase_status, server_default="pending")
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


class LessonNote(Base):
    """Un apunte privado de alguien sobre una lección. Migración 0057.

    NO es un comentario ni una reseña: no se publica, no se modera y no la lee
    nadie más. Ni el autor del curso, ni moderación. Vive aquí y no en
    `content/` porque su política es justo la contraria a la de todo lo que se
    publica.
    """

    __tablename__ = "lesson_notes"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE")
    )
    course_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("courses.id", ondelete="CASCADE")
    )
    lesson_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("course_lessons.id", ondelete="CASCADE")
    )
    #: La versión que se estaba estudiando. Nula si el curso no tiene ninguna
    #: publicada: inventar un número sería peor que no tenerlo.
    course_version_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("course_versions.id", ondelete="SET NULL"),
        nullable=True,
    )
    body: Mapped[str] = mapped_column(Text)
    #: El minuto del vídeo. Nulo cuando no hay posición real; no cero, que
    #: diría «al principio».
    position_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "length(trim(body)) between 1 and 2000", name="lesson_notes_texto"
        ),
        CheckConstraint(
            "position_seconds is null or position_seconds >= 0",
            name="lesson_notes_posicion",
        ),
        Index("lesson_notes_por_leccion", "user_id", "lesson_id", "created_at"),
    )
