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


async def descongelar(
    db: AsyncSession, *, order_id: str, refund_request_id: str | None = None
) -> bool:
    """Devuelve el saldo a la cola cuando la solicitud se rechaza o se retira.

    Vuelve a `pending` y NO a `eligible`: si la garantía todavía no había
    vencido, sigue sin haber vencido. El trabajo que libera vencidos ya lo
    recogerá cuando toque.

    NUNCA LEVANTA UNA RETENCIÓN POR DISPUTA. Esas se marcan sin solicitud
    (`frozen_by_request_id` nulo), así que resolver una devolución no puede
    soltar por accidente un dinero que el banco está reclamando. Con
    `refund_request_id` se exige además que sea ESA solicitud la que lo
    congeló.
    """
    condiciones = [
        OwnerSaleBalance.order_id == order_id,
        OwnerSaleBalance.status == "frozen",
    ]
    if refund_request_id is not None:
        condiciones.append(OwnerSaleBalance.frozen_by_request_id == refund_request_id)
    else:
        condiciones.append(OwnerSaleBalance.frozen_by_request_id.is_not(None))
    resultado = await db.execute(
        update(OwnerSaleBalance).where(*condiciones)
        .values(
            status="pending",
            frozen_by_request_id=None,
            updated_at=datetime.now(timezone.utc),
        )
    )
    await db.flush()
    return resultado.rowcount > 0


async def congelar_por_disputa(db: AsyncSession, *, order_id: str) -> bool:
    """Retiene el saldo mientras el banco reclama el cobro.

    SIN SOLICITUD ASOCIADA, y eso es lo que la distingue: `frozen_by_request_id`
    queda nulo, así que ninguna resolución de devolución la levanta. Sale de ahí
    a mano, cuando se sepa cómo acabó la disputa.

    Solo desde `pending` o `eligible`: si el dinero ya salió, esto no lo
    devuelve —ver `docs/`, sección de disputas—.
    """
    resultado = await db.execute(
        update(OwnerSaleBalance)
        .where(
            OwnerSaleBalance.order_id == order_id,
            OwnerSaleBalance.status.in_(("pending", "eligible")),
        )
        .values(
            status="frozen",
            frozen_by_request_id=None,
            updated_at=datetime.now(timezone.utc),
        )
    )
    await db.flush()
    return resultado.rowcount > 0


