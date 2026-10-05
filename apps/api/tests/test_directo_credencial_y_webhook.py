"""El endpoint de credencial y el de avisos, de punta a punta.

Lo de aquí es lo que intentaría alguien con malas intenciones: pedir permiso de
emitir siendo público, pedir credenciales en bucle, entrar en una emisión ya
terminada, y cerrarle la emisión a otro mandando un aviso falso.

El proveedor es un doble. Estas pruebas comprueban lo que hace Z con lo que
contesta 100ms, no que 100ms conteste: una prueba que salga a la red de un
tercero falla los lunes por motivos que no son nuestros.
"""

from __future__ import annotations

import json

import jwt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.live import limites, providers
from app.modules.live.hms_client import Configuracion100ms
from app.modules.live.models import LiveSession
from app.modules.live.providers import Credencial, ProveedorDeDirecto, SalaCreada
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.shared.database import Base, get_db

ANA = "aaaaaaaa-0000-0000-0000-000000000001"     # emite
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"   # mira
JEFA = "aaaaaaaa-0000-0000-0000-000000000003"    # administracion
LIVE = "/api/v1/live"
SECRETO = "secreto_de_webhook"

CONFIG = Configuracion100ms(
    access_key="clave", app_secret="secreto_de_firma", template_id="plantilla",
    api_base="https://api.100ms.test/v2",
)


class _Doble(ProveedorDeDirecto):
    """Un proveedor que apunta con qué rol se le pidió cada credencial."""

    nombre = "100ms"

    def __init__(self) -> None:
        self.credenciales: list[tuple[str, str, bool]] = []
        self.cerradas: list[str] = []
        self.abiertas: list[str] = []
        #: Para simular que el proveedor no responde al abrir la sala.
        self.falla_al_abrir = False

    async def abrir_sala(self, *, session_id: str, titulo: str) -> SalaCreada:
        if self.falla_al_abrir:
            raise providers.ErrorDeProveedor(
                "sin respuesta", codigo="network_timeout"
            )
        self.abiertas.append(session_id)
        return SalaCreada(room_id=f"room_{session_id}")

    async def cerrar_sala(self, *, room_id: str) -> None:
        self.cerradas.append(room_id)

    async def credencial(
        self, *, room_id: str, user_id: str, puede_emitir: bool, rol: str = ""
    ) -> Credencial:
        self.credenciales.append((user_id, rol, puede_emitir))
        return Credencial(
            token=f"token_de_{user_id}", url="", expira_en=3600,
            puede_emitir=puede_emitir, rol=rol, room_id=room_id,
        )

    def interpretar_evento(self, cuerpo: dict):
        from app.modules.live.proveedor_100ms import Proveedor100ms

        return Proveedor100ms(CONFIG).interpretar_evento(cuerpo)


@pytest_asyncio.fixture
async def entorno():
    limites.vaciar()
    esquema.olvidar()

    ajustes = get_settings()
    previos = (ajustes.hms_webhook_secret,)
    ajustes.hms_webhook_secret = SECRETO

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

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(Profile(id=JEFA, full_name="Jefa", username="jefa", role="admin"))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

    async def _usuario() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    async def _usuario_opcional() -> AuthUser | None:
        if identidad["uid"] is None:
            return None
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario
    app.dependency_overrides[get_optional_user] = _usuario_opcional
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad, doble
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    providers.PROVEEDORES.clear()
    providers.PROVEEDORES.update(anteriores)
    (ajustes.hms_webhook_secret,) = previos
    # Con el bucle de la prueba todavía vivo: si la cierra el recolector, lo
    # hace cuando ya no existe y el «Event loop is closed» le cae a otra prueba.
    await engine.dispose()


async def _emision(http, *, estado: str = "live") -> str:
    """Una emisión de Ana, ya con sala."""
    respuesta = await http.post(f"{LIVE}/sessions", json={"title": "Charla"})
    assert respuesta.status_code in (200, 201), respuesta.text
    sesion_id = respuesta.json()["id"]
    if estado != "scheduled":
        await http.post(f"{LIVE}/sessions/{sesion_id}/start")
    return sesion_id


async def _con_sala(sesiones, sesion_id: str, estado: str | None = None) -> None:
    """Le pone sala del proveedor, que es lo que el endpoint exige."""
    async with sesiones() as db:
        sesion = await db.get(LiveSession, sesion_id)
        sesion.provider = "100ms"
        sesion.provider_room_id = f"room_{sesion_id}"
        if estado:
            sesion.status = estado
        await db.commit()


