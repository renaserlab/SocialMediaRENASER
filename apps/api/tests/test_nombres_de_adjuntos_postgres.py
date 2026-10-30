"""Audios y temas (0113) contra PostgreSQL de verdad.

`test_audios_y_temas.py` fija el comportamiento en SQLite. Aquí se repite lo
que SQLite no puede ver:

  · LA MIGRACIÓN, EJECUTADA sobre una base con adjuntos de antes: el relleno
    (todo audio que existía es nota de voz, y nada más), el `CHECK` del nombre
    contando caracteres y no bytes, que pegarla dos veces deja lo mismo —y en
    particular que NO vuelve a marcar como nota de voz un archivo de audio que
    la API ya escribió—, que se para si alguien abrió el UPDATE por PostgREST,
    que la vuelta atrás escrita en el fichero funciona y que si no consigue el
    bloqueo se rinde sin dejar nada.
  · LA API sobre PostgreSQL: los nombres con su `CHECK` de verdad, el
    `insert … on conflict do nothing returning` de «agregar varios» (también
    dos a la vez, que en PostgreSQL sí corren a la vez), las etiquetas, el
    filtro y las cuentas por tema con `ILIKE` y el chat vaciado.

Se omite sin `MIGRACIONES_DATABASE_URL`, como el resto de pruebas de
PostgreSQL. Borra y rehace el esquema `public`: solo contra una base
desechable (ver `exigir_url_desechable`).
"""

from __future__ import annotations

import asyncio
import os
import threading
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.messaging import esquema
from app.modules.messaging import router as messaging_router
from app.shared.database import get_db
from tests.test_comunidades_en_el_perfil_postgres import (
    _conversacion,
    _hacer,
    _montar,
    _persona,
    _todas,
    _uno,
)
from tests.test_migraciones_reales import MIGRACIONES, exigir_url_desechable
from tests.test_vistas_de_conversacion import ANA, API, BRUNO, CARLA, DAVID

ARCHIVO = MIGRACIONES / "0113_nombres_de_adjuntos.sql"
SQL = ARCHIVO.read_text(encoding="utf-8")
URL = os.environ.get("MIGRACIONES_DATABASE_URL", "").strip()
SIN_POSTGRES = pytest.mark.skipif(
    not URL,
    reason=(
        "sin PostgreSQL desechable: define MIGRACIONES_DATABASE_URL "
        "(ver la cabecera de tests/test_migraciones_reales.py)"
    ),
)
BASE = datetime(2026, 10, 1, 12, 0, 0, tzinfo=timezone.utc)


# =========================================================================== #
# Ayudantes
# =========================================================================== #
def _vuelta_atras() -> str:
    """El SQL de la vuelta atrás, TAL COMO ESTÁ ESCRITO en el fichero."""
    bloque = SQL[SQL.index("-- VUELTA ATRÁS") :]
    return "\n".join(
        linea[len("--   ") :] for linea in bloque.splitlines() if linea.startswith("--   ")
    )


def _mensaje_pg(pg, conv: str, de: str, *kinds: str) -> tuple[str, list[str]]:
    """Un mensaje con adjuntos escrito como lo dejaba la API de antes de la 0113."""
    mid = _uno(
        pg,
        "insert into public.messages (conversation_id, sender_id, body) values (%s, %s, '') "
        "returning id::text",
        conv, de,
    )
    adjuntos = [
        _uno(
            pg,
            "insert into public.message_attachments (message_id, conversation_id, storage_path, "
            "kind, sort_order) values (%s, %s, %s, %s, %s) returning id::text",
            mid, conv, f"{conv}/{de}/{uuid4()}", kind, posicion,
        )
        for posicion, kind in enumerate(kinds)
    ]
    return mid, adjuntos


_COLUMNAS = "('title', 'voice_note')"


