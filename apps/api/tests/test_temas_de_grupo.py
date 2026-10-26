"""Los temas de un grupo (migración 0108, `messaging/temas.py`).

Pedido el 26/10/2026. Lo que se protege:

  · que solo quien administra el grupo cree, cambie y borre temas, y añada o
    quite referencias, aunque se llame a la API a mano;
  · que un tema enseñe el MISMO mensaje de General, con su conversación de
    verdad, y que lo borrado en General desaparezca también del tema;
  · que la lectura mezcle referencias y mensajes propios en orden, y que
    paginar no repita ni se salte nada;
  · que `unseen` cuente lo que la persona no ha visto, y que quien llega
    nuevo empiece en cero;
  · que los chats de los temas tengan siempre los miembros del grupo;
  · que eliminar un tema borre en suave lo suyo y no toque General.

El contrato está en `docs/CONTRATOS_TEMAS_Y_COMUNIDADES.md` § 4.1.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import (
    DateTime,
    Integer,
    Text,
    Uuid,
    column,
    func,
    insert,
    select,
    table,
    text,
    update,
)

# `app.main` VA PRIMERO: carga los módulos en el orden en que lo hace la
# aplicación (ver la misma nota en `test_grupos_de_mensajeria.py`).
from app.main import app  # noqa: I001
from app.modules.messaging import esquema, temas
from app.modules.messaging.models import (
    Conversation,
    ConversationMember,
    ConversationPreference,
    Message,
)
from app.modules.messaging.temas import (
    ConversationTopic,
    ConversationTopicItem,
    ConversationTopicView,
)
from tests.test_vistas_de_conversacion import (
    ANA,
    API,
    BASE,
    BRUNO,
    CARLA,
    DAVID,
    DIRECTO,
    GRUPO,
    OTRO_GRUPO,
    _levantar,
    _mensaje,
    _recoger,
)

#: Cuándo entró cada cual a sus conversaciones: antes de todo lo que se
#: escribe en estas pruebas. Fijarlo hace que `unseen` no dependa del reloj.
ANTES = BASE - timedelta(days=1)

COMUNIDAD = "bbbbbbbb-0000-0000-0000-0000000000c1"


@pytest_asyncio.fixture
async def entorno():
    engine, sesiones, identidad = await _levantar()
    async with sesiones() as db:
        await db.execute(update(ConversationMember).values(joined_at=ANTES))
        await db.commit()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad
    await _recoger(engine)


@pytest.fixture
def sin_avisos(monkeypatch):
    """Los avisos que programan añadir miembros y mandar un mensaje, retenidos.

    Sin esto el push sale en segundo plano contra el motor global de las
    pruebas, que no tiene tablas, y deja un error en el registro que no tiene
    nada que ver con lo que se prueba. Igual que `avisos_de_grupo` en
    `test_grupos_de_mensajeria.py`.
    """
    from app.modules.messaging import grupos
    from app.modules.messaging import router as messaging_router

    capturados: list[dict] = []

    def _retener(_background, **kwargs):
        capturados.append(kwargs)

    monkeypatch.setattr(grupos, "encolar_push", _retener, raising=False)
    monkeypatch.setattr(messaging_router, "encolar_push", _retener, raising=False)
    return capturados


# --------------------------------------------------------------------------- #
# Ayudantes
# --------------------------------------------------------------------------- #
async def _crear_tema(http, nombre: str = "Anuncios", icono: str | None = None, grupo=GRUPO):
    cuerpo: dict = {"name": nombre}
    if icono is not None:
        cuerpo["icon"] = icono
    return await http.post(f"{API}/{grupo}/topics", json=cuerpo)


async def _tema(
    http, nombre: str = "Anuncios", icono: str | None = None, sesiones=None
) -> dict:
    """Un tema creado por la API.

    Con `sesiones`, sus miembros «entraron» a su chat en `ANTES`, como el resto
    del montaje: las pruebas escriben mensajes con fechas fijas de BASE, y en
    la realidad nada se escribe en un tema antes de que exista.
    """
    respuesta = await _crear_tema(http, nombre, icono)
    assert respuesta.status_code == 201, respuesta.text
    tema = respuesta.json()
    if sesiones is not None:
        async with sesiones() as db:
            await db.execute(
                update(ConversationMember)
                .where(ConversationMember.conversation_id == tema["chat_id"])
                .values(joined_at=ANTES)
            )
            await db.commit()
    return tema


async def _lista(http, grupo: str = GRUPO, **params) -> dict:
    respuesta = await http.get(f"{API}/{grupo}/topics", params=params)
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


async def _del_tema(http, tema_id: str, grupo: str = GRUPO) -> dict:
    temas_ = (await _lista(http, grupo))["topics"]
    return next(t for t in temas_ if t["id"] == tema_id)


async def _pagina(http, tema_id: str, grupo: str = GRUPO, **params) -> dict:
    respuesta = await http.get(f"{API}/{grupo}/topics/{tema_id}/messages", params=params)
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


async def _referenciar(sesiones, tema_id: str, mid: str, cuando: datetime, por: str = ANA):
    """Una referencia escrita en la base, con la fecha que haga falta."""
    async with sesiones() as db:
        db.add(
            ConversationTopicItem(
                topic_id=tema_id,
                message_id=mid,
                conversation_id=GRUPO,
                added_by=por,
                added_at=cuando,
            )
        )
        await db.commit()


async def _miembros(sesiones, conv: str) -> set[str]:
    async with sesiones() as db:
        return set(
            (
                await db.execute(
                    select(ConversationMember.user_id).where(
                        ConversationMember.conversation_id == conv
                    )
                )
            ).scalars()
        )


def _error(respuesta) -> str:
    return respuesta.json()["error"]["code"]


# --------------------------------------------------------------------------- #
# 1. Crear, listar, cambiar y borrar
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_crear_un_tema_crea_su_chat_con_los_miembros_del_grupo(entorno):
    http, sesiones, _ = entorno
    tema = await _tema(http, "  Anuncios  ", "bell")
    assert tema["name"] == "Anuncios"
    assert tema["icon"] == "bell"
    assert tema["position"] == 0
    assert (tema["references"], tema["own"], tema["unseen"]) == (0, 0, 0)
    assert tema["contains"] is None
    assert tema["last"] is None

    # El chat propio es un grupo normal, firmado por quien administra, con
    # los mismos miembros que el grupo y el nombre del tema.
    async with sesiones() as db:
        chat = (
            await db.execute(
                select(Conversation.kind, Conversation.title, Conversation.created_by).where(
                    Conversation.id == tema["chat_id"]
                )
            )
        ).one()
    assert (chat.kind, chat.title, chat.created_by) == ("group", "Anuncios", ANA)
    assert await _miembros(sesiones, tema["chat_id"]) == {ANA, BRUNO, CARLA}

    lista = await _lista(http)
    assert lista["available"] is True
    assert lista["can_manage"] is True
    assert [t["id"] for t in lista["topics"]] == [tema["id"]]


@pytest.mark.asyncio
async def test_un_icono_desconocido_se_guarda_como_folder(entorno):
    http, _, _ = entorno
    assert (await _tema(http, "Sin icono"))["icon"] == "folder"
    assert (await _tema(http, "Raro", "no-existe"))["icon"] == "folder"


@pytest.mark.asyncio
async def test_solo_quien_administra_cambia_los_temas(entorno):
    http, sesiones, identidad = entorno
    tema = await _tema(http)
    mid = await _mensaje(sesiones, texto="hola", minuto=1)

    identidad["uid"] = BRUNO
    base = f"{API}/{GRUPO}/topics"
    intentos = [
        await http.post(base, json={"name": "Mío"}),
        await http.patch(f"{base}/{tema['id']}", json={"name": "Otro"}),
        await http.delete(f"{base}/{tema['id']}"),
        await http.put(f"{base}/{tema['id']}/items/{mid}"),
        await http.delete(f"{base}/{tema['id']}/items/{mid}"),
    ]
    for respuesta in intentos:
        assert respuesta.status_code == 403, respuesta.text
        assert _error(respuesta) == "topic_admin_only"

    # Pero lee, igual que todos los miembros, y no se le ofrece gestionar.
    lista = await _lista(http)
    assert lista["can_manage"] is False
    assert [t["name"] for t in lista["topics"]] == ["Anuncios"]
    assert (await http.post(f"{base}/{tema['id']}/seen")).status_code == 204

    # Quien no está en el grupo no lee nada, ni sabe si el tema existe.
    identidad["uid"] = DAVID
    assert (await http.get(base)).status_code == 403
    assert (await http.get(f"{base}/{tema['id']}/messages")).status_code == 403
    assert (await http.post(f"{base}/{tema['id']}/seen")).status_code == 403

    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(ConversationTopic)) == 1
        assert await db.scalar(select(func.count()).select_from(ConversationTopicItem)) == 0


@pytest.mark.asyncio
async def test_el_nombre_no_se_repite_y_hay_un_tope(entorno):
    http, _, _ = entorno
    primero = await _tema(http, "Anuncios")

    repetido = await _crear_tema(http, "  anuncios ")
    assert repetido.status_code == 409
    assert _error(repetido) == "topic_name_taken"

    for malo in ("   ", "x" * 41):
        assert (await _crear_tema(http, malo)).status_code == 422

    # Borrar un tema libera su nombre.
    assert (await http.delete(f"{API}/{GRUPO}/topics/{primero['id']}")).status_code == 204
    await _tema(http, "Anuncios")

    for i in range(temas.MAX_TEMAS_POR_GRUPO - 1):
        await _tema(http, f"Tema {i}")
    de_mas = await _crear_tema(http, "El que sobra")
    assert de_mas.status_code == 409
    assert _error(de_mas) == "topics_limit"


@pytest.mark.asyncio
async def test_renombrar_cambia_tambien_el_titulo_de_su_chat(entorno):
    http, sesiones, _ = entorno
    anuncios = await _tema(http, "Anuncios")
    material = await _tema(http, "Material")
    assert [t["name"] for t in (await _lista(http))["topics"]] == ["Anuncios", "Material"]

    cambiado = await http.patch(
        f"{API}/{GRUPO}/topics/{anuncios['id']}",
        json={"name": "Avisos", "icon": "inventado", "position": 5},
    )
    assert cambiado.status_code == 200, cambiado.text
    assert cambiado.json()["name"] == "Avisos"
    assert cambiado.json()["icon"] == "folder"
    assert cambiado.json()["position"] == 5

    async with sesiones() as db:
        assert await db.scalar(
            select(Conversation.title).where(Conversation.id == anuncios["chat_id"])
        ) == "Avisos"

    # La posición ordena la lista.
    assert [t["name"] for t in (await _lista(http))["topics"]] == ["Material", "Avisos"]

    choca = await http.patch(f"{API}/{GRUPO}/topics/{material['id']}", json={"name": " avisos"})
    assert choca.status_code == 409
    assert _error(choca) == "topic_name_taken"

    # Un tema que no es de este grupo, o inventado, es 404.
    nadie = await http.patch(
        f"{API}/{GRUPO}/topics/11111111-2222-3333-4444-555555555555", json={"name": "X"}
    )
    assert nadie.status_code == 404
    assert _error(nadie) == "topic_not_found"


@pytest.mark.asyncio
async def test_solo_un_grupo_de_primer_nivel_tiene_temas(entorno):
    http, sesiones, _ = entorno
    tema = await _tema(http)

    # Ni un chat de dos, ni el chat de un tema (que también es «group» y
    # también lo administra Ana).
    for conv in (DIRECTO, tema["chat_id"]):
        respuesta = await _crear_tema(http, "Dentro", grupo=conv)
        assert respuesta.status_code == 409, respuesta.text
        assert _error(respuesta) == "not_a_top_level_group"
        lista = await _lista(http, conv)
        assert lista == {"available": False, "can_manage": False, "topics": []}

    # Ni una comunidad (0109). Su modelo es del Agente C: si todavía no
    # existe, la tabla se crea aquí con las columnas del contrato.
    _subgrupos = table(
        "group_subgroups",
        column("conversation_id", Uuid(as_uuid=False)),
        column("parent_id", Uuid(as_uuid=False)),
        column("descripcion", Text),
        column("entrada", Text),
        column("posicion", Integer),
        column("created_at", DateTime(timezone=True)),
    )
    async with sesiones() as db:
        await db.execute(
            text(
                "create table if not exists group_subgroups ("
                " conversation_id char(32) primary key,"
                " parent_id char(32) not null,"
                " descripcion text not null default '',"
                " entrada text not null default 'open',"
                " posicion integer not null default 0,"
                " created_at datetime not null default current_timestamp,"
                " deleted_at datetime)"
            )
        )
        db.add(Conversation(id=COMUNIDAD, kind="group", title="Valorant", created_by=ANA))
        await db.flush()
        db.add(ConversationMember(conversation_id=COMUNIDAD, user_id=ANA))
        await db.execute(
            insert(_subgrupos).values(
                conversation_id=COMUNIDAD,
                parent_id=GRUPO,
                descripcion="",
                entrada="open",
                posicion=0,
                created_at=BASE,
            )
        )
        await db.commit()
    # Lo averiguado sobre la 0109 antes de crear la tabla ya no vale.
    esquema.olvidar()

    respuesta = await _crear_tema(http, "Dentro", grupo=COMUNIDAD)
    assert respuesta.status_code == 409
    assert _error(respuesta) == "not_a_top_level_group"
    assert (await _lista(http, COMUNIDAD))["available"] is False
    # El grupo padre sigue pudiendo.
    assert (await _crear_tema(http, "Otro")).status_code == 201


# --------------------------------------------------------------------------- #
# 2. Referencias
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_anadir_y_quitar_una_referencia_es_idempotente(entorno):
    http, sesiones, _ = entorno
    tema = await _tema(http)
    mid = await _mensaje(sesiones, de=CARLA, texto="Clase el lunes", minuto=1)
    ruta = f"{API}/{GRUPO}/topics/{tema['id']}/items/{mid}"

    assert (await http.put(ruta)).status_code == 204
    assert (await http.put(ruta)).status_code == 204
    async with sesiones() as db:
        filas = (await db.execute(select(ConversationTopicItem))).scalars().all()
    assert [(f.message_id, f.added_by, f.conversation_id) for f in filas] == [(mid, ANA, GRUPO)]
    assert (await _del_tema(http, tema["id"]))["references"] == 1

    assert (await http.delete(ruta)).status_code == 204
    assert (await http.delete(ruta)).status_code == 204
    assert (await _del_tema(http, tema["id"]))["references"] == 0

    # Quitarla no toca General.
    historial = await http.get(f"{API}/{GRUPO}/messages")
    assert [m["id"] for m in historial.json()] == [mid]


@pytest.mark.asyncio
async def test_solo_se_referencia_un_mensaje_vivo_de_general(entorno):
    http, sesiones, _ = entorno
    tema = await _tema(http)
    de_otro_grupo = await _mensaje(sesiones, de=BRUNO, texto="x", en=OTRO_GRUPO, minuto=1)
    del_directo = await _mensaje(sesiones, texto="x", en=DIRECTO, minuto=2)
    borrado = await _mensaje(sesiones, texto="x", minuto=3, borrado=True)
    del_tema = await _mensaje(sesiones, texto="x", en=tema["chat_id"], minuto=4)
    inventado = "11111111-2222-3333-4444-555555555555"

    for mid in (de_otro_grupo, del_directo, borrado, del_tema, inventado, "no-es-un-uuid"):
        respuesta = await http.put(f"{API}/{GRUPO}/topics/{tema['id']}/items/{mid}")
        assert respuesta.status_code == 404, mid
        assert _error(respuesta) == "message_not_in_group"

    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(ConversationTopicItem)) == 0


@pytest.mark.asyncio
async def test_contains_dice_en_que_temas_esta_un_mensaje(entorno):
    http, sesiones, _ = entorno
    anuncios = await _tema(http, "Anuncios")
    material = await _tema(http, "Material")
    mid = await _mensaje(sesiones, texto="Examen el viernes", minuto=1)
    assert (
        await http.put(f"{API}/{GRUPO}/topics/{material['id']}/items/{mid}")
    ).status_code == 204

    con = {t["id"]: t["contains"] for t in (await _lista(http, message_id=mid))["topics"]}
    assert con == {anuncios["id"]: False, material["id"]: True}
    # Un identificador mal escrito no es un error: no está en ninguno.
    raro = {t["id"]: t["contains"] for t in (await _lista(http, message_id="nada"))["topics"]}
    assert raro == {anuncios["id"]: False, material["id"]: False}
    sin = [t["contains"] for t in (await _lista(http))["topics"]]
    assert sin == [None, None]


# --------------------------------------------------------------------------- #
# 3. Leer un tema
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_lectura_mezcla_referencias_y_propios_en_orden_y_pagina(entorno):
    http, sesiones, identidad = entorno
    tema = await _tema(http)
    chat = tema["chat_id"]
    m1 = await _mensaje(sesiones, de=CARLA, texto="uno", adjuntos=("image",), minuto=1)
    m2 = await _mensaje(sesiones, de=BRUNO, texto="dos", minuto=2)
    m3 = await _mensaje(sesiones, de=CARLA, texto="tres", minuto=3)
    # Se ordenan por cuándo LLEGARON AL TEMA, no por cuándo se escribieron.
    await _referenciar(sesiones, tema["id"], m3, BASE + timedelta(minutes=10))
    a = await _mensaje(sesiones, texto="propio A", en=chat, minuto=20)
    await _referenciar(sesiones, tema["id"], m1, BASE + timedelta(minutes=30))
    b = await _mensaje(sesiones, texto="propio B", en=chat, minuto=40)
    await _referenciar(sesiones, tema["id"], m2, BASE + timedelta(minutes=50))
    # Lo de General que NO está en el tema no sale.
    await _mensaje(sesiones, texto="charla", minuto=60)

    # Ana vació General para sí después de todo eso: el tema no se entera (D3).
    async with sesiones() as db:
        db.add(
            ConversationPreference(
                conversation_id=GRUPO, user_id=ANA, cleared_at=BASE + timedelta(days=1)
            )
        )
        await db.commit()

    entera = await _pagina(http, tema["id"])
    assert entera["has_more"] is False
    items = entera["items"]
    assert [i["id"] for i in items] == [m3, a, m1, b, m2]
    assert [i["own"] for i in items] == [False, True, False, True, False]
    # El conversation_id de cada uno es el DE VERDAD.
    assert [i["conversation_id"] for i in items] == [GRUPO, chat, GRUPO, chat, GRUPO]

    ref = items[2]
    assert ref["body"] == "uno"
    assert ref["sender"]["id"] == CARLA
    assert [adj["kind"] for adj in ref["attachments"]] == ["image"]
    assert ref["added_by"]["id"] == ANA
    assert ref["added_at"].startswith("2026-10-01T12:30")
    assert ref["order_at"].startswith("2026-10-01T12:30")
    propio = items[1]
    assert propio["added_by"] is None
    assert propio["added_at"] is None
    assert propio["order_at"].startswith("2026-10-01T12:20")

    # Paginado por `before`: los más recientes primero, cada página de
    # antiguo a reciente, sin repetir ni saltarse nada.
    p1 = await _pagina(http, tema["id"], limit=2)
    assert [i["id"] for i in p1["items"]] == [b, m2]
    assert p1["has_more"] is True
    p2 = await _pagina(http, tema["id"], limit=2, before=p1["items"][0]["order_at"])
    assert [i["id"] for i in p2["items"]] == [a, m1]
    assert p2["has_more"] is True
    p3 = await _pagina(http, tema["id"], limit=2, before=p2["items"][0]["order_at"])
    assert [i["id"] for i in p3["items"]] == [m3]
    assert p3["has_more"] is False

    # Un miembro cualquiera lee lo mismo. Y el límite tiene tope.
    identidad["uid"] = BRUNO
    assert [i["id"] for i in (await _pagina(http, tema["id"]))["items"]] == [m3, a, m1, b, m2]
    demasiado = await http.get(
        f"{API}/{GRUPO}/topics/{tema['id']}/messages", params={"limit": 61}
    )
    assert demasiado.status_code == 422


@pytest.mark.asyncio
async def test_un_mensaje_borrado_en_general_desaparece_del_tema(entorno):
    http, sesiones, _ = entorno
    tema = await _tema(http)
    mid = await _mensaje(sesiones, texto="Me equivoqué", minuto=1)
    otro = await _mensaje(sesiones, texto="Esto sí", minuto=2)
    for m in (mid, otro):
        assert (
            await http.put(f"{API}/{GRUPO}/topics/{tema['id']}/items/{m}")
        ).status_code == 204

    # Su autora lo borra EN GENERAL, por la ruta de siempre.
    assert (await http.delete(f"{API}/{GRUPO}/messages/{mid}")).status_code == 204

    assert [i["id"] for i in (await _pagina(http, tema["id"]))["items"]] == [otro]
    fila = await _del_tema(http, tema["id"])
    assert fila["references"] == 1
    assert fila["last"]["excerpt"] == "Esto sí"


@pytest.mark.asyncio
async def test_el_tema_de_otro_grupo_no_se_alcanza(entorno):
    http, _, identidad = entorno
    # Bruno administra el otro grupo; Carla está en los dos.
    identidad["uid"] = BRUNO
    ajeno = (await _crear_tema(http, "De Bruno", grupo=OTRO_GRUPO)).json()

    identidad["uid"] = CARLA
    respuesta = await http.get(f"{API}/{GRUPO}/topics/{ajeno['id']}/messages")
    assert respuesta.status_code == 404
    assert _error(respuesta) == "topic_not_found"
    assert (await http.post(f"{API}/{GRUPO}/topics/{ajeno['id']}/seen")).status_code == 404


@pytest.mark.asyncio
async def test_se_reacciona_en_el_tema_con_las_reacciones_de_siempre(entorno):
    """D16: la aplicación reacciona con el `conversation_id` de cada mensaje."""
    http, sesiones, identidad = entorno
    tema = await _tema(http)
    general = await _mensaje(sesiones, de=CARLA, texto="ref", minuto=1)
    await _referenciar(sesiones, tema["id"], general, BASE + timedelta(minutes=5))
    propio = await _mensaje(sesiones, texto="aviso", en=tema["chat_id"], minuto=6)

    identidad["uid"] = BRUNO
    for item in (await _pagina(http, tema["id"]))["items"]:
        reaccion = await http.put(
            f"{API}/{item['conversation_id']}/messages/{item['id']}/reaction",
            json={"emoji": "❤"},
        )
        assert reaccion.status_code == 200, reaccion.text

    items = {i["id"]: i for i in (await _pagina(http, tema["id"]))["items"]}
    for mid in (general, propio):
        assert items[mid]["reactions"] == [{"emoji": "❤", "count": 1, "mine": True}]


@pytest.mark.asyncio
async def test_last_es_lo_ultimo_que_llego_al_tema(entorno):
    http, sesiones, _ = entorno
    tema = await _tema(http)
    foto = await _mensaje(sesiones, de=CARLA, adjuntos=("image",), minuto=1)
    await _mensaje(sesiones, texto="Primero", en=tema["chat_id"], minuto=5)
    await _referenciar(sesiones, tema["id"], foto, BASE + timedelta(minutes=10))

    ultimo = (await _del_tema(http, tema["id"]))["last"]
    assert ultimo["own"] is False
    assert ultimo["kind"] == "image"
    assert ultimo["sender_name"] == "Carla"
    assert ultimo["at"].startswith("2026-10-01T12:10")

    await _mensaje(sesiones, texto="Mira  https://renaser.pe", en=tema["chat_id"], minuto=20)
    ultimo = (await _del_tema(http, tema["id"]))["last"]
    assert ultimo == {
        "sender_name": "Ana",
        "excerpt": "Mira https://renaser.pe",
        "kind": "link",
        "at": ultimo["at"],
        "own": True,
    }
    assert ultimo["at"].startswith("2026-10-01T12:20")
    fila = await _del_tema(http, tema["id"])
    assert (fila["references"], fila["own"]) == (1, 2)


# --------------------------------------------------------------------------- #
# 4. Lo no visto
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_unseen_cuenta_lo_que_no_ha_visto_y_seen_lo_pone_a_cero(entorno):
    http, sesiones, identidad = entorno
    tema = await _tema(http, sesiones=sesiones)
    chat = tema["chat_id"]
    mid = await _mensaje(sesiones, de=CARLA, texto="ref", minuto=1)
    assert (
        await http.put(f"{API}/{GRUPO}/topics/{tema['id']}/items/{mid}")
    ).status_code == 204
    await _mensaje(sesiones, texto="aviso", en=chat, minuto=5)

    async def _no_vistos(uid: str) -> int:
        identidad["uid"] = uid
        return (await _del_tema(http, tema["id"]))["unseen"]

    async def _de_temas(uid: str) -> int:
        async with sesiones() as db:
            return await temas.no_leidos_de_temas(db, GRUPO, uid)

    # Ana lo hizo todo: no tiene nada que ver. Bruno y Carla, dos cosas cada
    # uno (la referencia la añadió Ana aunque el mensaje fuera de Carla).
    assert await _no_vistos(ANA) == 0
    assert await _no_vistos(BRUNO) == 2
    assert await _no_vistos(CARLA) == 2
    # La bandeja solo suma los mensajes propios del tema.
    assert await _de_temas(BRUNO) == 1
    assert await _de_temas(ANA) == 0

    identidad["uid"] = BRUNO
    assert (await http.post(f"{API}/{GRUPO}/topics/{tema['id']}/seen")).status_code == 204
    assert (await http.post(f"{API}/{GRUPO}/topics/{tema['id']}/seen")).status_code == 204
    assert await _no_vistos(BRUNO) == 0
    assert await _de_temas(BRUNO) == 0
    assert await _no_vistos(CARLA) == 2
    async with sesiones() as db:
        assert await db.scalar(
            select(func.count()).select_from(ConversationTopicView)
        ) == 1
        assert await db.scalar(
            select(ConversationMember.last_read_at).where(
                ConversationMember.conversation_id == chat,
                ConversationMember.user_id == BRUNO,
            )
        ) is not None

    # Lo que llega DESPUÉS de verlo vuelve a contar.
    luego = datetime.now(timezone.utc) + timedelta(hours=1)
    otro = await _mensaje(sesiones, de=CARLA, texto="otra ref", minuto=2)
    await _referenciar(sesiones, tema["id"], otro, luego)
    await _mensaje(sesiones, texto="otro aviso", en=chat, cuando=luego)
    assert await _no_vistos(BRUNO) == 2
    assert await _de_temas(BRUNO) == 1


@pytest.mark.asyncio
async def test_quien_llega_nuevo_al_grupo_empieza_en_cero(entorno):
    http, sesiones, identidad = entorno
    tema = await _tema(http, sesiones=sesiones)
    mid = await _mensaje(sesiones, de=CARLA, texto="ref", minuto=1)
    await _referenciar(sesiones, tema["id"], mid, BASE + timedelta(minutes=2))
    await _mensaje(sesiones, texto="aviso viejo", en=tema["chat_id"], minuto=3)

    # David entra al grupo después de todo eso.
    entra = datetime.now(timezone.utc) + timedelta(hours=1)
    async with sesiones() as db:
        db.add(ConversationMember(conversation_id=GRUPO, user_id=DAVID, joined_at=entra))
        await temas.sincronizar_miembros(db, GRUPO, [DAVID], dentro=True)
        await db.commit()

    identidad["uid"] = DAVID
    fila = await _del_tema(http, tema["id"])
    assert (fila["references"], fila["own"], fila["unseen"]) == (1, 1, 0)
    async with sesiones() as db:
        assert await temas.no_leidos_de_temas(db, GRUPO, DAVID) == 0

    # Lo que se escribe después de que entrara, sí le cuenta.
    await _mensaje(sesiones, texto="aviso nuevo", en=tema["chat_id"], cuando=entra + timedelta(hours=1))
    assert (await _del_tema(http, tema["id"]))["unseen"] == 1
    async with sesiones() as db:
        assert await temas.no_leidos_de_temas(db, GRUPO, DAVID) == 1


@pytest.mark.asyncio
async def test_seen_repone_la_fila_que_falte_en_el_chat_del_tema(entorno):
    """Un miembro del grupo sin fila en el chat del tema no podría reaccionar
    en él. `seen` se la pone, y solo a miembros del grupo."""
    http, sesiones, identidad = entorno
    tema = await _tema(http)
    async with sesiones() as db:
        await temas.sincronizar_miembros(db, GRUPO, [BRUNO], dentro=False)
        await db.commit()
    assert BRUNO not in await _miembros(sesiones, tema["chat_id"])

    identidad["uid"] = BRUNO
    assert (await http.post(f"{API}/{GRUPO}/topics/{tema['id']}/seen")).status_code == 204
    assert BRUNO in await _miembros(sesiones, tema["chat_id"])

    identidad["uid"] = DAVID
    assert (await http.post(f"{API}/{GRUPO}/topics/{tema['id']}/seen")).status_code == 403
    assert DAVID not in await _miembros(sesiones, tema["chat_id"])


@pytest.mark.asyncio
async def test_la_bandeja_cuenta_los_temas_igual_que_temas_py(entorno):
    """`lectura.temas_de_la_pagina` (C) calcula por lotes lo mismo que
    `no_leidos_de_temas`: si divergieran, el número del grupo en la bandeja y
    el de sus temas dentro no cuadrarían."""
    from app.modules.messaging import lectura

    http, sesiones, identidad = entorno
    uno = await _tema(http, "Uno", sesiones=sesiones)
    dos = await _tema(http, "Dos", sesiones=sesiones)
    await _mensaje(sesiones, texto="a", en=uno["chat_id"], minuto=1)
    await _mensaje(sesiones, texto="b", en=dos["chat_id"], minuto=2)
    await _mensaje(sesiones, texto="c", en=dos["chat_id"], minuto=3)
    identidad["uid"] = BRUNO
    assert (await http.post(f"{API}/{GRUPO}/topics/{uno['id']}/seen")).status_code == 204

    async with sesiones() as db:
        for uid in (ANA, BRUNO, CARLA):
            cuantos, no_leidos = await lectura.temas_de_la_pagina(db, [GRUPO], uid)
            assert cuantos.get(GRUPO, 0) == 2
            assert no_leidos.get(GRUPO, 0) == await temas.no_leidos_de_temas(db, GRUPO, uid)
        assert await temas.no_leidos_de_temas(db, GRUPO, BRUNO) == 2
        assert await temas.no_leidos_de_temas(db, GRUPO, CARLA) == 3


# --------------------------------------------------------------------------- #
# 5. Lo que usan los demás módulos
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sincronizar_miembros_mete_y_saca_de_todos_los_temas_vivos(entorno):
    http, sesiones, _ = entorno
    uno = await _tema(http, "Uno")
    dos = await _tema(http, "Dos")
    borrado = await _tema(http, "Borrado")
    assert (await http.delete(f"{API}/{GRUPO}/topics/{borrado['id']}")).status_code == 204

    async with sesiones() as db:
        await temas.sincronizar_miembros(db, GRUPO, [DAVID], dentro=True)
        # Dos veces: quien ya estaba se queda como estaba.
        await temas.sincronizar_miembros(db, GRUPO, [DAVID, DAVID], dentro=True)
        await db.commit()
    for chat in (uno["chat_id"], dos["chat_id"]):
        assert await _miembros(sesiones, chat) == {ANA, BRUNO, CARLA, DAVID}
    # El chat de un tema eliminado no recupera a nadie.
    assert await _miembros(sesiones, borrado["chat_id"]) == set()

    async with sesiones() as db:
        await temas.sincronizar_miembros(db, GRUPO, [DAVID, BRUNO], dentro=False)
        await db.commit()
    for chat in (uno["chat_id"], dos["chat_id"]):
        assert await _miembros(sesiones, chat) == {ANA, CARLA}
    # Y no se ha tocado el grupo: eso lo hace quien llama.
    assert await _miembros(sesiones, GRUPO) == {ANA, BRUNO, CARLA}

    # Sin personas, o en un grupo sin temas, no hace nada.
    async with sesiones() as db:
        await temas.sincronizar_miembros(db, GRUPO, [], dentro=True)
        await temas.sincronizar_miembros(db, OTRO_GRUPO, [DAVID], dentro=True)
        await db.commit()
    assert await _miembros(sesiones, OTRO_GRUPO) == {BRUNO, CARLA}


@pytest.mark.asyncio
async def test_tema_de_chat_chats_de_temas_y_la_condicion_de_la_bandeja(entorno):
    http, sesiones, _ = entorno
    uno = await _tema(http, "Uno")
    dos = await _tema(http, "Dos")

    async with sesiones() as db:
        assert await temas.tema_de_chat(db, uno["chat_id"]) == (GRUPO, uno["id"])
        assert await temas.tema_de_chat(db, GRUPO) is None
        assert await temas.tema_de_chat(db, "no-es-un-uuid") is None
        assert await temas.chats_de_temas(db, GRUPO) == [uno["chat_id"], dos["chat_id"]]
        assert await temas.chats_de_temas(db, OTRO_GRUPO) == []
        assert await temas.chats_de_temas(db, "basura") == []

        sueltas = set(
            (
                await db.execute(
                    select(Conversation.id).where(
                        temas.condicion_no_es_chat_de_tema(Conversation.id)
                    )
                )
            ).scalars()
        )
    assert sueltas == {GRUPO, OTRO_GRUPO, DIRECTO}

    assert (await http.delete(f"{API}/{GRUPO}/topics/{uno['id']}")).status_code == 204
    async with sesiones() as db:
        assert await temas.tema_de_chat(db, uno["chat_id"]) is None
        assert await temas.chats_de_temas(db, GRUPO) == [dos["chat_id"]]
        # El chat de un tema eliminado sigue sin ser un grupo suelto.
        sueltas = set(
            (
                await db.execute(
                    select(Conversation.id).where(
                        temas.condicion_no_es_chat_de_tema(Conversation.id)
                    )
                )
            ).scalars()
        )
    assert uno["chat_id"] not in sueltas


# --------------------------------------------------------------------------- #
# 6. Eliminar un tema (D15)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_eliminar_un_tema_borra_en_suave_lo_suyo_y_no_toca_general(entorno):
    http, sesiones, _ = entorno
    tema = await _tema(http)
    general = await _mensaje(sesiones, de=CARLA, texto="de General", minuto=1)
    assert (
        await http.put(f"{API}/{GRUPO}/topics/{tema['id']}/items/{general}")
    ).status_code == 204
    propios = [
        await _mensaje(sesiones, texto=f"aviso {i}", en=tema["chat_id"], minuto=2 + i)
        for i in range(2)
    ]

    assert (await http.delete(f"{API}/{GRUPO}/topics/{tema['id']}")).status_code == 204
    # Dos veces: ya estaba.
    assert (await http.delete(f"{API}/{GRUPO}/topics/{tema['id']}")).status_code == 204

    async with sesiones() as db:
        assert await db.scalar(
            select(ConversationTopic.deleted_at).where(ConversationTopic.id == tema["id"])
        ) is not None
        borrados = dict(
            (
                await db.execute(
                    select(Message.id, Message.deleted_at).where(
                        Message.id.in_([general, *propios])
                    )
                )
            ).all()
        )
        # Los suyos siguen en la base, borrados en suave; el de General, vivo.
        assert all(borrados[p] is not None for p in propios)
        assert borrados[general] is None
    assert await _miembros(sesiones, tema["chat_id"]) == set()

    assert (await _lista(http))["topics"] == []
    respuesta = await http.get(f"{API}/{GRUPO}/topics/{tema['id']}/messages")
    assert respuesta.status_code == 404
    historial = await http.get(f"{API}/{GRUPO}/messages")
    assert [m["id"] for m in historial.json()] == [general]


# --------------------------------------------------------------------------- #
# 7. Lo que depende del Agente C (integración en rutas que ya existen)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_en_el_chat_de_un_tema_solo_escribe_quien_administra(entorno, sin_avisos):
    http, _, identidad = entorno
    tema = await _tema(http)
    identidad["uid"] = BRUNO
    respuesta = await http.post(f"{API}/{tema['chat_id']}/messages", json={"body": "hola"})
    assert respuesta.status_code == 403
    assert _error(respuesta) == "topic_admin_only"
    identidad["uid"] = ANA
    assert (
        await http.post(f"{API}/{tema['chat_id']}/messages", json={"body": "aviso"})
    ).status_code == 201


@pytest.mark.asyncio
async def test_salir_del_grupo_saca_de_los_chats_de_sus_temas(entorno):
    http, sesiones, identidad = entorno
    tema = await _tema(http)
    identidad["uid"] = BRUNO
    assert (await http.delete(f"{API}/{GRUPO}/members/{BRUNO}")).status_code == 204
    assert BRUNO not in await _miembros(sesiones, tema["chat_id"])


@pytest.mark.asyncio
async def test_entrar_al_grupo_mete_en_los_chats_de_sus_temas(entorno, sin_avisos):
    http, sesiones, _ = entorno
    tema = await _tema(http)
    respuesta = await http.post(f"{API}/{GRUPO}/members", json={"user_ids": [DAVID]})
    assert respuesta.status_code == 200, respuesta.text
    assert DAVID in await _miembros(sesiones, tema["chat_id"])


@pytest.mark.asyncio
async def test_el_chat_de_un_tema_no_sale_en_la_bandeja(entorno):
    http, _, identidad = entorno
    tema = await _tema(http)
    for uid in (ANA, BRUNO):
        identidad["uid"] = uid
        bandeja = (await http.get(API)).json()
        ids = [c["id"] for c in bandeja]
        assert GRUPO in ids
        assert tema["chat_id"] not in ids
