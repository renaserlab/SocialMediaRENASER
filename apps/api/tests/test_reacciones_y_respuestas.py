"""Reaccionar a un mensaje y responder a uno concreto (migración 0106).

Pedido el 10/10/2026, visto en teléfono. Lo que se protege:

  · una reacción por persona y mensaje, y solo en conversaciones propias;
  · que no se pueda reaccionar ni citar un mensaje de otra conversación;
  · que un mensaje borrado no entregue ni sus reacciones ni su texto en una cita;
  · que nada de esto cueste una consulta por mensaje;
  · que sin la 0106 el chat siga funcionando y un mensaje con cita se mande igual.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, func, select

# `app.main` va primero: ver la nota en `test_grupos_de_mensajeria.py`.
from app.main import app  # noqa: I001
from app.modules.messaging import reacciones
from app.modules.messaging.models import MessageReaction, MessageReply
from tests.test_vistas_de_conversacion import (  # noqa: F401 - `entorno` es un fixture
    ANA,
    API,
    BRUNO,
    CARLA,
    DAVID,
    DIRECTO,
    GRUPO,
    OTRO_GRUPO,
    _levantar,
    _mensaje,
    _recoger,
    entorno,
)


@pytest_asyncio.fixture
async def sin_migracion():
    engine, sesiones, identidad = await _levantar(
        sin_tablas=("message_reactions", "message_replies")
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad
    await _recoger(engine)


async def _reaccionar(http, mensaje: str, emoji: str = "❤️", conv: str = GRUPO):
    return await http.put(f"{API}/{conv}/messages/{mensaje}/reaction", json={"emoji": emoji})


async def _historial(http, conv: str = GRUPO) -> dict[str, dict]:
    respuesta = await http.get(f"{API}/{conv}/messages", params={"limit": 100})
    assert respuesta.status_code == 200, respuesta.text
    return {m["id"]: m for m in respuesta.json()}


async def _enviar(http, texto: str, responde_a: str | None = None, conv: str = GRUPO):
    cuerpo: dict = {"body": texto}
    if responde_a is not None:
        cuerpo["reply_to_id"] = responde_a
    return await http.post(f"{API}/{conv}/messages", json=cuerpo)


# --------------------------------------------------------------------------- #
# 1. Reacciones
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_una_reaccion_por_persona_y_se_entregan_agrupadas(entorno):
    http, sesiones, identidad = entorno
    mensaje = await _mensaje(sesiones, de=BRUNO, texto="Aprobamos todos")

    puesta = await _reaccionar(http, mensaje, "❤️")
    assert puesta.status_code == 200, puesta.text
    assert puesta.json() == [{"emoji": "❤️", "count": 1, "mine": True}]

    identidad["uid"] = CARLA
    assert (await _reaccionar(http, mensaje, "❤️")).json() == [{"emoji": "❤️", "count": 2, "mine": True}]
    identidad["uid"] = BRUNO
    assert (await _reaccionar(http, mensaje, "🎉")).status_code == 200

    # En el historial: la más usada primero, y a cada cual se le dice la suya.
    del_mensaje = (await _historial(http))[mensaje]["reactions"]
    assert del_mensaje == [
        {"emoji": "❤️", "count": 2, "mine": False},
        {"emoji": "🎉", "count": 1, "mine": True},
    ]

    # Reaccionar otra vez la CAMBIA: sigue habiendo una por persona.
    identidad["uid"] = ANA
    cambiada = (await _reaccionar(http, mensaje, "🎉")).json()
    assert {(r["emoji"], r["count"], r["mine"]) for r in cambiada} == {("🎉", 2, True), ("❤️", 1, False)}
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(MessageReaction)) == 3

    # Y quitarla deja las de los demás.
    quitada = await http.delete(f"{API}/{GRUPO}/messages/{mensaje}/reaction")
    assert quitada.status_code == 200
    assert {(r["emoji"], r["count"]) for r in quitada.json()} == {("🎉", 1), ("❤️", 1)}
    assert (await http.delete(f"{API}/{GRUPO}/messages/{mensaje}/reaction")).status_code == 200


@pytest.mark.asyncio
async def test_solo_se_reacciona_en_las_conversaciones_propias(entorno):
    http, sesiones, identidad = entorno
    mio = await _mensaje(sesiones, texto="En el grupo de Ana")
    ajeno = await _mensaje(sesiones, de=BRUNO, texto="En el otro grupo", en=OTRO_GRUPO)

    identidad["uid"] = DAVID
    assert (await _reaccionar(http, mio)).status_code == 403
    assert (await http.delete(f"{API}/{GRUPO}/messages/{mio}/reaction")).status_code == 403

    # Ana no está en OTRO_GRUPO: ni por su ruta, ni colando el mensaje por la suya.
    identidad["uid"] = ANA
    assert (await _reaccionar(http, ajeno, conv=OTRO_GRUPO)).status_code == 403
    colado = await _reaccionar(http, ajeno, conv=GRUPO)
    assert colado.status_code == 404
    assert colado.json()["error"]["code"] == "message_not_found"
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(MessageReaction)) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("emoji", ["ok", "a", "1", "  ", "", "👍 bien", "❤️" * 9])
async def test_una_reaccion_es_un_emoji_y_no_un_texto(entorno, emoji):
    http, sesiones, _ = entorno
    mensaje = await _mensaje(sesiones, texto="Hola")
    assert (await _reaccionar(http, mensaje, emoji)).status_code == 422


@pytest.mark.asyncio
async def test_quien_reacciona_no_se_elige_desde_la_peticion(entorno):
    http, sesiones, _ = entorno
    mensaje = await _mensaje(sesiones, texto="Hola")
    suplantando = await http.put(
        f"{API}/{GRUPO}/messages/{mensaje}/reaction", json={"emoji": "👍", "user_id": BRUNO}
    )
    assert suplantando.status_code == 422


@pytest.mark.asyncio
async def test_un_mensaje_borrado_no_admite_ni_entrega_reacciones(entorno):
    http, sesiones, _ = entorno
    mensaje = await _mensaje(sesiones, texto="Me arrepiento")
    assert (await _reaccionar(http, mensaje)).status_code == 200
    assert (await http.delete(f"{API}/{GRUPO}/messages/{mensaje}")).status_code == 204

    borrado = await _reaccionar(http, mensaje, "🎉")
    assert borrado.status_code == 409
    assert borrado.json()["error"]["code"] == "message_deleted"
    assert (await _historial(http))[mensaje]["reactions"] == []
    consulta = await http.post(f"{API}/{GRUPO}/reactions/lookup", json={"message_ids": [mensaje]})
    assert consulta.json() == {"reactions": {}}


@pytest.mark.asyncio
async def test_consultar_reacciones_solo_dice_las_de_esta_conversacion(entorno):
    http, sesiones, identidad = entorno
    con = await _mensaje(sesiones, texto="Con reacción", minuto=1)
    sin = await _mensaje(sesiones, texto="Sin reacción", minuto=2)
    ajeno = await _mensaje(sesiones, de=BRUNO, texto="Otro grupo", en=OTRO_GRUPO)
    await _reaccionar(http, con, "👍")
    identidad["uid"] = BRUNO
    await _reaccionar(http, ajeno, "🔥", conv=OTRO_GRUPO)

    identidad["uid"] = CARLA
    respuesta = await http.post(
        f"{API}/{GRUPO}/reactions/lookup",
        json={"message_ids": [con, sin, ajeno, "no-es-un-id", con]},
    )
    assert respuesta.status_code == 200, respuesta.text
    # Solo el que tiene reacciones Y es de esta conversación. El de otro grupo
    # se ignora sin decir si existe.
    assert respuesta.json() == {"reactions": {con: [{"emoji": "👍", "count": 1, "mine": False}]}}

    identidad["uid"] = DAVID
    assert (await http.post(f"{API}/{GRUPO}/reactions/lookup", json={"message_ids": [con]})).status_code == 403
    identidad["uid"] = ANA
    demasiados = [con] * (reacciones.MAX_CONSULTA + 1)
    assert (await http.post(f"{API}/{GRUPO}/reactions/lookup", json={"message_ids": demasiados})).status_code == 422


@pytest.mark.asyncio
async def test_las_vistas_del_chat_tambien_traen_reacciones_y_citas(entorno):
    http, sesiones, _ = entorno
    foto = await _mensaje(sesiones, de=BRUNO, adjuntos=("image",))
    await _reaccionar(http, foto, "😍")
    respuesta = (await _enviar(http, "Qué buena foto https://x.example", responde_a=foto)).json()

    pagina = await http.get(f"{API}/{GRUPO}/views/messages", params={"category": "image"})
    assert pagina.json()["items"][0]["reactions"] == [{"emoji": "😍", "count": 1, "mine": True}]
    enlaces = await http.get(f"{API}/{GRUPO}/views/messages", params={"category": "link"})
    cita = enlaces.json()["items"][0]["reply_to"]
    assert (cita["id"], cita["kind"]) == (foto, "image")
    assert enlaces.json()["items"][0]["id"] == respuesta["id"]


# --------------------------------------------------------------------------- #
# 2. Responder a un mensaje
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_responder_a_un_mensaje_deja_su_cita(entorno):
    http, sesiones, identidad = entorno
    original = await _mensaje(sesiones, de=BRUNO, texto="¿A qué hora es la clase?")

    enviado = await _enviar(http, "A las nueve", responde_a=original)
    assert enviado.status_code == 201, enviado.text
    cita = enviado.json()["reply_to"]
    assert cita == {
        "id": original,
        "sender_id": BRUNO,
        "sender_name": "Bruno",
        "excerpt": "¿A qué hora es la clase?",
        "kind": None,
        "deleted": False,
    }
    # Y la ven igual los demás al leer el historial.
    identidad["uid"] = CARLA
    historial = await _historial(http)
    assert historial[enviado.json()["id"]]["reply_to"] == cita
    assert historial[original]["reply_to"] is None
    async with sesiones() as db:
        fila = (await db.execute(select(MessageReply))).scalar_one()
        assert (fila.message_id, fila.reply_to_id) == (enviado.json()["id"], original)


@pytest.mark.asyncio
async def test_la_cita_dice_de_que_era_el_mensaje_y_se_acorta(entorno):
    http, sesiones, _ = entorno
    foto = await _mensaje(sesiones, de=BRUNO, adjuntos=("image",), minuto=1)
    voz = await _mensaje(sesiones, de=CARLA, adjuntos=("audio",), minuto=2)
    largo = await _mensaje(sesiones, de=BRUNO, texto="palabra " * 60, minuto=3)

    de_foto = (await _enviar(http, "Bonita", responde_a=foto)).json()["reply_to"]
    assert (de_foto["excerpt"], de_foto["kind"]) == ("", "image")
    de_voz = (await _enviar(http, "Escuchado", responde_a=voz)).json()["reply_to"]
    assert (de_voz["kind"], de_voz["sender_name"]) == ("audio", "Carla")
    de_largo = (await _enviar(http, "Resumiendo", responde_a=largo)).json()["reply_to"]
    assert len(de_largo["excerpt"]) <= reacciones.MAX_EXTRACTO
    assert de_largo["excerpt"].endswith("…")
    assert "\n" not in de_largo["excerpt"] and "  " not in de_largo["excerpt"]


@pytest.mark.asyncio
async def test_no_se_cita_un_mensaje_de_otra_conversacion(entorno):
    http, sesiones, _ = entorno
    ajeno = await _mensaje(sesiones, de=BRUNO, texto="Secreto del otro grupo", en=OTRO_GRUPO)

    # El mensaje se manda igual, pero SIN cita: el texto ajeno no se filtra.
    enviado = await _enviar(http, "Intento citarlo", responde_a=ajeno)
    assert enviado.status_code == 201
    assert enviado.json()["reply_to"] is None
    assert "Secreto" not in str(await _historial(http))
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(MessageReply)) == 0

    inventado = await _enviar(http, "A uno que no existe", responde_a="aaaaaaaa-0000-0000-0000-00000000dead")
    assert inventado.status_code == 201
    assert inventado.json()["reply_to"] is None
    assert (await _enviar(http, "Mal escrito", responde_a="no-es-un-id")).status_code == 404


@pytest.mark.asyncio
async def test_si_el_original_se_borra_la_cita_no_ensena_su_texto(entorno):
    http, sesiones, identidad = entorno
    identidad["uid"] = BRUNO
    original = (await _enviar(http, "Esto lo voy a borrar")).json()["id"]
    identidad["uid"] = ANA
    respuesta = (await _enviar(http, "Te respondo", responde_a=original)).json()["id"]

    identidad["uid"] = BRUNO
    assert (await http.delete(f"{API}/{GRUPO}/messages/{original}")).status_code == 204

    identidad["uid"] = CARLA
    cita = (await _historial(http))[respuesta]["reply_to"]
    assert cita["deleted"] is True
    assert cita["excerpt"] == ""
    assert cita["kind"] is None
    assert cita["sender_name"] == "Bruno"      # se sigue sabiendo a quién se respondía
    assert "borrar" not in str(await _historial(http))


# --------------------------------------------------------------------------- #
# 3. No cuesta una consulta por mensaje
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_reacciones_y_citas_no_hacen_una_consulta_por_mensaje(entorno):
    http, sesiones, identidad = entorno
    anterior = await _mensaje(sesiones, de=BRUNO, texto="El primero", adjuntos=("image",))
    for i in range(30):
        enviado = (await _enviar(http, f"Mensaje {i}", responde_a=anterior)).json()["id"]
        await _reaccionar(http, enviado, "👍")
        anterior = enviado

    async with sesiones() as db:
        motor = db.get_bind()
    consultas: list[str] = []

    def _anotar(_conn, _cursor, sentencia, *_resto):
        consultas.append(sentencia)

    event.listen(motor, "before_cursor_execute", _anotar)
    try:
        respuesta = await http.get(f"{API}/{GRUPO}/messages", params={"limit": 31})
    finally:
        event.remove(motor, "before_cursor_execute", _anotar)

    cuerpo = respuesta.json()
    assert len(cuerpo) == 31
    assert sum(1 for m in cuerpo if m["reply_to"]) == 30
    assert sum(1 for m in cuerpo if m["reactions"]) == 30
    selects = [c for c in consultas if c.lstrip().lower().startswith("select")]
    # Las siete de siempre más el tipo de adjunto de los citados: ocho, con
    # treinta citas igual que con una.
    assert len(selects) <= 8, f"{len(selects)} consultas para 31 mensajes con cita y reacción"


# --------------------------------------------------------------------------- #
# 4. Sin la migración 0106
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_la_0106_el_chat_sigue_y_el_mensaje_se_manda_sin_cita(sin_migracion):
    http, sesiones, _ = sin_migracion
    original = await _mensaje(sesiones, de=BRUNO, texto="Hola")

    historial = await _historial(http)
    assert historial[original]["reactions"] == []
    assert historial[original]["reply_to"] is None

    # El texto es de quien lo escribe: se manda, aunque la cita no se pueda guardar.
    enviado = await _enviar(http, "Respondo igual", responde_a=original)
    assert enviado.status_code == 201
    assert enviado.json()["reply_to"] is None

    reaccion = await _reaccionar(http, original)
    assert reaccion.status_code == 503
    assert reaccion.json()["error"]["code"] == "reactions_not_available"
    consulta = await http.post(f"{API}/{GRUPO}/reactions/lookup", json={"message_ids": [original]})
    assert consulta.json() == {"reactions": {}}
    # Y las vistas tampoco se enteran.
    assert (await http.get(f"{API}/{GRUPO}/views/messages", params={"category": "all"})).status_code == 200


@pytest.mark.asyncio
async def test_la_aplicacion_pregunta_antes_de_ofrecer_reaccionar(entorno):
    """Nunca un botón muerto: «Responder» y las reacciones solo se pintan si existen."""
    http, _, _ = entorno
    assert (await http.get(f"{API}/availability")).json()["reactions"] is True


@pytest.mark.asyncio
async def test_sin_la_0106_la_aplicacion_no_ofrece_reaccionar(sin_migracion):
    http, _, _ = sin_migracion
    disponibilidad = await http.get(f"{API}/availability")
    assert disponibilidad.status_code == 200
    assert disponibilidad.json()["reactions"] is False


@pytest.mark.asyncio
async def test_un_chat_de_dos_tambien_tiene_reacciones_y_citas(entorno):
    http, sesiones, identidad = entorno
    original = await _mensaje(sesiones, de=BRUNO, texto="¿Vienes?", en=DIRECTO)
    assert (await _reaccionar(http, original, "👍", conv=DIRECTO)).status_code == 200
    enviado = await _enviar(http, "Sí", responde_a=original, conv=DIRECTO)
    assert enviado.json()["reply_to"]["id"] == original
    identidad["uid"] = BRUNO
    assert (await _historial(http, DIRECTO))[original]["reactions"] == [
        {"emoji": "👍", "count": 1, "mine": False}
    ]


# --------------------------------------------------------------------------- #
# 5. La migración
# --------------------------------------------------------------------------- #
def _sql_de_la_0106() -> str:
    raiz = Path(__file__).resolve().parents[3]
    crudo = (raiz / "supabase" / "migrations" / "0106_reacciones_y_respuestas.sql").read_text(
        encoding="utf-8"
    )
    return "\n".join(
        linea for linea in crudo.replace("\r\n", "\n").split("\n") if not linea.lstrip().startswith("--")
    )


def test_la_0106_crea_sus_dos_tablas_y_las_deja_cerradas():
    sql = _sql_de_la_0106()
    for tabla in ("message_reactions", "message_replies"):
        assert f"create table if not exists public.{tabla}" in sql
        assert f"alter table public.{tabla} enable row level security" in sql
    assert "create policy" not in sql
    assert "alter publication" not in sql
    for tabla in ("messages", "message_attachments", "conversations", "conversation_members"):
        assert not re.search(rf"alter table public\.{tabla}\b", sql), tabla
    assert not re.search(r"\b(drop table|delete from|truncate|update public\.)", sql)
    # Una reacción por persona y mensaje, y la cita sobrevive a su original.
    assert "primary key (message_id, user_id)" in sql
    assert "reply_to_id uuid references public.messages(id) on delete set null" in sql


@pytest.mark.parametrize(
    ("tabla", "modelo"),
    [("message_reactions", MessageReaction), ("message_replies", MessageReply)],
)
def test_las_tablas_de_los_modelos_son_las_de_la_0106(tabla, modelo):
    sql = _sql_de_la_0106()
    inicio = sql.index(f"create table if not exists public.{tabla}")
    cuerpo = sql[inicio : sql.index(");", inicio)]
    del_sql = set(re.findall(r"^\s{2}([a-z_]+) ", cuerpo, flags=re.M)) - {"primary"}
    assert del_sql == {c.name for c in modelo.__table__.columns}
