"""Guardar un lote de senales no puede costar una consulta por senal.

EL FALLO QUE FIJA ESTE FICHERO, con numeros.

`POST /recommendations/events` recorria el lote y hacia `await db.execute(
insert(...))` DENTRO del bucle: un viaje a la base por cada senal. El movil
manda hasta 25 por lote (`services/senales.ts`) y el esquema admite 50, asi
que guardar lo que produce un rato de scroll costaba hasta 50 viajes en fila.

Contra SQLite en memoria eso no se nota —son microsegundos— y por eso la suite
pasaba en verde con el problema dentro. Contra Supabase cada consulta es un
viaje de ~70 ms (medido, ver `shared/database.py`), asi que 50 senales eran
~3,5 segundos de puro ir y venir, mientras la persona sigue bajando el feed.

POR QUE SE CUENTAN CONSULTAS Y NO TIEMPO. El tiempo depende de la maquina; el
numero de INSERT es la propiedad que se quiere fijar. Dos son dos con cinco
senales y con cuarenta, y esa es la unica forma de que una regresion —alguien
vuelve a meter el `execute` dentro del bucle— falle aqui y no como «la
aplicacion va lenta» tres semanas despues.

SON DOS Y NO UNO a proposito: las senales con contexto de recomendacion
(migracion 0027) traen tres columnas mas, y un INSERT de varias filas exige
que todas declaren las mismas. Dos como mucho, nunca N.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

API = "/api/v1/recommendations/events"
ANA = "aaaaaaaa-0000-0000-0000-000000000001"


@pytest_asyncio.fixture
async def http():
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
        await db.commit()

    async def _db():
        async with sesiones() as s:
            yield s

    async def _usuario() -> AuthUser:
        return AuthUser(id=ANA, email="a@b.c", role="authenticated")

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _usuario

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as cliente:
        yield cliente, sesiones

    app.dependency_overrides.clear()
    await engine.dispose()


def _inserts(sesiones):
    """Devuelve (lista, quitar) contando solo los INSERT que se ejecutan."""
    vistos: list[str] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        if statement.lstrip().lower().startswith("insert"):
            vistos.append(statement)

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    return vistos, lambda: event.remove(motor, "before_cursor_execute", _anotar)


def _lote(cuantas: int, *, desde: int = 0) -> dict:
    return {
        "events": [
            {
                "event_type": "content_impression",
                "entity_type": "post",
                "entity_id": f"cccccccc-0000-0000-0000-{desde + i:012d}",
                "event_key": f"k{desde + i}",
            }
            for i in range(cuantas)
        ]
    }


@pytest.mark.asyncio
async def test_el_coste_de_guardar_no_crece_con_el_tamano_del_lote(http):
    cliente, sesiones = http

    inserts, quitar = _inserts(sesiones)
    try:
        pocas = await cliente.post(API, json=_lote(5))
    finally:
        quitar()
    assert pocas.status_code == 200, pocas.text
    assert pocas.json()["accepted"] == 5
    con_5 = len(inserts)

    inserts, quitar = _inserts(sesiones)
    try:
        muchas = await cliente.post(API, json=_lote(40, desde=100))
    finally:
        quitar()
    assert muchas.status_code == 200, muchas.text
    assert muchas.json()["accepted"] == 40
    con_40 = len(inserts)

    assert con_5 == con_40, (
        f"guardar 5 senales cuesta {con_5} INSERT y guardar 40 cuesta {con_40}: "
        "el coste crece con el lote, hay un execute dentro del bucle"
    )
    assert con_40 <= 2, (
        f"{con_40} INSERT para un lote; se admiten 2 como mucho "
        "(uno con contexto de recomendacion y otro sin el)"
    )


@pytest.mark.asyncio
async def test_las_senales_repetidas_se_siguen_descartando(http):
    """Agrupar no puede romper la idempotencia: eso contaria dos veces."""
    cliente, _ = http

    primera = await cliente.post(API, json=_lote(3))
    assert primera.status_code == 200
    assert primera.json() == {"accepted": 3, "duplicated": 0}

    repetida = await cliente.post(API, json=_lote(3))
    assert repetida.status_code == 200
    assert repetida.json()["accepted"] == 0, "una senal repetida se guardo dos veces"
    assert repetida.json()["duplicated"] == 3


@pytest.mark.asyncio
async def test_una_clave_repetida_dentro_del_mismo_lote_solo_cuenta_una_vez(http):
    cliente, _ = http

    lote = _lote(2)
    lote["events"].append(dict(lote["events"][0]))  # la misma clave otra vez

    respuesta = await cliente.post(API, json=lote)
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json() == {"accepted": 2, "duplicated": 1}
