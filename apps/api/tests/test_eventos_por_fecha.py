"""Un evento que ya pasó no se anuncia como próximo.

LO QUE SE VIO. En Explorar, bajo el título «Próximos eventos», aparecían
«Alquimia para crear riqueza · Quito - Ecuador» y «ALQUIMIA · 19 ago. · Lima,
Perú» sin ninguna distinción. El listado devolvía cualquier evento publicado
ordenado por `starts_at` ascendente, así que los vencidos salían LOS PRIMEROS.

LO QUE FIJAN ESTAS PRUEBAS:

1. La regla de clasificación, en Python, para los cinco casos que existen:
   ahora mismo, futuro, pasado, sin fecha, y con `ends_at` mandando sobre
   `starts_at`.
2. Que la MISMA regla escrita en SQL —la que filtra en la base— dice
   exactamente lo mismo que la de Python. Están escritas dos veces porque hacen
   falta las dos; separarse es el único riesgo de tenerlas duplicadas.
3. Que el endpoint agrupa de verdad y NO esconde el histórico.
4. Que un evento sin fecha no se clasifica como futuro ni como pasado.

Base SQLite en memoria, como el resto de la suite: nada de esto toca Supabase.
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
from app.modules.catalog import eventos
from app.modules.catalog.models import Event
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db

EVENTOS = "/api/v1/catalog/events"

ORGANIZA = "aaaaaaaa-0000-0000-0000-000000000001"

#: Un instante fijo para no depender del reloj de quien ejecuta las pruebas.
AHORA = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)

FUTURO = "eeee0000-0000-0000-0000-000000000001"
PASADO = "eeee0000-0000-0000-0000-000000000002"
SIN_FECHA = "eeee0000-0000-0000-0000-000000000003"
EN_CURSO = "eeee0000-0000-0000-0000-000000000004"
TERMINADO = "eeee0000-0000-0000-0000-000000000005"


@pytest.fixture(autouse=True)
def _reloj_detenido(monkeypatch: pytest.MonkeyPatch) -> None:
    """«Ahora» es siempre el mismo instante mientras corren estas pruebas.

    Sin esto, los escenarios se escriben en días relativos al reloj de quien
    ejecuta la suite y la prueba del congreso «que empieza ayer y termina
    mañana» dejaría de significar nada al día siguiente. El router pide la hora
    a `eventos.ahora()` justo para poder fijarla aquí.
    """
    monkeypatch.setattr(eventos, "ahora", lambda: AHORA)


@pytest_asyncio.fixture
async def entorno():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        from app.modules.catalog import models as _c  # noqa: F401
        from app.modules.profiles import models as _p  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ORGANIZA, full_name="Quien organiza", username="organiza"))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=ORGANIZA, email="quien@ejemplo.com", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    app.dependency_overrides[get_optional_user] = _usuario_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    await engine.dispose()


async def _sembrar(sesiones) -> None:
    """Los cinco casos que existen, todos publicados."""
    async with sesiones() as db:
        db.add_all(
            [
                Event(
                    id=FUTURO,
                    organizer_id=ORGANIZA,
                    title="Alquimia para crear riqueza",
                    location="Quito - Ecuador",
                    starts_at=AHORA + timedelta(days=20),
                    status="published",
                ),
                Event(
                    id=PASADO,
                    organizer_id=ORGANIZA,
                    title="ALQUIMIA",
                    location="Lima, Perú",
                    starts_at=AHORA - timedelta(days=12),
                    status="published",
                ),
                Event(
                    id=SIN_FECHA,
                    organizer_id=ORGANIZA,
                    title="Encuentro por confirmar",
                    location="Por definir",
                    status="published",
                ),
                Event(
                    id=EN_CURSO,
                    organizer_id=ORGANIZA,
                    # Empezó ayer y termina mañana: está ocurriendo.
                    starts_at=AHORA - timedelta(days=1),
                    ends_at=AHORA + timedelta(days=1),
                    title="Congreso de tres días",
                    location="Lima, Perú",
                    status="published",
                ),
                Event(
                    id=TERMINADO,
                    organizer_id=ORGANIZA,
                    starts_at=AHORA - timedelta(days=5),
                    ends_at=AHORA - timedelta(days=3),
                    title="Congreso que ya acabó",
                    location="Lima, Perú",
                    status="published",
                ),
            ]
        )
        await db.commit()


# --------------------------------------------------------------------------- #
# 1. La regla, en Python
# --------------------------------------------------------------------------- #
def test_un_evento_futuro_es_proximo():
    assert (
        eventos.estado_temporal(AHORA + timedelta(hours=1), None, AHORA)
        == eventos.PROXIMO
    )


def test_un_evento_pasado_es_anterior():
    assert (
        eventos.estado_temporal(AHORA - timedelta(hours=1), None, AHORA)
        == eventos.ANTERIOR
    )


def test_un_evento_sin_fecha_no_se_clasifica_como_futuro_ni_como_pasado():
    """Los dos campos son anulables: hay eventos anunciados «por confirmar».

    Colocarlo con los próximos le inventaría un futuro y colocarlo con los
    anteriores, un pasado. Se dice lo que se sabe, que es nada.
    """
    estado = eventos.estado_temporal(None, None, AHORA)
    assert estado == eventos.SIN_FECHA
    assert estado not in (eventos.PROXIMO, eventos.ANTERIOR)


def test_el_final_manda_sobre_el_comienzo():
    """Un congreso que empezó ayer y termina mañana está ocurriendo.

    Con la regla al revés desaparecería de «próximos» justo el día que más
    importa: mientras se celebra.
    """
    assert (
        eventos.estado_temporal(
            AHORA - timedelta(days=1), AHORA + timedelta(days=1), AHORA
        )
        == eventos.PROXIMO
    )
    assert (
        eventos.estado_temporal(
            AHORA - timedelta(days=5), AHORA - timedelta(days=3), AHORA
        )
        == eventos.ANTERIOR
    )


def test_justo_ahora_todavia_no_ha_pasado():
    """El límite se cuenta hacia el lado del evento.

    Un evento que empieza en este preciso segundo no es un evento perdido.
    """
    assert eventos.estado_temporal(AHORA, None, AHORA) == eventos.PROXIMO
    assert eventos.estado_temporal(None, AHORA, AHORA) == eventos.PROXIMO


def test_una_fecha_sin_zona_se_puede_comparar():
    """SQLite devuelve las fechas sin zona; PostgreSQL, con ella.

    Comparar las dos formas directamente lanza `TypeError`, y ese error saldría
    en un entorno de los dos y no en el otro: exactamente el fallo que no se ve
    en las pruebas y sí en producción.
    """
    ingenua = datetime(2026, 8, 19, 12, 0)
    assert eventos.estado_temporal(ingenua, None, AHORA) == eventos.ANTERIOR
    assert eventos.estado_temporal(ingenua, None, AHORA.replace(tzinfo=None)) == (
        eventos.ANTERIOR
    )


# --------------------------------------------------------------------------- #
# 2. La misma regla, en SQL
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_filtro_de_la_base_dice_lo_mismo_que_el_de_python(entorno):
    """Las dos escrituras de la regla no se pueden separar.

    Filtrar corre en la base (para que la paginación signifique algo) y
    etiquetar corre en Python (para poder decírselo a la pantalla). Si un día
    dijeran cosas distintas, una fila saldría en el grupo de los próximos con la
    etiqueta de los pasados.
    """
    _, sesiones = entorno
    await _sembrar(sesiones)

    async with sesiones() as db:
        todos = list(await db.scalars(select(Event)))
        esperado = {
            estado: sorted(
                e.id for e in todos if eventos.estado_de(e, AHORA) == estado
            )
            for estado in (eventos.PROXIMO, eventos.ANTERIOR, eventos.SIN_FECHA)
        }
        for estado, ids in esperado.items():
            condicion = eventos.condicion(estado, AHORA)
            assert condicion is not None
            en_la_base = sorted(
                await db.scalars(select(Event.id).where(condicion))
            )
            assert en_la_base == ids, f"el filtro SQL de «{estado}» no coincide"

    # Y los tres grupos juntos son todos los eventos, sin repetir ninguno.
    assert sum(len(ids) for ids in esperado.values()) == 5


# --------------------------------------------------------------------------- #
# 3. El endpoint
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_los_proximos_no_traen_ni_uno_vencido(entorno):
    http, sesiones = entorno
    await _sembrar(sesiones)

    respuesta = await http.get(EVENTOS, params={"when": "upcoming"})
    assert respuesta.status_code == 200, respuesta.text
    datos = respuesta.json()
    ids = [e["id"] for e in datos]

    assert FUTURO in ids
    assert EN_CURSO in ids
    assert PASADO not in ids
    assert TERMINADO not in ids
    # Y tampoco los de fecha por confirmar: no se les inventa un futuro.
    assert SIN_FECHA not in ids
    assert all(e["time_state"] == "upcoming" for e in datos)


@pytest.mark.asyncio
async def test_los_anteriores_siguen_siendo_consultables(entorno):
    """No se esconde el histórico: se saca de donde estorbaba."""
    http, sesiones = entorno
    await _sembrar(sesiones)

    datos = (await http.get(EVENTOS, params={"when": "past"})).json()
    ids = [e["id"] for e in datos]
    assert ids == [PASADO, TERMINADO] or ids == [TERMINADO, PASADO]
    assert all(e["time_state"] == "past" for e in datos)
    # Lo más reciente primero: un histórico se lee hacia atrás.
    assert ids[0] == TERMINADO


@pytest.mark.asyncio
async def test_los_de_fecha_por_confirmar_tienen_su_propio_grupo(entorno):
    http, sesiones = entorno
    await _sembrar(sesiones)

    datos = (await http.get(EVENTOS, params={"when": "undated"})).json()
    assert [e["id"] for e in datos] == [SIN_FECHA]
    assert datos[0]["time_state"] == "undated"
    assert datos[0]["starts_at"] is None and datos[0]["ends_at"] is None


@pytest.mark.asyncio
async def test_sin_parametro_se_devuelve_todo_pero_ordenado(entorno):
    """Las versiones instaladas no envían `when` y no pueden perder nada.

    Lo que cambia para ellas es el ORDEN: primero lo vigente, al final lo
    anterior. Antes salía por `starts_at` ascendente y un evento de agosto se
    colocaba delante de uno de octubre bajo el título «Próximos eventos».
    """
    http, sesiones = entorno
    await _sembrar(sesiones)

    datos = (await http.get(EVENTOS, params={"limit": 50})).json()
    ids = [e["id"] for e in datos]
    estados = [e["time_state"] for e in datos]

    assert len(ids) == 5, "no se pierde ningún evento"
    # Vigentes, después los que no tienen fecha, y el histórico al final.
    assert estados == ["upcoming", "upcoming", "undated", "past", "past"]
    # Dentro de lo vigente, lo más cercano primero.
    assert ids[:2] == [EN_CURSO, FUTURO]
    assert ids[-2:] == [TERMINADO, PASADO]


@pytest.mark.asyncio
async def test_un_valor_raro_en_when_se_rechaza(entorno):
    """Y no cae en «todos» por descuido: un filtro que no filtra es peor que un
    error, porque nadie se entera."""
    http, _ = entorno
    respuesta = await http.get(EVENTOS, params={"when": "proximos"})
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_los_borradores_siguen_sin_salir(entorno):
    """El filtro por fecha no puede haber abierto la puerta a lo no publicado."""
    http, sesiones = entorno
    await _sembrar(sesiones)
    async with sesiones() as db:
        db.add(
            Event(
                id="eeee0000-0000-0000-0000-0000000000ff",
                organizer_id=ORGANIZA,
                title="Borrador",
                starts_at=AHORA + timedelta(days=3),
                status="draft",
            )
        )
        await db.commit()

    for cuando in ("all", "upcoming", "past", "undated"):
        datos = (await http.get(EVENTOS, params={"when": cuando, "limit": 50})).json()
        assert "eeee0000-0000-0000-0000-0000000000ff" not in [e["id"] for e in datos]
