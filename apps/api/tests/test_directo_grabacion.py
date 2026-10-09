"""La grabación de un directo (prototipo, 09/10/2026).

Z no graba: guarda el enlace que avisa el proveedor y se lo entrega solo a
quien gestiona la emisión. Lo que se protege: que el enlace no llegue a quien
solo miraba, y que un aviso no pueda colgarle una grabación —o un enlace
raro— a una emisión que no es la suya.
"""

from __future__ import annotations

import re
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.modules.live.models import LiveRecording, LiveSession
from app.modules.live.proveedor_100ms import EVENTOS
from tests.test_directo_credencial_y_webhook import (  # noqa: F401  (`entorno` es una fixture)
    ANA,
    BRUNO,
    LIVE,
    SECRETO,
    _mandar,
    entorno,
)

ENLACE = "https://grabaciones.example/directo.mp4?firma=abc"


async def _emision(http) -> str:
    respuesta = await http.post(f"{LIVE}/sessions", json={"title": "Charla"})
    assert respuesta.status_code in (200, 201), respuesta.text
    return respuesta.json()["id"]


def _aviso(sesion_id: str, *, tipo: str = "beam.recording.success", event_id: str = "", **datos) -> dict:
    cuerpo = {
        "room_id": f"room_{sesion_id}",
        "session_id": "ses_1",
        "recording_id": "rec_1",
        "recording_path": "s3://cubo/directo.mp4",
        "recording_presigned_url": ENLACE,
        "duration": 754,
        "size": 13933649,
    }
    cuerpo.update(datos)
    # Cada aviso con su identificador: el servidor descarta los repetidos, y lo
    # recuerda entre pruebas.
    return {
        "id": event_id or f"evt_{uuid4()}",
        "type": tipo,
        "timestamp": "2026-10-09T00:00:00Z",
        "data": cuerpo,
    }


async def _grabacion(http, sesion_id: str):
    return await http.get(f"{LIVE}/sessions/{sesion_id}/recording")


def test_se_escuchan_los_dos_avisos_de_grabacion_lista():
    assert EVENTOS["beam.recording.success"] == "grabacion_lista"
    assert EVENTOS["recording.success"] == "grabacion_lista"


@pytest.mark.asyncio
async def test_sin_aviso_no_hay_grabacion_que_ofrecer(entorno):
    http, _sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http)
    assert (await _grabacion(http, sesion_id)).json() == {
        "available": True, "ready": False, "url": None,
        "duration_seconds": None, "size_bytes": None, "received_at": None,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("tipo", ["beam.recording.success", "recording.success"])
async def test_el_aviso_deja_la_grabacion_y_quien_emitio_la_puede_bajar(entorno, tipo):
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http)

    # El aviso de la grabación compuesta NO trae el nombre de la sala: se
    # encuentra la emisión por la sala del proveedor.
    assert (await _mandar(http, _aviso(sesion_id, tipo=tipo))).status_code == 204

    leida = (await _grabacion(http, sesion_id)).json()
    assert leida["ready"] is True
    assert leida["url"] == ENLACE
    assert (leida["duration_seconds"], leida["size_bytes"]) == (754, 13933649)
    assert leida["received_at"] is not None

    async with sesiones() as db:
        fila = await db.get(LiveRecording, sesion_id)
        sesion = await db.get(LiveSession, sesion_id)
    assert (fila.provider_recording_id, fila.storage_path) == ("rec_1", "s3://cubo/directo.mp4")
    # El aviso de grabación no mueve el estado de la emisión.
    assert sesion.status == "live"


@pytest.mark.asyncio
async def test_quien_solo_miraba_no_recibe_el_enlace(entorno):
    http, _sesiones, identidad, _doble = entorno
    sesion_id = await _emision(http)
    assert (await _mandar(http, _aviso(sesion_id))).status_code == 204

    identidad["uid"] = BRUNO
    respuesta = await _grabacion(http, sesion_id)
    assert respuesta.status_code == 403
    assert ENLACE not in respuesta.text


