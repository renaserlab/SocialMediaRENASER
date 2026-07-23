"""Endpoints de perfiles: perfil propio, público, edición y búsqueda.

Los perfiles vienen enriquecidos con contadores (seguidores/seguidos/posts) y,
si hay sesión, con is_following (si el usuario actual sigue a ese perfil).
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, literal, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NotFoundError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.content.models import Post
from app.modules.profiles.models import Profile
from app.modules.profiles.schemas import (
    FeaturedProfile,
    ProfileRead,
    ProfileSummary,
    ProfileUpdate,
)
from app.modules.social_graph.models import Follow
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.pagination import Page, pagination_params

router = APIRouter(prefix="/profiles", tags=["profiles"])


# --------------------------------------------------------------------------- #
# Helpers de contadores
# --------------------------------------------------------------------------- #
def _count_columns(viewer_id: str | None):
    followers = (
        select(func.count())
        .select_from(Follow)
        .where(Follow.following_id == Profile.id)
        .scalar_subquery()
    )
    following = (
        select(func.count())
        .select_from(Follow)
        .where(Follow.follower_id == Profile.id)
        .scalar_subquery()
    )
    posts = (
        select(func.count())
        .select_from(Post)
        .where(Post.author_id == Profile.id, Post.status == "published")
        .scalar_subquery()
    )
    if viewer_id:
        is_following = (
            select(func.count())
            .select_from(Follow)
            .where(Follow.follower_id == viewer_id, Follow.following_id == Profile.id)
            .scalar_subquery()
        )
    else:
        is_following = literal(0)
    return followers, following, posts, is_following


def _to_profile_read(profile: Profile, fc: int, gc: int, pc: int, isf: int) -> ProfileRead:
    return ProfileRead(
        id=profile.id,
        email=profile.email,
        full_name=profile.full_name,
        username=profile.username,
        bio=profile.bio,
        avatar_path=profile.avatar_path,
        cover_path=profile.cover_path,
        podcast_started_at=profile.podcast_started_at,
        role=profile.role,
        is_featured=profile.is_featured,
        is_private=profile.is_private,
        created_at=profile.created_at,
        followers_count=fc or 0,
        following_count=gc or 0,
        posts_count=pc or 0,
        is_following=(isf or 0) > 0,
    )


async def _load_profile(
    db: AsyncSession, profile_id: str, viewer_id: str | None
) -> ProfileRead:
    fc, gc, pc, isf = _count_columns(viewer_id)
    row = (
        await db.execute(
            select(Profile, fc, gc, pc, isf).where(Profile.id == profile_id)
        )
    ).first()
    if row is None:
        raise NotFoundError("Perfil no encontrado.")
    return _to_profile_read(*row)


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@router.get("/me", response_model=ProfileRead)
async def get_my_profile(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProfileRead:
    return await _load_profile(db, current_user.id, viewer_id=None)


@router.patch("/me", response_model=ProfileRead)
async def update_my_profile(
    payload: ProfileUpdate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProfileRead:
    profile = await db.get(Profile, current_user.id)
    if profile is None:
        raise NotFoundError("Perfil no encontrado para el usuario actual.")
    for field, value in payload.model_dump(exclude_unset=True).items():
        # `exclude_unset` ya distingue "no enviado" de "enviado". Para las
        # imagenes hace falta un valor que signifique "quitar": la cadena vacia
        # se guarda como NULL para volver a la imagen por defecto.
        if field in {"avatar_path", "cover_path"} and value == "":
            value = None
        setattr(profile, field, value)
    await db.commit()
    return await _load_profile(db, current_user.id, viewer_id=None)


@router.post("/me/podcast-start", response_model=ProfileRead)
async def start_podcast_drip(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ProfileRead:
    """Arranca la cuenta atras del podcast la primera vez que se abre.

    Es IDEMPOTENTE: si ya estaba marcada no se toca, para que volver a entrar en
    la seccion no reinicie el progreso. El `WHERE ... IS NULL` deja esa decision
    a la base de datos en una sola sentencia; leerla antes y escribirla despues
    permitiria que dos peticiones a la vez la fijaran dos veces.

    El instante lo pone el servidor, nunca el cliente: si lo enviara el telefono
    bastaria con cambiar su hora para desbloquearlo todo.
    """
    await db.execute(
        update(Profile)
        .where(Profile.id == current_user.id, Profile.podcast_started_at.is_(None))
        .values(podcast_started_at=datetime.now(timezone.utc))
    )
    await db.commit()
    # Si no existiera el perfil, la carga siguiente responde 404.
    return await _load_profile(db, current_user.id, viewer_id=None)


@router.get("/featured", response_model=list[FeaturedProfile])
async def list_featured_profiles(
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> list[FeaturedProfile]:
    """Perfiles sugeridos al registrarse, para que el feed no empiece vacio.

    Se declara antes que `/{profile_id}` porque si no esa ruta capturaria la
    palabra "featured" y responderia 404.
    """
    viewer_id = current_user.id if current_user else None
    followers_sq, _, posts_sq, is_following_sq = _count_columns(viewer_id)
    stmt = (
        select(Profile, followers_sq, posts_sq, is_following_sq)
        .where(Profile.is_featured.is_(True))
        # El propio usuario no se sugiere a si mismo.
        .where(Profile.id != viewer_id if viewer_id else literal(True))
        .order_by(Profile.created_at)
        .limit(20)
    )
    rows = (await db.execute(stmt)).all()
    return [
        FeaturedProfile(
            id=p.id,
            full_name=p.full_name,
            username=p.username,
            avatar_path=p.avatar_path,
            bio=p.bio,
            role=p.role,
            followers_count=fc or 0,
            posts_count=pc or 0,
            is_following=(isf or 0) > 0,
        )
        for p, fc, pc, isf in rows
    ]


@router.get("/search", response_model=list[ProfileSummary])
async def search_profiles(
    q: str = Query(min_length=1, max_length=80),
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> list[ProfileSummary]:
    term = q.strip()
    if len(term) < 2:
        return []
    viewer_id = current_user.id if current_user else None
    _, _, _, is_following_sq = _count_columns(viewer_id)
    pattern = f"%{term}%"
    stmt = (
        select(Profile, is_following_sq)
        .where(or_(Profile.username.ilike(pattern), Profile.full_name.ilike(pattern)))
        .order_by(Profile.full_name)
        .limit(20)
    )
    rows = (await db.execute(stmt)).all()
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


@router.get("", response_model=list[ProfileSummary])
async def list_profiles(
    page: Page = Depends(pagination_params),
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> list[ProfileSummary]:
    viewer_id = current_user.id if current_user else None
    _, _, _, is_following_sq = _count_columns(viewer_id)
    stmt = (
        select(Profile, is_following_sq)
        .order_by(Profile.created_at.desc())
        .limit(page.limit)
        .offset(page.offset)
    )
    rows = (await db.execute(stmt)).all()
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


@router.get("/{profile_id}", response_model=ProfileRead)
async def get_profile(
    profile_id: str,
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> ProfileRead:
    ensure_uuid(profile_id, "Perfil no encontrado.")
    viewer_id = current_user.id if current_user else None
    return await _load_profile(db, profile_id, viewer_id=viewer_id)
