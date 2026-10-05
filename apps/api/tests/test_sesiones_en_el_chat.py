"""Una sesión 1:1 vive en el chat: se pide, se responde y queda escrito ahí.

LO REPORTADO (04/10/2026). «No hubo manera de aceptar la solicitud de esa
sesión estando en mensajes… debería aparecer como una opción de botón en
mensajes y que aparezca también si acepté o no. Eso también debe quedar
registrado ahí».

Lo que se fija:

  * Pedir una sesión deja UN mensaje en el chat de las dos partes, escrito por
    el servidor, que sabe de qué sesión habla.
  * Ese mensaje dice a cada quien su papel: a quien se la piden, `provider`
    —es quien ve «Aceptar»—; a quien la pidió, `requester`.
  * Responder deja OTRO mensaje, de quien respondió: el registro.
  * El estado no se copia en el mensaje: la solicitud vieja lee el de hoy.
  * Un toque repetido no escribe dos veces ni hace sonar dos veces.
  * El registro no se borra.
  * Sin la 0097 nada falla: queda el texto.
  * Si el chat falla, la sesión se guarda igual.

SQLite en memoria. El push no sale: se retiene lo que se habría programado.
"""

from __future__ import annotations

import importlib
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.bookings.models import Booking
from app.modules.messaging import esquema as esquema_de_mensajes
from app.modules.messaging import sesiones
from app.modules.messaging.models import Message, MessageBookingContext
from app.modules.notifications import esquema as esquema_de_avisos
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

pytestmark = pytest.mark.asyncio

bookings_router = importlib.import_module("app.modules.bookings.router")

RESERVAS = "/api/v1/bookings"
CHATS = "/api/v1/conversations"

ANA = "cdcdcdcd-0000-0000-0000-000000000001"   # a quien se la piden
LUIS = "cdcdcdcd-0000-0000-0000-000000000002"  # quien la pide
EVA = "cdcdcdcd-0000-0000-0000-000000000003"   # no pinta nada aquí


def _manana() -> str:
    return (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()


def codigo(respuesta) -> str:
    return respuesta.json()["error"]["code"]


async def _levantar(sin_la_0097: bool = False):
    cache.vaciar()
    esquema.olvidar()
    esquema_de_avisos.olvidar()
    esquema_de_mensajes.olvidar()

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
        from app.modules.recommendations import models as _r  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)
        if sin_la_0097:
            await conn.run_sync(lambda c: MessageBookingContext.__table__.drop(c))

    fabrica = async_sessionmaker(engine, expire_on_commit=False)
    async with fabrica() as db:
        db.add_all(
            [
                Profile(id=ANA, full_name="Ana Torres", username="ana"),
                Profile(id=LUIS, full_name="Luis Ramos", username="luis"),
                Profile(id=EVA, full_name="Eva Soler", username="eva"),
            ]
        )
        await db.commit()
    return engine, fabrica


async def _entorno(sin_la_0097: bool = False):
    engine, fabrica = await _levantar(sin_la_0097)
    identidad = {"uid": LUIS}

    async def _db_override():
        async with fabrica() as session:
            yield session

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="quien@ejemplo.com", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    app.dependency_overrides[get_optional_user] = _usuario_override
    return engine, fabrica, identidad


async def _cerrar(engine) -> None:
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    await engine.dispose()
    esquema.olvidar()
    esquema_de_avisos.olvidar()
    esquema_de_mensajes.olvidar()


@pytest_asyncio.fixture
async def entorno():
    engine, fabrica, identidad = await _entorno()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, fabrica, identidad
    await _cerrar(engine)


@pytest_asyncio.fixture
async def entorno_sin_la_0097():
    engine, fabrica, identidad = await _entorno(sin_la_0097=True)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, fabrica, identidad
    await _cerrar(engine)


@pytest.fixture
def pushes(monkeypatch):
    capturados: list[dict] = []

    def _retener(background, **kwargs):
        capturados.append(kwargs)

    monkeypatch.setattr(bookings_router, "encolar_push", _retener)
    return capturados


