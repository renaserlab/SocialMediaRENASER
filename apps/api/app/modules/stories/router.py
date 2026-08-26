"""Endpoints de historias: publicar, ver, registrar visualizaciones y borrar.

Como en el resto de modulos, el autor de una historia y el espectador de una
vista salen SIEMPRE de current_user.id (JWT), nunca de un campo del cliente.

Una historia caduca a las 24 h (`expires_at`, que fija la base). El listado
filtra siempre por esa fecha, asi que no hace falta ningun proceso de limpieza
para que dejen de mostrarse.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, status
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError, NotFoundError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.content.schemas import AuthorSummary
from app.modules.profiles.models import Profile
from app.modules.stories.models import Story, StoryView
from app.modules.stories.schemas import StoryCreate, StoryGroupRead, StoryRead, StoryViewerRead
from app.shared.database import get_db
from app.shared.permissions import is_admin

router = APIRouter(tags=["stories"])


def _author_summary(profile: Profile) -> AuthorSummary:
    return AuthorSummary(
        id=profile.id,
        full_name=profile.full_name,
        username=profile.username,
        avatar_path=profile.avatar_path,
    )


async def _get_story(db: AsyncSession, story_id: str) -> Story:
    story = await db.get(Story, story_id)
    if story is None:
        raise NotFoundError("La historia no existe o ya caduco.")
    return story


@router.get("/stories", response_model=list[StoryGroupRead])
async def list_stories(
    current_user: AuthUser | None = Depends(get_optional_user),
    db: AsyncSession = Depends(get_db),
) -> list[StoryGroupRead]:
    """Historias vigentes agrupadas por autor.

    Orden: primero las que te faltan por ver y, dentro de cada grupo, de la mas
    antigua a la mas nueva (asi el visor avanza cronologicamente). Las propias
    van siempre delante, como en Instagram.
    """
    uid = current_user.id if current_user else None
    now = datetime.now(timezone.utc)

    stmt = (
        select(Story, Profile)
        .join(Profile, Profile.id == Story.author_id)
        .where(Story.expires_at > now)
        .order_by(Story.author_id, Story.created_at.asc())
    )
    rows = (await db.execute(stmt)).all()
    if not rows:
        return []

    # Que historias ha visto el usuario actual (una sola consulta).
    seen_ids: set[str] = set()
    if uid:
        story_ids = [story.id for story, _ in rows]
        seen_rows = await db.execute(
            select(StoryView.story_id).where(
                StoryView.viewer_id == uid, StoryView.story_id.in_(story_ids)
            )
        )
        seen_ids = {row[0] for row in seen_rows}

    # Contador de vistas, solo para las historias propias (es lo unico que el
    # autor puede consultar y evita cargar el recuento de todo el mundo).
    views_by_story: dict[str, int] = {}
    if uid:
        own_ids = [story.id for story, _ in rows if story.author_id == uid]
        if own_ids:
            count_rows = await db.execute(
                select(StoryView.story_id, func.count())
                .where(StoryView.story_id.in_(own_ids))
                .group_by(StoryView.story_id)
            )
            views_by_story = {row[0]: row[1] for row in count_rows}

    groups: dict[str, StoryGroupRead] = {}
    for story, profile in rows:
        group = groups.get(profile.id)
        if group is None:
            group = StoryGroupRead(
                author=_author_summary(profile),
                items=[],
                seen=True,
                is_own=profile.id == uid,
            )
            groups[profile.id] = group

        viewed = story.id in seen_ids
        group.items.append(
            StoryRead(
                id=story.id,
                storage_path=story.storage_path,
                media_type=story.media_type,
                duration_ms=story.duration_ms,
                caption=story.caption,
                created_at=story.created_at,
                expires_at=story.expires_at,
                viewed_by_me=viewed,
                views_count=views_by_story.get(story.id, 0),
            )
        )
        # Basta con que quede un tramo sin ver para que el anillo siga activo.
        if not viewed:
            group.seen = False

    ordered = sorted(
        groups.values(),
        key=lambda g: (
            not g.is_own,  # las propias primero
            g.seen,  # luego las que faltan por ver
            # y dentro de cada bloque, la mas reciente arriba
            -(g.items[-1].created_at.timestamp() if g.items else 0),
        ),
    )
    return ordered


@router.post("/stories", response_model=StoryRead, status_code=status.HTTP_201_CREATED)
async def create_story(
    payload: StoryCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StoryRead:
    story = Story(
        author_id=current_user.id,
        storage_path=payload.storage_path,
        media_type=payload.media_type,
        duration_ms=payload.duration_ms,
        caption=payload.caption,
    )
    db.add(story)
    await db.commit()
    # `expires_at` y `created_at` los calcula la base: hay que releerlos.
    await db.refresh(story)
    return StoryRead.model_validate(story)


@router.delete("/stories/{story_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_story(
    story_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    story = await _get_story(db, story_id)
    # El rol de la aplicacion vive en `profiles.role`, NO en el token: en el JWT
    # de Supabase `role` vale SIEMPRE "authenticated", asi que compararlo con
    # "admin" o "moderator" no se cumplia nunca y la moderacion no podia retirar
    # una historia denunciada. Es el mismo fallo que ya se corrigio en
    # `/payments/courses/{id}/access`.
    if story.author_id != current_user.id and not await is_admin(db, current_user.id):
        raise ForbiddenError("No puedes eliminar esta historia.")
    # Borrado real: una historia es efimera por definicion y las vistas caen en
    # cascada. El archivo del bucket se limpia aparte.
    await db.execute(delete(Story).where(Story.id == story_id))
    await db.commit()


@router.post("/stories/{story_id}/view", status_code=status.HTTP_204_NO_CONTENT)
async def mark_story_viewed(
    story_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Registra que el usuario vio la historia. Idempotente.

    El visor lo llama por cada tramo, asi que se ignora el conflicto contra la
    clave primaria (story_id, viewer_id) en vez de consultar antes.
    """
    story = await _get_story(db, story_id)
    # Ver la propia historia no cuenta como visita.
    if story.author_id == current_user.id:
        return
    await db.execute(
        pg_insert(StoryView)
        .values(story_id=story_id, viewer_id=current_user.id)
        .on_conflict_do_nothing(index_elements=["story_id", "viewer_id"])
    )
    await db.commit()


@router.get("/stories/{story_id}/viewers", response_model=list[StoryViewerRead])
async def list_story_viewers(
    story_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[StoryViewerRead]:
    """Quien vio la historia. Solo para su autor."""
    story = await _get_story(db, story_id)
    # Mismo motivo que en el borrado: `profiles.role`, nunca el `role` del token.
    if story.author_id != current_user.id and not await is_admin(db, current_user.id):
        raise ForbiddenError("Solo el autor puede ver esta informacion.")

    rows = (
        await db.execute(
            select(StoryView, Profile)
            .join(Profile, Profile.id == StoryView.viewer_id)
            .where(StoryView.story_id == story_id)
            .order_by(StoryView.viewed_at.desc())
        )
    ).all()
    return [
        StoryViewerRead(viewer=_author_summary(profile), viewed_at=view.viewed_at)
        for view, profile in rows
    ]
