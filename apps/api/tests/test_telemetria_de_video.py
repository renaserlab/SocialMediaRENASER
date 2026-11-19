"""Telemetria de velocidad de los videos de Inicio (`telemetria/router.py`).

Lo que se fija aqui:

  · que el lote del movil entra SIN sesion, responde 202 y se guarda una fila
    por hito y una por tramo, sin ningun dato de persona;
  · que la validacion es estricta: rangos de ms, tope de tramos, campos
    desconocidos, textos raros y cuerpos grandes se rechazan enteros;
  · que hay limite de ritmo por IP;
  · que un fallo al guardar no llega al telefono;
  · que el informe es solo para administracion y calcula bien los percentiles.
"""

from __future__ import annotations

import copy
import json

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.profiles.models import Profile
from app.modules.telemetria import router as telemetria
from app.modules.telemetria.models import MetricaDeVideo
from app.modules.telemetria.schemas import CUERPO_MAXIMO_BYTES, TOPE_DE_TRAMOS
from app.shared.database import Base, get_db

RUTA = "/api/v1/telemetria/video"
INFORME = "/api/v1/admin/telemetria/video"
ADMIN = "aaaaaaaa-0000-0000-0000-0000000000ad"
NORMAL = "aaaaaaaa-0000-0000-0000-000000000001"

LOTE = {
    "sesion": "0123456789abcdef",
    "contexto": {
        "plataforma": "ios",
        "version_app": "1.2.4",
        "build": "embebido",
        "modelo": "iPhone 13 Pro",
        "sistema": "iOS 18.1",
        "red": None,
    },
    "hitos": {
        "feed_pedido": 400,
        "feed_respuesta": 1000,
        "urls_firmadas": 1200,
        "primer_fotograma": 2100,
        "primera_reproduccion": 2200,
    },
    "tramos": [
        {
            "tipo": "primer_video",
            "hasta_reproducir_ms": 1000,
            "hasta_fotograma_ms": 900,
            "esperas": 0,
            "espera_ms": 0,
            "formato": "mp4",
            "bytes": 2500000,
            "error": False,
        },
        {
            "tipo": "deslizamiento",
            "hasta_reproducir_ms": 900,
            "hasta_fotograma_ms": None,
            "esperas": 2,
            "espera_ms": 500,
            "formato": "hls",
            "bytes": None,
            "error": False,
        },
    ],
}


def lote(**cambios) -> dict:
    nuevo = copy.deepcopy(LOTE)
    nuevo.update(cambios)
    return nuevo


@pytest_asyncio.fixture
async def entorno(monkeypatch):
    telemetria.vaciar()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(
            Base.metadata.create_all,
            tables=[Profile.__table__, MetricaDeVideo.__table__],
        )
    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ADMIN, full_name="Admin", username="admin", role="admin"))
        db.add(Profile(id=NORMAL, full_name="Ana", username="ana"))
        await db.commit()

    async def _db():
        async with sesiones() as s:
            yield s

    identidad = {"uid": ADMIN}

    async def _usuario() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="a@b.c", role="authenticated")

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _usuario
    monkeypatch.setattr(telemetria, "fabrica_de_sesiones", sesiones)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as cliente:
        yield cliente, sesiones, identidad

    app.dependency_overrides.clear()
    telemetria.vaciar()
    await engine.dispose()


async def _filas(sesiones) -> list[MetricaDeVideo]:
    async with sesiones() as db:
        return list((await db.scalars(select(MetricaDeVideo).order_by(MetricaDeVideo.id))).all())


@pytest.mark.asyncio
async def test_acepta_sin_sesion_y_guarda_una_fila_por_medicion(entorno):
    http, sesiones, _ = entorno
    app.dependency_overrides.pop(get_current_user)  # sin cuenta, como en Inicio

    respuesta = await http.post(RUTA, json=LOTE)

    assert respuesta.status_code == 202, respuesta.text
    assert respuesta.json() == {"aceptado": True, "filas": 7}
    filas = await _filas(sesiones)
    assert [(f.tramo, f.ms) for f in filas] == [
        ("feed_pedido", 400),
        ("feed_respuesta", 1000),
        ("urls_firmadas", 1200),
        ("primer_fotograma", 2100),
        ("primera_reproduccion", 2200),
        ("primer_video", 1000),
        ("deslizamiento", 900),
    ]
    deslizar = filas[-1]
    assert (deslizar.esperas, deslizar.espera_ms, deslizar.formato) == (2, 500, "hls")
    assert all(f.plataforma == "ios" and f.modelo == "iPhone 13 Pro" for f in filas)
    assert all(f.sesion == "0123456789abcdef" for f in filas)


@pytest.mark.asyncio
async def test_un_lote_vacio_se_acepta_sin_escribir(entorno):
    http, sesiones, _ = entorno
    respuesta = await http.post(RUTA, json=lote(hitos={}, tramos=[]))
    assert respuesta.status_code == 202
    assert respuesta.json() == {"aceptado": False, "filas": 0}
    assert await _filas(sesiones) == []


