"""Lo que Z le debe a quien vende, y cuándo se lo puede pagar.

EL SALDO SE FOTOGRAFÍA AL VENDER, NO SE CALCULA AL PAGAR. Si el neto se
resolviera en el momento de transferir —precio actual × comisión actual,
propietario actual—, cambiar cualquiera de las tres cosas reescribiría el
pasado: una venta de hace tres meses pasaría a deberle dinero a otra persona.

EL DINERO RETENIDO ES LA GARANTÍA. Mientras el comprador puede pedir
devolución, ese importe no es del propietario todavía. Pagarlo antes obligaría
a reclamárselo después, que es exactamente el problema que los marketplaces
resuelven reteniendo: se libera cuando el plazo vence sin reclamación.

    pending  →  la garantía del comprador sigue corriendo
    frozen   →  hay una solicitud de devolución en curso
    eligible →  venció sin reclamación: ya se puede pagar
    cancelled→  hubo reembolso: no hay nada que pagar

Todos los importes en la unidad MENOR y como ENTEROS. Ni un `float`: un céntimo
de redondeo por mil ventas es una tarde de conciliación.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.commerce.models import (
    CommerceProduct,
    Order,
    OwnerPayoutAccount,
    OwnerSaleBalance,
    OwnerTransfer,
)
from app.modules.commerce.service import _insert

logger = logging.getLogger("renaser.commerce")

#: Cuánto se queda la plataforma, en puntos básicos. 10 000 = 100 %.
BASE_DE_PUNTOS = 10_000


@dataclass(frozen=True)
class Reparto:
    """Cómo se parte una venta. Enteros, y el neto es lo que queda."""

    gross_minor: int
    platform_fee_minor: int
    provider_fee_minor: int
    net_minor: int
    fee_rules_version: str


def repartir(gross_minor: int, *, provider_fee_minor: int = 0) -> Reparto | None:
    """El reparto de una venta, o None si no hay comisión configurada.

    NONE Y NO CERO. Sin comisión configurada no se inventa un reparto: se
    devuelve nada y el saldo no se crea. Suponer 0 % transferiría el bruto —Z
    pagaría de su bolsillo la parte que le tocaba— y ninguna prueba lo
    delataría, porque el resultado cuadra.

    La comisión se redondea HACIA ABAJO, a favor de quien vende. El céntimo de
    la división entera se lo queda el propietario, no la plataforma.
    """
    ajustes = get_settings()
    if not ajustes.comision_configurada:
        return None
    comision = (gross_minor * ajustes.platform_fee_bps) // BASE_DE_PUNTOS
    neto = gross_minor - comision - provider_fee_minor
    if neto < 0:
        # Los costes se comen la venta entera. Puede pasar con un importe
        # minúsculo y una comisión fija del proveedor; no se deja negativo
        # porque un saldo negativo no significa nada: nadie le va a cobrar al
        # propietario por haber vendido.
        comision = max(0, gross_minor - provider_fee_minor)
        neto = gross_minor - comision - provider_fee_minor
    return Reparto(
        gross_minor=gross_minor,
        platform_fee_minor=comision,
        provider_fee_minor=provider_fee_minor,
        net_minor=neto,
        fee_rules_version=ajustes.fee_rules_version,
    )


async def registrar_saldo(
    db: AsyncSession, *, orden: Order, disponible_desde: datetime | None
) -> OwnerSaleBalance | None:
    """La fotografía de una venta. Se llama al confirmar el pago.

    UN SALDO POR ORDEN, y lo impide el índice `owner_sale_balances_orden_unica`,
    no un `if`: un webhook repetido no puede deberle el dinero dos veces al
    propietario.

    Devuelve None sin fallar si no hay comisión configurada o si el curso no
    tiene autor localizable. Que no se pueda liquidar NO puede impedir que la
    compra se complete: quien pagó tiene que recibir su acceso igual, y el
    saldo se puede reconstruir después.
    """
    curso_id, owner_id = await _curso_y_propietario(db, orden)
    if curso_id is None or owner_id is None:
        logger.warning(
            "[liquidacion] la orden %s no resuelve curso o propietario", orden.id
        )
        return None

    reparto = repartir(orden.amount_minor)
    if reparto is None:
        logger.warning(
            "[liquidacion] sin comision configurada: la orden %s no genera saldo. "
            "PLATFORM_FEE_BPS sigue sin decidirse.",
            orden.id,
        )
        return None

    cuenta = await cuenta_de_cobro(db, owner_id=owner_id, environment=orden.environment)
    await db.execute(
        _insert(db)(OwnerSaleBalance.__table__)
        .values(
            order_id=orden.id,
            course_id=curso_id,
            owner_id=owner_id,
            payout_account_id=cuenta.id if cuenta else None,
            gross_amount_minor=reparto.gross_minor,
            platform_fee_minor=reparto.platform_fee_minor,
            provider_fee_minor=reparto.provider_fee_minor,
            net_amount_minor=reparto.net_minor,
            currency=orden.currency,
            fee_rules_version=reparto.fee_rules_version,
            status="pending",
            available_at=disponible_desde,
        )
        .on_conflict_do_nothing(index_elements=["order_id"])
    )
    await db.flush()
    return await saldo_de_orden(db, orden.id)


async def _curso_y_propietario(
    db: AsyncSession, orden: Order
) -> tuple[str | None, str | None]:
    from app.modules.catalog.models import Course

    producto = await db.get(CommerceProduct, orden.commerce_product_id)
    if producto is None or producto.course_id is None:
        return None, None
    curso = await db.get(Course, producto.course_id)
    return producto.course_id, (curso.author_id if curso else None)


async def saldo_de_orden(db: AsyncSession, order_id: str) -> OwnerSaleBalance | None:
    return await db.scalar(
        select(OwnerSaleBalance).where(OwnerSaleBalance.order_id == order_id)
    )


async def cuenta_de_cobro(
    db: AsyncSession, *, owner_id: str, environment: str
) -> OwnerPayoutAccount | None:
    return await db.scalar(
        select(OwnerPayoutAccount).where(
            OwnerPayoutAccount.owner_id == owner_id,
            OwnerPayoutAccount.environment == environment,
        )
    )


# --------------------------------------------------------------------------- #
# El ciclo de vida del saldo
# --------------------------------------------------------------------------- #


async def congelar(
    db: AsyncSession, *, order_id: str, refund_request_id: str
) -> bool:
    """Retiene el saldo mientras se resuelve una solicitud.

    Solo desde `pending` o `eligible`: si ya se está transfiriendo o ya se
    transfirió, congelar no sirve de nada —el dinero salió— y hay que tratarlo
    como conciliación, no como un cambio de estado. Ver `docs/`.
    """
    resultado = await db.execute(
        update(OwnerSaleBalance)
        .where(
            OwnerSaleBalance.order_id == order_id,
            OwnerSaleBalance.status.in_(("pending", "eligible")),
        )
        .values(
            status="frozen",
            frozen_by_request_id=refund_request_id,
            updated_at=datetime.now(timezone.utc),
        )
    )
    await db.flush()
    return resultado.rowcount > 0


async def descongelar(db: AsyncSession, *, order_id: str) -> bool:
    """Devuelve el saldo a la cola cuando la solicitud se rechaza o se retira.

    Vuelve a `pending` y NO a `eligible`: si la garantía todavía no había
    vencido, sigue sin haber vencido. El trabajo que libera vencidos ya lo
    recogerá cuando toque.
    """
    resultado = await db.execute(
        update(OwnerSaleBalance)
        .where(
            OwnerSaleBalance.order_id == order_id,
            OwnerSaleBalance.status == "frozen",
        )
        .values(
            status="pending",
            frozen_by_request_id=None,
            updated_at=datetime.now(timezone.utc),
        )
    )
    await db.flush()
    return resultado.rowcount > 0


async def cancelar(db: AsyncSession, *, order_id: str) -> bool:
    """El reembolso se completó: no hay nada que pagarle al propietario.

    Si el saldo ya se había transferido NO se cancela aquí ni se inventa una
    devolución del propietario: se deja constancia y el caso pasa a
    conciliación manual. Recuperar dinero ya pagado a un tercero es una
    decisión de negocio, no algo que deba resolver un webhook a las tres de la
    mañana.
    """
    saldo = await saldo_de_orden(db, order_id)
    if saldo is None:
        return False
    if saldo.status in ("transferring", "transferred"):
        logger.error(
            "[liquidacion] la orden %s se reembolso con el saldo YA transferido "
            "(estado %s). Queda para conciliacion manual: no se genera ninguna "
            "devolucion automatica contra el propietario.",
            order_id,
            saldo.status,
        )
        return False
    saldo.status = "cancelled"
    saldo.updated_at = datetime.now(timezone.utc)
    await db.flush()
    return True


async def liberar_vencidos(db: AsyncSession, *, limite: int = 200) -> int:
    """Pasa a `eligible` los saldos cuya garantía ya venció sin reclamación.

    IDEMPOTENTE Y REINTENTABLE. Solo toca `pending` con fecha pasada, así que
    ejecutarlo dos veces seguidas no mueve nada la segunda. Es el mecanismo más
    simple que sirve: una consulta acotada que se puede llamar desde donde haga
    falta, sin cola de trabajos ni infraestructura nueva.
    """
    ahora = datetime.now(timezone.utc)
    ids = list(
        await db.scalars(
            select(OwnerSaleBalance.id)
            .where(
                OwnerSaleBalance.status == "pending",
                OwnerSaleBalance.available_at.is_not(None),
                OwnerSaleBalance.available_at <= ahora,
            )
            .limit(limite)
        )
    )
    if not ids:
        return 0
    await db.execute(
        update(OwnerSaleBalance)
        .where(OwnerSaleBalance.id.in_(ids))
        .values(status="eligible", updated_at=ahora)
    )
    await db.flush()
    return len(ids)


# --------------------------------------------------------------------------- #
# Transferencias
# --------------------------------------------------------------------------- #


def clave_de_idempotencia(balance_id: str) -> str:
    """Estable por saldo: un reintento reutiliza la misma y no paga dos veces."""
    return f"ztransfer_{balance_id}"


async def puede_transferirse(db: AsyncSession, saldo: OwnerSaleBalance) -> str | None:
    """None si se puede; si no, el código del motivo.

    Cinco puertas, y todas tienen que estar abiertas. El orden va de lo más
    barato de comprobar a lo más caro.
    """
    ajustes = get_settings()
    if not ajustes.creator_transfers_enabled:
        return "transfers_disabled"
    if not ajustes.stripe_connect_enabled:
        return "connect_disabled"
    if not ajustes.comision_configurada:
        # No debería llegar aquí —sin comisión no se crea el saldo— pero si la
        # configuración cambió después, no se transfiere a ciegas.
        return "fee_not_configured"
    if saldo.status != "eligible":
        return "not_eligible"
    if saldo.net_amount_minor <= 0:
        return "nothing_to_transfer"
    cuenta = (
        await db.get(OwnerPayoutAccount, saldo.payout_account_id)
        if saldo.payout_account_id
        else None
    )
    if cuenta is None or not cuenta.payouts_enabled:
        return "payout_account_not_ready"
    return None


async def abrir_transferencia(
    db: AsyncSession, saldo: OwnerSaleBalance
) -> OwnerTransfer | None:
    """Crea el intento de pago. No habla con nadie: eso lo hace el adaptador.

    UNA VIVA POR SALDO, y lo impide `owner_transfers_viva_por_saldo`. Si ya hay
    una en marcha se devuelve esa: reintentar no puede abrir una segunda.
    """
    clave = clave_de_idempotencia(saldo.id)
    ajustes = get_settings()
    await db.execute(
        _insert(db)(OwnerTransfer.__table__)
        .values(
            balance_id=saldo.id,
            owner_id=saldo.owner_id,
            payout_account_id=saldo.payout_account_id,
            amount_minor=saldo.net_amount_minor,
            currency=saldo.currency,
            provider="stripe",
            environment="production" if not ajustes.stripe_api_base.endswith("test") else "sandbox",
            idempotency_key=clave,
            status="processing",
            attempts=1,
        )
        .on_conflict_do_nothing(index_elements=["balance_id"])
    )
    await db.flush()
    saldo.status = "transferring"
    saldo.updated_at = datetime.now(timezone.utc)
    await db.flush()
    return await db.scalar(
        select(OwnerTransfer).where(OwnerTransfer.balance_id == saldo.id)
    )