# --------------------------------------------------------------------------- #
# 1. El rol lo decide el servidor
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_quien_emite_recibe_permiso_de_anfitrion(entorno):
    http, sesiones, _identidad, doble = entorno
    sesion_id = await _emision(http)
    await _con_sala(sesiones, sesion_id)

    respuesta = await http.post(f"{LIVE}/sessions/{sesion_id}/credential")
    assert respuesta.status_code == 200, respuesta.text
    cuerpo = respuesta.json()
    assert cuerpo["role"] == "host"
    assert cuerpo["can_publish"] is True
    assert cuerpo["provider"] == "100ms"
    assert doble.credenciales == [(ANA, "host", True)]


@pytest.mark.asyncio
async def test_el_publico_recibe_permiso_de_ver_y_nada_mas(entorno):
    """EL CASO QUE IMPORTA. Deducirlo en el cliente sería dejar que cualquier
    espectador se pusiera a emitir en la sala de otra persona."""
    http, sesiones, identidad, doble = entorno
    sesion_id = await _emision(http)
    await _con_sala(sesiones, sesion_id)

    identidad["uid"] = BRUNO
    respuesta = await http.post(f"{LIVE}/sessions/{sesion_id}/credential")
    assert respuesta.status_code == 200, respuesta.text
    cuerpo = respuesta.json()
    assert cuerpo["role"] == "viewer"
    assert cuerpo["can_publish"] is False
    assert doble.credenciales == [(BRUNO, "viewer", False)]


@pytest.mark.asyncio
async def test_un_espectador_no_se_declara_anfitrion_desde_el_cliente(entorno):
    """Se manda el rol en el cuerpo, que es lo que intentaría alguien. El
    endpoint ni lo lee: el rol sale de quién eres, no de qué pides."""
    http, sesiones, identidad, doble = entorno
    sesion_id = await _emision(http)
    await _con_sala(sesiones, sesion_id)

    identidad["uid"] = BRUNO
    respuesta = await http.post(
        f"{LIVE}/sessions/{sesion_id}/credential",
        json={"role": "host", "can_publish": True, "user_id": ANA},
    )
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["role"] == "viewer"
    assert doble.credenciales == [(BRUNO, "viewer", False)]


@pytest.mark.asyncio
async def test_administracion_entra_como_moderadora(entorno):
    http, sesiones, identidad, doble = entorno
    sesion_id = await _emision(http)
    await _con_sala(sesiones, sesion_id)

    identidad["uid"] = JEFA
    respuesta = await http.post(f"{LIVE}/sessions/{sesion_id}/credential")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["role"] == "moderator"
    assert doble.credenciales == [(JEFA, "moderator", True)]


# --------------------------------------------------------------------------- #
# 2. Cuándo NO se entrega credencial
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_una_emision_terminada_no_reparte_permisos(entorno):
    """Ni de emitir ni de ver: la sala ya no existe y el token solo serviría
    para que el SDK diera vueltas contra una puerta cerrada."""
    http, sesiones, _identidad, doble = entorno
    sesion_id = await _emision(http)
    await _con_sala(sesiones, sesion_id, estado="ended")

    respuesta = await http.post(f"{LIVE}/sessions/{sesion_id}/credential")
    assert respuesta.status_code == 409, respuesta.text
    assert respuesta.json()["error"]["code"] == "live_not_joinable"
    assert doble.credenciales == []


@pytest.mark.asyncio
async def test_una_emision_cancelada_tampoco(entorno):
    http, sesiones, _identidad, doble = entorno
    sesion_id = await _emision(http)
    await _con_sala(sesiones, sesion_id, estado="cancelled")

    respuesta = await http.post(f"{LIVE}/sessions/{sesion_id}/credential")
    assert respuesta.status_code == 409
    assert doble.credenciales == []


@pytest.mark.asyncio
async def test_sin_sala_del_proveedor_se_dice_claro(entorno):
    """Si el proveedor SIGUE sin poder abrirla, no hay nada a lo que conectarse."""
    http, sesiones, _identidad, doble = entorno
    sesion_id = await _emision(http)
    async with sesiones() as db:
        sesion = await db.get(LiveSession, sesion_id)
        sesion.provider_room_id = None
        await db.commit()
    doble.falla_al_abrir = True
    respuesta = await http.post(f"{LIVE}/sessions/{sesion_id}/credential")
    assert respuesta.status_code == 503
    assert respuesta.json()["error"]["code"] == "live_provider_not_configured"
    assert doble.credenciales == []