async def _pedir(http, identidad, tema: str = "Mi portafolio") -> dict:
    identidad["uid"] = LUIS
    respuesta = await http.post(
        RESERVAS,
        json={
            "provider_id": ANA,
            "topic": tema,
            "scheduled_at": _manana(),
            "timezone": "America/Lima",
        },
    )
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()


async def _responder(http, identidad, quien: str, sesion_id: str, estado: str):
    identidad["uid"] = quien
    return await http.patch(f"{RESERVAS}/{sesion_id}", json={"status": estado})


async def _mensajes(http, identidad, quien: str, conversacion: str) -> list[dict]:
    identidad["uid"] = quien
    respuesta = await http.get(f"{CHATS}/{conversacion}/messages")
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


def _hechos(mensajes: list[dict]) -> list[str]:
    """Los hechos que cuenta el chat, SIN fiarse del orden.

    En SQLite `created_at` tiene resolución de un segundo: dos mensajes
    escritos en el mismo segundo empatan y los desempata un identificador
    aleatorio. En PostgreSQL no ocurre (microsegundos), pero aquí una prueba
    que dependa del orden fallaría una de cada dos veces.
    """
    return sorted(m["booking_context"]["event"] for m in mensajes)


def _el_de(mensajes: list[dict], hecho: str) -> dict:
    return next(m for m in mensajes if (m["booking_context"] or {}).get("event") == hecho)


# --------------------------------------------------------------------------- #
# 1. Pedirla la deja en el chat
# --------------------------------------------------------------------------- #


async def test_pedir_una_sesion_deja_la_solicitud_en_el_chat_de_los_dos(entorno, pushes):
    http, _, identidad = entorno
    sesion = await _pedir(http, identidad)

    # La sesión sabe en qué conversación vive: es lo que le dice al móvil que
    # el mensaje ya está escrito y no tiene que mandar otro.
    assert sesion["conversation_id"], "la sesión no apunta a ninguna conversación"

    mensajes = await _mensajes(http, identidad, ANA, sesion["conversation_id"])
    assert len(mensajes) == 1, [m["body"] for m in mensajes]
    solicitud = mensajes[0]
    assert solicitud["sender"]["id"] == LUIS, "la solicitud la firma quien la pide"
    contexto = solicitud["booking_context"]
    assert contexto is not None, "el mensaje no sabe de qué sesión habla"
    assert contexto["booking_id"] == sesion["id"]
    assert contexto["event"] == "requested"
    assert contexto["status"] == "pending"
    assert contexto["topic"] == "Mi portafolio"


async def test_cada_quien_lee_su_papel_y_de_ahi_salen_sus_botones(entorno, pushes):
    http, _, identidad = entorno
    sesion = await _pedir(http, identidad)
    conversacion = sesion["conversation_id"]

    # A Ana se la piden: es quien tiene que ver «Aceptar».
    de_ana = (await _mensajes(http, identidad, ANA, conversacion))[0]["booking_context"]
    assert de_ana["my_role"] == "provider"
    # Luis la pidió: no puede aceptársela a sí mismo.
    de_luis = (await _mensajes(http, identidad, LUIS, conversacion))[0]["booking_context"]
    assert de_luis["my_role"] == "requester"


async def test_el_texto_del_mensaje_se_entiende_sin_tarjeta(entorno, pushes):
    """Es lo que ve la bandeja y una aplicación que no conoce las tarjetas."""
    http, _, identidad = entorno
    sesion = await _pedir(http, identidad, tema="Revisar mi CV")
    cuerpo = (await _mensajes(http, identidad, ANA, sesion["conversation_id"]))[0]["body"]
    assert "Solicitud de sesión 1:1" in cuerpo
    assert "Revisar mi CV" in cuerpo
    assert "Fecha propuesta:" in cuerpo


async def test_la_conversacion_aparece_en_la_bandeja_de_quien_la_recibe(entorno, pushes):
    http, _, identidad = entorno
    sesion = await _pedir(http, identidad)
    identidad["uid"] = ANA
    bandeja = (await http.get(CHATS)).json()
    assert [c["id"] for c in bandeja] == [sesion["conversation_id"]]


