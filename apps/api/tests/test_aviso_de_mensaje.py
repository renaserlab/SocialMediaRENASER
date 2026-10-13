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
from datetime import datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.messaging import avisos
from app.modules.messaging import esquema as esquema_mensajes
from app.modules.messaging import router as messaging_router
from app.modules.messaging.models import (
    Conversation,
    ConversationMember,
    Message,
    MessageAttachment,
)
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
async def test_el_aviso_dice_quien_escribe_y_que_escribio(entorno, pushes):
    """Decidido el 13/10/2026, como en WhatsApp: el aviso lleva el texto.

    Hasta entonces decía «Ana te envió un mensaje» y nada más, y en el teléfono
    eran casillas iguales, una por mensaje, sin saber qué se había escrito.
    """
    http, _, _ = entorno
    await _enviar(http, texto=SECRETO)

    aviso = pushes[0]
    assert aviso["actor_name"] == "Ana Pérez"
    # A quien lo recibe: de quién es, y qué dice.
    assert aviso["personales"] == {BRUNO: ("Ana Pérez", SECRETO)}
    # En los DATOS sigue sin viajar: son identificadores para abrir el chat.
    assert SECRETO not in str(aviso["data"])
    # Y el texto de reserva, por si no se pudo armar, sigue sin llevarlo.
    titulo, cuerpo = push.build_message("message", aviso["actor_name"])
    assert SECRETO not in titulo + cuerpo


async def test_sin_nombre_se_usa_el_usuario(entorno, pushes):
    http, _, identidad = entorno
    identidad["uid"] = CARLA
    await _enviar(http, GRUPO)

    assert pushes[0]["actor_name"] == "carla"


async def test_los_datos_son_un_tipo_y_dos_identificadores_y_ninguna_ruta(entorno, pushes):
    http, sesiones, _ = entorno
    await _enviar(http)

    async with sesiones() as db:
        mensaje = (await db.scalars(select(Message).where(Message.conversation_id == CHAT))).one()
    # El del mensaje es lo que permite a la aplicación no avisar dos veces del
    # mismo (llega en tiempo real y por push). Un UUID: no dice nada de él.
    assert pushes[0]["data"] == {
        "type": "message",
        "conversationId": CHAT,
        "messageId": str(mensaje.id),
    }
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


# --------------------------------------------------------------------------- #
# 5. El envío no retiene una conexión mientras habla con Expo
# --------------------------------------------------------------------------- #
async def test_la_sesion_ya_esta_cerrada_cuando_se_habla_con_expo(monkeypatch):
    """El pool son 5+5 conexiones: un aviso lento no puede quedarse con una.

    Desde que cada mensaje manda un push, diez a la vez con Expo lento agotaban
    el pool y se paraba la API entera.
    """
    orden: list[str] = []

    class _SesionDeMentira:
        async def __aenter__(self):
            orden.append("abre")
            return self

        async def __aexit__(self, *exc):
            orden.append("cierra")
            return False

    async def _tokens(db, user_ids):
        orden.append("lee tokens")
        return ["ExponentPushToken[uno]"]

    async def _enviar(tokens, **kwargs):
        orden.append("habla con Expo")
        assert tokens == ["ExponentPushToken[uno]"]
        assert kwargs["channel"] == "mensajes"

    monkeypatch.setattr(push, "SessionLocal", _SesionDeMentira)
    monkeypatch.setattr(push, "_leer_tokens", _tokens)
    monkeypatch.setattr(push, "_enviar_a", _enviar)

    await push._enviar_con_sesion_propia([BRUNO], "message", "Ana", {"type": "message"})

    assert orden == ["abre", "lee tokens", "cierra", "habla con Expo"]


async def test_sin_texto_para_el_tipo_ni_siquiera_se_abre_sesion(monkeypatch):
    def _no_deberia():
        raise AssertionError("un tipo sin plantilla no tiene nada que mandar")

    monkeypatch.setattr(push, "SessionLocal", _no_deberia)
    await push._enviar_con_sesion_propia([BRUNO], "tipo_que_no_existe", None, None)


async def test_sin_aparatos_registrados_no_se_llama_a_expo(monkeypatch):
    class _Cliente:
        def __init__(self, *a, **k):
            raise AssertionError("no hay a quién mandar: no se abre conexión con Expo")

    monkeypatch.setattr(push.httpx, "AsyncClient", _Cliente)
    await push._enviar_a([], title="t", body="b", channel="mensajes", data=None)


