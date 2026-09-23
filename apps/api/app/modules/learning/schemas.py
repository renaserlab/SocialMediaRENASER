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


class NotaCreate(BaseModel):
    """Lo único que el cliente manda al crear una nota.

    NO lleva `user_id`: lo pone el servidor con la sesión. Y no lleva la versión
    del curso: la resuelve el servidor mirando cuál está publicada, porque es
    una afirmación sobre qué se estudió.
    """

    body: str = Field(min_length=1, max_length=2000)
    #: El minuto del vídeo. `None` cuando el reproductor no da una posición
    #: real; nunca 0 por defecto, que diría «al principio».
    position_seconds: int | None = Field(default=None, ge=0)


class NotaUpdate(BaseModel):
    """Un PATCH cambia lo que trae; lo que no viene se queda como estaba."""

    body: str | None = Field(default=None, min_length=1, max_length=2000)
    position_seconds: int | None = Field(default=None, ge=0)


class NotaRead(BaseModel):
    id: str
    lesson_id: str
    course_id: str
    body: str
    position_seconds: int | None = None
    #: La versión que se estudiaba. `None` cuando el curso no tenía ninguna
    #: publicada al escribirla.
    course_version: int | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


# --------------------------------------------------------------------------- #
# Evaluación final (0058)
#
# DOS FAMILIAS DE ESQUEMAS, y la separación es la garantía: los de quien la
# escribe llevan `is_correct`; los de quien la responde NO LO DECLARAN, así que
# no hay forma de que se cuele por descuido al añadir un campo.
# --------------------------------------------------------------------------- #


class OpcionDeAutor(BaseModel):
    """Una alternativa, como la ve quien escribe la evaluación."""

    body: str = Field(min_length=1, max_length=300)
    is_correct: bool = False


class PreguntaDeAutor(BaseModel):
    prompt: str = Field(min_length=1, max_length=500)
    options: list[OpcionDeAutor] = Field(min_length=2, max_length=5)


class EvaluacionGuardada(BaseModel):
    """Lo que manda quien la escribe. Reemplaza la evaluación entera.

    Se guarda completa y no por trozos: media evaluación guardada —preguntas
    nuevas con las alternativas viejas— es peor que ninguna, y reconstruirla
    trozo a trozo pide una máquina de estados que nadie ha pedido.
    """

    title: str = Field(default="", max_length=200)
    pass_percent: int = Field(default=70, ge=1, le=100)
    questions: list[PreguntaDeAutor] = Field(default_factory=list, max_length=50)


class OpcionDeAutorRead(OpcionDeAutor):
    id: str


class PreguntaDeAutorRead(BaseModel):
    id: str
    prompt: str
    sort_order: int
    options: list[OpcionDeAutorRead] = []


class EvaluacionDeAutorRead(BaseModel):
    """El borrador, CON las respuestas correctas. Solo para quien gestiona."""

    id: str
    course_id: str
    title: str = ""
    pass_percent: int = 70
    status: str = "draft"
    questions: list[PreguntaDeAutorRead] = []
    #: Por qué todavía no se puede publicar, o `None`. Se calcula al leer para
    #: que la pantalla lo diga antes de que alguien toque «Publicar».
    blocking_reason: str | None = None


class OpcionRead(BaseModel):
    """Una alternativa, como la ve quien responde. SIN `is_correct`."""

    id: str
    body: str


class PreguntaRead(BaseModel):
    id: str
    prompt: str
    sort_order: int
    options: list[OpcionRead] = []


class IntentoRead(BaseModel):
    id: str
    status: str
    #: Nula mientras no se envía: un 0 diría «lo hizo y sacó cero».
    score_percent: int | None = None
    passed: bool | None = None
    started_at: datetime
    submitted_at: datetime | None = None
    course_version: int | None = None


class EvaluacionRead(BaseModel):
    """La evaluación publicada, como la ve el alumno."""

    id: str
    course_id: str
    title: str = ""
    pass_percent: int = 70
    questions: list[PreguntaRead] = []
    #: El intento abierto, si lo hay. Es lo que permite retomar sin perder nada.
    open_attempt: IntentoRead | None = None
    #: El mejor resultado enviado. Es el que cuenta para terminar el curso.
    best_attempt: IntentoRead | None = None


class RespuestaEnviada(BaseModel):
    question_id: str
    option_id: str


class EnvioDeIntento(BaseModel):
    """Lo que manda el alumno al enviar.

    NO lleva nota ni `passed`: los calcula el servidor. Un cliente que pudiera
    declarar su propia nota convertiría el certificado en un adorno.
    """

    answers: list[RespuestaEnviada] = Field(default_factory=list, max_length=50)


# --------------------------------------------------------------------------- #
# Finalización y certificado (0059)
# --------------------------------------------------------------------------- #


class FinalizacionRead(BaseModel):
    """El estado de finalización de un curso, calculado por el SERVIDOR."""

    course_id: str
    course_title: str = ""
    lessons_total: int = 0
    lessons_completed: int = 0
    progress_percent: int = 0
    #: Si el curso tiene evaluación final publicada.
    quiz_required: bool = False
    quiz_best_score: int | None = None
    quiz_passed: bool = False
    completed: bool = False
    #: Cuándo se terminó. `None` si no está terminado o falta la 0059.
    completed_at: datetime | None = None
    #: El código público del certificado, si ya se emitió.
    certificate_public_id: str | None = None


class MotivoDeRevocacion(BaseModel):
    """Por qué se revoca. Obligatorio: revocar sin motivo no se puede auditar."""

    reason: str = Field(min_length=3, max_length=500)


class CertificadoRead(BaseModel):
    """El certificado de quien lo obtuvo."""

    public_id: str
    course_id: str
    course_title: str
    display_name: str
    author_name: str = ""
    course_version: int | None = None
    completed_at: datetime
    issued_at: datetime
    status: str = "valid"
    #: La dirección de la verificación pública. La compone el servidor: el
    #: teléfono no sabe en qué dominio vive.
    verify_url: str


class VerificacionPublicaRead(BaseModel):
    """Lo que ve CUALQUIERA con el código. Sin sesión.

    LO QUE NO LLEVA: correo, identificador de usuario, orden, importe ni
    referencia de pago. Y no lleva `course_id` tampoco: no hace falta para
    verificar y es un identificador interno más.
    """

    public_id: str
    display_name: str
    course_title: str
    author_name: str = ""
    course_version: int | None = None
    completed_at: datetime
    issued_at: datetime
    #: 'valid' o 'revoked'. Un código que no existe responde 404, no `false`.
    status: str
