"""Comunidades en el perfil (0112) contra PostgreSQL de verdad.

`test_comunidades_en_el_perfil.py` fija el comportamiento en SQLite. Aquí se
repite lo que SQLite no puede ver:

  · LA MIGRACIÓN, EJECUTADA sobre una base con datos de antes: el relleno
    (quien hoy enseña su comunidad la sigue enseñando, y nada más), que todas
    quedan «con solicitud», que pegarla dos veces deja lo mismo, que el `CHECK`
    y las claves ajenas hacen lo que dicen, que la vuelta atrás escrita en el
    fichero funciona, y que si no consigue el bloqueo se rinde sin dejar nada.
  · LA API sobre PostgreSQL: el `insert … on conflict` de «en mi perfil», las
    consultas del perfil con sus `NOT EXISTS`, y dos toques a la vez en
    «Unirme», que en PostgreSQL sí corren a la vez y chocan en la clave
    primaria de los miembros.

Se omite sin `MIGRACIONES_DATABASE_URL`, como el resto de pruebas de
PostgreSQL. Borra y rehace el esquema `public`: solo contra una base
desechable (ver `exigir_url_desechable`).
"""

from __future__ import annotations

import asyncio
import os
import re
import threading
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.messaging import esquema
from app.shared.database import get_db
from tests.test_migraciones_reales import MIGRACIONES, PROLOGO, exigir_url_desechable
from tests.test_vistas_de_conversacion import ANA, API, BRUNO, CARLA, DAVID

ARCHIVO = MIGRACIONES / "0112_comunidades_en_el_perfil.sql"
SQL = ARCHIVO.read_text(encoding="utf-8")
URL = os.environ.get("MIGRACIONES_DATABASE_URL", "").strip()
SIN_POSTGRES = pytest.mark.skipif(
    not URL,
    reason=(
        "sin PostgreSQL desechable: define MIGRACIONES_DATABASE_URL "
        "(ver la cabecera de tests/test_migraciones_reales.py)"
    ),
)


# =========================================================================== #
# Ayudantes de psycopg
# =========================================================================== #
def _hacer(pg, sql: str, *args) -> None:
    with pg.cursor() as cur:
        cur.execute(sql, args or None)


def _todas(pg, sql: str, *args) -> list[tuple]:
    with pg.cursor() as cur:
        cur.execute(sql, args or None)
        return [tuple(f) for f in cur.fetchall()]


def _uno(pg, sql: str, *args):
    filas = _todas(pg, sql, *args)
    return filas[0][0] if filas else None


def _vuelta_atras() -> str:
    """El SQL de la vuelta atrás, TAL COMO ESTÁ ESCRITO en el fichero.

    Se ejecuta lo que lee quien lo pega en el editor, no una copia: si alguien
    lo cambia y deja de funcionar, esta prueba se entera.
    """
    bloque = SQL[SQL.index("-- VUELTA ATRÁS") :]
    lineas = [
        linea[len("--   ") :]
        for linea in bloque.splitlines()
        if linea.startswith("--   ")
    ]
    return "\n".join(lineas)


def _persona(pg, ident: str, nombre: str) -> None:
    """El disparador de la 0001 crea su perfil."""
    _hacer(
        pg,
        "insert into auth.users (id, email, raw_user_meta_data) values "
        "(%s, %s, jsonb_build_object('full_name', cast(%s as text), 'username', cast(%s as text)))",
        ident, f"{nombre.lower()}-{ident[-4:]}@x.test", nombre, f"{nombre.lower()}{ident[-4:]}",
    )


def _conversacion(pg, creada_por: str, miembros: list[str], kind: str = "group") -> str:
    ident = _uno(
        pg,
        "insert into public.conversations (kind, title, created_by) values (%s, 'Aula', %s) "
        "returning id::text",
        kind, creada_por,
    )
    for miembro in miembros:
        _hacer(
            pg,
            "insert into public.conversation_members (conversation_id, user_id) values (%s, %s)",
            ident, miembro,
        )
    return ident


