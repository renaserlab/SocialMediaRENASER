"""Endpoints de perfiles: perfil propio, público, edición y búsqueda.

Los perfiles vienen enriquecidos con contadores (seguidores/seguidos/posts) y,
si hay sesión, con is_following (si el usuario actual sigue a ese perfil).
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, literal, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.content.models import Post, PostLike
from app.modules.profiles.models import Profile
from app.modules.profiles.schemas import (
    FeaturedProfile,
    ProfileRead,
    ProfileSummary,
    ProfileUpdate,
)
from app.modules.social_graph.models import Follow, UserBlock
from app.modules.social_graph.service import is_blocked_column
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.pagination import Page, pagination_params

router = APIRouter(prefix="/profiles", tags=["profiles"])


# --------------------------------------------------------------------------- #
# Helpers de contadores
# --------------------------------------------------------------------------- #
def _blocked_column(viewer_id: str | None):
    """Si el visitante ha bloqueado el perfil de cada fila."""
    column = is_blocked_column(viewer_id, Profile.id)
    return column if column is not None else literal(False)


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
    """
    "Me gusta" del perfil = los RECIBIDOS en sus publicaciones.

    Es la cifra que el documento pide junto a seguidores y seguidos, y la unica
    lectura util de las dos posibles: cuantos ha dado una persona no dice nada
    de ella para quien la visita. Se cuentan solo los de publicaciones
    publicadas, para que borrar o archivar una no deje likes fantasma.
    """
    likes = (
        select(func.count())
        .select_from(PostLike)
        .join(Post, Post.id == PostLike.post_id)
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
    return followers, following, posts, likes, is_following


def _to_profile_read(
    profile: Profile,
    fc: int,
    gc: int,
    pc: int,
    lc: int,
    isf: int,
    blocked: bool = False,
) -> ProfileRead:
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
        likes_count=lc or 0,
        intro_audio_path=profile.intro_audio_path,
        intro_audio_duration_s=profile.intro_audio_duration_s,
        intro_audio_updated_at=profile.intro_audio_updated_at,
        is_following=(isf or 0) > 0,
        is_blocked=bool(blocked),
    )


async def _load_profile(
    db: AsyncSession, profile_id: str, viewer_id: str | None
) -> ProfileRead:
    fc, gc, pc, lc, isf = _count_columns(viewer_id)
    blocked = _blocked_column(viewer_id)
    row = (
        await db.execute(
            select(Profile, fc, gc, pc, lc, isf, blocked).where(
                Profile.id == profile_id
            )
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

    datos = payload.model_dump(exclude_unset=True)

    # EL NOMBRE DE USUARIO ES UNICO EN LA BASE, y hasta aqui eso se descubria
    # chocando: elegir uno ya cogido reventaba el `commit` con un IntegrityError
    # sin capturar, o sea un 500 —que ademas sale sin cabeceras CORS y en el
    # navegador se disfraza de fallo de red—. La pantalla de editar perfil YA
    # sabe pintar «Ese nombre de usuario ya está en uso» cuando recibe un 409
    # (`EditProfileScreen`), asi que lo unico que faltaba era mandarselo.
    #
    # Se compara EXACTAMENTE como lo compara el indice unico de la 0001: una
    # comprobacion mas estricta rechazaria nombres que la base si aceptaria.
    nuevo_usuario = datos.get("username")
    if nuevo_usuario and nuevo_usuario != profile.username:
        cogido = await db.scalar(
            select(Profile.id).where(
                Profile.username == nuevo_usuario, Profile.id != current_user.id
            )
        )
        if cogido is not None:
            raise ConflictError(
                "Ese nombre de usuario ya está en uso.", code="username_taken"
            )

    for field, value in datos.items():
        # `exclude_unset` ya distingue "no enviado" de "enviado". Para las
        # imagenes hace falta un valor que signifique "quitar": la cadena vacia
        # se guarda como NULL para volver a la imagen por defecto.
        #
        # `username` va en el mismo grupo, y no por simetria: en la base es
        # NULL mientras nadie elija uno —el registro no lo pide (ver el
        # disparador `handle_new_user`)—, asi que la pantalla de editar perfil
        # lo manda vacio y con eso la peticion ENTERA se rechazaba con un 422.
        # Quien no habia elegido nombre de usuario no podia guardar tampoco su
        # nombre ni su biografia.
        if (
            field in {"avatar_path", "cover_path", "intro_audio_path", "username"}
            and value == ""
        ):
            value = None
        setattr(profile, field, value)
    """
    Quitar el audio quita tambien lo que lo describe.

    Si no, un perfil sin audio seguiria anunciando "0:34" y el reproductor
    pintaria una barra de un audio que ya no existe.
    """
    if "intro_audio_path" in payload.model_fields_set:
        profile.intro_audio_updated_at = (
            datetime.now(timezone.utc) if profile.intro_audio_path else None
        )
        if profile.intro_audio_path is None:
            profile.intro_audio_duration_s = None
    try:
        await db.commit()
    except IntegrityError as exc:
        # Red de seguridad para la carrera: dos personas eligiendo el mismo
        # nombre a la vez pasan las dos la comprobacion de arriba y solo una
        # llega. Quien pierde recibe un 409, no un 500.
        await db.rollback()
        raise ConflictError(
            "Ese nombre de usuario ya está en uso.", code="username_taken"
        ) from exc
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
    followers_sq, _, posts_sq, _, is_following_sq = _count_columns(viewer_id)
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
    *_, is_following_sq = _count_columns(viewer_id)
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
    *_, is_following_sq = _count_columns(viewer_id)
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