@pytest.mark.asyncio
async def test_una_emision_en_directo_sin_sala_la_recupera_al_pedir_credencial(entorno):
    """EL AGUJERO QUE SE CIERRA. Nacer en directo con el proveedor caído dejaba
    la emisión sin sala para siempre: `/start` no vuelve a pasar por una emisión
    que ya está `live`, y la credencial contestaba 503 en cada intento."""
    http, sesiones, _identidad, doble = entorno
    doble.falla_al_abrir = True
    respuesta = await http.post(f"{LIVE}/sessions", json={"title": "Charla"})
    assert respuesta.status_code == 201, respuesta.text
    sesion_id = respuesta.json()["id"]
    async with sesiones() as db:
        assert (await db.get(LiveSession, sesion_id)).provider_room_id is None

    doble.falla_al_abrir = False
    respuesta = await http.post(f"{LIVE}/sessions/{sesion_id}/credential")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["room_id"] == f"room_{sesion_id}"
    async with sesiones() as db:
        assert (await db.get(LiveSession, sesion_id)).provider_room_id == f"room_{sesion_id}"


@pytest.mark.asyncio
async def test_una_emision_PROGRAMADA_no_abre_sala_al_pedir_credencial(entorno):
    """Solo se repara lo que está en directo: una programada todavía no tiene
    sala a propósito, y abrirla ya facturaría horas antes de empezar."""
    http, _sesiones, _identidad, doble = entorno
    respuesta = await http.post(
        f"{LIVE}/sessions",
        json={"title": "Mañana", "scheduled_for": "2099-01-01T10:00:00Z"},
    )
    assert respuesta.status_code == 201, respuesta.text
    sesion_id = respuesta.json()["id"]
    respuesta = await http.post(f"{LIVE}/sessions/{sesion_id}/credential")
    assert respuesta.status_code == 503
    assert doble.abiertas == []


@pytest.mark.asyncio
async def test_nacer_en_directo_respeta_el_techo_de_emisiones_simultaneas(entorno):
    """Antes solo lo miraba `/start`, y el camino de «Vivo» en la app —crear sin
    fecha, que nace ya emitiendo— se lo saltaba."""
    http, _sesiones, identidad, _doble = entorno
    ajustes = get_settings()
    anterior = ajustes.live_max_concurrent
    ajustes.live_max_concurrent = 1
    try:
        primera = await http.post(f"{LIVE}/sessions", json={"title": "Una"})
        assert primera.status_code == 201, primera.text

        identidad["uid"] = BRUNO
        segunda = await http.post(f"{LIVE}/sessions", json={"title": "Otra"})
        assert segunda.status_code == 409, segunda.text
        assert segunda.json()["error"]["code"] == "live_too_many_concurrent"

        # Programar sí se puede: no ocupa sala hasta que empiece.
        programada = await http.post(
            f"{LIVE}/sessions",
            json={"title": "Luego", "scheduled_for": "2099-01-01T10:00:00Z"},
        )
        assert programada.status_code == 201, programada.text
    finally:
        ajustes.live_max_concurrent = anterior


@pytest.mark.asyncio
async def test_la_disponibilidad_dice_si_hay_video(entorno):
    """Es lo que mira la app antes de ofrecer «Vivo»."""
    http, _sesiones, _identidad, _doble = entorno
    respuesta = await http.get(f"{LIVE}/availability")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json() == {"video": True, "provider": "100ms"}

    providers.PROVEEDORES.pop("100ms")
    respuesta = await http.get(f"{LIVE}/availability")
    assert respuesta.json() == {"video": False, "provider": "none"}


@pytest.mark.asyncio
async def test_una_emision_de_un_proveedor_que_ya_no_existe(entorno):
    """La configuración cambió bajo los pies: se dice, no se revienta."""
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http)
    async with sesiones() as db:
        sesion = await db.get(LiveSession, sesion_id)
        sesion.provider = "un_proveedor_retirado"
        sesion.provider_room_id = "room_x"
        await db.commit()

    respuesta = await http.post(f"{LIVE}/sessions/{sesion_id}/credential")
    assert respuesta.status_code == 503
    assert respuesta.json()["error"]["code"] == "live_provider_missing"