def _ajustes(pg, conv: str, *, en_perfil: bool, enlace: str | None = None) -> None:
    """Una fila de ajustes de ANTES de la 0112: sin `entrada`."""
    _hacer(
        pg,
        "insert into public.group_settings (conversation_id, listed_on_profile, invite_code, "
        "invite_enabled) values (%s, %s, %s, %s)",
        conv, en_perfil, enlace, enlace is not None,
    )


def _montar(pg, *, hasta: str) -> None:
    with pg.cursor() as cur:
        cur.execute("drop schema if exists public cascade")
        cur.execute("drop schema if exists auth cascade")
        cur.execute("drop schema if exists storage cascade")
        cur.execute("create schema public")
        cur.execute(PROLOGO.read_text(encoding="utf-8"))
    for ruta in sorted(MIGRACIONES.glob("*.sql")):
        if ruta.name[:4] > hasta:
            break
        with pg.cursor() as cur:
            cur.execute(ruta.read_text(encoding="utf-8"))


def _foto(pg) -> list:
    """Todo lo que la 0112 crea o rellena, para comparar antes y después."""
    return [
        _todas(
            pg,
            "select column_name, column_default, is_nullable, data_type "
            "from information_schema.columns where table_schema = 'public' "
            "and table_name in ('group_settings', 'group_profile_listings') order by 1, 2",
        ),
        _todas(
            pg,
            "select conrelid::regclass::text, conname, pg_get_constraintdef(oid) from pg_constraint "
            "where conrelid in ('public.group_settings'::regclass, "
            "coalesce(to_regclass('public.group_profile_listings'), 'public.group_settings'::regclass)) "
            "order by 1, 2",
        ),
        _todas(
            pg,
            "select indexname, indexdef from pg_indexes where schemaname = 'public' "
            "and tablename in ('group_settings', 'group_profile_listings') order by 1",
        ),
        _todas(
            pg,
            "select relname, relrowsecurity from pg_class where oid = "
            "to_regclass('public.group_profile_listings')",
        ),
        _todas(
            pg,
            "select count(*) from pg_policies where schemaname = 'public' "
            "and tablename = 'group_profile_listings'",
        ),
        _todas(
            pg,
            "select conversation_id::text, user_id::text from public.group_profile_listings "
            "order by 1, 2"
        )
        if _uno(pg, "select to_regclass('public.group_profile_listings') is not null")
        else [],
        _todas(pg, "select conversation_id::text, listed_on_profile from public.group_settings order by 1"),
    ]


# =========================================================================== #
# La base: hasta la 0111 con datos de antes, y después la 0112
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
    """Las comunidades de antes de la 0112, y la 0112 aplicada encima.

      · `G1`, de Ana, que sale en su perfil;
      · `G2`, de Ana, que no;
      · `G3`, de Bruno, que sale en su perfil y tiene enlace;
      · `G4`, de Ana, sin fila de ajustes;
      · `D`, un chat de dos con una fila de ajustes que dice «en el perfil»
        (no debería existir, y el relleno no la puede convertir en comunidad).
    """
    _montar(pg, hasta="0111")
    for ident, nombre in ((ANA, "Ana"), (BRUNO, "Bruno"), (CARLA, "Carla"), (DAVID, "David")):
        _persona(pg, ident, nombre)
    c = {
        "G1": _conversacion(pg, ANA, [ANA, BRUNO]),
        "G2": _conversacion(pg, ANA, [ANA, CARLA]),
        "G3": _conversacion(pg, BRUNO, [BRUNO, CARLA]),
        "G4": _conversacion(pg, ANA, [ANA]),
        "D": _conversacion(pg, ANA, [ANA, CARLA], kind="direct"),
    }
    _ajustes(pg, c["G1"], en_perfil=True)
    _ajustes(pg, c["G2"], en_perfil=False)
    _ajustes(pg, c["G3"], en_perfil=True, enlace="enlace-de-bruno-123456")
    _ajustes(pg, c["D"], en_perfil=True)
    _hacer(pg, SQL)
    return c


