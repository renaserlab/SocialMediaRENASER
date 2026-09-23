# -*- coding: utf-8 -*-
"""El webhook de devoluciones y los contracargos, ejecutados.

LO QUE SE PRUEBA AQUI NO SE PODIA PROBAR ANTES, y no por falta de pruebas:

  - una devolucion `pending` NO llegaba nunca a `confirmed`, porque el unico
    camino de confirmacion era la respuesta sincrona de `pedir` y los avisos
    de la pasarela solo se anotaban;
  - y NADA insertaba jamas una fila en `product_disputes`, asi que la puerta de
    disputa de `por_que_no_se_libera` —escrita, comentada y con su indice— no
    podia dispararse en ninguna circunstancia.

Los avisos se construyen a mano con la misma forma que trae el webhook YA
VERIFICADO: aqui no se prueba la firma —eso es del puerto compartido y ya tiene
sus pruebas—, sino que lo verificado llega a su dominio y hace lo que debe.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select

from app.modules.commerce.models import OwnerSaleBalance
from app.modules.payments.providers import PaymentEvent
from app.modules.products import devoluciones, disputas, finanzas, pagos
from app.modules.products.finanzas_models import ProductDispute, ProductRefund
from app.modules.products.models import ProductOrder
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
)
from tests.test_productos_finanzas import (  # noqa: F401
    comision_puesta,
    con_saldo,
    cuenta_lista,
)
from tests.test_productos_incidencias import pedido_entregado  # noqa: F401
from tests.test_productos_pedidos import (  # noqa: F401
    venta_encendida,
)


def aviso(
    *,
    estado: str,
    cobro: str,
    reembolso: str = "",
    disputa: str = "",
    importe: int = 1000,
    moneda: str = "PEN",
    tipo: str = "",
    payload: dict | None = None,
    entorno: str = "sandbox",
) -> PaymentEvent:
    """Un aviso como el que entrega el webhook DESPUES de verificar la firma."""
    return PaymentEvent(
        purchase_id="",
        provider_transaction_id=cobro,
        status=estado,
        amount_minor=importe,
        currency=moneda,
        event_id=str(uuid.uuid4()),
        event_type=tipo or estado,
        environment=entorno,
        payload=payload or {},
        dominio=pagos.DOMINIO,
        refund_id=reembolso,
        dispute_id=disputa,
    )


async def cobro_de(sesiones, orden_id: str) -> str:  # noqa: ANN001
    """La referencia del cobro, PROPIA de este pedido.

    EL FIXTURE LA PONE CONSTANTE —`pi_de_prueba`— porque a las pruebas de
    pedidos les da igual. Aqui no: la disputa se identifica contra el cobro y
    varias pruebas compartiendo referencia colisionan en el indice unico, que
    es un choque de la prueba y no del codigo. En produccion cada pedido tiene
    su propio PaymentIntent, asi que esto se parece mas a la realidad que
    dejarla como esta.
    """
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        if str(orden.external_payment_id or "").startswith("pi_de_prueba"):
            orden.external_payment_id = "pi_" + str(orden.id)[:18]
            await db.commit()
        return str(orden.external_payment_id)


def disputa_de(cobro: str) -> str:
    """El `dp_...` que mandaria la pasarela para ese cobro."""
    return "dp_" + cobro.replace("pi_", "")


# =========================================================================== #
# 1. EL WEBHOOK DE DEVOLUCIONES (4.2)
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_devolucion_pendiente_se_confirma_por_el_aviso(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """EL RECORRIDO QUE NO EXISTIA.

    La pasarela contesta `pending`, la devolucion se queda «en curso», y solo
    un aviso posterior dice que el dinero salio. Sin encaminar ese aviso, la
    devolucion se quedaba en curso PARA SIEMPRE y el saldo bloqueado con ella.
    """
    from app.modules.payments.reembolsos import DobleDeterminista

    _, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "disp-pend", rol="admin")
    doble = DobleDeterminista()
    monkeypatch.setattr(devoluciones, "_proveedor", lambda: doble)

    #: UN IMPORTE TERMINADO EN 01 hace que el doble conteste «pendiente».
    async with sesiones() as db:
        fila = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=501,
            motivo="Una parte, y la pasarela tarda.",
            actor_id=admin,
        )
        devolucion_id = fila.id
        await db.commit()

    async with sesiones() as db:
        pedida = await devoluciones.pedir(
            db, devolucion_id=devolucion_id, actor_id=admin
        )
        referencia = pedida.external_refund_id
        await db.commit()
        assert pedida.status == devoluciones.DEVOLUCION_EN_CURSO
        assert referencia

    #: Y AHORA EL AVISO, por la puerta del webhook.
    async with sesiones() as db:
        nota = await pagos.atender_aviso(
            db,
            aviso(
                estado="refund_parcial",
                cobro=await cobro_de(sesiones, orden_id),
                reembolso=referencia,
                tipo="charge.refund.updated",
            ),
        )
        await db.commit()
    assert nota is None, nota

    async with sesiones() as db:
        final = await db.get(ProductRefund, devolucion_id)
        assert final.status == devoluciones.DEVOLUCION_CONFIRMADA
        assert final.confirmed_at is not None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_mismo_aviso_dos_veces_no_confirma_dos_veces(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """Idempotencia del efecto, no solo de la barrera anti-repeticion.

    La barrera de arriba para el aviso REPETIDO. Esta prueba entra por debajo
    de ella, que es lo que pasaria con dos avisos distintos que digan lo mismo:
    `refund.updated` y `charge.refunded` del mismo reembolso.
    """
    from app.modules.payments.reembolsos import DobleDeterminista

    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "disp-dos", rol="admin")
    monkeypatch.setattr(devoluciones, "_proveedor", DobleDeterminista)

    async with sesiones() as db:
        fila = await devoluciones.aprobar(
            db,
            orden_id=orden_id,
            importe_minor=501,
            motivo="Pendiente.",
            actor_id=admin,
        )
        devolucion_id = fila.id
        await db.commit()
    async with sesiones() as db:
        pedida = await devoluciones.pedir(
            db, devolucion_id=devolucion_id, actor_id=admin
        )
        referencia = pedida.external_refund_id
        await db.commit()

    cobro = await cobro_de(sesiones, orden_id)
    for _ in range(2):
        async with sesiones() as db:
            await pagos.atender_aviso(
                db,
                aviso(
                    estado="refunded",
                    cobro=cobro,
                    reembolso=referencia,
                    tipo="charge.refunded",
                ),
            )
            await db.commit()

    async with sesiones() as db:
        final = await db.get(ProductRefund, devolucion_id)
        assert final.status == devoluciones.DEVOLUCION_CONFIRMADA
        #: UNA SOLA FILA DE HISTORIAL diciendo «confirmada».
        cuantas = await db.scalar(
            select(func.count())
            .select_from(devoluciones.ProductRefundEvent)
            .where(
                devoluciones.ProductRefundEvent.refund_id == devolucion_id,
                devoluciones.ProductRefundEvent.to_status
                == devoluciones.DEVOLUCION_CONFIRMADA,
            )
        )
        assert cuantas == 1, cuantas


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_aviso_de_fallo_posterior_no_deshace_una_confirmada(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """FUERA DE ORDEN. La pasarela puede avisar tarde y desordenado."""
    from app.modules.payments.reembolsos import DobleDeterminista

    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    admin = await persona(sesiones, "disp-orden", rol="admin")
    monkeypatch.setattr(devoluciones, "_proveedor", DobleDeterminista)

    async with sesiones() as db:
        fila = await devoluciones.aprobar(
            db, orden_id=orden_id, importe_minor=500, motivo="Se acordo devolver.", actor_id=admin
        )
        devolucion_id = fila.id
        await db.commit()
    async with sesiones() as db:
        pedida = await devoluciones.pedir(
            db, devolucion_id=devolucion_id, actor_id=admin
        )
        referencia = pedida.external_refund_id
        await db.commit()
        assert pedida.status == devoluciones.DEVOLUCION_CONFIRMADA

    async with sesiones() as db:
        await pagos.atender_aviso(
            db,
            aviso(
                estado="refund_fallido",
                cobro=await cobro_de(sesiones, orden_id),
                reembolso=referencia,
                tipo="refund.failed",
            ),
        )
        await db.commit()

    async with sesiones() as db:
        final = await db.get(ProductRefund, devolucion_id)
        assert final.status == devoluciones.DEVOLUCION_CONFIRMADA
        assert final.failed_at is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_aviso_de_otro_reembolso_no_toca_el_nuestro(
    sesiones, monkeypatch, comision_puesta
) -> None:
    """Un `re_...` que no es de Productos deja una nota y no cambia nada."""
    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    async with sesiones() as db:
        nota = await pagos.atender_aviso(
            db,
            aviso(
                estado="refunded",
                cobro=await cobro_de(sesiones, orden_id),
                reembolso="re_de_otro_dominio",
                tipo="charge.refunded",
            ),
        )
        await db.commit()
    assert nota is not None
    assert "conciliar" in nota.lower()


# =========================================================================== #
# 2. LOS CONTRACARGOS (4.3)
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_disputa_se_registra_y_congela_el_saldo(
    sesiones, monkeypatch, cuenta_lista
) -> None:
    """LA FILA QUE NADIE ESCRIBIA.

    `por_que_no_se_libera` tenia su puerta de disputa desde el Incremento 9,
    con su indice y su comentario sobre mirar por saldo O por pedido. No podia
    dispararse jamas porque nada insertaba una fila.
    """
    _, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)
    cobro = await cobro_de(sesiones, orden_id)

    async with sesiones() as db:
        nota = await pagos.atender_aviso(
            db,
            aviso(
                estado="disputa_abierta",
                cobro=cobro,
                tipo="charge.dispute.created",
                importe=800,
            ),
        )
        await db.commit()
    assert nota is None, nota

    async with sesiones() as db:
        fila = await db.scalar(
            select(ProductDispute).where(ProductDispute.order_id == orden_id)
        )
        assert fila is not None
        assert fila.status == disputas.DISPUTA_ABIERTA
        assert fila.provider == "stripe"

        #: EL SALDO, CONGELADO. Es lo que ve quien vende.
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        assert saldo.status == finanzas.RETENIDO

        #: Y SU IMPORTE, APARTADO. Es lo que impide que el barrido lo pague.
        reservas = await finanzas.reservas_de(db, saldo_id=saldo_id, solo_vivas=True)
        assert any(r.reason == finanzas.RESERVA_POR_DISPUTA for r in reservas)

        #: Y EL BLOQUEO LO DICE.
        bloqueo = await finanzas.por_que_no_se_libera(db, saldo=saldo)
        assert bloqueo is not None
        assert bloqueo.motivo in (
            finanzas.SALDO_NO_PENDIENTE,
            finanzas.RESERVA_VIVA,
            finanzas.DISPUTA_ABIERTA_BLOQUEA,
        )


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_mismo_contracargo_dos_veces_es_una_sola_fila(
    sesiones, monkeypatch, cuenta_lista
) -> None:
    """La unicidad la sostiene el indice (provider, referencia), no un `select`."""
    _, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)
    cobro = await cobro_de(sesiones, orden_id)

    for tipo in ("charge.dispute.created", "charge.dispute.funds_withdrawn"):
        estado = (
            "disputa_abierta"
            if tipo.endswith("created")
            else "disputa_fondos_retirados"
        )
        async with sesiones() as db:
            await pagos.atender_aviso(
                db,
                aviso(
                    estado=estado,
                    cobro=cobro,
                    disputa=disputa_de(cobro),
                    tipo=tipo,
                    importe=800,
                ),
            )
            await db.commit()

    async with sesiones() as db:
        cuantas = await db.scalar(
            select(func.count())
            .select_from(ProductDispute)
            .where(ProductDispute.order_id == orden_id)
        )
        assert cuantas == 1, cuantas
        fila = await db.scalar(
            select(ProductDispute).where(ProductDispute.order_id == orden_id)
        )
        #: Y AVANZO: el segundo aviso movio el estado, no creo otra fila.
        assert fila.status == disputas.DISPUTA_EN_REVISION

        #: UNA SOLA RESERVA, tambien. Dos apartarian el dinero dos veces.
        reservas = await finanzas.reservas_de(db, saldo_id=saldo_id, solo_vivas=True)
        por_disputa = [
            r for r in reservas if r.reason == finanzas.RESERVA_POR_DISPUTA
        ]
        assert len(por_disputa) == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_disputa_ganada_devuelve_el_saldo_a_la_cola(
    sesiones, monkeypatch, cuenta_lista
) -> None:
    """GANARLA NO ES COBRARLA. Vuelve a la cola y pasa otra vez por las puertas."""
    _, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)
    cobro = await cobro_de(sesiones, orden_id)

    async with sesiones() as db:
        await pagos.atender_aviso(
            db, aviso(
                estado="disputa_abierta",
                cobro=cobro,
                disputa=disputa_de(cobro),
                importe=800,
            )
        )
        await db.commit()

    async with sesiones() as db:
        await pagos.atender_aviso(
            db,
            aviso(
                estado="disputa_cerrada",
                cobro=cobro,
                disputa=disputa_de(cobro),
                tipo="charge.dispute.closed",
                importe=800,
                payload={"data": {"object": {"status": "won"}}},
            ),
        )
        await db.commit()

    async with sesiones() as db:
        fila = await db.scalar(
            select(ProductDispute).where(ProductDispute.order_id == orden_id)
        )
        assert fila.status == disputas.DISPUTA_GANADA
        assert fila.closed_at is not None

        saldo = await db.get(OwnerSaleBalance, saldo_id)
        #: A LA COLA, no a «cobrable».
        assert saldo.status == finanzas.PENDIENTE

        #: Y LA RESERVA, SOLTADA sin consumir: ese dinero no se fue.
        reservas = await finanzas.reservas_de(db, saldo_id=saldo_id)
        por_disputa = [
            r for r in reservas if r.reason == finanzas.RESERVA_POR_DISPUTA
        ]
        assert por_disputa
        assert all(r.status == finanzas.RESERVA_SOLTADA for r in por_disputa)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_disputa_perdida_cancela_el_saldo_y_lo_dice(
    sesiones, monkeypatch, cuenta_lista
) -> None:
    """PERDERLA ES QUE EL DINERO SE FUE. No se le paga a nadie, y no se inventa
    un cargo: quien asume el coste esta sin decidir, y la nota lo dice."""
    _, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)
    cobro = await cobro_de(sesiones, orden_id)

    async with sesiones() as db:
        await pagos.atender_aviso(
            db, aviso(
                estado="disputa_abierta",
                cobro=cobro,
                disputa=disputa_de(cobro),
                importe=800,
            )
        )
        await db.commit()

    async with sesiones() as db:
        nota = await pagos.atender_aviso(
            db,
            aviso(
                estado="disputa_cerrada",
                cobro=cobro,
                disputa=disputa_de(cobro),
                tipo="charge.dispute.closed",
                importe=800,
                payload={"data": {"object": {"status": "lost"}}},
            ),
        )
        await db.commit()

    assert nota is not None
    assert "sin decidir" in nota.lower()

    async with sesiones() as db:
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        assert saldo.status == finanzas.CANCELADO
        reservas = await finanzas.reservas_de(db, saldo_id=saldo_id)
        por_disputa = [
            r for r in reservas if r.reason == finanzas.RESERVA_POR_DISPUTA
        ]
        #: CONSUMIDA: ese dinero se gasto en el contracargo.
        assert all(r.status == finanzas.RESERVA_CONSUMIDA for r in por_disputa)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_cierre_fuera_de_orden_no_reabre_una_disputa(
    sesiones, monkeypatch, cuenta_lista
) -> None:
    """Un `created` que llega DESPUES del `closed` dejaria el saldo bloqueado
    para siempre sobre algo que ya se resolvio."""
    _, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)
    cobro = await cobro_de(sesiones, orden_id)

    async with sesiones() as db:
        await pagos.atender_aviso(
            db,
            aviso(
                estado="disputa_cerrada",
                cobro=cobro,
                disputa=disputa_de(cobro),
                tipo="charge.dispute.closed",
                importe=800,
                payload={"data": {"object": {"status": "won"}}},
            ),
        )
        await db.commit()

    async with sesiones() as db:
        await pagos.atender_aviso(
            db, aviso(
                estado="disputa_abierta",
                cobro=cobro,
                disputa=disputa_de(cobro),
                importe=800,
            )
        )
        await db.commit()

    async with sesiones() as db:
        fila = await db.scalar(
            select(ProductDispute).where(ProductDispute.order_id == orden_id)
        )
        assert fila.status == disputas.DISPUTA_GANADA, "se reabrio una cerrada"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_contracargo_de_otro_pedido_no_toca_nada(
    sesiones, monkeypatch, cuenta_lista
) -> None:
    """Un aviso con una referencia de cobro que no es nuestra no escribe nada."""
    _, orden_id, _, _ = await con_saldo(sesiones, monkeypatch)
    async with sesiones() as db:
        antes = await db.scalar(select(func.count()).select_from(ProductDispute))
        nota = await pagos.atender_aviso(
            db,
            aviso(
                estado="disputa_abierta",
                cobro="pi_de_otra_plataforma",
                disputa="dp_de_otra_plataforma",
                tipo="charge.dispute.created",
            ),
        )
        await db.commit()
    assert nota is None
    async with sesiones() as db:
        despues = await db.scalar(select(func.count()).select_from(ProductDispute))
    assert despues == antes


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_cierre_que_no_se_entiende_no_suelta_el_dinero(
    sesiones, monkeypatch, cuenta_lista
) -> None:
    """LO QUE NO SE ENTIENDE NO SE DA POR GANADO.

    Un `closed` con un estado que no conocemos deja la disputa en revision, que
    sigue bloqueando. Darlo por ganado soltaria dinero que quiza ya se fue.
    """
    _, orden_id, _, saldo_id = await con_saldo(sesiones, monkeypatch)
    cobro = await cobro_de(sesiones, orden_id)

    async with sesiones() as db:
        await pagos.atender_aviso(
            db, aviso(
                estado="disputa_abierta",
                cobro=cobro,
                disputa=disputa_de(cobro),
                importe=800,
            )
        )
        await db.commit()

    async with sesiones() as db:
        await pagos.atender_aviso(
            db,
            aviso(
                estado="disputa_cerrada",
                cobro=cobro,
                disputa=disputa_de(cobro),
                tipo="charge.dispute.closed",
                importe=800,
                payload={"data": {"object": {"status": "lo_que_sea"}}},
            ),
        )
        await db.commit()

    async with sesiones() as db:
        fila = await db.scalar(
            select(ProductDispute).where(ProductDispute.order_id == orden_id)
        )
        assert fila.status == disputas.DISPUTA_EN_REVISION
        saldo = await db.get(OwnerSaleBalance, saldo_id)
        assert saldo.status == finanzas.RETENIDO
