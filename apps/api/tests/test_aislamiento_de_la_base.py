"""Las pruebas no pueden hablar con la base de datos real. Nunca.

POR QUE ESTE FICHERO EXISTE. `apps/api/.env` esta en la maquina de desarrollo
y su `DATABASE_URL` apunta al pooler de Supabase de PRODUCCION.
`app/shared/database.py` construye el motor al importarse, leyendo esa
variable. Hoy todas las pruebas sustituyen `get_db` por una sesion propia en
memoria, asi que nadie llega a usar ese motor; pero basta con que una prueba
nueva se olvide de la sustitucion para que abra una sesion contra la base real.
No falla, no avisa: funciona, y escribe donde no debe.

Es el mismo razonamiento que ya llevo a `_sin_salidas_a_produccion` en
`conftest.py` con el procesado de medios, y por el mismo motivo: lo que depende
de que alguien se acuerde, antes o despues falla.
"""

from __future__ import annotations

from app.core.config import get_settings


def test_la_suite_apunta_a_una_base_desechable() -> None:
    """Sea cual sea el `.env` de quien ejecute, aqui se usa SQLite en memoria."""
    url = get_settings().database_url
    assert url.startswith("sqlite"), (
        f"las pruebas apuntan a {url.split('://')[0]}://…: el conftest tiene que "
        "haber fijado DATABASE_URL antes de importar app.shared.database"
    )
    assert ":memory:" in url, f"se esperaba una base en memoria, no {url}"


def test_el_motor_global_no_apunta_a_produccion() -> None:
    """Y el motor ya construido tampoco.

    Se comprueba el objeto real y no solo la configuracion: entre los dos hay
    un import, y es justo ahi donde se colaba el problema.
    """
    from app.shared.database import engine

    assert engine.url.get_backend_name() == "sqlite", (
        f"el motor global habla {engine.url.get_backend_name()}"
    )
    # Ni rastro del pooler. Se compara el host, que no es un secreto.
    assert (engine.url.host or "") == "", "el motor global tiene un host remoto"