def _foto(pg) -> list:
    """Todo lo que la 0113 crea o rellena, para comparar antes y después."""
    return [
        _todas(
            pg,
            "select column_name, column_default, is_nullable, data_type "
            "from information_schema.columns where table_schema = 'public' "
            f"and table_name = 'message_attachments' and column_name in {_COLUMNAS} order by 1",
        ),
        _todas(
            pg,
            "select conname, pg_get_constraintdef(oid) from pg_constraint "
            "where conrelid = 'public.message_attachments'::regclass order by 1",
        ),
        _todas(
            pg,
            "select policyname, cmd from pg_policies where schemaname = 'public' "
            "and tablename = 'message_attachments' order by 1",
        ),
        _todas(
            pg,
            "select id::text, kind, title, voice_note from public.message_attachments order by 1"
        )
        if _uno(
            pg,
            "select count(*) from information_schema.columns where table_schema = 'public' "
            "and table_name = 'message_attachments' and column_name = 'voice_note'",
        )
        else _todas(pg, "select id::text, kind from public.message_attachments order by 1"),
    ]


# =========================================================================== #
# La base: hasta la 0112 con adjuntos de antes, y después la 0113
# =========================================================================== #
@pytest.fixture(scope="module")
def pg():
    psycopg = pytest.importorskip("psycopg")
    if not URL:
        pytest.skip("sin PostgreSQL desechable")
    exigir_url_desechable(URL, os.environ.get("DATABASE_URL", ""))
    with psycopg.connect(URL, autocommit=True) as conexion:
        yield conexion


@pytest.fixture(scope="module")
def base(pg):
    """Adjuntos de antes de la 0113 —dos notas de voz, un documento, una foto
    y un video— y la 0113 aplicada encima."""
    _montar(pg, hasta="0112")
    for ident, nombre in ((ANA, "Ana"), (BRUNO, "Bruno"), (CARLA, "Carla"), (DAVID, "David")):
        _persona(pg, ident, nombre)
    grupo = _conversacion(pg, ANA, [ANA, BRUNO, CARLA])
    _, notas = _mensaje_pg(pg, grupo, BRUNO, "audio")
    _, otra_nota = _mensaje_pg(pg, grupo, ANA, "audio")
    _, varios = _mensaje_pg(pg, grupo, ANA, "document", "image", "video")
    _hacer(pg, SQL)
    return {"grupo": grupo, "audios": notas + otra_nota, "otros": varios}


@SIN_POSTGRES
def test_el_relleno_marca_cada_audio_como_nota_de_voz_y_nada_mas(base, pg) -> None:
    filas = dict(
        (ident, (kind, title, voz))
        for ident, kind, title, voz in _todas(
            pg,
            "select id::text, kind, title, voice_note from public.message_attachments "
            "where conversation_id = %s",
            base["grupo"],
        )
    )
    assert {filas[i] for i in base["audios"]} == {("audio", None, True)}
    assert [filas[i] for i in base["otros"]] == [
        ("document", None, False),
        ("image", None, False),
        ("video", None, False),
    ]
    columnas = _todas(
        pg,
        "select column_name, column_default, is_nullable from information_schema.columns "
        "where table_schema = 'public' and table_name = 'message_attachments' "
        f"and column_name in {_COLUMNAS} order by 1",
    )
    assert columnas == [("title", None, "YES"), ("voice_note", "false", "NO")]
    # Una fila nueva que no dice nada —lo que escribe la API anterior— es
    # «sin nombre» y no es nota de voz.
    with pg.transaction(force_rollback=True):
        nuevo = _uno(
            pg,
            "insert into public.message_attachments (message_id, conversation_id, storage_path, kind) "
            "select message_id, conversation_id, storage_path, 'document' "
            "from public.message_attachments where id = %s returning id::text",
            base["otros"][0],
        )
        assert _todas(
            pg, "select title, voice_note from public.message_attachments where id = %s", nuevo
        ) == [(None, False)]


@SIN_POSTGRES
def test_el_check_del_nombre_cuenta_caracteres(base, pg) -> None:
    import psycopg

    adjunto = base["otros"][0]
    for bueno in ("a", "ñ" * 80, "Respiración 4-7-8 🌬️"):
        with pg.transaction(force_rollback=True):
            _hacer(pg, "update public.message_attachments set title = %s where id = %s", bueno, adjunto)
    for malo in ("", "ñ" * 81, "a" * 81):
        with pytest.raises(psycopg.errors.CheckViolation):
            with pg.transaction(force_rollback=True):
                _hacer(pg, "update public.message_attachments set title = %s where id = %s", malo, adjunto)
    with pytest.raises(psycopg.errors.NotNullViolation):
        with pg.transaction(force_rollback=True):
            _hacer(pg, "update public.message_attachments set voice_note = null where id = %s", adjunto)


