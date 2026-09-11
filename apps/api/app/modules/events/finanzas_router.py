"""La API financiera de Eventos.

TODO APAGADO POR CONFIGURACIÓN. Las rutas existen; sin comisión decidida no hay
saldo que enseñar, sin política de retención nada se libera, y la transferencia
real exige banderas que están en `false`. Ninguna ruta llama a Stripe.

QUIÉN PUEDE QUÉ. El organizador ve lo suyo, sin comisión si no está configurada
y sin datos de otro. Administración financiera —`puede_mover_dinero`, no
`is_admin`— ve y acciona. Moderar contenido no mueve dinero.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.exceptions import ForbiddenError, NotFoundError
from app.core.security import AuthUser, get_current_user
from app.modules.catalog.models import Event
from app.modules.commerce.models import OwnerSaleBalance
from app.modules.events import conciliacion, esquema, finanzas
from app.modules.events.finanzas_models import EventDispute, OwnerSaleReserve
from app.shared.database import get_db
from app.shared.identifiers import ensure_uuid
from app.shared.permissions import puede_mover_dinero

router = APIRouter(prefix="/events", tags=["events-finance"])
admin_router = APIRouter(prefix="/admin/events/finance", tags=["events-finance-admin"])


class SaldoRead(BaseModel):
    """Un saldo de venta. Sin la cuenta de cobro ni nada del comprador.

    `platform_fee_minor` y `net_amount_minor` van a `null` cuando la comisión
    NO está configurada: enseñar cero sería decir que Z no cobra nada, que es
    una decisión que nadie ha tomado.
    """

    id: str
    event_id: str | None = None
    order_id: str | None = None
    gross_amount_minor: int
    platform_fee_minor: int | None = None
    net_amount_minor: int | None = None
    currency: str
    status: str
    #: Cuánto hay retenido por reservas vivas.
    reserved_minor: int = 0
    available_at: datetime | None = None
    #: Código de por qué no se libera. `null` si no hay nada que lo impida.
    bloqueo: str | None = None
    created_at: datetime


class ResumenFinancieroRead(BaseModel):
    """Lo que el organizador ve de un evento.

    `comision_configurada` es la que manda: cuando es `false`, la pantalla
    escribe «pendiente de configuración» y NO un número.
    """

    comision_configurada: bool
    ventas: int
    bruto_minor: int
    comision_minor: int | None = None
    neto_minor: int | None = None
    retenido_minor: int
    reservado_minor: int
    disponible_minor: int
    transferido_minor: int
    currency: str | None = None
    #: Por qué no hay nada disponible todavía, si es el caso.
    motivos: list[str] = Field(default_factory=list)


def _saldo_leido(
    saldo: OwnerSaleBalance, *, reservado: int, bloqueo: str | None
) -> SaldoRead:
    configurada = get_settings().comision_configurada
    return SaldoRead(
        id=saldo.id,
        event_id=saldo.event_id,
        order_id=saldo.event_order_id,
        gross_amount_minor=int(saldo.gross_amount_minor),
        platform_fee_minor=int(saldo.platform_fee_minor) if configurada else None,
        net_amount_minor=int(saldo.net_amount_minor) if configurada else None,
        currency=saldo.currency,
        status=saldo.status,
        reserved_minor=reservado,
        available_at=saldo.available_at,
        bloqueo=bloqueo,
        created_at=saldo.created_at,
    )


async def _evento_propio(db: AsyncSession, evento_id: str, usuario: AuthUser) -> Event:
    """El evento de quien pregunta. 404 para el ajeno, nunca 403.

    ABRE LA PUERTA, y no elige el dinero. Quién ve QUÉ saldos se decide con
    `OwnerSaleBalance.owner_id`, que se congela al vender: si algún día un
    evento cambia de organizador, el nuevo no puede ver —ni cobrar— las ventas
    que son dinero del anterior.
    """
    ensure_uuid(evento_id, "Evento no encontrado.")
    evento = await db.get(Event, evento_id)
    if evento is None or evento.organizer_id != usuario.id:
        raise NotFoundError("Evento no encontrado.")
    return evento


@router.get("/{event_id}/finance", response_model=ResumenFinancieroRead)
async def finanzas_del_evento(
    event_id: str,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ResumenFinancieroRead:
    """Ventas y saldo de un evento, para su organizador.

    SIN COMISIÓN CONFIGURADA NO SE ENSEÑA NINGÚN NETO. La pantalla recibe
    `comision_configurada: false` y escribe «pendiente de configuración»: nunca
    `-1`, ni cero, ni un porcentaje inventado.
    """
    await finanzas.exigir_disponible(db)
    await _evento_propio(db, event_id, current_user)
    ajustes = get_settings()

    filas = (
        await db.execute(
            select(
                OwnerSaleBalance.status,
                func.count(),
                func.coalesce(func.sum(OwnerSaleBalance.gross_amount_minor), 0),
                func.coalesce(func.sum(OwnerSaleBalance.platform_fee_minor), 0),
                func.coalesce(func.sum(OwnerSaleBalance.net_amount_minor), 0),
                func.min(OwnerSaleBalance.currency),
            )
            .where(
                OwnerSaleBalance.event_id == event_id,
                OwnerSaleBalance.owner_id == current_user.id,
            )
            .group_by(OwnerSaleBalance.status)
        )
    ).all()

    por_estado = {f[0]: f for f in filas}
    total = sum(int(f[1]) for f in filas)
    bruto = sum(int(f[2]) for f in filas)
    comision = sum(int(f[3]) for f in filas)
    neto = sum(int(f[4]) for f in filas)
    moneda = next((f[5] for f in filas if f[5]), None)

    reservado = int(
        await db.scalar(
            select(func.coalesce(func.sum(OwnerSaleReserve.amount_minor), 0))
            .select_from(OwnerSaleReserve)
            .join(
                OwnerSaleBalance, OwnerSaleBalance.id == OwnerSaleReserve.balance_id
            )
            .where(
                OwnerSaleBalance.event_id == event_id,
                OwnerSaleBalance.owner_id == current_user.id,
                OwnerSaleReserve.status == "held",
            )
        )
        or 0
    )

    def _neto_de(estado: str) -> int:
        fila = por_estado.get(estado)
        return int(fila[4]) if fila else 0

    motivos: list[str] = []
    if not ajustes.comision_configurada:
        motivos.append(finanzas.SIN_COMISION)
    sin_fecha = int(
        await db.scalar(
            select(func.count())
            .select_from(OwnerSaleBalance)
            .where(
                OwnerSaleBalance.event_id == event_id,
                OwnerSaleBalance.owner_id == current_user.id,
                OwnerSaleBalance.available_at.is_(None),
                OwnerSaleBalance.status == finanzas.PENDIENTE,
            )
        )
        or 0
    )
    if sin_fecha:
        motivos.append(finanzas.SIN_POLITICA_DE_RETENCION)
    if reservado:
        motivos.append(finanzas.RESERVA_VIVA)

    return ResumenFinancieroRead(
        comision_configurada=ajustes.comision_configurada,
        ventas=total,
        bruto_minor=bruto,
        comision_minor=comision if ajustes.comision_configurada else None,
        neto_minor=neto if ajustes.comision_configurada else None,
        retenido_minor=_neto_de(finanzas.PENDIENTE) + _neto_de(finanzas.RETENIDO),
        reservado_minor=reservado,
        disponible_minor=_neto_de(finanzas.ELEGIBLE),
        transferido_minor=_neto_de(finanzas.TRANSFERIDO),
        currency=moneda,
        motivos=motivos,
    )


@router.get("/{event_id}/finance/balances", response_model=list[SaldoRead])
async def saldos_del_evento(
    event_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[SaldoRead]:
    """El detalle por pedido, para su organizador."""
    await finanzas.exigir_disponible(db)
    await _evento_propio(db, event_id, current_user)
    filas = list(
        await db.scalars(
            select(OwnerSaleBalance)
            .where(
                OwnerSaleBalance.event_id == event_id,
                OwnerSaleBalance.owner_id == current_user.id,
            )
            .order_by(OwnerSaleBalance.created_at.desc(), OwnerSaleBalance.id.desc())
            .limit(limit)
        )
    )
    if not filas:
        # LISTA VACÍA = NO SE CONSULTA. El `in_(lista or [""])` que se suele
        # escribir aquí manda la cadena vacía contra una columna `uuid`: SQLite
        # la acepta y PostgreSQL la rechaza, así que el 500 solo aparece en
        # producción. Y sin comisión configurada no hay ningún saldo: hoy este
        # es el caso de TODOS los eventos.
        return []
    salida: list[SaldoRead] = []
    # Los reservados, EN UNA CONSULTA para todos: uno por saldo sería N+1.
    reservas = dict(
        (
            await db.execute(
                select(
                    OwnerSaleReserve.balance_id,
                    func.coalesce(func.sum(OwnerSaleReserve.amount_minor), 0),
                )
                .where(
                    OwnerSaleReserve.balance_id.in_([f.id for f in filas]),
                    OwnerSaleReserve.status == "held",
                )
                .group_by(OwnerSaleReserve.balance_id)
            )
        ).all()
    )
    for saldo in filas:
        # EL RESERVADO YA ESTÁ CALCULADO. Sin pasárselo, cada vuelta volvía a
        # sumarlo: con doscientos saldos eran doscientas sumas de más, debajo
        # del comentario que dice que el N+1 se había evitado.
        reservado = int(reservas.get(saldo.id, 0))
        bloqueo = await finanzas.por_que_no_se_libera(
            db, saldo=saldo, reservado=reservado
        )
        salida.append(
            _saldo_leido(
                saldo,
                reservado=reservado,
                bloqueo=bloqueo.motivo if bloqueo else None,
            )
        )
    return salida


# --------------------------------------------------------------------------- #
# Administración financiera
# --------------------------------------------------------------------------- #
async def _exigir_finanzas(db: AsyncSession, usuario: AuthUser) -> None:
    if not await puede_mover_dinero(db, usuario.id):
        raise ForbiddenError("Solo administración financiera.")


@admin_router.get("/health")
async def salud_financiera(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Los números de operación. Consultas agregadas, sin N+1."""
    await _exigir_finanzas(db, current_user)
    return await conciliacion.salud(db)


