"""Endpoints de moderación: crear y listar reportes propios."""

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import AuthUser, get_current_user
from app.modules.moderation.models import Report
from app.modules.moderation.schemas import ReportCreate, ReportRead
from app.shared.database import get_db
from app.shared.pagination import Page, pagination_params

router = APIRouter(prefix="/reports", tags=["moderation"])


@router.post("", response_model=ReportRead, status_code=status.HTTP_201_CREATED)
async def create_report(
    payload: ReportCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Report:
    report = Report(
        reporter_id=current_user.id,
        reported_user_id=payload.reported_user_id,
        entity_type=payload.entity_type,
        entity_id=payload.entity_id,
        reason=payload.reason,
        details=payload.details,
    )
    db.add(report)
    await db.commit()
    await db.refresh(report)
    return report


@router.get("/mine", response_model=list[ReportRead])
async def my_reports(
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[Report]:
    result = await db.scalars(
        select(Report)
        .where(Report.reporter_id == current_user.id)
        .order_by(Report.created_at.desc())
        .limit(page.limit)
        .offset(page.offset)
    )
    return list(result)
