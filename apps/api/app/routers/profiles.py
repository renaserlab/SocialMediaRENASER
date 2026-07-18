from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Profile
from app.schemas import ProfileCreate, ProfileRead

router = APIRouter(prefix="/profiles", tags=["profiles"])


@router.get("", response_model=list[ProfileRead])
async def list_profiles(db: AsyncSession = Depends(get_db)) -> list[Profile]:
    result = await db.scalars(select(Profile).order_by(Profile.created_at.desc()).limit(50))
    return list(result)


@router.post("", response_model=ProfileRead, status_code=status.HTTP_201_CREATED)
async def create_profile(payload: ProfileCreate, db: AsyncSession = Depends(get_db)) -> Profile:
    existing = await db.scalar(select(Profile).where((Profile.email == payload.email) | (Profile.username == payload.username)))
    if existing:
        raise HTTPException(status_code=409, detail="Email o username ya registrado")
    profile = Profile(**payload.model_dump())
    db.add(profile)
    await db.commit()
    await db.refresh(profile)
    return profile
