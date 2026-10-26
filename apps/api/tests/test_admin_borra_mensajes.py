"""D4: quien administra un grupo puede borrar mensajes de otros en él.

Decisión de producto del 26/10/2026 (`docs/CONTRATOS_TEMAS_Y_COMUNIDADES.md`).
Hasta entonces solo borraban su autor y la moderación. Lo que se protege:

  · que quien administra un grupo pueda quitar lo de otros en ese grupo y en
    sus comunidades, sin esperar a la moderación;
  · que el borrado siga siendo suave: la fila y su autor se quedan, y en el chat
    queda la lápida, sin el texto;
  · que NADA MÁS cambie: un miembro normal sigue sin poder borrar lo ajeno,
    quien administra otro grupo tampoco, y en un chat de dos quien lo abrió no
    gana ningún poder sobre lo que escribe el otro (ver
    `test_bloqueo_y_borrado_de_mensajes.py`).
"""

from __future__ import annotations

import pytest

# `app.main` va primero: ver la nota en `test_grupos_de_mensajeria.py`.
from app.main import app  # noqa: F401, I001
from app.modules.messaging.models import Message
from tests.test_vistas_de_conversacion import (  # noqa: F401 - `entorno` es un fixture
    ANA,
    API,
    BRUNO,
    CARLA,
    DIRECTO,
    GRUPO,
    OTRO_GRUPO,
    _mensaje,
    entorno,
)


def codigo(respuesta) -> str:
    return respuesta.json()["error"]["code"]


async def _borrar(http, identidad, quien: str, conv: str, mensaje: str):
    identidad["uid"] = quien
    return await http.delete(f"{API}/{conv}/messages/{mensaje}")


@pytest.mark.asyncio
async def test_quien_administra_el_grupo_borra_lo_de_otro(entorno):
    http, sesiones, identidad = entorno
    mensaje = await _mensaje(sesiones, de=BRUNO, texto="spam", en=GRUPO)

    assert (await _borrar(http, identidad, ANA, GRUPO, mensaje)).status_code == 204

    # Suave: la fila y su autor se quedan, por si hay que responder de ello.
    async with sesiones() as db:
        fila = await db.get(Message, mensaje)
        assert fila.deleted_at is not None
        assert fila.sender_id == BRUNO
        primera = fila.deleted_at

    # Y para los demás, la lápida y no el texto.
    identidad["uid"] = CARLA
    historial = (await http.get(f"{API}/{GRUPO}/messages")).json()
    assert [(m["id"], m["body"]) for m in historial] == [(mensaje, "")]
    assert historial[0]["deleted_at"] is not None

    # Idempotente, y la fecha sigue siendo la del borrado de verdad.
    assert (await _borrar(http, identidad, ANA, GRUPO, mensaje)).status_code == 204
    async with sesiones() as db:
        assert (await db.get(Message, mensaje)).deleted_at == primera


@pytest.mark.asyncio
async def test_un_miembro_normal_sigue_sin_poder_borrar_lo_de_otro(entorno):
    http, sesiones, identidad = entorno
    de_carla = await _mensaje(sesiones, de=CARLA, texto="hola", en=GRUPO)
    de_ana = await _mensaje(sesiones, de=ANA, texto="soy quien administra", en=GRUPO, minuto=1)

    for mensaje in (de_carla, de_ana):
        respuesta = await _borrar(http, identidad, BRUNO, GRUPO, mensaje)
        assert respuesta.status_code == 403, respuesta.text
        assert codigo(respuesta) == "message_not_yours"

    async with sesiones() as db:
        assert (await db.get(Message, de_carla)).deleted_at is None
        assert (await db.get(Message, de_ana)).deleted_at is None


@pytest.mark.asyncio
async def test_administrar_un_grupo_no_da_poder_en_otro(entorno):
    """Bruno administra OTRO_GRUPO y es un miembro más de GRUPO."""
    http, sesiones, identidad = entorno
    en_el_suyo = await _mensaje(sesiones, de=CARLA, texto="hola", en=OTRO_GRUPO)
    en_el_otro = await _mensaje(sesiones, de=CARLA, texto="hola", en=GRUPO)

    assert (await _borrar(http, identidad, BRUNO, OTRO_GRUPO, en_el_suyo)).status_code == 204
    respuesta = await _borrar(http, identidad, BRUNO, GRUPO, en_el_otro)
    assert respuesta.status_code == 403
    assert codigo(respuesta) == "message_not_yours"

    # Ni nombrando su propio grupo en la ruta: el mensaje tiene que ser de ahí.
    respuesta = await _borrar(http, identidad, BRUNO, OTRO_GRUPO, en_el_otro)
    assert respuesta.status_code == 404


@pytest.mark.asyncio
async def test_en_un_chat_de_dos_quien_lo_abrio_no_borra_lo_del_otro(entorno):
    """`created_by` de un chat directo no es autoridad: ahí no hay quien administre."""
    http, sesiones, identidad = entorno
    mensaje = await _mensaje(sesiones, de=BRUNO, texto="hola", en=DIRECTO)

    respuesta = await _borrar(http, identidad, ANA, DIRECTO, mensaje)
    assert respuesta.status_code == 403
    assert codigo(respuesta) == "message_not_yours"


@pytest.mark.asyncio
async def test_tambien_en_sus_comunidades(entorno):
    http, sesiones, identidad = entorno
    identidad["uid"] = ANA
    sub = (
        await http.post(f"{API}/{GRUPO}/subgroups", json={"title": "Valorant"})
    ).json()["id"]
    identidad["uid"] = BRUNO
    assert (await http.post(f"{API}/{GRUPO}/subgroups/{sub}/join")).status_code == 204
    identidad["uid"] = CARLA
    assert (await http.post(f"{API}/{GRUPO}/subgroups/{sub}/join")).status_code == 204
    mensaje = (
        await http.post(f"{API}/{sub}/messages", json={"body": "fuera de lugar"})
    ).json()["id"]

    # Bruno, miembro de la comunidad, no.
    assert (await _borrar(http, identidad, BRUNO, sub, mensaje)).status_code == 403
    # Ana, que administra el grupo y por eso la comunidad, sí.
    assert (await _borrar(http, identidad, ANA, sub, mensaje)).status_code == 204