# --------------------------------------------------------------------------- #
# 6. Un aviso que no sale deja rastro de por qué
# --------------------------------------------------------------------------- #
async def test_los_rechazos_de_expo_se_cuentan_por_motivo_y_sin_el_token():
    """Reportado el 05/10/2026: «a mí sí me llegan, a otro usuario no».

    Sin esto no había forma de saber, mirando los registros, si Expo estaba
    rechazando los envíos. El texto del error trae el token dentro: no se usa.
    """
    cuerpo = {
        "data": [
            {"status": "ok", "id": "1"},
            {
                "status": "error",
                "message": '"ExponentPushToken[secreto]" is not a registered push notification recipient',
                "details": {"error": "DeviceNotRegistered"},
            },
            {"status": "error", "details": {"error": "InvalidCredentials"}},
            {"status": "error", "details": {"error": "InvalidCredentials"}},
            {"status": "error", "message": "algo que no trae código"},
        ]
    }
    motivos = push.motivos_de_rechazo(cuerpo)
    assert motivos == {"DeviceNotRegistered": 1, "InvalidCredentials": 2, "desconocido": 1}
    assert "secreto" not in repr(motivos)


@pytest.mark.parametrize(
    "cuerpo", [None, [], "no es json", {"errors": []}, {"data": "x"}, {"data": [{"status": "ok"}]}]
)
async def test_sin_rechazos_no_hay_nada_que_contar(cuerpo):
    assert push.motivos_de_rechazo(cuerpo) == {}


async def test_un_envio_rechazado_se_registra_con_el_motivo_y_sin_el_token(monkeypatch, caplog):
    class _Respuesta:
        def raise_for_status(self):
            return None

        def json(self):
            return {"data": [{"status": "error", "details": {"error": "InvalidCredentials"}}]}

    class _Cliente:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json):
            return _Respuesta()

    monkeypatch.setattr(push.httpx, "AsyncClient", _Cliente)
    with caplog.at_level("WARNING", logger=push.logger.name):
        await push._enviar_a(
            ["ExponentPushToken[secreto]"], title="t", body="b", channel="mensajes", data=None
        )
    registro = " ".join(r.getMessage() for r in caplog.records)
    assert "InvalidCredentials×1" in registro
    assert "rechazó 1 de 1" in registro
    assert "secreto" not in registro


async def test_sin_aparato_registrado_se_dice_cuantos_y_no_quienes(monkeypatch, caplog):
    class _Sesion:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    async def _sin_tokens(db, user_ids):
        return []

    monkeypatch.setattr(push, "SessionLocal", _Sesion)
    monkeypatch.setattr(push, "_leer_tokens", _sin_tokens)
    with caplog.at_level("INFO", logger=push.logger.name):
        await push._enviar_con_sesion_propia([BRUNO], "message", "Ana", {"type": "message"})
    registro = " ".join(r.getMessage() for r in caplog.records)
    assert "message: 1 destinatario(s) sin ningún aparato registrado" in registro
    assert BRUNO not in registro


# --------------------------------------------------------------------------- #
# UNA CASILLA POR CONVERSACIÓN, CON LO QUE HAY SIN LEER (13/10/2026)
# --------------------------------------------------------------------------- #
async def _leyo_hasta_ahora(sesiones, persona: str, chat: str = CHAT) -> None:
    """Esa persona abre el chat: su marca de lectura queda después de todo."""
    async with sesiones() as db:
        await db.execute(
            update(ConversationMember)
            .where(
                ConversationMember.conversation_id == chat,
                ConversationMember.user_id == persona,
            )
            .values(last_read_at=datetime.utcnow() + timedelta(seconds=5))
        )
        await db.commit()


async def _enviar_fechado(http, sesiones, puesto: int, chat: str = CHAT, texto: str = "hola") -> None:
    """Envía un mensaje y lo deja fechado en su puesto, en el pasado.

    SQLite guarda la hora con segundos: varios mensajes mandados seguidos en
    una prueba empatan, y el orden entre ellos no estaría definido. En
    PostgreSQL la hora lleva microsegundos y no hace falta.
    """
    respuesta = await http.post(f"{API}/{chat}/messages", json={"body": texto})
    assert respuesta.status_code == 201, respuesta.text
    async with sesiones() as db:
        await db.execute(
            update(Message)
            .where(Message.id == respuesta.json()["id"])
            .values(created_at=datetime.utcnow() - timedelta(hours=1) + timedelta(minutes=puesto))
        )
        await db.commit()


