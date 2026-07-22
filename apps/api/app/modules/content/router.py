"""Endpoints de contenido: feed, posts, likes, guardados y comentarios.

Seguridad clave (Fase 1): al crear un post/comentario o dar like/guardar, la
identidad se toma SIEMPRE de current_user.id (JWT), nunca de un campo del cliente.

El feed devuelve el autor (join a profiles) y los contadores (likes/comentarios)
mas el estado propio (liked_by_me / saved_by_me) cuando hay sesion.
"""

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import delete, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError, NotFoundError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.content.models import Comment, Post, PostLike, PostMedia, SavedPost
from app.modules.content.schemas import (
    AuthorSummary,
    CommentCreate,
    CommentRead,
    PostCreate,
    PostMediaRead,
    PostRead,
)
from app.modules.notifications.service import add_notification
from app.modules.profiles.models import Profile
from app.modules.social_graph.models import Follow
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.permissions import is_admin as is_admin_user
from app.shared.pagination import Page, pagination_params

router = APIRouter(tags=["content"])



# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _feed_columns(uid: str | None):
    likes_sq = (
        select(func.count())
        .select_from(PostLike)
        .where(PostLike.post_id == Post.id)
        .scalar_subquery()
    )
    comments_sq = (
        select(func.count())
        .select_from(Comment)
        .where(Comment.post_id == Post.id, Comment.status == "published")
        .scalar_subquery()
    )
    if uid:
        liked_sq = (
            select(func.count())
            .select_from(PostLike)
            .where(PostLike.post_id == Post.id, PostLike.user_id == uid)
            .scalar_subquery()
        )
        saved_sq = (
            select(func.count())
            .select_from(SavedPost)
            .where(SavedPost.post_id == Post.id, SavedPost.user_id == uid)
            .scalar_subquery()
        )
    else:
        liked_sq = literal(0)
        saved_sq = literal(0)
    return likes_sq, comments_sq, liked_sq, saved_sq


def _author(profile: Profile) -> AuthorSummary:
    return AuthorSummary(
        id=profile.id,
        full_name=profile.full_name,
        username=profile.username,
        avatar_path=profile.avatar_path,
    )


def _to_post_read(
    post: Post,
    profile: Profile,
    lc: int,
    cc: int,
    lk: int,
    sv: int,
    media: list[PostMediaRead] | None = None,
) -> PostRead:
    return PostRead(
        id=post.id,
        author=_author(profile),
        body=post.body,
        status=post.status,
        visibility=post.visibility,
        created_at=post.created_at,
        media=media or [],
        likes_count=lc or 0,
        comments_count=cc or 0,
        liked_by_me=(lk or 0) > 0,
        saved_by_me=(sv or 0) > 0,
    )


async def _load_media_map(
    db: AsyncSession, post_ids: list[str]
) -> dict[str, list[PostMediaRead]]:
    if not post_ids:
        return {}
    rows = (
        await db.scalars(
            select(PostMedia)
            .where(PostMedia.post_id.in_(post_ids))
            .order_by(PostMedia.sort_order)
        )
    ).all()
    result: dict[str, list[PostMediaRead]] = {}
    for media in rows:
        result.setdefault(media.post_id, []).append(
            PostMediaRead(
                storage_path=media.storage_path,
                media_type=media.media_type,
                sort_order=media.sort_order,
            )
        )
    return result


async def _get_active_post(db: AsyncSession, post_id: str) -> Post:
    post = await db.get(Post, post_id)
    if post is None or post.status == "deleted":
        raise NotFoundError("Publicacion no encontrada.")
    return post


async def _likes_count(db: AsyncSession, post_id: str) -> int:
    value = await db.scalar(
        select(func.count()).select_from(PostLike).where(PostLike.post_id == post_id)
    )
    return value or 0


