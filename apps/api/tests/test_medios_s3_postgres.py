"""Los medios en S3 (0116) contra PostgreSQL de verdad.

`test_medios_s3.py` fija el comportamiento en SQLite. Aquí se comprueba lo que
solo se ve en PostgreSQL:

  · LA MIGRACIÓN sobre una base con medios de antes: todos quedan en
    'supabase', el `CHECK` rechaza otro almacén, las dos tablas nuevas tienen
    RLS sin políticas y `anon`/`authenticated` no pueden leerlas, pegarla dos
    veces deja lo mismo y la vuelta atrás escrita en el fichero funciona.
  · LA API sobre PostgreSQL: el predicado de visibilidad (con el `enum` de
    roles y los alias), la columna `almacen` leída con la tabla ligera (uuid
    contra uuid, no contra texto) y el registro de subidas.

Se omite sin `MIGRACIONES_DATABASE_URL`, como el resto de pruebas de
PostgreSQL. Borra y rehace el esquema `public`: solo contra una base
desechable.
"""

from __future__ import annotations

import os
from urllib.parse import urlsplit
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.shared.database import get_db
from tests.test_comunidades_en_el_perfil_postgres import _hacer, _montar, _persona, _todas, _uno
from tests.test_medios_s3 import NUEVA, _verificar_url, ajustes  # noqa: F401 — fixture
from tests.test_migraciones_reales import MIGRACIONES, exigir_url_desechable

ARCHIVO = MIGRACIONES / "0116_medios_en_s3.sql"
SQL = ARCHIVO.read_text(encoding="utf-8")
URL = os.environ.get("MIGRACIONES_DATABASE_URL", "").strip()
SIN_POSTGRES = pytest.mark.skipif(
    not URL,
    reason=(
        "sin PostgreSQL desechable: define MIGRACIONES_DATABASE_URL "
        "(ver la cabecera de tests/test_migraciones_reales.py)"
    ),
)

ANA = str(uuid4())
BETO = str(uuid4())
CARLA = str(uuid4())


def _vuelta_atras() -> str:
    bloque = SQL[SQL.index("-- VUELTA ATRÁS") :]
    lineas = [l[len("--   ") :] for l in bloque.splitlines() if l.startswith("--   ")]
    # La primera es la comprobación previa (un `select`), no parte del rollback.
    return "\n".join(l for l in lineas if not l.startswith("select count"))


def _foto(pg) -> list:
    return [
        _todas(
            pg,
            "select table_name, column_name, column_default, is_nullable from "
            "information_schema.columns where table_schema = 'public' and table_name in "
            "('post_media', 'medios_subidas', 'post_media_respaldo_supabase') order by 1, 2",
        ),
        _todas(
            pg,
            "select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid in "
            "('public.post_media'::regclass, 'public.medios_subidas'::regclass) order by 1",
        ),
        _todas(pg, "select indexname, indexdef from pg_indexes where tablename in "
               "('post_media', 'medios_subidas') order by 1"),
        _todas(pg, "select almacen, count(*) from public.post_media group by 1"),
    ]


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
    """Hasta la 0114 con medios de antes; después, la 0116 encima."""
    _montar(pg, hasta="0114")
    for ident, nombre in ((ANA, "Ana"), (BETO, "Beto"), (CARLA, "Carla")):
        _persona(pg, ident, nombre)
    _hacer(pg, "insert into public.follows (follower_id, following_id) values (%s, %s)", BETO, ANA)
    publica = _uno(
        pg,
        "insert into public.posts (author_id, body, visibility) values (%s, 'publica', 'public') "
        "returning id::text",
        ANA,
    )
    seguidores = _uno(
        pg,
        "insert into public.posts (author_id, body, visibility) values (%s, 'seg', 'followers') "
        "returning id::text",
        ANA,
    )
    _hacer(
        pg,
        "insert into public.post_media (post_id, storage_path, media_type) values (%s, %s, 'image')",
        publica, f"{ANA}/foto.jpg",
    )
    medio = str(uuid4())
    _hacer(
        pg,
        "insert into public.post_media (id, post_id, storage_path, poster_path, media_type) "
        "values (%s, %s, %s, %s, 'video')",
        medio, seguidores, f"videos/{ANA}/{medio}/original.mp4", f"videos/{ANA}/{medio}/poster-v1.jpg",
    )
    _hacer(pg, SQL)
    return {"publica": publica, "seguidores": seguidores, "medio": medio}


@SIN_POSTGRES
def test_los_medios_de_antes_quedan_en_supabase(base, pg) -> None:
    assert _todas(pg, "select almacen, count(*) from public.post_media group by 1") == [("supabase", 2)]


@SIN_POSTGRES
def test_el_check_rechaza_otro_almacen(base, pg) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _hacer(pg, "update public.post_media set almacen = 'gcs' where id = %s", base["medio"])