async def test_cada_conversacion_tiene_su_etiqueta_y_siempre_la_misma(entorno, pushes):
    http, _, _ = entorno
    await _enviar(http, texto="uno")
    await _enviar(http, texto="dos")
    await _enviar(http, GRUPO, texto="al grupo")

    # Con la misma etiqueta el teléfono reemplaza el aviso en vez de sumar otro.
    assert pushes[0]["etiqueta"] == pushes[1]["etiqueta"] == f"chat-{CHAT}"
    # Otra conversación, otra casilla.
    assert pushes[2]["etiqueta"] == f"chat-{GRUPO}"
    assert pushes[2]["etiqueta"] != pushes[0]["etiqueta"]


async def test_los_mensajes_sin_leer_se_acumulan_en_el_mismo_aviso(entorno, pushes):
    http, sesiones, _ = entorno
    await _enviar_fechado(http, sesiones, 1, texto="Hola")
    await _enviar_fechado(http, sesiones, 2, texto="¿Estás?")
    await _enviar_fechado(http, sesiones, 3, texto="Te mandé el archivo")

    assert pushes[0]["personales"][BRUNO] == ("Ana Pérez", "Hola")
    assert pushes[1]["personales"][BRUNO] == ("Ana Pérez (2 mensajes)", "Hola\n¿Estás?")
    assert pushes[2]["personales"][BRUNO] == (
        "Ana Pérez (3 mensajes)",
        "Hola\n¿Estás?\nTe mandé el archivo",
    )


async def test_lo_que_ya_se_leyo_no_vuelve_a_salir(entorno, pushes):
    http, sesiones, _ = entorno
    await _enviar(http, texto="viejo uno")
    await _enviar(http, texto="viejo dos")
    await _leyo_hasta_ahora(sesiones, BRUNO)
    # El reloj de la base tiene que pasar de la marca de lectura.
    async with sesiones() as db:
        await db.execute(
            update(ConversationMember)
            .where(ConversationMember.conversation_id == CHAT, ConversationMember.user_id == BRUNO)
            .values(last_read_at=datetime.utcnow() - timedelta(seconds=1))
        )
        await db.execute(
            update(Message)
            .where(Message.conversation_id == CHAT)
            .values(created_at=datetime.utcnow() - timedelta(minutes=5))
        )
        await db.commit()

    await _enviar(http, texto="nuevo")

    assert pushes[-1]["personales"][BRUNO] == ("Ana Pérez", "nuevo")


async def test_en_un_grupo_cada_linea_dice_quien_y_el_titulo_es_el_grupo(entorno, pushes):
    http, sesiones, identidad = entorno
    async with sesiones() as db:
        await db.execute(update(Conversation).where(Conversation.id == GRUPO).values(title="Talento"))
        await db.commit()

    await _enviar_fechado(http, sesiones, 1, GRUPO, texto="Reunión a las 5")
    identidad["uid"] = CARLA
    await _enviar_fechado(http, sesiones, 2, GRUPO, texto="Voy")

    # A Bruno le escribieron Ana y Carla; Carla no tiene nombre y sale su usuario.
    assert pushes[1]["personales"][BRUNO] == (
        "Talento (2 mensajes)",
        "Ana: Reunión a las 5\ncarla: Voy",
    )
    # A Ana, lo suyo no: solo lo que escribió Carla.
    assert pushes[1]["personales"][ANA] == ("Talento", "carla: Voy")
    # Nadie se avisa a sí mismo.
    assert CARLA not in pushes[1]["personales"]


async def test_un_grupo_sin_nombre_no_deja_el_titulo_vacio(entorno, pushes):
    http, _, _ = entorno
    await _enviar(http, GRUPO, texto="hola")
    assert pushes[0]["personales"][BRUNO][0] == "Grupo"


