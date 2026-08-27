"""Si el recomendador se cae, la pantalla sigue en pie.

QUE SE ARREGLA AQUI. Los tres endpoints de recomendacion llamaban al servicio
sin red de seguridad. Cualquier fallo dentro —una columna que falta porque una
migracion no se aplico, un candidato con datos raros, un `None` inesperado—
salia como un 500.

Y un 500 no es solo «no hay recomendaciones»: en la web, una respuesta de error
sin manejar de Starlette NO lleva cabeceras CORS, asi que el navegador ni
siquiera la lee como un error del servidor. La lee como «sin conexion». Un
fallo al ORDENAR el muro se veia igual que quedarse sin internet.

Lo que estas pruebas fijan es que el fallo se degrada: 200, lista vacia y
`strategy="fallback"`. Quien llama ya sabe que hacer con una lista vacia —el
movil cae al orden cronologico y al catalogo publico—, asi que se pierde la
personalizacion y se salva la pantalla.

`fallback` se distingue de `disabled` a proposito: apagado es una decision,
caido es un fallo, y con la misma etiqueta las metricas no podrian separarlos.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.modules.recommendations import router as reco_router
from app.shared.database import Base, get_db

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
        yield cliente

    app.dependency_overrides.clear()
    await engine.dispose()


def _reventar(monkeypatch, nombre: str) -> None:
    """Hace que el servicio falle como fallaria de verdad."""

    async def _falla(*args, **kwargs):
        raise RuntimeError("el recomendador se rompio")

    # Se parchea en `service`, que es el modulo que el router importo entero
    # (`from ... import service`), asi que la sustitucion le llega.
    monkeypatch.setattr(reco_router.service, nombre, _falla)


@pytest.mark.asyncio
async def test_el_muro_sobrevive_a_un_recomendador_roto(http, monkeypatch):
    _reventar(monkeypatch, "contenido_para")

    respuesta = await http.get("/api/v1/recommendations/content?limit=10")

    assert respuesta.status_code == 200, (
        "un fallo al ordenar el muro salio como error HTTP; en la web eso se "
        "lee como «sin conexion», no como «sin recomendaciones»"
    )
    cuerpo = respuesta.json()
    assert cuerpo["items"] == []
    assert cuerpo["strategy"] == "fallback", (
        "hay que poder distinguir «se rompio» de «lo apagamos»"
    )


@pytest.mark.asyncio
async def test_explorar_sobrevive_a_personas_para_ti_roto(http, monkeypatch):
    _reventar(monkeypatch, "personas_para")

    respuesta = await http.get("/api/v1/recommendations/people?limit=10")

    assert respuesta.status_code == 200
    cuerpo = respuesta.json()
    assert cuerpo["items"] == []
    assert cuerpo["strategy"] == "fallback"


@pytest.mark.asyncio
async def test_los_cursos_sobreviven_a_su_recomendador_roto(http, monkeypatch):
    _reventar(monkeypatch, "cursos_para")

    respuesta = await http.get("/api/v1/recommendations/courses?limit=10")

    assert respuesta.status_code == 200
    cuerpo = respuesta.json()
    assert cuerpo["items"] == []
    assert cuerpo["strategy"] == "fallback"
