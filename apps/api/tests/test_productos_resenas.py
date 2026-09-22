"""Incremento 8 de Productos: resenas verificadas. La 0081, contra PostgreSQL.

LO QUE DEFIENDEN ESTAS PRUEBAS, Y POR QUE CADA UNA:

  1. EL SELLO SE DERIVA, Y LO IMPONE LA BASE. Hay pruebas que fabrican el
     INSERT a mano, saltandose el servicio entero, y comprueban que PostgreSQL
     lo rechaza igual: sin entrega, con otro autor o con una fecha de pago
     inventada. Si «compra verificada» dependiera de un `if`, esas pruebas
     pasarian.
  2. LA UNIDAD ES LA LINEA DE PEDIDO. Una por linea, dos lineas dos resenas, y
     el mismo producto comprado dos veces se puede valorar dos veces.
  3. NADIE VALORA LO SUYO NI LO AJENO.
  4. SIN RESENAS NO HAY PUNTUACION, Y NO HAY UN CERO. Ni promedio, ni ajustada,
     ni porcentaje que recomienda.
  5. LA FORMULA ES LA DEL BLUEPRINT, con su peso de diez y su 4,2.
  6. MODERAR ES ESCONDER, NUNCA REESCRIBIR: la fila se queda entera y el
     historial no se puede modificar.
  7. UNA SOLA RESPUESTA VISIBLE POR RESENA.
  8. LA PAGINACION NO REPITE NI SE SALTA cuando entra una resena nueva.
  9. LO QUE UNA RESENA ATA NO SE PUEDE BORRAR: mientras exista, la fecha de
     entrega y la de cobro quedan congeladas.
 10. SIN LA 0081, 503 CON CODIGO ESTABLE.

LAS AFIRMACIONES ESTAN ACOTADAS AL PRODUCTO Y AL PEDIDO DE CADA PRUEBA. La base
de este modulo es compartida y contar filas globales haria que una prueba
dependiera de las demas.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.core.exceptions import AppError
from app.modules.products import carts, esquema, resenas
from app.modules.products.models import (
    ProductOrder,
    ProductReview,
    ProductReviewModeration,
    ProductReviewReply,
    ProductShipment,
)
from tests.test_productos_dominio import (  # noqa: F401
    SIN_POSTGRES,
    URL,
    base_aplicada,
    persona,
    sesiones,
    vendedor,
)
from tests.test_productos_envios import (  # noqa: F401
    duenno_de,
    pedido_pagado,
    preparar_entero,
)
from tests.test_productos_incidencias import pedido_entregado  # noqa: F401
from tests.test_productos_pedidos import (  # noqa: F401
    AvisoDeMentira,
    PasarelaDeMentira,
    bolsa_con,
    crear_pedido,
    motor,
    politica_publicada,
    venta_encendida,
)

COMENTARIO = "Llego bien embalado y es tal cual se describe en la ficha."

#: Las cinco puntuaciones, para no repetirlas en cada llamada.
CINCO = dict(overall=5, quality=5, fidelity=5, functioning=5, value_for_money=5)


# =========================================================================== #
# Montaje
# =========================================================================== #
async def linea_de(sesiones, orden_id: str):
    from app.modules.products import pedidos

    async with sesiones() as db:
        return (await pedidos.lineas_de(db, orden_id))[0]


async def resena_puesta(sesiones, monkeypatch, **puntuaciones):
    """Un pedido entregado y su resena, por el camino real."""
    _, _, comprador, orden_id, proveedor = await pedido_entregado(sesiones, monkeypatch)
    linea = await linea_de(sesiones, orden_id)
    async with sesiones() as db:
        resena = await resenas.crear(
            db,
            order_item_id=linea.id,
            usuario_id=comprador,
            comentario=COMENTARIO,
            recommends=True,
            **{**CINCO, **puntuaciones},
        )
        await db.commit()
        resena_id = resena.id
    return resena_id, comprador, proveedor, orden_id, linea


async def entregado_del_mismo(sesiones, monkeypatch, producto_id, variante, quien):
    """Otra persona compra ESE producto, lo paga, lo recibe y lo valora.

    Hace falta para poder probar la paginacion: `pedido_entregado` crea un
    producto nuevo cada vez, y con una resena por producto no hay nada que
    paginar.
    """
    from app.modules.products import envios, estados_de_envio, pagos, pedidos

    comprador = await persona(sesiones, "compra-" + uuid.uuid4().hex[:6])
    async with sesiones() as db:
        await carts.anadir(
            db,
            usuario_id=comprador,
            producto_id=producto_id,
            variante_id=variante.id,
            cantidad=1,
        )
        await db.commit()
    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
        seller_id = bolsa.items[0].seller_id

    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    orden_id = creado.orden.id

    monkeypatch.setattr(pagos, "get_provider", lambda _n: PasarelaDeMentira())
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await pagos.iniciar_pago(db, orden=orden, correo="x@y.test")
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await pagos.atender_aviso(
            db, AvisoDeMentira(purchase_id=orden.id, amount_minor=int(orden.total_minor))
        )
        await db.commit()

    await preparar_entero(sesiones, orden_id, quien)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.despachar(db, orden=orden, actor_id=quien)
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.registrar_entrega(
            db, orden=orden, actor_id=quien, actor_rol=estados_de_envio.PROVEEDOR
        )
        await db.commit()

    async with sesiones() as db:
        linea = (await pedidos.lineas_de(db, orden_id))[0]
    async with sesiones() as db:
        resena = await resenas.crear(
            db,
            order_item_id=linea.id,
            usuario_id=comprador,
            recommends=True,
            **CINCO,
        )
        await db.commit()
        return resena.id


# =========================================================================== #
# 1. La verificacion, y que la impone la base
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_quien_compro_y_recibio_puede_valorar(sesiones, monkeypatch, venta_encendida) -> None:
    resena_id, comprador, _, _, linea = await resena_puesta(sesiones, monkeypatch)
    async with sesiones() as db:
        resena = await db.get(ProductReview, resena_id)
    assert resena.author_id == comprador
    assert resena.order_item_id == linea.id
    assert resena.product_id == linea.product_id
    # LAS DOS FECHAS SE COPIARON DE LAS FILAS DE VERDAD, no las mando nadie.
    async with sesiones() as db:
        orden = await db.get(ProductOrder, resena.order_id)
        envio = await db.get(ProductShipment, resena.order_id)
    assert resena.order_paid_at == orden.paid_at
    assert resena.delivered_at == envio.delivered_at


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_entrega_no_se_valora(sesiones, monkeypatch, venta_encendida) -> None:
    """PAGADO NO ES RECIBIDO. Y el motivo lo dice con un codigo estable."""
    _, _, comprador, orden_id = await pedido_pagado(sesiones, monkeypatch)
    linea = await linea_de(sesiones, orden_id)
    async with sesiones() as db:
        puede, motivo, _ = await resenas.puede_resenar(
            db, order_item_id=linea.id, usuario_id=comprador
        )
    assert not puede
    assert motivo == "not_delivered"

    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await resenas.crear(
                db,
                order_item_id=linea.id,
                usuario_id=comprador,
                recommends=True,
                **CINCO,
            )
    assert fallo.value.code == "product_review_not_allowed"
    assert fallo.value.details.get("reason") == "not_delivered"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_pagar_no_se_valora(sesiones, monkeypatch, venta_encendida) -> None:
    """Un pedido creado y sin cobrar no habilita nada."""
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    linea = await linea_de(sesiones, creado.orden.id)
    async with sesiones() as db:
        puede, motivo, _ = await resenas.puede_resenar(
            db, order_item_id=linea.id, usuario_id=comprador
        )
    assert not puede
    assert motivo == "order_not_paid"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_compra_de_otro_no_existe(sesiones, monkeypatch, venta_encendida) -> None:
    """404 Y NO 403. Decir «no es tuya» confirmaria que la compra existe."""
    _, _, _, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await linea_de(sesiones, orden_id)
    intruso = await persona(sesiones, "intrusa")

    async with sesiones() as db:
        puede, motivo, _ = await resenas.puede_resenar(
            db, order_item_id=linea.id, usuario_id=intruso
        )
    assert not puede
    assert motivo == "order_item_not_found"

    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await resenas.crear(
                db, order_item_id=linea.id, usuario_id=intruso, recommends=True, **CINCO
            )
    assert fallo.value.status_code == 404
    assert fallo.value.code == "product_review_not_found"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_nadie_valora_su_propio_producto(sesiones, monkeypatch, venta_encendida) -> None:
    """La unica de las cuatro condiciones que la base no puede imponer.

    El dueno esta a dos saltos —producto, vendedor, perfil— asi que vive en el
    servicio, y por eso tiene prueba propia.
    """
    _, _, _, orden_id, proveedor = await pedido_entregado(sesiones, monkeypatch)
    linea = await linea_de(sesiones, orden_id)
    #: Se le pone al proveedor el papel de comprador de su propio pedido, que es
    #: la unica forma de llegar a esa comprobacion sin falsear nada mas.
    async with sesiones() as db:
        await db.execute(
            text("update product_orders set buyer_id = :p where id = :o"),
            {"p": proveedor, "o": orden_id},
        )
        await db.commit()
    async with sesiones() as db:
        puede, motivo, _ = await resenas.puede_resenar(
            db, order_item_id=linea.id, usuario_id=proveedor
        )
    assert not puede
    assert motivo == "own_product"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_sola_resena_por_linea(sesiones, monkeypatch, venta_encendida) -> None:
    resena_id, comprador, _, _, linea = await resena_puesta(sesiones, monkeypatch)
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await resenas.crear(
                db,
                order_item_id=linea.id,
                usuario_id=comprador,
                recommends=True,
                **CINCO,
            )
    assert fallo.value.code == "product_review_already_exists"

    async with sesiones() as db:
        cuantas = await db.scalar(
            select(func.count(ProductReview.id)).where(
                ProductReview.order_item_id == linea.id
            )
        )
    assert cuantas == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_base_rechaza_una_resena_sin_entrega(sesiones, monkeypatch, venta_encendida) -> None:
    """LA PRUEBA QUE IMPORTA. Se salta el servicio ENTERO y escribe a mano.

    Si la verificacion viviera en los `if` de `resenas.py`, este INSERT pasaria.
    Lo rechaza la clave ajena compuesta contra `product_shipments`, porque la
    fila del envio de ESTE pedido tiene `delivered_at` nulo.
    """
    _, _, comprador, orden_id = await pedido_pagado(sesiones, monkeypatch)
    linea = await linea_de(sesiones, orden_id)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        with pytest.raises((IntegrityError, DBAPIError)):
            await db.execute(
                text(
                    "insert into product_reviews"
                    " (id, product_id, order_id, order_item_id, author_id,"
                    "  order_paid_at, delivered_at, overall, quality, fidelity,"
                    "  functioning, value_for_money, recommends)"
                    " values (gen_random_uuid(), :p, :o, :i, :a, :pa, now(),"
                    "         5, 5, 5, 5, 5, true)"
                ),
                {
                    "p": linea.product_id,
                    "o": orden_id,
                    "i": linea.id,
                    "a": comprador,
                    "pa": orden.paid_at,
                },
            )
        await db.rollback()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_base_rechaza_una_resena_de_otra_persona(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """Otra vez a mano: el autor tiene que ser el comprador de ese pedido."""
    _, _, _, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await linea_de(sesiones, orden_id)
    intruso = await persona(sesiones, "intrusa2")
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        envio = await db.get(ProductShipment, orden_id)
        with pytest.raises((IntegrityError, DBAPIError)):
            await db.execute(
                text(
                    "insert into product_reviews"
                    " (id, product_id, order_id, order_item_id, author_id,"
                    "  order_paid_at, delivered_at, overall, quality, fidelity,"
                    "  functioning, value_for_money, recommends)"
                    " values (gen_random_uuid(), :p, :o, :i, :a, :pa, :da,"
                    "         5, 5, 5, 5, 5, true)"
                ),
                {
                    "p": linea.product_id,
                    "o": orden_id,
                    "i": linea.id,
                    "a": intruso,
                    "pa": orden.paid_at,
                    "da": envio.delivered_at,
                },
            )
        await db.rollback()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_base_rechaza_una_fecha_de_cobro_inventada(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """Y la tercera: la fecha de pago tiene que ser LA del pedido."""
    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await linea_de(sesiones, orden_id)
    async with sesiones() as db:
        envio = await db.get(ProductShipment, orden_id)
        with pytest.raises((IntegrityError, DBAPIError)):
            await db.execute(
                text(
                    "insert into product_reviews"
                    " (id, product_id, order_id, order_item_id, author_id,"
                    "  order_paid_at, delivered_at, overall, quality, fidelity,"
                    "  functioning, value_for_money, recommends)"
                    " values (gen_random_uuid(), :p, :o, :i, :a, now(), :da,"
                    "         5, 5, 5, 5, 5, true)"
                ),
                {
                    "p": linea.product_id,
                    "o": orden_id,
                    "i": linea.id,
                    "a": comprador,
                    "da": envio.delivered_at,
                },
            )
        await db.rollback()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_mientras_haya_resena_la_entrega_no_se_puede_borrar(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """EL EFECTO DE VUELTA. Una resena es evidencia, y ata lo que la respalda.

    Nadie puede deshacer la entrega ni el cobro de un pedido que ya se valoro:
    la clave ajena compuesta lo impide.
    """
    _, _, _, orden_id, _ = await resena_puesta(sesiones, monkeypatch)
    async with sesiones() as db:
        with pytest.raises((IntegrityError, DBAPIError)):
            await db.execute(
                text("update product_shipments set delivered_at = null where order_id = :o"),
                {"o": orden_id},
            )
        await db.rollback()
    async with sesiones() as db:
        with pytest.raises((IntegrityError, DBAPIError)):
            await db.execute(
                text("update product_orders set paid_at = null where id = :o"),
                {"o": orden_id},
            )
        await db.rollback()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_lineas_del_mismo_pedido_son_dos_resenas(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """LA UNIDAD ES LA LINEA. Dos variantes compradas juntas se valoran aparte."""
    from tests.test_productos_carrito import con_existencias, variantes_de
    from tests.test_productos_catalogo import publicado

    producto_id, version_id, _ = await publicado(sesiones)
    variantes = await variantes_de(sesiones, version_id)
    assert len(variantes) >= 2, "el montaje necesita dos variantes"
    await con_existencias(sesiones, producto_id, variantes[0].sku, 5)
    await con_existencias(sesiones, producto_id, variantes[1].sku, 5)
    comprador = await persona(sesiones, "dos-lineas")
    async with sesiones() as db:
        for variante in variantes[:2]:
            await carts.anadir(
                db,
                usuario_id=comprador,
                producto_id=producto_id,
                variante_id=variante.id,
                cantidad=1,
            )
        await db.commit()
    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
        seller_id = bolsa.items[0].seller_id

    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    orden_id = creado.orden.id

    from app.modules.products import envios, estados_de_envio, pagos, pedidos

    monkeypatch.setattr(pagos, "get_provider", lambda _n: PasarelaDeMentira())
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await pagos.iniciar_pago(db, orden=orden, correo="x@y.test")
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await pagos.atender_aviso(
            db, AvisoDeMentira(purchase_id=orden.id, amount_minor=int(orden.total_minor))
        )
        await db.commit()

    quien = await duenno_de(sesiones, orden_id)
    await preparar_entero(sesiones, orden_id, quien)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.despachar(db, orden=orden, actor_id=quien)
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.registrar_entrega(
            db, orden=orden, actor_id=quien, actor_rol=estados_de_envio.PROVEEDOR
        )
        await db.commit()

    async with sesiones() as db:
        lineas = await pedidos.lineas_de(db, orden_id)
    assert len(lineas) == 2

    async with sesiones() as db:
        for linea in lineas:
            await resenas.crear(
                db,
                order_item_id=linea.id,
                usuario_id=comprador,
                recommends=True,
                **CINCO,
            )
        await db.commit()

    async with sesiones() as db:
        cuantas = await db.scalar(
            select(func.count(ProductReview.id)).where(
                ProductReview.order_id == orden_id
            )
        )
    assert cuantas == 2


# =========================================================================== #
# 2. Lo que se escribe
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_puntuacion_fuera_de_rango_la_rechaza_la_base(
    sesiones, monkeypatch, venta_encendida
) -> None:
    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await linea_de(sesiones, orden_id)
    async with sesiones() as db:
        with pytest.raises((IntegrityError, DBAPIError)):
            await resenas.crear(
                db,
                order_item_id=linea.id,
                usuario_id=comprador,
                overall=6,
                quality=5,
                fidelity=5,
                functioning=5,
                value_for_money=5,
                recommends=True,
            )
        await db.rollback()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_general_no_es_la_media_de_los_ejes(sesiones, monkeypatch, venta_encendida) -> None:
    """Responde a otra pregunta, y se guarda tal cual la escribio la persona."""
    resena_id, _, _, _, _ = await resena_puesta(
        sesiones,
        monkeypatch,
        overall=2,
        quality=5,
        fidelity=5,
        functioning=5,
        value_for_money=5,
    )
    async with sesiones() as db:
        resena = await db.get(ProductReview, resena_id)
    assert resena.overall == 2
    assert resena.quality == 5


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_comentario_se_recorta_y_el_vacio_viaja_nulo(
    sesiones, monkeypatch, venta_encendida
) -> None:
    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await linea_de(sesiones, orden_id)
    async with sesiones() as db:
        resena = await resenas.crear(
            db,
            order_item_id=linea.id,
            usuario_id=comprador,
            comentario="   ",
            recommends=False,
            **CINCO,
        )
        await db.commit()
        assert resena.comment is None


# =========================================================================== #
# 3. El resumen
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_resenas_no_hay_puntuacion_y_no_hay_un_cero(
    sesiones, monkeypatch, venta_encendida
) -> None:
    from tests.test_productos_catalogo import publicado

    producto_id, _, _ = await publicado(sesiones)
    async with sesiones() as db:
        resumen = await resenas.resumen(db, producto_id=producto_id)
    assert resumen.total == 0
    assert resumen.promedio is None, "un producto sin resenas no puntua 0,0"
    assert resumen.ajustada is None, "ni se publica la ajustada, que seria 4,2"
    assert resumen.recomiendan_bps is None
    assert resumen.histograma == {1: 0, 2: 0, 3: 0, 4: 0, 5: 0}
    assert all(v is None for v in resumen.por_eje.values())


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_resumen_cuenta_lo_que_hay(sesiones, monkeypatch, venta_encendida) -> None:
    resena_id, _, _, _, linea = await resena_puesta(
        sesiones,
        monkeypatch,
        overall=4,
        quality=5,
        fidelity=3,
        functioning=4,
        value_for_money=2,
    )
    async with sesiones() as db:
        resumen = await resenas.resumen(db, producto_id=linea.product_id)
    assert resumen.total == 1
    assert resumen.promedio == pytest.approx(4.0)
    assert resumen.histograma[4] == 1
    assert resumen.recomiendan_bps == 10_000
    assert resumen.por_eje["value_for_money"] == pytest.approx(2.0)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_ajustada_es_la_formula_del_blueprint(sesiones, monkeypatch, venta_encendida) -> None:
    """(v/(v+10))*promedio + (10/(v+10))*4,2, con v = 1 y promedio = 4."""
    _, _, _, _, linea = await resena_puesta(sesiones, monkeypatch, overall=4)
    async with sesiones() as db:
        resumen = await resenas.resumen(db, producto_id=linea.product_id)
    esperada = (1 / 11) * 4.0 + (10 / 11) * 4.2
    assert resumen.ajustada == pytest.approx(esperada)
    assert resumen.promedio_de_categoria == 4.2
    assert resumen.categoria_configurada is False, (
        "de donde sale el promedio de categoria es una decision abierta"
    )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_resena_escondida_no_cuenta_en_el_resumen(
    sesiones, monkeypatch, venta_encendida
) -> None:
    resena_id, _, _, _, linea = await resena_puesta(sesiones, monkeypatch, overall=1)
    moderador = await persona(sesiones, "modera")
    async with sesiones() as db:
        await resenas.moderar(
            db, resena_id=resena_id, actor_id=moderador, esconder=True, motivo="spam"
        )
        await db.commit()
    async with sesiones() as db:
        resumen = await resenas.resumen(db, producto_id=linea.product_id)
    assert resumen.total == 0
    assert resumen.promedio is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_resumen_de_varios_no_hace_una_consulta_por_producto(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """CONTRA EL N+1. Doce productos tienen que costar lo mismo que uno."""
    from tests.test_productos_catalogo import publicado

    _, _, _, _, linea = await resena_puesta(sesiones, monkeypatch)
    otros = []
    for _ in range(3):
        producto_id, _, _ = await publicado(sesiones)
        otros.append(producto_id)

    consultas: list[str] = []
    async with sesiones() as db:
        conexion = await db.connection()

        from sqlalchemy import event

        motor_sync = conexion.sync_connection.engine

        def contar(conn, cursor, statement, params, context, many):  # noqa: ANN001
            if "product_reviews" in statement:
                consultas.append(statement)

        event.listen(motor_sync, "before_cursor_execute", contar)
        try:
            mapa = await resenas.resumen_de(
                db, producto_ids=[linea.product_id, *otros]
            )
        finally:
            event.remove(motor_sync, "before_cursor_execute", contar)

    assert set(mapa) == {linea.product_id, *otros}
    assert mapa[linea.product_id].total == 1
    assert all(mapa[p].total == 0 for p in otros)
    assert len(consultas) == 2, (
        f"el resumen de cuatro productos hizo {len(consultas)} consultas"
    )


# =========================================================================== #
# 4. Editar
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_se_edita_la_propia(sesiones, monkeypatch, venta_encendida) -> None:
    resena_id, comprador, _, _, _ = await resena_puesta(sesiones, monkeypatch)
    async with sesiones() as db:
        await resenas.editar(
            db,
            resena_id=resena_id,
            usuario_id=comprador,
            overall=3,
            comentario="Lo he usado un mes y se ha desgastado antes de tiempo.",
        )
        await db.commit()
    async with sesiones() as db:
        resena = await db.get(ProductReview, resena_id)
    assert resena.overall == 3
    assert resena.comment.startswith("Lo he usado")


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_editar_no_cambia_de_que_compra_habla(sesiones, monkeypatch, venta_encendida) -> None:
    resena_id, comprador, _, _, linea = await resena_puesta(sesiones, monkeypatch)
    async with sesiones() as db:
        antes = await db.get(ProductReview, resena_id)
        atado = (antes.order_id, antes.order_item_id, antes.order_paid_at, antes.delivered_at)
    async with sesiones() as db:
        await resenas.editar(db, resena_id=resena_id, usuario_id=comprador, overall=1)
        await db.commit()
    async with sesiones() as db:
        despues = await db.get(ProductReview, resena_id)
    assert (
        despues.order_id,
        despues.order_item_id,
        despues.order_paid_at,
        despues.delivered_at,
    ) == atado


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_edita_la_ajena(sesiones, monkeypatch, venta_encendida) -> None:
    resena_id, _, _, _, _ = await resena_puesta(sesiones, monkeypatch)
    intruso = await persona(sesiones, "edita-ajena")
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await resenas.editar(db, resena_id=resena_id, usuario_id=intruso, overall=1)
    assert fallo.value.status_code == 404


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_escondida_no_se_edita(sesiones, monkeypatch, venta_encendida) -> None:
    """Editarla y dejarla escondida no sirve; dejarla visible seria saltarse la
    moderacion escribiendo."""
    resena_id, comprador, _, _, _ = await resena_puesta(sesiones, monkeypatch)
    moderador = await persona(sesiones, "modera2")
    async with sesiones() as db:
        await resenas.moderar(
            db, resena_id=resena_id, actor_id=moderador, esconder=True, motivo="insultos"
        )
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await resenas.editar(db, resena_id=resena_id, usuario_id=comprador, overall=5)
    assert fallo.value.code == "product_review_not_allowed"
    assert fallo.value.details.get("reason") == "hidden"


# =========================================================================== #
# 5. Moderar
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_moderar_esconde_y_no_reescribe(sesiones, monkeypatch, venta_encendida) -> None:
    resena_id, comprador, _, _, _ = await resena_puesta(
        sesiones, monkeypatch, overall=1
    )
    moderador = await persona(sesiones, "modera3")
    async with sesiones() as db:
        antes = await db.get(ProductReview, resena_id)
        copia = (antes.overall, antes.comment, antes.author_id, antes.recommends)
    async with sesiones() as db:
        await resenas.moderar(
            db,
            resena_id=resena_id,
            actor_id=moderador,
            esconder=True,
            motivo="datos personales",
        )
        await db.commit()
    async with sesiones() as db:
        despues = await db.get(ProductReview, resena_id)
    assert despues.status == "hidden"
    assert despues.moderated_at is not None
    assert (
        despues.overall,
        despues.comment,
        despues.author_id,
        despues.recommends,
    ) == copia, "moderar reescribio lo que escribio otra persona"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_restaurar_limpia_la_marca_y_deja_dos_filas_de_historial(
    sesiones, monkeypatch, venta_encendida
) -> None:
    resena_id, _, _, _, _ = await resena_puesta(sesiones, monkeypatch)
    moderador = await persona(sesiones, "modera4")
    async with sesiones() as db:
        await resenas.moderar(
            db, resena_id=resena_id, actor_id=moderador, esconder=True, motivo="revisar"
        )
        await db.commit()
    async with sesiones() as db:
        await resenas.moderar(
            db, resena_id=resena_id, actor_id=moderador, esconder=False, motivo="ok"
        )
        await db.commit()
    async with sesiones() as db:
        resena = await db.get(ProductReview, resena_id)
        historial = await resenas.historial_de_moderacion(db, resena_id=resena_id)
    assert resena.status == "visible"
    assert resena.moderated_at is None
    assert resena.moderation_reason is None
    assert [f.to_status for f in historial] == ["hidden", "visible"]
    assert historial[0].reason == "revisar", "el motivo vive en el historial"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_historial_de_moderacion_no_se_reescribe(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """Lo impone un disparador, no la buena voluntad del codigo."""
    resena_id, _, _, _, _ = await resena_puesta(sesiones, monkeypatch)
    moderador = await persona(sesiones, "modera5")
    async with sesiones() as db:
        await resenas.moderar(
            db, resena_id=resena_id, actor_id=moderador, esconder=True, motivo="x"
        )
        await db.commit()
    async with sesiones() as db:
        fila = await db.scalar(
            select(ProductReviewModeration.id).where(
                ProductReviewModeration.review_id == resena_id
            )
        )
        with pytest.raises((IntegrityError, DBAPIError)):
            await db.execute(
                text("update product_review_moderation set reason = 'otro' where id = :i"),
                {"i": fila},
            )
        await db.rollback()
    async with sesiones() as db:
        with pytest.raises((IntegrityError, DBAPIError)):
            await db.execute(
                text("delete from product_review_moderation where id = :i"), {"i": fila}
            )
        await db.rollback()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_escondida_sale_de_la_lista_publica_pero_no_de_la_mia(
    sesiones, monkeypatch, venta_encendida
) -> None:
    resena_id, comprador, _, _, linea = await resena_puesta(sesiones, monkeypatch)
    moderador = await persona(sesiones, "modera6")
    async with sesiones() as db:
        await resenas.moderar(
            db, resena_id=resena_id, actor_id=moderador, esconder=True, motivo="x"
        )
        await db.commit()
    async with sesiones() as db:
        publicas = await resenas.listar(db, producto_id=linea.product_id)
        mias = await resenas.mias(db, usuario_id=comprador)
    assert resena_id not in [r.id for r in publicas]
    assert resena_id in [r.id for r in mias], (
        "quien la escribio tiene derecho a saber que paso con lo que escribio"
    )


# =========================================================================== #
# 6. La respuesta del proveedor
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_proveedor_responde_una_vez(sesiones, monkeypatch, venta_encendida) -> None:
    resena_id, _, proveedor, _, _ = await resena_puesta(sesiones, monkeypatch)
    async with sesiones() as db:
        await resenas.responder(
            db, resena_id=resena_id, usuario_id=proveedor, texto="Gracias por contarlo."
        )
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await resenas.responder(
                db, resena_id=resena_id, usuario_id=proveedor, texto="Otra mas."
            )
    assert fallo.value.code == "product_review_reply_already_exists"

    async with sesiones() as db:
        visibles = await db.scalar(
            select(func.count(ProductReviewReply.id)).where(
                ProductReviewReply.review_id == resena_id,
                ProductReviewReply.status == "visible",
            )
        )
    assert visibles == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_otro_proveedor_no_ve_esa_resena(sesiones, monkeypatch, venta_encendida) -> None:
    resena_id, _, _, _, _ = await resena_puesta(sesiones, monkeypatch)
    otro = await persona(sesiones, "otro-prov")
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await resenas.responder(
                db, resena_id=resena_id, usuario_id=otro, texto="Hola."
            )
    assert fallo.value.status_code == 404


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_responde_a_una_escondida(sesiones, monkeypatch, venta_encendida) -> None:
    resena_id, _, proveedor, _, _ = await resena_puesta(sesiones, monkeypatch)
    moderador = await persona(sesiones, "modera7")
    async with sesiones() as db:
        await resenas.moderar(
            db, resena_id=resena_id, actor_id=moderador, esconder=True, motivo="x"
        )
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await resenas.responder(
                db, resena_id=resena_id, usuario_id=proveedor, texto="Hola."
            )
    assert fallo.value.code == "product_review_reply_forbidden"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_restaurar_una_respuesta_choca_con_la_que_haya_visible(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """Y lo dice con palabras, en vez de dejar salir un 500 del indice."""
    resena_id, _, proveedor, _, _ = await resena_puesta(sesiones, monkeypatch)
    moderador = await persona(sesiones, "modera8")
    async with sesiones() as db:
        primera = await resenas.responder(
            db, resena_id=resena_id, usuario_id=proveedor, texto="Primera."
        )
        await db.commit()
        primera_id = primera.id
    async with sesiones() as db:
        await resenas.moderar_respuesta(
            db, respuesta_id=primera_id, actor_id=moderador, esconder=True, motivo="x"
        )
        await db.commit()
    async with sesiones() as db:
        await resenas.responder(
            db, resena_id=resena_id, usuario_id=proveedor, texto="Segunda."
        )
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await resenas.moderar_respuesta(
                db, respuesta_id=primera_id, actor_id=moderador, esconder=False
            )
    assert fallo.value.code == "product_review_reply_already_exists"
    #: Y DICE CUAL ES LA OTRA. Es lo que distingue la comprobacion previa del
    #: indice unico de la base: las dos contestan el mismo codigo, pero solo la
    #: de arriba sabe cual es la respuesta que estorba y puede llevar ahi. Sin
    #: esta linea, retirar la comprobacion previa no cambiaba nada medible.
    assert fallo.value.details.get("reply_id"), (
        "el 409 no dice cual es la otra respuesta visible"
    )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_respuesta_escondida_no_viaja_con_la_resena(
    sesiones, monkeypatch, venta_encendida
) -> None:
    resena_id, _, proveedor, _, _ = await resena_puesta(sesiones, monkeypatch)
    moderador = await persona(sesiones, "modera9")
    async with sesiones() as db:
        respuesta = await resenas.responder(
            db, resena_id=resena_id, usuario_id=proveedor, texto="Primera."
        )
        await db.commit()
        respuesta_id = respuesta.id
    async with sesiones() as db:
        await resenas.moderar_respuesta(
            db, respuesta_id=respuesta_id, actor_id=moderador, esconder=True, motivo="x"
        )
        await db.commit()
    async with sesiones() as db:
        mapa = await resenas.respuestas_de(db, resena_ids=[resena_id])
    assert resena_id not in mapa


# =========================================================================== #
# 7. Listar y paginar
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_paginacion_no_repite_ni_se_salta(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """EL CURSOR ES `(created_at, id)` Y NO UN NUMERO DE PAGINA.

    Se pide una pagina de dos, ENTRA UNA RESENA NUEVA —la mas reciente, que con
    un desplazamiento numerico correria todas las demas una posicion— y se pide
    la siguiente. No puede repetir ninguna de las dos primeras ni saltarse las
    que ya estaban, y la nueva NO puede aparecer: es posterior al cursor.

    LAS CUATRO SON DE VERDAD: cuatro personas distintas compran el mismo
    producto y lo reciben. Moverlas de producto con un `update` no vale, porque
    la clave ajena compuesta de la 0081 lo rechaza, que es justo lo que tiene
    que hacer.
    """
    from tests.test_productos_carrito import con_existencias, variantes_de
    from tests.test_productos_catalogo import publicado

    producto_id, version_id, quien = await publicado(sesiones)
    variantes = await variantes_de(sesiones, version_id)
    await con_existencias(sesiones, producto_id, variantes[0].sku, 20)

    viejas = [
        await entregado_del_mismo(
            sesiones, monkeypatch, producto_id, variantes[0], quien
        )
        for _ in range(3)
    ]

    async with sesiones() as db:
        primera = await resenas.listar(db, producto_id=producto_id, limite=2)
    assert len(primera) == 2
    cursor = (primera[-1].created_at, primera[-1].id)

    #: LA CUARTA ENTRA AQUI, entre las dos paginas. Es la mas reciente.
    nueva = await entregado_del_mismo(
        sesiones, monkeypatch, producto_id, variantes[0], quien
    )

    async with sesiones() as db:
        segunda = await resenas.listar(
            db, producto_id=producto_id, antes_de=cursor, limite=5
        )

    vistos = [r.id for r in primera] + [r.id for r in segunda]
    assert len(vistos) == len(set(vistos)), "la paginacion repitio una resena"
    assert set(viejas) <= set(vistos), "la paginacion se salto una resena"
    assert nueva not in vistos, (
        "la resena nueva se colo en la segunda pagina: el cursor no es estable"
    )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_las_lineas_valorables_de_un_pedido_ajeno_no_se_ven(
    sesiones, monkeypatch, venta_encendida
) -> None:
    _, _, _, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    intruso = await persona(sesiones, "curioso")
    async with sesiones() as db:
        lineas = await resenas.valorables_del_pedido(
            db, orden_id=orden_id, usuario_id=intruso
        )
    assert lineas == []


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_linea_ya_valorada_sale_marcada(sesiones, monkeypatch, venta_encendida) -> None:
    resena_id, comprador, _, orden_id, linea = await resena_puesta(
        sesiones, monkeypatch
    )
    async with sesiones() as db:
        lineas = await resenas.valorables_del_pedido(
            db, orden_id=orden_id, usuario_id=comprador
        )
    assert [l.order_item_id for l in lineas] == [linea.id]
    assert lineas[0].review_id == resena_id


# =========================================================================== #
# 8. Concurrencia
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_envios_a_la_vez_dejan_una_sola_resena(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """DOS PESTANAS, O UN DOBLE TOQUE. La unica que lo decide es la base."""
    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await linea_de(sesiones, orden_id)

    async def valorar():
        async with sesiones() as db:
            resena = await resenas.crear(
                db,
                order_item_id=linea.id,
                usuario_id=comprador,
                recommends=True,
                **CINCO,
            )
            await db.commit()
            return resena.id

    salidas = await asyncio.gather(valorar(), valorar(), return_exceptions=True)
    buenas = [s for s in salidas if isinstance(s, str)]
    #: LA EXCEPCION CONCRETA, no «alguna». Aceptar cualquier `Exception` dejaba
    #: pasar un `IntegrityError` crudo —un 500 para quien pulsa dos veces— si
    #: `_es` dejara de reconocer el nombre de la restriccion. Lo encontro la
    #: revision independiente.
    malas = [s for s in salidas if isinstance(s, resenas.ResenaDuplicada)]
    otras = [
        s for s in salidas if isinstance(s, Exception) and not isinstance(s, resenas.ResenaDuplicada)
    ]
    assert len(buenas) == 1, f"las dos escribieron: {salidas}"
    assert len(malas) == 1, f"la segunda no dio un 409 limpio: {salidas}"
    assert not otras, f"salio un error que la pantalla no sabe leer: {otras}"
    assert malas[0].status_code == 409

    async with sesiones() as db:
        cuantas = await db.scalar(
            select(func.count(ProductReview.id)).where(
                ProductReview.order_item_id == linea.id
            )
        )
    assert cuantas == 1


# =========================================================================== #
# 9. Sin la 0081
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_la_0081_las_resenas_contestan_503(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """503 CON CODIGO ESTABLE, Y SOBRE LAS FUNCIONES DE VERDAD.

    La primera version llamaba a `exigir_disponible` y nada mas, asi que
    probaba el `if` de la puerta y no que las entradas del modulo contestasen
    503. Lo encontro la revision independiente. Ahora se recorren las cinco que
    una pantalla puede tocar.
    """
    _, _, comprador, orden_id, proveedor = await pedido_entregado(
        sesiones, monkeypatch
    )
    linea = await linea_de(sesiones, orden_id)

    async def _no_hay(db):  # noqa: ANN001, ANN202
        return False

    monkeypatch.setattr(esquema, "hay_resenas", _no_hay)

    #: LAS CINCO ENTRADAS, cada una por su camino.
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await resenas.crear(
                db,
                order_item_id=linea.id,
                usuario_id=comprador,
                recommends=True,
                **CINCO,
            )
        await db.rollback()
    assert fallo.value.status_code == 503
    assert fallo.value.code == "product_reviews_not_available"

    for llamada in (
        lambda db: resenas.listar(db, producto_id=linea.product_id),
        lambda db: resenas.valorables_del_pedido(
            db, orden_id=orden_id, usuario_id=comprador
        ),
        lambda db: resenas.del_proveedor(db, usuario_id=proveedor),
        lambda db: resenas.para_moderar(db),
    ):
        async with sesiones() as db:
            with pytest.raises(AppError) as fallo:
                await llamada(db)
        assert fallo.value.code == "product_reviews_not_available", llamada

    #: Y `puede_resenar` NO LANZA: contesta el motivo, porque lo llama la
    #: pantalla para decidir si ofrecer el formulario.
    async with sesiones() as db:
        puede, motivo, _ = await resenas.puede_resenar(
            db, order_item_id=linea.id, usuario_id=comprador
        )
    assert (puede, motivo) == (False, "reviews_not_available")

    #: Y EL RESUMEN NO SE CAE: contesta vacio, porque es un bloque de la ficha
    #: y tumbar la ficha entera por esto seria peor.
    async with sesiones() as db:
        resumen = await resenas.resumen(db, producto_id=str(uuid.uuid4()))
    assert resumen.total == 0
    assert resumen.promedio is None


# =========================================================================== #
# 10. Lo que el codigo NO puede hacer
# =========================================================================== #
def _arbol(nombre: str):  # noqa: ANN202
    import ast
    import pathlib

    ruta = (
        pathlib.Path(__file__).resolve().parents[1]
        / "app"
        / "modules"
        / "products"
        / nombre
    )
    return ast.parse(ruta.read_text(encoding="utf-8"))


#: Los campos que NADIE reescribe: son lo que escribio otra persona.
INTOCABLES = frozenset(
    {"overall", "quality", "fidelity", "functioning", "value_for_money",
     "recommends", "comment", "author_id", "order_item_id", "product_id",
     "order_paid_at", "delivered_at"}
)


def test_solo_editar_y_moderar_escriben_una_resena() -> None:
    """NADIE REESCRIBE LO QUE ESCRIBIO OTRA PERSONA.

    La primera version de esta prueba recorria el ROUTER buscando asignaciones
    a atributo, y no habia ninguna: el router no escribe campos del ORM, todo
    pasa por el servicio. Era una prueba VACIA —lo encontro la revision
    independiente— y ademas excluia `moderar_resena`, que es la unica ruta que
    si cambia el estado.

    Ahora mira `resenas.py`, que es donde viven las escrituras, y se apoya en
    dos cosas que la hacen poder fallar: cuenta las funciones que escriben algo
    y exige que sean EXACTAMENTE las que pueden.
    """
    import ast

    arbol = _arbol("resenas.py")
    quien_escribe: dict[str, set[str]] = {}
    for nodo in ast.walk(arbol):
        if not isinstance(nodo, (ast.AsyncFunctionDef, ast.FunctionDef)):
            continue
        for hijo in ast.walk(nodo):
            if not isinstance(hijo, ast.Attribute) or not isinstance(
                hijo.ctx, ast.Store
            ):
                continue
            if not isinstance(hijo.value, ast.Name):
                continue
            if hijo.value.id not in {"resena", "respuesta"}:
                continue
            quien_escribe.setdefault(nodo.name, set()).add(hijo.attr)

    #: LA PRUEBA TIENE QUE PODER FALLAR: si no encontrara ninguna escritura
    #: —porque alguien renombro las variables o movio el codigo— no estaria
    #: comprobando nada, y eso se dice aqui en vez de pasar en verde.
    assert quien_escribe, "no se encontro ni una escritura: la prueba no mide nada"
    assert set(quien_escribe) == {"editar", "moderar", "moderar_respuesta"}, (
        f"escriben tambien: {sorted(set(quien_escribe))}"
    )

    #: Y CADA UNA SOLO LO SUYO. `editar` toca lo que escribio su autor;
    #: moderar NO puede tocar ni una de esas columnas.
    for funcion in ("moderar", "moderar_respuesta"):
        tocadas = quien_escribe[funcion] & INTOCABLES
        assert not tocadas, f"{funcion} reescribe {sorted(tocadas)}"
    assert "status" not in quien_escribe["editar"], "editar cambia el estado"


def test_ninguna_ruta_de_proveedor_toca_la_resena() -> None:
    """El proveedor RESPONDE, y nada mas.

    Se comprueba sobre las rutas: ninguna funcion del router cuyo nombre hable
    del proveedor puede llamar a `moderar`, `moderar_respuesta` ni `editar`.
    """
    import ast

    arbol = _arbol("router.py")
    del_proveedor = []
    for nodo in ast.walk(arbol):
        if not isinstance(nodo, (ast.AsyncFunctionDef, ast.FunctionDef)):
            continue
        fuente = ast.dump(nodo)
        if "seller/reviews" not in fuente:
            continue
        del_proveedor.append(nodo.name)
        for prohibido in ("moderar", "moderar_respuesta", "editar"):
            assert f"attr='{prohibido}'" not in fuente, f"{nodo.name} llama a {prohibido}"

    assert len(del_proveedor) == 2, (
        f"se esperaban dos rutas de proveedor y hay {del_proveedor}"
    )


#: Lo que una resena no puede importar. Ni dinero, ni almacen.
PROHIBIDOS = ("pagos", "refund", "reembolso", "finanzas", "liquidacion",
              "transferencias", "inventory", "inventario")


def _importados(codigo: str) -> set[str]:
    """Todos los nombres que un fichero importa, en los TRES idiomas.

    La primera version de este centinela solo miraba `nodo.module` de un
    `ImportFrom`, asi que no veia `from app.modules.products import pagos`
    —donde el nombre viaja en `nodo.names`— que es justamente el idioma que usa
    todo el modulo. Lo encontro la revision independiente.
    """
    import ast

    nombres: set[str] = set()
    for nodo in ast.walk(ast.parse(codigo)):
        if isinstance(nodo, ast.ImportFrom):
            if nodo.module:
                nombres.update(nodo.module.split("."))
            nombres.update(a.name.split(".")[0] for a in nodo.names)
        elif isinstance(nodo, ast.Import):
            for a in nodo.names:
                nombres.update(a.name.split("."))
    return nombres


def test_el_servicio_no_sabe_de_dinero() -> None:
    """UNA RESENA NO MUEVE NI UN CENTIMO, y no importa nada que lo haga."""
    import pathlib

    ruta = (
        pathlib.Path(__file__).resolve().parents[1]
        / "app"
        / "modules"
        / "products"
        / "resenas.py"
    )
    codigo = ruta.read_text(encoding="utf-8")
    encontrados = sorted(PROHIBIDOS_EN := set(_importados(codigo)) & set(PROHIBIDOS))
    assert not encontrados, f"resenas.py importa {encontrados}"

    #: CONTROL POSITIVO: el centinela TIENE que ver los tres idiomas de import.
    #: Sin esto, un centinela roto pasa en verde y nadie se entera.
    for inyectado in (
        "from app.modules.products import esquema, pagos",
        "from app.modules.products.pagos import iniciar_pago",
        "import app.modules.products.pagos",
    ):
        copia = codigo.replace(
            "from app.modules.products import esquema", inyectado, 1
        )
        assert "pagos" in _importados(copia), f"el centinela no ve: {inyectado}"


# =========================================================================== #
# 11. Los dos huecos que encontraron las mutaciones
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_proveedor_solo_ve_las_resenas_de_sus_productos(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """LA BANDEJA NO ES UNA VENTANA AL CATALOGO ENTERO.

    Lo encontro una mutacion: sin el filtro por perfil, `del_proveedor`
    devolvia todas las resenas de la plataforma y ninguna prueba se enteraba,
    porque las que habia solo comprobaban que la propia SI estuviera.
    """
    mia, _, proveedor, _, _ = await resena_puesta(sesiones, monkeypatch)
    ajena, _, otro_proveedor, _, _ = await resena_puesta(sesiones, monkeypatch)
    assert proveedor != otro_proveedor, "el montaje necesita dos tiendas"

    async with sesiones() as db:
        vistas = [r.id for r in await resenas.del_proveedor(db, usuario_id=proveedor)]
    assert mia in vistas
    assert ajena not in vistas, "la bandeja ensena resenas de productos ajenos"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_resena_escondida_no_sale_en_la_bandeja_del_proveedor(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """Una escondida por moderacion no se le ensena a nadie mas que a su autor."""
    resena_id, _, proveedor, _, _ = await resena_puesta(sesiones, monkeypatch)
    moderador = await persona(sesiones, "modera10")
    async with sesiones() as db:
        await resenas.moderar(
            db, resena_id=resena_id, actor_id=moderador, esconder=True, motivo="x"
        )
        await db.commit()
    async with sesiones() as db:
        vistas = [r.id for r in await resenas.del_proveedor(db, usuario_id=proveedor)]
    assert resena_id not in vistas


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_histograma_ausente_sale_en_ceros_y_no_revienta(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """Un producto con resenas tiene su histograma; sin filas, cinco ceros."""
    _, _, _, _, linea = await resena_puesta(sesiones, monkeypatch, overall=3)
    async with sesiones() as db:
        resumen = await resenas.resumen(db, producto_id=linea.product_id)
    assert resumen.histograma[3] == 1
    assert sum(resumen.histograma.values()) == 1


def test_armar_con_cero_resenas_no_publica_ninguna_puntuacion() -> None:
    """LAS DOS GUARDIAS DEL RESUMEN, LLAMADAS DIRECTAMENTE.

    Dentro de la consulta `total` sale de un `count()` sobre un `group_by` y
    nunca vale cero, asi que estas dos reglas eran codigo defensivo que ninguna
    prueba podia alcanzar. Aqui si: se llama con cero y se comprueba que no se
    publica ni la ajustada —que seria la puntuacion de la CATEGORIA— ni un
    «0 %» que se leeria como que nadie lo recomienda.
    """
    #: SE LE PASAN DATOS A PROPOSITO en los tres sitios —promedio, quien
    #: recomienda y los cuatro ejes— para que la prueba mida las guardias y no
    #: la ausencia de datos: con  la de los ejes se cumpliria sola.
    vacio = resenas.armar(
        total=0,
        promedio=4.5,
        recomiendan=3,
        ejes={eje: 4.0 for eje in resenas.EJES},
    )
    assert vacio.total == 0
    assert vacio.promedio is None, "una media sobre cero opiniones no es una media"
    assert vacio.ajustada is None, "con cero resenas la formula da la de la categoria"
    assert vacio.recomiendan_bps is None, "«0 %» no es lo mismo que «nadie contesto»"
    assert vacio.histograma == {1: 0, 2: 0, 3: 0, 4: 0, 5: 0}
    assert all(v is None for v in vacio.por_eje.values())
    #: Y EL PREVIO SE DICE IGUAL, para que la pantalla pueda explicarlo.
    assert vacio.promedio_de_categoria == resenas.PROMEDIO_DE_CATEGORIA_POR_DEFECTO
    assert vacio.categoria_configurada is False


def test_armar_con_una_resena_publica_la_formula_del_blueprint() -> None:
    uno = resenas.armar(
        total=1,
        promedio=4.0,
        recomiendan=1,
        ejes={"quality": 5.0, "fidelity": None, "functioning": 4.0, "value_for_money": 2.0},
        histograma={1: 0, 2: 0, 3: 0, 4: 1, 5: 0},
    )
    assert uno.promedio == 4.0
    assert uno.ajustada == pytest.approx((1 / 11) * 4.0 + (10 / 11) * 4.2)
    assert uno.recomiendan_bps == 10_000
    assert uno.por_eje["quality"] == 5.0
    assert uno.por_eje["fidelity"] is None, "un eje sin datos no se rellena"
    #: Y NINGUN EJE DE MAS: la tupla del modelo es la unica fuente.
    assert set(uno.por_eje) == set(resenas.EJES)


def test_armar_con_nadie_que_recomiende_si_dice_cero() -> None:
    """UN CERO DE VERDAD SI ES UN CERO. Que nadie lo recomiende es un dato."""
    ninguno = resenas.armar(total=4, promedio=2.0, recomiendan=0)
    assert ninguno.recomiendan_bps == 0


# =========================================================================== #
# 12. Lo que encontro la revision independiente
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_base_impide_que_nadie_modere_lo_suyo(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """EL BLOQUEANTE, EN LA CAPA QUE NO SE ESQUIVA.

    `profiles.role` incluye `moderator`, asi que a un proveedor al que se le
    diera rol de curaduria le bastaba la ruta de moderacion para enterrar todas
    las valoraciones malas de su catalogo. Es la misma regla que gobierna
    evaluar y publicar desde el Incremento 2, y faltaba aqui.

    Esta prueba llama al SERVICIO, saltandose la ruta y su comprobacion de
    propiedad: lo que la rechaza es el disparador de la 0081.
    """
    resena_id, _, proveedor, _, linea = await resena_puesta(
        sesiones, monkeypatch, overall=1
    )
    async with sesiones() as db:
        with pytest.raises((IntegrityError, DBAPIError)) as fallo:
            await resenas.moderar(
                db,
                resena_id=resena_id,
                actor_id=proveedor,
                esconder=True,
                motivo="no me gusta",
            )
        await db.rollback()
    assert "propio producto" in str(fallo.value)

    #: Y LA VALORACION SIGUE VISIBLE, con su estrella.
    async with sesiones() as db:
        fila = await db.get(ProductReview, resena_id)
        resumen = await resenas.resumen(db, producto_id=linea.product_id)
    assert fila.status == "visible"
    assert resumen.total == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_base_impide_que_esconda_la_respuesta_de_lo_suyo(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """Lo mismo para la respuesta: esconder la suya tambien es moderar lo suyo."""
    resena_id, _, proveedor, _, _ = await resena_puesta(sesiones, monkeypatch)
    async with sesiones() as db:
        respuesta = await resenas.responder(
            db, resena_id=resena_id, usuario_id=proveedor, texto="Gracias."
        )
        await db.commit()
        respuesta_id = respuesta.id
    async with sesiones() as db:
        with pytest.raises((IntegrityError, DBAPIError)):
            await resenas.moderar_respuesta(
                db, respuesta_id=respuesta_id, actor_id=proveedor, esconder=True
            )
        await db.rollback()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_escondida_vuelve_a_la_cola_y_se_puede_restaurar(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """EL ALTO A1. Esconder no puede ser una decision de un solo sentido.

    Antes la cola solo traia las visibles, asi que una valoracion escondida por
    error no se podia volver a encontrar sin haber apuntado su identificador a
    mano, y el boton de restaurar de la pantalla era codigo muerto.
    """
    resena_id, _, _, _, _ = await resena_puesta(sesiones, monkeypatch)
    moderador = await persona(sesiones, "mod-a1")

    async with sesiones() as db:
        await resenas.moderar(
            db, resena_id=resena_id, actor_id=moderador, esconder=True, motivo="x"
        )
        await db.commit()

    async with sesiones() as db:
        visibles = [r.id for r in await resenas.para_moderar(db)]
        escondidas = [
            r.id for r in await resenas.para_moderar(db, escondidas=True)
        ]
    assert resena_id not in visibles
    assert resena_id in escondidas, "una escondida no se puede volver a encontrar"

    async with sesiones() as db:
        await resenas.moderar(
            db, resena_id=resena_id, actor_id=moderador, esconder=False
        )
        await db.commit()
    async with sesiones() as db:
        fila = await db.get(ProductReview, resena_id)
        visibles = [r.id for r in await resenas.para_moderar(db)]
    assert fila.status == "visible"
    assert resena_id in visibles


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_las_tres_bandejas_paginan(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """EL ALTO A2. Sin cursor topaban en veinte y no habia forma de pedir mas.

    Se prueba con paginas de UNA: lo que hay que demostrar es que el cursor
    existe y avanza, no que veintiuna filas caben en dos paginas.
    """
    from tests.test_productos_carrito import con_existencias, variantes_de
    from tests.test_productos_catalogo import publicado

    producto_id, version_id, quien = await publicado(sesiones)
    variantes = await variantes_de(sesiones, version_id)
    await con_existencias(sesiones, producto_id, variantes[0].sku, 20)
    tres = [
        await entregado_del_mismo(
            sesiones, monkeypatch, producto_id, variantes[0], quien
        )
        for _ in range(3)
    ]

    #: LA DEL PROVEEDOR.
    async with sesiones() as db:
        primera = await resenas.del_proveedor(db, usuario_id=quien, limite=1)
    assert len(primera) == 1
    cursor = (primera[0].created_at, primera[0].id)
    async with sesiones() as db:
        segunda = await resenas.del_proveedor(
            db, usuario_id=quien, antes_de=cursor, limite=5
        )
    vistas = [r.id for r in primera] + [r.id for r in segunda]
    assert len(vistas) == len(set(vistas)), "la bandeja repitio una valoracion"
    assert set(tres) <= set(vistas), "la bandeja se salto una valoracion"

    #: LA COLA DE MODERACION.
    async with sesiones() as db:
        primera = await resenas.para_moderar(db, limite=1)
    assert len(primera) == 1
    cursor = (primera[0].created_at, primera[0].id)
    async with sesiones() as db:
        segunda = await resenas.para_moderar(db, antes_de=cursor, limite=50)
    ids = [r.id for r in primera] + [r.id for r in segunda]
    assert len(ids) == len(set(ids))
    assert primera[0].id not in [r.id for r in segunda]

    #: Y LA DE QUIEN OPINO.
    async with sesiones() as db:
        autor = primera[0].author_id
        suyas = await resenas.mias(db, usuario_id=autor, limite=1)
    assert len(suyas) == 1
    async with sesiones() as db:
        despues = await resenas.mias(
            db,
            usuario_id=autor,
            antes_de=(suyas[0].created_at, suyas[0].id),
            limite=5,
        )
    assert suyas[0].id not in [r.id for r in despues]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_moderaciones_a_la_vez_dejan_UNA_fila_de_historial(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """EL MEDIO M3. El candado de fila, demostrado con una barrera.

    Sin el, las dos leian `visible` antes de que ninguna escribiera y el
    historial —que un disparador protege para que solo se anada— acababa
    contando dos veces el mismo paso, con dos actores y dos motivos: quien
    auditara despues no podia distinguir «se escondio dos veces» de «dos
    personas pulsaron a la vez».

    LA BARRERA ES LA PRUEBA: con candado, la segunda NO PUEDE leer hasta que la
    primera suelta, asi que se comprueba que se queda esperando.
    """
    resena_id, _, _, _, _ = await resena_puesta(sesiones, monkeypatch)
    uno = await persona(sesiones, "mod-m3-uno")
    dos = await persona(sesiones, "mod-m3-dos")

    empezo = asyncio.Event()
    suelta = asyncio.Event()

    async def primera():
        async with sesiones() as db:
            await db.get(ProductReview, resena_id, with_for_update=True)
            empezo.set()
            await suelta.wait()
            await resenas.moderar(
                db, resena_id=resena_id, actor_id=uno, esconder=True, motivo="uno"
            )
            await db.commit()

    async def segunda():
        await empezo.wait()
        async with sesiones() as db:
            await resenas.moderar(
                db, resena_id=resena_id, actor_id=dos, esconder=True, motivo="dos"
            )
            await db.commit()

    tarea_uno = asyncio.create_task(primera())
    tarea_dos = asyncio.create_task(segunda())
    await empezo.wait()
    await asyncio.sleep(0.5)
    assert not tarea_dos.done(), "la segunda no espero: no hay candado de fila"
    suelta.set()
    await asyncio.gather(tarea_uno, tarea_dos)

    async with sesiones() as db:
        filas = list(
            await db.scalars(
                select(ProductReviewModeration).where(
                    ProductReviewModeration.review_id == resena_id
                )
            )
        )
        fila = await db.get(ProductReview, resena_id)
    assert fila.status == "hidden"
    assert len(filas) == 1, (
        f"el historial cuenta {len(filas)} pasos y solo hubo uno: "
        f"{[(f.from_status, f.to_status) for f in filas]}"
    )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_edita_mientras_se_modera(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """EL MEDIO M1. Con candado, editar y moderar no se cruzan.

    Sin el, el moderador acababa escondiendo un texto DISTINTO del que juzgo,
    con un motivo que ya no se referia a nada. Lo reprodujo la revision
    independiente.
    """
    resena_id, comprador, _, _, _ = await resena_puesta(sesiones, monkeypatch)
    moderador = await persona(sesiones, "mod-m1")
    nuevo = "Lo he cambiado mientras lo estaban mirando."

    empezo = asyncio.Event()
    suelta = asyncio.Event()

    async def moderando():
        async with sesiones() as db:
            await db.get(ProductReview, resena_id, with_for_update=True)
            empezo.set()
            await suelta.wait()
            await resenas.moderar(
                db, resena_id=resena_id, actor_id=moderador, esconder=True, motivo="spam"
            )
            await db.commit()

    async def editando():
        await empezo.wait()
        async with sesiones() as db:
            await resenas.editar(
                db, resena_id=resena_id, usuario_id=comprador, comentario=nuevo
            )
            await db.commit()

    tarea_mod = asyncio.create_task(moderando())
    tarea_edit = asyncio.create_task(editando())
    await empezo.wait()
    await asyncio.sleep(0.5)
    assert not tarea_edit.done(), "la edicion no espero: no hay candado de fila"
    suelta.set()
    salidas = await asyncio.gather(tarea_mod, tarea_edit, return_exceptions=True)

    async with sesiones() as db:
        fila = await db.get(ProductReview, resena_id)
    assert fila.status == "hidden"
    #: LA EDICION TIENE QUE HABER FALLADO: cuando le toco, la valoracion ya
    #: estaba escondida, y una escondida no se edita.
    fallos = [s for s in salidas if isinstance(s, AppError)]
    assert len(fallos) == 1, f"la edicion se colo: {salidas}"
    assert fallos[0].details.get("reason") == "hidden"
    assert nuevo not in (fila.comment or ""), (
        "se escondio un texto distinto del que se juzgo"
    )


async def segundo_producto_del_mismo(sesiones, quien: str, evaluador: str):
    """Otro producto publicado, DEL MISMO proveedor.

    `publicado` crea una tienda nueva cada vez, y para medir el N+1 hacen falta
    dos productos distintos en el MISMO pedido: con uno solo, preguntar el dueno
    en bucle y preguntarlo en lote hacen exactamente una consulta y la mutacion
    sobrevive sin que nada cambie.
    """
    from app.modules.products import evaluations, service
    from app.modules.products import states as maquina
    from tests.test_productos_admision import evaluar_completo
    from tests.test_productos_dominio import DATOS, VARIANTES, foto_aprobada

    async with sesiones() as db:
        producto, version = await service.crear(
            db,
            usuario_id=quien,
            datos={**DATOS, "name": "Tabla de cortar de nogal"},
            variantes=VARIANTES,
        )
        await db.commit()
        producto_id, version_id = producto.id, version.id

    await foto_aprobada(sesiones, version_id, quien=evaluador)
    async with sesiones() as db:
        for hasta, rol in (
            ("submitted", maquina.PROVEEDOR),
            ("document_review", maquina.EVALUADOR),
            ("evaluation", maquina.EVALUADOR),
        ):
            await service.transicionar(
                db,
                producto_id=producto_id,
                hasta=hasta,
                actor_id=evaluador,
                actor_rol=rol,
            )
        await db.commit()

    ident = await evaluar_completo(sesiones, version_id, evaluador, nota=95)
    async with sesiones() as db:
        evidencias = [
            e.id for e in await evaluations.evidencia_de(db, evaluacion_id=ident)
        ]
        await evaluations.elegir_razones(
            db,
            evaluacion_id=ident,
            usuario_id=evaluador,
            razones=[
                {"evidence_id": e, "text": f"Razón respaldada número {i}."}
                for i, e in enumerate(evidencias[:3])
            ],
        )
        await evaluations.decidir(db, evaluacion_id=ident, usuario_id=evaluador)
        await db.commit()
    async with sesiones() as db:
        await service.publicar(db, producto_id=producto_id, usuario_id=evaluador)
        await db.commit()
    return producto_id, version_id


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_las_lineas_valorables_no_preguntan_el_dueno_producto_a_producto(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """EL BAJO B-1. El docstring prometia una sola consulta y hacia N.

    CON DOS PRODUCTOS DEL MISMO PROVEEDOR, que es el caso que existe: un pedido
    es de una sola tienda, pero esa tienda puede tener dos cosas en la misma
    bolsa. Con uno solo, el bucle y el lote hacen exactamente una consulta y la
    mutacion sobrevive sin que nada cambie.
    """
    from sqlalchemy import event

    from tests.test_productos_carrito import con_existencias, variantes_de
    from tests.test_productos_catalogo import publicado

    primero, version_uno, quien = await publicado(sesiones)
    evaluador = await persona(sesiones, "adm-n1", rol="admin")
    segundo, version_dos = await segundo_producto_del_mismo(
        sesiones, quien, evaluador
    )

    variantes_uno = await variantes_de(sesiones, version_uno)
    variantes_dos = await variantes_de(sesiones, version_dos)
    await con_existencias(sesiones, primero, variantes_uno[0].sku, 5)
    await con_existencias(sesiones, segundo, variantes_dos[0].sku, 5)

    comprador = await persona(sesiones, "n1-compra")
    async with sesiones() as db:
        await carts.anadir(
            db,
            usuario_id=comprador,
            producto_id=primero,
            variante_id=variantes_uno[0].id,
            cantidad=1,
        )
        await carts.anadir(
            db,
            usuario_id=comprador,
            producto_id=segundo,
            variante_id=variantes_dos[0].id,
            cantidad=1,
        )
        await db.commit()
    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
        seller_id = bolsa.items[0].seller_id

    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    orden_id = creado.orden.id

    from app.modules.products import envios, estados_de_envio, pagos, pedidos

    monkeypatch.setattr(pagos, "get_provider", lambda _n: PasarelaDeMentira())
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await pagos.iniciar_pago(db, orden=orden, correo="x@y.test")
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await pagos.atender_aviso(
            db, AvisoDeMentira(purchase_id=orden.id, amount_minor=int(orden.total_minor))
        )
        await db.commit()
    await preparar_entero(sesiones, orden_id, quien)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.despachar(db, orden=orden, actor_id=quien)
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.registrar_entrega(
            db, orden=orden, actor_id=quien, actor_rol=estados_de_envio.PROVEEDOR
        )
        await db.commit()

    async with sesiones() as db:
        lineas = await pedidos.lineas_de(db, orden_id)
    assert len({l.product_id for l in lineas}) == 2, "el montaje necesita dos productos"

    consultas: list[str] = []
    async with sesiones() as db:
        conexion = await db.connection()
        motor_sync = conexion.sync_connection.engine

        def contar(conn, cursor, statement, params, context, many):  # noqa: ANN001
            if "product_sellers" in statement:
                consultas.append(statement)

        event.listen(motor_sync, "before_cursor_execute", contar)
        try:
            valorables = await resenas.valorables_del_pedido(
                db, orden_id=orden_id, usuario_id=comprador
            )
        finally:
            event.remove(motor_sync, "before_cursor_execute", contar)

    assert len(valorables) == 2
    assert len(consultas) == 1, (
        f"se pregunto el dueno {len(consultas)} veces para dos productos, "
        "y con una basta"
    )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_envio_con_fecha_pero_sin_estado_entregado_no_deja_valorar(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """LA FRAGILIDAD QUE SENALO LA REVISION.

    Mirar solo `delivered_at` es correcto HOY porque `DELIVERED` es terminal. El
    dia que alguien anada una transicion que salga de ahi sin limpiar la fecha,
    mirar solo la fecha dejaria de significar «entregado». Se comprueban las dos
    cosas, y esta prueba lo demuestra retorciendo la fila del envio.
    """
    _, _, comprador, orden_id, _ = await pedido_entregado(sesiones, monkeypatch)
    linea = await linea_de(sesiones, orden_id)
    async with sesiones() as db:
        #: La fecha se queda; el estado se mueve. Es lo que pasaria si algun dia
        #: hubiera un salto que saliera de «entregado».
        await db.execute(
            text(
                "update product_shipments set status = 'DELIVERY_FAILED',"
                " failed_at = now(), failure_reason = 'nadie abrio' where order_id = :o"
            ),
            {"o": orden_id},
        )
        await db.commit()
    async with sesiones() as db:
        puede, motivo, _ = await resenas.puede_resenar(
            db, order_item_id=linea.id, usuario_id=comprador
        )
    assert not puede
    assert motivo == "not_delivered"
