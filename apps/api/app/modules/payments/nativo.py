"""Reconciliacion de las compras de las tiendas (Google Play / App Store).

Esto es lo que pasa cuando la aplicacion movil dice «he comprado» o «restaura
mis compras»: NO se cree nada de lo que manda. Se le pregunta a RevenueCat, con
la clave secreta y desde el servidor, que compras tiene ese `appUserID`, y se
deja la base de datos igual a esa respuesta.

## Por que la peticion del movil es solo un disparador

Porque cualquiera puede escribirla. El cuerpo de `POST /payments/native/sync`
no lleva precio, ni producto, ni estado, ni entitlement: la identidad sale del
JWT y todo lo demas sale de RevenueCat. Aunque alguien mande la peticion cien
veces con lo que quiera, lo unico que consigue es que preguntemos de nuevo.

## Las devoluciones, sin webhook

RevenueCat conserva la compra devuelta con `status: "refunded"`. Es decir: el
reembolso es un dato que se puede CONSULTAR, no solo un aviso que hay que
esperar. Por eso revocar funciona aunque nunca lleguemos a configurar webhooks,
que es justo el requisito.

Se ha descartado a proposito la otra heuristica posible —«si una compra que yo
tenia apuntada ya no aparece en la respuesta, revoco»—. Es mas amplia, pero
convierte cualquier respuesta incompleta o un 404 pasajero en una retirada de
acceso a gente que pago. Un fallo del proveedor no puede costarle el curso a
nadie: ante la duda, no se toca nada.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.payments import service
from app.modules.payments.revenuecat import CompraDeTienda, RevenueCatClient

logger = logging.getLogger("renaser.payments")

#: Proveedores que llegan por esta via. Stripe NO esta, y es la razon de que
#: exista la lista: una compra de Stripe jamas se concede ni se revoca desde
#: aqui, igual que una de tienda jamas se toca desde el webhook de Stripe.
PROVEEDORES_NATIVOS = frozenset({"google", "apple", "revenuecat_test"})


@dataclass
class ResultadoDeSincronizacion:
    """Que ha cambiado. Sirve para responder y para el registro."""

    concedidos: list[str] = field(default_factory=list)
    revocados: list[str] = field(default_factory=list)
    #: Cursos a los que la persona ya tenia acceso y siguen igual.
    sin_cambios: list[str] = field(default_factory=list)
    #: Identificadores de tienda que no estan en `provider_products`. No
    #: conceden nada; se devuelven para poder detectar un producto mal dado de
    #: alta sin tener que entrar a los registros del servidor.
    desconocidos: list[str] = field(default_factory=list)


async def sincronizar(
    db: AsyncSession,
    *,
    user_id: str,
    cliente: RevenueCatClient,
    entorno: str,
    canal_declarado: str | None = None,
) -> ResultadoDeSincronizacion:
    """Deja `entitlements` igual a lo que RevenueCat dice que se compro.

    `user_id` es el UUID de Supabase, que es tambien el `appUserID` con el que
    el movil configura el SDK. Nunca el correo: un correo cambia, y si el
    identificador cambia se pierden las compras.
    """
    compras = await cliente.compras(user_id, canal_declarado=canal_declarado)
    resultado = ResultadoDeSincronizacion()

    for compra in compras:
        if compra.environment != entorno:
            # Una compra de pruebas no abre nada en produccion, y al reves
            # tampoco. La comprobacion es explicita aunque la busqueda de
            # producto ya filtre por entorno: que la regla se lea, y no se
            # deduzca de un WHERE tres funciones mas abajo.
            continue
        await _aplicar(db, user_id=user_id, compra=compra, resultado=resultado)

    await db.commit()
    return resultado


async def _resolver_aceptacion_de_recompra(
    db,
    *,
    user_id: str,
    course_id: str,
    proveedor: str,
    producto_externo: str | None,
) -> None:
    """Ata la aceptación de recompra a la compra de tienda, o deja constancia.

    LO QUE **NO** HACE, Y ES LA DECISIÓN ENTERA: no rechaza. Cuando esto corre,
    la compra en la tienda YA OCURRIÓ y el dinero YA SE MOVIÓ —Google y Apple
    cobran antes de que nosotros nos enteremos—, así que negar el acceso aquí
    sería cobrar y no entregar. La aceptación se pide ANTES, en la aplicación,
    contra `POST /payments/repurchase-acceptance`; aquí solo se cierra el
    círculo.

    TRES CAMINOS:

      1. La garantía de esta persona en este curso no está usada: no hace falta
         ninguna aceptación y no se toca nada. Es el caso normal.
      2. Está usada y hay aceptación suelta: se ata a la orden que acaba de
         nacer, y con eso se puede responder «qué aceptó exactamente quien hizo
         ESTA compra».
      3. Está usada y NO hay aceptación: se concede igual —ver arriba— y se
         escribe una nota de auditoría. Es lo único que convierte «la casilla
         del cliente se saltó» en algo que alguien puede ver y revisar, en vez
         de en nada.

    NUNCA REVIENTA LA SINCRONIZACIÓN. Un fallo aquí no puede tumbar la
    concesión de un acceso que ya está pagado.
    """
    from app.modules.refunds import esquema as esquema_devoluciones

    try:
        if not await esquema_devoluciones.hay_devoluciones(db):
            return

        from app.modules.refunds import service as devoluciones

        if await devoluciones.ya_devolvio(db, user_id=user_id, course_id=course_id) is None:
            return  # Camino 1: no hay garantía gastada, no hay nada que aceptar.

        if await devoluciones.tiene_aceptacion(db, user_id=user_id, course_id=course_id):
            orden = await _ultima_orden_pagada(db, user_id=user_id, course_id=course_id)
            if orden is not None:
                await devoluciones.enlazar_aceptacion(
                    db, user_id=user_id, course_id=course_id, order_id=orden
                )
            return  # Camino 2.

        # Camino 3: se concedió sin aceptación. Se deja escrito.
        from app.modules.gobernanza import auditoria

        await auditoria.anotar(
            db,
            actor_id=user_id,
            action="repurchase.sin_aceptacion",
            entity_type="course",
            entity_id=course_id,
            # "ok" PORQUE LA OPERACION SE HIZO: el acceso se concedio de verdad.
            # Lo que falto es la aceptacion previa, y eso lo cuentan "action" y
            # "reason". Marcarlo "denied" diria que no se concedio, que es
            # justamente lo contrario de lo que paso.
            outcome="ok",
            reason="compra de tienda sobre una garantia ya usada, sin aceptacion previa",
            payload={"provider": proveedor, "store_product": producto_externo},
        )
    except Exception:  # noqa: BLE001
        logger.warning(
            "[pagos] no se pudo resolver la aceptacion de recompra de %s",
            course_id,
            exc_info=True,
        )


async def _ultima_orden_pagada(db, *, user_id: str, course_id: str) -> str | None:
    """La orden pagada más reciente de esta persona para este curso."""
    from sqlalchemy import select

    from app.modules.commerce.models import CommerceProduct, Order

    return await db.scalar(
        select(Order.id)
        .join(CommerceProduct, CommerceProduct.id == Order.commerce_product_id)
        .where(
            Order.user_id == user_id,
            CommerceProduct.course_id == course_id,
            Order.status == "paid",
        )
        .order_by(Order.created_at.desc())
        .limit(1)
    )


async def _aplicar(
    db: AsyncSession,
    *,
    user_id: str,
    compra: CompraDeTienda,
    resultado: ResultadoDeSincronizacion,
) -> None:
    producto = await service.producto_por_identificador(
        db,
        provider=compra.provider,
        environment=compra.environment,
        external_product_id=compra.store_product_id,
    )
    if producto is None:
        # Producto que no vendemos nosotros. No concede. Puede ser de otra app
        # del mismo proyecto de RevenueCat, o uno dado de alta en la tienda y
        # olvidado en `provider_products`.
        logger.warning(
            "[pagos] compra de un producto desconocido: %s (%s/%s)",
            compra.store_product_id,
            compra.provider,
            compra.environment,
        )
        if compra.store_product_id not in resultado.desconocidos:
            resultado.desconocidos.append(compra.store_product_id)
        return

    if compra.devuelta:
        # EL PEDIDO, ANTES DE REVOCAR. Una compra por tienda tambien abre su
        # `orders` y la deja en 'paid'; sin cerrarla, la devolucion quedaba a
        # medias: el acceso desaparecia pero el historial seguia diciendo
        # «pagado», porque la pantalla etiqueta cada linea con el estado del
        # PEDIDO. La misma compra devuelta por Stripe si aparecia como devuelta,
        # asi que el mismo hecho se contaba de dos maneras segun la tienda.
        pedido = await service.orden_pagada_de(db, user_id=user_id, producto=producto)
        quitado = await service.revocar(
            db,
            user_id=user_id,
            producto=producto,
            # La devolucion es OTRA transaccion, no un `update` de la compra:
            # machacar la fila borraria que la compra existio, y hace falta
            # para cuadrar cuentas y para saber por que se revoco un acceso.
            external_transaction_id=f"{compra.external_transaction_id}:refund",
            # EL IMPORTE DEL PEDIDO, no cero. RevenueCat no nos dice cuanto
            # cobro la tienda —el precio es local y lo fija Google o Apple—,
            # pero apuntar el reembolso a cero convertia la contabilidad en una
            # lista de devoluciones sin importe. El del pedido es el que el
            # servidor congelo al crearlo, y es el unico que conocemos.
            amount_minor=pedido.amount_minor if pedido else 0,
            currency=pedido.currency if pedido else "PEN",
            motivo="devolucion confirmada por RevenueCat",
        )
        if pedido is not None:
            await service.marcar_pedido_devuelto(db, order_id=pedido.id)
        if quitado and producto.course_id not in resultado.revocados:
            resultado.revocados.append(producto.course_id)
        return

    if not compra.concede:
        # Compartida en familia. Ni concede ni revoca: se deja constancia.
        logger.info(
            "[pagos] compra con ownership=%s, no concede: %s",
            compra.ownership,
            compra.store_product_id,
        )
        return

    concesion = await service.conceder(
        db,
        user_id=user_id,
        producto=producto,
        external_transaction_id=compra.external_transaction_id,
        # El importe NO se pasa: lo pone el comercio leyendo el curso. En
        # tienda el cobro va en la moneda local y con el precio localizado que
        # fija Google o Apple, que nosotros no vemos ni decidimos; `price_minor`
        # queda como referencia de catalogo, que es lo que dice el contrato.
        canal=compra.canal or "android",
        pagado_en=compra.purchased_at,
    )
    destino = resultado.concedidos if concesion.nuevo else resultado.sin_cambios
    if concesion.course_id not in destino:
        destino.append(concesion.course_id)

    if concesion.nuevo:
        await _resolver_aceptacion_de_recompra(
            db,
            user_id=user_id,
            course_id=concesion.course_id,
            proveedor=compra.canal or "android",
            producto_externo=compra.store_product_id,
        )
