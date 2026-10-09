"""Grupos de mensajería: crearlos, sus miembros y sus avisos.

Decidido el 09/10/2026: grupos libres, quien lo crea lo administra, y se puede
añadir a cualquiera con quien no haya un bloqueo. Lo que se protege:

  · que solo quien administra cambie el grupo, aunque se llame a la API a mano;
  · que un grupo no sirva para volver a llegar a quien te bloqueó, ni para
    averiguar que te bloqueó;
  · que quien sale pierda el acceso en el acto y sus mensajes se queden;
  · que el aviso diga quién escribió y en qué grupo, sin el texto;
  · que el chat de dos personas siga exactamente igual.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from sqlalchemy import func, select

# `app.main` VA PRIMERO, y no por orden alfabético: carga los módulos en el
# orden en que lo hace la aplicación. Importar `grupos` a pelo entra por
# `vistas → sesiones → bookings → messaging.router → grupos` y se encuentra a
# sí mismo a medio cargar (el mismo rodeo que ya tenía `sesiones`).
from app.main import app  # noqa: F401, I001
from app.modules.messaging import grupos
from app.modules.messaging import router as messaging_router
from app.modules.messaging.models import Conversation, ConversationMember, Message
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
    _mensaje,
    entorno,
)

NADIE = "aaaaaaaa-0000-0000-0000-00000000dead"


@pytest.fixture
def avisos_de_grupo(monkeypatch):
    """Los avisos que programan los grupos y el envío de mensajes."""
    capturados: list[dict] = []

    def _retener(_background, **kwargs):
        capturados.append(kwargs)

    monkeypatch.setattr(grupos, "encolar_push", _retener)
    monkeypatch.setattr(messaging_router, "encolar_push", _retener)
    return capturados


async def _crear(http, titulo: str = "Aula 3", miembros: tuple[str, ...] = (BRUNO, CARLA)):
    return await http.post(
        f"{API}/groups", json={"title": titulo, "member_ids": list(miembros)}
    )


async def _info(http, conv: str) -> dict:
    respuesta = await http.get(f"{API}/{conv}/info")
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


async def _bloquear(sesiones, quien: str, a_quien: str) -> None:
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=quien, blocked_id=a_quien))
        await db.commit()


# --------------------------------------------------------------------------- #
# 1. Crear un grupo
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_crear_un_grupo_mete_a_quien_lo_crea_y_a_quien_nombra(entorno, avisos_de_grupo):
    http, sesiones, identidad = entorno
    respuesta = await _crear(http, "  Aula   3 ")
    assert respuesta.status_code == 201, respuesta.text
    grupo = respuesta.json()
    assert grupo["kind"] == "group"
    assert grupo["title"] == "Aula 3"
    assert grupo["other"] is None

    info = await _info(http, grupo["id"])
    assert info["can_manage"] is True
    assert info["members_count"] == 3
    # Quien administra, el primero.
    assert [(m["id"], m["is_admin"]) for m in info["members"]] == [
        (ANA, True),
        (BRUNO, False),
        (CARLA, False),
    ]

    # Sale en la bandeja de todos aunque nadie haya escrito todavía.
    for uid in (ANA, BRUNO, CARLA):
        identidad["uid"] = uid
        bandeja = (await http.get(API)).json()
        assert grupo["id"] in [c["id"] for c in bandeja], uid
    identidad["uid"] = DAVID
    assert grupo["id"] not in [c["id"] for c in (await http.get(API)).json()]

    # Y a quienes se añadió se les avisa, diciendo quién y a qué grupo.
    assert len(avisos_de_grupo) == 1
    aviso = avisos_de_grupo[0]
    assert aviso["notification_type"] == "group_added"
    assert sorted(aviso["user_ids"]) == [BRUNO, CARLA]
    assert aviso["actor_name"] == "Ana"
    assert aviso["grupo"] == "Aula 3"
    assert aviso["data"] == {"type": "message", "conversationId": grupo["id"]}


@pytest.mark.asyncio
async def test_quien_crea_el_grupo_no_se_elige_desde_la_peticion(entorno):
    http, sesiones, _ = entorno
    respuesta = await http.post(
        f"{API}/groups",
        json={"title": "Suplantado", "member_ids": [BRUNO], "created_by": CARLA},
    )
    assert respuesta.status_code == 422
    creado = (await _crear(http, "Mío", (BRUNO,))).json()
    async with sesiones() as db:
        assert await db.scalar(
            select(Conversation.created_by).where(Conversation.id == creado["id"])
        ) == ANA


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cuerpo",
    [
        {"title": "   ", "member_ids": [BRUNO]},
        {"title": "x" * 61, "member_ids": [BRUNO]},
        {"title": "Sin nadie", "member_ids": []},
        {"title": "Mal escrito", "member_ids": ["no-es-un-uuid"]},
        {"title": "Solo yo", "member_ids": [ANA]},
        {"member_ids": [BRUNO]},
    ],
)
async def test_un_grupo_mal_escrito_no_se_crea(entorno, cuerpo):
    http, sesiones, _ = entorno
    respuesta = await http.post(f"{API}/groups", json=cuerpo)
    assert respuesta.status_code == 422, respuesta.text
    async with sesiones() as db:
        # Los dos grupos del montaje, y ninguno más.
        assert await db.scalar(
            select(func.count()).select_from(Conversation).where(Conversation.kind == "group")
        ) == 2


@pytest.mark.asyncio
async def test_no_se_anade_a_quien_te_bloqueo_y_no_se_dice_por_que(entorno, avisos_de_grupo):
    http, sesiones, _ = entorno
    await _bloquear(sesiones, BRUNO, ANA)    # Bruno bloqueó a Ana
    await _bloquear(sesiones, ANA, CARLA)    # Ana bloqueó a Carla

    por_bloqueada = await _crear(http, "A", (BRUNO, DAVID))
    por_bloquear = await _crear(http, "B", (CARLA, DAVID))
    no_existe = await _crear(http, "C", (NADIE, DAVID))

    # Las tres respuestas son LA MISMA: distinguirlas le diría a Ana que Bruno
    # la bloqueó.
    for respuesta in (por_bloqueada, por_bloquear, no_existe):
        assert respuesta.status_code == 422
        assert respuesta.json()["error"]["code"] == "group_member_not_allowed"
    assert por_bloqueada.json() == por_bloquear.json() == no_existe.json()
    assert avisos_de_grupo == []


@pytest.mark.asyncio
async def test_hay_un_tope_de_grupos_por_hora(entorno):
    http, _, _ = entorno
    # El montaje ya trae un grupo creado por Ana hace un instante.
    for i in range(grupos.GRUPOS_POR_HORA - 1):
        assert (await _crear(http, f"Grupo {i}", (BRUNO,))).status_code == 201
    de_mas = await _crear(http, "El que sobra", (BRUNO,))
    assert de_mas.status_code == 409
    assert de_mas.json()["error"]["code"] == "group_rate_limited"


# --------------------------------------------------------------------------- #
# 2. Quién está, y quién lo puede ver
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_informacion_solo_la_ven_los_miembros(entorno):
    http, _, identidad = entorno
    grupo = (await _crear(http)).json()["id"]

    identidad["uid"] = BRUNO
    info = await _info(http, grupo)
    assert info["can_manage"] is False
    assert info["title"] == "Aula 3"

    identidad["uid"] = DAVID
    assert (await http.get(f"{API}/{grupo}/info")).status_code == 403


@pytest.mark.asyncio
async def test_un_chat_de_dos_dice_que_no_es_un_grupo(entorno):
    http, _, _ = entorno
    info = await _info(http, DIRECTO)
    assert info["kind"] == "direct"
    assert info["can_manage"] is False
    assert sorted(m["id"] for m in info["members"]) == [ANA, BRUNO]
    assert not any(m["is_admin"] for m in info["members"])

    # Y nada de lo de los grupos vale en él.
    assert (await http.patch(f"{API}/{DIRECTO}/group", json={"title": "X"})).status_code == 409
    assert (await http.post(f"{API}/{DIRECTO}/members", json={"user_ids": [CARLA]})).status_code == 409
    salir = await http.delete(f"{API}/{DIRECTO}/members/{ANA}")
    assert salir.status_code == 409
    assert salir.json()["error"]["code"] == "not_a_group"


# --------------------------------------------------------------------------- #
# 3. Cambiar el grupo: solo quien lo administra
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_solo_quien_administra_cambia_el_nombre(entorno):
    http, _, identidad = entorno
    grupo = (await _crear(http)).json()["id"]

    identidad["uid"] = BRUNO
    negado = await http.patch(f"{API}/{grupo}/group", json={"title": "De Bruno"})
    assert negado.status_code == 403
    assert negado.json()["error"]["code"] == "group_admin_required"

    identidad["uid"] = ANA
    assert (await http.patch(f"{API}/{grupo}/group", json={"title": "  Aula  4 "})).status_code == 204
    assert (await _info(http, grupo))["title"] == "Aula 4"
    assert (await http.patch(f"{API}/{grupo}/group", json={"title": " "})).status_code == 422


@pytest.mark.asyncio
async def test_solo_quien_administra_anade_gente(entorno, avisos_de_grupo):
    http, _, identidad = entorno
    grupo = (await _crear(http, "Aula", (BRUNO,))).json()["id"]
    avisos_de_grupo.clear()

    identidad["uid"] = BRUNO
    negado = await http.post(f"{API}/{grupo}/members", json={"user_ids": [CARLA]})
    assert negado.status_code == 403

    identidad["uid"] = ANA
    # Bruno ya estaba: se queda como estaba, y solo se avisa a quien entra.
    respuesta = await http.post(f"{API}/{grupo}/members", json={"user_ids": [BRUNO, CARLA]})
    assert respuesta.status_code == 200, respuesta.text
    assert sorted(m["id"] for m in respuesta.json()["members"]) == [ANA, BRUNO, CARLA]
    assert len(avisos_de_grupo) == 1
    assert avisos_de_grupo[0]["user_ids"] == [CARLA]
    assert avisos_de_grupo[0]["grupo"] == "Aula"

    # Quien entra después ve el historial: la conversación es del grupo.
    identidad["uid"] = CARLA
    assert (await http.get(f"{API}/{grupo}/messages")).status_code == 200


@pytest.mark.asyncio
async def test_al_anadir_tambien_cuentan_los_bloqueos_y_el_tope(entorno, monkeypatch):
    http, sesiones, _ = entorno
    grupo = (await _crear(http, "Aula", (BRUNO,))).json()["id"]

    await _bloquear(sesiones, CARLA, ANA)
    bloqueada = await http.post(f"{API}/{grupo}/members", json={"user_ids": [CARLA]})
    assert bloqueada.status_code == 422
    assert bloqueada.json()["error"]["code"] == "group_member_not_allowed"

    monkeypatch.setattr(grupos, "MAX_MIEMBROS", 2)
    lleno = await http.post(f"{API}/{grupo}/members", json={"user_ids": [DAVID]})
    assert lleno.status_code == 409
    assert lleno.json()["error"]["code"] == "group_is_full"
    assert (await _info(http, grupo))["members_count"] == 2


@pytest.mark.asyncio
async def test_sacar_a_alguien_le_quita_el_acceso_y_deja_sus_mensajes(entorno):
    http, sesiones, identidad = entorno
    grupo = (await _crear(http)).json()["id"]
    de_bruno = await _mensaje(sesiones, de=BRUNO, texto="Sigo aquí", en=grupo)

    # Carla, que no administra, no puede sacar a Bruno.
    identidad["uid"] = CARLA
    assert (await http.delete(f"{API}/{grupo}/members/{BRUNO}")).status_code == 403

    identidad["uid"] = ANA
    assert (await http.delete(f"{API}/{grupo}/members/{BRUNO}")).status_code == 204
    assert sorted(m["id"] for m in (await _info(http, grupo))["members"]) == [ANA, CARLA]
    # Sacarlo otra vez: ya no está.
    assert (await http.delete(f"{API}/{grupo}/members/{BRUNO}")).status_code == 404

    # Bruno pierde el acceso a TODO, en el acto.
    identidad["uid"] = BRUNO
    for ruta in ("messages", "info", "views", "filters"):
        assert (await http.get(f"{API}/{grupo}/{ruta}")).status_code == 403, ruta
    assert (await http.get(f"{API}/{grupo}/views/messages", params={"category": "all"})).status_code == 403
    assert (await http.post(f"{API}/{grupo}/messages", json={"body": "Hola"})).status_code == 403
    assert grupo not in [c["id"] for c in (await http.get(API)).json()]

    # Lo que escribió se queda: es del grupo.
    identidad["uid"] = CARLA
    historial = (await http.get(f"{API}/{grupo}/messages")).json()
    assert [m["id"] for m in historial] == [de_bruno]
    assert historial[0]["sender"]["full_name"] == "Bruno"


@pytest.mark.asyncio
async def test_un_miembro_se_sale_y_quien_administra_no(entorno):
    http, sesiones, identidad = entorno
    grupo = (await _crear(http)).json()["id"]

    identidad["uid"] = CARLA
    assert (await http.delete(f"{API}/{grupo}/members/{CARLA}")).status_code == 204
    assert (await http.get(f"{API}/{grupo}/info")).status_code == 403

    identidad["uid"] = ANA
    salir = await http.delete(f"{API}/{grupo}/members/{ANA}")
    assert salir.status_code == 409
    assert salir.json()["error"]["code"] == "group_admin_cannot_leave"
    async with sesiones() as db:
        dentro = set(
            (
                await db.execute(
                    select(ConversationMember.user_id).where(
                        ConversationMember.conversation_id == grupo
                    )
                )
            ).scalars()
        )
    assert dentro == {ANA, BRUNO}


# --------------------------------------------------------------------------- #
# 4. Mensajes y avisos en un grupo
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_aviso_de_un_grupo_dice_quien_y_en_cual(entorno, avisos_de_grupo):
    http, _, identidad = entorno
    grupo = (await _crear(http, "Aula 3")).json()["id"]
    avisos_de_grupo.clear()

    identidad["uid"] = BRUNO
    enviado = await http.post(f"{API}/{grupo}/messages", json={"body": "El examen es el viernes"})
    assert enviado.status_code == 201, enviado.text

    assert len(avisos_de_grupo) == 1
    aviso = avisos_de_grupo[0]
    assert aviso["notification_type"] == "message_group"
    assert sorted(aviso["user_ids"]) == [ANA, CARLA]      # todos menos quien escribe
    assert aviso["actor_name"] == "Bruno"
    assert aviso["grupo"] == "Aula 3"
    # Lleva a la conversación, y NO lleva el texto del mensaje.
    assert aviso["data"] == {
        "type": "message",
        "conversationId": grupo,
        "messageId": enviado.json()["id"],
    }
    assert "examen" not in str(aviso)

    titulo, cuerpo = push.build_message(aviso["notification_type"], aviso["actor_name"], aviso["grupo"])
    assert (titulo, cuerpo) == ("Nuevo mensaje", "Bruno envió un mensaje al grupo «Aula 3».")


@pytest.mark.asyncio
async def test_en_un_grupo_tampoco_suena_el_telefono_de_quien_te_bloqueo(entorno, avisos_de_grupo):
    http, sesiones, identidad = entorno
    grupo = (await _crear(http)).json()["id"]
    await _bloquear(sesiones, CARLA, BRUNO)   # después de estar los dos dentro
    avisos_de_grupo.clear()

    identidad["uid"] = BRUNO
    assert (await http.post(f"{API}/{grupo}/messages", json={"body": "Hola"})).status_code == 201
    assert avisos_de_grupo[0]["user_ids"] == [ANA]


@pytest.mark.asyncio
async def test_el_aviso_de_un_chat_de_dos_no_cambia(entorno, avisos_de_grupo):
    http, _, _ = entorno
    assert (await http.post(f"{API}/{DIRECTO}/messages", json={"body": "Hola"})).status_code == 201
    aviso = avisos_de_grupo[0]
    assert aviso["notification_type"] == "message"
    assert aviso["grupo"] is None
    assert aviso["user_ids"] == [BRUNO]
    assert push.build_message("message", "Ana") == ("Nuevo mensaje", "Ana te envió un mensaje.")


def test_el_nombre_del_grupo_es_un_valor_y_no_una_plantilla():
    # Unas llaves en el nombre salen tal cual: no se interpretan.
    _, cuerpo = push.build_message("message_group", "Ana", "{actor} {0} {grupo.__class__}")
    assert cuerpo == "Ana envió un mensaje al grupo «{actor} {0} {grupo.__class__}»."
    # Sin nombre —no debería pasar— no se escribe «None».
    assert push.build_message("message_group", None, None)[1] == (
        "Alguien envió un mensaje al grupo «un grupo»."
    )
    assert push.build_message("group_added", "Ana", "Aula") == (
        "Nuevo grupo",
        "Ana te añadió al grupo «Aula».",
    )
    # Los dos avisos suenan por el canal de los mensajes.
    assert push.CHANNELS["message_group"] == push.CHANNELS["group_added"] == "mensajes"
    # Y los demás textos no se enteran del parámetro nuevo.
    assert push.build_message("follow", "Ana", "Aula") == ("Nuevo seguidor", "Ana empezó a seguirte.")


@pytest.mark.asyncio
async def test_todos_escriben_y_leen_y_cada_mensaje_dice_de_quien_es(entorno):
    http, _, identidad = entorno
    grupo = (await _crear(http)).json()["id"]
    for uid, texto in ((ANA, "Uno"), (BRUNO, "Dos"), (CARLA, "Tres")):
        identidad["uid"] = uid
        assert (await http.post(f"{API}/{grupo}/messages", json={"body": texto})).status_code == 201

    identidad["uid"] = CARLA
    historial = (await http.get(f"{API}/{grupo}/messages")).json()
    assert sorted((m["sender"]["id"], m["body"]) for m in historial) == sorted(
        [(ANA, "Uno"), (BRUNO, "Dos"), (CARLA, "Tres")]
    )
    # Los no leídos cuentan lo de los demás.
    fila = next(c for c in (await http.get(API)).json() if c["id"] == grupo)
    assert fila["unread_count"] == 2


# --------------------------------------------------------------------------- #
# 5. Los filtros, en un grupo creado de verdad
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_quien_crea_el_grupo_administra_sus_filtros(entorno):
    http, sesiones, identidad = entorno
    grupo = (await _crear(http)).json()["id"]
    pdf = await _mensaje(sesiones, de=BRUNO, texto="examen", adjuntos=("document",), en=grupo)

    creado = await http.post(
        f"{API}/{grupo}/filters",
        json={"name": "De Bruno", "criteria": {"author_ids": [BRUNO], "types": ["document"]}},
    )
    assert creado.status_code == 201, creado.text
    filtro = creado.json()["id"]

    identidad["uid"] = CARLA
    vistas = (await http.get(f"{API}/{grupo}/views")).json()
    assert vistas["can_manage"] is False
    assert [f["id"] for f in vistas["filters"]] == [filtro]
    pagina = await http.get(f"{API}/{grupo}/views/messages", params={"filter_id": filtro})
    assert [m["id"] for m in pagina.json()["items"]] == [pdf]
    assert (await http.delete(f"{API}/{grupo}/filters/{filtro}")).status_code == 403

    # Quien no está en el grupo no puede ser autor de un filtro suyo.
    identidad["uid"] = ANA
    fuera = await http.post(
        f"{API}/{grupo}/filters",
        json={"name": "De David", "criteria": {"author_ids": [DAVID]}},
    )
    assert fuera.status_code == 422


@pytest.mark.asyncio
async def test_borrar_el_filtro_de_un_grupo_no_toca_sus_mensajes(entorno):
    http, sesiones, _ = entorno
    grupo = (await _crear(http)).json()["id"]
    await _mensaje(sesiones, texto="examen", en=grupo)
    filtro = (
        await http.post(f"{API}/{grupo}/filters", json={"name": "F", "criteria": {"keywords": ["examen"]}})
    ).json()["id"]
    assert (await http.delete(f"{API}/{grupo}/filters/{filtro}")).status_code == 204
    async with sesiones() as db:
        assert await db.scalar(
            select(func.count()).select_from(Message).where(Message.conversation_id == grupo)
        ) == 1


# --------------------------------------------------------------------------- #
# 6. La migración 0103
# --------------------------------------------------------------------------- #
def _sql_de_la_0103() -> str:
    raiz = Path(__file__).resolve().parents[3]
    crudo = (raiz / "supabase" / "migrations" / "0103_miembros_solo_por_la_api.sql").read_text(
        encoding="utf-8"
    )
    return "\n".join(
        linea for linea in crudo.replace("\r\n", "\n").split("\n") if not linea.lstrip().startswith("--")
    )


def test_la_0103_quita_las_dos_politicas_de_alta_y_nada_mas():
    sql = _sql_de_la_0103()
    quitadas = re.findall(r"drop policy if exists (\w+) on public\.(\w+);", sql)
    assert quitadas == [
        ("conversations_insert", "conversations"),
        ("conversation_members_insert", "conversation_members"),
    ]
    # No crea políticas, no apaga RLS y no toca ninguna fila ni la lectura.
    assert "create policy" not in sql
    assert "disable row level security" not in sql
    assert not re.search(r"\b(drop table|delete from|truncate|update public\.|alter table)", sql)
    for de_lectura in ("conversations_read", "conversation_members_read", "messages_read"):
        assert de_lectura not in sql


def test_la_0103_quita_politicas_que_existen_en_la_0001():
    """Si la 0001 las llamara de otra forma, la 0103 no cerraría nada."""
    raiz = Path(__file__).resolve().parents[3]
    inicial = (raiz / "supabase" / "migrations" / "0001_initial.sql").read_text(encoding="utf-8")
    assert "create policy conversations_insert on public.conversations for insert" in inicial
    assert "create policy conversation_members_insert on public.conversation_members for insert" in inicial
    # La mitad peligrosa: cualquiera se añade a sí mismo.
    trozo = inicial[inicial.index("create policy conversation_members_insert") :][:200]
    assert "user_id = auth.uid() or exists" in trozo
