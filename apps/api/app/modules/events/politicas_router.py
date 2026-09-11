"""Las políticas de un evento: las escribe quien organiza, las supervisa Z.

QUIÉN PUEDE QUÉ LO DECIDE EL SERVIDOR. Que un botón esté escondido no es un
permiso: cada ruta comprueba la propiedad del evento, el estado de la política y
el rol de quien llama.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ForbiddenError, NotFoundError, ValidationAppError
from app.core.security import AuthUser, get_current_user
from app.modules.catalog.models import Event
from app.modules.events import aceptacion, esquema, politicas
from app.modules.events import politicas_del_organizador as propias
from app.modules.events.posventa_models import EventPolicy
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.permissions import is_admin

router = APIRouter(prefix="/events", tags=["events-policies"])
admin_router = APIRouter(prefix="/admin/events", tags=["events-policies-admin"])


class PoliticaRead(BaseModel):
    """Una política, tal como la ve quien la escribe o quien la supervisa."""

    id: str
    event_id: str | None = None
    policy_type: str
    version: str
    status: str
    params: dict[str, Any] = Field(default_factory=dict)
    #: El texto que lee quien compra. `null` = no se escribió ninguno.
    body: str | None = None
    #: La huella de los parámetros. Es lo que hace demostrable qué se publicó.
    params_sha256: str
    published_at: datetime | None = None
    published_by: str | None = None
    created_by: str | None = None
    effective_from: datetime | None = None
    effective_to: datetime | None = None
    created_at: datetime


class BorradorRequest(BaseModel):
    policy_type: str
    version: str = Field(min_length=1, max_length=32)
    params: dict[str, Any] = Field(default_factory=dict)
    body: str | None = Field(default=None, max_length=propias.LARGO_DEL_TEXTO)


class EstadoDeLasPoliticas(BaseModel):
    """Lo que la pantalla necesita para no adivinar nada.

    `configurada` distingue SIN POLÍTICA de «no corresponde devolución», que es
    la diferencia entre «la empresa no lo ha decidido» y «se decidió que no».
    """

    event_id: str
    #: Los tipos que puede decidir quien organiza, y nada más.
    tipos: list[str]
    #: Si ESTE evento tiene las suyas propias publicadas.
    configurada: bool
    #: Si, además, se le aplica alguna de la plataforma. Sin esto, «no tienes
    #: políticas» y «no hay ninguna política» se leían igual, y no son lo mismo:
    #: `politicas.vigente` cae a la global y el comprador sí ve algo.
    hereda_de_la_plataforma: bool = False
    vigentes: list[PoliticaRead] = Field(default_factory=list)
    borradores: list[PoliticaRead] = Field(default_factory=list)
    historial: list[PoliticaRead] = Field(default_factory=list)


def _leida(p: EventPolicy) -> PoliticaRead:
    return PoliticaRead(
        id=p.id,
        event_id=p.event_id,
        policy_type=p.policy_type,
        version=p.version,
        status=p.status,
        params=dict(p.params or {}),
        body=p.body,
        params_sha256=p.params_sha256,
        published_at=p.published_at,
        published_by=p.published_by,
        created_by=p.created_by,
        effective_from=p.effective_from,
        effective_to=p.effective_to,
        created_at=p.created_at,
    )


# --------------------------------------------------------------------------- #
# Quien organiza
# --------------------------------------------------------------------------- #
@router.get("/{event_id}/policies", response_model=EstadoDeLasPoliticas)
async def politicas_del_evento(
    event_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EstadoDeLasPoliticas:
    """Todo lo del evento en una llamada: vigente, borrador e historial.

    Las superadas SE LEEN y no se tocan: son lo que aceptaron las compras de su
    momento.
    """
    await esquema.exigir_posventa(db)
    ensure_uuid(event_id, "Evento no encontrado.")
    todas = await propias.listar(
        db, evento_id=event_id, usuario_id=current_user.id
    )
    vigentes = [p for p in todas if p.status == politicas.PUBLICADA]
    borradores = [p for p in todas if p.status == politicas.BORRADOR]
    historial = [p for p in todas if p.status == politicas.SUPERADA]
    propios = {p.policy_type for p in vigentes}
    hereda = False
    for tipo in propias.TIPOS_DEL_ORGANIZADOR:
        if tipo in propios:
            continue
        if await politicas.vigente(db, tipo=tipo, evento_id=event_id) is not None:
            hereda = True
            break
    return EstadoDeLasPoliticas(
        event_id=event_id,
        tipos=list(propias.TIPOS_DEL_ORGANIZADOR),
        configurada=bool(vigentes),
        hereda_de_la_plataforma=hereda,
        vigentes=[_leida(p) for p in vigentes],
        borradores=[_leida(p) for p in borradores],
        historial=[_leida(p) for p in historial],
    )


@router.put("/{event_id}/policies/draft", response_model=PoliticaRead)
async def guardar_borrador(
    event_id: str,
    cuerpo: BorradorRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PoliticaRead:
    """Crea el borrador o reescribe el que haya. UNO por tipo y evento."""
    ensure_uuid(event_id, "Evento no encontrado.")
    borrador = await propias.guardar_borrador(
        db,
        evento_id=event_id,
        usuario_id=current_user.id,
        tipo=cuerpo.policy_type,
        version=cuerpo.version,
        params=cuerpo.params,
        body=cuerpo.body,
    )
    await db.commit()
    return _leida(borrador)


@router.delete("/policies/{policy_id}/draft", status_code=204)
async def descartar_borrador(
    policy_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Tira un borrador. Lo publicado no se borra nunca."""
    ensure_uuid(policy_id, "Política no encontrada.")
    await propias.descartar_borrador(
        db, politica_id=policy_id, usuario_id=current_user.id
    )
    await db.commit()


