"""Órdenes, emisión de entradas, QR y check-in, por HTTP.

LO QUE ESTO PRUEBA Y LO QUE NO. Aquí están las reglas que no necesitan dos
escritores a la vez: idempotencia, congelación de precios, comprobación del
importe y la moneda, emisión exacta, permisos y check-in. La CARRERA —dos
webhooks a la vez, dos lectores escaneando el mismo QR— vive en
`test_ordenes_concurrentes_postgres.py` y solo significa algo contra PostgreSQL.

AQUÍ NO SE COBRA NADA DE VERDAD. No hay credenciales de Stripe, la bandera de
pagos nace apagada y ninguna prueba llama a una pasarela. Lo que se ejercita es
qué hace el servidor cuando le llega un aviso YA VERIFICADO, que es donde están
las formas conocidas de regalar una entrada.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.catalog.models import Event
from app.modules.events import esquema, orders, ticketing
from app.modules.events import tickets as emision
from app.modules.gobernanza.models import AuditEvent
from app.modules.events.models import (
    EventCheckin,
    EventOperations,
    EventOrder,
    EventTicket,
    EventTicketHold,
    EventTicketingSettings,
    EventTicketType,
)
from app.modules.commerce.models import PaymentEvent as ComercioPaymentEvent
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db

EVENTOS = "/api/v1/events"
ADMIN = "/api/v1/admin/events"

ORG = "cccccccc-3333-0000-0000-000000000001"
ANA = "aaaaaaaa-3333-0000-0000-000000000001"
BRUNO = "aaaaaaaa-3333-0000-0000-000000000002"
ADMINISTRA = "dddddddd-3333-0000-0000-000000000001"
MODERA = "dddddddd-3333-0000-0000-000000000002"

CON_ENTRADAS = "eeeeeeee-3333-0000-0000-0000000000a1"
GRATIS = "eeeeeeee-3333-0000-0000-0000000000a2"
AJENO = "eeeeeeee-3333-0000-0000-0000000000a3"

GENERAL = "ffffffff-3333-0000-0000-00000000000a"
VIP = "ffffffff-3333-0000-0000-00000000000b"
CORTESIA = "ffffffff-3333-0000-0000-00000000000c"


@pytest_asyncio.fixture
async def entorno(monkeypatch):
    esquema.olvidar()
    monkeypatch.setattr(get_settings(), "feature_event_ticketing", True, raising=False)
    # LA DE PAGOS SIGUE APAGADA. Se enciende solo en las pruebas que la miran.
    monkeypatch.setattr(get_settings(), "feature_event_payments", False, raising=False)
    # `payments_environment` se DERIVA del entorno del despliegue y no tiene
    # setter: se fija el entorno, que es lo que de verdad manda.
    monkeypatch.setattr(get_settings(), "environment", "development", raising=False)

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sesiones = async_sessionmaker(engine, expire_on_commit=False)

    ahora = datetime.now(timezone.utc)
    async with sesiones() as db:
        for ident, nombre, rol in (
            (ORG, "Org", "user"),
            (ANA, "Ana", "user"),
            (BRUNO, "Bruno", "user"),
            (ADMINISTRA, "Admin", "admin"),
            (MODERA, "Modera", "moderator"),
        ):
            db.add(Profile(id=ident, full_name=nombre, username=nombre.lower(), role=rol))

        def evento(ident, organizador=ORG, aforo=100):
            return Event(
                id=ident,
                organizer_id=organizador,
                title=f"Evento {ident[-2:]}",
                description="Una descripción suficientemente larga para revisarla.",
                starts_at=ahora + timedelta(days=20),
                event_type="presential",
                location="Teatro Fénix",
                status="published",
                capacity=aforo,
            )

        db.add(evento(CON_ENTRADAS))
        db.add(evento(GRATIS))
        db.add(evento(AJENO, organizador=ADMINISTRA))
        for ident in (CON_ENTRADAS, GRATIS, AJENO):
            db.add(
                EventOperations(
                    event_id=ident,
                    workflow_status="PUBLISHED",
                    selection_status="none",
                    origin="events_v2",
                )
            )
        for ident in (CON_ENTRADAS, AJENO):
            db.add(
                EventTicketingSettings(
                    event_id=ident, access_mode="TICKETED", currency="PEN"
                )
            )

        db.add(
            EventTicketType(
                id=GENERAL,
                event_id=CON_ENTRADAS,
                name="General",
                description="Acceso a la sala.",
                price_minor=4900,
                currency="PEN",
                quota=20,
                min_per_order=1,
                max_per_order=6,
                status="on_sale",
                sort_order=1,
            )
        )
        db.add(
            EventTicketType(
                id=VIP,
                event_id=CON_ENTRADAS,
                name="VIP",
                price_minor=15000,
                currency="PEN",
                quota=5,
                max_per_order=2,
                status="on_sale",
                sort_order=0,
            )
        )
        # UNA CORTESÍA: precio cero DENTRO de un evento con entradas. No es lo
        # mismo que un evento gratuito, y es el camino que se confirma solo.
        db.add(
            EventTicketType(
                id=CORTESIA,
                event_id=CON_ENTRADAS,
                name="Cortesía",
                price_minor=0,
                currency="PEN",
                quota=5,
                max_per_order=2,
                status="on_sale",
                sort_order=2,
            )
        )
        await db.commit()

    identidad = {"uid": ANA}

    async def _db():
        async with sesiones() as sesion:
            yield sesion

    async def _usuario() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _usuario
    app.dependency_overrides[get_optional_user] = _usuario
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, identidad, sesiones
    for dep in (get_db, get_current_user, get_optional_user):
        app.dependency_overrides.pop(dep, None)
    await engine.dispose()


async def _apartar(http, tipo, cantidad, clave, evento=CON_ENTRADAS):
    respuesta = await http.post(
        f"{EVENTOS}/{evento}/ticket-holds",
        json={"items": [{"ticket_type_id": tipo, "quantity": cantidad}]},
        headers={"Idempotency-Key": clave},
    )
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()


async def _pedir(http, hold_id, clave):
    return await http.post(
        f"{EVENTOS}/ticket-holds/{hold_id}/orders",
        headers={"Idempotency-Key": clave},
    )


async def _abrir_cobro(sesiones, orden_id):
    """Lo que hace `iniciar_pago` sin llamar a ninguna pasarela.

    Una orden que nunca abrio un cobro no la confirma ningun aviso, asi que las
    pruebas del camino de pago tienen que dejarla como la dejaria el checkout.
    """
    async with sesiones() as db:
        orden = await db.get(EventOrder, orden_id)
        # SOLO SI TODAVIA ADMITE UN PAGO. Una orden ya pagada o cancelada no
        # abre ningun cobro, y forzarle el estado rompe los CHECK que exigen que
        # el estado y las fechas digan lo mismo, que es justo lo que protegen.
        if orden.status != "PENDING_PAYMENT":
            return
        orden.provider = "stripe"
        orden.environment = "sandbox"
        orden.operation_ref = f"evt-ord-{orden_id}"
        orden.status = "PAYMENT_PROCESSING"
        await db.commit()


async def _confirmar(sesiones, orden_id, importe, **cambios):
    """Un aviso YA VERIFICADO, con los valores que la prueba quiera romper.

    EL IMPORTE SE PASA A MANO Y NO SE LEE DE LA ORDEN. Leerlo de la propia fila
    hacia que el aviso coincidiera SIEMPRE: si `crear_orden` calculase mal el
    total, todas las pruebas del camino feliz seguirian en verde comparando el
    error consigo mismo.
    """
    await _abrir_cobro(sesiones, orden_id)
    datos = {
        "provider": "stripe",
        "environment": "sandbox",
        "external_payment_id": f"pi_{orden_id[:8]}",
        "amount_minor": importe,
        "currency": "PEN",
    }
    datos.update(cambios)
    async with sesiones() as db:
        # EL `commit` LO HACE QUIEN LLAMA, igual que el webhook: `confirmar_pago`
        # corre dentro de un savepoint y no puede tocar la transaccion de fuera.
        try:
            resultado = await orders.confirmar_pago(db, orden_id=orden_id, **datos)
        except Exception:
            await db.rollback()
            raise
        await db.commit()
        return resultado


# --------------------------------------------------------------------------- #
# Crear la orden
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_una_reserva_vigente_se_convierte_en_pedido(entorno):
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 2, "h1")
    respuesta = await _pedir(http, hold["id"], "o1")

    assert respuesta.status_code == 201, respuesta.text
    cuerpo = respuesta.json()
    assert cuerpo["status"] == "PENDING_PAYMENT"
    assert cuerpo["subtotal_minor"] == 9800
    assert cuerpo["total_minor"] == 9800
    assert cuerpo["currency"] == "PEN"
    assert [(l["ticket_type_id"], l["quantity"]) for l in cuerpo["items"]] == [
        (GENERAL, 2)
    ]

    # NO SE EMITE NADA Y NO SE CONSUME LA RESERVA: el inventario sigue siendo
    # del hold hasta que el pago se confirme.
    async with sesiones() as db:
        assert (await db.scalars(select(EventTicket))).all() == []
        assert (await db.get(EventTicketHold, hold["id"])).status == "ACTIVE"


@pytest.mark.asyncio
async def test_el_mismo_pedido_dos_veces_es_el_mismo_pedido(entorno):
    """Un reintento de la red no crea dos pedidos sobre la misma reserva."""
    http, _, _ = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    primera = await _pedir(http, hold["id"], "misma")
    segunda = await _pedir(http, hold["id"], "misma")
    assert primera.status_code == 201
    assert segunda.status_code == 201
    assert primera.json()["id"] == segunda.json()["id"]


@pytest.mark.asyncio
async def test_otra_clave_sobre_la_misma_reserva_lleva_al_pedido_que_ya_hay(entorno):
    """Y dice CUÁL, para que la pantalla pueda ir en vez de dejar un error."""
    http, _, _ = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    primera = await _pedir(http, hold["id"], "una")
    otra = await _pedir(http, hold["id"], "otra")

    assert otra.status_code == 409
    error = otra.json()["error"]
    assert error["code"] == "event_order_already_exists"
    assert error["details"]["order_id"] == primera.json()["id"]


@pytest.mark.asyncio
async def test_la_misma_clave_sobre_otra_reserva_es_un_conflicto(entorno):
    """No se le devuelve un pedido que no pidió."""
    http, identidad, sesiones = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    assert (await _pedir(http, hold["id"], "clave")).status_code == 201

    # La misma persona, otro evento, la misma clave.
    async with sesiones() as db:
        viejo = await db.get(EventTicketHold, hold["id"])
        viejo.status = "RELEASED"
        await db.commit()
    otro = await _apartar(http, VIP, 1, "h2")
    respuesta = await _pedir(http, otro["id"], "clave")
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "event_order_conflict"


@pytest.mark.asyncio
async def test_la_reserva_de_otra_persona_no_existe(entorno):
    http, identidad, _ = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    identidad["uid"] = BRUNO
    respuesta = await _pedir(http, hold["id"], "ajena")
    assert respuesta.status_code == 404
    assert respuesta.json()["error"]["code"] == "ticket_hold_not_found"


@pytest.mark.asyncio
@pytest.mark.parametrize("estado", ["EXPIRED", "RELEASED", "CONSUMED"])
async def test_una_reserva_que_ya_no_aparta_nada_no_se_compra(entorno, estado):
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    async with sesiones() as db:
        fila = await db.get(EventTicketHold, hold["id"])
        fila.status = estado
        await db.commit()

    respuesta = await _pedir(http, hold["id"], "tarde")
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "ticket_hold_not_usable"


@pytest.mark.asyncio
async def test_una_reserva_vencida_por_reloj_tampoco(entorno):
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    async with sesiones() as db:
        fila = await db.get(EventTicketHold, hold["id"])
        fila.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await db.commit()

    respuesta = await _pedir(http, hold["id"], "tarde")
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "ticket_hold_not_usable"


@pytest.mark.asyncio
async def test_el_precio_del_pedido_es_el_que_se_aparto(entorno):
    """Entre apartar y pagar el organizador puede subir el precio. No se cobra
    el nuevo: se cobra lo que se enseñó."""
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 2, "h1")
    async with sesiones() as db:
        tipo = await db.get(EventTicketType, GENERAL)
        tipo.price_minor = 99900
        tipo.name = "General renombrado"
        await db.commit()

    cuerpo = (await _pedir(http, hold["id"], "o1")).json()
    assert cuerpo["subtotal_minor"] == 9800, "el precio viejo, el que se apartó"
    assert cuerpo["items"][0]["name"] == "General"
    assert cuerpo["items"][0]["unit_price_minor"] == 4900


# --------------------------------------------------------------------------- #
# Total cero: se confirma sin proveedor
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_pedido_de_cero_se_confirma_y_emite(entorno):
    """Una cortesía no necesita pasarela: no hay dinero que confirmar."""
    http, _, sesiones = entorno
    hold = await _apartar(http, CORTESIA, 2, "h1")
    cuerpo = (await _pedir(http, hold["id"], "o1")).json()

    assert cuerpo["status"] == "PAID"
    assert cuerpo["total_minor"] == 0
    assert cuerpo["paid_at"] is not None

    async with sesiones() as db:
        entradas = list(await db.scalars(select(EventTicket)))
        assert len(entradas) == 2, "una entrada por cada una comprada"
        assert {e.status for e in entradas} == {"VALID"}
        assert (await db.get(EventTicketHold, hold["id"])).status == "CONSUMED"
        orden = await db.get(EventOrder, cuerpo["id"])
        assert orden.provider == "none"
        assert orden.external_payment_id is None


@pytest.mark.asyncio
async def test_un_pedido_de_cero_repetido_no_emite_el_doble(entorno):
    http, _, sesiones = entorno
    hold = await _apartar(http, CORTESIA, 2, "h1")
    primera = await _pedir(http, hold["id"], "misma")
    segunda = await _pedir(http, hold["id"], "misma")
    assert primera.json()["id"] == segunda.json()["id"]
    async with sesiones() as db:
        assert len(list(await db.scalars(select(EventTicket)))) == 2


# --------------------------------------------------------------------------- #
# El pago: qué confirma y qué no
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_aviso_que_cuadra_confirma_y_emite(entorno):
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 3, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()

    resultado = await _confirmar(sesiones, orden["id"], 3 * 4900)
    assert resultado.estrenada is True

    async with sesiones() as db:
        fila = await db.get(EventOrder, orden["id"])
        assert fila.status == "PAID"
        assert fila.paid_at is not None
        assert fila.external_payment_id
        assert (await db.get(EventTicketHold, hold["id"])).status == "CONSUMED"
        entradas = list(await db.scalars(select(EventTicket)))
        assert len(entradas) == 3
        assert {e.owner_id for e in entradas} == {ANA}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cambio, por_que",
    [
        ({"amount_minor": None}, "sin importe"),
        ({"amount_minor": 0}, "importe cero"),
        ({"amount_minor": 4900}, "pago parcial"),
        ({"amount_minor": 999999}, "importe de mas"),
        ({"currency": None}, "sin moneda"),
        ({"currency": ""}, "moneda vacia"),
        ({"currency": "USD"}, "otra moneda"),
        ({"environment": "production"}, "otro entorno"),
    ],
)
async def test_un_aviso_que_no_cuadra_no_emite_nada(entorno, cambio, por_que):
    """Cada uno de estos es una forma conocida de regalar una entrada.

    LA AUSENCIA DEL DATO NO VALE COMO COINCIDENCIA: un aviso sin importe no
    confirma nada. Sustituirlo por el valor esperado es el defecto clásico.
    """
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 2, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()

    with pytest.raises(orders.PagoNoCuadra):
        await _confirmar(sesiones, orden["id"], 2 * 4900, **cambio)

    async with sesiones() as db:
        # SIGUE ESPERANDO EL COBRO, no pagada. El cobro se abrio —eso es lo que
        # hace `_confirmar`— y el aviso que llego no vale, asi que el pedido se
        # queda donde estaba: sin entradas y con su reserva en pie.
        assert (await db.get(EventOrder, orden["id"])).status == "PAYMENT_PROCESSING"
        assert list(await db.scalars(select(EventTicket))) == [], por_que
        assert (await db.get(EventTicketHold, hold["id"])).status == "ACTIVE"


@pytest.mark.asyncio
async def test_el_mismo_aviso_dos_veces_no_emite_el_doble(entorno):
    """Las pasarelas reintentan. Diez avisos, un juego de entradas."""
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 2, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()

    primera = await _confirmar(sesiones, orden["id"], 2 * 4900)
    segunda = await _confirmar(sesiones, orden["id"], 2 * 4900)
    assert primera.estrenada is True
    assert segunda.estrenada is False

    async with sesiones() as db:
        assert len(list(await db.scalars(select(EventTicket)))) == 2


@pytest.mark.asyncio
async def test_otro_cobro_sobre_un_pedido_ya_pagado_no_pasa(entorno):
    """Dos cobros distintos por el mismo pedido es un problema de conciliación,
    no una segunda confirmación."""
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    await _confirmar(sesiones, orden["id"], 4900)

    with pytest.raises(orders.PagoNoCuadra):
        await _confirmar(
            sesiones, orden["id"], 4900, external_payment_id="pi_otro_cobro"
        )


@pytest.mark.asyncio
async def test_un_pago_tardio_no_concede_aforo(entorno):
    """La reserva venció mientras se pagaba: el aforo volvió al común.

    NO SE INVENTA CAPACIDAD. Falla en cerrado y queda conciliable a mano;
    emitir de todas formas es meter a 210 personas en una sala de 200.
    """
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 2, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    async with sesiones() as db:
        fila = await db.get(EventTicketHold, hold["id"])
        fila.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await db.commit()

    with pytest.raises(orders.PagoNoCuadra):
        await _confirmar(sesiones, orden["id"], 2 * 4900)

    async with sesiones() as db:
        assert list(await db.scalars(select(EventTicket))) == []
        assert (await db.get(EventOrder, orden["id"])).status == "PAYMENT_PROCESSING"


@pytest.mark.asyncio
async def test_un_pedido_ya_cancelado_no_se_paga(entorno):
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    cancelada = await http.post(f"{EVENTOS}/orders/{orden['id']}/cancel")
    assert cancelada.status_code == 200
    assert cancelada.json()["status"] == "CANCELLED"

    with pytest.raises(orders.PagoNoCuadra):
        await _confirmar(sesiones, orden["id"], 4900)
    async with sesiones() as db:
        assert list(await db.scalars(select(EventTicket))) == []


@pytest.mark.asyncio
async def test_los_pedidos_cuya_reserva_murio_se_cierran(entorno):
    http, identidad, sesiones = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    async with sesiones() as db:
        fila = await db.get(EventTicketHold, hold["id"])
        fila.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await db.commit()

    identidad["uid"] = ADMINISTRA
    respuesta = await http.post(f"{ADMIN}/orders/expire")
    assert respuesta.status_code == 200
    assert respuesta.json()["procesados"] == 1

    async with sesiones() as db:
        fila = await db.get(EventOrder, orden["id"])
        assert fila.status == "EXPIRED"
        assert fila.cancelled_at is not None


# --------------------------------------------------------------------------- #
# La bandera de pagos
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_bandera_de_pagos_no_se_abre_un_cobro(entorno):
    http, _, _ = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    respuesta = await http.post(f"{EVENTOS}/orders/{orden['id']}/payment")
    assert respuesta.status_code == 503
    assert respuesta.json()["error"]["code"] == "event_payments_not_available"


@pytest.mark.asyncio
async def test_con_la_bandera_encendida_pero_sin_pasarela_tampoco(entorno, monkeypatch):
    """Encender la bandera no configura una pasarela, y decirlo es más honesto
    que fallar dentro del SDK."""
    http, _, _ = entorno
    monkeypatch.setattr(get_settings(), "feature_event_payments", True, raising=False)
    monkeypatch.setattr(get_settings(), "event_payments_provider", "none", raising=False)
    hold = await _apartar(http, GENERAL, 1, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    respuesta = await http.post(f"{EVENTOS}/orders/{orden['id']}/payment")
    assert respuesta.status_code == 503


@pytest.mark.asyncio
async def test_apagar_los_pagos_no_impide_confirmar_lo_ya_iniciado(entorno, monkeypatch):
    """El interruptor detiene la VENTA. Quien ya pagó no se queda sin entrada."""
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    monkeypatch.setattr(get_settings(), "feature_event_payments", False, raising=False)

    resultado = await _confirmar(sesiones, orden["id"], 4900)
    assert resultado.estrenada is True
    async with sesiones() as db:
        assert len(list(await db.scalars(select(EventTicket)))) == 1


# --------------------------------------------------------------------------- #
# Las entradas y su credencial
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_mis_entradas_solo_lleva_las_mias(entorno):
    http, identidad, sesiones = entorno
    hold = await _apartar(http, CORTESIA, 2, "h1")
    await _pedir(http, hold["id"], "o1")

    mias = (await http.get(f"{EVENTOS}/me/tickets")).json()
    assert len(mias["items"]) == 2

    identidad["uid"] = BRUNO
    ajenas = (await http.get(f"{EVENTOS}/me/tickets")).json()
    assert ajenas["items"] == []


@pytest.mark.asyncio
async def test_la_entrada_de_otra_persona_no_existe(entorno):
    http, identidad, _ = entorno
    hold = await _apartar(http, CORTESIA, 1, "h1")
    await _pedir(http, hold["id"], "o1")
    entrada = (await http.get(f"{EVENTOS}/me/tickets")).json()["items"][0]

    identidad["uid"] = BRUNO
    respuesta = await http.get(f"{EVENTOS}/tickets/{entrada['id']}")
    assert respuesta.status_code == 404


@pytest.mark.asyncio
async def test_la_credencial_no_lleva_datos_de_nadie(entorno):
    """Un QR se fotografía y se comparte. Cuanto menos diga, menos cuenta."""
    http, _, sesiones = entorno
    hold = await _apartar(http, CORTESIA, 1, "h1")
    await _pedir(http, hold["id"], "o1")
    entrada = (await http.get(f"{EVENTOS}/me/tickets")).json()["items"][0]

    respuesta = await http.post(f"{EVENTOS}/tickets/{entrada['id']}/credential")
    assert respuesta.status_code == 200
    credencial = respuesta.json()["credential"]

    for prohibido in (ANA, entrada["id"], entrada["event_id"], "x@y.z", "Ana", "4900"):
        assert prohibido not in credencial, f"la credencial lleva {prohibido}"
    assert len(credencial) >= 32


@pytest.mark.asyncio
async def test_la_credencial_no_se_guarda_en_claro(entorno):
    http, _, sesiones = entorno
    hold = await _apartar(http, CORTESIA, 1, "h1")
    await _pedir(http, hold["id"], "o1")
    entrada = (await http.get(f"{EVENTOS}/me/tickets")).json()["items"][0]
    credencial = (
        await http.post(f"{EVENTOS}/tickets/{entrada['id']}/credential")
    ).json()["credential"]

    async with sesiones() as db:
        fila = await db.get(EventTicket, entrada["id"])
    assert credencial not in fila.credential_hash
    assert fila.credential_hash == emision.resumir(credencial)
    assert len(fila.credential_hash) == 64


@pytest.mark.asyncio
async def test_pedir_la_credencial_otra_vez_invalida_la_anterior(entorno):
    """Un QR compartido deja de valer en cuanto la persona abre su entrada."""
    http, identidad, sesiones = entorno
    hold = await _apartar(http, CORTESIA, 1, "h1")
    await _pedir(http, hold["id"], "o1")
    entrada = (await http.get(f"{EVENTOS}/me/tickets")).json()["items"][0]

    vieja = (await http.post(f"{EVENTOS}/tickets/{entrada['id']}/credential")).json()[
        "credential"
    ]
    nueva = (await http.post(f"{EVENTOS}/tickets/{entrada['id']}/credential")).json()[
        "credential"
    ]
    assert vieja != nueva

    identidad["uid"] = ORG
    con_la_vieja = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/tickets/verify", json={"credential": vieja}
    )
    assert con_la_vieja.json()["result"] == "NOT_FOUND"
    con_la_nueva = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/tickets/verify", json={"credential": nueva}
    )
    assert con_la_nueva.json()["result"] == "OK"


# --------------------------------------------------------------------------- #
# Check-in
# --------------------------------------------------------------------------- #
async def _una_entrada(http, identidad, sesiones, quien=ANA):
    identidad["uid"] = quien
    hold = await _apartar(http, CORTESIA, 1, f"h1-{quien[-4:]}")
    await _pedir(http, hold["id"], f"o1-{quien[-4:]}")
    entrada = (await http.get(f"{EVENTOS}/me/tickets")).json()["items"][0]
    fresca = (
        await http.post(f"{EVENTOS}/tickets/{entrada['id']}/credential")
    ).json()
    # LOS DOS DE LA MISMA ROTACIÓN. Pedirlos por separado invalida el primero,
    # que es exactamente lo que la rotación promete.
    entrada["code"] = fresca["code"]
    return entrada, fresca["credential"]


@pytest.mark.asyncio
async def test_el_check_in_deja_pasar_una_vez(entorno):
    http, identidad, sesiones = entorno
    entrada, credencial = await _una_entrada(http, identidad, sesiones)

    identidad["uid"] = ORG
    primera = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": credencial}
    )
    assert primera.status_code == 200
    assert primera.json()["result"] == "OK"
    assert primera.json()["checked_in_at"] is not None

    segunda = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": credencial}
    )
    assert segunda.json()["result"] == "ALREADY_USED"
    assert segunda.json()["checked_in_at"] is not None

    async with sesiones() as db:
        fila = await db.get(EventTicket, entrada["id"])
        assert fila.status == "USED"
        assert fila.checked_in_by == ORG


@pytest.mark.asyncio
async def test_el_codigo_tecleado_tambien_vale(entorno):
    """Cuando la cámara no funciona hay que poder entrar igual.

    EL CÓDIGO ACTUAL, no el que traía la lista: rota con la credencial, y por
    eso hay que releerlo. Es justo lo que hace la pantalla de la entrada.
    """
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)
    codigo = entrada["code"]

    identidad["uid"] = ORG
    respuesta = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": codigo}
    )
    assert respuesta.json()["result"] == "OK"


@pytest.mark.asyncio
async def test_una_credencial_que_no_existe_no_dice_nada_util(entorno):
    http, identidad, _ = entorno
    identidad["uid"] = ORG
    respuesta = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": "no-existe-nada"}
    )
    assert respuesta.json()["result"] == "NOT_FOUND"
    assert respuesta.json()["ticket_id"] is None


@pytest.mark.asyncio
async def test_una_entrada_de_otro_evento_no_pasa(entorno):
    """Y no se dice de qué evento es: en la puerta de un sitio no hay por qué
    enterarse de a qué otro evento va esa persona."""
    http, identidad, sesiones = entorno
    _, credencial = await _una_entrada(http, identidad, sesiones)

    identidad["uid"] = ADMINISTRA
    respuesta = await http.post(
        f"{EVENTOS}/{AJENO}/check-ins", json={"credential": credencial}
    )
    assert respuesta.json()["result"] == "WRONG_EVENT"
    assert respuesta.json()["name"] is None


@pytest.mark.asyncio
async def test_una_entrada_revocada_no_pasa(entorno):
    http, identidad, sesiones = entorno
    entrada, credencial = await _una_entrada(http, identidad, sesiones)

    identidad["uid"] = ORG
    revocada = await http.post(
        f"{EVENTOS}/tickets/{entrada['id']}/revoke",
        json={"reason": "Compra en disputa"},
    )
    assert revocada.status_code == 200
    assert revocada.json()["status"] == "REVOKED"

    respuesta = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": credencial}
    )
    assert respuesta.json()["result"] == "REVOKED"


@pytest.mark.asyncio
async def test_una_entrada_usada_no_se_revoca(entorno):
    """La persona ya entró: reescribir el registro después lo vuelve inútil."""
    http, identidad, sesiones = entorno
    entrada, credencial = await _una_entrada(http, identidad, sesiones)
    identidad["uid"] = ORG
    await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": credencial}
    )
    respuesta = await http.post(
        f"{EVENTOS}/tickets/{entrada['id']}/revoke", json={"reason": "Ya no"}
    )
    assert respuesta.status_code == 400
    assert respuesta.json()["error"]["code"] == "event_ticket_already_used"


@pytest.mark.asyncio
async def test_verificar_no_gasta_la_entrada(entorno):
    """«¿Esto vale?» se puede preguntar mil veces; «déjala pasar», una."""
    http, identidad, sesiones = entorno
    entrada, credencial = await _una_entrada(http, identidad, sesiones)

    identidad["uid"] = ORG
    for _ in range(3):
        respuesta = await http.post(
            f"{EVENTOS}/{CON_ENTRADAS}/tickets/verify", json={"credential": credencial}
        )
        assert respuesta.json()["result"] == "OK"

    async with sesiones() as db:
        assert (await db.get(EventTicket, entrada["id"])).status == "VALID"


# --------------------------------------------------------------------------- #
# Permisos
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_quien_compra_no_hace_check_in(entorno):
    """404 Y NO 403. Un 403 le confirma a quien sondea que ese identificador es
    un evento real; para quien no puede operar su puerta, no existe."""
    http, identidad, sesiones = entorno
    _, credencial = await _una_entrada(http, identidad, sesiones)
    identidad["uid"] = ANA
    respuesta = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": credencial}
    )
    assert respuesta.status_code == 404


@pytest.mark.asyncio
async def test_quien_solo_modera_contenido_no_hace_check_in(entorno):
    """`moderator` existe para revisar contenido, no para abrir una puerta."""
    http, identidad, sesiones = entorno
    _, credencial = await _una_entrada(http, identidad, sesiones)
    identidad["uid"] = MODERA
    respuesta = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": credencial}
    )
    assert respuesta.status_code == 404


@pytest.mark.asyncio
async def test_admision_si_hace_check_in(entorno):
    http, identidad, sesiones = entorno
    _, credencial = await _una_entrada(http, identidad, sesiones)
    identidad["uid"] = ADMINISTRA
    respuesta = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": credencial}
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["result"] == "OK"


@pytest.mark.asyncio
async def test_la_lista_de_asistentes_no_lleva_al_comprador(entorno):
    """La puerta necesita saber si pasa, no quién es."""
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)

    identidad["uid"] = ORG
    respuesta = await http.get(f"{EVENTOS}/{CON_ENTRADAS}/attendees")
    assert respuesta.status_code == 200
    crudo = respuesta.text
    for prohibido in (ANA, "x@y.z", "Ana"):
        assert prohibido not in crudo, f"la lista lleva {prohibido}"
    fila = respuesta.json()["items"][0]
    assert fila["ticket_id"] == entrada["id"]
    assert fila["name"] == "Cortesía"


@pytest.mark.asyncio
async def test_los_asistentes_de_otro_evento_no_se_ven(entorno):
    http, identidad, sesiones = entorno
    await _una_entrada(http, identidad, sesiones)
    identidad["uid"] = ORG
    respuesta = await http.get(f"{EVENTOS}/{AJENO}/attendees")
    assert respuesta.status_code == 404


@pytest.mark.asyncio
async def test_el_pedido_de_otra_persona_no_existe(entorno):
    http, identidad, _ = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    identidad["uid"] = BRUNO
    respuesta = await http.get(f"{EVENTOS}/orders/{orden['id']}")
    assert respuesta.status_code == 404
    assert respuesta.json()["error"]["code"] == "event_order_not_found"


@pytest.mark.asyncio
async def test_el_pedido_no_expone_la_referencia_del_proveedor(entorno):
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    await _confirmar(sesiones, orden["id"], 4900)

    crudo = (await http.get(f"{EVENTOS}/orders/{orden['id']}")).text
    assert "pi_" not in crudo, "la referencia del cobro no es del comprador"
    assert "external_payment_id" not in crudo
    assert "operation_ref" not in crudo


# --------------------------------------------------------------------------- #
# Ventas
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_resumen_de_ventas_cuenta_lo_que_hay(entorno):
    http, identidad, sesiones = entorno
    hold = await _apartar(http, GENERAL, 2, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    await _confirmar(sesiones, orden["id"], 2 * 4900)

    identidad["uid"] = BRUNO
    otro = await _apartar(http, VIP, 1, "h2")
    await _pedir(http, otro["id"], "o2")  # pendiente, sin pagar

    identidad["uid"] = ORG
    resumen = (await http.get(f"{EVENTOS}/{CON_ENTRADAS}/sales")).json()
    assert resumen["entradas_emitidas"] == 2
    assert resumen["ordenes_pagadas"] == 1
    assert resumen["ordenes_pendientes"] == 1
    assert resumen["ingresos_brutos_minor"] == 9800, "solo lo pagado"
    assert resumen["currency"] == "PEN"
    assert resumen["checkins"] == 0


@pytest.mark.asyncio
async def test_las_ventas_de_un_evento_ajeno_no_se_ven(entorno):
    http, identidad, _ = entorno
    identidad["uid"] = ORG
    respuesta = await http.get(f"{EVENTOS}/{AJENO}/sales")
    assert respuesta.status_code == 404


# --------------------------------------------------------------------------- #
# Paginación
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_mis_pedidos_paginan_con_orden_estable(entorno):
    http, _, sesiones = entorno
    for i in range(3):
        hold = await _apartar(http, CORTESIA, 1, f"h{i}")
        assert (await _pedir(http, hold["id"], f"o{i}")).status_code == 201
        async with sesiones() as db:
            fila = await db.get(EventTicketHold, hold["id"])
            fila.status = "RELEASED"
            await db.commit()

    primera = (await http.get(f"{EVENTOS}/me/orders?limit=2")).json()
    assert len(primera["items"]) == 2
    assert primera["next_cursor"] is not None

    segunda = (
        await http.get(f"{EVENTOS}/me/orders?limit=2&cursor={primera['next_cursor']}")
    ).json()
    ids = {o["id"] for o in primera["items"]} | {o["id"] for o in segunda["items"]}
    assert len(ids) == 3, "ninguno se repite ni se pierde entre páginas"


# --------------------------------------------------------------------------- #
# Sin bandera y sin migración
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_la_bandera_todo_responde_503(entorno, monkeypatch):
    http, _, _ = entorno
    monkeypatch.setattr(get_settings(), "feature_event_ticketing", False, raising=False)
    for ruta in (f"{EVENTOS}/me/orders", f"{EVENTOS}/me/tickets"):
        respuesta = await http.get(ruta)
        assert respuesta.status_code == 503
        assert respuesta.json()["error"]["code"] in (
            "event_orders_not_available",
            "event_ticketing_not_available",
        )


@pytest.mark.asyncio
async def test_sin_la_migracion_0062_responde_503_y_lo_anterior_sigue(entorno):
    http, _, sesiones = entorno
    async with sesiones() as db:
        conexion = await db.connection()
        for tabla in (
            "event_checkins",
            "event_tickets",
            "event_order_items",
            "event_orders",
        ):
            await conexion.exec_driver_sql(f"drop table if exists {tabla}")
        await db.commit()
    esquema.olvidar()

    respuesta = await http.get(f"{EVENTOS}/me/orders")
    assert respuesta.status_code == 503
    assert respuesta.json()["error"]["code"] == "event_orders_not_available"

    # Y LO DE ANTES SIGUE FUNCIONANDO: apartar entradas no necesita la 0062.
    apartada = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/ticket-holds",
        json={"items": [{"ticket_type_id": GENERAL, "quantity": 1}]},
        headers={"Idempotency-Key": "sin-0062"},
    )
    assert apartada.status_code == 201


# --------------------------------------------------------------------------- #
# La puerta de un evento no es de cualquiera
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_borrador_propio_no_es_una_puerta(entorno):
    """Crear un evento es libre; ser la puerta de uno, no.

    Sin esto, cualquiera con una cuenta crea un borrador —que no ve nadie— y
    con su identificador puede preguntar por cualquier credencial de la
    plataforma: la respuesta distingue «no existe» de «es de otro evento», que
    es un oráculo de validez de entradas ajenas.
    """
    http, identidad, sesiones = entorno
    _, credencial = await _una_entrada(http, identidad, sesiones)

    borrador = "eeeeeeee-3333-0000-0000-0000000000b1"
    identidad["uid"] = BRUNO
    async with sesiones() as db:
        db.add(
            Event(
                id=borrador,
                organizer_id=BRUNO,
                title="Mi borrador",
                description="Una descripción suficientemente larga para revisarla.",
                starts_at=datetime.now(timezone.utc) + timedelta(days=10),
                event_type="presential",
                location="Casa",
                status="draft",
                capacity=10,
            )
        )
        db.add(
            EventOperations(
                event_id=borrador,
                workflow_status="DRAFT",
                selection_status="none",
                origin="events_v2",
            )
        )
        # CONFIGURADO PARA VENDER, a propósito. Sin esto el borrador se
        # rechazaría por no vender entradas y la prueba saldría verde aunque la
        # comprobación de que esté PUBLICADO no existiera: diría estar probando
        # una cosa y estaría probando otra.
        db.add(
            EventTicketingSettings(
                event_id=borrador, access_mode="TICKETED", currency="PEN"
            )
        )
        await db.commit()

    respuesta = await http.post(
        f"{EVENTOS}/{borrador}/tickets/verify", json={"credential": credencial}
    )
    assert respuesta.status_code == 404, respuesta.text


@pytest.mark.asyncio
async def test_un_evento_ajeno_no_existe_para_la_puerta(entorno):
    """404 y no 403: un 403 confirma que ese identificador es un evento real."""
    http, identidad, _ = entorno
    identidad["uid"] = ORG
    for ruta in (
        f"{EVENTOS}/{AJENO}/attendees",
        f"{EVENTOS}/{AJENO}/sales",
    ):
        respuesta = await http.get(ruta)
        assert respuesta.status_code == 404, ruta


@pytest.mark.asyncio
async def test_un_evento_sin_venta_no_tiene_puerta(entorno):
    """Un evento de reserva gratuita no emite entradas: no hay nada que admitir."""
    http, identidad, _ = entorno
    identidad["uid"] = ORG
    respuesta = await http.post(
        f"{EVENTOS}/{GRATIS}/tickets/verify", json={"credential": "lo-que-sea"}
    )
    assert respuesta.status_code == 404


# --------------------------------------------------------------------------- #
# El código tecleado no sobrevive a la rotación
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_codigo_tambien_deja_de_valer_al_rotar(entorno):
    """La rotación no sirve de nada si el otro camino de entrada no rota.

    Escenario: alguien fotografía la pantalla de la entrada —el QR Y el código
    escrito debajo—, la persona vuelve a abrir su entrada creyendo que eso
    invalida lo fotografiado, y quien tiene la foto entra tecleando el código.
    """
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)
    codigo_viejo = entrada["code"]

    identidad["uid"] = ANA
    await http.post(f"{EVENTOS}/tickets/{entrada['id']}/credential")

    identidad["uid"] = ORG
    con_el_viejo = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/tickets/verify", json={"credential": codigo_viejo}
    )
    assert con_el_viejo.json()["result"] == "NOT_FOUND"


@pytest.mark.asyncio
async def test_la_lista_de_asistentes_no_reparte_codigos(entorno):
    """Un código admite. Volcarlos todos en una lista es repartir entradas."""
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)
    identidad["uid"] = ORG
    crudo = (await http.get(f"{EVENTOS}/{CON_ENTRADAS}/attendees")).text
    assert entrada["code"] not in crudo


@pytest.mark.asyncio
async def test_se_puede_buscar_por_codigo_aunque_no_se_devuelva(entorno):
    """La pantalla de respaldo sigue funcionando: se busca, no se reparte."""
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)
    codigo = entrada["code"]

    identidad["uid"] = ORG
    encontrados = (
        await http.get(f"{EVENTOS}/{CON_ENTRADAS}/attendees?q={codigo}")
    ).json()
    assert [f["ticket_id"] for f in encontrados["items"]] == [entrada["id"]]


# --------------------------------------------------------------------------- #
# Revocar: primero quién eres, después qué existe
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_revocar_una_entrada_ajena_no_dice_si_existe(entorno):
    """404 tanto si existe como si no: cargar y luego comprobar el rol
    convierte la respuesta en un oráculo de identificadores."""
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)

    identidad["uid"] = BRUNO
    existe = await http.post(
        f"{EVENTOS}/tickets/{entrada['id']}/revoke", json={"reason": "porque si"}
    )
    inventada = await http.post(
        f"{EVENTOS}/tickets/ffffffff-3333-0000-0000-0000000000ff/revoke",
        json={"reason": "porque si"},
    )
    assert existe.status_code == 404, existe.text
    assert existe.status_code == inventada.status_code
    assert existe.json()["error"]["code"] == inventada.json()["error"]["code"]


@pytest.mark.asyncio
async def test_quien_solo_modera_no_revoca(entorno):
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)
    identidad["uid"] = MODERA
    respuesta = await http.post(
        f"{EVENTOS}/tickets/{entrada['id']}/revoke", json={"reason": "porque si"}
    )
    assert respuesta.status_code == 404


# --------------------------------------------------------------------------- #
# El registro de un evento no se llena con entradas de otro
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_una_entrada_de_otro_evento_no_ensucia_el_registro(entorno):
    """`WRONG_EVENT` deja constancia del INTENTO, no del identificador ajeno."""
    http, identidad, sesiones = entorno
    entrada, credencial = await _una_entrada(http, identidad, sesiones)

    identidad["uid"] = ADMINISTRA
    respuesta = await http.post(
        f"{EVENTOS}/{AJENO}/check-ins", json={"credential": credencial}
    )
    assert respuesta.json()["result"] == "WRONG_EVENT"

    async with sesiones() as db:
        filas = list(
            await db.scalars(
                select(EventCheckin).where(EventCheckin.event_id == AJENO)
            )
        )
    assert len(filas) == 1
    assert filas[0].ticket_id is None, "la entrada es de otro evento: no se apunta"


# --------------------------------------------------------------------------- #
# Permisos que faltaban por probar
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_nadie_pide_la_credencial_de_una_entrada_ajena(entorno):
    """Es el camino peligroso: devolvería un QR que funciona."""
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)
    identidad["uid"] = BRUNO
    respuesta = await http.post(f"{EVENTOS}/tickets/{entrada['id']}/credential")
    assert respuesta.status_code == 404


@pytest.mark.asyncio
async def test_nadie_cancela_ni_paga_el_pedido_de_otro(entorno):
    http, identidad, _ = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    identidad["uid"] = BRUNO
    assert (
        await http.post(f"{EVENTOS}/orders/{orden['id']}/cancel")
    ).status_code == 404
    assert (
        await http.post(f"{EVENTOS}/orders/{orden['id']}/payment")
    ).status_code in (404, 503)


@pytest.mark.asyncio
@pytest.mark.parametrize("quien", [MODERA, ANA])
async def test_la_limpieza_masiva_de_pedidos_exige_admision(entorno, quien):
    http, identidad, _ = entorno
    identidad["uid"] = quien
    respuesta = await http.post(f"{ADMIN}/orders/expire")
    assert respuesta.status_code == 403


# --------------------------------------------------------------------------- #
# Lo emitido SIGUE OCUPANDO SITIO
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_lo_ya_vendido_no_devuelve_el_aforo_al_comun(entorno):
    """La segunda oleada, que es donde estaba el agujero.

    Al pagar, la reserva pasa a `CONSUMED` y deja de contar como apartada. Si
    las entradas emitidas tampoco cuentan, el aforo vuelve entero al común y el
    siguiente comprador ve la sala vacía: seis entradas para tres asientos, y
    otras seis en la ronda siguiente.

    No hace falta concurrencia. Es secuencial y determinista.
    """
    http, identidad, sesiones = entorno
    async with sesiones() as db:
        evento = await db.get(Event, CON_ENTRADAS)
        evento.capacity = 3
        await db.commit()

    identidad["uid"] = ANA
    hold = await _apartar(http, CORTESIA, 2, "primera")
    primera = await _pedir(http, hold["id"], "o1")
    assert primera.status_code == 201
    assert primera.json()["status"] == "PAID"

    # AHORA QUEDA UNO. Con el aforo bien contado, pedir dos no cabe.
    identidad["uid"] = BRUNO
    libre = (await http.get(f"{EVENTOS}/{CON_ENTRADAS}/availability")).json()
    assert libre["general"] == 1, f"quedan tres menos dos: {libre}"

    respuesta = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/ticket-holds",
        json={"items": [{"ticket_type_id": CORTESIA, "quantity": 2}]},
        headers={"Idempotency-Key": "segunda"},
    )
    assert respuesta.status_code == 409, respuesta.text
    assert respuesta.json()["error"]["code"] == "event_capacity_exceeded"


@pytest.mark.asyncio
async def test_lo_ya_vendido_tampoco_devuelve_el_cupo_del_tipo(entorno):
    """Y lo mismo con el cupo de cada tipo, que tampoco se decrementa solo."""
    http, identidad, sesiones = entorno
    async with sesiones() as db:
        tipo = await db.get(EventTicketType, CORTESIA)
        tipo.quota = 3
        await db.commit()

    identidad["uid"] = ANA
    hold = await _apartar(http, CORTESIA, 2, "primera")
    assert (await _pedir(http, hold["id"], "o1")).json()["status"] == "PAID"

    identidad["uid"] = BRUNO
    libre = (await http.get(f"{EVENTOS}/{CON_ENTRADAS}/availability")).json()
    assert libre["por_tipo"][CORTESIA] == 1, f"cupo tres menos dos: {libre}"


@pytest.mark.asyncio
async def test_una_entrada_revocada_libera_su_sitio(entorno):
    """Revocar retira la entrada, y con ella lo que ocupaba.

    Es la otra mitad: si lo emitido cuenta, lo revocado tiene que dejar de
    contar, o el aforo se va agotando con entradas que ya no existen.
    """
    http, identidad, sesiones = entorno
    async with sesiones() as db:
        evento = await db.get(Event, CON_ENTRADAS)
        evento.capacity = 2
        await db.commit()

    identidad["uid"] = ANA
    hold = await _apartar(http, CORTESIA, 2, "primera")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    entradas = (await http.get(f"{EVENTOS}/me/tickets")).json()["items"]
    assert len(entradas) == 2

    identidad["uid"] = ORG
    libre = (await http.get(f"{EVENTOS}/{CON_ENTRADAS}/availability")).json()
    assert libre["general"] == 0

    await http.post(
        f"{EVENTOS}/tickets/{entradas[0]['id']}/revoke",
        json={"reason": "Compra en disputa"},
    )
    libre = (await http.get(f"{EVENTOS}/{CON_ENTRADAS}/availability")).json()
    assert libre["general"] == 1, "lo revocado deja de ocupar"


@pytest.mark.asyncio
async def test_una_entrada_usada_sigue_ocupando(entorno):
    """Quien ya entró ocupa el sitio más que nadie."""
    http, identidad, sesiones = entorno
    async with sesiones() as db:
        evento = await db.get(Event, CON_ENTRADAS)
        evento.capacity = 2
        await db.commit()

    entrada, credencial = await _una_entrada(http, identidad, sesiones)
    identidad["uid"] = ORG
    await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": credencial}
    )
    libre = (await http.get(f"{EVENTOS}/{CON_ENTRADAS}/availability")).json()
    assert libre["general"] == 1, "usada sigue contando"


# --------------------------------------------------------------------------- #
# El webhook, por HTTP y de punta a punta
# --------------------------------------------------------------------------- #
WEBHOOK = "/api/v1/payments/webhook/stripe"


class _PasarelaDePrueba:
    """Un proveedor que devuelve el aviso que la prueba quiera.

    NO SIMULA UN COBRO. Simula lo único que el servidor puede comprobar: qué
    llega YA VERIFICADO desde la pasarela. La firma se comprueba antes, en el
    proveedor de verdad, y aquí se ejercita levantando la misma excepción.
    """

    name = "stripe"
    dominio = "comercio"

    def __init__(self):
        self.aviso = None
        self.firma_valida = True

    async def create_checkout(self, request):  # pragma: no cover - no se usa
        raise NotImplementedError

    def verify_and_parse(self, *, body, headers):
        from app.modules.payments.stripe_provider import StripeSignatureError

        if not self.firma_valida:
            raise StripeSignatureError("firma no valida")
        return self.aviso


@pytest_asyncio.fixture
async def pasarela(monkeypatch):
    from app.modules.payments import providers

    falsa = _PasarelaDePrueba()
    monkeypatch.setitem(providers.PROVIDERS, "stripe", falsa)
    return falsa


def _aviso(orden_id, *, importe, dominio="evento", evento_id="ev-1", **cambios):
    from app.modules.payments.providers import PaymentEvent

    datos = {
        "purchase_id": orden_id,
        "provider_transaction_id": f"pi_{orden_id[:8]}",
        "status": "paid",
        "amount_minor": importe,
        "currency": "PEN",
        "event_id": evento_id,
        "event_type": "checkout.session.completed",
        "environment": "sandbox",
        "dominio": dominio,
        "payload": {"id": evento_id},
    }
    datos.update(cambios)
    return PaymentEvent(**datos)


@pytest.mark.asyncio
async def test_el_webhook_confirma_y_emite(entorno, pasarela):
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 2, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    await _abrir_cobro(sesiones, orden["id"])

    pasarela.aviso = _aviso(orden["id"], importe=2 * 4900)
    respuesta = await http.post(WEBHOOK, content=b"{}")
    assert respuesta.status_code == 204, respuesta.text

    async with sesiones() as db:
        assert (await db.get(EventOrder, orden["id"])).status == "PAID"
        assert len(list(await db.scalars(select(EventTicket)))) == 2


@pytest.mark.asyncio
async def test_un_aviso_sin_firma_no_tiene_efecto(entorno, pasarela):
    """Sin verificar la firma, quien descubra la URL se regala entradas."""
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    await _abrir_cobro(sesiones, orden["id"])

    pasarela.firma_valida = False
    pasarela.aviso = _aviso(orden["id"], importe=4900)
    respuesta = await http.post(WEBHOOK, content=b"{}")
    assert respuesta.status_code == 422

    async with sesiones() as db:
        assert (await db.get(EventOrder, orden["id"])).status == "PAYMENT_PROCESSING"
        assert list(await db.scalars(select(EventTicket))) == []


@pytest.mark.asyncio
async def test_el_mismo_aviso_repetido_no_emite_el_doble(entorno, pasarela):
    """LA BARRERA DE VERDAD, que es el índice único de `payment_events`.

    La prueba del servicio ejercita el atajo «ya está pagada»; esta ejercita lo
    que pasa antes: el mismo identificador de aviso no se procesa dos veces.
    """
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 2, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    await _abrir_cobro(sesiones, orden["id"])

    pasarela.aviso = _aviso(orden["id"], importe=2 * 4900, evento_id="evt_repetido")
    for _ in range(3):
        assert (await http.post(WEBHOOK, content=b"{}")).status_code == 204

    async with sesiones() as db:
        assert len(list(await db.scalars(select(EventTicket)))) == 2
        avisos = list(
            await db.scalars(
                select(ComercioPaymentEvent).where(
                    ComercioPaymentEvent.external_event_id == "evt_repetido"
                )
            )
        )
    assert len(avisos) == 1, "tres avisos iguales, una fila"


@pytest.mark.asyncio
async def test_un_aviso_de_otro_entorno_no_emite_nada(entorno, pasarela):
    """Un cobro de pruebas no concede una entrada en producción, ni al revés."""
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    await _abrir_cobro(sesiones, orden["id"])

    pasarela.aviso = _aviso(
        orden["id"], importe=4900, environment="production", evento_id="evt_de_otro"
    )
    assert (await http.post(WEBHOOK, content=b"{}")).status_code == 204

    async with sesiones() as db:
        assert (await db.get(EventOrder, orden["id"])).status == "PAYMENT_PROCESSING"
        assert list(await db.scalars(select(EventTicket))) == []
        # SE CORTA ANTES DE REGISTRARLO, y eso es lo que distingue este corte de
        # los de más abajo: un aviso de otro entorno no es nuestro, así que no
        # ocupa sitio en la tabla anti-repetición. Sin esta comprobación, la
        # prueba saldría verde solo porque el servicio también lo rechaza.
        assert (
            await db.scalar(
                select(ComercioPaymentEvent).where(
                    ComercioPaymentEvent.external_event_id == "evt_de_otro"
                )
            )
        ) is None


@pytest.mark.asyncio
async def test_un_aviso_no_confirma_un_pedido_que_nunca_abrio_un_cobro(
    entorno, pasarela
):
    """Un pedido con `provider = 'none'` no tiene ningún cobro a su nombre.

    Sin esto, el aviso de un cobro cualquiera podía confirmar un pedido que
    nadie llegó a pagar: bastaba con que el importe y la moneda coincidieran.
    """
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    # NO se llama a `_abrir_cobro`: el pedido nunca pasó por la pasarela.

    pasarela.aviso = _aviso(orden["id"], importe=4900, evento_id="evt_sin_cobro")
    assert (await http.post(WEBHOOK, content=b"{}")).status_code == 204

    async with sesiones() as db:
        assert (await db.get(EventOrder, orden["id"])).status == "PENDING_PAYMENT"
        assert list(await db.scalars(select(EventTicket))) == []


@pytest.mark.asyncio
async def test_un_aviso_de_cursos_no_toca_un_pedido_de_entradas(entorno, pasarela):
    """El reparto por dominio: sin él, un aviso legítimo de un dominio quedaría
    registrado como «pedido inexistente» del otro."""
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    await _abrir_cobro(sesiones, orden["id"])

    # Mismo identificador de pedido, pero SIN el dominio de eventos.
    pasarela.aviso = _aviso(orden["id"], importe=4900, dominio="")
    await http.post(WEBHOOK, content=b"{}")

    async with sesiones() as db:
        assert (await db.get(EventOrder, orden["id"])).status == "PAYMENT_PROCESSING"
        assert list(await db.scalars(select(EventTicket))) == []


@pytest.mark.asyncio
async def test_un_aviso_que_no_cuadra_queda_anotado_y_no_reintenta(entorno, pasarela):
    """204 Y CON RASTRO. Reintentar un aviso que no cuadra no lo arregla, y
    devolver un error pone a la pasarela a repetirlo durante días."""
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 2, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    await _abrir_cobro(sesiones, orden["id"])

    pasarela.aviso = _aviso(orden["id"], importe=1, evento_id="evt_descuadrado")
    assert (await http.post(WEBHOOK, content=b"{}")).status_code == 204

    async with sesiones() as db:
        assert list(await db.scalars(select(EventTicket))) == []
        aviso = await db.scalar(
            select(ComercioPaymentEvent).where(
                ComercioPaymentEvent.external_event_id == "evt_descuadrado"
            )
        )
    assert aviso is not None, "el aviso queda para conciliar"
    assert aviso.error


@pytest.mark.asyncio
async def test_la_bandera_de_cursos_no_bloquea_una_entrada(entorno, pasarela, monkeypatch):
    """`STRIPE_PAYMENTS_ENABLED` gobierna la compra de un CURSO."""
    http, _, sesiones = entorno
    monkeypatch.setattr(get_settings(), "stripe_payments_enabled", False, raising=False)
    hold = await _apartar(http, GENERAL, 1, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    await _abrir_cobro(sesiones, orden["id"])

    pasarela.aviso = _aviso(orden["id"], importe=4900)
    assert (await http.post(WEBHOOK, content=b"{}")).status_code == 204
    async with sesiones() as db:
        assert (await db.get(EventOrder, orden["id"])).status == "PAID"


# --------------------------------------------------------------------------- #
# Aislamiento entre dominios cuando llega una DEVOLUCION
# --------------------------------------------------------------------------- #
async def _pagada(http, sesiones, pasarela, *, cantidad=1, evento_id="ev-pago"):
    """Un pedido de entradas PAGADO de verdad, con su referencia de cobro."""
    hold = await _apartar(http, GENERAL, cantidad, "hd")
    orden = (await _pedir(http, hold["id"], "od")).json()
    await _abrir_cobro(sesiones, orden["id"])
    pasarela.aviso = _aviso(orden["id"], importe=cantidad * 4900, evento_id=evento_id)
    assert (await http.post(WEBHOOK, content=b"{}")).status_code == 204
    async with sesiones() as db:
        fresca = await db.get(EventOrder, orden["id"])
        assert fresca.status == "PAID"
        referencia = fresca.external_payment_id
    assert referencia, "el pedido pagado tiene que llevar su referencia de cobro"
    return orden, referencia


@pytest.mark.asyncio
async def test_una_devolucion_de_entradas_no_cae_en_la_rama_de_cursos(
    entorno, pasarela
):
    """El objeto `refund` NO hereda la metadata del cobro: llega sin dominio.

    Si el reparto se hace solo por `metadata.dominio`, este aviso se entrega a
    Cursos, que no encuentra ningun pedido suyo, lo anota como «devolucion sin
    compra apuntada» y lo marca procesado SIN error. Resultado: hay dinero
    devuelto de un evento y ni un solo rastro de que haya que conciliarlo.
    """
    http, _, sesiones = entorno
    orden, referencia = await _pagada(http, sesiones, pasarela)

    pasarela.aviso = _aviso(
        orden["id"],
        importe=4900,
        dominio="",                      # como llega de verdad un `refund.*`
        evento_id="evt_devolucion",
        status="refunded",
        event_type="refund.created",
        provider_transaction_id=referencia,
    )
    assert (await http.post(WEBHOOK, content=b"{}")).status_code == 204

    async with sesiones() as db:
        aviso = await db.scalar(
            select(ComercioPaymentEvent).where(
                ComercioPaymentEvent.external_event_id == "evt_devolucion"
            )
        )
    assert aviso is not None, "el aviso se guarda siempre"
    assert aviso.error, (
        "una devolucion de entradas tiene que quedar PENDIENTE DE CONCILIACION, "
        "no marcada como atendida"
    )


@pytest.mark.asyncio
async def test_una_devolucion_de_entradas_no_revoca_ni_desapaga_nada(
    entorno, pasarela
):
    """Sin politica de cancelacion aprobada, no se revoca por decision propia.

    Devolver el dinero y retirar la entrada son dos decisiones distintas, y la
    segunda es del Incremento 5. Automatizarla aqui seria inventarse una
    politica comercial que nadie ha aprobado.
    """
    http, _, sesiones = entorno
    orden, referencia = await _pagada(http, sesiones, pasarela, cantidad=2)

    pasarela.aviso = _aviso(
        orden["id"],
        importe=2 * 4900,
        dominio="",
        evento_id="evt_devolucion_2",
        status="refunded",
        event_type="charge.refunded",
        provider_transaction_id=referencia,
    )
    assert (await http.post(WEBHOOK, content=b"{}")).status_code == 204

    async with sesiones() as db:
        assert (await db.get(EventOrder, orden["id"])).status == "PAID"
        entradas = list(await db.scalars(select(EventTicket)))
        assert len(entradas) == 2
        assert {e.status for e in entradas} == {"VALID"}


@pytest.mark.asyncio
async def test_una_disputa_de_entradas_tampoco_toca_cursos(entorno, pasarela):
    """El objeto `dispute` tampoco hereda la metadata del cobro."""
    http, _, sesiones = entorno
    orden, referencia = await _pagada(http, sesiones, pasarela)

    pasarela.aviso = _aviso(
        orden["id"],
        importe=4900,
        dominio="",
        evento_id="evt_disputa",
        status="disputa_abierta",
        event_type="charge.dispute.created",
        provider_transaction_id=referencia,
    )
    assert (await http.post(WEBHOOK, content=b"{}")).status_code == 204

    async with sesiones() as db:
        assert (await db.get(EventOrder, orden["id"])).status == "PAID"
        aviso = await db.scalar(
            select(ComercioPaymentEvent).where(
                ComercioPaymentEvent.external_event_id == "evt_disputa"
            )
        )
    assert aviso is not None and aviso.error, "queda para que una persona lo mire"


@pytest.mark.asyncio
async def test_una_devolucion_ajena_sigue_yendo_a_cursos(entorno, pasarela):
    """EL AISLAMIENTO VA EN LOS DOS SENTIDOS.

    Sin esta prueba, «mandarlo todo a Eventos» pasaria la de arriba y romperia
    las devoluciones de Cursos sin que nada se pusiera en rojo.
    """
    http, _, sesiones = entorno
    await _pagada(http, sesiones, pasarela)

    pasarela.aviso = _aviso(
        "00000000-0000-0000-0000-000000000000",
        importe=19900,
        dominio="",
        evento_id="evt_de_cursos",
        status="refunded",
        event_type="refund.created",
        provider_transaction_id="pi_de_un_curso",
    )
    assert (await http.post(WEBHOOK, content=b"{}")).status_code == 204

    async with sesiones() as db:
        aviso = await db.scalar(
            select(ComercioPaymentEvent).where(
                ComercioPaymentEvent.external_event_id == "evt_de_cursos"
            )
        )
    assert aviso is not None
    assert not aviso.error, (
        "una devolucion que no es de ninguna entrada la sigue atendiendo Cursos "
        "como siempre"
    )


# --------------------------------------------------------------------------- #
# La busqueda de la puerta no puede ser un extractor de codigos
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_los_comodines_no_extraen_codigos_posicion_a_posicion(
    entorno,
):
    """`q = "___A%"` preguntaba «que entradas llevan una A en la cuarta letra».

    Con 32 caracteres y 14 posiciones son 448 peticiones para reconstruir el
    codigo COMPLETO de todas las entradas del evento a la vez. Y un codigo
    admite por si solo: `_buscar` lo acepta como credencial. Es decir, quien
    tiene la lista puede marcar como usadas las entradas de todo el mundo sin
    que su dueno haya llegado a la puerta.
    """
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)
    codigo = entrada["code"]

    identidad["uid"] = ORG
    # El mismo ataque, tal cual: subrayados hasta la posicion y el caracter.
    # Se sonda la posicion 7 para que la cadena pase del largo minimo y lo que
    # se pruebe sea el ESCAPADO, no la longitud.
    posicion = 7
    sonda = "_" * posicion + codigo[posicion] + "%"
    encontrados = (
        await http.get(f"{EVENTOS}/{CON_ENTRADAS}/attendees", params={"q": sonda})
    ).json()
    assert encontrados.get("items") == [], (
        "el comodin `_` se esta interpretando: la lista dice que caracter hay "
        "en cada posicion del codigo"
    )


@pytest.mark.asyncio
async def test_el_porcentaje_tampoco_busca_por_dentro(entorno):
    """`q = "%XY%"` era una busqueda por subcadena en cualquier posicion."""
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)
    codigo = entrada["code"]

    identidad["uid"] = ORG
    # EL `%` SE MANDA COMO PARAMETRO, no dentro de la URL: `%AB` en una cadena
    # de consulta es un escape de porcentaje y lo decodifica el servidor antes
    # de que la prueba pruebe nada.
    sonda = "%" + codigo[6:10] + "%"
    encontrados = (
        await http.get(f"{EVENTOS}/{CON_ENTRADAS}/attendees", params={"q": sonda})
    ).json()
    assert encontrados.get("items") == []


@pytest.mark.asyncio
async def test_un_prefijo_corto_no_se_admite(entorno):
    """Sin longitud minima, el prefijo se recorre letra a letra.

    Con seis caracteres hacen falta 32^6 sondas para encontrar uno que exista,
    que es exactamente lo que hace inutil el recorrido.
    """
    http, identidad, sesiones = entorno
    await _una_entrada(http, identidad, sesiones)
    identidad["uid"] = ORG
    respuesta = await http.get(f"{EVENTOS}/{CON_ENTRADAS}/attendees?q=A")
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_la_busqueda_por_codigo_entero_sigue_funcionando(entorno):
    """LA PANTALLA DE RESPALDO NO SE ROMPE. Quien dicta su codigo se encuentra."""
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)
    codigo = entrada["code"]

    identidad["uid"] = ORG
    encontrados = (
        await http.get(f"{EVENTOS}/{CON_ENTRADAS}/attendees?q={codigo}")
    ).json()
    assert [f["ticket_id"] for f in encontrados["items"]] == [entrada["id"]]


# --------------------------------------------------------------------------- #
# La puerta de un evento sin ciclo operativo
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_evento_sin_ciclo_operativo_no_se_da_por_publicado(entorno):
    """Sin fila en `event_operations` la puerta asumia PUBLISHED.

    Falla en ABIERTO: un borrador sin ciclo operativo abria la puerta, y la
    puerta es el oraculo de credenciales que `_evento_de_la_puerta` documenta
    haber cerrado. El propio proyecto resuelve esto al reves en
    `states.se_puede_saber_que_existe`: sin ciclo, manda el `status` del evento.
    """
    http, identidad, sesiones = entorno
    borrador = "eeeeeeee-4444-0000-0000-0000000000c1"
    identidad["uid"] = BRUNO
    async with sesiones() as db:
        db.add(
            Event(
                id=borrador,
                organizer_id=BRUNO,
                title="Sin ciclo operativo",
                description="Una descripción suficientemente larga para revisarla.",
                starts_at=datetime.now(timezone.utc) + timedelta(days=10),
                event_type="presential",
                location="Casa",
                status="draft",
                capacity=10,
            )
        )
        # A PROPOSITO SIN `EventOperations`: es el estado que se da por bueno.
        db.add(
            EventTicketingSettings(
                event_id=borrador, access_mode="TICKETED", currency="PEN"
            )
        )
        await db.commit()

    respuesta = await http.post(
        f"{EVENTOS}/{borrador}/tickets/verify", json={"credential": "loquesea"}
    )
    assert respuesta.status_code == 404, (
        "un borrador sin ciclo operativo esta abriendo la puerta"
    )


@pytest.mark.asyncio
async def test_un_evento_publicado_sin_ciclo_operativo_si_tiene_puerta(entorno):
    """EL ARREGLO NO PUEDE CERRAR LA PUERTA A QUIEN SI LA TIENE.

    Sin esta prueba, «devolver siempre 404 cuando falta la fila» pasaria la de
    arriba y dejaria fuera a cualquier evento anterior a la 0060.
    """
    http, identidad, sesiones = entorno
    publicado = "eeeeeeee-4444-0000-0000-0000000000c2"
    identidad["uid"] = BRUNO
    async with sesiones() as db:
        db.add(
            Event(
                id=publicado,
                organizer_id=BRUNO,
                title="Publicado a la antigua",
                description="Una descripción suficientemente larga para revisarla.",
                starts_at=datetime.now(timezone.utc) + timedelta(days=10),
                event_type="presential",
                location="Casa",
                status="published",
                capacity=10,
            )
        )
        db.add(
            EventTicketingSettings(
                event_id=publicado, access_mode="TICKETED", currency="PEN"
            )
        )
        await db.commit()

    respuesta = await http.post(
        f"{EVENTOS}/{publicado}/tickets/verify", json={"credential": "loquesea"}
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["result"] == "NOT_FOUND"


# --------------------------------------------------------------------------- #
# La auditoria de la puerta: canal, resultado real y actor
# --------------------------------------------------------------------------- #
async def _rastro(sesiones, accion):
    async with sesiones() as db:
        return list(
            await db.scalars(select(AuditEvent).where(AuditEvent.action == accion))
        )


@pytest.mark.asyncio
async def test_la_auditoria_distingue_la_camara_del_teclado(entorno):
    """El camino tecleado es el debil y era el que no dejaba huella propia.

    Doscientos check-ins a mano desde la trastienda eran, en el historico,
    identicos a doscientos escaneos. La pregunta «cuantos de estos entraron por
    teclado» no tenia respuesta posible.
    """
    http, identidad, sesiones = entorno
    entrada, credencial = await _una_entrada(http, identidad, sesiones)
    codigo = entrada["code"]

    identidad["uid"] = ADMINISTRA
    # Por el QR.
    await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": credencial}
    )
    # Y por el codigo tecleado, sobre la MISMA entrada: el segundo es "ya usada".
    await http.post(f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": codigo})

    canales = [f.payload.get("canal") for f in await _rastro(sesiones, "event.checkin")]
    assert canales == ["qr", "code"], canales


@pytest.mark.asyncio
async def test_el_canal_lo_decide_el_servidor_y_no_el_cliente(entorno):
    """No hay ningun campo del cuerpo que diga «vengo de la camara».

    Si lo declarara el cliente, quien teclea podria decir que escaneo, y el
    rastro contaria la version del sospechoso.
    """
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)
    codigo = entrada["code"]

    identidad["uid"] = ADMINISTRA
    await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins",
        json={"credential": codigo, "canal": "qr", "channel": "qr"},
    )
    canales = [f.payload.get("canal") for f in await _rastro(sesiones, "event.checkin")]
    assert canales == ["code"]


@pytest.mark.asyncio
async def test_un_intento_rechazado_no_se_archiva_como_correcto(entorno):
    """Con `outcome` siempre en 'ok', una alerta de intentos rechazados por
    operador no dispara nunca: es el patron de alguien probando codigos."""
    http, identidad, sesiones = entorno
    await _una_entrada(http, identidad, sesiones)

    identidad["uid"] = ADMINISTRA
    await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": "NOEXISTE12345"}
    )
    filas = await _rastro(sesiones, "event.checkin")
    assert [f.outcome for f in filas] == ["denied"]
    assert [f.new_state for f in filas] == ["NOT_FOUND"]
    # Y no es una persona del sistema: es un operador con nombre.
    assert filas[0].actor_role == "user"
    assert filas[0].actor_id == ADMINISTRA


@pytest.mark.asyncio
async def test_sin_entrada_el_rastro_no_dice_ser_de_una_entrada(entorno):
    """Guardaba el id de un EVENTO bajo `entity_type='event_ticket'`.

    Reconstruir la vida de una entrada consultando por ese identificador
    devolvia los intentos fallidos de una puerta entera.
    """
    http, identidad, sesiones = entorno
    await _una_entrada(http, identidad, sesiones)
    identidad["uid"] = ADMINISTRA
    await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": "NOEXISTE12345"}
    )
    fila = (await _rastro(sesiones, "event.checkin"))[0]
    assert fila.entity_type == "event"
    assert fila.entity_id == CON_ENTRADAS


@pytest.mark.asyncio
async def test_rotar_la_credencial_deja_rastro_y_no_la_escribe(entorno):
    """Rotar invalida el QR anterior: es destructivo para quien esta en la cola.

    Una sesion robada que pida credencial nueva justo antes del evento deja a
    quien compro con una entrada que ya no vale, y no dejaba ni una linea.
    """
    http, identidad, sesiones = entorno
    entrada, credencial = await _una_entrada(http, identidad, sesiones)

    identidad["uid"] = ANA
    nueva = (await http.post(f"{EVENTOS}/tickets/{entrada['id']}/credential")).json()

    filas = await _rastro(sesiones, "event.ticket.credential_rotated")
    assert len(filas) >= 1
    crudo = " ".join(str(f.payload) + str(f.new_state) for f in filas)
    assert credencial not in crudo
    assert nueva["credential"] not in crudo


# --------------------------------------------------------------------------- #
# Los siete numeros del aforo, separados
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_las_ventas_separan_apartado_de_vendido(entorno):
    """Confundirlos es como un organizador cree que vendio lo que sigue en la
    cesta de alguien."""
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)
    # Y una reserva VIVA que nadie ha comprado.
    identidad["uid"] = BRUNO
    await _apartar(http, GENERAL, 3, "hv")

    identidad["uid"] = ORG
    ventas = (await http.get(f"{EVENTOS}/{CON_ENTRADAS}/sales")).json()
    assert ventas["entradas_apartadas"] == 3
    assert ventas["entradas_emitidas"] == 1
    assert ventas["entradas_validas"] == 1
    assert ventas["entradas_usadas"] == 0
    assert ventas["checkins"] == 0
    assert ventas["aforo"] is not None


@pytest.mark.asyncio
async def test_los_asistentes_presentes_salen_de_los_check_ins(entorno):
    """No de pedidos, ni de compradores, ni de una suma guardada a mano."""
    http, identidad, sesiones = entorno
    entrada, credencial = await _una_entrada(http, identidad, sesiones)
    # UNA SEGUNDA ENTRADA, DE OTRA PERSONA, QUE NO VA A PASAR. Sin ella, el
    # unico intento rechazado seria sobre la misma entrada que si paso y
    # contarlo o no daria el mismo numero: la prueba diria estar comprobando el
    # filtro y no estaria comprobando nada.
    identidad["uid"] = BRUNO
    otra, suya = await _una_entrada(http, identidad, sesiones, quien=BRUNO)
    identidad["uid"] = ORG
    await http.post(f"{EVENTOS}/tickets/{otra['id']}/revoke", json={"reason": "no va"})

    identidad["uid"] = ADMINISTRA
    await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": credencial}
    )
    # El mismo QR otra vez: la puerta lo rechaza y NO suma otro asistente.
    await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": credencial}
    )
    # Y la entrada anulada, que deja un intento REVOKED sobre OTRA entrada.
    await http.post(f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": suya})

    identidad["uid"] = ORG
    ventas = (await http.get(f"{EVENTOS}/{CON_ENTRADAS}/sales")).json()
    assert ventas["checkins"] == 1
    assert ventas["entradas_usadas"] == 1
    assert ventas["entradas_validas"] == 0
    assert ventas["entradas_revocadas"] == 1


# --------------------------------------------------------------------------- #
# La recaudacion no viene con el permiso de abrir la puerta
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_recaudacion_no_la_ve_quien_solo_abre_la_puerta(
    entorno, monkeypatch
):
    """El dia que exista un rol de acomodador, no puede llevar la caja dentro.

    Se anade ese rol a `ROLES_ADMISION` —que es exactamente para lo que la
    constante existe— y se comprueba que la puerta se le abre y las ventas no.
    """
    from app.modules.events import permissions

    monkeypatch.setattr(
        permissions, "ROLES_ADMISION", {"admin", "moderator"}, raising=True
    )
    http, identidad, sesiones = entorno
    await _una_entrada(http, identidad, sesiones)

    identidad["uid"] = MODERA
    puerta = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/tickets/verify", json={"credential": "loquesea"}
    )
    assert puerta.status_code == 200, "el acomodador tiene que poder abrir la puerta"
    ventas = await http.get(f"{EVENTOS}/{CON_ENTRADAS}/sales")
    assert ventas.status_code == 404, "y NO tiene que ver la recaudacion"


@pytest.mark.asyncio
async def test_revocar_no_devuelve_el_codigo_de_una_entrada_ajena(entorno):
    """Un codigo admite por si solo: devolverselo a quien revoca es repartir
    una entrada que esa persona todavia no tenia."""
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)
    codigo = entrada["code"]

    identidad["uid"] = ORG
    respuesta = await http.post(
        f"{EVENTOS}/tickets/{entrada['id']}/revoke", json={"reason": "duplicada"}
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["code"] is None
    assert codigo not in respuesta.text


# --------------------------------------------------------------------------- #
# El código de admisión ya no está en claro
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_volcado_de_la_tabla_no_entrega_codigos_utilizables(entorno):
    """LA PRUEBA DEL VOLCADO. Todo lo que la fila guarda, contra la puerta.

    El código admite por sí solo: `_buscar` lo acepta como credencial. Mientras
    estuvo en texto legible, una copia de seguridad, una réplica de análisis o
    una consulta de más entregaban un juego completo de entradas. Aquí se toma
    TODO lo que la fila contiene y se intenta entrar con cada campo.
    """
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)

    async with sesiones() as db:
        fila = await db.get(EventTicket, entrada["id"])
        volcado = {
            c.name: getattr(fila, c.name) for c in EventTicket.__table__.columns
        }
    assert volcado["code"] is None, "el texto legible no se guarda"
    assert volcado["code_hash"], "y su resumen sí"

    identidad["uid"] = ADMINISTRA
    for campo, valor in volcado.items():
        if not isinstance(valor, str) or not valor.strip():
            continue
        respuesta = await http.post(
            f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": valor}
        )
        assert respuesta.json()["result"] != "OK", (
            f"el campo {campo} de la fila deja entrar por sí solo"
        )

    async with sesiones() as db:
        assert (await db.get(EventTicket, entrada["id"])).status == "VALID"


@pytest.mark.asyncio
async def test_el_codigo_solo_se_entrega_al_rotar(entorno):
    """Ni el listado, ni la ficha, ni la revocación lo llevan."""
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)
    codigo = entrada["code"]
    assert codigo, "la rotación sí lo entrega"

    identidad["uid"] = ANA
    listado = await http.get(f"{EVENTOS}/me/tickets")
    ficha = await http.get(f"{EVENTOS}/tickets/{entrada['id']}")
    assert codigo not in listado.text
    assert codigo not in ficha.text

    identidad["uid"] = ORG
    asistentes = await http.get(f"{EVENTOS}/{CON_ENTRADAS}/attendees")
    revocada = await http.post(
        f"{EVENTOS}/tickets/{entrada['id']}/revoke", json={"reason": "duplicada"}
    )
    assert codigo not in asistentes.text
    assert codigo not in revocada.text


@pytest.mark.asyncio
async def test_el_codigo_anterior_no_vuelve_a_valer(entorno):
    """Rotar invalida el código igual que invalida el QR."""
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)
    viejo = entrada["code"]

    identidad["uid"] = ANA
    nuevo = (
        await http.post(f"{EVENTOS}/tickets/{entrada['id']}/credential")
    ).json()["code"]
    assert nuevo != viejo

    identidad["uid"] = ADMINISTRA
    con_el_viejo = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": viejo}
    )
    assert con_el_viejo.json()["result"] == "NOT_FOUND"
    con_el_nuevo = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": nuevo}
    )
    assert con_el_nuevo.json()["result"] == "OK"


@pytest.mark.asyncio
async def test_una_entrada_de_antes_de_la_migracion_sigue_admitiendo(entorno):
    """LA ESTRATEGIA PARA LO ANTERIOR, ejercida.

    Una entrada emitida antes de la 0063 tiene su código en texto legible y no
    tiene resumen. Tiene que seguir dejando pasar, o la migración habría dejado
    fuera a quien ya había comprado.
    """
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)

    # Se recrea el estado anterior a la migración: texto legible, sin resumen.
    async with sesiones() as db:
        fila = await db.get(EventTicket, entrada["id"])
        fila.code = "ANTIGUO1234567"
        fila.code_hash = None
        await db.commit()

    identidad["uid"] = ADMINISTRA
    respuesta = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": "ANTIGUO1234567"}
    )
    assert respuesta.json()["result"] == "OK"


@pytest.mark.asyncio
async def test_el_texto_legible_deja_de_valer_en_cuanto_hay_resumen(entorno):
    """Y ESE ES EL LÍMITE DEL LEGADO.

    El texto legible solo se acepta mientras esa fila no tenga resumen. Si se
    aceptara siempre, una rotación no invalidaría nada en las entradas que
    vienen de antes: el código viejo seguiría en la columna y seguiría
    admitiendo.
    """
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)

    async with sesiones() as db:
        fila = await db.get(EventTicket, entrada["id"])
        # Texto legible Y resumen a la vez: manda el resumen.
        fila.code = "ANTIGUO1234567"
        await db.commit()

    identidad["uid"] = ADMINISTRA
    respuesta = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": "ANTIGUO1234567"}
    )
    assert respuesta.json()["result"] == "NOT_FOUND"


@pytest.mark.asyncio
async def test_la_busqueda_de_asistentes_es_exacta(entorno):
    """Sin prefijos no hay recorrido: un resumen no admite «empieza por».

    Es lo que cierra del todo el extractor de códigos, en vez de encarecerlo.
    """
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)
    codigo = entrada["code"]

    identidad["uid"] = ORG
    entero = (
        await http.get(f"{EVENTOS}/{CON_ENTRADAS}/attendees", params={"q": codigo})
    ).json()
    assert [f["ticket_id"] for f in entero["items"]] == [entrada["id"]]

    # Y ningún prefijo suyo encuentra nada, por largo que sea.
    for corte in (6, 8, 10, 13):
        parcial = (
            await http.get(
                f"{EVENTOS}/{CON_ENTRADAS}/attendees", params={"q": codigo[:corte]}
            )
        ).json()
        assert parcial["items"] == [], f"el prefijo de {corte} encontró algo"