@pytest.mark.parametrize(
    "malo",
    [
        lote(hitos={"feed_pedido": 120_001}),
        lote(hitos={"feed_pedido": -1}),
        lote(hitos={"inventado": 3}),
        lote(sesion="no-es-hex-de-16"),
        lote(sesion="0123456789ABCDEF"),
        lote(contexto={**LOTE["contexto"], "plataforma": "windows"}),
        lote(contexto={**LOTE["contexto"], "modelo": "x" * 65}),
        lote(contexto={**LOTE["contexto"], "modelo": "<script>alert(1)</script>"}),
        lote(contexto={**LOTE["contexto"], "usuario": "ana@correo.pe"}),
        lote(tramos=[{**LOTE["tramos"][0], "hasta_reproducir_ms": 999_999}]),
        lote(tramos=[{**LOTE["tramos"][0], "esperas": 5000}]),
        lote(tramos=[{**LOTE["tramos"][0], "formato": "webm"}]),
        lote(tramos=[{**LOTE["tramos"][0], "post_id": "abc"}]),
        lote(tramos=[LOTE["tramos"][0]] * (TOPE_DE_TRAMOS + 1)),
        lote(extra=1),
    ],
)
@pytest.mark.asyncio
async def test_la_validacion_rechaza_el_lote_entero(entorno, malo):
    http, sesiones, _ = entorno
    respuesta = await http.post(RUTA, json=malo)
    assert respuesta.status_code == 422, respuesta.text
    assert respuesta.json()["error"]["code"] == "validation_error"
    assert await _filas(sesiones) == []


@pytest.mark.asyncio
async def test_el_tope_exacto_de_tramos_si_entra(entorno):
    http, sesiones, _ = entorno
    respuesta = await http.post(RUTA, json=lote(hitos={}, tramos=[LOTE["tramos"][1]] * TOPE_DE_TRAMOS))
    assert respuesta.status_code == 202
    assert len(await _filas(sesiones)) == TOPE_DE_TRAMOS


@pytest.mark.asyncio
async def test_json_roto_es_422_y_no_un_500(entorno):
    http, _, _ = entorno
    respuesta = await http.post(RUTA, content=b"{no es json", headers={"content-type": "application/json"})
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_un_cuerpo_grande_se_corta_sin_leerlo(entorno):
    http, sesiones, _ = entorno
    relleno = json.dumps(lote(contexto={**LOTE["contexto"], "red": "a" * (CUERPO_MAXIMO_BYTES + 10)}))
    respuesta = await http.post(RUTA, content=relleno.encode(), headers={"content-type": "application/json"})
    assert respuesta.status_code == 413
    assert respuesta.json()["error"]["code"] == "telemetry_too_large"
    assert await _filas(sesiones) == []


@pytest.mark.asyncio
async def test_limite_de_ritmo_por_ip(entorno, monkeypatch):
    http, _, _ = entorno
    # Sin IP conocida va al tope global; con IP, al de cada IP. Se prueba el de
    # IP, que es el que corta un bucle desde un telefono.
    monkeypatch.setattr(telemetria, "_ip_del_cliente", lambda *_: "200.48.1.7")
    for _ in range(telemetria.LOTES_POR_IP):
        assert (await http.post(RUTA, json=LOTE)).status_code == 202
    respuesta = await http.post(RUTA, json=LOTE)
    assert respuesta.status_code == 429
    assert respuesta.json()["error"]["code"] == "telemetry_rate_limited"

    # Otra IP no hereda el castigo.
    monkeypatch.setattr(telemetria, "_ip_del_cliente", lambda *_: "200.48.1.8")
    assert (await http.post(RUTA, json=LOTE)).status_code == 202


@pytest.mark.asyncio
async def test_si_guardar_falla_el_telefono_igual_recibe_202(entorno, monkeypatch):
    http, _, _ = entorno

    def _rota():
        raise RuntimeError("relation metricas_de_video does not exist")

    monkeypatch.setattr(telemetria, "fabrica_de_sesiones", _rota)
    respuesta = await http.post(RUTA, json=LOTE)
    assert respuesta.status_code == 202


@pytest.mark.asyncio
async def test_el_informe_es_solo_para_administracion(entorno):
    http, _, identidad = entorno
    identidad["uid"] = NORMAL
    assert (await http.get(INFORME)).status_code == 403
    app.dependency_overrides.pop(get_current_user)
    assert (await http.get(INFORME)).status_code == 401


@pytest.mark.asyncio
async def test_el_informe_da_mediana_y_percentiles_por_plataforma_y_tramo(entorno):
    http, _, _ = entorno
    for i, ms in enumerate([100, 200, 300, 400, 1000]):
        tramo = {**LOTE["tramos"][1], "hasta_reproducir_ms": ms, "esperas": 1 if i == 0 else 0}
        sesion = f"{i:016x}"
        assert (await http.post(RUTA, json=lote(sesion=sesion, hitos={"feed_pedido": 50}, tramos=[tramo]))).status_code == 202
    sin_llegar = {**LOTE["tramos"][1], "hasta_reproducir_ms": None, "esperas": 0}
    android = lote(contexto={**LOTE["contexto"], "plataforma": "android"}, hitos={}, tramos=[sin_llegar])
    assert (await http.post(RUTA, json=android)).status_code == 202

    informe = (await http.get(INFORME, params={"dias": 7})).json()
    assert informe["filas_leidas"] == 11
    assert informe["recortado"] is False
    por_clave = {(r["plataforma"], r["tramo"]): r for r in informe["resumen"]}
    ios = por_clave[("ios", "deslizamiento")]
    assert (ios["n"], ios["mediana_ms"], ios["p75_ms"], ios["p90_ms"]) == (5, 300, 400, 760)
    assert ios["con_esperas"] == 0.2
    assert ios["mediana_espera_ms"] == 500
    assert por_clave[("ios", "feed_pedido")]["mediana_ms"] == 50
    andr = por_clave[("android", "deslizamiento")]
    assert (andr["n"], andr["sin_reproducir"], andr["mediana_ms"]) == (1, 1, None)


@pytest.mark.asyncio
async def test_el_informe_valida_los_dias(entorno):
    http, _, _ = entorno
    assert (await http.get(INFORME, params={"dias": 0})).status_code == 422
    assert (await http.get(INFORME, params={"dias": 91})).status_code == 422
