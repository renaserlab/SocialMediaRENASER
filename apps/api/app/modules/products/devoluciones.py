"""El dinero que vuelve de un pedido de producto (Incremento 9, 0082).

APROBAR NO ES PAGAR, y este fichero existe para que eso no se pueda confundir.
Una devolución nace `approved` —alguien con permiso financiero decidió devolver
un importe—, pasa a `requested` cuando se le pide a la pasarela, y solo el aviso
de la pasarela la deja en `confirmed`. Entre medias puede quedarse en
`processing` o caer en `failed`, que son cosas distintas y se leen distinto.

EL ADAPTADOR ESTÁ APAGADO Y FALLA EN CERRADO. `NoConfigurado` contesta
`failed / provider_not_configured` y **no simula ningún éxito**: eso dejaría una
devolución marcada como pagada sin que el dinero se hubiera movido, que es el
peor error posible de esta funcionalidad. Se reutiliza tal cual el adaptador de
Cursos, que ya lo hace bien.

EL IMPORTE LO TECLEA UNA PERSONA. Cuánto se devuelve en cada una de las cinco
salidas del blueprint es una decisión que la empresa no ha tomado, así que aquí
no hay ninguna fórmula: hay un tope —el bruto de la venta— y un rastro de quién
lo decidió y por qué.

Y NO SE DEVUELVE DOS VECES. Dos cosas lo impiden y las dos están en la base: la
clave de idempotencia es única, y hay un índice único parcial de una devolución
viva por expediente.

LO QUE ESTE MÓDULO NO HACE: no toca el inventario. Dónde está una unidad
devuelta lo decide una persona; reponerla al confirmar el dinero la pondría a la
venta estando en casa de alguien. Una prueba recorre el árbol de sintaxis y
falla si aparece el import.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError, ConflictError, NotFoundError
from app.modules.payments.reembolsos import RefundRequestToProvider
from app.modules.products import esquema
from app.modules.products import estados_de_incidencia as maquina
from app.modules.products import finanzas
from app.modules.products.finanzas_models import (
    DEVOLUCION_ANULADA,
    DEVOLUCION_APROBADA,
    DEVOLUCION_CONFIRMADA,
    DEVOLUCION_EN_CURSO,
    DEVOLUCION_EN_MARCHA,
    DEVOLUCION_FALLIDA,
    DEVOLUCION_PARCIAL,
    DEVOLUCION_PEDIDA,
    DEVOLUCION_RETIENE,
    DEVOLUCION_TOTAL,
    ProductRefund,
    ProductRefundEvent,
)
from app.modules.products.models import (
    ACTOR_ADMINISTRACION,
    PEDIDO_PAGADO,
    ProductIncident,
    ProductOrder,
)

logger = logging.getLogger("renaser.products")

#: El prefijo de la clave de idempotencia. Estable por devolución: un reintento
#: reutiliza la misma y la pasarela no devuelve dos veces.
CLAVE_DE_DEVOLUCION = "pr-ref-"


class DevolucionNoPermitida(AppError):
    status_code = 409
    code = "product_refund_not_allowed"


class DevolucionNoEncontrada(NotFoundError):
    code = "product_refund_not_found"


class DevolucionDuplicada(ConflictError):
    code = "product_refund_already_exists"


def ahora() -> datetime:
    return datetime.now(timezone.utc)


async def exigir_disponible(db: AsyncSession) -> None:
    await esquema.exigir_finanzas(db)


def por_que_no_se_puede_devolver() -> list[str]:
    """Qué falta para que una devolución pueda SALIR de verdad.

    NO IMPIDE REGISTRARLA. Decidir que se devuelve un importe es una decisión
    que se puede tomar hoy y queda escrita; lo que no se puede es pedírselo a
    una pasarela que no existe. Separar las dos cosas es lo que permite que el
    expediente cuente la verdad: «se aprobó el día 3, se pudo pagar el día 20».
    """
    from app.core.config import get_settings

    ajustes = get_settings()
    faltan: list[str] = []
    if not ajustes.payments_enabled:
        faltan.append("payments_enabled")
    if not ajustes.stripe_refunds_enabled:
        faltan.append("stripe_refunds_enabled")
    if not (ajustes.stripe_secret_key or "").strip():
        faltan.append("stripe_secret_key")
    return faltan


def _proveedor():  # noqa: ANN202
    """El adaptador que toca, y si no hay ninguno el que falla en cerrado."""
    from app.modules.payments.reembolsos import NoConfigurado

    if por_que_no_se_puede_devolver():
        return NoConfigurado()
    from app.modules.payments.stripe_refunds import StripeRefundProvider

    return StripeRefundProvider()


async def _anotar(
    db: AsyncSession,
    devolucion: ProductRefund,
    *,
    desde: str | None,
    hasta: str,
    actor_id: str | None,
    actor_rol: str,
    motivo: str | None = None,
    referencia: str | None = None,
    momento: datetime | None = None,
) -> None:
    """Una fila en el historial. SOLO SE AÑADE: lo impone un disparador."""
    db.add(
        ProductRefundEvent(
            refund_id=devolucion.id,
            from_status=desde,
            to_status=hasta,
            actor_id=actor_id,
            actor_role=actor_rol,
            reason=(motivo or "").strip()[:500] or None,
            provider_reference=referencia,
            created_at=momento or ahora(),
        )
    )


# --------------------------------------------------------------------------- #
# 1. Aprobar. No mueve un céntimo.
# --------------------------------------------------------------------------- #
async def aprobar(
    db: AsyncSession,
    *,
    orden_id: str,
    importe_minor: int,
    motivo: str,
    actor_id: str,
    incidencia_id: str | None = None,
    momento: datetime | None = None,
) -> ProductRefund:
    """Registra que se decidió devolver un importe. NO LLAMA A LA PASARELA.

    LAS CINCO PUERTAS, en orden de lo más barato a lo más caro de comprobar:

      1. la 0082 tiene que estar aplicada;
      2. el pedido tiene que existir y estar pagado —no se devuelve lo que no se
         cobró—;
      3. si viene de una reclamación, esa reclamación tiene que estar RESUELTA y
         su resolución tiene que deber dinero: `REJECT_CLAIM` no devuelve nada, y
         `REPLACEMENT` devuelve mercancía y no dinero;
      4. el importe tiene que ser positivo y no pasar del bruto de la venta,
         menos lo que ya se haya devuelto;
      5. y no puede haber otra devolución viva del mismo expediente, que lo
         decide un índice único parcial y no un `select` de antes.
    """
    await exigir_disponible(db)
    momento = momento or ahora()

    orden = await db.get(ProductOrder, orden_id)
    if orden is None:
        raise DevolucionNoEncontrada("Pedido no encontrado.")
    if orden.status != PEDIDO_PAGADO or orden.paid_at is None:
        raise DevolucionNoPermitida(
            "No se devuelve lo que no se ha cobrado.",
            details={"reason": "order_not_paid", "status": orden.status},
        )

    caso: ProductIncident | None = None
    if incidencia_id is not None:
        caso = await db.get(ProductIncident, incidencia_id)
        if caso is None or caso.order_id != orden_id:
            raise DevolucionNoEncontrada("Reclamación no encontrada.")
        if caso.status != maquina.RESUELTA:
            raise DevolucionNoPermitida(
                "Esa reclamación todavía no está resuelta.",
                details={"reason": "incident_not_resolved", "status": caso.status},
            )
        if not maquina.deja_deuda(caso.resolution):
            raise DevolucionNoPermitida(
                "Esa decisión no devuelve dinero.",
                details={
                    "reason": "resolution_without_money",
                    "resolution": caso.resolution,
                },
            )

    tope = int(orden.total_minor) - await devuelto_de(db, orden_id=orden_id)
    if int(importe_minor) <= 0:
        raise DevolucionNoPermitida(
            "Una devolución de cero no devuelve nada.",
            details={"reason": "amount_invalid"},
        )
    if int(importe_minor) > tope:
        # EL TOPE ES EL BRUTO MENOS LO YA DEVUELTO. Sin restar lo anterior, dos
        # parciales del total podían devolver el doble de lo cobrado.
        raise DevolucionNoPermitida(
            "Ese importe pasa de lo que queda por devolver.",
            details={"reason": "amount_above_charge", "max_minor": max(0, tope)},
        )

    saldo = await finanzas.saldo_del_pedido(db, orden_id=orden_id)
    devolucion = ProductRefund(
        order_id=orden_id,
        incident_id=incidencia_id,
        balance_id=saldo.id if saldo is not None else None,
        amount_minor=int(importe_minor),
        currency=orden.currency,
        kind=(
            DEVOLUCION_TOTAL
            if int(importe_minor) == int(orden.total_minor)
            else DEVOLUCION_PARCIAL
        ),
        status=DEVOLUCION_APROBADA,
        provider="none",
        environment=orden.environment,
        idempotency_key=CLAVE_DE_DEVOLUCION + orden_id + "-" + str(momento.timestamp()),
        decided_by=actor_id,
        decision_reason=(motivo or "").strip(),
        created_at=momento,
        updated_at=momento,
    )
    db.add(devolucion)
    try:
        await db.flush()
    except IntegrityError as fallo:
        await db.rollback()
        if "product_refunds_viva_por_expediente" in str(getattr(fallo, "orig", fallo)):
            raise DevolucionDuplicada(
                "Ya hay una devolución en marcha de esa reclamación."
            ) from None
        raise

    await _anotar(
        db,
        devolucion,
        desde=None,
        hasta=DEVOLUCION_APROBADA,
        actor_id=actor_id,
        actor_rol=ACTOR_ADMINISTRACION,
        motivo=motivo,
        momento=momento,
    )

    # Y EL SALDO SE RETIENE, si existe. Aprobar una devolución y dejar el dinero
    # camino del proveedor es pagarle dos veces.
    if saldo is not None and saldo.status in finanzas.SALDO_ABIERTO:
        try:
            await finanzas.reservar(
                db,
                saldo=saldo,
                importe_minor=int(importe_minor),
                motivo=finanzas.RESERVA_POR_DEVOLUCION,
                incidencia_id=incidencia_id,
                creado_por=actor_id,
                momento=momento,
            )
        except AppError:
            # YA HABÍA UNA RESERVA POR DEVOLUCIÓN. No es un fallo: el dinero ya
            # estaba apartado, que es lo que se quería.
            logger.info("Productos: ya había reserva de devolución en %s", saldo.id)
    await db.flush()
    return devolucion


async def devuelto_de(db: AsyncSession, *, orden_id: str) -> int:
    """Cuánto se ha devuelto ya de este pedido, contando lo que está en marcha.

    CUENTA LO QUE TODAVÍA NO SE HA PAGADO. Si solo se contaran las confirmadas,
    dos aprobaciones seguidas del total podrían devolver el doble.
    """
    total = await db.scalar(
        select(func.coalesce(func.sum(ProductRefund.amount_minor), 0)).where(
            ProductRefund.order_id == orden_id,
            ProductRefund.status.in_(DEVOLUCION_RETIENE),
        )
    )
    return int(total or 0)


# --------------------------------------------------------------------------- #
# 2. Pedírsela a la pasarela. Aquí SÍ sale del proceso.
# --------------------------------------------------------------------------- #
async def pedir(
    db: AsyncSession,
    *,
    devolucion_id: str,
    actor_id: str,
    momento: datetime | None = None,
) -> ProductRefund:
    """Le pide a la pasarela que devuelva el dinero.

    LA LLAMADA A LA PASARELA VA FUERA DE LA TRANSACCIÓN, y por eso esta función
    hace `commit` antes de salir a la red: es una llamada HTTP a un tercero y no
    puede ocurrir con filas bloqueadas. Es la misma regla que el paso 7 del
    checkout del Incremento 5.

    APAGADO FALLA EN CERRADO Y LO DICE. `NoConfigurado` contesta
    `provider_not_configured`, la devolución queda `failed` con ese código, y
    **nunca** se marca como confirmada: eso diría que el dinero salió cuando no
    ha salido.
    """
    await exigir_disponible(db)
    momento = momento or ahora()

    devolucion = await db.get(ProductRefund, devolucion_id, with_for_update=True)
    if devolucion is None:
        raise DevolucionNoEncontrada("Devolución no encontrada.")
    if devolucion.status not in (DEVOLUCION_APROBADA, DEVOLUCION_FALLIDA):
        raise DevolucionNoPermitida(
            "Esa devolución ya se pidió.",
            details={"reason": "already_requested", "status": devolucion.status},
        )

    orden = await db.get(ProductOrder, devolucion.order_id)
    if orden is None or not (orden.external_payment_id or "").strip():
        # SIN LA TRANSACCIÓN ORIGINAL NO HAY NADA QUE DEVOLVER: se devuelve un
        # cobro, no un importe suelto.
        raise DevolucionNoPermitida(
            "Ese pedido no tiene una transacción que devolver.",
            details={"reason": "no_original_charge"},
        )

    anterior = devolucion.status
    devolucion.status = DEVOLUCION_PEDIDA
    devolucion.requested_at = momento
    devolucion.failed_at = None
    devolucion.failure_code = None
    devolucion.failure_message = None
    devolucion.updated_at = momento
    await _anotar(
        db,
        devolucion,
        desde=anterior,
        hasta=DEVOLUCION_PEDIDA,
        actor_id=actor_id,
        actor_rol=ACTOR_ADMINISTRACION,
        momento=momento,
    )
    #: SE GUARDA ANTES DE SALIR A LA RED. Si la llamada se queda colgada, lo que
    #: queda escrito es «se pidió», que es la verdad; perderlo dejaría una
    #: devolución que la pasarela conoce y nosotros no.
    await db.commit()

    peticion = RefundRequestToProvider(
        external_transaction_id=str(orden.external_payment_id),
        amount_minor=int(devolucion.amount_minor),
        currency=str(devolucion.currency),
        idempotency_key=str(devolucion.idempotency_key),
        metadata={"domain": "producto", "product_order_id": str(orden.id)},
    )
    proveedor = _proveedor()
    if devolucion.kind == DEVOLUCION_PARCIAL and not hasattr(
        proveedor, "create_partial_refund"
    ):
        #: LA PARCIAL NECESITA UN MÉTODO QUE EL ADAPTADOR DE CURSOS NO TIENE:
        #: el suyo omite el importe a propósito para devolver el cobro entero.
        #: Se dice y se para; fingir una total sería devolver más de lo decidido.
        resultado = None
    elif devolucion.kind == DEVOLUCION_PARCIAL:
        resultado = await proveedor.create_partial_refund(peticion)
    else:
        resultado = await proveedor.create_full_refund(peticion)

    devolucion = await db.get(ProductRefund, devolucion_id, with_for_update=True)
    assert devolucion is not None
    #: SU PROPIO INSTANTE, y no el de antes de salir a la red. Con el mismo
    #: `momento` en los dos pasos, el historial ordenado por fecha quedaba a
    #: merced del identificador y contaba los pasos en cualquier orden.
    despues = ahora()
    if resultado is None:
        return await _marcar_fallo(
            db,
            devolucion,
            codigo="partial_refund_not_supported",
            mensaje=(
                "La pasarela configurada solo sabe devolver el cobro entero."
            ),
            actor_id=actor_id,
            momento=despues,
        )

    devolucion.provider = getattr(proveedor, "name", "unknown")
    if resultado.status == "succeeded":
        return await _confirmar(
            db,
            devolucion,
            referencia=resultado.external_refund_id,
            actor_id=actor_id,
            momento=despues,
        )
    if resultado.status == "pending":
        anterior = devolucion.status
        devolucion.status = DEVOLUCION_EN_CURSO
        devolucion.external_refund_id = resultado.external_refund_id or None
        devolucion.updated_at = despues
        await _anotar(
            db,
            devolucion,
            desde=anterior,
            hasta=DEVOLUCION_EN_CURSO,
            actor_id=actor_id,
            actor_rol=ACTOR_ADMINISTRACION,
            referencia=resultado.external_refund_id or None,
            momento=despues,
        )
        await db.flush()
        return devolucion
    return await _marcar_fallo(
        db,
        devolucion,
        codigo=resultado.failure_code or "provider_error",
        mensaje=resultado.failure_message or "",
        actor_id=actor_id,
        momento=despues,
    )


async def _marcar_fallo(
    db: AsyncSession,
    devolucion: ProductRefund,
    *,
    codigo: str,
    mensaje: str,
    actor_id: str | None,
    momento: datetime,
) -> ProductRefund:
    anterior = devolucion.status
    devolucion.status = DEVOLUCION_FALLIDA
    devolucion.failed_at = momento
    devolucion.failure_code = codigo
    devolucion.failure_message = (mensaje or "")[:500] or None
    devolucion.updated_at = momento
    await _anotar(
        db,
        devolucion,
        desde=anterior,
        hasta=DEVOLUCION_FALLIDA,
        actor_id=actor_id,
        actor_rol=ACTOR_ADMINISTRACION,
        motivo=codigo,
        momento=momento,
    )
    await db.flush()
    return devolucion


# --------------------------------------------------------------------------- #
# 3. Confirmarla. Es lo único que dice que el dinero salió.
# --------------------------------------------------------------------------- #
async def _confirmar(
    db: AsyncSession,
    devolucion: ProductRefund,
    *,
    referencia: str | None,
    actor_id: str | None,
    momento: datetime,
) -> ProductRefund:
    """Marca el dinero como devuelto Y CIERRA LO QUE ESO ARRASTRA.

    TRES COSAS, Y NINGUNA SOBRA:

      1. la devolución queda `confirmed`, con su referencia;
      2. la reserva del saldo pasa a CONSUMIDA —el dinero se gastó en devolver,
         no vuelve al proveedor— y el saldo se cancela si la devolución fue
         total;
      3. la reclamación que la originó marca su efecto como EJECUTADO, que es lo
         que deja de bloquear el resto del saldo.

    IDEMPOTENTE. Dos avisos de la pasarela del mismo reembolso no cancelan el
    saldo dos veces ni escriben dos veces el historial.
    """
    if devolucion.status == DEVOLUCION_CONFIRMADA:
        return devolucion

    anterior = devolucion.status
    devolucion.status = DEVOLUCION_CONFIRMADA
    devolucion.confirmed_at = momento
    devolucion.external_refund_id = referencia or devolucion.external_refund_id
    devolucion.failed_at = None
    devolucion.failure_code = None
    devolucion.updated_at = momento
    await _anotar(
        db,
        devolucion,
        desde=anterior,
        hasta=DEVOLUCION_CONFIRMADA,
        actor_id=actor_id,
        actor_rol=ACTOR_ADMINISTRACION,
        referencia=referencia,
        momento=momento,
    )

    if devolucion.balance_id is not None:
        from app.modules.commerce.models import OwnerSaleBalance

        saldo = await db.get(
            OwnerSaleBalance, devolucion.balance_id, with_for_update=True
        )
        if saldo is not None:
            for reserva in await finanzas.reservas_de(
                db, saldo_id=saldo.id, solo_vivas=True
            ):
                if reserva.reason == finanzas.RESERVA_POR_DEVOLUCION:
                    await finanzas.soltar_reserva(
                        db,
                        reserva=reserva,
                        consumida=True,
                        actor_id=actor_id,
                        motivo="devolucion confirmada",
                        momento=momento,
                    )
            if devolucion.kind == DEVOLUCION_TOTAL and saldo.status in (
                finanzas.PENDIENTE,
                finanzas.ELEGIBLE,
            ):
                # UN SALDO DEVUELTO ENTERO NO SE LE PAGA A NADIE.
                saldo.status = finanzas.CANCELADO
                saldo.updated_at = momento

    if devolucion.incident_id is not None:
        caso = await db.get(ProductIncident, devolucion.incident_id)
        if caso is not None and caso.financial_effect == maquina.EFECTO_PENDIENTE:
            # EL EFECTO YA SE EJECUTÓ. Es lo que deja de bloquear el saldo, y
            # hasta la 0082 no había forma de decirlo.
            caso.financial_effect = maquina.EFECTO_EJECUTADO
            caso.updated_at = momento

    await db.flush()
    return devolucion


async def atender_aviso(
    db: AsyncSession,
    *,
    referencia_externa: str,
    exito: bool,
    codigo: str | None = None,
    mensaje: str | None = None,
    momento: datetime | None = None,
) -> ProductRefund | None:
    """Lo que dice la pasarela. ES LO ÚNICO QUE CONFIRMA QUE EL DINERO SALIÓ.

    `None` cuando ese reembolso no es de Productos: el aviso lo atiende primero
    quien lo reconoce, y no reconocerlo no es un error.
    """
    if not await esquema.hay_finanzas(db):
        return None
    momento = momento or ahora()
    devolucion = await db.scalar(
        select(ProductRefund).where(
            ProductRefund.external_refund_id == referencia_externa
        )
    )
    if devolucion is None:
        return None
    if exito:
        return await _confirmar(
            db,
            devolucion,
            referencia=referencia_externa,
            actor_id=None,
            momento=momento,
        )
    if devolucion.status == DEVOLUCION_CONFIRMADA:
        # UN AVISO DE FALLO NO DESHACE UN ÉXITO. Si la pasarela se contradice,
        # lo que vale es que el dinero ya salió; la contradicción se concilia.
        logger.warning(
            "Productos: aviso de fallo sobre una devolución ya confirmada (%s)",
            devolucion.id,
        )
        return devolucion
    return await _marcar_fallo(
        db,
        devolucion,
        codigo=codigo or "provider_error",
        mensaje=mensaje or "",
        actor_id=None,
        momento=momento,
    )


# --------------------------------------------------------------------------- #
# 4. Anularla, mientras no haya salido.
# --------------------------------------------------------------------------- #
async def anular(
    db: AsyncSession,
    *,
    devolucion_id: str,
    actor_id: str,
    motivo: str,
    momento: datetime | None = None,
) -> ProductRefund:
    """Cancela una devolución que todavía no ha salido, y suelta su reserva.

    UNA CONFIRMADA NO SE ANULA. El dinero ya volvió al comprador; deshacerlo
    aquí no lo trae de vuelta y dejaría el registro diciendo lo contrario de lo
    que hizo la pasarela.
    """
    await exigir_disponible(db)
    momento = momento or ahora()
    devolucion = await db.get(ProductRefund, devolucion_id, with_for_update=True)
    if devolucion is None:
        raise DevolucionNoEncontrada("Devolución no encontrada.")
    if devolucion.status == DEVOLUCION_CONFIRMADA:
        raise DevolucionNoPermitida(
            "Esa devolución ya se pagó y no se puede anular.",
            details={"reason": "already_confirmed"},
        )
    if devolucion.status == DEVOLUCION_ANULADA:
        return devolucion

    anterior = devolucion.status
    devolucion.status = DEVOLUCION_ANULADA
    devolucion.failed_at = None
    devolucion.failure_code = None
    devolucion.updated_at = momento
    await _anotar(
        db,
        devolucion,
        desde=anterior,
        hasta=DEVOLUCION_ANULADA,
        actor_id=actor_id,
        actor_rol=ACTOR_ADMINISTRACION,
        motivo=motivo,
        momento=momento,
    )

    if devolucion.balance_id is not None:
        for reserva in await finanzas.reservas_de(
            db, saldo_id=devolucion.balance_id, solo_vivas=True
        ):
            if reserva.reason == finanzas.RESERVA_POR_DEVOLUCION:
                await finanzas.soltar_reserva(
                    db,
                    reserva=reserva,
                    consumida=False,
                    actor_id=actor_id,
                    motivo=motivo,
                    momento=momento,
                )
    await db.flush()
    return devolucion


# --------------------------------------------------------------------------- #
# 5. Leer.
# --------------------------------------------------------------------------- #
async def del_pedido(db: AsyncSession, *, orden_id: str) -> list[ProductRefund]:
    if not await esquema.hay_finanzas(db):
        return []
    return list(
        await db.scalars(
            select(ProductRefund)
            .where(ProductRefund.order_id == orden_id)
            .order_by(ProductRefund.created_at.desc(), ProductRefund.id.desc())
        )
    )


async def por_atender(
    db: AsyncSession, *, limite: int = 20
) -> list[ProductRefund]:
    """Las que esperan algo: aprobadas sin pedir, pedidas sin confirmar."""
    await exigir_disponible(db)
    return list(
        await db.scalars(
            select(ProductRefund)
            .where(ProductRefund.status.in_(DEVOLUCION_EN_MARCHA))
            .order_by(ProductRefund.created_at, ProductRefund.id)
            .limit(max(1, min(int(limite), 50)))
        )
    )


async def historial_de(
    db: AsyncSession, *, devolucion_id: str
) -> list[ProductRefundEvent]:
    await exigir_disponible(db)
    return list(
        await db.scalars(
            select(ProductRefundEvent)
            .where(ProductRefundEvent.refund_id == devolucion_id)
            .order_by(ProductRefundEvent.created_at, ProductRefundEvent.id)
        )
    )


__all__ = [
    "CLAVE_DE_DEVOLUCION",
    "DevolucionDuplicada",
    "DevolucionNoEncontrada",
    "DevolucionNoPermitida",
    "ahora",
    "anular",
    "aprobar",
    "atender_aviso",
    "del_pedido",
    "devuelto_de",
    "exigir_disponible",
    "historial_de",
    "pedir",
    "por_atender",
    "por_que_no_se_puede_devolver",
]
