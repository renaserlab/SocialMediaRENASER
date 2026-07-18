from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Post, Profile
from app.schemas import PostCreate, PostRead

router = APIRouter(prefix="/posts", tags=["posts"])


@router.get("", response_model=list[PostRead])
async def list_posts(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
) -> list[Post]:
    result = await db.scalars(
        select(Post)
        .where(Post.status == "published")
        .order_by(Post.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return list(result)


@router.post("", response_model=PostRead, status_code=status.HTTP_201_CREATED)
async def create_post(payload: PostCreate, db: AsyncSession = Depends(get_db)) -> Post:
    author = await db.get(Profile, payload.author_id)
    if not author:
        raise HTTPException(status_code=404, detail="Autor no encontrado")
    post = Post(**payload.model_dump())
    db.add(post)
    await db.commit()
    await db.refresh(post)
    return post