# --------------------------------------------------------------------------- #
# 2. Responder queda registrado
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("estado", "quien", "frase"),
    [
        ("accepted", ANA, "Sesión aceptada"),
        ("rejected", ANA, "Solicitud de sesión rechazada"),
        ("cancelled", LUIS, "Sesión cancelada"),
    ],
)
async def test_responder_deja_otro_mensaje_de_quien_respondio(
    entorno, pushes, estado, quien, frase
):
    http, _, identidad = entorno
    sesion = await _pedir(http, identidad)
    respuesta = await _responder(http, identidad, quien, sesion["id"], estado)
    assert respuesta.status_code == 200, respuesta.text

    mensajes = await _mensajes(http, identidad, ANA, sesion["conversation_id"])
    assert _hechos(mensajes) == sorted(["requested", estado])
    registro = _el_de(mensajes, estado)
    assert registro["sender"]["id"] == quien, "el registro lo firma quien respondió"
    assert frase in registro["body"]


async def test_la_solicitud_vieja_lee_el_estado_de_hoy(entorno, pushes):
    """Es lo que apaga «Aceptar» en la tarjeta sin reescribir el mensaje."""
    http, _, identidad = entorno
    sesion = await _pedir(http, identidad)
    await _responder(http, identidad, ANA, sesion["id"], "accepted")

    mensajes = await _mensajes(http, identidad, ANA, sesion["conversation_id"])
    solicitud, registro = _el_de(mensajes, "requested"), _el_de(mensajes, "accepted")
    assert solicitud["booking_context"]["event"] == "requested"
    assert solicitud["booking_context"]["status"] == "accepted"
    assert registro["booking_context"]["status"] == "accepted"


async def test_aceptar_dos_veces_no_escribe_ni_suena_dos_veces(entorno, pushes):
    http, _, identidad = entorno
    sesion = await _pedir(http, identidad)
    primera = await _responder(http, identidad, ANA, sesion["id"], "accepted")
    assert primera.status_code == 200
    antes = len(pushes)

    segunda = await _responder(http, identidad, ANA, sesion["id"], "accepted")
    assert segunda.status_code == 422
    # Con código: el móvil vuelve a leer la sesión en vez de dejar un botón
    # que ya no vale.
    assert codigo(segunda) == "booking_transition_not_allowed"
    assert len(pushes) == antes, "el segundo toque ha vuelto a hacer sonar el teléfono"

    mensajes = await _mensajes(http, identidad, ANA, sesion["conversation_id"])
    assert _hechos(mensajes) == ["accepted", "requested"]


async def test_pedirla_otra_vez_mientras_espera_no_la_repite_en_el_chat(entorno, pushes):
    http, _, identidad = entorno
    primera = await _pedir(http, identidad)
    segunda = await _pedir(http, identidad)
    assert segunda["id"] == primera["id"]
    mensajes = await _mensajes(http, identidad, ANA, primera["conversation_id"])
    assert len(mensajes) == 1
    assert len(pushes) == 1


async def test_un_hecho_un_aviso_el_mensaje_no_manda_un_push_aparte(entorno, pushes, monkeypatch):
    """El push de la sesión ya dice lo que pasó. El del mensaje sobraría."""
    messaging_router = importlib.import_module("app.modules.messaging.router")
    de_mensajes: list[dict] = []
    monkeypatch.setattr(
        messaging_router, "encolar_push", lambda background, **k: de_mensajes.append(k)
    )
    http, _, identidad = entorno
    sesion = await _pedir(http, identidad)
    await _responder(http, identidad, ANA, sesion["id"], "accepted")

    assert [p["notification_type"] for p in pushes] == ["session_booked", "session_accepted"]
    assert [p["user_ids"] for p in pushes] == [[ANA], [LUIS]]
    assert de_mensajes == []


# --------------------------------------------------------------------------- #
# 3. El registro no se borra; un mensaje normal, sí
# --------------------------------------------------------------------------- #


