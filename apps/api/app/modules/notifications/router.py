"""Endpoints de notificaciones in-app."""

from fastapi import APIRouter, Depends, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import AuthUser, get_current_user
from app.modules.content.schemas import AuthorSummary
from app.modules.notifications.models import Notification
from app.modules.notifications.schemas import NotificationRead
from app.modules.profiles.models import Profile
from app.shared.database import get_db
from app.shared.pagination import Page, pagination_params

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationRead])
async def list_notifications(
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[NotificationRead]:
    rows = (
        await db.execute(
            select(Notification, Profile)
            .outerjoin(Profile, Profile.id == Notification.actor_id)
            .where(Notification.user_id == current_user.id)
            .order_by(Notification.created_at.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()
    result: list[NotificationRead] = []
    for notif, actor in rows:
        result.append(
            NotificationRead(
                id=notif.id,
                type=notif.type,
                actor=(
                    AuthorSummary(
                        id=actor.id,
                        full_name=actor.full_name,
                        username=actor.username,
                        avatar_path=actor.avatar_path,
                    )
                    if actor is not None
                    else None
                ),
                entity_type=notif.entity_type,
                entity_id=notif.entity_id,
                read=notif.read_at is not None,
                created_at=notif.created_at,
            )
        )
    return result


@router.get("/unread-count")
async def unread_count(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    value = await db.scalar(
        select(func.count())
        .select_from(Notification)
        .where(Notification.user_id == current_user.id, Notification.read_at.is_(None))
    )
    return {"count": value or 0}


@router.post("/{notification_id}/read", status_code=status.HTTP_204_NO_CONTENT)
async def mark_read(
    notification_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    await db.execute(
        update(Notification)
        .where(
            Notification.id == notification_id,
            Notification.user_id == current_user.id,
        )
        .values(read_at=func.now())
    )
    await db.commit()


@router.post("/read-all", status_code=status.HTTP_204_NO_CONTENT)
async def mark_all_read(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    await db.execute(
        update(Notification)
        .where(
            Notification.user_id == current_user.id,
            Notification.read_at.is_(None),
        )
        .values(read_at=func.now())
    )
    await db.commit()
