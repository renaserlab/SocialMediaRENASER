"""La API de «comunidades en el perfil» contra una base que todavía NO tiene la 0112.

Es lo que pasa en producción entre que la integración continua despliega la API
y alguien pega la migración a mano en el editor de Supabase. En ese rato no
existen ni `group_settings.entrada` ni `group_profile_listings`, y la API tiene
que comportarse exactamente como la de antes:

  · el perfil, la tarjeta del enlace, `/info`, los ajustes y `join-requests`
    responden lo de siempre, sin un 500: todas las comunidades «con
    solicitud» y el perfil leído de `listed_on_profile`;
  · lo único que necesita lo nuevo —cambiar cómo se entra— responde 503
    `group_extras_not_available` sin escribir nada;
  · y cuando se pega, la API lo ve sin reiniciar en cuanto caduca el «no»
    (`esquema.SEGUNDOS_DE_UN_NO`), con el perfil intacto gracias al relleno.

Aquí la columna falta DE VERDAD (en SQLite la crea el modelo; ver
`test_comunidades_en_el_perfil.py`, sección 7). Se omite sin
`MIGRACIONES_DATABASE_URL`. Borra y rehace el esquema `public`: solo contra
una base desechable.
"""

from __future__ import annotations

import os
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
from tests.test_comunidades_en_el_perfil_postgres import (
    SQL,
    _hacer,
    _montar,
    _persona,
    _uno,
    _vuelta_atras,
)
from tests.test_migraciones_reales import exigir_url_desechable
from tests.test_vistas_de_conversacion import ANA, API, BRUNO, CARLA, DAVID

