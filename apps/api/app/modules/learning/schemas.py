"""Esquemas de aprendizaje."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class LessonRead(BaseModel):
    id: str
    title: str
    duration_seconds: int
    sort_order: int
    completed: bool = False
    # Ruta del video dentro de Storage. La columna existia desde 0001 pero no
    # se exponia, asi que la app no podia reproducir el video real de nadie.
    #
    # SOLO SE ENTREGA A QUIEN PUEDE VERLA: la leccion es muestra, o esta persona
    # tiene acceso al curso. No es la seguridad —esa es la RLS del bucket, que
    # sigue exigiendo `has_course_access` para firmar la URL— pero repartir la
    # ruta de todos los videos de un curso de pago a quien solo mira la ficha es
    # regalar informacion que no hace falta dar.
    media_path: str | None = None
    #: Si la leccion TIENE medio, se pueda entregar su ruta o no.
    #:
    #: Sin esto, esconder la ruta convertiria «no tienes acceso» en «esta
    #: leccion todavia no tiene video», que son dos cosas muy distintas delante
    #: de quien mira: la primera se resuelve comprando y la segunda esperando a
    #: que su autor lo suba. Decir cual es no regala nada.
    has_media: bool = False
    #: Segundos vistos. Existia en la base desde 0001 y nadie lo devolvia, asi
    #: que el reproductor no tenia por donde retomar.
    progress_seconds: int = 0
    #: `video` | `text` (0034). Sin la migracion, todas son de video, que es lo
    #: que hay hoy.
    kind: str = "video"
    #: Leccion abierta sin comprar. Sin la 0034 ninguna lo es.
    is_preview: bool = False


class LessonDetailRead(LessonRead):
    """Una leccion con su contexto, para abrirla por su propio id."""

    course_id: str
    course_title: str
    module_title: str
    #: La descripcion de la leccion (`course_lessons.body`). Se guardaba desde
    #: la app pero este endpoint no la devolvia, asi que quien la escribia veia
    #: «Sin descripción todavía» justo despues de guardarla.
    body: str = ""
    #: Si quien pregunta puede editar o borrar ESTA leccion: el autor del curso
    #: o la administracion. La pantalla la abre por su id sin conocer el curso,
    #: asi que sin este campo tendria que pedir el curso entero solo para saber
    #: si ensenar un boton.
    can_manage: bool = False
    #: Si tiene acceso al contenido de pago del curso al que pertenece.
    #:
    #: `kind` e `is_preview` los hereda de `LessonRead`: son de la leccion, no
    #: del contexto, y declararlos otra vez aqui seria un sitio mas donde
    #: cambiar el valor por defecto y olvidarse del otro.
    has_access: bool = False


class ModuleRead(BaseModel):
    id: str
    title: str
    sort_order: int
    #: De que va el bloque (0034). Un temario de titulos sueltos no explica
    #: nada; vacia mientras la migracion no este aplicada.
    description: str = ""
    lessons: list[LessonRead] = []


class CourseDetailRead(BaseModel):
    id: str
    #: Quien lo creo. Sin este campo la aplicacion no podia saber si quien mira
    #: es el autor, y acababa dando la gestion solo a la administracion.
    author_id: str
    #: Nombre y usuario del autor. Van en el detalle para no obligar a la
    #: ficha a pedir el perfil aparte solo para escribir «por Fulana».
    author_name: str | None = None
    author_username: str | None = None
    title: str
    description: str
    cover_path: str | None = None
    price_minor: int
    currency: str
    status: str
    coming_soon: bool = False
    topic_ids: list[str] = Field(default_factory=list)
    enrolled: bool = False
    #: Si esta persona puede ver el contenido de pago. Lo decide el servidor con
    #: la misma regla que `has_course_access()` en la base de datos. NO es la
    #: seguridad —esa es la RLS— sino lo que la interfaz necesita para no
    #: prometer un video que despues no va a cargar.
    has_access: bool = False
    #: Si esta persona puede editar el curso: su autor o la administracion. Lo
    #: decide el servidor y se vuelve a comprobar en cada escritura; aqui solo
    #: sirve para no ensenar botones que van a dar 403.
    can_manage: bool = False
    progress_percent: int = 0
    lessons_total: int = 0
    lessons_completed: int = 0
    #: La duracion del curso entero, sumada por el SERVIDOR. La aplicacion podia
    #: sumarla sola, pero entonces la ficha y la vista previa del asistente
    #: sumarian por su cuenta y un dia dirian cosas distintas.
    duration_seconds_total: int = 0
    modules: list[ModuleRead] = []

    # --- Ficha ampliada (0034). Vacia mientras la migracion no este puesta. ---
    subtitle: str | None = None
    promo_video_path: str | None = None
    primary_topic_id: str | None = None
    language: str = "es"
    level: str | None = None
    #: «Lo que aprenderas»: `courses.highlights` (0013), reutilizada.
    highlights: list[str] = Field(default_factory=list)
    target_audience: list[str] = Field(default_factory=list)
    prerequisites: list[str] = Field(default_factory=list)

    # --- Revision (0034). EJE APARTE de `status`, que es visibilidad. ---
    review_status: str = "draft"
    rejection_reason: str | None = None


class LessonProgressInput(BaseModel):
    """Lo que el reproductor informa. El servidor decide que hacer con ello."""

    #: Segundos vistos. El servidor los acota a la duracion real.
    progress_seconds: int = Field(ge=0, le=100_000_000)
    #: El reproductor llego al final. Es lo unico que el cliente sabe mejor que
    #: el servidor, asi que se acepta; todo lo demas se recalcula aqui.
    completed: bool = False


class LessonProgressRead(BaseModel):
    lesson_id: str
    progress_seconds: int
    completed: bool
    #: Si con esta leccion se termino el curso entero. Lo calcula el servidor
    #: recorriendo las lecciones, no lo declara el cliente.
    course_completed: bool = False
    course_progress_percent: int = 0


class MyCourseRead(BaseModel):
    """Un curso al que esta persona tiene acceso, con su avance."""

    id: str
    title: str
    description: str
    cover_path: str | None = None
    author_id: str
    price_minor: int
    currency: str
    status: str
    lessons_total: int = 0
    lessons_completed: int = 0
    progress_percent: int = 0
    #: `not_started` | `in_progress` | `completed`. Tres estados distintos que
    #: la biblioteca no puede mezclar: un curso terminado y uno sin empezar
    #: piden cosas opuestas de quien mira.
    state: str = "not_started"
    #: Primera leccion sin completar, para el boton «Continuar». `None` cuando
    #: el curso esta terminado o todavia no tiene contenido.
    next_lesson_id: str | None = None

    model_config = ConfigDict(from_attributes=True)


class CourseStudentRead(BaseModel):
    """Un estudiante, como lo ve el PROPIETARIO del curso.

    LO QUE NO SALE POR AQUI, y no sale por diseño: tarjeta, cuenta bancaria,
    identificadores de la pasarela, el motivo privado de una devolución, las
    notas internas de revisión y cualquier cosa de OTROS cursos. El propietario
    ve a quien compró el suyo y su avance, no un expediente de la persona.
    """

    id: str
    full_name: str = ""
    username: str | None = None
    avatar_path: str | None = None
    enrolled_at: datetime | None = None
    #: Por qué está en la lista: compra, curso gratuito, autor, administración.
    source: str = ""
    lessons_total: int = 0
    lessons_completed: int = 0
    progress_percent: int = 0
    #: `not_started` | `in_progress` | `completed`.
    state: str = "not_started"
    #: `active` | `revoked` | `none`. Quien devolvió sigue en la lista con el
    #: acceso retirado: borrarlo sería perder que compró.
    access_state: str = "none"
    #: Estado COMERCIAL, el único que el propietario necesita: si la venta
    #: sigue en pie, si está en revisión o si se devolvió. Sin el motivo.
    commercial_state: str = "none"
