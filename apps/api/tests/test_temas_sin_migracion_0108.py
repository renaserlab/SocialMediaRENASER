"""La aplicación tiene que funcionar SIN la migración 0108.

LA MISMA LECCIÓN QUE LA 0033, LA 0044 Y LA 0045. El código se despliega antes
de que alguien aplique la migración a mano, y una ruta que consulte una tabla
que no existe responde 500; Starlette no le añade cabeceras CORS y el
navegador lo enseña como un fallo de red. Mientras la 0108 espere, esto es lo
que tiene que pasar:

- El chat de un grupo funciona exactamente igual: mandar, listar, leer.
- Las lecturas de temas responden vacío: `available: false` en la lista, y
  una página sin nada en la lectura de un tema.
- Las escrituras responden 503 `topics_unavailable`, para quien administra.
- Pertenecer sigue siendo lo primero: quien no está en el grupo recibe el
  403 de siempre, no un 503 que le diría que la ruta existe para ese grupo.
- Las funciones que usan otros módulos devuelven `None`, `[]` o `0` y no
  tocan la base.

CÓMO SE COMPRUEBA. Se crea el esquema entero SIN las tres tablas de la 0108,
dejando la base como está hoy producción.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

# `app.main` primero, por el orden de carga (ver `test_grupos_de_mensajeria.py`).
from app.main import app  # noqa: I001
from app.modules.messaging import esquema, temas
from tests.test_vistas_de_conversacion import (
    ANA,
    API,
    BRUNO,
    DAVID,
    DIRECTO,
    GRUPO,
    _levantar,
    _mensaje,
    _recoger,
)

TABLAS_DE_LA_0108 = (
    "conversation_topic_views",
    "conversation_topic_items",
    "conversation_topics",
)
UN_TEMA = "11111111-2222-3333-4444-555555555555"


@pytest_asyncio.fixture
async def sin_0108(monkeypatch):
    # El aviso de un mensaje saldría en segundo plano contra el motor global
    # de las pruebas, sin tablas: aquí no se prueba el push.
    from app.modules.messaging import router as messaging_router

    monkeypatch.setattr(messaging_router, "encolar_push", lambda *_a, **_k: None)
    engine, sesiones, identidad = await _levantar(sin_tablas=TABLAS_DE_LA_0108)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad
    await _recoger(engine)


@pytest.mark.asyncio
async def test_el_chat_del_grupo_funciona_exactamente_igual(sin_0108):
    http, _, identidad = sin_0108
    enviado = await http.post(f"{API}/{GRUPO}/messages", json={"body": "hola"})
    assert enviado.status_code == 201, enviado.text

    for uid in (ANA, BRUNO):
        identidad["uid"] = uid
        bandeja = await http.get(API)
        assert bandeja.status_code == 200, bandeja.text
        assert GRUPO in [c["id"] for c in bandeja.json()]
        historial = await http.get(f"{API}/{GRUPO}/messages")
        assert [m["body"] for m in historial.json()] == ["hola"]

    info = await http.get(f"{API}/{GRUPO}/info")
    assert info.status_code == 200, info.text


@pytest.mark.asyncio
async def test_las_lecturas_responden_vacio(sin_0108):
    http, sesiones, identidad = sin_0108
    mid = await _mensaje(sesiones, texto="algo", minuto=1)

    for uid in (ANA, BRUNO):
        identidad["uid"] = uid
        lista = await http.get(f"{API}/{GRUPO}/topics", params={"message_id": mid})
        assert lista.status_code == 200, lista.text
        assert lista.json() == {"available": False, "can_manage": False, "topics": []}

        pagina = await http.get(f"{API}/{GRUPO}/topics/{UN_TEMA}/messages")
        assert pagina.status_code == 200, pagina.text
        assert pagina.json() == {"items": [], "has_more": False}

    identidad["uid"] = ANA
    directo = await http.get(f"{API}/{DIRECTO}/topics")
    assert directo.json()["available"] is False


@pytest.mark.asyncio
async def test_las_escrituras_responden_503(sin_0108):
    http, sesiones, _ = sin_0108
    mid = await _mensaje(sesiones, texto="algo", minuto=1)
    base = f"{API}/{GRUPO}/topics"
    intentos = [
        await http.post(base, json={"name": "Anuncios"}),
        await http.patch(f"{base}/{UN_TEMA}", json={"name": "Otro"}),
        await http.delete(f"{base}/{UN_TEMA}"),
        await http.post(f"{base}/{UN_TEMA}/seen"),
        await http.put(f"{base}/{UN_TEMA}/items/{mid}"),
        await http.delete(f"{base}/{UN_TEMA}/items/{mid}"),
    ]
    for respuesta in intentos:
        assert respuesta.status_code == 503, respuesta.text
        assert respuesta.json()["error"]["code"] == "topics_unavailable"


@pytest.mark.asyncio
async def test_pertenecer_sigue_siendo_lo_primero(sin_0108):
    http, _, identidad = sin_0108
    identidad["uid"] = DAVID
    base = f"{API}/{GRUPO}/topics"
    for respuesta in (
        await http.get(base),
        await http.post(base, json={"name": "Anuncios"}),
        await http.get(f"{base}/{UN_TEMA}/messages"),
    ):
        assert respuesta.status_code == 403, respuesta.text


@pytest.mark.asyncio
async def test_las_funciones_de_los_demas_modulos_no_tocan_la_base(sin_0108):
    _, sesiones, _ = sin_0108
    async with sesiones() as db:
        assert await esquema.hay_temas(db) is False
        assert await temas.tema_de_chat(db, GRUPO) is None
        assert await temas.chats_de_temas(db, GRUPO) == []
        # No hace nada, y sobre todo no lanza: quien llama lo hace dentro de
        # su transacción, y un error aquí le tumbaría el alta de un miembro.
        await temas.sincronizar_miembros(db, GRUPO, [DAVID], dentro=True)
        await temas.sincronizar_miembros(db, GRUPO, [BRUNO], dentro=False)
        assert await temas.no_leidos_de_temas(db, GRUPO, BRUNO) == 0
        await db.commit()
