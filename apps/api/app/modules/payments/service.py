"""Puente entre las pasarelas y el dominio comercial.

## Qué hace y qué NO hace

Hace: traducir lo que dice un proveedor —RevenueCat o Stripe— a las llamadas
del comercio, y responder las preguntas que necesita la pantalla de compra
(qué producto toca en esta tienda, historial).

NO hace: crear tablas, ni definir modelos, ni decidir cómo se guarda un
derecho. Todo eso vive en `app/modules/commerce/*`, que es de otro agente y
tiene su propia lista de lo que se puede llamar desde aquí (`service.__all__`).
Este fichero **consume** ese dominio; duplicarlo sería garantizar que el día que
se corrija un fallo en un sitio el otro siga regalando cursos.

Lo único que se lee directamente de los modelos de `commerce` son consultas
—buscar el producto de una tienda por su identificador externo, reconstruir el
historial—, porque son lecturas que la pantalla de compra necesita y que la
API pública del comercio no expone. Escribir, se escribe siempre a través de
sus funciones.

## Las reglas, y dónde está cada una

1. **El importe se lee del servidor.** `commerce.crear_orden` ni siquiera
   acepta un parámetro de importe: lo busca en el curso.
2. **La idempotencia la garantiza la base.** Los índices únicos de
   `payment_transactions`, `payment_events` y `entitlements` los declara
   `commerce/models.py`; aquí no se hace «mira si existe y si no inserta».
3. **Revocar es dos cosas mientras dure el trasvase.** Quitar el derecho no
   basta: `has_course_access` todavía mira `purchases`, así que un reembolso
   tiene que cerrar también la compra heredada o la persona seguiría entrando.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.commerce import service as comercio
from app.modules.commerce.models import (
    CommerceProduct,
    Entitlement,
    Order,
    PaymentTransaction,
    ProviderProduct,
)

logger = logging.getLogger("renaser.payments")


@dataclass(frozen=True)
class ProductoComercial:
    """Un producto vendible ya resuelto: el nuestro y el de la tienda."""

    commerce_product_id: str
    course_id: str
    provider: str
    environment: str
    external_product_id: str


async def producto_para_curso(
    db: AsyncSession, *, course_id: str, provider: str, environment: str
) -> ProductoComercial | None:
    """Qué se vende para ESE curso en ESA tienda, o nada.

    «Nada» es una respuesta legítima y la interfaz tiene que saber decirla: un
    curso puede estar dado de alta en Google y todavía no en Apple. Lo que no
    puede es salir un botón de comprar que no lleve a ninguna parte.
    """
    fila = await comercio.producto_de_tienda(
        db, course_id=course_id, provider=provider, environment=environment
    )
    if fila is None:
        return None
    return ProductoComercial(
        commerce_product_id=fila.commerce_product_id,
        course_id=course_id,
        provider=fila.provider,
        environment=fila.environment,
        external_product_id=fila.external_product_id,
    )


async def producto_por_identificador(
    db: AsyncSession, *, provider: str, environment: str, external_product_id: str
) -> ProductoComercial | None:
    """El camino de vuelta: de lo que dice la tienda a lo nuestro.

    Un identificador que no esté en `provider_products` NO concede nada. Es la
    puerta que impide que una compra de otro producto —o de otra aplicación del
    mismo proyecto de RevenueCat— acabe abriendo un curso.
    """
    consulta = (
        select(
            ProviderProduct.commerce_product_id,
            CommerceProduct.course_id,
            ProviderProduct.provider,
            ProviderProduct.environment,
            ProviderProduct.external_product_id,
        )
        .join(CommerceProduct, CommerceProduct.id == ProviderProduct.commerce_product_id)
        .where(
            ProviderProduct.provider == provider,
            ProviderProduct.environment == environment,
            ProviderProduct.external_product_id == external_product_id,
            ProviderProduct.active.is_(True),
            CommerceProduct.active.is_(True),
        )
        .limit(1)
    )
    fila = (await db.execute(consulta)).first()
    if fila is None or fila[1] is None:
        return None
    return ProductoComercial(
        commerce_product_id=fila[0],
        course_id=fila[1],
        provider=fila[2],
        environment=fila[3],
        external_product_id=fila[4],
    )


async def tiene_entitlement(
    db: AsyncSession, *, user_id: str, commerce_product_id: str
) -> bool:
    encontrado = await db.scalar(
        select(Entitlement.id).where(
            Entitlement.user_id == user_id,
            Entitlement.commerce_product_id == commerce_product_id,
            Entitlement.status == "active",
        )
    )
    return encontrado is not None


@dataclass(frozen=True)
class ResultadoDeConcesion:
    course_id: str
    #: True si esta llamada creó el derecho. False si ya lo tenía (aviso
    #: repetido, restauración de algo ya concedido...). No es un error.
    nuevo: bool


async def conceder(
    db: AsyncSession,
    *,
    user_id: str,
    producto: ProductoComercial,
    external_transaction_id: str,
    canal: str,
    order_id: str | None = None,
    pagado_en: datetime | None = None,
) -> ResultadoDeConcesion:
    """Apunta la compra y concede el acceso. Repetirla no hace daño.

    En este orden a propósito: primero la transacción —que es la que lleva el
    índice único de idempotencia del dinero— y después el derecho. Al revés, un
    reintento a medias podría dejar acceso concedido sin rastro del cobro.

    **No hay parámetro de importe.** El del pedido lo puso el servidor leyendo
    el curso, y es el que se apunta. Aceptarlo aquí abriría la puerta a que
    algún día llegara desde un endpoint.
    """
    if order_id is None:
        orden = await comercio.crear_orden(
            db,
            user_id=user_id,
            commerce_product_id=producto.commerce_product_id,
            provider=producto.provider,
            channel=canal,
            environment=producto.environment,
            reutilizar_pendiente=True,
        )
        order_id = orden.id
        importe, moneda = orden.amount_minor, orden.currency
    else:
        orden = await db.get(Order, order_id)
        importe = orden.amount_minor if orden is not None else 0
        moneda = orden.currency if orden is not None else "PEN"

    transaccion, _nueva = await comercio.registrar_transaccion(
        db,
        provider=producto.provider,
        environment=producto.environment,
        external_transaction_id=external_transaction_id,
        kind="purchase",
        amount_minor=importe,
        currency=moneda,
        order_id=order_id,
    )
    await comercio.marcar_orden(db, order_id=order_id, status="paid")

    _derecho, es_nuevo = await comercio.conceder_entitlement(
        db,
        user_id=user_id,
        commerce_product_id=producto.commerce_product_id,
        source_provider=producto.provider,
        transaction_id=transaccion.id,
        # Compra ÚNICA y permanente: no caduca. La columna existe para el día
        # que haya suscripción, no para usarla hoy.
        expires_at=None,
        matricular_tambien=True,
    )
    return ResultadoDeConcesion(course_id=producto.course_id, nuevo=es_nuevo)


async def orden_pagada_de(
    db: AsyncSession, *, user_id: str, producto: ProductoComercial
) -> Order | None:
    """La compra viva de esta persona sobre este producto, o nada.

    Hace falta cuando la devolución llega por la TIENDA. Stripe avisa sobre un
    pedido concreto y quien atiende el aviso ya lo tiene en la mano; Google y
    Apple avisan sobre una transacción suya, y el pedido hay que encontrarlo.

    La más reciente en pie: quien devolvió una vez y volvió a comprar tiene dos
    pedidos, y el que se cierra es el que sigue `paid`.
    """
    return await db.scalar(
        select(Order)
        .where(
            Order.user_id == user_id,
            Order.commerce_product_id == producto.commerce_product_id,
            Order.status == "paid",
        )
        .order_by(Order.created_at.desc())
        .limit(1)
    )


async def marcar_pedido_devuelto(db: AsyncSession, *, order_id: str) -> None:
    """Cierra el pedido y suelta el saldo que hubiera retenido por esa venta.

    Las dos cosas juntas porque son la misma consecuencia: la venta se deshizo.
    Es lo que el camino de Stripe ya hacía por su cuenta, y lo que al de la
    tienda le faltaba.

    `liquidacion.cancelar` es idempotente y no hace nada si no hay saldo —hoy
    las compras por tienda no generan ninguno—; se llama igual para que el día
    que lo generen esto no haya que recordarlo.
    """
    from app.modules.commerce import liquidacion

    await comercio.marcar_orden(db, order_id=order_id, status="refunded")
    await liquidacion.cancelar(db, order_id=order_id)


async def revocar(
    db: AsyncSession,
    *,
    user_id: str,
    producto: ProductoComercial,
    external_transaction_id: str | None = None,
    amount_minor: int = 0,
    currency: str = "PEN",
    motivo: str = "refund",
) -> bool:
    """Quita el acceso tras una devolución confirmada.

    Son DOS cosas, no una, y saltarse la segunda deja el reembolso a medias:
    mientras dure el trasvase de la 0036, `has_course_access` sigue mirando
    `purchases`, así que quien tuviera allí una fila en 'paid' seguiría
    entrando aunque su derecho estuviera revocado.

    La MATRÍCULA no se toca. Quitarla perdería el progreso de la persona, y una
    devolución no es motivo para destruir información suya: lo que decide el
    acceso es el derecho, y ese es el que se revoca.
    """
    if external_transaction_id:
        await comercio.registrar_transaccion(
            db,
            provider=producto.provider,
            environment=producto.environment,
            external_transaction_id=external_transaction_id,
            kind="refund",
            amount_minor=amount_minor,
            currency=currency,
            order_id=None,
        )

    quitado = await comercio.revocar_entitlement(
        db, user_id=user_id, commerce_product_id=producto.commerce_product_id
    )
    heredadas = await comercio.revocar_compra_heredada(
        db, user_id=user_id, course_id=producto.course_id, nuevo_estado="refunded"
    )
    if quitado or heredadas:
        logger.info(
            "[pagos] acceso revocado (%s) usuario=%s curso=%s",
            motivo,
            user_id,
            producto.course_id,
        )
    return bool(quitado or heredadas)


async def crear_pedido_pendiente(
    db: AsyncSession, *, user_id: str, producto: ProductoComercial, canal: str
) -> Order:
    """Un pedido `pending` para el checkout de Stripe.

    Reutiliza el pendiente que ya hubiera en vez de acumular filas muertas cada
    vez que alguien abre el checkout y se lo piensa. El importe lo pone el
    comercio leyendo el curso; aquí no se le pasa ninguno.
    """
    return await comercio.crear_orden(
        db,
        user_id=user_id,
        commerce_product_id=producto.commerce_product_id,
        provider=producto.provider,
        channel=canal,
        environment=producto.environment,
        reutilizar_pendiente=True,
    )


@dataclass(frozen=True)
class Pedido:
    id: str
    user_id: str
    commerce_product_id: str
    course_id: str
    provider: str
    environment: str
    status: str
    amount_minor: int
    currency: str


def _a_pedido(orden: Order, course_id: str | None) -> Pedido | None:
    if course_id is None:
        return None
    return Pedido(
        id=orden.id,
        user_id=orden.user_id,
        commerce_product_id=orden.commerce_product_id,
        course_id=course_id,
        provider=orden.provider,
        environment=orden.environment,
        status=orden.status,
        amount_minor=orden.amount_minor,
        currency=orden.currency,
    )


async def pedido_por_id(db: AsyncSession, order_id: str) -> Pedido | None:
    orden = await db.get(Order, order_id)
    if orden is None:
        return None
    curso = await db.scalar(
        select(CommerceProduct.course_id).where(
            CommerceProduct.id == orden.commerce_product_id
        )
    )
    return _a_pedido(orden, curso)


async def pedido_por_transaccion(
    db: AsyncSession, *, provider: str, environment: str, external_transaction_id: str
) -> Pedido | None:
    """El pedido al que pertenece una transacción ya apuntada.

    Es el camino de vuelta de una devolución: el aviso de Stripe trae el
    `payment_intent`, no nuestro pedido, y la metadata del cobro puede no haber
    llegado hasta el objeto que manda ese evento concreto. Buscarlo por la
    transacción que ya guardamos no depende de eso.
    """
    order_id = await db.scalar(
        select(PaymentTransaction.order_id).where(
            PaymentTransaction.provider == provider,
            PaymentTransaction.environment == environment,
            PaymentTransaction.external_transaction_id == external_transaction_id,
            PaymentTransaction.kind == "purchase",
        )
    )
    if order_id is None:
        return None
    return await pedido_por_id(db, order_id)


async def producto_de_pedido(db: AsyncSession, pedido: Pedido) -> ProductoComercial:
    """El producto de un pedido, para poder conceder o revocar sobre él."""
    return ProductoComercial(
        commerce_product_id=pedido.commerce_product_id,
        course_id=pedido.course_id,
        provider=pedido.provider,
        environment=pedido.environment,
        external_product_id="",
    )


async def historial(db: AsyncSession, user_id: str) -> list[dict]:
    """Las compras de una persona, reconstruidas desde el servidor.

    Nunca desde el almacenamiento local del teléfono: allí no hay forma de
    saber si algo se devolvió, y quien reinstale se quedaría sin historial.

    El estado del derecho va aparte del estado del pedido a propósito, porque
    no siempre coinciden: un pedido devuelto sigue existiendo, con su fecha, y
    lo que cambia es que el acceso ya no está.
    """
    consulta = (
        select(
            Order.id,
            CommerceProduct.course_id,
            Order.status,
            Order.amount_minor,
            Order.currency,
            Order.provider,
            Order.channel,
            Order.created_at,
            Order.paid_at,
            Entitlement.status,
        )
        .join(CommerceProduct, CommerceProduct.id == Order.commerce_product_id)
        .outerjoin(
            Entitlement,
            (Entitlement.user_id == Order.user_id)
            & (Entitlement.commerce_product_id == Order.commerce_product_id)
            & (Entitlement.status == "active"),
        )
        .where(Order.user_id == user_id)
        .order_by(Order.created_at.desc())
    )
    filas = (await db.execute(consulta)).all()
    return [
        {
            "id": f[0],
            "course_id": f[1],
            "status": f[2],
            "amount_minor": f[3],
            "currency": f[4],
            "provider": f[5],
            "channel": f[6],
            "purchased_at": f[8] or f[7],
            "has_access": f[9] == "active",
        }
        for f in filas
        if f[1] is not None
    ]
