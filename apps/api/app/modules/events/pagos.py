"""El cobro de una entrada, a través del puerto compartido de pagos.

ESTE MÓDULO NO CONOCE STRIPE. Habla con `payments.providers.PaymentProvider`,
que es la misma interfaz que usa Cursos: dos operaciones, iniciar el cobro y
verificar el aviso de vuelta. Si mañana la empresa elige otra pasarela, aquí no
se toca nada.

NADA DE ESTO ESTÁ ENCENDIDO. `FEATURE_EVENT_PAYMENTS` nace apagada y
`EVENT_PAYMENTS_PROVIDER` nace en `none`. Con cualquiera de las dos así, iniciar
un pago responde 503 con un código estable en vez de fallar al llamar a una
pasarela que no está configurada. No hay credenciales en el repositorio y no se
simula ningún cobro: una orden solo se paga con un aviso verificado de verdad.

QUÉ DECIDE EL SERVIDOR Y QUÉ NO DECIDE NADIE MÁS. El importe, la moneda y el
concepto salen de la orden, que se escribió con los precios congelados en la
reserva. El cliente no manda `amount`: si lo mandara, mandaría el precio.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from sqlalchemy import select

from app.core.config import get_settings
from app.modules.events import inventory, orders
from app.modules.events.models import ORDEN_EN_CURSO, ORDEN_PROCESANDO, EventOrder
from app.modules.payments.providers import CheckoutRequest, get_provider

logger = logging.getLogger("renaser.events")

#: El valor de `metadata.dominio` que marca un cobro como de entradas. El
#: webhook compartido lo usa para saber a quién entregarle el aviso sin tener
#: que buscar el identificador en la tabla equivocada primero.
DOMINIO = "evento"


@dataclass(frozen=True)
class IntentoDePago:
    """A dónde mandar a quien paga, y con qué referencia."""

    checkout_url: str
    provider: str
    provider_reference: str


def proveedor_configurado() -> str:
    """Qué pasarela cobra las entradas hoy: `none` o su nombre."""
    ajustes = get_settings()
    if not ajustes.feature_event_payments:
        return "none"
    nombre = (ajustes.event_payments_provider or "none").strip().lower()
    return nombre if nombre != "none" and get_provider(nombre) is not None else "none"


def exigir_pagos_disponibles() -> None:
    """Sin bandera o sin pasarela, 503 con un código estable.

    NO SE INTENTA LLAMAR para descubrirlo. Fallar dentro del SDK deja al cliente
    con un error de la pasarela sobre algo que es una decisión nuestra.
    """
    if proveedor_configurado() == "none":
        raise orders.PagosNoDisponibles()


def referencia_de_operacion(orden: EventOrder) -> str:
    """La referencia interna del intento de cobro, para conciliar.

    DETERMINISTA Y ATADA A LA ORDEN: se guarda en `operation_ref` y no cambia
    entre reintentos, así que sirve para cruzar un cobro con su pedido cuando
    algo hay que revisarlo a mano.

    NO ES la clave de idempotencia que viaja a la pasarela. Esa la construye el
    adaptador del proveedor a partir del pedido, el importe y la moneda, y es
    igualmente determinista: reintentar tras un timeout devuelve el MISMO cobro
    en vez de abrir otro. Cambiarla porque «esta vez seguro que falló» es
    exactamente cómo se cobra dos veces.
    """
    return f"evt-ord-{orden.id}"


async def iniciar_pago(
    db: AsyncSession,
    *,
    orden: EventOrder,
    titulo_del_evento: str,
    correo: str,
    return_url: str,
    cancel_url: str,
) -> IntentoDePago:
    """Abre el cobro en la pasarela y deja la orden en `PAYMENT_PROCESSING`.

    NO MARCA NADA COMO PAGADO. Abrir un checkout no es cobrar: quien decide eso
    es el aviso verificado, y hasta entonces la orden sigue debiendo dinero y la
    reserva sigue apartando el aforo.
    """
    exigir_pagos_disponibles()
    if orden.status not in ORDEN_EN_CURSO:
        raise orders.OrdenNoPagable(f"Ese pedido está {orden.status}.")
    if int(orden.total_minor) <= 0:
        # Una orden gratuita se confirma sola al crearse; llegar aquí significa
        # que algo la dejó pendiente, y abrir un cobro de cero no lo arregla.
        raise orders.OrdenNoPagable("Ese pedido no tiene nada que cobrar.")

    nombre = proveedor_configurado()
    proveedor = get_provider(nombre)
    assert proveedor is not None  # `proveedor_configurado` ya lo comprobó

    ajustes = get_settings()
    sesion = await proveedor.create_checkout(
        CheckoutRequest(
            purchase_id=orden.id,
            concepto=f"Entradas · {titulo_del_evento}"[:120],
            # DEL SERVIDOR, SIEMPRE. La orden guarda los precios congelados en
            # la reserva; el cliente no manda un importe porque no le toca.
            amount_minor=int(orden.total_minor),
            currency=orden.currency,
            user_email=correo,
            return_url=return_url,
            cancel_url=cancel_url,
            metadata={
                "order_id": orden.id,
                "dominio": DOMINIO,
                "event_id": orden.event_id,
                "buyer_id": orden.buyer_id,
            },
        )
    )

    # BAJO CERROJO Y RECOMPROBANDO, porque entre leer la orden y llegar aquí ha
    # habido una llamada HTTP a la pasarela que puede tardar segundos. Sin esto,
    # quien cancelara el pedido en ese hueco se encontraba con
    # `PAYMENT_PROCESSING` escrito encima de su `CANCELLED`, `cancelled_at`
    # todavía puesto, el CHECK de la base rechazando la transacción y un 500.
    async with inventory.espera_traducida(db):
        fresca = await db.scalar(
            select(EventOrder)
            .where(EventOrder.id == orden.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    if fresca is None or fresca.status not in ORDEN_EN_CURSO:
        await db.rollback()
        raise orders.OrdenNoPagable(
            "Ese pedido dejó de admitir un pago mientras se abría el cobro."
        )

    fresca.provider = nombre
    fresca.environment = ajustes.payments_environment
    fresca.operation_ref = referencia_de_operacion(fresca)
    fresca.status = ORDEN_PROCESANDO
    fresca.updated_at = orders.ahora()
    await db.commit()

    return IntentoDePago(
        checkout_url=sesion.checkout_url,
        provider=nombre,
        provider_reference=sesion.provider_reference,
    )


async def atender_aviso(db: AsyncSession, evento) -> bool:
    """Entrega un aviso YA VERIFICADO a la orden que le corresponde.

    Quien llama —el webhook compartido— comprobó la firma, guardó el aviso en
    crudo contra el índice anti-repetición y abrió un savepoint. Aquí solo se
    decide si este aviso confirma, tumba o no significa nada para la orden.

    Devuelve si el aviso tuvo efecto. No lanza por un aviso que no nos incumbe:
    hacer fallar el webhook por eso lo pone a reintentar en bucle.
    """
    if evento.status == "paid":
        try:
            resultado = await orders.confirmar_pago(
                db,
                orden_id=evento.purchase_id,
                provider="stripe",
                environment=evento.environment,
                external_payment_id=evento.provider_transaction_id,
                amount_minor=evento.amount_minor,
                currency=evento.currency,
            )
        except Exception:
            # Se registra con el identificador del cobro, NUNCA con el del
            # comprador ni con la credencial de ninguna entrada.
            logger.exception(
                "[eventos] no se pudo confirmar la orden del cobro %s",
                evento.provider_transaction_id,
            )
            raise
        return resultado.estrenada

    if evento.status in ("failed", "cancelled"):
        # FALLO TERMINAL, y solo eso. Un timeout o un error de red no llegan
        # por aquí: la pasarela no manda un aviso firmado por haberse caído.
        await orders.marcar_fallida(
            db, orden_id=evento.purchase_id, motivo=evento.event_type or evento.status
        )
        return True

    # 'pendiente', 'refunded' y los estados de devolución. Ninguno emite una
    # entrada, y devolver el dinero de un evento es un incremento posterior:
    # decidirlo aquí sería inventarse una política de cancelación.
    return False
