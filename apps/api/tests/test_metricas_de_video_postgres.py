"""La tabla de mediciones de video (0115) contra PostgreSQL de verdad.

`test_telemetria_de_video.py` fija la API en SQLite. Aquí se repite lo que
SQLite no puede ver:

  · que la migración aplica sobre todas las anteriores y se puede pegar dos
    veces;
  · que `anon` y `authenticated` no leen ni escriben la tabla ni la vista, ni
    pueden llamar a la purga (lo que PostgREST serviría si se olvidara);
  · que los CHECK rechazan lo que la API ya rechaza (segunda red);
  · que la API escribe de verdad un lote con el modelo ORM, y que la vista y
    la purga hacen lo que dicen;
  · que la vuelta atrás escrita en el fichero funciona.

Se omite sin `MIGRACIONES_DATABASE_URL`, como el resto de pruebas de
PostgreSQL. Borra y rehace el esquema `public`: solo contra una base
desechable (ver `exigir_url_desechable`).
"""

from __future__ import annotations

import os

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.main import app
from app.modules.telemetria import router as telemetria
from app.shared.database import get_db
from tests.test_comunidades_en_el_perfil_postgres import _hacer, _montar, _todas, _uno
from tests.test_migraciones_reales import MIGRACIONES, exigir_url_desechable
from tests.test_telemetria_de_video import LOTE, RUTA

ARCHIVO = MIGRACIONES / "0115_metricas_de_video.sql"
SQL = ARCHIVO.read_text(encoding="utf-8")
URL = os.environ.get("MIGRACIONES_DATABASE_URL", "").strip()
SIN_POSTGRES = pytest.mark.skipif(
    not URL,
    reason=(
        "sin PostgreSQL desechable: define MIGRACIONES_DATABASE_URL "
        "(ver la cabecera de tests/test_migraciones_reales.py)"
    ),
)


def _vuelta_atras() -> str:
    bloque = SQL[SQL.index("-- VUELTA ATRÁS") :]
    lineas = [linea[len("--   ") :] for linea in bloque.splitlines() if linea.startswith("--   ")]
    return "\n".join(lineas)


@pytest.fixture(scope="module")
def pg():
    psycopg = pytest.importorskip("psycopg")
    exigir_url_desechable(URL, os.environ.get("DATABASE_URL", ""))
    with psycopg.connect(URL, autocommit=True) as conexion:
        _montar(conexion, hasta="0115")
        yield conexion


def _como(pg, rol: str, sql: str) -> str | None:
    """Ejecuta `sql` como `rol`; devuelve el error de permisos, o None."""
    import psycopg

    try:
        with pg.transaction(), pg.cursor() as cur:
            cur.execute(f"set local role {rol}")
            cur.execute(sql)
    except psycopg.errors.InsufficientPrivilege as error:
        return str(error)
    return None


@SIN_POSTGRES
def test_aplica_y_se_puede_pegar_dos_veces(pg):
    _hacer(pg, SQL)
    assert _uno(pg, "select relrowsecurity from pg_class where oid = 'public.metricas_de_video'::regclass")
    assert _uno(pg, "select count(*) from pg_policies where tablename = 'metricas_de_video'") == 0
    indices = {f[0] for f in _todas(pg, "select indexname from pg_indexes where tablename = 'metricas_de_video'")}
    assert {"metricas_de_video_creado_en", "metricas_de_video_plataforma_tramo"} <= indices


@SIN_POSTGRES
@pytest.mark.parametrize("rol", ["anon", "authenticated"])
def test_por_postgrest_no_se_lee_ni_se_escribe_nada(pg, rol):
    assert _como(pg, rol, "select * from public.metricas_de_video") is not None
    assert _como(pg, rol, "select * from public.metricas_de_video_resumen") is not None
    assert (
        _como(
            pg,
            rol,
            "insert into public.metricas_de_video (sesion, plataforma, tramo) "
            "values ('0123456789abcdef', 'ios', 'feed_pedido')",
        )
        is not None
    )
    assert _como(pg, rol, "select public.purgar_metricas_de_video(90)") is not None


@SIN_POSTGRES
@pytest.mark.parametrize(
    "valores",
    [
        "('NO-HEX', 'ios', 'feed_pedido', 1)",
        "('0123456789abcdef', 'windows', 'feed_pedido', 1)",
        "('0123456789abcdef', 'ios', 'inventado', 1)",
        "('0123456789abcdef', 'ios', 'feed_pedido', 120001)",
        "('0123456789abcdef', 'ios', 'feed_pedido', -1)",
    ],
)
def test_los_check_son_la_segunda_red(pg, valores):
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation), pg.transaction(), pg.cursor() as cur:
        cur.execute(f"insert into public.metricas_de_video (sesion, plataforma, tramo, ms) values {valores}")


@pytest_asyncio.fixture
async def http(pg):
    url = URL.replace("postgresql://", "postgresql+asyncpg://", 1)
    engine = create_async_engine(url)
    sesiones = async_sessionmaker(engine, expire_on_commit=False)

    async def _db():
        async with sesiones() as s:
            yield s

    telemetria.vaciar()
    app.dependency_overrides[get_db] = _db
    original = telemetria.fabrica_de_sesiones
    telemetria.fabrica_de_sesiones = sesiones
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as cliente:
            yield cliente
    finally:
        telemetria.fabrica_de_sesiones = original
        app.dependency_overrides.clear()
        telemetria.vaciar()
        await engine.dispose()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_api_escribe_y_la_vista_resume(pg, http):
    _hacer(pg, "delete from public.metricas_de_video")
    respuesta = await http.post(RUTA, json=LOTE)
    assert respuesta.status_code == 202, respuesta.text
    assert _uno(pg, "select count(*) from public.metricas_de_video") == 7
    resumen = {
        (f[0], f[1]): f[2:]
        for f in _todas(pg, "select plataforma, tramo, n, mediana_ms from public.metricas_de_video_resumen")
    }
    assert resumen[("ios", "deslizamiento")] == (1, 900)
    assert resumen[("ios", "primera_reproduccion")] == (1, 2200)


@SIN_POSTGRES
def test_la_purga_borra_solo_lo_viejo_y_no_acepta_menos_de_siete_dias(pg):
    import psycopg

    _hacer(pg, "delete from public.metricas_de_video")
    _hacer(
        pg,
        "insert into public.metricas_de_video (creado_en, sesion, plataforma, tramo, ms) values "
        "(now() - interval '120 days', '0123456789abcdef', 'android', 'feed_pedido', 10),"
        "(now() - interval '1 day', '0123456789abcdef', 'android', 'feed_pedido', 20)",
    )
    assert _uno(pg, "select public.purgar_metricas_de_video()") == 1
    assert _uno(pg, "select count(*) from public.metricas_de_video") == 1
    with pytest.raises(psycopg.errors.RaiseException), pg.transaction(), pg.cursor() as cur:
        cur.execute("select public.purgar_metricas_de_video(1)")


@SIN_POSTGRES
def test_la_vuelta_atras_escrita_funciona_y_se_puede_volver_a_aplicar(pg):
    _hacer(pg, _vuelta_atras())
    assert _uno(pg, "select to_regclass('public.metricas_de_video')") is None
    assert _uno(pg, "select to_regclass('public.metricas_de_video_resumen')") is None
    _hacer(pg, SQL)
    assert _uno(pg, "select to_regclass('public.metricas_de_video')") is not None
