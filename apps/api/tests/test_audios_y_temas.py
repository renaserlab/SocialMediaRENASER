"""Audios y temas (30/10/2026, migración 0113): el nombre de cada archivo y en qué tema está.

`docs/CONTRATOS_AUDIOS_Y_TEMAS.md`, § 1 y § 2. Lo que se protege:

  · que un archivo de audio viaje como `audio` con `voice_note: false`, sin
    las reglas de una nota de voz, y que las aplicaciones antiguas sigan
    mandando notas de voz sin decir nada;
  · que el nombre se recorte, que vacío sea «sin nombre», que pase de 80 sea
    un 422 con su código y que en una foto no exista;
  · que ponerle nombre después lo puedan quien envió el mensaje, quien
    administra y la moderación, y nadie más, aunque llame a la API a mano;
  · que cada mensaje diga en qué temas está (`topics`) en el chat, en
    Contenido y dentro de un tema, sin una consulta por burbuja y sin que se
    cuele el tema de otra comunidad;
  · que «Agregar N a un tema» sea todo o nada e idempotente;
  · que `of-messages` sea solo para miembros y no sirva para mirar fuera;
  · que el filtro por tema y «Sin tema» de Contenido, y sus cuentas, digan lo
    mismo, también con el chat vaciado;
  · que las vistas previas digan «Nota de voz» y, con nombre, el nombre;
  · que SIN LA 0113 (la API desplegada antes de pegarla) todo funcione como
    antes, sin un 500 y sin mirar el catálogo en cada petición;
  · y que la migración diga lo mismo que el modelo.
"""

from __future__ import annotations

import re
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import Column, MetaData, Table, event, func, insert, inspect, select, update
from sqlalchemy.exc import IntegrityError

# `app.main` va primero: ver la nota en `test_grupos_de_mensajeria.py`.
from app.main import app  # noqa: F401, I001
from app.modules.messaging import esquema
from app.modules.messaging import router as messaging_router
from app.modules.messaging.models import (
    ConversationPreference,
    Message,
    MessageAttachment,
)
from app.modules.messaging.temas import ConversationTopicItem
from app.modules.profiles.models import Profile
from tests.test_vistas_de_conversacion import (  # noqa: F401 - `entorno` es un fixture
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
    _recoger,
    entorno,
)

MIGRACION = (
    Path(__file__).resolve().parents[3] / "supabase" / "migrations" / "0113_nombres_de_adjuntos.sql"
)
NADA = "11111111-2222-3333-4444-555555555555"


@pytest.fixture(autouse=True)
def sin_push(monkeypatch):
    """Los avisos no son de esta prueba: que mandar un mensaje no los encole."""
    monkeypatch.setattr(messaging_router, "encolar_push", lambda *_a, **_k: None)


def codigo(respuesta) -> str:
    return respuesta.json()["error"]["code"]


# --------------------------------------------------------------------------- #
# Ayudantes
# --------------------------------------------------------------------------- #
def _adjunto(kind: str, *, de: str = ANA, en: str = GRUPO, **extra) -> dict:
    extension = {"image": "jpg", "video": "mp4", "document": "pdf", "audio": "m4a"}[kind]
    cuerpo = {"storage_path": f"{en}/{de}/{uuid4()}.{extension}", "kind": kind}
    if kind == "audio" and "duration_s" not in extra and extra.get("voice_note") is not False:
        cuerpo["duration_s"] = 12.5
    cuerpo.update(extra)
    return cuerpo


async def _enviar(http, identidad, *adjuntos: dict, de: str = ANA, en: str = GRUPO, texto: str = "", **mas):
    identidad["uid"] = de
    return await http.post(
        f"{API}/{en}/messages", json={"body": texto, "attachments": list(adjuntos), **mas}
    )


async def _enviado(http, identidad, *adjuntos: dict, de: str = ANA, en: str = GRUPO, texto: str = "") -> dict:
    respuesta = await _enviar(http, identidad, *adjuntos, de=de, en=en, texto=texto)
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()


async def _escrito(
    sesiones,
    *,
    de: str = ANA,
    en: str = GRUPO,
    texto: str = "",
    kind: str | None = None,
    titulo: str | None = None,
    nota: bool | None = None,
    minuto: int = 0,
    borrado: bool = False,
) -> str:
    """Un mensaje escrito en la base, con un adjunto con nombre si se pide."""
    mid = str(uuid4())
    cuando = BASE + timedelta(minutes=minuto)
    async with sesiones() as db:
        db.add(
            Message(
                id=mid,
                conversation_id=en,
                sender_id=de,
                body=texto,
                created_at=cuando,
                deleted_at=cuando if borrado else None,
            )
        )
        await db.flush()
        if kind is not None:
            await db.execute(
                insert(MessageAttachment.__table__).values(
                    id=str(uuid4()),
                    message_id=mid,
                    conversation_id=en,
                    storage_path=f"{en}/{de}/{uuid4()}",
                    kind=kind,
                    title=titulo,
                    voice_note=(kind == "audio") if nota is None else nota,
                    sort_order=0,
                )
            )
        await db.commit()
    return mid


async def _historial(http, identidad, quien: str = ANA, en: str = GRUPO, **params) -> list[dict]:
    identidad["uid"] = quien
    respuesta = await http.get(f"{API}/{en}/messages", params=params)
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


async def _tema(http, identidad, nombre: str, en: str = GRUPO, quien: str = ANA) -> str:
    identidad["uid"] = quien
    respuesta = await http.post(f"{API}/{en}/topics", json={"name": nombre})
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()["id"]


async def _al_tema(http, identidad, tema: str, *mids: str, en: str = GRUPO) -> None:
    identidad["uid"] = ANA
    for mid in mids:
        respuesta = await http.put(f"{API}/{en}/topics/{tema}/items/{mid}")
        assert respuesta.status_code == 204, respuesta.text


async def _lote(http, identidad, tema: str, ids: list[str], quien: str = ANA, en: str = GRUPO):
    identidad["uid"] = quien
    return await http.put(f"{API}/{en}/topics/{tema}/items", json={"message_ids": ids})


async def _referencias(sesiones, tema: str) -> set[str]:
    async with sesiones() as db:
        return {
            str(m)
            for m in await db.scalars(
                select(ConversationTopicItem.message_id).where(
                    ConversationTopicItem.topic_id == tema
                )
            )
        }


async def _nombrar(http, identidad, mid: str, aid: str, titulo, quien: str = ANA, en: str = GRUPO):
    identidad["uid"] = quien
    return await http.patch(
        f"{API}/{en}/messages/{mid}/attachments/{aid}", json={"title": titulo}
    )


async def _fila_del_adjunto(sesiones, aid: str):
    async with sesiones() as db:
        return (
            await db.execute(
                select(
                    MessageAttachment.__table__.c.title,
                    MessageAttachment.__table__.c.voice_note,
                    MessageAttachment.kind,
                ).where(MessageAttachment.id == aid)
            )
        ).one()


def _por_id(mensajes: list[dict]) -> dict[str, dict]:
    return {m["id"]: m for m in mensajes}