@SIN_POSTGRES
def test_el_relleno_deja_en_su_perfil_a_quien_ya_la_ensenaba(base, pg) -> None:
    filas = set(
        _todas(
            pg,
            "select conversation_id::text, user_id::text from public.group_profile_listings "
            "where conversation_id = any(%s::uuid[])",
            list(base.values()),
        )
    )
    assert filas == {(base["G1"], ANA), (base["G3"], BRUNO)}
    # La columna de siempre no se toca: la API anterior la sigue leyendo.
    assert _uno(
        pg, "select listed_on_profile from public.group_settings where conversation_id = %s", base["G1"]
    ) is True


@SIN_POSTGRES
def test_todas_las_de_antes_quedan_con_solicitud(base, pg) -> None:
    assert set(
        _todas(
            pg,
            "select entrada from public.group_settings where conversation_id = any(%s::uuid[])",
            list(base.values()),
        )
    ) == {("request",)}
    columna = _todas(
        pg,
        "select column_default, is_nullable from information_schema.columns "
        "where table_schema = 'public' and table_name = 'group_settings' and column_name = 'entrada'",
    )
    assert columna == [("'request'::text", "NO")]
    # Una fila nueva que no dice nada, también.
    with pg.transaction(force_rollback=True):
        _hacer(pg, "insert into public.group_settings (conversation_id) values (%s)", base["G4"])
        assert _uno(
            pg, "select entrada from public.group_settings where conversation_id = %s", base["G4"]
        ) == "request"


@SIN_POSTGRES
def test_el_check_solo_admite_abierta_o_con_solicitud(base, pg) -> None:
    import psycopg

    with pg.transaction(force_rollback=True):
        _hacer(pg, "update public.group_settings set entrada = 'open' where conversation_id = %s", base["G1"])
    with pytest.raises(psycopg.errors.CheckViolation):
        with pg.transaction(force_rollback=True):
            _hacer(
                pg, "update public.group_settings set entrada = 'abierta' where conversation_id = %s",
                base["G1"],
            )
    with pytest.raises(psycopg.errors.NotNullViolation):
        with pg.transaction(force_rollback=True):
            _hacer(
                pg, "update public.group_settings set entrada = null where conversation_id = %s",
                base["G1"],
            )


@SIN_POSTGRES
def test_la_tabla_nueva_queda_cerrada_a_la_clave_del_cliente(base, pg) -> None:
    import psycopg

    assert _uno(pg, "select relrowsecurity from pg_class where oid = 'public.group_profile_listings'::regclass")
    assert _uno(
        pg,
        "select count(*) from pg_policies where schemaname = 'public' and tablename = 'group_profile_listings'",
    ) == 0
    # Como `authenticated` (lo que usa PostgREST con la sesión de alguien): o
    # no tiene permiso sobre la tabla, o la RLS sin políticas no le deja ver
    # ninguna fila. Las dos cierran; lo que no puede es leer las que hay.
    with pg.transaction(force_rollback=True):
        _hacer(pg, "grant usage on schema public to authenticated")
        _hacer(pg, "set local role authenticated")
        try:
            with pg.transaction():
                vistas = _uno(pg, "select count(*) from public.group_profile_listings")
        except psycopg.errors.InsufficientPrivilege:
            vistas = 0
        assert vistas == 0