async def test_el_registro_de_una_sesion_no_se_borra(entorno, pushes):
    http, fabrica, identidad = entorno
    sesion = await _pedir(http, identidad)
    conversacion = sesion["conversation_id"]
    solicitud = (await _mensajes(http, identidad, LUIS, conversacion))[0]

    identidad["uid"] = LUIS
    respuesta = await http.delete(f"{CHATS}/{conversacion}/messages/{solicitud['id']}")
    assert respuesta.status_code == 409, respuesta.text
    assert codigo(respuesta) == "message_is_booking_record"

    async with fabrica() as db:
        fila = await db.get(Message, solicitud["id"])
        assert fila is not None and fila.deleted_at is None


async def test_un_mensaje_normal_del_mismo_chat_se_sigue_pudiendo_borrar(entorno, pushes):
    http, _, identidad = entorno
    sesion = await _pedir(http, identidad)
    conversacion = sesion["conversation_id"]
    identidad["uid"] = LUIS
    enviado = await http.post(f"{CHATS}/{conversacion}/messages", json={"body": "¿Te va bien?"})
    assert enviado.status_code == 201, enviado.text
    borrado = await http.delete(f"{CHATS}/{conversacion}/messages/{enviado.json()['id']}")
    assert borrado.status_code == 204


# --------------------------------------------------------------------------- #
# 4. Lo que no puede tumbar la sesión
# --------------------------------------------------------------------------- #


async def test_sin_la_0097_queda_el_texto_y_nada_falla(entorno_sin_la_0097, pushes):
    http, _, identidad = entorno_sin_la_0097
    sesion = await _pedir(http, identidad)
    respuesta = await _responder(http, identidad, ANA, sesion["id"], "accepted")
    assert respuesta.status_code == 200, respuesta.text

    mensajes = await _mensajes(http, identidad, ANA, sesion["conversation_id"])
    assert [m["booking_context"] for m in mensajes] == [None, None]
    solicitud = next(m for m in mensajes if "Solicitud de sesión 1:1" in m["body"])
    assert any("Sesión aceptada" in m["body"] for m in mensajes)

    # Y sin la tabla, un mensaje de esos es un mensaje: se puede borrar.
    identidad["uid"] = LUIS
    borrado = await http.delete(
        f"{CHATS}/{sesion['conversation_id']}/messages/{solicitud['id']}"
    )
    assert borrado.status_code == 204


async def test_si_escribir_en_el_chat_falla_la_sesion_se_guarda_igual(
    entorno, pushes, monkeypatch
):
    async def _roto(*args, **kwargs):
        raise RuntimeError("el chat no está")

    monkeypatch.setattr(sesiones, "anotar", _roto)
    http, fabrica, identidad = entorno
    sesion = await _pedir(http, identidad)
    assert sesion["status"] == "pending"

    respuesta = await _responder(http, identidad, ANA, sesion["id"], "accepted")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["status"] == "accepted"
    # El aviso sale: es lo que queda cuando el chat no está.
    assert [p["notification_type"] for p in pushes] == ["session_booked", "session_accepted"]

    async with fabrica() as db:
        assert (await db.scalars(select(Message))).all() == []


async def test_una_sesion_de_antes_sin_conversacion_tambien_queda_registrada(entorno, pushes):
    """Las que se pidieron antes de este cambio no apuntan a ningún chat."""
    http, fabrica, identidad = entorno
    async with fabrica() as db:
        vieja = Booking(
            requester_id=LUIS, provider_id=ANA, topic="De antes", status="pending"
        )
        db.add(vieja)
        await db.commit()
        sesion_id = vieja.id

    respuesta = await _responder(http, identidad, ANA, sesion_id, "accepted")
    assert respuesta.status_code == 200, respuesta.text
    conversacion = respuesta.json()["conversation_id"]
    assert conversacion, "no se le ha buscado conversación"

    mensajes = await _mensajes(http, identidad, LUIS, conversacion)
    assert [m["booking_context"]["event"] for m in mensajes] == ["accepted"]
    assert mensajes[0]["sender"]["id"] == ANA


async def test_quien_no_participa_no_lee_la_conversacion(entorno, pushes):
    http, _, identidad = entorno
    sesion = await _pedir(http, identidad)
    identidad["uid"] = EVA
    respuesta = await http.get(f"{CHATS}/{sesion['conversation_id']}/messages")
    assert respuesta.status_code in (403, 404)