# --------------------------------------------------------------------------- #
# Feed / posts
# --------------------------------------------------------------------------- #
@router.get("/posts", response_model=list[PostRead])
async def list_posts(
    page: Page = Depends(pagination_params),
    feed: str = Query(default="all", pattern="^(all|following)$"),
    author_id: str | None = Query(default=None),
    circle_id: str | None = Query(default=None),
    media: str | None = Query(default=None, pattern="^(image|video|audio)$"),
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> list[PostRead]:
    """Feed publico.

    `feed=all` ("Para ti") devuelve todo lo publicado; `feed=following`
    ("Siguiendo") solo lo de los perfiles que sigue el usuario. Sin sesion,
    `following` no tiene a quien consultar y devuelve una lista vacia.

    `author_id` restringe a las publicaciones de un perfil (su galeria) y
    `media` al tipo de adjunto, para separar la cuadricula de los audios sin
    traerse todo y filtrar en el cliente.
    """
    uid = current_user.id if current_user else None
    likes_sq, comments_sq, liked_sq, saved_sq = _feed_columns(uid)
    stmt = (
        select(Post, Profile, likes_sq, comments_sq, liked_sq, saved_sq)
        .join(Profile, Profile.id == Post.author_id)
        .where(Post.status == "published")
        .order_by(Post.created_at.desc())
        .limit(page.limit)
        .offset(page.offset)
    )
    if feed == "following":
        if not uid:
            return []
        followed = select(Follow.following_id).where(Follow.follower_id == uid)
        stmt = stmt.where(Post.author_id.in_(followed))

    if author_id:
        # Un id con otro formato llegaria a Postgres y reventaria la consulta.
        ensure_uuid(author_id, "Perfil no encontrado.")
        stmt = stmt.where(Post.author_id == author_id)

    if circle_id:
        ensure_uuid(circle_id, "Círculo no encontrado.")
        stmt = stmt.where(Post.circle_id == circle_id)

    if media:
        with_media = select(PostMedia.post_id).where(PostMedia.media_type == media)
        stmt = stmt.where(Post.id.in_(with_media))
    rows = (await db.execute(stmt)).all()
    media_map = await _load_media_map(db, [row[0].id for row in rows])
    return [_to_post_read(*row, media=media_map.get(row[0].id, [])) for row in rows]


@router.post("/posts", response_model=PostRead, status_code=status.HTTP_201_CREATED)
async def create_post(
    payload: PostCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PostRead:
    post = Post(
        author_id=current_user.id,
        body=payload.body,
        visibility=payload.visibility,
    )
    db.add(post)
    await db.commit()
    await db.refresh(post)

    # Medios con tipo explícito + compatibilidad con image_paths (sin tipo).
    entries: list[tuple[str, str]] = [
        (item.storage_path, item.media_type) for item in payload.media
    ]
    entries += [(path, "image") for path in payload.image_paths]

    media: list[PostMediaRead] = []
    for index, (path, media_type) in enumerate(entries):
        db.add(
            PostMedia(
                post_id=post.id,
                storage_path=path,
                media_type=media_type,
                sort_order=index,
            )
        )
        media.append(
            PostMediaRead(storage_path=path, media_type=media_type, sort_order=index)
        )
    if media:
        await db.commit()

    profile = await db.get(Profile, current_user.id)
    if profile is None:
        raise NotFoundError("Perfil del autor no encontrado.")
    return _to_post_read(post, profile, 0, 0, 0, 0, media=media)


@router.get("/posts/{post_id}", response_model=PostRead)
async def get_post(
    post_id: str,
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> PostRead:
    uid = current_user.id if current_user else None
    likes_sq, comments_sq, liked_sq, saved_sq = _feed_columns(uid)
    stmt = (
        select(Post, Profile, likes_sq, comments_sq, liked_sq, saved_sq)
        .join(Profile, Profile.id == Post.author_id)
        .where(Post.id == post_id, Post.status != "deleted")
    )
    row = (await db.execute(stmt)).first()
    if row is None:
        raise NotFoundError("Publicacion no encontrada.")
    media_map = await _load_media_map(db, [row[0].id])
    return _to_post_read(*row, media=media_map.get(row[0].id, []))


@router.delete("/posts/{post_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_post(
    post_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    post = await _get_active_post(db, post_id)
    # El rol de la app esta en profiles.role, no en el JWT: alli `role` vale
    # siempre "authenticated", asi que esta comprobacion nunca se cumplia y un
    # moderador no podia retirar la publicacion de otra persona.
    if post.author_id != current_user.id and not await is_admin_user(db, current_user.id):
        raise ForbiddenError("No puedes eliminar esta publicacion.")
    post.status = "deleted"  # soft delete
    await db.commit()


# --------------------------------------------------------------------------- #
# Likes
# --------------------------------------------------------------------------- #
@router.post("/posts/{post_id}/like")
async def like_post(
    post_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    post = await _get_active_post(db, post_id)
    existing = await db.get(PostLike, {"post_id": post_id, "user_id": current_user.id})
    if existing is None:
        db.add(PostLike(post_id=post_id, user_id=current_user.id))
        add_notification(
            db,
            user_id=post.author_id,
            actor_id=current_user.id,
            type="like",
            entity_type="post",
            entity_id=post_id,
        )
        await db.commit()
    return {"liked": True, "likes_count": await _likes_count(db, post_id)}


@router.delete("/posts/{post_id}/like")
async def unlike_post(
    post_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    await db.execute(
        delete(PostLike).where(
            PostLike.post_id == post_id, PostLike.user_id == current_user.id
        )
    )
    await db.commit()
    return {"liked": False, "likes_count": await _likes_count(db, post_id)}


# --------------------------------------------------------------------------- #
# Guardados
# --------------------------------------------------------------------------- #
@router.post("/posts/{post_id}/save")
async def save_post(
    post_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    await _get_active_post(db, post_id)
    existing = await db.get(SavedPost, {"post_id": post_id, "user_id": current_user.id})
    if existing is None:
        db.add(SavedPost(post_id=post_id, user_id=current_user.id))
        await db.commit()
    return {"saved": True}


@router.delete("/posts/{post_id}/save")
async def unsave_post(
    post_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    await db.execute(
        delete(SavedPost).where(
            SavedPost.post_id == post_id, SavedPost.user_id == current_user.id
        )
    )
    await db.commit()
    return {"saved": False}


# --------------------------------------------------------------------------- #
# Comentarios
# --------------------------------------------------------------------------- #
def _to_comment_read(comment: Comment, profile: Profile) -> CommentRead:
    return CommentRead(
        id=comment.id,
        post_id=comment.post_id,
        author=_author(profile),
        parent_id=comment.parent_id,
        body=comment.body,
        created_at=comment.created_at,
    )


@router.get("/posts/{post_id}/comments", response_model=list[CommentRead])
async def list_comments(
    post_id: str,
    page: Page = Depends(pagination_params),
    db: AsyncSession = Depends(get_db),
) -> list[CommentRead]:
    ensure_uuid(post_id, "Publicacion no encontrada.")
    stmt = (
        select(Comment, Profile)
        .join(Profile, Profile.id == Comment.author_id)
        .where(Comment.post_id == post_id, Comment.status == "published")
        .order_by(Comment.created_at.asc())
        .limit(page.limit)
        .offset(page.offset)
    )
    rows = (await db.execute(stmt)).all()
    return [_to_comment_read(comment, profile) for comment, profile in rows]


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
) -> CommentRead:
    ensure_uuid(post_id, "Publicacion no encontrada.")
    post = await _get_active_post(db, post_id)
    comment = Comment(
        post_id=post_id,
        author_id=current_user.id,
        parent_id=payload.parent_id,
        body=payload.body,
    )
    db.add(comment)
    add_notification(
        db,
        user_id=post.author_id,
        actor_id=current_user.id,
        type="comment",
        entity_type="post",
        entity_id=post_id,
    )
    await db.commit()
    await db.refresh(comment)

    profile = await db.get(Profile, current_user.id)
    if profile is None:
        raise NotFoundError("Perfil del autor no encontrado.")
    return _to_comment_read(comment, profile)