URL = os.environ.get("MIGRACIONES_DATABASE_URL", "").strip()
SIN_POSTGRES = pytest.mark.skipif(
    not URL,
    reason=(
        "sin PostgreSQL desechable: define MIGRACIONES_DATABASE_URL "
        "(ver la cabecera de tests/test_migraciones_reales.py)"
    ),
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
def hasta_la_0111(pg):
    """Todas las migraciones hasta la 0111, ninguna más, y las cuatro personas."""
    _montar(pg, hasta="0111")
    for ident, nombre in ((ANA, "Ana"), (BRUNO, "Bruno"), (CARLA, "Carla"), (DAVID, "David")):
        _persona(pg, ident, nombre)
    assert _uno(pg, "select to_regclass('public.group_profile_listings')") is None
    assert _uno(
        pg,
        "select count(*) from information_schema.columns where table_schema = 'public' "
        "and table_name = 'group_settings' and column_name = 'entrada'",
    ) == 0
    return pg


@pytest_asyncio.fixture
async def entorno(hasta_la_0111):
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


async def _comunidad(motor, *, en_perfil: bool = True) -> str:
    """Una comunidad de Ana con Bruno, con su fila de ajustes de ANTES de la 0112."""
    cid = str(uuid4())
    async with motor.begin() as c:
        await c.execute(
            text(
                "insert into public.conversations (id, kind, title, created_by) "
                "values (cast(:i as uuid), 'group', 'Aula', cast(:a as uuid))"
            ),
            {"i": cid, "a": ANA},
        )
        for uid in (ANA, BRUNO):
            await c.execute(
                text(
                    "insert into public.conversation_members (conversation_id, user_id) "
                    "values (cast(:i as uuid), cast(:u as uuid))"
                ),
                {"i": cid, "u": uid},
            )
        await c.execute(
            text(
                "insert into public.group_settings (conversation_id, listed_on_profile) "
                "values (cast(:i as uuid), :p)"
            ),
            {"i": cid, "p": en_perfil},
        )
    return cid


async def _columna(motor, cid: str) -> bool:
    async with motor.connect() as c:
        return bool(
            (
                await c.execute(
                    text(
                        "select listed_on_profile from public.group_settings "
                        "where conversation_id = cast(:i as uuid)"
                    ),
                    {"i": cid},
                )
            ).scalar_one()
        )


async def _perfil(http, identidad) -> dict[str, dict]:
    identidad["uid"] = DAVID
    respuesta = await http.get(f"{API}/groups/of/{ANA}")
    assert respuesta.status_code == 200, respuesta.text
    return {t["id"]: t for t in respuesta.json()}


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_la_0112_el_perfil_la_tarjeta_y_los_ajustes_salen_como_antes(entorno) -> None:
    http, motor, identidad = entorno
    cid = await _comunidad(motor)
    oculta = await _comunidad(motor, en_perfil=False)

    perfil = await _perfil(http, identidad)
    assert cid in perfil and oculta not in perfil
    tarjeta = perfil[cid]
    # En la tarjeta, «con solicitud»: es lo que leen la app de antes y la nueva.
    assert (tarjeta["entrada"], tarjeta["my_status"], tarjeta["members_count"]) == ("request", "none", 2)
    assert (tarjeta["groups_count"], tarjeta["topics_count"]) == (0, 0)

    identidad["uid"] = ANA
    info = await http.get(f"{API}/{cid}/info")
    assert info.status_code == 200, info.text
    assert info.json()["settings"] == {
        "listed_on_profile": True,
        "invite_enabled": False,
        "invite_code": None,
        # Sin la 0112 no se puede elegir: `None`, para que la app no lo ofrezca.
        "entrada": None,
    }
    assert (await http.get(f"{API}/{oculta}/info")).json()["settings"]["listed_on_profile"] is False


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_la_0112_en_mi_perfil_escribe_la_columna_de_siempre(entorno) -> None:
    http, motor, identidad = entorno
    cid = await _comunidad(motor)

    identidad["uid"] = ANA
    quitada = await http.patch(f"{API}/{cid}/group/settings", json={"listed_on_profile": False})
    assert quitada.status_code == 200, quitada.text
    assert quitada.json()["listed_on_profile"] is False
    assert await _columna(motor, cid) is False
    assert cid not in await _perfil(http, identidad)

    identidad["uid"] = ANA
    puesta = await http.patch(f"{API}/{cid}/group/settings", json={"listed_on_profile": True})
    assert puesta.json() == {
        "listed_on_profile": True,
        "invite_enabled": False,
        "invite_code": None,
        # Sin la 0112 no se puede elegir: `None`, para que la app no lo ofrezca.
        "entrada": None,
    }
    assert cid in await _perfil(http, identidad)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_la_0112_cambiar_como_se_entra_responde_503_sin_escribir_nada(entorno) -> None:
    http, motor, identidad = entorno
    cid = await _comunidad(motor)
    identidad["uid"] = ANA
    for cuerpo in ({"entrada": "open"}, {"entrada": "open", "listed_on_profile": False}):
        respuesta = await http.patch(f"{API}/{cid}/group/settings", json=cuerpo)
        assert respuesta.status_code == 503, respuesta.text
        assert respuesta.json()["error"]["code"] == "group_extras_not_available"
    assert await _columna(motor, cid) is True


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_la_0112_el_enlace_y_las_solicitudes_como_antes(entorno) -> None:
    http, motor, identidad = entorno
    cid = await _comunidad(motor, en_perfil=False)
    identidad["uid"] = ANA
    activado = await http.patch(f"{API}/{cid}/group/settings", json={"invite_enabled": True})
    assert activado.status_code == 200, activado.text
    codigo = activado.json()["invite_code"]
    rotado = await http.post(f"{API}/{cid}/group/invite/rotate")
    assert rotado.status_code == 200
    codigo = rotado.json()["invite_code"]

    identidad["uid"] = DAVID
    tarjeta = await http.get(f"{API}/groups/invite/{codigo}")
    assert tarjeta.status_code == 200, tarjeta.text
    assert tarjeta.json()["entrada"] == "request"
    # `join` responde lo que a una con solicitud; pedirlo, lo de siempre.
    unirse = await http.post(f"{API}/{cid}/join", json={"code": codigo})
    assert unirse.status_code == 409
    assert unirse.json()["error"]["code"] == "group_requires_request"
    pedida = await http.post(f"{API}/{cid}/join-requests", json={"code": codigo})
    assert pedida.status_code == 201, pedida.text
    assert pedida.json()["status"] == "pending"

    identidad["uid"] = ANA
    pendientes = (await http.get(f"{API}/{cid}/join-requests")).json()
    assert [p["user"]["id"] for p in pendientes] == [DAVID]
    aceptada = await http.post(f"{API}/{cid}/join-requests/{pendientes[0]['id']}/approve")
    assert aceptada.status_code == 204
    identidad["uid"] = DAVID
    assert (await http.post(f"{API}/{cid}/join", json={})).json()["my_status"] == "member"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_al_pegarla_la_api_la_ve_sin_reiniciar(entorno, hasta_la_0111) -> None:
    """Se pega con la API en marcha. Mientras dura el «no» guardado sigue como
    antes; cuando caduca, lee la 0112, y el perfil es el mismo (el relleno
    copió la columna). Al terminar, la base vuelve a estar sin la 0112."""
    http, motor, identidad = entorno
    pg = hasta_la_0111
    cid = await _comunidad(motor)
    assert cid in await _perfil(http, identidad)  # la API ya sabe que falta

    _hacer(pg, SQL)
    try:
        identidad["uid"] = ANA
        # El «no» guardado todavía vale: nada cambia, y nada falla.
        assert (
            await http.patch(f"{API}/{cid}/group/settings", json={"entrada": "open"})
        ).status_code == 503

        # Caduca (es lo que pasa solo al cabo de `SEGUNDOS_DE_UN_NO`).
        esquema._no_hasta["group_profile_listings"] = 0.0
        assert cid in await _perfil(http, identidad)
        identidad["uid"] = ANA
        abierta = await http.patch(f"{API}/{cid}/group/settings", json={"entrada": "open"})
        assert abierta.status_code == 200, abierta.text
        assert (abierta.json()["entrada"], abierta.json()["listed_on_profile"]) == ("open", True)
        identidad["uid"] = DAVID
        entra = await http.post(f"{API}/{cid}/join")
        assert entra.status_code == 200, entra.text
        assert entra.json()["my_status"] == "member"
    finally:
        _hacer(pg, _vuelta_atras())
        esquema.olvidar()
    assert _uno(pg, "select to_regclass('public.group_profile_listings')") is None
