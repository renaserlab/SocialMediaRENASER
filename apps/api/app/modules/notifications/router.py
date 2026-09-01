"""Endpoints de notificaciones in-app."""

from fastapi import APIRouter, Depends, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import AuthUser, get_current_user
from app.modules.content.schemas import AuthorSummary
from app.modules.content.models import PostLike
from app.modules.notifications.models import Notification
from app.modules.notifications.schemas import NotificationRead
from app.modules.profiles.models import Profile
from app.shared.database import get_db
from app.shared.pagination import Page, pagination_params

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationRead])
async def list_notifications(
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[NotificationRead]:
    rows = (
        await db.execute(
            select(Notification, Profile)
            .outerjoin(Profile, Profile.id == Notification.actor_id)
            .where(Notification.user_id == current_user.id)
            .order_by(Notification.created_at.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    ).all()
    # UNA notificación por publicación, no una por persona.
    #
    # Cien personas reaccionando a un vídeo generaban cien avisos, y la pantalla
    # de notificaciones dejaba de servir para nada: lo único que había pasado
    # era una cosa —«gustó tu vídeo»— contada cien veces.
    #
    # Se agrupa AL LEER y no al escribir. Escribiendo haría falta encontrar y
    # actualizar la fila anterior, lo que pide un índice único, y ese índice no
    # se puede crear mientras existan los duplicados que ya hay guardados: habría
    # que borrarlos primero. Agrupando aquí no se toca ni una fila, funciona con
    # lo que ya está en la base y se deshace quitando este bloque.
    #
    # Se conserva la MÁS RECIENTE de cada publicación, que es la que trae el
    # último actor: es lo que se lee en «Edson y 99 personas más».
    vistas: set[str] = set()
    agrupadas: list[tuple[Notification, Profile | None]] = []
    for notif, actor in rows:
        if notif.type == "like" and notif.entity_id:
            if notif.entity_id in vistas:
                continue
            vistas.add(notif.entity_id)
        agrupadas.append((notif, actor))
    rows = agrupadas

    # Cuánta gente reaccionó de verdad a cada una, en UNA consulta para todas.
    # Se cuenta `post_likes` y no las notificaciones porque las notificaciones
    # se duplican —quitar y volver a poner un me gusta deja dos filas— y porque
    # al retirarlo la notificación se queda, pero la reacción no.
    conteos: dict[str, int] = {}
    if vistas:
        filas = (
            await db.execute(
                select(PostLike.post_id, func.count())
                .where(PostLike.post_id.in_(vistas))
                .group_by(PostLike.post_id)
            )
        ).all()
        conteos = {post_id: total for post_id, total in filas}

    result: list[NotificationRead] = []
    for notif, actor in rows:
        result.append(
            NotificationRead(
                id=notif.id,
                type=notif.type,
                actor=(
                    AuthorSummary(
                        id=actor.id,
                        full_name=actor.full_name,
                        username=actor.username,
                        avatar_path=actor.avatar_path,
                    )
                    if actor is not None
                    else None
                ),
                entity_type=notif.entity_type,
                entity_id=notif.entity_id,
                payload=notif.payload or {},
                read=notif.read_at is not None,
                created_at=notif.created_at,
                group_count=conteos.get(notif.entity_id or "") if notif.type == "like" else None,
            )
        )
    return result


@router.get("/unread-count")
async def unread_count(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    value = await db.scalar(
        select(func.count())
        .select_from(Notification)
        .where(Notification.user_id == current_user.id, Notification.read_at.is_(None))
    )
    return {"count": value or 0}


@router.post("/{notification_id}/read", status_code=status.HTTP_204_NO_CONTENT)
async def mark_read(
    notification_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    await db.execute(
        update(Notification)
        .where(
            Notification.id == notification_id,
            Notification.user_id == current_user.id,
        )
        .values(read_at=func.now())
    )
    await db.commit()


@router.post("/read-all", status_code=status.HTTP_204_NO_CONTENT)
async def mark_all_read(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    await db.execute(
        update(Notification)
        .where(
            Notification.user_id == current_user.id,
            Notification.read_at.is_(None),
        )
        .values(read_at=func.now())
    )
    await db.commit()
