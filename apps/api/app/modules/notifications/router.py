"""Endpoints de notificaciones in-app."""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, status
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
admin_router = APIRouter(prefix="/admin/notifications", tags=["notifications-admin"])


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
    since: datetime | None = Query(
        default=None,
        description="Con esto, la respuesta dice ademas cuantos son posteriores a ese instante.",
    ),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    """Cuantos avisos hay sin leer y, si se pregunta, cuantos son NUEVOS.

    POR QUE `since` (04/10/2026). La aplicacion, abierta, pregunta de vez en
    cuando si hay algo nuevo que anunciar. Lo decidia comparando la cuenta de
    ahora con la de antes: «si subio, hay algo». Pero la cuenta de antes la
    escribian tambien otras pantallas, y abrir la bandeja la pone a cero: bastaba
    con que alguien la refrescara primero para que «te han pedido una sesion» no
    se anunciara nunca. Una cuenta no dice si lo que hay es nuevo.

    Con `since` —el instante del ultimo aviso que la aplicacion ya vio— el
    servidor responde exactamente eso: cuantos sin leer son posteriores. Es la
    misma consulta con indice; no se piden filas.

    SIN `since` responde lo de siempre, y solo `count`: una aplicacion anterior
    no se entera de nada.
    """
    sin_leer = (Notification.user_id == current_user.id) & Notification.read_at.is_(None)
    if since is None:
        value = await db.scalar(select(func.count()).select_from(Notification).where(sin_leer))
        return {"count": value or 0}

    if since.tzinfo is None:
        # Sin zona se toma como UTC: comparar con una columna con zona un
        # instante que no la tiene revienta en el driver.
        since = since.replace(tzinfo=timezone.utc)
    total, nuevos = (
        await db.execute(
            select(
                func.count(),
                func.count().filter(Notification.created_at > since),
            )
            .select_from(Notification)
            .where(sin_leer)
        )
    ).one()
    return {"count": total or 0, "new_count": nuevos or 0}


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


# --------------------------------------------------------------------------- #
# La cola de entregas. La vacía un planificador EXTERNO.
# --------------------------------------------------------------------------- #
@admin_router.post("/deliveries/process")
async def procesar_entregas(
    limit: int = 50,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Intenta las entregas que tocan ahora. Idempotente y acotado.

    DENTRO DE LA API NO HAY TEMPORIZADOR: hay varias réplicas y cada una
    dispararía el suyo. Esto lo invoca un planificador externo; el documento de
    despliegue dice con qué frecuencia.
    """
    from app.core.exceptions import ForbiddenError, ServiceUnavailableError
    from app.modules.notifications import entregas, esquema, push
    from app.shared.permissions import is_admin

    if not await is_admin(db, current_user.id):
        raise ForbiddenError("Solo administración procesa la cola de avisos.")
    if not await esquema.hay_entregas(db):
        raise ServiceUnavailableError(
            "La cola de avisos todavía no está desplegada.",
            code="notification_deliveries_not_available",
        )

    async def _enviar(sesion, *, usuario_id: str, tipo: str, locale: str) -> bool:
        # SE DEVUELVE LO QUE CONTESTA. Sin este `return`, `procesar` recibía
        # `None`, y `None is not False` es cierto: todo se contaba como enviado
        # y `sin_destino` no se incrementaba jamás. El defecto que el envío
        # decía haber corregido volvía por el envoltorio.
        return await push.enviar_de_la_cola(
            sesion, usuario_id=usuario_id, tipo=tipo, locale=locale
        )

    return await entregas.procesar(db, enviar=_enviar, limite=limit)


@admin_router.get("/deliveries/health")
async def salud_de_entregas(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Cuántas entregas hay en cada estado."""
    from app.core.exceptions import ForbiddenError
    from app.modules.notifications import entregas, esquema
    from app.shared.permissions import is_admin

    if not await is_admin(db, current_user.id):
        raise ForbiddenError("Solo administración ve la cola de avisos.")
    if not await esquema.hay_entregas(db):
        return {"disponible": False}
    return {"disponible": True, **await entregas.resumen(db)}
