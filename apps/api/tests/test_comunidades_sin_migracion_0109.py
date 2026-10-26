"""La mensajería tiene que funcionar SIN la migración 0109 (y sin la 0108).

ES LA MISMA LECCIÓN DE LA 0033, LA 0045 Y LA 0104. El código se despliega antes
de que la migración esté aplicada —se aplica a mano, con aprobación— y una
consulta a una tabla que no existe es un 500 que el navegador, además, enseña
como un fallo de CORS. Lo que tiene que pasar hoy contra producción:

  · los grupos funcionan EXACTAMENTE igual: la bandeja, con y sin `grouped`, el
    chat, los miembros, salir, la información, los filtros y las solicitudes;
  · la lista de comunidades sale vacía con `available: false`, y la aplicación
    no ofrece nada (`/availability` dice `subgroups: false`);
  · crear, cambiar, eliminar y entrar responden 503 `subgroups_unavailable`,
    nunca un 500.

Y lo mismo sin la 0108 a la vez: la bandeja y el envío preguntan por los temas
en cada petición, y sin sus tablas no pueden romperse.

COMO SE COMPRUEBA. Se crea el esquema entero menos las tablas de esas
migraciones, que es como está hoy producción.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

# `app.main` va primero: ver la nota en `test_grupos_de_mensajeria.py`.
from app.main import app  # noqa: I001
from app.modules.messaging import grupos
from app.modules.messaging import router as messaging_router
from app.modules.messaging.models import ConversationMember
from tests.test_vistas_de_conversacion import (
    ANA,
    API,
    BRUNO,
    CARLA,
    DAVID,
    GRUPO,
    _levantar,
    _mensaje,
    _recoger,
)

SUB = "cccccccc-0000-0000-0000-000000000109"

SIN_LA_0109 = ("group_subgroups",)
SIN_LA_0108 = (
    "conversation_topic_views",
    "conversation_topic_items",
    "conversation_topics",
)


@pytest_asyncio.fixture(params=["sin_0109", "sin_0108_ni_0109"])
async def sin_migracion(request, monkeypatch):
    fuera = SIN_LA_0109 if request.param == "sin_0109" else SIN_LA_0109 + SIN_LA_0108
    engine, sesiones, identidad = await _levantar(sin_tablas=fuera)
    avisos: list[dict] = []
    for modulo in (grupos, messaging_router):
        monkeypatch.setattr(modulo, "encolar_push", lambda _b, **kw: avisos.append(kw))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad, avisos, request.param
    await _recoger(engine)


def codigo(respuesta) -> str:
    return respuesta.json()["error"]["code"]


@pytest.mark.asyncio
async def test_no_se_ofrece_nada(sin_migracion):
    http, _, _, _, caso = sin_migracion
    disponible = (await http.get(f"{API}/availability")).json()
    assert disponible["subgroups"] is False
    assert disponible["topics"] is (caso == "sin_0109")

    lista = await http.get(f"{API}/{GRUPO}/subgroups")
    assert lista.status_code == 200, lista.text
    assert lista.json() == {"available": False, "can_manage": False, "subgroups": []}


@pytest.mark.asyncio
async def test_las_escrituras_responden_503_y_nunca_500(sin_migracion):
    http, _, identidad, _, _ = sin_migracion
    for uid in (ANA, BRUNO):
        identidad["uid"] = uid
        for respuesta in (
            await http.post(f"{API}/{GRUPO}/subgroups", json={"title": "Valorant"}),
            await http.patch(f"{API}/{GRUPO}/subgroups/{SUB}", json={"title": "x"}),
            await http.delete(f"{API}/{GRUPO}/subgroups/{SUB}"),
            await http.post(f"{API}/{GRUPO}/subgroups/{SUB}/join"),
        ):
            assert respuesta.status_code == 503, respuesta.text
            assert codigo(respuesta) == "subgroups_unavailable"

    # Quien no es del grupo, lo de siempre antes que nada: no se le cuenta que
    # el servidor tiene o no tiene comunidades.
    identidad["uid"] = DAVID
    assert (await http.post(f"{API}/{GRUPO}/subgroups", json={"title": "x"})).status_code == 403
    assert (await http.post(f"{API}/{GRUPO}/subgroups/{SUB}/join")).status_code == 404


@pytest.mark.asyncio
async def test_la_bandeja_con_y_sin_grouped_funciona_como_siempre(sin_migracion):
    http, sesiones, identidad, _, _ = sin_migracion
    await _mensaje(sesiones, de=CARLA, texto="hola", en=GRUPO)

    identidad["uid"] = BRUNO
    for params in ({}, {"grouped": "true"}):
        respuesta = await http.get(API, params=params)
        assert respuesta.status_code == 200, respuesta.text
        fila = next(f for f in respuesta.json() if f["id"] == GRUPO)
        assert fila["unread_count"] == fila["total_unread"] == 1
        assert (fila["parent_id"], fila["subgroups_count"], fila["topics_count"]) == (None, 0, 0)


@pytest.mark.asyncio
async def test_el_chat_y_sus_avisos_funcionan_igual(sin_migracion):
    http, _, identidad, avisos, _ = sin_migracion
    identidad["uid"] = BRUNO
    enviado = await http.post(f"{API}/{GRUPO}/messages", json={"body": "hola"})
    assert enviado.status_code == 201, enviado.text
    assert [sorted(a["user_ids"]) for a in avisos] == [sorted([ANA, CARLA])]

    # D4 no depende de ninguna migración: quien administra borra lo de otro.
    identidad["uid"] = ANA
    borrado = await http.delete(f"{API}/{GRUPO}/messages/{enviado.json()['id']}")
    assert borrado.status_code == 204


@pytest.mark.asyncio
async def test_miembros_informacion_filtros_y_solicitudes_funcionan_igual(sin_migracion):
    http, sesiones, identidad, _, _ = sin_migracion

    info = await http.get(f"{API}/{GRUPO}/info")
    assert info.status_code == 200, info.text
    assert (info.json()["parent"], info.json()["topic"]) == (None, None)

    assert (
        await http.post(f"{API}/{GRUPO}/members", json={"user_ids": [DAVID]})
    ).status_code == 200
    assert (await http.delete(f"{API}/{GRUPO}/members/{DAVID}")).status_code == 204
    identidad["uid"] = CARLA
    assert (await http.delete(f"{API}/{GRUPO}/members/{CARLA}")).status_code == 204
    async with sesiones() as db:
        clave = {"conversation_id": GRUPO, "user_id": CARLA}
        assert await db.get(ConversationMember, clave) is None

    identidad["uid"] = ANA
    assert (await http.patch(f"{API}/{GRUPO}/group", json={"title": "Aula 2"})).status_code == 204
    filtro = await http.post(
        f"{API}/{GRUPO}/filters",
        json={"name": "Material", "criteria": {"keywords": ["examen"]}},
    )
    assert filtro.status_code == 201, filtro.text
    ajustes = await http.patch(f"{API}/{GRUPO}/group/settings", json={"listed_on_profile": True})
    assert ajustes.status_code == 200, ajustes.text

    identidad["uid"] = DAVID
    pedida = await http.post(f"{API}/{GRUPO}/join-requests", json={})
    assert pedida.status_code == 201, pedida.text
    identidad["uid"] = ANA
    aceptada = await http.post(f"{API}/{GRUPO}/join-requests/{pedida.json()['id']}/approve")
    assert aceptada.status_code == 204, aceptada.text

    # Crear un grupo cuenta el tope igual que siempre.
    creado = await http.post(f"{API}/groups", json={"title": "Nuevo", "member_ids": [BRUNO]})
    assert creado.status_code == 201, creado.text
    assert creado.json()["parent_id"] is None
