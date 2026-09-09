"""HTTP de Eventos: organizador y admisión.

LO PÚBLICO NO ESTÁ AQUÍ. `GET /catalog/events` y `GET /catalog/events/{id}`
siguen donde estaban y con el mismo contrato: son las dos rutas que la
aplicación instalada ya llama, y romperlas para reordenar carpetas no arregla
nada. Lo que hacen ahora es consultar a este dominio para saber si un evento
lleva sello Z.

CADA TRANSICIÓN, UNA ACCIÓN CON NOMBRE. No hay ningún `PATCH` que acepte
`workflow_status`: el ciclo se mueve por `/submit`, `/review`, `/decision`,
`/publish`, `/suspend` y `/resume`, cada una con su comprobación y su rastro.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError
from app.core.security import AuthUser, get_current_user
from app.modules.events import admission, esquema, permissions, service, states
from app.modules.events.schemas import (
    BorradorCreate,
    BorradorUpdate,
    DecisionCreate,
    DocumentoRead,
    DocumentoUpsert,
    EnvioARevision,
    EvaluacionCreate,
    EvaluacionRead,
    EventoDelOrganizador,
    ExpedienteRead,
    MotivoObligatorio,
    ObservacionRead,
    VersionRead,
)
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.pagination import Page, pagination_params

router = APIRouter(prefix="/events", tags=["events"])


# --------------------------------------------------------------------------- #
# Presentación
# --------------------------------------------------------------------------- #


def _observacion(exp: service.Expediente) -> ObservacionRead | None:
    if exp.decision is None:
        return None
    return ObservacionRead(
        decision=exp.decision.decision,
        reason=exp.decision.reason,
        version=exp.decision.version,
        created_at=exp.decision.created_at,
    )


def _del_organizador(exp: service.Expediente) -> EventoDelOrganizador:
    op = exp.operacion
    editable = op.workflow_status in (states.BORRADOR, states.CONDICIONAL)
    return EventoDelOrganizador(
        id=exp.evento.id,
        title=exp.evento.title,
        description=exp.evento.description,
        promise=op.promise,
        category=op.category,
        timezone=op.timezone,
        starts_at=exp.evento.starts_at,
        ends_at=exp.evento.ends_at,
        location=exp.evento.location,
        cover_path=exp.evento.cover_path,
        whatsapp_url=exp.evento.whatsapp_url,
        event_type=exp.evento.event_type,
        capacity=exp.evento.capacity,
        approved_capacity=op.approved_capacity,
        workflow_status=service.estado_para_mostrar(exp),
        selection_status=op.selection_status,
        # LO CONFIRMA EL SERVIDOR. La app no deduce el sello de ninguna otra
        # cosa: si esto es falso, no se pinta.
        seleccionado_por_z=op.selection_status == "approved",
        current_version=op.current_version,
        registrations_count=exp.inscritos,
        motivo_para_no_enviar=(
            service.motivo_para_no_enviar(exp.evento, op) if editable else None
        ),
        editable=editable,
        ultima_observacion=_observacion(exp),
    )


def _evaluacion(exp: service.Expediente) -> EvaluacionRead | None:
    ev = exp.evaluacion
    if ev is None:
        return None
    resumen = admission.Evaluacion(
        puntajes={n: getattr(ev, n) for n in admission.CRITERIOS},
        falla_critica=ev.critical_failure,
    )
    return EvaluacionRead(
        **{n: getattr(ev, n) for n in admission.CRITERIOS},
        version=ev.version,
        total=ev.total,
        falla_critica=ev.critical_failure,
        motivo_de_la_falla=ev.critical_reason,
        evidencia=ev.evidence,
        decision_posible=admission.decision_posible(resumen),
        updated_at=ev.updated_at,
    )


def _expediente(exp: service.Expediente) -> ExpedienteRead:
    base = _del_organizador(exp)
    documentos = exp.documentos or []
    return ExpedienteRead(
        **base.model_dump(),
        organizer_id=exp.evento.organizer_id,
        origin=exp.operacion.origin,
        submitted_at=exp.operacion.submitted_at,
        evaluacion=_evaluacion(exp),
        documentos=[DocumentoRead.model_validate(d) for d in documentos],
        bloqueos_para_publicar=service.documentos_que_bloquean(
            documentos, service.ahora()
        ),
    )


async def _mio(db: AsyncSession, evento_id: str, usuario: AuthUser) -> service.Expediente:
    """El expediente de un evento PROPIO. Ajeno responde 404, no 403."""
    ensure_uuid(evento_id, "Evento no encontrado.")
    exp = await service.expediente(db, evento_id)
    permissions.exigir_organizador(exp.evento, usuario)
    return exp


# --------------------------------------------------------------------------- #
# Organizador
# --------------------------------------------------------------------------- #


@router.get("/mine", response_model=list[EventoDelOrganizador])
async def mis_eventos(
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[EventoDelOrganizador]:
    """Los eventos de quien pregunta, en cualquier estado."""
    await esquema.exigir_eventos_v2(db)
    expedientes = await service.mis_eventos(
        db, usuario=current_user, limite=page.limit, desplazamiento=page.offset
    )
    return [_del_organizador(exp) for exp in expedientes]


@router.post("", response_model=EventoDelOrganizador, status_code=status.HTTP_201_CREATED)
async def crear_borrador(
    payload: BorradorCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EventoDelOrganizador:
    """Crea un evento. NACE BORRADOR: no lo ve nadie hasta que se aprueba."""
    await esquema.exigir_eventos_v2(db)
    exp = await service.crear_borrador(
        db, datos=payload.model_dump(), usuario=current_user
    )
    return _del_organizador(exp)


@router.get("/{evento_id}", response_model=EventoDelOrganizador)
async def ver_mi_evento(
    evento_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EventoDelOrganizador:
    await esquema.exigir_eventos_v2(db)
    return _del_organizador(await _mio(db, evento_id, current_user))


@router.patch("/{evento_id}", response_model=EventoDelOrganizador)
async def actualizar_borrador(
    evento_id: str,
    payload: BorradorUpdate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EventoDelOrganizador:
    """Guarda el borrador, incluso a medias. `exclude_unset` distingue «no
    enviado» de «enviado vacío»: sin eso, cambiar el título borraría lo demás."""
    await esquema.exigir_eventos_v2(db)
    ensure_uuid(evento_id, "Evento no encontrado.")
    exp = await service.actualizar_borrador(
        db,
        evento_id=evento_id,
        datos=payload.model_dump(exclude_unset=True),
        usuario=current_user,
    )
    return _del_organizador(exp)


@router.post("/{evento_id}/submit", response_model=EventoDelOrganizador)
async def enviar_a_revision(
    evento_id: str,
    payload: EnvioARevision,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EventoDelOrganizador:
    """Congela una versión y la manda a revisión. NO publica nada."""
    await esquema.exigir_eventos_v2(db)
    ensure_uuid(evento_id, "Evento no encontrado.")
    exp = await service.enviar_a_revision(
        db, evento_id=evento_id, usuario=current_user, motivo=payload.motivo
    )
    return _del_organizador(exp)


@router.get("/{evento_id}/versions", response_model=list[VersionRead])
async def versiones(
    evento_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[VersionRead]:
    await esquema.exigir_eventos_v2(db)
    ensure_uuid(evento_id, "Evento no encontrado.")
    exp = await service.expediente(db, evento_id)
    if not await permissions.puede_ver_expediente(db, exp.evento, current_user):
        raise NotFoundError("Evento no encontrado.")
    return [
        VersionRead(
            version=v.version,
            status=v.status,
            reason=v.reason,
            changed_fields=list(v.changed_fields or []),
            created_at=v.created_at,
        )
        for v in await service.versiones_de(db, evento_id)
    ]


# --------------------------------------------------------------------------- #
# Curaduría y administración
# --------------------------------------------------------------------------- #

admin_router = APIRouter(prefix="/admin/events", tags=["events-admin"])


@admin_router.get("/pending", response_model=list[ExpedienteRead])
async def pendientes(
    estado: str | None = Query(default=None, pattern="^(SUBMITTED|CONDITIONAL)$"),
    page: Page = Depends(pagination_params),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ExpedienteRead]:
    """La cola de revisión: lo enviado y lo condicional."""
    await esquema.exigir_eventos_v2(db)
    await permissions.exigir_curaduria(db, current_user)
    expedientes = await service.pendientes(
        db, limite=page.limit, desplazamiento=page.offset, estado=estado
    )
    return [_expediente(exp) for exp in expedientes]


@admin_router.get("/{evento_id}", response_model=ExpedienteRead)
async def expediente(
    evento_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteRead:
    await esquema.exigir_eventos_v2(db)
    await permissions.exigir_curaduria(db, current_user)
    ensure_uuid(evento_id, "Evento no encontrado.")
    return _expediente(await service.expediente(db, evento_id))


@admin_router.post("/{evento_id}/review", response_model=ExpedienteRead)
async def evaluar(
    evento_id: str,
    payload: EvaluacionCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteRead:
    """Guarda los ocho puntajes con su evidencia. PUNTUAR NO ES DECIDIR."""
    await esquema.exigir_eventos_v2(db)
    await permissions.exigir_curaduria(db, current_user)
    ensure_uuid(evento_id, "Evento no encontrado.")
    await service.evaluar(
        db,
        evento_id=evento_id,
        puntajes={n: getattr(payload, n) for n in admission.CRITERIOS},
        evidencia=payload.evidencia,
        falla_critica=payload.falla_critica,
        motivo_de_la_falla=payload.motivo_de_la_falla,
        usuario=current_user,
    )
    return _expediente(await service.expediente(db, evento_id))


@admin_router.post("/{evento_id}/request-changes", response_model=ExpedienteRead)
async def pedir_correcciones(
    evento_id: str,
    payload: MotivoObligatorio,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteRead:
    """Devuelve el evento a borrador con una observación. Curaduría puede.

    Es la única decisión que no exige administración: pedir una corrección no
    autoriza nada, y esperar a quien pueda aprobar solo alarga la espera.
    """
    await esquema.exigir_eventos_v2(db)
    await permissions.exigir_curaduria(db, current_user)
    ensure_uuid(evento_id, "Evento no encontrado.")
    exp = await service.decidir(
        db,
        evento_id=evento_id,
        decision=admission.CAMBIOS,
        motivo=payload.motivo,
        usuario=current_user,
    )
    return _expediente(exp)


@admin_router.post("/{evento_id}/decision", response_model=ExpedienteRead)
async def decidir(
    evento_id: str,
    payload: DecisionCreate,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteRead:
    """Aprueba, condiciona o rechaza. Solo administración, y nunca lo propio."""
    await esquema.exigir_eventos_v2(db)
    ensure_uuid(evento_id, "Evento no encontrado.")
    exp = await service.expediente(db, evento_id)
    await permissions.exigir_admision(db, exp.evento, current_user)
    if payload.decision == admission.CAMBIOS:
        raise ConflictError(
            "Para pedir correcciones está /request-changes, que no exige "
            "administración."
        )
    return _expediente(
        await service.decidir(
            db,
            evento_id=evento_id,
            decision=payload.decision,
            motivo=payload.motivo,
            usuario=current_user,
        )
    )


@admin_router.post("/{evento_id}/publish", response_model=ExpedienteRead)
async def publicar(
    evento_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteRead:
    """Hace visible un evento APROBADO. Nada más se puede publicar."""
    await esquema.exigir_eventos_v2(db)
    ensure_uuid(evento_id, "Evento no encontrado.")
    exp = await service.expediente(db, evento_id)
    await permissions.exigir_admision(db, exp.evento, current_user)
    return _expediente(await service.publicar(db, evento_id=evento_id, usuario=current_user))


@admin_router.post("/{evento_id}/suspend", response_model=ExpedienteRead)
async def suspender(
    evento_id: str,
    payload: MotivoObligatorio,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteRead:
    """Detiene las reservas y lo saca del catálogo mientras se resuelve."""
    await esquema.exigir_eventos_v2(db)
    ensure_uuid(evento_id, "Evento no encontrado.")
    exp = await service.expediente(db, evento_id)
    await permissions.exigir_admision(db, exp.evento, current_user)
    return _expediente(
        await service.cambiar_visibilidad(
            db,
            evento_id=evento_id,
            accion="suspend",
            motivo=payload.motivo,
            usuario=current_user,
        )
    )


@admin_router.post("/{evento_id}/resume", response_model=ExpedienteRead)
async def reanudar(
    evento_id: str,
    payload: MotivoObligatorio,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteRead:
    await esquema.exigir_eventos_v2(db)
    ensure_uuid(evento_id, "Evento no encontrado.")
    exp = await service.expediente(db, evento_id)
    await permissions.exigir_admision(db, exp.evento, current_user)
    return _expediente(
        await service.cambiar_visibilidad(
            db,
            evento_id=evento_id,
            accion="resume",
            motivo=payload.motivo,
            usuario=current_user,
        )
    )


@admin_router.put("/{evento_id}/documents", response_model=ExpedienteRead)
async def registrar_documento(
    evento_id: str,
    payload: DocumentoUpsert,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteRead:
    """Anota un requisito y su estado. Uno por tipo; volver a enviarlo lo cambia."""
    await esquema.exigir_eventos_v2(db)
    await permissions.exigir_curaduria(db, current_user)
    ensure_uuid(evento_id, "Evento no encontrado.")
    await service.guardar_documento(
        db, evento_id=evento_id, datos=payload.model_dump(), usuario=current_user
    )
    return _expediente(await service.expediente(db, evento_id))