@SIN_POSTGRES
def test_pegarla_dos_veces_deja_lo_mismo_y_no_vuelve_a_marcar_los_archivos(base, pg) -> None:
    antes = _foto(pg)
    _hacer(pg, SQL)
    _hacer(pg, SQL)
    assert _foto(pg) == antes
    # Lo que la API escribe después: un archivo de audio (`voice_note = false`)
    # con nombre. Pegarla otra vez no lo convierte en nota de voz ni le quita
    # el nombre.
    with pg.transaction(force_rollback=True):
        archivo = base["audios"][0]
        _hacer(
            pg,
            "update public.message_attachments set voice_note = false, title = 'Clase 3' where id = %s",
            archivo,
        )
        _hacer(pg, SQL)
        assert _todas(
            pg, "select title, voice_note from public.message_attachments where id = %s", archivo
        ) == [("Clase 3", False)]


@SIN_POSTGRES
def test_si_alguien_abrio_el_update_por_postgrest_se_para(base, pg) -> None:
    import psycopg

    with pg.transaction(force_rollback=True):
        _hacer(
            pg,
            "create policy renombrar_a_mano on public.message_attachments for update using (true)",
        )
        with pytest.raises(psycopg.errors.RaiseException, match="UPDATE"):
            with pg.transaction():
                _hacer(pg, SQL)
    assert _uno(
        pg,
        "select count(*) from pg_policies where schemaname = 'public' "
        "and tablename = 'message_attachments' and cmd in ('UPDATE', 'ALL')",
    ) == 0


@SIN_POSTGRES
def test_la_vuelta_atras_escrita_funciona_y_si_no_hay_bloqueo_se_rinde(base, pg) -> None:
    """Primero la vuelta atrás del fichero; después, con `message_attachments`
    leída por otra sesión, la migración no se queda esperando (y con ella
    cada chat con adjuntos): se rinde a los 5 s y no cambia nada. Al final se
    vuelve a aplicar y el relleno deja lo mismo de antes."""
    import psycopg

    aplicada = _foto(pg)
    _hacer(pg, _vuelta_atras())
    try:
        assert _uno(
            pg,
            "select count(*) from information_schema.columns where table_schema = 'public' "
            f"and table_name = 'message_attachments' and column_name in {_COLUMNAS}",
        ) == 0
        # Los adjuntos siguen ahí, todos.
        assert _uno(pg, "select count(*) from public.message_attachments") == len(aplicada[3])
        sin_ella = _foto(pg)

        listo = threading.Event()
        soltar = threading.Event()

        def lector() -> None:
            with psycopg.connect(URL) as otra:
                otra.execute("lock table public.message_attachments in access share mode")
                listo.set()
                soltar.wait(30)
                otra.rollback()

        hilo = threading.Thread(target=lector)
        hilo.start()
        try:
            assert listo.wait(10)
            with pytest.raises(psycopg.errors.LockNotAvailable):
                with pg.transaction():
                    _hacer(pg, SQL)
        finally:
            soltar.set()
            hilo.join()
        assert _foto(pg) == sin_ella
    finally:
        _hacer(pg, SQL)
    assert _foto(pg) == aplicada


# =========================================================================== #
# La API, sobre PostgreSQL
# =========================================================================== #
@pytest_asyncio.fixture
async def entorno(base, monkeypatch):
    monkeypatch.setattr(messaging_router, "encolar_push", lambda *_a, **_k: None)
    motor = create_async_engine(URL.replace("postgresql://", "postgresql+asyncpg://", 1))
    sesiones = async_sessionmaker(motor, expire_on_commit=False)
    identidad = {"uid": ANA}

    async def _db():
        async with sesiones() as sesion:
            yield sesion

    async def _usuario() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _usuario
    app.dependency_overrides[get_optional_user] = _usuario
    esquema.olvidar()
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
            yield http, motor, identidad
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_optional_user, None)
        esquema.olvidar()
        await motor.dispose()


async def _grupo(motor, miembros=(ANA, BRUNO, CARLA), kind: str = "group") -> str:
    """Una conversación de Ana para cada prueba: la base es del módulo."""
    cid = str(uuid4())
    async with motor.begin() as c:
        await c.execute(
            text(
                "insert into public.conversations (id, kind, title, created_by) "
                "values (cast(:i as uuid), :k, 'Aula', cast(:a as uuid))"
            ),
            {"i": cid, "k": kind, "a": ANA},
        )
        for uid in miembros:
            await c.execute(
                text(
                    "insert into public.conversation_members (conversation_id, user_id) "
                    "values (cast(:i as uuid), cast(:u as uuid))"
                ),
                {"i": cid, "u": uid},
            )
    return cid