@SIN_POSTGRES
def test_borrar_la_comunidad_o_la_persona_borra_sus_filas(base, pg) -> None:
    with pg.transaction(force_rollback=True):
        _hacer(pg, "delete from public.conversations where id = %s", base["G1"])
        assert _uno(
            pg, "select count(*) from public.group_profile_listings where conversation_id = %s", base["G1"]
        ) == 0
        # La de Bruno sigue ahí: borrar una comunidad no toca las de otros.
        assert _uno(
            pg, "select count(*) from public.group_profile_listings where conversation_id = %s", base["G3"]
        ) == 1
    with pg.transaction(force_rollback=True):
        otra = str(uuid4())
        _persona(pg, otra, "Eva")
        _hacer(
            pg,
            "insert into public.group_profile_listings (conversation_id, user_id) values (%s, %s)",
            base["G1"], otra,
        )
        _hacer(pg, "delete from auth.users where id = %s", otra)
        assert _uno(pg, "select count(*) from public.group_profile_listings where user_id = %s", otra) == 0


@SIN_POSTGRES
def test_pegarla_dos_veces_deja_lo_mismo(base, pg) -> None:
    antes = _foto(pg)
    _hacer(pg, SQL)
    _hacer(pg, SQL)
    assert _foto(pg) == antes


@SIN_POSTGRES
def test_volver_a_pegarla_no_devuelve_al_perfil_lo_que_se_quito(base, pg) -> None:
    """Lo que hace la API al quitarla de un perfil: borra la fila y la columna.
    Pegar la migración otra vez no puede deshacer esa decisión."""
    with pg.transaction(force_rollback=True):
        _hacer(pg, "delete from public.group_profile_listings where conversation_id = %s", base["G1"])
        _hacer(
            pg, "update public.group_settings set listed_on_profile = false where conversation_id = %s",
            base["G1"],
        )
        _hacer(pg, SQL)
        assert _uno(
            pg, "select count(*) from public.group_profile_listings where conversation_id = %s", base["G1"]
        ) == 0


@SIN_POSTGRES
def test_la_vuelta_atras_escrita_funciona_y_si_no_hay_bloqueo_se_rinde(base, pg) -> None:
    """Primero la vuelta atrás del fichero; después, con `group_settings` leída
    por otra sesión, la migración no se queda esperando (y con ella el `/info`
    de cada grupo): se rinde a los 5 s y no cambia nada. Al final, se vuelve a
    aplicar y el relleno deja lo mismo de antes."""
    import psycopg

    aplicada = _foto(pg)
    _hacer(pg, _vuelta_atras())
    try:
        assert _uno(pg, "select to_regclass('public.group_profile_listings')") is None
        assert _uno(
            pg,
            "select count(*) from information_schema.columns where table_schema = 'public' "
            "and table_name = 'group_settings' and column_name = 'entrada'",
        ) == 0
        sin_ella = _foto(pg)

        listo = threading.Event()
        soltar = threading.Event()

        def lector() -> None:
            with psycopg.connect(URL) as otra:
                otra.execute("lock table public.group_settings in access share mode")
                listo.set()
                soltar.wait(30)
                otra.rollback()

        hilo = threading.Thread(target=lector)
        hilo.start()
        try:
            assert listo.wait(10)
            with pytest.raises(psycopg.errors.LockNotAvailable):
                _hacer(pg, SQL)
        finally:
            soltar.set()
            hilo.join()
        assert _foto(pg) == sin_ella
    finally:
        _hacer(pg, SQL)
    # Lo que se pierde al deshacerla es cuáles eran abiertas (no había) y las
    # filas por persona; el relleno las rehace desde la columna de siempre.
    assert _foto(pg) == aplicada


# =========================================================================== #
# La API, sobre PostgreSQL
# =========================================================================== #
@pytest_asyncio.fixture
async def entorno(base):
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


