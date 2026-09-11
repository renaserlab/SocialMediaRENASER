"""La API de posventa de eventos.

APAGADA POR CONFIGURACIÓN, NO POR AUSENCIA. Las rutas existen y responden; lo
que no existe es una política publicada, y sin ella nada decide solo: la
elegibilidad contesta `policy_not_configured` y cerrar un expediente con
resultado se rechaza con un código estable.

QUIÉN PUEDE QUÉ. El comprador abre y retira lo suyo. Soporte tría. **Solo quien
administra el dinero aprueba, rechaza o publica una política**, y se comprueba
con `puede_mover_dinero`, no con `is_admin`: moderar contenido no es administrar
dinero, y ese conjunto está separado en el proyecto precisamente para esto.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    AppError,
    ForbiddenError,
    NotFoundError,
    ValidationAppError,
)
from app.core.security import AuthUser, get_current_user
from app.modules.catalog.models import Event
from app.modules.events import elegibilidad, esquema, politicas, posventa
from app.modules.events import posventa_estados as maquina
from app.modules.events.models import EventOrder, EventTicket
from app.modules.events.posventa_models import (
    CANCELADO,
    EN_REVISION,
    ESPERANDO,
    APROBADO,
    RECHAZADO,
    EventAftersaleCase,
    EventAftersaleCaseTicket,
    EventChange,
    EventPolicy,
    SIN_CLASIFICAR,
    CLASIFICACIONES,
)
from app.modules.events.posventa_schemas import (
    AbrirExpedienteRequest,
    CambioRead,
    ClasificarCambioRequest,
    DecisionRequest,
    ExpedienteDeAdministracion,
    ExpedienteDelOrganizador,
    ExpedienteRead,
    LineaDeHistorial,
    PaginaDeExpedientes,
    PoliticaRead,
    EntradaAfectadaRead,
    PoliticaAplicadaRead,
    PublicarPoliticaRequest,
    ResponderRequest,
    RetiroRequest,
    VeredictoDePosventa,
)
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.permissions import puede_mover_dinero

router = APIRouter(prefix="/events", tags=["events-aftersale"])
admin_router = APIRouter(prefix="/admin/events", tags=["events-aftersale-admin"])


# --------------------------------------------------------------------------- #
# Ayudantes
# --------------------------------------------------------------------------- #
async def _exigir_gestor(db: AsyncSession, usuario: AuthUser) -> None:
    """Quien administra el DINERO. No `is_admin`, que incluye moderación."""
    if not await puede_mover_dinero(db, usuario.id):
        raise ForbiddenError("Solo administración puede resolver expedientes.")


async def _mi_pedido(db: AsyncSession, orden_id: str, usuario: AuthUser) -> EventOrder:
    """El pedido de quien pregunta. 404 para el ajeno, nunca 403."""
    ensure_uuid(orden_id, "Pedido no encontrado.")
    orden = await db.get(EventOrder, orden_id)
    if orden is None or orden.buyer_id != usuario.id:
        raise NotFoundError("Pedido no encontrado.")
    return orden


def _leido(caso: EventAftersaleCase, *, actor: str) -> ExpedienteRead:
    return ExpedienteRead(
        id=caso.id,
        event_id=caso.event_id,
        order_id=caso.order_id,
        kind=caso.kind,
        status=caso.status,
        reason=caso.buyer_reason,
        outcome=caso.outcome,
        refund_amount_minor=caso.refund_amount_minor,
        currency=caso.currency,
        created_at=caso.created_at,
        updated_at=caso.updated_at,
        resolved_at=caso.resolved_at,
        acciones=list(maquina.siguientes(caso.status, actor)),
    )


def _para_administracion(caso: EventAftersaleCase) -> ExpedienteDeAdministracion:
    base = _leido(caso, actor=maquina.ADMINISTRACION)
    return ExpedienteDeAdministracion(
        **base.model_dump(),
        buyer_id=caso.buyer_id,
        organizer_id=caso.organizer_id,
        internal_notes=caso.internal_notes,
        assignee_id=caso.assignee_id,
        policy_id=caso.policy_id,
        provider=caso.provider,
        environment=caso.environment,
    )


# --------------------------------------------------------------------------- #
# Comprador
# --------------------------------------------------------------------------- #
@router.get(
    "/orders/{order_id}/aftersale-eligibility", response_model=VeredictoDePosventa
)
async def elegibilidad_del_pedido(
    order_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> VeredictoDePosventa:
    """Qué se puede pedir con esta compra. NO PROMETE NADA.

    Con la política sin publicar contesta `policy_not_configured`, que es
    distinto de «no»: la pantalla puede explicar que todavía no está definido
    en vez de dar una negativa que nadie ha decidido.
    """
    await esquema.exigir_posventa(db)
    orden = await _mi_pedido(db, order_id, current_user)
    v = await elegibilidad.evaluar(db, orden=orden)
    return VeredictoDePosventa(
        resultado=v.resultado,
        motivos=list(v.motivos),
        puede_pedir=v.puede_pedir,
        politica_version=v.politica_version,
        porcentaje_bps=v.porcentaje_bps,
    )


@router.post("/aftersale-cases", response_model=ExpedienteRead, status_code=201)
async def abrir_expediente(
    payload: AbrirExpedienteRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteRead:
    """Abre una solicitud. NO RETIRA LA ENTRADA.

    Pedir no es haber obtenido: la entrada se revoca en el punto que diga la
    política, y normalmente cuando el dinero ya volvió.
    """
    await esquema.exigir_posventa(db)
    orden = await _mi_pedido(db, payload.order_id, current_user)

    veredicto = await elegibilidad.evaluar(db, orden=orden)
    if not veredicto.puede_pedir:
        # Un hecho duro —no pagado, ya devuelto, expediente abierto— o una
        # negativa de la política. Se dice con su código y con los motivos, no
        # con una frase: la aplicación los traduce y una consulta los agrupa.
        raise AppError(
            "No se puede abrir una solicitud sobre esta compra.",
            code=f"event_case_{veredicto.resultado}",
            status_code=409,
            details={"motivos": list(veredicto.motivos)},
        )

    evento = await db.get(Event, orden.event_id)
    if evento is None:
        # `event_orders.event_id` no tiene clave ajena a `events`, así que un
        # pedido huérfano es posible. Sin esto salía como 500.
        raise NotFoundError("Evento no encontrado.")
    caso = await posventa.abrir(
        db,
        orden=orden,
        organizador_id=evento.organizer_id,
        tipo=payload.kind,
        actor_id=current_user.id,
        actor_rol=maquina.COMPRADOR,
        motivo=payload.reason,
    )
    await db.commit()
    return _leido(caso, actor=maquina.COMPRADOR)


@router.get(
    "/{event_id}/aftersale-cases", response_model=list[ExpedienteDelOrganizador]
)
async def casos_de_mi_evento(
    event_id: str,
    estado: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ExpedienteDelOrganizador]:
    """Los casos de UN evento propio, para quien lo organiza.

    UN SUBCONJUNTO: sin comprador, sin su motivo, sin notas internas, sin
    política y sin proveedor. El organizador necesita saber que hay un caso
    abierto y cuántas entradas toca para poder atender a alguien; no necesita
    saber quién lo abrió ni qué escribió.

    404 para un evento ajeno, nunca 403.
    """
    await esquema.exigir_posventa(db)
    ensure_uuid(event_id, "Evento no encontrado.")
    evento = await db.get(Event, event_id)
    if evento is None or evento.organizer_id != current_user.id:
        raise NotFoundError("Evento no encontrado.")

    consulta = select(EventAftersaleCase).where(
        EventAftersaleCase.event_id == event_id
    )
    if estado:
        consulta = consulta.where(EventAftersaleCase.status == estado)
    consulta = consulta.order_by(
        EventAftersaleCase.created_at.desc(), EventAftersaleCase.id.desc()
    ).limit(limit)
    casos = list(await db.scalars(consulta))

    # EL RECUENTO DE ENTRADAS, EN UNA CONSULTA para todos: una por caso sería
    # N+1, y una bandeja de cincuenta haría cincuenta viajes.
    # SIN CASOS NO SE CONSULTA: `in_(lista or [""])` manda la cadena vacía
    # contra una columna `uuid` y PostgreSQL la rechaza.
    cuantas = (
        dict(
            (
                await db.execute(
                    select(
                        EventAftersaleCaseTicket.case_id,
                        func.count(),
                    )
                    .where(
                        EventAftersaleCaseTicket.case_id.in_([c.id for c in casos])
                    )
                    .group_by(EventAftersaleCaseTicket.case_id)
                )
            ).all()
        )
        if casos
        else {}
    )
    return [
        ExpedienteDelOrganizador(
            id=c.id,
            event_id=c.event_id,
            kind=c.kind,
            status=c.status,
            entradas=int(cuantas.get(c.id, 0)),
            created_at=c.created_at,
            updated_at=c.updated_at,
        )
        for c in casos
    ]


@router.get("/me/aftersale-cases", response_model=PaginaDeExpedientes)
async def mis_expedientes(
    limit: int = Query(default=20, ge=1, le=100),
    cursor: str | None = Query(default=None),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PaginaDeExpedientes:
    await esquema.exigir_posventa(db)
    filas = await posventa.mios(db, usuario_id=current_user.id, limite=limit, cursor=cursor)
    siguiente = (
        f"{filas[-1].created_at.isoformat()}|{filas[-1].id}"
        if len(filas) == limit
        else None
    )
    return PaginaDeExpedientes(
        items=[_leido(c, actor=maquina.COMPRADOR) for c in filas],
        next_cursor=siguiente,
    )


@router.get("/aftersale-cases/{case_id}", response_model=ExpedienteRead)
async def leer_expediente(
    case_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteRead:
    await esquema.exigir_posventa(db)
    ensure_uuid(case_id, "Expediente no encontrado.")
    caso = await posventa.leer(db, expediente_id=case_id, usuario_id=current_user.id)
    return _leido(caso, actor=maquina.COMPRADOR)


@router.get(
    "/aftersale-cases/{case_id}/history", response_model=list[LineaDeHistorial]
)
async def historial_del_expediente(
    case_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[LineaDeHistorial]:
    """La línea de tiempo. SIN las notas internas."""
    await esquema.exigir_posventa(db)
    ensure_uuid(case_id, "Expediente no encontrado.")
    await posventa.leer(db, expediente_id=case_id, usuario_id=current_user.id)
    return [
        LineaDeHistorial(
            from_status=linea.from_status,
            to_status=linea.to_status,
            actor_role=linea.actor_role,
            reason=linea.reason,
            created_at=linea.created_at,
        )
        for linea in await posventa.historial(db, expediente_id=case_id)
    ]


@router.post("/aftersale-cases/{case_id}/respond", response_model=ExpedienteRead)
async def responder_informacion(
    case_id: str,
    payload: ResponderRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteRead:
    """El comprador contesta a una petición de información.

    Devuelve el expediente a revisión. Su texto se guarda como MOTIVO de ese
    paso, no como nota interna: es suyo y lo puede volver a leer.
    """
    await esquema.exigir_posventa(db)
    ensure_uuid(case_id, "Expediente no encontrado.")
    await posventa.leer(db, expediente_id=case_id, usuario_id=current_user.id)
    movimiento = await posventa.transicionar(
        db,
        expediente_id=case_id,
        hasta=EN_REVISION,
        actor_id=current_user.id,
        actor_rol=maquina.COMPRADOR,
        motivo=payload.reason,
    )
    await db.commit()
    return _leido(movimiento.expediente, actor=maquina.COMPRADOR)


@router.get(
    "/aftersale-cases/{case_id}/tickets", response_model=list[EntradaAfectadaRead]
)
async def entradas_afectadas(
    case_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[EntradaAfectadaRead]:
    """Qué entradas toca el expediente y cómo quedó cada una.

    SIN CREDENCIAL Y SIN CÓDIGO: los dos admiten por sí solos, y para saber en
    qué estado quedó una entrada no hace falta ninguno.
    """
    await esquema.exigir_posventa(db)
    ensure_uuid(case_id, "Expediente no encontrado.")
    await posventa.leer(db, expediente_id=case_id, usuario_id=current_user.id)
    return await _entradas_del_caso(db, case_id)


async def _entradas_del_caso(
    db: AsyncSession, case_id: str
) -> list[EntradaAfectadaRead]:
    """Las entradas de un expediente. Una consulta, con su unión."""
    filas = (
        await db.execute(
            select(
                EventAftersaleCaseTicket.ticket_id,
                EventAftersaleCaseTicket.status_at_open,
                EventAftersaleCaseTicket.effect,
                EventTicket.status,
                EventTicket.ticket_type_name_snapshot,
            )
            .join(EventTicket, EventTicket.id == EventAftersaleCaseTicket.ticket_id)
            .where(EventAftersaleCaseTicket.case_id == case_id)
            .order_by(EventTicket.issued_at, EventTicket.id)
        )
    ).all()
    return [
        EntradaAfectadaRead(
            ticket_id=f[0],
            status_at_open=f[1],
            effect=f[2],
            status=f[3],
            name=f[4],
        )
        for f in filas
    ]


@router.get(
    "/aftersale-cases/{case_id}/policy", response_model=PoliticaAplicadaRead
)
async def politica_aplicada(
    case_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PoliticaAplicadaRead:
    """Con qué reglas se resolvió. 404 mientras no haya decisión.

    Que no haya política aplicada no es un error: es que nadie ha decidido
    todavía, y decirlo con un 404 lo distingue de un expediente inexistente
    tanto como hace falta aquí, porque el expediente ya se comprobó como suyo.
    """
    await esquema.exigir_posventa(db)
    ensure_uuid(case_id, "Expediente no encontrado.")
    caso = await posventa.leer(db, expediente_id=case_id, usuario_id=current_user.id)
    if caso.policy_id is None:
        raise NotFoundError(
            "Todavía no hay una política aplicada a este expediente.",
            code="event_case_policy_not_applied",
        )
    politica = await db.get(EventPolicy, caso.policy_id)
    if politica is None:
        raise NotFoundError("Política no encontrada.")
    return PoliticaAplicadaRead(
        policy_type=politica.policy_type,
        version=politica.version,
        published_at=politica.published_at,
        body=politica.body,
    )


@router.post("/aftersale-cases/{case_id}/withdraw", response_model=ExpedienteRead)
async def retirar_expediente(
    case_id: str,
    payload: RetiroRequest | None = None,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteRead:
    """El comprador retira su solicitud mientras nadie ha decidido."""
    await esquema.exigir_posventa(db)
    ensure_uuid(case_id, "Expediente no encontrado.")
    await posventa.leer(db, expediente_id=case_id, usuario_id=current_user.id)
    movimiento = await posventa.transicionar(
        db,
        expediente_id=case_id,
        hasta=CANCELADO,
        actor_id=current_user.id,
        actor_rol=maquina.COMPRADOR,
        motivo=(payload.reason if payload else None),
    )
    await db.commit()
    return _leido(movimiento.expediente, actor=maquina.COMPRADOR)


# --------------------------------------------------------------------------- #
# Administración
# --------------------------------------------------------------------------- #
@admin_router.get("/aftersale-cases", response_model=list[ExpedienteDeAdministracion])
async def bandeja(
    estado: str | None = Query(default=None),
    event_id: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ExpedienteDeAdministracion]:
    """La bandeja. SE FILTRA EN LA BASE, antes del límite."""
    await esquema.exigir_posventa(db)
    await _exigir_gestor(db, current_user)
    consulta = select(EventAftersaleCase)
    if estado:
        consulta = consulta.where(EventAftersaleCase.status == estado)
    if event_id:
        ensure_uuid(event_id, "Evento no encontrado.")
        consulta = consulta.where(EventAftersaleCase.event_id == event_id)
    consulta = consulta.order_by(
        EventAftersaleCase.created_at.desc(), EventAftersaleCase.id.desc()
    ).limit(limit)
    return [_para_administracion(c) for c in await db.scalars(consulta)]


@admin_router.get(
    "/aftersale-cases/{case_id}", response_model=ExpedienteDeAdministracion
)
async def detalle_de_administracion(
    case_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteDeAdministracion:
    """El expediente entero, con sus notas internas."""
    await esquema.exigir_posventa(db)
    await _exigir_gestor(db, current_user)
    ensure_uuid(case_id, "Expediente no encontrado.")
    return _para_administracion(await posventa.leer(db, expediente_id=case_id))


@admin_router.get(
    "/aftersale-cases/{case_id}/history", response_model=list[LineaDeHistorial]
)
async def historial_de_administracion(
    case_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[LineaDeHistorial]:
    """La línea de tiempo. Aquí SÍ con las notas internas de cada paso."""
    await esquema.exigir_posventa(db)
    await _exigir_gestor(db, current_user)
    ensure_uuid(case_id, "Expediente no encontrado.")
    await posventa.leer(db, expediente_id=case_id)
    return [
        LineaDeHistorial(
            from_status=linea.from_status,
            to_status=linea.to_status,
            actor_role=linea.actor_role,
            reason=linea.reason,
            notes=linea.notes,
            created_at=linea.created_at,
        )
        for linea in await posventa.historial(db, expediente_id=case_id)
    ]


@admin_router.get(
    "/aftersale-cases/{case_id}/tickets", response_model=list[EntradaAfectadaRead]
)
async def entradas_de_administracion(
    case_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[EntradaAfectadaRead]:
    """Las entradas del expediente. SIN credencial y SIN código, igual que al
    comprador: administrar un caso no exige poder abrir una puerta."""
    await esquema.exigir_posventa(db)
    await _exigir_gestor(db, current_user)
    ensure_uuid(case_id, "Expediente no encontrado.")
    await posventa.leer(db, expediente_id=case_id)
    return await _entradas_del_caso(db, case_id)


@admin_router.post(
    "/aftersale-cases/{case_id}/review", response_model=ExpedienteDeAdministracion
)
async def tomar_el_caso(
    case_id: str,
    payload: DecisionRequest | None = None,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteDeAdministracion:
    """Lo toma para revisarlo. El UPDATE condicional impide que dos lo tomen."""
    await esquema.exigir_posventa(db)
    await _exigir_gestor(db, current_user)
    ensure_uuid(case_id, "Expediente no encontrado.")
    movimiento = await posventa.transicionar(
        db,
        expediente_id=case_id,
        hasta=EN_REVISION,
        actor_id=current_user.id,
        actor_rol=maquina.ADMINISTRACION,
        notas=(payload.notes if payload else None),
    )
    movimiento.expediente.assignee_id = current_user.id
    await db.commit()
    return _para_administracion(movimiento.expediente)


@admin_router.post(
    "/aftersale-cases/{case_id}/request-info",
    response_model=ExpedienteDeAdministracion,
)
async def pedir_informacion(
    case_id: str,
    payload: DecisionRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteDeAdministracion:
    await esquema.exigir_posventa(db)
    await _exigir_gestor(db, current_user)
    ensure_uuid(case_id, "Expediente no encontrado.")
    movimiento = await posventa.transicionar(
        db,
        expediente_id=case_id,
        hasta=ESPERANDO,
        actor_id=current_user.id,
        actor_rol=maquina.ADMINISTRACION,
        motivo=payload.reason,
        notas=payload.notes,
    )
    await db.commit()
    return _para_administracion(movimiento.expediente)


@admin_router.post(
    "/aftersale-cases/{case_id}/approve", response_model=ExpedienteDeAdministracion
)
async def aprobar(
    case_id: str,
    payload: DecisionRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteDeAdministracion:
    """Aprueba, y APRUEBA NO ES DEVOLVER.

    El expediente pasa a `approved` y ahí se queda hasta que alguien decida
    ejecutar. Y ejecutar contra la pasarela está apagado: `resolved` desde
    `refund_processing` solo lo alcanza un aviso verificado del proveedor.

    SIN POLÍTICA NO SE APRUEBA. Aprobar es aplicar unas reglas, y decir cuáles
    es lo que permite explicar el caso dentro de un año.
    """
    await esquema.exigir_posventa(db)
    await _exigir_gestor(db, current_user)
    ensure_uuid(case_id, "Expediente no encontrado.")
    caso = await posventa.leer(db, expediente_id=case_id)
    politica = await politicas.exigir_vigente(
        db, tipo="aftersale_eligibility", evento_id=caso.event_id
    )
    movimiento = await posventa.transicionar(
        db,
        expediente_id=case_id,
        hasta=APROBADO,
        actor_id=current_user.id,
        actor_rol=maquina.ADMINISTRACION,
        motivo=payload.reason,
        notas=payload.notes,
        politica_id=politica.id,
        resultado=payload.outcome,
        importe_minor=payload.refund_amount_minor,
        moneda=payload.currency,
    )
    await db.commit()
    return _para_administracion(movimiento.expediente)


@admin_router.post(
    "/aftersale-cases/{case_id}/reject", response_model=ExpedienteDeAdministracion
)
async def rechazar(
    case_id: str,
    payload: DecisionRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpedienteDeAdministracion:
    """Rechaza, con motivo. El motivo lo ve la persona; las notas no."""
    await esquema.exigir_posventa(db)
    await _exigir_gestor(db, current_user)
    ensure_uuid(case_id, "Expediente no encontrado.")
    if not (payload.reason or "").strip():
        raise ValidationAppError(
            "Un rechazo necesita un motivo que se le pueda enseñar a la persona.",
            code="event_case_reject_needs_reason",
        )
    movimiento = await posventa.transicionar(
        db,
        expediente_id=case_id,
        hasta=RECHAZADO,
        actor_id=current_user.id,
        actor_rol=maquina.ADMINISTRACION,
        motivo=payload.reason,
        notas=payload.notes,
    )
    await db.commit()
    return _para_administracion(movimiento.expediente)


# --------------------------------------------------------------------------- #
# Administración: políticas y cambios
# --------------------------------------------------------------------------- #
@admin_router.post("/policies", response_model=PoliticaRead, status_code=201)
async def publicar_politica(
    payload: PublicarPoliticaRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PoliticaRead:
    """Publica una decisión de la empresa. Cierra la anterior en la misma
    transacción, y republicar la misma versión no duplica."""
    await esquema.exigir_posventa(db)
    await _exigir_gestor(db, current_user)
    if payload.event_id:
        ensure_uuid(payload.event_id, "Evento no encontrado.")
    politica = await politicas.publicar(
        db,
        tipo=payload.policy_type,
        version=payload.version,
        params=payload.params,
        actor_id=current_user.id,
        evento_id=payload.event_id,
        locale=payload.locale,
        body=payload.body,
    )
    await db.commit()
    return PoliticaRead.model_validate(politica, from_attributes=True)


@admin_router.get("/policies", response_model=list[PoliticaRead])
async def listar_politicas(
    policy_type: str | None = Query(default=None),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[PoliticaRead]:
    await esquema.exigir_posventa(db)
    await _exigir_gestor(db, current_user)
    consulta = select(EventPolicy)
    if policy_type:
        consulta = consulta.where(EventPolicy.policy_type == policy_type)
    consulta = consulta.order_by(
        EventPolicy.created_at.desc(), EventPolicy.id.desc()
    ).limit(200)
    return [
        PoliticaRead.model_validate(p, from_attributes=True)
        for p in await db.scalars(consulta)
    ]


@admin_router.get("/changes", response_model=list[CambioRead])
async def cambios_registrados(
    event_id: str | None = Query(default=None),
    solo_sin_clasificar: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[CambioRead]:
    """Los cambios del evento. Sin clasificar es SIN CLASIFICAR, no «no
    esencial»."""
    await esquema.exigir_posventa(db)
    await _exigir_gestor(db, current_user)
    consulta = select(EventChange)
    if event_id:
        ensure_uuid(event_id, "Evento no encontrado.")
        consulta = consulta.where(EventChange.event_id == event_id)
    if solo_sin_clasificar:
        consulta = consulta.where(EventChange.classification == SIN_CLASIFICAR)
    consulta = consulta.order_by(
        EventChange.created_at.desc(), EventChange.id.desc()
    ).limit(limit)
    return [
        CambioRead.model_validate(c, from_attributes=True)
        for c in await db.scalars(consulta)
    ]


@admin_router.post("/changes/{change_id}/classify", response_model=CambioRead)
async def clasificar_cambio(
    change_id: str,
    payload: ClasificarCambioRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CambioRead:
    """Clasifica un cambio. LO HACE UNA PERSONA, no una regla automática.

    Qué es «esencial» es una decisión de la empresa; el sistema registra el
    cambio y espera.
    """
    await esquema.exigir_posventa(db)
    await _exigir_gestor(db, current_user)
    ensure_uuid(change_id, "Cambio no encontrado.")
    if payload.classification not in CLASIFICACIONES or (
        payload.classification == SIN_CLASIFICAR
    ):
        raise ValidationAppError(
            "Clasificación no reconocida.", code="event_change_classification_invalid"
        )
    cambio = await db.get(EventChange, change_id)
    if cambio is None:
        raise NotFoundError("Cambio no encontrado.")
    cambio.classification = payload.classification
    cambio.classification_reason = (payload.reason or "").strip()[:500] or None
    cambio.classified_by = current_user.id
    cambio.classified_at = posventa.ahora()

    from app.modules.gobernanza import auditoria

    await auditoria.anotar(
        db,
        actor_id=current_user.id,
        actor_role="user",
        action="event.change_classified",
        entity_type="event_change",
        entity_id=cambio.id,
        new_state=payload.classification,
        payload={"evento": cambio.event_id, "campo": cambio.field},
    )
    await db.commit()
    return CambioRead.model_validate(cambio, from_attributes=True)