@router.post("/policies/{policy_id}/publish", response_model=PoliticaRead)
async def publicar(
    policy_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PoliticaRead:
    """Publica el borrador y supersede la vigente, en la misma transacción.

    LO YA VENDIDO NO CAMBIA: cada compra guarda la versión que aceptó.
    """
    ensure_uuid(policy_id, "Política no encontrada.")
    publicada = await propias.publicar_borrador(
        db, politica_id=policy_id, usuario_id=current_user.id
    )
    await db.commit()
    return _leida(publicada)


# --------------------------------------------------------------------------- #
# Quien compra: lo que se le enseña ANTES de pagar
# --------------------------------------------------------------------------- #
class CondicionRead(BaseModel):
    """Lo que rige para este evento, para leerlo antes de pagar.

    SIN la huella ni los identificadores internos: quien compra necesita saber
    qué se le promete, no con qué fila se guarda.
    """

    policy_type: str
    version: str
    body: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)


class CondicionesRead(BaseModel):
    #: `false` significa SIN POLÍTICA CONFIGURADA. No es «no hay devolución».
    configurada: bool
    condiciones: list[CondicionRead] = Field(default_factory=list)


@router.get("/{event_id}/policies/terms", response_model=CondicionesRead)
async def condiciones_del_evento(
    event_id: str, db: AsyncSession = Depends(get_db)
) -> CondicionesRead:
    """Las condiciones de venta de este evento. Se leen antes de pagar.

    Es una ruta ANÓNIMA a propósito: quien todavía no ha entrado tiene derecho a
    leer qué le van a prometer.
    """
    ensure_uuid(event_id, "Evento no encontrado.")
    # SIN ESQUEMA NO ES «sin política». `aplicables` devuelve lista vacía en los
    # dos casos, y `configurada: false` existe justo para no confundirlos.
    await esquema.exigir_posventa(db)
    vigentes = await aceptacion.aplicables(db, evento_id=event_id)
    return CondicionesRead(
        configurada=bool(vigentes),
        condiciones=[
            CondicionRead(
                policy_type=p.policy_type,
                version=p.version,
                body=p.body,
                params=dict(p.params or {}),
            )
            for p in vigentes
        ],
    )


class AceptacionRead(BaseModel):
    policy_type: str
    policy_version: str
    params_sha256: str
    accepted_at: datetime


