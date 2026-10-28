"""El tamaño de cada grupo viaja en la fila de la bandeja (`members_count`).

POR QUÉ (auditoría del 28/10, §10). La bandeja del teléfono enseña «está
escribiendo…» en sus primeras filas, y para eso se suscribe a un canal de
difusión por conversación. Supabase cuenta cada aviso UNA vez por cada teléfono
que lo recibe: en un grupo de trescientos que todos tienen arriba de su bandeja,
cuatro personas tecleando a la vez llegan al tope de 500 mensajes por segundo
del plan, y Supabase desconecta a todo el mundo. La bandeja deja de atender
«escribiendo» en los grupos grandes, y para saber cuáles son necesita su
tamaño SIN pedir la ficha de cada grupo.

Lo que se fija aquí:

  · un grupo dice cuántos son, contando a quien pregunta, y se entera de las
    altas y las bajas;
  · un chat de dos no dice nada (son dos, siempre);
  · cuesta UNA consulta, tenga la página dos grupos o seis.
"""

from __future__ import annotations

import pytest
from sqlalchemy import event

# `app.main` primero, por el mismo rodeo de imports que explica
# `test_grupos_de_mensajeria.py`.
from app.main import app  # noqa: F401, I001
from tests.test_vistas_de_conversacion import (  # noqa: F401 - `entorno` es un fixture
    ANA,
    API,
    BRUNO,
    CARLA,
    DAVID,
    DIRECTO,
    GRUPO,
    _mensaje,
    entorno,
)


async def _bandeja(http, **params) -> dict[str, dict]:
    respuesta = await http.get(API, params={"limit": 50, **params})
    assert respuesta.status_code == 200, respuesta.text
    return {fila["id"]: fila for fila in respuesta.json()}


def _contar_selects(sesiones):
    sentencias: list[str] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        if statement.lstrip().lower().startswith("select"):
            sentencias.append(statement)

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    return sentencias, lambda: event.remove(motor, "before_cursor_execute", _anotar)


@pytest.mark.asyncio
async def test_un_grupo_dice_cuantos_son_y_un_chat_de_dos_no(entorno):
    http, sesiones, _identidad = entorno
    # Un chat de dos sin mensajes no sale en la bandeja: se le escribe algo.
    await _mensaje(sesiones, de=BRUNO, texto="Hola", en=DIRECTO)
    nuevo = (
        await http.post(f"{API}/groups", json={"title": "Aula", "member_ids": [BRUNO, CARLA]})
    ).json()["id"]

    for agrupada in ("false", "true"):
        bandeja = await _bandeja(http, grouped=agrupada)
        # Ana, Bruno y Carla: quien pregunta también cuenta.
        assert bandeja[nuevo]["members_count"] == 3, agrupada
        assert bandeja[DIRECTO]["members_count"] is None, agrupada
        # El grupo sembrado: Ana, Bruno y Carla.
        assert bandeja[GRUPO]["members_count"] == 3, agrupada


@pytest.mark.asyncio
async def test_el_tamano_sigue_a_las_altas_y_las_bajas(entorno):
    http, _sesiones, _identidad = entorno
    nuevo = (
        await http.post(f"{API}/groups", json={"title": "Aula", "member_ids": [BRUNO]})
    ).json()["id"]
    assert (await _bandeja(http))[nuevo]["members_count"] == 2

    respuesta = await http.post(f"{API}/{nuevo}/members", json={"user_ids": [CARLA, DAVID]})
    assert respuesta.status_code in (200, 201), respuesta.text
    assert (await _bandeja(http))[nuevo]["members_count"] == 4

    assert (await http.delete(f"{API}/{nuevo}/members/{DAVID}")).status_code == 204
    assert (await _bandeja(http))[nuevo]["members_count"] == 3


@pytest.mark.asyncio
async def test_saber_el_tamano_cuesta_lo_mismo_con_dos_grupos_que_con_seis(entorno):
    http, sesiones, identidad = entorno
    identidad["uid"] = ANA
    await _bandeja(http, grouped="true")  # en vacío: lo que se cachea no cuenta

    sentencias, quitar = _contar_selects(sesiones)
    try:
        pocas = await _bandeja(http, grouped="true")
    finally:
        quitar()
    con_pocos = len(sentencias)

    nuevos = []
    for i in range(4):
        respuesta = await http.post(
            f"{API}/groups", json={"title": f"Tamaño {i}", "member_ids": [BRUNO, CARLA]}
        )
        assert respuesta.status_code == 201, respuesta.text
        nuevos.append(respuesta.json()["id"])

    sentencias, quitar = _contar_selects(sesiones)
    try:
        muchas = await _bandeja(http, grouped="true")
    finally:
        quitar()
    assert len(muchas) == len(pocas) + 4
    assert [muchas[nuevo]["members_count"] for nuevo in nuevos] == [3, 3, 3, 3]
    assert len(sentencias) == con_pocos, (
        f"{con_pocos} consultas con {len(pocas)} filas y {len(sentencias)} con {len(muchas)}"
    )
