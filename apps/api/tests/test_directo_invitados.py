"""Invitados en el directo: quién sube, quién lo decide y cómo se baja.

Pedido el 07/10/2026: quien emite invita a otras personas, estas salen con su
cámara y la pantalla se reparte. Lo que se protege aquí es lo que intentaría
alguien con malas intenciones —salir en el directo de otro sin que le hayan
invitado, seguir publicando después de que le quiten— y lo que rompería a
alguien con buenas: quedarse sin emitir porque la migración 0098 no está.

El proveedor es un doble (ver `test_directo_credencial_y_webhook.py`): se
comprueba lo que hace Z, no que 100ms conteste.
"""

from __future__ import annotations

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.live import escenario, limites, providers
from app.modules.live.hms_client import Cliente100ms, Configuracion100ms
from app.modules.live.models import LiveGuest, LiveSession
from app.modules.live.proveedor_100ms import Proveedor100ms
from app.modules.live.providers import Credencial, ProveedorDeDirecto, SalaCreada
from app.modules.notifications.models import Notification
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.social_graph.models import UserBlock
from app.shared.database import Base, get_db

ANA = "aaaaaaaa-0000-0000-0000-000000000001"     # emite
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"   # a quien se invita
CARLA = "aaaaaaaa-0000-0000-0000-000000000003"   # mira
DARIO = "aaaaaaaa-0000-0000-0000-000000000004"
ELSA = "aaaaaaaa-0000-0000-0000-000000000005"
FABIO = "aaaaaaaa-0000-0000-0000-000000000006"
NADIE = "aaaaaaaa-0000-0000-0000-00000000dead"
LIVE = "/api/v1/live"


class _Doble(ProveedorDeDirecto):
    """Apunta con qué rol se pidió cada credencial y a quién se mandó bajar."""

    nombre = "100ms"

    def __init__(self) -> None:
        self.credenciales: list[tuple[str, str, bool]] = []
        self.bajadas: list[tuple[str, str, str, str]] = []
        self.falla_al_bajar = False

    async def abrir_sala(self, *, session_id: str, titulo: str) -> SalaCreada:
        return SalaCreada(room_id=f"room_{session_id}")

    async def cerrar_sala(self, *, room_id: str) -> None:
        return None

    async def credencial(
        self, *, room_id: str, user_id: str, puede_emitir: bool, rol: str = ""
    ) -> Credencial:
        self.credenciales.append((user_id, rol, puede_emitir))
        return Credencial(
            token=f"token_de_{user_id}", url="", expira_en=3600,
            puede_emitir=puede_emitir, rol=rol, room_id=room_id,
        )

    async def bajar_del_escenario(
        self, *, room_id: str, user_id: str, de_rol: str, a_rol: str
    ) -> int:
        if self.falla_al_bajar:
            raise providers.ErrorDeProveedor("sin respuesta", codigo="network_timeout")
        self.bajadas.append((room_id, user_id, de_rol, a_rol))
        return 1


async def _levantar(sin_la_0098: bool = False):
    limites.vaciar()
    esquema.olvidar()

    doble = _Doble()
    anteriores = dict(providers.PROVEEDORES)
    providers.PROVEEDORES["100ms"] = doble

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

        if sin_la_0098:
            tablas = [t for t in Base.metadata.sorted_tables if t.name != "live_guests"]
            await conn.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tablas))
        else:
            await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        for uid, nombre in (
            (ANA, "Ana"), (BRUNO, "Bruno"), (CARLA, "Carla"),
            (DARIO, "Dario"), (ELSA, "Elsa"), (FABIO, "Fabio"),
        ):
            db.add(Profile(id=uid, full_name=nombre, username=nombre.lower()))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

    async def _usuario() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario
    app.dependency_overrides[get_optional_user] = _usuario
    return engine, sesiones, identidad, doble, anteriores


async def _recoger(engine, anteriores) -> None:
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    providers.PROVEEDORES.clear()
    providers.PROVEEDORES.update(anteriores)
    esquema.olvidar()
    await engine.dispose()


@pytest_asyncio.fixture
async def entorno():
    engine, sesiones, identidad, doble, anteriores = await _levantar()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad, doble
    await _recoger(engine, anteriores)


@pytest_asyncio.fixture
async def sin_migracion():
    engine, sesiones, identidad, doble, anteriores = await _levantar(sin_la_0098=True)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad, doble
    await _recoger(engine, anteriores)


