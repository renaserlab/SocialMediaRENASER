"""Disponibilidad para las sesiones 1:1 (prototipo, 09/10/2026).

Lo esencial: cada cual guarda SU semana, los huecos salen bien calculados en
la zona horaria de la persona, y sin la migración 0100 no se rompe nada.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.bookings import disponibilidad
from app.modules.bookings.models import AvailabilitySlot, Booking
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.social_graph.models import UserBlock
from app.shared.database import Base, get_db

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
NADIE = "aaaaaaaa-0000-0000-0000-00000000dead"
RUTA = "/api/v1/availability"


async def _levantar(sin_la_0100: bool = False):
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

        tablas = [
            t for t in Base.metadata.sorted_tables
            if not (sin_la_0100 and t.name == "availability_slots")
        ]
        await conn.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tablas))

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

    async def _usuario() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario
    app.dependency_overrides[get_optional_user] = _usuario
    return engine, sesiones, identidad


async def _recoger(engine) -> None:
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    esquema.olvidar()
    await engine.dispose()


@pytest_asyncio.fixture
async def entorno():
    engine, sesiones, identidad = await _levantar()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad
    await _recoger(engine)


@pytest_asyncio.fixture
async def sin_migracion():
    engine, sesiones, identidad = await _levantar(sin_la_0100=True)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad
    await _recoger(engine)


SEMANA = {
    "timezone": "America/Lima",
    "slots": [
        {"weekday": 1, "start": "09:00", "end": "12:00"},
        {"weekday": 3, "start": "15:00", "end": "17:00"},
    ],
}


@pytest.mark.asyncio
async def test_sin_la_0100_se_dice_que_no_esta_y_nada_falla(sin_migracion):
    http, _sesiones, _identidad = sin_migracion
    assert (await http.get(f"{RUTA}/me")).json() == {
        "available": False, "timezone": "America/Lima", "slots": [],
    }
    assert (await http.put(f"{RUTA}/me", json=SEMANA)).json()["available"] is False
    huecos = (await http.get(f"{RUTA}/{BRUNO}/openings")).json()
    assert (huecos["available"], huecos["openings"]) == (False, [])


@pytest.mark.asyncio
async def test_cada_cual_guarda_su_semana_y_guardar_la_sustituye(entorno):
    http, sesiones, identidad = entorno
    assert (await http.get(f"{RUTA}/me")).json() == {
        "available": True, "timezone": "America/Lima", "slots": [],
    }
    guardada = await http.put(f"{RUTA}/me", json=SEMANA)
    assert guardada.status_code == 200, guardada.text
    assert guardada.json()["slots"] == SEMANA["slots"]

    # Bruno no ve la de Ana como suya, ni puede escribirla: solo hay «me».
    identidad["uid"] = BRUNO
    assert (await http.get(f"{RUTA}/me")).json()["slots"] == []
    identidad["uid"] = ANA

    otra = {"timezone": "America/Bogota", "slots": [{"weekday": 0, "start": "08:00", "end": "09:00"}]}
    assert (await http.put(f"{RUTA}/me", json=otra)).json() == {"available": True, **otra}
    async with sesiones() as db:
        filas = list(await db.scalars(select(AvailabilitySlot)))
    assert [(f.user_id, f.weekday, f.starts_minute, f.ends_minute) for f in filas] == [(ANA, 0, 480, 540)]

    # Vaciarla es «no estoy disponible».
    assert (await http.put(f"{RUTA}/me", json={"slots": []})).json()["slots"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "malo",
    [
        {"slots": [{"weekday": 7, "start": "09:00", "end": "10:00"}]},
        {"slots": [{"weekday": 1, "start": "10:00", "end": "09:00"}]},
        {"slots": [{"weekday": 1, "start": "09:00", "end": "09:30"}]},
        {"slots": [{"weekday": 1, "start": "9am", "end": "10:00"}]},
        {"slots": [{"weekday": 1, "start": "25:00", "end": "26:00"}]},
        {"slots": [
            {"weekday": 1, "start": "09:00", "end": "11:00"},
            {"weekday": 1, "start": "10:00", "end": "12:00"},
        ]},
        {"timezone": "Marte/Olimpo", "slots": []},
        {"slots": [{"weekday": 2, "start": f"{h:02d}:00", "end": f"{h + 1:02d}:00"} for h in range(8, 13)]},
    ],
)
async def test_una_semana_sin_sentido_no_se_guarda(entorno, malo):
    http, sesiones, _identidad = entorno
    assert (await http.put(f"{RUTA}/me", json=malo)).status_code == 422
    async with sesiones() as db:
        assert list(await db.scalars(select(AvailabilitySlot))) == []


def _fila(weekday: int, inicio: int, fin: int, zona: str = "America/Lima") -> AvailabilitySlot:
    return AvailabilitySlot(
        user_id=ANA, weekday=weekday, starts_minute=inicio, ends_minute=fin, timezone=zona
    )


def test_los_huecos_salen_en_la_hora_de_la_persona_partidos_de_hora_en_hora():
    # Lunes 12/10/2026, 08:00 en Lima (13:00 UTC). Lima va 5 horas por detrás.
    ahora = datetime(2026, 10, 12, 13, 0, tzinfo=timezone.utc)
    huecos = disponibilidad.huecos_de(
        [_fila(1, 9 * 60, 12 * 60)], ahora=ahora, dias=7, ocupados=[]
    )
    # Martes 13, de 9 a 12 de Lima = 14:00, 15:00 y 16:00 UTC.
    assert [h.starts_at for h in huecos] == [
        datetime(2026, 10, 13, hora, 0, tzinfo=timezone.utc) for hora in (14, 15, 16)
    ]
    assert all(h.ends_at - h.starts_at == timedelta(hours=1) for h in huecos)


def test_no_se_ofrece_lo_que_ya_paso_ni_lo_que_empieza_en_menos_de_una_hora():
    # Martes 13/10 a las 09:30 de Lima: el de las 9 ya pasó y el de las 10
    # empieza en media hora. Queda el de las 11.
    ahora = datetime(2026, 10, 13, 14, 30, tzinfo=timezone.utc)
    huecos = disponibilidad.huecos_de(
        [_fila(1, 9 * 60, 12 * 60)], ahora=ahora, dias=1, ocupados=[]
    )
    assert [h.starts_at.hour for h in huecos] == [16]


def test_un_hueco_que_se_pisa_con_una_sesion_aceptada_no_se_ofrece():
    ahora = datetime(2026, 10, 12, 13, 0, tzinfo=timezone.utc)
    ocupada = datetime(2026, 10, 13, 15, 30, tzinfo=timezone.utc)  # 10:30 de Lima
    huecos = disponibilidad.huecos_de(
        [_fila(1, 9 * 60, 12 * 60)], ahora=ahora, dias=7, ocupados=[ocupada]
    )
    # Se caen el de las 10 y el de las 11 (los dos se pisan con 10:30–11:30).
    assert [h.starts_at.hour for h in huecos] == [14]


def test_una_franja_que_no_da_para_otra_sesion_entera_no_deja_medio_hueco():
    ahora = datetime(2026, 10, 12, 13, 0, tzinfo=timezone.utc)
    huecos = disponibilidad.huecos_de(
        [_fila(1, 9 * 60, 11 * 60 + 30)], ahora=ahora, dias=7, ocupados=[]
    )
    assert len(huecos) == 2


def test_la_lista_tiene_tope_y_sin_franjas_no_hay_huecos():
    ahora = datetime(2026, 10, 12, 13, 0, tzinfo=timezone.utc)
    todas = [_fila(dia, 0, 1440) for dia in range(7)]
    huecos = disponibilidad.huecos_de(todas, ahora=ahora, dias=30, ocupados=[])
    assert len(huecos) == disponibilidad.HUECOS_MAXIMO
    assert disponibilidad.huecos_de([], ahora=ahora, dias=30, ocupados=[]) == []


def _instante(texto: str) -> datetime:
    momento = datetime.fromisoformat(texto.replace("Z", "+00:00"))
    return momento if momento.tzinfo else momento.replace(tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_quien_pide_ve_los_huecos_de_la_otra_persona_sin_los_ocupados(entorno):
    http, sesiones, identidad = entorno
    todos_los_dias = {
        "timezone": "America/Lima",
        "slots": [{"weekday": d, "start": "00:00", "end": "24:00"} for d in range(7)],
    }
    assert (await http.put(f"{RUTA}/me", json=todos_los_dias)).status_code == 200

    identidad["uid"] = BRUNO
    antes = (await http.get(f"{RUTA}/{ANA}/openings?days=3")).json()
    assert antes["available"] is True and antes["session_minutes"] == 60
    assert len(antes["openings"]) > 10
    primero = _instante(antes["openings"][0]["starts_at"])
    assert primero >= datetime.now(timezone.utc) + timedelta(minutes=59)

    # Ana acepta una sesión justo en el tercer hueco: deja de ofrecerse.
    tercero = _instante(antes["openings"][2]["starts_at"])
    async with sesiones() as db:
        db.add(
            Booking(
                requester_id=BRUNO, provider_id=ANA, topic="x",
                scheduled_at=tercero, status="accepted",
            )
        )
        await db.commit()
    despues = (await http.get(f"{RUTA}/{ANA}/openings?days=3")).json()
    comienzos = [h["starts_at"] for h in despues["openings"]]
    assert antes["openings"][2]["starts_at"] not in comienzos
    assert antes["openings"][0]["starts_at"] in comienzos


@pytest.mark.asyncio
async def test_un_bloqueo_no_ensena_la_semana_y_un_perfil_que_no_existe_es_404(entorno):
    http, sesiones, identidad = entorno
    assert (await http.put(f"{RUTA}/me", json=SEMANA)).status_code == 200
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=ANA, blocked_id=BRUNO))
        await db.commit()
    identidad["uid"] = BRUNO
    assert (await http.get(f"{RUTA}/{ANA}/openings")).json()["openings"] == []
    assert (await http.get(f"{RUTA}/{NADIE}/openings")).status_code == 404
    assert (await http.get(f"{RUTA}/no-es-un-id/openings")).status_code == 404


def test_la_0100_crea_solo_su_tabla_cerrada_y_con_las_columnas_del_modelo():
    sql = (
        Path(__file__).resolve().parents[3]
        / "supabase" / "migrations" / "0100_disponibilidad_para_sesiones.sql"
    ).read_text(encoding="utf-8").replace("\r\n", "\n")
    sql = re.sub(r"--[^\n]*", "", sql).lower()
    assert re.findall(r"create table (?:if not exists )?([a-z_.]+)", sql) == [
        "public.availability_slots"
    ]
    assert set(re.findall(r"alter table ([a-z_.]+)", sql)) == {"public.availability_slots"}
    assert "enable row level security" in sql and "create policy" not in sql
    for prohibido in (
        "drop table", "truncate", "delete from", "insert into", "alter publication", "grant ",
    ):
        assert prohibido not in sql, prohibido
    cuerpo = sql[sql.index("create table if not exists public.availability_slots (") :]
    cuerpo = cuerpo[cuerpo.index("(") + 1 : cuerpo.index(");")]
    del_sql = {t.strip().split()[0] for t in re.split(r",\s*\n", cuerpo) if t.strip()}
    assert del_sql == {c.name for c in AvailabilitySlot.__table__.columns}
