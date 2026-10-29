"""Las cuentas de «Enlaces» y `own`, contra PostgreSQL de verdad y con la 0111.

`test_cuentas_de_temas_y_enlaces.py` fija los valores en SQLite. Aquí se
repiten donde de verdad corren, por dos motivos que SQLite no puede ver:

  · `ILIKE` no es lo mismo en los dos. SQLite lo traduce a `lower() LIKE`
    solo con letras ASCII; PostgreSQL usa las reglas del idioma de la base.
    Para `http://`, `https://` y `www.` tienen que salir los mismos números.
  · Los ÍNDICES PARCIALES de la 0111 solo sirven si el planificador puede
    demostrar que la consulta de la API pide lo mismo que ellos guardan. Si
    alguien cambia una marca de `vistas.py`, o vuelve a mandarlas como
    parámetros, ninguna cuenta sale mal: vuelven a ser lentas, en silencio.
    Eso se comprueba aquí con el SQL que manda la API, en su plan GENÉRICO,
    que es el que acaba usando una sentencia preparada que se repite.

Se omite sin `MIGRACIONES_DATABASE_URL`, como el resto de pruebas de
PostgreSQL. En CI corre en el trabajo `migraciones`, donde una prueba omitida
tumba el trabajo. Borra y rehace el esquema `public`: solo contra una base
desechable (ver `exigir_url_desechable`).
"""

from __future__ import annotations

import os
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.messaging import esquema, vistas
from app.shared.database import get_db
from tests.test_cuentas_de_temas_y_enlaces import CASOS_DE_ENLACE
from tests.test_migraciones_reales import exigir_url_desechable
from tests.test_vistas_de_conversacion import ANA, API, BASE, BRUNO

RAIZ = Path(__file__).resolve().parents[3]
MIGRACIONES = RAIZ / "supabase" / "migrations"
PROLOGO = RAIZ / "supabase" / "tests" / "prologo_local.sql"
URL = os.environ.get("MIGRACIONES_DATABASE_URL", "").strip()

SIN_POSTGRES = pytest.mark.skipif(
    not URL,
    reason=(
        "sin PostgreSQL desechable: define MIGRACIONES_DATABASE_URL "
        "(ver la cabecera de tests/test_migraciones_reales.py)"
    ),
)


@pytest.fixture(scope="module")
def base_aplicada():
    """Prólogo y TODAS las migraciones, en blanco; y las dos personas."""
    import psycopg

    if not URL:
        pytest.skip("sin PostgreSQL desechable")
    exigir_url_desechable(URL, os.environ.get("DATABASE_URL", ""))
    with psycopg.connect(URL, autocommit=True) as conexion:
        with conexion.cursor() as cur:
            cur.execute("drop schema if exists public cascade")
            cur.execute("drop schema if exists auth cascade")
            cur.execute("drop schema if exists storage cascade")
            cur.execute("create schema public")
            cur.execute(PROLOGO.read_text(encoding="utf-8"))
        for ruta in sorted(MIGRACIONES.glob("*.sql")):
            with conexion.cursor() as cur:
                cur.execute(ruta.read_text(encoding="utf-8"))
        with conexion.cursor() as cur:
            # El disparador de la 0001 crea el perfil de cada una.
            for uid, nombre in ((ANA, "Ana"), (BRUNO, "Bruno")):
                cur.execute(
                    "insert into auth.users (id, email, raw_user_meta_data) values "
                    "(%s, %s, jsonb_build_object('full_name', %s::text, 'username', %s::text))",
                    (uid, f"{nombre.lower()}@x.test", nombre, nombre.lower()),
                )
    return True


@pytest_asyncio.fixture
async def entorno(base_aplicada):
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
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
            yield http, motor, identidad
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_optional_user, None)
        esquema.olvidar()
        await motor.dispose()


