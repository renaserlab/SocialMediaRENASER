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


class CourseReviewDecision(BaseModel):
    """La decision de administracion sobre un curso en revision."""

    #: `approve` o `reject`. Un tercer valor no existe: dejarlo a medias es
    #: exactamente lo que hace que una cola de revision no se vacie nunca.
    decision: str = Field(pattern="^(approve|reject)$")
    #: Obligatorio al rechazar. Un «no» sin motivo es un muro sin puerta: quien
    #: lo recibe no sabe que corregir y vuelve a enviar lo mismo.
    reason: str | None = Field(default=None, max_length=1000)