@router.get("/orders/{order_id}/policies", response_model=list[AceptacionRead])
async def lo_que_acepto_mi_compra(
    order_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[AceptacionRead]:
    """Qué condiciones aceptó ESTA compra. Ni las de hoy ni las de nadie más."""
    from app.modules.events.models import EventOrder

    ensure_uuid(order_id, "Pedido no encontrado.")
    # Lista vacía significaría «no aceptó ninguna», y sin la 0069 significa que
    # no se guarda ninguna. No es lo mismo.
    await esquema.exigir_aceptaciones(db)
    orden = await db.get(EventOrder, order_id)
    if orden is None or orden.buyer_id != current_user.id:
        raise NotFoundError("Pedido no encontrado.")
    return [
        AceptacionRead(
            policy_type=f.policy_type,
            policy_version=f.policy_version,
            params_sha256=f.params_sha256,
            accepted_at=f.accepted_at,
        )
        for f in await aceptacion.de_la_orden(db, orden_id=order_id)
    ]


# --------------------------------------------------------------------------- #
# Supervisión
# --------------------------------------------------------------------------- #
class PoliticaSupervisada(PoliticaRead):
    """La política, más de qué evento y de quién es.

    `PoliticaRead` no los trae porque quien la escribe ya sabe de qué evento es.
    Quien supervisa mira muchas a la vez y necesita distinguirlas.
    """

    event_title: str | None = None
    organizer_id: str | None = None


@admin_router.get("/policies/overview", response_model=list[PoliticaSupervisada])
async def supervisar_politicas(
    organizer_id: str | None = Query(default=None),
    event_id: str | None = Query(default=None),
    policy_type: str | None = Query(default=None),
    estado: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[PoliticaSupervisada]:
    """Ver qué ha publicado cada organizador. SUPERVISIÓN, NO APROBACIÓN.

    Aquí no hay ningún paso de aprobación previa: la empresa no lo ha pedido, y
    convertir cada publicación en un trámite manual pararía a todo el mundo.
    Esto sirve para mirar, comparar y encontrar quién no tiene ninguna.
    """
    # EL ROL ANTES QUE EL ESQUEMA. Al revés, quien no tiene permiso distingue
    # un 503 de un 403 y con eso averigua qué migraciones están aplicadas.
    if not await is_admin(db, current_user.id):
        raise ForbiddenError("Solo administración.")
    await esquema.exigir_posventa(db)

    # SOLO LAS DE VENTA. `is_admin` incluye a moderación de contenido, y las
    # de plataforma —retención, reserva, quién asume una disputa, saldo
    # negativo— son dinero: viven detrás de `puede_mover_dinero` en su propio
    # panel. Moderar contenido no es administrar dinero, tampoco para leerlo.
    consulta = select(EventPolicy).where(
        EventPolicy.policy_type.in_(propias.TIPOS_DEL_ORGANIZADOR)
    )
    if event_id:
        ensure_uuid(event_id, "Evento no encontrado.")
        consulta = consulta.where(EventPolicy.event_id == event_id)
    if organizer_id:
        ensure_uuid(organizer_id, "Organizador no encontrado.")
        consulta = consulta.where(
            EventPolicy.event_id.in_(
                select(Event.id).where(Event.organizer_id == organizer_id)
            )
        )
    if policy_type:
        consulta = consulta.where(EventPolicy.policy_type == policy_type)
    if estado:
        consulta = consulta.where(EventPolicy.status == estado)
    consulta = consulta.order_by(
        EventPolicy.created_at.desc(), EventPolicy.id.desc()
    ).limit(limit)
    filas = list(await db.scalars(consulta))
    # EL EVENTO Y SU DUEÑO, EN UNA CONSULTA para todas: una por política sería
    # N+1 en la pantalla que más filas enseña.
    eventos: dict[str, tuple[str | None, str | None]] = {}
    identificadores = [p.event_id for p in filas if p.event_id]
    if identificadores:
        eventos = {
            str(i): (t, str(o) if o else None)
            for i, t, o in (
                await db.execute(
                    select(Event.id, Event.title, Event.organizer_id).where(
                        Event.id.in_(identificadores)
                    )
                )
            ).all()
        }
    salida: list[PoliticaSupervisada] = []
    for p in filas:
        titulo, dueno = eventos.get(str(p.event_id or ""), (None, None))
        salida.append(
            PoliticaSupervisada(
                **_leida(p).model_dump(), event_title=titulo, organizer_id=dueno
            )
        )
    return salida


class EventoSinPolitica(BaseModel):
    event_id: str
    title: str | None = None
    organizer_id: str | None = None
    policy_type: str


@admin_router.get("/policies/missing", response_model=list[EventoSinPolitica])
async def eventos_sin_politica(
    policy_type: str = Query(default=""),
    limit: int = Query(default=50, ge=1, le=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Los eventos publicados que NO tienen política propia de elegibilidad.

    Es la consulta que de verdad importa supervisar: un evento vendiendo sin
    condiciones escritas. No los bloquea —esa decisión no está tomada— pero
    deja de ser invisible.
    """
    await esquema.exigir_posventa(db)
    if not await is_admin(db, current_user.id):
        raise ForbiddenError("Solo administración.")

    from app.modules.events.posventa_models import POLITICA_ELEGIBILIDAD

    tipo = policy_type or POLITICA_ELEGIBILIDAD
    if tipo not in propias.TIPOS_DEL_ORGANIZADOR:
        raise ValidationAppError(
            "Ese tipo no lo decide quien organiza.",
            code="event_policy_type_not_allowed",
            details={"allowed": list(propias.TIPOS_DEL_ORGANIZADOR)},
        )
    filas = (
        await db.execute(
            select(Event.id, Event.title, Event.organizer_id)
            .where(
                Event.status == "published",
                ~select(EventPolicy.id)
                .where(
                    EventPolicy.scope == "event",
                    EventPolicy.event_id == Event.id,
                    EventPolicy.policy_type == tipo,
                    EventPolicy.status == politicas.PUBLICADA,
                    EventPolicy.effective_to.is_(None),
                )
                .exists(),
            )
            .order_by(Event.created_at.desc(), Event.id.desc())
            .limit(limit)
        )
    ).all()
    return [
        EventoSinPolitica(
            event_id=str(i),
            title=t,
            organizer_id=str(o) if o else None,
            policy_type=tipo,
        )
        for i, t, o in filas
    ]


@admin_router.get("/policies/{policy_id}", response_model=PoliticaRead)
async def detalle_de_politica(
    policy_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PoliticaRead:
    """El contenido de una política concreta, para revisarla."""
    await esquema.exigir_posventa(db)
    if not await is_admin(db, current_user.id):
        raise ForbiddenError("Solo administración.")
    ensure_uuid(policy_id, "Política no encontrada.")
    politica = await db.get(EventPolicy, policy_id)
    if politica is None or politica.policy_type not in propias.TIPOS_DEL_ORGANIZADOR:
        # 404 y no 403: una política de dinero no se le confirma a moderación
        # ni por su existencia.
        raise NotFoundError("Política no encontrada.")
    return _leida(politica)


__all__ = ["admin_router", "router"]
