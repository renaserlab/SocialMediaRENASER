"""Endpoints de perfiles.

- La lectura publica del perfil no requiere sesion.
- La edicion solo puede hacerla el dueno (identidad tomada del JWT, nunca
  de un id enviado por el cliente).
"""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.core.security import AuthUser, get_current_user
from app.modules.profiles.models import Profile
from app.modules.profiles.schemas import ProfileRead, ProfileUpdate
from app.shared.database import get_db
from app.shared.pagination import Page, pagination_params

router = APIRouter(prefix="/profiles", tags=["profiles"])


@router.get("", response_model=list[ProfileRead])
async def list_profiles(
    page: Page = Depends(pagination_params),
    db: AsyncSession = Depends(get_db),
) -> list[Profile]:
    result = await db.scalars(
        select(Profile)
        .order_by(Profile.created_at.desc())
        .limit(page.limit)
        .offset(page.offset)
    )
    return list(result)


@router.get("/me", response_model=ProfileRead)
async def get_my_profile(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Profile:
    profile = await db.get(Profile, current_user.id)
    if profile is None:
        raise NotFoundError("Perfil no encontrado para el usuario actual.")
    return profile


@router.patch("/me", response_model=ProfileRead)
async def update_my_profile(
    payload: ProfileUpdate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Profile:
    profile = await db.get(Profile, current_user.id)
    if profile is None:
        raise NotFoundError("Perfil no encontrado para el usuario actual.")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(profile, field, value)
    await db.commit()
    await db.refresh(profile)
    return profile


@router.get("/{profile_id}", response_model=ProfileRead)
async def get_profile(
    profile_id: str,
    db: AsyncSession = Depends(get_db),
) -> Profile:
    profile = await db.get(Profile, profile_id)
    if profile is None:
        raise NotFoundError("Perfil no encontrado.")
    return profile
