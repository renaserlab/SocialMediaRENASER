"""Modelos de las resenas entre personas.

Mapean public.profile_reviews y public.review_media de la migracion 0030.

POR QUE NO SE REUTILIZA `testimonials`. Esa tabla es la galeria de fotos y
videos de UN autor: el archivo es obligatorio, el texto opcional y no hay
ninguna columna que diga sobre quien se opina. Con esa forma, lo que A escribia
salia en el perfil de A, que es una publicacion y no una resena. `testimonials`
se conserva intacta —tiene contenido real— y esto es lo que faltaba.

CADA COLUMNA DE AQUI EXISTE EN LA 0030, Y AL REVES. No es una coincidencia que
haya que mantener: `select(ProfileReview)` pide TODAS las columnas del modelo y
`db.add(ProfileReview(...))` las inserta todas, asi que una columna de mas aqui
—o de menos alli— revienta contra la base real aunque en SQLite pase de largo.
"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.database import Base


def _uuid() -> str:
    return str(uuid4())


class ProfileReview(Base):
    """Lo que UNA persona opina de OTRA. Sale en el perfil de la opinada."""

    __tablename__ = "profile_reviews"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)

    #: Quien escribe. Nombres explicitos, igual que en `bookings`: con `user_a`
    #: y `user_b` cualquier consulta futura tendria que adivinar quien opina, y
    #: adivinar mal aqui invierte el sentido de la frase entera.
    reviewer_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )
    #: Sobre quien. Es la columna que `testimonials` no tenia, y su falta era el
    #: motivo de que una resena no pudiera existir.
    reviewed_user_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False), ForeignKey("profiles.id", ondelete="CASCADE"), index=True
    )

    #: El texto, OBLIGATORIO. Es lo contrario que en `testimonials`, donde lo
    #: obligatorio era el archivo: una resena sin palabras es una foto.
    body: Mapped[str] = mapped_column(Text)

    #: `published` | `hidden` | `removed`. CHECK en la base, no un enum de
    #: Postgres: ampliar un CHECK es una linea y ampliar un enum arrastra su
    #: propia migracion.
    status: Mapped[str] = mapped_column(
        String(16), default="published", server_default="published"
    )

    #: De donde sale el sello de interaccion verificada: `booking` o `course`.
    #: NULL cuando no hay constancia, que es la mayoria de las veces y no resta
    #: nada a la resena. Se guarda la FUENTE y no un booleano para que el sello
    #: siempre se pueda justificar. Ver `verificacion.py`.
    verified_source: Mapped[str | None] = mapped_column(String(16), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ReviewMedia(Base):
    """Una foto o un video que ACOMPANA a una resena. Siempre opcional."""

    __tablename__ = "review_media"

    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True, default=_uuid)
    review_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profile_reviews.id", ondelete="CASCADE"),
        index=True,
    )
    #: La RUTA dentro del bucket `post-media`, no la URL: las firmas caducan y
    #: la ruta no. Tiene que empezar por la carpeta de quien sube (`<uid>/...`)
    #: o la politica de Storage la rechaza; se comprueba en el router.
    storage_path: Mapped[str] = mapped_column(Text)
    media_type: Mapped[str] = mapped_column(String(16))  # image|video
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ReviewCourse(Base):
    """De que curso habla una resena (migracion 0041). SIEMPRE opcional.

    TABLA NUEVA Y NINGUNA COLUMNA NUEVA EN `profile_reviews`, a proposito y por
    la misma razon que explican `MessageAttachment` (0033) y
    `DirectConversationPair` (0039): `select(ProfileReview)` pide TODAS las
    columnas mapeadas y `db.get` tambien, asi que anadir `course_id` al modelo
    de arriba haria que los cinco sitios que leen resenas pidieran una columna
    que la base real no tiene mientras la 0041 espera aprobacion. Cada listado
    respondia 500, y un 500 sin cabeceras CORS se lee en el navegador como un
    fallo de red: horas buscando en el sitio equivocado.

    Es lo que ya avisa el comentario de cabecera de este fichero: CADA COLUMNA
    DE AQUI EXISTE EN LA 0030, Y AL REVES.

    `review_id` es la CLAVE PRIMARIA, no una columna mas: una resena habla como
    mucho de un curso. Sin eso haria falta un indice unico aparte para impedir
    que la misma resena acabara enlazada a tres cursos distintos.

    «Opcional» se expresa como AUSENCIA DE FILA y no como una columna nullable,
    que es mas estricto: no existe el estado intermedio «hay enlace, pero apunta
    a nada».
    """

    __tablename__ = "review_course"

    review_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("profile_reviews.id", ondelete="CASCADE"),
        primary_key=True,
    )
    #: El curso. Si el curso desaparece se va el ENLACE, nunca la resena: el
    #: texto sigue siendo la opinion de alguien.
    course_id: Mapped[str] = mapped_column(
        Uuid(as_uuid=False),
        ForeignKey("courses.id", ondelete="CASCADE"),
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
