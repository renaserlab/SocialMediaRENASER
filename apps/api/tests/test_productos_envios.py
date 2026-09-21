"""Incremento 6 de Productos: preparacion, despacho y entrega. La 0079.

CONTRA POSTGRESQL DE VERDAD, y no es un detalle. SQLite no bloquea filas: una
prueba de doble despacho alli pasaria con el cerrojo puesto y tambien sin el, y
lo que hay que demostrar es exactamente que dos despachos a la vez no sacan del
almacen el doble de unidades.

LO QUE DEFIENDEN ESTAS PRUEBAS, Y POR QUE CADA UNA:

  1. LA RESERVA DE UN PEDIDO PAGADO SE CONSUME UNA SOLA VEZ, Y AL SALIR. No al
     cobrar —las unidades siguen en la caja— y no dos veces.
  2. DOS DESPACHOS SIMULTANEOS NO DESCUENTAN DOS VECES. Con el orden fijado a
     mano con una barrera: un `sleep` convierte la prueba en una apuesta sobre
     lo rapida que sea la maquina, y una apuesta que sale bien no prueba nada.
  3. UN PEDIDO QUE NO SE PAGO NO SE DESPACHA.
  4. UN PROVEEDOR NO LLEGA AL PEDIDO DE OTRO, y recibe 404, no 403.
  5. MODERACION NO DESPACHA NI MUEVE INVENTARIO.
  6. QUIEN COMPRA SOLO VE SU PEDIDO.
  7. EL HISTORIAL NO SE REESCRIBE. Lo impone un disparador, no una costumbre.
  8. UN PAQUETE SALE ENTERO O NO SALE.
  9. ADMINISTRACION NO FABRICA UNA ENTREGA NI DESPACHA.
 10. CANCELAR UN PEDIDO PAGADO SE PARA POR FALTA DE POLITICA, y no en silencio.
 11. UNA ENTREGA FALLIDA NO REPONE NADA.
 12. NI EL HISTORIAL NI LA AUDITORIA GUARDAN DATOS PERSONALES.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.exceptions import AppError
from app.modules.products import envios, esquema, estados_de_envio, inventory, pagos
from app.modules.products import pedidos
from app.modules.products.models import (
    PEDIDO_PAGADO,
    PEDIDO_PENDIENTE,
    SALIDA,
    InventoryMovement,
    ProductOrder,
    ProductShipment,
    ProductShipmentEvent,
)
from tests.test_productos_carrito import con_existencias, variantes_de
from tests.test_productos_catalogo import publicado
from tests.test_productos_dominio import (  # noqa: F401
    SIN_POSTGRES,
    URL,
    base_aplicada,
    persona,
    sesiones,
    vendedor,
)
from tests.test_productos_pedidos import (  # noqa: F401
    AvisoDeMentira,
    PasarelaDeMentira,
    bolsa_con,
    crear_pedido,
    motor,
    politica_publicada,
    venta_encendida,
)


# =========================================================================== #
# Montaje
# =========================================================================== #
async def pedido_pagado(sesiones, monkeypatch, *, unidades=5, en_la_bolsa=2):
    """Un pedido COBRADO de verdad, por el mismo camino que en produccion.

    No se escribe `PAID` a mano: se abre el cobro y se atiende un aviso ya
    verificado, que es la unica forma que tiene el sistema de marcar un pedido
    como pagado. Falsearlo aqui probaria un estado que nunca se alcanza asi.
    """
    producto_id, variantes, comprador, seller_id = await bolsa_con(
        sesiones, unidades=unidades, en_la_bolsa=en_la_bolsa
    )
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    monkeypatch.setattr(pagos, "get_provider", lambda _n: PasarelaDeMentira())
    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
        await pagos.iniciar_pago(db, orden=orden, correo="x@y.test")
    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
        await pagos.atender_aviso(
            db,
            AvisoDeMentira(
                purchase_id=orden.id, amount_minor=int(orden.total_minor)
            ),
        )
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
        assert orden.status == PEDIDO_PAGADO, "el montaje tiene que dejarlo pagado"
    return producto_id, variantes, comprador, creado.orden.id


async def dos_pedidos_pagados_del_mismo_sku(sesiones, monkeypatch):
    """Dos compras distintas de la MISMA unidad de almacen.

    Hace falta para una cosa muy concreta: dejar reserva viva de OTRO pedido
    cuando se intenta despachar el primero dos veces. Sin eso, el segundo
    intento tropieza antes con la aritmetica del inventario —no queda nada
    comprometido— y la clave de idempotencia nunca llega a usarse.
    """
    from app.modules.products.models import ProductSeller

    producto_id, version_id, _ = await publicado(sesiones)
    variantes = await variantes_de(sesiones, version_id)
    sku = variantes[0].sku
    await con_existencias(sesiones, producto_id, sku, 8)
    politica_id = await politica_publicada(sesiones)
    monkeypatch.setattr(pagos, "get_provider", lambda _n: PasarelaDeMentira())

    ordenes = []
    for etiqueta in ("compraA", "compraB"):
        comprador = await persona(sesiones, etiqueta)
        async with sesiones() as db:
            from app.modules.products import carts

            await carts.anadir(
                db,
                usuario_id=comprador,
                producto_id=producto_id,
                variante_id=variantes[0].id,
                cantidad=2,
            )
            await db.commit()
        async with sesiones() as db:
            bolsa = await carts.leer(db, usuario_id=comprador)
            seller_id = bolsa.items[0].seller_id
        creado = await crear_pedido(
            sesiones,
            comprador=comprador,
            seller_id=seller_id,
            politica_id=politica_id,
        )
        async with sesiones() as db:
            orden = await db.get(ProductOrder, creado.orden.id)
            await pagos.iniciar_pago(db, orden=orden, correo="x@y.test")
        async with sesiones() as db:
            orden = await db.get(ProductOrder, creado.orden.id)
            await pagos.atender_aviso(
                db,
                AvisoDeMentira(
                    purchase_id=orden.id, amount_minor=int(orden.total_minor)
                ),
            )
            await db.commit()
        ordenes.append(creado.orden.id)

    async with sesiones() as db:
        orden = await db.get(ProductOrder, ordenes[0])
        duenno = (await db.get(ProductSeller, orden.seller_id)).profile_id
    return producto_id, sku, ordenes, duenno


async def duenno_de(sesiones, orden_id: str) -> str:
    """El perfil que responde de ese pedido. Es quien prepara el paquete."""
    from app.modules.products.models import ProductSeller

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        vendedor_fila = await db.get(ProductSeller, orden.seller_id)
        return vendedor_fila.profile_id


async def preparar_entero(sesiones, orden_id: str, actor: str) -> None:
    """Mete en la caja todo lo que se compro y cierra el paquete."""
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        lineas = await pedidos.lineas_de(db, orden_id)
        await envios.anotar_preparado(
            db,
            orden=orden,
            cantidades={l.id: int(l.quantity) for l in lineas},
            actor_id=actor,
        )
        await envios.marcar_listo(db, orden=orden, actor_id=actor)
        await db.commit()


# =========================================================================== #
# 0. La maquina de estados, sola. SIN BASE DE DATOS
# =========================================================================== #
def test_la_maquina_no_deja_volver_de_despachado() -> None:
    """DESPACHAR SACA UNIDADES DEL ALMACEN, y eso no se deshace.

    Deshacerlo significaria devolver al comun unas unidades que estan dentro de
    una caja camino de otra ciudad.
    """
    for hacia in (
        estados_de_envio.PENDIENTE,
        estados_de_envio.PREPARANDO,
        estados_de_envio.LISTO,
        estados_de_envio.CANCELADO,
    ):
        assert not estados_de_envio.existe(estados_de_envio.DESPACHADO, hacia), hacia
        assert not estados_de_envio.existe(estados_de_envio.ENTREGADO, hacia), hacia


def test_administracion_no_puede_escribir_entregado() -> None:
    """NADIE FABRICA UNA ENTREGA. Administracion no tiene como saberlo.

    Puede registrar que la entrega FALLO —eso se lo cuenta el transportista— y
    puede reabrir un paquete antes de que salga. Escribir «llego» no.
    """
    desde_donde = (estados_de_envio.DESPACHADO, estados_de_envio.ENTREGA_FALLIDA)
    for desde in desde_donde:
        quienes = estados_de_envio.quienes(desde, estados_de_envio.ENTREGADO)
        assert estados_de_envio.ADMINISTRACION not in quienes, desde
        assert estados_de_envio.PROVEEDOR in quienes
    assert estados_de_envio.COMPRADOR in estados_de_envio.quienes(
        estados_de_envio.DESPACHADO, estados_de_envio.ENTREGADO
    )


def test_solo_el_proveedor_despacha() -> None:
    """ES EL UNICO QUE PUEDE AFIRMAR QUE LA CAJA SALIO DE SU ALMACEN."""
    quienes = estados_de_envio.quienes(
        estados_de_envio.LISTO, estados_de_envio.DESPACHADO
    )
    assert quienes == frozenset({estados_de_envio.PROVEEDOR})


def test_los_saltos_que_deshacen_o_dan_mala_noticia_exigen_motivo() -> None:
    """SIN EL PORQUE, EL HISTORIAL NO SIRVE PARA NADA."""
    with pytest.raises(estados_de_envio.MotivoNecesario):
        estados_de_envio.exigir(
            estados_de_envio.DESPACHADO,
            estados_de_envio.ENTREGA_FALLIDA,
            estados_de_envio.PROVEEDOR,
        )
    #: Y UN MOTIVO DE DOS LETRAS NO ES UN MOTIVO.
    with pytest.raises(estados_de_envio.MotivoNecesario):
        estados_de_envio.exigir(
            estados_de_envio.LISTO,
            estados_de_envio.PREPARANDO,
            estados_de_envio.PROVEEDOR,
            "ok",
        )
    assert (
        estados_de_envio.exigir(
            estados_de_envio.LISTO,
            estados_de_envio.PREPARANDO,
            estados_de_envio.PROVEEDOR,
            "  se rompio el precinto  ",
        )
        == "se rompio el precinto"
    )


def test_un_salto_que_no_existe_no_se_confunde_con_uno_prohibido() -> None:
    """DOS PREGUNTAS DISTINTAS: si el salto existe, y si es de quien lo pide.

    Confundirlas hace que un error de programacion se lea como un permiso que
    falta, y que alguien pierda una tarde buscando el permiso.
    """
    with pytest.raises(estados_de_envio.SaltoInexistente):
        estados_de_envio.exigir(
            estados_de_envio.PENDIENTE,
            estados_de_envio.DESPACHADO,
            estados_de_envio.PROVEEDOR,
        )
    with pytest.raises(estados_de_envio.SaltoNoPermitido):
        estados_de_envio.exigir(
            estados_de_envio.LISTO,
            estados_de_envio.DESPACHADO,
            estados_de_envio.ADMINISTRACION,
        )


def test_solo_despachar_consume_y_solo_cancelar_suelta() -> None:
    """NINGUN OTRO SALTO TOCA EL ALMACEN.

    Si alguien anade uno que si lo toque sin decirlo aqui, esta prueba se
    entera: la lista es la fuente, no un comentario.
    """
    assert estados_de_envio.CONSUME_INVENTARIO == frozenset(
        {(estados_de_envio.LISTO, estados_de_envio.DESPACHADO)}
    )
    for desde, hasta in estados_de_envio.LIBERA_INVENTARIO:
        assert hasta == estados_de_envio.CANCELADO
        assert desde in estados_de_envio.ANTES_DE_SALIR
    #: Y NINGUN SALTO HACE LAS DOS COSAS.
    assert not (
        estados_de_envio.CONSUME_INVENTARIO & estados_de_envio.LIBERA_INVENTARIO
    )


# =========================================================================== #
# 1. La reserva se consume al despachar, y una sola vez
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_pagar_no_saca_nada_del_almacen(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """COBRAR NO ES DESPACHAR. Las unidades siguen comprometidas en la caja.

    Sacarlas al cobrar diria que algo salio cuando sigue en el almacen, y
    dejaria el inventario mintiendo durante todo el tiempo que tarde en
    prepararse el paquete.
    """
    producto_id, variantes, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        envio = await db.get(ProductShipment, orden_id)
    assert hay.on_hand == 5, "nada ha salido todavia"
    assert hay.reserved == 2, "las dos siguen comprometidas"
    assert hay.available == 3
    #: Y NO HAY FILA DE ENVIO TODAVIA: nadie lo ha tocado.
    assert envio is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_fila_el_envio_se_lee_como_pendiente_de_preparacion(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """`exists = False` NO ES UN HUECO: es «nadie lo ha tocado».

    Crear una fila por cada pedido que se cobra seria una escritura mas en el
    camino del cobro para no ganar nada.
    """
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        envio = await envios.del_pedido(db, orden=orden)
    assert envio is not None
    assert envio.existe is False
    assert envio.status == estados_de_envio.PENDIENTE
    #: Y YA TRAE LAS LINEAS, con cero preparado. Cero es «todavia ninguna».
    assert len(envio.items) == 1
    assert envio.items[0].ordered_quantity == 2
    assert envio.items[0].prepared_quantity == 0
    assert envio.items[0].completa is False


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_despachar_consume_la_reserva_exactamente_una_vez(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """LA REGLA CENTRAL DEL INCREMENTO.

    Al salir, bajan las DOS cuentas: lo que hay y lo comprometido. Y repetir la
    llamada no vuelve a bajarlas.
    """
    producto_id, variantes, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)
    await preparar_entero(sesiones, orden_id, quien)

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        envio = await envios.despachar(
            db, orden=orden, actor_id=quien, carrier_name="Transporte de prueba"
        )
        await db.commit()
    assert envio.status == estados_de_envio.DESPACHADO

    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert hay.on_hand == 3, "salieron las dos"
    assert hay.reserved == 0, "ya no hay nada comprometido"
    assert hay.available == 3

    #: REPETIR LA LLAMADA NO VUELVE A DESPACHAR. Un POST que se perdio por el
    #: camino y se reintenta no es un despacho nuevo.
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        otra = await envios.despachar(db, orden=orden, actor_id=quien)
        await db.commit()
    assert otra.status == estados_de_envio.DESPACHADO
    assert otra.carrier_name == "Transporte de prueba", "no se pisa lo que ya estaba"

    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        salidas = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(
                InventoryMovement.product_id == producto_id,
                InventoryMovement.kind == SALIDA,
            )
        )
        renglones = await db.scalar(
            select(func.count())
            .select_from(ProductShipmentEvent)
            .where(
                ProductShipmentEvent.shipment_order_id == orden_id,
                ProductShipmentEvent.to_status == estados_de_envio.DESPACHADO,
            )
        )
    assert hay.on_hand == 3, "el reintento no volvio a sacar nada"
    assert hay.reserved == 0
    assert salidas == 1, "UN solo movimiento de salida"
    assert renglones == 1, "y UN solo renglon en el historial"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_capa_de_abajo_aguanta_aunque_se_cuelen_por_la_de_arriba(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """LA SEGUNDA CAPA, PROBADA DONDE DE VERDAD SE USA.

    Arriba, lo que para un segundo despacho es la maquina de estados bajo el
    cerrojo de la fila: el segundo llega, ve que el envio ya salio y no hace
    nada. Esa capa se prueba en la de concurrencia.

    ABAJO HAY OTRA, y por el camino normal NO SE EJERCITA NUNCA: la clave de
    idempotencia del movimiento, que es un indice unico de la base. Esta
    prueba baja a proposito hasta `_consumir_la_reserva` y lo llama DOS VECES
    con la marca de «ya se decidio» limpiada en medio, que es exactamente el
    estado en el que quedarian dos procesos que se colaran a la vez por
    arriba.

    SIN ESTA PRUEBA, la capa de abajo seria codigo que nadie comprueba: se
    podria hacer la clave aleatoria y toda la suite seguiria en verde. Se
    comprobo quitandola.
    """
    producto_id, variantes, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)
    await preparar_entero(sesiones, orden_id, quien)

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        envio = await db.get(ProductShipment, orden_id)
        #: SE QUEDA EN `READY` A PROPOSITO. El CHECK de la base no deja que un
        #: envio `DISPATCHED` tenga la marca vacia —y esta bien que no deje—,
        #: asi que la simulacion se hace justo antes del salto, que es donde
        #: estarian los dos procesos.
        envio.dispatched_at = envios.ahora()
        await envios._consumir_la_reserva(
            db, orden=orden, envio=envio, momento=envios.ahora()
        )
        assert envio.dispatch_settled_at is not None, "la primera si consume"

        #: Y AHORA EL SEGUNDO PROCESO, que no vio la marca del primero.
        #:
        #: LA CAPA DE ABAJO NO SE TRAGA EL INTENTO: LO RECHAZA. `inventory.mover`
        #: hace las cuentas antes de mirar la clave, y con la reserva ya
        #: consumida no queda nada comprometido que sacar. Rechazar en voz alta
        #: es mejor que contestar «hecho» sobre un almacen que no se movio:
        #: llegar aqui significa que algo se colo por arriba, y eso hay que
        #: verlo. Lo unico que NO puede pasar —y es lo que se comprueba abajo—
        #: es que el almacen baje dos veces.
        envio.dispatch_settled_at = None
        with pytest.raises(inventory.NoAlcanza):
            await envios._consumir_la_reserva(
                db, orden=orden, envio=envio, momento=envios.ahora()
            )
        envio.dispatch_settled_at = envios.ahora()
        await db.commit()

    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        salidas = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(
                InventoryMovement.product_id == producto_id,
                InventoryMovement.kind == SALIDA,
            )
        )
    assert hay.on_hand == 3, f"el almacen bajo dos veces: quedan {hay.on_hand}"
    assert hay.reserved == 0
    assert salidas == 1, f"hubo {salidas} movimientos de salida, tenia que haber 1"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_clave_del_movimiento_para_el_segundo_despacho(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """LA CAPA DE ABAJO, EJERCITADA DE VERDAD.

    ESTE ES EL UNICO ESCENARIO EN QUE LA CLAVE ES LA QUE PARA. Dos pedidos
    distintos apartan unidades del mismo SKU: al despachar el primero por
    segunda vez, la reserva del OTRO sigue viva, asi que la aritmetica del
    inventario no se queja —hay de sobra que descontar— y lo unico que impide
    sacar cuatro unidades donde se vendieron dos es que el identificador del
    movimiento se DERIVA del pedido y choca contra la clave primaria.

    Se comprobo haciendo la clave aleatoria: esta prueba se pone roja y el
    almacen baja dos veces. Con la reserva de un solo pedido no se enteraba,
    porque tropezaba antes con la aritmetica.
    """
    producto_id, sku, ordenes, duenno = await dos_pedidos_pagados_del_mismo_sku(
        sesiones, monkeypatch
    )
    async with sesiones() as db:
        hay = await inventory.de_la_unidad(db, product_id=producto_id, sku=sku)
    assert (hay.on_hand, hay.reserved) == (8, 4), "las dos compras apartaron"

    await preparar_entero(sesiones, ordenes[0], duenno)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, ordenes[0])
        await envios.despachar(db, orden=orden, actor_id=duenno)
        await db.commit()

    async with sesiones() as db:
        hay = await inventory.de_la_unidad(db, product_id=producto_id, sku=sku)
    assert (hay.on_hand, hay.reserved) == (6, 2), "salio solo lo del primer pedido"

    #: EL SEGUNDO PROCESO, que no vio la marca del primero. Ahora SI hay
    #: reserva que descontar —la del otro pedido— asi que la aritmetica pasa.
    async with sesiones() as db:
        orden = await db.get(ProductOrder, ordenes[0])
        envio = await db.get(ProductShipment, ordenes[0])
        await db.execute(
            text(
                "update product_shipments set status = 'READY', "
                "dispatch_settled_at = null where order_id = cast(:i as uuid)"
            ),
            {"i": ordenes[0]},
        )
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, ordenes[0])
        envio = await db.get(ProductShipment, ordenes[0])
        await envios._consumir_la_reserva(
            db, orden=orden, envio=envio, momento=envios.ahora()
        )
        await db.commit()

    async with sesiones() as db:
        hay = await inventory.de_la_unidad(db, product_id=producto_id, sku=sku)
        salidas = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(
                InventoryMovement.product_id == producto_id,
                InventoryMovement.kind == SALIDA,
            )
        )
    assert (hay.on_hand, hay.reserved) == (6, 2), (
        f"el almacen bajo dos veces: {hay.on_hand} en mano, {hay.reserved} apartadas"
    )
    assert salidas == 1, f"hubo {salidas} movimientos de salida, tenia que haber 1"
    #: Y LO DEL OTRO PEDIDO SIGUE APARTADO, intacto.
    assert hay.available == 4


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_base_no_deja_un_despacho_sin_su_marca(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """EL CHECK DE LA 0079, PROBADO CONTRA LA BASE DE VERDAD.

    Un envio `DISPATCHED` sin `dispatch_settled_at` seria un paquete que salio
    sin que nadie hubiera tocado el almacen: lo que la pantalla enseña y lo que
    hay en las cajas dejarian de cuadrar, y nada lo delataria. Lo impide la
    tabla, no el codigo, asi que sigue impidiendolo por otra via.
    """
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)
    await preparar_entero(sesiones, orden_id, quien)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.despachar(db, orden=orden, actor_id=quien)
        await db.commit()

    async with sesiones() as db:
        with pytest.raises(Exception) as fallo:
            await db.execute(
                text(
                    "update product_shipments set dispatch_settled_at = null "
                    "where order_id = cast(:i as uuid)"
                ),
                {"i": orden_id},
            )
            await db.commit()
        await db.rollback()
    assert "despachado_con_salida" in str(fallo.value)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_estado_del_pedido_no_se_entera_del_envio(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """DESPACHAR NO DESPAGA UN PEDIDO. Son dos maquinas distintas.

    Es justo lo que se perderia si el envio hubiera entrado en
    `product_orders.status`: al escribir «despachado» se habria perdido
    «pagado».
    """
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)
    await preparar_entero(sesiones, orden_id, quien)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.despachar(db, orden=orden, actor_id=quien)
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        envio = await db.get(ProductShipment, orden_id)
    assert orden.status == PEDIDO_PAGADO, "sigue pagado, y con su fecha y su cobro"
    assert orden.paid_at is not None
    assert orden.external_payment_id is not None
    assert envio.status == estados_de_envio.DESPACHADO


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_clave_del_despacho_no_choca_con_la_de_la_reserva(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """TRES CLAVES DISTINTAS PARA EL MISMO PEDIDO.

    Si el despacho reutilizara el prefijo de la reserva o el de la liberacion,
    el segundo movimiento chocaria contra la clave primaria del primero y se
    tragaria como un reintento: unidades vendidas que nunca salieron.
    """
    producto_id, variantes, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)
    await preparar_entero(sesiones, orden_id, quien)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.despachar(db, orden=orden, actor_id=quien)
        await db.commit()
    async with sesiones() as db:
        claves = list(
            await db.scalars(
                select(InventoryMovement.idempotency_key).where(
                    InventoryMovement.product_id == producto_id
                )
            )
        )
    assert len(claves) == len(set(claves)), "ninguna clave se repite"
    assert any(c.startswith(pedidos.CLAVE_DE_RESERVA) for c in claves)
    assert any(c.startswith(envios.CLAVE_DE_SALIDA) for c in claves)
    assert envios.CLAVE_DE_SALIDA != pedidos.CLAVE_DE_RESERVA
    assert envios.CLAVE_DE_DEVOLUCION_AL_COMUN != pedidos.CLAVE_DE_LIBERACION


# =========================================================================== #
# 2. Dos despachos a la vez. CONTRA POSTGRESQL, CON EL ORDEN FIJADO
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_despachos_simultaneos_no_descuentan_dos_veces(
    sesiones, motor, venta_encendida, monkeypatch
) -> None:
    """EL PEOR FALLO POSIBLE DE ESTE INCREMENTO, probado donde puede ocurrir.

    DOS SESIONES DE VERDAD Y UNA BARRERA. Las dos llegan a la vez al `select
    ... for update` de la fila del envio; una gana, consume y confirma, y la
    otra despierta, relee bajo el cerrojo y ve que ya se decidio. Con un
    `sleep` en vez de la barrera, la prueba seria una apuesta sobre lo rapida
    que sea la maquina.

    Y NO BASTA CON QUE NO REVIENTE: se cuenta el inventario y se cuentan los
    movimientos de salida. Uno, no dos.
    """
    producto_id, variantes, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)
    await preparar_entero(sesiones, orden_id, quien)

    fabrica = async_sessionmaker(motor, expire_on_commit=False)
    puerta = asyncio.Barrier(2)

    async def despachar_una() -> str:
        async with fabrica() as db:
            orden = await db.get(ProductOrder, orden_id)
            await puerta.wait()
            try:
                envio = await envios.despachar(db, orden=orden, actor_id=quien)
                await db.commit()
                return envio.status
            except AppError as fallo:  # pragma: no cover - la que pierde
                await db.rollback()
                return fallo.code

    resultados = await asyncio.gather(despachar_una(), despachar_una())

    #: LAS DOS PUEDEN CONTESTAR «despachado»: la segunda es un reintento
    #: legitimo desde fuera. Lo que NO puede pasar es que el almacen baje dos
    #: veces, y eso es lo que se cuenta.
    assert all(r == estados_de_envio.DESPACHADO for r in resultados), resultados

    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        salidas = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(
                InventoryMovement.product_id == producto_id,
                InventoryMovement.kind == SALIDA,
            )
        )
    assert hay.on_hand == 3, f"salio mas de una vez: quedan {hay.on_hand}"
    assert hay.reserved == 0
    assert hay.available == 3
    assert salidas == 1, f"hubo {salidas} movimientos de salida, tenia que haber 1"


# =========================================================================== #
# 3. Un pedido que no se pago no se despacha
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_pedido_sin_pagar_no_se_prepara_ni_se_despacha(
    sesiones, venta_encendida
) -> None:
    """SE COMPRUEBA EN CADA PASO, no solo al empezar.

    Entre preparar y despachar pasa tiempo, y el dia que alguien anada un
    camino nuevo la puerta tiene que seguir estando en el paso, no en la
    entrada del recorrido.
    """
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    quien = await duenno_de(sesiones, creado.orden.id)

    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
        assert orden.status == PEDIDO_PENDIENTE
        with pytest.raises(envios.PedidoNoPagado):
            await envios.anotar_preparado(
                db, orden=orden, cantidades={}, actor_id=quien
            )
        await db.rollback()

    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
        with pytest.raises(envios.PedidoNoPagado):
            await envios.mover(
                db,
                orden=orden,
                hasta=estados_de_envio.PREPARANDO,
                actor_id=quien,
                actor_rol=estados_de_envio.PROVEEDOR,
            )
        await db.rollback()

    #: Y NO SE QUEDA NINGUNA FILA DE ENVIO detras del intento.
    async with sesiones() as db:
        assert await db.get(ProductShipment, creado.orden.id) is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_pedido_sin_pagar_no_tiene_envio_que_ensenar(
    sesiones, venta_encendida
) -> None:
    """NULO, NO «PENDIENTE DE PREPARACION».

    Contestar «pendiente de preparacion» sobre un pedido que nadie pago haria
    creer que va a salir algo.
    """
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
        assert await envios.del_pedido(db, orden=orden) is None


# =========================================================================== #
# 4. Lo ajeno es un 404
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_proveedor_no_llega_al_pedido_de_otro(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """404 Y NO 403. Decir «existe pero no es tuyo» ya cuenta que existe, y
    aqui contaria ademas que alguien compro eso."""
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    otro = await persona(sesiones, "otroprov")
    await vendedor(sesiones, otro)

    async with sesiones() as db:
        with pytest.raises(envios.EnvioNoEncontrado) as fallo:
            await envios.pedido_del_proveedor(
                db, orden_id=orden_id, usuario_id=otro
            )
    assert fallo.value.status_code == 404
    assert fallo.value.code == "product_shipment_not_found"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_quien_no_es_proveedor_no_llega_a_ningun_pedido(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """SIN CAPACIDAD COMERCIAL NO SE PREPARA NADA. Ni el propio pedido."""
    from app.modules.products.permissions import SinCapacidadComercial

    _, _, comprador, orden_id = await pedido_pagado(sesiones, monkeypatch)
    async with sesiones() as db:
        with pytest.raises(SinCapacidadComercial):
            await envios.pedido_del_proveedor(
                db, orden_id=orden_id, usuario_id=comprador
            )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_quien_compra_solo_ve_su_pedido(
    sesiones, venta_encendida, monkeypatch
) -> None:
    _, _, comprador, orden_id = await pedido_pagado(sesiones, monkeypatch)
    ajeno = await persona(sesiones, "ajeno")
    async with sesiones() as db:
        suyo = await envios.pedido_del_comprador(
            db, orden_id=orden_id, usuario_id=comprador
        )
        assert suyo.id == orden_id
        with pytest.raises(AppError) as fallo:
            await envios.pedido_del_comprador(
                db, orden_id=orden_id, usuario_id=ajeno
            )
    assert fallo.value.status_code == 404


# =========================================================================== #
# 5. Moderacion no despacha
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_moderacion_no_puede_intervenir_un_envio(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """UN DESPACHO MUEVE INVENTARIO, Y MOVER INVENTARIO NO ES MODERAR.

    Es la misma linea que ya separa `ADMIN_ROLES` de `FINANCE_ROLES`: un
    moderador puede mirar un producto, no puede tocar el almacen.
    """
    from app.modules.profiles.models import Profile

    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    moderador = await persona(sesiones, "modera")
    administrador = await persona(sesiones, "manda")
    async with sesiones() as db:
        (await db.get(Profile, moderador)).role = "moderator"
        (await db.get(Profile, administrador)).role = "admin"
        await db.commit()

    async with sesiones() as db:
        assert await envios.puede_intervenir_envios(db, moderador) is False
        assert await envios.puede_intervenir_envios(db, administrador) is True
        with pytest.raises(AppError) as fallo:
            await envios.exigir_interventor(db, moderador)
    assert fallo.value.status_code == 403
    assert fallo.value.code == "product_shipment_intervene_forbidden"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_administracion_no_despacha_ni_fabrica_una_entrega(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """LO QUE ADMINISTRACION PUEDE HACER ES ESTRECHO, Y LO IMPONE LA MAQUINA.

    Puede reabrir y puede registrar un fallo de entrega. No puede sacar la caja
    del almacen —eso solo lo sabe quien la saca— ni escribir «llego».
    """
    producto_id, variantes, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)
    manda = await persona(sesiones, "manda2")
    await preparar_entero(sesiones, orden_id, quien)

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        with pytest.raises(estados_de_envio.SaltoNoPermitido):
            await envios.mover(
                db,
                orden=orden,
                hasta=estados_de_envio.DESPACHADO,
                actor_id=manda,
                actor_rol=estados_de_envio.ADMINISTRACION,
            )
        await db.rollback()

    #: Y EL ALMACEN NO SE ENTERO DEL INTENTO.
    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert hay.on_hand == 5
    assert hay.reserved == 2

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.despachar(db, orden=orden, actor_id=quien)
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        with pytest.raises(estados_de_envio.SaltoNoPermitido):
            await envios.mover(
                db,
                orden=orden,
                hasta=estados_de_envio.ENTREGADO,
                actor_id=manda,
                actor_rol=estados_de_envio.ADMINISTRACION,
            )
        await db.rollback()


# =========================================================================== #
# 6. Un paquete sale entero o no sale
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_cierra_un_paquete_a_medias(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """CERRARLO A MEDIAS OBLIGA A DECIDIR QUE PASA CON LO QUE SE QUEDO FUERA.

    Segundo envio, devolucion parcial, quien paga el porte: ninguna politica
    publicada lo dice, asi que lo honesto es no dejar cerrar. Y el 409 lleva en
    los detalles que linea falta y cuanto.
    """
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        lineas = await pedidos.lineas_de(db, orden_id)
        await envios.anotar_preparado(
            db, orden=orden, cantidades={lineas[0].id: 1}, actor_id=quien
        )
        await db.commit()

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        with pytest.raises(envios.PreparacionIncompleta) as fallo:
            await envios.marcar_listo(db, orden=orden, actor_id=quien)
        await db.rollback()
    assert fallo.value.status_code == 409
    faltan = fallo.value.details["missing"]
    assert len(faltan) == 1
    assert faltan[0]["ordered_quantity"] == 2
    assert faltan[0]["prepared_quantity"] == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_prepara_mas_de_lo_que_se_compro(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """METER SIETE EN LA CAJA DE UN PEDIDO DE DOS ES REGALAR CINCO.

    Y descuadra el almacen, porque lo que sale es lo que se reservo: dos.
    """
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        lineas = await pedidos.lineas_de(db, orden_id)
        with pytest.raises(envios.CantidadInvalida) as fallo:
            await envios.anotar_preparado(
                db, orden=orden, cantidades={lineas[0].id: 7}, actor_id=quien
            )
        await db.rollback()
    assert fallo.value.details["max"] == 2


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_linea_de_otro_pedido_no_se_puede_preparar(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """422 Y NO 404: la ruta existe y el pedido es suyo; lo que no cuadra es el
    cuerpo que mando."""
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        with pytest.raises(envios.LineaAjena):
            await envios.anotar_preparado(
                db,
                orden=orden,
                cantidades={str(uuid.uuid4()): 1},
                actor_id=quien,
            )
        await db.rollback()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_preparar_no_mueve_inventario(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """CONTAR LO QUE VA EN LA CAJA NO SACA NADA DEL ALMACEN."""
    producto_id, variantes, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)
    async with sesiones() as db:
        antes = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(InventoryMovement.product_id == producto_id)
        )
    await preparar_entero(sesiones, orden_id, quien)
    async with sesiones() as db:
        despues = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(InventoryMovement.product_id == producto_id)
        )
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert antes == despues, "preparar no escribio ningun movimiento"
    assert hay.on_hand == 5
    assert hay.reserved == 2


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_reabrir_un_paquete_cerrado_exige_motivo_y_deja_rastro(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """EL UNICO PASO ATRAS, Y SOLO ANTES DE QUE SALGA.

    Prohibirlo dejaria un paquete atascado en «listo» cuando se rompe algo al
    embalar, y un estado atascado se acaba resolviendo mintiendo en el
    siguiente.
    """
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)
    await preparar_entero(sesiones, orden_id, quien)

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        with pytest.raises(estados_de_envio.MotivoNecesario):
            await envios.reabrir(
                db,
                orden=orden,
                actor_id=quien,
                actor_rol=estados_de_envio.PROVEEDOR,
                motivo="",
            )
        await db.rollback()

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        envio = await envios.reabrir(
            db,
            orden=orden,
            actor_id=quien,
            actor_rol=estados_de_envio.PROVEEDOR,
            motivo="se rompio el precinto al cerrar",
        )
        await db.commit()
    assert envio.status == estados_de_envio.PREPARANDO

    async with sesiones() as db:
        renglon = (
            await db.scalars(
                select(ProductShipmentEvent)
                .where(
                    ProductShipmentEvent.shipment_order_id == orden_id,
                    ProductShipmentEvent.from_status == estados_de_envio.LISTO,
                )
                .limit(1)
            )
        ).one()
    assert renglon.reason == "se rompio el precinto al cerrar"
    assert renglon.actor_role == "seller"


# =========================================================================== #
# 7. El historial no se reescribe
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_historial_del_envio_no_se_puede_editar_ni_borrar(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """LO IMPONE UN DISPARADOR, NO UNA COSTUMBRE.

    Un historial que se puede editar no es un historial: es una version de los
    hechos.
    """
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)
    await preparar_entero(sesiones, orden_id, quien)

    async with sesiones() as db:
        fila = (
            await db.scalars(
                select(ProductShipmentEvent)
                .where(ProductShipmentEvent.shipment_order_id == orden_id)
                .limit(1)
            )
        ).one()
        renglon_id = fila.id

    for sentencia in (
        "update product_shipment_events set to_status = 'DELIVERED' where id = :i",
        "delete from product_shipment_events where id = :i",
    ):
        async with sesiones() as db:
            with pytest.raises(Exception) as fallo:
                await db.execute(text(sentencia), {"i": renglon_id})
                await db.commit()
            await db.rollback()
        assert "solo se anade" in str(fallo.value).lower(), sentencia


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_historial_no_guarda_datos_personales(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """NI NOMBRE, NI TELEFONO, NI DIRECCION.

    El historial se lee para auditar un estado, no para recomponer a quien se
    le mando que. La direccion vive congelada y en un solo sitio.
    """
    from app.modules.gobernanza.models import AuditEvent

    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)
    await preparar_entero(sesiones, orden_id, quien)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.despachar(db, orden=orden, actor_id=quien)
        await db.commit()

    async with sesiones() as db:
        direccion = await pedidos.direccion_de(db, orden_id)
        renglones = await envios.historial(db, orden_id=orden_id)
        rastro = list(
            await db.scalars(
                select(AuditEvent).where(
                    AuditEvent.entity_id == orden_id,
                    AuditEvent.action.like("product_shipment.%"),
                )
            )
        )

    prohibidos = [
        direccion.recipient_name,
        direccion.phone,
        direccion.address_line,
        direccion.city,
    ]
    texto_historial = " ".join(
        f"{r.from_status} {r.to_status} {r.reason or ''}" for r in renglones
    )
    for dato in prohibidos:
        assert dato not in texto_historial, dato

    assert rastro, "el despacho tiene que dejar rastro"
    for evento in rastro:
        contenido = str(evento.payload or {}) + str(evento.reason or "")
        for dato in prohibidos:
            assert dato not in contenido, f"{dato} en la auditoria"


# =========================================================================== #
# 8. La entrega
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_entrega_guarda_quien_la_afirma(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """SIN SABER QUIEN LO DIJO, LA DISPUTA DEL INCREMENTO 7 NO SE PUEDE TENER.

    El blueprint contempla que el transportista marque la entrega y quien
    compro la niegue; una fecha de entrega sin dueno seria imposible de
    discutir despues.
    """
    _, _, comprador, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)
    await preparar_entero(sesiones, orden_id, quien)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.despachar(db, orden=orden, actor_id=quien)
        await db.commit()

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        envio = await envios.registrar_entrega(
            db,
            orden=orden,
            actor_id=quien,
            actor_rol=estados_de_envio.PROVEEDOR,
        )
        await db.commit()
    assert envio.status == estados_de_envio.ENTREGADO
    assert envio.delivered_source == "seller"
    assert envio.buyer_confirmed_at is None

    #: Y QUIEN COMPRA PUEDE CONFIRMARLO DESPUES: es un dato que no teniamos, y
    #: no cambia quien lo afirmo primero ni vuelve a escribir en el historial.
    async with sesiones() as db:
        antes = len(await envios.historial(db, orden_id=orden_id))
        orden = await db.get(ProductOrder, orden_id)
        confirmado = await envios.registrar_entrega(
            db,
            orden=orden,
            actor_id=comprador,
            actor_rol=estados_de_envio.COMPRADOR,
        )
        await db.commit()
        despues = len(await envios.historial(db, orden_id=orden_id))
    assert confirmado.delivered_source == "seller", "no se reescribe quien lo dijo"
    assert confirmado.buyer_confirmed_at is not None
    assert antes == despues, "confirmar lo ya entregado no anade un renglon"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_confirmar_la_recepcion_no_mueve_dinero_ni_inventario(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """CONFIRMAR QUE LLEGO NO ES DAR LA CONFORMIDAD.

    Lo segundo libera dinero al proveedor en el blueprint, y no existe: no hay
    transferencias, ni comision, ni plazo aprobado. Esta prueba lo fija: el
    almacen no se mueve y el pedido sigue exactamente igual de pagado.
    """
    producto_id, variantes, comprador, orden_id = await pedido_pagado(
        sesiones, monkeypatch
    )
    quien = await duenno_de(sesiones, orden_id)
    await preparar_entero(sesiones, orden_id, quien)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.despachar(db, orden=orden, actor_id=quien)
        await db.commit()

    async with sesiones() as db:
        antes = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(InventoryMovement.product_id == producto_id)
        )
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        envio = await envios.registrar_entrega(
            db,
            orden=orden,
            actor_id=comprador,
            actor_rol=estados_de_envio.COMPRADOR,
        )
        await db.commit()
    assert envio.delivered_source == "buyer"

    async with sesiones() as db:
        despues = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(InventoryMovement.product_id == producto_id)
        )
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        orden = await db.get(ProductOrder, orden_id)
    assert antes == despues, "confirmar no escribio ningun movimiento"
    assert hay.on_hand == 3, "lo entregado NO vuelve al almacen"
    assert hay.reserved == 0
    assert orden.status == PEDIDO_PAGADO


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_entrega_fallida_no_repone_nada(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """DONDE ESTA ESA UNIDAD ES INSPECCION DE POSVENTA, NO UN AUTOMATISMO.

    Reponerla aqui la pondria a la venta estando dentro de un camion.
    """
    producto_id, variantes, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)
    await preparar_entero(sesiones, orden_id, quien)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.despachar(db, orden=orden, actor_id=quien)
        await db.commit()

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        envio = await envios.registrar_fallo(
            db,
            orden=orden,
            actor_id=quien,
            actor_rol=estados_de_envio.PROVEEDOR,
            motivo="nadie en el domicilio",
        )
        await db.commit()
    assert envio.status == estados_de_envio.ENTREGA_FALLIDA
    assert envio.failure_reason == "nadie en el domicilio"

    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert hay.on_hand == 3, "sigue fuera del almacen"
    assert hay.reserved == 0
    assert hay.available == 3

    #: Y EL TRANSPORTISTA PUEDE VOLVER A INTENTARLO, sin tocar nada.
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        otra = await envios.reintentar_entrega(
            db,
            orden=orden,
            actor_id=quien,
            actor_rol=estados_de_envio.PROVEEDOR,
            motivo="segundo intento acordado",
        )
        await db.commit()
    assert otra.status == estados_de_envio.DESPACHADO
    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        salidas = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(
                InventoryMovement.product_id == producto_id,
                InventoryMovement.kind == SALIDA,
            )
        )
    assert hay.on_hand == 3
    assert salidas == 1, "reintentar la entrega no vuelve a sacar nada"


# =========================================================================== #
# 9. Cancelar se para por falta de politica
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cancelar_un_pedido_pagado_se_para_y_dice_que_falta(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """NO EN SILENCIO, Y CON LO QUE FALTA EN LOS DETALLES.

    Cancelar lo ya cobrado obliga a devolver el dinero, y `product_policies` no
    tiene ninguna columna que diga con que plazo, en que casos ni quien paga el
    porte de vuelta. Ejecutarlo igual seria inventarse la politica.
    """
    producto_id, variantes, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    manda = await persona(sesiones, "manda3")
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        with pytest.raises(envios.CancelacionSinPolitica) as fallo:
            await envios.cancelar(
                db, orden=orden, actor_id=manda, motivo="se quedo sin stock"
            )
        await db.rollback()
    assert fallo.value.status_code == 409
    assert fallo.value.code == "product_shipment_cancellation_not_configured"
    assert "refund_policy" in fallo.value.details["pending"]

    #: Y NO SE SOLTO NI UNA UNIDAD.
    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert hay.reserved == 2, "la reserva sigue donde estaba"
    assert hay.available == 3


def test_el_salto_de_cancelar_existe_y_es_solo_de_administracion() -> None:
    """LA ESTRUCTURA ESTA; LO QUE FALTA ES LA DECISION.

    El dia que la empresa publique su politica de cancelacion, lo que hay que
    quitar es la puerta del servicio: la maquina ya dice quien podria darlo.
    """
    for desde in estados_de_envio.ANTES_DE_SALIR:
        quienes = estados_de_envio.quienes(desde, estados_de_envio.CANCELADO)
        assert quienes == frozenset({estados_de_envio.ADMINISTRACION}), desde
    #: Y DESPUES DE SALIR NO SE CANCELA NUNCA.
    for desde in estados_de_envio.DESPUES_DE_SALIR:
        assert not estados_de_envio.existe(desde, estados_de_envio.CANCELADO), desde


# =========================================================================== #
# 10. La cola de administracion
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_cola_de_administracion_no_lleva_datos_personales(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """NI DIRECCION, NI NOMBRE DE QUIEN COMPRO, NI IMPORTE.

    Es lo que permite que la lea curaduria sin que eso reparta domicilios, al
    reves que la cola de conciliacion, que si los llevaba y por eso se cerro a
    `admin`.
    """
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    async with sesiones() as db:
        cola = await envios.para_administracion(db, limite=200)
        direccion = await pedidos.direccion_de(db, orden_id)

    #: SE BUSCA EL PEDIDO DE ESTA PRUEBA, no se cuenta la cola entera: el
    #: modulo comparte la base y otros casos dejan pedidos pagados detras.
    suyas = [f for f in cola if f.order_id == orden_id]
    assert len(suyas) == 1
    fila = suyas[0]
    assert fila.status == estados_de_envio.PENDIENTE, "nadie lo ha tocado"
    assert fila.units == 2
    campos = set(fila.__dict__)
    for prohibido in ("address", "recipient_name", "phone", "buyer_id", "total_minor"):
        assert prohibido not in campos, prohibido
    texto = str(fila.__dict__)
    assert direccion.address_line not in texto
    assert direccion.recipient_name not in texto


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_cola_no_marca_nada_como_atrasado(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """NO HAY PLAZO DE DESPACHO EN NINGUNA POLITICA PUBLICADA.

    Llamarle tarde a algo sin plazo es inventarse el plazo. Lo que se da es el
    tiempo transcurrido, que es un hecho, y quien mira decide.
    """
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    async with sesiones() as db:
        cola = await envios.para_administracion(db, limite=200)
    fila = next(f for f in cola if f.order_id == orden_id)
    assert fila.waiting_hours is not None
    assert fila.waiting_hours >= 0
    campos = set(fila.__dict__)
    for inventado in ("late", "overdue", "atrasado", "sla", "deadline", "due_at"):
        assert inventado not in campos, inventado


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_lo_entregado_sale_de_la_cola(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """LA COLA ES LO QUE NECESITA A UNA PERSONA, no un historico."""
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)
    await preparar_entero(sesiones, orden_id, quien)

    async def en_la_cola(db) -> list:
        """Lo de ESTE pedido. El modulo comparte la base entre pruebas."""
        return [
            f
            for f in await envios.para_administracion(db, limite=200)
            if f.order_id == orden_id
        ]

    async with sesiones() as db:
        assert len(await en_la_cola(db)) == 1, "preparando, espera a alguien"
        orden = await db.get(ProductOrder, orden_id)
        await envios.despachar(db, orden=orden, actor_id=quien)
        await db.commit()
    async with sesiones() as db:
        assert len(await en_la_cola(db)) == 1, (
            "despachado todavia necesita que alguien lo vea llegar"
        )
        orden = await db.get(ProductOrder, orden_id)
        await envios.registrar_entrega(
            db,
            orden=orden,
            actor_id=quien,
            actor_rol=estados_de_envio.PROVEEDOR,
        )
        await db.commit()
    async with sesiones() as db:
        assert await en_la_cola(db) == [], "lo entregado ya no necesita a nadie"


# =========================================================================== #
# 11. Sin la 0079
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_la_0079_el_envio_contesta_503_y_leer_no_revienta(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """DEGRADACION SEGURA.

    Mover un envio contesta 503 con su codigo; leer el pedido sigue
    funcionando y devuelve el envio como pendiente de preparacion, que es lo
    que es. Un 404 haria pensar que la ruta esta mal escrita, y un 500 que algo
    se rompio.
    """
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)

    async def _no_hay(db):
        return False

    monkeypatch.setattr(esquema, "hay_envios", _no_hay)

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        with pytest.raises(AppError) as fallo:
            await envios.mover(
                db,
                orden=orden,
                hasta=estados_de_envio.PREPARANDO,
                actor_id=quien,
                actor_rol=estados_de_envio.PROVEEDOR,
            )
        await db.rollback()
    assert fallo.value.status_code == 503
    assert fallo.value.code == "product_shipments_not_available"

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        envio = await envios.del_pedido(db, orden=orden)
        historial = await envios.historial(db, orden_id=orden_id)
    assert envio is not None and envio.existe is False
    assert envio.status == estados_de_envio.PENDIENTE
    assert historial == []


# =========================================================================== #
# 12. Nada inventado
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_transportista_el_campo_queda_nulo(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """NULO ES «NO LO DIJERON», NUNCA «N/A» NI CADENA VACIA.

    Un `carrier_name = ''` guardado se pinta como un transportista sin nombre;
    nulo se pinta como lo que es.
    """
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    quien = await duenno_de(sesiones, orden_id)
    await preparar_entero(sesiones, orden_id, quien)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        envio = await envios.despachar(
            db,
            orden=orden,
            actor_id=quien,
            carrier_name="   ",
            tracking_reference="",
        )
        await db.commit()
    assert envio.carrier_name is None
    assert envio.tracking_reference is None


def test_el_envio_no_tiene_columnas_que_nadie_ha_decidido() -> None:
    """NI COSTE, NI IMPUESTOS, NI FECHA PREVISTA, NI ENLACE DE SEGUIMIENTO.

    Una columna vacia «para luego» es una columna que alguien rellena con un
    cero, y un cero en el coste del envio es una promesa de envio gratis que
    nadie ha hecho.
    """
    columnas = set(ProductShipment.__table__.columns.keys())
    for inventada in (
        "shipping_cost_minor",
        "tax_minor",
        "estimated_delivery_at",
        "tracking_url",
        "latitude",
        "longitude",
        "carrier_id",
    ):
        assert inventada not in columnas, inventada
    #: Y EL TRANSPORTISTA NO TIENE VALOR POR DEFECTO.
    assert ProductShipment.__table__.columns["carrier_name"].default is None
    assert ProductShipment.__table__.columns["carrier_name"].server_default is None


def test_el_estado_del_pedido_no_habla_de_envios() -> None:
    """LAS DOS MAQUINAS SIGUEN SEPARADAS.

    Si alguien mete un estado de envio en `product_orders.status`, las junto sin
    decirlo y esta prueba se entera.
    """
    from app.modules.products.models import ESTADOS_DE_PEDIDO

    for estado in estados_de_envio.ESTADOS:
        if estado == estados_de_envio.CANCELADO:
            #: `CANCELLED` existe en las dos y significa cosas distintas: en el
            #: pedido, que no se llego a pagar; en el envio, que no va a salir.
            continue
        assert estado not in ESTADOS_DE_PEDIDO, estado
