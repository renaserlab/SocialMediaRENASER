"""Cada aviso dice QUIÉN y QUÉ, y un bloqueo lo calla.

LO PEDIDO (04/10/2026). «Vuelve a revisar si las notificaciones, tanto para
envío de mensajes como queriendo agendar una sesión, funcionan correctamente…
que le llegue indicando exactamente de qué es la notificación: ya sea de un
nuevo seguidor (indicando el usuario), o una reacción, o un mensaje».

El mensaje de chat ya está fijado en `test_aviso_de_mensaje.py`. Aquí se fija el
resto de lo que se pidió, que NO tenía ninguna prueba de servidor sobre el
push: seguir, reaccionar, comentar y la agenda. De cada uno:

  * A QUIÉN se manda.
  * EL TEXTO EXACTO que leerá en la pantalla bloqueada, con el nombre de quien
    lo provocó. Se compone con la misma función que usa el envío de verdad
    (`push.build_message`), no con una copia de la plantilla.
  * LO QUE VIAJA para abrir el destino: un tipo y un identificador, con las
    claves que entiende el mapa cerrado del móvil (`lib/rutaDelPush.ts`).
  * Que además queda en la bandeja.

Y lo que encontró la auditoría de ese mismo día: el bloqueo no cortaba seguir,
reaccionar ni comentar. Quien estaba bloqueado podía seguir haciéndolo por la
API y a quien le bloqueó le sonaba el teléfono con su nombre.

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
from app.modules.notifications import esquema as esquema_de_avisos
from app.modules.notifications import push
from app.modules.notifications.models import Notification
from app.modules.notifications.service import TIPOS_QUE_EL_BLOQUEO_CALLA
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.modules.social_graph.models import UserBlock
from app.shared.database import Base, get_db

pytestmark = pytest.mark.asyncio

# Los MODULOS, no el `router` que reexporta cada paquete: `encolar_push` se
# parchea donde se importo por nombre.
content_router = importlib.import_module("app.modules.content.router")
bookings_router = importlib.import_module("app.modules.bookings.router")
social_graph_router = importlib.import_module("app.modules.social_graph.router")

PERFILES = "/api/v1/profiles"
POSTS = "/api/v1/posts"
RESERVAS = "/api/v1/bookings"

ANA = "abababab-0000-0000-0000-000000000001"   # la dueña: recibe los avisos
LUIS = "abababab-0000-0000-0000-000000000002"  # quien los provoca
RITA = "abababab-0000-0000-0000-000000000003"  # sin nombre: solo usuario


def _manana() -> str:
    return (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()


@pytest_asyncio.fixture
async def entorno():
    cache.vaciar()
    esquema.olvidar()
    esquema_de_avisos.olvidar()

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

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add_all(
            [
                Profile(id=ANA, full_name="Ana Torres", username="ana"),
                Profile(id=LUIS, full_name="Luis Ramos", username="luis"),
                Profile(id=RITA, full_name="", username="rita"),
            ]
        )
        await db.commit()

    identidad = {"uid": LUIS}

    async def _db_override():
        async with sesiones() as session:
            yield session

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="quien@ejemplo.com", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    app.dependency_overrides[get_optional_user] = _usuario_override

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad

    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    await engine.dispose()
    esquema.olvidar()
    esquema_de_avisos.olvidar()


@pytest.fixture
def pushes(monkeypatch):
    """Retiene los push en vez de mandarlos.

    Se parchea en cada router porque todos importan `encolar_push` por nombre:
    cambiar el original no tendría efecto.
    """
    capturados: list[dict] = []

    def _retener(background, **kwargs):
        capturados.append(kwargs)

    for modulo in (content_router, bookings_router, social_graph_router):
        monkeypatch.setattr(modulo, "encolar_push", _retener)
    return capturados


def _texto(aviso: dict) -> tuple[str, str]:
    """El título y el cuerpo que saldrían, compuestos como en el envío real."""
    mensaje = push.build_message(aviso["notification_type"], aviso.get("actor_name"))
    assert mensaje is not None, f"el tipo {aviso['notification_type']} no tiene texto"
    return mensaje


async def _avisos_de(sesiones, uid: str) -> list[Notification]:
    async with sesiones() as db:
        return list(
            (await db.scalars(select(Notification).where(Notification.user_id == uid))).all()
        )


async def _publicar(http, identidad, autor: str, texto: str = "Hola") -> str:
    anterior = identidad["uid"]
    identidad["uid"] = autor
    respuesta = await http.post(POSTS, json={"body": texto})
    identidad["uid"] = anterior
    assert respuesta.status_code in (200, 201), respuesta.text
    return respuesta.json()["id"]


async def _bloquear(sesiones, quien: str, a_quien: str) -> None:
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=quien, blocked_id=a_quien))
        await db.commit()


# --------------------------------------------------------------------------- #
# 1. Nuevo seguidor
# --------------------------------------------------------------------------- #
async def test_seguir_avisa_con_el_nombre_de_quien_sigue(entorno, pushes):
    http, sesiones, _ = entorno
    respuesta = await http.post(f"{PERFILES}/{ANA}/follow")
    assert respuesta.status_code == 200, respuesta.text

    assert len(pushes) == 1
    assert pushes[0]["user_ids"] == [ANA]
    assert _texto(pushes[0]) == ("Nuevo seguidor", "Luis Ramos empezó a seguirte.")
    # Tocar el aviso abre el perfil de quien sigue.
    assert pushes[0]["data"] == {"type": "follow", "profileId": LUIS}
    # Y queda en la bandeja.
    assert [(a.type, a.actor_id) for a in await _avisos_de(sesiones, ANA)] == [("follow", LUIS)]


async def test_sin_nombre_el_aviso_dice_el_usuario_nunca_alguien(entorno, pushes):
    """Rita no rellenó su nombre. El aviso tiene que seguir diciendo quién es."""
    http, _, identidad = entorno
    identidad["uid"] = RITA
    await http.post(f"{PERFILES}/{ANA}/follow")

    assert _texto(pushes[0]) == ("Nuevo seguidor", "rita empezó a seguirte.")


# --------------------------------------------------------------------------- #
# 2. Reacción y comentario
# --------------------------------------------------------------------------- #
async def test_un_me_gusta_avisa_al_autor_con_el_nombre_y_la_publicacion(entorno, pushes):
    http, sesiones, identidad = entorno
    post_id = await _publicar(http, identidad, ANA)

    respuesta = await http.post(f"{POSTS}/{post_id}/like")
    assert respuesta.status_code in (200, 201), respuesta.text

    assert len(pushes) == 1
    assert pushes[0]["user_ids"] == [ANA]
    assert _texto(pushes[0]) == ("Nueva reacción", "A Luis Ramos le gustó tu publicación.")
    assert pushes[0]["data"] == {"type": "like", "postId": post_id}
    assert [a.type for a in await _avisos_de(sesiones, ANA)] == ["like"]


async def test_un_comentario_avisa_al_autor_con_el_nombre_y_la_publicacion(entorno, pushes):
    http, sesiones, identidad = entorno
    post_id = await _publicar(http, identidad, ANA)

    respuesta = await http.post(f"{POSTS}/{post_id}/comments", json={"body": "Muy bueno"})
    assert respuesta.status_code in (200, 201), respuesta.text

    assert len(pushes) == 1
    assert pushes[0]["user_ids"] == [ANA]
    assert _texto(pushes[0]) == ("Nuevo comentario", "Luis Ramos comentó tu publicación.")
    assert pushes[0]["data"] == {"type": "comment", "postId": post_id}
    # El texto del comentario NO viaja: un push se lee en la pantalla bloqueada.
    assert "Muy bueno" not in str(pushes[0])
    assert [a.type for a in await _avisos_de(sesiones, ANA)] == ["comment"]


async def test_reaccionar_a_lo_propio_no_avisa_a_nadie(entorno, pushes):
    http, sesiones, identidad = entorno
    post_id = await _publicar(http, identidad, LUIS)
    await http.post(f"{POSTS}/{post_id}/like")
    await http.post(f"{POSTS}/{post_id}/comments", json={"body": "Yo mismo"})

    assert pushes == []
    assert await _avisos_de(sesiones, LUIS) == []


# --------------------------------------------------------------------------- #
# 3. Agendar una sesión
# --------------------------------------------------------------------------- #
async def _pedir_sesion(http, a_quien: str = ANA) -> str:
    respuesta = await http.post(
        RESERVAS,
        json={"provider_id": a_quien, "topic": "Mentoría", "scheduled_at": _manana()},
    )
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()["id"]


async def test_pedir_una_sesion_avisa_a_quien_se_le_pide_con_el_nombre(entorno, pushes):
    http, sesiones, _ = entorno
    reserva_id = await _pedir_sesion(http)

    assert len(pushes) == 1
    assert pushes[0]["user_ids"] == [ANA]
    assert _texto(pushes[0]) == ("Nueva solicitud de sesión", "Luis Ramos quiere agendar contigo.")
    # `booking` es lo que el móvil lleva a la agenda.
    assert pushes[0]["data"] == {"type": "booking", "id": reserva_id}

    bandeja = await _avisos_de(sesiones, ANA)
    assert [(a.type, a.actor_id, a.entity_type, a.entity_id) for a in bandeja] == [
        ("session_booked", LUIS, "booking", reserva_id)
    ]


async def test_aceptar_la_sesion_avisa_a_quien_la_pidio(entorno, pushes):
    http, sesiones, identidad = entorno
    reserva_id = await _pedir_sesion(http)
    pushes.clear()

    identidad["uid"] = ANA
    respuesta = await http.patch(f"{RESERVAS}/{reserva_id}", json={"status": "accepted"})
    assert respuesta.status_code == 200, respuesta.text

    assert len(pushes) == 1
    assert pushes[0]["user_ids"] == [LUIS]
    assert _texto(pushes[0]) == ("Sesión confirmada", "Ana Torres aceptó tu solicitud.")
    assert pushes[0]["data"] == {"type": "booking", "id": reserva_id}
    assert [a.type for a in await _avisos_de(sesiones, LUIS)] == ["session_accepted"]


async def test_rechazar_la_sesion_lo_dice_con_su_propio_texto(entorno, pushes):
    http, _, identidad = entorno
    reserva_id = await _pedir_sesion(http)
    pushes.clear()

    identidad["uid"] = ANA
    await http.patch(f"{RESERVAS}/{reserva_id}", json={"status": "rejected"})

    assert pushes[0]["user_ids"] == [LUIS]
    assert _texto(pushes[0]) == ("Solicitud rechazada", "Ana Torres no puede en esta ocasión.")


# --------------------------------------------------------------------------- #
# 4. Un bloqueo calla los avisos sociales, en los dos sentidos
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("quien_bloquea", ["la_duena", "el_otro"])
async def test_con_un_bloqueo_no_avisa_seguir_reaccionar_ni_comentar(
    entorno, pushes, quien_bloquea
):
    """Bloquear a alguien es dejar de saber de él.

    Antes Luis, bloqueado por Ana, podía seguirla o comentarle por la API y a
    Ana le sonaba el teléfono con su nombre.
    """
    http, sesiones, identidad = entorno
    post_id = await _publicar(http, identidad, ANA)
    if quien_bloquea == "la_duena":
        await _bloquear(sesiones, ANA, LUIS)
    else:
        await _bloquear(sesiones, LUIS, ANA)

    await http.post(f"{PERFILES}/{ANA}/follow")
    await http.post(f"{POSTS}/{post_id}/like")
    await http.post(f"{POSTS}/{post_id}/comments", json={"body": "Hola otra vez"})

    assert pushes == [], "a quien bloqueó no le puede sonar el teléfono"
    assert await _avisos_de(sesiones, ANA) == [], "ni quedarle una fila en la bandeja"


async def test_el_bloqueo_no_calla_a_terceros(entorno, pushes):
    """Que Ana bloquee a Luis no deja a Ana sin los avisos de Rita."""
    http, sesiones, identidad = entorno
    await _bloquear(sesiones, ANA, LUIS)

    identidad["uid"] = RITA
    await http.post(f"{PERFILES}/{ANA}/follow")

    assert len(pushes) == 1
    assert [a.actor_id for a in await _avisos_de(sesiones, ANA)] == [RITA]


async def test_el_bloqueo_no_calla_la_agenda_ya_acordada(entorno, pushes):
    """Decisión explícita: lo de la agenda sigue avisando.

    Que te confirmen o te cancelen una sesión ya pedida te afecta aunque
    después hayas bloqueado a esa persona. Por eso los `session_*` no están en
    `TIPOS_QUE_EL_BLOQUEO_CALLA`.
    """
    http, sesiones, identidad = entorno
    reserva_id = await _pedir_sesion(http)
    pushes.clear()
    await _bloquear(sesiones, LUIS, ANA)

    identidad["uid"] = ANA
    await http.patch(f"{RESERVAS}/{reserva_id}", json={"status": "accepted"})

    assert len(pushes) == 1
    assert pushes[0]["notification_type"] == "session_accepted"
    assert not any(tipo.startswith("session_") for tipo in TIPOS_QUE_EL_BLOQUEO_CALLA)


# --------------------------------------------------------------------------- #
# 5. El nombre
# --------------------------------------------------------------------------- #
async def test_nombre_visible_prefiere_el_nombre_y_cae_al_usuario():
    assert push.nombre_visible("Ana Torres", "ana") == "Ana Torres"
    assert push.nombre_visible("", "ana") == "ana"
    assert push.nombre_visible("   ", "ana") == "ana"
    assert push.nombre_visible(None, None) is None
    # Sin nada, la plantilla escribe «Alguien»: mejor eso que ningún aviso.
    assert push.build_message("follow", None) == ("Nuevo seguidor", "Alguien empezó a seguirte.")


async def test_todo_tipo_con_actor_nombra_al_actor_en_el_cuerpo():
    """Ninguna plantilla social se olvida de decir quién."""
    for tipo in (
        "follow", "like", "comment", "comment_reply", "comment_like", "message",
        "post_mention", "session_booked", "session_accepted", "session_rejected",
        "session_cancelled", "session_rescheduled", "session_completed", "live_started",
    ):
        titulo, cuerpo = push.build_message(tipo, "Luis Ramos")  # type: ignore[misc]
        assert "Luis Ramos" in cuerpo, tipo
        assert titulo and titulo != cuerpo, tipo