# =========================================================================== #
# 1. Enviar: notas de voz, archivos de audio y nombres
# =========================================================================== #
@pytest.mark.asyncio
async def test_una_aplicacion_antigua_sigue_mandando_notas_de_voz(entorno):
    """Sin `voice_note` ni `title` —lo que manda la aplicación de los teléfonos—
    un audio es una nota de voz, con sus reglas de siempre."""
    http, sesiones, identidad = entorno
    nota = _adjunto("audio", mime_type="audio/mp4")
    enviado = await _enviado(http, identidad, nota)
    [adjunto] = enviado["attachments"]
    assert (adjunto["kind"], adjunto["voice_note"], adjunto["title"]) == ("audio", True, None)
    assert enviado["topics"] == []
    assert tuple(await _fila_del_adjunto(sesiones, adjunto["id"])) == (None, True, "audio")
    [en_el_chat] = (await _historial(http, identidad))[-1]["attachments"]
    assert en_el_chat == adjunto

    # Y sin duración sigue siendo un 422, como siempre.
    sin_duracion = await _enviar(http, identidad, _adjunto("audio", duration_s=None))
    assert sin_duracion.status_code == 422
    assert codigo(sin_duracion) == "voice_note_without_duration"
    explicita = await _enviar(http, identidad, _adjunto("audio", voice_note=True, duration_s=None))
    assert codigo(explicita) == "voice_note_without_duration"
    larga = await _enviar(http, identidad, _adjunto("audio", voice_note=True, duration_s=3600))
    assert codigo(larga) == "voice_note_too_long"


@pytest.mark.asyncio
async def test_un_archivo_de_audio_viaja_como_audio_sin_las_reglas_de_una_nota(entorno):
    http, sesiones, identidad = entorno
    # Sin duración (el selector de archivos no la sabe) y una clase de 40 min.
    for extra in ({}, {"duration_s": 2400.0}, {"duration_s": 0}):
        enviado = await _enviado(
            http,
            identidad,
            _adjunto("audio", voice_note=False, mime_type="audio/mpeg", file_name="clase.mp3", **extra),
        )
        [adjunto] = enviado["attachments"]
        assert (adjunto["kind"], adjunto["voice_note"]) == ("audio", False)
        assert tuple(await _fila_del_adjunto(sesiones, adjunto["id"])) == (None, False, "audio")
    historial = await _historial(http, identidad)
    assert [a["voice_note"] for m in historial for a in m["attachments"]] == [False, False, False]

    # Lo que sí se le exige: que sea audio, si dice su tipo.
    for tipo in ("image/png", "application/pdf"):
        respuesta = await _enviar(http, identidad, _adjunto("audio", voice_note=False, mime_type=tipo))
        assert respuesta.status_code == 422
        assert codigo(respuesta) == "voice_note_bad_type"
    for tipo in ("audio/mp4", "audio/x-m4a", "audio/aac", "audio/ogg", "audio/wav", "AUDIO/MPEG"):
        assert (
            await _enviar(http, identidad, _adjunto("audio", voice_note=False, mime_type=tipo))
        ).status_code == 201, tipo


@pytest.mark.asyncio
async def test_voice_note_solo_significa_algo_en_un_audio(entorno):
    http, sesiones, identidad = entorno
    enviado = await _enviado(
        http,
        identidad,
        _adjunto("document", voice_note=True),
        _adjunto("video", voice_note=True),
        _adjunto("image"),
    )
    assert [a["voice_note"] for a in enviado["attachments"]] == [False, False, False]
    for adjunto in enviado["attachments"]:
        assert (await _fila_del_adjunto(sesiones, adjunto["id"])).voice_note is False


@pytest.mark.asyncio
async def test_el_nombre_se_recorta_vacio_es_sin_nombre_y_en_una_foto_no_existe(entorno):
    http, sesiones, identidad = entorno
    enviado = await _enviado(
        http,
        identidad,
        _adjunto("audio", title="  Respiración 4-7-8 \n"),
        _adjunto("document", title="   "),
        _adjunto("video", title=""),
        _adjunto("image", title="Una foto con nombre"),
        _adjunto("audio", voice_note=False, title="Clase  3"),
    )
    titulos = [a["title"] for a in enviado["attachments"]]
    # Solo los extremos: lo de dentro es de quien lo escribe.
    assert titulos == ["Respiración 4-7-8", None, None, None, "Clase  3"]
    for adjunto, titulo in zip(enviado["attachments"], titulos, strict=True):
        assert (await _fila_del_adjunto(sesiones, adjunto["id"])).title == titulo
    [mensaje] = await _historial(http, identidad)
    assert [a["title"] for a in mensaje["attachments"]] == titulos


@pytest.mark.asyncio
async def test_un_nombre_de_mas_de_80_no_manda_nada(entorno):
    http, sesiones, identidad = entorno
    # 80 caracteres, también con acentos (cuentan caracteres, no bytes), y con
    # espacios de sobra en los extremos.
    for titulo in ("a" * 80, "ñ" * 80, "  " + "b" * 80 + "  "):
        enviado = await _enviado(http, identidad, _adjunto("document", title=titulo))
        assert enviado["attachments"][0]["title"] == titulo.strip()

    async with sesiones() as db:
        antes = await db.scalar(select(func.count()).select_from(Message))
    for adjuntos in (
        [_adjunto("document", title="c" * 81)],
        [_adjunto("image"), _adjunto("audio", title="ñ" * 81)],
        [_adjunto("audio", voice_note=False, title="x" * 500)],
    ):
        respuesta = await _enviar(http, identidad, *adjuntos)
        assert respuesta.status_code == 422, respuesta.text
        assert codigo(respuesta) == "attachment_title_too_long"
    # En una foto se ignora, por largo que sea.
    assert (await _enviar(http, identidad, _adjunto("image", title="d" * 300))).status_code == 201
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(Message)) == antes + 1


@pytest.mark.asyncio
async def test_la_base_de_las_pruebas_tambien_rechaza_un_nombre_vacio_o_largo(entorno):
    """El `CHECK` repetido en el modelo: lo que producción rechaza, aquí también."""
    _, sesiones, _ = entorno
    mid = await _escrito(sesiones)
    for titulo in ("", "z" * 81):
        async with sesiones() as db:
            with pytest.raises(IntegrityError):
                await db.execute(
                    insert(MessageAttachment.__table__).values(
                        id=str(uuid4()),
                        message_id=mid,
                        conversation_id=GRUPO,
                        storage_path=f"{GRUPO}/{ANA}/x",
                        kind="document",
                        title=titulo,
                    )
                )
                await db.commit()


# =========================================================================== #
# 2. Ponerle nombre después: PATCH
# =========================================================================== #
@pytest.mark.asyncio
async def test_lo_nombran_quien_lo_envio_y_quien_administra(entorno):
    http, sesiones, identidad = entorno
    enviado = await _enviado(http, identidad, _adjunto("audio", de=BRUNO), de=BRUNO)
    mid, aid = enviado["id"], enviado["attachments"][0]["id"]

    suyo = await _nombrar(http, identidad, mid, aid, "  Meditación de la mañana ", quien=BRUNO)
    assert suyo.status_code == 200, suyo.text
    assert suyo.json() == {**enviado["attachments"][0], "title": "Meditación de la mañana"}
    [en_el_chat] = (await _historial(http, identidad, CARLA))[-1]["attachments"]
    assert en_el_chat["title"] == "Meditación de la mañana"

    # Ana administra el grupo: puede cambiarlo aunque no sea suyo.
    de_quien_administra = await _nombrar(http, identidad, mid, aid, "Respiración", quien=ANA)
    assert de_quien_administra.status_code == 200
    assert (await _fila_del_adjunto(sesiones, aid)).title == "Respiración"

    # `null`, vacío y espacios lo quitan.
    for vacio in (None, "", "   "):
        await _nombrar(http, identidad, mid, aid, "Otra vez", quien=BRUNO)
        quitado = await _nombrar(http, identidad, mid, aid, vacio, quien=BRUNO)
        assert quitado.status_code == 200
        assert quitado.json()["title"] is None
        assert (await _fila_del_adjunto(sesiones, aid)).title is None