async def test_a_cada_quien_lo_que_tiene_sin_leer_y_no_lo_del_otro(entorno, pushes):
    http, sesiones, _ = entorno
    await _enviar(http, GRUPO, texto="primero")
    # Bruno abre el grupo; Carla, no.
    async with sesiones() as db:
        await db.execute(
            update(Message)
            .where(Message.conversation_id == GRUPO)
            .values(created_at=datetime.utcnow() - timedelta(minutes=5))
        )
        await db.execute(
            update(ConversationMember)
            .where(ConversationMember.conversation_id == GRUPO, ConversationMember.user_id == BRUNO)
            .values(last_read_at=datetime.utcnow() - timedelta(seconds=1))
        )
        await db.commit()

    await _enviar(http, GRUPO, texto="segundo")

    assert pushes[-1]["personales"][BRUNO][1] == "Ana: segundo"
    assert pushes[-1]["personales"][CARLA][1] == "Ana: primero\nAna: segundo"


async def test_con_muchos_sin_leer_salen_los_ultimos_y_se_dice_cuantos_quedan_fuera(entorno, pushes):
    http, sesiones, _ = entorno
    for numero in range(1, 10):
        await _enviar_fechado(http, sesiones, numero, texto=f"mensaje {numero}")

    titulo, cuerpo = pushes[-1]["personales"][BRUNO]
    assert titulo == "Ana Pérez (9 mensajes)"
    lineas = cuerpo.split("\n")
    assert lineas[0] == "… y 3 anteriores"
    assert lineas[1:] == [f"mensaje {n}" for n in range(4, 10)]
    assert len(lineas) == avisos.MENSAJES_EN_EL_AVISO + 1


async def test_un_mensaje_borrado_no_sale_en_el_aviso(entorno, pushes):
    http, sesiones, _ = entorno
    await _enviar(http, texto="me arrepentí")
    async with sesiones() as db:
        await db.execute(
            update(Message).where(Message.conversation_id == CHAT).values(deleted_at=datetime.utcnow())
        )
        await db.commit()

    await _enviar(http, texto="mejor esto")

    assert pushes[-1]["personales"][BRUNO] == ("Ana Pérez", "mejor esto")


async def test_una_foto_se_dice_foto_y_nunca_el_nombre_del_archivo(entorno, pushes):
    http, sesiones, _ = entorno
    foto = "ffffffff-0000-0000-0000-000000000001"
    async with sesiones() as db:
        db.add(Message(id=foto, conversation_id=CHAT, sender_id=ANA, body=""))
        db.add(
            MessageAttachment(
                message_id=foto,
                conversation_id=CHAT,
                storage_path=f"{CHAT}/informe-medico-confidencial.jpg",
                kind="image",
                file_name="informe-medico-confidencial.jpg",
            )
        )
        await db.commit()

    textos = None
    async with sesiones() as db:
        textos = await avisos.textos_para(
            db, conversation_id=CHAT, destinatarios=[BRUNO], grupo=None, remitente="Ana Pérez"
        )

    assert textos[BRUNO] == ("Ana Pérez", "📷 Foto")
    assert "informe" not in str(textos)


async def test_el_texto_va_en_una_linea_y_no_se_pasa_de_largo():
    assert avisos.en_una_linea("  hola\n\nqué   tal  ") == "hola qué tal"
    largo = avisos.en_una_linea("a" * 500)
    assert len(largo) == avisos.LARGO_DE_UN_MENSAJE
    assert largo.endswith("…")
    assert avisos.en_una_linea(None) == ""


async def test_sin_nada_sin_leer_no_hay_texto_propio_y_sale_el_de_reserva():
    assert avisos.componer([], grupo=None, remitente="Ana") is None
    # Sin nombre de quien escribe, el título no queda vacío.
    assert avisos.componer([(None, "hola")], grupo=None, remitente=None) == ("Nuevo mensaje", "hola")


async def test_armar_el_texto_nunca_tumba_el_aviso():
    class _BaseRota:
        async def execute(self, *_a, **_k):
            raise RuntimeError("sin base")

    textos = await avisos.textos_para(
        _BaseRota(), conversation_id=CHAT, destinatarios=[BRUNO], grupo=None, remitente="Ana"
    )
    assert textos == {}
    assert await avisos.textos_para(
        _BaseRota(), conversation_id=CHAT, destinatarios=[], grupo=None, remitente="Ana"
    ) == {}


