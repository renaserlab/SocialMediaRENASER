"""Endpoints del grafo social: seguir / dejar de seguir / bloquear.

La identidad (quién sigue o bloquea) se toma siempre del JWT.
"""

from fastapi import APIRouter, Depends
from sqlalchemy import delete, func, literal, literal_column, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationAppError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.notifications.service import add_notification
from app.modules.profiles.models import Profile
from app.modules.profiles.schemas import ProfileSummary
from app.modules.social_graph.models import Follow, UserBlock
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.pagination import Page, pagination_params

router = APIRouter(prefix="/profiles", tags=["social"])


async def _followers_count(db: AsyncSession, profile_id: str) -> int:
    value = await db.scalar(
        select(func.count()).select_from(Follow).where(Follow.following_id == profile_id)
    )
    return value or 0


async def _require_profile(db: AsyncSession, profile_id: str) -> Profile:
    profile = await db.get(Profile, profile_id)
    if profile is None:
        raise NotFoundError("Perfil no encontrado.")
    return profile


async def _people(
    db: AsyncSession,
    profile_id: str,
    viewer_id: str | None,
    *,
    direction: str,
    page: Page,
) -> list[ProfileSummary]:
    """Seguidores o seguidos de un perfil, con `is_following` del que mira.

    `direction='followers'` -> quienes siguen a `profile_id`.
    `direction='following'` -> a quienes sigue `profile_id`.
    """
    ensure_uuid(profile_id, "Perfil no encontrado.")
    if direction == "followers":
        join_on = Profile.id == Follow.follower_id
        where = Follow.following_id == profile_id
    else:
        join_on = Profile.id == Follow.following_id
        where = Follow.follower_id == profile_id

    if viewer_id:
        is_following_sq = (
            select(func.count())
            .select_from(Follow.__table__.alias("f2"))
            .where(
                literal_column("f2.follower_id") == viewer_id,
                literal_column("f2.following_id") == Profile.id,
            )
            .scalar_subquery()
        )
    else:
        is_following_sq = literal(0)

    rows = (
        await db.execute(
            select(Profile, is_following_sq)
            .join(Follow, join_on)
            .where(where)
            .order_by(Profile.full_name)
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()
    return [
        ProfileSummary(
            id=p.id,
            full_name=p.full_name,
            username=p.username,
            avatar_path=p.avatar_path,
            bio=p.bio,
            is_following=(isf or 0) > 0,
        )
        for p, isf in rows
    ]


@router.get("/{profile_id}/followers", response_model=list[ProfileSummary])
async def list_followers(
    profile_id: str,
    page: Page = Depends(pagination_params),
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> list[ProfileSummary]:
    return await _people(
        db,
        profile_id,
        current_user.id if current_user else None,
        direction="followers",
        page=page,
    )


@router.get("/{profile_id}/following", response_model=list[ProfileSummary])
async def list_following(
    profile_id: str,
    page: Page = Depends(pagination_params),
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> list[ProfileSummary]:
    return await _people(
        db,
        profile_id,
        current_user.id if current_user else None,
        direction="following",
        page=page,
    )


@router.post("/{profile_id}/follow")
async def follow_profile(
    profile_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    if profile_id == current_user.id:
        raise ValidationAppError("No puedes seguirte a ti mismo.")
    await _require_profile(db, profile_id)
    existing = await db.get(
        Follow, {"follower_id": current_user.id, "following_id": profile_id}
    )
    if existing is None:
        db.add(Follow(follower_id=current_user.id, following_id=profile_id))
        add_notification(
            db, user_id=profile_id, actor_id=current_user.id, type="follow"
        )
        await db.commit()
    return {"following": True, "followers_count": await _followers_count(db, profile_id)}


@router.delete("/{profile_id}/follow")
async def unfollow_profile(
    profile_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    await db.execute(
        delete(Follow).where(
            Follow.follower_id == current_user.id, Follow.following_id == profile_id
        )
    )
    await db.commit()
    return {"following": False, "followers_count": await _followers_count(db, profile_id)}


@router.post("/{profile_id}/block")
async def block_profile(
    profile_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    if profile_id == current_user.id:
        raise ValidationAppError("No puedes bloquearte a ti mismo.")
    await _require_profile(db, profile_id)
    existing = await db.get(
        UserBlock, {"blocker_id": current_user.id, "blocked_id": profile_id}
    )
    if existing is None:
        db.add(UserBlock(blocker_id=current_user.id, blocked_id=profile_id))
    # Al bloquear se elimina cualquier relación de seguimiento en ambos sentidos.
    await db.execute(
        delete(Follow).where(
            or_(
                (Follow.follower_id == current_user.id)
                & (Follow.following_id == profile_id),
                (Follow.follower_id == profile_id)
                & (Follow.following_id == current_user.id),
            )
        )
    )
    await db.commit()
    return {"blocked": True}


@router.delete("/{profile_id}/block")
async def unblock_profile(
    profile_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    await db.execute(
        delete(UserBlock).where(
            UserBlock.blocker_id == current_user.id,
            UserBlock.blocked_id == profile_id,
        )
    )
    await db.commit()
    return {"blocked": False}
