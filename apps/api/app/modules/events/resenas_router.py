"""La API de reseñas de evento.

APAGADA POR POLÍTICA, NO POR AUSENCIA. Las rutas existen; sin la política
`review_window` publicada, crear una reseña se rechaza con un código estable y
la ficha no enseña ninguna sección. El plazo para opinar y el efecto de una
devolución posterior sobre el sello los decide la empresa.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError
from app.core.security import AuthUser, get_current_user
from app.modules.events import resenas
from app.modules.events.resenas_models import EventReview
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.permissions import is_admin

router = APIRouter(prefix="/events", tags=["events-reviews"])


class EjesRequest(BaseModel):
    """Los cinco del blueprint. Todos opcionales: quien solo quiera contestar
    la pregunta general no se queda sin poder opinar."""

    content: int | None = Field(default=None, ge=1, le=5)
    organization: int | None = Field(default=None, ge=1, le=5)
    venue: int | None = Field(default=None, ge=1, le=5)
    safety: int | None = Field(default=None, ge=1, le=5)
    value: int | None = Field(default=None, ge=1, le=5)


class CrearResenaRequest(BaseModel):
    overall: int = Field(ge=1, le=5)
    ejes: EjesRequest | None = None
    recommends: bool | None = None
    comment: str | None = Field(default=None, max_length=1000)


class RespuestaRead(BaseModel):
    """La respuesta del organizador, tal como se lee debajo de la reseña."""

    id: str
    author_id: str
    body: str
    created_at: datetime


class ResenaRead(BaseModel):
    """Una reseña publicada. SIN la entrada ni el check-in que la respaldan.

    Los dos atan a una persona con un acceso concreto, y el sello ya dice lo
    único que el lector necesita saber.
    """

    id: str
    event_id: str
    author_id: str
    overall: int
    content: int | None = None
    organization: int | None = None
    venue: int | None = None
    safety: int | None = None
    value: int | None = None
    recommends: bool | None = None
    comment: str | None = None
    #: Siempre `True`: una reseña existe porque hubo check-in. Va explícito
    #: para que la pantalla no tenga que deducirlo.
    asistencia_verificada: bool = True
    #: La respuesta del organizador, si la hay. UNA como mucho, y solo si está
    #: visible: una escondida por moderación no se lee.
    respuesta: RespuestaRead | None = None
    #: Estado de la reseña. Solo viaja en la reseña PROPIA: en la lista pública
    #: no hace falta, porque las escondidas ni siquiera salen.
    status: str | None = None
    created_at: datetime


class ResumenRead(BaseModel):
    """El resumen de la ficha. `promedio` es `null` cuando no hay reseñas.

    NO ES CERO. Un evento sin reseñas no tiene una puntuación de 0.0: no tiene
    puntuación, y pintar estrellas vacías dice algo que nadie ha dicho.
    """

    total: int
    promedio: float | None = None
    histograma: dict[int, int] = Field(default_factory=dict)
    #: En puntos básicos, y `null` si nadie contestó a la pregunta.
    recomiendan_bps: int | None = None
    por_eje: dict[str, float | None] = Field(default_factory=dict)


class PuedeResenarRead(BaseModel):
    puede: bool
    #: Código estable: `policy_not_configured`, `no_check_in`, `own_event`,
    #: `event_not_finished`, `already_reviewed`…
    motivo: str


class ResponderRequest(BaseModel):
    body: str = Field(min_length=1, max_length=1000)


class ModerarRequest(BaseModel):
    hide: bool
    reason: str | None = Field(default=None, max_length=500)


def _leida(r: EventReview, respuesta=None, *, con_estado: bool = False) -> ResenaRead:
    return ResenaRead(
        id=r.id,
        event_id=r.event_id,
        author_id=r.author_id,
        overall=r.overall,
        content=r.content,
        organization=r.organization,
        venue=r.venue,
        safety=r.safety,
        value=r.value,
        recommends=r.recommends,
        comment=r.comment,
        respuesta=(
            RespuestaRead(
                id=respuesta.id,
                author_id=respuesta.author_id,
                body=respuesta.body,
                created_at=respuesta.created_at,
            )
            if respuesta is not None
            else None
        ),
        status=r.status if con_estado else None,
        created_at=r.created_at,
    )


@router.get("/{event_id}/reviews/summary", response_model=ResumenRead)
async def resumen_del_evento(
    event_id: str, db: AsyncSession = Depends(get_db)
) -> ResumenRead:
    """El resumen. Una consulta agregada, no una lista traída a memoria."""
    ensure_uuid(event_id, "Evento no encontrado.")
    r = await resenas.resumen(db, evento_id=event_id)
    return ResumenRead(
        total=r.total,
        promedio=r.promedio,
        histograma=r.histograma,
        recomiendan_bps=r.recomiendan_bps,
        por_eje=r.por_eje,
    )


@router.get("/{event_id}/reviews", response_model=list[ResenaRead])
async def listar_resenas(
    event_id: str,
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[ResenaRead]:
    ensure_uuid(event_id, "Evento no encontrado.")
    filas = await resenas.listar(db, evento_id=event_id, limite=limit, cursor=cursor)
    # LAS RESPUESTAS, EN UNA CONSULTA para todas: una por reseña sería N+1 en la
    # pantalla que más se abre.
    respuestas = await resenas.respuestas_de(db, resenas_ids=[r.id for r in filas])
    return [_leida(r, respuestas.get(r.id)) for r in filas]


@router.get("/{event_id}/reviews/mine", response_model=ResenaRead | None)
async def mi_resena(
    event_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ResenaRead | None:
    """La reseña propia de este evento, para poder editarla.

    Incluye la ESCONDIDA por moderación —con su estado— porque su autor tiene
    que poder ver lo que escribió. `null` si no ha escrito ninguna.
    """
    ensure_uuid(event_id, "Evento no encontrado.")
    fila = await resenas.mia(db, evento_id=event_id, usuario_id=current_user.id)
    if fila is None:
        return None
    respuestas = await resenas.respuestas_de(db, resenas_ids=[fila.id])
    return _leida(fila, respuestas.get(fila.id), con_estado=True)


@router.get("/{event_id}/reviews/can-review", response_model=PuedeResenarRead)
async def puedo_resenar(
    event_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PuedeResenarRead:
    """Si esta persona puede valorar, y por qué no. El motivo es un código."""
    ensure_uuid(event_id, "Evento no encontrado.")
    puede, motivo, _ = await resenas.puede_resenar(
        db, evento_id=event_id, usuario_id=current_user.id
    )
    return PuedeResenarRead(puede=puede, motivo=motivo)


@router.post("/{event_id}/reviews", response_model=ResenaRead, status_code=201)
async def crear_resena(
    event_id: str,
    payload: CrearResenaRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ResenaRead:
    """Publica la reseña. Exige asistencia verificada Y política publicada."""
    ensure_uuid(event_id, "Evento no encontrado.")
    resena = await resenas.crear(
        db,
        evento_id=event_id,
        usuario_id=current_user.id,
        overall=payload.overall,
        ejes=payload.ejes.model_dump() if payload.ejes else None,
        recomienda=payload.recommends,
        comentario=payload.comment,
    )
    await db.commit()
    return _leida(resena)


@router.patch("/reviews/{review_id}", response_model=ResenaRead)
async def editar_resena(
    review_id: str,
    payload: CrearResenaRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ResenaRead:
    """Solo su autor. 404 para la ajena, nunca 403."""
    ensure_uuid(review_id, "Reseña no encontrada.")
    resena = await resenas.editar(
        db,
        resena_id=review_id,
        usuario_id=current_user.id,
        overall=payload.overall,
        ejes=payload.ejes.model_dump() if payload.ejes else None,
        recomienda=payload.recommends,
        comentario=payload.comment,
    )
    await db.commit()
    return _leida(resena)


@router.post("/reviews/{review_id}/reply", status_code=201)
async def responder_resena(
    review_id: str,
    payload: ResponderRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """La respuesta del organizador. APAGADA hasta que la empresa la habilite."""
    ensure_uuid(review_id, "Reseña no encontrada.")
    respuesta = await resenas.responder(
        db, resena_id=review_id, usuario_id=current_user.id, texto=payload.body
    )
    await db.commit()
    return {"id": respuesta.id, "status": respuesta.status}


@router.post("/reviews/{review_id}/moderate", response_model=ResenaRead)
async def moderar_resena(
    review_id: str,
    payload: ModerarRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ResenaRead:
    """Esconder o volver a mostrar. NUNCA cambia autor ni puntuación.

    Es moderación de CONTENIDO, así que `is_admin` —que incluye moderadores— es
    el permiso correcto. Lo que ese conjunto no puede es mover dinero, y eso se
    comprueba en otro sitio.
    """
    ensure_uuid(review_id, "Reseña no encontrada.")
    if not await is_admin(db, current_user.id):
        raise ForbiddenError("Solo moderación puede esconder una reseña.")
    resena = await resenas.moderar(
        db,
        resena_id=review_id,
        actor_id=current_user.id,
        esconder=payload.hide,
        motivo=payload.reason,
    )
    await db.commit()
    return _leida(resena)