async def _emision(http, sesiones, *, en_vivo: bool = True) -> str:
    """Una emisión de Ana, en vivo y con sala del proveedor."""
    cuerpo = {"title": "Charla"}
    if not en_vivo:
        cuerpo["scheduled_for"] = "2099-01-01T10:00:00Z"
    respuesta = await http.post(f"{LIVE}/sessions", json=cuerpo)
    assert respuesta.status_code in (200, 201), respuesta.text
    sesion_id = respuesta.json()["id"]
    async with sesiones() as db:
        sesion = await db.get(LiveSession, sesion_id)
        sesion.provider = "100ms"
        sesion.provider_room_id = f"room_{sesion_id}"
        await db.commit()
    return sesion_id


async def _invitar(http, sesion_id: str, user_id: str):
    return await http.post(f"{LIVE}/sessions/{sesion_id}/guests", json={"user_id": user_id})


async def _credencial(http, sesion_id: str, cuerpo: dict | None = None) -> dict:
    respuesta = await http.post(f"{LIVE}/sessions/{sesion_id}/credential", json=cuerpo)
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


def _estados(escena: dict) -> dict[str, str]:
    return {g["user_id"]: g["status"] for g in escena["guests"]}


# --------------------------------------------------------------------------- #
# 1. Sin la migración 0098 no se rompe nada de lo que ya había
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_sin_la_0098_se_emite_y_se_mira_como_siempre(sin_migracion):
    http, sesiones, identidad, doble = sin_migracion
    sesion_id = await _emision(http, sesiones)

    assert (await _credencial(http, sesion_id))["role"] == "host"
    identidad["uid"] = BRUNO
    cuerpo = await _credencial(http, sesion_id)
    assert (cuerpo["role"], cuerpo["can_publish"]) == ("viewer", False)
    assert doble.credenciales == [(ANA, "host", True), (BRUNO, "viewer", False)]


@pytest.mark.asyncio
async def test_sin_la_0098_lo_de_invitados_dice_que_no_esta_disponible(sin_migracion):
    http, sesiones, _identidad, _doble = sin_migracion
    sesion_id = await _emision(http, sesiones)

    for metodo, ruta, cuerpo in (
        ("GET", "guests", None),
        ("POST", "guests", {"user_id": BRUNO}),
        ("DELETE", f"guests/{BRUNO}", None),
        ("POST", "guests/me/accept", None),
        ("POST", "guests/me/decline", None),
        ("POST", "guests/me/leave", None),
    ):
        respuesta = await http.request(metodo, f"{LIVE}/sessions/{sesion_id}/{ruta}", json=cuerpo)
        assert respuesta.status_code == 503, (metodo, ruta, respuesta.text)
        assert respuesta.json()["error"]["code"] == "live_guests_not_available"


# --------------------------------------------------------------------------- #
# 2. Invitar: solo quien gestiona, con tope y sin repetir avisos
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_quien_emite_invita_y_la_persona_recibe_un_aviso(entorno):
    http, sesiones, identidad, _doble = entorno
    sesion_id = await _emision(http, sesiones)

    respuesta = await _invitar(http, sesion_id, BRUNO)
    assert respuesta.status_code == 200, respuesta.text
    escena = respuesta.json()
    assert escena["max_guests"] == get_settings().live_max_guests == 3
    assert escena["can_invite"] is True
    assert _estados(escena) == {BRUNO: "invited"}
    assert escena["guests"][0]["name"] == "Bruno"
    # Quien invita no es invitado de nada.
    assert escena["me"] is None

    async with sesiones() as db:
        avisos = list(await db.scalars(select(Notification).where(Notification.user_id == BRUNO)))
    assert [(a.type, a.entity_type, a.entity_id, a.actor_id) for a in avisos] == [
        ("live_invited", "live", sesion_id, ANA)
    ]

    # Bruno, al preguntar, ve lo suyo.
    identidad["uid"] = BRUNO
    suya = (await http.get(f"{LIVE}/sessions/{sesion_id}/guests")).json()
    assert suya["me"] == "invited"
    assert suya["can_invite"] is False


@pytest.mark.asyncio
async def test_invitar_dos_veces_no_manda_dos_avisos(entorno):
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http, sesiones)

    assert (await _invitar(http, sesion_id, BRUNO)).status_code == 200
    assert (await _invitar(http, sesion_id, BRUNO)).status_code == 200

    async with sesiones() as db:
        avisos = list(await db.scalars(select(Notification).where(Notification.user_id == BRUNO)))
        filas = list(await db.scalars(select(LiveGuest)))
    assert len(avisos) == 1
    assert len(filas) == 1