@pytest.mark.asyncio
async def test_pedir_credenciales_en_bucle_se_corta(entorno):
    """Una reconexión legítima cabe de sobra; un bucle, no."""
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http)
    await _con_sala(sesiones, sesion_id)

    codigos = []
    for _ in range(limites.CREDENCIALES_POR_VENTANA + 3):
        codigos.append((await http.post(f"{LIVE}/sessions/{sesion_id}/credential")).status_code)

    assert codigos[: limites.CREDENCIALES_POR_VENTANA] == [200] * limites.CREDENCIALES_POR_VENTANA
    assert codigos[-1] == 409
    ultima = await http.post(f"{LIVE}/sessions/{sesion_id}/credential")
    assert ultima.json()["error"]["code"] == "live_credential_rate_limited"


@pytest.mark.asyncio
async def test_el_limite_es_por_persona_y_emision(entorno):
    """Que a uno se le acabe el cupo no puede dejar fuera a los demás."""
    http, sesiones, identidad, _doble = entorno
    sesion_id = await _emision(http)
    await _con_sala(sesiones, sesion_id)
    for _ in range(limites.CREDENCIALES_POR_VENTANA + 1):
        await http.post(f"{LIVE}/sessions/{sesion_id}/credential")

    identidad["uid"] = BRUNO
    respuesta = await http.post(f"{LIVE}/sessions/{sesion_id}/credential")
    assert respuesta.status_code == 200, respuesta.text


@pytest.mark.asyncio
async def test_la_credencial_no_filtra_nada_de_la_cuenta(entorno):
    """Con el proveedor DE VERDAD, que es el que firma.

    ANTES ESTA PRUEBA ESTABA MEDIO MUERTA: el proveedor era el doble, que
    devuelve `token="token_de_ana"`, y `CONFIG` no estaba conectado a los
    ajustes de la aplicación. Buscar el secreto en la respuesta era comparar dos
    literales que no se habían tocado; habría pasado igual aunque el adaptador
    real filtrara la cuenta entera.

    Ahora se registra `Proveedor100ms` con un secreto reconocible y se mira lo
    que sale por el endpoint.
    """
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http)
    await _con_sala(sesiones, sesion_id)

    from app.modules.live.proveedor_100ms import Proveedor100ms

    anterior = providers.PROVEEDORES["100ms"]
    providers.PROVEEDORES["100ms"] = Proveedor100ms(CONFIG, ttl_credencial=600)
    try:
        respuesta = await http.post(f"{LIVE}/sessions/{sesion_id}/credential")
        assert respuesta.status_code == 200, respuesta.text
        cuerpo = respuesta.text
        for prohibido in (CONFIG.app_secret, CONFIG.template_id, SECRETO):
            assert prohibido not in cuerpo, f"se filtro {prohibido}"

        # Y solo los campos del contrato, ni uno mas.
        datos = respuesta.json()
        assert set(datos) == {
            "provider", "token", "url", "expires_in", "can_publish", "role", "room_id",
        }
        # El token es REAL: va firmado con el secreto y lleva el rol que decidio
        # el servidor, no el que pidiera nadie.
        reclamos = jwt.decode(datos["token"], CONFIG.app_secret, algorithms=["HS256"])
        assert reclamos["role"] == "host"
        assert reclamos["user_id"] == ANA
        assert CONFIG.app_secret not in json.dumps(reclamos)
    finally:
        providers.PROVEEDORES["100ms"] = anterior


# --------------------------------------------------------------------------- #
# 3. Los avisos del proveedor
# --------------------------------------------------------------------------- #


def _aviso(sesion_id: str, tipo: str = "session.close.success", event_id: str = "evt_1") -> dict:
    return {
        "id": event_id,
        "type": tipo,
        "timestamp": "2026-01-01T00:00:00Z",
        "data": {
            "room_id": f"room_{sesion_id}",
            "room_name": sesion_id,
            "session_id": "ses_1",
        },
    }


async def _mandar(http, aviso: dict, *, autorizacion: str | None = SECRETO):
    cabeceras = {"content-type": "application/json"}
    if autorizacion is not None:
        cabeceras["authorization"] = autorizacion
    return await http.post(f"{LIVE}/webhook/100ms", json=aviso, headers=cabeceras)


@pytest.mark.asyncio
async def test_un_aviso_sin_autorizacion_no_cierra_la_emision_de_nadie(entorno):
    """Es lo único que se rechaza con error: hay que verlo."""
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http)
    await _con_sala(sesiones, sesion_id)

    respuesta = await _mandar(http, _aviso(sesion_id), autorizacion=None)
    assert respuesta.status_code == 403
    async with sesiones() as db:
        assert (await db.get(LiveSession, sesion_id)).status == "live"