async def _comunidad(motor, *, miembros=(ANA, BRUNO), entrada: str = "open") -> str:
    """Una comunidad de Ana, en su perfil, con la entrada pedida. Cada prueba la suya."""
    cid = str(uuid4())
    async with motor.begin() as c:
        await c.execute(
            text(
                "insert into public.conversations (id, kind, title, created_by) "
                "values (cast(:i as uuid), 'group', 'Aula', cast(:a as uuid))"
            ),
            {"i": cid, "a": ANA},
        )
        for uid in miembros:
            await c.execute(
                text(
                    "insert into public.conversation_members (conversation_id, user_id) "
                    "values (cast(:i as uuid), cast(:u as uuid))"
                ),
                {"i": cid, "u": uid},
            )
        await c.execute(
            text(
                "insert into public.group_settings (conversation_id, listed_on_profile, entrada) "
                "values (cast(:i as uuid), true, :e)"
            ),
            {"i": cid, "e": entrada},
        )
        await c.execute(
            text(
                "insert into public.group_profile_listings (conversation_id, user_id) "
                "values (cast(:i as uuid), cast(:a as uuid))"
            ),
            {"i": cid, "a": ANA},
        )
    return cid


async def _cuantas(motor, sql: str, **params) -> int:
    async with motor.connect() as c:
        return int((await c.execute(text(sql), params)).scalar_one())


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_toques_a_la_vez_en_unirme_dejan_un_miembro(entorno) -> None:
    http, motor, identidad = entorno
    cid = await _comunidad(motor)
    identidad["uid"] = DAVID
    respuestas = await asyncio.gather(*(http.post(f"{API}/{cid}/join") for _ in range(4)))
    assert [r.status_code for r in respuestas] == [200] * 4, [r.text for r in respuestas]
    assert {r.json()["my_status"] for r in respuestas} == {"member"}
    assert await _cuantas(
        motor,
        "select count(*) from public.conversation_members "
        "where conversation_id = cast(:c as uuid) and user_id = cast(:u as uuid)",
        c=cid, u=DAVID,
    ) == 1
    # Una sola entrada escrita: las que perdieron la carrera se deshicieron enteras.
    assert await _cuantas(
        motor,
        "select count(*) from public.group_join_requests "
        "where conversation_id = cast(:c as uuid) and user_id = cast(:u as uuid) and status = 'approved'",
        c=cid, u=DAVID,
    ) == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_toques_a_la_vez_en_mi_perfil_dejan_una_fila(entorno) -> None:
    http, motor, identidad = entorno
    cid = await _comunidad(motor)
    async with motor.begin() as c:
        await c.execute(
            text("delete from public.group_profile_listings where conversation_id = cast(:c as uuid)"),
            {"c": cid},
        )
    identidad["uid"] = ANA
    respuestas = await asyncio.gather(
        *(
            http.patch(f"{API}/{cid}/group/settings", json={"listed_on_profile": True})
            for _ in range(3)
        )
    )
    assert [r.status_code for r in respuestas] == [200] * 3, [r.text for r in respuestas]
    assert all(r.json()["listed_on_profile"] is True for r in respuestas)
    assert await _cuantas(
        motor,
        "select count(*) from public.group_profile_listings where conversation_id = cast(:c as uuid)",
        c=cid,
    ) == 1

    quitada = await http.patch(f"{API}/{cid}/group/settings", json={"listed_on_profile": False})
    assert quitada.json()["listed_on_profile"] is False
    assert await _cuantas(
        motor,
        "select count(*) from public.group_profile_listings where conversation_id = cast(:c as uuid)",
        c=cid,
    ) == 0


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_perfil_y_la_tarjeta_en_postgresql(entorno) -> None:
    """Las condiciones del perfil (`NOT EXISTS` sobre grupos de dentro y temas)
    y las cuentas de la tarjeta, con los tipos de PostgreSQL."""
    http, motor, identidad = entorno
    cid = await _comunidad(motor)
    hija = await _comunidad(motor)  # se convierte en un grupo de dentro de `cid`
    tema_chat = await _comunidad(motor)  # y esta, en el chat de un tema de `cid`
    async with motor.begin() as c:
        await c.execute(
            text(
                "insert into public.group_subgroups (conversation_id, parent_id) "
                "values (cast(:h as uuid), cast(:p as uuid))"
            ),
            {"h": hija, "p": cid},
        )
        await c.execute(
            text(
                "insert into public.conversation_topics "
                "(conversation_id, chat_id, nombre, nombre_normalizado, created_by) values "
                "(cast(:g as uuid), cast(:c as uuid), 'Anuncios', 'anuncios', cast(:a as uuid))"
            ),
            {"g": cid, "c": tema_chat, "a": ANA},
        )

    identidad["uid"] = DAVID
    perfil = await http.get(f"{API}/groups/of/{ANA}")
    assert perfil.status_code == 200, perfil.text
    ids = [t["id"] for t in perfil.json()]
    assert cid in ids
    assert hija not in ids and tema_chat not in ids
    tarjeta = next(t for t in perfil.json() if t["id"] == cid)
    assert (tarjeta["entrada"], tarjeta["groups_count"], tarjeta["topics_count"]) == ("open", 1, 1)

    # La aplicación de antes pide entrar y entra.
    pedida = await http.post(f"{API}/{cid}/join-requests", json={})
    assert pedida.status_code == 201, pedida.text
    assert pedida.json()["status"] == "approved"
    tarjeta = next(t for t in (await http.get(f"{API}/groups/of/{ANA}")).json() if t["id"] == cid)
    assert (tarjeta["my_status"], tarjeta["members_count"]) == ("member", 3)
    # Al chat del tema entra con la comunidad; al grupo de dentro, no.
    for conv, esperado in ((tema_chat, 1), (hija, 0)):
        assert await _cuantas(
            motor,
            "select count(*) from public.conversation_members "
            "where conversation_id = cast(:c as uuid) and user_id = cast(:u as uuid)",
            c=conv, u=DAVID,
        ) == esperado


