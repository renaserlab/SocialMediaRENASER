"""Endpoints del catálogo: eventos (con reservas) y cursos (lista)."""

from fastapi import APIRouter, Depends, status
from sqlalchemy import func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.catalog.models import Course, Event, EventRegistration
from app.modules.catalog.schemas import (
    CoursePublishResult,
    CourseCreate,
    CourseRead,
    CourseUpdate,
    EventCreate,
    EventRead,
    EventUpdate,
)
from app.modules.learning.models import CourseLesson, CourseModule
from app.modules.recommendations import temas_de_curso
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

    for field, value in data.items():
        setattr(course, field, value)

    if temas is not None:
        await temas_de_curso.fijar(db, course.id, temas, autor_id=course.author_id)

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
    course = Course(
        author_id=current_user.id,
        title=payload.title,
        description=payload.description,
        cover_path=payload.cover_path,
        price_minor=payload.centavos(0) or 0,
        currency=payload.currency,
        status="draft",
    )
    db.add(course)
    await db.flush()
    if payload.topic_ids:
        await temas_de_curso.fijar(
            db, course.id, payload.topic_ids, autor_id=current_user.id
        )
    await db.commit()
    await db.refresh(course)
    return await _leer_curso(db, course)


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
    """
    faltan: list[str] = []
    if not (course.title or "").strip():
        faltan.append("Ponle un título al curso.")
    if len((course.description or "").strip()) < 30:
        faltan.append(
            "Escribe una descripción de al menos 30 caracteres: es lo que lee "
            "quien decide si empezarlo."
        )

    modulos = list(
        await db.scalars(
            select(CourseModule.id).where(CourseModule.course_id == course.id)
        )
    )
    if not modulos:
        faltan.append("Añade al menos un módulo.")
    else:
        lecciones = await db.scalar(
            select(func.count())
            .select_from(CourseLesson)
            .where(CourseLesson.module_id.in_(modulos))
        )
        if not lecciones:
            faltan.append("Añade al menos una lección dentro de un módulo.")

    # Los temas solo se exigen si hay donde guardarlos. Sin la migracion 0028 la
    # tabla no existe, y exigir algo imposible dejaria el catalogo congelado.
    if await temas_de_curso.disponible(db):
        if not await temas_de_curso.tiene_alguno(db, course.id):
            faltan.append("Elige al menos un tema: es lo que permite recomendarlo.")

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
    ensure_uuid(course_id, "Curso no encontrado.")
    course = await db.get(Course, course_id)
    if course is None or course.status == "deleted":
        raise NotFoundError("Curso no encontrado.")
    await require_owner_or_admin(
        db, course.author_id, current_user, "No puedes publicar este curso."
    )

    faltan = await _requisitos_que_faltan(db, course)
    if faltan:
        return CoursePublishResult(
            id=course.id, status=course.status, published=False, missing=faltan
        )

    course.status = "published"
    await db.commit()
    return CoursePublishResult(id=course.id, status="published", published=True)


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
    """Los cursos con sus temas, en UNA consulta para todos.

    Una por curso convertiria el catalogo en veinte viajes para pintar unas
    etiquetas.
    """
    temas = await temas_de_curso.leer(db, [c.id for c in cursos])
    salida: list[CourseRead] = []
    for curso in cursos:
        leido = CourseRead.model_validate(curso)
        leido.topic_ids = temas.get(curso.id, [])
        salida.append(leido)
    return salida
