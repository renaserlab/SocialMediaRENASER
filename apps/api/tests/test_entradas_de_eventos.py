"""Tipos de entrada, disponibilidad y reservas temporales, por HTTP.

LO QUE ESTO PRUEBA Y LO QUE NO. Aquí están las reglas que no necesitan dos
escritores a la vez: precios, límites, idempotencia, permisos, vencimiento y la
separación entre reserva gratuita y venta de entradas. La CARRERA —dos personas
peleando por la última entrada— vive en `test_entradas_concurrentes_postgres.py`
y solo significa algo contra PostgreSQL.

NADA DE ESTO COBRA. Una reserva temporal aparta entradas diez minutos; no hay
orden, ni pago, ni entrada emitida. El contrato no lo insinúa y las pruebas
comprueban que no lo insinúe.
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
from app.modules.catalog.models import Event, EventRegistration
from app.modules.events import esquema, ticketing
from app.modules.events.models import (
    EventOperations,
    EventTicketHold,
    EventTicketingSettings,
    EventTicketType,
)
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db

EVENTOS = "/api/v1/events"
ADMIN = "/api/v1/admin/events"
CATALOGO = "/api/v1/catalog"

ORG = "cccccccc-2222-0000-0000-000000000001"
ANA = "aaaaaaaa-2222-0000-0000-000000000001"
BRUNO = "aaaaaaaa-2222-0000-0000-000000000002"
ADMINISTRA = "dddddddd-2222-0000-0000-000000000001"

CON_ENTRADAS = "eeeeeeee-2222-0000-0000-0000000000a1"
GRATUITO = "eeeeeeee-2222-0000-0000-0000000000a2"
AJENO = "eeeeeeee-2222-0000-0000-0000000000a3"

GENERAL = "ffffffff-2222-0000-0000-00000000000a"
VIP = "ffffffff-2222-0000-0000-00000000000b"
BORRADOR_DE_TIPO = "ffffffff-2222-0000-0000-00000000000c"
DEL_AJENO = "ffffffff-2222-0000-0000-00000000000d"


@pytest_asyncio.fixture
async def entorno(monkeypatch):
    esquema.olvidar()
    # LA BANDERA, ENCENDIDA SOLO AQUÍ. En producción nace apagada: el flujo
    # llega hasta la reserva temporal y no hay cobro detrás.
    monkeypatch.setattr(get_settings(), "feature_event_ticketing", True, raising=False)

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
        db.add(evento(GRATUITO))
        db.add(evento(AJENO, organizador=ADMINISTRA))
        for ident in (CON_ENTRADAS, GRATUITO, AJENO):
            db.add(
                EventOperations(
                    event_id=ident,
                    workflow_status="PUBLISHED",
                    selection_status="none",
                    origin="events_v2",
                )
            )

        db.add(
            EventTicketingSettings(
                event_id=CON_ENTRADAS, access_mode="TICKETED", currency="PEN"
            )
        )
        db.add(
            EventTicketingSettings(
                event_id=AJENO, access_mode="TICKETED", currency="PEN"
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
                quota=10,
                min_per_order=1,
                max_per_order=4,
                status="on_sale",
                sort_order=1,
            )
        )
        db.add(
            EventTicketType(
                id=VIP,
                event_id=CON_ENTRADAS,
                name="VIP",
                description="Primera fila y saludo.",
                price_minor=15000,
                currency="PEN",
                quota=2,
                min_per_order=1,
                max_per_order=2,
                status="on_sale",
                sort_order=0,
            )
        )
        db.add(
            EventTicketType(
                id=BORRADOR_DE_TIPO,
                event_id=CON_ENTRADAS,
                name="Todavía no",
                price_minor=1000,
                currency="PEN",
                quota=5,
                status="draft",
                sort_order=2,
            )
        )
        db.add(
            EventTicketType(
                id=DEL_AJENO,
                event_id=AJENO,
                name="De otro evento",
                price_minor=1000,
                currency="PEN",
                quota=5,
                status="on_sale",
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


def _pedido(**cantidades):
    return {"items": [{"ticket_type_id": t, "quantity": c} for t, c in cantidades.items()]}


async def _apartar(http, tipo, cantidad, clave, evento=CON_ENTRADAS):
    return await http.post(
        f"{EVENTOS}/{evento}/ticket-holds",
        json={"items": [{"ticket_type_id": tipo, "quantity": cantidad}]},
        headers={"Idempotency-Key": clave},
    )


# --------------------------------------------------------------------------- #
# Los tipos que se enseñan
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_solo_se_ofrecen_los_que_estan_a_la_venta(entorno):
    http, _, _ = entorno
    tipos = (await http.get(f"{EVENTOS}/{CON_ENTRADAS}/ticket-types")).json()
    assert [t["id"] for t in tipos] == [VIP, GENERAL], "y en el orden del organizador"
    assert BORRADOR_DE_TIPO not in {t["id"] for t in tipos}


@pytest.mark.asyncio
async def test_el_cupo_no_viaja_en_el_contrato_publico(entorno):
    """`quota` es inventario del organizador.

    Lo que quien elige necesita es cuántas quedan, y eso sí viaja.
    """
    http, _, _ = entorno
    tipos = (await http.get(f"{EVENTOS}/{CON_ENTRADAS}/ticket-types")).json()
    for tipo in tipos:
        assert "quota" not in tipo
        assert "status" not in tipo
        assert "disponibles" in tipo


@pytest.mark.asyncio
async def test_un_evento_gratuito_no_tiene_entradas_que_ofrecer(entorno):
    """409 con su código, no una lista vacía: son dos cosas distintas."""
    http, _, _ = entorno
    respuesta = await http.get(f"{EVENTOS}/{GRATUITO}/ticket-types")
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "event_not_ticketed"


@pytest.mark.asyncio
async def test_un_evento_que_no_se_ve_no_dice_ni_que_existe(entorno):
    http, _, sesiones = entorno
    async with sesiones() as db:
        evento = await db.get(Event, GRATUITO)
        evento.status = "draft"
        operacion = await db.get(EventOperations, GRATUITO)
        operacion.workflow_status = "DRAFT"
        await db.commit()
    assert (await http.get(f"{EVENTOS}/{GRATUITO}/ticket-types")).status_code == 404


# --------------------------------------------------------------------------- #
# Disponibilidad
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_la_disponibilidad_se_calcula_desde_los_cupos(entorno):
    http, _, _ = entorno
    libre = (await http.get(f"{EVENTOS}/{CON_ENTRADAS}/availability")).json()
    assert libre["general"] == 100
    assert libre["por_tipo"][GENERAL] == 10
    assert libre["por_tipo"][VIP] == 2


@pytest.mark.asyncio
async def test_lo_apartado_deja_de_estar_disponible(entorno):
    http, _, _ = entorno
    assert (await _apartar(http, GENERAL, 3, "k1")).status_code == 201
    libre = (await http.get(f"{EVENTOS}/{CON_ENTRADAS}/availability")).json()
    assert libre["por_tipo"][GENERAL] == 7
    assert libre["general"] == 97


@pytest.mark.asyncio
async def test_un_tipo_nunca_ofrece_mas_de_lo_que_cabe_en_el_evento(entorno):
    """Dos tipos comparten el aforo general: la suma no puede pasarse."""
    http, _, sesiones = entorno
    async with sesiones() as db:
        evento = await db.get(Event, CON_ENTRADAS)
        evento.capacity = 5
        await db.commit()
    libre = (await http.get(f"{EVENTOS}/{CON_ENTRADAS}/availability")).json()
    # El cupo de General son 10, pero en el evento solo caben 5.
    assert libre["por_tipo"][GENERAL] == 5
    assert libre["por_tipo"][VIP] == 2


@pytest.mark.asyncio
async def test_las_reservas_gratuitas_ocupan_aforo(entorno):
    http, _, sesiones = entorno
    async with sesiones() as db:
        db.add(
            EventRegistration(
                event_id=CON_ENTRADAS, user_id=BRUNO, status="confirmed"
            )
        )
        await db.commit()
    libre = (await http.get(f"{EVENTOS}/{CON_ENTRADAS}/availability")).json()
    assert libre["general"] == 99


# --------------------------------------------------------------------------- #
# Reservar temporalmente
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_apartar_entradas_devuelve_precios_del_servidor(entorno):
    http, _, _ = entorno
    respuesta = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/ticket-holds",
        json=_pedido(**{GENERAL: 2, VIP: 1}),
        headers={"Idempotency-Key": "carrito-1"},
    )
    assert respuesta.status_code == 201, respuesta.text
    hold = respuesta.json()
    assert hold["status"] == "ACTIVE"
    assert hold["currency"] == "PEN"
    # 2 × 4900 + 1 × 15000
    assert hold["subtotal_minor"] == 24800
    porlinea = {i["ticket_type_id"]: i for i in hold["items"]}
    assert porlinea[GENERAL]["unit_price_minor"] == 4900
    assert porlinea[GENERAL]["subtotal_minor"] == 9800
    assert porlinea[VIP]["subtotal_minor"] == 15000
    assert 0 < hold["segundos_restantes"] <= 600


@pytest.mark.asyncio
async def test_el_precio_que_manda_el_cliente_no_existe_en_el_contrato(entorno):
    """Mandar un precio no lo cambia: el contrato no tiene dónde ponerlo."""
    http, _, _ = entorno
    respuesta = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/ticket-holds",
        json={
            "items": [
                {"ticket_type_id": GENERAL, "quantity": 1, "unit_price_minor": 1}
            ]
        },
        headers={"Idempotency-Key": "listillo"},
    )
    assert respuesta.status_code == 201
    assert respuesta.json()["subtotal_minor"] == 4900


@pytest.mark.asyncio
async def test_sin_clave_de_idempotencia_no_se_aparta_nada(entorno):
    http, _, _ = entorno
    respuesta = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/ticket-holds", json=_pedido(**{GENERAL: 1})
    )
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_la_misma_clave_devuelve_la_misma_reserva(entorno):
    """Un reintento de la red no aparta el doble de entradas."""
    http, _, _ = entorno
    primera = await _apartar(http, GENERAL, 2, "misma")
    segunda = await _apartar(http, GENERAL, 2, "misma")
    assert primera.status_code == 201
    assert segunda.status_code == 201
    assert primera.json()["id"] == segunda.json()["id"]
    libre = (await http.get(f"{EVENTOS}/{CON_ENTRADAS}/availability")).json()
    assert libre["por_tipo"][GENERAL] == 8, "se apartaron dos, no cuatro"


@pytest.mark.asyncio
async def test_la_misma_clave_con_otra_cosa_dentro_es_un_conflicto(entorno):
    """No se le devuelve una reserva que no pidió."""
    http, _, _ = entorno
    assert (await _apartar(http, GENERAL, 2, "clave")).status_code == 201
    respuesta = await _apartar(http, GENERAL, 3, "clave")
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "ticket_hold_conflict"


@pytest.mark.asyncio
async def test_dos_claves_distintas_no_evaden_el_limite_por_tipo(entorno):
    """El tope es por operación, y el índice deja UN hold activo por persona.

    Sin eso, pedir cuatro y cuatro con dos claves distintas sería pedir ocho.
    """
    http, _, _ = entorno
    assert (await _apartar(http, GENERAL, 4, "a")).status_code == 201
    segunda = await _apartar(http, GENERAL, 4, "b")
    assert segunda.status_code == 409
    assert segunda.json()["error"]["code"] == "ticket_hold_already_active"


@pytest.mark.asyncio
async def test_pedir_mas_del_maximo_por_operacion(entorno):
    http, _, _ = entorno
    respuesta = await _apartar(http, GENERAL, 5, "muchas")
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "ticket_limit_exceeded"


@pytest.mark.asyncio
async def test_pedir_mas_de_lo_que_queda(entorno):
    http, identidad, _ = entorno
    identidad["uid"] = ANA
    assert (await _apartar(http, VIP, 2, "vip-ana")).status_code == 201
    identidad["uid"] = BRUNO
    respuesta = await _apartar(http, VIP, 1, "vip-bruno")
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "event_capacity_exceeded"


@pytest.mark.asyncio
async def test_una_cantidad_de_cero_o_negativa_no_pasa_del_contrato(entorno):
    http, _, _ = entorno
    for cantidad in (0, -1):
        respuesta = await _apartar(http, GENERAL, cantidad, f"c{cantidad}")
        assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_un_tipo_que_no_esta_a_la_venta_no_se_aparta(entorno):
    http, _, _ = entorno
    respuesta = await _apartar(http, BORRADOR_DE_TIPO, 1, "borrador")
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "ticket_type_unavailable"


@pytest.mark.asyncio
async def test_un_tipo_de_otro_evento_no_entra_en_la_reserva(entorno):
    http, _, _ = entorno
    respuesta = await _apartar(http, DEL_AJENO, 1, "ajeno")
    assert respuesta.status_code == 404
    assert respuesta.json()["error"]["code"] == "ticket_type_not_found"


@pytest.mark.asyncio
async def test_un_evento_gratuito_no_admite_apartar_entradas(entorno):
    http, _, _ = entorno
    respuesta = await _apartar(http, GENERAL, 1, "gratis", evento=GRATUITO)
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "event_not_ticketed"


@pytest.mark.asyncio
async def test_apartar_entradas_no_crea_una_reserva_gratuita(entorno):
    """Los dos flujos no se mezclan: un hold no es un RSVP."""
    http, _, sesiones = entorno
    await _apartar(http, GENERAL, 1, "sin-rsvp")
    async with sesiones() as db:
        reservas = list(
            await db.scalars(
                select(EventRegistration).where(
                    EventRegistration.event_id == CON_ENTRADAS
                )
            )
        )
    assert reservas == []


# --------------------------------------------------------------------------- #
# La ventana de venta
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_antes_de_abrir_la_venta(entorno):
    http, _, sesiones = entorno
    async with sesiones() as db:
        ajustes = await db.get(EventTicketingSettings, CON_ENTRADAS)
        ajustes.sales_open_at = datetime.now(timezone.utc) + timedelta(days=1)
        await db.commit()
    respuesta = await _apartar(http, GENERAL, 1, "pronto")
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "event_sales_not_open"


@pytest.mark.asyncio
async def test_despues_de_cerrar_la_venta(entorno):
    http, _, sesiones = entorno
    async with sesiones() as db:
        ajustes = await db.get(EventTicketingSettings, CON_ENTRADAS)
        ajustes.sales_close_at = datetime.now(timezone.utc) - timedelta(hours=1)
        await db.commit()
    respuesta = await _apartar(http, GENERAL, 1, "tarde")
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "event_sales_closed"


# --------------------------------------------------------------------------- #
# Vencimiento y liberación
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_un_hold_vencido_deja_de_ocupar_aunque_siga_diciendo_activo(entorno):
    """La limpieza puede no haber corrido. La disponibilidad no la espera."""
    http, _, sesiones = entorno
    creado = (await _apartar(http, GENERAL, 4, "vieja")).json()
    async with sesiones() as db:
        hold = await db.get(EventTicketHold, creado["id"])
        hold.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await db.commit()

    libre = (await http.get(f"{EVENTOS}/{CON_ENTRADAS}/availability")).json()
    assert libre["por_tipo"][GENERAL] == 10, "vencido no ocupa"

    # Y su ficha lo dice, aunque la fila siga en ACTIVE.
    ficha = (await http.get(f"{EVENTOS}/ticket-holds/{creado['id']}")).json()
    assert ficha["status"] == "EXPIRED"
    assert ficha["segundos_restantes"] == 0


@pytest.mark.asyncio
async def test_la_limpieza_marca_los_vencidos_y_es_idempotente(entorno):
    http, identidad, sesiones = entorno
    creado = (await _apartar(http, GENERAL, 1, "limpiar")).json()
    async with sesiones() as db:
        hold = await db.get(EventTicketHold, creado["id"])
        hold.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        await db.commit()

    identidad["uid"] = ADMINISTRA
    primera = await http.post(f"{ADMIN}/ticket-holds/expire")
    segunda = await http.post(f"{ADMIN}/ticket-holds/expire")
    assert primera.json()["procesados"] == 1
    assert segunda.json()["procesados"] == 0, "correrla dos veces no cambia nada"

    async with sesiones() as db:
        assert (await db.get(EventTicketHold, creado["id"])).status == "EXPIRED"


@pytest.mark.asyncio
async def test_la_limpieza_es_solo_para_administracion(entorno):
    http, identidad, _ = entorno
    identidad["uid"] = ANA
    assert (await http.post(f"{ADMIN}/ticket-holds/expire")).status_code == 403


@pytest.mark.asyncio
async def test_liberar_devuelve_el_inventario_al_momento(entorno):
    http, _, _ = entorno
    creado = (await _apartar(http, VIP, 2, "suelto")).json()
    assert (
        await http.get(f"{EVENTOS}/{CON_ENTRADAS}/availability")
    ).json()["por_tipo"][VIP] == 0

    respuesta = await http.delete(f"{EVENTOS}/ticket-holds/{creado['id']}")
    assert respuesta.status_code == 200
    assert respuesta.json()["status"] == "RELEASED"
    assert (
        await http.get(f"{EVENTOS}/{CON_ENTRADAS}/availability")
    ).json()["por_tipo"][VIP] == 2


@pytest.mark.asyncio
async def test_liberar_dos_veces_no_es_un_error(entorno):
    http, _, _ = entorno
    creado = (await _apartar(http, GENERAL, 1, "doble")).json()
    primera = await http.delete(f"{EVENTOS}/ticket-holds/{creado['id']}")
    segunda = await http.delete(f"{EVENTOS}/ticket-holds/{creado['id']}")
    assert primera.status_code == segunda.status_code == 200
    assert segunda.json()["status"] == "RELEASED"


@pytest.mark.asyncio
async def test_un_hold_vencido_no_vuelve_a_estar_activo(entorno):
    http, _, sesiones = entorno
    creado = (await _apartar(http, GENERAL, 1, "no-revive")).json()
    async with sesiones() as db:
        hold = await db.get(EventTicketHold, creado["id"])
        hold.status = "EXPIRED"
        await db.commit()
    ficha = (await http.get(f"{EVENTOS}/ticket-holds/{creado['id']}")).json()
    assert ficha["status"] == "EXPIRED"


@pytest.mark.asyncio
async def test_un_hold_consumido_no_se_libera(entorno):
    """Si algún día existe la orden que lo consume, soltar su inventario sería
    vender dos veces lo mismo."""
    http, _, sesiones = entorno
    creado = (await _apartar(http, GENERAL, 1, "consumido")).json()
    async with sesiones() as db:
        hold = await db.get(EventTicketHold, creado["id"])
        hold.status = "CONSUMED"
        await db.commit()
    respuesta = await http.delete(f"{EVENTOS}/ticket-holds/{creado['id']}")
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "ticket_hold_already_consumed"


@pytest.mark.asyncio
async def test_ningun_camino_de_este_incremento_consume_una_reserva(entorno):
    """`CONSUMED` está en el contrato y no lo escribe nadie: no hay orden."""
    fuente = (
        __import__("pathlib").Path(ticketing.__file__).read_text(encoding="utf-8")
    )
    asignaciones = [
        linea
        for linea in fuente.splitlines()
        if "status = CONSUMIDO" in linea or 'status = "CONSUMED"' in linea
    ]
    assert asignaciones == []


@pytest.mark.asyncio
async def test_la_reserva_de_otra_persona_no_existe(entorno):
    http, identidad, _ = entorno
    creado = (await _apartar(http, GENERAL, 1, "mia")).json()
    identidad["uid"] = BRUNO
    assert (await http.get(f"{EVENTOS}/ticket-holds/{creado['id']}")).status_code == 404
    assert (
        await http.delete(f"{EVENTOS}/ticket-holds/{creado['id']}")
    ).status_code == 404


# --------------------------------------------------------------------------- #
# El organizador administra sus tipos
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_el_organizador_crea_un_tipo(entorno):
    http, identidad, _ = entorno
    identidad["uid"] = ORG
    respuesta = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/ticket-types",
        json={"name": "Estudiante", "price_minor": 2500, "quota": 20},
    )
    assert respuesta.status_code == 201, respuesta.text
    assert respuesta.json()["currency"] == "PEN", "la moneda la pone el evento"
    assert respuesta.json()["status"] == "draft", "nace sin estar a la venta"


@pytest.mark.asyncio
async def test_un_cupo_mayor_que_el_aforo_no_se_crea(entorno):
    http, identidad, _ = entorno
    identidad["uid"] = ORG
    respuesta = await http.post(
        f"{EVENTOS}/{CON_ENTRADAS}/ticket-types",
        json={"name": "Imposible", "price_minor": 100, "quota": 500},
    )
    assert respuesta.status_code == 422
    assert respuesta.json()["error"]["code"] == "ticket_quota_invalid"


@pytest.mark.asyncio
async def test_no_se_cambia_el_precio_con_reservas_encima(entorno):
    http, identidad, _ = entorno
    await _apartar(http, GENERAL, 1, "encima")
    identidad["uid"] = ORG
    respuesta = await http.patch(
        f"{EVENTOS}/{CON_ENTRADAS}/ticket-types/{GENERAL}", json={"price_minor": 100}
    )
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "ticket_type_in_use"


@pytest.mark.asyncio
async def test_el_precio_cambiado_despues_no_toca_lo_ya_apartado(entorno):
    """El resumen tiene que seguir contando lo que se apartó."""
    http, identidad, _ = entorno
    creado = (await _apartar(http, GENERAL, 2, "congelado")).json()
    assert creado["subtotal_minor"] == 9800

    # Se libera para poder cambiar el precio, y se comprueba que la reserva
    # anterior sigue diciendo lo mismo.
    identidad["uid"] = ORG
    await http.patch(
        f"{EVENTOS}/{CON_ENTRADAS}/ticket-types/{GENERAL}", json={"price_minor": 9900}
    )
    identidad["uid"] = ANA
    ficha = (await http.get(f"{EVENTOS}/ticket-holds/{creado['id']}")).json()
    assert ficha["subtotal_minor"] == 9800
    assert ficha["items"][0]["unit_price_minor"] == 4900


@pytest.mark.asyncio
async def test_retirar_un_tipo_no_lo_borra(entorno):
    http, identidad, _ = entorno
    await _apartar(http, GENERAL, 1, "retirado")
    identidad["uid"] = ORG
    respuesta = await http.delete(f"{EVENTOS}/{CON_ENTRADAS}/ticket-types/{GENERAL}")
    assert respuesta.status_code == 200
    assert respuesta.json()["status"] == "retired"

    identidad["uid"] = ANA
    # Deja de ofrecerse, y la reserva que lo apuntaba sigue contando lo mismo.
    tipos = (await http.get(f"{EVENTOS}/{CON_ENTRADAS}/ticket-types")).json()
    assert GENERAL not in {t["id"] for t in tipos}


@pytest.mark.asyncio
async def test_el_organizador_no_administra_eventos_ajenos(entorno):
    http, identidad, _ = entorno
    identidad["uid"] = ORG
    for llamada in (
        http.get(f"{EVENTOS}/{AJENO}/ticket-types/manage"),
        http.post(
            f"{EVENTOS}/{AJENO}/ticket-types",
            json={"name": "Mío", "price_minor": 1, "quota": 1},
        ),
        http.patch(f"{EVENTOS}/{AJENO}/ticket-types/{DEL_AJENO}", json={"quota": 99}),
    ):
        assert (await llamada).status_code == 404


@pytest.mark.asyncio
async def test_no_se_pasa_a_entradas_con_reservas_gratuitas_encima(entorno):
    """Convertirlas en compradas sería regalar entradas que nadie pagó."""
    http, identidad, sesiones = entorno
    async with sesiones() as db:
        db.add(EventRegistration(event_id=GRATUITO, user_id=BRUNO, status="confirmed"))
        await db.commit()
    identidad["uid"] = ORG
    respuesta = await http.put(
        f"{EVENTOS}/{GRATUITO}/ticketing",
        json={"access_mode": "TICKETED", "currency": "PEN"},
    )
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "event_mode_conflict"


@pytest.mark.asyncio
async def test_un_evento_sin_configuracion_es_gratuito(entorno):
    """Sin fila significa `FREE_RSVP`. No es un hueco: es la respuesta."""
    http, identidad, _ = entorno
    identidad["uid"] = ORG
    respuesta = await http.get(f"{EVENTOS}/{GRATUITO}/ticketing")
    assert respuesta.status_code == 200
    assert respuesta.json()["access_mode"] == "FREE_RSVP"


@pytest.mark.asyncio
async def test_no_se_cambia_la_moneda_con_tipos_creados(entorno):
    http, identidad, _ = entorno
    identidad["uid"] = ORG
    respuesta = await http.put(
        f"{EVENTOS}/{CON_ENTRADAS}/ticketing",
        json={"access_mode": "TICKETED", "currency": "USD"},
    )
    assert respuesta.status_code == 409


@pytest.mark.asyncio
async def test_la_reserva_gratuita_sigue_funcionando_en_un_evento_libre(entorno):
    """El Incremento 1 no se toca: los dos flujos conviven sin mezclarse."""
    http, _, _ = entorno
    respuesta = await http.post(f"{CATALOGO}/events/{GRATUITO}/reserve")
    assert respuesta.status_code == 200
    assert respuesta.json()["reserved_by_me"] is True


# --------------------------------------------------------------------------- #
# La bandera y la migración
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_con_la_bandera_apagada_las_rutas_nuevas_responden_503(entorno, monkeypatch):
    http, _, _ = entorno
    monkeypatch.setattr(get_settings(), "feature_event_ticketing", False, raising=False)

    respuesta = await http.get(f"{EVENTOS}/{CON_ENTRADAS}/ticket-types")
    assert respuesta.status_code == 503
    assert respuesta.json()["error"]["code"] == "event_ticketing_not_available"

    # Y NADA DE LO ANTERIOR SE CAE.
    assert (await http.get(f"{CATALOGO}/events")).status_code == 200
    assert (await http.get(f"{CATALOGO}/events/{GRATUITO}")).status_code == 200
    assert (await http.post(f"{CATALOGO}/events/{GRATUITO}/reserve")).status_code == 200


@pytest.mark.asyncio
async def test_sin_la_migracion_0061_tambien_responden_503(entorno):
    http, _, sesiones = entorno
    async with sesiones() as db:
        conexion = await db.connection()
        for tabla in (
            "event_ticket_hold_items",
            "event_ticket_holds",
            "event_ticket_types",
            "event_ticketing_settings",
        ):
            await conexion.exec_driver_sql(f"drop table if exists {tabla}")
        await db.commit()
    esquema.olvidar()

    respuesta = await http.get(f"{EVENTOS}/{CON_ENTRADAS}/availability")
    assert respuesta.status_code == 503
    assert respuesta.json()["error"]["code"] == "event_ticketing_not_available"
    assert (await http.get(f"{CATALOGO}/events")).status_code == 200


@pytest.mark.asyncio
async def test_apagar_la_bandera_no_corrompe_las_reservas_existentes(entorno, monkeypatch):
    http, _, sesiones = entorno
    creado = (await _apartar(http, GENERAL, 2, "antes-de-apagar")).json()
    monkeypatch.setattr(get_settings(), "feature_event_ticketing", False, raising=False)

    async with sesiones() as db:
        hold = await db.get(EventTicketHold, creado["id"])
    assert hold.status == "ACTIVE"
    assert hold.subtotal_minor == 9800
