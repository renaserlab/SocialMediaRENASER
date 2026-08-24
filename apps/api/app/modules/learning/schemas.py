"""Esquemas de aprendizaje."""

from pydantic import BaseModel, ConfigDict, Field


class LessonRead(BaseModel):
    id: str
    title: str
    duration_seconds: int
    sort_order: int
    completed: bool = False
    # Ruta del video dentro de Storage. La columna existia desde 0001 pero no
    # se exponia, asi que la app no podia reproducir el video real de nadie.
    media_path: str | None = None
    #: Segundos vistos. Existia en la base desde 0001 y nadie lo devolvia, asi
    #: que el reproductor no tenia por donde retomar.
    progress_seconds: int = 0


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
    has_access: bool = False


class ModuleRead(BaseModel):
    id: str
    title: str
    sort_order: int
    lessons: list[LessonRead] = []


class CourseDetailRead(BaseModel):
    id: str
    #: Quien lo creo. Sin este campo la aplicacion no podia saber si quien mira
    #: es el autor, y acababa dando la gestion solo a la administracion.
    author_id: str
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
    modules: list[ModuleRead] = []


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