async def descongelar_disputa(db: AsyncSession, *, order_id: str) -> bool:
    """Suelta una retención por disputa cuando la disputa se GANA.

    Existe porque `descongelar` no puede hacerlo, y es deliberado: aquella exige
    que la retención venga de una solicitud (`frozen_by_request_id` no nulo)
    justamente para que resolver una devolución no suelte por accidente un
    dinero que el banco está reclamando. Sin esta función no había ninguna
    manera de sacar el saldo de `frozen`, y el creador no cobraba nunca esa
    venta.

    SE LLAMA A MANO, no desde un webhook. Ganar una disputa es un hecho que
    alguien comprueba en el panel de Stripe; automatizarlo con
    `charge.dispute.closed` exigiría distinguir el desenlace, y ese aviso
    también llega cuando se pierde.
    """
    resultado = await db.execute(
        update(OwnerSaleBalance)
        .where(
            OwnerSaleBalance.order_id == order_id,
            OwnerSaleBalance.status == "frozen",
            OwnerSaleBalance.frozen_by_request_id.is_(None),
        )
        .values(status="pending", updated_at=datetime.now(timezone.utc))
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


async def puede_transferirse(db: AsyncSession, saldo: OwnerSaleBalance) -> str | None:
    """None si se puede; si no, el código del motivo.

    TODAS LAS PUERTAS TIENEN QUE ESTAR ABIERTAS, y el orden va de lo más barato
    de comprobar a lo más caro. Ninguna sobra: cada una corresponde a una forma
    concreta de pagarle a alguien dinero que todavía no es suyo.

    Las cuatro últimas son DEFENSA EN PROFUNDIDAD. En teoría `eligible` ya
    implica que no hay reclamación (una solicitud congela) ni disputa (también
    congela) ni reembolso (cancela), y que la garantía venció. Se comprueban
    igual porque la única forma de que ese razonamiento falle es que alguien
    haya escrito el estado a mano, y el resultado sería pagar con la garantía
    abierta —dinero que hay que recuperar de un tercero—.
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

    # LA GARANTÍA, explícita. Un `available_at` nulo significa que todavía no se
    # sabe cuándo vence: la persona no ha entrado al curso y el reloj no ha
    # empezado. Pagar ahí es pagar con la garantía entera por delante.
    ahora_mismo = datetime.now(timezone.utc)
    if saldo.available_at is None:
        return "guarantee_not_started"
    vencimiento = saldo.available_at
    if vencimiento.tzinfo is None:
        vencimiento = vencimiento.replace(tzinfo=timezone.utc)
    if vencimiento > ahora_mismo:
        return "guarantee_open"

    # UNA RECLAMACIÓN VIVA, aunque el saldo no esté congelado.
    from app.modules.refunds import esquema as esquema_devoluciones

    if await esquema_devoluciones.hay_devoluciones(db):
        from app.modules.refunds import estados
        from app.modules.refunds.models import RefundRequest

        viva = await db.scalar(
            select(RefundRequest.id).where(
                RefundRequest.order_id == saldo.order_id,
                RefundRequest.status.in_(tuple(estados.VIVOS)),
            )
        )
        if viva is not None:
            return "refund_request_open"

    # Y QUE LA VENTA SIGA EN PIE. Una orden reembolsada no se le paga a nadie.
    orden = await db.get(Order, saldo.order_id)
    if orden is None or orden.status != "paid":
        return "order_not_payable"

    cuenta = (
        await db.get(OwnerPayoutAccount, saldo.payout_account_id)
        if saldo.payout_account_id
        else None
    )
    if cuenta is None or not cuenta.payouts_enabled:
        return "payout_account_not_ready"
    if (cuenta.onboarding_status or "") != "active":
        return "onboarding_incomplete"
    if cuenta.owner_id != saldo.owner_id:
        # La cuenta conectada tiene que ser la DEL PROPIETARIO de esta venta.
        return "payout_account_mismatch"
    return None


async def _fallos_terminales_de(db: AsyncSession, balance_id: str) -> int:
    """Cuántas veces la pasarela dijo que no de forma CONCLUYENTE.

    Sale de la fila persistida y no de un contador en memoria, así que
    sobrevive a reinicios y es el mismo para todos los procesos.
    """
    from app.modules.commerce.transferencias import es_terminal

    fila = await db.scalar(
        select(OwnerTransfer).where(OwnerTransfer.balance_id == balance_id)
    )
    if fila is None or fila.status != "failed":
        return 0
    return fila.attempts if es_terminal(fila.failure_code or "") else 0


async def _tomar_el_turno(db: AsyncSession, saldo: OwnerSaleBalance) -> bool:
    """UPDATE CONDICIONAL: comparar y escribir en la MISMA sentencia.

    Sin esto, dos procesos que leyeran el mismo saldo `eligible` pasarían los
    dos por `puede_transferirse` y los dos llamarían a la pasarela. La clave de
    idempotencia lo pararía en el proveedor, pero apoyarse solo en ella deja el
    sistema a merced de que esa clave nunca cambie. El segundo afecta a cero
    filas y se entera aquí.
    """
    resultado = await db.execute(
        update(OwnerSaleBalance)
        .where(
            OwnerSaleBalance.id == saldo.id,
            OwnerSaleBalance.status == "eligible",
        )
        .values(status="transferring", updated_at=datetime.now(timezone.utc))
    )
    await db.flush()
    return resultado.rowcount > 0


async def ejecutar_transferencia(
    db: AsyncSession, saldo: OwnerSaleBalance
) -> OwnerTransfer | None:
    """Paga el saldo al creador. Devuelve el intento, o `None` si no procede.

    NO HACE COMMIT: lo hace quien llama, para que o pasa todo o no pasa nada.

    NUNCA CREA UN SEGUNDO PAGO. Tres defensas superpuestas, y ninguna sobra:

    1. `puede_transferirse` con todas sus puertas.
    2. Un UPDATE condicional que serializa quién ejecuta.
    3. Una clave de idempotencia estable por saldo, que solo cambia cuando la
       pasarela ha dicho que no de forma concluyente.

    Un fallo AMBIGUO —tiempo de espera agotado, respuesta ilegible, 5xx— deja el
    saldo en `transferring` y el intento en `processing`, a propósito: el dinero
    PUDO salir, así que tiene que resolverlo la conciliación y no un reintento
    con clave nueva.
    """
    from app.modules.commerce.transferencias import (
        TransferRequest,
        clave_de_idempotencia,
        es_terminal,
        exigir_referencia,
        proveedor_de_transferencias,
    )

    motivo = await puede_transferirse(db, saldo)
    if motivo is not None:
        logger.info(
            "[liquidacion] el saldo %s no se transfiere: %s", saldo.id, motivo
        )
        return None
    if not await _tomar_el_turno(db, saldo):
        logger.info("[liquidacion] otro proceso ya esta pagando el saldo %s", saldo.id)
        return None

    intentos_previos = await _fallos_terminales_de(db, saldo.id)
    clave = clave_de_idempotencia(saldo.id, intentos_previos)
    cuenta = await db.get(OwnerPayoutAccount, saldo.payout_account_id)
    ajustes = get_settings()
    entorno = "sandbox" if ajustes.stripe_api_base.endswith("test") else "production"

    # SE REUTILIZA LA FILA si ya habia un intento para este saldo. No hace falta
    # `on conflict` —el indice unico de la 0049 es PARCIAL, solo sobre las
    # transferencias vivas— porque la exclusion ya la da el UPDATE condicional
    # de arriba: quien llega aqui es el unico que tomo el turno.
    intento = await db.scalar(
        select(OwnerTransfer).where(OwnerTransfer.balance_id == saldo.id)
    )
    if intento is None:
        intento = OwnerTransfer(
            balance_id=saldo.id,
            owner_id=saldo.owner_id,
            payout_account_id=saldo.payout_account_id,
            amount_minor=saldo.net_amount_minor,
            currency=saldo.currency,
            provider="stripe",
            environment=entorno,
            idempotency_key=clave,
            status="processing",
            attempts=intentos_previos + 1,
        )
        db.add(intento)
    else:
        intento.idempotency_key = clave
        intento.status = "processing"
        intento.attempts = intentos_previos + 1
        intento.failure_code = None
        intento.failure_message = None
    await db.flush()

    resultado = await proveedor_de_transferencias().create_transfer(
        TransferRequest(
            destination_account_id=(cuenta.external_account_id if cuenta else ""),
            amount_minor=saldo.net_amount_minor,
            currency=saldo.currency,
            idempotency_key=clave,
            metadata={"balanceId": saldo.id, "orderId": saldo.order_id},
        )
    )
    await _asentar(db, saldo=saldo, intento=intento, resultado=resultado)
    return intento


async def _asentar(
    db: AsyncSession, *, saldo: OwnerSaleBalance, intento: OwnerTransfer, resultado
) -> None:
    """Escribe lo que contestó la pasarela. Es el ÚNICO sitio que marca pagado.

    `owner_transfers` admite 'completed' y no 'succeeded' (lo fija la 0049), así
    que la traducción ocurre aquí y en un solo sitio.
    """
    from app.modules.commerce.transferencias import es_terminal, exigir_referencia

    momento = datetime.now(timezone.utc)
    # Acotados antes de guardarlos: los escribe la pasarela, asi que ni su
    # longitud ni sus caracteres los decidimos nosotros.
    intento.failure_code = (resultado.failure_code or "")[:64] or None
    intento.failure_message = (resultado.failure_message or "")[:500] or None

    referencia = ""
    if resultado.external_transfer_id:
        try:
            referencia = exigir_referencia(resultado.external_transfer_id)
        except ValueError as error:
            # Guardar cualquier cadena es como un expediente acaba preguntando
            # por un identificador que la pasarela no reconoce, para siempre.
            logger.error("[liquidacion] referencia de transferencia invalida: %s", error)
    if referencia:
        intento.external_transfer_id = referencia

    if resultado.status == "succeeded" and referencia:
        intento.status = "completed"
        saldo.status = "transferred"
    elif resultado.status == "failed" and es_terminal(resultado.failure_code):
        # Concluyente: se puede volver a intentar, y con clave nueva.
        intento.status = "failed"
        saldo.status = "eligible"
    else:
        # Pendiente, ambiguo o exitoso SIN identificador: el dinero pudo salir.
        # Se queda en marcha y lo resuelve la conciliacion.
        intento.status = "processing"
        saldo.status = "transferring"
    saldo.updated_at = momento
    intento.updated_at = momento
    await db.flush()


async def conciliar_transferencia(db: AsyncSession, intento: OwnerTransfer) -> str:
    """Le pregunta a la pasarela cómo acabó. NO HACE COMMIT.

    Existe por la misma razón que la conciliación de reembolsos: si el aviso se
    pierde, el saldo se queda en `transferring` para siempre y nadie sabe si el
    creador cobró.
    """
    from app.modules.commerce.transferencias import proveedor_de_transferencias

    referencia = (intento.external_transfer_id or "").strip()
    if not referencia:
        # Sin referencia no hay nada que preguntar. El intento sigue en marcha y
        # se resuelve a mano: preguntar con una cadena vacia y tomar el «no
        # encontrado» por un fallo marcaria como fallido un pago que pudo salir.
        return "sin_referencia"
    resultado = await proveedor_de_transferencias().get_transfer_status(referencia)
    saldo = await db.get(OwnerSaleBalance, intento.balance_id)
    if saldo is None:  # pragma: no cover
        return resultado.status
    await _asentar(db, saldo=saldo, intento=intento, resultado=resultado)
    return resultado.status
