"""Las REGLAS del aforo, por HTTP y de punta a punta.

Qué prueba esto y qué NO. Aquí están los casos que no necesitan dos escritores
a la vez: lleno, vacío, pasado, no publicado, suspendido, doble toque, cancelar
y volver. La CARRERA —dos personas peleando por el último sitio— no se puede
probar en SQLite, que serializa la base entera y donde `SELECT ... FOR UPDATE`
ni siquiera se compila; está en `test_aforo_concurrente_postgres.py`, contra
PostgreSQL de verdad.

Fingirla aquí con dos llamadas seguidas daría un verde que no significa nada:
pasaría igual con el código roto.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.catalog.models import Event, EventRegistration
from app.modules.events import esquema
from app.modules.events.models import EventOperations
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db

CATALOGO = "/api/v1/catalog"
ORG = "cccccccc-0000-0000-0000-0000000000a1"
ANA = "aaaaaaaa-0000-0000-0000-0000000000a1"
BRUNO = "aaaaaaaa-0000-0000-0000-0000000000a2"
CARLA = "aaaaaaaa-0000-0000-0000-0000000000a3"

LIBRE = "eeeeeeee-0000-0000-0000-0000000000b1"
DE_UNO = "eeeeeeee-0000-0000-0000-0000000000b2"
SIN_AFORO = "eeeeeeee-0000-0000-0000-0000000000b3"
PASADO = "eeeeeeee-0000-0000-0000-0000000000b4"
BORRADOR = "eeeeeeee-0000-0000-0000-0000000000b5"
SUSPENDIDO = "eeeeeeee-0000-0000-0000-0000000000b6"
APROBADO_A_DOS = "eeeeeeee-0000-0000-0000-0000000000b7"


@pytest_asyncio.fixture
async def entorno():
    esquema.olvidar()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sesiones = async_sessionmaker(engine, expire_on_commit=False)

    ahora = datetime.now(timezone.utc)
    async with sesiones() as db:
        for ident, nombre in ((ORG, "Org"), (ANA, "Ana"), (BRUNO, "Bruno"), (CARLA, "Carla")):
            db.add(Profile(id=ident, full_name=nombre, username=nombre.lower()))

        def evento(ident, *, aforo=None, cuando=7, estado="published"):
            return Event(
                id=ident,
                organizer_id=ORG,
                title=f"Evento {ident[-2:]}",
                description="Descripción suficientemente larga para revisarla.",
                starts_at=ahora + timedelta(days=cuando),
                event_type="presential",
                location="Teatro Fénix",
                status=estado,
                capacity=aforo,
            )

        db.add(evento(LIBRE, aforo=3))
        db.add(evento(DE_UNO, aforo=1))
        db.add(evento(SIN_AFORO))
        db.add(evento(PASADO, cuando=-7))
        db.add(evento(BORRADOR, estado="draft"))
        db.add(evento(SUSPENDIDO, aforo=5, estado="draft"))
        db.add(evento(APROBADO_A_DOS, aforo=9))
        for ident, ciclo in (
            (LIBRE, "PUBLISHED"),
            (DE_UNO, "PUBLISHED"),
            (SIN_AFORO, "PUBLISHED"),
            (PASADO, "PUBLISHED"),
            (BORRADOR, "DRAFT"),
            (SUSPENDIDO, "SUSPENDED"),
            (APROBADO_A_DOS, "PUBLISHED"),
        ):
            db.add(
                EventOperations(
                    event_id=ident,
                    workflow_status=ciclo,
                    selection_status="none",
                    origin="events_v2",
                    approved_capacity=2 if ident == APROBADO_A_DOS else None,
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


async def _confirmadas(sesiones, evento: str) -> int:
    async with sesiones() as db:
        filas = await db.scalars(
            select(EventRegistration).where(EventRegistration.event_id == evento)
        )
        return len(list(filas))


# --------------------------------------------------------------------------- #
# Lo que se puede reservar
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_con_sitio_se_reserva(entorno):
    http, _, sesiones = entorno
    respuesta = await http.post(f"{CATALOGO}/events/{LIBRE}/reserve")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["reserved_by_me"] is True
    assert respuesta.json()["registrations_count"] == 1
    assert await _confirmadas(sesiones, LIBRE) == 1


@pytest.mark.asyncio
async def test_sin_aforo_no_hay_limite(entorno):
    """Compatibilidad: un evento sin `capacity` sigue admitiendo a quien llegue."""
    http, identidad, sesiones = entorno
    for quien in (ANA, BRUNO, CARLA):
        identidad["uid"] = quien
        assert (await http.post(f"{CATALOGO}/events/{SIN_AFORO}/reserve")).status_code == 200
    assert await _confirmadas(sesiones, SIN_AFORO) == 3


@pytest.mark.asyncio
async def test_un_evento_lleno_responde_409(entorno):
    http, identidad, sesiones = entorno
    assert (await http.post(f"{CATALOGO}/events/{DE_UNO}/reserve")).status_code == 200
    identidad["uid"] = BRUNO
    respuesta = await http.post(f"{CATALOGO}/events/{DE_UNO}/reserve")
    assert respuesta.status_code == 409
    assert "capacidad" in respuesta.text.lower()
    assert await _confirmadas(sesiones, DE_UNO) == 1


@pytest.mark.asyncio
async def test_el_aforo_aprobado_manda_sobre_el_declarado(entorno):
    """Se declararon 9 y la admisión autorizó 2: entran 2.

    Sin esta regla, un organizador ampliaría su aforo editando su propia ficha.
    """
    http, identidad, sesiones = entorno
    for quien in (ANA, BRUNO):
        identidad["uid"] = quien
        assert (
            await http.post(f"{CATALOGO}/events/{APROBADO_A_DOS}/reserve")
        ).status_code == 200
    identidad["uid"] = CARLA
    assert (
        await http.post(f"{CATALOGO}/events/{APROBADO_A_DOS}/reserve")
    ).status_code == 409
    assert await _confirmadas(sesiones, APROBADO_A_DOS) == 2


@pytest.mark.asyncio
async def test_un_evento_pasado_no_se_reserva(entorno):
    http, _, sesiones = entorno
    respuesta = await http.post(f"{CATALOGO}/events/{PASADO}/reserve")
    assert respuesta.status_code == 409
    assert "terminó" in respuesta.text
    assert await _confirmadas(sesiones, PASADO) == 0


@pytest.mark.asyncio
async def test_un_borrador_responde_404_y_no_409(entorno):
    """Un borrador ajeno NO EXISTE para quien no lo organiza.

    Contestar «este evento no admite reservas» ya cuenta que existe y que
    alguien lo está preparando. Es la misma respuesta que da la ficha.
    """
    http, _, sesiones = entorno
    assert (await http.post(f"{CATALOGO}/events/{BORRADOR}/reserve")).status_code == 404
    assert await _confirmadas(sesiones, BORRADOR) == 0


@pytest.mark.asyncio
async def test_un_evento_suspendido_no_recibe_reservas(entorno):
    """La regla del blueprint: suspendido o rechazado no admite gente nueva."""
    http, _, sesiones = entorno
    respuesta = await http.post(f"{CATALOGO}/events/{SUSPENDIDO}/reserve")
    assert respuesta.status_code == 409
    assert await _confirmadas(sesiones, SUSPENDIDO) == 0


@pytest.mark.asyncio
async def test_un_evento_que_no_existe_responde_404(entorno):
    http, _, _ = entorno
    ausente = "eeeeeeee-0000-0000-0000-0000000000ff"
    assert (await http.post(f"{CATALOGO}/events/{ausente}/reserve")).status_code == 404


@pytest.mark.asyncio
async def test_un_identificador_que_no_es_uuid_no_revienta(entorno):
    http, _, _ = entorno
    assert (await http.post(f"{CATALOGO}/events/no-es-un-uuid/reserve")).status_code == 404


# --------------------------------------------------------------------------- #
# Repetir, cancelar y volver
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_pulsar_dos_veces_no_consume_dos_cupos(entorno):
    """El doble toque, que es lo que de verdad pasa con el dedo."""
    http, _, sesiones = entorno
    primera = await http.post(f"{CATALOGO}/events/{DE_UNO}/reserve")
    segunda = await http.post(f"{CATALOGO}/events/{DE_UNO}/reserve")
    assert primera.status_code == segunda.status_code == 200
    assert segunda.json()["registrations_count"] == 1
    assert await _confirmadas(sesiones, DE_UNO) == 1


@pytest.mark.asyncio
async def test_cancelar_libera_el_cupo(entorno):
    http, identidad, sesiones = entorno
    await http.post(f"{CATALOGO}/events/{DE_UNO}/reserve")
    identidad["uid"] = BRUNO
    assert (await http.post(f"{CATALOGO}/events/{DE_UNO}/reserve")).status_code == 409

    identidad["uid"] = ANA
    respuesta = await http.delete(f"{CATALOGO}/events/{DE_UNO}/reserve")
    assert respuesta.status_code == 200
    assert respuesta.json()["reserved_by_me"] is False

    identidad["uid"] = BRUNO
    assert (await http.post(f"{CATALOGO}/events/{DE_UNO}/reserve")).status_code == 200
    assert await _confirmadas(sesiones, DE_UNO) == 1


@pytest.mark.asyncio
async def test_cancelar_lo_que_no_existe_no_es_un_error(entorno):
    http, _, sesiones = entorno
    respuesta = await http.delete(f"{CATALOGO}/events/{LIBRE}/reserve")
    assert respuesta.status_code == 200
    assert respuesta.json()["registrations_count"] == 0
    assert await _confirmadas(sesiones, LIBRE) == 0


@pytest.mark.asyncio
async def test_cancelar_y_volver_a_reservar(entorno):
    http, _, sesiones = entorno
    await http.post(f"{CATALOGO}/events/{LIBRE}/reserve")
    await http.delete(f"{CATALOGO}/events/{LIBRE}/reserve")
    respuesta = await http.post(f"{CATALOGO}/events/{LIBRE}/reserve")
    assert respuesta.status_code == 200
    assert respuesta.json()["reserved_by_me"] is True
    assert await _confirmadas(sesiones, LIBRE) == 1


@pytest.mark.asyncio
async def test_quien_ya_estaba_apuntado_a_algo_pasado_conserva_su_reserva(entorno):
    """El evento pasó, pero su reserva existió: negarla ahora sería reescribirlo."""
    http, _, sesiones = entorno
    async with sesiones() as db:
        db.add(EventRegistration(event_id=PASADO, user_id=ANA, status="confirmed"))
        await db.commit()

    respuesta = await http.post(f"{CATALOGO}/events/{PASADO}/reserve")
    assert respuesta.status_code == 200
    assert respuesta.json()["reserved_by_me"] is True


# --------------------------------------------------------------------------- #
# Lo que se enseña coincide con lo que hay
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_el_conteo_que_se_devuelve_es_el_real(entorno):
    http, identidad, sesiones = entorno
    for quien in (ANA, BRUNO):
        identidad["uid"] = quien
        respuesta = await http.post(f"{CATALOGO}/events/{LIBRE}/reserve")
    assert respuesta.json()["registrations_count"] == await _confirmadas(sesiones, LIBRE) == 2

    ficha = (await http.get(f"{CATALOGO}/events/{LIBRE}")).json()
    assert ficha["registrations_count"] == 2


@pytest.mark.asyncio
async def test_la_respuesta_de_reservar_trae_el_organizador(entorno):
    """La pantalla vuelve a pintar la ficha con lo que devuelve la reserva."""
    http, _, _ = entorno
    ficha = (await http.post(f"{CATALOGO}/events/{LIBRE}/reserve")).json()
    assert ficha["organizer_name"] == "Org"
    assert ficha["time_state"] == "upcoming"
