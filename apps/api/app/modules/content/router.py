"""Endpoints de contenido: feed, posts y comentarios.

Seguridad clave (Fase 1): al crear un post o comentario, el autor se toma
SIEMPRE de current_user.id (JWT), nunca de un campo enviado por el cliente.
Esto elimina el hueco donde el celular decidia libremente el author_id.
"""

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.core.security import AuthUser, get_current_user
from app.modules.content.models import Comment, Post
from app.modules.content.schemas import (
    CommentCreate,
    CommentRead,
    PostCreate,
    PostRead,
)
from app.shared.database import get_db
from app.shared.pagination import Page, pagination_params

router = APIRouter(tags=["content"])


@router.get("/posts", response_model=list[PostRead])
async def list_posts(
    page: Page = Depends(pagination_params),
    db: AsyncSession = Depends(get_db),
) -> list[Post]:
    result = await db.scalars(
        select(Post)
        .where(Post.status == "published")
        .order_by(Post.created_at.desc())
        .limit(page.limit)
        .offset(page.offset)
    )
    return list(result)


@router.post("/posts", response_model=PostRead, status_code=status.HTTP_201_CREATED)
async def create_post(
    payload: PostCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Post:
    post = Post(
        author_id=current_user.id,
        body=payload.body,
        visibility=payload.visibility,
    )
    db.add(post)
    await db.commit()
    await db.refresh(post)
    return post


@router.get("/posts/{post_id}", response_model=PostRead)
async def get_post(post_id: str, db: AsyncSession = Depends(get_db)) -> Post:
    post = await db.get(Post, post_id)
    if post is None or post.status == "deleted":
        raise NotFoundError("Publicacion no encontrada.")
    return post


@router.get("/posts/{post_id}/comments", response_model=list[CommentRead])
async def list_comments(
    post_id: str,
    page: Page = Depends(pagination_params),
    db: AsyncSession = Depends(get_db),
) -> list[Comment]:
    result = await db.scalars(
        select(Comment)
        .where(Comment.post_id == post_id, Comment.status == "published")
        .order_by(Comment.created_at.asc())
        .limit(page.limit)
        .offset(page.offset)
    )
    return list(result)


@router.post(
    "/posts/{post_id}/comments",
    response_model=CommentRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_comment(
    post_id: str,
    payload: CommentCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Comment:
    post = await db.get(Post, post_id)
    if post is None or post.status == "deleted":
        raise NotFoundError("Publicacion no encontrada.")
    comment = Comment(
        post_id=post_id,
        author_id=current_user.id,
        parent_id=payload.parent_id,
        body=payload.body,
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    return comment