# --------------------------------------------------------------------------- #
# 5. La fecha del texto, en la zona de quien la propuso
# --------------------------------------------------------------------------- #


async def test_la_fecha_se_escribe_en_la_zona_de_quien_la_propuso():
    # Las 02:41 UTC del día 6 son las 21:41 del día 5 en Lima.
    momento = datetime(2026, 10, 6, 2, 41, tzinfo=timezone.utc)
    assert sesiones.fecha_legible(momento, "America/Lima") == "05/10/2026 a las 21:41"


async def test_sin_zona_conocida_se_escribe_en_utc_y_se_dice():
    momento = datetime(2026, 10, 6, 2, 41, tzinfo=timezone.utc)
    assert sesiones.fecha_legible(momento, None) == "06/10/2026 a las 02:41 (UTC)"
    assert sesiones.fecha_legible(momento, "No/Existe") == "06/10/2026 a las 02:41 (UTC)"
    assert sesiones.fecha_legible(None, "America/Lima") is None


async def test_un_hecho_desconocido_no_se_escribe(entorno):
    _, fabrica, _ = entorno
    async with fabrica() as db:
        reserva = Booking(requester_id=LUIS, provider_id=ANA, topic="x", status="pending")
        with pytest.raises(ValueError):
            await sesiones.anotar(
                db, conversation_id=ANA, sender_id=LUIS, reserva=reserva, evento="inventado"
            )


# --------------------------------------------------------------------------- #
# 6. Las sesiones de UNA conversación: lo que deja responder sin la tarjeta
# --------------------------------------------------------------------------- #


async def test_el_chat_puede_pedir_las_sesiones_que_viven_en_el(entorno, pushes):
    http, fabrica, identidad = entorno
    sesion = await _pedir(http, identidad)
    # Otra sesión de Ana, con otra persona y en otro chat: no tiene que salir.
    async with fabrica() as db:
        db.add(Booking(requester_id=EVA, provider_id=ANA, topic="Otra", status="pending"))
        await db.commit()

    identidad["uid"] = ANA
    respuesta = await http.get(RESERVAS, params={"conversation_id": sesion["conversation_id"]})
    assert respuesta.status_code == 200, respuesta.text
    assert [s["id"] for s in respuesta.json()] == [sesion["id"]]
    assert respuesta.json()[0]["my_role"] == "provider"
    # Sin el filtro siguen saliendo las dos.
    assert len((await http.get(RESERVAS)).json()) == 2


async def test_el_filtro_por_conversacion_no_abre_las_sesiones_de_otros(entorno, pushes):
    http, _, identidad = entorno
    sesion = await _pedir(http, identidad)
    identidad["uid"] = EVA
    respuesta = await http.get(RESERVAS, params={"conversation_id": sesion["conversation_id"]})
    assert respuesta.status_code == 200
    assert respuesta.json() == []


async def test_sin_la_0097_la_sesion_se_sigue_pudiendo_encontrar_por_su_chat(
    entorno_sin_la_0097, pushes
):
    """Es el camino que no necesita la migración: el chat pregunta a la agenda."""
    http, _, identidad = entorno_sin_la_0097
    sesion = await _pedir(http, identidad)
    identidad["uid"] = ANA
    del_chat = (
        await http.get(RESERVAS, params={"conversation_id": sesion["conversation_id"]})
    ).json()
    assert [s["status"] for s in del_chat] == ["pending"]

    await _responder(http, identidad, ANA, sesion["id"], "accepted")
    identidad["uid"] = LUIS
    del_chat = (
        await http.get(RESERVAS, params={"conversation_id": sesion["conversation_id"]})
    ).json()
    assert [s["status"] for s in del_chat] == ["accepted"]
    assert del_chat[0]["my_role"] == "requester"


async def test_un_identificador_de_conversacion_que_no_lo_es_no_revienta(entorno, pushes):
    http, _, identidad = entorno
    identidad["uid"] = ANA
    respuesta = await http.get(RESERVAS, params={"conversation_id": "no-es-un-uuid"})
    assert respuesta.status_code == 404
