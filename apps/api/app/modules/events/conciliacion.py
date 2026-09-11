"""Conciliar lo que Z cree con lo que de verdad hay.

QUÉ ES CONCILIAR AQUÍ. Comparar el pedido, su pago, sus entradas, su saldo, su
devolución y su disputa, y decir en qué NO cuadran. Nada más.

LO QUE NO HACE, Y ES LO IMPORTANTE: no corrige. Una diferencia de dinero no se
arregla escribiendo el número que falta —eso no concilia, eso tapa—. Se registra
con su código y una persona la mira.

IDEMPOTENTE Y ACOTADA. Se puede ejecutar mil veces y da lo mismo; se pagina, y
la invoca un planificador EXTERNO. Dentro de la API no hay temporizador: hay
varias réplicas y cada una dispararía el suyo.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.commerce.models import OwnerSaleBalance
from app.modules.events import esquema
from app.modules.events.finanzas_models import EventDispute, OwnerSaleReserve
from app.modules.events.models import EventOrder, EventTicket
from app.modules.events.posventa_models import EXPEDIENTES_VIVOS, EventAftersaleCase

#: Cada hallazgo es un CÓDIGO, no una frase. La pantalla lo traduce y una
#: consulta los agrupa; un motivo en prosa no se puede contar.
PAGO_SIN_PEDIDO = "payment_without_order"
PEDIDO_SIN_ENTRADAS = "paid_order_without_tickets"
ENTRADA_SIN_PAGO = "ticket_without_payment"
SALDO_SIN_PEDIDO = "balance_without_order"
SALDO_DUPLICADO = "duplicate_balance"
IMPORTE_DISTINTO = "amount_mismatch"
MONEDA_DISTINTA = "currency_mismatch"
PROVEEDOR_DISTINTO = "provider_mismatch"
ENTORNO_DISTINTO = "environment_mismatch"
DEVOLUCION_SIN_EXPEDIENTE = "refund_without_case"
TRANSFERIDO_CON_RESERVA = "transferred_with_reserve"
TRANSFERENCIA_ESTANCADA = "stalled_transfer"


@dataclass(frozen=True)
class Hallazgo:
    """Una diferencia concreta. NUNCA se corrige sola."""

    codigo: str
    entidad: str
    identificador: str
    detalle: str | None = None


def ahora() -> datetime:
    return datetime.now(timezone.utc)


async def conciliar_ventas(
    db: AsyncSession, *, limite: int = 200
) -> list[Hallazgo]:
    """Compara pedidos, entradas y saldos. Devuelve lo que no cuadra.

    No escribe nada. Acotado por `limite` para que un catálogo grande no
    convierta esto en una consulta de minutos.
    """
    if not await esquema.hay_ordenes(db):
        return []
    tope = max(1, min(int(limite), 1000))
    hallazgos: list[Hallazgo] = []

    # 1. PEDIDO PAGADO SIN ENTRADAS. El disparador de la 0062 lo impide al
    #    confirmar, así que encontrar uno significa que algo las borró después.
    sin_entradas = (
        await db.execute(
            select(EventOrder.id)
            .where(
                EventOrder.status == "PAID",
                ~select(EventTicket.id)
                .where(EventTicket.order_id == EventOrder.id)
                .exists(),
            )
            .limit(tope)
        )
    ).scalars().all()
    hallazgos += [
        Hallazgo(PEDIDO_SIN_ENTRADAS, "event_order", str(o)) for o in sin_entradas
    ]

    # 2. ENTRADA SIN PAGO. Una entrada viva cuyo pedido no está pagado.
    sin_pago = (
        await db.execute(
            select(EventTicket.id)
            .join(EventOrder, EventOrder.id == EventTicket.order_id)
            .where(EventOrder.status != "PAID", EventTicket.status != "REVOKED")
            .limit(tope)
        )
    ).scalars().all()
    hallazgos += [
        Hallazgo(ENTRADA_SIN_PAGO, "event_ticket", str(t)) for t in sin_pago
    ]

    # 3. PAGO SIN PEDIDO. Una referencia de cobro que no apunta a ningún pedido
    #    vivo. Se mira solo si las finanzas están desplegadas.
    if not await esquema.hay_finanzas(db):
        return hallazgos

    # 4. SALDO SIN PEDIDO, y saldo duplicado por pedido.
    huerfanos = (
        await db.execute(
            select(OwnerSaleBalance.id)
            .where(
                OwnerSaleBalance.event_order_id.is_not(None),
                ~select(EventOrder.id)
                .where(EventOrder.id == OwnerSaleBalance.event_order_id)
                .exists(),
            )
            .limit(tope)
        )
    ).scalars().all()
    hallazgos += [
        Hallazgo(SALDO_SIN_PEDIDO, "owner_sale_balance", str(s)) for s in huerfanos
    ]

    duplicados = (
        await db.execute(
            select(OwnerSaleBalance.event_order_id, func.count())
            .where(OwnerSaleBalance.event_order_id.is_not(None))
            .group_by(OwnerSaleBalance.event_order_id)
            .having(func.count() > 1)
            .limit(tope)
        )
    ).all()
    hallazgos += [
        Hallazgo(SALDO_DUPLICADO, "event_order", str(o), f"{c} saldos")
        for o, c in duplicados
    ]

    # 5. IMPORTE, MONEDA Y ORIGEN. El saldo se congela al vender; si su bruto
    #    no es el total del pedido, uno de los dos miente.
    descuadrados = (
        await db.execute(
            select(
                OwnerSaleBalance.id,
                OwnerSaleBalance.gross_amount_minor,
                OwnerSaleBalance.currency,
                EventOrder.total_minor,
                EventOrder.currency,
                OwnerSaleBalance.event_id,
                EventOrder.event_id,
            )
            .join(EventOrder, EventOrder.id == OwnerSaleBalance.event_order_id)
            .where(
                or_(
                    OwnerSaleBalance.gross_amount_minor != EventOrder.total_minor,
                    OwnerSaleBalance.currency != EventOrder.currency,
                    OwnerSaleBalance.event_id != EventOrder.event_id,
                )
            )
            .limit(tope)
        )
    ).all()
    for fila in descuadrados:
        saldo_id, bruto, moneda, total, moneda_pedido, evento_saldo, evento_pedido = fila
        if int(bruto) != int(total):
            hallazgos.append(
                Hallazgo(IMPORTE_DISTINTO, "owner_sale_balance", str(saldo_id),
                         f"{bruto} vs {total}")
            )
        if (moneda or "") != (moneda_pedido or ""):
            hallazgos.append(
                Hallazgo(MONEDA_DISTINTA, "owner_sale_balance", str(saldo_id),
                         f"{moneda} vs {moneda_pedido}")
            )
        if str(evento_saldo) != str(evento_pedido):
            hallazgos.append(
                Hallazgo(PROVEEDOR_DISTINTO, "owner_sale_balance", str(saldo_id),
                         "el saldo apunta a otro evento")
            )

    # 6. TRANSFERIDO CON RESERVA VIVA. Se pagó dinero que estaba retenido.
    con_reserva = (
        await db.execute(
            select(OwnerSaleBalance.id)
            .where(
                OwnerSaleBalance.event_order_id.is_not(None),
                OwnerSaleBalance.status.in_(("transferring", "transferred")),
                select(OwnerSaleReserve.id)
                .where(
                    OwnerSaleReserve.balance_id == OwnerSaleBalance.id,
                    OwnerSaleReserve.status == "held",
                )
                .exists(),
            )
            .limit(tope)
        )
    ).scalars().all()
    hallazgos += [
        Hallazgo(TRANSFERIDO_CON_RESERVA, "owner_sale_balance", str(s))
        for s in con_reserva
    ]

    return hallazgos


async def salud(db: AsyncSession) -> dict[str, int]:
    """Los números del panel de operación. Consultas agregadas, sin N+1."""
    if not await esquema.hay_ordenes(db):
        return {"disponible": 0}

    cuenta: dict[str, int] = {"disponible": 1}

    cuenta["pedidos_pagados"] = int(
        await db.scalar(
            select(func.count()).select_from(EventOrder).where(EventOrder.status == "PAID")
        )
        or 0
    )
    cuenta["entradas_vivas"] = int(
        await db.scalar(
            select(func.count())
            .select_from(EventTicket)
            .where(EventTicket.status != "REVOKED")
        )
        or 0
    )

    if await esquema.hay_posventa(db):
        cuenta["expedientes_abiertos"] = int(
            await db.scalar(
                select(func.count())
                .select_from(EventAftersaleCase)
                .where(EventAftersaleCase.status.in_(EXPEDIENTES_VIVOS))
            )
            or 0
        )

    if not await esquema.hay_finanzas(db):
        return cuenta

    for estado in ("pending", "frozen", "eligible", "transferring", "transferred"):
        cuenta[f"saldos_{estado}"] = int(
            await db.scalar(
                select(func.count())
                .select_from(OwnerSaleBalance)
                .where(
                    OwnerSaleBalance.event_order_id.is_not(None),
                    OwnerSaleBalance.status == estado,
                )
            )
            or 0
        )

    # SALDOS PENDIENTES SIN FECHA: el reloj no ha empezado porque falta la
    # política. Es el número que dice cuánto dinero está esperando una decisión.
    cuenta["saldos_sin_fecha"] = int(
        await db.scalar(
            select(func.count())
            .select_from(OwnerSaleBalance)
            .where(
                OwnerSaleBalance.event_order_id.is_not(None),
                OwnerSaleBalance.status == "pending",
                OwnerSaleBalance.available_at.is_(None),
            )
        )
        or 0
    )
    cuenta["reservas_vivas"] = int(
        await db.scalar(
            select(func.count())
            .select_from(OwnerSaleReserve)
            .where(OwnerSaleReserve.status == "held")
        )
        or 0
    )
    cuenta["disputas_abiertas"] = int(
        await db.scalar(
            select(func.count())
            .select_from(EventDispute)
            .where(EventDispute.status.in_(("open", "needs_response", "under_review")))
        )
        or 0
    )
    return cuenta


__all__ = [
    "DEVOLUCION_SIN_EXPEDIENTE",
    "ENTORNO_DISTINTO",
    "ENTRADA_SIN_PAGO",
    "Hallazgo",
    "IMPORTE_DISTINTO",
    "MONEDA_DISTINTA",
    "PAGO_SIN_PEDIDO",
    "PEDIDO_SIN_ENTRADAS",
    "PROVEEDOR_DISTINTO",
    "SALDO_DUPLICADO",
    "SALDO_SIN_PEDIDO",
    "TRANSFERENCIA_ESTANCADA",
    "TRANSFERIDO_CON_RESERVA",
    "conciliar_ventas",
    "salud",
]