async def test_cada_aparato_recibe_el_texto_de_su_dueno_y_la_etiqueta():
    mensajes = push.mensajes_personales(
        [(BRUNO, "ExponentPushToken[b1]"), (BRUNO, "ExponentPushToken[b2]"), (CARLA, "ExponentPushToken[c1]")],
        de_reserva=("Nuevo mensaje", "Ana te envió un mensaje."),
        personales={BRUNO: ("Ana (2 mensajes)", "Hola\n¿Estás?")},
        channel="mensajes",
        data={"type": "message", "conversationId": CHAT},
        etiqueta=f"chat-{CHAT}",
    )

    assert [m["to"] for m in mensajes] == [
        "ExponentPushToken[b1]",
        "ExponentPushToken[b2]",
        "ExponentPushToken[c1]",
    ]
    # Los dos teléfonos de Bruno, lo de Bruno.
    assert mensajes[0]["title"] == mensajes[1]["title"] == "Ana (2 mensajes)"
    assert mensajes[0]["body"] == "Hola\n¿Estás?"
    # Carla no tenía texto propio: le llega el de reserva.
    assert (mensajes[2]["title"], mensajes[2]["body"]) == ("Nuevo mensaje", "Ana te envió un mensaje.")
    # Todos con la etiqueta de la conversación, el canal y los datos de siempre.
    for mensaje in mensajes:
        assert mensaje["tag"] == f"chat-{CHAT}"
        assert mensaje["channelId"] == push.canal_android("mensajes")
        assert mensaje["priority"] == "high"
        assert mensaje["data"] == {"type": "message", "conversationId": CHAT}


async def test_sin_etiqueta_el_mensaje_no_lleva_ese_campo():
    (mensaje,) = push.mensajes_personales(
        [(BRUNO, "ExponentPushToken[b1]")],
        de_reserva=("t", "c"),
        personales={},
        channel="mensajes",
        data=None,
        etiqueta=None,
    )
    assert "tag" not in mensaje
    assert mensaje["data"] == {}


async def test_el_envio_personal_suelta_la_base_antes_de_hablar_con_expo(monkeypatch):
    pasos: list[str] = []

    class _Sesion:
        async def __aenter__(self):
            pasos.append("abre")
            return self

        async def __aexit__(self, *_a):
            pasos.append("cierra")

    async def _aparatos(_db, user_ids):
        pasos.append("lee")
        return [(BRUNO, "ExponentPushToken[b1]")]

    enviados: list[list[dict]] = []

    async def _lotes(mensajes):
        pasos.append("envia")
        enviados.append(mensajes)

    monkeypatch.setattr(push, "SessionLocal", lambda: _Sesion())
    monkeypatch.setattr(push, "_leer_tokens_por_persona", _aparatos)
    monkeypatch.setattr(push, "_enviar_lotes", _lotes)

    await push._enviar_con_sesion_propia(
        [BRUNO],
        "message",
        "Ana",
        {"type": "message"},
        None,
        {BRUNO: ("Ana", "hola")},
        f"chat-{CHAT}",
    )

    assert pasos == ["abre", "lee", "cierra", "envia"]
    assert enviados[0][0]["body"] == "hola"
    assert enviados[0][0]["tag"] == f"chat-{CHAT}"


async def test_los_demas_avisos_siguen_saliendo_igual_para_todos(monkeypatch):
    """Un «me gusta» no es personal ni lleva etiqueta: sale por el camino de siempre."""
    llamadas: list[str] = []

    class _Sesion:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_a):
            return None

    async def _tokens(_db, user_ids):
        llamadas.append("tokens")
        return ["ExponentPushToken[b1]"]

    async def _enviar_a(tokens, **kwargs):
        llamadas.append("igual-para-todos")
        assert kwargs["title"] == "Nueva reacción"

    async def _personales(*_a, **_k):
        raise AssertionError("un aviso sin texto propio no pregunta de quién es cada aparato")

    monkeypatch.setattr(push, "SessionLocal", lambda: _Sesion())
    monkeypatch.setattr(push, "_leer_tokens", _tokens)
    monkeypatch.setattr(push, "_enviar_a", _enviar_a)
    monkeypatch.setattr(push, "_leer_tokens_por_persona", _personales)

    await push._enviar_con_sesion_propia([BRUNO], "like", "Ana", None)

    assert llamadas == ["tokens", "igual-para-todos"]