@pytest.mark.asyncio
async def test_otro_miembro_y_quien_no_esta_no_pueden(entorno):
    http, sesiones, identidad = entorno
    enviado = await _enviado(http, identidad, _adjunto("document", de=BRUNO, title="Temario"), de=BRUNO)
    mid, aid = enviado["id"], enviado["attachments"][0]["id"]

    carla = await _nombrar(http, identidad, mid, aid, "Mío", quien=CARLA)
    assert carla.status_code == 403
    assert codigo(carla) == "attachment_title_forbidden"
    david = await _nombrar(http, identidad, mid, aid, "Mío", quien=DAVID)
    assert david.status_code == 403
    assert codigo(david) == "forbidden"
    # Ni aunque el id no exista: quien no está no averigua nada.
    assert (await _nombrar(http, identidad, mid, str(uuid4()), "x", quien=DAVID)).status_code == 403
    assert (await _fila_del_adjunto(sesiones, aid)).title == "Temario"

    # En un chat de dos no hay quien administre: solo quien lo envió.
    directo = await _enviado(http, identidad, _adjunto("audio", de=BRUNO, en=DIRECTO), de=BRUNO, en=DIRECTO)
    otro = await _nombrar(
        http, identidad, directo["id"], directo["attachments"][0]["id"], "x", quien=ANA, en=DIRECTO
    )
    assert otro.status_code == 403
    assert codigo(otro) == "attachment_title_forbidden"