@admin_router.post("/reconcile")
async def conciliar(
    limit: int = Query(default=200, ge=1, le=1000),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Compara y REPORTA. No corrige nada.

    Una diferencia de dinero no se arregla escribiendo el número que falta: eso
    no concilia, tapa. Lo invoca un planificador externo.
    """
    await _exigir_finanzas(db, current_user)
    hallazgos = await conciliacion.conciliar_ventas(db, limite=limit)
    return {
        "total": len(hallazgos),
        "hallazgos": [
            {
                "codigo": h.codigo,
                "entidad": h.entidad,
                "id": h.identificador,
                "detalle": h.detalle,
            }
            for h in hallazgos
        ],
    }


@admin_router.get("/reserves")
async def retenciones(
    estado: str = Query(default="held"),
    event_id: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Las retenciones vivas sobre saldos de evento.

    SIN ESTO LA RUTA QUE SUELTA UNA ERA INALCANZABLE: el resumen del
    organizador solo manda cuánto hay retenido, y el panel no tenía de dónde
    sacar el identificador. Una puerta de salida que nadie puede encontrar es
    la misma retención eterna con otro nombre.
    """
    await _exigir_finanzas(db, current_user)
    if not await esquema.hay_finanzas(db):
        return []
    consulta = (
        select(OwnerSaleReserve, OwnerSaleBalance.event_id)
        .join(OwnerSaleBalance, OwnerSaleBalance.id == OwnerSaleReserve.balance_id)
        .where(OwnerSaleBalance.event_order_id.is_not(None))
    )
    if estado:
        consulta = consulta.where(OwnerSaleReserve.status == estado)
    if event_id:
        ensure_uuid(event_id, "Evento no encontrado.")
        consulta = consulta.where(OwnerSaleBalance.event_id == event_id)
    consulta = consulta.order_by(
        OwnerSaleReserve.created_at.desc(), OwnerSaleReserve.id.desc()
    ).limit(limit)
    return [
        {
            "id": reserva.id,
            "balance_id": reserva.balance_id,
            "event_id": evento_id,
            "amount_minor": reserva.amount_minor,
            "currency": reserva.currency,
            "reason": reserva.reason,
            "status": reserva.status,
            "case_id": reserva.case_id,
            # NULA MIENTRAS NO HAYA POLÍTICA: una retención que nadie decidió.
            "policy_id": reserva.policy_id,
            "created_at": reserva.created_at,
            "released_at": reserva.released_at,
            "released_by": reserva.released_by,
            "release_reason": reserva.release_reason,
        }
        for reserva, evento_id in (await db.execute(consulta)).all()
    ]


class SoltarReservaRequest(BaseModel):
    """Por qué se suelta. Obligatorio: una retención que se levanta sin motivo
    escrito no se puede auditar después."""

    motivo: str = Field(min_length=3, max_length=500)
    #: `true` cuando el dinero se fue de verdad —una disputa perdida—. No mueve
    #: nada: solo deja de retener y anota que ya no vuelve.
    consumida: bool = False


@admin_router.post("/reserves/{reserve_id}/release")
async def soltar_reserva(
    reserve_id: str,
    cuerpo: SoltarReservaRequest,
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Levanta una retención sobre un saldo. NO MUEVE DINERO.

    LA PUERTA DE SALIDA QUE FALTABA. Una reserva se abría desde el webhook de
    disputa y desde una devolución parcial, y no había ninguna forma de
    soltarla: el saldo se quedaba con `reserve_held` para siempre y solo salía
    de ahí con SQL a mano. Las de disputa se sueltan solas cuando la pasarela
    dice cómo acabó; las demás las suelta una persona, aquí.
    """
    await _exigir_finanzas(db, current_user)
    await finanzas.exigir_disponible(db)
    ensure_uuid(reserve_id, "Retención no encontrada.")
    reserva = await db.get(OwnerSaleReserve, reserve_id)
    if reserva is None:
        raise NotFoundError("Retención no encontrada.")
    soltada = await finanzas.liberar_reserva(
        db,
        reserva_id=reserve_id,
        motivo=cuerpo.motivo,
        consumida=cuerpo.consumida,
        actor_id=current_user.id,
    )
    await db.commit()
    return {"soltada": soltada, "id": reserve_id}


@admin_router.get("/disputes")
async def disputas(
    estado: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Las disputas abiertas. Sin `liability` cuando no hay política."""
    await _exigir_finanzas(db, current_user)
    if not await esquema.hay_finanzas(db):
        return []
    consulta = select(EventDispute)
    if estado:
        consulta = consulta.where(EventDispute.status == estado)
    consulta = consulta.order_by(
        EventDispute.created_at.desc(), EventDispute.id.desc()
    ).limit(limit)
    return [
        {
            "id": d.id,
            "event_id": d.event_id,
            "order_id": d.order_id,
            "amount_minor": d.amount_minor,
            "currency": d.currency,
            "status": d.status,
            "evidence_due_at": d.evidence_due_at,
            # NULO MIENTRAS NO HAYA POLÍTICA: quién asume la pérdida no está
            # decidido, y un valor aquí sería inventárselo.
            "liability": d.liability,
            "created_at": d.created_at,
        }
        for d in await db.scalars(consulta)
    ]


@admin_router.post("/transfers/run")
async def ejecutar_transferencias(
    current_user: AuthUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Pagaría a los organizadores. HOY NO HACE NADA, y lo dice.

    Las banderas están apagadas y `platform_fee_bps` vale -1: el adaptador
    responde «no configurado» y NUNCA simula un éxito. Existe para que el día
    que la empresa decida no haya que escribir el circuito con prisa.
    """
    await _exigir_finanzas(db, current_user)
    # EL ESQUEMA, TAMBIÉN AQUÍ. Contestaba 200 con su lista de bloqueos aunque
    # las finanzas no estuvieran desplegadas, que es decir «solo faltan estas
    # tres cosas» cuando falta la tabla entera.
    await finanzas.exigir_disponible(db)
    ajustes = get_settings()
    bloqueos: list[str] = []
    if not ajustes.creator_transfers_enabled:
        bloqueos.append("transfers_disabled")
    if not ajustes.stripe_connect_enabled:
        bloqueos.append("connect_disabled")
    if not ajustes.comision_configurada:
        bloqueos.append(finanzas.SIN_COMISION)
    return {"ejecutadas": 0, "bloqueos": bloqueos}
