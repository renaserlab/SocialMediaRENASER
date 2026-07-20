"""Endpoints de comunidades: listar círculos, unirse y salir."""

from fastapi import APIRouter, Depends
from sqlalchemy import func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.communities.models import Circle, CircleMember
from app.modules.communities.schemas import CircleRead
from app.shared.database import get_db
from app.shared.pagination import Page, pagination_params

router = APIRouter(prefix="/circles", tags=["communities"])


def _member_columns(uid: str | None):
    members = (
        select(func.count())
        .select_from(CircleMember)
        .where(CircleMember.circle_id == Circle.id)
        .scalar_subquery()
    )
    if uid:
        mine = (
            select(func.count())
            .select_from(CircleMember)
            .where(CircleMember.circle_id == Circle.id, CircleMember.user_id == uid)
            .scalar_subquery()
        )
    else:
        mine = literal(0)
    return members, mine


def _to_circle_read(circle: Circle, members: int, mine: int) -> CircleRead:
    return CircleRead(
        id=circle.id,
        owner_id=circle.owner_id,
        name=circle.name,
        description=circle.description,
        cover_path=circle.cover_path,
        is_private=circle.is_private,
        members_count=members or 0,
        is_member=(mine or 0) > 0,
    )


async def _members_count(db: AsyncSession, circle_id: str) -> int:
    value = await db.scalar(
        select(func.count())
        .select_from(CircleMember)
        .where(CircleMember.circle_id == circle_id)
    )
    return value or 0


@router.get("", response_model=list[CircleRead])
async def list_circles(
    page: Page = Depends(pagination_params),
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> list[CircleRead]:
    uid = current_user.id if current_user else None
    members_sq, mine_sq = _member_columns(uid)
    rows = (
        await db.execute(
            select(Circle, members_sq, mine_sq)
            .order_by(Circle.created_at.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()
    return [_to_circle_read(*row) for row in rows]


@router.get("/{circle_id}", response_model=CircleRead)
async def get_circle(
    circle_id: str,
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> CircleRead:
    uid = current_user.id if current_user else None
    members_sq, mine_sq = _member_columns(uid)
    row = (
        await db.execute(
            select(Circle, members_sq, mine_sq).where(Circle.id == circle_id)
        )
    ).first()
    if row is None:
        raise NotFoundError("Círculo no encontrado.")
    return _to_circle_read(*row)


@router.post("/{circle_id}/join")
async def join_circle(
    circle_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    circle = await db.get(Circle, circle_id)
    if circle is None:
        raise NotFoundError("Círculo no encontrado.")
    existing = await db.get(
        CircleMember, {"circle_id": circle_id, "user_id": current_user.id}
    )
    if existing is None:
        db.add(CircleMember(circle_id=circle_id, user_id=current_user.id))
        await db.commit()
    return {"is_member": True, "members_count": await _members_count(db, circle_id)}


@router.delete("/{circle_id}/leave")
async def leave_circle(
    circle_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    existing = await db.get(
        CircleMember, {"circle_id": circle_id, "user_id": current_user.id}
    )
    if existing is not None:
        await db.delete(existing)
        await db.commit()
    return {"is_member": False, "members_count": await _members_count(db, circle_id)}