@pytest.mark.asyncio
async def test_un_aviso_sin_autorizacion_no_deja_ninguna_grabacion(entorno):
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http)
    assert (await _mandar(http, _aviso(sesion_id), autorizacion=None)).status_code == 403
    assert (await _mandar(http, _aviso(sesion_id), autorizacion="otro")).status_code == 403
    async with sesiones() as db:
        assert list(await db.scalars(select(LiveRecording))) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "enlace",
    ["", "http://sin-cifrar.example/v.mp4", "javascript:alert(1)", "file:///etc/passwd", "https://a b.example/v.mp4"],
)
async def test_un_enlace_que_no_es_https_no_se_guarda(entorno, enlace):
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http)
    aviso = _aviso(sesion_id, recording_presigned_url=enlace)
    assert (await _mandar(http, aviso)).status_code == 204
    async with sesiones() as db:
        assert list(await db.scalars(select(LiveRecording))) == []
    assert (await _grabacion(http, sesion_id)).json()["ready"] is False


@pytest.mark.asyncio
async def test_un_aviso_de_una_sala_que_no_es_nuestra_se_ignora_sin_fallar(entorno):
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http)

    de_otra = _aviso(sesion_id, room_id="room_de_otra_cuenta")
    assert (await _mandar(http, de_otra)).status_code == 204
    # El nombre dice una emisión y la sala dice otra: tampoco.
    cruzado = _aviso(sesion_id, room_id="room_de_otra_cuenta", room_name=sesion_id)
    assert (await _mandar(http, cruzado)).status_code == 204
    async with sesiones() as db:
        assert list(await db.scalars(select(LiveRecording))) == []


@pytest.mark.asyncio
async def test_un_segundo_aviso_sustituye_al_primero_y_no_crea_otra_fila(entorno):
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http)
    assert (await _mandar(http, _aviso(sesion_id))).status_code == 204
    nuevo = _aviso(sesion_id, recording_presigned_url=ENLACE + "&v=2", duration="mucho", size=-4)
    assert (await _mandar(http, nuevo)).status_code == 204

    async with sesiones() as db:
        filas = list(await db.scalars(select(LiveRecording)))
    assert len(filas) == 1
    assert filas[0].download_url == ENLACE + "&v=2"
    # Una duración o un tamaño que no son números no se dan por buenos.
    assert (filas[0].duration_seconds, filas[0].size_bytes) == (None, None)


@pytest.mark.asyncio
async def test_la_grabacion_se_sigue_pudiendo_bajar_con_la_emision_terminada(entorno):
    http, _sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http)
    assert (await http.post(f"{LIVE}/sessions/{sesion_id}/end")).status_code == 200
    # Es lo normal: el proveedor prepara la grabación DESPUÉS de cerrar la sala.
    assert (await _mandar(http, _aviso(sesion_id))).status_code == 204
    assert (await _grabacion(http, sesion_id)).json()["url"] == ENLACE


def test_la_0101_crea_solo_su_tabla_cerrada_y_con_las_columnas_del_modelo():
    sql = (
        Path(__file__).resolve().parents[3]
        / "supabase" / "migrations" / "0101_grabacion_del_directo.sql"
    ).read_text(encoding="utf-8").replace("\r\n", "\n")
    sql = re.sub(r"--[^\n]*", "", sql).lower()
    assert re.findall(r"create table (?:if not exists )?([a-z_.]+)", sql) == ["public.live_recordings"]
    assert set(re.findall(r"alter table ([a-z_.]+)", sql)) == {"public.live_recordings"}
    assert "enable row level security" in sql and "create policy" not in sql
    for prohibido in (
        "drop table", "truncate", "delete from", "insert into", "alter publication", "grant ",
    ):
        assert prohibido not in sql, prohibido
    cuerpo = sql[sql.index("create table if not exists public.live_recordings (") :]
    cuerpo = cuerpo[cuerpo.index("(") + 1 : cuerpo.index(");")]
    del_sql = {t.strip().split()[0] for t in re.split(r",\s*\n", cuerpo) if t.strip()}
    assert del_sql == {c.name for c in LiveRecording.__table__.columns}
