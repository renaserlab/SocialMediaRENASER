"""Endpoints del catalogo: eventos y cursos (lecturas publicas)."""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.catalog.models import Course, Event
from app.modules.catalog.schemas import CourseRead, EventRead
from app.shared.database import get_db
from app.shared.pagination import Page, pagination_params

router = APIRouter(prefix="/catalog", tags=["catalog"])


@router.get("/events", response_model=list[EventRead])
async def list_events(
    page: Page = Depends(pagination_params),
    db: AsyncSession = Depends(get_db),
) -> list[Event]:
    result = await db.scalars(
        select(Event)
        .where(Event.status == "published")
        .order_by(Event.starts_at.asc())
        .limit(page.limit)
        .offset(page.offset)
    )
    return list(result)


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
