"""Cómo se entra a un grupo: foto, enlace, «únete a mi grupo» y solicitudes.

Pedido el 10/10/2026. Lo que se protege:

  · que nadie entre solo: ni el enlace ni el perfil añaden a nadie, crean una
    solicitud que decide quien administra;
  · que a quien no es miembro se le enseñe la tarjeta y nada más, y solo de los
    grupos que su administrador decidió enseñar;
  · que un bloqueo deje el grupo «sin existir», sin decir por qué;
  · que solo quien administra cambie la foto, el enlace y responda solicitudes;
  · que pedir entrar no sirva para hacer sonar un teléfono sin parar;
  · que sin la migración 0104 los grupos sigan funcionando como antes.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update

# `app.main` va primero: ver la nota en `test_grupos_de_mensajeria.py`.
from app.main import app  # noqa: I001
from app.modules.messaging import entrada_a_grupos, grupos
from app.modules.messaging import router as messaging_router
from app.modules.messaging.models import (
    ConversationMember,
    GroupJoinRequest,
    GroupSettings,
)
from app.modules.notifications import push
from app.modules.social_graph.models import UserBlock
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

NADIE = "aaaaaaaa-0000-0000-0000-00000000dead"
FOTO = f"{ANA}/avatar-grupo.jpg"


@pytest.fixture
def avisos_enviados(monkeypatch):
    capturados: list[dict] = []

    def _retener(_background, **kwargs):
        capturados.append(kwargs)

    for modulo in (entrada_a_grupos, grupos, messaging_router):
        monkeypatch.setattr(modulo, "encolar_push", _retener)
    return capturados


@pytest_asyncio.fixture
async def sin_migracion():
    engine, sesiones, identidad = await _levantar(
        sin_tablas=("group_settings", "group_join_requests")
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad
    await _recoger(engine)


async def _info(http, conv: str = GRUPO) -> dict:
    respuesta = await http.get(f"{API}/{conv}/info")
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


async def _ajustar(http, conv: str = GRUPO, **cambios):
    return await http.patch(f"{API}/{conv}/group/settings", json=cambios)


async def _pedir(http, conv: str = GRUPO, code: str | None = None):
    return await http.post(f"{API}/{conv}/join-requests", json={"code": code} if code else {})


async def _bloquear(sesiones, quien: str, a_quien: str) -> None:
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=quien, blocked_id=a_quien))
        await db.commit()


async def _es_miembro(sesiones, conv: str, uid: str) -> bool:
    async with sesiones() as db:
        return (
            await db.get(ConversationMember, {"conversation_id": conv, "user_id": uid})
        ) is not None


# --------------------------------------------------------------------------- #
# 1. La foto del grupo
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_quien_administra_pone_y_quita_la_foto(entorno):
    http, _, identidad = entorno
    assert (await _info(http))["avatar_path"] is None

    assert (await http.put(f"{API}/{GRUPO}/group/photo", json={"avatar_path": FOTO})).status_code == 204
    assert (await _info(http))["avatar_path"] == FOTO

    # Sale también en la fila de la bandeja, para todos los miembros.
    identidad["uid"] = CARLA
    fila = next(c for c in (await http.get(API)).json() if c["id"] == GRUPO)
    assert fila["avatar_path"] == FOTO
    # Un chat de dos no lleva foto de grupo.
    identidad["uid"] = ANA
    directo = next((c for c in (await http.get(API)).json() if c["id"] == DIRECTO), None)
    assert directo is None or directo["avatar_path"] is None

    assert (await http.delete(f"{API}/{GRUPO}/group/photo")).status_code == 204
    assert (await _info(http))["avatar_path"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "ruta",
    [
        f"{BRUNO}/avatar-ajeno.jpg",          # la carpeta de otra persona
        f"{ANA}/",                            # la carpeta a secas
        f"{ANA}/../{BRUNO}/avatar.jpg",       # escapando de la suya
        "/absoluta.jpg",
        "",
    ],
)
async def test_la_foto_tiene_que_estar_en_la_carpeta_de_quien_la_pone(entorno, ruta):
    http, _, _ = entorno
    respuesta = await http.put(f"{API}/{GRUPO}/group/photo", json={"avatar_path": ruta})
    assert respuesta.status_code == 422, respuesta.text
    assert (await _info(http))["avatar_path"] is None


@pytest.mark.asyncio
async def test_un_miembro_no_cambia_la_foto_ni_los_ajustes(entorno):
    http, _, identidad = entorno
    identidad["uid"] = BRUNO
    foto = await http.put(f"{API}/{GRUPO}/group/photo", json={"avatar_path": f"{BRUNO}/a.jpg"})
    assert foto.status_code == 403
    assert (await http.delete(f"{API}/{GRUPO}/group/photo")).status_code == 403
    assert (await _ajustar(http, listed_on_profile=True)).status_code == 403
    assert (await http.post(f"{API}/{GRUPO}/group/invite/rotate")).status_code == 403
    assert (await http.get(f"{API}/{GRUPO}/join-requests")).status_code == 403
    # Y en un chat de dos, nada de esto vale.
    identidad["uid"] = ANA
    assert (await _ajustar(http, DIRECTO, listed_on_profile=True)).status_code == 409


# --------------------------------------------------------------------------- #
# 2. Los ajustes y el enlace
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_enlace_se_activa_se_desactiva_y_se_cambia(entorno):
    http, _, identidad = entorno
    info = await _info(http)
    assert info["extras_available"] is True
    # `entrada` llega con la 0112; las que ya existían quedan con solicitud.
    assert info["settings"] == {
        "listed_on_profile": False,
        "invite_enabled": False,
        "invite_code": None,
        "entrada": "request",
    }

    activado = (await _ajustar(http, invite_enabled=True)).json()
    codigo = activado["invite_code"]
    assert activado["invite_enabled"] is True
    assert re.fullmatch(r"[A-Za-z0-9_-]{16,64}", codigo)

    # Desactivarlo no lo borra: al volver a activarlo es el mismo enlace.
    assert (await _ajustar(http, invite_enabled=False)).json()["invite_code"] == codigo
    assert (await _ajustar(http, invite_enabled=True)).json()["invite_code"] == codigo

    cambiado = (await http.post(f"{API}/{GRUPO}/group/invite/rotate")).json()
    assert cambiado["invite_code"] != codigo
    assert cambiado["invite_enabled"] is True

    # El código es un secreto de quien administra: los demás miembros no lo ven.
    identidad["uid"] = CARLA
    de_carla = await _info(http)
    assert de_carla["settings"] is None
    assert de_carla["pending_requests"] == 0
    assert cambiado["invite_code"] not in str(de_carla)

    identidad["uid"] = ANA
    assert (await _ajustar(http, invite_code="elegido-por-mi-1234567")).status_code == 422


# --------------------------------------------------------------------------- #
# 3. Las tarjetas: lo que ve quien no está dentro
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_en_el_perfil_salen_solo_los_grupos_que_su_administrador_ensena(entorno):
    http, _, identidad = entorno
    identidad["uid"] = DAVID
    assert (await http.get(f"{API}/groups/of/{ANA}")).json() == []

    identidad["uid"] = ANA
    await _ajustar(http, listed_on_profile=True)
    await http.put(f"{API}/{GRUPO}/group/photo", json={"avatar_path": FOTO})

    identidad["uid"] = DAVID
    tarjetas = (await http.get(f"{API}/groups/of/{ANA}")).json()
    assert len(tarjetas) == 1
    tarjeta = tarjetas[0]
    assert tarjeta["id"] == GRUPO
    assert tarjeta["title"] == "Aula"
    assert tarjeta["avatar_path"] == FOTO
    assert tarjeta["members_count"] == 3
    assert tarjeta["admin"]["id"] == ANA
    assert tarjeta["my_status"] == "none"
    assert tarjeta["is_full"] is False
    # La tarjeta es TODO lo que se enseña: ni miembros, ni mensajes, ni enlace.
    # Los tres últimos son de la 0112: cómo se entra y cuántos grupos y temas.
    assert set(tarjeta) == {
        "id", "title", "avatar_path", "members_count", "admin", "my_status", "is_full",
        "entrada", "groups_count", "topics_count",
    }
    assert (tarjeta["entrada"], tarjeta["groups_count"], tarjeta["topics_count"]) == ("request", 0, 0)

    # Quien ya está dentro lo ve como miembro.
    identidad["uid"] = BRUNO
    assert (await http.get(f"{API}/groups/of/{ANA}")).json()[0]["my_status"] == "member"
    # Bruno administra OTRO_GRUPO, pero no lo enseña: su perfil no lo lista.
    identidad["uid"] = DAVID
    assert (await http.get(f"{API}/groups/of/{BRUNO}")).json() == []
    # Y Carla, que es miembro pero no administra nada, tampoco lista ninguno.
    assert (await http.get(f"{API}/groups/of/{CARLA}")).json() == []


@pytest.mark.asyncio
async def test_con_un_bloqueo_el_grupo_no_existe_para_quien_mira(entorno):
    http, sesiones, identidad = entorno
    codigo = (await _ajustar(http, listed_on_profile=True, invite_enabled=True)).json()["invite_code"]
    await _bloquear(sesiones, ANA, DAVID)

    identidad["uid"] = DAVID
    assert (await http.get(f"{API}/groups/of/{ANA}")).json() == []
    por_enlace = await http.get(f"{API}/groups/invite/{codigo}")
    inventado = await http.get(f"{API}/groups/invite/{'x' * 24}")
    pedir = await _pedir(http)
    pedir_con_enlace = await _pedir(http, code=codigo)
    pedir_a_uno_inventado = await _pedir(http, NADIE)
    for respuesta in (por_enlace, inventado, pedir, pedir_con_enlace, pedir_a_uno_inventado):
        assert respuesta.status_code == 404
    # Las respuestas son LA MISMA: no se dice que hay un bloqueo.
    assert por_enlace.json() == inventado.json()
    assert pedir.json() == pedir_a_uno_inventado.json()


@pytest.mark.asyncio
async def test_el_enlace_lleva_a_la_tarjeta_solo_mientras_vale(entorno):
    http, _, identidad = entorno
    codigo = (await _ajustar(http, invite_enabled=True)).json()["invite_code"]

    identidad["uid"] = DAVID
    tarjeta = await http.get(f"{API}/groups/invite/{codigo}")
    assert tarjeta.status_code == 200
    assert tarjeta.json()["id"] == GRUPO

    identidad["uid"] = ANA
    await _ajustar(http, invite_enabled=False)
    identidad["uid"] = DAVID
    assert (await http.get(f"{API}/groups/invite/{codigo}")).status_code == 404

    identidad["uid"] = ANA
    await _ajustar(http, invite_enabled=True)
    nuevo = (await http.post(f"{API}/{GRUPO}/group/invite/rotate")).json()["invite_code"]
    identidad["uid"] = DAVID
    # El enlace anterior deja de valer en el acto; el nuevo sí.
    assert (await http.get(f"{API}/groups/invite/{codigo}")).status_code == 404
    assert (await http.get(f"{API}/groups/invite/{nuevo}")).status_code == 200
    for basura in ("corto", "con espacios 1234567890", "a" * 65):
        assert (await http.get(f"{API}/groups/invite/{basura}")).status_code == 404


# --------------------------------------------------------------------------- #
# 4. Pedir entrar
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_pedir_entrar_no_mete_a_nadie_y_avisa_a_quien_administra(entorno, avisos_enviados):
    http, sesiones, identidad = entorno
    await _ajustar(http, listed_on_profile=True)

    identidad["uid"] = DAVID
    respuesta = await _pedir(http)
    assert respuesta.status_code == 201, respuesta.text
    solicitud = respuesta.json()
    assert solicitud["status"] == "pending"

    # NO está dentro: ni lee, ni escribe, ni ve el grupo en su bandeja.
    assert await _es_miembro(sesiones, GRUPO, DAVID) is False
    assert (await http.get(f"{API}/{GRUPO}/messages")).status_code == 403
    assert (await http.post(f"{API}/{GRUPO}/messages", json={"body": "Hola"})).status_code == 403
    assert (await http.get(f"{API}/groups/of/{ANA}")).json()[0]["my_status"] == "pending"

    # A quien administra le llega el aviso: quién y a qué grupo.
    assert len(avisos_enviados) == 1
    aviso = avisos_enviados[0]
    assert aviso["notification_type"] == "group_join_request"
    assert aviso["user_ids"] == [ANA]
    assert aviso["actor_name"] == "David"
    assert aviso["grupo"] == "Aula"
    assert aviso["data"] == {"type": "group_join", "conversationId": GRUPO}
    # Desde el 30/10/2026 el chat padre se llama «comunidad» en la aplicación.
    assert aviso["nivel"] == "comunidad"
    assert push.build_message(aviso["notification_type"], aviso["actor_name"], aviso["grupo"]) == (
        "Solicitud para unirse",
        "David quiere unirse a tu comunidad «Aula».",
    )
    assert push.CHANNELS["group_join_request"] == "mensajes"

    # Pedirlo otra vez devuelve la MISMA solicitud y no vuelve a avisar.
    otra_vez = await _pedir(http)
    assert otra_vez.json()["id"] == solicitud["id"]
    assert len(avisos_enviados) == 1
    async with sesiones() as db:
        filas = (await db.execute(select(GroupJoinRequest))).scalars().all()
        assert [(f.user_id, f.status, f.source) for f in filas] == [(DAVID, "pending", "profile")]


@pytest.mark.asyncio
async def test_solo_se_puede_pedir_entrar_por_el_perfil_o_con_el_enlace(entorno, avisos_enviados):
    http, sesiones, identidad = entorno
    # El grupo existe, David conoce su identificador, y aun así «no existe».
    identidad["uid"] = DAVID
    assert (await _pedir(http)).status_code == 404

    identidad["uid"] = ANA
    codigo = (await _ajustar(http, invite_enabled=True)).json()["invite_code"]
    identidad["uid"] = DAVID
    assert (await _pedir(http)).status_code == 404                      # sin código
    assert (await _pedir(http, code="x" * 24)).status_code == 404       # con otro
    con_enlace = await _pedir(http, code=codigo)
    assert con_enlace.status_code == 201
    async with sesiones() as db:
        assert (await db.execute(select(GroupJoinRequest.source))).scalar_one() == "link"

    # Con el enlace desactivado, el código deja de servir para pedir.
    identidad["uid"] = DAVID
    await http.delete(f"{API}/{GRUPO}/join-requests/mine")
    identidad["uid"] = ANA
    await _ajustar(http, invite_enabled=False)
    identidad["uid"] = DAVID
    assert (await _pedir(http, code=codigo)).status_code == 404
    assert avisos_enviados and all(a["user_ids"] == [ANA] for a in avisos_enviados)


@pytest.mark.asyncio
async def test_quien_ya_esta_dentro_no_pide_entrar_y_la_identidad_no_se_elige(entorno):
    http, _, identidad = entorno
    await _ajustar(http, listed_on_profile=True)
    identidad["uid"] = BRUNO
    dentro = await _pedir(http)
    assert dentro.status_code == 409
    assert dentro.json()["error"]["code"] == "already_member"

    identidad["uid"] = DAVID
    suplantando = await http.post(f"{API}/{GRUPO}/join-requests", json={"user_id": CARLA})
    assert suplantando.status_code == 422


@pytest.mark.asyncio
async def test_pedir_entrar_tiene_topes(entorno, monkeypatch):
    http, sesiones, identidad = entorno
    await _ajustar(http, listed_on_profile=True)
    identidad["uid"] = BRUNO
    await _ajustar(http, OTRO_GRUPO, listed_on_profile=True)

    # Un grupo lleno no admite solicitudes.
    monkeypatch.setattr(grupos, "MAX_MIEMBROS", 3)
    identidad["uid"] = DAVID
    lleno = await _pedir(http)
    assert lleno.status_code == 409
    assert lleno.json()["error"]["code"] == "group_is_full"
    assert (await http.get(f"{API}/groups/of/{ANA}")).json()[0]["is_full"] is True
    monkeypatch.setattr(grupos, "MAX_MIEMBROS", 100)

    # Y hay un tope de solicitudes por persona y hora, sea a los grupos que sea.
    monkeypatch.setattr(entrada_a_grupos, "SOLICITUDES_POR_HORA", 1)
    assert (await _pedir(http)).status_code == 201
    de_mas = await _pedir(http, OTRO_GRUPO)
    assert de_mas.status_code == 409
    assert de_mas.json()["error"]["code"] == "join_rate_limited"


# --------------------------------------------------------------------------- #
# 5. Responder: solo quien administra
# --------------------------------------------------------------------------- #
async def _con_solicitud(http, identidad) -> str:
    """David pide entrar al grupo de Ana. Devuelve el id de la solicitud."""
    identidad["uid"] = ANA
    await _ajustar(http, listed_on_profile=True)
    identidad["uid"] = DAVID
    solicitud = (await _pedir(http)).json()["id"]
    identidad["uid"] = ANA
    return solicitud


@pytest.mark.asyncio
async def test_quien_administra_ve_las_solicitudes_y_los_demas_no(entorno):
    http, _, identidad = entorno
    solicitud = await _con_solicitud(http, identidad)

    pendientes = (await http.get(f"{API}/{GRUPO}/join-requests")).json()
    assert [(p["id"], p["user"]["id"], p["user"]["full_name"], p["source"]) for p in pendientes] == [
        (solicitud, DAVID, "David", "profile")
    ]
    assert (await _info(http))["pending_requests"] == 1

    for uid in (BRUNO, DAVID):
        identidad["uid"] = uid
        assert (await http.get(f"{API}/{GRUPO}/join-requests")).status_code == 403
        assert (await http.post(f"{API}/{GRUPO}/join-requests/{solicitud}/approve")).status_code == 403
        assert (await http.post(f"{API}/{GRUPO}/join-requests/{solicitud}/reject")).status_code == 403


@pytest.mark.asyncio
async def test_aceptar_mete_a_la_persona_y_le_avisa(entorno, avisos_enviados):
    http, sesiones, identidad = entorno
    solicitud = await _con_solicitud(http, identidad)
    await _mensaje(sesiones, texto="Bienvenidos", en=GRUPO)
    avisos_enviados.clear()

    assert (await http.post(f"{API}/{GRUPO}/join-requests/{solicitud}/approve")).status_code == 204
    assert await _es_miembro(sesiones, GRUPO, DAVID) is True
    assert (await http.get(f"{API}/{GRUPO}/join-requests")).json() == []
    assert (await _info(http))["pending_requests"] == 0
    async with sesiones() as db:
        fila = (await db.execute(select(GroupJoinRequest))).scalar_one()
        assert (fila.status, fila.resolved_by) == ("approved", ANA)
        assert fila.resolved_at is not None

    # A David se le avisa con el aviso de «te añadieron», que abre el chat.
    assert [(a["notification_type"], a["user_ids"], a["grupo"]) for a in avisos_enviados] == [
        ("group_added", [DAVID], "Aula")
    ]
    identidad["uid"] = DAVID
    assert (await http.get(f"{API}/{GRUPO}/messages")).status_code == 200
    assert (await http.get(f"{API}/groups/of/{ANA}")).json()[0]["my_status"] == "member"

    # Ya está resuelta: no se puede responder dos veces.
    identidad["uid"] = ANA
    assert (await http.post(f"{API}/{GRUPO}/join-requests/{solicitud}/approve")).status_code == 404
    assert (await http.post(f"{API}/{GRUPO}/join-requests/{solicitud}/reject")).status_code == 404


@pytest.mark.asyncio
async def test_rechazar_no_avisa_y_hay_que_esperar_para_volver_a_pedir(entorno, avisos_enviados):
    http, sesiones, identidad = entorno
    solicitud = await _con_solicitud(http, identidad)
    avisos_enviados.clear()

    assert (await http.post(f"{API}/{GRUPO}/join-requests/{solicitud}/reject")).status_code == 204
    assert avisos_enviados == []                       # un «no» no se anuncia
    assert await _es_miembro(sesiones, GRUPO, DAVID) is False
    assert (await http.get(f"{API}/{GRUPO}/join-requests")).json() == []

    identidad["uid"] = DAVID
    pronto = await _pedir(http)
    assert pronto.status_code == 409
    assert pronto.json()["error"]["code"] == "join_request_too_soon"

    # Pasado el plazo, puede volver a pedirlo.
    async with sesiones() as db:
        await db.execute(
            update(GroupJoinRequest).values(
                resolved_at=datetime.now(timezone.utc) - entrada_a_grupos.ESPERA_TRAS_RECHAZO - timedelta(minutes=1)
            )
        )
        await db.commit()
    assert (await _pedir(http)).status_code == 201


@pytest.mark.asyncio
async def test_la_solicitud_de_otro_grupo_no_se_responde_desde_este(entorno):
    http, sesiones, identidad = entorno
    solicitud = await _con_solicitud(http, identidad)

    # Bruno administra OTRO_GRUPO y conoce el id de la solicitud del de Ana.
    identidad["uid"] = BRUNO
    assert (await http.post(f"{API}/{OTRO_GRUPO}/join-requests/{solicitud}/approve")).status_code == 404
    assert (await http.post(f"{API}/{OTRO_GRUPO}/join-requests/{solicitud}/reject")).status_code == 404
    assert await _es_miembro(sesiones, OTRO_GRUPO, DAVID) is False
    assert await _es_miembro(sesiones, GRUPO, DAVID) is False


@pytest.mark.asyncio
async def test_aceptar_respeta_el_tope_y_los_bloqueos(entorno, monkeypatch):
    http, sesiones, identidad = entorno
    solicitud = await _con_solicitud(http, identidad)

    monkeypatch.setattr(grupos, "MAX_MIEMBROS", 3)
    lleno = await http.post(f"{API}/{GRUPO}/join-requests/{solicitud}/approve")
    assert lleno.status_code == 409
    assert lleno.json()["error"]["code"] == "group_is_full"
    monkeypatch.setattr(grupos, "MAX_MIEMBROS", 100)

    # Entre que lo pidió y que se responde apareció un bloqueo: no entra.
    await _bloquear(sesiones, DAVID, ANA)
    bloqueado = await http.post(f"{API}/{GRUPO}/join-requests/{solicitud}/approve")
    assert bloqueado.status_code == 422
    assert await _es_miembro(sesiones, GRUPO, DAVID) is False


@pytest.mark.asyncio
async def test_quien_pide_puede_retirar_su_solicitud(entorno):
    http, sesiones, identidad = entorno
    await _con_solicitud(http, identidad)

    identidad["uid"] = DAVID
    assert (await http.delete(f"{API}/{GRUPO}/join-requests/mine")).status_code == 204
    assert (await http.delete(f"{API}/{GRUPO}/join-requests/mine")).status_code == 204   # sin nada que retirar
    assert (await http.get(f"{API}/groups/of/{ANA}")).json()[0]["my_status"] == "none"
    identidad["uid"] = ANA
    assert (await http.get(f"{API}/{GRUPO}/join-requests")).json() == []
    # Retirarla no es un rechazo: puede volver a pedirlo en el acto.
    identidad["uid"] = DAVID
    assert (await _pedir(http)).status_code == 201


@pytest.mark.asyncio
async def test_a_quien_se_anadio_a_mano_no_le_queda_una_solicitud_por_responder(entorno):
    http, _, identidad = entorno
    solicitud = await _con_solicitud(http, identidad)
    assert (await http.post(f"{API}/{GRUPO}/members", json={"user_ids": [DAVID]})).status_code == 200

    assert (await http.get(f"{API}/{GRUPO}/join-requests")).json() == []
    assert (await _info(http))["pending_requests"] == 0
    # Aceptarla igualmente no rompe nada: ya estaba dentro.
    assert (await http.post(f"{API}/{GRUPO}/join-requests/{solicitud}/approve")).status_code == 204


# --------------------------------------------------------------------------- #
# 6. Sin la migración 0104
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_la_0104_los_grupos_siguen_como_antes(sin_migracion):
    http, sesiones, identidad = sin_migracion
    info = await _info(http)
    assert info["extras_available"] is False
    assert info["avatar_path"] is None
    assert info["settings"] is None
    assert info["pending_requests"] == 0
    assert len(info["members"]) == 3

    # Lo de siempre funciona: la bandeja, crear un grupo y escribir.
    bandeja = (await http.get(API)).json()
    assert all(c["avatar_path"] is None for c in bandeja)
    creado = await http.post(f"{API}/groups", json={"title": "Nuevo", "member_ids": [BRUNO]})
    assert creado.status_code == 201
    assert (await http.post(f"{API}/{GRUPO}/messages", json={"body": "Hola"})).status_code == 201

    # Lo nuevo no existe: vacío al leer, 503 al escribir, 404 un enlace.
    assert (await http.get(f"{API}/groups/of/{ANA}")).json() == []
    assert (await http.get(f"{API}/groups/invite/{'x' * 24}")).status_code == 404
    assert (await http.get(f"{API}/{GRUPO}/join-requests")).json() == []
    for respuesta in (
        await _ajustar(http, listed_on_profile=True),
        await http.post(f"{API}/{GRUPO}/group/invite/rotate"),
        await http.put(f"{API}/{GRUPO}/group/photo", json={"avatar_path": FOTO}),
        await _pedir(http),
    ):
        assert respuesta.status_code == 503, respuesta.text
        assert respuesta.json()["error"]["code"] == "group_extras_not_available"
    assert (await http.delete(f"{API}/{GRUPO}/join-requests/mine")).status_code == 204


# --------------------------------------------------------------------------- #
# 7. La migración
# --------------------------------------------------------------------------- #
def _sql_de_la_0104() -> str:
    raiz = Path(__file__).resolve().parents[3]
    crudo = (raiz / "supabase" / "migrations" / "0104_puertas_de_grupo.sql").read_text(encoding="utf-8")
    return "\n".join(
        linea for linea in crudo.replace("\r\n", "\n").split("\n") if not linea.lstrip().startswith("--")
    )


def test_la_0104_crea_sus_dos_tablas_y_las_deja_cerradas():
    sql = _sql_de_la_0104()
    for tabla in ("group_settings", "group_join_requests"):
        assert f"create table if not exists public.{tabla}" in sql
        assert f"alter table public.{tabla} enable row level security" in sql
    assert "create policy" not in sql
    assert "alter publication" not in sql
    for tabla in ("messages", "conversations", "conversation_members", "profiles"):
        assert not re.search(rf"alter table public\.{tabla}\b", sql), tabla
    assert not re.search(r"\b(drop table|delete from|truncate|update public\.)", sql)
    # Una sola solicitud viva por persona y grupo, y un enlace por grupo.
    assert re.search(
        r"create unique index if not exists group_join_requests_pending_uidx\s+on public\.group_join_requests "
        r"\(conversation_id, user_id\)\s+where status = 'pending'",
        sql,
    )
    assert re.search(
        r"create unique index if not exists group_settings_invite_code_uidx\s+on public\.group_settings "
        r"\(invite_code\)\s+where invite_code is not null",
        sql,
    )


@pytest.mark.parametrize(
    ("tabla", "modelo"),
    [("group_settings", GroupSettings), ("group_join_requests", GroupJoinRequest)],
)
def test_las_tablas_de_los_modelos_son_las_de_la_migracion(tabla, modelo):
    sql = _sql_de_la_0104()
    inicio = sql.index(f"create table if not exists public.{tabla}")
    cuerpo = sql[inicio : sql.index(");", inicio)]
    del_sql = set(re.findall(r"^\s{2}([a-z_]+) ", cuerpo, flags=re.M))
    # La 0112 añade `entrada` a `group_settings` con un `alter table`; lo
    # comprueba `test_comunidades_en_el_perfil.py` contra su propio SQL.
    despues = {"group_settings": {"entrada"}}.get(tabla, set())
    assert del_sql | despues == {c.name for c in modelo.__table__.columns}


def test_los_codigos_que_se_generan_caben_en_la_restriccion_de_la_tabla():
    from app.modules.messaging import ajustes_de_grupo

    codigos = {ajustes_de_grupo.codigo_nuevo() for _ in range(200)}
    assert len(codigos) == 200
    assert all(re.fullmatch(r"[A-Za-z0-9_-]{16,64}", codigo) for codigo in codigos)