@pytest.mark.asyncio
async def test_quien_mira_no_puede_invitar_ni_quitar(entorno):
    http, sesiones, identidad, _doble = entorno
    sesion_id = await _emision(http, sesiones)
    assert (await _invitar(http, sesion_id, BRUNO)).status_code == 200

    identidad["uid"] = CARLA
    assert (await _invitar(http, sesion_id, DARIO)).status_code == 403
    assert (
        await http.delete(f"{LIVE}/sessions/{sesion_id}/guests/{BRUNO}")
    ).status_code == 403

    async with sesiones() as db:
        filas = {f.user_id: f.status for f in await db.scalars(select(LiveGuest))}
    assert filas == {BRUNO: "invited"}


@pytest.mark.asyncio
async def test_no_se_invita_a_quien_emite_ni_a_quien_no_existe(entorno):
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http, sesiones)

    a_si_misma = await _invitar(http, sesion_id, ANA)
    assert a_si_misma.status_code == 409
    assert a_si_misma.json()["error"]["code"] == "live_guest_is_host"
    assert (await _invitar(http, sesion_id, NADIE)).status_code == 404
    assert (await _invitar(http, sesion_id, "no-es-un-id")).status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("quien_bloquea", ["anfitriona", "invitado"])
async def test_un_bloqueo_se_contesta_como_si_la_persona_no_existiera(entorno, quien_bloquea):
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http, sesiones)
    async with sesiones() as db:
        db.add(
            UserBlock(blocker_id=ANA, blocked_id=BRUNO)
            if quien_bloquea == "anfitriona"
            else UserBlock(blocker_id=BRUNO, blocked_id=ANA)
        )
        await db.commit()

    respuesta = await _invitar(http, sesion_id, BRUNO)
    assert respuesta.status_code == 404
    assert "bloque" not in respuesta.text.lower()


@pytest.mark.asyncio
async def test_el_tope_cuenta_a_quien_esta_arriba_y_a_quien_aun_no_ha_contestado(entorno):
    http, sesiones, identidad, _doble = entorno
    sesion_id = await _emision(http, sesiones)

    for persona in (BRUNO, CARLA, DARIO):
        assert (await _invitar(http, sesion_id, persona)).status_code == 200
    llena = await _invitar(http, sesion_id, ELSA)
    assert llena.status_code == 409
    assert llena.json()["error"]["code"] == "live_guests_full"

    # Bruno dice que no: su sitio queda libre.
    identidad["uid"] = BRUNO
    assert (await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/decline")).status_code == 200
    identidad["uid"] = ANA
    respuesta = await _invitar(http, sesion_id, ELSA)
    assert respuesta.status_code == 200
    assert _estados(respuesta.json()) == {
        BRUNO: "declined", CARLA: "invited", DARIO: "invited", ELSA: "invited",
    }


@pytest.mark.asyncio
async def test_solo_se_invita_con_la_emision_en_vivo(entorno):
    http, sesiones, _identidad, _doble = entorno
    programada = await _emision(http, sesiones, en_vivo=False)
    respuesta = await _invitar(http, programada, BRUNO)
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "live_guests_not_live"

    terminada = await _emision(http, sesiones)
    assert (await http.post(f"{LIVE}/sessions/{terminada}/end")).status_code == 200
    respuesta = await _invitar(http, terminada, BRUNO)
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "live_guests_not_live"


@pytest.mark.asyncio
async def test_invitar_sin_parar_se_frena(entorno):
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http, sesiones)

    for _ in range(limites.INVITACIONES_POR_VENTANA):
        assert (await _invitar(http, sesion_id, BRUNO)).status_code == 200
    frenada = await _invitar(http, sesion_id, BRUNO)
    assert frenada.status_code == 409
    assert frenada.json()["error"]["code"] == "live_guests_rate_limited"


