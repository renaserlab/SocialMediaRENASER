"""«Bruno te envió un mensaje»: el aviso que faltaba al llegar un mensaje.

LO REPORTADO (03/10/2026). «Cuando se envía un mensaje a un usuario… no
aparecen las notificaciones». Y era literal: `send_message` guardaba el mensaje
y no avisaba a nadie. El canal `mensajes` existía en el teléfono desde el
principio y ningún aviso del servidor lo usaba.

Aquí se fija la parte del servidor:

  * QUIÉN recibe el push: los demás miembros de la conversación, nunca quien
    escribe, y nadie con quien haya un bloqueo en cualquiera de los dos
    sentidos.
  * QUÉ DICE: quién escribe. NUNCA el texto del mensaje: un push se lee en la
    pantalla bloqueada.
  * QUÉ VIAJA: un tipo y el identificador de la conversación. Ninguna ruta.
  * QUE NUNCA ROMPE: un fallo al avisar no puede impedir el mensaje.
  * QUE NO LLENA LA BANDEJA: un mensaje vive en Mensajes, no en notificaciones.
  * Y que un teléfono que ya no existe deja de recibir avisos.

SQLite en memoria, mismo patrón que `test_mensajes_adjuntos.py`. El push no
sale: se retiene lo que se habría programado (ver la fixture `pushes`).
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.messaging import avisos
from app.modules.messaging import esquema as esquema_mensajes
from app.modules.messaging import router as messaging_router
from app.modules.messaging.models import Conversation, ConversationMember, Message
from app.modules.notifications import push
from app.modules.notifications.models import Notification
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.modules.social_graph.models import UserBlock
from app.shared.database import Base, get_db

pytestmark = pytest.mark.asyncio

API = "/api/v1/conversations"

ANA = "dddddddd-0000-0000-0000-000000000001"
BRUNO = "dddddddd-0000-0000-0000-000000000002"
CARLA = "dddddddd-0000-0000-0000-000000000003"

CHAT = "eeeeeeee-0000-0000-0000-000000000001"   # Ana y Bruno
GRUPO = "eeeeeeee-0000-0000-0000-000000000002"  # Ana, Bruno y Carla

SECRETO = "el resultado de la biopsia es negativo"


@pytest_asyncio.fixture
async def entorno():
    cache.vaciar()
    esquema.olvidar()
    esquema_mensajes.olvidar()

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

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana Pérez", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(Profile(id=CARLA, full_name="", username="carla"))
        db.add(Conversation(id=CHAT, kind="direct", created_by=ANA))
        db.add(ConversationMember(conversation_id=CHAT, user_id=ANA))
        db.add(ConversationMember(conversation_id=CHAT, user_id=BRUNO))
        db.add(Conversation(id=GRUPO, kind="group", created_by=ANA))
        for miembro in (ANA, BRUNO, CARLA):
            db.add(ConversationMember(conversation_id=GRUPO, user_id=miembro))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad

    app.dependency_overrides.clear()
    await engine.dispose()


@pytest.fixture
def pushes(monkeypatch):
    """Retiene los push en vez de mandarlos.

    Se parchea en el router de mensajes porque lo importó por nombre: cambiar
    el original no tendría efecto.
    """
    capturados: list[dict] = []

    def _retener(background, **kwargs):
        capturados.append(kwargs)

    monkeypatch.setattr(messaging_router, "encolar_push", _retener)
    return capturados


async def _enviar(http, chat: str = CHAT, texto: str = "hola") -> None:
    respuesta = await http.post(f"{API}/{chat}/messages", json={"body": texto})
    assert respuesta.status_code == 201, respuesta.text


# --------------------------------------------------------------------------- #
# 1. A quién
# --------------------------------------------------------------------------- #
async def test_el_mensaje_avisa_a_quien_lo_recibe_y_no_a_quien_lo_escribe(entorno, pushes):
    http, _, _ = entorno
    await _enviar(http)

    assert len(pushes) == 1
    assert pushes[0]["user_ids"] == [BRUNO]
    assert ANA not in pushes[0]["user_ids"]
    assert pushes[0]["notification_type"] == "message"


async def test_en_un_grupo_se_avisa_a_todos_los_demas(entorno, pushes):
    http, _, _ = entorno
    await _enviar(http, GRUPO)

    assert sorted(pushes[0]["user_ids"]) == sorted([BRUNO, CARLA])


async def test_quien_bloqueo_a_quien_escribe_no_recibe_el_aviso(entorno, pushes):
    """El push no puede ser la puerta trasera para llegar a quien te bloqueó."""
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=BRUNO, blocked_id=ANA))
        await db.commit()

    await _enviar(http)

    assert pushes[0]["user_ids"] == []
    # El mensaje se guarda igual: el bloqueo corta el aviso, no la conversación.
    async with sesiones() as db:
        guardados = list(await db.scalars(select(Message).where(Message.conversation_id == CHAT)))
    assert len(guardados) == 1


async def test_el_bloqueo_corta_tambien_en_el_otro_sentido(entorno, pushes):
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=ANA, blocked_id=BRUNO))
        await db.commit()

    await _enviar(http)

    assert pushes[0]["user_ids"] == []


async def test_en_un_grupo_el_bloqueo_solo_quita_a_esa_persona(entorno, pushes):
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=CARLA, blocked_id=ANA))
        await db.commit()

    await _enviar(http, GRUPO)

    assert pushes[0]["user_ids"] == [BRUNO]


# --------------------------------------------------------------------------- #
# 2. Qué dice y qué viaja
# --------------------------------------------------------------------------- #
async def test_el_aviso_dice_quien_escribe_y_nunca_que_escribio(entorno, pushes):
    http, _, _ = entorno
    await _enviar(http, texto=SECRETO)

    aviso = pushes[0]
    assert aviso["actor_name"] == "Ana Pérez"
    # Ni en los datos ni en el texto que se va a mandar.
    assert SECRETO not in str(aviso)
    titulo, cuerpo = push.build_message("message", aviso["actor_name"])
    assert "Ana Pérez" in cuerpo
    assert SECRETO not in titulo + cuerpo


async def test_sin_nombre_se_usa_el_usuario(entorno, pushes):
    http, _, identidad = entorno
    identidad["uid"] = CARLA
    await _enviar(http, GRUPO)

    assert pushes[0]["actor_name"] == "carla"


async def test_los_datos_son_un_tipo_y_un_identificador_y_ninguna_ruta(entorno, pushes):
    http, _, _ = entorno
    await _enviar(http)

    assert pushes[0]["data"] == {"type": "message", "conversationId": CHAT}
    # Nada que el teléfono tenga que creerse como destino.
    for clave in ("url", "route", "ruta", "path", "href", "token"):
        assert clave not in pushes[0]["data"]


async def test_el_aviso_de_mensaje_sale_por_su_canal():
    assert push.CHANNELS["message"] == "mensajes"
    assert push.build_message("message", None) == ("Nuevo mensaje", "Alguien te envió un mensaje.")


# --------------------------------------------------------------------------- #
# 3. Lo que no hace
# --------------------------------------------------------------------------- #
async def test_un_mensaje_no_escribe_en_la_bandeja_de_notificaciones(entorno, pushes):
    """Un mensaje vive en Mensajes. En la bandeja sería el mismo aviso dos veces."""
    http, sesiones, _ = entorno
    await _enviar(http)
    await _enviar(http, texto="¿estás?")

    async with sesiones() as db:
        filas = list(await db.scalars(select(Notification)))
    assert filas == []
    assert len(pushes) == 2, "pero cada mensaje sí avisa"


async def test_si_falla_el_aviso_el_mensaje_se_guarda_igual(entorno, monkeypatch):
    http, sesiones, _ = entorno

    async def _reventar(*args, **kwargs):
        raise RuntimeError("la consulta de destinatarios falló")

    monkeypatch.setattr(avisos, "destinatarios", _reventar)

    respuesta = await http.post(f"{API}/{CHAT}/messages", json={"body": "hola"})

    assert respuesta.status_code == 201
    async with sesiones() as db:
        guardados = list(await db.scalars(select(Message).where(Message.conversation_id == CHAT)))
    assert len(guardados) == 1


async def test_quien_no_es_miembro_ni_escribe_ni_hace_sonar_nada(entorno, pushes):
    http, _, identidad = entorno
    identidad["uid"] = CARLA  # no está en CHAT

    respuesta = await http.post(f"{API}/{CHAT}/messages", json={"body": "hola"})

    assert respuesta.status_code == 403
    assert pushes == []


# --------------------------------------------------------------------------- #
# 4. Los teléfonos que ya no existen
# --------------------------------------------------------------------------- #
def _lote(*tokens: str) -> list[dict]:
    return [{"to": token, "title": "t", "body": "b"} for token in tokens]


async def test_un_token_que_expo_da_por_muerto_se_reconoce():
    cuerpo = {
        "data": [
            {"status": "ok", "id": "1"},
            {"status": "error", "message": "x", "details": {"error": "DeviceNotRegistered"}},
        ]
    }
    assert push.tokens_muertos(_lote("vivo", "muerto"), cuerpo) == ["muerto"]


async def test_otros_errores_no_borran_el_token():
    """Un límite de envíos no dice nada del teléfono: borrarlo lo dejaría sin avisos."""
    cuerpo = {
        "data": [
            {"status": "error", "details": {"error": "MessageRateExceeded"}},
            {"status": "error", "details": {"error": "InvalidCredentials"}},
            {"status": "error"},
        ]
    }
    assert push.tokens_muertos(_lote("a", "b", "c"), cuerpo) == []


async def test_sin_correspondencia_uno_a_uno_no_se_borra_nada():
    cuerpo = {"data": [{"status": "error", "details": {"error": "DeviceNotRegistered"}}]}
    assert push.tokens_muertos(_lote("a", "b"), cuerpo) == []


@pytest.mark.parametrize("cuerpo", [None, [], "no es json", {"errors": []}, {"data": "x"}])
async def test_un_cuerpo_que_no_se_entiende_no_borra_nada(cuerpo):
    assert push.tokens_muertos(_lote("a"), cuerpo) == []


async def test_olvidar_sin_tokens_no_abre_ninguna_sesion(monkeypatch):
    def _no_deberia():
        raise AssertionError("no hay nada que borrar: no se abre sesión")

    monkeypatch.setattr(push, "SessionLocal", _no_deberia)
    await push.olvidar_tokens([])


async def test_olvidar_nunca_lanza(monkeypatch):
    def _roto():
        raise RuntimeError("sin base de datos")

    monkeypatch.setattr(push, "SessionLocal", _roto)
    await push.olvidar_tokens(["ExponentPushToken[x]"])
