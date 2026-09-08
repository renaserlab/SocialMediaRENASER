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
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import text as sql_text

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


class CourseQuiz(Base):
    """La evaluación final de un curso. Cero o una. Migración 0058.

    `unique (course_id)` en la base y no un `if`: dos peticiones a la vez
    creando la evaluación del mismo curso se pasarían por delante de cualquier
    comprobación en Python.
    """

    __tablename__ = "course_quizzes"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    course_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("courses.id", ondelete="CASCADE"), unique=True
    )
    title: Mapped[str] = mapped_column(Text, default="", server_default="")
    #: Nota mínima para aprobar. Decisión de producto, por eso configurable.
    pass_percent: Mapped[int] = mapped_column(Integer, default=70, server_default="70")
    #: 'draft' mientras se escribe; 'published' cuando el alumno la ve.
    status: Mapped[str] = mapped_column(
        String(16), default="draft", server_default="draft"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "pass_percent between 1 and 100", name="course_quizzes_pass_percent"
        ),
        CheckConstraint(
            "status in ('draft', 'published')", name="course_quizzes_status"
        ),
    )


class QuizQuestion(Base):
    """Una pregunta de la evaluación. Migración 0058."""

    __tablename__ = "quiz_questions"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    quiz_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("course_quizzes.id", ondelete="CASCADE")
    )
    prompt: Mapped[str] = mapped_column(Text)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "length(trim(prompt)) between 1 and 500", name="quiz_questions_prompt"
        ),
        Index("quiz_questions_por_orden", "quiz_id", "sort_order"),
    )


class QuizOption(Base):
    """Una alternativa. `is_correct` NO SALE de la API mientras se responde."""

    __tablename__ = "quiz_options"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    question_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("quiz_questions.id", ondelete="CASCADE")
    )
    body: Mapped[str] = mapped_column(Text)
    is_correct: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "length(trim(body)) between 1 and 300", name="quiz_options_body"
        ),
        Index("quiz_options_por_orden", "question_id", "sort_order"),
        # UNA SOLA CORRECTA POR PREGUNTA, y lo decide la base: dos peticiones a
        # la vez marcando dos opciones distintas se pasan por delante de un `if`.
        Index(
            "quiz_options_una_correcta",
            "question_id",
            unique=True,
            sqlite_where=sql_text("is_correct"),
            postgresql_where=sql_text("is_correct"),
        ),
        # Para que una respuesta apunte a la PAREJA (pregunta, alternativa).
        UniqueConstraint("question_id", "id", name="quiz_options_de_su_pregunta"),
    )


class QuizAttempt(Base):
    """Un intento. La nota la pone el SERVIDOR al enviar, nunca el cliente."""

    __tablename__ = "quiz_attempts"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    quiz_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("course_quizzes.id", ondelete="CASCADE")
    )
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE")
    )
    course_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("courses.id", ondelete="CASCADE")
    )
    course_version_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("course_versions.id", ondelete="SET NULL"),
        nullable=True,
    )
    status: Mapped[str] = mapped_column(
        String(16), default="in_progress", server_default="in_progress"
    )
    #: Nula mientras no se envía: un 0 diría «lo hizo y sacó cero».
    score_percent: Mapped[int | None] = mapped_column(Integer, nullable=True)
    passed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    submitted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        CheckConstraint(
            "status in ('in_progress', 'submitted')", name="quiz_attempts_status"
        ),
        CheckConstraint(
            "score_percent is null or score_percent between 0 and 100",
            name="quiz_attempts_nota",
        ),
        # Enviado tiene nota y fecha; abierto no tiene ninguna de las dos. Es lo
        # que separa «lo está haciendo» de «lo hizo», y de ahí sale el fin del
        # curso.
        CheckConstraint(
            "(status = 'in_progress' and score_percent is null and passed is null"
            " and submitted_at is null)"
            " or (status = 'submitted' and score_percent is not null"
            " and passed is not null and submitted_at is not null)",
            name="quiz_attempts_coherente",
        ),
        # UN SOLO INTENTO ABIERTO por persona y evaluación.
        Index(
            "quiz_attempts_uno_abierto",
            "quiz_id",
            "user_id",
            unique=True,
            sqlite_where=sql_text("status = 'in_progress'"),
            postgresql_where=sql_text("status = 'in_progress'"),
        ),
        Index("quiz_attempts_historial", "user_id", "quiz_id", "submitted_at"),
    )