# --------------------------------------------------------------------------- #
# 3. Aceptar: es lo único que da permiso para publicar
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_quien_acepta_entra_como_invitado_y_puede_publicar(entorno):
    http, sesiones, identidad, doble = entorno
    sesion_id = await _emision(http, sesiones)
    await _invitar(http, sesion_id, BRUNO)

    identidad["uid"] = BRUNO
    # Invitado pero sin aceptar: sigue siendo público.
    antes = await _credencial(http, sesion_id)
    assert (antes["role"], antes["can_publish"]) == ("viewer", False)

    aceptada = await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/accept")
    assert aceptada.status_code == 200, aceptada.text
    assert aceptada.json()["me"] == "accepted"

    despues = await _credencial(http, sesion_id)
    assert (despues["role"], despues["can_publish"]) == ("guest", True)
    assert doble.credenciales[-1] == (BRUNO, "guest", True)


@pytest.mark.asyncio
async def test_nadie_se_sube_sin_que_le_hayan_invitado(entorno):
    """EL CASO QUE IMPORTA: aceptar una invitación que no existe."""
    http, sesiones, identidad, doble = entorno
    sesion_id = await _emision(http, sesiones)

    identidad["uid"] = CARLA
    colada = await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/accept")
    assert colada.status_code == 409
    assert colada.json()["error"]["code"] == "live_guest_not_invited"

    cuerpo = await _credencial(http, sesion_id, {"publish": True})
    assert (cuerpo["role"], cuerpo["can_publish"]) == ("viewer", False)
    assert doble.credenciales == [(CARLA, "viewer", False)]


