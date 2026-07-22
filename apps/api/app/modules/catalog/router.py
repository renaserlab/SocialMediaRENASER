"""Endpoints del catálogo: eventos (con reservas) y cursos (lista)."""

from fastapi import APIRouter, Depends, status
from sqlalchemy import func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.catalog.models import Course, Event, EventRegistration
from app.modules.catalog.schemas import (
    CourseCreate,
    CourseRead,
    EventCreate,
    EventRead,
)
from app.shared.database import get_db
from app.shared.pagination import Page, pagination_params
from app.shared.permissions import require_admin

router = APIRouter(prefix="/catalog", tags=["catalog"])


@router.post("/events", response_model=EventRead, status_code=status.HTTP_201_CREATED)
async def create_event(
    payload: EventCreate,
    current_user: AuthUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> EventRead:
    """Publica un evento. `require_admin` es lo que protege esto de verdad:
    que la app oculte el boton no impide llamar al endpoint a mano."""
    event = Event(
        organizer_id=current_user.id,
        title=payload.title,
        description=payload.description,
        starts_at=payload.starts_at,
        location=payload.location,
        cover_path=payload.cover_path,
        event_type=payload.event_type,
        status="published",
    )
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return _to_event_read(event, 0, 0)


@router.post("/courses", response_model=CourseRead, status_code=status.HTTP_201_CREATED)
async def create_course(
    payload: CourseCreate,
    current_user: AuthUser = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> CourseRead:
    course = Course(
        author_id=current_user.id,
        title=payload.title,
        description=payload.description,
        cover_path=payload.cover_path,
        # El cliente envia la unidad mayor; la columna guarda centavos.
        price_minor=payload.price * 100,
        currency=payload.currency,
        status="published",
    )
    db.add(course)
    await db.commit()
    await db.refresh(course)
    return CourseRead.model_validate(course)


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
            .order_by(Event.starts_at.asc())
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
) -> list[Course]:
    result = await db.scalars(
        select(Course)
        .where(Course.status == "published")
        .order_by(Course.created_at.desc())
        .limit(page.limit)
        .offset(page.offset)
    )
    return list(result)