@pytest.mark.asyncio
async def test_la_moderacion_tambien_puede_como_al_borrar(entorno):
    http, sesiones, identidad = entorno
    enviado = await _enviado(http, identidad, _adjunto("video", de=BRUNO), de=BRUNO)
    async with sesiones() as db:
        await db.execute(update(Profile).where(Profile.id == CARLA).values(role="moderator"))
        await db.commit()
    respuesta = await _nombrar(
        http, identidad, enviado["id"], enviado["attachments"][0]["id"], "Revisado", quien=CARLA
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["title"] == "Revisado"


@pytest.mark.asyncio
async def test_una_foto_no_lleva_nombre_y_mas_de_80_no_cabe(entorno):
    http, sesiones, identidad = entorno
    enviado = await _enviado(http, identidad, _adjunto("image"), _adjunto("document"))
    foto, documento = (a["id"] for a in enviado["attachments"])
    for titulo in ("Una foto", None):
        respuesta = await _nombrar(http, identidad, enviado["id"], foto, titulo)
        assert respuesta.status_code == 422
        assert codigo(respuesta) == "attachment_title_not_allowed"
    largo = await _nombrar(http, identidad, enviado["id"], documento, "e" * 81)
    assert largo.status_code == 422
    assert codigo(largo) == "attachment_title_too_long"
    justo = await _nombrar(http, identidad, enviado["id"], documento, " " + "e" * 80 + " ")
    assert justo.status_code == 200
    assert justo.json()["title"] == "e" * 80
    # Sin `title` en el cuerpo no se borra nada por accidente.
    identidad["uid"] = ANA
    vacio = await http.patch(f"{API}/{GRUPO}/messages/{enviado['id']}/attachments/{documento}", json={})
    assert vacio.status_code == 422
    assert (await _fila_del_adjunto(sesiones, documento)).title == "e" * 80


@pytest.mark.asyncio
async def test_el_adjunto_tiene_que_ser_de_ese_mensaje_de_esta_conversacion_y_vivo(entorno):
    http, sesiones, identidad = entorno
    uno = await _enviado(http, identidad, _adjunto("document"))
    otro = await _enviado(http, identidad, _adjunto("document"))
    fuera = await _enviado(http, identidad, _adjunto("document", de=BRUNO, en=OTRO_GRUPO), de=BRUNO, en=OTRO_GRUPO)
    borrado = await _enviado(http, identidad, _adjunto("document"))
    identidad["uid"] = ANA
    assert (await http.delete(f"{API}/{GRUPO}/messages/{borrado['id']}")).status_code == 204

    casos = [
        (uno["id"], otro["attachments"][0]["id"]),  # de otro mensaje
        (fuera["id"], fuera["attachments"][0]["id"]),  # de otra conversación, por esta ruta
        (uno["id"], str(uuid4())),  # no existe
        (borrado["id"], borrado["attachments"][0]["id"]),  # el mensaje se borró
        ("no-es-un-id", uno["attachments"][0]["id"]),
        (uno["id"], "tampoco"),
    ]
    for mid, aid in casos:
        respuesta = await _nombrar(http, identidad, mid, aid, "x")
        assert respuesta.status_code == 404, (mid, aid, respuesta.text)
        assert codigo(respuesta) == "attachment_not_found"
    assert (await _fila_del_adjunto(sesiones, fuera["attachments"][0]["id"])).title is None


# =========================================================================== #
# 3. En qué temas está cada mensaje (`MessageRead.topics`)
# =========================================================================== #
@pytest.mark.asyncio
async def test_cada_mensaje_dice_en_que_temas_esta_y_en_su_orden(entorno):
    http, sesiones, identidad = entorno
    meditaciones = await _tema(http, identidad, "Meditaciones")
    clases = await _tema(http, identidad, "Clases")
    eliminado = await _tema(http, identidad, "Viejo")
    en_uno = await _escrito(sesiones, kind="audio", minuto=1)
    en_dos = await _escrito(sesiones, kind="audio", minuto=2)
    en_ninguno = await _escrito(sesiones, texto="Hola", minuto=3)
    solo_en_el_eliminado = await _escrito(sesiones, kind="document", minuto=4)
    borrado = await _escrito(sesiones, kind="audio", minuto=5)
    await _al_tema(http, identidad, meditaciones, en_uno, borrado)
    # Se añade primero a «Clases», pero sale en el orden de la lista de temas.
    await _al_tema(http, identidad, clases, en_dos)
    await _al_tema(http, identidad, meditaciones, en_dos)
    await _al_tema(http, identidad, eliminado, solo_en_el_eliminado, en_uno)
    identidad["uid"] = ANA
    assert (await http.delete(f"{API}/{GRUPO}/topics/{eliminado}")).status_code == 204
    assert (await http.delete(f"{API}/{GRUPO}/messages/{borrado}")).status_code == 204

    for quien in (ANA, CARLA):  # la ven todos los miembros
        mensajes = _por_id(await _historial(http, identidad, quien))
        assert mensajes[en_uno]["topics"] == [{"id": meditaciones, "name": "Meditaciones"}]
        assert mensajes[en_dos]["topics"] == [
            {"id": meditaciones, "name": "Meditaciones"},
            {"id": clases, "name": "Clases"},
        ]
        assert mensajes[en_ninguno]["topics"] == []
        assert mensajes[solo_en_el_eliminado]["topics"] == []
        # Una lápida no lleva etiqueta, como no lleva adjuntos.
        assert mensajes[borrado]["topics"] == []


@pytest.mark.asyncio
async def test_el_tema_de_otra_comunidad_no_se_cuela(entorno):
    """Aunque una fila apuntara mal (de otro grupo hacia un mensaje de este),
    la etiqueta no sale: el grupo va en el WHERE del tema, de la referencia y
    del mensaje."""
    http, sesiones, identidad = entorno
    de_bruno = await _tema(http, identidad, "De Bruno", en=OTRO_GRUPO, quien=BRUNO)
    mio = await _tema(http, identidad, "Mío")
    mid = await _escrito(sesiones, kind="audio", minuto=1)
    await _al_tema(http, identidad, mio, mid)
    async with sesiones() as db:
        await db.execute(
            insert(ConversationTopicItem.__table__).values(
                topic_id=de_bruno, message_id=mid, conversation_id=OTRO_GRUPO
            )
        )
        await db.execute(
            insert(ConversationTopicItem.__table__).values(
                topic_id=de_bruno,
                message_id=await _escrito(sesiones, en=OTRO_GRUPO, de=BRUNO),
                conversation_id=GRUPO,
            )
        )
        await db.commit()
    [mensaje] = await _historial(http, identidad)
    assert mensaje["topics"] == [{"id": mio, "name": "Mío"}]
    identidad["uid"] = CARLA
    respuesta = await http.get(f"{API}/{GRUPO}/topics/of-messages", params={"ids": mid})
    assert respuesta.json() == {mid: [{"id": mio, "name": "Mío"}]}


@pytest.mark.asyncio
async def test_en_contenido_y_dentro_de_un_tema_tambien(entorno):
    http, sesiones, identidad = entorno
    uno = await _tema(http, identidad, "Uno")
    dos = await _tema(http, identidad, "Dos")
    mid = await _escrito(sesiones, kind="audio", titulo="Respiración", minuto=1)
    await _al_tema(http, identidad, uno, mid)
    await _al_tema(http, identidad, dos, mid)
    esperados = [{"id": uno, "name": "Uno"}, {"id": dos, "name": "Dos"}]

    identidad["uid"] = CARLA
    vista = (await http.get(f"{API}/{GRUPO}/views/messages", params={"category": "audio"})).json()
    [item] = vista["items"]
    assert item["topics"] == esperados
    assert item["attachments"][0]["title"] == "Respiración"
    assert item["attachments"][0]["voice_note"] is True

    pagina = (await http.get(f"{API}/{GRUPO}/topics/{uno}/messages")).json()
    [item] = pagina["items"]
    assert (item["id"], item["topics"]) == (mid, esperados)
    assert item["attachments"][0]["title"] == "Respiración"


@pytest.mark.asyncio
async def test_en_un_chat_de_dos_no_se_pregunta_por_temas(entorno):
    http, sesiones, identidad = entorno
    for minuto in range(3):
        await _escrito(sesiones, en=DIRECTO, texto=f"hola {minuto}", minuto=minuto)
    assert (await _historial(http, identidad, en=DIRECTO))[0]["topics"] == []

    nombradas: list[str] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        if "conversation_topic" in statement:
            nombradas.append(statement)

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    try:
        mensajes = await _historial(http, identidad, en=DIRECTO)
    finally:
        event.remove(motor, "before_cursor_execute", _anotar)
    assert [m["topics"] for m in mensajes] == [[], [], []]
    assert nombradas == []


@pytest.mark.asyncio
async def test_las_etiquetas_no_cuestan_una_consulta_por_mensaje(entorno):
    http, sesiones, identidad = entorno
    tema = await _tema(http, identidad, "Todo")
    otro = await _tema(http, identidad, "Más")

    async def _consultas_para(cuantos: int) -> int:
        ids = [await _escrito(sesiones, kind="audio", minuto=500 + i) for i in range(cuantos)]
        assert (await _lote(http, identidad, tema, ids)).status_code == 200
        assert (await _lote(http, identidad, otro, ids)).status_code == 200
        await _historial(http, identidad, limit=cuantos)  # el esquema ya se miró
        sentencias: list[str] = []

        def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
            if statement.lstrip().lower().startswith("select"):
                sentencias.append(statement)

        motor = sesiones.kw["bind"].sync_engine
        event.listen(motor, "before_cursor_execute", _anotar)
        try:
            mensajes = await _historial(http, identidad, limit=cuantos)
        finally:
            event.remove(motor, "before_cursor_execute", _anotar)
        assert all(len(m["topics"]) == 2 for m in mensajes[-cuantos:])
        return len(sentencias)

    assert await _consultas_para(2) == await _consultas_para(30)


# =========================================================================== #
# 4. Agregar varios a un tema: PUT por lotes
# =========================================================================== #
@pytest.mark.asyncio
async def test_agregar_varios_es_idempotente_y_cuenta_lo_que_ya_estaba(entorno):
    http, sesiones, identidad = entorno
    tema = await _tema(http, identidad, "Meditaciones")
    ids = [await _escrito(sesiones, kind="audio", minuto=i) for i in range(4)]

    primera = await _lote(http, identidad, tema, ids[:3])
    assert primera.status_code == 200, primera.text
    assert primera.json() == {"added": 3, "already": 0}
    async with sesiones() as db:
        fechas = dict(
            (
                await db.execute(
                    select(ConversationTopicItem.message_id, ConversationTopicItem.added_at).where(
                        ConversationTopicItem.topic_id == tema
                    )
                )
            ).all()
        )

    # Escrito en mayúsculas sigue siendo el mismo mensaje.
    segunda = await _lote(http, identidad, tema, [ids[3], ids[0].upper(), ids[1], ids[2]])
    assert segunda.json() == {"added": 1, "already": 3}
    assert await _referencias(sesiones, tema) == set(ids)
    async with sesiones() as db:
        for mid, cuando in fechas.items():
            assert (
                await db.scalar(
                    select(ConversationTopicItem.added_at).where(
                        ConversationTopicItem.topic_id == tema,
                        ConversationTopicItem.message_id == mid,
                    )
                )
            ) == cuando
    assert (await _lote(http, identidad, tema, ids)).json() == {"added": 0, "already": 4}


@pytest.mark.asyncio
async def test_agregar_varios_es_todo_o_nada(entorno):
    http, sesiones, identidad = entorno
    tema = await _tema(http, identidad, "Meditaciones")
    otro_tema = await _tema(http, identidad, "Otro")
    buenos = [await _escrito(sesiones, kind="audio", minuto=i) for i in range(2)]
    identidad["uid"] = ANA
    chat_del_otro = next(
        t["chat_id"]
        for t in (await http.get(f"{API}/{GRUPO}/topics")).json()["topics"]
        if t["id"] == otro_tema
    )
    malos = {
        "de otro grupo": await _escrito(sesiones, en=OTRO_GRUPO, de=BRUNO),
        "de un chat de dos": await _escrito(sesiones, en=DIRECTO),
        "borrado": await _escrito(sesiones, kind="audio", borrado=True),
        "del chat de un tema": await _escrito(sesiones, en=chat_del_otro),
        "inventado": str(uuid4()),
        "mal escrito": "no-es-un-id",
    }
    for caso, malo in malos.items():
        respuesta = await _lote(http, identidad, tema, [*buenos, malo])
        assert respuesta.status_code == 404, caso
        assert codigo(respuesta) == "message_not_in_group", caso
        assert await _referencias(sesiones, tema) == set(), caso


@pytest.mark.asyncio
async def test_agregar_varios_tiene_tope_y_no_admite_repetidos(entorno):
    http, sesiones, identidad = entorno
    tema = await _tema(http, identidad, "Meditaciones")
    mid = await _escrito(sesiones, kind="audio")
    for cuerpo in (
        [],
        [str(uuid4()) for _ in range(51)],
        [mid, mid],
        [mid, mid.upper()],
    ):
        respuesta = await _lote(http, identidad, tema, cuerpo)
        assert respuesta.status_code == 422, cuerpo
    assert await _referencias(sesiones, tema) == set()
    # Cincuenta justos sí.
    cincuenta = [await _escrito(sesiones, kind="audio", minuto=i) for i in range(50)]
    assert (await _lote(http, identidad, tema, cincuenta)).json() == {"added": 50, "already": 0}


@pytest.mark.asyncio
async def test_agregar_varios_solo_lo_hace_quien_administra(entorno):
    http, sesiones, identidad = entorno
    tema = await _tema(http, identidad, "Meditaciones")
    de_bruno = await _tema(http, identidad, "De Bruno", en=OTRO_GRUPO, quien=BRUNO)
    eliminado = await _tema(http, identidad, "Eliminado")
    identidad["uid"] = ANA
    assert (await http.delete(f"{API}/{GRUPO}/topics/{eliminado}")).status_code == 204
    mid = await _escrito(sesiones, kind="audio")

    carla = await _lote(http, identidad, tema, [mid], quien=CARLA)
    assert (carla.status_code, codigo(carla)) == (403, "topic_admin_only")
    david = await _lote(http, identidad, tema, [mid], quien=DAVID)
    assert david.status_code == 403
    for ajeno in (de_bruno, eliminado, NADA):
        respuesta = await _lote(http, identidad, ajeno, [mid])
        assert (respuesta.status_code, codigo(respuesta)) == (404, "topic_not_found"), ajeno
    assert await _referencias(sesiones, tema) == set()


# =========================================================================== #
# 5. Refrescar etiquetas: GET …/topics/of-messages
# =========================================================================== #
@pytest.mark.asyncio
async def test_of_messages_dice_los_temas_de_cada_uno_y_vacio_de_los_demas(entorno):
    http, sesiones, identidad = entorno
    uno = await _tema(http, identidad, "Uno")
    dos = await _tema(http, identidad, "Dos")
    en_dos = await _escrito(sesiones, kind="audio", minuto=1)
    en_uno = await _escrito(sesiones, kind="audio", minuto=2)
    en_ninguno = await _escrito(sesiones, kind="audio", minuto=3)
    de_fuera = await _escrito(sesiones, en=OTRO_GRUPO, de=BRUNO)
    await _al_tema(http, identidad, uno, en_dos, en_uno)
    await _al_tema(http, identidad, dos, en_dos)

    identidad["uid"] = BRUNO  # un miembro cualquiera
    pedidos = ",".join([en_dos, en_uno.upper(), en_ninguno, de_fuera, "basura", en_dos, ""])
    respuesta = await http.get(f"{API}/{GRUPO}/topics/of-messages", params={"ids": pedidos})
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json() == {
        en_dos: [{"id": uno, "name": "Uno"}, {"id": dos, "name": "Dos"}],
        en_uno: [{"id": uno, "name": "Uno"}],
        en_ninguno: [],
        de_fuera: [],
    }
    # Quitarlo de un tema se ve al volver a pedir: es para lo que existe.
    identidad["uid"] = ANA
    assert (await http.delete(f"{API}/{GRUPO}/topics/{uno}/items/{en_uno}")).status_code == 204
    otra = await http.get(f"{API}/{GRUPO}/topics/of-messages", params={"ids": en_uno})
    assert otra.json() == {en_uno: []}
    assert (await http.get(f"{API}/{GRUPO}/topics/of-messages")).json() == {}


@pytest.mark.asyncio
async def test_of_messages_es_solo_para_miembros_y_tiene_tope(entorno):
    http, sesiones, identidad = entorno
    tema = await _tema(http, identidad, "Uno")
    mid = await _escrito(sesiones, kind="audio")
    await _al_tema(http, identidad, tema, mid)

    identidad["uid"] = DAVID
    fuera = await http.get(f"{API}/{GRUPO}/topics/of-messages", params={"ids": mid})
    assert fuera.status_code == 403
    identidad["uid"] = ANA
    ciento_uno = ",".join(str(uuid4()) for _ in range(101))
    assert (
        await http.get(f"{API}/{GRUPO}/topics/of-messages", params={"ids": ciento_uno})
    ).status_code == 422
    cien = ",".join([mid, *(str(uuid4()) for _ in range(99))])
    respuesta = await http.get(f"{API}/{GRUPO}/topics/of-messages", params={"ids": cien})
    assert respuesta.status_code == 200
    assert respuesta.json()[mid] == [{"id": tema, "name": "Uno"}]
    # Preguntar desde otra conversación de la que es miembro no dice nada de esta.
    identidad["uid"] = BRUNO
    desde_otra = await http.get(f"{API}/{DIRECTO}/topics/of-messages", params={"ids": mid})
    assert desde_otra.json() == {mid: []}


# =========================================================================== #
# 6. Contenido: filtro por tema, «Sin tema» y sus cuentas
# =========================================================================== #
async def _vista(http, identidad, quien: str = ANA, en: str = GRUPO, **params):
    identidad["uid"] = quien
    return await http.get(f"{API}/{en}/views/messages", params=params)


async def _ids(http, identidad, **params) -> list[str]:
    respuesta = await _vista(http, identidad, **params)
    assert respuesta.status_code == 200, respuesta.text
    return [m["id"] for m in respuesta.json()["items"]]


async def _cuentas(http, identidad, quien: str = ANA, en: str = GRUPO, **params) -> dict:
    identidad["uid"] = quien
    respuesta = await http.get(f"{API}/{en}/views/topics", params=params)
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


@pytest_asyncio.fixture
async def veinte_audios(entorno):
    """El caso de la spec: audios en General, unos ordenados y otros no.

      · a0–a3 en «Meditaciones», a2 también en «Clases»;
      · a4 solo en un tema eliminado (vuelve a estar sin tema);
      · a5–a7 sin tema; d0 un documento sin tema, d1 en «Clases»;
      · un audio borrado en «Meditaciones» (no cuenta en ningún sitio).
    """
    http, sesiones, identidad = entorno
    meditaciones = await _tema(http, identidad, "Meditaciones")
    clases = await _tema(http, identidad, "Clases")
    viejo = await _tema(http, identidad, "Viejo")
    vacio = await _tema(http, identidad, "Vacío")
    a = [
        await _escrito(sesiones, kind="audio", titulo=f"Audio {i}", minuto=i)
        for i in range(8)
    ]
    d = [await _escrito(sesiones, kind="document", minuto=20 + i) for i in range(2)]
    borrado = await _escrito(sesiones, kind="audio", minuto=30)
    await _al_tema(http, identidad, meditaciones, *a[:4], borrado)
    await _al_tema(http, identidad, clases, a[2], d[1])
    await _al_tema(http, identidad, viejo, a[4])
    identidad["uid"] = ANA
    assert (await http.delete(f"{API}/{GRUPO}/topics/{viejo}")).status_code == 204
    assert (await http.delete(f"{API}/{GRUPO}/messages/{borrado}")).status_code == 204
    return {
        "http": http,
        "sesiones": sesiones,
        "identidad": identidad,
        "meditaciones": meditaciones,
        "clases": clases,
        "vacio": vacio,
        "a": a,
        "d": d,
    }


@pytest.mark.asyncio
async def test_sin_tema_trae_justo_lo_que_falta_y_su_cuenta_coincide(veinte_audios):
    v = veinte_audios
    http, identidad, a, d = v["http"], v["identidad"], v["a"], v["d"]
    sin = await _ids(http, identidad, quien=CARLA, category="audio", sin_tema="true")
    assert set(sin) == {a[4], a[5], a[6], a[7]}
    cuentas = await _cuentas(http, identidad, quien=CARLA, category="audio")
    assert cuentas == {
        "sin_tema": 4,
        "topics": [
            {"id": v["meditaciones"], "name": "Meditaciones", "count": 4},
            {"id": v["clases"], "name": "Clases", "count": 1},
        ],
    }
    # Por tema, la lista y la cuenta dicen lo mismo.
    for tema in cuentas["topics"]:
        assert len(await _ids(http, identidad, category="audio", topic_id=tema["id"])) == tema["count"]
    # Documentos: el tema solo sale si tiene algo de esa categoría.
    assert await _cuentas(http, identidad, category="document") == {
        "sin_tema": 1,
        "topics": [{"id": v["clases"], "name": "Clases", "count": 1}],
    }
    assert set(await _ids(http, identidad, category="document", sin_tema="true")) == {d[0]}
    # Sin categoría es «all».
    todo = await _cuentas(http, identidad)
    assert todo["sin_tema"] == 5
    assert [t["count"] for t in todo["topics"]] == [4, 2]
    assert todo == await _cuentas(http, identidad, category="all")


@pytest.mark.asyncio
async def test_ordenar_tres_los_saca_de_sin_tema(veinte_audios):
    v = veinte_audios
    http, identidad, a = v["http"], v["identidad"], v["a"]
    agregados = await _lote(http, identidad, v["clases"], [a[5], a[6], a[7]])
    assert agregados.json() == {"added": 3, "already": 0}
    assert await _ids(http, identidad, category="audio", sin_tema="true") == [a[4]]
    cuentas = await _cuentas(http, identidad, category="audio")
    assert cuentas["sin_tema"] == 1
    assert [(t["name"], t["count"]) for t in cuentas["topics"]] == [("Meditaciones", 4), ("Clases", 4)]


@pytest.mark.asyncio
async def test_el_filtro_por_tema_se_combina_y_valida(veinte_audios):
    v = veinte_audios
    http, identidad, a = v["http"], v["identidad"], v["a"]
    meditaciones = await _ids(http, identidad, category="audio", topic_id=v["meditaciones"])
    assert meditaciones == [a[3], a[2], a[1], a[0]]  # lo más reciente primero
    assert await _ids(http, identidad, category="document", topic_id=v["meditaciones"]) == []
    assert await _ids(http, identidad, category="audio", topic_id=v["vacio"]) == []
    # Paginar con el filtro no repite ni se salta nada.
    primera = (await _vista(http, identidad, category="audio", topic_id=v["meditaciones"], limit=2)).json()
    segunda = await _ids(
        http,
        identidad,
        category="audio",
        topic_id=v["meditaciones"],
        limit=2,
        before=primera["next_before"],
        before_id=primera["next_before_id"],
    )
    assert [m["id"] for m in primera["items"]] + segunda == meditaciones

    conflicto = await _vista(
        http, identidad, category="audio", topic_id=v["meditaciones"], sin_tema="true"
    )
    assert (conflicto.status_code, codigo(conflicto)) == (422, "views_topic_conflict")
    de_bruno = await _tema(http, identidad, "De Bruno", en=OTRO_GRUPO, quien=BRUNO)
    for ajeno in (de_bruno, NADA, "no-es-un-id"):
        respuesta = await _vista(http, identidad, category="audio", topic_id=ajeno)
        assert (respuesta.status_code, codigo(respuesta)) == (404, "topic_not_found"), ajeno
    # En un chat de dos no hay temas: un tema no existe y «sin tema» es todo.
    directo = await _escrito(v["sesiones"], en=DIRECTO, kind="audio")
    fuera = await _vista(http, identidad, en=DIRECTO, category="audio", topic_id=v["meditaciones"])
    assert (fuera.status_code, codigo(fuera)) == (404, "topic_not_found")
    assert await _ids(http, identidad, en=DIRECTO, category="audio", sin_tema="true") == [directo]
    assert await _cuentas(http, identidad, en=DIRECTO, category="audio") == {"sin_tema": 1, "topics": []}


@pytest.mark.asyncio
async def test_las_cuentas_respetan_el_chat_vaciado(veinte_audios):
    v = veinte_audios
    http, sesiones, identidad, a = v["http"], v["sesiones"], v["identidad"], v["a"]
    # Carla vació el chat después del minuto 2: a0, a1 y a2 ya no son suyos.
    async with sesiones() as db:
        db.add(
            ConversationPreference(
                conversation_id=GRUPO, user_id=CARLA, cleared_at=BASE + timedelta(minutes=2, seconds=30)
            )
        )
        await db.commit()
    cuentas = await _cuentas(http, identidad, quien=CARLA, category="audio")
    assert cuentas == {
        "sin_tema": 4,
        "topics": [{"id": v["meditaciones"], "name": "Meditaciones", "count": 1}],
    }
    assert await _ids(http, identidad, quien=CARLA, category="audio", topic_id=v["meditaciones"]) == [a[3]]
    assert await _ids(http, identidad, quien=CARLA, category="audio", topic_id=v["clases"]) == []
    # A Ana le sigue saliendo todo: es de Carla.
    assert (await _cuentas(http, identidad, quien=ANA, category="audio"))["topics"][0]["count"] == 4


@pytest.mark.asyncio
async def test_las_cuentas_son_solo_para_miembros_y_validan_la_categoria(veinte_audios):
    v = veinte_audios
    http, identidad = v["http"], v["identidad"]
    identidad["uid"] = DAVID
    assert (await http.get(f"{API}/{GRUPO}/views/topics", params={"category": "audio"})).status_code == 403
    identidad["uid"] = ANA
    mala = await http.get(f"{API}/{GRUPO}/views/topics", params={"category": "musica"})
    assert (mala.status_code, codigo(mala)) == (422, "view_category_invalid")


@pytest.mark.asyncio
async def test_buscar_en_contenido_encuentra_por_el_nombre(entorno):
    http, sesiones, identidad = entorno
    respiracion = await _escrito(sesiones, kind="audio", titulo="Respiración 4-7-8", minuto=1)
    await _escrito(sesiones, kind="audio", titulo="Otra cosa", minuto=2)
    temario = await _escrito(sesiones, kind="document", titulo="Temario 100%", minuto=3)
    assert await _ids(http, identidad, category="audio", q="respiración") == [respiracion]
    assert await _ids(http, identidad, category="all", q="4-7-8") == [respiracion]
    # Los comodines no muerden.
    assert await _ids(http, identidad, category="all", q="100%") == [temario]
    assert await _ids(http, identidad, category="all", q="%") == [temario]


# =========================================================================== #
# 7. Vistas previas
# =========================================================================== #
async def _bandeja(http, identidad, quien: str = ANA) -> dict[str, dict]:
    identidad["uid"] = quien
    respuesta = await http.get(API)
    assert respuesta.status_code == 200, respuesta.text
    return {fila["id"]: fila for fila in respuesta.json()}


@pytest.mark.asyncio
async def test_la_bandeja_dice_nota_de_voz_y_con_nombre_el_nombre(entorno):
    http, sesiones, identidad = entorno
    # Con minutos distintos: en SQLite `now()` tiene resolución de segundo, y
    # dos mensajes del mismo segundo no tienen «último» fijo.
    casos = [
        ({"kind": "audio"}, "Nota de voz"),
        # Un archivo de audio sin nombre no es una nota de voz.
        ({"kind": "audio", "nota": False}, "Audio"),
        ({"kind": "audio", "titulo": "Respiración"}, "Respiración"),
        ({"kind": "audio", "nota": False, "titulo": "Clase 3"}, "Clase 3"),
        # Con texto, lo que escribió (como siempre).
        ({"kind": "document", "titulo": "Temario", "texto": "Te paso el temario"}, "Te paso el temario"),
        ({"kind": "document"}, "Archivo"),
        ({"kind": "video", "titulo": "Clase grabada"}, "Clase grabada"),
        ({"kind": "image"}, "Foto"),
    ]
    for minuto, (mensaje, esperado) in enumerate(casos):
        await _escrito(sesiones, de=BRUNO, en=DIRECTO, minuto=minuto, **mensaje)
        assert (await _bandeja(http, identidad))[DIRECTO]["last_message"] == esperado, mensaje


@pytest.mark.asyncio
async def test_la_lista_de_la_comunidad_y_la_de_temas_usan_el_nombre(entorno):
    http, sesiones, identidad = entorno
    identidad["uid"] = ANA
    creada = await http.post(f"{API}/{GRUPO}/subgroups", json={"title": "Valorant"})
    assert creada.status_code == 201, creada.text
    sub = creada.json()["id"]
    await _escrito(sesiones, en=sub, kind="audio", titulo="Estrategia", minuto=1)
    [fila] = (await http.get(f"{API}/{GRUPO}/subgroups")).json()["subgroups"]
    assert (fila["last"]["excerpt"], fila["last"]["kind"]) == ("Estrategia", "audio")
    await _escrito(sesiones, en=sub, kind="audio", minuto=2)
    [fila] = (await http.get(f"{API}/{GRUPO}/subgroups")).json()["subgroups"]
    assert fila["last"]["excerpt"] == "Nota de voz"
    await _escrito(sesiones, en=sub, kind="audio", nota=False, minuto=3)
    [fila] = (await http.get(f"{API}/{GRUPO}/subgroups")).json()["subgroups"]
    assert (fila["last"]["excerpt"], fila["last"]["kind"]) == ("Audio", "audio")

    # En la lista de temas el nombre va en `excerpt`; sin nombre, `excerpt`
    # vacío y la aplicación pone la etiqueta (traducida) según `voice_note`.
    # Un tema por caso: dos referencias añadidas en el mismo segundo (SQLite)
    # no tienen «última» fija.
    async def _ultimo(tema: str) -> tuple:
        identidad["uid"] = ANA
        temas_ = (await http.get(f"{API}/{GRUPO}/topics")).json()["topics"]
        last = next(t for t in temas_ if t["id"] == tema)["last"]
        return (last["excerpt"], last["kind"], last["voice_note"])

    for numero, (mensaje, esperado) in enumerate(
        [
            ({"kind": "audio", "titulo": "Respiración 4-7-8"}, ("Respiración 4-7-8", "audio", True)),
            ({"kind": "audio"}, ("", "audio", True)),
            ({"kind": "audio", "nota": False}, ("", "audio", False)),
            ({"kind": "audio", "nota": False, "titulo": "Clase 3"}, ("Clase 3", "audio", False)),
            ({"kind": "document"}, ("", "document", False)),
        ]
    ):
        tema = await _tema(http, identidad, f"Tema {numero}")
        mid = await _escrito(sesiones, minuto=10 + numero, **mensaje)
        await _al_tema(http, identidad, tema, mid)
        assert await _ultimo(tema) == esperado, mensaje


@pytest.mark.asyncio
async def test_la_cita_de_un_audio_con_nombre_dice_el_nombre(entorno):
    http, sesiones, identidad = entorno
    con_nombre = await _escrito(sesiones, de=BRUNO, kind="audio", titulo="Respiración", minuto=1)
    sin_nombre = await _escrito(sesiones, de=BRUNO, kind="audio", minuto=2)
    archivo = await _escrito(sesiones, de=BRUNO, kind="audio", nota=False, minuto=3)
    documento = await _escrito(sesiones, de=BRUNO, kind="document", minuto=4)
    identidad["uid"] = ANA
    for original in (con_nombre, sin_nombre, archivo, documento):
        respuesta = await http.post(
            f"{API}/{GRUPO}/messages", json={"body": "Gracias", "reply_to_id": original}
        )
        assert respuesta.status_code == 201
    citas = {
        m["reply_to"]["id"]: (
            m["reply_to"]["excerpt"],
            m["reply_to"]["kind"],
            m["reply_to"]["voice_note"],
        )
        for m in await _historial(http, identidad)
        if m["reply_to"]
    }
    # Sin nombre, `excerpt` vacío y `voice_note` dice si es «Nota de voz» o
    # «Audio»: la etiqueta la pone la aplicación, traducida.
    assert citas == {
        con_nombre: ("Respiración", "audio", True),
        sin_nombre: ("", "audio", True),
        archivo: ("", "audio", False),
        documento: ("", "document", False),
    }


@pytest.mark.asyncio
async def test_la_aplicacion_puede_preguntar_si_hay_nombres(entorno):
    """Con la 0113, `attachment_titles: true`: la aplicación ofrece ponerle nombre."""
    http, _, _ = entorno
    respuesta = await http.get(f"{API}/availability")
    assert respuesta.status_code == 200
    assert respuesta.json()["attachment_titles"] is True


# =========================================================================== #
# 8. Sin la 0113: la API desplegada antes de pegar la migración
# =========================================================================== #
def _adjuntos_de_antes(metadata: MetaData) -> Table:
    """`message_attachments` como la deja la 0112: sin `title` ni `voice_note`.

    En SQLite no se puede quitar una columna que nombra un `CHECK`, así que se
    crea la tabla sin ellas desde el principio. Sin claves ajenas: SQLite no
    las impone por defecto y la API no depende de ellas.
    """
    columnas = [
        Column(
            c.name,
            c.type,
            primary_key=c.primary_key,
            nullable=c.nullable,
            server_default=c.server_default.arg if c.server_default is not None else None,
        )
        for c in MessageAttachment.__table__.columns
        if c.name not in ("title", "voice_note")
    ]
    return Table("message_attachments", metadata, *columnas)


@pytest_asyncio.fixture
async def sin_la_0113():
    engine, sesiones, identidad = await _levantar(sin_tablas=("message_attachments",))
    metadata = MetaData()
    _adjuntos_de_antes(metadata)
    async with engine.begin() as conexion:
        await conexion.run_sync(metadata.create_all)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad
    await _recoger(engine)


async def _columnas(sesiones) -> set[str]:
    async with sesiones() as db:
        conexion = await db.connection()
        return set(
            await conexion.run_sync(
                lambda s: [c["name"] for c in inspect(s).get_columns("message_attachments")]
            )
        )


@pytest.mark.asyncio
async def test_sin_la_0113_todo_funciona_como_antes(sin_la_0113):
    http, sesiones, identidad = sin_la_0113
    assert not {"title", "voice_note"} & await _columnas(sesiones)
    # La aplicación lo pregunta antes y no ofrece nombres; lo demás, igual.
    disponible = (await http.get(f"{API}/availability")).json()
    assert disponible["attachment_titles"] is False
    assert (disponible["voice_notes"], disponible["topics"]) == (True, True)

    # Mandar: el nombre se ignora, el audio es nota de voz, y nada revienta.
    enviado = await _enviado(
        http,
        identidad,
        _adjunto("audio", title="Respiración"),
        _adjunto("document", title="Temario"),
        _adjunto("image"),
    )
    assert [(a["title"], a["voice_note"]) for a in enviado["attachments"]] == [
        (None, True),
        (None, False),
        (None, False),
    ]
    historial = await _historial(http, identidad)
    assert [(a["title"], a["voice_note"]) for a in historial[-1]["attachments"]] == [
        (None, True),
        (None, False),
        (None, False),
    ]
    # Un nombre demasiado largo es un 422 igual: la misma petición vale lo
    # mismo con o sin la migración.
    largo = await _enviar(http, identidad, _adjunto("document", title="x" * 81))
    assert codigo(largo) == "attachment_title_too_long"

    # Un archivo de audio sin la 0113 se lee como nota de voz, así que se
    # valida como nota de voz: sin duración no entra, y con ella sí.
    sin_duracion = await _enviar(http, identidad, _adjunto("audio", voice_note=False, mime_type="audio/mpeg"))
    assert codigo(sin_duracion) == "voice_note_without_duration"
    con_duracion = await _enviado(
        http, identidad, _adjunto("audio", voice_note=False, mime_type="audio/mpeg", duration_s=30)
    )
    assert con_duracion["attachments"][0]["voice_note"] is True

    # Ponerle nombre después: 503, no un 500.
    nombrar = await _nombrar(http, identidad, enviado["id"], enviado["attachments"][1]["id"], "Temario")
    assert (nombrar.status_code, codigo(nombrar)) == (503, "attachment_titles_not_available")

    # Lo demás que lee adjuntos sigue igual.
    tema = await _tema(http, identidad, "Meditaciones")
    await _al_tema(http, identidad, tema, enviado["id"])
    identidad["uid"] = CARLA
    vista = (await http.get(f"{API}/{GRUPO}/views/messages", params={"category": "all", "q": "temario"})).json()
    assert vista["items"] == []  # sin la columna no se busca por nombre, pero no falla
    vista = (await http.get(f"{API}/{GRUPO}/views/messages", params={"category": "document"})).json()
    assert vista["items"][0]["topics"] == [{"id": tema, "name": "Meditaciones"}]
    assert (await _cuentas(http, identidad, quien=CARLA, category="audio"))["sin_tema"] == 1
    [en_la_lista] = (await http.get(f"{API}/{GRUPO}/topics")).json()["topics"]
    assert (en_la_lista["last"]["excerpt"], en_la_lista["last"]["voice_note"]) == ("", True)
    pagina = (await http.get(f"{API}/{GRUPO}/topics/{tema}/messages")).json()
    assert pagina["items"][0]["attachments"][0]["title"] is None
    # Sin la 0113 todo audio es nota de voz, también el que llegó como
    # archivo: dice «Nota de voz», no «Audio».
    await _enviado(
        http,
        identidad,
        _adjunto("audio", de=BRUNO, en=DIRECTO, voice_note=False, duration_s=20, title="x"),
        de=BRUNO,
        en=DIRECTO,
    )
    assert (await _bandeja(http, identidad))[DIRECTO]["last_message"] == "Nota de voz"
    identidad["uid"] = ANA
    for original in (enviado["id"], con_duracion["id"]):
        respuesta = await http.post(
            f"{API}/{GRUPO}/messages", json={"body": "Gracias", "reply_to_id": original}
        )
        cita = respuesta.json()["reply_to"]
        assert (cita["excerpt"], cita["kind"], cita["voice_note"]) == ("", "audio", True)


@pytest.mark.asyncio
async def test_sin_la_0113_no_se_pregunta_por_ella_en_cada_peticion(sin_la_0113):
    """Averiguar que falta cuesta una lectura del catálogo por proceso (y otra
    por minuto mientras falte), no una por petición."""
    http, sesiones, identidad = sin_la_0113
    enviado = await _enviado(http, identidad, _adjunto("document"))

    async def _de_todo() -> None:
        await _enviado(http, identidad, _adjunto("audio", title="x"))
        await _historial(http, identidad)
        await _nombrar(http, identidad, enviado["id"], enviado["attachments"][0]["id"], "x")
        await _bandeja(http, identidad)

    await _de_todo()  # la primera vez sí se mira (esta y las demás migraciones)

    catalogo: list[str] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        if "pragma" in statement.lower() or "sqlite_master" in statement.lower():
            catalogo.append(statement)

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    try:
        for _ in range(3):
            await _de_todo()
    finally:
        event.remove(motor, "before_cursor_execute", _anotar)
    assert catalogo == []
    assert esquema._cache.get("message_attachments.title") is False


@pytest.mark.asyncio
async def test_pegada_con_la_api_en_marcha_se_ve_sin_reiniciar(sin_la_0113, monkeypatch):
    """Lo que hará la 0113 al pegarla (las dos columnas), con la API ya
    arrancada: en cuanto caduca el «no», la API la usa."""
    http, sesiones, identidad = sin_la_0113
    enviado = await _enviado(http, identidad, _adjunto("document"))
    aid = enviado["attachments"][0]["id"]
    assert (await _nombrar(http, identidad, enviado["id"], aid, "Temario")).status_code == 503

    async with sesiones() as db:
        conexion = await db.connection()
        await conexion.exec_driver_sql("alter table message_attachments add column title text")
        await conexion.exec_driver_sql(
            "alter table message_attachments add column voice_note boolean not null default 0"
        )
        await db.commit()
    # Todavía no: el «no» vale un minuto.
    assert (await _nombrar(http, identidad, enviado["id"], aid, "Temario")).status_code == 503
    # Pasa el minuto.
    monkeypatch.setitem(esquema._no_hasta, "message_attachments.title", 0.0)
    puesto = await _nombrar(http, identidad, enviado["id"], aid, "Temario")
    assert puesto.status_code == 200, puesto.text
    assert (await _historial(http, identidad))[-1]["attachments"][0]["title"] == "Temario"


# =========================================================================== #
# 9. La migración dice lo mismo que el modelo
# =========================================================================== #
def _sin_comentarios(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


def test_la_0113_se_pega_entera_y_dice_como_deshacerse():
    crudo = MIGRACION.read_text(encoding="utf-8")
    codigo_sql = _sin_comentarios(crudo)
    assert codigo_sql.lstrip().startswith("set local lock_timeout = '5s';")
    assert "notify pgrst, 'reload schema';" in codigo_sql
    # Lo último que se ejecuta es la comprobación que se ve en el editor.
    assert codigo_sql.rstrip().rsplit(";", 2)[-2].lstrip().startswith("select")
    assert "rollback" in crudo.lower()
    assert "drop column if exists title" in crudo and "drop column if exists voice_note" in crudo
    # Va justo después de la 0112.
    nombres = sorted(p.name for p in MIGRACION.parent.glob("*.sql"))
    assert nombres[nombres.index(MIGRACION.name) - 1] == "0112_comunidades_en_el_perfil.sql"


def test_la_0113_solo_anade_y_el_relleno_corre_una_vez():
    codigo_sql = _sin_comentarios(MIGRACION.read_text(encoding="utf-8"))
    assert "add column if not exists title text;" in codigo_sql
    assert re.search(
        r"drop constraint if exists message_attachments_title_check;\s+alter table "
        r"public\.message_attachments\s+add constraint message_attachments_title_check\s+"
        r"check \(title is null or char_length\(title\) between 1 and 80\)",
        codigo_sql,
    )
    assert not re.search(r"\b(drop table|drop column|delete from|truncate)\b", codigo_sql)
    assert "create policy" not in codigo_sql and "alter publication" not in codigo_sql
    # El relleno va DENTRO del `if not exists` de la columna: pegarla otra vez
    # no vuelve a marcar como nota de voz un archivo de audio.
    bloque = codigo_sql[codigo_sql.index("do $$") : codigo_sql.index("end\n$$;")]
    assert "column_name = 'voice_note'" in bloque
    assert "add column voice_note boolean not null default false" in bloque
    assert re.search(r"update public\.message_attachments\s+set voice_note = true\s+where kind = 'audio'", bloque)
    assert codigo_sql.count("update public.message_attachments") == 1


def test_el_modelo_dice_lo_mismo_que_la_0113():
    tabla = MessageAttachment.__table__
    assert {"title", "voice_note"} <= {c.name for c in tabla.columns}
    assert tabla.c.title.nullable and not tabla.c.voice_note.nullable
    assert "message_attachments_title_check" in {c.name for c in tabla.constraints}
    # Fuera del mapeo: el ORM no las pide nunca (ver el docstring del modelo).
    mapeadas = {p.key for p in MessageAttachment.__mapper__.column_attrs}
    assert not {"title", "voice_note"} & mapeadas
    assert "title" not in str(select(MessageAttachment.id, MessageAttachment.kind))