@SIN_POSTGRES
def test_las_tablas_nuevas_estan_cerradas(base, pg) -> None:
    import psycopg

    for tabla in ("medios_subidas", "post_media_respaldo_supabase"):
        assert _uno(pg, f"select relrowsecurity from pg_class where oid = 'public.{tabla}'::regclass")
        assert _uno(pg, "select count(*) from pg_policies where tablename = %s", tabla) == 0
        for rol in ("anon", "authenticated"):
            with pg.transaction():
                _hacer(pg, f"set local role {rol}")
                with pytest.raises(psycopg.errors.InsufficientPrivilege):
                    with pg.transaction():
                        _hacer(pg, f"select * from public.{tabla}")


@SIN_POSTGRES
def test_pegarla_dos_veces_deja_lo_mismo(base, pg) -> None:
    antes = _foto(pg)
    _hacer(pg, SQL)
    assert _foto(pg) == antes


@pytest_asyncio.fixture
async def entorno(base, pg, ajustes):  # noqa: F811
    _hacer(pg, "update public.post_media set almacen = 's3' where id = %s", base["medio"])
    motor = create_async_engine(URL.replace("postgresql://", "postgresql+asyncpg://", 1))
    sesiones = async_sessionmaker(motor, expire_on_commit=False)

    async def _db():
        async with sesiones() as sesion:
            yield sesion

    app.dependency_overrides[get_db] = _db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
            yield http
    finally:
        app.dependency_overrides.clear()
        await motor.dispose()
        _hacer(pg, "update public.post_media set almacen = 'supabase' where id = %s", base["medio"])


def _como(uid: str | None) -> None:
    usuario = AuthUser(id=uid, email="x@x.test", role="authenticated") if uid else None
    app.dependency_overrides[get_current_user] = lambda: usuario
    app.dependency_overrides[get_optional_user] = lambda: usuario


@SIN_POSTGRES
@pytest.mark.asyncio
@pytest.mark.parametrize("visibilidad", ["abierta", "estricta"])
async def test_la_api_firma_solo_a_quien_puede_ver(entorno, base, visibilidad, monkeypatch) -> None:
    monkeypatch.setattr(get_settings(), "publicaciones_visibilidad", visibilidad)
    _como(BETO)
    detalle = (await entorno.get(f"/api/v1/posts/{base['seguidores']}", headers=NUEVA)).json()
    medio = detalle["media"][0]
    assert medio["almacen"] == "s3"
    assert urlsplit(medio["poster_url"]).path.endswith("/poster-v1.jpg")
    _verificar_url(medio["media_url"])

    _como(CARLA)
    assert (await entorno.get(f"/api/v1/posts/{base['seguidores']}", headers=NUEVA)).status_code == 404
    muro = (await entorno.get("/api/v1/posts", headers=NUEVA)).json()
    assert [p["id"] for p in muro] == [base["publica"]]

    # La app vieja, aunque pueda verla, no la recibe.
    _como(BETO)
    viejo = (await entorno.get("/api/v1/posts")).json()
    assert [p["id"] for p in viejo] == [base["publica"]]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_registro_de_subidas_y_el_limite_en_postgresql(entorno, base, pg, ajustes) -> None:  # noqa: F811
    ajustes.medios_publicaciones_con_video_por_hora = 1
    _como(ANA)
    grupo = str(uuid4())
    pedido = {"tipo": "video", "content_type": "video/mp4", "bytes": 10, "grupo": grupo}
    assert (await entorno.post("/api/v1/medios/subidas", json=pedido)).status_code == 201
    assert (await entorno.post("/api/v1/medios/subidas", json=pedido)).status_code == 201
    otro = {**pedido, "grupo": str(uuid4())}
    assert (await entorno.post("/api/v1/medios/subidas", json=otro)).status_code == 429
    assert _uno(pg, "select count(*) from public.medios_subidas where uid = %s", ANA) == 2
    _hacer(pg, "delete from public.medios_subidas")


@SIN_POSTGRES
def test_la_vuelta_atras_del_fichero_funciona_y_se_puede_volver_a_pegar(base, pg) -> None:
    _hacer(pg, _vuelta_atras())
    columnas = _todas(
        pg,
        "select column_name from information_schema.columns where table_schema = 'public' "
        "and table_name = 'post_media' and column_name = 'almacen'",
    )
    assert columnas == []
    assert _uno(pg, "select to_regclass('public.medios_subidas')") is None
    # Los medios siguen ahí.
    assert _uno(pg, "select count(*) from public.post_media") == 2
    _hacer(pg, SQL)
    assert _uno(pg, "select to_regclass('public.medios_subidas')::text") == "medios_subidas"
