"""Endpoints del catálogo: eventos (con reservas) y cursos (lista)."""

from fastapi import APIRouter, Depends, status
from sqlalchemy import func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationAppError,
)
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.catalog import cursos_v2, esquema
from app.modules.catalog.models import Course, Event, EventRegistration
from app.modules.catalog.schemas import (
    CoursePublishResult,
    CourseCreate,
    CourseRead,
    CourseRequirements,
    CourseReviewDecision,
    CourseSubmitResult,
    CourseUpdate,
    EventCreate,
    EventRead,
    EventUpdate,
)
from app.modules.learning.models import CourseLesson, CourseModule
from app.modules.recommendations import temas_de_curso
from app.modules.recommendations.models import CourseTopic
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.pagination import Page, pagination_params
from app.shared.permissions import require_admin, require_owner_or_admin

router = APIRouter(prefix="/catalog", tags=["catalog"])


@router.post("/events", response_model=EventRead, status_code=status.HTTP_201_CREATED)
async def create_event(
    payload: EventCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EventRead:
    """Publica un evento o una cita. Queda a nombre de quien lo organiza.

    Lo que protege esto de verdad es el servidor, no la interfaz: que la app
    oculte un boton no impide llamar al endpoint a mano. Por eso editar sigue
    comprobandose aqui contra el organizador.
    """
    event = Event(
        organizer_id=current_user.id,
        title=payload.title,
        description=payload.description,
        starts_at=payload.starts_at,
        ends_at=payload.ends_at,
        location=payload.location,
        cover_path=payload.cover_path,
        whatsapp_url=payload.whatsapp_url,
        event_type=payload.event_type,
        status="published",
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return _to_event_read(event, 0, 0)


@router.patch("/events/{event_id}", response_model=EventRead)
async def update_event(
    event_id: str,
    payload: EventUpdate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EventRead:
    ensure_uuid(event_id, "Evento no encontrado.")
    event = await db.get(Event, event_id)
    if event is None:
        raise NotFoundError("Evento no encontrado.")
    await require_owner_or_admin(
        db, event.organizer_id, current_user, "No puedes editar este evento."
    )
    # `exclude_unset` distingue "no enviado" de "enviado vacio", igual que en
    # el perfil: sin ello, editar el titulo borraria el resto de campos.
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(event, field, value)
    await db.commit()
    await db.refresh(event)
    return _to_event_read(event, 0, 0)


@router.patch("/courses/{course_id}", response_model=CourseRead)
async def update_course(
    course_id: str,
    payload: CourseUpdate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CourseRead:
    ensure_uuid(course_id, "Curso no encontrado.")
    course = await db.get(Course, course_id)
    if course is None:
        raise NotFoundError("Curso no encontrado.")
    await require_owner_or_admin(
        db, course.author_id, current_user, "No puedes editar este curso."
    )
    data = payload.model_dump(exclude_unset=True)

    # El precio se resuelve aparte porque llega por dos nombres: `price_minor`
    # (el bueno) y `price` (el viejo, en unidad mayor). Si vienen los dos manda
    # el primero. Si no viene ninguno, no se toca.
    centavos = payload.centavos()
    data.pop("price_minor", None)
    data.pop("price", None)
    if centavos is not None:
        course.price_minor = centavos

    temas = data.pop("topic_ids", None)
    ficha = {k: data.pop(k) for k in cursos_v2.CAMPOS_EDITABLES if k in data}
    if "highlights" in data:
        # `highlights` SI esta mapeada en el ORM (existe desde la 0013), asi que
        # se guarda por el camino de siempre. Va aparte solo para limpiarla.
        data["highlights"] = _frases(data["highlights"])

    # La categoria principal se lee de la ficha ACTUAL cuando el cliente no la
    # menciona: hace falta para saber cual de las filas de `course_topics` era
    # la suya y no confundirla con un tema mas del autor.
    anterior = (await cursos_v2.leer_una(db, course.id)).primary_topic_id
    toca_la_categoria = "primary_topic_id" in ficha
    principal = (
        await _tema_principal_valido(db, ficha) if toca_la_categoria else anterior
    )

    for field, value in data.items():
        setattr(course, field, value)

    if temas is not None or toca_la_categoria:
        await _guardar_temas(
            db,
            course_id=course.id,
            autor_id=course.author_id,
            principal=principal,
            principal_anterior=anterior,
            elegidos=temas,
        )
    if ficha:
        await cursos_v2.guardar(db, course.id, _ficha_limpia(ficha))

    await db.commit()
    await db.refresh(course)
    return await _leer_curso(db, course)


@router.post("/courses", response_model=CourseRead, status_code=status.HTTP_201_CREATED)
async def create_course(
    payload: CourseCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CourseRead:
    """Crea la ficha de un curso. Nace como BORRADOR, a nombre de quien lo crea.

    POR QUE BORRADOR Y NO PUBLICADO. Antes esta llamada escribia
    `status='published'` directamente, asi que rellenar el titulo y el precio
    publicaba en el catalogo un curso sin un solo modulo. Quien lo creo no habia
    dicho «ya esta»: habia dicho «voy a empezar». Publicar es una decision
    aparte y tiene su propio endpoint, con validaciones que corren en el
    servidor.

    El autor ve su borrador desde el primer segundo en `/catalog/courses/mine`;
    el resto del mundo no lo ve en ningun sitio, ni en el catalogo ni en las
    recomendaciones. Eso ya lo garantiza tambien la RLS (`courses_read`, 0001).
    """
    ficha = {
        campo: getattr(payload, campo)
        for campo in cursos_v2.CAMPOS_EDITABLES
        if getattr(payload, campo) is not None
    }
    principal = await _tema_principal_valido(db, ficha)

    course = Course(
        author_id=current_user.id,
        title=payload.title,
        description=payload.description,
        cover_path=payload.cover_path,
        price_minor=payload.centavos(0) or 0,
        currency=payload.currency,
        status="draft",
        highlights=_frases(payload.highlights or []),
    )
    db.add(course)
    await db.flush()
    if payload.topic_ids or principal:
        await _guardar_temas(
            db,
            course_id=course.id,
            autor_id=current_user.id,
            principal=principal,
            principal_anterior=None,
            elegidos=payload.topic_ids,
        )
    if ficha:
        await cursos_v2.guardar(db, course.id, _ficha_limpia(ficha))
    await db.commit()
    await db.refresh(course)
    return await _leer_curso(db, course)


def _frases(valores: list[str] | None) -> list[str]:
    """Deja las frases que dicen algo, sin espacios sueltos ni duplicados.

    Un punto vacio en «lo que aprenderas» se pinta como una vineta sin texto y
    parece un fallo de la aplicacion. Se limpia al escribir y no al leer,
    porque lo que se guarda es lo que despues se ensena.
    """
    limpias = [v.strip() for v in (valores or []) if v and v.strip()]
    return list(dict.fromkeys(limpias))


def _ficha_limpia(ficha: dict) -> dict:
    """Las listas de la ficha, ya limpias. El resto pasa tal cual."""
    salida = dict(ficha)
    for campo in ("target_audience", "prerequisites"):
        if campo in salida:
            salida[campo] = _frases(salida[campo])
    return salida


async def _tema_principal_valido(db: AsyncSession, ficha: dict) -> str | None:
    """Comprueba que la categoria principal existe y sigue activa.

    Se valida ANTES de escribir nada: aceptar un id inventado dejaria una clave
    foranea rota a mitad de la transaccion, y en PostgreSQL eso se lleva por
    delante la edicion entera del curso.
    """
    principal = ficha.get("primary_topic_id")
    if not principal:
        return None
    await temas_de_curso.validar(db, [principal])
    return principal


async def _guardar_temas(
    db: AsyncSession,
    *,
    course_id: str,
    autor_id: str,
    principal: str | None,
    principal_anterior: str | None,
    elegidos: list[str] | None,
) -> None:
    """Deja el curso con su categoria principal MAS los temas que eligio su autor.

    POR QUE LA PRINCIPAL TAMBIEN SE ESCRIBE EN `course_topics`. Esa tabla (0028)
    es lo que lee el recomendador; si la categoria principal viviera solo en
    `primary_topic_id`, un curso quedaria clasificado en todo MENOS en lo que de
    verdad trata. La tabla dice DE QUE trata y la columna cual de esos temas
    manda.

    POR QUE NO DESCUENTA DEL TOPE. Son 1 + 5, no 5 en total: la principal es la
    categoria y los cinco son «el resto». Haciendola contar, elegir categoria
    dejaba al autor con cuatro huecos en vez de cinco, y ademas sin poder saber
    por que se le habia encogido la lista.

    POR QUE SE ESCRIBE ESA FILA AQUI Y NO EN `temas_de_curso.fijar`. Porque
    `fijar` aplica `MAX_TEMAS_POR_CURSO` a TODO lo que recibe, y ese modulo es
    del recomendador. Los cinco del autor pasan por el —con su validacion y su
    tope intactos— y la principal, que ya se valido aparte, se anade despues.
    El dia que `fijar` sepa de categorias principales, esto son dos lineas menos.

    QUE SE TOCA Y QUE NO. `elegidos = None` significa «el cliente no habla de
    temas»: se conservan los que ya tenia (sin la principal ANTERIOR, que se
    escribe aparte) y solo se cambia la categoria. Sin eso, elegir categoria en
    el asistente vaciaba la clasificacion del curso sin que nadie lo pidiera.
    """
    if not await temas_de_curso.disponible(db):
        # Sin la 0028 no hay donde guardarlos. El curso se crea y se edita
        # igual: que no se pueda clasificar no puede impedir editar el titulo.
        return

    if elegidos is None:
        actuales = (await temas_de_curso.leer(db, [course_id])).get(course_id, [])
        elegidos = [t for t in actuales if t != principal_anterior]

    # Los del autor pasan por la validacion de siempre: existen, siguen activos
    # y no son mas de cinco. La principal no viaja en esta lista.
    del_autor = [t for t in elegidos if t != principal]
    await temas_de_curso.fijar(db, course_id, del_autor, autor_id=autor_id)

    if principal is not None:
        # `fijar` acaba de dejar la tabla con EXACTAMENTE los del autor, asi que
        # esta fila no puede chocar con ninguna: la principal se excluyo arriba.
        db.add(CourseTopic(course_id=course_id, topic_id=principal, source="manual"))


def _to_event_read(event: Event, count: int, reserved: int) -> EventRead:
    return EventRead(
        id=event.id,
        organizer_id=event.organizer_id,
        title=event.title,
        description=event.description,
        starts_at=event.starts_at,
        ends_at=event.ends_at,
        location=event.location,
        cover_path=event.cover_path,
        whatsapp_url=event.whatsapp_url,
        event_type=event.event_type,
        status=event.status,
        capacity=event.capacity,
        registrations_count=count or 0,
        reserved_by_me=(reserved or 0) > 0,
    )


async def _registrations_count(db: AsyncSession, event_id: str) -> int:
    value = await db.scalar(
        select(func.count())
        .select_from(EventRegistration)
        .where(EventRegistration.event_id == event_id)
    )
    return value or 0


@router.get("/events", response_model=list[EventRead])
async def list_events(
    page: Page = Depends(pagination_params),
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> list[EventRead]:
    uid = current_user.id if current_user else None
    count_sq = (
        select(func.count())
        .select_from(EventRegistration)
        .where(EventRegistration.event_id == Event.id)
        .scalar_subquery()
    )
    reserved_sq = (
        (
            select(func.count())
            .select_from(EventRegistration)
            .where(
                EventRegistration.event_id == Event.id,
                EventRegistration.user_id == uid,
            )
            .scalar_subquery()
        )
        if uid
        else literal(0)
    )
    rows = (
        await db.execute(
            select(Event, count_sq, reserved_sq)
            .where(Event.status == "published")
            .order_by(Event.starts_at.asc().nulls_last())
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()
    return [_to_event_read(*row) for row in rows]


@router.post("/events/{event_id}/reserve", response_model=EventRead)
async def reserve_event(
    event_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EventRead:
    event = await db.get(Event, event_id)
    if event is None or event.status != "published":
        raise NotFoundError("Evento no encontrado.")

    existing = await db.get(
        EventRegistration, {"event_id": event_id, "user_id": current_user.id}
    )
    if existing is None:
        if event.capacity is not None:
            count = await _registrations_count(db, event_id)
            if count >= event.capacity:
                raise ConflictError("El evento alcanzó su capacidad máxima.")
        db.add(EventRegistration(event_id=event_id, user_id=current_user.id))
        await db.commit()

    count = await _registrations_count(db, event_id)
    return _to_event_read(event, count, 1)


@router.delete("/events/{event_id}/reserve", response_model=EventRead)
async def cancel_reservation(
    event_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EventRead:
    event = await db.get(Event, event_id)
    if event is None:
        raise NotFoundError("Evento no encontrado.")
    existing = await db.get(
        EventRegistration, {"event_id": event_id, "user_id": current_user.id}
    )
    if existing is not None:
        await db.delete(existing)
        await db.commit()
    count = await _registrations_count(db, event_id)
    return _to_event_read(event, count, 0)


@router.get("/courses", response_model=list[CourseRead])
async def list_courses(
    page: Page = Depends(pagination_params),
    db: AsyncSession = Depends(get_db),
) -> list[CourseRead]:
    """El catalogo publico. SOLO publicados, y sigue siendo asi a proposito.

    Los borradores del autor se piden en `/catalog/courses/mine`. Meterlos aqui
    con un parametro convertiria el listado publico en un endpoint que devuelve
    cosas distintas segun quien pregunte, que es como se cuela un borrador en la
    pantalla de otra persona.
    """
    cursos = list(
        await db.scalars(
            select(Course)
            .where(Course.status == "published")
            .order_by(Course.created_at.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    )
    return await _leer_cursos(db, cursos)


@router.get("/courses/mine", response_model=list[CourseRead])
async def list_my_courses(
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[CourseRead]:
    """Los cursos de quien pregunta, en cualquier estado menos borrado.

    Es la contraparte de que crear ya no publique: sin este listado, un curso
    recien creado no aparecia en ninguna pantalla y parecia que no se habia
    guardado.
    """
    cursos = list(
        await db.scalars(
            select(Course)
            .where(Course.author_id == current_user.id, Course.status != "deleted")
            .order_by(Course.created_at.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    )
    return await _leer_cursos(db, cursos)


async def _requisitos_que_faltan(db: AsyncSession, course: Course) -> list[str]:
    """Lo que le falta a este curso para poder publicarse, en frases.

    Se devuelven TODAS de una vez y no la primera: corregir de una en una,
    guardando y volviendo a intentarlo, es la forma mas rapida de que alguien
    abandone a medias.

    ESTO CORRE EN EL SERVIDOR Y NO ES NEGOCIABLE. Esconder el boton de publicar
    en la aplicacion es comodidad para quien la usa; lo que impide que un curso
    a medias entre en el catalogo es esta funcion, porque la URL se puede llamar
    a mano.

    Cada requisito se pide SOLO si esta base sabe guardarlo. Exigir un nivel
    contra una base sin la 0034 seria pedir algo imposible y dejar el catalogo
    congelado hasta que alguien apruebe una migracion.
    """
    faltan: list[str] = []
    hay_v2 = await esquema.hay_cursos_v2(db)
    ficha = await cursos_v2.leer_una(db, course.id)

    if not (course.title or "").strip():
        faltan.append("Ponle un título al curso.")
    if len((course.description or "").strip()) < 30:
        faltan.append(
            "Escribe una descripción de al menos 30 caracteres: es lo que lee "
            "quien decide si empezarlo."
        )

    if hay_v2:
        # «Lo que aprenderas» vive en `highlights` desde la 0013, asi que la
        # columna existe hoy. La EXIGENCIA, en cambio, entra con la 0034: la
        # lista de requisitos de la ficha nueva se estrena entera o no se
        # estrena, para que nadie se encuentre un curso que ayer podia publicar
        # y hoy no, sin que haya cambiado nada en su curso.
        if not [h for h in (course.highlights or []) if (h or "").strip()]:
            faltan.append(
                "Escribe al menos un resultado de aprendizaje: qué sabrá hacer "
                "alguien al terminarlo."
            )
        if not ficha.primary_topic_id:
            faltan.append(
                "Elige la categoría principal: es donde se encuentra el curso."
            )
        if not ficha.level:
            faltan.append("Indica el nivel: inicial, intermedio o avanzado.")
        if not (ficha.language or "").strip():
            faltan.append("Indica el idioma en que se imparte.")
    elif await temas_de_curso.disponible(db):
        # Sin la 0034 no hay categoria principal, asi que la regla de siempre
        # sigue en pie: al menos un tema. Con la 0034 la categoria principal ya
        # es ese tema y pedir los dos seria pedir lo mismo dos veces.
        if not await temas_de_curso.tiene_alguno(db, course.id):
            faltan.append("Elige al menos un tema: es lo que permite recomendarlo.")

    modulos = list(
        await db.scalars(
            select(CourseModule.id).where(CourseModule.course_id == course.id)
        )
    )
    hay_lecciones = False
    if not modulos:
        faltan.append("Añade al menos un módulo.")
    else:
        # `in_(modulos)` con la lista NO vacia: `in_(lista or [""])` cuela en
        # SQLite y PostgreSQL rechaza la cadena vacia contra una columna uuid.
        lecciones = await db.scalar(
            select(func.count())
            .select_from(CourseLesson)
            .where(CourseLesson.module_id.in_(modulos))
        )
        hay_lecciones = bool(lecciones)
        if not hay_lecciones:
            faltan.append("Añade al menos una lección dentro de un módulo.")

    faltan.extend(await _requisitos_de_cobro(db, course, hay_lecciones=hay_lecciones))
    return faltan


async def _requisitos_de_cobro(
    db: AsyncSession, course: Course, *, hay_lecciones: bool
) -> list[str]:
    """Lo que le falta a un curso para poder COBRARSE.

    UNA COMPRA TIENE QUE DESBLOQUEAR ALGO REAL. Un curso de pago en el que todas
    las lecciones son muestra se puede ver entero sin pagar: quien compre habra
    pagado por nada, y quien no compre no notara la diferencia. Y al reves, un
    curso gratuito con lecciones marcadas como muestra tiene una configuracion
    que no significa nada, porque en un curso gratuito ya se abren todas.
    """
    faltan: list[str] = []
    de_pago = (course.price_minor or 0) > 0

    if de_pago:
        if course.price_minor <= 0:  # pragma: no cover - lo impide el esquema
            faltan.append("Ponle un precio mayor que cero.")
        if hay_lecciones and not await cursos_v2.tiene_leccion_de_pago(db, course.id):
            faltan.append(
                "Deja al menos una lección fuera de la muestra: quien compre "
                "tiene que desbloquear algo que no podía ver antes."
            )
    elif await cursos_v2.tiene_muestra(db, course.id):
        faltan.append(
            "Ponle precio al curso o quita las muestras: en un curso gratuito "
            "todas las lecciones ya se abren."
        )

    return faltan


@router.post("/courses/{course_id}/publish", response_model=CoursePublishResult)
async def publish_course(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CoursePublishResult:
    """Publica un curso, si esta terminado.

    LA VALIDACION CORRE AQUI, no en la aplicacion. Un boton escondido no impide
    llamar a esta URL a mano, y lo que hay al otro lado es el catalogo que ve
    todo el mundo.

    No lanza error cuando falta algo: devuelve `published: false` y la lista de
    lo que falta. Un 4xx obligaria al movil a adivinar el motivo a partir de un
    mensaje suelto, y aqui el motivo es lo unico util.
    """
    course = await _curso_gestionable(db, course_id, current_user, "publicar")
    ficha = await cursos_v2.leer_una(db, course.id)

    faltan = await _requisitos_que_faltan(db, course)
    # Con la 0034 puesta, publicar exige que alguien de la casa lo haya mirado.
    # No es mezclar los dos ejes: `status` sigue significando visibilidad y
    # `review_status` sigue significando revision. Lo que se dice aqui es que
    # uno es condicion del otro, que es la regla del producto.
    if await esquema.hay_cursos_v2(db) and ficha.review_status != cursos_v2.APROBADO:
        # `.get` con respaldo: un valor raro en la columna —escrito a mano, o de
        # una version futura— no puede tumbar la peticion con un KeyError. Se
        # dice que falta la revision, que es cierto en cualquier caso.
        faltan.append(
            _QUE_FALTA_DE_REVISION.get(
                ficha.review_status,
                "Envía el curso a revisión: aún no está aprobado.",
            )
        )

    if faltan:
        return CoursePublishResult(
            id=course.id, status=course.status, published=False, missing=faltan
        )

    course.status = "published"
    await db.commit()
    return CoursePublishResult(id=course.id, status="published", published=True)


#: Que decirle a quien intenta publicar segun donde este su revision. Se
#: escribe una vez y en un sitio: repartir estas frases por la aplicacion es
#: como acaban diciendo cosas distintas.
_QUE_FALTA_DE_REVISION = {
    cursos_v2.BORRADOR: "Envía el curso a revisión: aún no lo ha visto nadie.",
    cursos_v2.EN_REVISION: "Tu curso está en revisión. Te avisaremos al resolverla.",
    cursos_v2.RECHAZADO: (
        "La revisión anterior se rechazó. Corrige lo indicado y vuelve a enviarlo."
    ),
}


async def _curso_gestionable(
    db: AsyncSession, course_id: str, current_user: AuthUser, accion: str
) -> Course:
    """El curso, si quien pregunta puede gestionarlo. Su autor o administracion."""
    ensure_uuid(course_id, "Curso no encontrado.")
    course = await db.get(Course, course_id)
    if course is None or course.status == "deleted":
        raise NotFoundError("Curso no encontrado.")
    await require_owner_or_admin(
        db, course.author_id, current_user, f"No puedes {accion} este curso."
    )
    return course


async def _exigir_revision_disponible(db: AsyncSession) -> None:
    """503 —no 404 ni 500— mientras la 0034 no este aplicada.

    404 haria pensar que la ruta esta mal escrita y 500 que algo se ha roto. La
    funcion existe; lo que falta es la migracion, y eso es un 503.
    """
    if not await esquema.hay_cursos_v2(db):
        raise ServiceUnavailableError(
            "La revisión de cursos todavía no está disponible.",
            code="course_review_not_available",
        )


@router.get("/courses/{course_id}/requirements", response_model=CourseRequirements)
async def course_requirements(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CourseRequirements:
    """Que le falta al curso, SIN cambiar nada.

    Lo pide el paso «revisar y enviar» del asistente para pintar la lista antes
    de que alguien pulse. Las reglas salen de `_requisitos_que_faltan`, la misma
    funcion que decide de verdad: si un dia se anade un requisito, la pantalla
    lo ensena sola.
    """
    course = await _curso_gestionable(db, course_id, current_user, "revisar")
    ficha = await cursos_v2.leer_una(db, course.id)
    faltan = await _requisitos_que_faltan(db, course)
    return CourseRequirements(
        id=course.id,
        status=course.status,
        review_status=ficha.review_status,
        ready=not faltan,
        missing=faltan,
        review_available=await esquema.hay_cursos_v2(db),
    )


@router.post("/courses/{course_id}/submit", response_model=CourseSubmitResult)
async def submit_course_for_review(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CourseSubmitResult:
    """Pide que administracion mire el curso.

    Se valida lo MISMO que al publicar. Mandar a revision un curso sin lecciones
    solo sirve para que alguien pierda el tiempo mirandolo y lo devuelva.

    Como en `/publish`, cuando falta algo NO se lanza un error: se responde
    `submitted: false` y la lista entera de lo que falta, que es lo unico util.
    """
    # Primero QUIEN, despues QUE hay disponible: quien no puede tocar este curso
    # recibe un 403 y no un informe sobre el estado del despliegue.
    course = await _curso_gestionable(db, course_id, current_user, "enviar a revisión")
    await _exigir_revision_disponible(db)
    ficha = await cursos_v2.leer_una(db, course.id)

    if ficha.review_status == cursos_v2.EN_REVISION:
        # Insistir no adelanta la cola, y reescribir `submitted_at` mandaria al
        # final a quien ya llevaba esperando. Se responde que ya esta enviado.
        return CourseSubmitResult(
            id=course.id, review_status=ficha.review_status, submitted=True
        )

    faltan = await _requisitos_que_faltan(db, course)
    if faltan:
        return CourseSubmitResult(
            id=course.id,
            review_status=ficha.review_status,
            submitted=False,
            missing=faltan,
        )

    await cursos_v2.enviar_a_revision(db, course.id)
    await db.commit()
    return CourseSubmitResult(
        id=course.id, review_status=cursos_v2.EN_REVISION, submitted=True
    )


@router.get("/courses/review-queue", response_model=list[CourseRead])
async def review_queue(
    page: Page = Depends(pagination_params),
    _: AuthUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[CourseRead]:
    """La bandeja de administracion: los cursos esperando revision.

    Solo administracion, y lo impone el servidor (`require_admin` contra
    `profiles.role`, NUNCA contra el token: en el JWT de Supabase `role` vale
    siempre «authenticated»).
    """
    await _exigir_revision_disponible(db)
    ids = await cursos_v2.en_revision(db, page.limit, page.offset)
    if not ids:
        return []
    cursos = list(await db.scalars(select(Course).where(Course.id.in_(ids))))
    # El orden lo decide la cola (quien lleva mas esperando), no la base.
    por_id = {c.id: c for c in cursos}
    return await _leer_cursos(db, [por_id[i] for i in ids if i in por_id])


@router.post("/courses/{course_id}/review", response_model=CourseRead)
async def review_course(
    course_id: str,
    payload: CourseReviewDecision,
    current_user: AuthUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> CourseRead:
    """Aprueba o rechaza un curso. Solo administracion.

    APROBAR NO PUBLICA. Son dos ejes distintos y los dos tienen dueno: la
    revision es de administracion, la decision de estar en el catalogo sigue
    siendo de quien lo creo. Aprobar y publicar de golpe le quitaria a su autor
    la ultima palabra sobre cuando se estrena su curso.

    RECHAZAR SIN MOTIVO NO SE PUEDE. Un «no» sin explicacion no se puede
    corregir: quien lo recibe vuelve a enviar lo mismo y la cola no avanza.
    """
    await _exigir_revision_disponible(db)
    ensure_uuid(course_id, "Curso no encontrado.")
    course = await db.get(Course, course_id)
    if course is None or course.status == "deleted":
        raise NotFoundError("Curso no encontrado.")

    aprobado = payload.decision == "approve"
    motivo = (payload.reason or "").strip()
    if not aprobado and len(motivo) < 10:
        raise ValidationAppError(
            "Explica por qué se rechaza: quien lo recibe necesita saber qué corregir."
        )

    await cursos_v2.resolver_revision(
        db,
        course.id,
        aprobado=aprobado,
        revisor_id=current_user.id,
        motivo=motivo or None,
    )
    await db.commit()
    await db.refresh(course)
    return await _leer_curso(db, course)


@router.post("/courses/{course_id}/unpublish", response_model=CourseRead)
async def unpublish_course(
    course_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CourseRead:
    """Retira un curso del catalogo SIN borrar nada.

    Pasa a `hidden` y no a `draft` a proposito: `draft` significa «todavia no ha
    estado publicado nunca», y perder esa diferencia borraria la unica pista de
    que este curso ya estuvo a la vista de alguien. Sus modulos, lecciones,
    videos y el progreso de quien lo empezo siguen intactos, y volver a
    publicarlo es otra llamada.
    """
    ensure_uuid(course_id, "Curso no encontrado.")
    course = await db.get(Course, course_id)
    if course is None or course.status == "deleted":
        raise NotFoundError("Curso no encontrado.")
    await require_owner_or_admin(
        db, course.author_id, current_user, "No puedes retirar este curso."
    )
    course.status = "hidden"
    await db.commit()
    await db.refresh(course)
    return await _leer_curso(db, course)


async def _leer_curso(db: AsyncSession, course: Course) -> CourseRead:
    return (await _leer_cursos(db, [course]))[0]


async def _leer_cursos(db: AsyncSession, cursos: list[Course]) -> list[CourseRead]:
    """Los cursos con sus temas y su ficha, en UNA consulta de cada cosa.

    Una por curso convertiria el catalogo en veinte viajes para pintar unas
    etiquetas. Con la ficha de la 0034 el riesgo es el mismo, asi que se lee en
    lote igual que los temas.
    """
    ids = [c.id for c in cursos]
    temas = await temas_de_curso.leer(db, ids)
    fichas = await cursos_v2.leer(db, ids)
    salida: list[CourseRead] = []
    for curso in cursos:
        leido = CourseRead.model_validate(curso)
        leido.topic_ids = temas.get(curso.id, [])
        # Sin la 0034 la ficha sale vacia: subtitulo nulo, nivel nulo, idioma
        # `es` y revision en borrador. Es la verdad, no un error.
        ficha = fichas.get(curso.id, cursos_v2.FICHA_VACIA)
        leido.subtitle = ficha.subtitle
        leido.promo_video_path = ficha.promo_video_path
        leido.primary_topic_id = ficha.primary_topic_id
        leido.language = ficha.language
        leido.level = ficha.level
        leido.target_audience = ficha.target_audience
        leido.prerequisites = ficha.prerequisites
        leido.review_status = ficha.review_status
        leido.submitted_at = ficha.submitted_at
        leido.reviewed_at = ficha.reviewed_at
        leido.rejection_reason = ficha.rejection_reason
        salida.append(leido)
    return salida
