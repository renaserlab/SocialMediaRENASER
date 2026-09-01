"""Un evento que ya terminó: ni se reserva, ni se presenta como si nada.

DOS AGUJEROS QUE DEJÓ LA SEPARACIÓN POR FECHAS. Al distinguir «próximos» de
«anteriores», la interfaz dejó de ofrecer reservar lo que ya pasó — pero la
interfaz no es la protección:

  1. `POST /catalog/events/{id}/reserve` seguía aceptándolo. Una petición
     directa, o un binario ya instalado que sigue enseñando el botón porque no
     sabe distinguir, apuntaba a alguien a un evento del mes pasado.
  2. La BÚSQUEDA lo encontraba y lo presentaba exactamente igual que uno de la
     semana que viene: mismo icono, mismo subtítulo, misma promesa. El encargo
     pide que se pueda encontrar —esconder lo histórico no ayuda a nadie— pero
     que se diga.

LA REGLA ES LA MISMA EN LOS DOS SITIOS, y eso importa: `catalog.eventos` es la
única que decide. Dos reglas para lo mismo acabarían contestando distinto, que
es como vuelve el problema por otra puerta.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.catalog.models import Event, EventRegistration
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

EVENTOS = "/api/v1/catalog/events"
BUSCAR = "/api/v1/search"

ANA = str(uuid4())

TERMINADO = str(uuid4())
FUTURO = str(uuid4())
#: Empezó ayer y termina mañana. El caso que una regla mal escrita da por
#: terminado justo el día que más importa.
EN_CURSO = str(uuid4())

AHORA = datetime.now(timezone.utc)


@pytest_asyncio.fixture
async def entorno():
    cache.vaciar()
    esquema.olvidar()

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        from app.modules.bookings import models as _b  # noqa: F401
        from app.modules.catalog import models as _c  # noqa: F401
        from app.modules.communities import models as _co  # noqa: F401
        from app.modules.content import models as _ct  # noqa: F401
        from app.modules.learning import models as _l  # noqa: F401
        from app.modules.messaging import models as _m  # noqa: F401
        from app.modules.moderation import models as _mo  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(
            Event(
                id=TERMINADO,
                title="Alquimia Lima",
                description="Ya pasó",
                status="published",
                starts_at=AHORA - timedelta(days=12),
                ends_at=AHORA - timedelta(days=12) + timedelta(hours=3),
                location="Lima",
                organizer_id=ANA,
            )
        )
        db.add(
            Event(
                id=FUTURO,
                title="Alquimia Quito",
                description="Aún no",
                status="published",
                starts_at=AHORA + timedelta(days=10),
                location="Quito",
                organizer_id=ANA,
            )
        )
        db.add(
            Event(
                id=EN_CURSO,
                title="Alquimia Congreso",
                description="Ocurriendo",
                status="published",
                starts_at=AHORA - timedelta(days=1),
                ends_at=AHORA + timedelta(days=1),
                location="Bogotá",
                organizer_id=ANA,
            )
        )
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    usuario = AuthUser(id=ANA, email="ana@ejemplo.com", role="authenticated")
    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = lambda: usuario
    app.dependency_overrides[get_optional_user] = lambda: usuario
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones
    app.dependency_overrides.clear()
    await engine.dispose()


# --------------------------------------------------------------------------- #
# 1. Reservar
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_no_se_puede_reservar_un_evento_que_ya_termino(entorno):
    http, sesiones = entorno

    respuesta = await http.post(f"{EVENTOS}/{TERMINADO}/reserve")

    assert respuesta.status_code == 409, respuesta.text
    # Y no queda ninguna fila: negar y apuntar a la vez sería lo peor de ambas.
    async with sesiones() as db:
        assert (
            await db.get(EventRegistration, {"event_id": TERMINADO, "user_id": ANA})
        ) is None


@pytest.mark.asyncio
async def test_uno_que_esta_ocurriendo_si_se_puede_reservar(entorno):
    """`ends_at` manda sobre `starts_at`.

    Un congreso de tres días que empezó ayer y termina mañana está ocurriendo.
    Con la regla al revés desaparecería justo el día que más importa.
    """
    http, _ = entorno

    respuesta = await http.post(f"{EVENTOS}/{EN_CURSO}/reserve")

    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["reserved_by_me"] is True


@pytest.mark.asyncio
async def test_reservar_uno_futuro_sigue_funcionando_igual(entorno):
    """Que la comprobación no se lleve por delante lo que sí vale."""
    http, _ = entorno

    respuesta = await http.post(f"{EVENTOS}/{FUTURO}/reserve")

    assert respuesta.status_code == 200, respuesta.text


@pytest.mark.asyncio
async def test_quien_ya_tenia_reserva_no_la_pierde_cuando_el_evento_pasa(entorno):
    """La comprobación es al CREAR, no al consultar.

    Su reserva existió. Negarla ahora sería reescribir el pasado, y además
    rompería la respuesta de una pantalla que solo está mirando su historial.
    """
    http, sesiones = entorno
    async with sesiones() as db:
        db.add(EventRegistration(event_id=TERMINADO, user_id=ANA))
        await db.commit()

    respuesta = await http.post(f"{EVENTOS}/{TERMINADO}/reserve")

    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["reserved_by_me"] is True


@pytest.mark.asyncio
async def test_cancelar_una_reserva_de_algo_pasado_sigue_permitido(entorno):
    """Limpiar tu propia agenda no puede depender de que el evento siga vivo."""
    http, sesiones = entorno
    async with sesiones() as db:
        db.add(EventRegistration(event_id=TERMINADO, user_id=ANA))
        await db.commit()

    respuesta = await http.delete(f"{EVENTOS}/{TERMINADO}/reserve")

    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["reserved_by_me"] is False


# --------------------------------------------------------------------------- #
# 2. La búsqueda lo encuentra, y lo dice
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_busqueda_marca_el_evento_terminado(entorno):
    http, _ = entorno

    respuesta = await http.get(f"{BUSCAR}?q=alquimia")

    assert respuesta.status_code == 200, respuesta.text
    por_id = {e["id"]: e for e in respuesta.json()["events"]}
    assert por_id[TERMINADO]["time_state"] == "past"
    assert por_id[FUTURO]["time_state"] == "upcoming"
    assert por_id[EN_CURSO]["time_state"] == "upcoming"


@pytest.mark.asyncio
async def test_la_busqueda_sigue_encontrandolos(entorno):
    """No se esconde lo histórico: se etiqueta.

    Es la otra mitad del encargo, y la que un arreglo perezoso se llevaría por
    delante filtrando los pasados de la búsqueda.
    """
    http, _ = entorno

    respuesta = await http.get(f"{BUSCAR}?q=alquimia")

    assert TERMINADO in {e["id"] for e in respuesta.json()["events"]}


@pytest.mark.asyncio
async def test_la_busqueda_manda_ends_at_para_poder_decir_la_verdad(entorno):
    """Sin `ends_at` no se puede distinguir «terminó» de «está ocurriendo»."""
    http, _ = entorno

    respuesta = await http.get(f"{BUSCAR}?q=alquimia")

    por_id = {e["id"]: e for e in respuesta.json()["events"]}
    assert por_id[EN_CURSO]["ends_at"] is not None
