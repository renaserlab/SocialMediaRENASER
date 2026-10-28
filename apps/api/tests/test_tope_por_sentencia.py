"""El tope por sentencia (`statement_timeout`) de las sesiones de la API.

QUE SE FIJA. La API entraba en la base como `postgres`, sin tope: una consulta
torcida seguia corriendo —con una conexion del pool cogida— mucho despues de
que CloudFront cortara a los 60 s. Ahora cada conexion NUEVA del motor de la
API recibe un `SET statement_timeout` (ver `shared/database.py`).

Lo que se comprueba:

  * SOLO EN POSTGRESQL. SQLite no tiene ese ajuste y el `SET` fallaria: con
    SQLite no se engancha nada, ni en el motor de las pruebas ni en uno nuevo.
  * Cero lo apaga.
  * Lo que se manda es exactamente el `SET` con el valor configurado, y se
    manda por la conexion de asyncpg FUERA de transaccion (si fuera dentro, el
    `ROLLBACK` con el que el pool limpia cada conexion se lo llevaria).
  * Y, si hay un PostgreSQL desechable (`MIGRACIONES_DATABASE_URL`), que de
    verdad se aplica, que sobrevive a un `ROLLBACK` y que corta lo que se
    pasa. Esa parte solo LEE: `show` y `pg_sleep`.
"""

from __future__ import annotations

import asyncio
import os

import pytest
from sqlalchemy import event, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import Settings
from app.shared import database
from tests.test_migraciones_reales import exigir_url_desechable

URL_PG = os.environ.get("MIGRACIONES_DATABASE_URL", "").strip()


def _ajustes(url: str, ms: int = 30000) -> Settings:
    return Settings(database_url=url, database_statement_timeout_ms=ms, _env_file=None)


# --------------------------------------------------------------------------- #
# 1. Cuando se aplica y cuando no
# --------------------------------------------------------------------------- #
def test_con_sqlite_no_hay_tope():
    assert database.tope_por_sentencia_ms(_ajustes("sqlite+aiosqlite:///:memory:")) is None


def test_con_postgres_hay_tope_y_de_fabrica_son_30_segundos():
    url = "postgresql+asyncpg://u:p@127.0.0.1:5432/x"
    assert database.tope_por_sentencia_ms(_ajustes(url)) == 30000
    assert Settings(_env_file=None).database_statement_timeout_ms == 30000


def test_cero_lo_apaga():
    url = "postgresql+asyncpg://u:p@127.0.0.1:5432/x"
    assert database.tope_por_sentencia_ms(_ajustes(url, ms=0)) is None


def test_el_motor_de_las_pruebas_no_lleva_el_tope():
    """Las pruebas corren contra SQLite (ver `conftest.py`): el motor del
    modulo no puede llevar el `SET`, o la primera conexion reventaria."""
    assert database.settings.uses_sqlite
    assert database.tope_por_sentencia_ms() is None


@pytest.mark.asyncio
async def test_en_sqlite_no_se_engancha_nada_y_la_conexion_funciona():
    motor = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        assert database.instalar_tope_por_sentencia(motor, None) is None
        async with motor.connect() as conn:
            assert (await conn.execute(text("select 1"))).scalar() == 1
    finally:
        await motor.dispose()


# --------------------------------------------------------------------------- #
# 2. Que se manda, y por donde
# --------------------------------------------------------------------------- #
def test_en_postgres_se_engancha_al_abrir_cada_conexion():
    # No conecta: el motor es perezoso y aqui solo se mira el enganche.
    motor = create_async_engine("postgresql+asyncpg://u:p@127.0.0.1:1/x")
    escucha = database.instalar_tope_por_sentencia(motor, 30000)
    try:
        assert escucha is not None
        assert event.contains(motor.sync_engine, "connect", escucha)
    finally:
        event.remove(motor.sync_engine, "connect", escucha)


def test_el_set_va_por_la_conexion_de_asyncpg_fuera_de_transaccion():
    """`run_async` entrega la conexion CRUDA de asyncpg; su `execute` sin
    transaccion abierta confirma al momento. Se comprueba con dobles: el
    motor de verdad se prueba abajo, cuando hay PostgreSQL."""
    motor = create_async_engine("postgresql+asyncpg://u:p@127.0.0.1:1/x")
    escucha = database.instalar_tope_por_sentencia(motor, 45000)
    enviadas: list[str] = []

    class _Asyncpg:
        async def execute(self, sentencia: str) -> str:
            enviadas.append(sentencia)
            return "SET"

    class _ConexionAdaptada:
        def run_async(self, funcion):  # noqa: ANN001, ANN201
            return asyncio.run(funcion(_Asyncpg()))

    try:
        escucha(_ConexionAdaptada(), None)
    finally:
        event.remove(motor.sync_engine, "connect", escucha)
    assert enviadas == ["set statement_timeout = 45000"]


# --------------------------------------------------------------------------- #
# 3. Contra PostgreSQL de verdad (desechable), solo lectura
# --------------------------------------------------------------------------- #
@pytest.mark.skipif(
    not URL_PG,
    reason="sin PostgreSQL desechable: define MIGRACIONES_DATABASE_URL",
)
@pytest.mark.asyncio
async def test_en_postgres_se_aplica_sobrevive_al_rollback_y_corta():
    exigir_url_desechable(URL_PG, os.environ.get("DATABASE_URL", ""))
    motor = create_async_engine(
        URL_PG.replace("postgresql://", "postgresql+asyncpg://", 1), pool_size=1, max_overflow=0
    )
    database.instalar_tope_por_sentencia(motor, 1500)
    sesiones = async_sessionmaker(motor, expire_on_commit=False)
    try:
        async with sesiones() as db:
            assert (await db.execute(text("show statement_timeout"))).scalar() == "1500ms"
            await db.rollback()
            # El ROLLBACK no se lo lleva: se puso fuera de toda transaccion.
            assert (await db.execute(text("show statement_timeout"))).scalar() == "1500ms"

        # La MISMA conexion, devuelta al pool (que hace ROLLBACK) y recogida.
        async with sesiones() as db:
            assert (await db.execute(text("show statement_timeout"))).scalar() == "1500ms"
            with pytest.raises(DBAPIError) as fallo:
                await db.execute(text("select pg_sleep(3)"))
            causa = getattr(fallo.value.orig, "__cause__", None) or fallo.value.orig
            assert getattr(causa, "sqlstate", None) == "57014"  # query_canceled
            await db.rollback()
            # Cortar una sentencia no deja la conexion inservible.
            assert (await db.execute(text("select 1"))).scalar() == 1
    finally:
        await motor.dispose()