@pytest.mark.asyncio
async def test_no_se_acepta_una_invitacion_retirada_ni_una_ya_rechazada(entorno):
    http, sesiones, identidad, _doble = entorno
    sesion_id = await _emision(http, sesiones)
    await _invitar(http, sesion_id, BRUNO)
    await _invitar(http, sesion_id, CARLA)

    # A Bruno se la retiran antes de que conteste.
    assert (await http.delete(f"{LIVE}/sessions/{sesion_id}/guests/{BRUNO}")).status_code == 200
    identidad["uid"] = BRUNO
    assert (await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/accept")).status_code == 409

    # Carla dice que no y luego intenta decir que sí.
    identidad["uid"] = CARLA
    assert (await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/decline")).status_code == 200
    assert (await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/accept")).status_code == 409
    assert (await _credencial(http, sesion_id))["role"] == "viewer"


@pytest.mark.asyncio
async def test_repetir_la_misma_respuesta_no_es_un_error(entorno):
    http, sesiones, identidad, _doble = entorno
    sesion_id = await _emision(http, sesiones)
    await _invitar(http, sesion_id, BRUNO)

    identidad["uid"] = BRUNO
    for _ in range(2):
        respuesta = await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/accept")
        assert respuesta.status_code == 200
        assert respuesta.json()["me"] == "accepted"


@pytest.mark.asyncio
async def test_se_puede_entrar_solo_a_mirar_aunque_se_pudiera_publicar(entorno):
    """Sin esto, quien aceptó, cerró la aplicación y vuelve saldría al aire
    solo con abrir la pantalla."""
    http, sesiones, identidad, doble = entorno
    sesion_id = await _emision(http, sesiones)
    await _invitar(http, sesion_id, BRUNO)

    identidad["uid"] = BRUNO
    await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/accept")
    mirando = await _credencial(http, sesion_id, {"publish": False})
    assert (mirando["role"], mirando["can_publish"]) == ("viewer", False)

    # Y quien emite, igual: renunciar siempre se puede.
    identidad["uid"] = ANA
    anfitriona = await _credencial(http, sesion_id, {"publish": False})
    assert (anfitriona["role"], anfitriona["can_publish"]) == ("viewer", False)
    assert doble.credenciales == [(BRUNO, "viewer", False), (ANA, "viewer", False)]


# --------------------------------------------------------------------------- #
# 4. Bajarse y que te bajen
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_quien_se_baja_deja_de_poder_publicar_y_se_le_baja_en_el_proveedor(entorno):
    http, sesiones, identidad, doble = entorno
    sesion_id = await _emision(http, sesiones)
    await _invitar(http, sesion_id, BRUNO)
    identidad["uid"] = BRUNO
    await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/accept")

    respuesta = await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/leave")
    assert respuesta.status_code == 200
    assert respuesta.json()["me"] == "left"
    assert doble.bajadas == [(f"room_{sesion_id}", BRUNO, "guest", "viewer")]
    assert (await _credencial(http, sesion_id))["role"] == "viewer"

    # Bajarse otra vez no hace nada, ni vuelve a llamar al proveedor.
    assert (await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/leave")).status_code == 200
    assert len(doble.bajadas) == 1


@pytest.mark.asyncio
async def test_quien_emite_quita_a_un_invitado_de_la_pantalla(entorno):
    http, sesiones, identidad, doble = entorno
    sesion_id = await _emision(http, sesiones)
    await _invitar(http, sesion_id, BRUNO)
    identidad["uid"] = BRUNO
    await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/accept")

    identidad["uid"] = ANA
    respuesta = await http.delete(f"{LIVE}/sessions/{sesion_id}/guests/{BRUNO}")
    assert respuesta.status_code == 200
    # Quien fue retirado ya no sale en la lista: su sitio queda libre.
    assert _estados(respuesta.json()) == {}
    assert doble.bajadas == [(f"room_{sesion_id}", BRUNO, "guest", "viewer")]

    identidad["uid"] = BRUNO
    suya = (await http.get(f"{LIVE}/sessions/{sesion_id}/guests")).json()
    assert suya["me"] == "removed"
    assert (await _credencial(http, sesion_id))["role"] == "viewer"
    # Y no puede volver a subirse por su cuenta.
    assert (await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/accept")).status_code == 409


@pytest.mark.asyncio
async def test_retirar_una_invitacion_sin_contestar_no_toca_el_proveedor(entorno):
    http, sesiones, _identidad, doble = entorno
    sesion_id = await _emision(http, sesiones)
    await _invitar(http, sesion_id, BRUNO)

    assert (await http.delete(f"{LIVE}/sessions/{sesion_id}/guests/{BRUNO}")).status_code == 200
    assert doble.bajadas == []
    assert (await http.delete(f"{LIVE}/sessions/{sesion_id}/guests/{CARLA}")).status_code == 404


@pytest.mark.asyncio
async def test_que_el_proveedor_no_conteste_no_impide_bajarse(entorno):
    http, sesiones, identidad, doble = entorno
    sesion_id = await _emision(http, sesiones)
    await _invitar(http, sesion_id, BRUNO)
    identidad["uid"] = BRUNO
    await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/accept")

    doble.falla_al_bajar = True
    respuesta = await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/leave")
    assert respuesta.status_code == 200
    assert respuesta.json()["me"] == "left"
    assert (await _credencial(http, sesion_id))["role"] == "viewer"


@pytest.mark.asyncio
async def test_bajarse_se_puede_tambien_con_la_emision_terminada(entorno):
    http, sesiones, identidad, _doble = entorno
    sesion_id = await _emision(http, sesiones)
    await _invitar(http, sesion_id, BRUNO)
    identidad["uid"] = BRUNO
    await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/accept")

    identidad["uid"] = ANA
    assert (await http.post(f"{LIVE}/sessions/{sesion_id}/end")).status_code == 200

    identidad["uid"] = BRUNO
    respuesta = await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/leave")
    assert respuesta.status_code == 200
    assert respuesta.json()["me"] == "left"


@pytest.mark.asyncio
async def test_a_quien_se_fue_se_le_puede_volver_a_invitar(entorno):
    http, sesiones, identidad, _doble = entorno
    sesion_id = await _emision(http, sesiones)
    await _invitar(http, sesion_id, BRUNO)
    identidad["uid"] = BRUNO
    await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/accept")
    await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/leave")

    identidad["uid"] = ANA
    respuesta = await _invitar(http, sesion_id, BRUNO)
    assert respuesta.status_code == 200
    assert _estados(respuesta.json()) == {BRUNO: "invited"}
    async with sesiones() as db:
        avisos = list(await db.scalars(select(Notification).where(Notification.user_id == BRUNO)))
        filas = list(await db.scalars(select(LiveGuest)))
    # Una fila por persona y emisión, y un aviso por cada invitación de verdad.
    assert len(filas) == 1
    assert len(avisos) == 2


# --------------------------------------------------------------------------- #
# 5. Qué ve cada cual
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_quien_mira_solo_ve_a_quien_esta_en_pantalla(entorno):
    http, sesiones, identidad, _doble = entorno
    sesion_id = await _emision(http, sesiones)
    await _invitar(http, sesion_id, BRUNO)
    await _invitar(http, sesion_id, DARIO)
    identidad["uid"] = BRUNO
    await http.post(f"{LIVE}/sessions/{sesion_id}/guests/me/accept")

    identidad["uid"] = CARLA
    escena = (await http.get(f"{LIVE}/sessions/{sesion_id}/guests")).json()
    # A Dario se le ha invitado y no ha contestado: eso no es asunto de Carla.
    assert _estados(escena) == {BRUNO: "accepted"}
    assert escena["me"] is None
    assert escena["can_invite"] is False


def test_los_estados_son_los_del_check_de_la_migracion():
    from pathlib import Path

    sql = (
        Path(__file__).resolve().parents[3]
        / "supabase" / "migrations" / "0098_invitados_en_el_directo.sql"
    ).read_text(encoding="utf-8")
    for estado in escenario.ESTADOS:
        assert f"'{estado}'" in sql, estado
    assert set(escenario.OCUPAN_PLAZA) == {"invited", "accepted"}


# --------------------------------------------------------------------------- #
# 6. Lo que se le pide a 100ms para bajar a alguien
# --------------------------------------------------------------------------- #

CONFIG = Configuracion100ms(
    access_key="clave_de_prueba",
    app_secret="secreto_de_prueba",
    template_id="plantilla_de_prueba",
    api_base="https://api.100ms.test/v2",
)


class _Http:
    def __init__(self, respuestas: list[httpx.Response]) -> None:
        self.respuestas = respuestas
        self.peticiones: list[tuple[str, str, dict | None]] = []

    async def request(self, metodo, url, *, json=None, params=None, **_kw):
        self.peticiones.append((metodo, url, json or params))
        if not self.respuestas:
            raise AssertionError(f"peticion inesperada: {metodo} {url}")
        return self.respuestas.pop(0)


def _respuesta(codigo: int, cuerpo: dict | None = None) -> httpx.Response:
    return httpx.Response(
        codigo,
        json=cuerpo if cuerpo is not None else {},
        request=httpx.Request("GET", "https://api.100ms.test/v2/active-rooms"),
    )


def _proveedor(respuestas: list[httpx.Response]) -> tuple[Proveedor100ms, _Http]:
    http = _Http(respuestas)
    return Proveedor100ms(CONFIG, cliente=Cliente100ms(CONFIG, cliente_http=http)), http


@pytest.mark.asyncio
async def test_en_100ms_solo_se_cambia_la_conexion_que_sigue_de_invitado():
    """Si la persona ya volvió a entrar como público, ESA conexión no se toca:
    cambiarla sería dejarla igual, y echarla, sacarla de una sala en la que
    tiene todo el derecho a estar."""
    pares = {
        "peer_vieja": {"id": "peer_vieja", "user_id": BRUNO, "role": "guest"},
        "peer_nueva": {"id": "peer_nueva", "user_id": BRUNO, "role": "viewer"},
    }
    proveedor, http = _proveedor([_respuesta(200, {"peers": pares}), _respuesta(200, {})])

    cambiadas = await proveedor.bajar_del_escenario(
        room_id="sala1", user_id=BRUNO, de_rol="guest", a_rol="viewer"
    )

    assert cambiadas == 1
    assert http.peticiones == [
        ("GET", "https://api.100ms.test/v2/active-rooms/sala1/peers", {"user_id": BRUNO}),
        ("POST", "https://api.100ms.test/v2/active-rooms/sala1/peers/peer_vieja", {"role": "viewer"}),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "contesta",
    [
        _respuesta(404, {"message": "no active session"}),
        _respuesta(200, {"peers": []}),
        _respuesta(200, {"peers": {}}),
        _respuesta(200, {}),
    ],
)
async def test_sin_nadie_dentro_no_hay_nada_que_bajar(contesta):
    proveedor, http = _proveedor([contesta])
    assert (
        await proveedor.bajar_del_escenario(
            room_id="sala1", user_id=BRUNO, de_rol="guest", a_rol="viewer"
        )
    ) == 0
    assert len(http.peticiones) == 1


@pytest.mark.asyncio
async def test_si_se_fue_entre_medias_no_es_un_fallo():
    pares = {"peer_vieja": {"id": "peer_vieja", "user_id": BRUNO, "role": "guest"}}
    proveedor, _http = _proveedor([_respuesta(200, {"peers": pares}), _respuesta(404, {})])
    assert (
        await proveedor.bajar_del_escenario(
            room_id="sala1", user_id=BRUNO, de_rol="guest", a_rol="viewer"
        )
    ) == 0


@pytest.mark.asyncio
async def test_un_proveedor_que_no_sabe_bajar_no_cambia_ninguna_conexion():
    assert (
        await providers.ProveedorNoConfigurado().bajar_del_escenario(
            room_id="sala1", user_id=BRUNO, de_rol="guest", a_rol="viewer"
        )
    ) == 0