@pytest.mark.asyncio
async def test_un_aviso_con_la_autorizacion_equivocada_tampoco(entorno):
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http)
    await _con_sala(sesiones, sesion_id)

    respuesta = await _mandar(http, _aviso(sesion_id), autorizacion="otra_cosa")
    assert respuesta.status_code == 403
    async with sesiones() as db:
        assert (await db.get(LiveSession, sesion_id)).status == "live"


@pytest.mark.asyncio
async def test_un_aviso_de_cierre_termina_la_emision(entorno):
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http)
    await _con_sala(sesiones, sesion_id)

    assert (await _mandar(http, _aviso(sesion_id))).status_code == 204
    async with sesiones() as db:
        sesion = await db.get(LiveSession, sesion_id)
        assert sesion.status == "ended"
        assert sesion.ended_at is not None


@pytest.mark.asyncio
async def test_el_mismo_aviso_dos_veces_no_hace_nada_la_segunda(entorno):
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http)
    await _con_sala(sesiones, sesion_id)

    assert (await _mandar(http, _aviso(sesion_id))).status_code == 204
    async with sesiones() as db:
        primero = (await db.get(LiveSession, sesion_id)).ended_at

    assert (await _mandar(http, _aviso(sesion_id))).status_code == 204
    async with sesiones() as db:
        assert (await db.get(LiveSession, sesion_id)).ended_at == primero


@pytest.mark.asyncio
async def test_un_aviso_TARDIO_sobre_una_emision_ya_terminada_no_la_reabre(entorno):
    """El UPDATE es condicional, así que afecta a cero filas y no cambia nada."""
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http)
    await _con_sala(sesiones, sesion_id, estado="ended")

    assert (await _mandar(http, _aviso(sesion_id, event_id="evt_tardio"))).status_code == 204
    async with sesiones() as db:
        assert (await db.get(LiveSession, sesion_id)).status == "ended"


@pytest.mark.asyncio
async def test_un_cierre_sobre_una_emision_PROGRAMADA_no_la_termina(entorno):
    """Una emisión que nunca empezó no se termina porque el proveedor cierre
    una sala vacía: seguiría pudiendo emitirse a la hora prevista."""
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http, estado="scheduled")
    await _con_sala(sesiones, sesion_id, estado="scheduled")

    assert (await _mandar(http, _aviso(sesion_id))).status_code == 204
    async with sesiones() as db:
        assert (await db.get(LiveSession, sesion_id)).status == "scheduled"


@pytest.mark.asyncio
async def test_un_aviso_de_FALLO_no_le_quita_la_sala_al_anfitrion(entorno):
    """Un fallo del proveedor puede ser pasajero y el anfitrión puede estar
    reconectando; cerrarla le quitaría la sala debajo."""
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http)
    await _con_sala(sesiones, sesion_id)

    aviso = _aviso(sesion_id, tipo="session.failure", event_id="evt_fallo")
    assert (await _mandar(http, aviso)).status_code == 204
    async with sesiones() as db:
        assert (await db.get(LiveSession, sesion_id)).status == "live"


@pytest.mark.asyncio
async def test_un_aviso_de_una_emision_desconocida_se_ignora(entorno):
    """De otro entorno, de otra cuenta, o de una emisión borrada."""
    http, _sesiones, _identidad, _doble = entorno
    aviso = _aviso("00000000-0000-0000-0000-00000000dead", event_id="evt_ajeno")
    assert (await _mandar(http, aviso)).status_code == 204


@pytest.mark.asyncio
async def test_un_aviso_que_no_nos_incumbe_se_acepta_y_se_ignora(entorno):
    """Responder con error haría que el proveedor reintentara en bucle."""
    http, sesiones, _identidad, _doble = entorno
    sesion_id = await _emision(http)
    await _con_sala(sesiones, sesion_id)

    aviso = _aviso(sesion_id, tipo="algo.que.no.existe", event_id="evt_raro")
    assert (await _mandar(http, aviso)).status_code == 204
    async with sesiones() as db:
        assert (await db.get(LiveSession, sesion_id)).status == "live"


@pytest.mark.asyncio
async def test_un_cuerpo_ilegible_no_revienta_el_endpoint(entorno):
    http, _sesiones, _identidad, _doble = entorno
    respuesta = await http.post(
        f"{LIVE}/webhook/100ms",
        content=b"<html>no soy json</html>",
        headers={"content-type": "application/json", "authorization": SECRETO},
    )
    assert respuesta.status_code == 204