class QuizAnswer(Base):
    """Lo que alguien respondió. Una por pregunta e intento: lo dice la clave."""

    __tablename__ = "quiz_answers"

    attempt_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("quiz_attempts.id", ondelete="CASCADE"),
        primary_key=True,
    )
    question_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("quiz_questions.id", ondelete="CASCADE"),
        primary_key=True,
    )
    option_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("quiz_options.id", ondelete="CASCADE")
    )
    answered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        # LA ALTERNATIVA ES DE ESA PREGUNTA, y lo dice la base. La API ya lo
        # comprueba, pero un `if` en Python no es un invariante.
        ForeignKeyConstraint(
            ["question_id", "option_id"],
            ["quiz_options.question_id", "quiz_options.id"],
            name="quiz_answers_alternativa_de_la_pregunta",
            ondelete="CASCADE",
        ),
    )


class CourseCompletion(Base):
    """Cuándo alguien terminó un curso. Migración 0059.

    Se guarda porque el certificado dice una FECHA, y recalcularla mañana con
    las lecciones de mañana daría otra: añadir una lección movería el día en
    que alguien terminó. La clave primaria compuesta hace el registro
    idempotente sin un `if`.
    """

    __tablename__ = "course_completions"

    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    course_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("courses.id", ondelete="CASCADE"),
        primary_key=True,
    )
    completed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    quiz_attempt_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("quiz_attempts.id", ondelete="SET NULL"),
        nullable=True,
    )
    course_version_id: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("course_versions.id", ondelete="SET NULL"),
        nullable=True,
    )

    __table_args__ = (
        Index("course_completions_por_fecha", "user_id", "completed_at"),
    )


class CourseCertificate(Base):
    """Un certificado de finalización. Migración 0059.

    COPIA lo que decía el mundo al emitirlo —nombre, título del curso, autor,
    versión—: un certificado que cambia de nombre cuando alguien edita su
    perfil no certifica nada.

    NO guarda correo, identificador interno, orden ni referencia de pago: la
    página de verificación es pública.
    """

    __tablename__ = "course_certificates"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    #: El código que se comparte. Lo genera la API con `secrets`: no es
    #: correlativo y no se puede recorrer.
    public_id: Mapped[str] = mapped_column(Text, unique=True)
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE")
    )
    course_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("courses.id", ondelete="CASCADE")
    )
    display_name: Mapped[str] = mapped_column(Text)
    course_title: Mapped[str] = mapped_column(Text)
    author_name: Mapped[str] = mapped_column(Text, default="", server_default="")
    course_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    issued_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    status: Mapped[str] = mapped_column(
        String(16), default="valid", server_default="valid"
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    revoked_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        CheckConstraint(
            "status in ('valid', 'revoked')", name="course_certificates_status"
        ),
        # Revocado tiene fecha; vigente no la tiene. Es lo que separa los dos
        # estados, y de ahí sale lo que dice la verificación pública.
        CheckConstraint(
            "(status = 'valid' and revoked_at is null)"
            " or (status = 'revoked' and revoked_at is not null)",
            name="course_certificates_coherente",
        ),
        # UNO POR PERSONA Y CURSO. Reintentar devuelve el que ya hay.
        Index(
            "course_certificates_uno_por_curso", "user_id", "course_id", unique=True
        ),
        Index("course_certificates_por_persona", "user_id", "issued_at"),
    )
