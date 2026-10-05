"""Cuántos avisos sin leer son NUEVOS desde un instante.

LO REPORTADO (04/10/2026). «No llegó ninguna notificación cuando un usuario me
agendó una sesión». Con la aplicación abierta, el aviso flotante se decidía
restando dos cuentas de «sin leer», y la de antes la escribían también otras
pantallas: bastaba con que una refrescara primero para que la cuenta no
«subiera» y el aviso no se anunciara. Una cuenta no dice si lo que hay es nuevo.

`GET /notifications/unread-count?since=…` lo dice: cuántos sin leer son
posteriores a lo último que la aplicación ya vio.

SQLite en memoria.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.notifications import esquema as esquema_de_avisos
from app.modules.notifications.models import Notification
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db

pytestmark = pytest.mark.asyncio

RUTA = "/api/v1/notifications/unread-count"

ANA = "efefefef-0000-0000-0000-000000000001"
LUIS = "efefefef-0000-0000-0000-000000000002"

AHORA = datetime(2026, 10, 4, 21, 41, 0, tzinfo=timezone.utc)


@pytest_asyncio.fixture
async def entorno():
    esquema_de_avisos.olvidar()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.profiles import models as _p  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    fabrica = async_sessionmaker(engine, expire_on_commit=False)
    async with fabrica() as db:
        db.add_all(
            [
                Profile(id=ANA, full_name="Ana Torres", username="ana"),
                Profile(id=LUIS, full_name="Luis Ramos", username="luis"),
            ]
        )
        await db.commit()

    identidad = {"uid": ANA}

    async def _db_override():
        async with fabrica() as session:
            yield session

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="quien@ejemplo.com", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, fabrica, identidad

    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    await engine.dispose()
    esquema_de_avisos.olvidar()


async def _aviso(fabrica, *, para: str, hace_minutos: int, leido: bool = False) -> None:
    async with fabrica() as db:
        db.add(
            Notification(
                user_id=para,
                actor_id=LUIS if para == ANA else ANA,
                type="comment",
                payload={},
                created_at=AHORA - timedelta(minutes=hace_minutos),
                read_at=AHORA if leido else None,
            )
        )
        await db.commit()


async def test_sin_since_responde_lo_de_siempre(entorno):
    """Una aplicación anterior no se entera de nada."""
    http, fabrica, _ = entorno
    await _aviso(fabrica, para=ANA, hace_minutos=30)
    respuesta = await http.get(RUTA)
    assert respuesta.status_code == 200
    assert respuesta.json() == {"count": 1}


async def test_con_since_dice_cuantos_son_posteriores(entorno):
    http, fabrica, _ = entorno
    await _aviso(fabrica, para=ANA, hace_minutos=30)  # ya visto
    await _aviso(fabrica, para=ANA, hace_minutos=20)  # ya visto
    await _aviso(fabrica, para=ANA, hace_minutos=2)   # nuevo

    visto_hasta = (AHORA - timedelta(minutes=10)).isoformat()
    respuesta = await http.get(RUTA, params={"since": visto_hasta})
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json() == {"count": 3, "new_count": 1}


async def test_el_caso_reportado_la_cuenta_no_sube_pero_hay_uno_nuevo(entorno):
    """Tenía 2 sin leer. Lee uno en otra pantalla y le llega otro: siguen 2.

    Restando cuentas, «2 no es más que 2» y el aviso nuevo no se anunciaba.
    """
    http, fabrica, _ = entorno
    await _aviso(fabrica, para=ANA, hace_minutos=30)
    await _aviso(fabrica, para=ANA, hace_minutos=25, leido=True)
    await _aviso(fabrica, para=ANA, hace_minutos=1)

    visto_hasta = (AHORA - timedelta(minutes=10)).isoformat()
    cuerpo = (await http.get(RUTA, params={"since": visto_hasta})).json()
    assert cuerpo["count"] == 2
    assert cuerpo["new_count"] == 1


async def test_lo_ya_leido_y_lo_de_otra_persona_no_cuentan_como_nuevo(entorno):
    http, fabrica, _ = entorno
    await _aviso(fabrica, para=ANA, hace_minutos=1, leido=True)
    await _aviso(fabrica, para=LUIS, hace_minutos=1)

    visto_hasta = (AHORA - timedelta(minutes=10)).isoformat()
    assert (await http.get(RUTA, params={"since": visto_hasta})).json() == {
        "count": 0,
        "new_count": 0,
    }


async def test_el_aviso_que_fijo_la_marca_no_vuelve_a_contar(entorno):
    """La aplicación pregunta desde un milisegundo DESPUÉS de lo último visto."""
    http, fabrica, _ = entorno
    await _aviso(fabrica, para=ANA, hace_minutos=5)
    ultimo_visto = AHORA - timedelta(minutes=5)

    justo_despues = (ultimo_visto + timedelta(milliseconds=1)).isoformat()
    assert (await http.get(RUTA, params={"since": justo_despues})).json()["new_count"] == 0


async def test_un_instante_sin_zona_se_toma_como_utc_y_no_revienta(entorno):
    http, fabrica, _ = entorno
    await _aviso(fabrica, para=ANA, hace_minutos=1)
    sin_zona = (AHORA - timedelta(minutes=10)).replace(tzinfo=None).isoformat()
    respuesta = await http.get(RUTA, params={"since": sin_zona})
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["new_count"] == 1


async def test_un_since_que_no_es_una_fecha_se_rechaza_con_422(entorno):
    http, _, _ = entorno
    respuesta = await http.get(RUTA, params={"since": "ayer"})
    assert respuesta.status_code == 422
