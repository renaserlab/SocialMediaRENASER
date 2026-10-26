"""Las comunidades de un grupo (migración 0109) y cómo encajan con lo que ya había.

Decidido el 26/10/2026 (`docs/CONTRATOS_TEMAS_Y_COMUNIDADES.md`). Lo que se
protege:

  · que solo quien administra el grupo cree, cambie y elimine comunidades, aunque
    se llame a la API a mano, y que eliminar sea suave y deje a todos fuera (D5);
  · que a una comunidad solo llegue quien es del grupo: de un toque si es
    `open`, pidiéndolo si es `request` (D2), y nunca alguien de fuera ni alguien
    con un bloqueo con quien administra, que recibe el mismo 404 que si no
    existiera;
  · que salir del grupo, o que te saquen, saque también de sus comunidades en
    el mismo instante (D10);
  · que haya un solo nivel: nada de comunidades, filtros ni enlace dentro de
    una comunidad o del chat de un tema;
  · que la bandeja nueva (`grouped=true`) esconda las comunidades y sume lo suyo
    al grupo, y que la de siempre las siga enseñando como antes;
  · que leer la lista y la bandeja no cueste una consulta por fila;
  · y lo que se cruza con los temas: sus chats no salen en la bandeja, en ellos
    solo escribe quien administra, el silencio del grupo vale para sus avisos y
    entrar o salir del grupo sincroniza sus miembros.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event, func, select, update

# `app.main` va primero: ver la nota en `test_grupos_de_mensajeria.py`.
from app.main import app  # noqa: F401, I001
from app.modules.messaging import entrada_a_grupos, grupos, temas
from app.modules.messaging import router as messaging_router
from app.modules.messaging.models import (
    Conversation,
    ConversationMember,
    GroupJoinRequest,
    Message,
)
from app.modules.messaging.subgrupos import GroupSubgroup
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
    _mensaje,
    entorno,
)

NADIE = "aaaaaaaa-0000-0000-0000-00000000dead"


@pytest.fixture
def avisos(monkeypatch):
    capturados: list[dict] = []

    def _retener(_background, **kwargs):
        capturados.append(kwargs)

    for modulo in (entrada_a_grupos, grupos, messaging_router):
        monkeypatch.setattr(modulo, "encolar_push", _retener)
    return capturados


async def _crear(http, titulo="Valorant", *, entrada="open", descripcion="", grupo=GRUPO):
    return await http.post(
        f"{API}/{grupo}/subgroups",
        json={"title": titulo, "description": descripcion, "entry": entrada},
    )


async def _crear_ok(http, titulo="Valorant", **kwargs) -> dict:
    respuesta = await _crear(http, titulo, **kwargs)
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()


async def _lista(http, grupo=GRUPO) -> dict:
    respuesta = await http.get(f"{API}/{grupo}/subgroups")
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


async def _unirse(http, sub: str, grupo=GRUPO):
    return await http.post(f"{API}/{grupo}/subgroups/{sub}/join")


async def _es_miembro(sesiones, conv: str, uid: str) -> bool:
    async with sesiones() as db:
        return (
            await db.get(ConversationMember, {"conversation_id": conv, "user_id": uid})
        ) is not None


async def _escribir(http, identidad, conv: str, quien: str, texto: str):
    identidad["uid"] = quien
    respuesta = await http.post(f"{API}/{conv}/messages", json={"body": texto})
    return respuesta


async def _bandeja(http, **params) -> dict[str, dict]:
    respuesta = await http.get(API, params={"limit": 100, **params})
    assert respuesta.status_code == 200, respuesta.text
    return {fila["id"]: fila for fila in respuesta.json()}


def codigo(respuesta) -> str:
    return respuesta.json()["error"]["code"]


# --------------------------------------------------------------------------- #
# 1. Crear, listar, cambiar y eliminar
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_quien_administra_crea_y_todos_los_del_grupo_las_ven(entorno):
    http, sesiones, identidad = entorno
    valorant = await _crear_ok(http, "  Valorant   PC ", descripcion=" Jugamos ")
    assert valorant["title"] == "Valorant PC"
    assert valorant["description"] == "Jugamos"
    assert valorant["entry"] == "open"
    assert valorant["position"] == 0
    assert valorant["members_count"] == 1
    assert valorant["is_member"] is True
    assert valorant["last"] is None

    lectura = await _crear_ok(http, "Lectura", entrada="request")
    assert lectura["position"] == 1

    # La comunidad es un grupo normal, creado por quien administra y con él
    # como único miembro.
    async with sesiones() as db:
        fila = (
            await db.execute(
                select(Conversation.kind, Conversation.created_by).where(
                    Conversation.id == valorant["id"]
                )
            )
        ).one()
        assert (fila.kind, fila.created_by) == ("group", ANA)
        padre = await db.scalar(
            select(GroupSubgroup.parent_id).where(
                GroupSubgroup.conversation_id == valorant["id"]
            )
        )
        assert padre == GRUPO

    lista = await _lista(http)
    assert lista["available"] is True
    assert lista["can_manage"] is True
    assert [c["id"] for c in lista["subgroups"]] == [valorant["id"], lectura["id"]]

    # Un miembro las ve todas, también aquellas en las que no está, sin poder
    # gestionarlas ni ver lo de dentro.
    identidad["uid"] = BRUNO
    lista = await _lista(http)
    assert lista["can_manage"] is False
    assert [(c["title"], c["is_member"], c["entry"]) for c in lista["subgroups"]] == [
        ("Valorant PC", False, "open"),
        ("Lectura", False, "request"),
    ]
    assert all(c["pending_requests"] == 0 for c in lista["subgroups"])

    # Quien no es del grupo, ni la lista.
    identidad["uid"] = DAVID
    assert (await http.get(f"{API}/{GRUPO}/subgroups")).status_code == 403


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cuerpo",
    [
        {"title": "   "},
        {"title": "x" * 61},
        {"title": "Larga", "description": "x" * 201},
        {"title": "Rara", "entry": "a_dedo"},
        {"title": "Con dueño", "created_by": BRUNO},
        {"description": "sin nombre"},
    ],
)
async def test_una_comunidad_mal_escrita_no_se_crea(entorno, cuerpo):
    http, sesiones, _ = entorno
    respuesta = await http.post(f"{API}/{GRUPO}/subgroups", json=cuerpo)
    assert respuesta.status_code == 422, respuesta.text
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(GroupSubgroup)) == 0


@pytest.mark.asyncio
async def test_solo_quien_administra_crea_cambia_y_elimina(entorno):
    http, _, identidad = entorno
    sub = (await _crear_ok(http))["id"]

    identidad["uid"] = BRUNO
    for respuesta in (
        await _crear(http, "Mía"),
        await http.patch(f"{API}/{GRUPO}/subgroups/{sub}", json={"title": "Robada"}),
        await http.delete(f"{API}/{GRUPO}/subgroups/{sub}"),
    ):
        assert respuesta.status_code == 403, respuesta.text
        assert codigo(respuesta) == "group_admin_required"

    # Quien no es del grupo: el 403 de siempre, antes de mirar nada más.
    identidad["uid"] = DAVID
    assert (await _crear(http, "De fuera")).status_code == 403

    # En un chat de dos no caben comunidades.
    identidad["uid"] = ANA
    respuesta = await _crear(http, "Imposible", grupo=DIRECTO)
    assert respuesta.status_code == 409
    assert codigo(respuesta) == "not_a_group"

    # Y desde otro grupo no se alcanza: Bruno administra OTRO_GRUPO, no este.
    identidad["uid"] = BRUNO
    respuesta = await http.patch(f"{API}/{OTRO_GRUPO}/subgroups/{sub}", json={"title": "x"})
    assert respuesta.status_code == 404
    assert codigo(respuesta) == "subgroup_not_found"


@pytest.mark.asyncio
async def test_cambiar_una_comunidad(entorno):
    http, sesiones, identidad = entorno
    sub = (await _crear_ok(http, descripcion="Antes"))["id"]

    respuesta = await http.patch(
        f"{API}/{GRUPO}/subgroups/{sub}",
        json={"title": " Valorant  2 ", "description": "", "entry": "request", "position": 5},
    )
    assert respuesta.status_code == 200, respuesta.text
    cambiada = respuesta.json()
    assert [cambiada[c] for c in ("title", "description", "entry", "position")] == [
        "Valorant 2",
        "",
        "request",
        5,
    ]

    # Lo que no viene no se toca.
    respuesta = await http.patch(f"{API}/{GRUPO}/subgroups/{sub}", json={"position": 1})
    assert respuesta.json()["title"] == "Valorant 2"
    assert respuesta.json()["entry"] == "request"

    # Renombrar no es actividad: no sube la comunidad en la bandeja.
    async with sesiones() as db:
        antes = await db.scalar(select(Conversation.updated_at).where(Conversation.id == sub))
    await http.patch(f"{API}/{GRUPO}/subgroups/{sub}", json={"title": "Otro nombre"})
    async with sesiones() as db:
        despues = await db.scalar(select(Conversation.updated_at).where(Conversation.id == sub))
    assert despues == antes

    for cuerpo in ({"position": -1}, {"entry": "x"}, {"title": ""}, {"nada": 1}):
        assert (
            await http.patch(f"{API}/{GRUPO}/subgroups/{sub}", json=cuerpo)
        ).status_code == 422, cuerpo


@pytest.mark.asyncio
async def test_eliminar_es_suave_y_deja_a_todos_fuera(entorno):
    """D5: se marca, se quitan sus miembros y los mensajes se quedan en la base."""
    http, sesiones, identidad = entorno
    sub = (await _crear_ok(http))["id"]
    otra = (await _crear_ok(http, "Lectura", entrada="request"))["id"]
    identidad["uid"] = BRUNO
    assert (await _unirse(http, sub)).status_code == 204
    escrito = (await _escribir(http, identidad, sub, BRUNO, "hola")).json()["id"]
    # Una solicitud viva a la que se elimina no puede quedarse esperando.
    identidad["uid"] = CARLA
    assert (await http.post(f"{API}/{sub}/join-requests", json={})).status_code == 201

    identidad["uid"] = ANA
    assert (await http.delete(f"{API}/{GRUPO}/subgroups/{sub}")).status_code == 204

    assert [c["id"] for c in (await _lista(http))["subgroups"]] == [otra]
    assert not await _es_miembro(sesiones, sub, ANA)
    assert not await _es_miembro(sesiones, sub, BRUNO)
    async with sesiones() as db:
        # La conversación y lo escrito siguen ahí, sin lápida: nadie lo borró.
        mensaje = await db.get(Message, escrito)
        assert mensaje is not None and mensaje.deleted_at is None
        assert await db.get(Conversation, sub) is not None
        assert (
            await db.scalar(
                select(GroupSubgroup.deleted_at).where(GroupSubgroup.conversation_id == sub)
            )
        ) is not None
        assert (
            await db.scalar(
                select(GroupJoinRequest.status).where(
                    GroupJoinRequest.conversation_id == sub, GroupJoinRequest.user_id == CARLA
                )
            )
        ) == "cancelled"

    # Inaccesible para todos, también para quien la administraba.
    for uid in (ANA, BRUNO):
        identidad["uid"] = uid
        assert (await http.get(f"{API}/{sub}/messages")).status_code == 403
        assert sub not in await _bandeja(http)

    # Eliminarla otra vez: ya no existe.
    identidad["uid"] = ANA
    assert (await http.delete(f"{API}/{GRUPO}/subgroups/{sub}")).status_code == 404


@pytest.mark.asyncio
async def test_crear_comunidades_cuenta_en_el_tope_de_grupos_por_hora(entorno):
    """Una comunidad es un grupo: sin esto, serían la forma de saltarse el tope."""
    http, _, _ = entorno
    # El montaje ya trae GRUPO, creado por Ana hace un instante.
    for i in range(grupos.GRUPOS_POR_HORA - 1):
        assert (await _crear(http, f"Comunidad {i}")).status_code == 201
    de_mas = await _crear(http, "La que sobra")
    assert de_mas.status_code == 409
    assert codigo(de_mas) == "group_rate_limited"
    de_mas = await http.post(f"{API}/groups", json={"title": "Grupo", "member_ids": [BRUNO]})
    assert de_mas.status_code == 409


# --------------------------------------------------------------------------- #
# 2. Entrar
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_a_una_abierta_se_entra_de_un_toque_y_se_ve_todo_su_historial(entorno):
    """D1 y D2: un toque, y el historial entero."""
    http, sesiones, identidad = entorno
    sub = (await _crear_ok(http))["id"]
    assert (await _escribir(http, identidad, sub, ANA, "Bienvenidos")).status_code == 201

    identidad["uid"] = BRUNO
    assert (await _unirse(http, sub)).status_code == 204
    assert await _es_miembro(sesiones, sub, BRUNO)
    # Idempotente: otra vez, lo mismo.
    assert (await _unirse(http, sub)).status_code == 204

    historial = (await http.get(f"{API}/{sub}/messages")).json()
    assert [m["body"] for m in historial] == ["Bienvenidos"]

    fila = (await _lista(http))["subgroups"][0]
    assert fila["is_member"] is True
    assert fila["members_count"] == 2
    assert fila["unread_count"] == 1
    assert fila["last"]["sender_name"] == "Ana"
    assert fila["last"]["excerpt"] == "Bienvenidos"
    assert fila["last"]["kind"] == "text"


@pytest.mark.asyncio
async def test_lo_de_dentro_solo_lo_ve_quien_esta_dentro(entorno):
    http, sesiones, identidad = entorno
    sub = (await _crear_ok(http))["id"]
    await _escribir(http, identidad, sub, ANA, "Hoy a las 9: https://renaser.pe/partida")

    identidad["uid"] = CARLA
    fila = (await _lista(http))["subgroups"][0]
    assert fila["is_member"] is False
    assert fila["last"] is None
    assert fila["unread_count"] == 0
    # Ni leyendo el chat a mano.
    assert (await http.get(f"{API}/{sub}/messages")).status_code == 403

    identidad["uid"] = BRUNO
    await _unirse(http, sub)
    fila = (await _lista(http))["subgroups"][0]
    assert fila["last"]["kind"] == "link"

    # Una foto sin texto se resume como foto, no como una fila en blanco.
    mas_tarde = datetime(2099, 1, 1, tzinfo=timezone.utc)
    await _mensaje(sesiones, de=ANA, en=sub, adjuntos=("image",), cuando=mas_tarde)
    fila = (await _lista(http))["subgroups"][0]
    assert (fila["last"]["kind"], fila["last"]["excerpt"]) == ("image", "Foto")


@pytest.mark.asyncio
async def test_una_con_solicitud_se_pide_por_ser_del_grupo_y_decide_quien_administra(
    entorno, avisos
):
    http, sesiones, identidad = entorno
    sub = (await _crear_ok(http, "Lectura", entrada="request"))["id"]

    identidad["uid"] = BRUNO
    respuesta = await _unirse(http, sub)
    assert respuesta.status_code == 409
    assert codigo(respuesta) == "subgroup_requires_request"
    assert not await _es_miembro(sesiones, sub, BRUNO)

    # Sin enlace ni perfil: ser del grupo basta para pedirlo.
    pedida = await http.post(f"{API}/{sub}/join-requests", json={})
    assert pedida.status_code == 201, pedida.text
    assert pedida.json()["status"] == "pending"
    assert avisos[-1]["notification_type"] == "group_join_request"
    assert avisos[-1]["user_ids"] == [ANA]
    assert avisos[-1]["data"]["conversationId"] == sub
    assert (await _lista(http))["subgroups"][0]["request_pending"] is True

    identidad["uid"] = ANA
    fila = (await _lista(http))["subgroups"][0]
    assert fila["pending_requests"] == 1
    pendientes = (await http.get(f"{API}/{sub}/join-requests")).json()
    assert [p["user"]["id"] for p in pendientes] == [BRUNO]

    aceptada = await http.post(f"{API}/{sub}/join-requests/{pendientes[0]['id']}/approve")
    assert aceptada.status_code == 204, aceptada.text
    assert await _es_miembro(sesiones, sub, BRUNO)
    assert (await _lista(http))["subgroups"][0]["pending_requests"] == 0


@pytest.mark.asyncio
async def test_quien_no_es_del_grupo_recibe_404(entorno):
    http, _, identidad = entorno
    abierta = (await _crear_ok(http))["id"]
    cerrada = (await _crear_ok(http, "Lectura", entrada="request"))["id"]

    identidad["uid"] = DAVID
    for sub in (abierta, cerrada):
        respuesta = await _unirse(http, sub)
        assert respuesta.status_code == 404
        assert codigo(respuesta) == "subgroup_not_found"
    # Pedirlo tampoco: no hay enlace ni perfil que lo lleve hasta ahí.
    respuesta = await http.post(f"{API}/{cerrada}/join-requests", json={})
    assert respuesta.status_code == 404
    # Ni con una comunidad que no existe: el mismo 404.
    assert (await _unirse(http, NADIE)).json() == (await _unirse(http, abierta)).json()

    # Una comunidad de GRUPO no se alcanza por OTRO_GRUPO, aunque se sea de los dos.
    identidad["uid"] = CARLA
    assert (await _unirse(http, abierta, grupo=OTRO_GRUPO)).status_code == 404


@pytest.mark.asyncio
async def test_con_un_bloqueo_con_quien_administra_la_comunidad_no_existe(entorno):
    http, sesiones, identidad = entorno
    sub = (await _crear_ok(http))["id"]
    cerrada = (await _crear_ok(http, "Lectura", entrada="request"))["id"]
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=CARLA, blocked_id=ANA))
        await db.commit()

    identidad["uid"] = CARLA
    assert (await _lista(http))["subgroups"] == []
    respuesta = await _unirse(http, sub)
    assert respuesta.status_code == 404
    assert codigo(respuesta) == "subgroup_not_found"
    assert (await http.post(f"{API}/{cerrada}/join-requests", json={})).status_code == 404
    assert not await _es_miembro(sesiones, sub, CARLA)

    # Bruno, sin bloqueo, sigue viéndolas.
    identidad["uid"] = BRUNO
    assert len((await _lista(http))["subgroups"]) == 2


@pytest.mark.asyncio
async def test_a_una_comunidad_solo_se_anade_a_quien_ya_es_del_grupo(entorno):
    http, sesiones, _ = entorno
    sub = (await _crear_ok(http))["id"]

    de_fuera = await http.post(f"{API}/{sub}/members", json={"user_ids": [DAVID]})
    no_existe = await http.post(f"{API}/{sub}/members", json={"user_ids": [NADIE]})
    # El mismo error genérico de siempre: no dice si es de fuera o si no existe.
    assert de_fuera.status_code == 422
    assert codigo(de_fuera) == "group_member_not_allowed"
    assert de_fuera.json() == no_existe.json()
    assert not await _es_miembro(sesiones, sub, DAVID)

    dentro = await http.post(f"{API}/{sub}/members", json={"user_ids": [BRUNO]})
    assert dentro.status_code == 200, dentro.text
    assert await _es_miembro(sesiones, sub, BRUNO)


# --------------------------------------------------------------------------- #
# 3. Salir del grupo es salir de sus comunidades (D10)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_salir_del_grupo_saca_de_todas_sus_comunidades(entorno):
    http, sesiones, identidad = entorno
    una = (await _crear_ok(http))["id"]
    otra = (await _crear_ok(http, "Lectura"))["id"]
    cerrada = (await _crear_ok(http, "Club", entrada="request"))["id"]

    identidad["uid"] = BRUNO
    for sub in (una, otra):
        assert (await _unirse(http, sub)).status_code == 204
    assert (await http.post(f"{API}/{cerrada}/join-requests", json={})).status_code == 201

    assert (await http.delete(f"{API}/{GRUPO}/members/{BRUNO}")).status_code == 204
    for sub in (una, otra):
        assert not await _es_miembro(sesiones, sub, BRUNO)
        assert (await http.get(f"{API}/{sub}/messages")).status_code == 403
    async with sesiones() as db:
        assert (
            await db.scalar(
                select(GroupJoinRequest.status).where(
                    GroupJoinRequest.conversation_id == cerrada,
                    GroupJoinRequest.user_id == BRUNO,
                )
            )
        ) == "cancelled"


@pytest.mark.asyncio
async def test_que_te_saquen_del_grupo_tambien(entorno):
    http, sesiones, identidad = entorno
    sub = (await _crear_ok(http))["id"]
    identidad["uid"] = CARLA
    await _unirse(http, sub)
    # Carla también está en OTRO_GRUPO: lo de otro grupo no se toca.
    identidad["uid"] = ANA
    assert (await http.delete(f"{API}/{GRUPO}/members/{CARLA}")).status_code == 204
    assert not await _es_miembro(sesiones, sub, CARLA)
    assert await _es_miembro(sesiones, OTRO_GRUPO, CARLA)


@pytest.mark.asyncio
async def test_salir_de_una_comunidad_no_saca_del_grupo(entorno):
    http, sesiones, identidad = entorno
    sub = (await _crear_ok(http))["id"]
    identidad["uid"] = BRUNO
    await _unirse(http, sub)
    assert (await http.delete(f"{API}/{sub}/members/{BRUNO}")).status_code == 204
    assert not await _es_miembro(sesiones, sub, BRUNO)
    assert await _es_miembro(sesiones, GRUPO, BRUNO)
    # Y puede volver a entrar.
    assert (await _unirse(http, sub)).status_code == 204


# --------------------------------------------------------------------------- #
# 4. Un solo nivel
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_dentro_de_una_comunidad_no_hay_comunidades_ni_filtros_ni_enlace(entorno):
    http, _, _ = entorno
    sub = (await _crear_ok(http))["id"]

    for respuesta in (
        await _crear(http, "Nieta", grupo=sub),
        await http.post(
            f"{API}/{sub}/filters",
            json={"name": "Material", "criteria": {"keywords": ["examen"]}},
        ),
        await http.patch(f"{API}/{sub}/group/settings", json={"invite_enabled": True}),
        await http.post(f"{API}/{sub}/group/invite/rotate"),
    ):
        assert respuesta.status_code == 409, respuesta.text
        assert codigo(respuesta) == "not_a_top_level_group"

    # Su lista de comunidades sale vacía y sin ofrecer crear.
    assert await _lista(http, sub) == {"available": True, "can_manage": False, "subgroups": []}

    # Lo que SÍ tiene: nombre, foto y sus categorías automáticas.
    assert (await http.patch(f"{API}/{sub}/group", json={"title": "Renombrada"})).status_code == 204
    foto = await http.put(f"{API}/{sub}/group/photo", json={"avatar_path": f"{ANA}/c.jpg"})
    assert foto.status_code == 204, foto.text
    assert (await _lista(http))["subgroups"][0]["avatar_path"] == f"{ANA}/c.jpg"
    assert (await http.get(f"{API}/{sub}/views")).status_code == 200


@pytest.mark.asyncio
async def test_la_informacion_de_una_comunidad_dice_su_grupo(entorno):
    http, _, _ = entorno
    sub = (await _crear_ok(http))["id"]
    info = (await http.get(f"{API}/{sub}/info")).json()
    assert info["parent"] == {"id": GRUPO, "title": "Aula"}
    assert info["topic"] is None
    assert info["can_manage"] is True

    info = (await http.get(f"{API}/{GRUPO}/info")).json()
    assert info["parent"] is None
    assert info["topic"] is None


@pytest.mark.asyncio
async def test_la_disponibilidad_anuncia_temas_y_comunidades(entorno):
    http, _, _ = entorno
    disponible = (await http.get(f"{API}/availability")).json()
    assert disponible["subgroups"] is True
    assert disponible["topics"] is True


# --------------------------------------------------------------------------- #
# 5. La bandeja
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_bandeja_agrupada_esconde_las_comunidades_y_suma_lo_suyo(entorno):
    http, sesiones, identidad = entorno
    sub = (await _crear_ok(http))["id"]
    await _crear_ok(http, "Lectura")
    identidad["uid"] = BRUNO
    await _unirse(http, sub)
    await _escribir(http, identidad, sub, ANA, "uno")
    await _escribir(http, identidad, sub, ANA, "dos")
    await _mensaje(sesiones, de=CARLA, texto="en General", en=GRUPO)

    identidad["uid"] = BRUNO
    bandeja = await _bandeja(http, grouped="true")
    assert sub not in bandeja
    grupo = bandeja[GRUPO]
    assert grupo["unread_count"] == 1
    assert grupo["subgroups_count"] == 2
    assert grupo["total_unread"] == 3
    assert grupo["parent_id"] is None

    # Carla no está en la comunidad: lo de dentro no le suma.
    identidad["uid"] = CARLA
    grupo = (await _bandeja(http, grouped="true"))[GRUPO]
    assert grupo["subgroups_count"] == 2
    assert grupo["total_unread"] == grupo["unread_count"] == 0

    # Leer la comunidad baja el total del grupo.
    identidad["uid"] = BRUNO
    assert (await http.post(f"{API}/{sub}/read")).status_code == 204
    assert (await _bandeja(http, grouped="true"))[GRUPO]["total_unread"] == 1


@pytest.mark.asyncio
async def test_sin_grouped_las_comunidades_salen_como_antes(entorno):
    """Las versiones ya instaladas no saben abrir una comunidad desde su grupo:
    si no la vieran suelta, perderían el acceso."""
    http, sesiones, identidad = entorno
    sub = (await _crear_ok(http))["id"]
    identidad["uid"] = BRUNO
    await _unirse(http, sub)
    await _escribir(http, identidad, sub, ANA, "uno")
    await _mensaje(sesiones, de=CARLA, texto="en General", en=GRUPO)

    identidad["uid"] = BRUNO
    bandeja = await _bandeja(http)
    comunidad = bandeja[sub]
    assert comunidad["kind"] == "group"
    assert comunidad["title"] == "Valorant"
    assert comunidad["parent_id"] == GRUPO
    assert comunidad["unread_count"] == comunidad["total_unread"] == 1
    grupo = bandeja[GRUPO]
    assert grupo["total_unread"] == grupo["unread_count"] == 1
    assert (grupo["subgroups_count"], grupo["topics_count"]) == (0, 0)


def _contar_selects(sesiones):
    sentencias: list[str] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        if statement.lstrip().lower().startswith("select"):
            sentencias.append(statement)

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    return sentencias, lambda: event.remove(motor, "before_cursor_execute", _anotar)


@pytest.mark.asyncio
async def test_la_bandeja_agrupada_no_cuesta_una_consulta_por_grupo(entorno):
    """Lo de dentro se lee por lotes: dos grupos y cinco cuestan lo mismo."""
    http, sesiones, identidad = entorno
    sub = (await _crear_ok(http))["id"]
    identidad["uid"] = BRUNO
    await _unirse(http, sub)
    await _escribir(http, identidad, sub, ANA, "uno")
    identidad["uid"] = BRUNO
    await _bandeja(http, grouped="true")  # en vacío: lo que se cachea no cuenta

    sentencias, quitar = _contar_selects(sesiones)
    try:
        pocas = await _bandeja(http, grouped="true")
    finally:
        quitar()
    con_pocos = len(sentencias)

    # Tres grupos más de Bruno, cada uno con su comunidad y algo sin leer.
    for i in range(3):
        identidad["uid"] = BRUNO
        nuevo = (
            await http.post(f"{API}/groups", json={"title": f"G{i}", "member_ids": [CARLA]})
        ).json()["id"]
        hija = (await _crear_ok(http, f"Hija {i}", grupo=nuevo))["id"]
        await _escribir(http, identidad, hija, BRUNO, "hola")
        identidad["uid"] = CARLA
        await _unirse(http, hija, grupo=nuevo)
        await _escribir(http, identidad, hija, CARLA, "respuesta")
    identidad["uid"] = BRUNO

    sentencias, quitar = _contar_selects(sesiones)
    try:
        muchas = await _bandeja(http, grouped="true")
    finally:
        quitar()
    assert len(muchas) == len(pocas) + 3
    assert len(sentencias) == con_pocos, (
        f"{con_pocos} consultas con {len(pocas)} filas y {len(sentencias)} con {len(muchas)}"
    )


@pytest.mark.asyncio
async def test_la_lista_de_comunidades_no_cuesta_una_consulta_por_comunidad(entorno):
    http, sesiones, identidad = entorno
    for i in range(2):
        sub = (await _crear_ok(http, f"C{i}"))["id"]
        await _escribir(http, identidad, sub, ANA, "hola")
        identidad["uid"] = BRUNO
        await _unirse(http, sub)
        identidad["uid"] = ANA
    identidad["uid"] = BRUNO
    await _lista(http)

    sentencias, quitar = _contar_selects(sesiones)
    try:
        await _lista(http)
    finally:
        quitar()
    con_dos = len(sentencias)

    identidad["uid"] = ANA
    for i in range(2, 6):
        sub = (await _crear_ok(http, f"C{i}"))["id"]
        await _escribir(http, identidad, sub, ANA, "hola")
        identidad["uid"] = BRUNO
        await _unirse(http, sub)
        identidad["uid"] = ANA
    identidad["uid"] = BRUNO

    sentencias, quitar = _contar_selects(sesiones)
    try:
        assert len((await _lista(http))["subgroups"]) == 6
    finally:
        quitar()
    assert len(sentencias) == con_dos


# --------------------------------------------------------------------------- #
# 6. Lo que se cruza con los temas (`temas.py`)
# --------------------------------------------------------------------------- #
async def _tema(http, identidad, nombre: str = "Anuncios") -> dict:
    identidad["uid"] = ANA
    respuesta = await http.post(f"{API}/{GRUPO}/topics", json={"name": nombre})
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()


@pytest.mark.asyncio
async def test_los_chats_de_los_temas_no_salen_nunca_en_la_bandeja(entorno):
    http, _, identidad = entorno
    chat = (await _tema(http, identidad))["chat_id"]
    await _escribir(http, identidad, chat, ANA, "Anuncio")

    for uid in (ANA, BRUNO):
        identidad["uid"] = uid
        assert chat not in await _bandeja(http)
        agrupada = await _bandeja(http, grouped="true")
        assert chat not in agrupada
        assert agrupada[GRUPO]["topics_count"] == 1


@pytest.mark.asyncio
async def test_en_un_tema_solo_escribe_quien_administra_el_grupo(entorno):
    http, _, identidad = entorno
    chat = (await _tema(http, identidad))["chat_id"]

    respuesta = await _escribir(http, identidad, chat, BRUNO, "Yo también")
    assert respuesta.status_code == 403
    assert codigo(respuesta) == "topic_admin_only"
    assert (await _escribir(http, identidad, chat, ANA, "Anuncio")).status_code == 201


@pytest.mark.asyncio
async def test_lo_escrito_en_un_tema_suma_en_el_total_del_grupo(entorno):
    http, sesiones, identidad = entorno
    chat = (await _tema(http, identidad))["chat_id"]
    await _escribir(http, identidad, chat, ANA, "uno")
    await _escribir(http, identidad, chat, ANA, "dos")

    identidad["uid"] = BRUNO
    grupo = (await _bandeja(http, grouped="true"))[GRUPO]
    assert grupo["unread_count"] == 0
    assert grupo["total_unread"] == 2
    # Sin `grouped`, como antes: solo General.
    assert (await _bandeja(http))[GRUPO]["total_unread"] == 0
    # Quien lo escribió no lo tiene pendiente.
    identidad["uid"] = ANA
    assert (await _bandeja(http, grouped="true"))[GRUPO]["total_unread"] == 0

    # Quien llega nuevo al grupo empieza en cero: lo anterior no le cuenta. Su
    # entrada se adelanta un minuto porque en SQLite la marca tiene resolución
    # de segundo y entraría en el mismo instante en que se escribió.
    assert (
        await http.post(f"{API}/{GRUPO}/members", json={"user_ids": [DAVID]})
    ).status_code == 200
    async with sesiones() as db:
        await db.execute(
            update(ConversationMember)
            .where(
                ConversationMember.conversation_id == chat,
                ConversationMember.user_id == DAVID,
            )
            .values(joined_at=datetime.now(timezone.utc) + timedelta(minutes=1))
        )
        await db.commit()
    identidad["uid"] = DAVID
    assert (await _bandeja(http, grouped="true"))[GRUPO]["total_unread"] == 0

    # La bandeja suma por lotes y `temas.py` cuenta grupo a grupo: tienen que
    # decir lo mismo, o el número del grupo y el de sus temas no cuadrarían.
    async with sesiones() as db:
        for uid, esperado in ((BRUNO, 2), (CARLA, 2), (ANA, 0), (DAVID, 0)):
            assert await temas.no_leidos_de_temas(db, GRUPO, uid) == esperado, uid


@pytest.mark.asyncio
async def test_el_aviso_de_un_tema_no_llega_a_quien_silencio_el_grupo(entorno, avisos):
    """D14: quien silencia el grupo no sabe que sus temas son otros chats."""
    http, _, identidad = entorno
    chat = (await _tema(http, identidad))["chat_id"]
    identidad["uid"] = BRUNO
    assert (await http.put(f"{API}/{GRUPO}/mute")).status_code == 204

    avisos.clear()
    assert (await _escribir(http, identidad, chat, ANA, "Anuncio")).status_code == 201
    assert [sorted(a["user_ids"]) for a in avisos] == [[CARLA]]


@pytest.mark.asyncio
async def test_entrar_y_salir_del_grupo_sincroniza_los_chats_de_los_temas(entorno):
    http, sesiones, identidad = entorno
    chat = (await _tema(http, identidad))["chat_id"]

    identidad["uid"] = ANA
    assert (
        await http.post(f"{API}/{GRUPO}/members", json={"user_ids": [DAVID]})
    ).status_code == 200
    assert await _es_miembro(sesiones, chat, DAVID)

    identidad["uid"] = BRUNO
    assert (await http.delete(f"{API}/{GRUPO}/members/{BRUNO}")).status_code == 204
    assert not await _es_miembro(sesiones, chat, BRUNO)

    # Y al aceptar una solicitud, también.
    identidad["uid"] = ANA
    await http.patch(f"{API}/{GRUPO}/group/settings", json={"listed_on_profile": True})
    identidad["uid"] = BRUNO
    pedida = (await http.post(f"{API}/{GRUPO}/join-requests", json={})).json()
    identidad["uid"] = ANA
    assert (
        await http.post(f"{API}/{GRUPO}/join-requests/{pedida['id']}/approve")
    ).status_code == 204
    assert await _es_miembro(sesiones, chat, BRUNO)


@pytest.mark.asyncio
async def test_la_informacion_del_chat_de_un_tema_dice_cual_es(entorno):
    http, _, identidad = entorno
    tema = await _tema(http, identidad)
    identidad["uid"] = BRUNO
    info = (await http.get(f"{API}/{tema['chat_id']}/info")).json()
    assert info["topic"] == {"group_id": GRUPO, "topic_id": tema["id"], "name": "Anuncios"}
    assert info["parent"] is None
    # Ni foto, ni enlace, ni solicitudes: ahí no aplican y no se ofrecen.
    identidad["uid"] = ANA
    info = (await http.get(f"{API}/{tema['chat_id']}/info")).json()
    assert info["extras_available"] is False
    assert info["settings"] is None


@pytest.mark.asyncio
async def test_el_chat_de_un_tema_no_se_toca_como_un_grupo(entorno):
    """Su nombre es el del tema y sus miembros, los del grupo."""
    http, _, identidad = entorno
    chat = (await _tema(http, identidad))["chat_id"]

    identidad["uid"] = ANA
    for respuesta in (
        await http.patch(f"{API}/{chat}/group", json={"title": "Otro"}),
        await http.post(f"{API}/{chat}/members", json={"user_ids": [DAVID]}),
        await http.delete(f"{API}/{chat}/members/{BRUNO}"),
        await _crear(http, "Dentro del tema", grupo=chat),
        await http.post(
            f"{API}/{chat}/filters",
            json={"name": "Material", "criteria": {"keywords": ["examen"]}},
        ),
        await http.put(f"{API}/{chat}/group/photo", json={"avatar_path": f"{ANA}/x.jpg"}),
    ):
        assert respuesta.status_code == 409, respuesta.text
        assert codigo(respuesta) == "not_a_top_level_group"

    # Salir de él por separado tampoco: se sale del grupo.
    identidad["uid"] = BRUNO
    assert (await http.delete(f"{API}/{chat}/members/{BRUNO}")).status_code == 409
    # Y nadie pide entrar a él.
    identidad["uid"] = DAVID
    assert (await http.post(f"{API}/{chat}/join-requests", json={})).status_code == 404
