"""Comunidades en el perfil (30/10/2026, migración 0112): cómo se entra y en el perfil de quién sale.

`docs/CONTRATOS_COMUNIDADES_EN_EL_PERFIL.md`, §1 y §2. Lo que se protege:

  · que cada comunidad diga cómo se entra (`entrada`), que las de antes sigan
    «con solicitud» y que solo quien la administra lo cambie;
  · que a una ABIERTA se entre de un toque (`POST /{id}/join`), con las mismas
    puertas que pedir entrar: perfil o enlace, bloqueos, tope de miembros,
    espera tras un rechazo y tope por hora; solo a la comunidad y sus temas,
    nunca a sus grupos de dentro; y sin repetir nada si ya se está dentro;
  · que a una CON SOLICITUD se siga pidiendo como siempre (409 en `join`);
  · que una aplicación antigua, que solo conoce `join-requests`, entre igual
    en una abierta;
  · que «en mi perfil» sea de cada persona, que el perfil lea esas filas y
    solo de comunidades que la persona administra, y que una comunidad que
    desaparece o que deja de administrar se vaya del perfil;
  · que la tarjeta cuente los grupos y los temas vivos sin una consulta por
    tarjeta;
  · que los avisos digan «comunidad» del padre, «grupo» de los de dentro y
    «tema» del chat de un tema;
  · que SIN LA 0112 (la API desplegada antes de pegarla) todo funcione como
    antes, sin un 500 y sin una consulta de más por petición;
  · y que la migración diga lo mismo que los modelos.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, event, insert, select, update

# `app.main` va primero: ver la nota en `test_grupos_de_mensajeria.py`.
from app.main import app  # noqa: F401, I001
from app.modules.messaging import entrada_a_grupos, esquema, grupos
from app.modules.messaging import router as messaging_router
from app.modules.messaging.models import (
    Conversation,
    ConversationMember,
    GroupJoinRequest,
    GroupProfileListing,
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
    _recoger,
    entorno,
)

NADIE = "aaaaaaaa-0000-0000-0000-00000000dead"
MIGRACION = Path(__file__).resolve().parents[3] / "supabase" / "migrations" / "0112_comunidades_en_el_perfil.sql"


@pytest.fixture
def avisos(monkeypatch):
    capturados: list[dict] = []

    def _retener(_background, **kwargs):
        capturados.append(kwargs)

    for modulo in (entrada_a_grupos, grupos, messaging_router):
        monkeypatch.setattr(modulo, "encolar_push", _retener)
    return capturados


def codigo(respuesta) -> str:
    return respuesta.json()["error"]["code"]


async def _ajustar(http, identidad, conv: str = GRUPO, **cambios):
    identidad["uid"] = ANA
    respuesta = await http.patch(f"{API}/{conv}/group/settings", json=cambios)
    return respuesta


async def _abrir_en_el_perfil(http, identidad, conv: str = GRUPO) -> None:
    """Ana enseña su comunidad en el perfil y la abre."""
    respuesta = await _ajustar(http, identidad, conv, listed_on_profile=True, entrada="open")
    assert respuesta.status_code == 200, respuesta.text


async def _unirse(http, conv: str = GRUPO, code: str | None = None):
    if code is None:
        return await http.post(f"{API}/{conv}/join")
    return await http.post(f"{API}/{conv}/join", json={"code": code})


async def _pedir(http, conv: str = GRUPO, code: str | None = None):
    return await http.post(f"{API}/{conv}/join-requests", json={"code": code} if code else {})


async def _es_miembro(sesiones, conv: str, uid: str) -> bool:
    async with sesiones() as db:
        return (
            await db.get(ConversationMember, {"conversation_id": conv, "user_id": uid})
        ) is not None


async def _solicitudes(sesiones, conv: str = GRUPO, uid: str = DAVID) -> list[tuple]:
    async with sesiones() as db:
        return [
            (f.id, f.status, f.source, f.resolved_by)
            for f in (
                await db.execute(
                    select(GroupJoinRequest)
                    .where(
                        GroupJoinRequest.conversation_id == conv,
                        GroupJoinRequest.user_id == uid,
                    )
                    .order_by(GroupJoinRequest.created_at)
                )
            ).scalars()
        ]


async def _en_perfiles(sesiones, conv: str = GRUPO) -> set[str]:
    async with sesiones() as db:
        return {
            str(u)
            for u in await db.scalars(
                select(GroupProfileListing.user_id).where(
                    GroupProfileListing.conversation_id == conv
                )
            )
        }


async def _bloquear(sesiones, quien: str, a_quien: str) -> None:
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=quien, blocked_id=a_quien))
        await db.commit()


async def _perfil(http, identidad, de: str = ANA, *, como: str = DAVID) -> list[dict]:
    identidad["uid"] = como
    respuesta = await http.get(f"{API}/groups/of/{de}")
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


async def _subgrupo(http, identidad, titulo: str = "Valorant", entrada: str = "open") -> str:
    identidad["uid"] = ANA
    respuesta = await http.post(
        f"{API}/{GRUPO}/subgroups", json={"title": titulo, "entry": entrada}
    )
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()["id"]


async def _tema(http, identidad, nombre: str = "Anuncios") -> dict:
    identidad["uid"] = ANA
    respuesta = await http.post(f"{API}/{GRUPO}/topics", json={"name": nombre})
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()


# --------------------------------------------------------------------------- #
# 1. Cómo se entra: el ajuste
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_las_de_antes_son_con_solicitud_y_quien_administra_la_abre(entorno):
    http, sesiones, identidad = entorno
    # Una fila de ajustes de antes de la 0112 (sin decir nada de `entrada`)
    # lee `request`, como una comunidad sin fila.
    async with sesiones() as db:
        db.add(GroupSettings(conversation_id=GRUPO, listed_on_profile=False))
        await db.commit()
    info = (await http.get(f"{API}/{GRUPO}/info")).json()
    assert info["settings"]["entrada"] == "request"
    identidad["uid"] = CARLA  # es miembro, no la administra: no ve los ajustes
    assert (await http.get(f"{API}/{GRUPO}/info")).json()["settings"] is None

    abierta = await _ajustar(http, identidad, entrada="open")
    assert abierta.status_code == 200, abierta.text
    assert abierta.json() == {
        "listed_on_profile": False,
        "invite_enabled": False,
        "invite_code": None,
        "entrada": "open",
    }
    assert (await http.get(f"{API}/{GRUPO}/info")).json()["settings"]["entrada"] == "open"

    # Lo que no viene no se toca: cambiar el perfil no cierra la puerta.
    assert (await _ajustar(http, identidad, listed_on_profile=True)).json()["entrada"] == "open"
    cerrada = await _ajustar(http, identidad, entrada="request")
    assert cerrada.json()["entrada"] == "request"
    assert cerrada.json()["listed_on_profile"] is True

    # Un valor que no es de la lista no entra; y la base tampoco lo admitiría.
    assert (await _ajustar(http, identidad, entrada="abierta")).status_code == 422
    assert (await _ajustar(http, identidad, entrada=None)).status_code == 200


@pytest.mark.asyncio
async def test_solo_quien_administra_cambia_como_se_entra_y_solo_en_una_comunidad(entorno):
    http, _, identidad = entorno
    identidad["uid"] = BRUNO
    respuesta = await http.patch(f"{API}/{GRUPO}/group/settings", json={"entrada": "open"})
    assert respuesta.status_code == 403
    assert codigo(respuesta) == "group_admin_required"

    sub = await _subgrupo(http, identidad)
    for conv, esperado in ((sub, "not_a_top_level_group"), (DIRECTO, "not_a_group")):
        respuesta = await _ajustar(http, identidad, conv, entrada="open")
        assert respuesta.status_code == 409, respuesta.text
        assert codigo(respuesta) == esperado


# --------------------------------------------------------------------------- #
# 2. En el perfil de quién sale
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_en_mi_perfil_escribe_la_fila_de_quien_llama_y_la_columna_de_siempre(entorno):
    http, sesiones, identidad = entorno
    puesta = await _ajustar(http, identidad, listed_on_profile=True)
    assert puesta.status_code == 200, puesta.text
    assert puesta.json()["listed_on_profile"] is True
    assert await _en_perfiles(sesiones) == {ANA}
    async with sesiones() as db:
        # La columna se sigue escribiendo: volver a la API anterior no pierde nada.
        assert (await db.get(GroupSettings, GRUPO)).listed_on_profile is True

    # Dos veces es una fila, no un error.
    assert (await _ajustar(http, identidad, listed_on_profile=True)).status_code == 200
    assert await _en_perfiles(sesiones) == {ANA}
    assert [t["id"] for t in await _perfil(http, identidad)] == [GRUPO]

    quitada = await _ajustar(http, identidad, listed_on_profile=False)
    assert quitada.json()["listed_on_profile"] is False
    assert await _en_perfiles(sesiones) == set()
    async with sesiones() as db:
        assert (await db.get(GroupSettings, GRUPO)).listed_on_profile is False
    assert await _perfil(http, identidad) == []


@pytest.mark.asyncio
async def test_en_mi_perfil_es_de_quien_pregunta(entorno):
    """La fila de otra persona no dice que salga en el perfil de quien administra."""
    http, sesiones, identidad = entorno
    async with sesiones() as db:
        db.add(GroupSettings(conversation_id=GRUPO))
        db.add(GroupProfileListing(conversation_id=GRUPO, user_id=BRUNO))
        await db.commit()

    identidad["uid"] = ANA
    assert (await http.get(f"{API}/{GRUPO}/info")).json()["settings"]["listed_on_profile"] is False
    # Bruno tiene fila pero no la administra: en su perfil no sale.
    assert await _perfil(http, identidad, BRUNO) == []
    assert await _perfil(http, identidad, ANA) == []

    await _ajustar(http, identidad, listed_on_profile=True)
    identidad["uid"] = ANA
    assert (await http.get(f"{API}/{GRUPO}/info")).json()["settings"]["listed_on_profile"] is True
    # Quitarla del suyo no toca la fila de nadie más.
    await _ajustar(http, identidad, listed_on_profile=False)
    assert await _en_perfiles(sesiones) == {BRUNO}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("con_fila", "columna"),
    [
        # La API anterior la QUITÓ del perfil: escribió la columna y dejó la fila.
        (True, False),
        # La API anterior la PUSO: escribió la columna y no hay fila.
        (False, True),
    ],
)
async def test_si_la_fila_y_la_columna_no_coinciden_no_sale_en_el_perfil(entorno, con_fila, columna):
    http, sesiones, identidad = entorno
    async with sesiones() as db:
        db.add(GroupSettings(conversation_id=GRUPO, listed_on_profile=columna))
        if con_fila:
            db.add(GroupProfileListing(conversation_id=GRUPO, user_id=ANA))
        await db.commit()
        # Abierta, para que tampoco se pueda entrar «desde el perfil».
        await db.execute(update(GroupSettings.__table__).values(entrada="open"))
        await db.commit()

    assert await _perfil(http, identidad) == []
    for respuesta in (await _pedir(http), await _unirse(http)):
        assert respuesta.status_code == 404
        assert codigo(respuesta) == "group_not_found"
    assert not await _es_miembro(sesiones, GRUPO, DAVID)
    # El interruptor de quien administra dice lo mismo que su perfil.
    identidad["uid"] = ANA
    assert (await http.get(f"{API}/{GRUPO}/info")).json()["settings"]["listed_on_profile"] is False

    # Encenderlo con esta API escribe las dos, y vuelve a salir.
    assert (await _ajustar(http, identidad, listed_on_profile=True)).json()["listed_on_profile"] is True
    assert [t["id"] for t in await _perfil(http, identidad)] == [GRUPO]
    assert (await _unirse(http)).status_code == 200


@pytest.mark.asyncio
async def test_el_enlace_cambiado_responde_con_mi_perfil(entorno):
    http, _, identidad = entorno
    await _ajustar(http, identidad, listed_on_profile=True, invite_enabled=True)
    cambiado = await http.post(f"{API}/{GRUPO}/group/invite/rotate")
    assert cambiado.status_code == 200
    assert (cambiado.json()["listed_on_profile"], cambiado.json()["entrada"]) == (True, "request")


@pytest.mark.asyncio
async def test_un_grupo_de_dentro_no_se_puede_poner_en_el_perfil(entorno):
    http, sesiones, identidad = entorno
    sub = await _subgrupo(http, identidad)
    respuesta = await _ajustar(http, identidad, sub, listed_on_profile=True)
    assert respuesta.status_code == 409
    assert codigo(respuesta) == "not_a_top_level_group"
    assert await _en_perfiles(sesiones, sub) == set()

    # Y aunque alguien escribiera la fila a mano, el perfil no la enseña.
    async with sesiones() as db:
        db.add(GroupProfileListing(conversation_id=sub, user_id=ANA))
        await db.commit()
    assert await _perfil(http, identidad) == []


@pytest.mark.asyncio
async def test_si_la_comunidad_desaparece_o_deja_de_administrarla_se_va_del_perfil(entorno):
    http, sesiones, identidad = entorno
    await _ajustar(http, identidad, listed_on_profile=True)
    assert len(await _perfil(http, identidad)) == 1

    # Deja de administrarla (hoy solo se ve cambiando quién la creó): su fila
    # se queda, pero su perfil ya no la enseña.
    async with sesiones() as db:
        await db.execute(update(Conversation).where(Conversation.id == GRUPO).values(created_by=BRUNO))
        await db.commit()
    assert await _perfil(http, identidad) == []
    assert await _en_perfiles(sesiones) == {ANA}

    # Y si se borra la conversación, desaparece. En PostgreSQL la fila se va
    # con ella (`on delete cascade`, ver la prueba de PostgreSQL); aquí basta
    # con que el perfil no la enseñe.
    async with sesiones() as db:
        await db.execute(update(Conversation).where(Conversation.id == GRUPO).values(created_by=ANA))
        await db.commit()
    assert len(await _perfil(http, identidad)) == 1
    async with sesiones() as db:
        await db.execute(delete(ConversationMember).where(ConversationMember.conversation_id == GRUPO))
        await db.execute(delete(Conversation).where(Conversation.id == GRUPO))
        await db.commit()
    assert await _perfil(http, identidad) == []


@pytest.mark.asyncio
async def test_el_perfil_conserva_su_tope_su_orden_y_sus_bloqueos(entorno, monkeypatch):
    http, sesiones, identidad = entorno
    identidad["uid"] = ANA
    nuevas = []
    for titulo in ("Segunda", "Tercera"):
        creada = await http.post(f"{API}/groups", json={"title": titulo, "member_ids": [BRUNO]})
        assert creada.status_code == 201
        nuevas.append(creada.json()["id"])
    # Las fechas, a mano: crear dos en el mismo segundo no dice cuál es más nueva.
    async with sesiones() as db:
        for i, conv in enumerate((GRUPO, *nuevas)):
            await db.execute(
                update(Conversation)
                .where(Conversation.id == conv)
                .values(created_at=datetime(2026, 10, i + 1, 10, tzinfo=timezone.utc))
            )
        await db.commit()
    for conv in (GRUPO, *nuevas):
        await _ajustar(http, identidad, conv, listed_on_profile=True)

    assert [t["id"] for t in await _perfil(http, identidad)] == [nuevas[1], nuevas[0], GRUPO]
    monkeypatch.setattr(entrada_a_grupos, "MAX_GRUPOS_EN_PERFIL", 2)
    assert [t["id"] for t in await _perfil(http, identidad)] == [nuevas[1], nuevas[0]]

    await _bloquear(sesiones, DAVID, ANA)
    assert await _perfil(http, identidad) == []


# --------------------------------------------------------------------------- #
# 3. La tarjeta
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_tarjeta_dice_como_se_entra_y_cuantos_grupos_y_temas_vivos_tiene(entorno):
    http, _, identidad = entorno
    codigo_del_enlace = (
        await _ajustar(http, identidad, listed_on_profile=True, invite_enabled=True)
    ).json()["invite_code"]
    vivo = await _subgrupo(http, identidad, "Valorant")
    borrado = await _subgrupo(http, identidad, "Lectura", "request")
    assert (await http.delete(f"{API}/{GRUPO}/subgroups/{borrado}")).status_code == 204
    await _tema(http, identidad, "Anuncios")
    tema_borrado = (await _tema(http, identidad, "Material"))["id"]
    assert (await http.delete(f"{API}/{GRUPO}/topics/{tema_borrado}")).status_code == 204
    await _ajustar(http, identidad, entrada="open")

    tarjeta = (await _perfil(http, identidad))[0]
    assert (tarjeta["entrada"], tarjeta["groups_count"], tarjeta["topics_count"]) == ("open", 1, 1)
    # La del enlace dice lo mismo.
    identidad["uid"] = DAVID
    del_enlace = (await http.get(f"{API}/groups/invite/{codigo_del_enlace}")).json()
    assert del_enlace == tarjeta
    assert vivo not in str(tarjeta)  # el número, no cuáles


@pytest.mark.asyncio
async def test_el_perfil_no_cuesta_una_consulta_por_comunidad(entorno):
    http, sesiones, identidad = entorno
    await _ajustar(http, identidad, listed_on_profile=True)
    await _perfil(http, identidad)  # lo que se cachea (el esquema) no cuenta

    def _contar():
        sentencias: list[str] = []

        def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
            if statement.lstrip().lower().startswith("select"):
                sentencias.append(statement)

        motor = sesiones.kw["bind"].sync_engine
        event.listen(motor, "before_cursor_execute", _anotar)
        return sentencias, lambda: event.remove(motor, "before_cursor_execute", _anotar)

    sentencias, quitar = _contar()
    try:
        una = await _perfil(http, identidad)
    finally:
        quitar()
    con_una = len(sentencias)

    identidad["uid"] = ANA
    for titulo in ("Dos", "Tres", "Cuatro"):
        nueva = (
            await http.post(f"{API}/groups", json={"title": titulo, "member_ids": [BRUNO]})
        ).json()["id"]
        await _ajustar(http, identidad, nueva, listed_on_profile=True)
        sub = await http.post(f"{API}/{nueva}/subgroups", json={"title": "Hija"})
        assert sub.status_code == 201
    sentencias, quitar = _contar()
    try:
        cuatro = await _perfil(http, identidad)
    finally:
        quitar()
    assert (len(una), len(cuatro)) == (1, 4)
    assert len(sentencias) == con_una, f"{con_una} consultas con una y {len(sentencias)} con cuatro"


# --------------------------------------------------------------------------- #
# 4. Entrar en una abierta
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_a_una_abierta_se_entra_de_un_toque_solo_a_la_comunidad_y_sus_temas(entorno, avisos):
    http, sesiones, identidad = entorno
    sub = await _subgrupo(http, identidad, "Valorant", "open")
    chat_del_tema = (await _tema(http, identidad))["chat_id"]
    await _abrir_en_el_perfil(http, identidad)
    avisos.clear()

    identidad["uid"] = DAVID
    respuesta = await _unirse(http)
    assert respuesta.status_code == 200, respuesta.text
    tarjeta = respuesta.json()
    assert (tarjeta["id"], tarjeta["my_status"], tarjeta["members_count"]) == (GRUPO, "member", 4)
    assert tarjeta["entrada"] == "open"

    assert await _es_miembro(sesiones, GRUPO, DAVID)
    assert await _es_miembro(sesiones, chat_del_tema, DAVID)   # General y sus temas
    assert not await _es_miembro(sesiones, sub, DAVID)         # a los grupos de dentro, no
    assert (await http.get(f"{API}/{GRUPO}/messages")).status_code == 200

    # Queda escrito como una solicitud aprobada que no decidió nadie.
    [(_, estado, origen, quien)] = await _solicitudes(sesiones)
    assert (estado, origen, quien) == ("approved", "profile", None)
    # Sin aviso a quien administra, y nada que decidir en su lista.
    assert avisos == []
    identidad["uid"] = ANA
    assert (await http.get(f"{API}/{GRUPO}/join-requests")).json() == []
    assert (await http.get(f"{API}/{GRUPO}/info")).json()["pending_requests"] == 0


@pytest.mark.asyncio
async def test_entrar_otra_vez_no_repite_nada(entorno):
    http, sesiones, identidad = entorno
    await _abrir_en_el_perfil(http, identidad)
    identidad["uid"] = DAVID
    primera = await _unirse(http)
    segunda = await _unirse(http, code="x" * 24)  # aunque traiga un código que no vale
    assert primera.status_code == segunda.status_code == 200
    assert primera.json() == segunda.json()
    assert len(await _solicitudes(sesiones)) == 1

    # Quien ya estaba (Bruno) también recibe su tarjeta, aunque sea con solicitud
    # y no salga en ningún perfil.
    await _ajustar(http, identidad, listed_on_profile=False, entrada="request")
    identidad["uid"] = BRUNO
    ya = await _unirse(http)
    assert ya.status_code == 200
    assert ya.json()["my_status"] == "member"
    assert await _solicitudes(sesiones, uid=BRUNO) == []


@pytest.mark.asyncio
async def test_por_el_enlace_tambien_se_entra_en_una_abierta(entorno):
    http, sesiones, identidad = entorno
    codigo_del_enlace = (
        await _ajustar(http, identidad, invite_enabled=True, entrada="open")
    ).json()["invite_code"]

    identidad["uid"] = DAVID
    # Sin perfil y sin el código, no existe.
    for respuesta in (await _unirse(http), await _unirse(http, code="y" * 24)):
        assert respuesta.status_code == 404
        assert codigo(respuesta) == "group_not_found"
    assert not await _es_miembro(sesiones, GRUPO, DAVID)

    respuesta = await _unirse(http, code=codigo_del_enlace)
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["my_status"] == "member"
    assert [s[1:3] for s in await _solicitudes(sesiones)] == [("approved", "link")]


@pytest.mark.asyncio
async def test_a_una_con_solicitud_no_se_entra_y_se_sigue_pidiendo(entorno, avisos):
    http, sesiones, identidad = entorno
    await _ajustar(http, identidad, listed_on_profile=True)

    identidad["uid"] = DAVID
    respuesta = await _unirse(http)
    assert respuesta.status_code == 409
    assert codigo(respuesta) == "group_requires_request"
    assert not await _es_miembro(sesiones, GRUPO, DAVID)
    assert await _solicitudes(sesiones) == []

    # Pedirlo funciona exactamente como antes: pendiente, y aviso a quien administra.
    pedida = await _pedir(http)
    assert pedida.status_code == 201
    assert pedida.json()["status"] == "pending"
    assert not await _es_miembro(sesiones, GRUPO, DAVID)
    assert [a["notification_type"] for a in avisos] == ["group_join_request"]
    assert (await _perfil(http, identidad))[0]["my_status"] == "pending"


@pytest.mark.asyncio
async def test_una_abierta_llena_no_admite_a_nadie(entorno, monkeypatch):
    http, sesiones, identidad = entorno
    await _abrir_en_el_perfil(http, identidad)
    monkeypatch.setattr(grupos, "MAX_MIEMBROS", 3)
    identidad["uid"] = DAVID
    for respuesta in (await _unirse(http), await _pedir(http)):
        assert respuesta.status_code == 409
        assert codigo(respuesta) == "group_is_full"
    assert not await _es_miembro(sesiones, GRUPO, DAVID)


@pytest.mark.asyncio
@pytest.mark.parametrize("quien_bloquea", ["visita", "administra"])
async def test_con_un_bloqueo_la_abierta_no_existe(entorno, quien_bloquea):
    http, sesiones, identidad = entorno
    codigo_del_enlace = (
        await _ajustar(http, identidad, listed_on_profile=True, invite_enabled=True, entrada="open")
    ).json()["invite_code"]
    if quien_bloquea == "visita":
        await _bloquear(sesiones, DAVID, ANA)
    else:
        await _bloquear(sesiones, ANA, DAVID)

    identidad["uid"] = DAVID
    inventada = await _unirse(http, NADIE)
    for respuesta in (
        await _unirse(http),
        await _unirse(http, code=codigo_del_enlace),
        await _pedir(http),
    ):
        assert respuesta.status_code == 404
        # La misma respuesta que una comunidad que no existe: no se dice que
        # hay un bloqueo.
        assert respuesta.json() == inventada.json()
    assert not await _es_miembro(sesiones, GRUPO, DAVID)
    assert await _solicitudes(sesiones) == []


@pytest.mark.asyncio
async def test_join_es_solo_para_comunidades(entorno):
    http, _, identidad = entorno
    sub = await _subgrupo(http, identidad, "Valorant", "open")
    chat_del_tema = (await _tema(http, identidad))["chat_id"]
    await _abrir_en_el_perfil(http, identidad)

    # Bruno es de la comunidad: aun así, un grupo de dentro o el chat de un
    # tema no se alcanzan por aquí (tienen su camino, o ninguno).
    identidad["uid"] = BRUNO
    for conv in (sub, chat_del_tema, DIRECTO, NADIE, "no-es-un-uuid"):
        respuesta = await _unirse(http, conv)
        assert respuesta.status_code == 404, (conv, respuesta.text)
    assert codigo(await _unirse(http, sub)) == "group_not_found"


@pytest.mark.asyncio
async def test_tras_un_rechazo_hay_que_esperar_aunque_la_abran(entorno):
    http, sesiones, identidad = entorno
    await _ajustar(http, identidad, listed_on_profile=True)
    identidad["uid"] = DAVID
    solicitud = (await _pedir(http)).json()["id"]
    identidad["uid"] = ANA
    assert (await http.post(f"{API}/{GRUPO}/join-requests/{solicitud}/reject")).status_code == 204
    await _ajustar(http, identidad, entrada="open")

    identidad["uid"] = DAVID
    for respuesta in (await _unirse(http), await _pedir(http)):
        assert respuesta.status_code == 409
        assert codigo(respuesta) == "join_request_too_soon"
    assert not await _es_miembro(sesiones, GRUPO, DAVID)


@pytest.mark.asyncio
async def test_entrar_y_salir_sin_parar_tiene_tope(entorno, monkeypatch):
    http, sesiones, identidad = entorno
    await _abrir_en_el_perfil(http, identidad)
    monkeypatch.setattr(entrada_a_grupos, "SOLICITUDES_POR_HORA", 2)
    identidad["uid"] = DAVID
    for _ in range(2):
        assert (await _unirse(http)).status_code == 200
        assert (await http.delete(f"{API}/{GRUPO}/members/{DAVID}")).status_code == 204
    respuesta = await _unirse(http)
    assert respuesta.status_code == 409
    assert codigo(respuesta) == "join_rate_limited"
    assert not await _es_miembro(sesiones, GRUPO, DAVID)


@pytest.mark.asyncio
async def test_la_solicitud_que_esperaba_se_aprueba_al_entrar(entorno, avisos):
    http, sesiones, identidad = entorno
    await _ajustar(http, identidad, listed_on_profile=True)
    identidad["uid"] = DAVID
    solicitud = (await _pedir(http)).json()["id"]
    # Bruno sale y pide volver: dos personas esperando.
    identidad["uid"] = BRUNO
    assert (await http.delete(f"{API}/{GRUPO}/members/{BRUNO}")).status_code == 204
    de_bruno = (await _pedir(http)).json()["id"]

    # Abrirla NO mete a quien esperaba: siguen ahí para quien administra.
    await _ajustar(http, identidad, entrada="open")
    identidad["uid"] = ANA
    assert {p["id"] for p in (await http.get(f"{API}/{GRUPO}/join-requests")).json()} == {
        solicitud,
        de_bruno,
    }
    assert not await _es_miembro(sesiones, GRUPO, DAVID)

    # Cuando David vuelve a tocar el botón, entra, y es SU solicitud la que se
    # aprueba: no se queda colgando ni se crea otra.
    avisos.clear()
    identidad["uid"] = DAVID
    assert (await _unirse(http)).status_code == 200
    assert await _solicitudes(sesiones) == [(solicitud, "approved", "profile", None)]
    # Bruno, con la aplicación de antes, toca «Pedir unirme» otra vez: entra.
    identidad["uid"] = BRUNO
    otra_vez = await _pedir(http)
    assert otra_vez.status_code == 201
    assert otra_vez.json() == {"id": de_bruno, "status": "approved"}
    assert await _es_miembro(sesiones, GRUPO, BRUNO)
    assert avisos == []
    identidad["uid"] = ANA
    assert (await http.get(f"{API}/{GRUPO}/join-requests")).json() == []


@pytest.mark.asyncio
async def test_la_aplicacion_antigua_entra_en_una_abierta_pidiendolo(entorno, avisos):
    """Lo que hace la versión que ya está en los teléfonos: `join-requests` con
    `{}`, ignora la respuesta y vuelve a leer la tarjeta."""
    http, sesiones, identidad = entorno
    await _abrir_en_el_perfil(http, identidad)
    avisos.clear()

    identidad["uid"] = DAVID
    respuesta = await _pedir(http)
    assert respuesta.status_code == 201, respuesta.text
    cuerpo = respuesta.json()
    assert set(cuerpo) == {"id", "status"}
    assert cuerpo["status"] == "approved"
    assert await _es_miembro(sesiones, GRUPO, DAVID)
    assert (await _perfil(http, identidad))[0]["my_status"] == "member"
    assert avisos == []
    assert [s[0] for s in await _solicitudes(sesiones)] == [cuerpo["id"]]

    # Para quien ya está dentro, lo de siempre.
    otra_vez = await _pedir(http)
    assert otra_vez.status_code == 409
    assert codigo(otra_vez) == "already_member"


@pytest.mark.asyncio
@pytest.mark.parametrize("tenia_pendiente", [False, True])
async def test_si_quien_administra_lo_mete_a_la_vez_entrar_no_falla(entorno, monkeypatch, tenia_pendiente):
    """Pide entrar (o toca «Unirme») en el mismo instante en que quien
    administra lo añade a mano: la comprobación de «ya está dentro» no lo ve,
    y al entrar choca con la fila que acaba de escribir quien administra. Ya
    está dentro, que es lo que pidió: éxito, no 409."""
    http, sesiones, identidad = entorno
    await _ajustar(http, identidad, listed_on_profile=True)
    pendiente = None
    if tenia_pendiente:
        identidad["uid"] = DAVID
        pendiente = (await _pedir(http)).json()["id"]
    await _ajustar(http, identidad, entrada="open")
    identidad["uid"] = ANA
    assert (await http.post(f"{API}/{GRUPO}/members", json={"user_ids": [DAVID]})).status_code == 200

    # El instante de la carrera: lo que se leyó antes de que Ana lo añadiera.
    sin_david = entrada_a_grupos._miembros

    async def _antes_de_que_lo_anadieran(db, conversation_id):
        return await sin_david(db, conversation_id) - {DAVID}

    monkeypatch.setattr(entrada_a_grupos, "_miembros", _antes_de_que_lo_anadieran)

    identidad["uid"] = DAVID
    pedida = await _pedir(http)
    assert pedida.status_code == 201, pedida.text
    assert pedida.json()["status"] == "approved"
    # Su petición queda escrita como cumplida: la pendiente que tenía, o una nueva.
    [(ident, estado, _, quien)] = await _solicitudes(sesiones)
    assert (estado, quien) == ("approved", None)
    assert pedida.json()["id"] == (pendiente or ident)

    unirse = await _unirse(http)
    assert unirse.status_code == 200, unirse.text
    assert unirse.json()["my_status"] == "member"
    assert len(await _solicitudes(sesiones)) == 1
    async with sesiones() as db:
        assert len(
            (
                await db.execute(
                    select(ConversationMember).where(
                        ConversationMember.conversation_id == GRUPO,
                        ConversationMember.user_id == DAVID,
                    )
                )
            ).all()
        ) == 1


@pytest.mark.asyncio
async def test_las_comunidades_de_dentro_se_siguen_pidiendo_como_antes(entorno, avisos):
    """Un grupo de dentro `open` tiene su propia ruta; por `join-requests` sigue
    quedando pendiente, aunque su comunidad sea abierta."""
    http, sesiones, identidad = entorno
    await _abrir_en_el_perfil(http, identidad)
    sub = await _subgrupo(http, identidad, "Valorant", "open")
    identidad["uid"] = BRUNO
    pedida = await _pedir(http, sub)
    assert pedida.status_code == 201
    assert pedida.json()["status"] == "pending"
    assert not await _es_miembro(sesiones, sub, BRUNO)


@pytest.mark.asyncio
async def test_pasar_a_con_solicitud_no_saca_a_nadie(entorno):
    http, sesiones, identidad = entorno
    await _abrir_en_el_perfil(http, identidad)
    identidad["uid"] = DAVID
    assert (await _unirse(http)).status_code == 200

    await _ajustar(http, identidad, entrada="request")
    assert await _es_miembro(sesiones, GRUPO, DAVID)
    tarjeta = (await _perfil(http, identidad, como=CARLA))[0]
    assert (tarjeta["entrada"], tarjeta["members_count"]) == ("request", 4)


# --------------------------------------------------------------------------- #
# 5. Los avisos: «comunidad» del padre, «grupo» de los de dentro
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_los_avisos_de_un_grupo_de_dentro_dicen_grupo(entorno, avisos):
    http, _, identidad = entorno
    sub = await _subgrupo(http, identidad, "Valorant", "request")
    avisos.clear()

    identidad["uid"] = BRUNO
    pedida = await _pedir(http, sub)
    assert pedida.status_code == 201
    identidad["uid"] = ANA
    assert (
        await http.post(f"{API}/{sub}/join-requests/{pedida.json()['id']}/approve")
    ).status_code == 204
    assert (await http.post(f"{API}/{sub}/messages", json={"body": "Hola"})).status_code == 201

    textos = [
        push.build_message(a["notification_type"], a["actor_name"], a["grupo"], nivel=a["nivel"])
        for a in avisos
    ]
    assert [a["nivel"] for a in avisos] == ["subgrupo", "subgrupo", "subgrupo"]
    assert textos == [
        ("Solicitud para unirse", "Bruno quiere unirse a tu grupo «Valorant»."),
        ("Nuevo grupo", "Ana te agregó al grupo «Valorant»."),
        ("Nuevo mensaje", "Ana envió un mensaje al grupo «Valorant»."),
    ]


@pytest.mark.asyncio
async def test_los_avisos_de_una_comunidad_dicen_comunidad(entorno, avisos):
    http, _, identidad = entorno
    identidad["uid"] = ANA
    assert (await http.post(f"{API}/{GRUPO}/members", json={"user_ids": [DAVID]})).status_code == 200
    assert (await http.post(f"{API}/{GRUPO}/messages", json={"body": "Hola"})).status_code == 201
    assert [a["nivel"] for a in avisos] == ["comunidad", "comunidad"]
    assert [
        push.build_message(a["notification_type"], a["actor_name"], a["grupo"], nivel=a["nivel"])
        for a in avisos
    ] == [
        ("Nueva comunidad", "Ana te agregó a la comunidad «Aula»."),
        ("Nuevo mensaje", "Ana envió un mensaje a la comunidad «Aula»."),
    ]


@pytest.mark.asyncio
async def test_el_aviso_de_un_tema_dice_tema(entorno, avisos):
    """No «a la comunidad «Anuncios»»: «Anuncios» es un tema, no una comunidad."""
    http, _, identidad = entorno
    chat = (await _tema(http, identidad, "Anuncios"))["chat_id"]
    avisos.clear()

    identidad["uid"] = ANA
    assert (await http.post(f"{API}/{chat}/messages", json={"body": "Mañana no hay clase"})).status_code == 201
    [aviso] = avisos
    assert (aviso["nivel"], aviso["grupo"], aviso["notification_type"]) == ("tema", "Anuncios", "message_group")
    assert sorted(aviso["user_ids"]) == sorted([BRUNO, CARLA])
    assert push.build_message(aviso["notification_type"], aviso["actor_name"], aviso["grupo"], nivel=aviso["nivel"]) == (
        "Nuevo mensaje",
        "Ana envió un mensaje en el tema «Anuncios».",
    )


def test_las_plantillas_concuerdan_y_los_demas_avisos_no_cambian():
    assert push.build_message("group_join_request", None, None) == (
        "Solicitud para unirse",
        "Alguien quiere unirse a tu comunidad «una comunidad».",
    )
    assert push.build_message("group_join_request", None, None, nivel="subgrupo") == (
        "Solicitud para unirse",
        "Alguien quiere unirse a tu grupo «un grupo».",
    )
    # El nombre sigue siendo un valor, no una plantilla.
    assert push.build_message("message_group", "Ana", "{actor}", nivel="subgrupo")[1] == (
        "Ana envió un mensaje al grupo «{actor}»."
    )
    assert push.build_message("message_group", None, None, nivel="tema")[1] == (
        "Alguien envió un mensaje en el tema «un tema»."
    )
    # `nivel` no toca los tipos que no hablan de grupos, ni los canales.
    for nivel in ("subgrupo", "tema"):
        assert push.build_message("follow", "Ana", nivel=nivel) == ("Nuevo seguidor", "Ana empezó a seguirte.")
        assert set(push.TEMPLATES_POR_NIVEL[nivel]) <= set(push.TEMPLATES)
        assert all(push.CHANNELS[t] == "mensajes" for t in push.TEMPLATES_POR_NIVEL[nivel])
    # Un tema solo tiene mensajes: lo demás no puede pasar en él y cae al texto
    # de la comunidad, nunca a un hueco.
    assert push.build_message("group_added", "Ana", "Aula", nivel="tema") == (
        "Nueva comunidad",
        "Ana te agregó a la comunidad «Aula».",
    )


# --------------------------------------------------------------------------- #
# 6. La migración, leída
# --------------------------------------------------------------------------- #
def _sin_comentarios(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


def test_la_0112_se_pega_entera_y_dice_como_deshacerse():
    crudo = MIGRACION.read_text(encoding="utf-8")
    codigo_sql = _sin_comentarios(crudo)
    assert codigo_sql.lstrip().startswith("set local lock_timeout = '5s';")
    assert "notify pgrst, 'reload schema';" in codigo_sql
    # Lo último que se ejecuta es la comprobación que se ve en el editor.
    assert codigo_sql.rstrip().rsplit(";", 2)[-2].lstrip().startswith("select")
    assert "rollback" in crudo.lower()
    # Va justo después de la 0111.
    nombres = sorted(p.name for p in MIGRACION.parent.glob("*.sql"))
    assert nombres[nombres.index(MIGRACION.name) - 1] == "0111_cuentas_de_temas_y_enlaces.sql"


def test_la_0112_solo_anade():
    codigo_sql = _sin_comentarios(MIGRACION.read_text(encoding="utf-8"))
    assert "add column if not exists entrada text not null default 'request'" in codigo_sql
    assert re.search(
        r"drop constraint if exists group_settings_entrada_check;\s+alter table public\.group_settings\s+"
        r"add constraint group_settings_entrada_check\s+check \(entrada in \('open', 'request'\)\)",
        codigo_sql,
    )
    assert "create table if not exists public.group_profile_listings" in codigo_sql
    assert "alter table public.group_profile_listings enable row level security" in codigo_sql
    assert "create policy" not in codigo_sql
    assert "alter publication" not in codigo_sql
    # `listed_on_profile` se queda: la API anterior la sigue leyendo.
    assert not re.search(r"\b(drop table|drop column|delete from|truncate|update public\.)", codigo_sql)
    for tabla in ("messages", "conversations", "conversation_members", "profiles"):
        assert not re.search(rf"alter table public\.{tabla}\b", codigo_sql), tabla
    # El relleno no duplica al pegarla dos veces.
    relleno = codigo_sql[codigo_sql.index("insert into public.group_profile_listings") :]
    relleno = relleno[: relleno.index(";")]
    assert "on conflict do nothing" in relleno
    assert "s.listed_on_profile" in relleno and "c.created_by" in relleno


def test_el_modelo_dice_lo_mismo_que_la_0112():
    codigo_sql = _sin_comentarios(MIGRACION.read_text(encoding="utf-8"))
    inicio = codigo_sql.index("create table if not exists public.group_profile_listings")
    cuerpo = codigo_sql[inicio : codigo_sql.index(");", inicio)]
    columnas = set(re.findall(r"^\s{2}([a-z_]+) (?!key)", cuerpo, flags=re.M)) - {"primary"}
    assert columnas == {c.name for c in GroupProfileListing.__table__.columns}
    assert "primary key (conversation_id, user_id)" in cuerpo
    assert {c.name for c in GroupProfileListing.__table__.primary_key} == {"conversation_id", "user_id"}
    # Las mismas claves ajenas, con el mismo `on delete`.
    ajenas = {
        (fk.parent.name, fk.target_fullname, fk.ondelete)
        for fk in GroupProfileListing.__table__.foreign_keys
    }
    assert ajenas == {
        ("conversation_id", "conversations.id", "CASCADE"),
        ("user_id", "profiles.id", "CASCADE"),
    }
    assert "references public.conversations(id) on delete cascade" in cuerpo
    assert "references public.profiles(id) on delete cascade" in cuerpo
    # El índice y el `CHECK`, con el mismo nombre.
    assert "group_profile_listings_user_idx" in codigo_sql
    assert "group_profile_listings_user_idx" in {i.name for i in GroupProfileListing.__table__.indexes}
    assert "group_settings_entrada_check" in {c.name for c in GroupSettings.__table__.constraints}


@pytest.mark.asyncio
async def test_la_base_de_las_pruebas_tambien_rechaza_una_entrada_desconocida(entorno):
    """El `CHECK` repetido en el modelo: lo que producción rechaza, aquí también."""
    from sqlalchemy.exc import IntegrityError

    _, sesiones, _ = entorno
    async with sesiones() as db:
        with pytest.raises(IntegrityError):
            await db.execute(
                insert(GroupSettings.__table__).values(conversation_id=GRUPO, entrada="abierta")
            )
            await db.commit()


# --------------------------------------------------------------------------- #
# 7. Sin la 0112: la API desplegada antes de pegar la migración
# --------------------------------------------------------------------------- #
@pytest_asyncio.fixture
async def sin_la_0112():
    """Sin `group_profile_listings`. La columna `entrada` sí está (SQLite la crea
    con el modelo), y eso es lo que permite comprobar que sin la tabla la API
    NI LA MIRA: la prueba de PostgreSQL la quita de verdad."""
    engine, sesiones, identidad = await _levantar(sin_tablas=("group_profile_listings",))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad
    await _recoger(engine)


@pytest.mark.asyncio
async def test_sin_la_0112_todo_funciona_como_antes(sin_la_0112, avisos):
    http, sesiones, identidad = sin_la_0112
    puesta = await _ajustar(http, identidad, listed_on_profile=True, invite_enabled=True)
    assert puesta.status_code == 200, puesta.text
    codigo_del_enlace = puesta.json()["invite_code"]
    assert puesta.json() == {
        "listed_on_profile": True,
        "invite_enabled": True,
        "invite_code": codigo_del_enlace,
        # Sin la 0112 no se puede elegir cómo se entra: `None`, y la app no lo ofrece.
        "entrada": None,
    }
    assert (await http.get(f"{API}/{GRUPO}/info")).json()["settings"] == puesta.json()
    async with sesiones() as db:
        assert (await db.get(GroupSettings, GRUPO)).listed_on_profile is True
        # Aunque la columna dijera «abierta», sin la tabla no se lee.
        await db.execute(update(GroupSettings.__table__).values(entrada="open"))
        await db.commit()

    [tarjeta] = await _perfil(http, identidad)
    assert (tarjeta["id"], tarjeta["entrada"], tarjeta["my_status"]) == (GRUPO, "request", "none")
    del_enlace = await http.get(f"{API}/groups/invite/{codigo_del_enlace}")
    assert del_enlace.status_code == 200
    assert del_enlace.json()["entrada"] == "request"

    # Entrar sigue siendo pedirlo, con su aviso; `join` responde como a una con solicitud.
    unirse = await _unirse(http)
    assert unirse.status_code == 409
    assert codigo(unirse) == "group_requires_request"
    pedida = await _pedir(http)
    assert pedida.status_code == 201
    assert pedida.json()["status"] == "pending"
    assert [a["notification_type"] for a in avisos] == ["group_join_request"]

    # Cambiar cómo se entra no tiene dónde guardarse: 503, y sin tocar nada más.
    for cambio in ({"entrada": "open"}, {"entrada": "request", "listed_on_profile": False}):
        respuesta = await _ajustar(http, identidad, **cambio)
        assert respuesta.status_code == 503, respuesta.text
        assert codigo(respuesta) == "group_extras_not_available"
    async with sesiones() as db:
        assert (await db.get(GroupSettings, GRUPO)).listed_on_profile is True

    # Quitarla del perfil escribe la columna, como siempre.
    quitada = await _ajustar(http, identidad, listed_on_profile=False)
    assert quitada.status_code == 200
    assert quitada.json()["listed_on_profile"] is False
    assert await _perfil(http, identidad) == []
    identidad["uid"] = ANA
    cambiado = await http.post(f"{API}/{GRUPO}/group/invite/rotate")
    assert cambiado.status_code == 200
    assert (cambiado.json()["listed_on_profile"], cambiado.json()["entrada"]) == (False, None)


@pytest.mark.asyncio
async def test_sin_la_0112_no_se_pregunta_por_ella_en_cada_peticion(sin_la_0112):
    """Averiguar que falta cuesta una consulta al catálogo por proceso (y otra
    por minuto mientras falte), no una por petición."""
    http, sesiones, identidad = sin_la_0112
    await _ajustar(http, identidad, listed_on_profile=True)
    await _perfil(http, identidad)  # la primera vez sí se mira

    nombradas: list[str] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        if "group_profile_listings" in statement:
            nombradas.append(statement)

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    try:
        for _ in range(3):
            assert len(await _perfil(http, identidad)) == 1
            identidad["uid"] = ANA
            assert (await http.get(f"{API}/{GRUPO}/info")).status_code == 200
            assert (await _pedir(http, GRUPO)).status_code == 409  # Ana ya está dentro
    finally:
        event.remove(motor, "before_cursor_execute", _anotar)
    assert nombradas == []
    assert esquema._cache.get("group_profile_listings") is False