async def _escrito(
    motor, conv: str, *, de: str = ANA, kind: str | None = "audio", titulo: str | None = None,
    nota: bool = True, minuto: int = 0, texto: str = "",
) -> str:
    mid = str(uuid4())
    async with motor.begin() as c:
        await c.execute(
            text(
                "insert into public.messages (id, conversation_id, sender_id, body, created_at) "
                "values (cast(:m as uuid), cast(:c as uuid), cast(:d as uuid), :b, :t)"
            ),
            {"m": mid, "c": conv, "d": de, "b": texto, "t": BASE + timedelta(minutes=minuto)},
        )
        if kind is not None:
            await c.execute(
                text(
                    "insert into public.message_attachments (message_id, conversation_id, "
                    "storage_path, kind, title, voice_note) values (cast(:m as uuid), "
                    "cast(:c as uuid), :p, :k, :ti, :v)"
                ),
                {
                    "m": mid, "c": conv, "p": f"{conv}/{de}/{uuid4()}", "k": kind,
                    "ti": titulo, "v": nota and kind == "audio",
                },
            )
    return mid


async def _tema(http, identidad, grupo: str, nombre: str) -> str:
    identidad["uid"] = ANA
    respuesta = await http.post(f"{API}/{grupo}/topics", json={"name": nombre})
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()["id"]


