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
from app.modules.events.models import (
    EventOperations,
    EventOrder,
    EventTicket,
    EventTicketHold,
    EventTicketingSettings,
    EventTicketType,
)
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


async def _confirmar(sesiones, orden_id, **cambios):
    """Un aviso YA VERIFICADO, con los valores que la prueba quiera romper."""
    datos = {
        "provider": "stripe",
        "environment": "sandbox",
        "external_payment_id": f"pi_{orden_id[:8]}",
        "amount_minor": None,
        "currency": "PEN",
    }
    datos.update(cambios)
    async with sesiones() as db:
        if datos["amount_minor"] is None and "amount_minor" not in cambios:
            orden = await db.get(EventOrder, orden_id)
            datos["amount_minor"] = orden.total_minor
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

    resultado = await _confirmar(sesiones, orden["id"])
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
        await _confirmar(sesiones, orden["id"], **cambio)

    async with sesiones() as db:
        assert (await db.get(EventOrder, orden["id"])).status == "PENDING_PAYMENT"
        assert list(await db.scalars(select(EventTicket))) == [], por_que
        assert (await db.get(EventTicketHold, hold["id"])).status == "ACTIVE"


@pytest.mark.asyncio
async def test_el_mismo_aviso_dos_veces_no_emite_el_doble(entorno):
    """Las pasarelas reintentan. Diez avisos, un juego de entradas."""
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 2, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()

    primera = await _confirmar(sesiones, orden["id"])
    segunda = await _confirmar(sesiones, orden["id"])
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
    await _confirmar(sesiones, orden["id"])

    with pytest.raises(orders.PagoNoCuadra):
        await _confirmar(sesiones, orden["id"], external_payment_id="pi_otro_cobro")


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
        await _confirmar(sesiones, orden["id"])

    async with sesiones() as db:
        assert list(await db.scalars(select(EventTicket))) == []
        assert (await db.get(EventOrder, orden["id"])).status == "PENDING_PAYMENT"


@pytest.mark.asyncio
async def test_un_pedido_ya_cancelado_no_se_paga(entorno):
    http, _, sesiones = entorno
    hold = await _apartar(http, GENERAL, 1, "h1")
    orden = (await _pedir(http, hold["id"], "o1")).json()
    cancelada = await http.post(f"{EVENTOS}/orders/{orden['id']}/cancel")
    assert cancelada.status_code == 200
    assert cancelada.json()["status"] == "CANCELLED"

    with pytest.raises(orders.PagoNoCuadra):
        await _confirmar(sesiones, orden["id"])
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

    resultado = await _confirmar(sesiones, orden["id"])
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
async def _una_entrada(http, identidad, sesiones):
    identidad["uid"] = ANA
    hold = await _apartar(http, CORTESIA, 1, "h1")
    await _pedir(http, hold["id"], "o1")
    entrada = (await http.get(f"{EVENTOS}/me/tickets")).json()["items"][0]
    credencial = (
        await http.post(f"{EVENTOS}/tickets/{entrada['id']}/credential")
    ).json()["credential"]
    return entrada, credencial


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
    """Cuando la cámara no funciona hay que poder entrar igual."""
    http, identidad, sesiones = entorno
    entrada, _ = await _una_entrada(http, identidad, sesiones)

    identidad["uid"] = ORG
    respuesta = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": entrada["code"]}
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
    http, identidad, sesiones = entorno
    _, credencial = await _una_entrada(http, identidad, sesiones)
    identidad["uid"] = ANA
    respuesta = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": credencial}
    )
    assert respuesta.status_code == 403


@pytest.mark.asyncio
async def test_quien_solo_modera_contenido_no_hace_check_in(entorno):
    """`moderator` existe para revisar contenido, no para abrir una puerta."""
    http, identidad, sesiones = entorno
    _, credencial = await _una_entrada(http, identidad, sesiones)
    identidad["uid"] = MODERA
    respuesta = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/check-ins", json={"credential": credencial}
    )
    assert respuesta.status_code == 403


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
    assert respuesta.status_code == 403


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
    await _confirmar(sesiones, orden["id"])

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
    await _confirmar(sesiones, orden["id"])

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
    assert respuesta.status_code == 403


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
