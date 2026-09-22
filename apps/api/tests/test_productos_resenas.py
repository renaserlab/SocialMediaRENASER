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
    malas = [s for s in salidas if isinstance(s, Exception)]
    assert len(buenas) == 1, f"las dos escribieron: {salidas}"
    assert len(malas) == 1

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
async def test_sin_la_0081_las_resenas_contestan_503(sesiones, monkeypatch, venta_encendida) -> None:
    """503 CON CODIGO ESTABLE. No 404, que haria pensar que la ruta esta mal
    escrita, ni 500, que haria pensar que algo se rompio."""
    monkeypatch.setattr(esquema, "hay_resenas", lambda _db: _no())
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await resenas.exigir_disponible(db)
    assert fallo.value.status_code == 503
    assert fallo.value.code == "product_reviews_not_available"

    #: Y EL RESUMEN NO SE CAE: contesta vacio, porque es un bloque de la ficha
    #: y tumbar la ficha entera por esto seria peor.
    async with sesiones() as db:
        resumen = await resenas.resumen(db, producto_id=str(uuid.uuid4()))
    assert resumen.total == 0
    assert resumen.promedio is None


async def _no() -> bool:
    return False


# =========================================================================== #
# 10. Lo que el codigo NO puede hacer
# =========================================================================== #
def test_ninguna_ruta_de_proveedor_escribe_la_resena() -> None:
    """MODERAR ES ESCONDER Y RESPONDER ES RESPONDER.

    Se recorre el arbol de sintaxis del router: ninguna funcion cuyo nombre
    hable del proveedor puede asignar `overall`, `comment`, `status` ni
    `author_id` sobre una resena.
    """
    import ast
    import pathlib

    ruta = (
        pathlib.Path(__file__).resolve().parents[1]
        / "app"
        / "modules"
        / "products"
        / "router.py"
    )
    arbol = ast.parse(ruta.read_text(encoding="utf-8"))
    prohibidos = {"overall", "comment", "status", "author_id", "moderated_at"}
    for nodo in ast.walk(arbol):
        if not isinstance(nodo, (ast.AsyncFunctionDef, ast.FunctionDef)):
            continue
        if "resena" not in nodo.name and "review" not in nodo.name:
            continue
        if "moderar" in nodo.name or "cola" in nodo.name or "historial" in nodo.name:
            continue
        for hijo in ast.walk(nodo):
            if isinstance(hijo, ast.Attribute) and isinstance(hijo.ctx, ast.Store):
                assert hijo.attr not in prohibidos, f"{nodo.name} escribe {hijo.attr}"


def test_el_servicio_no_sabe_de_dinero() -> None:
    """UNA RESENA NO MUEVE NI UN CENTIMO, y no importa nada que lo haga.

    Si alguien anade el import, hace falta una decision en vez de que aparezca
    solo.
    """
    import ast
    import pathlib

    ruta = (
        pathlib.Path(__file__).resolve().parents[1]
        / "app"
        / "modules"
        / "products"
        / "resenas.py"
    )
    arbol = ast.parse(ruta.read_text(encoding="utf-8"))
    for nodo in ast.walk(arbol):
        if isinstance(nodo, ast.ImportFrom) and nodo.module:
            assert "pagos" not in nodo.module, nodo.module
            assert "refund" not in nodo.module, nodo.module
            assert "finanzas" not in nodo.module, nodo.module
            assert "inventory" not in nodo.module, nodo.module
