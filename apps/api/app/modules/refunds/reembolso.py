"""Qué pasa cuando un reembolso se confirma de verdad.

ES EL ÚNICO SITIO QUE RETIRA UN ACCESO COMPRADO, y solo lo hace con un
reembolso TOTAL, CONFIRMADO y CONCILIADO con la orden y el entorno correctos.

LO QUE **NO** RETIRA ACCESO, y cada uno estuvo a punto de hacerlo:

    crear la solicitud          no
    empezar la revisión         no
    aprobar                     no
    `refund.created` de Stripe  no
    un reembolso pendiente      no
    un reembolso PARCIAL        no
    un reembolso fallido        no

Quitarle el curso a alguien antes de que el dinero le vuelva es lo peor que
puede hacer esta funcionalidad: se queda sin las dos cosas.

Y LO QUE SE CONSERVA PASE LO QUE PASE: la matrícula y el progreso. Alguien que
devolvió un curso y lo recompra meses después vuelve por donde iba. Borrar su
avance sería castigarle por haber usado una garantía que se le ofreció.
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.commerce import liquidacion
from app.modules.commerce import service as comercio_service
from app.modules.commerce.models import CommerceProduct, Order
from app.modules.refunds import estados, service
from app.modules.refunds.models import RefundRequest

logger = logging.getLogger("renaser.refunds")


class NoConciliado(Exception):
    """El aviso no cuadra con la orden. No se toca nada."""


def conciliar(
    *,
    orden: Order,
    solicitud: RefundRequest | None,
    amount_minor: int,
    environment: str,
) -> None:
    """Comprueba que este reembolso es el de esta orden. Lanza si no.

    TRES COMPROBACIONES, y ninguna sobra:

    1. **Entorno.** Un reembolso de sandbox no toca producción, y al revés. Sin
       esto, una prueba retira un acceso real.
    2. **Importe.** Total o nada. Devolver 1 de 199 no puede quitar el curso.
    3. **La solicitud es de esta orden.** Un expediente apuntando a otra compra
       revocaría el acceso equivocado.
    """
    if environment != orden.environment:
        raise NoConciliado(
            f"El aviso viene de '{environment}' y la orden es de "
            f"'{orden.environment}'."
        )
    if amount_minor and amount_minor != orden.amount_minor:
        raise NoConciliado(
            f"Reembolso de {amount_minor} sobre una orden de {orden.amount_minor}: "
            "no es total."
        )
    if solicitud is not None and solicitud.order_id != orden.id:
        raise NoConciliado("La solicitud no pertenece a esta orden.")


async def aplicar(
    db: AsyncSession,
    *,
    orden: Order,
    external_transaction_id: str,
    amount_minor: int,
    currency: str,
    environment: str,
    solicitud: RefundRequest | None = None,
    motivo: str = "reembolso confirmado",
) -> bool:
    """Las diez cosas que pasan al confirmarse un reembolso, en una transacción.

    Devuelve si se aplicó. `False` sin lanzar cuando ya estaba aplicado: un
    webhook repetido no puede revocar dos veces ni notificar dos veces.

    NO HACE COMMIT. Lo hace quien llama, para que o pasa todo o no pasa nada.
    Que el acceso se retire y el saldo del propietario siga vivo —porque el
    commit se coló entre medias— es exactamente el estado imposible que hay que
    evitar.
    """
    conciliar(
        orden=orden,
        solicitud=solicitud,
        amount_minor=amount_minor,
        environment=environment,
    )

    if orden.status == "refunded":
        logger.info("[devoluciones] la orden %s ya estaba reembolsada", orden.id)
        return False

    producto = await db.get(CommerceProduct, orden.commerce_product_id)
    if producto is None or producto.course_id is None:
        raise NoConciliado(f"La orden {orden.id} no resuelve ningún curso.")
    course_id = producto.course_id

    # 1. La transacción de reembolso. Es OTRA fila, no un update de la compra:
    #    machacar la compra borraría que ocurrió.
    _, nueva = await comercio_service.registrar_transaccion(
        db,
        provider=orden.provider,
        environment=environment,
        external_transaction_id=external_transaction_id,
        kind="refund",
        amount_minor=amount_minor or orden.amount_minor,
        currency=currency or orden.currency,
        order_id=orden.id,
    )
    if not nueva:
        # Ya se había registrado: este aviso es una repetición.
        logger.info(
            "[devoluciones] reembolso %s ya registrado; no se repite nada",
            external_transaction_id,
        )
        return False

    # 2. La orden queda reembolsada.
    await comercio_service.marcar_orden(db, order_id=orden.id, status="refunded")

    # 3. Se retira el derecho.
    await comercio_service.revocar_entitlement(
        db, user_id=orden.user_id, commerce_product_id=orden.commerce_product_id
    )

    # 4. Y cualquier compra heredada que todavía diera acceso por su cuenta.
    #    Sin esto, revocar el derecho nuevo dejaría el acceso vivo por la vía
    #    antigua y el reembolso no quitaría nada.
    await comercio_service.revocar_compra_heredada(
        db, user_id=orden.user_id, course_id=course_id
    )

    # 5. La matrícula y el progreso NO se tocan. Está escrito aquí, en el sitio
    #    donde alguien tendría la tentación de borrarlos «para limpiar».

    # 6. La garantía queda consumida, para siempre.
    if solicitud is not None:
        await service.consumir_garantia(db, solicitud)

    # 7. El propietario deja de tener ese dinero pendiente.
    await liquidacion.cancelar(db, order_id=orden.id)

    # 8. El expediente pasa a 'refunded'. Lo mueve el SISTEMA: ni un
    #    administrador puede declararlo a mano.
    if solicitud is not None and solicitud.status != estados.REFUNDED:
        await service.transicionar(
            db,
            solicitud,
            hasta=estados.REFUNDED,
            rol="system",
            actor_id=None,
            reason=motivo,
            external_reference=external_transaction_id,
            metadata={
                "amount_minor": amount_minor,
                "currency": currency,
                "environment": environment,
            },
        )

    logger.info(
        "[devoluciones] orden %s reembolsada por completo; acceso retirado y "
        "progreso conservado",
        orden.id,
    )
    return True
