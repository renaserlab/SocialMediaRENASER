"""Endpoints del grafo social: seguir / dejar de seguir / bloquear.

La identidad (quién sigue o bloquea) se toma siempre del JWT.
"""

from fastapi import APIRouter, Depends
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError, ValidationAppError
from app.core.security import AuthUser, get_current_user
from app.modules.notifications.service import add_notification
from app.modules.profiles.models import Profile
from app.modules.social_graph.models import Follow, UserBlock
from app.shared.database import get_db

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
