"""Las finanzas de una venta de entradas.

NO ES OTRO MÓDULO FINANCIERO. Reutiliza `owner_sale_balances`, su máquina de
estados, `owner_payout_accounts`, `owner_transfers` y el adaptador de
transferencias, que ya no mencionan cursos por ninguna parte. Lo único que
había que generalizar eran dos columnas, y lo hace la 0068.

QUÉ SE CONGELA AL VENDER. El evento, el ORGANIZADOR BENEFICIARIO, el pedido, el
bruto, la moneda, la comisión, el neto, la versión de reglas, el proveedor y el
entorno. Cambiar después el organizador del evento no redirige dinero ya
vendido: el saldo apunta a quien lo era cuando se cobró.

SIN COMISIÓN CONFIGURADA NO HAY SALDO. `platform_fee_bps = -1` significa que
nadie ha decidido el número; suponer 0 % transferiría el bruto y ninguna prueba
lo delataría, porque el resultado cuadra. `repartir()` devuelve `None` y aquí no
se escribe nada.

Y NADA SE LIBERA SOLO. La fecha de disponibilidad sale de una política de
retención publicada; sin ella el saldo se queda `pending` sin fecha, y el panel
dice por qué.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError
from app.modules.catalog.models import Event
from app.modules.commerce.liquidacion import repartir
from app.modules.commerce.models import OwnerSaleBalance
from app.modules.events import esquema, politicas
from app.modules.events.models import EventOrder
from app.modules.events.posventa_models import POLITICA_RESERVA, POLITICA_RETENCION
from app.modules.events.finanzas_models import EventDispute, EventDisputeEvent, OwnerSaleReserve

PENDIENTE = "pending"
RETENIDO = "frozen"
ELEGIBLE = "eligible"
EN_TRANSFERENCIA = "transferring"
TRANSFERIDO = "transferred"
CANCELADO = "cancelled"
FALLIDO = "failed"

#: Por qué un saldo todavía no está disponible. Códigos, no frases: la pantalla
#: los traduce y una consulta los agrupa.
SIN_COMISION = "fee_not_configured"
SIN_POLITICA_DE_RETENCION = "hold_policy_not_configured"
SIN_CUENTA = "payout_account_missing"
SIN_ORGANIZADOR = "organizer_missing"
RESERVA_VIVA = "reserve_held"
EXPEDIENTE_ABIERTO = "aftersale_case_open"
DISPUTA_ABIERTA = "dispute_open"
RETENCION_EN_CURSO = "hold_open"


class FinanzasNoDisponibles(AppError):
    status_code = 503
    code = "event_finance_not_available"


def ahora() -> datetime:
    return datetime.now(timezone.utc)


async def exigir_disponible(db: AsyncSession) -> None:
    if not await esquema.hay_finanzas(db):
        raise FinanzasNoDisponibles(
            "Las finanzas de eventos todavía no están disponibles."
        )


async def registrar_venta(
    db: AsyncSession, *, orden: EventOrder, momento: datetime | None = None
) -> OwnerSaleBalance | None:
    """Crea el saldo de una venta pagada. Idempotente por pedido.

    Devuelve `None` cuando no se puede crear —sin esquema, sin comisión, sin
    organizador— y eso NO es un fallo: es que falta una decisión. El pedido
    sigue pagado y las entradas emitidas.

    NO HACE `commit`: lo llama el webhook, dentro de su savepoint.
    """
    momento = momento or ahora()
    if not await esquema.hay_finanzas(db):
        return None
    if orden.status != "PAID":
        return None

    ya = await db.scalar(
        select(OwnerSaleBalance).where(OwnerSaleBalance.event_order_id == orden.id)
    )
    if ya is not None:
        # El webhook se reintenta. Un saldo por pedido, y ya está.
        return ya

    evento = await db.get(Event, orden.event_id)
    if evento is None or not evento.organizer_id:
        return None

    reparto = repartir(int(orden.total_minor))
    if reparto is None:
        # SIN COMISIÓN CONFIGURADA NO SE INVENTA UN REPARTO.
        return None

    cuenta = await _cuenta_de(db, evento.organizer_id)
    saldo = OwnerSaleBalance(
        event_id=orden.event_id,
        event_order_id=orden.id,
        # CONGELADO: quien organizaba cuando se cobró. Cambiar el organizador
        # después no redirige dinero ya vendido.
        owner_id=evento.organizer_id,
        payout_account_id=cuenta.id if cuenta is not None else None,
        gross_amount_minor=reparto.gross_minor,
        platform_fee_minor=reparto.platform_fee_minor,
        provider_fee_minor=reparto.provider_fee_minor,
        net_amount_minor=reparto.net_minor,
        currency=orden.currency,
        fee_rules_version=reparto.fee_rules_version,
        status=PENDIENTE,
        # SIN FECHA. La política de retención no está publicada, así que no se
        # supone ninguna: `available_at` nulo significa «el reloj no ha
        # empezado», y `puede_transferirse` ya lo trata como bloqueo.
        available_at=await _disponible_desde(db, orden=orden, momento=momento),
        created_at=momento,
        updated_at=momento,
    )
    try:
        async with db.begin_nested():
            db.add(saldo)
            await db.flush()
    except IntegrityError:
        if saldo in db:
            db.expunge(saldo)
        return await db.scalar(
            select(OwnerSaleBalance).where(OwnerSaleBalance.event_order_id == orden.id)
        )
    return saldo


async def _cuenta_de(db: AsyncSession, owner_id: str):
    """La cuenta de cobro del organizador, si la tiene. Nunca se inventa."""
    from app.core.config import get_settings
    from app.modules.commerce.models import OwnerPayoutAccount

    ajustes = get_settings()
    return await db.scalar(
        select(OwnerPayoutAccount).where(
            OwnerPayoutAccount.owner_id == owner_id,
            OwnerPayoutAccount.environment == ajustes.payments_environment,
        )
    )


async def _disponible_desde(
    db: AsyncSession, *, orden: EventOrder, momento: datetime
) -> datetime | None:
    """Cuándo podría estar disponible, según la política de retención.

    `None` cuando no hay política: el reloj no empieza y el saldo se queda
    retenido. No se aproxima con la fecha del evento ni con ningún plazo.
    """
    politica = await politicas.vigente(
        db, tipo=POLITICA_RETENCION, evento_id=orden.event_id
    )
    if politica is None:
        return None
    dias = politicas.numero(politica, "hold_days")
    if dias is None:
        return None

    desde_el_evento = politicas.bandera(politica, "hold_from_event")
    base = momento
    if desde_el_evento:
        evento = await db.get(Event, orden.event_id)
        empieza = getattr(evento, "starts_at", None)
        if empieza is None:
            return None
        base = empieza if empieza.tzinfo else empieza.replace(tzinfo=timezone.utc)
    return base + timedelta(days=int(dias))


@dataclass(frozen=True)
class Bloqueo:
    """Por qué un saldo no se puede liberar todavía. Código, no frase."""

    motivo: str
    detalle: str | None = None


async def por_que_no_se_libera(
    db: AsyncSession, *, saldo: OwnerSaleBalance, momento: datetime | None = None
) -> Bloqueo | None:
    """La primera razón por la que este saldo sigue bloqueado, o `None`.

    SE COMPRUEBAN TODAS Y SE DEVUELVE LA PRIMERA, en orden de «lo que más
    claramente falta»: al organizador hay que decirle una cosa concreta, no
    siete a la vez.
    """
    momento = momento or ahora()
    from app.core.config import get_settings

    if not get_settings().comision_configurada:
        return Bloqueo(SIN_COMISION)
    if not saldo.owner_id:
        return Bloqueo(SIN_ORGANIZADOR)
    if saldo.payout_account_id is None:
        return Bloqueo(SIN_CUENTA)
    if saldo.available_at is None:
        return Bloqueo(SIN_POLITICA_DE_RETENCION)

    disponible = saldo.available_at
    if disponible.tzinfo is None:
        disponible = disponible.replace(tzinfo=timezone.utc)
    if disponible > momento:
        return Bloqueo(RETENCION_EN_CURSO, disponible.isoformat())

    reservado = await reservado_de(db, saldo_id=saldo.id)
    if reservado > 0:
        return Bloqueo(RESERVA_VIVA, str(reservado))

    abierta = await db.scalar(
        select(func.count())
        .select_from(EventDispute)
        .where(
            EventDispute.balance_id == saldo.id,
            EventDispute.status.in_(("open", "needs_response", "under_review")),
        )
    )
    if abierta:
        return Bloqueo(DISPUTA_ABIERTA)

    if saldo.event_order_id is not None:
        from app.modules.events.posventa_models import (
            EXPEDIENTES_VIVOS,
            EventAftersaleCase,
        )

        vivo = await db.scalar(
            select(func.count())
            .select_from(EventAftersaleCase)
            .where(
                EventAftersaleCase.order_id == saldo.event_order_id,
                EventAftersaleCase.status.in_(EXPEDIENTES_VIVOS),
            )
        )
        if vivo:
            return Bloqueo(EXPEDIENTE_ABIERTO)

    return None


# --------------------------------------------------------------------------- #
# Reservas
# --------------------------------------------------------------------------- #
async def reservar(
    db: AsyncSession,
    *,
    saldo: OwnerSaleBalance,
    importe_minor: int,
    motivo: str,
    caso_id: str | None = None,
    politica_id: str | None = None,
    actor_id: str | None = None,
    momento: datetime | None = None,
) -> OwnerSaleReserve | None:
    """Retiene parte del saldo. Idempotente por saldo y motivo.

    NO CALCULA EL IMPORTE: se lo dan. Cuánto reservar es una política que nadie
    ha publicado, y este módulo no inventa porcentajes.
    """
    momento = momento or ahora()
    if importe_minor <= 0:
        return None

    reserva = OwnerSaleReserve(
        balance_id=saldo.id,
        amount_minor=int(importe_minor),
        currency=saldo.currency,
        reason=motivo,
        case_id=caso_id,
        policy_id=politica_id,
        status="held",
        created_by=actor_id,
        created_at=momento,
    )
    try:
        async with db.begin_nested():
            db.add(reserva)
            await db.flush()
    except IntegrityError:
        if reserva in db:
            db.expunge(reserva)
        return None
    return reserva


async def liberar_reserva(
    db: AsyncSession,
    *,
    reserva_id: str,
    motivo: str,
    consumida: bool = False,
    momento: datetime | None = None,
) -> bool:
    """Suelta o consume una reserva. UPDATE condicional."""
    momento = momento or ahora()
    hechas = await db.execute(
        update(OwnerSaleReserve)
        .where(OwnerSaleReserve.id == reserva_id, OwnerSaleReserve.status == "held")
        .values(
            status="consumed" if consumida else "released",
            released_at=momento,
            release_reason=(motivo or "").strip()[:500] or None,
        )
    )
    return (hechas.rowcount or 0) == 1


async def reservado_de(db: AsyncSession, *, saldo_id: str) -> int:
    """Cuánto hay retenido ahora mismo sobre ese saldo."""
    valor = await db.scalar(
        select(func.coalesce(func.sum(OwnerSaleReserve.amount_minor), 0)).where(
            OwnerSaleReserve.balance_id == saldo_id,
            OwnerSaleReserve.status == "held",
        )
    )
    return int(valor or 0)


async def politica_de_reserva(db: AsyncSession, *, evento_id: str):
    """La política de reserva, o `None`. Sin ella no se calcula ninguna."""
    return await politicas.vigente(db, tipo=POLITICA_RESERVA, evento_id=evento_id)


# --------------------------------------------------------------------------- #
# Disputas
# --------------------------------------------------------------------------- #
async def abrir_o_actualizar_disputa(
    db: AsyncSession,
    *,
    externa: str,
    entorno: str,
    estado: str,
    orden: EventOrder | None = None,
    importe_minor: int | None = None,
    moneda: str | None = None,
    motivo: str | None = None,
    momento: datetime | None = None,
) -> EventDispute | None:
    """Abre la disputa o mueve su estado. Idempotente por referencia.

    ADMINISTRACIÓN NO DECIDE AQUÍ. Quién asume la pérdida se queda nulo hasta
    que haya política; esta función solo refleja lo que dice la pasarela.
    """
    momento = momento or ahora()
    if not await esquema.hay_finanzas(db):
        return None

    existente = await db.scalar(
        select(EventDispute).where(
            EventDispute.provider == "stripe",
            EventDispute.environment == entorno,
            EventDispute.external_id == externa,
        )
    )
    if existente is not None:
        desde = existente.status
        if desde != estado:
            existente.status = estado
            existente.updated_at = momento
            if estado in ("won", "lost", "closed"):
                existente.resolved_at = momento
            db.add(
                EventDisputeEvent(
                    dispute_id=existente.id,
                    from_status=desde,
                    to_status=estado,
                    actor_role="system",
                    created_at=momento,
                )
            )
            await db.flush()
        return existente

    saldo = None
    organizador = None
    if orden is not None:
        saldo = await db.scalar(
            select(OwnerSaleBalance).where(
                OwnerSaleBalance.event_order_id == orden.id
            )
        )
        evento = await db.get(Event, orden.event_id)
        organizador = evento.organizer_id if evento is not None else None

    disputa = EventDispute(
        provider="stripe",
        environment=entorno,
        external_id=externa,
        event_id=orden.event_id if orden is not None else None,
        order_id=orden.id if orden is not None else None,
        organizer_id=organizador,
        balance_id=saldo.id if saldo is not None else None,
        amount_minor=importe_minor,
        currency=(moneda or None),
        reason=(motivo or None),
        status=estado,
        created_at=momento,
        updated_at=momento,
        resolved_at=momento if estado in ("won", "lost", "closed") else None,
    )
    try:
        async with db.begin_nested():
            db.add(disputa)
            await db.flush()
    except IntegrityError:
        if disputa in db:
            db.expunge(disputa)
        return await db.scalar(
            select(EventDispute).where(
                EventDispute.provider == "stripe",
                EventDispute.environment == entorno,
                EventDispute.external_id == externa,
            )
        )

    db.add(
        EventDisputeEvent(
            dispute_id=disputa.id,
            from_status=None,
            to_status=estado,
            actor_role="system",
            created_at=momento,
        )
    )
    # BLOQUEA EL IMPORTE. No descuenta nada de ningún otro saldo: quién asume
    # la pérdida no está decidido.
    if saldo is not None:
        await reservar(
            db,
            saldo=saldo,
            importe_minor=int(importe_minor or saldo.net_amount_minor),
            motivo="dispute",
            momento=momento,
        )
    await db.flush()
    return disputa


__all__ = [
    "Bloqueo",
    "DISPUTA_ABIERTA",
    "EXPEDIENTE_ABIERTO",
    "FinanzasNoDisponibles",
    "RESERVA_VIVA",
    "RETENCION_EN_CURSO",
    "SIN_COMISION",
    "SIN_CUENTA",
    "SIN_ORGANIZADOR",
    "SIN_POLITICA_DE_RETENCION",
    "abrir_o_actualizar_disputa",
    "exigir_disponible",
    "liberar_reserva",
    "politica_de_reserva",
    "por_que_no_se_libera",
    "registrar_venta",
    "reservado_de",
    "reservar",
]
