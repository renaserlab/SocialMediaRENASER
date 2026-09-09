"""Esquemas Pydantic del catalogo (lecturas publicas en Fase 1)."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

#: Nivel del curso. Los mismos tres valores que el CHECK de la 0034.
NIVEL = "^(beginner|intermediate|advanced)$"
#: Idioma en codigo ISO 639-1 (dos letras minusculas). No se admite `es-PE`:
#: mezclar idioma y region en la misma columna acaba con «es», «es-PE» y
#: «es_pe» significando lo mismo y sin forma de agruparlos.
IDIOMA = "^[a-z]{2}$"

#: Tope de frases en cada lista de la ficha. No es una regla de negocio: es lo
#: que impide que un cliente mal escrito guarde diez mil lineas en una columna
#: que se pinta entera en la pantalla del curso.
MAX_FRASES = 12
MAX_FRASE = 200

#: Los tipos de leccion que la interfaz sabe pintar. TIENE QUE DECIR LO MISMO
#: que `cursos_v2.TIPOS_DE_LECCION` y que el CHECK de la 0034: una leccion de un
#: tipo que ninguna pantalla sabe abrir es una leccion rota, no una funcion
#: adelantada.
TIPO_DE_LECCION = "^(video|text)$"


class _FichaDeCursoV2(BaseModel):
    """Los metadatos que anade la 0034. Todos opcionales, en alta y en edicion.

    Sin la migracion aplicada se aceptan igual y NO se guardan: el resto del
    curso (titulo, descripcion, precio, temas) se guarda como siempre. Un campo
    que todavia no tiene donde vivir no puede impedir editar el titulo.
    """

    #: Una linea bajo el titulo. Antes se recortaba la descripcion y salia a
    #: medias, con la frase cortada por donde tocara.
    subtitle: str | None = Field(default=None, max_length=200)
    #: Ruta en `course-media` del video de presentacion. NO es una leccion: no
    #: cuenta para la duracion ni para el progreso.
    promo_video_path: str | None = Field(default=None, max_length=500)
    #: Categoria principal: uno de los temas de `topics` (0026). Los demas
    #: siguen en `topic_ids` / `course_topics`.
    primary_topic_id: str | None = None
    language: str | None = Field(default=None, pattern=IDIOMA)
    level: str | None = Field(default=None, pattern=NIVEL)
    #: Para quien es el curso.
    target_audience: list[str] | None = Field(default=None, max_length=MAX_FRASES)
    #: Que hace falta saber antes de empezarlo.
    prerequisites: list[str] | None = Field(default=None, max_length=MAX_FRASES)
    #: «Lo que aprenderas». Es `courses.highlights` (0013), NO una columna
    #: nueva: los puntos que ya escribieron los cursos existentes son estos.
    #: Presente REEMPLAZA la lista entera; ausente la deja como esta.
    highlights: list[str] | None = Field(default=None, max_length=MAX_FRASES)


class EventCreate(BaseModel):
    """Alta de evento. Solo para administradores."""

    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    #: Fecha y hora de inicio, ya combinadas por el cliente. Opcional: hay
    #: eventos anunciados "por confirmar".
    starts_at: datetime | None = None
    #: Fin del evento; permite mostrar rangos ("25-26 de agosto").
    ends_at: datetime | None = None
    location: str | None = Field(default=None, max_length=200)
    #: Ruta de la portada en Storage (no una URL): igual que avatar_path.
    cover_path: str | None = Field(default=None, max_length=500)
    #: Invitacion al grupo de WhatsApp del evento.
    whatsapp_url: str | None = Field(default=None, max_length=500)
    #: Valores admitidos por el CHECK de la tabla (0001_initial.sql). No usar
    #: otros: la fila se rechaza con `events_event_type_check`.
    event_type: str = Field(default="presential", pattern="^(online|presential|live)$")


class _PrecioDeCurso(BaseModel):
    """El precio, en la unidad que la base de datos guarda de verdad.

    POR QUE CAMBIA EL CONTRATO. Antes se recibia `price` en la unidad MAYOR
    (soles enteros) y el servidor multiplicaba por 100. Con ese contrato
    «49.90» no se podia expresar: llegaba como 49 y se guardaba 4900, cuarenta
    y nueve soles exactos. Un precio que el creador escribe y el sistema cambia
    en silencio no es un precio, es un error esperando a que alguien compre.

    `price` se sigue aceptando para no romper a los clientes que ya estan
    instalados, pero `price_minor` manda si vienen los dos.
    """

    #: Centavos. 4990 = S/ 49.90. Nunca decimales: en dinero, un flotante es
    #: un descuadre con fecha.
    price_minor: int | None = Field(default=None, ge=0, le=100_000_000)
    #: OBSOLETO: unidad mayor, sin centavos. Se mantiene por compatibilidad.
    price: int | None = Field(default=None, ge=0)

    def centavos(self, por_defecto: int | None = None) -> int | None:
        """El precio en centavos, o `None` si el cliente no menciono ninguno."""
        if self.price_minor is not None:
            return self.price_minor
        if self.price is not None:
            return self.price * 100
        return por_defecto


class CourseCreate(_PrecioDeCurso, _FichaDeCursoV2):
    """Alta de curso. La crea su autor; nace como BORRADOR."""

    title: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=2000)
    cover_path: str | None = Field(default=None, max_length=500)
    currency: str = Field(default="PEN", pattern="^[A-Z]{3}$")
    #: Temas del catalogo comun (`topics`, migracion 0026). Opcional al crear
    #: —se puede rellenar despues— pero obligatorio para publicar.
    topic_ids: list[str] = Field(default_factory=list)


class EventUpdate(BaseModel):
    """Edicion de evento. Solo administradores; todos los campos opcionales."""

    title: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    location: str | None = Field(default=None, max_length=200)
    cover_path: str | None = Field(default=None, max_length=500)
    whatsapp_url: str | None = Field(default=None, max_length=500)
    event_type: str | None = Field(default=None, pattern="^(online|presential|live)$")


class CourseUpdate(_PrecioDeCurso, _FichaDeCursoV2):
    """Edicion de curso. Su autor o la administracion; todo opcional."""

    title: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    cover_path: str | None = Field(default=None, max_length=500)
    currency: str | None = Field(default=None, pattern="^[A-Z]{3}$")
    #: Anunciado pero todavia sin contenido. NO es lo mismo que borrador: un
    #: borrador no lo ve nadie mas que su autor (migracion 0014).
    coming_soon: bool | None = None
    #: Ausente deja los temas como estan; presente los REEMPLAZA.
    topic_ids: list[str] | None = None
    #: `status` NO se toca por aqui a proposito: publicar tiene validaciones
    #: propias y vive en /publish y /unpublish.


class EventRead(BaseModel):
    id: str
    organizer_id: str
    #: Nombre y usuario de quien organiza. Van aquí para que la ficha no tenga
    #: que pedir el perfil aparte solo para escribir «organiza Fulana». Vacíos
    #: cuando el perfil no está: NO se inventa un nombre.
    organizer_name: str = ""
    organizer_username: str = ""
    title: str
    description: str
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    location: str | None = None
    cover_path: str | None = None
    whatsapp_url: str | None = None
    event_type: str
    status: str
    capacity: int | None = None
    registrations_count: int = 0
    reserved_by_me: bool = False
    #: `upcoming`, `past` o `undated`, resuelto contra `starts_at` / `ends_at`
    #: en el momento de responder (ver `catalog/eventos.py`).
    #:
    #: Viaja aunque el cliente haya pedido un solo grupo: así la pantalla puede
    #: decir «finalizado» sin recalcular nada, y sobre todo sin comparar el
    #: texto de la fecha ya formateada, que es lo que no se puede hacer.
    #:
    #: `upcoming` por defecto SOLO para que el esquema tenga un valor de
    #: respaldo; el router siempre lo escribe.
    time_state: str = "upcoming"

    model_config = ConfigDict(from_attributes=True)


class CourseRead(BaseModel):
    id: str
    author_id: str
    title: str
    description: str
    cover_path: str | None = None
    price_minor: int
    currency: str
    status: str
    coming_soon: bool = False
    #: Vacio mientras la migracion 0028 no este aplicada: la tabla no existe y
    #: se dice «ninguno», que es la verdad, en lugar de fallar.
    topic_ids: list[str] = Field(default_factory=list)

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
    submitted_at: datetime | None = None
    reviewed_at: datetime | None = None
    rejection_reason: str | None = None

    model_config = ConfigDict(from_attributes=True)


class CoursePublishResult(BaseModel):
    """Resultado de intentar publicar, con lo que falta si no se pudo."""

    id: str
    status: str
    published: bool
    #: Frases para ensenar tal cual. Vacio cuando se publico.
    #:
    #: NO se anade aqui el estado de revision, aunque publicar dependa de el:
    #: este cuerpo es un contrato que ya consumen clientes instalados, y donde
    #: mejor se lee la revision es en el propio curso (`CourseRead`) y en
    #: `/requirements`. Un dato repetido en tres sitios es un dato que un dia
    #: dice tres cosas.
    missing: list[str] = Field(default_factory=list)


class CourseRequirements(BaseModel):
    """Que le falta a un curso para poder publicarse. Sin cambiar nada.

    Lo pide el paso «revisar y enviar» del asistente para pintar la lista de
    pendientes ANTES de que alguien pulse nada. Las reglas son las mismas que
    aplica el servidor al publicar, leidas del mismo sitio: repetirlas en la
    aplicacion garantiza que un dia digan cosas distintas.
    """

    id: str
    status: str
    review_status: str
    ready: bool
    missing: list[str] = Field(default_factory=list)
    #: Si esta base sabe de revision. Sin la 0034 no hay a quien enviar nada y
    #: la pantalla ensena «Publicar» en vez de «Enviar a revisión».
    review_available: bool = False


class CourseSubmitResult(BaseModel):
    """Resultado de pedir revision, con lo que falta si no se pudo pedir."""

    id: str
    review_status: str
    submitted: bool
    missing: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# El temario: modulos y lecciones.
#
# NINGUNA ALTA ACEPTA `sort_order`, y es la decision que ordena todo el bloque.
# Lo elegia el cliente, y dos elementos con el mismo numero dejan el temario a
# merced de como devuelva las filas la base: el alumno ve las lecciones bailar
# entre dos cargas de la misma pantalla. Crear anade AL FINAL y el orden se
# cambia en un solo sitio (`/reorder`), que reescribe la lista entera.
# --------------------------------------------------------------------------- #


class CourseModuleCreate(BaseModel):
    """Alta de un modulo. Se anade al final del temario."""

    title: str = Field(min_length=1, max_length=160)
    #: De que va el bloque (0034). Sin la migracion se acepta y NO se guarda,
    #: igual que el resto de la ficha ampliada: un campo que todavia no tiene
    #: donde vivir no puede impedir crear el modulo.
    description: str = Field(default="", max_length=2000)


class CourseModuleUpdate(BaseModel):
    """Edicion de un modulo. Renombrar es esto con `title` y nada mas.

    Todo opcional: lo que no viaja no se toca. Sin `exclude_unset` en el router,
    cambiar el titulo borraria la descripcion.
    """

    title: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)


class CourseModuleRead(BaseModel):
    id: str
    course_id: str
    title: str
    #: Vacia mientras la 0034 no este aplicada. Es la verdad, no un error.
    description: str = ""
    sort_order: int


class CourseLessonCreate(BaseModel):
    """Alta de una leccion dentro de un modulo. Se anade al final."""

    title: str = Field(min_length=1, max_length=160)
    #: El cuerpo de la leccion. En una de tipo `text` es el contenido entero,
    #: por eso el tope es alto y no el de una descripcion.
    body: str = Field(default="", max_length=20_000)
    #: Ruta en `course-media`, NO una URL: la URL se firma al reproducir y
    #: caduca. Guardar una firma seria guardar algo que manana no vale.
    media_path: str | None = Field(default=None, max_length=500)
    #: Un dia entero de tope. No es una regla de negocio: una leccion de mas de
    #: veinticuatro horas es un cliente que mando milisegundos, y ese numero se
    #: suma en la duracion que se ensena en la ficha del curso.
    duration_seconds: int = Field(default=0, ge=0, le=86_400)
    #: `video` o `text` (0034). Sin la migracion se acepta y no se guarda: hoy
    #: todas son de video, que es lo que hay.
    kind: str = Field(default="video", pattern=TIPO_DE_LECCION)
    #: Leccion abierta sin comprar. DECIDE QUE SE VE SIN PAGAR, asi que entra en
    #: la fotografia de la version: convertir en muestra la unica leccion de
    #: pago de un curso ya vendido cambia el producto.
    is_preview: bool = False


class CourseLessonUpdate(BaseModel):
    """Edicion de una leccion. Todo opcional; lo que no viaja no se toca.

    `media_path` en `null` SI borra la ruta: es la unica forma de quitar un
    video, y por eso el router distingue «no enviado» de «enviado vacio».
    """

    title: str | None = Field(default=None, min_length=1, max_length=160)
    body: str | None = Field(default=None, max_length=20_000)
    media_path: str | None = Field(default=None, max_length=500)
    duration_seconds: int | None = Field(default=None, ge=0, le=86_400)
    kind: str | None = Field(default=None, pattern=TIPO_DE_LECCION)
    is_preview: bool | None = None


class CourseLessonRead(BaseModel):
    id: str
    module_id: str
    title: str
    body: str = ""
    media_path: str | None = None
    duration_seconds: int
    sort_order: int
    #: Sin la 0034 todas son de video y NINGUNA es muestra. Es exactamente lo
    #: que hay hoy, y ademas es el lado seguro: una leccion que no consta como
    #: muestra no entrega su video sin acceso.
    kind: str = "video"
    is_preview: bool = False


#: Tope de elementos en una reordenacion. Es el mismo numero para modulos y
#: lecciones porque protege de lo mismo: un cuerpo enorme que hay que recorrer
#: entero antes de poder rechazarlo.
MAX_ELEMENTOS_ORDENADOS = 500


class CourseOrder(BaseModel):
    """El orden nuevo: la lista COMPLETA de ids, en el orden que van a quedar.

    Es la lista entera y no «el que se movio»: ver `contenido.exigir_orden_completo`.
    """

    ids: list[str] = Field(min_length=1, max_length=MAX_ELEMENTOS_ORDENADOS)


class CourseReviewDecision(BaseModel):
    """La decision de administracion sobre un curso en revision."""

    #: `approve` o `reject`. Un tercer valor no existe: dejarlo a medias es
    #: exactamente lo que hace que una cola de revision no se vacie nunca.
    decision: str = Field(pattern="^(approve|reject)$")
    #: Obligatorio al rechazar. Un «no» sin motivo es un muro sin puerta: quien
    #: lo recibe no sabe que corregir y vuelve a enviar lo mismo.
    reason: str | None = Field(default=None, max_length=1000)


# ---------------------------------------------------------------------------
# Valoraciones de cursos (migración 0056)
# ---------------------------------------------------------------------------


class ValoracionCreate(BaseModel):
    """Lo único que el cliente puede mandar.

    NO lleva `verified`: eso lo decide el servidor mirando la compra. Un cliente
    que pudiera marcarse como verificado convertiría la etiqueta en un adorno.
    """

    rating: int = Field(ge=1, le=5)
    comment: str | None = Field(default=None, max_length=2000)


class ValoracionUpdate(BaseModel):
    """Un PATCH cambia lo que trae; lo que no viene se queda como estaba.

    Con el esquema de creación, subir la puntuación sin reenviar el texto lo
    borraba en silencio.
    """

    rating: int | None = Field(default=None, ge=1, le=5)
    comment: str | None = Field(default=None, max_length=2000)


class ValoracionRead(BaseModel):
    id: str
    course_id: str
    rating: int
    comment: str | None = None
    created_at: datetime
    updated_at: datetime
    #: Perfil público mínimo de quien valora.
    author_id: str
    author_name: str = ""
    author_username: str = ""
    #: Calculada por el servidor: compró y su acceso sigue vivo.
    verified_purchase: bool = False
    #: Solo la ve quien la escribió, para poder editarla.
    is_mine: bool = False
    #: Moderada. Solo puede llegar a `True` en la propia: el listado no devuelve
    #: las ocultas de otros. Sin esto, quien la escribió la ve publicada.
    hidden: bool = False


class ResumenDeValoraciones(BaseModel):
    #: `None` cuando no hay ninguna. NO es 0: un 0,0 diría que está mal valorado.
    average: float | None = None
    total: int = 0
    #: Cuántas de cada puntuación, de "1" a "5".
    distribution: dict[str, int] = Field(default_factory=dict)
