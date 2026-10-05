"""Endpoints del grafo social: seguir / dejar de seguir / bloquear.

La identidad (quién sigue o bloquea) se toma siempre del JWT.
"""

from fastapi import APIRouter, BackgroundTasks, Depends
from sqlalchemy import delete, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.exceptions import NotFoundError, ValidationAppError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.modules.notifications.push import encolar_push, nombre_visible
from app.modules.notifications.service import add_notification
from app.modules.profiles.models import Profile
from app.modules.recommendations.signals import registrar_senal
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
        # Alias TIPADO del modelo (no literal_column): asi `follower_id` conserva
        # su tipo UUID y no se compara como texto contra el viewer, que reventaba
        # con "operator does not exist: uuid = character varying".
        f2 = aliased(Follow)
        is_following_sq = (
            select(func.count())
            .select_from(f2)
            .where(
                f2.follower_id == viewer_id,
                f2.following_id == Profile.id,
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


@router.get("/me/blocked", response_model=list[ProfileSummary])
async def list_blocked(
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ProfileSummary]:
    """Perfiles que ha bloqueado quien hace la peticion.

    Sin este listado, bloquear seria una via de sentido unico: la persona
    bloqueada desaparece de la vista y ya no habria forma de encontrarla para
    revertirlo.

    Se declara antes que `/{profile_id}/...` porque si no esa ruta capturaria
    la palabra "me" y responderia 404.
    """
    rows = (
        await db.execute(
            select(Profile)
            .join(UserBlock, UserBlock.blocked_id == Profile.id)
            .where(UserBlock.blocker_id == current_user.id)
            .order_by(UserBlock.created_at.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    ).scalars().all()
    return [
        ProfileSummary(
            id=p.id,
            full_name=p.full_name,
            username=p.username,
            avatar_path=p.avatar_path,
            bio=p.bio,
            # Al bloquear se deshace el seguimiento en ambos sentidos, asi que
            # aqui siempre es falso.
            is_following=False,
        )
        for p in rows
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
    background: BackgroundTasks,
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
        # ESTE `if` NO ES LA GARANTIA, y es justo lo que producia el aviso
        # repetido de la captura: al dejar de seguir, la fila de `follows` SE
        # BORRA, asi que al volver a seguir vuelve a entrar aqui y se escribia
        # un segundo «empezo a seguirte» debajo del primero. Y dos peticiones
        # simultaneas —doble toque, reintento al cambiar de red— pasan las dos.
        #
        # La idempotencia la pone ahora la base (`dedupe_key`, migracion 0043).
        # `add_notification` devuelve si ha escrito de verdad, y de eso depende
        # que ademas suene el telefono.
        estrenado = await add_notification(
            db, user_id=profile_id, actor_id=current_user.id, type="follow"
        )
        # Seguir es una de las senales que mas dice, y la escribe el SERVIDOR:
        # es aqui donde consta que ocurrio de verdad. Viaja en el mismo commit
        # que el seguimiento, asi que no puede quedar una senal de algo que no
        # llego a pasar.
        await registrar_senal(
            db,
            user_id=current_user.id,
            event_type="follow",
            entity_type="profile",
            entity_id=profile_id,
        )
        await db.commit()
        # Despues del commit: un aviso de algo que no se guardo seria peor que
        # no avisar.
        #
        # El nombre sale del PERFIL de quien sigue, no del token: `AuthUser`
        # lleva la identidad (id, correo, rol), no el nombre para mostrar, y
        # pedirselo reventaba el seguimiento con un AttributeError justo
        # despues de haberlo guardado.
        if estrenado:
            actor = await db.get(Profile, current_user.id)
            encolar_push(
                background,
                user_ids=[profile_id],
                notification_type="follow",
                actor_name=nombre_visible(actor.full_name, actor.username) if actor else None,
                data={"type": "follow", "profileId": current_user.id},
            )
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
    # Antes de tocar la base: un id con otro formato llegaba hasta el driver y
    # el manejador de DBAPIError lo convertia en un 404 silencioso, que se lee
    # como «ese perfil no existe» cuando lo que pasa es que el id esta mal.
    ensure_uuid(profile_id, "Perfil no encontrado.")
    if profile_id == current_user.id:
        raise ValidationAppError("No puedes bloquearte a ti mismo.")
    await _require_profile(db, profile_id)
    # IDEMPOTENTE: bloquear a quien ya esta bloqueado no es un error, es el
    # resultado que quien pulsa venia buscando. Sin este `if`, la segunda vez
    # reventaba con una violacion de clave primaria —que sale como 500— por
    # pulsar dos veces o por el reintento de una red lenta.
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
    """Quita el bloqueo. IDEMPOTENTE: desbloquear dos veces responde lo mismo.

    NO devuelve el seguimiento que el bloqueo deshizo, y no es un olvido: eso
    seria decidir por dos personas que quieren volver a seguirse. Se desbloquea
    y cada una vuelve a seguir si quiere.
    """
    ensure_uuid(profile_id, "Perfil no encontrado.")
    await db.execute(
        delete(UserBlock).where(
            UserBlock.blocker_id == current_user.id,
            UserBlock.blocked_id == profile_id,
        )
    )
    await db.commit()
    return {"blocked": False}
