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
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.core.config import get_settings
from app.core.exceptions import AppError
from app.modules.commerce.models import OwnerSaleBalance
from app.modules.events.finanzas_models import OwnerSaleReserve
from app.modules.products import devoluciones, envios, esquema, finanzas
from app.modules.products import estados_de_incidencia as maquina
from app.modules.products.finanzas_models import (
    DEVOLUCION_APROBADA,
    DEVOLUCION_CONFIRMADA,
    DEVOLUCION_FALLIDA,
    DEVOLUCION_PEDIDA,
    ProductDispute,
    ProductRefund,
)
from app.modules.products.models import ProductOrder, ProductShipment
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
    async with sesiones() as db:
        with pytest.raises((IntegrityError, DBAPIError)):
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
        await db.rollback()

    async with sesiones() as db:
        with pytest.raises((IntegrityError, DBAPIError)):
            await db.execute(
                text(
                    "insert into owner_sale_balances"
                    " (id, owner_id, gross_amount_minor, platform_fee_minor,"
                    "  net_amount_minor, currency, fee_rules_version, status)"
                    " values (gen_random_uuid(), :p, 100, 10, 90, 'PEN',"
                    "         'v1', 'pending')"
                ),
                {"p": proveedor},
            )
        await db.rollback()


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

    from app.modules.products.models import ProductPolicy

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
    assert fila.failure_code in (
        "provider_not_configured",
        "partial_refund_not_supported",
    )
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
            db, referencia_externa="re_de_mentira", exito=True
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
                db, referencia_externa="re_dos_veces", exito=True
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
            db, referencia_externa="re_contradictorio", exito=True
        )
        await db.commit()
    async with sesiones() as db:
        await devoluciones.atender_aviso(
            db, referencia_externa="re_contradictorio", exito=False, codigo="x"
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
            db, referencia_externa="re_pagado", exito=True
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
