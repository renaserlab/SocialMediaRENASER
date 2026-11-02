"""El rótulo editable (0114) contra PostgreSQL de verdad.

`test_rotulo_editable.py` fija el comportamiento en SQLite, donde las columnas
se añaden a mano. Aquí se comprueba lo que solo se ve en PostgreSQL:

  · LA MIGRACIÓN, EJECUTADA sobre una base con rótulos de antes: las filas que
    ya había quedan exactamente como se pintaban (sitio de siempre, 100 %,
    recto, blanco, velo, clásica), los CHECK rechazan lo que la API rechaza
    —también `NaN`, que en PostgreSQL es «mayor que todo»—, pegarla dos veces
    deja lo mismo y la vuelta atrás escrita en el fichero funciona.
  · LA API sobre PostgreSQL: lo que se guarda en `real` vuelve con cuatro
    decimales y no con el ruido del tipo, y quitar el rótulo devuelve su
    presentación a la de siempre.

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

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.live import limites
from app.modules.recommendations import esquema
from app.shared.database import get_db
from tests.test_comunidades_en_el_perfil_postgres import _hacer, _montar, _persona, _todas, _uno
from tests.test_directo_invitados import ANA, CARLA, LIVE
from tests.test_migraciones_reales import MIGRACIONES, exigir_url_desechable

ARCHIVO = MIGRACIONES / "0114_rotulo_editable.sql"
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
    """El SQL de la vuelta atrás, TAL COMO ESTÁ ESCRITO en el fichero."""
    bloque = SQL[SQL.index("-- VUELTA ATRÁS") :]
    lineas = [linea[len("--   ") :] for linea in bloque.splitlines() if linea.startswith("--   ")]
    return "\n".join(lineas)


def _foto(pg) -> list:
    """Lo que la 0114 crea, para comparar antes y después."""
    return [
        _todas(
            pg,
            "select column_name, column_default, is_nullable, data_type "
            "from information_schema.columns where table_schema = 'public' "
            "and table_name = 'live_spotlights' order by 1",
        ),
        _todas(
            pg,
            "select conname, pg_get_constraintdef(c.oid) from pg_constraint c "
            "where conrelid = 'public.live_spotlights'::regclass order by 1",
        ),
        _todas(
            pg,
            "select relrowsecurity from pg_class where oid = 'public.live_spotlights'::regclass",
        ),
        _todas(pg, "select count(*) from pg_policies where tablename = 'live_spotlights'"),
        _todas(
            pg,
            "select session_id::text, banner_text, banner_style, banner_x, banner_y, banner_scale, "
            "banner_rotation, banner_color, banner_background, banner_font "
            "from public.live_spotlights order by 1",
        ),
    ]


def _emision(pg, host: str, *, estado: str = "live") -> str:
    return _uno(
        pg,
        "insert into public.live_sessions (host_id, title, status, started_at) "
        "values (%s, 'Charla', %s, now()) returning id::text",
        host, estado,
    )


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
    """Hasta la 0113 con un rótulo de antes y una fila solo con mensaje fijado;
    después, la 0114 encima."""
    _montar(pg, hasta="0113")
    _persona(pg, ANA, "Ana")
    _persona(pg, CARLA, "Carla")
    con_rotulo = _emision(pg, ANA)
    sin_rotulo = _emision(pg, ANA)
    _hacer(
        pg,
        "insert into public.live_spotlights (session_id, banner_text, banner_style, banner_by, banner_at) "
        "values (%s, 'Bienvenidos', 'pulse', %s, now())",
        con_rotulo, ANA,
    )
    _hacer(pg, "insert into public.live_spotlights (session_id) values (%s)", sin_rotulo)
    _hacer(pg, SQL)
    return {"con_rotulo": con_rotulo, "sin_rotulo": sin_rotulo}


@SIN_POSTGRES
def test_los_rotulos_de_antes_quedan_como_se_pintaban(base, pg) -> None:
    filas = _todas(
        pg,
        "select session_id::text, banner_text, banner_x, banner_y, banner_scale, banner_rotation, "
        "banner_color, banner_background, banner_font from public.live_spotlights order by banner_text",
    )
    assert sorted(filas) == sorted([
        (base["con_rotulo"], "Bienvenidos", None, None, 100, 0, "blanco", "velo", "clasica"),
        (base["sin_rotulo"], None, None, None, 100, 0, "blanco", "velo", "clasica"),
    ])


@SIN_POSTGRES
@pytest.mark.parametrize(
    "asignacion",
    [
        "banner_x = 1.5, banner_y = 0.5",
        "banner_x = -0.1, banner_y = 0.5",
        "banner_x = 'NaN', banner_y = 0.5",
        "banner_x = 0.5, banner_y = 'Infinity'",
        "banner_x = 0.5",
        "banner_y = 0.5",
        "banner_scale = 65",
        "banner_scale = 245",
        "banner_scale = 101",
        "banner_rotation = 181",
        "banner_rotation = -181",
        "banner_color = 'violeta'",
        "banner_color = '#FF0000'",
        "banner_background = 'degradado'",
        "banner_font = 'Comic Sans'",
        "banner_color = null",
        "banner_scale = null",
    ],
)
def test_la_base_rechaza_lo_que_rechaza_la_api(base, pg, asignacion) -> None:
    import psycopg

    with pytest.raises((psycopg.errors.CheckViolation, psycopg.errors.NotNullViolation)):
        _hacer(
            pg,
            f"update public.live_spotlights set {asignacion} where session_id = %s",
            base["con_rotulo"],
        )


@SIN_POSTGRES
def test_la_base_admite_los_bordes(base, pg) -> None:
    for asignacion in (
        "banner_x = 0, banner_y = 1, banner_scale = 70, banner_rotation = -180",
        "banner_x = 1, banner_y = 0, banner_scale = 240, banner_rotation = 180",
        "banner_x = null, banner_y = null, banner_scale = 100, banner_rotation = 0",
    ):
        _hacer(
            pg,
            f"update public.live_spotlights set {asignacion} where session_id = %s",
            base["sin_rotulo"],
        )


@SIN_POSTGRES
def test_pegarla_dos_veces_deja_lo_mismo(base, pg) -> None:
    antes = _foto(pg)
    _hacer(pg, SQL)
    assert _foto(pg) == antes


# --------------------------------------------------------------------------- #
# La API sobre PostgreSQL
# --------------------------------------------------------------------------- #


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
    limites.vaciar()
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
            yield http, identidad
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_optional_user, None)
        esquema.olvidar()
        await motor.dispose()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_api_guarda_y_devuelve_la_presentacion_en_postgresql(entorno, base, pg) -> None:
    http, identidad = entorno
    sesion_id = _emision(pg, ANA)
    ruta = f"{LIVE}/sessions/{sesion_id}/spotlight"

    puesto = await http.put(
        f"{ruta}/banner",
        json={"text": "Sorteo", "style": "slide", "x": 0.3, "y": 0.45, "scale": 135,
              "rotation": -7, "color": "oro", "background": "solido", "font": "fuerte"},
    )
    assert puesto.status_code == 200, puesto.text
    rotulo = puesto.json()["banner"]
    assert puesto.json()["banner_layout"] is True
    # `real` guarda 0.3 como 0.30000001192…: vuelve redondeado, no con ruido.
    assert (rotulo["x"], rotulo["y"], rotulo["scale"], rotulo["rotation"]) == (0.3, 0.45, 135, -7)

    movido = await http.patch(
        f"{ruta}/banner/layout", json={"x": 0.6666666, "y": 0.1, "scale": 70, "rotation": 180}
    )
    assert movido.status_code == 200, movido.text
    assert (movido.json()["banner"]["x"], movido.json()["banner"]["set_at"]) == (0.6667, rotulo["set_at"])

    identidad["uid"] = CARLA
    assert (await http.patch(f"{ruta}/banner/layout", json={"x": 0.1, "y": 0.1, "scale": 100, "rotation": 0})).status_code == 403
    assert (await http.get(ruta)).json()["banner"]["x"] == 0.6667

    identidad["uid"] = ANA
    assert (await http.delete(f"{ruta}/banner")).status_code == 200
    assert _todas(
        pg,
        "select banner_text, banner_x, banner_y, banner_scale, banner_rotation, banner_color, "
        "banner_background, banner_font from public.live_spotlights where session_id = %s",
        sesion_id,
    ) == [(None, None, None, 100, 0, "blanco", "velo", "clasica")]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_las_columnas_la_api_pone_el_texto_como_siempre(entorno, base, pg) -> None:
    """La API desplegada antes que la migración: se quitan las columnas con la
    vuelta atrás del fichero y la API, que lo averigua de nuevo, sigue."""
    http, _identidad = entorno
    _hacer(pg, _vuelta_atras())
    esquema.olvidar()
    try:
        sesion_id = _emision(pg, ANA)
        ruta = f"{LIVE}/sessions/{sesion_id}/spotlight"
        puesto = await http.put(f"{ruta}/banner", json={"text": "Hola", "color": "oro", "x": 0.2, "y": 0.2})
        assert puesto.status_code == 200, puesto.text
        assert puesto.json()["banner_layout"] is False
        assert puesto.json()["banner"]["color"] == "blanco"
        movido = await http.patch(f"{ruta}/banner/layout", json={"x": 0.1, "y": 0.1, "scale": 100, "rotation": 0})
        assert movido.status_code == 503
        assert (await http.delete(f"{ruta}/banner")).status_code == 200
    finally:
        _hacer(pg, SQL)
        esquema.olvidar()


@SIN_POSTGRES
def test_la_vuelta_atras_quita_las_siete_columnas_y_nada_mas(base, pg) -> None:
    antes = _todas(pg, "select count(*) from public.live_spotlights")
    _hacer(pg, _vuelta_atras())
    columnas = {
        fila[0]
        for fila in _todas(
            pg,
            "select column_name from information_schema.columns "
            "where table_schema = 'public' and table_name = 'live_spotlights'",
        )
    }
    assert not columnas & set(esquema.COLUMNAS_DEL_ROTULO_EDITABLE)
    assert {"banner_text", "banner_style", "pinned_message_id"} <= columnas
    assert _todas(pg, "select count(*) from public.live_spotlights") == antes
    # Y se puede volver a aplicar encima.
    _hacer(pg, SQL)
    assert _uno(
        pg,
        "select count(*) from information_schema.columns where table_schema = 'public' "
        "and table_name = 'live_spotlights' and column_name like 'banner\\_%%'",
    ) == 11


def test_la_vuelta_atras_del_fichero_se_puede_leer() -> None:
    vuelta = _vuelta_atras()
    assert vuelta.startswith("alter table public.live_spotlights")
    for columna in esquema.COLUMNAS_DEL_ROTULO_EDITABLE:
        assert f"drop column if exists {columna}" in vuelta, columna