# --------------------------------------------------------------------------- #
# Ayudantes: cada prueba tiene SUS conversaciones, la base es del módulo.
# --------------------------------------------------------------------------- #
async def _conversacion(motor, *, creador: str = ANA, miembros=(ANA, BRUNO)) -> str:
    cid = str(uuid4())
    async with motor.begin() as c:
        await c.execute(
            text(
                "insert into public.conversations (id, kind, title, created_by) "
                "values (cast(:i as uuid), 'group', 'Aula', cast(:c as uuid))"
            ),
            {"i": cid, "c": creador},
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


async def _tema(motor, grupo: str, nombre: str) -> tuple[str, str]:
    """(topic_id, chat_id): el tema y su chat propio, con los miembros del grupo."""
    chat = await _conversacion(motor)
    tid = str(uuid4())
    async with motor.begin() as c:
        await c.execute(
            text(
                "insert into public.conversation_topics "
                "(id, conversation_id, chat_id, nombre, nombre_normalizado, created_by) values "
                "(cast(:t as uuid), cast(:g as uuid), cast(:c as uuid), cast(:n as text), "
                "lower(cast(:n as text)), cast(:a as uuid))"
            ),
            {"t": tid, "g": grupo, "c": chat, "n": nombre, "a": ANA},
        )
    return tid, chat


async def _mensaje(
    motor, conv: str, texto: str, segundos: int, *, de: str = ANA, borrado: bool = False
) -> str:
    mid = str(uuid4())
    cuando = BASE + timedelta(seconds=segundos)
    async with motor.begin() as c:
        await c.execute(
            text(
                "insert into public.messages "
                "(id, conversation_id, sender_id, body, created_at, deleted_at) values "
                "(cast(:i as uuid), cast(:c as uuid), cast(:s as uuid), :b, :t, :d)"
            ),
            {"i": mid, "c": conv, "s": de, "b": texto, "t": cuando, "d": cuando if borrado else None},
        )
    return mid


async def _cuenta_de_enlaces(http, conv: str) -> int:
    respuesta = await http.get(f"{API}/{conv}/views")
    assert respuesta.status_code == 200, respuesta.text
    return {c["key"]: c["count"] for c in respuesta.json()["categories"]}["link"]


async def _pestana_de_enlaces(http, conv: str) -> list[str]:
    ids: list[str] = []
    cursor: dict = {}
    while True:
        respuesta = await http.get(
            f"{API}/{conv}/views/messages", params={"category": "link", "limit": 60, **cursor}
        )
        assert respuesta.status_code == 200, respuesta.text
        cuerpo = respuesta.json()
        ids += [m["id"] for m in cuerpo["items"]]
        if not cuerpo["next_before"]:
            return ids
        cursor = {"before": cuerpo["next_before"], "before_id": cuerpo["next_before_id"]}


async def _own(http, grupo: str) -> dict[str, int]:
    respuesta = await http.get(f"{API}/{grupo}/topics")
    assert respuesta.status_code == 200, respuesta.text
    return {t["id"]: t["own"] for t in respuesta.json()["topics"]}


# --------------------------------------------------------------------------- #
# Los valores
# --------------------------------------------------------------------------- #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_en_postgresql_cuenta_como_enlace_lo_mismo_que_en_sqlite(entorno):
    http, motor, _ = entorno
    grupo = await _conversacion(motor)
    texto_de: dict[str, str] = {}
    esperados: set[str] = set()
    for segundo, (texto, es_enlace) in enumerate(CASOS_DE_ENLACE):
        mid = await _mensaje(motor, grupo, texto, segundo)
        texto_de[mid] = texto
        if es_enlace:
            esperados.add(mid)

    pestana = set(await _pestana_de_enlaces(http, grupo))
    sobran = sorted(texto_de[m] for m in pestana - esperados)
    faltan = sorted(texto_de[m] for m in esperados - pestana)
    assert not sobran and not faltan, f"sobran {sobran}, faltan {faltan}"
    assert await _cuenta_de_enlaces(http, grupo) == len(esperados) == 11


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_en_postgresql_la_cuenta_de_enlaces_es_exacta_y_sin_tope(entorno):
    http, motor, identidad = entorno
    grupo = await _conversacion(motor)
    otro = await _conversacion(motor, creador=BRUNO)
    for i in range(150):
        await _mensaje(motor, grupo, f"material {i}: HTTPS://renaser.pe/{i}", i)
    for i in range(20):
        await _mensaje(motor, grupo, f"gracias {i}", 500 + i, de=BRUNO)
    for i in range(3):
        await _mensaje(motor, grupo, f"borrado {i} www.x.example", 600 + i, borrado=True)
    await _mensaje(motor, otro, "http://otro-grupo.example", 700, de=BRUNO)

    assert await _cuenta_de_enlaces(http, grupo) == 150
    assert len(set(await _pestana_de_enlaces(http, grupo))) == 150

    # Ana vacía el chat en el segundo 99: lo de ese instante no se le cuenta
    # (`>` estricto), así que le quedan los segundos 100 a 149.
    async with motor.begin() as c:
        await c.execute(
            text(
                "insert into public.conversation_preferences (conversation_id, user_id, cleared_at) "
                "values (cast(:c as uuid), cast(:u as uuid), :t)"
            ),
            {"c": grupo, "u": ANA, "t": BASE + timedelta(seconds=99)},
        )
    assert await _cuenta_de_enlaces(http, grupo) == 50
    assert len(await _pestana_de_enlaces(http, grupo)) == 50
    identidad["uid"] = BRUNO
    assert await _cuenta_de_enlaces(http, grupo) == 150


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_en_postgresql_own_es_exacto_y_sin_tope(entorno):
    http, motor, _ = entorno
    grupo = await _conversacion(motor)
    anuncios, chat = await _tema(motor, grupo, "Anuncios")
    vacio, _ = await _tema(motor, grupo, "Vacío")
    for i in range(150):
        await _mensaje(motor, chat, f"Aviso {i}", i)
    for i in range(5):
        await _mensaje(motor, chat, f"Borrado {i}", 200 + i, borrado=True)
    # Lo de General no es «propio» de ningún tema.
    for i in range(7):
        await _mensaje(motor, grupo, f"General {i}", 300 + i)

    assert await _own(http, grupo) == {anuncios: 150, vacio: 0}


# --------------------------------------------------------------------------- #
# Los índices: que el planificador pueda usarlos con el SQL que manda la API
# --------------------------------------------------------------------------- #
def _plan_generico(sql: str, parametros) -> str:
    """El plan GENÉRICO de una sentencia tal como la mandó asyncpg.

    Es el que acaba usando una sentencia preparada que se repite, y el único en
    que el planificador no ve los valores de los parámetros: si aquí sale el
    índice parcial, sale siempre. Sin recorrido secuencial, para que el
    tamaño de esta base de pruebas no decida por él.
    """
    import psycopg
    from psycopg import sql as psql

    with psycopg.connect(URL, autocommit=True) as conexion, conexion.cursor() as cur:
        cur.execute("set enable_seqscan = off")
        cur.execute("set plan_cache_mode = force_generic_plan")
        cur.execute("prepare consulta as " + sql)
        argumentos = psql.SQL(", ").join(psql.Literal(str(p)) for p in parametros)
        cur.execute(psql.SQL("explain (costs off) execute consulta({})").format(argumentos))
        return "\n".join(fila[0] for fila in cur.fetchall())


def _vacuum_analyze() -> None:
    import psycopg

    with psycopg.connect(URL, autocommit=True) as conexion:
        conexion.execute("vacuum analyze public.messages")


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_las_dos_cuentas_las_contestan_los_indices_de_la_0111(entorno):
    http, motor, _ = entorno
    grupo = await _conversacion(motor)
    _, chat = await _tema(motor, grupo, "Anuncios")
    for i in range(40):
        await _mensaje(motor, grupo, f"mensaje {i}" + (" https://x.example" if i % 4 == 0 else ""), i)
        await _mensaje(motor, chat, f"aviso {i}", i, borrado=i % 10 == 0)
    _vacuum_analyze()

    enviadas: list[tuple[str, object]] = []

    def _apuntar(conn, cursor, sql, params, context, executemany):
        enviadas.append((sql, params))

    event.listen(motor.sync_engine, "before_cursor_execute", _apuntar)
    try:
        assert await _cuenta_de_enlaces(http, grupo) == 10
        assert list((await _own(http, grupo)).values()) == [36]
    finally:
        event.remove(motor.sync_engine, "before_cursor_execute", _apuntar)

    def _plano(sql: str) -> str:
        return " ".join(sql.split())

    enlaces = [(s, p) for s, p in enviadas if "count(*)" in s and "ILIKE" in s]
    propios = [
        (s, p)
        for s, p in enviadas
        if _plano(s).startswith(
            "SELECT messages.conversation_id, count(*) AS count_1 FROM messages WHERE"
        )
    ]
    assert len(enlaces) == 1 and len(propios) == 1, enviadas

    plan = _plan_generico(*enlaces[0])
    assert "messages_con_enlace_idx" in plan, plan
    plan = _plan_generico(*propios[0])
    assert "Index Only Scan using messages_vivos_idx" in plan, plan

    # La contraprueba: la MISMA consulta con las marcas como parámetros, que es
    # como la mandaba la API antes de la 0111, no puede usar el índice en un
    # plan genérico. Si esto dejara de ser verdad, la prueba de arriba no
    # estaría distinguiendo nada.
    sql, parametros = enlaces[0]
    con_parametros = sql
    for n, marca in enumerate(vistas._MARCAS_DE_ENLACE, start=len(parametros) + 1):
        con_parametros = con_parametros.replace(f"'{marca}'", f"${n}::VARCHAR")
    assert con_parametros != sql
    plan = _plan_generico(con_parametros, [*parametros, *vistas._MARCAS_DE_ENLACE])
    assert "messages_con_enlace_idx" not in plan, plan


@SIN_POSTGRES
def test_la_0111_se_puede_pegar_otra_vez_entera(base_aplicada):
    """El editor de Supabase la corre como UNA transacción: repetirla no falla
    y deja los dos índices válidos."""
    import psycopg

    sql = (MIGRACIONES / "0111_cuentas_de_temas_y_enlaces.sql").read_text(encoding="utf-8")
    with psycopg.connect(URL) as conexion:  # sin autocommit: una transacción
        with conexion.cursor() as cur:
            cur.execute(sql)
            # Cada sentencia deja su resultado; el último es el `select` de
            # comprobación con el que termina la migración.
            filas: list = []
            while True:
                if cur.description is not None:
                    filas = cur.fetchall()
                if not cur.nextset():
                    break
        conexion.commit()
    assert sorted((nombre, valido) for nombre, valido, _ in filas) == [
        ("messages_con_enlace_idx", True),
        ("messages_vivos_idx", True),
    ]
