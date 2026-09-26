"""«Juan está transmitiendo en vivo»: el aviso a quien sigue a alguien que emite.

Lo pedido el 25/09/2026, como en TikTok: si sigues a alguien y empieza un
directo, te llega el push, el aviso queda en tu bandeja y, al abrir la
aplicacion, te sale arriba. Aqui se fija la parte del servidor:

  * QUIEN recibe el aviso: sus seguidores, sin bloqueos en ningun sentido.
  * CUANDO: al pasar a emitir, no al anunciar una emision para mas tarde.
  * CUANTAS VECES: una cada media hora por persona; cortar y volver a empezar
    no hace sonar otra vez todos los telefonos.
  * QUE NUNCA ROMPE: un fallo al avisar no puede impedir el directo.
  * Y lo que pregunta la aplicacion al abrirse: que emisiones de gente a la que
    sigo estan vivas AHORA.

SQLite en memoria, mismo patron que `test_directos.py`. El push no sale: se
retiene lo que se habria programado (ver la fixture `pushes`).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.live import avisos, limites
from app.modules.live import router as live_router
from app.modules.live.models import LiveSession
from app.modules.notifications.models import Notification
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.social_graph.models import Follow, UserBlock
from app.shared.database import Base, get_db

#: Todas las pruebas de aqui son asincronas (`pytest-asyncio`, modo estricto).
pytestmark = pytest.mark.asyncio

API = "/api/v1/live"

ANA = "bbbbbbbb-0000-0000-0000-000000000001"    # emite
BRUNO = "bbbbbbbb-0000-0000-0000-000000000002"  # sigue a Ana
CARLA = "bbbbbbbb-0000-0000-0000-000000000003"  # sigue a Ana
DIEGO = "bbbbbbbb-0000-0000-0000-000000000004"  # no sigue a nadie


@pytest_asyncio.fixture
async def entorno():
    limites.vaciar()
    esquema.olvidar()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        from app.modules.bookings import models as _b  # noqa: F401
        from app.modules.catalog import models as _c  # noqa: F401
        from app.modules.communities import models as _co  # noqa: F401
        from app.modules.content import models as _ct  # noqa: F401
        from app.modules.learning import models as _l  # noqa: F401
        from app.modules.live import models as _li  # noqa: F401
        from app.modules.messaging import models as _m  # noqa: F401
        from app.modules.moderation import models as _mo  # noqa: F401
        from app.modules.notifications import device_tokens as _dt  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana Pérez", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(Profile(id=CARLA, full_name="Carla", username="carla"))
        db.add(Profile(id=DIEGO, full_name="Diego", username="diego"))
        db.add(Follow(follower_id=BRUNO, following_id=ANA))
        db.add(Follow(follower_id=CARLA, following_id=ANA))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    app.dependency_overrides[get_optional_user] = _usuario_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    limites.vaciar()
    esquema.olvidar()
    await engine.dispose()


@pytest.fixture
def pushes(monkeypatch):
    """Retiene los push en vez de mandarlos.

    Se parchea en el router de directos porque lo importo por nombre: cambiar
    el original no tendria efecto (la misma leccion que en
    `test_reacciones_y_comentarios.py`).
    """
    capturados: list[dict] = []

    def _retener(background, **kwargs):
        capturados.append(kwargs)

    monkeypatch.setattr(live_router, "encolar_push", _retener)
    return capturados


# --------------------------------------------------------------------------- #
# Ayudas
# --------------------------------------------------------------------------- #


async def emitir(http, *, titulo: str = "Charla en vivo") -> dict:
    respuesta = await http.post(f"{API}/sessions", json={"title": titulo})
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()


async def programar(http, *, titulo: str = "El jueves") -> dict:
    cuando = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
    respuesta = await http.post(
        f"{API}/sessions", json={"title": titulo, "scheduled_for": cuando}
    )
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()


async def avisos_de(sesiones, usuario: str) -> list[Notification]:
    async with sesiones() as db:
        return list(
            await db.scalars(
                select(Notification).where(
                    Notification.user_id == usuario, Notification.type == avisos.TIPO
                )
            )
        )


# --------------------------------------------------------------------------- #
# Quien recibe el aviso
# --------------------------------------------------------------------------- #


async def test_nacer_en_directo_avisa_a_sus_seguidores_y_a_nadie_mas(entorno, pushes):
    http, sesiones, _ = entorno
    emision = await emitir(http)

    for seguidor in (BRUNO, CARLA):
        filas = await avisos_de(sesiones, seguidor)
        assert len(filas) == 1, f"{seguidor} no recibio el aviso"
        aviso = filas[0]
        assert aviso.actor_id == ANA
        assert aviso.entity_type == "live"
        assert aviso.entity_id == emision["id"]
        assert aviso.payload == {"title": "Charla en vivo"}
        assert aviso.read_at is None

    # Quien no la sigue no se entera, y quien emite no se avisa a si misma.
    assert await avisos_de(sesiones, DIEGO) == []
    assert await avisos_de(sesiones, ANA) == []

    # Un solo push, a los dos, con el nombre y la emision para abrirla.
    assert len(pushes) == 1
    push = pushes[0]
    assert sorted(push["user_ids"]) == sorted([BRUNO, CARLA])
    assert push["notification_type"] == "live_started"
    assert push["actor_name"] == "Ana Pérez"
    assert push["data"] == {"type": "live_started", "liveId": emision["id"]}


async def test_el_bloqueo_corta_el_aviso_en_los_dos_sentidos(entorno, pushes):
    http, sesiones, _ = entorno
    async with sesiones() as db:
        # Ana bloqueo a Bruno, y Carla bloqueo a Ana. Los dos la siguen.
        db.add(UserBlock(blocker_id=ANA, blocked_id=BRUNO))
        db.add(UserBlock(blocker_id=CARLA, blocked_id=ANA))
        await db.commit()

    await emitir(http)

    assert await avisos_de(sesiones, BRUNO) == []
    assert await avisos_de(sesiones, CARLA) == []
    assert pushes == [], "sin nadie a quien avisar no se programa ningun push"


async def test_sin_seguidores_no_se_escribe_nada(entorno, pushes):
    http, sesiones, identidad = entorno
    identidad["uid"] = DIEGO
    await emitir(http)
    async with sesiones() as db:
        total = list(await db.scalars(select(Notification)))
    assert total == []
    assert pushes == []


# --------------------------------------------------------------------------- #
# Cuando
# --------------------------------------------------------------------------- #


async def test_anunciar_para_mas_tarde_no_avisa_y_empezar_si(entorno, pushes):
    http, sesiones, _ = entorno
    emision = await programar(http)
    assert await avisos_de(sesiones, BRUNO) == []
    assert pushes == []

    respuesta = await http.post(f"{API}/sessions/{emision['id']}/start")
    assert respuesta.status_code == 200, respuesta.text
    assert len(await avisos_de(sesiones, BRUNO)) == 1
    assert len(pushes) == 1

    # Pulsar «empezar» otra vez es idempotente y no vuelve a avisar.
    respuesta = await http.post(f"{API}/sessions/{emision['id']}/start")
    assert respuesta.status_code == 200
    assert len(await avisos_de(sesiones, BRUNO)) == 1
    assert len(pushes) == 1


# --------------------------------------------------------------------------- #
# Cuantas veces
# --------------------------------------------------------------------------- #


async def test_volver_a_emitir_antes_de_media_hora_no_vuelve_a_avisar(entorno, pushes):
    http, sesiones, _ = entorno
    primera = await emitir(http, titulo="Se me corto")
    respuesta = await http.post(f"{API}/sessions/{primera['id']}/end")
    assert respuesta.status_code == 200, respuesta.text

    await emitir(http, titulo="Ahora si")

    assert len(await avisos_de(sesiones, BRUNO)) == 1
    assert len(pushes) == 1


async def test_pasada_media_hora_si_vuelve_a_avisar(entorno, pushes):
    http, sesiones, _ = entorno
    primera = await emitir(http, titulo="Por la mañana")
    await http.post(f"{API}/sessions/{primera['id']}/end")
    # La primera empezo hace 31 minutos.
    async with sesiones() as db:
        await db.execute(
            update(LiveSession)
            .where(LiveSession.id == primera["id"])
            .values(started_at=datetime.now(timezone.utc) - timedelta(minutes=31))
        )
        await db.commit()

    await emitir(http, titulo="Por la tarde")

    assert len(await avisos_de(sesiones, BRUNO)) == 2
    assert len(pushes) == 2


# --------------------------------------------------------------------------- #
# Que nunca rompe
# --------------------------------------------------------------------------- #


async def test_un_fallo_al_avisar_no_impide_el_directo(entorno, pushes, monkeypatch):
    http, sesiones, _ = entorno

    async def _revienta(*_args, **_kwargs):
        raise RuntimeError("la base se fue a tomar un cafe")

    monkeypatch.setattr(avisos, "seguidores_a_avisar", _revienta)
    emision = await emitir(http)

    assert emision["status"] == "live"
    async with sesiones() as db:
        guardada = await db.get(LiveSession, emision["id"])
    assert guardada is not None and guardada.status == "live"
    assert await avisos_de(sesiones, BRUNO) == []
    assert pushes == []


# --------------------------------------------------------------------------- #
# Lo que pregunta la aplicacion al abrirse
# --------------------------------------------------------------------------- #


async def test_al_abrir_la_app_salen_solo_los_directos_de_quien_sigo(entorno, pushes):
    http, sesiones, identidad = entorno
    # Ana emite (Bruno la sigue); Diego emite (Bruno no le sigue); Carla solo
    # anuncia una para mas tarde (Bruno la sigue).
    de_ana = await emitir(http, titulo="De Ana")
    identidad["uid"] = DIEGO
    await emitir(http, titulo="De Diego")
    identidad["uid"] = CARLA
    await programar(http, titulo="De Carla, el jueves")
    async with sesiones() as db:
        db.add(Follow(follower_id=BRUNO, following_id=CARLA))
        await db.commit()

    identidad["uid"] = BRUNO
    respuesta = await http.get(f"{API}/sessions/following")
    assert respuesta.status_code == 200, respuesta.text
    cuerpo = respuesta.json()
    assert [e["id"] for e in cuerpo] == [de_ana["id"]]
    # Lo que necesita el aviso para pintarse sin pedir nada mas.
    assert cuerpo[0]["host_name"] == "Ana Pérez"
    assert cuerpo[0]["title"] == "De Ana"


async def test_al_abrir_la_app_tampoco_sale_quien_me_bloqueo(entorno, pushes):
    http, sesiones, identidad = entorno
    await emitir(http)
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=ANA, blocked_id=BRUNO))
        await db.commit()

    identidad["uid"] = BRUNO
    respuesta = await http.get(f"{API}/sessions/following")
    assert respuesta.status_code == 200
    assert respuesta.json() == []


async def test_following_no_se_confunde_con_el_id_de_una_emision(entorno, pushes):
    # Si la ruta se declarase despues de `/sessions/{session_id}`, «following»
    # se tomaria por un identificador y la respuesta seria un 404.
    http, _, _ = entorno
    respuesta = await http.get(f"{API}/sessions/following")
    assert respuesta.status_code == 200
    assert respuesta.json() == []


async def test_una_emision_abandonada_no_se_anuncia(entorno, pushes, monkeypatch):
    http, sesiones, identidad = entorno
    emision = await emitir(http)
    # Lleva emitiendo mas del tope (el movil se quedo sin bateria).
    async with sesiones() as db:
        await db.execute(
            update(LiveSession)
            .where(LiveSession.id == emision["id"])
            .values(started_at=datetime.now(timezone.utc) - timedelta(hours=10))
        )
        await db.commit()

    identidad["uid"] = BRUNO
    respuesta = await http.get(f"{API}/sessions/following")
    assert respuesta.status_code == 200
    assert respuesta.json() == []


# --------------------------------------------------------------------------- #
# Y queda en la bandeja
# --------------------------------------------------------------------------- #


async def test_el_aviso_queda_en_la_bandeja_de_notificaciones(entorno, pushes):
    http, _, identidad = entorno
    emision = await emitir(http)

    identidad["uid"] = BRUNO
    respuesta = await http.get("/api/v1/notifications")
    assert respuesta.status_code == 200, respuesta.text
    del_directo = [n for n in respuesta.json() if n["type"] == "live_started"]
    assert len(del_directo) == 1
    aviso = del_directo[0]
    assert aviso["entity_id"] == emision["id"]
    assert aviso["entity_type"] == "live"
    assert aviso["actor"]["full_name"] == "Ana Pérez"
