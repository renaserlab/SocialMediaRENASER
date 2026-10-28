"""Un cliente HTTP por proceso, y el modo de siempre cuando no lo hay.

QUE SE FIJA (ver `shared/cliente_http.py`). Firmar en Storage, subir, borrar,
mandar un push y servir la playlist HLS abrían un `httpx.AsyncClient` en cada
llamada: contexto TLS nuevo con el bucle parado y conexión nueva. Ahora el
arranque de la aplicación abre uno y esos caminos lo reutilizan.

Lo que se comprueba:

  * con compartido abierto, las llamadas pasan por él, NO se construye ningún
    cliente nuevo y no se cierra al terminar la operación;
  * cada llamada conserva SU plazo (15 s Storage, 10 s Expo), aunque el
    cliente sea de todos;
  * sin compartido —pruebas, guiones—, se construye uno propio con
    `httpx.AsyncClient`, como antes, y por eso las pruebas que lo sustituyen
    con `monkeypatch` siguen viendo el suyo;
  * desde otro bucle de eventos, o ya cerrado, tampoco se usa;
  * y el arranque de la aplicación lo abre y el apagado lo cierra.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

from app.modules.notifications import push
from app.shared import cliente_http, storage


@pytest.fixture(autouse=True)
def _sin_compartido_heredado(monkeypatch):
    """Cada prueba empieza y acaba sin cliente del proceso."""
    monkeypatch.setattr(cliente_http, "_compartido", None)
    monkeypatch.setattr(cliente_http, "_bucle", None)


@pytest.fixture
def con_credenciales(monkeypatch):
    monkeypatch.setattr(storage, "storage_configured", lambda: True)
    monkeypatch.setattr(
        storage,
        "get_settings",
        lambda: type("S", (), {"supabase_url": "https://x.supabase.co", "supabase_service_role_key": "k"})(),
    )


class _Prohibido:
    """Sustituye a `httpx.AsyncClient`: construir uno es justo lo que no toca."""

    construidos = 0

    def __init__(self, *a, **k) -> None:
        type(self).construidos += 1
        raise AssertionError("se ha construido un cliente HTTP con el compartido abierto")


def _compartido_de_mentira(monkeypatch, responder) -> tuple[httpx.AsyncClient, list[httpx.Request]]:
    """Un cliente REAL de httpx sobre un transporte de mentira, puesto como el
    del proceso y atado al bucle de esta prueba."""
    vistas: list[httpx.Request] = []

    def _transporte(peticion: httpx.Request) -> httpx.Response:
        vistas.append(peticion)
        return responder(peticion)

    cliente = httpx.AsyncClient(transport=httpx.MockTransport(_transporte))
    monkeypatch.setattr(cliente_http, "_compartido", cliente)
    monkeypatch.setattr(cliente_http, "_bucle", asyncio.get_running_loop())
    return cliente, vistas


def _plazo_de_lectura(peticion: httpx.Request) -> float | None:
    return peticion.extensions["timeout"]["read"]


# --------------------------------------------------------------------------- #
# 1. Con el cliente del proceso abierto
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_firmar_usa_el_compartido_con_el_plazo_de_storage(monkeypatch, con_credenciales):
    compartido, vistas = _compartido_de_mentira(
        monkeypatch,
        lambda p: httpx.Response(200, json=[{"path": "a.jpg", "signedURL": "/object/sign/b/a.jpg?t=1"}]),
    )
    monkeypatch.setattr(httpx, "AsyncClient", _Prohibido)

    firmadas = await storage.firmar_objetos("b", ["a.jpg"])
    # Dos veces: la segunda tampoco construye nada ni encuentra el cliente cerrado.
    await storage.firmar_objetos("b", ["a.jpg"])

    assert firmadas == {"a.jpg": "https://x.supabase.co/storage/v1/object/sign/b/a.jpg?t=1"}
    assert len(vistas) == 2
    assert _plazo_de_lectura(vistas[0]) == 15.0
    assert not compartido.is_closed, "la operación no puede cerrar el cliente de todos"
    await compartido.aclose()


@pytest.mark.asyncio
async def test_subir_y_borrar_usan_el_compartido(monkeypatch, con_credenciales):
    compartido, vistas = _compartido_de_mentira(monkeypatch, lambda p: httpx.Response(200, json={}))
    monkeypatch.setattr(httpx, "AsyncClient", _Prohibido)

    await storage.subir_objeto("b", "x/y.jpg", b"123", "image/jpeg")
    assert await storage.borrar_objeto("b", "x/y.jpg") is True

    assert [(p.method, p.url.path) for p in vistas] == [
        ("POST", "/storage/v1/object/b/x/y.jpg"),
        ("DELETE", "/storage/v1/object/b"),
    ]
    assert all(_plazo_de_lectura(p) == 15.0 for p in vistas)
    await compartido.aclose()


@pytest.mark.asyncio
async def test_el_push_usa_el_compartido_con_el_plazo_de_expo(monkeypatch):
    compartido, vistas = _compartido_de_mentira(
        monkeypatch, lambda p: httpx.Response(200, json={"data": [{"status": "ok", "id": "1"}]})
    )
    monkeypatch.setattr(httpx, "AsyncClient", _Prohibido)

    await push._enviar_a(
        ["ExponentPushToken[uno]"], title="Hola", body="Algo", channel="mensajes", data=None
    )

    assert len(vistas) == 1
    assert str(vistas[0].url) == push.EXPO_PUSH_URL
    assert _plazo_de_lectura(vistas[0]) == push.ESPERA_DE_EXPO == 10
    assert _Prohibido.construidos == 0
    await compartido.aclose()


@pytest.mark.asyncio
async def test_un_plazo_explicito_en_la_llamada_se_respeta(monkeypatch):
    compartido, vistas = _compartido_de_mentira(monkeypatch, lambda p: httpx.Response(204))

    async with cliente_http.cliente_http(15.0) as cliente:
        await cliente.get("https://x.test/a")
        await cliente.get("https://x.test/b", timeout=2.0)

    assert [_plazo_de_lectura(p) for p in vistas] == [15.0, 2.0]
    await compartido.aclose()


# --------------------------------------------------------------------------- #
# 2. Sin cliente del proceso: como antes
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_compartido_se_abre_uno_propio_y_se_cierra(monkeypatch):
    abiertos: list[dict] = []
    cerrados: list[bool] = []

    class _Propio:
        def __init__(self, **kwargs) -> None:
            abiertos.append(kwargs)

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc) -> bool:
            cerrados.append(True)
            return False

    monkeypatch.setattr(httpx, "AsyncClient", _Propio)

    async with cliente_http.cliente_http(12.0) as cliente:
        assert isinstance(cliente, _Propio)

    assert abiertos == [{"timeout": 12.0}], "el plazo de la llamada va al cliente propio"
    assert cerrados == [True]


@pytest.mark.asyncio
async def test_desde_otro_bucle_no_se_usa_el_compartido(monkeypatch):
    """Las conexiones de httpx son de un bucle; desde otro, uno propio."""
    otro = asyncio.new_event_loop()
    compartido = httpx.AsyncClient(transport=httpx.MockTransport(lambda p: httpx.Response(204)))
    try:
        monkeypatch.setattr(cliente_http, "_compartido", compartido)
        monkeypatch.setattr(cliente_http, "_bucle", otro)
        assert cliente_http.compartido() is None
    finally:
        otro.close()
        await compartido.aclose()


@pytest.mark.asyncio
async def test_cerrado_no_se_usa():
    await cliente_http.abrir()
    cliente = cliente_http.compartido()
    assert cliente is not None
    await cliente_http.cerrar()
    assert cliente.is_closed
    assert cliente_http.compartido() is None


@pytest.mark.asyncio
async def test_abrir_dos_veces_no_abre_dos():
    await cliente_http.abrir()
    primero = cliente_http.compartido()
    await cliente_http.abrir()
    try:
        assert cliente_http.compartido() is primero
    finally:
        await cliente_http.cerrar()


# --------------------------------------------------------------------------- #
# 3. El arranque lo abre y el apagado lo cierra
# --------------------------------------------------------------------------- #
def test_el_arranque_de_la_aplicacion_lo_abre_y_el_apagado_lo_cierra():
    from app.main import app

    assert cliente_http._compartido is None
    with TestClient(app) as http:
        assert http.get("/health").status_code == 200
        abierto = cliente_http._compartido
        assert abierto is not None and not abierto.is_closed
    assert cliente_http._compartido is None
    assert abierto.is_closed
