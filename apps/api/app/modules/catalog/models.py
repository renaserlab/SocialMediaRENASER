"""Modelos ORM del catalogo: eventos y cursos.

Coinciden con public.events / public.courses de la migracion inicial.
"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base
from app.shared.enums import content_status

#: `text[]` en PostgreSQL, JSON en SQLite (la base de los tests), igual que en
#: `recommendations/models.py`. Sin la variante, los tests no podrian ni crear
#: las tablas.
_LISTA_DE_TEXTO = ARRAY(Text).with_variant(JSON, "sqlite")

#: `jsonb` en PostgreSQL, JSON en SQLite. Mismo motivo que la lista de arriba.
_DOCUMENTO = JSONB().with_variant(JSON, "sqlite")


def _uuid() -> str:
    return str(uuid4())


class Event(Base):
    __tablename__ = "events"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    organizer_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, default="", server_default="")
    # Opcional: un evento puede anunciarse antes de cerrar la fecha.
    starts_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), index=True, nullable=True
    )
    ends_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    location: Mapped[str | None] = mapped_column(Text, nullable=True)
    cover_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Invitacion al grupo donde se dan los detalles del evento.
    whatsapp_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    event_type: Mapped[str] = mapped_column(String(20), server_default="online")
    status: Mapped[str] = mapped_column(content_status, server_default="published")
    capacity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class EventRegistration(Base):
    __tablename__ = "event_registrations"

    event_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("events.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profiles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    status: Mapped[str] = mapped_column(String(16), server_default="confirmed")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Course(Base):
    __tablename__ = "courses"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    author_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, default="", server_default="")
    cover_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    price_minor: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    currency: Mapped[str] = mapped_column(String(3), server_default="PEN")
    status: Mapped[str] = mapped_column(content_status, server_default="draft")
    # Anunciado pero sin contenido todavia (migracion 0014). NO es `draft`: un
    # borrador solo lo ve su autor, esto lo ve todo el mundo como «Proximamente».
    # La columna existe en produccion desde la 0014; se mapea ahora porque el
    # servidor necesita decidir si un curso asi puede recomendarse.
    coming_soon: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    # «Lo que aprenderas», con su orden. La columna existe en produccion desde
    # la 0013 y la app ya la escribe, asi que mapearla es seguro: `select(Course)`
    # la pide y esta ahi.
    #
    # NO SE DUPLICA. La 0034 podria haber anadido un `learning_outcomes` con el
    # mismo significado, y entonces la mitad de los cursos tendria sus puntos en
    # una columna y la mitad en la otra. Los resultados de aprendizaje son ESTO.
    #
    # Sin `server_default`: en PostgreSQL la columna ya lo trae de la 0013, y
    # declararlo aqui haria que SQLite (los tests) escribiera literalmente la
    # cadena '{}', que al releerla sale como diccionario y no como lista.
    highlights: Mapped[list[str]] = mapped_column(_LISTA_DE_TEXTO, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class CourseVersion(Base):
    """La fotografía inmutable de lo que un curso ofrecía al publicarse.

    POR QUÉ EXISTE. Hasta la 0050, editar un curso reescribía lo que alguien ya
    había comprado: la orden congelaba el importe y la moneda y nada más, así
    que no había forma de responder «¿qué compró exactamente esta persona?».
    El criterio A02 del blueprint —«la orden muestra la misma versión, garantía
    y precio aceptados»— no se podía cumplir.

    UN SOLO DOCUMENTO Y NO VEINTE COLUMNAS. El contenido comercialmente
    relevante vive repartido en tres sitios: `courses`, las columnas que añadió
    la 0034 y el temario. Y el temario NO TIENE NINGUNA MARCA TEMPORAL, así que
    no hay forma de reconstruirlo después: o se copia entero al publicar, o se
    pierde. Por eso `snapshot` es un documento.

    LO QUE NO GUARDA, y cada omisión es una decisión:

      * El precio. Es OFERTA, no contenido: cambiar el precio no puede
        invalidar el temario que alguien está viendo. Va en la orden.
      * El estado de revisión. Es un eje aparte y vive en `courses`.
      * Las rutas de los medios. Apuntan a Storage, que es mutable por fuera:
        guardarlas aquí sería prometer una inmutabilidad que no se tiene.
      * El cuerpo de las lecciones. Corregir una errata generaría una versión
        nueva y, con ella, ruido en las garantías vivas.
    """

    __tablename__ = "course_versions"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    course_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("courses.id", ondelete="CASCADE"), index=True
    )
    #: 1, 2, 3… por curso. Legible para una persona, a diferencia del uuid.
    version: Mapped[int] = mapped_column(Integer)
    #: `published` es la vigente; `superseded`, las anteriores.
    status: Mapped[str] = mapped_column(
        String(16), default="published", server_default="published"
    )
    #: SHA-256 del snapshot canónico. Republicar sin cambios no crea versión.
    content_hash: Mapped[str] = mapped_column(Text)
    snapshot: Mapped[dict] = mapped_column(_DOCUMENTO, default=dict)
    published_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    published_by: Mapped[str | None] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="SET NULL"), nullable=True
    )
    #: `publish` es una versión creada al publicar de verdad. `backfill` es una
    #: reconstruida del estado actual del curso: dice lo que el curso ES, no
    #: necesariamente lo que se vendió. La distinción no se debe borrar.
    origin: Mapped[str] = mapped_column(
        String(16), default="publish", server_default="publish"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("version >= 1", name="course_versions_version_positiva"),
        CheckConstraint(
            "status in ('published', 'superseded')", name="course_versions_status"
        ),
        CheckConstraint(
            "origin in ('publish', 'backfill')", name="course_versions_origin"
        ),
        Index("course_versions_numero_unico", "course_id", "version", unique=True),
        # UNA SOLA VIGENTE POR CURSO, y lo decide la base.
        #
        # `publish_course` lee, valida y escribe sin bloqueo: mientras solo
        # cambiaba `status` era inocuo, pero en cuanto publicar CREA una fila,
        # dos peticiones simultáneas crearían dos versiones vigentes. Un `if` en
        # Python no lo impide; este índice sí.
        Index(
            "course_versions_vigente_unica",
            "course_id",
            unique=True,
            postgresql_where=text("status = 'published'"),
            sqlite_where=text("status = 'published'"),
        ),
    )


class SavedCourse(Base):
    """Un curso guardado para después. Migración 0055."""

    __tablename__ = "saved_courses"

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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        Index("saved_courses_por_fecha", "user_id", "created_at"),
    )


class CourseReview(Base):
    """Valoración de un curso, de 1 a 5. Migración 0056.

    Vive aquí y no en `reviews/` porque `profile_reviews` valora personas: son
    dos cosas distintas con la misma palabra.

    NO guarda si la compra está verificada ni el promedio: los dos se derivan al
    leer. Guardarlos los dejaría obsoletos en cuanto alguien devuelve.
    """

    __tablename__ = "course_reviews"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=lambda: str(uuid4()))
    course_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("courses.id", ondelete="CASCADE"), index=True
    )
    user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE")
    )
    rating: Mapped[int] = mapped_column(Integer)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: 'visible' o 'hidden'. Moderar oculta; no borra.
    status: Mapped[str] = mapped_column(String(16), default="visible")
    #: Interno: no sale por ninguna respuesta pública.
    moderation_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        CheckConstraint("rating >= 1 and rating <= 5", name="course_reviews_rating"),
        CheckConstraint(
            "status in ('visible', 'hidden')", name="course_reviews_status"
        ),
        UniqueConstraint("user_id", "course_id", name="course_reviews_unica"),
        Index("course_reviews_por_curso", "course_id", "created_at"),
    )