@SIN_POSTGRES
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "deriva",
    [
        # La API anterior la quitó del perfil: columna a `false`, la fila se quedó.
        "update public.group_settings set listed_on_profile = false where conversation_id = cast(:c as uuid)",
        # La API anterior la puso: columna a `true`, sin fila.
        "delete from public.group_profile_listings where conversation_id = cast(:c as uuid)",
    ],
)
async def test_si_la_fila_y_la_columna_no_coinciden_no_sale_en_postgresql(entorno, deriva) -> None:
    http, motor, identidad = entorno
    cid = await _comunidad(motor)
    async with motor.begin() as c:
        await c.execute(text(deriva), {"c": cid})
    identidad["uid"] = DAVID
    perfil = await http.get(f"{API}/groups/of/{ANA}")
    assert perfil.status_code == 200, perfil.text
    assert cid not in [t["id"] for t in perfil.json()]
    for respuesta in (
        await http.post(f"{API}/{cid}/join-requests", json={}),
        await http.post(f"{API}/{cid}/join"),
    ):
        assert respuesta.status_code == 404
    identidad["uid"] = ANA
    assert (await http.get(f"{API}/{cid}/info")).json()["settings"]["listed_on_profile"] is False


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_a_una_con_solicitud_no_se_entra_en_postgresql(entorno) -> None:
    http, motor, identidad = entorno
    cid = await _comunidad(motor, entrada="request")
    identidad["uid"] = DAVID
    respuesta = await http.post(f"{API}/{cid}/join", json={})
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "group_requires_request"
    pedida = await http.post(f"{API}/{cid}/join-requests", json={})
    assert pedida.status_code == 201
    assert pedida.json()["status"] == "pending"


def test_la_vuelta_atras_del_fichero_se_puede_leer() -> None:
    """Sin PostgreSQL también: que el bloque exista y diga lo que tiene que decir."""
    vuelta = _vuelta_atras()
    assert re.search(r"drop table if exists public\.group_profile_listings;", vuelta)
    assert "drop column if exists entrada;" in vuelta
    assert "notify pgrst, 'reload schema';" in vuelta
