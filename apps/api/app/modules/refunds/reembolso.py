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

from sqlalchemy import select

from app.modules.commerce import liquidacion
from app.modules.commerce import service as comercio_service
from app.modules.commerce.models import CommerceProduct, Order, PaymentTransaction
from app.modules.refunds import estados, service, validacion
from app.modules.refunds.models import RefundRequest
from app.modules.refunds.validacion import (  # noqa: F401  (compatibilidad)
    CompraOriginal,
    NoConciliado,
    ReembolsoConfirmado,
)

logger = logging.getLogger("renaser.refunds")


def _compra(orden: Order) -> CompraOriginal:
    return CompraOriginal(
        id=orden.id,
        amount_minor=orden.amount_minor,
        currency=orden.currency,
        environment=orden.environment,
        provider=orden.provider,
    )


async def _referencia_libre(
    db: AsyncSession, *, referencia: str, orden: Order
) -> None:
    """Que ese reembolso no esté ya contado como el de OTRA orden.

    Sin esto, reenviar el mismo `re_...` cambiando la orden de destino retiraba
    un segundo acceso con un único reembolso real. El UNIQUE de
    `payment_transactions` impide duplicar la fila, no apuntarla a otra compra.
    """
    ajena = await db.scalar(
        select(PaymentTransaction.order_id).where(
            PaymentTransaction.provider == orden.provider,
            PaymentTransaction.environment == orden.environment,
            PaymentTransaction.external_transaction_id == referencia,
            PaymentTransaction.order_id.is_not(None),
            PaymentTransaction.order_id != orden.id,
        )
    )
    if ajena is not None:
        raise NoConciliado(
            f"El reembolso {referencia} ya está registrado en otra orden."
        )


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
    referencia = validacion.exigir_conciliado(
        compra=_compra(orden),
        confirmado=ReembolsoConfirmado(
            external_refund_id=external_transaction_id,
            amount_minor=amount_minor,
            currency=currency,
            environment=environment,
            provider=orden.provider,
        ),
    )
    await _referencia_libre(db, referencia=referencia, orden=orden)

    if orden.status == "refunded":
        logger.info("[devoluciones] la orden %s ya estaba reembolsada", orden.id)
        return False

    producto = await db.get(CommerceProduct, orden.commerce_product_id)
    if producto is None or producto.course_id is None:
        raise NoConciliado(f"La orden {orden.id} no resuelve ningún curso.")
    course_id = producto.course_id

    # El expediente tiene que ser el de ESTA compra. Se comprueba aquí y no en
    # `validacion` porque hasta este punto no se conoce el curso de la orden.
    if solicitud is not None:
        validacion.exigir_expediente_de_la_compra(
            solicitud_order_id=solicitud.order_id,
            solicitud_user_id=solicitud.user_id,
            solicitud_course_id=solicitud.course_id,
            orden_id=orden.id,
            orden_user_id=orden.user_id,
            curso_de_la_orden=course_id,
        )

    # 1. La transacción de reembolso. Es OTRA fila, no un update de la compra:
    #    machacar la compra borraría que ocurrió.
    _, nueva = await comercio_service.registrar_transaccion(
        db,
        provider=orden.provider,
        environment=environment,
        external_transaction_id=referencia,
        kind="refund",
        # Ya validados: enteros, positivos y exactamente los de la orden. No
        # hay coalescencia posible porque no hay nada ausente que sustituir.
        amount_minor=amount_minor,
        currency=currency,
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

    # 5-bis. El certificado, si lo hubiera, deja de estar vigente. NO se borra:
    #    sigue en el historial, marcado como revocado y con su motivo, y la
    #    verificación pública dice que no vale. Borrarlo dejaría a quien lo
    #    compartió sin ninguna explicación de por qué desapareció.
    await _revocar_certificado_del_curso(db, user_id=orden.user_id, course_id=course_id)

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
            external_reference=referencia,
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


async def _revocar_certificado_del_curso(
    db: AsyncSession, *, user_id: str, course_id: str
) -> None:
    """Deja sin vigencia el certificado de un curso devuelto.

    Sin la 0059 aplicada no hay nada que revocar y no se rompe nada: el
    reembolso sigue su curso.
    """
    from app.modules.learning import certificados
    from app.modules.learning import esquema as esquema_aprendizaje
    from app.modules.learning.models import CourseCertificate

    if not await esquema_aprendizaje.hay_certificados(db):
        return
    fila = await db.scalar(
        select(CourseCertificate).where(
            CourseCertificate.user_id == user_id,
            CourseCertificate.course_id == course_id,
            CourseCertificate.status == "valid",
        )
    )
    if fila is None:
        return
    await certificados.revocar(
        db, fila, motivo="Devolución total confirmada.", actor_id=None
    )
