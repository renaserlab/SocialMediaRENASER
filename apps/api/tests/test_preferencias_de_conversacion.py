"""Silenciar una conversación y vaciarla para uno mismo (migración 0107).

Pedido el 10/10/2026, con Telegram de referencia. Lo que se protege:

  · silenciar quita el aviso y nada más: el mensaje llega y cuenta como no leído;
  · las dos decisiones son de quien las toma: a los demás no les cambia nada;
  · vaciar no borra ningún mensaje, y lo que llega después se ve;
  · lo vaciado no reaparece por el historial, por las vistas ni por la bandeja;
  · nadie que no sea miembro puede tocar nada, y nadie decide por otra persona;
  · sin la 0107 el chat sigue igual y la aplicación no ofrece ninguna de las dos;
  · «media» junta fotos y vídeos sin contar dos veces el mensaje que trae ambos.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

# `app.main` va primero: ver la nota en `test_grupos_de_mensajeria.py`.
from app.main import app  # noqa: I001
from app.modules.messaging import avisos, esquema
from app.modules.messaging.models import ConversationPreference, Message
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
    engine, sesiones, identidad = await _levantar(sin_tablas=("conversation_preferences",))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad
    await _recoger(engine)


def _despues(minutos: int = 5) -> datetime:
    """Un instante posterior a cualquier «ahora» de la prueba."""
    return datetime.now(timezone.utc) + timedelta(minutes=minutos)


async def _historial(http, conv: str = GRUPO) -> list[dict]:
    respuesta = await http.get(f"{API}/{conv}/messages", params={"limit": 100})
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


async def _bandeja(http) -> dict[str, dict]:
    respuesta = await http.get(API, params={"limit": 50})
    assert respuesta.status_code == 200, respuesta.text
    return {fila["id"]: fila for fila in respuesta.json()}


async def _vista(http, categoria: str, conv: str = GRUPO) -> list[dict]:
    respuesta = await http.get(f"{API}/{conv}/views/messages", params={"category": categoria})
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()["items"]


async def _cuentas(http, conv: str = GRUPO) -> dict[str, int]:
    respuesta = await http.get(f"{API}/{conv}/views")
    assert respuesta.status_code == 200, respuesta.text
    return {c["key"]: c["count"] for c in respuesta.json()["categories"]}


# --------------------------------------------------------------------------- #
# 1. Silenciar
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_silenciar_quita_el_aviso_y_solo_a_quien_silencia(entorno):
    http, sesiones, identidad = entorno

    identidad["uid"] = BRUNO
    assert (await http.put(f"{API}/{GRUPO}/mute")).status_code == 204

    async with sesiones() as db:
        a_quien = await avisos.destinatarios(db, conversation_id=GRUPO, remitente_id=ANA)
    assert set(a_quien) == {CARLA}, "Bruno la silenció: no se le avisa; a Carla sí"

    # Es SUYO: en la bandeja de Bruno sale silenciada; en la de Carla, no.
    assert (await _bandeja(http))[GRUPO]["muted"] is True
    assert (await http.get(f"{API}/{GRUPO}/info")).json()["muted"] is True
    identidad["uid"] = CARLA
    assert (await _bandeja(http))[GRUPO]["muted"] is False
    assert (await http.get(f"{API}/{GRUPO}/info")).json()["muted"] is False

    # Y silenciar un grupo no silencia los demás chats de esa persona.
    async with sesiones() as db:
        del_directo = await avisos.destinatarios(db, conversation_id=DIRECTO, remitente_id=ANA)
    assert del_directo == [BRUNO]


@pytest.mark.asyncio
async def test_un_chat_silenciado_sigue_recibiendo_y_contando(entorno):
    http, sesiones, identidad = entorno
    identidad["uid"] = BRUNO
    await http.put(f"{API}/{GRUPO}/mute")

    identidad["uid"] = ANA
    enviado = await http.post(f"{API}/{GRUPO}/messages", json={"body": "Mañana hay examen"})
    assert enviado.status_code in (200, 201), enviado.text

    identidad["uid"] = BRUNO
    fila = (await _bandeja(http))[GRUPO]
    assert fila["last_message"] == "Mañana hay examen"
    assert fila["unread_count"] == 1
    assert [m["body"] for m in await _historial(http)] == ["Mañana hay examen"]


@pytest.mark.asyncio
async def test_quitar_el_silencio_devuelve_el_aviso(entorno):
    http, sesiones, identidad = entorno
    identidad["uid"] = BRUNO
    await http.put(f"{API}/{GRUPO}/mute")
    # Dos veces seguidas no deja dos filas ni falla.
    assert (await http.put(f"{API}/{GRUPO}/mute")).status_code == 204
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(ConversationPreference)) == 1

    assert (await http.delete(f"{API}/{GRUPO}/mute")).status_code == 204
    async with sesiones() as db:
        a_quien = await avisos.destinatarios(db, conversation_id=GRUPO, remitente_id=ANA)
    assert set(a_quien) == {BRUNO, CARLA}
    assert (await _bandeja(http))[GRUPO]["muted"] is False

    # Quitarlo sin haberla silenciado nunca no es un error.
    identidad["uid"] = CARLA
    assert (await http.delete(f"{API}/{GRUPO}/mute")).status_code == 204


# --------------------------------------------------------------------------- #
# 2. Vaciar
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_vaciar_es_solo_para_quien_vacia_y_no_borra_nada(entorno):
    http, sesiones, identidad = entorno
    await _mensaje(sesiones, de=BRUNO, texto="Lo de antes", minuto=1)
    await _mensaje(sesiones, de=CARLA, texto="Mira https://z.pe/guia", adjuntos=("image",), minuto=2)

    assert len(await _historial(http)) == 2
    assert (await http.post(f"{API}/{GRUPO}/clear")).status_code == 204

    # Para Ana, que lo vació: nada. Ni en el historial, ni en las vistas.
    assert await _historial(http) == []
    assert await _vista(http, "all") == []
    assert await _vista(http, "media") == []
    assert await _vista(http, "link") == []
    cuentas = await _cuentas(http)
    assert cuentas["image"] == cuentas["media"] == cuentas["link"] == 0

    # Para Bruno, que no: todo sigue ahí.
    identidad["uid"] = BRUNO
    assert [m["body"] for m in await _historial(http)] == ["Lo de antes", "Mira https://z.pe/guia"]
    assert (await _cuentas(http))["image"] == 1

    # Y en la base no se ha borrado ni marcado ningún mensaje.
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(Message)) == 2
        assert await db.scalar(
            select(func.count()).select_from(Message).where(Message.deleted_at.is_not(None))
        ) == 0


@pytest.mark.asyncio
async def test_lo_que_llega_despues_de_vaciar_se_ve(entorno):
    http, sesiones, identidad = entorno
    await _mensaje(sesiones, de=BRUNO, texto="Lo de antes", minuto=1)
    await http.post(f"{API}/{GRUPO}/clear")

    nuevo = await _mensaje(
        sesiones, de=BRUNO, texto="Lo nuevo", adjuntos=("video",), cuando=_despues()
    )
    assert [m["id"] for m in await _historial(http)] == [nuevo]
    assert [m["id"] for m in await _vista(http, "media")] == [nuevo]
    assert (await _cuentas(http))["video"] == 1


@pytest.mark.asyncio
async def test_la_bandeja_no_ensena_lo_vaciado(entorno):
    http, sesiones, identidad = entorno
    await _mensaje(sesiones, de=BRUNO, texto="Esto ya no quiero verlo", minuto=1)
    assert (await _bandeja(http))[GRUPO]["last_message"] == "Esto ya no quiero verlo"
    assert (await _bandeja(http))[GRUPO]["unread_count"] == 1

    await http.post(f"{API}/{GRUPO}/clear")
    fila = (await _bandeja(http))[GRUPO]
    assert fila["last_message"] is None
    assert fila["last_message_at"] is None
    # Quien vacía acaba de verla: no le queda un contador sobre un chat vacío.
    assert fila["unread_count"] == 0

    # A Bruno su bandeja le sigue enseñando el mensaje.
    identidad["uid"] = BRUNO
    assert (await _bandeja(http))[GRUPO]["last_message"] == "Esto ya no quiero verlo"

    # Y a Ana le vuelve a salir en cuanto llega algo nuevo.
    await _mensaje(sesiones, de=CARLA, texto="Hola de nuevo", cuando=_despues())
    identidad["uid"] = ANA
    fila = (await _bandeja(http))[GRUPO]
    assert fila["last_message"] == "Hola de nuevo"
    assert fila["unread_count"] == 1


@pytest.mark.asyncio
async def test_vaciar_un_chat_no_vacia_los_demas(entorno):
    http, sesiones, identidad = entorno
    await _mensaje(sesiones, de=BRUNO, texto="En el grupo", minuto=1)
    await _mensaje(sesiones, de=BRUNO, texto="En privado", en=DIRECTO, minuto=1)

    await http.post(f"{API}/{GRUPO}/clear")
    assert await _historial(http) == []
    assert [m["body"] for m in await _historial(http, DIRECTO)] == ["En privado"]

    # Un chat de dos también se vacía, y también solo para quien lo pide.
    assert (await http.post(f"{API}/{DIRECTO}/clear")).status_code == 204
    assert await _historial(http, DIRECTO) == []
    identidad["uid"] = BRUNO
    assert [m["body"] for m in await _historial(http, DIRECTO)] == ["En privado"]


@pytest.mark.asyncio
async def test_silenciar_y_vaciar_no_se_pisan(entorno):
    http, sesiones, identidad = entorno
    await _mensaje(sesiones, de=BRUNO, texto="Antes", minuto=1)
    await http.put(f"{API}/{GRUPO}/mute")
    await http.post(f"{API}/{GRUPO}/clear")

    assert (await _bandeja(http))[GRUPO]["muted"] is True
    assert await _historial(http) == []

    await http.delete(f"{API}/{GRUPO}/mute")
    assert (await _bandeja(http))[GRUPO]["muted"] is False
    assert await _historial(http) == [], "quitar el silencio no puede devolver lo vaciado"
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(ConversationPreference)) == 1


# --------------------------------------------------------------------------- #
# 3. Permisos
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("metodo", "cola"), [("put", "mute"), ("delete", "mute"), ("post", "clear")]
)
async def test_quien_no_es_miembro_no_toca_nada(entorno, metodo, cola):
    http, sesiones, identidad = entorno
    identidad["uid"] = DAVID
    assert (await getattr(http, metodo)(f"{API}/{GRUPO}/{cola}")).status_code == 403
    # Ana no está en OTRO_GRUPO.
    identidad["uid"] = ANA
    assert (await getattr(http, metodo)(f"{API}/{OTRO_GRUPO}/{cola}")).status_code == 403
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(ConversationPreference)) == 0


@pytest.mark.asyncio
async def test_nadie_decide_por_otra_persona(entorno):
    http, sesiones, identidad = entorno
    await _mensaje(sesiones, de=BRUNO, texto="Hola", minuto=1)

    # Ni un cuerpo ni un parámetro cambian a quién se le aplica.
    await http.put(f"{API}/{GRUPO}/mute", params={"user_id": BRUNO})
    await http.post(f"{API}/{GRUPO}/clear", params={"user_id": BRUNO})
    async with sesiones() as db:
        filas = (await db.execute(select(ConversationPreference.user_id))).scalars().all()
    assert filas == [ANA]

    identidad["uid"] = BRUNO
    assert (await _bandeja(http))[GRUPO]["muted"] is False
    assert [m["body"] for m in await _historial(http)] == ["Hola"]


# --------------------------------------------------------------------------- #
# 4. Sin la migración 0107
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_la_0107_el_chat_sigue_igual_y_no_se_ofrece_nada(sin_migracion):
    http, sesiones, identidad = sin_migracion
    await _mensaje(sesiones, de=BRUNO, texto="Hola", adjuntos=("image",), minuto=1)

    assert (await http.get(f"{API}/availability")).json()["preferences"] is False
    for metodo, cola in (("put", "mute"), ("delete", "mute"), ("post", "clear")):
        respuesta = await getattr(http, metodo)(f"{API}/{GRUPO}/{cola}")
        assert respuesta.status_code == 503, (cola, respuesta.text)
        assert respuesta.json()["error"]["code"] == "conversation_preferences_not_available"

    # Y todo lo demás responde como siempre.
    assert [m["body"] for m in await _historial(http)] == ["Hola"]
    assert (await _bandeja(http))[GRUPO]["muted"] is False
    assert (await _bandeja(http))[GRUPO]["last_message"] == "Hola"
    assert (await _cuentas(http))["media"] == 1
    assert (await http.get(f"{API}/{GRUPO}/info")).json()["muted"] is False
    async with sesiones() as db:
        assert set(await avisos.destinatarios(db, conversation_id=GRUPO, remitente_id=ANA)) == {
            BRUNO,
            CARLA,
        }


@pytest.mark.asyncio
async def test_la_aplicacion_pregunta_antes_de_ofrecer_silenciar_y_vaciar(entorno):
    http, _, _ = entorno
    assert (await http.get(f"{API}/availability")).json()["preferences"] is True


# --------------------------------------------------------------------------- #
# 5. Un «no» del esquema caduca
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_api_ve_una_migracion_aplicada_despues_de_arrancar(sin_migracion, monkeypatch):
    """Sin esto había que reiniciar la API para que viera la tabla recién creada."""
    http, sesiones, _ = sin_migracion
    assert (await http.get(f"{API}/availability")).json()["preferences"] is False

    # Se aplica la migración con la API en marcha…
    async with sesiones() as db:
        conexion = await db.connection()
        await conexion.run_sync(
            lambda sync: ConversationPreference.__table__.create(sync, checkfirst=True)
        )
        await db.commit()

    # …y mientras el «no» sigue vigente, la respuesta no cambia (no se mira cada vez).
    assert (await http.get(f"{API}/availability")).json()["preferences"] is False

    # Pasado su plazo se vuelve a mirar, y ya está.
    reloj = esquema.time.monotonic()
    monkeypatch.setattr(
        esquema.time, "monotonic", lambda: reloj + esquema.SEGUNDOS_DE_UN_NO + 1
    )
    assert (await http.get(f"{API}/availability")).json()["preferences"] is True
    assert (await http.put(f"{API}/{GRUPO}/mute")).status_code == 204


@pytest.mark.asyncio
async def test_un_si_del_esquema_no_se_vuelve_a_preguntar(entorno, monkeypatch):
    http, sesiones, _ = entorno
    assert (await http.get(f"{API}/availability")).json()["preferences"] is True
    reloj = esquema.time.monotonic()
    monkeypatch.setattr(esquema.time, "monotonic", lambda: reloj + 10 * esquema.SEGUNDOS_DE_UN_NO)
    assert esquema._sabido("conversation_preferences") is True


# --------------------------------------------------------------------------- #
# 6. «Media»: fotos y vídeos juntos
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_media_junta_fotos_y_videos_sin_contar_dos_veces(entorno):
    http, sesiones, _ = entorno
    foto = await _mensaje(sesiones, de=BRUNO, adjuntos=("image", "image"), minuto=1)
    video = await _mensaje(sesiones, de=CARLA, adjuntos=("video",), minuto=2)
    las_dos = await _mensaje(sesiones, adjuntos=("image", "video"), minuto=3)
    await _mensaje(sesiones, adjuntos=("document",), nombre="apuntes.pdf", minuto=4)
    await _mensaje(sesiones, adjuntos=("audio",), minuto=5)
    await _mensaje(sesiones, de=BRUNO, adjuntos=("image",), minuto=6, borrado=True)

    cuentas = await _cuentas(http)
    assert (cuentas["image"], cuentas["video"]) == (2, 2)
    assert cuentas["media"] == 3, "el mensaje con foto Y vídeo cuenta una vez"
    assert (cuentas["document"], cuentas["audio"]) == (1, 1)

    # De lo más reciente a lo más antiguo, y sin el documento ni el audio.
    assert [m["id"] for m in await _vista(http, "media")] == [las_dos, video, foto]
    assert [m["id"] for m in await _vista(http, "image")] == [las_dos, foto]
    assert [m["id"] for m in await _vista(http, "video")] == [las_dos, video]


# --------------------------------------------------------------------------- #
# 7. La migración
# --------------------------------------------------------------------------- #
def _sql_de_la_0107() -> str:
    ruta = Path(__file__).resolve().parents[3] / "supabase" / "migrations"
    crudo = (ruta / "0107_preferencias_de_conversacion.sql").read_text(encoding="utf-8")
    return "\n".join(
        linea for linea in crudo.replace("\r\n", "\n").split("\n") if not linea.lstrip().startswith("--")
    )


def test_la_0107_crea_su_tabla_y_la_deja_cerrada():
    sql = _sql_de_la_0107()
    assert "create table if not exists public.conversation_preferences" in sql
    assert "alter table public.conversation_preferences enable row level security" in sql
    assert "create policy" not in sql
    assert "alter publication" not in sql
    for tabla in ("messages", "conversations", "conversation_members", "profiles"):
        assert not re.search(rf"alter table public\.{tabla}\b", sql), tabla
    assert not re.search(r"\b(drop table|delete from|truncate|update public\.)", sql)
    # Una fila por persona y conversación, y se va con cualquiera de las dos.
    assert "primary key (conversation_id, user_id)" in sql
    assert sql.count("on delete cascade") == 2
    # Repetible: nada que falle la segunda vez.
    assert "create index if not exists conversation_preferences_user_idx" in sql


def test_la_tabla_del_modelo_es_la_de_la_0107():
    sql = _sql_de_la_0107()
    inicio = sql.index("create table if not exists public.conversation_preferences")
    cuerpo = sql[inicio : sql.index(");", inicio)]
    del_sql = set(re.findall(r"^\s{2}([a-z_]+) ", cuerpo, flags=re.M)) - {"primary"}
    assert del_sql == {c.name for c in ConversationPreference.__table__.columns}