def codigo(respuesta) -> str:
    return respuesta.json()["error"]["code"]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_en_postgresql_se_manda_y_se_nombra_con_el_check_de_verdad(entorno) -> None:
    http, motor, identidad = entorno
    grupo = await _grupo(motor)
    identidad["uid"] = BRUNO
    enviado = await http.post(
        f"{API}/{grupo}/messages",
        json={
            "body": "",
            "attachments": [
                {
                    "storage_path": f"{grupo}/{BRUNO}/clase.mp3",
                    "kind": "audio",
                    "voice_note": False,
                    "mime_type": "audio/mpeg",
                    "title": "  " + "ñ" * 80 + "  ",
                },
                {"storage_path": f"{grupo}/{BRUNO}/nota.m4a", "kind": "audio", "duration_s": 3},
                {"storage_path": f"{grupo}/{BRUNO}/foto.jpg", "kind": "image", "title": "x"},
            ],
        },
    )
    assert enviado.status_code == 201, enviado.text
    mid = enviado.json()["id"]
    archivo, nota, foto = enviado.json()["attachments"]
    assert (archivo["title"], archivo["voice_note"]) == ("ñ" * 80, False)
    assert (nota["title"], nota["voice_note"]) == (None, True)
    assert (foto["title"], foto["voice_note"]) == (None, False)

    # Quien lo envió, quien administra y nadie más.
    async def _nombrar(quien: str, aid: str, titulo):
        identidad["uid"] = quien
        return await http.patch(
            f"{API}/{grupo}/messages/{mid}/attachments/{aid}", json={"title": titulo}
        )

    assert (await _nombrar(BRUNO, nota["id"], "Respiración")).status_code == 200
    assert (await _nombrar(ANA, nota["id"], " Respiración 4-7-8 ")).json()["title"] == "Respiración 4-7-8"
    otra = await _nombrar(CARLA, nota["id"], "Mía")
    assert (otra.status_code, codigo(otra)) == (403, "attachment_title_forbidden")
    assert (await _nombrar(DAVID, nota["id"], "Mía")).status_code == 403
    largo = await _nombrar(BRUNO, nota["id"], "ñ" * 81)
    assert (largo.status_code, codigo(largo)) == (422, "attachment_title_too_long")
    en_foto = await _nombrar(BRUNO, foto["id"], "x")
    assert (en_foto.status_code, codigo(en_foto)) == (422, "attachment_title_not_allowed")
    assert (await _nombrar(BRUNO, archivo["id"], None)).json()["title"] is None

    identidad["uid"] = CARLA
    [mensaje] = (await http.get(f"{API}/{grupo}/messages")).json()
    assert [(a["title"], a["voice_note"]) for a in mensaje["attachments"]] == [
        (None, False),
        ("Respiración 4-7-8", True),
        (None, False),
    ]
    async with motor.connect() as c:
        filas = (
            await c.execute(
                text(
                    "select title, voice_note from public.message_attachments "
                    "where message_id = cast(:m as uuid) order by sort_order"
                ),
                {"m": mid},
            )
        ).all()
    assert [tuple(f) for f in filas] == [(None, False), ("Respiración 4-7-8", True), (None, False)]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_en_postgresql_un_nul_en_el_nombre_es_un_422_y_no_un_500(entorno) -> None:
    """PostgreSQL no admite NUL en `text`: si el nombre llegara a la base,
    asyncpg fallaría y saldría un 500 (sin cabeceras CORS). Se para antes,
    al mandar y al ponerlo después, y no se escribe nada."""
    http, motor, identidad = entorno
    grupo = await _grupo(motor)

    async def _mensajes() -> int:
        async with motor.connect() as c:
            return int(
                (
                    await c.execute(
                        text(
                            "select count(*) from public.messages "
                            "where conversation_id = cast(:g as uuid)"
                        ),
                        {"g": grupo},
                    )
                ).scalar_one()
            )

    identidad["uid"] = ANA
    for titulo in ("Clase\u00003", "\u0000", "Fin\u0000", "Clase\n3"):
        respuesta = await http.post(
            f"{API}/{grupo}/messages",
            json={
                "body": "",
                "attachments": [
                    {"storage_path": f"{grupo}/{ANA}/t.pdf", "kind": "document", "title": titulo}
                ],
            },
        )
        assert (respuesta.status_code, codigo(respuesta)) == (422, "attachment_title_invalid"), titulo
    assert await _mensajes() == 0

    mid = await _escrito(motor, grupo, kind="document", titulo="Antes")
    async with motor.connect() as c:
        aid = (
            await c.execute(
                text("select id::text from public.message_attachments where message_id = cast(:m as uuid)"),
                {"m": mid},
            )
        ).scalar_one()
    for titulo in ("Clase\u00003", "Fin\u0000"):
        respuesta = await http.patch(
            f"{API}/{grupo}/messages/{mid}/attachments/{aid}", json={"title": titulo}
        )
        assert (respuesta.status_code, codigo(respuesta)) == (422, "attachment_title_invalid"), titulo
    async with motor.connect() as c:
        assert (
            await c.execute(
                text("select title from public.message_attachments where id = cast(:a as uuid)"),
                {"a": aid},
            )
        ).scalar_one() == "Antes"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_en_postgresql_agregar_varios_es_todo_o_nada_y_aguanta_dos_a_la_vez(entorno) -> None:
    http, motor, identidad = entorno
    grupo = await _grupo(motor)
    otro = await _grupo(motor)
    tema = await _tema(http, identidad, grupo, "Meditaciones")
    ids = [await _escrito(motor, grupo, minuto=i) for i in range(4)]
    ajeno = await _escrito(motor, otro)

    identidad["uid"] = ANA
    malo = await http.put(f"{API}/{grupo}/topics/{tema}/items", json={"message_ids": [*ids, ajeno]})
    assert (malo.status_code, codigo(malo)) == (404, "message_not_in_group")

    async def _cuantas() -> int:
        async with motor.connect() as c:
            return int(
                (
                    await c.execute(
                        text(
                            "select count(*) from public.conversation_topic_items "
                            "where topic_id = cast(:t as uuid)"
                        ),
                        {"t": tema},
                    )
                ).scalar_one()
            )

    assert await _cuantas() == 0
    # Dos lotes a la vez que se solapan: cada uno cuenta los suyos, ninguno
    # falla, y no hay referencias repetidas.
    respuestas = await asyncio.gather(
        http.put(f"{API}/{grupo}/topics/{tema}/items", json={"message_ids": ids[:3]}),
        http.put(f"{API}/{grupo}/topics/{tema}/items", json={"message_ids": ids[1:]}),
    )
    assert [r.status_code for r in respuestas] == [200, 200], [r.text for r in respuestas]
    assert sum(r.json()["added"] for r in respuestas) == 4
    assert sum(r.json()["already"] for r in respuestas) == 2
    assert await _cuantas() == 4
    otra_vez = await http.put(f"{API}/{grupo}/topics/{tema}/items", json={"message_ids": ids})
    assert otra_vez.json() == {"added": 0, "already": 4}


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_en_postgresql_etiquetas_filtro_y_cuentas_dicen_lo_mismo(entorno) -> None:
    http, motor, identidad = entorno
    grupo = await _grupo(motor)
    directo = await _grupo(motor, miembros=(ANA, BRUNO), kind="direct")
    meditaciones = await _tema(http, identidad, grupo, "Meditaciones")
    clases = await _tema(http, identidad, grupo, "Clases")
    a = [await _escrito(motor, grupo, titulo=f"Respiración {i}", minuto=i) for i in range(6)]
    documento = await _escrito(motor, grupo, kind="document", titulo="Temario 100%", minuto=10)
    identidad["uid"] = ANA
    for tema, mids in ((meditaciones, a[:3]), (clases, [a[2], documento])):
        r = await http.put(f"{API}/{grupo}/topics/{tema}/items", json={"message_ids": mids})
        assert r.status_code == 200, r.text

    identidad["uid"] = CARLA
    historial = {m["id"]: m for m in (await http.get(f"{API}/{grupo}/messages")).json()}
    assert [t["name"] for t in historial[a[2]]["topics"]] == ["Meditaciones", "Clases"]
    assert historial[a[5]]["topics"] == []
    de = await http.get(f"{API}/{grupo}/topics/of-messages", params={"ids": f"{a[0]},{a[5]}"})
    assert de.json() == {a[0]: [{"id": meditaciones, "name": "Meditaciones"}], a[5]: []}

    async def _ids(**params) -> list[str]:
        r = await http.get(f"{API}/{grupo}/views/messages", params=params)
        assert r.status_code == 200, r.text
        return [m["id"] for m in r.json()["items"]]

    assert set(await _ids(category="audio", sin_tema="true")) == {a[3], a[4], a[5]}
    assert await _ids(category="audio", topic_id=meditaciones) == [a[2], a[1], a[0]]
    cuentas = (await http.get(f"{API}/{grupo}/views/topics", params={"category": "audio"})).json()
    assert cuentas == {
        "sin_tema": 3,
        "topics": [
            {"id": meditaciones, "name": "Meditaciones", "count": 3},
            {"id": clases, "name": "Clases", "count": 1},
        ],
    }
    # `ILIKE` de PostgreSQL: sin distinguir mayúsculas y con los comodines escapados.
    assert await _ids(category="all", q="RESPIRACIÓN 4") == [a[4]]
    assert await _ids(category="all", q="100%") == [documento]

    # Carla vacía el chat a mitad: lo anterior no se le cuenta.
    async with motor.begin() as c:
        await c.execute(
            text(
                "insert into public.conversation_preferences (conversation_id, user_id, cleared_at) "
                "values (cast(:c as uuid), cast(:u as uuid), :t)"
            ),
            {"c": grupo, "u": CARLA, "t": BASE + timedelta(minutes=2, seconds=30)},
        )
    vaciado = (await http.get(f"{API}/{grupo}/views/topics", params={"category": "audio"})).json()
    assert vaciado == {"sin_tema": 3, "topics": []}

    # La bandeja: el nombre en vez de «Nota de voz».
    await _escrito(motor, directo, de=BRUNO, titulo=None, minuto=1)
    identidad["uid"] = ANA
    filas = {f["id"]: f for f in (await http.get(API)).json()}
    assert filas[directo]["last_message"] == "Nota de voz"
    await _escrito(motor, directo, de=BRUNO, titulo="Para ti", minuto=2)
    filas = {f["id"]: f for f in (await http.get(API)).json()}
    assert filas[directo]["last_message"] == "Para ti"
    # Un archivo de audio sin nombre no es una nota de voz: «Audio».
    archivo = await _escrito(motor, directo, de=BRUNO, nota=False, minuto=3)
    filas = {f["id"]: f for f in (await http.get(API)).json()}
    assert filas[directo]["last_message"] == "Audio"
    respuesta = await http.post(
        f"{API}/{directo}/messages", json={"body": "Gracias", "reply_to_id": archivo}
    )
    cita = respuesta.json()["reply_to"]
    assert (cita["excerpt"], cita["kind"], cita["voice_note"]) == ("", "audio", False)
    assert (await http.get(f"{API}/availability")).json()["attachment_titles"] is True
