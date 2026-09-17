"""El cobro de un pedido de productos, por el puerto compartido de pagos.

ESTE MÓDULO NO CONOCE STRIPE. Habla con `payments.providers.PaymentProvider`,
la misma interfaz que usan Cursos y Eventos. No se crea un segundo cliente de
Stripe: hay uno, con su verificación de firma y su tolerancia de reloj, y
duplicarlo sería duplicar también el sitio donde se olvida arreglar un fallo.

NADA DE ESTO ESTÁ ENCENDIDO, y no basta con encender una cosa. Para que un
producto se pueda cobrar tienen que darse CINCO condiciones a la vez —las
enumera `pedidos.por_que_no_se_puede_vender`— más una política publicada para la
jurisdicción. Con cualquiera sin cumplir, la ruta contesta 503 con un código
estable y la lista de lo que falta, en vez de fallar dentro del SDK de una
pasarela que nadie configuró.

LAS URL DE VUELTA LAS PONE EL SERVIDOR. No se acepta una URL del cliente ni una
que venga del proveedor: una URL de retorno controlada por otro es una página
que puede decir «pagado» sin que se haya pagado nada. Y aunque las nuestras
lleven el identificador del pedido, LA VUELTA DEL NAVEGADOR NO CONFIRMA DINERO:
la pantalla de retorno pregunta al servidor por el estado.

QUÉ DECIDE EL SERVIDOR Y QUÉ NO DECIDE NADIE MÁS. El importe, la moneda y el
concepto salen del pedido, que se escribió con los precios congelados al
reservar. El cliente no manda `amount`: si lo mandara, mandaría el precio.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.modules.payments.providers import CheckoutRequest, get_provider
from app.modules.products import esquema, pedidos
from app.modules.products.models import (
    PEDIDO_EN_CURSO,
    PEDIDO_FALLIDO,
    PEDIDO_PROCESANDO,
    ProductOrder,
)

logger = logging.getLogger("renaser.products")

#: El valor de `metadata.dominio` que marca un cobro como de un producto
#: físico. El webhook compartido lo usa para repartir el aviso sin tener que
#: buscar el identificador en la tabla equivocada primero.
DOMINIO = "producto"

#: Estados de aviso que hablan de dinero que VUELVE. Hoy NO deshacen nada: se
#: anotan para que una persona los concilie.
#:
#: Y ES DELIBERADO. Devolver el importe y deshacer la venta son dos decisiones
#: distintas, y la segunda no existe todavía: devolución, reembolso y garantía
#: son de los Incrementos 8 y 9, y ninguna política los ha fijado. Soltar aquí
#: el inventario por iniciativa propia sería inventarse la política.
DINERO_QUE_VUELVE = frozenset(
    {
        "refunded",
        "refund_procesando",
        "refund_parcial",
        "refund_fallido",
        "disputa_abierta",
        "disputa_fondos_retirados",
        "disputa_cerrada",
    }
)


@dataclass(frozen=True)
class IntentoDePago:
    """A dónde mandar a quien paga, y con qué referencia."""

    checkout_url: str
    provider: str
    provider_reference: str


def referencia_de_operacion(orden: ProductOrder) -> str:
    """La referencia interna del intento de cobro, para conciliar a mano.

    DETERMINISTA Y ATADA AL PEDIDO: no cambia entre reintentos, así que sirve
    para cruzar un cobro con su pedido cuando algo hay que mirarlo. No es la
    clave de idempotencia que viaja a la pasarela: esa la construye el adaptador
    a partir del pedido, el importe y la moneda, y cambiarla porque «esta vez
    seguro que falló» es exactamente cómo se cobra dos veces.
    """
    return f"prod-ord-{orden.id}"


def urls_de_vuelta(orden_id: str) -> tuple[str, str]:
    """A dónde vuelve el navegador. LAS PONE EL SERVIDOR.

    Y VUELVE A SITIOS DISTINTOS. Mandar a la página de «gracias por tu compra»
    a quien acaba de cancelar es mentirle sobre lo que acaba de pasar.
    """
    ajustes = get_settings()
    return (
        f"{ajustes.payments_return_url}?product_order={orden_id}",
        f"{ajustes.payments_cancel_url}?product_order={orden_id}",
    )


async def iniciar_pago(
    db: AsyncSession, *, orden: ProductOrder, correo: str
) -> IntentoDePago:
    """Abre el cobro y deja el pedido en `PAYMENT_PROCESSING`.

    NO MARCA NADA COMO PAGADO. Abrir un checkout no es cobrar: quien decide eso
    es el aviso verificado, y hasta entonces el pedido sigue debiendo dinero y
    la reserva sigue apartando las unidades.
    """
    pedidos.exigir_venta_habilitada()
    await esquema.exigir_pedidos(db)

    momento = pedidos.ahora()

    #: UN COBRO FALLIDO SE PUEDE REINTENTAR MIENTRAS LA RESERVA VIVA. Sin esto,
    #: una tarjeta rechazada dejaba el pedido muerto con sus unidades apartadas
    #: hasta el vencimiento, y la persona no podía hacer nada.
    if orden.status == PEDIDO_FALLIDO:
        await pedidos.reintentar(db, orden=orden, momento=momento)

    if orden.status not in PEDIDO_EN_CURSO:
        raise pedidos.PedidoNoPagable(
            f"Ese pedido está {orden.status}.", details={"status": orden.status}
        )
    if int(orden.total_minor) <= 0:
        #: UN COBRO DE CERO NO ES UN COBRO. Un pedido de cero no debería existir
        #: —`crear` lo rechaza— y si llegó aquí, abrir un checkout no lo arregla.
        raise pedidos.PedidoNoPagable("Ese pedido no tiene nada que cobrar.")

    limite = pedidos._comparable(orden.reserved_until, momento)
    if orden.reservation_settled_at is not None or limite is None or limite <= momento:
        raise pedidos.PedidoNoPagable(
            "La reserva de ese pedido ya venció.",
            details={"status": orden.status},
        )

    proveedor = get_provider("stripe")
    if proveedor is None:  # pragma: no cover - registrado en providers.py
        raise pedidos.VentaNoDisponible(["stripe_provider"])

    lineas = await pedidos.lineas_de(db, orden.id)
    #: EL CONCEPTO, SIN INVENTAR NADA. Un solo artículo se nombra; varios se
    #: cuentan. Escribir aquí el nombre de la tienda o una promesa —«compra
    #: protegida»— sería decirle a quien paga algo que no está decidido.
    if len(lineas) == 1:
        concepto = lineas[0].name_snapshot
    else:
        concepto = f"{len(lineas)} artículos"

    retorno, cancelacion = urls_de_vuelta(orden.id)
    ajustes = get_settings()
    sesion = await proveedor.create_checkout(
        CheckoutRequest(
            purchase_id=orden.id,
            concepto=concepto[:120],
            #: DEL SERVIDOR, SIEMPRE. El pedido guarda los precios congelados al
            #: reservar; el cliente no manda un importe porque no le toca.
            amount_minor=int(orden.total_minor),
            currency=orden.currency,
            user_email=correo,
            return_url=retorno,
            cancel_url=cancelacion,
            metadata={
                "dominio": DOMINIO,
                "order_id": orden.id,
                "buyer_id": orden.buyer_id,
                "seller_id": orden.seller_id,
                "environment": orden.environment,
                "operation_ref": referencia_de_operacion(orden),
            },
        )
    )

    #: BAJO CERROJO Y RECOMPROBANDO, porque entre leer el pedido y llegar aquí
    #: ha habido una llamada HTTP que puede tardar segundos. Sin esto, quien
    #: cancelara en ese hueco se encontraba `PAYMENT_PROCESSING` escrito encima
    #: de su `CANCELLED`, el CHECK de la base rechazando la transacción y un 500.
    fresco = await pedidos._bloqueado(db, orden.id)
    if fresco is None or fresco.status not in PEDIDO_EN_CURSO:
        await db.rollback()
        raise pedidos.PedidoNoPagable(
            "Ese pedido dejó de admitir un pago mientras se abría el cobro."
        )

    fresco.provider = "stripe"
    fresco.environment = ajustes.payments_environment
    fresco.operation_ref = referencia_de_operacion(fresco)
    anterior = fresco.status
    fresco.status = PEDIDO_PROCESANDO
    fresco.updated_at = momento
    if anterior != PEDIDO_PROCESANDO:
        await pedidos._anotar(
            db,
            orden=fresco,
            desde=anterior,
            hasta=PEDIDO_PROCESANDO,
            actor_id=fresco.buyer_id,
            actor_rol="buyer",
        )
    await db.commit()

    return IntentoDePago(
        checkout_url=sesion.checkout_url,
        provider="stripe",
        provider_reference=sesion.provider_reference,
    )


async def es_de_productos(db: AsyncSession, evento) -> bool:
    """Si este cobro es de un pedido de productos, MIRANDO NUESTRAS TABLAS.

    POR QUÉ NO BASTA LA METADATA. Al abrir el checkout le adjuntamos
    `dominio=producto`, y esa metadata sobrevive al cobro. Pero un aviso de
    DEVOLUCIÓN o de DISPUTA no trae el cobro: trae el objeto `refund` o
    `dispute`, con metadata PROPIA —vacía si el reembolso se hizo desde el panel
    de Stripe—. Ese aviso llegaría sin dominio y caería en la rama de otro
    módulo, que no encontraría ningún pedido suyo y lo daría por atendido.

    La referencia del cobro SÍ sobrevive en los tres objetos, y es la que
    guardamos al confirmar. Preguntárselo a nuestra propia tabla no depende de
    lo que Stripe decida propagar.
    """
    referencia = (getattr(evento, "provider_transaction_id", "") or "").strip()
    if not referencia:
        return False
    orden = await pedidos.por_cobro(
        db, referencia=referencia, entorno=evento.environment
    )
    return orden is not None


async def atender_aviso(db: AsyncSession, evento) -> str | None:
    """Entrega un aviso YA VERIFICADO al pedido que le corresponde.

    Quien llama —el webhook compartido— comprobó la firma, guardó el aviso en
    crudo contra el índice anti-repetición y abrió un savepoint. Aquí solo se
    decide si este aviso confirma, tumba o no significa nada para el pedido.

    Devuelve una NOTA cuando el aviso necesita que lo mire una persona, o `None`
    cuando queda cerrado.
    """
    if evento.status == "paid":
        try:
            await pedidos.confirmar_pago(
                db,
                orden_id=evento.purchase_id,
                provider="stripe",
                environment=evento.environment,
                external_payment_id=evento.provider_transaction_id,
                amount_minor=evento.amount_minor,
                currency=evento.currency,
            )
        except pedidos.PagoNoCuadra as fallo:
            #: EL PAGO QUE LLEGA TARDE, O QUE NO CUADRA. Ni se cobra en silencio
            #: ni se niega en silencio: el pedido queda EXPLÍCITAMENTE en
            #: revisión, con su motivo, y lo resuelve una persona. Inventarse
            #: unidades para no dar una mala noticia es prometer un producto que
            #: otra persona ya compró.
            await pedidos.marcar_en_revision(
                db, orden_id=evento.purchase_id, motivo=str(fallo)[:500]
            )
            logger.warning(
                "[productos] cobro %s que no cuadra con su pedido: %s",
                evento.provider_transaction_id,
                fallo,
            )
            return (
                "Cobro de un pedido de productos que no cuadra. "
                "El pedido queda en revisión manual."
            )
        except Exception:
            #: Con el identificador del COBRO y nunca con el del comprador ni
            #: con su dirección.
            logger.exception(
                "[productos] no se pudo confirmar el pedido del cobro %s",
                evento.provider_transaction_id,
            )
            raise
        return None

    if evento.status in ("failed", "cancelled"):
        #: FALLO TERMINAL, y solo eso. Un timeout o un error de red no llegan
        #: por aquí: la pasarela no manda un aviso firmado por haberse caído.
        #: NO SUELTA LA RESERVA: mientras siga viva se puede reintentar.
        await pedidos.marcar_fallido(
            db,
            orden_id=evento.purchase_id,
            motivo=evento.event_type or evento.status,
        )
        return None

    if evento.status in DINERO_QUE_VUELVE:
        #: NO SE DESHACE NADA. Ver la cabecera de `DINERO_QUE_VUELVE`.
        logger.info(
            "[productos] dinero que vuelve (%s) del cobro %s",
            evento.event_type,
            evento.provider_transaction_id,
        )
        return (
            f"Devolución o disputa de un pedido de productos ({evento.event_type})."
            " Pendiente de conciliar a mano: no hay política de devoluciones."
        )

    #: 'pendiente' e 'ignorado'. Ninguno vende nada.
    return None


__all__ = [
    "DINERO_QUE_VUELVE",
    "DOMINIO",
    "IntentoDePago",
    "atender_aviso",
    "es_de_productos",
    "iniciar_pago",
    "referencia_de_operacion",
    "urls_de_vuelta",
]
