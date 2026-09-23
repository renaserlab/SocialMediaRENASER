"""La ficha de UN evento, y buscar en el servidor.

Hasta ahora no existía `GET /catalog/events/{id}`: tocar un evento concreto
—desde Explorar, desde la búsqueda, desde el listado— abría la LISTA entera,
donde ese evento era una fila más.

Y el listado no sabía buscar. Filtrar en el teléfono deja fuera todo lo que no
cupo en la primera página, así que el resultado dependía de cuánto se hubiera
bajado.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.catalog.models import Event, EventRegistration
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db

CATALOGO = "/api/v1/catalog"
ORGANIZADORA = "cccccccc-0000-0000-0000-00000000000a"
ANA = "aaaaaaaa-0000-0000-0000-000000000001"
PROXIMO = "eeeeeeee-0000-0000-0000-000000000001"
PASADO = "eeeeeeee-0000-0000-0000-000000000002"
BORRADOR = "eeeeeeee-0000-0000-0000-000000000003"
SIN_FECHA = "eeeeeeee-0000-0000-0000-000000000004"


@pytest_asyncio.fixture
async def entorno():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sesiones = async_sessionmaker(engine, expire_on_commit=False)

    ahora = datetime.now(timezone.utc)
    async with sesiones() as db:
        db.add(Profile(id=ORGANIZADORA, full_name="Carla Ruiz", username="carla"))
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(
            Event(
                id=PROXIMO,
                organizer_id=ORGANIZADORA,
                title="Encuentro de empresarios",
                description="Una tarde de trabajo en Arequipa.",
                starts_at=ahora + timedelta(days=7),
                location="Teatro Fénix, Arequipa",
                event_type="presential",
                status="published",
                capacity=2,
            )
        )
        db.add(
            Event(
                id=PASADO,
                organizer_id=ORGANIZADORA,
                title="Taller de respiración",
                description="Sesión en línea.",
                starts_at=ahora - timedelta(days=7),
                event_type="online",
                status="published",
            )
        )
        db.add(
            Event(
                id=BORRADOR,
                organizer_id=ORGANIZADORA,
                title="Todavía sin anunciar",
                description="",
                starts_at=ahora + timedelta(days=30),
                event_type="online",
                status="draft",
            )
        )
        db.add(
            Event(
                id=SIN_FECHA,
                organizer_id=ORGANIZADORA,
                title="Ronda de preguntas",
                description="Fecha por confirmar.",
                event_type="live",
                status="published",
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


# --------------------------------------------------------------------------- #
# La ficha
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_la_ficha_trae_lo_que_la_pantalla_necesita(entorno):
    http, _, _ = entorno
    respuesta = await http.get(f"{CATALOGO}/events/{PROXIMO}")
    assert respuesta.status_code == 200, respuesta.text
    ficha = respuesta.json()
    assert ficha["title"] == "Encuentro de empresarios"
    assert ficha["location"] == "Teatro Fénix, Arequipa"
    assert ficha["event_type"] == "presential"
    assert ficha["time_state"] == "upcoming"
    assert ficha["organizer_id"] == ORGANIZADORA
    assert ficha["organizer_name"] == "Carla Ruiz"
    assert ficha["organizer_username"] == "carla"


@pytest.mark.asyncio
async def test_un_borrador_responde_404_y_no_403(entorno):
    """Decir «existe pero no puedes verlo» cuenta que alguien prepara algo."""
    http, _, _ = entorno
    respuesta = await http.get(f"{CATALOGO}/events/{BORRADOR}")
    assert respuesta.status_code == 404
    assert "Todavía sin anunciar" not in respuesta.text


@pytest.mark.asyncio
async def test_la_ficha_se_lee_sin_sesion(entorno):
    """Un evento publicado es público, igual que el catálogo."""
    http, _, _ = entorno
    app.dependency_overrides[get_optional_user] = lambda: None
    try:
        respuesta = await http.get(f"{CATALOGO}/events/{PROXIMO}")
        assert respuesta.status_code == 200, respuesta.text
        # Sin sesión no hay a quién preguntarle si reservó.
        assert respuesta.json()["reserved_by_me"] is False
    finally:
        app.dependency_overrides.pop(get_optional_user, None)


@pytest.mark.asyncio
async def test_la_ficha_dice_si_YO_reserve(entorno):
    http, identidad, _ = entorno
    assert (await http.post(f"{CATALOGO}/events/{PROXIMO}/reserve")).status_code == 200
    assert (await http.get(f"{CATALOGO}/events/{PROXIMO}")).json()["reserved_by_me"] is True

    # Y para otra persona, no.
    identidad["uid"] = ORGANIZADORA
    assert (
        await http.get(f"{CATALOGO}/events/{PROXIMO}")
    ).json()["reserved_by_me"] is False


@pytest.mark.asyncio
async def test_la_ficha_cuenta_los_inscritos_de_verdad(entorno):
    http, _, sesiones = entorno
    assert (await http.get(f"{CATALOGO}/events/{PROXIMO}")).json()["registrations_count"] == 0

    async with sesiones() as db:
        db.add(EventRegistration(event_id=PROXIMO, user_id=ANA))
        await db.commit()
    assert (await http.get(f"{CATALOGO}/events/{PROXIMO}")).json()["registrations_count"] == 1


@pytest.mark.asyncio
async def test_sin_organizador_no_se_inventa_un_nombre(entorno):
    http, _, sesiones = entorno
    async with sesiones() as db:
        perfil = await db.get(Profile, ORGANIZADORA)
        perfil.full_name = ""
        perfil.username = ""
        await db.commit()

    ficha = (await http.get(f"{CATALOGO}/events/{PROXIMO}")).json()
    assert ficha["organizer_name"] == ""
    assert ficha["organizer_username"] == ""


@pytest.mark.asyncio
async def test_un_evento_que_no_existe(entorno):
    http, _, _ = entorno
    assert (
        await http.get(f"{CATALOGO}/events/eeeeeeee-0000-0000-0000-00000000ffff")
    ).status_code == 404
    # Y un identificador que ni siquiera es un uuid.
    assert (await http.get(f"{CATALOGO}/events/no-es-un-uuid")).status_code == 404


# --------------------------------------------------------------------------- #
# Buscar y filtrar EN EL SERVIDOR
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_buscar_por_titulo(entorno):
    http, _, _ = entorno
    encontrados = (await http.get(f"{CATALOGO}/events?q=respiración")).json()
    assert [e["id"] for e in encontrados] == [PASADO]


@pytest.mark.asyncio
async def test_buscar_por_lugar_y_por_descripcion(entorno):
    http, _, _ = entorno
    por_lugar = (await http.get(f"{CATALOGO}/events?q=Arequipa")).json()
    assert [e["id"] for e in por_lugar] == [PROXIMO]
    por_descripcion = (await http.get(f"{CATALOGO}/events?q=confirmar")).json()
    assert [e["id"] for e in por_descripcion] == [SIN_FECHA]


@pytest.mark.asyncio
async def test_la_busqueda_no_distingue_mayusculas(entorno):
    http, _, _ = entorno
    assert (await http.get(f"{CATALOGO}/events?q=EMPRESARIOS")).json()[0]["id"] == PROXIMO


@pytest.mark.asyncio
async def test_una_busqueda_sin_resultados_devuelve_vacio(entorno):
    """Vacío, no la lista entera: un filtro que no filtra es peor que ninguno."""
    http, _, _ = entorno
    assert (await http.get(f"{CATALOGO}/events?q=zzzzzz")).json() == []


@pytest.mark.asyncio
async def test_filtrar_por_modalidad(entorno):
    http, _, _ = entorno
    for modalidad, esperados in (
        ("presential", {PROXIMO}),
        ("online", {PASADO}),
        ("live", {SIN_FECHA}),
    ):
        salida = (await http.get(f"{CATALOGO}/events?event_type={modalidad}")).json()
        assert {e["id"] for e in salida} == esperados, modalidad


@pytest.mark.asyncio
async def test_una_modalidad_inventada_se_rechaza(entorno):
    http, _, _ = entorno
    assert (await http.get(f"{CATALOGO}/events?event_type=teletransporte")).status_code == 422


@pytest.mark.asyncio
async def test_los_filtros_se_combinan_con_el_grupo_temporal(entorno):
    http, _, _ = entorno
    salida = (
        await http.get(f"{CATALOGO}/events?when=upcoming&event_type=presential")
    ).json()
    assert {e["id"] for e in salida} == {PROXIMO}
    vacia = (
        await http.get(f"{CATALOGO}/events?when=past&event_type=presential")
    ).json()
    assert vacia == []


@pytest.mark.asyncio
async def test_un_borrador_no_sale_ni_buscandolo(entorno):
    http, _, _ = entorno
    assert (await http.get(f"{CATALOGO}/events?q=anunciar")).json() == []


@pytest.mark.asyncio
async def test_el_listado_trae_el_organizador_sin_una_consulta_por_fila(entorno):
    """Los nombres en UNA consulta: uno por evento sería N+1 en cada página."""
    from sqlalchemy import event as sa_event

    http, _, sesiones = entorno
    consultas: list[str] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        consultas.append(statement)

    motor = sesiones.kw["bind"].sync_engine
    sa_event.listen(motor, "before_cursor_execute", _anotar)
    try:
        salida = (await http.get(f"{CATALOGO}/events")).json()
    finally:
        sa_event.remove(motor, "before_cursor_execute", _anotar)

    assert len(salida) == 3
    assert all(e["organizer_name"] == "Carla Ruiz" for e in salida)
    perfiles = [
        c for c in consultas if "from profiles" in c.lower() and "select" in c.lower()
    ]
    assert len(perfiles) == 1, f"{len(perfiles)} consultas de perfiles: {perfiles}"
