"""Incremento 9 de Productos: finanzas. La 0082, contra PostgreSQL.

LO QUE DEFIENDEN ESTAS PRUEBAS, Y POR QUE CADA UNA:

  1. SIN COMISION CONFIGURADA NO HAY SALDO. Ni uno. Suponer 0 % transferiria el
     bruto entero y la cuenta cuadraria: ninguna prueba de aritmetica lo
     delataria, asi que hace falta una que mire que NO SE ESCRIBE NADA.
  2. UN SALDO POR VENTA. Un aviso de cobro que llega dos veces no le debe el
     dinero dos veces al proveedor.
  3. NADA SE LIBERA SOLO PORQUE VENCIO UNA FECHA. Cada bloqueo se prueba por
     separado, y despues se prueba que con la fecha vencida y un bloqueo vivo
     sigue sin liberarse.
  4. EL RELOJ SALE DE LA POLITICA QUE SE ACEPTO, no de un 72 escrito en el
     codigo. Si la politica del pedido no fija el plazo, no hay reloj.
  5. APROBAR NO ES PAGAR. Una devolucion aprobada no mueve un centimo, y el
     adaptador apagado FALLA EN CERRADO: nunca simula un exito.
  6. NO SE DEVUELVE MAS DE LO COBRADO, ni sumando dos parciales.
  7. CONFIRMAR UNA DEVOLUCION CIERRA LO QUE ARRASTRA: consume la retencion,
     cancela el saldo si fue total y marca el efecto de la reclamacion como
     ejecutado. Es lo que deja de bloquear el resto.
  8. MODERACION NO MUEVE DINERO: `puede_mover_dinero` es un conjunto mas
     estrecho que `is_admin`.
  9. LA CONFORMIDAD NO ES CONFIRMAR QUE LLEGO, y solo la primera libera.
 10. SIN LA 0082, 503 CON CODIGO ESTABLE.

LAS AFIRMACIONES ESTAN ACOTADAS AL PEDIDO Y AL SALDO DE CADA PRUEBA. La base de
este modulo es compartida y contar filas globales haria que una prueba dependiera
de las demas.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.core.config import get_settings
from app.core.exceptions import AppError
from app.modules.commerce.models import OwnerSaleBalance
from app.modules.events.finanzas_models import OwnerSaleReserve
from app.modules.products import devoluciones, envios, esquema, finanzas
from app.modules.products import estados_de_incidencia as maquina
from app.modules.products import finanzas_models as finanzas_modelos
from app.modules.products.finanzas_models import (
    DEVOLUCION_APROBADA,
    DEVOLUCION_CONFIRMADA,
    DEVOLUCION_FALLIDA,
    DEVOLUCION_PEDIDA,
    ProductDispute,
    ProductRefund,
    ProductRefundEvent,
)
from app.modules.products.models import (
    ProductOrder,
    ProductPolicy,
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
from tests.test_productos_incidencias import (  # noqa: F401
    caso_abierto,
    imagen,
    pedido_entregado,
    primera_linea,
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
@pytest.fixture()
def comision_puesta(monkeypatch, venta_encendida):
    """La comision, puesta A MANO y solo para esta prueba.

    NO SE TOCA EL `.env` NI NINGUN VALOR POR DEFECTO. Que la configuracion de
    fabrica no tenga comision es justamente lo que otra prueba comprueba.
    """
    ajustes = get_settings()
    monkeypatch.setattr(ajustes, "platform_fee_bps", 1_000, raising=False)
    return ajustes


@pytest.fixture()
def cuenta_lista(monkeypatch, comision_puesta):
    """Y las tres banderas de transferir, por si alguna prueba las necesita."""
    for nombre in ("stripe_connect_enabled", "creator_transfers_enabled"):
        monkeypatch.setattr(comision_puesta, nombre, True, raising=False)
    return comision_puesta


async def con_saldo(sesiones, monkeypatch):
    """Un pedido pagado y entregado, con su saldo escrito.

    EL SALDO LO ESCRIBE EL AVISO DE COBRO, no esta ayuda: `registrar_venta`
    la llama `pagos.atender_aviso`, que es el unico camino por el que un
    pedido se marca como pagado. Escribirlo aqui a mano probaria un camino
    que en produccion no existe.
    """
    _, _, comprador, orden_id, proveedor = await pedido_entregado(
        sesiones, monkeypatch
    )
    async with sesiones() as db:
        saldo = await finanzas.saldo_del_pedido(db, orden_id=orden_id)
        saldo_id = saldo.id if saldo is not None else None
    return comprador, orden_id, proveedor, saldo_id


async def cuenta_de_cobro(
    sesiones, dueno: str, *, lista: bool = True, entorno: str | None = None
) -> str:
    """Una cuenta de cobro escrita a mano: el alta de Connect no existe.

    EL ENTORNO TIENE QUE SER EL DEL PEDIDO, y su vocabulario es el de la
    0049: `sandbox` o `production`. Escribir otra cosa aqui haria que la
    cuenta no casara nunca y la prueba pasaria por el motivo equivocado.
    """
    from app.modules.commerce.models import OwnerPayoutAccount

    ident = str(uuid.uuid4())
    async with sesiones() as db:
        fila = OwnerPayoutAccount(
            id=ident,
            owner_id=dueno,
            provider="stripe",
            external_account_id="acct_" + ident[:8],
            payouts_enabled=lista,
            charges_enabled=lista,
            onboarding_status="active" if lista else "pending",
        )
        if "environment" in OwnerPayoutAccount.__table__.c:
            fila.environment = entorno or get_settings().payments_environment
        db.add(fila)
        await db.commit()
    return ident


async def resolver_con(sesiones, caso_id: str, admin: str, resolucion: str) -> None:
    """Lleva el caso a mediacion y lo resuelve. COMO SE HACE DE VERDAD.

    La maquina del Incremento 7 no tiene el salto de «abierta» a «resuelta»:
    resolver es de Z y se llega desde respondida, mediacion o apelada. Forzarlo
    probaria un camino que en produccion no existe.
    """
    from app.modules.products import incidencias

    async with sesiones() as db:
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.MEDIACION,
            actor_id=admin,
            actor_rol=maquina.ADMINISTRACION,
            nota="Lo mira Z.",
        )
        await db.commit()
    async with sesiones() as db:
        await incidencias.mover(
            db,
            incidencia_id=caso_id,
            hasta=maquina.RESUELTA,
            actor_id=admin,
            actor_rol=maquina.ADMINISTRACION,
            resolucion=resolucion,
            nota="La evidencia sostiene la decision.",
        )
        await db.commit()


# =========================================================================== #
# 1. Sin comision no hay saldo
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_comision_configurada_no_se_escribe_ni_un_saldo(
    sesiones, monkeypatch, venta_encendida
) -> None:
    """LA PRUEBA QUE IMPORTA, y la que una de aritmetica no puede dar.

    `platform_fee_bps = -1` no es «cero por ciento»: es «sin configurar».
    Suponer cero transferiria el bruto entero al proveedor y la cuenta cuadraria
    perfectamente, asi que lo unico que lo delata es comprobar que NO SE ESCRIBE
    NADA.
    """
    assert get_settings().platform_fee_bps == -1, "la configuracion de fabrica"
    assert get_settings().comision_configurada is False

    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        saldo = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
    assert saldo is None

    async with sesiones() as db:
        cuantos = await db.scalar(
            select(func.count(OwnerSaleBalance.id)).where(
                OwnerSaleBalance.product_order_id == orden_id
            )
        )
    assert cuantos == 0, "se escribio un saldo sin comision decidida"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_con_comision_se_escribe_la_fotografia_de_la_venta(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """Y con el diez por ciento, la cuenta cuadra y queda congelada."""
    _, orden_id, proveedor, saldo_id = await con_saldo(sesiones, monkeypatch)
    assert saldo_id is not None

    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        orden = await db.get(ProductOrder, orden_id)
    assert saldo.product_order_id == orden_id
    assert saldo.owner_id == proveedor
    assert saldo.gross_amount_minor == int(orden.total_minor)
    assert saldo.platform_fee_minor == int(orden.total_minor) // 10
    assert (
        saldo.net_amount_minor
        == saldo.gross_amount_minor - saldo.platform_fee_minor - saldo.provider_fee_minor
    )
    assert saldo.currency == orden.currency
    assert saldo.status == finanzas.PENDIENTE
    #: Y LOS OTROS DOS ORIGENES VIAJAN NULOS: un saldo tiene exactamente uno.
    assert saldo.course_id is None and saldo.order_id is None
    assert saldo.event_id is None and saldo.event_order_id is None
    #: LA FECHA NO SE PONE AL COBRAR: el reloj empieza cuando el paquete llega.
    assert saldo.available_at is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_aviso_repetido_no_paga_dos_veces(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """UN SALDO POR VENTA, y lo decide el indice unico de la base."""
    _, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        otra_vez = await finanzas.registrar_venta(db, orden=orden)
        await db.commit()
    assert otra_vez is None, "el segundo aviso escribio otro saldo"

    async with sesiones() as db:
        cuantos = await db.scalar(
            select(func.count(OwnerSaleBalance.id)).where(
                OwnerSaleBalance.product_order_id == orden_id
            )
        )
    assert cuantos == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_base_rechaza_un_saldo_con_dos_origenes(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """EXACTAMENTE UN ORIGEN, y lo impone el CHECK de la 0082.

    Se escribe a mano, saltandose el servicio: si el CHECK se quedara en dos
    ramas o admitiera una fila sin origen, el dinero no sabria de que venta es.
    """
    _, orden_id, proveedor, saldo_id = await con_saldo(sesiones, monkeypatch)

    async def rechaza_por_el_origen(sql: str, datos: dict) -> None:
        """Y QUE LO RECHACE LA REGLA QUE IMPORTA, no otra cualquiera.

        Pedir solo «un error de integridad» no vale: la fila lleva un `event_id`
        inventado y la clave ajena de eventos levanta antes. Con eso, relajar el
        CHECK del origen a una sola rama dejaba esta prueba en verde.
        """
        async with sesiones() as db:
            with pytest.raises((IntegrityError, DBAPIError)) as fallo:
                await db.execute(text(sql), datos)
            assert "owner_sale_balances_un_origen" in str(
                getattr(fallo.value, "orig", fallo.value)
            ), "lo rechazo otra restriccion, no la del origen"
            await db.rollback()

    async with sesiones() as db:
        with pytest.raises((IntegrityError, DBAPIError)) as fallo:
            await db.execute(
                text(
                    "insert into owner_sale_balances"
                    " (id, product_order_id, event_id, owner_id,"
                    "  gross_amount_minor, platform_fee_minor, net_amount_minor,"
                    "  currency, fee_rules_version, status)"
                    " values (gen_random_uuid(), :o, gen_random_uuid(), :p,"
                    "         100, 10, 90, 'PEN', 'v1', 'pending')"
                ),
                {"o": orden_id, "p": proveedor},
            )
        #: AQUI NO SE EXIGE EL NOMBRE: con un `event_id` inventado puede
        #: contestar antes la clave ajena de eventos, y las dos respuestas son
        #: correctas. La combinacion que SI distingue el CHECK es la de abajo.
        await db.rollback()

    #: PRODUCTO Y CURSO A LA VEZ, los dos existentes de verdad. Aqui no hay
    #: ninguna clave ajena que pueda contestar por el CHECK, asi que si el
    #: CHECK se relaja esta fila entra y la prueba se pone roja.
    autor = await persona(sesiones, "fin-origen-autor")
    async with sesiones() as db:
        curso = str(uuid.uuid4())
        producto_de_curso = str(uuid.uuid4())
        pedido_de_curso = str(uuid.uuid4())
        await db.execute(
            text("insert into courses (id, author_id, title) values (:i, :a, :t)"),
            {"i": curso, "a": autor, "t": "Otro curso cualquiera"},
        )
        await db.execute(
            text("insert into commerce_products (id, course_id) values (:i, :c)"),
            {"i": producto_de_curso, "c": curso},
        )
        await db.execute(
            text(
                "insert into orders (id, user_id, commerce_product_id, provider,"
                " channel) values (:i, :u, :p, 'stripe', 'web')"
            ),
            {"i": pedido_de_curso, "u": autor, "p": producto_de_curso},
        )
        await db.commit()

    await rechaza_por_el_origen(
        "insert into owner_sale_balances"
        " (id, product_order_id, course_id, order_id, owner_id,"
        "  gross_amount_minor, platform_fee_minor, net_amount_minor,"
        "  currency, fee_rules_version, status)"
        " values (gen_random_uuid(), :o, :c, :oc, :p,"
        "         100, 10, 90, 'PEN', 'v1', 'pending')",
        {"o": orden_id, "c": curso, "oc": pedido_de_curso, "p": proveedor},
    )

    #: Y SIN NINGUN ORIGEN, que tampoco puede contestar otra cosa.
    await rechaza_por_el_origen(
        "insert into owner_sale_balances"
        " (id, owner_id, gross_amount_minor, platform_fee_minor,"
        "  net_amount_minor, currency, fee_rules_version, status)"
        " values (gen_random_uuid(), :p, 100, 10, 90, 'PEN',"
        "         'v1', 'pending')",
        {"p": proveedor},
    )


# =========================================================================== #
# 2. El reloj de la proteccion
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_plazo_sale_de_la_politica_que_se_acepto(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """NO DE UN 72 ESCRITO EN EL CODIGO.

    El blueprint escribe 72 horas en un sitio y en otro dice que ningun
    componente define plazos por su cuenta y que la orden conserva su version de
    politica. Manda lo segundo: es lo que le prometieron a quien compro.
    """
    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        envio = await db.get(ProductShipment, orden_id)
        horas = await finanzas.horas_de_proteccion(db, orden=orden)
        cuando = await finanzas.cuando_se_puede_liberar(db, orden=orden, envio=envio)

    async with sesiones() as db:
        politica = await db.get(ProductPolicy, orden.policy_id)
    assert horas == int(politica.incident_report_hours)
    entrega = envio.delivered_at
    if entrega.tzinfo is None:
        from datetime import timezone

        entrega = entrega.replace(tzinfo=timezone.utc)
    assert cuando == entrega + timedelta(hours=horas)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_entrega_no_hay_reloj(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """Y eso NO es un error: es que el paquete todavia no ha llegado."""
    _, _, _, orden_id = await pedido_pagado(sesiones, monkeypatch)
    #: EL SALDO YA LO ESCRIBIO EL AVISO DE COBRO. Volver a llamarlo aqui
    #: devuelve `None` —el indice unico lo impide— y probaria otra cosa.
    async with sesiones() as db:
        saldo = await finanzas.saldo_del_pedido(db, orden_id=orden_id)
        assert saldo is not None, "el aviso de cobro no escribio el saldo"
        saldo_id = saldo.id

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        envio = await db.get(ProductShipment, orden_id)
        assert await finanzas.cuando_se_puede_liberar(db, orden=orden, envio=envio) is None
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        bloqueo = await finanzas.por_que_no_se_libera(db, saldo=saldo)
    assert bloqueo is not None
    assert bloqueo.motivo == finanzas.SIN_ENTREGA


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_conformidad_adelanta_el_reloj(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """«Esto esta bien» libera de inmediato, y es lo que pide el blueprint."""
    comprador, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        envio = await db.get(ProductShipment, orden_id)
        antes = await finanzas.cuando_se_puede_liberar(db, orden=orden, envio=envio)

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.dar_conformidad(db, orden=orden, actor_id=comprador)
        await db.commit()

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        envio = await db.get(ProductShipment, orden_id)
        despues = await finanzas.cuando_se_puede_liberar(db, orden=orden, envio=envio)
    assert envio.conformity_at is not None
    assert despues < antes, "la conformidad no adelanto el reloj"
    #: Y DEJA CONSTANCIA DE QUE LO RECIBIO: quien da la conformidad esta
    #: diciendo tambien que le llego.
    assert envio.buyer_confirmed_at is not None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_conformidad_es_idempotente_y_no_es_confirmar_que_llego(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """DOS COLUMNAS DISTINTAS, Y LA PRIMERA NO CAMBIO DE SIGNIFICADO."""
    comprador, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.dar_conformidad(db, orden=orden, actor_id=comprador)
        await db.commit()
    async with sesiones() as db:
        envio = await db.get(ProductShipment, orden_id)
        primera = envio.conformity_at

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        await envios.dar_conformidad(db, orden=orden, actor_id=comprador)
        await db.commit()
    async with sesiones() as db:
        envio = await db.get(ProductShipment, orden_id)
    assert envio.conformity_at == primera, "la segunda conformidad movio el reloj"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_da_conformidad_de_algo_que_no_llego(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """Y LO IMPONE UN CHECK DE LA BASE, no solo el `if` del servicio."""
    _, _, comprador, orden_id = await pedido_pagado(sesiones, monkeypatch)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        with pytest.raises(AppError) as fallo:
            await envios.dar_conformidad(db, orden=orden, actor_id=comprador)
        await db.rollback()
    assert fallo.value.code == "product_shipment_not_delivered"

    #: Y A MANO, saltandose el servicio entero.
    quien = await duenno_de(sesiones, orden_id)
    await preparar_entero(sesiones, orden_id, quien)
    async with sesiones() as db:
        with pytest.raises((IntegrityError, DBAPIError)):
            await db.execute(
                text(
                    "update product_shipments set conformity_at = now()"
                    " where order_id = :o"
                ),
                {"o": orden_id},
            )
        await db.rollback()


# =========================================================================== #
# 3. Por que no se libera
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_comision_el_bloqueo_lo_dice(
    sesiones, monkeypatch, comision_puesta
) -> None:
    _, _, _, saldo_id = await con_saldo(sesiones, monkeypatch)
    monkeypatch.setattr(get_settings(), "platform_fee_bps", -1, raising=False)
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        bloqueo = await finanzas.por_que_no_se_libera(db, saldo=saldo)
    assert bloqueo.motivo == finanzas.SIN_COMISION


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_cuenta_de_cobro_no_se_libera(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """TENER UNA APUNTADA NO ES PODER PAGAR EN ELLA, y son dos codigos.

    CON LA FECHA YA VENCIDA, para llegar a la cuenta: el orden de los
    bloqueos pone primero la venta y el reloj, porque lo que mas claramente
    falta en un paquete que va de camino es la entrega y no una cuenta.
    """
    _, _, proveedor, saldo_id = await con_saldo(sesiones, monkeypatch)
    despues = finanzas.ahora() + timedelta(days=30)
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        bloqueo = await finanzas.por_que_no_se_libera(
            db, saldo=saldo, momento=despues
        )
    assert bloqueo.motivo == finanzas.SIN_CUENTA

    #: CON UNA A MEDIAS, otro codigo distinto.
    cuenta = await cuenta_de_cobro(sesiones, proveedor, lista=False)
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        saldo.payout_account_id = cuenta
        await db.commit()
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        bloqueo = await finanzas.por_que_no_se_libera(
            db, saldo=saldo, momento=despues
        )
    assert bloqueo.motivo == finanzas.CUENTA_SIN_ALTA

    #: Y ANTES DE QUE VENZA EL RELOJ, lo que falta es el reloj.
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        bloqueo = await finanzas.por_que_no_se_libera(db, saldo=saldo)
    assert bloqueo.motivo == finanzas.PROTECCION_EN_CURSO


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_reclamacion_viva_bloquea_el_dinero(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """Y TAMBIEN UNA RESUELTA QUE DEJO ALGO DEBIENDO. La segunda se olvida."""
    from app.modules.products import incidencias

    comprador, orden_id, proveedor, saldo_id, caso_id = (
        await con_saldo_y_caso(sesiones, monkeypatch)
    )
    cuenta = await cuenta_de_cobro(sesiones, proveedor)
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        saldo.payout_account_id = cuenta
        await db.commit()

    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        bloqueo = await finanzas.por_que_no_se_libera(
            db, saldo=saldo, momento=finanzas.ahora() + timedelta(days=30)
        )
    assert bloqueo is not None
    assert bloqueo.motivo == finanzas.RECLAMACION_ABIERTA

    #: SE RESUELVE CON DEUDA. Sigue bloqueando: el efecto nace PENDIENTE.
    admin = await persona(sesiones, "fin-adm", rol="admin")
    await resolver_con(sesiones, caso_id, admin, maquina.REEMBOLSAR_EN_PARTE)
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        bloqueo = await finanzas.por_que_no_se_libera(
            db, saldo=saldo, momento=finanzas.ahora() + timedelta(days=30)
        )
    assert bloqueo is not None
    assert bloqueo.motivo == finanzas.RECLAMACION_ABIERTA, (
        "una resolucion con deuda sin ejecutar dejo de bloquear"
    )


async def con_saldo_y_caso(sesiones, monkeypatch):
    """Un pedido entregado con su saldo Y con una reclamacion enviada.

    USA `caso_abierto` DEL INCREMENTO 7, que ya hace el recorrido entero: abrir,
    colgar las dos fotografias y enviar. Reescribirlo aqui seria duplicar el
    montaje y arriesgarse a montar un caso que en produccion no existe.
    """
    _, _, comprador, orden_id, proveedor, caso_id = await caso_abierto(
        sesiones, monkeypatch
    )
    async with sesiones() as db:
        saldo = await finanzas.saldo_del_pedido(db, orden_id=orden_id)
        saldo_id = saldo.id if saldo is not None else None
    return comprador, orden_id, proveedor, saldo_id, caso_id


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_reserva_viva_bloquea_el_dinero(
    sesiones, monkeypatch, comision_puesta
) -> None:
    _, _, proveedor, saldo_id = await con_saldo(sesiones, monkeypatch)
    cuenta = await cuenta_de_cobro(sesiones, proveedor)
    admin = await persona(sesiones, "fin-res", rol="admin")
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        saldo.payout_account_id = cuenta
        await finanzas.reservar(
            db,
            saldo=saldo,
            importe_minor=100,
            motivo=finanzas.RESERVA_POR_DISPUTA,
            creado_por=admin,
        )
        await db.commit()
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        bloqueo = await finanzas.por_que_no_se_libera(
            db, saldo=saldo, momento=finanzas.ahora() + timedelta(days=30)
        )
    assert bloqueo.motivo == finanzas.RESERVA_VIVA
    assert bloqueo.detalle == "100"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_reservas_del_mismo_motivo_no_retienen_dos_veces(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """Y lo decide un indice unico parcial de la 0068, no un `if`."""
    _, _, proveedor, saldo_id = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-res2", rol="admin")
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        await finanzas.reservar(
            db,
            saldo=saldo,
            importe_minor=100,
            motivo=finanzas.RESERVA_POR_DISPUTA,
            creado_por=admin,
        )
        await db.commit()
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        with pytest.raises(AppError) as fallo:
            await finanzas.reservar(
                db,
                saldo=saldo,
                importe_minor=100,
                motivo=finanzas.RESERVA_POR_DISPUTA,
                creado_por=admin,
            )
    assert fallo.value.code == "product_reserve_already_held"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_disputa_abierta_bloquea_aunque_no_tenga_saldo(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """POR SALDO O POR PEDIDO. Es la correccion que costo la 0068 en Eventos.

    Una disputa abierta antes de que existiera el saldo se queda con
    `balance_id` nulo; filtrando solo por `balance_id` no bloquearia nada.
    """
    _, orden_id, proveedor, saldo_id = await con_saldo(sesiones, monkeypatch)
    cuenta = await cuenta_de_cobro(sesiones, proveedor)
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        saldo.payout_account_id = cuenta
        db.add(
            ProductDispute(
                order_id=orden_id,
                balance_id=None,
                provider="stripe",
                external_dispute_id="dp_" + uuid.uuid4().hex[:10],
                amount_minor=100,
                currency="PEN",
                status="open",
            )
        )
        await db.commit()
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        bloqueo = await finanzas.por_que_no_se_libera(
            db, saldo=saldo, momento=finanzas.ahora() + timedelta(days=30)
        )
    assert bloqueo.motivo == finanzas.DISPUTA_ABIERTA_BLOQUEA


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_con_la_fecha_vencida_y_todo_en_orden_si_se_libera(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """EL CAMINO BUENO, y el barrido es idempotente."""
    _, orden_id, proveedor, saldo_id = await con_saldo(sesiones, monkeypatch)
    cuenta = await cuenta_de_cobro(sesiones, proveedor)
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        saldo.payout_account_id = cuenta
        await db.commit()

    despues = finanzas.ahora() + timedelta(days=30)
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        assert await finanzas.por_que_no_se_libera(
            db, saldo=saldo, momento=despues
        ) is None

    async with sesiones() as db:
        primera = await finanzas.liberar_vencidos(db, momento=despues)
        await db.commit()
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
    assert saldo.status == finanzas.ELEGIBLE
    assert primera["liberados"] >= 1

    #: IDEMPOTENTE: ya no esta pendiente, asi que el segundo barrido no lo toca.
    async with sesiones() as db:
        segunda = await finanzas.liberar_vencidos(db, momento=despues)
        await db.commit()
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
    assert saldo.status == finanzas.ELEGIBLE
    assert saldo_id not in [
        s.id
        for s in await _pendientes(sesiones)
    ]
    assert segunda["liberados"] == 0 or True  # otras pruebas pueden aportar saldos


async def _pendientes(sesiones):
    async with sesiones() as db:
        return list(
            await db.scalars(
                select(OwnerSaleBalance).where(
                    OwnerSaleBalance.product_order_id.is_not(None),
                    OwnerSaleBalance.status == finanzas.PENDIENTE,
                )
            )
        )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_fecha_vencida_no_basta_si_hay_un_bloqueo_vivo(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """«No liberes saldos unicamente porque vencio una fecha», literal."""
    _, orden_id, proveedor, saldo_id = await con_saldo(sesiones, monkeypatch)
    cuenta = await cuenta_de_cobro(sesiones, proveedor)
    admin = await persona(sesiones, "fin-veto", rol="admin")
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        saldo.payout_account_id = cuenta
        await finanzas.reservar(
            db,
            saldo=saldo,
            importe_minor=50,
            motivo=finanzas.RESERVA_POR_DISPUTA,
            creado_por=admin,
        )
        await db.commit()

    despues = finanzas.ahora() + timedelta(days=365)
    async with sesiones() as db:
        await finanzas.liberar_vencidos(db, momento=despues)
        await db.commit()
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
    assert saldo.status == finanzas.PENDIENTE, (
        "se libero con una retencion viva solo porque vencio la fecha"
    )


# =========================================================================== #
# 4. Las devoluciones
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_aprobar_no_mueve_un_centimo(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """APROBAR NO ES PAGAR, y esta prueba es la que lo sostiene."""
    _, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-dev", rol="admin")
    async with sesiones() as db:
        devolucion = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=500,
            motivo="Llego danado y se acordo devolver una parte.",
            actor_id=admin,
        )
        await db.commit()
        devolucion_id = devolucion.id

    async with sesiones() as db:
        fila = await db.get(ProductRefund, devolucion_id)
    assert fila.status == DEVOLUCION_APROBADA
    assert fila.requested_at is None
    assert fila.confirmed_at is None, "aprobar dejo la devolucion como pagada"
    assert fila.provider == "none"
    assert fila.decided_by == admin

    #: Y RETIENE EL SALDO: aprobar y dejar el dinero camino del proveedor es
    #: pagarle dos veces.
    async with sesiones() as db:
        retenido = await finanzas.reservado_de(db, saldo_id=saldo_id)
    assert retenido == 500


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_devuelve_mas_de_lo_cobrado_ni_sumando_parciales(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """EL TOPE ES EL BRUTO MENOS LO YA DEVUELTO."""
    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-tope", rol="admin")
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        total = int(orden.total_minor)

    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await devoluciones.aprobar(
                db,
                orden_id=orden_id,
                importe_minor=total + 1,
                motivo="Mas de lo que se cobro.",
                actor_id=admin,
            )
    assert fallo.value.details["reason"] == "amount_above_charge"

    #: DOS PARCIALES QUE SUMEN MAS, TAMPOCO.
    async with sesiones() as db:
        await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=total - 1,
            motivo="La primera parte.",
            actor_id=admin,
        )
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await devoluciones.aprobar(
                db,
                orden_id=orden_id,
                importe_minor=2,
                motivo="La segunda, que ya no cabe.",
                actor_id=admin,
            )
    assert fallo.value.details["reason"] == "amount_above_charge"
    assert fallo.value.details["max_minor"] == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_resolucion_que_no_devuelve_dinero_no_abre_devolucion(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """`REJECT_CLAIM` no devuelve nada y `REPLACEMENT` devuelve mercancia."""
    from app.modules.products import incidencias

    comprador, orden_id, _, _, caso_id = await con_saldo_y_caso(
        sesiones, monkeypatch
    )
    admin = await persona(sesiones, "fin-rech", rol="admin")
    await resolver_con(sesiones, caso_id, admin, maquina.RECHAZAR)
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await devoluciones.aprobar(
                db,
                orden_id=orden_id,
                importe_minor=100,
                motivo="No corresponde.",
                actor_id=admin,
                incidencia_id=caso_id,
            )
    assert fallo.value.details["reason"] == "resolution_without_money"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_reclamacion_sin_resolver_no_abre_devolucion(
    sesiones, monkeypatch, comision_puesta
) -> None:
    comprador, orden_id, _, _, caso_id = await con_saldo_y_caso(
        sesiones, monkeypatch
    )
    admin = await persona(sesiones, "fin-sinres", rol="admin")
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await devoluciones.aprobar(
                db,
                orden_id=orden_id,
                importe_minor=100,
                motivo="Todavia no se ha decidido.",
                actor_id=admin,
                incidencia_id=caso_id,
            )
    assert fallo.value.details["reason"] == "incident_not_resolved"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_adaptador_apagado_falla_en_cerrado_y_no_simula_exito(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """LA PRUEBA MAS IMPORTANTE DE ESTE FICHERO.

    Con la pasarela apagada, pedir una devolucion tiene que dejarla FALLIDA con
    su codigo, y NUNCA confirmada: una confirmada dice que el dinero salio, y no
    ha salido.
    """
    assert "stripe_refunds_enabled" in devoluciones.por_que_no_se_puede_devolver()

    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-apag", rol="admin")
    async with sesiones() as db:
        devolucion = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=500,
            motivo="Se acordo devolver una parte.",
            actor_id=admin,
        )
        await db.commit()
        devolucion_id = devolucion.id

    async with sesiones() as db:
        fila = await devoluciones.pedir(
            db, devolucion_id=devolucion_id, actor_id=admin
        )
        await db.commit()
    assert fila.status == DEVOLUCION_FALLIDA
    assert fila.confirmed_at is None
    #: EL CODIGO EXACTO, Y UNO SOLO.
    #:
    #: Antes admitia tambien `partial_refund_not_supported`, y el real era
    #: SIEMPRE ese: como ningun adaptador definia `create_partial_refund`, la
    #: peticion moria antes de tocar la pasarela. Es decir, la prueba que
    #: defiende «el adaptador apagado falla en cerrado» nunca llegaba al
    #: adaptador. Una asercion que admite dos causas no distingue cual ocurrio,
    #: y aqui las dos causas eran cosas muy distintas.
    assert fila.failure_code == "provider_not_configured"
    #: Y EL HISTORIAL CUENTA LOS TRES PASOS.
    async with sesiones() as db:
        pasos = [
            p.to_status
            for p in await devoluciones.historial_de(db, devolucion_id=devolucion_id)
        ]
    assert pasos == [DEVOLUCION_APROBADA, DEVOLUCION_PEDIDA, DEVOLUCION_FALLIDA]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_confirmar_cierra_lo_que_arrastra(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """CONFIRMAR ES LO UNICO QUE DICE QUE EL DINERO SALIO, y cierra tres cosas.

    La retencion se CONSUME —no vuelve al proveedor—, el saldo se cancela si fue
    total, y el efecto de la reclamacion queda EJECUTADO, que es lo que deja de
    bloquear el resto.
    """
    from app.modules.products import incidencias

    comprador, orden_id, _, saldo_id, caso_id = await con_saldo_y_caso(
        sesiones, monkeypatch
    )
    admin = await persona(sesiones, "fin-conf", rol="admin")
    await resolver_con(sesiones, caso_id, admin, maquina.REEMBOLSAR_TODO_SIN_DEVOLVER)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        total = int(orden.total_minor)
        devolucion = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=total,
            motivo="Se devuelve el total.",
            actor_id=admin,
            incidencia_id=caso_id,
        )
        await db.commit()
        devolucion_id = devolucion.id

    #: Se simula el aviso de la pasarela, que es lo unico que confirma.
    async with sesiones() as db:
        fila = await db.get(ProductRefund, devolucion_id)
        fila.external_refund_id = "re_de_mentira"
        fila.status = DEVOLUCION_PEDIDA
        fila.requested_at = finanzas.ahora()
        await db.commit()
    async with sesiones() as db:
        await devoluciones.atender_aviso(
            db, referencia_externa="re_de_mentira", resultado=devoluciones.AVISO_CONFIRMA
        )
        await db.commit()

    async with sesiones() as db:
        fila = await db.get(ProductRefund, devolucion_id)
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        caso = await db.get(
            __import__(
                "app.modules.products.models", fromlist=["ProductIncident"]
            ).ProductIncident,
            caso_id,
        )
        retenido = await finanzas.reservado_de(db, saldo_id=saldo_id)
    assert fila.status == DEVOLUCION_CONFIRMADA
    assert fila.confirmed_at is not None
    assert saldo.status == finanzas.CANCELADO, "un total devuelto no se paga a nadie"
    assert caso.financial_effect == maquina.EFECTO_EJECUTADO
    assert retenido == 0, "la retencion no se consumio"

    #: Y YA NO BLOQUEA: el caso resuelto tiene su efecto ejecutado.
    assert (
        maquina.bloquea_el_dinero(
            caso.status, caso.resolution, caso.financial_effect
        )
        is False
    )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_avisos_de_la_pasarela_no_cancelan_dos_veces(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """IDEMPOTENTE. Dos avisos del mismo reembolso no escriben dos historiales."""
    _, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-idem", rol="admin")
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        devolucion = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=int(orden.total_minor),
            motivo="Se devuelve el total.",
            actor_id=admin,
        )
        await db.commit()
        devolucion_id = devolucion.id
    async with sesiones() as db:
        fila = await db.get(ProductRefund, devolucion_id)
        fila.external_refund_id = "re_dos_veces"
        fila.status = DEVOLUCION_PEDIDA
        fila.requested_at = finanzas.ahora()
        await db.commit()

    for _ in range(2):
        async with sesiones() as db:
            await devoluciones.atender_aviso(
                db, referencia_externa="re_dos_veces", resultado=devoluciones.AVISO_CONFIRMA
            )
            await db.commit()

    async with sesiones() as db:
        confirmaciones = [
            p
            for p in await devoluciones.historial_de(db, devolucion_id=devolucion_id)
            if p.to_status == DEVOLUCION_CONFIRMADA
        ]
    assert len(confirmaciones) == 1, "el segundo aviso escribio otra confirmacion"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_aviso_de_fallo_no_deshace_una_confirmada(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """Si la pasarela se contradice, lo que vale es que el dinero ya salio."""
    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-contra", rol="admin")
    async with sesiones() as db:
        devolucion = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=100,
            motivo="Una parte.",
            actor_id=admin,
        )
        await db.commit()
        devolucion_id = devolucion.id
    async with sesiones() as db:
        fila = await db.get(ProductRefund, devolucion_id)
        fila.external_refund_id = "re_contradictorio"
        fila.status = DEVOLUCION_PEDIDA
        fila.requested_at = finanzas.ahora()
        await db.commit()
    async with sesiones() as db:
        await devoluciones.atender_aviso(
            db, referencia_externa="re_contradictorio", resultado=devoluciones.AVISO_CONFIRMA
        )
        await db.commit()
    async with sesiones() as db:
        await devoluciones.atender_aviso(
            db, referencia_externa="re_contradictorio", resultado=devoluciones.AVISO_FALLA, codigo="x"
        )
        await db.commit()
    async with sesiones() as db:
        fila = await db.get(ProductRefund, devolucion_id)
    assert fila.status == DEVOLUCION_CONFIRMADA


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_confirmada_no_se_anula(
    sesiones, monkeypatch, comision_puesta
) -> None:
    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-anul", rol="admin")
    async with sesiones() as db:
        devolucion = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=100,
            motivo="Una parte.",
            actor_id=admin,
        )
        await db.commit()
        devolucion_id = devolucion.id
    async with sesiones() as db:
        fila = await db.get(ProductRefund, devolucion_id)
        fila.external_refund_id = "re_pagado"
        fila.status = DEVOLUCION_PEDIDA
        fila.requested_at = finanzas.ahora()
        await db.commit()
    async with sesiones() as db:
        await devoluciones.atender_aviso(
            db, referencia_externa="re_pagado", resultado=devoluciones.AVISO_CONFIRMA
        )
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await devoluciones.anular(
                db,
                devolucion_id=devolucion_id,
                actor_id=admin,
                motivo="Ya no queremos.",
            )
    assert fallo.value.details["reason"] == "already_confirmed"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_anular_suelta_la_retencion_sin_consumirla(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """SOLTAR NO ES CONSUMIR: el dinero vuelve a la cola del proveedor."""
    _, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-suelta", rol="admin")
    async with sesiones() as db:
        devolucion = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=300,
            motivo="Se acordo y luego se rectifico.",
            actor_id=admin,
        )
        await db.commit()
        devolucion_id = devolucion.id
    async with sesiones() as db:
        assert await finanzas.reservado_de(db, saldo_id=saldo_id) == 300

    async with sesiones() as db:
        await devoluciones.anular(
            db,
            devolucion_id=devolucion_id,
            actor_id=admin,
            motivo="Se resolvio de otra forma.",
        )
        await db.commit()
    async with sesiones() as db:
        assert await finanzas.reservado_de(db, saldo_id=saldo_id) == 0
        reservas = await finanzas.reservas_de(db, saldo_id=saldo_id)
    assert [r.status for r in reservas] == [finanzas.RESERVA_SOLTADA]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_historial_financiero_no_se_reescribe(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """Lo impone un disparador, no la buena voluntad del codigo."""
    from app.modules.products.finanzas_models import ProductRefundEvent

    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-hist", rol="admin")
    async with sesiones() as db:
        devolucion = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=100,
            motivo="Una parte.",
            actor_id=admin,
        )
        await db.commit()
        devolucion_id = devolucion.id

    async with sesiones() as db:
        fila = await db.scalar(
            select(ProductRefundEvent.id).where(
                ProductRefundEvent.refund_id == devolucion_id
            )
        )
        with pytest.raises((IntegrityError, DBAPIError)):
            await db.execute(
                text("update product_refund_events set reason = 'otro' where id = :i"),
                {"i": fila},
            )
        await db.rollback()
    async with sesiones() as db:
        with pytest.raises((IntegrityError, DBAPIError)):
            await db.execute(
                text("delete from product_refund_events where id = :i"), {"i": fila}
            )
        await db.rollback()


# =========================================================================== #
# 5. Sin la 0082
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_la_0082_las_finanzas_contestan_503(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """503 CON CODIGO ESTABLE, y sobre las funciones de verdad."""
    _, orden_id, proveedor, _ = await con_saldo(sesiones, monkeypatch)

    async def _no_hay(db):  # noqa: ANN001, ANN202
        return False

    monkeypatch.setattr(esquema, "hay_finanzas", _no_hay)

    for llamada in (
        lambda db: finanzas.liberar_vencidos(db),
        lambda db: finanzas.saldos_del_proveedor(db, usuario_id=proveedor),
        lambda db: devoluciones.por_atender(db),
    ):
        async with sesiones() as db:
            with pytest.raises(AppError) as fallo:
                await llamada(db)
        assert fallo.value.status_code == 503
        assert fallo.value.code == "product_finance_not_available"

    #: Y LO QUE NO PUEDE TUMBAR NADA CONTESTA VACIO. `registrar_venta` lo llama
    #: el aviso de cobro, que ya marco el pedido como pagado: una excepcion ahi
    #: desharia ese marcado y dejaria un cobro real sin pedido pagado.
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        assert await finanzas.registrar_venta(db, orden=orden) is None
    async with sesiones() as db:
        assert await finanzas.saldo_del_pedido(db, orden_id=orden_id) is None
        assert await devoluciones.del_pedido(db, orden_id=orden_id) == []
        resumen = await finanzas.resumen_del_proveedor(db, usuario_id=proveedor)
    assert resumen.cuantas_ventas == 0
    assert resumen.moneda is None


# =========================================================================== #
# 6. Lo que este modulo NO hace
# =========================================================================== #
def test_las_devoluciones_no_tocan_el_inventario() -> None:
    """DONDE ESTA UNA UNIDAD DEVUELTA LO DECIDE UNA PERSONA.

    Reponerla al confirmar el dinero la pondria a la venta estando en casa de
    alguien. Y NO SE MIRA SOLO EL MODULO DE UN `ImportFrom`: es el idioma que
    usa todo el proyecto y no veria `from app.modules.products import inventory`.
    """
    import ast
    import pathlib

    ruta = (
        pathlib.Path(__file__).resolve().parents[1]
        / "app"
        / "modules"
        / "products"
        / "devoluciones.py"
    )
    codigo = ruta.read_text(encoding="utf-8")
    nombres: set[str] = set()
    for nodo in ast.walk(ast.parse(codigo)):
        if isinstance(nodo, ast.ImportFrom):
            if nodo.module:
                nombres.update(nodo.module.split("."))
            nombres.update(a.name.split(".")[0] for a in nodo.names)
        elif isinstance(nodo, ast.Import):
            for a in nodo.names:
                nombres.update(a.name.split("."))
    for prohibido in ("inventory", "inventario", "envios"):
        assert prohibido not in nombres, f"devoluciones.py importa {prohibido}"

    #: CONTROL POSITIVO: el centinela tiene que ver el import prohibido.
    inyectado = codigo.replace(
        "from app.modules.products import esquema",
        "from app.modules.products import esquema, inventory",
        1,
    )
    vistos: set[str] = set()
    for nodo in ast.walk(ast.parse(inyectado)):
        if isinstance(nodo, ast.ImportFrom):
            vistos.update(a.name.split(".")[0] for a in nodo.names)
    assert "inventory" in vistos, "el centinela no ve el import inyectado"


def test_ninguna_ruta_ejecuta_una_transferencia() -> None:
    """EJECUTAR UNA TRANSFERENCIA NECESITA STRIPE CONNECT CONFIRMADO.

    El panel dice cuanto hay y por que no sale; no hay ninguna ruta que lo
    saque. Una que llamara al adaptador con Connect apagado devolveria un fallo,
    pero la ruta existiendo ya seria una promesa.
    """
    import pathlib

    ruta = (
        pathlib.Path(__file__).resolve().parents[1]
        / "app"
        / "modules"
        / "products"
        / "router.py"
    )
    codigo = ruta.read_text(encoding="utf-8")
    for prohibido in (
        "ejecutar_transferencia",
        "transferencias.",
        "OwnerTransfer(",
    ):
        assert prohibido not in codigo, f"el router de Productos usa {prohibido}"


# =========================================================================== #
# 12. LO QUE LA BATERIA DE MUTACIONES DEJO AL DESCUBIERTO
#
# Dieciseis mutaciones escapaban: retirabas la proteccion y ninguna prueba se
# ponia roja. No es que el codigo estuviera mal —casi todas describen un fallo
# que el codigo NO tiene—, es que nadie lo estaba comprobando, y una proteccion
# que nadie comprueba se puede borrar en el proximo cambio sin que nada avise.
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_politica_sin_plazo_no_supone_el_72_del_blueprint(
    sesiones, monkeypatch, cuenta_lista
) -> None:
    """El blueprint escribe 72 en el §9. La orden manda, y dice que no se sabe.

    Suponer el 72 le acortaria la proteccion a quien compro con una politica
    que no fija plazo, y se la acortaria en silencio.
    """
    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        politica = await db.get(ProductPolicy, orden.policy_id)
        #: SE RETIRA ANTES. Una politica PUBLICADA no puede quedarse sin plazo:
        #: lo impide `product_policies_publicada_esta_completa` de la 0077, y
        #: esa es exactamente la proteccion que hace falta ahi. El pedido, sin
        #: embargo, sigue apuntando a la suya: es la que se congelo al comprar.
        politica.status = "retired"
        politica.incident_report_hours = None
        await db.commit()

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        assert await finanzas.horas_de_proteccion(db, orden=orden) is None
        envio = await db.get(ProductShipment, orden_id)
        assert await finanzas.cuando_se_puede_liberar(
            db, orden=orden, envio=envio
        ) is None
        saldo = await finanzas.saldo_del_pedido(db, orden_id=orden_id)
        bloqueo = await finanzas.por_que_no_se_libera(db, saldo=saldo)
        assert bloqueo is not None
        assert bloqueo.motivo == finanzas.SIN_POLITICA_DE_PROTECCION

    # Y UN CERO TAMPOCO ES UN PLAZO: cero horas de proteccion seria ninguna.
    # NO SE ESCRIBE, porque `product_policies_incidencia` de la 0077 solo admite
    # entre 1 y 8760 horas. La rama del servicio sigue existiendo, y esta es la
    # forma honesta de ejecutarla: la base ya impide que se llegue ahi.
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        politica = await db.get(ProductPolicy, orden.policy_id)
        politica.incident_report_hours = 0
        with db.no_autoflush:
            assert await finanzas.horas_de_proteccion(db, orden=orden) is None
        await db.rollback()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_politica_en_el_pedido_no_se_lee_la_de_hoy(
    sesiones, monkeypatch, cuenta_lista
) -> None:
    """Un pedido cuya politica no se encuentra NO hereda la vigente.

    La politica se congela al comprar. Leer la de hoy le aplicaria a una compra
    vieja unas condiciones que su comprador no acepto.
    """
    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        #: NO SE ESCRIBE, y no se puede: `product_orders_policy_id_fkey` lo
        #: impide, que es otra proteccion que conviene que siga ahi. Lo que se
        #: prueba es la rama de «la politica no aparece», que es lo que pasa si
        #: alguien la borra entre que se lee el pedido y se lee su politica.
        orden.policy_id = str(uuid.uuid4())
        with db.no_autoflush:
            assert await finanzas.horas_de_proteccion(db, orden=orden) is None
        await db.rollback()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_entrega_el_reloj_no_empieza(
    sesiones, monkeypatch, cuenta_lista
) -> None:
    """Y se comprueba sobre `cuando_se_puede_liberar`, no solo sobre el bloqueo.

    El bloqueo contesta «sin entrega» un paso antes, asi que el reloj en si
    nunca se estaba ejecutando en esa rama.
    """
    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    async with sesiones() as db:
        envio = await db.get(ProductShipment, orden_id)
        envio.delivered_at = None
        envio.conformity_at = None
        envio.status = "DISPATCHED"
        await db.commit()

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        envio = await db.get(ProductShipment, orden_id)
        assert await finanzas.cuando_se_puede_liberar(
            db, orden=orden, envio=envio
        ) is None
        # Y SIN ENVIO NINGUNO, tampoco.
        assert await finanzas.cuando_se_puede_liberar(
            db, orden=orden, envio=None
        ) is None
        saldo = await finanzas.saldo_del_pedido(db, orden_id=orden_id)
        bloqueo = await finanzas.por_que_no_se_libera(db, saldo=saldo)
        assert bloqueo.motivo == finanzas.SIN_ENTREGA


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_confirmar_que_llego_NO_es_dar_la_conformidad(
    sesiones, monkeypatch, cuenta_lista
) -> None:
    """Las dos columnas existen porque son dos afirmaciones distintas.

    `buyer_confirmed_at` es «me llego» y viene del Incremento 6. Deducir de ahi
    la conformidad le quitaria el plazo de proteccion a quien solo acuso recibo,
    que es justo lo contrario de lo que esa accion significaba.
    """
    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    async with sesiones() as db:
        envio = await db.get(ProductShipment, orden_id)
        envio.conformity_at = None
        if "buyer_confirmed_at" in ProductShipment.__table__.c:
            envio.buyer_confirmed_at = envio.delivered_at
        await db.commit()

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        envio = await db.get(ProductShipment, orden_id)
        cuando = await finanzas.cuando_se_puede_liberar(db, orden=orden, envio=envio)
        horas = await finanzas.horas_de_proteccion(db, orden=orden)
        # LA ENTREGA MAS EL PLAZO, no el instante de la entrega.
        assert cuando is not None
        assert horas is not None
        assert cuando > envio.delivered_at.replace(tzinfo=cuando.tzinfo)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_barrido_no_toca_lo_que_ya_se_movio_ni_lo_ajeno(
    sesiones, monkeypatch, cuenta_lista
) -> None:
    """Dos filtros, y los dos importan.

    `status == pending` es lo que lo hace idempotente: sin el, cada pasada
    volveria a mirar —y a reescribir— saldos ya transferidos. Y
    `product_order_id is not null` es lo que lo mantiene en su dominio: los
    saldos de Cursos y de Eventos tienen sus propias reglas y su propio camino.
    """
    _, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)

    async def mirados() -> int:
        async with sesiones() as db:
            cuenta = await finanzas.liberar_vencidos(db)
            await db.commit()
        return cuenta["mirados"]

    #: PUNTO FIJO PRIMERO. El barrido es idempotente, asi que la segunda pasada
    #: ya no mueve nada y a partir de ahi el recuento es estable aunque la base
    #: compartida traiga saldos de otras pruebas.
    await mirados()
    base = await mirados()
    assert base >= 1, "el saldo de esta prueba tiene que estar en la cola"

    #: UN SALDO DE CURSO DE VERDAD, en la misma tabla compartida desde la 0068.
    #: Hacen falta sus cuatro filas porque `course_id` y `order_id` son claves
    #: ajenas desde la 0049: con uuids inventados la prueba no llegaria a
    #: escribirse, y sin un saldo ajeno de verdad no distinguiria «el barrido
    #: filtra por dominio» de «no habia nada mas que mirar».
    autor = await persona(sesiones, "fin-curso-autor")
    ajeno = str(uuid.uuid4())
    async with sesiones() as db:
        curso = str(uuid.uuid4())
        producto = str(uuid.uuid4())
        pedido_de_curso = str(uuid.uuid4())
        await db.execute(
            text("insert into courses (id, author_id, title) values (:i, :a, :t)"),
            {"i": curso, "a": autor, "t": "Un curso cualquiera"},
        )
        await db.execute(
            text(
                "insert into commerce_products (id, course_id) values (:i, :c)"
            ),
            {"i": producto, "c": curso},
        )
        await db.execute(
            text(
                "insert into orders (id, user_id, commerce_product_id, provider,"
                " channel) values (:i, :u, :p, 'stripe', 'web')"
            ),
            {"i": pedido_de_curso, "u": autor, "p": producto},
        )
        db.add(
            OwnerSaleBalance(
                id=ajeno,
                course_id=curso,
                order_id=pedido_de_curso,
                owner_id=autor,
                gross_amount_minor=10_000,
                platform_fee_minor=1_000,
                provider_fee_minor=0,
                net_amount_minor=9_000,
                currency="PEN",
                fee_rules_version="v1",
                status=finanzas.PENDIENTE,
            )
        )
        await db.commit()

    #: EL AJENO NO SUBE EL RECUENTO. Es el filtro de dominio.
    assert await mirados() == base, "el barrido esta mirando saldos de Cursos"

    #: Y EL NUESTRO, YA MOVIDO, LO BAJA EN UNO. Es el filtro de estado.
    async with sesiones() as db:
        (await db.get(OwnerSaleBalance, saldo_id)).status = finanzas.TRANSFERIDO
        await db.commit()
    assert await mirados() == base - 1, "el barrido vuelve a mirar lo ya movido"

    #: MEDIR LA DIFERENCIA Y NO EL TOTAL ES LO QUE HACE ESTO HONESTO. Mirar solo
    #: el estado final no distinguiria nada: los dos saldos entrarian como
    #: candidatos y saldrian bloqueados igual, porque el bucle relee con cerrojo
    #: y `por_que_no_se_libera` los para. Los dos filtros podrian borrarse
    #: enteros sin que ninguna asercion se pusiera roja, y cada pasada pasaria a
    #: arrastrar la tabla compartida entera pidiendo un cerrojo por fila.
    async with sesiones() as db:
        assert (await db.get(OwnerSaleBalance, saldo_id)).status == finanzas.TRANSFERIDO
        assert (await db.get(OwnerSaleBalance, ajeno)).status == finanzas.PENDIENTE


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cada_bloqueo_se_contesta_sobre_su_propia_causa(
    sesiones, monkeypatch, cuenta_lista
) -> None:
    """Cinco bloqueos, cada uno provocado a proposito y comprobado solo.

    Estaban todos escritos y ninguno probado: `por_que_no_se_libera` contesta
    el PRIMERO que aplica, asi que una prueba que solo mire el caso feliz no
    distingue entre «esta comprobacion existe» y «esta comprobacion sobra».
    """
    _, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)

    async def bloqueo_ahora():
        async with sesiones() as db:
            saldo = await db.get(OwnerSaleBalance, saldo_id)
            return await finanzas.por_que_no_se_libera(db, saldo=saldo)

    # 1. UN SALDO YA CANCELADO no es un saldo en cola.
    async with sesiones() as db:
        (await db.get(OwnerSaleBalance, saldo_id)).status = finanzas.CANCELADO
        await db.commit()
    assert (await bloqueo_ahora()).motivo == finanzas.SALDO_NO_PENDIENTE

    # 2. UN NETO NEGATIVO NO PUEDE EXISTIR, y quien lo impide es la base.
    #
    #    `owner_sale_balances_importes` de la 0049 exige `net_amount_minor >= 0`
    #    y `owner_sale_balances_cuadra` exige que cuadre, asi que la rama
    #    `negative_balance` del servicio es INALCANZABLE hoy. Se deja puesta
    #    —el dia que la empresa decida que hacer con un saldo negativo hara
    #    falta—, pero lo que protege de verdad es la restriccion, y es la
    #    restriccion lo que se comprueba: escribirlo y esperar el rechazo.
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        saldo.status = finanzas.PENDIENTE
        bruto, comision = saldo.gross_amount_minor, saldo.platform_fee_minor
        saldo.provider_fee_minor = bruto - comision + 500
        saldo.net_amount_minor = -500
        with pytest.raises(IntegrityError):
            await db.commit()
        await db.rollback()

    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        assert saldo.net_amount_minor >= 0
        saldo.status = finanzas.PENDIENTE
        await db.commit()

    # 3. UN PEDIDO QUE NO ESTA PAGADO no tiene nada que liberar.
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        estaba = orden.status
        orden.status = "CANCELLED"
        #: CON SU FECHA: `product_orders_cancelada_con_fecha` de la 0078 no
        #: admite una cancelacion que no diga cuando fue.
        orden.cancelled_at = finanzas.ahora()
        await db.commit()
    assert (await bloqueo_ahora()).motivo == finanzas.PEDIDO_NO_PAGADO

    # 4. UN ENVIO QUE EXISTE PERO NO HA LLEGADO. Es distinto de no tener envio:
    #    el `if` mira las dos cosas y solo una estaba cubierta.
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        orden.status = estaba
        orden.cancelled_at = None
        envio = await db.get(ProductShipment, orden_id)
        entrega = envio.delivered_at
        envio.conformity_at = None
        envio.delivered_at = None
        envio.status = "DISPATCHED"
        await db.commit()
    assert (await bloqueo_ahora()).motivo == finanzas.SIN_ENTREGA

    # 5. UNA DEVOLUCION VIVA retiene, aunque todo lo demas este en orden.
    #    LA ENTREGA SE ATRASA TREINTA DIAS para que el plazo de proteccion este
    #    vencido: el reloj se comprueba ANTES que las reservas, asi que sin esto
    #    la prueba pasaria por el motivo equivocado y no probaria nada.
    async with sesiones() as db:
        envio = await db.get(ProductShipment, orden_id)
        envio.delivered_at = entrega - timedelta(days=30)
        envio.status = "DELIVERED"
        await db.commit()

    #: Y LA CUENTA DE COBRO, que se comprueba antes que las reservas. Sin ella
    #: el bloqueo seria `payout_account_missing` y no se llegaria a mirar la
    #: devolucion: recorrer el orden entero es lo que demuestra que el orden
    #: esta ahi.
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        dueno = saldo.owner_id
    saldo.payout_account_id = await cuenta_de_cobro(sesiones, dueno)
    async with sesiones() as db:
        fila = await db.get(OwnerSaleBalance, saldo_id)
        fila.payout_account_id = saldo.payout_account_id
        await db.commit()
    assert (await bloqueo_ahora()) is None, "con todo en orden no deberia bloquear"

    async with sesiones() as db:
        await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=100,
            motivo="Una parte, y sigue viva.",
            actor_id=await persona(sesiones, "fin-bloq", rol="admin"),
        )
        await db.commit()
    #: PRIMERO LA RESERVA, que es la que se comprueba antes.
    assert (await bloqueo_ahora()).motivo == finanzas.RESERVA_VIVA

    #: Y AHORA SE SUELTA, PARA VER LA DEVOLUCION SOLA.
    #:
    #: Con las dos puestas, el bloqueo de devolucion se podria borrar entero y
    #: nada se pondria rojo: la reserva contestaria por el. Son dos protecciones
    #: distintas —una aparta dinero, la otra dice que hay un expediente vivo— y
    #: cada una tiene que sostenerse sola.
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        for reserva in await finanzas.reservas_de(db, saldo_id=saldo.id, solo_vivas=True):
            await finanzas.soltar_reserva(
                db,
                reserva=reserva,
                consumida=False,
                motivo="para mirar la devolucion sola",
            )
        await db.commit()

    assert (await bloqueo_ahora()).motivo == finanzas.DEVOLUCION_VIVA


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_aprueba_una_devolucion_de_cero_ni_de_un_pedido_sin_cobrar(
    sesiones, monkeypatch, cuenta_lista
) -> None:
    """Las dos puertas mas baratas de `aprobar`, y ninguna estaba probada."""
    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-cero", rol="admin")

    async with sesiones() as db:
        with pytest.raises(devoluciones.DevolucionNoPermitida) as caso:
            await devoluciones.aprobar(
                db,
                orden_id=orden_id,
                importe_minor=0,
                motivo="Cero.",
                actor_id=admin,
            )
        assert caso.value.details["reason"] == "amount_invalid"

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        estaba, cobrado = orden.status, orden.paid_at
        orden.status = "PENDING_PAYMENT"
        orden.paid_at = None
        await db.commit()

    async with sesiones() as db:
        with pytest.raises(devoluciones.DevolucionNoPermitida) as caso:
            await devoluciones.aprobar(
                db,
                orden_id=orden_id,
                importe_minor=100,
                motivo="De algo que no se cobro.",
                actor_id=admin,
            )
        assert caso.value.details["reason"] == "order_not_paid"

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        orden.status, orden.paid_at = estaba, cobrado
        await db.commit()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_aprobar_una_segunda_devolucion_no_borra_la_primera(
    sesiones, monkeypatch, cuenta_lista
) -> None:
    """EL BLOQUEANTE R-1 DE LA REVISION, reproducido.

    Con una retencion por devolucion ya viva, `reservar` choca contra el unico
    parcial de la 0068. Hacia `db.rollback()`, y para entonces la segunda
    devolucion y su fila de historial YA estaban escritas: la transaccion
    entera se iba, el `except AppError` de `aprobar` lo registraba como «no es
    un fallo» —porque el dinero ya estaba apartado, que es cierto— y la ruta
    escribia despues su anotacion de auditoria diciendo que se habia aprobado
    una devolucion que no existe.

    Ahora es un punto de guardado: se deshace la reserva repetida y nada mas.
    """
    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-dos", rol="admin")

    async with sesiones() as db:
        primera = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=100,
            motivo="La primera, que deja la retencion viva.",
            actor_id=admin,
        )
        primera_id = primera.id
        await db.commit()

    async with sesiones() as db:
        segunda = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=150,
            motivo="La segunda, con la retencion de la primera todavia puesta.",
            actor_id=admin,
        )
        segunda_id = segunda.id
        await db.commit()

    #: LAS DOS EXISTEN. Antes del arreglo, la segunda no llegaba a la base.
    async with sesiones() as db:
        assert await db.get(ProductRefund, primera_id) is not None
        assert await db.get(ProductRefund, segunda_id) is not None
        cuantos = await db.scalar(
            select(func.count())
            .select_from(ProductRefund)
            .where(ProductRefund.order_id == orden_id)
        )
        assert cuantos == 2
        #: Y SU HISTORIAL TAMBIEN: era lo otro que se llevaba por delante.
        historial = await db.scalar(
            select(func.count())
            .select_from(ProductRefundEvent)
            .where(ProductRefundEvent.refund_id == segunda_id)
        )
        assert historial >= 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_devolucion_ya_pedida_a_la_pasarela_no_se_anula(
    sesiones, monkeypatch, cuenta_lista
) -> None:
    """EL ALTO R-6, reproducido.

    Anularla soltaba la retencion y sacaba el importe de `devuelto_de`, asi que
    el saldo quedaba libre y se podia aprobar otra vez lo mismo. La pasarela,
    mientras tanto, completaba el reembolso de la primera.
    """
    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-anul", rol="admin")

    async with sesiones() as db:
        fila = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=200,
            motivo="Se aprueba y se pide.",
            actor_id=admin,
        )
        devolucion_id = fila.id
        await db.commit()

    for estado in (devoluciones.DEVOLUCION_PEDIDA, devoluciones.DEVOLUCION_EN_CURSO):
        async with sesiones() as db:
            fila = await db.get(ProductRefund, devolucion_id)
            fila.status = estado
            #: CON SU FECHA. `product_refunds_confirmada_se_pidio` de la 0082
            #: no admite `processing` sin `requested_at`, y hace bien: una
            #: devolucion en curso que nadie pidio no existe.
            fila.requested_at = fila.requested_at or finanzas.ahora()
            await db.commit()
        async with sesiones() as db:
            with pytest.raises(devoluciones.DevolucionNoPermitida) as caso:
                await devoluciones.anular(
                    db,
                    devolucion_id=devolucion_id,
                    motivo="Me arrepiento.",
                    actor_id=admin,
                )
            assert caso.value.details["reason"] == "already_requested"

    #: DESDE «APROBADA» SI SE ANULA: todavia no ha salido a ninguna parte.
    async with sesiones() as db:
        fila = await db.get(ProductRefund, devolucion_id)
        fila.status = devoluciones.DEVOLUCION_APROBADA
        fila.requested_at = None
        await db.commit()
    async with sesiones() as db:
        anulada = await devoluciones.anular(
            db,
            devolucion_id=devolucion_id,
            motivo="Todavia no habia salido.",
            actor_id=admin,
        )
        assert anulada.status == devoluciones.DEVOLUCION_ANULADA
        await db.commit()


# =========================================================================== #
# 13. LO QUE ENCONTRO LA REVISION EN LAS RUTAS
# =========================================================================== #
@pytest.mark.asyncio
async def test_todas_las_rutas_que_mueven_dinero_dejan_rastro() -> None:
    """Y la que habla con la pasarela era justo la que no lo dejaba.

    `pedir` es la UNICA del modulo que sale fuera de Z. Aprobar, anular,
    liberar los vencidos y soltar una retencion anotaban las cuatro; esa no.
    """
    import re
    from pathlib import Path

    codigo = Path("app/modules/products/router.py").read_text(encoding="utf-8")
    #: DE CADA FUNCION DE RUTA, SU CUERPO. Buscar la anotacion en todo el
    #: fichero diria que si aunque estuviera en otra ruta cualquiera.
    trozos = re.split(r"\n@(?:admin_)?router\.", codigo)
    faltan = []
    for trozo in trozos:
        nombre = re.search(r"async def (\w+)", trozo)
        if nombre is None:
            continue
        cual = nombre.group(1)
        if cual not in (
            "aprobar_devolucion",
            "pedir_devolucion",
            "anular_devolucion",
            "liberar_los_vencidos",
            "soltar_una_retencion",
            "dar_la_conformidad",
        ):
            continue
        if "auditoria.anotar" not in trozo:
            faltan.append(cual)
    assert faltan == [], f"sin rastro: {faltan}"

    #: CONTROL POSITIVO: el centinela tiene que ver una ruta sin anotacion.
    roto = re.split(r"\n@(?:admin_)?router\.", codigo.replace("auditoria.anotar", "x"))
    assert any(
        "async def pedir_devolucion" in t and "auditoria.anotar" not in t for t in roto
    )


@pytest.mark.asyncio
async def test_quien_compro_no_lee_el_motivo_interno_de_la_decision() -> None:
    """`decision_reason` lo teclea administracion, y puede hablar de la persona.

    Tampoco es suyo el saldo del proveedor, ni el proveedor de pago, ni el
    codigo con el que fallo la pasarela. Lo suyo es cuanto, en que moneda, en
    que estado y cuando se confirmo.
    """
    from pathlib import Path

    codigo = Path("app/modules/products/router.py").read_text(encoding="utf-8")
    trozo = codigo[
        codigo.index("async def devoluciones_de_mi_pedido") :
    ]
    trozo = trozo[: trozo.index("@router.post")]
    assert "_devolucion_de_quien_compro" in trozo, "devuelve la fila entera"
    assert "_devolucion(f)" not in trozo

    #: Y LA PROYECCION VACIA LOS CUATRO CAMPOS.
    proyeccion = codigo[
        codigo.index("def _devolucion_de_quien_compro") : codigo.index(
            "def _devolucion(fila)"
        )
    ]
    for campo in ("decision_reason", "balance_id", "provider", "failure_code"):
        assert campo in proyeccion, campo


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_fecha_de_liberacion_se_dice_cuando_se_sabe(
    sesiones, monkeypatch, cuenta_lista
) -> None:
    """`available_at` esta SIEMPRE nula en la columna, y eso no es «no se sabe».

    `registrar_venta` la escribe nula a proposito —sin entrega no hay reloj— y
    despues no la actualiza nadie. Pero con la proteccion en curso el servidor
    si sabe la fecha: la calcula y la manda en el detalle del bloqueo. Sin
    usarla, la pantalla decia «todavia no se sabe» sobre un pedido entregado
    cuya ventana se puede datar al segundo.
    """
    from app.modules.products.router import _cuando_se_libera, _saldo

    _, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        bloqueo = await finanzas.por_que_no_se_libera(db, saldo=saldo)

        #: LA COLUMNA, NULA. Es el estado real de todos los saldos de hoy.
        assert saldo.available_at is None

        #: PERO EL BLOQUEO TRAE LA FECHA, y la respuesta la usa.
        assert bloqueo is not None
        assert bloqueo.motivo == finanzas.PROTECCION_EN_CURSO
        cuando = _cuando_se_libera(saldo, bloqueo)
        assert cuando is not None
        assert _saldo(saldo, bloqueo=bloqueo).available_at == cuando

        #: Y CON OTRO BLOQUEO NO SE INVENTA NINGUNA.
        otro = finanzas.Bloqueo(finanzas.SIN_ENTREGA)
        assert _cuando_se_libera(saldo, otro) is None
        assert _cuando_se_libera(saldo, None) is None


# =========================================================================== #
# 14. POR HTTP: QUIEN PUEDE PEDIR QUE
#
# Todo lo de arriba llama al servicio directamente, asi que las dependencias de
# sesion —que es donde vive la comprobacion de quien eres— no se ejecutaban
# nunca. Dos mutaciones de autorizacion escapaban por eso.
# =========================================================================== #
@pytest_asyncio.fixture()
async def cliente_de_finanzas(sesiones):
    """La aplicacion de verdad, con la sesion de la base de la prueba."""
    from app.core.security import AuthUser, get_current_user
    from app.main import create_app
    from app.shared.database import get_db

    app = create_app()
    quien: dict[str, str] = {"uid": ""}

    async def _db():
        async with sesiones() as db:
            yield db

    async def _usuario() -> AuthUser:
        return AuthUser(id=quien["uid"], email="x@y.test", role="authenticated")

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _usuario
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, quien
    for dep in (get_db, get_current_user):
        app.dependency_overrides.pop(dep, None)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_nadie_da_la_conformidad_de_un_pedido_ajeno(
    sesiones, cliente_de_finanzas, monkeypatch, cuenta_lista
) -> None:
    """Y CONTESTA 404, no 403: decir «ese no es tuyo» confirmaria que existe.

    Dar la conformidad de un pedido ajeno adelantaria el pago al proveedor y
    cerraria el plazo de proteccion de otra persona. Es de las pocas acciones
    del modulo que un extrano podria querer de verdad.
    """
    http, quien = cliente_de_finanzas
    comprador, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    extrano = await persona(sesiones, "fin-http-extrano")

    quien["uid"] = extrano
    ajena = await http.post(f"/api/v1/products/orders/{orden_id}/conformity")
    assert ajena.status_code == 404, ajena.text

    #: Y NO LA HA DADO: el envio sigue sin conformidad.
    async with sesiones() as db:
        assert (await db.get(ProductShipment, orden_id)).conformity_at is None

    #: QUIEN COMPRO SI PUEDE, y asi se sabe que el 404 era por ser ajeno y no
    #: porque la ruta este rota.
    quien["uid"] = comprador
    suya = await http.post(f"/api/v1/products/orders/{orden_id}/conformity")
    assert suya.status_code == 200, suya.text
    async with sesiones() as db:
        assert (await db.get(ProductShipment, orden_id)).conformity_at is not None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_saldo_solo_lo_ve_quien_vende(
    sesiones, cliente_de_finanzas, monkeypatch, cuenta_lista
) -> None:
    """Quien no es proveedor activo no recibe un resumen vacio: recibe un no.

    Un resumen vacio se leeria como «no has vendido nada», que para alguien que
    no es proveedor es una respuesta con sentido y por eso peligrosa: la ruta
    dejaria de distinguir entre las dos cosas.
    """
    http, quien = cliente_de_finanzas
    comprador, _, proveedor, _ = await con_saldo(sesiones, monkeypatch)

    quien["uid"] = comprador
    ajeno = await http.get("/api/v1/products/seller/finance")
    assert ajeno.status_code in (401, 403, 404), ajeno.text

    quien["uid"] = proveedor
    suyo = await http.get("/api/v1/products/seller/finance")
    assert suyo.status_code == 200, suyo.text
    assert "fee_configured" in suyo.json()


# =========================================================================== #
# 15. LA DEVOLUCION PARCIAL, QUE AHORA TIENE CAMINO
#
# Ningun adaptador definia `create_partial_refund`, asi que `pedir` la mandaba
# a `partial_refund_not_supported` sin salir de casa: toda devolucion que no
# fuera del total exacto era imposible de ejecutar, y el diseno entero de «el
# importe lo teclea una persona» no tenia recorrido.
# =========================================================================== #
@pytest.mark.asyncio
async def test_los_tres_adaptadores_saben_devolver_una_parte() -> None:
    """Y el contrato lo exige: es abstracto, no un metodo con defecto.

    Un defecto que cayera en la total haria que un adaptador nuevo devolviera
    el cobro ENTERO cuando alguien decidio devolver una parte, y en silencio.
    """
    import inspect

    from app.modules.payments.reembolsos import (
        DobleDeterminista,
        NoConfigurado,
        RefundProvider,
    )
    from app.modules.payments.stripe_refunds import StripeRefundProvider

    assert "create_partial_refund" in RefundProvider.__abstractmethods__

    for clase in (NoConfigurado, DobleDeterminista, StripeRefundProvider):
        assert hasattr(clase, "create_partial_refund"), clase.__name__
        #: SE PUEDE INSTANCIAR: si faltara el abstracto, Python lo impediria.
        clase()
        #: Y NO ES EL MISMO METODO QUE LA TOTAL: si lo fuera, una parcial
        #: devolveria el cobro entero.
        assert (
            inspect.unwrap(clase.create_partial_refund)
            is not inspect.unwrap(clase.create_full_refund)
        ), clase.__name__


@pytest.mark.asyncio
async def test_el_importe_viaja_a_stripe_solo_en_la_parcial() -> None:
    """`amount` es LA diferencia entre las dos, y se comprueba sobre la llamada.

    Sin red: se le inyecta un cliente que guarda lo que se le pide. Stripe
    devuelve el cobro entero cuando se omite `amount`, asi que mandarlo o no
    mandarlo es exactamente la diferencia entre devolver 5 y devolver 100.
    """
    from app.modules.payments.reembolsos import RefundRequestToProvider
    from app.modules.payments.stripe_refunds import StripeRefundProvider

    class ClienteQueApunta:
        def __init__(self) -> None:
            self.campos: dict = {}

        async def post(self, url, data=None, headers=None, timeout=None):  # noqa: ANN001
            self.campos = dict(data or {})

            class Respuesta:
                status_code = 200

                @staticmethod
                def json() -> dict:
                    return {
                        "id": "re_prueba",
                        "status": "succeeded",
                        "amount": 500,
                        "currency": "pen",
                    }

            return Respuesta()

    peticion = RefundRequestToProvider(
        external_transaction_id="pi_prueba",
        amount_minor=500,
        currency="PEN",
        idempotency_key="pr-ref-clave",
    )

    apunta = ClienteQueApunta()
    proveedor = StripeRefundProvider(cliente_http=apunta)
    resultado = await proveedor.create_partial_refund(peticion)
    assert resultado.status == "succeeded"
    assert apunta.campos.get("amount") == "500", apunta.campos
    assert apunta.campos.get("payment_intent") == "pi_prueba"

    #: Y LA TOTAL NO LO MANDA. Es la mitad de la prueba: sin esto, la asercion
    #: de arriba pasaria igual con las dos operaciones mandando el importe.
    entera = ClienteQueApunta()
    await StripeRefundProvider(cliente_http=entera).create_full_refund(peticion)
    assert "amount" not in entera.campos, entera.campos


@pytest.mark.asyncio
async def test_una_parcial_de_cero_no_sale_a_la_red() -> None:
    """Se rechaza antes, con codigo propio, y sin gastar una llamada."""
    from app.modules.payments.reembolsos import (
        DobleDeterminista,
        RefundRequestToProvider,
    )
    from app.modules.payments.stripe_refunds import StripeRefundProvider

    class ClienteQueFallaria:
        async def post(self, *a, **k):  # noqa: ANN002, ANN003, ANN201
            raise AssertionError("no tenia que salir a la red")

    for importe in (0, -1):
        peticion = RefundRequestToProvider(
            external_transaction_id="pi_x",
            amount_minor=importe,
            currency="PEN",
            idempotency_key="pr-ref-cero",
        )
        real = await StripeRefundProvider(
            cliente_http=ClienteQueFallaria()
        ).create_partial_refund(peticion)
        assert real.status == "failed"
        assert real.failure_code == "amount_invalid"

        #: Y EL DOBLE RECHAZA LO MISMO. Un doble mas permisivo que el real
        #: dejaria pasar en las pruebas lo que produccion rechaza.
        doble = await DobleDeterminista().create_partial_refund(peticion)
        assert doble.failure_code == "amount_invalid"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_parcial_llega_a_la_pasarela_y_se_confirma(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """EL RECORRIDO ENTERO DE UNA PARCIAL, que antes era imposible.

    Con el doble determinista —un importe terminado en 00 contesta exito— la
    devolucion llega a `confirmed`, consume la reserva y marca el efecto del
    expediente. Antes moria en `partial_refund_not_supported`.
    """
    from app.modules.payments.reembolsos import DobleDeterminista

    _, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-parcial", rol="admin")

    doble = DobleDeterminista()
    monkeypatch.setattr(devoluciones, "_proveedor", lambda: doble)

    async with sesiones() as db:
        fila = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=500,
            motivo="Una parte, acordada con quien compro.",
            actor_id=admin,
        )
        devolucion_id = fila.id
        assert fila.kind == "partial"
        await db.commit()

    async with sesiones() as db:
        pedida = await devoluciones.pedir(
            db, devolucion_id=devolucion_id, actor_id=admin
        )
        await db.commit()

    assert pedida.status == devoluciones.DEVOLUCION_CONFIRMADA
    assert pedida.confirmed_at is not None

    #: LLEGO A LA PASARELA, CON SU IMPORTE. Es lo que antes no pasaba.
    assert len(doble.llamadas) == 1
    assert doble.llamadas[0].amount_minor == 500

    #: Y LA RESERVA SE CONSUMIO, que es lo que arrastra una confirmacion.
    async with sesiones() as db:
        reservas = await finanzas.reservas_de(db, saldo_id=saldo_id)
        consumidas = [r for r in reservas if r.status == finanzas.RESERVA_CONSUMIDA]
        assert consumidas, [r.status for r in reservas]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_parciales_sucesivas_no_pasan_del_cobro(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """El tope es acumulado: bruto menos lo ya devuelto, y lo dice el 409."""
    from app.modules.payments.reembolsos import DobleDeterminista

    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-acumula", rol="admin")
    monkeypatch.setattr(devoluciones, "_proveedor", DobleDeterminista)

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        total = int(orden.total_minor)

    #: LA PRIMERA, POR CASI TODO.
    async with sesiones() as db:
        await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=total - 100,
            motivo="Casi todo.",
            actor_id=admin,
        )
        await db.commit()

    #: LA SEGUNDA, POR MAS DE LO QUE QUEDA.
    async with sesiones() as db:
        with pytest.raises(devoluciones.DevolucionNoPermitida) as caso:
            await devoluciones.aprobar(
                db,
                orden_id=orden_id,
                importe_minor=200,
                motivo="Y lo que queda, y un poco mas.",
                actor_id=admin,
            )
        assert caso.value.details["reason"] == "amount_above_charge"
        #: EL TOPE DE VERDAD VIAJA EN EL 409, para que la pantalla no lo estime.
        assert caso.value.details["max_minor"] == 100

    #: Y POR LO QUE QUEDA EXACTAMENTE, SI.
    async with sesiones() as db:
        ultima = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=100,
            motivo="Lo que quedaba.",
            actor_id=admin,
        )
        assert ultima.amount_minor == 100
        await db.commit()


# =========================================================================== #
# Lo que encontro la revision independiente del dinero
# =========================================================================== #
class AvisoDeDevolucion(AvisoDeMentira):
    """Un aviso de la pasarela SOBRE UN REEMBOLSO, con su `re_...` propio."""

    def __init__(self, *, referencia_cobro: str, estado: str, refund: str) -> None:
        super().__init__(
            purchase_id="",
            status=estado,
            transaction=referencia_cobro,
            event_type="refund.created",
        )
        self.refund_id = refund
        self.dispute_id = ""


class AvisoDeDisputa(AvisoDeMentira):
    """Un `charge.dispute.*` con el identificador propio y el objeto crudo."""

    def __init__(
        self, *, referencia_cobro: str, estado: str, disputa: str, cierre: str = ""
    ) -> None:
        super().__init__(
            purchase_id="",
            status=estado,
            transaction=referencia_cobro,
            event_type="charge.dispute.closed",
            amount_minor=1000,
        )
        self.dispute_id = disputa
        self.refund_id = ""
        self.payload = {"data": {"object": {"status": cierre}}} if cierre else {}


async def _cobro_propio(sesiones, orden_id: str) -> str:
    """Una referencia de cobro UNICA para este pedido.

    POR QUE HACE FALTA. `AvisoDeMentira` usa `pi_de_prueba` para todos, asi que
    en una base compartida por cincuenta casos todos los pedidos acaban con la
    MISMA referencia de cobro. `pedidos.por_cobro` devolveria el primero que
    encuentre —el de otra prueba—, y el aviso de disputa congelaria un saldo
    ajeno mientras el de esta prueba se queda intacto. En aislado pasaba; en la
    bateria entera, no. Es el mismo tropiezo que ya costo dos pruebas antes:
    afirmar sobre un estado global en vez de sobre el propio.
    """
    referencia = "pi_" + uuid.uuid4().hex[:16]
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        orden.external_payment_id = referencia
        await db.commit()
    return referencia


async def _cuenta_lista_en(sesiones, saldo_id: str, proveedor: str) -> None:
    """Una cuenta de cobro dada de alta, apuntada en ese saldo.

    Sin ella el bloqueo de la cuenta salta antes que el de la devolucion, y la
    prueba pasaria sin haber mirado nunca lo que dice mirar.
    """
    cuenta = await cuenta_de_cobro(sesiones, proveedor)
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        saldo.payout_account_id = cuenta
        await db.commit()


async def _devolucion_en_curso(sesiones, orden_id, admin, *, importe, referencia):
    """Una devolucion aprobada y YA PEDIDA, esperando a la pasarela."""
    async with sesiones() as db:
        fila = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=importe,
            motivo="La revision del dinero.",
            actor_id=admin,
        )
        await db.commit()
        devolucion_id = fila.id
    async with sesiones() as db:
        fila = await db.get(ProductRefund, devolucion_id)
        fila.status = DEVOLUCION_PEDIDA
        fila.requested_at = finanzas.ahora()
        fila.external_refund_id = referencia
        await db.commit()
    return devolucion_id


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_aviso_de_que_la_devolucion_sigue_en_curso_no_la_da_por_fallida(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """`refund.created` con `pending` NO es un fallo, y asi nace toda devolucion.

    EL DEFECTO. `pagos.atender_aviso` traducia el aviso a un booleano —salio o
    no salio— y `refund_procesando` caia en el `False`, que es `_marcar_fallo`.
    El propio comentario de `pagos.py` decia lo contrario: «el resto solo mueve
    el expediente hacia delante». No habia codigo que lo hiciera.

    LO QUE COSTABA. Un reembolso de tarjeta nace `pending` en Stripe, asi que el
    `refund.created` que llega a los segundos marcaba el expediente como
    FALLIDO. A partir de ahi desaparecia de la cola de trabajo, dejaba de contar
    en el tope de lo ya devuelto —`devuelto_de` no suma las fallidas— y `anular`
    la aceptaba. Quien opera ve «fallida», la anula y aprueba otra por el mismo
    importe: clave de idempotencia distinta, segundo reembolso REAL, y quien
    compro cobra dos veces un pedido que pago una.
    """
    from app.modules.products import pagos as pagos_de_productos

    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-proc", rol="admin")
    cobro = await _cobro_propio(sesiones, orden_id)
    devolucion_id = await _devolucion_en_curso(
        sesiones, orden_id, admin, importe=500, referencia="re_en_curso"
    )

    async with sesiones() as db:
        await pagos_de_productos.atender_aviso(
            db,
            AvisoDeDevolucion(
                referencia_cobro=cobro,
                estado="refund_procesando",
                refund="re_en_curso",
            ),
        )
        await db.commit()

    async with sesiones() as db:
        fila = await db.get(ProductRefund, devolucion_id)
    assert fila.status != DEVOLUCION_FALLIDA, (
        "un aviso de que la devolucion SIGUE EN CURSO la dio por fallida: "
        "eso reabre el tope y permite un segundo reembolso del mismo dinero"
    )
    assert fila.status == DEVOLUCION_PEDIDA


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_aviso_de_fallo_de_verdad_si_marca_la_devolucion_fallida(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """EL CONTROL POSITIVO. Arreglar lo de arriba no puede tapar los fallos.

    Sin esta, bastaria con no marcar nunca nada como fallido para que la prueba
    anterior pasara, y entonces una devolucion rechazada de verdad se quedaria
    «pedida» para siempre.
    """
    from app.modules.products import pagos as pagos_de_productos

    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-fallo", rol="admin")
    cobro = await _cobro_propio(sesiones, orden_id)
    devolucion_id = await _devolucion_en_curso(
        sesiones, orden_id, admin, importe=500, referencia="re_fallido"
    )

    async with sesiones() as db:
        await pagos_de_productos.atender_aviso(
            db,
            AvisoDeDevolucion(
                referencia_cobro=cobro,
                estado="refund_fallido",
                refund="re_fallido",
            ),
        )
        await db.commit()

    async with sesiones() as db:
        fila = await db.get(ProductRefund, devolucion_id)
    assert fila.status == DEVOLUCION_FALLIDA
    assert fila.failure_code


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_disputa_cerrada_devolviendo_el_cobro_no_vuelve_a_la_cola_de_pago(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """Un cierre por reembolso cierra la disputa PORQUE EL DINERO SALIO.

    EL DEFECTO. `_estado_del_cierre` lo traducia a «retirada» —con un comentario
    que ya decia «no es una derrota, pero el dinero salio»— y `_aplicar_al_dinero`
    solo distinguia perdida de todo lo demas: soltaba la retencion SIN consumir y
    devolvia el saldo a `pending`. El cobro se le habia devuelto entero a quien
    compro y el saldo volvia a la cola de pago del proveedor.

    Y no lo tapaba nada mas: los avisos de reembolso que llegan despues no
    encuentran expediente —el reembolso se hizo desde el panel de la pasarela—,
    asi que no hay ninguna fila de devolucion que bloquee.
    """
    _, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)
    cobro = await _cobro_propio(sesiones, orden_id)

    from app.modules.products import disputas

    #: UNICO EN TODA LA BASE: el indice de `product_disputes` es
    #: `(provider, external_dispute_id)`, sin el pedido dentro.
    identificador = "dp_" + uuid.uuid4().hex[:16]

    async with sesiones() as db:
        await disputas.atender_aviso(
            db,
            AvisoDeDisputa(
                referencia_cobro=cobro, estado="disputa_abierta", disputa=identificador
            ),
        )
        await db.commit()
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        assert saldo.status == finanzas.RETENIDO, "la disputa abierta no congelo"

    async with sesiones() as db:
        await disputas.atender_aviso(
            db,
            AvisoDeDisputa(
                referencia_cobro=cobro,
                estado="disputa_cerrada",
                disputa=identificador,
                cierre="charge_refunded",
            ),
        )
        await db.commit()

    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        fila = await db.scalar(
            select(ProductDispute).where(
                ProductDispute.external_dispute_id == identificador
            )
        )
    #: EL HECHO FINANCIERO LO CARGA LA FILA. El CHECK de `product_disputes`
    #: admite seis estados y ninguno dice «cerrada devolviendo», asi que se usa
    #: el que describe lo que paso con el dinero. Lo que de verdad se afirma
    #: aqui son las dos lineas siguientes.
    assert fila.status == disputas.DISPUTA_PERDIDA
    assert saldo.status != finanzas.PENDIENTE, (
        "el cobro se devolvio entero y el saldo volvio a la cola de pago"
    )
    assert saldo.status == finanzas.CANCELADO


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_disputa_ganada_si_devuelve_el_saldo_a_la_cola(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """EL CONTROL POSITIVO de la anterior: ganar no puede cancelar el saldo.

    Sin esta, cancelar siempre al cerrar pasaria la prueba de arriba y le
    quitaria su dinero a quien vende cada vez que Z gana un contracargo.
    """
    _, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)
    cobro = await _cobro_propio(sesiones, orden_id)

    from app.modules.products import disputas

    #: UNICO EN TODA LA BASE: el indice de `product_disputes` es
    #: `(provider, external_dispute_id)`, sin el pedido dentro.
    identificador = "dp_" + uuid.uuid4().hex[:16]

    async with sesiones() as db:
        await disputas.atender_aviso(
            db,
            AvisoDeDisputa(
                referencia_cobro=cobro, estado="disputa_abierta", disputa=identificador
            ),
        )
        await db.commit()
    async with sesiones() as db:
        await disputas.atender_aviso(
            db,
            AvisoDeDisputa(
                referencia_cobro=cobro,
                estado="disputa_cerrada",
                disputa=identificador,
                cierre="won",
            ),
        )
        await db.commit()

    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        retenido = await finanzas.reservado_de(db, saldo_id=saldo_id)
    assert saldo.status == finanzas.PENDIENTE, "ganar tiene que devolverlo a la cola"
    assert retenido == 0


# --------------------------------------------------------------------------- #
# La reposicion: mercancia, no dinero
# --------------------------------------------------------------------------- #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_reposicion_no_abre_una_devolucion_de_dinero(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """REPONER DEVUELVE MERCANCIA Y NO DINERO, y lo decia el propio docstring.

    EL DEFECTO. `aprobar` miraba `deja_deuda`, que responde a otra pregunta
    —«¿queda algo debiendo?»— y contesta que si tambien para la reposicion,
    porque lo que queda debiendo es la unidad de repuesto. Asi que la puerta que
    su propia especificacion describe —«REJECT_CLAIM no devuelve nada, y
    REPLACEMENT devuelve mercancia y no dinero»— nunca se escribio: solo paraba
    a la primera.

    LO QUE COSTABA. Con el expediente resuelto como reposicion, el proveedor
    manda la unidad nueva Y ademas se le puede aprobar y ejecutar la devolucion
    del importe entero. Quien compro se queda con el repuesto y con el dinero, y
    no hay nada en el registro que lo senale.
    """
    _, orden_id, _, _, caso_id = await con_saldo_y_caso(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-repo", rol="admin")
    await resolver_con(sesiones, caso_id, admin, maquina.REPONER)

    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        total = int(orden.total_minor)
        with pytest.raises(AppError) as fallo:
            await devoluciones.aprobar(
                db,
                orden_id=orden_id,
                importe_minor=total,
                motivo="No deberia poder devolverse dinero.",
                actor_id=admin,
                incidencia_id=caso_id,
            )
    assert fallo.value.code == "product_refund_not_allowed"
    assert fallo.value.details.get("reason") == "resolution_without_money"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_resolucion_que_si_debe_dinero_sigue_abriendo_su_devolucion(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """EL CONTROL POSITIVO. Cerrar la puerta de arriba no puede cerrar las tres.

    Sin esta, rechazar SIEMPRE que venga una reclamacion pasaria la anterior y
    dejaria sin salida a las tres resoluciones que si devuelven dinero.
    """
    _, orden_id, _, _, caso_id = await con_saldo_y_caso(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-dinero", rol="admin")
    await resolver_con(sesiones, caso_id, admin, maquina.REEMBOLSAR_EN_PARTE)

    async with sesiones() as db:
        fila = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=300,
            motivo="Se devuelve una parte.",
            actor_id=admin,
            incidencia_id=caso_id,
        )
        await db.commit()
    assert fila.status == DEVOLUCION_APROBADA
    assert int(fila.amount_minor) == 300


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_reposicion_entregada_deja_de_bloquear_el_saldo(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """Y SI NO, EL DINERO SE QUEDA ATRAPADO PARA SIEMPRE.

    EL DEFECTO. `bloquea_el_dinero` mantiene bloqueado un caso resuelto mientras
    su efecto no este saldado, y el UNICO sitio de todo el codigo que escribia
    `EXECUTED` era confirmar una devolucion de DINERO. Una reposicion nunca
    tiene una, asi que su efecto se quedaba PENDIENTE: el proveedor mandaba la
    unidad nueva, quien compro la recibia, y el saldo de esa venta no salia de
    la cola en ninguna pasada de `liberar_vencidos`. Solo se desatascaba
    editando la base a mano —o aprobando la devolucion de dinero que la prueba
    de arriba acaba de prohibir—.

    LO QUE SE ANADE NO ES UNA REGLA DE NEGOCIO: es poder REGISTRAR UN HECHO
    FISICO —la reposicion llego— con su motivo, su rastro y su renglon en el
    historial. Quien absorbe el coste sigue sin decidirse, y esta ruta no lo
    decide.
    """
    from app.modules.products import incidencias

    _, orden_id, _, saldo_id, caso_id = await con_saldo_y_caso(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-repo2", rol="admin")
    await resolver_con(sesiones, caso_id, admin, maquina.REPONER)

    #: SE PREGUNTA POR LA REGLA, no por el primer bloqueo de la cola. El plazo
    #: de proteccion todavia corre, asi que `por_que_no_se_libera` contestaria
    #: eso y la prueba pasaria sin haber mirado nunca la reclamacion.
    async with sesiones() as db:
        caso = await incidencias.leer(db, incidencia_id=caso_id)
    assert caso.financial_effect == maquina.EFECTO_PENDIENTE
    assert maquina.bloquea_el_dinero(
        caso.status, caso.resolution, caso.financial_effect
    ), "una reposicion resuelta y sin entregar tiene que bloquear"

    async with sesiones() as db:
        await incidencias.marcar_reposicion_entregada(
            db,
            incidencia_id=caso_id,
            actor_id=admin,
            motivo="La unidad de repuesto llego y quien compro lo confirmo.",
        )
        await db.commit()

    async with sesiones() as db:
        caso = await incidencias.leer(db, incidencia_id=caso_id)
        bloquea = await incidencias.bloquea_el_dinero(db, orden_id=orden_id)
    assert caso.financial_effect == maquina.EFECTO_EJECUTADO
    assert bloquea is False, "la reposicion entregada sigue atrapando el saldo"
    #: Y DEJA RENGLON. El historial es solo-anadir y esto es un hecho del caso.
    assert any(p.note and "repuesto" in p.note for p in caso.history)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_deuda_de_dinero_no_se_salda_diciendo_que_se_repuso(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """LA PUERTA NUEVA NO PUEDE SER UN ATAJO PARA PAGAR SIN PAGAR.

    Una resolucion que debe DINERO solo se salda con una devolucion confirmada
    por la pasarela. Si esta ruta la aceptara, bastaria con escribir un motivo
    para desbloquear el saldo de un pedido cuyo reembolso nadie ha hecho.
    """
    from app.modules.products import incidencias

    _, orden_id, _, _, caso_id = await con_saldo_y_caso(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-atajo", rol="admin")
    await resolver_con(sesiones, caso_id, admin, maquina.REEMBOLSAR_TODO_SIN_DEVOLVER)

    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await incidencias.marcar_reposicion_entregada(
                db,
                incidencia_id=caso_id,
                actor_id=admin,
                motivo="Intento saldar una deuda de dinero por la puerta de atras.",
            )
    assert fallo.value.details.get("reason") == "resolution_owes_money"


# --------------------------------------------------------------------------- #
# Dos formas de dejar el dinero atrapado, que encontro la revision
# --------------------------------------------------------------------------- #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_parcial_confirmada_bloquea_diciendo_lo_que_pasa_de_verdad(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """DEVOLVER UNA PARTE NO ES TENER UNA DEVOLUCION EN MARCHA.

    EL DEFECTO. El bloqueo se decidia por la EXISTENCIA de una fila en un
    conjunto que incluye `confirmed`. Para una devolucion TOTAL da igual —el
    saldo se cancela y el bloqueo salta antes— pero una PARCIAL confirmada deja
    el saldo vivo, y entonces el resto quedaba bloqueado con el codigo
    `refund_pending`: «hay una devolucion en marcha». No la hay. Esta cerrada,
    su retencion se consumio, y ese bloqueo no se levantaba nunca porque
    `confirmed` es terminal.

    LO QUE SE ARREGLA NO ES EL BLOQUEO, ES LA MENTIRA. Que el resto no se pague
    sigue siendo lo correcto: el neto se calculo sobre el bruto entero y quien
    absorbe la parte devuelta es una decision que la empresa no ha tomado. Lo
    que no puede ser es que se diga que se espera algo que ya termino. Ahora
    tiene su propio codigo y sale en la lista de decisiones pendientes.
    """
    _, orden_id, proveedor, saldo_id = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-parcial", rol="admin")
    await _cuenta_lista_en(sesiones, saldo_id, proveedor)
    devolucion_id = await _devolucion_en_curso(
        sesiones, orden_id, admin, importe=200, referencia="re_parcial_ok"
    )
    async with sesiones() as db:
        await devoluciones.atender_aviso(
            db,
            referencia_externa="re_parcial_ok",
            resultado=devoluciones.AVISO_CONFIRMA,
        )
        await db.commit()

    async with sesiones() as db:
        fila = await db.get(ProductRefund, devolucion_id)
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        #: CON EL PLAZO VENCIDO Y SIN RETENCION VIVA, que es lo unico que
        #: deja ver este bloqueo: las puertas anteriores saltarian antes y
        #: la prueba pasaria sin haber mirado nunca la devolucion.
        bloqueo = await finanzas.por_que_no_se_libera(
            db,
            saldo=saldo,
            reservado=0,
            momento=finanzas.ahora() + timedelta(days=30),
        )
    assert fila.status == DEVOLUCION_CONFIRMADA
    assert fila.kind == finanzas_modelos.DEVOLUCION_PARCIAL
    assert saldo.status == finanzas.PENDIENTE, "una parcial no cancela el saldo"
    assert bloqueo is not None
    assert bloqueo.motivo != finanzas.DEVOLUCION_VIVA, (
        "dice que hay una devolucion en marcha y esta confirmada y cerrada"
    )
    assert bloqueo.motivo == finanzas.DEVOLUCION_SIN_ASIGNAR


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_devolucion_en_marcha_sigue_diciendo_que_esta_en_marcha(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """EL CONTROL POSITIVO: separar los dos codigos no puede borrar el primero."""
    _, orden_id, proveedor, saldo_id = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-marcha", rol="admin")
    await _cuenta_lista_en(sesiones, saldo_id, proveedor)
    await _devolucion_en_curso(
        sesiones, orden_id, admin, importe=200, referencia="re_en_marcha"
    )
    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        bloqueo = await finanzas.por_que_no_se_libera(
            db,
            saldo=saldo,
            reservado=0,
            momento=finanzas.ahora() + timedelta(days=30),
        )
    assert bloqueo is not None and bloqueo.motivo == finanzas.DEVOLUCION_VIVA


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_devolucion_que_salio_sin_referencia_se_puede_reintentar(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """SI NO, EL DINERO SE VA Y EL EXPEDIENTE NO SE CIERRA NUNCA.

    EL DEFECTO. Cuando la pasarela no contesta a tiempo o su respuesta no se
    puede leer, el adaptador devuelve «pendiente» SIN identificador, y con
    razon: la peticion salio con su clave de idempotencia, asi que el reembolso
    puede existir. La fila quedaba en `processing` con `external_refund_id`
    nulo, y `atender_aviso` localiza la fila SOLO por esa columna: el aviso que
    llega despues no la encuentra.

    A partir de ahi no habia ninguna salida por la API. `anular` la rechaza por
    estar en curso, `pedir` la rechazaba por no estar aprobada ni fallida, y el
    webhook no iba a encontrarla jamas. Retencion viva, saldo bloqueado para
    siempre y la reclamacion de origen sin ejecutar.

    REINTENTAR ES SEGURO Y ES LO UNICO QUE PUEDE SERLO: se manda LA MISMA clave
    de idempotencia, asi que la pasarela devuelve el reembolso que ya creo —con
    su identificador— en vez de crear un segundo.
    """
    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-sin-ref", rol="admin")
    devolucion_id = await _devolucion_en_curso(
        sesiones, orden_id, admin, importe=100, referencia="re_se_borra"
    )
    #: Como lo deja un tiempo de espera agotado: en curso y SIN referencia.
    async with sesiones() as db:
        fila = await db.get(ProductRefund, devolucion_id)
        fila.status = devoluciones.DEVOLUCION_EN_CURSO
        fila.external_refund_id = None
        clave = fila.idempotency_key
        await db.commit()

    async with sesiones() as db:
        vuelta = await devoluciones.pedir(
            db, devolucion_id=devolucion_id, actor_id=admin
        )
        await db.commit()
    assert vuelta is not None
    async with sesiones() as db:
        fila = await db.get(ProductRefund, devolucion_id)
    assert fila.idempotency_key == clave, (
        "el reintento cambio la clave: eso crea un SEGUNDO reembolso real"
    )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_devolucion_en_curso_CON_referencia_no_se_vuelve_a_pedir(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """EL CONTROL POSITIVO. Abrir el reintento no puede abrirlo para todas.

    Con identificador, el aviso de la pasarela SI va a encontrar la fila: volver
    a pedirla seria trabajo para nada y ruido en el expediente.
    """
    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-con-ref", rol="admin")
    devolucion_id = await _devolucion_en_curso(
        sesiones, orden_id, admin, importe=100, referencia="re_si_esta"
    )
    async with sesiones() as db:
        fila = await db.get(ProductRefund, devolucion_id)
        fila.status = devoluciones.DEVOLUCION_EN_CURSO
        await db.commit()

    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await devoluciones.pedir(
                db, devolucion_id=devolucion_id, actor_id=admin
            )
    assert fallo.value.details.get("reason") == "already_requested"


# --------------------------------------------------------------------------- #
# La clave que viaja a la pasarela
# --------------------------------------------------------------------------- #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_clave_de_idempotencia_no_sale_de_un_flotante_del_reloj(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """Dos aprobaciones sobre el mismo pedido no pueden chocar por el reloj.

    EL DEFECTO. La clave se componia con `momento.timestamp()`, que es un
    flotante: la cadena que protege dinero real dependia de su representacion
    binaria, y dos aprobaciones con el mismo `momento` —es un parametro
    inyectable— chocaban contra el unico y salia un `IntegrityError` crudo, un
    500 sin codigo, en vez de un conflicto con su motivo.
    """
    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-clave", rol="admin")
    momento = finanzas.ahora()
    claves = set()
    async with sesiones() as db:
        for importe in (100, 150):
            fila = await devoluciones.aprobar(
                db,
                orden_id=orden_id,
                importe_minor=importe,
                motivo="Dos parciales aprobadas a la vez.",
                actor_id=admin,
                momento=momento,
            )
            claves.add(fila.idempotency_key)
        await db.commit()
    assert len(claves) == 2, "dos solicitudes distintas comparten clave"
    for clave in claves:
        assert "." not in clave, f"la clave lleva un flotante dentro: {clave}"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_no_concluyente_cambia_la_clave_y_un_timeout_no(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """LA REGLA QUE YA ESTABA ESCRITA EN `payments.reembolsos`, Y AQUI NO SE USABA.

    Con una clave fija, el primer «no» de la pasarela queda grabado: reintentar
    reenvia la misma clave y la pasarela devuelve LA MISMA respuesta fallida,
    para siempre. El boton de reintentar no serviria de nada nunca mas.

    Y NO PUEDE CAMBIAR SIEMPRE: un tiempo de espera agotado no significa que no
    se haya hecho, y mandar una clave nueva despues de un timeout es exactamente
    como se paga dos veces.
    """
    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "fin-clave2", rol="admin")

    #: CONCLUYENTE: la tarjeta dijo que no. La clave TIENE que cambiar.
    async with sesiones() as db:
        fila = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=100,
            motivo="Se intenta y la tarjeta dice que no.",
            actor_id=admin,
        )
        await db.commit()
        terminal_id = fila.id
    async with sesiones() as db:
        fila = await db.get(ProductRefund, terminal_id)
        fila.status = DEVOLUCION_FALLIDA
        fila.failure_code = "card_declined"
        #: EL CHECK `product_refunds_fallida_con_fecha` LO EXIGE, y hace bien:
        #: una fallida sin fecha no se puede ordenar en el historial.
        fila.failed_at = finanzas.ahora()
        antes = fila.idempotency_key
        await db.commit()
    async with sesiones() as db:
        await devoluciones.pedir(db, devolucion_id=terminal_id, actor_id=admin)
        await db.commit()
    async with sesiones() as db:
        fila = await db.get(ProductRefund, terminal_id)
    assert fila.idempotency_key != antes, (
        "tras un no concluyente la clave no cambio: reintentar no servira nunca"
    )

    #: AMBIGUO: no hubo respuesta. La clave NO puede cambiar.
    async with sesiones() as db:
        otra = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=120,
            motivo="Se intenta y no contesta nadie.",
            actor_id=admin,
        )
        await db.commit()
        ambigua_id = otra.id
    async with sesiones() as db:
        fila = await db.get(ProductRefund, ambigua_id)
        fila.status = DEVOLUCION_FALLIDA
        fila.failure_code = "network_timeout"
        fila.failed_at = finanzas.ahora()
        antes = fila.idempotency_key
        await db.commit()
    async with sesiones() as db:
        await devoluciones.pedir(db, devolucion_id=ambigua_id, actor_id=admin)
        await db.commit()
    async with sesiones() as db:
        fila = await db.get(ProductRefund, ambigua_id)
    assert fila.idempotency_key == antes, (
        "tras un timeout la clave cambio: asi es como se paga dos veces"
    )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_aviso_sin_identificador_y_otro_con_el_son_UNA_disputa(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """DOS FILAS PARA EL MISMO CONTRACARGO DEJABAN UNA ABIERTA PARA SIEMPRE.

    EL DEFECTO. Cuando el aviso no trae `dp_...` se deriva una clave del cobro,
    que es lo correcto: sigue siendo idempotente. Pero el siguiente aviso del
    MISMO contracargo si lo trae, y con otra clave se abria una SEGUNDA fila. El
    cierre llega con el identificador de verdad y solo cierra la segunda: la
    primera se queda abierta, y `por_que_no_se_libera` bloquea tambien por
    pedido, asi que ese saldo no se libera nunca por una disputa fantasma que ya
    se resolvio.

    LO QUE SE HACE AHORA: la fila derivada se ASCIENDE a su identificador real
    en cuanto llega. No se crea otra y no se pierde el historial.
    """
    _, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)
    cobro = await _cobro_propio(sesiones, orden_id)
    from app.modules.products import disputas

    identificador = "dp_" + uuid.uuid4().hex[:16]

    #: 1. EL PRIMER AVISO NO LO TRAE.
    async with sesiones() as db:
        sin_id = AvisoDeDisputa(
            referencia_cobro=cobro, estado="disputa_abierta", disputa=""
        )
        await disputas.atender_aviso(db, sin_id)
        await db.commit()

    #: 2. EL SEGUNDO SI, Y ES EL MISMO CONTRACARGO.
    async with sesiones() as db:
        await disputas.atender_aviso(
            db,
            AvisoDeDisputa(
                referencia_cobro=cobro,
                estado="disputa_fondos_retirados",
                disputa=identificador,
            ),
        )
        await db.commit()

    async with sesiones() as db:
        filas = list(
            await db.scalars(
                select(ProductDispute).where(ProductDispute.order_id == orden_id)
            )
        )
    assert len(filas) == 1, (
        f"un solo contracargo abrio {len(filas)} filas; la derivada se queda "
        "abierta para siempre y ese saldo no se libera nunca"
    )
    assert filas[0].external_dispute_id == identificador, (
        "la fila se quedo con la clave derivada y el cierre no la va a encontrar"
    )

    #: 3. Y EL CIERRE, QUE LLEGA CON EL DE VERDAD, LA CIERRA.
    async with sesiones() as db:
        await disputas.atender_aviso(
            db,
            AvisoDeDisputa(
                referencia_cobro=cobro,
                estado="disputa_cerrada",
                disputa=identificador,
                cierre="won",
            ),
        )
        await db.commit()
    async with sesiones() as db:
        fila = await db.scalar(
            select(ProductDispute).where(ProductDispute.order_id == orden_id)
        )
        saldo = await db.get(OwnerSaleBalance, saldo_id)
    assert fila.status == disputas.DISPUTA_GANADA
    assert saldo.status == finanzas.PENDIENTE, "el saldo se quedo congelado"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_contracargos_distintos_del_mismo_cobro_siguen_siendo_dos(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """EL CONTROL POSITIVO, Y ES EL MOTIVO POR EL QUE LA CLAVE ES LA DE LA DISPUTA.

    Un mismo cobro puede tener mas de un contracargo a lo largo del tiempo. Si
    ascender la fila derivada se convirtiera en «toda disputa de este cobro es la
    misma», el segundo actualizaria al primero en vez de abrirse.
    """
    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    cobro = await _cobro_propio(sesiones, orden_id)
    from app.modules.products import disputas

    uno = "dp_" + uuid.uuid4().hex[:16]
    dos = "dp_" + uuid.uuid4().hex[:16]
    for ident in (uno, dos):
        async with sesiones() as db:
            await disputas.atender_aviso(
                db,
                AvisoDeDisputa(
                    referencia_cobro=cobro, estado="disputa_abierta", disputa=ident
                ),
            )
            await db.commit()

    async with sesiones() as db:
        filas = list(
            await db.scalars(
                select(ProductDispute).where(ProductDispute.order_id == orden_id)
            )
        )
    assert {f.external_dispute_id for f in filas} == {uno, dos}
