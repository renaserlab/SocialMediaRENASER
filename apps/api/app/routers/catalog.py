from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Course, Event
from app.schemas import CourseCreate, CourseRead, EventCreate, EventRead

router = APIRouter(prefix="/catalog", tags=["catalog"])


@router.get("/events", response_model=list[EventRead])
async def list_events(db: AsyncSession = Depends(get_db)) -> list[Event]:
    result = await db.scalars(select(Event).order_by(Event.starts_at.asc()).limit(100))
    return list(result)


@router.post("/events", response_model=EventRead, status_code=status.HTTP_201_CREATED)
async def create_event(payload: EventCreate, db: AsyncSession = Depends(get_db)) -> Event:
    event = Event(**payload.model_dump())
    db.add(event)
    await db.commit()
    await db.refresh(event)
    return event


@router.get("/courses", response_model=list[CourseRead])
async def list_courses(db: AsyncSession = Depends(get_db)) -> list[Course]:
    result = await db.scalars(select(Course).where(Course.published.is_(True)).limit(100))
    return list(result)


@router.post("/courses", response_model=CourseRead, status_code=status.HTTP_201_CREATED)
async def create_course(payload: CourseCreate, db: AsyncSession = Depends(get_db)) -> Course:
    course = Course(**payload.model_dump())
    db.add(course)
    await db.commit()
    await db.refresh(course)
    return course
