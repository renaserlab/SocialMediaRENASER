"""La API de «audios y temas» contra una base que todavía NO tiene la 0113.

Es lo que pasa en producción entre que la integración continua despliega la API
y alguien pega la migración a mano en el editor de Supabase. En ese rato no
existen `message_attachments.title` ni `.voice_note`, y la API tiene que
comportarse como la de antes:

  · mandar, leer el historial, Contenido, los temas, la bandeja y las citas
    responden lo de siempre, sin un 500: sin nombres y todo audio nota de voz;
  · un nombre que mande la aplicación nueva se ignora, y ponérselo después
    responde 503 `attachment_titles_not_available` sin escribir nada;
  · un archivo de audio se valida como nota de voz, porque eso es lo que
    dirá de él el relleno de la 0113;
  · y cuando se pega, la API lo ve sin reiniciar en cuanto caduca el «no»
    (`esquema.SEGUNDOS_DE_UN_NO`).

Aquí las columnas faltan DE VERDAD, como en `test_audios_y_temas.py` (sección
8), pero con el PostgreSQL de producción y la 0113 tal como está escrita. Se
omite sin `MIGRACIONES_DATABASE_URL`. Borra y rehace el esquema `public`: solo
contra una base desechable.
"""

from __future__ import annotations

import os

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
from tests.test_comunidades_en_el_perfil_postgres import _hacer, _montar, _persona, _uno
from tests.test_migraciones_reales import exigir_url_desechable
from tests.test_nombres_de_adjuntos_postgres import SQL, _grupo, _tema, codigo
from tests.test_vistas_de_conversacion import ANA, API, BRUNO, CARLA, DAVID

URL = os.environ.get("MIGRACIONES_DATABASE_URL", "").strip()
SIN_POSTGRES = pytest.mark.skipif(
    not URL,
    reason=(
        "sin PostgreSQL desechable: define MIGRACIONES_DATABASE_URL "
        "(ver la cabecera de tests/test_migraciones_reales.py)"
    ),
)

_COLUMNAS_0113 = (
    "select count(*) from information_schema.columns where table_schema = 'public' "
    "and table_name = 'message_attachments' and column_name in ('title', 'voice_note')"
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
def hasta_la_0112(pg):
    """Todas las migraciones hasta la 0112, ninguna más, y las cuatro personas."""
    _montar(pg, hasta="0112")
    for ident, nombre in ((ANA, "Ana"), (BRUNO, "Bruno"), (CARLA, "Carla"), (DAVID, "David")):
        _persona(pg, ident, nombre)
    assert _uno(pg, _COLUMNAS_0113) == 0
    return pg


@pytest_asyncio.fixture
async def entorno(hasta_la_0112, monkeypatch):
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


def _adjuntos(grupo: str, de: str = ANA) -> list[dict]:
    return [
        {
            "storage_path": f"{grupo}/{de}/nota.m4a",
            "kind": "audio",
            "duration_s": 4,
            "title": "Respiración",
        },
        {"storage_path": f"{grupo}/{de}/temario.pdf", "kind": "document", "title": "Temario"},
    ]


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_la_0113_todo_funciona_como_antes(entorno) -> None:
    http, motor, identidad = entorno
    assert (await http.get(f"{API}/availability")).json()["attachment_titles"] is False
    grupo = await _grupo(motor)
    tema = await _tema(http, identidad, grupo, "Meditaciones")

    identidad["uid"] = ANA
    enviado = await http.post(
        f"{API}/{grupo}/messages", json={"body": "", "attachments": _adjuntos(grupo)}
    )
    assert enviado.status_code == 201, enviado.text
    nota, documento = enviado.json()["attachments"]
    assert [(a["title"], a["voice_note"]) for a in (nota, documento)] == [(None, True), (None, False)]

    # Un archivo de audio: se lee como nota de voz, así que se valida como tal.
    sin_duracion = await http.post(
        f"{API}/{grupo}/messages",
        json={
            "body": "",
            "attachments": [
                {"storage_path": f"{grupo}/{ANA}/clase.mp3", "kind": "audio", "voice_note": False}
            ],
        },
    )
    assert (sin_duracion.status_code, codigo(sin_duracion)) == (422, "voice_note_without_duration")

    nombrar = await http.patch(
        f"{API}/{grupo}/messages/{enviado.json()['id']}/attachments/{documento['id']}",
        json={"title": "Temario"},
    )
    assert (nombrar.status_code, codigo(nombrar)) == (503, "attachment_titles_not_available")

    referencia = await http.put(
        f"{API}/{grupo}/topics/{tema}/items", json={"message_ids": [enviado.json()["id"]]}
    )
    assert referencia.json() == {"added": 1, "already": 0}

    identidad["uid"] = CARLA
    [mensaje] = (await http.get(f"{API}/{grupo}/messages")).json()
    assert [(a["title"], a["voice_note"]) for a in mensaje["attachments"]] == [(None, True), (None, False)]
    assert mensaje["topics"] == [{"id": tema, "name": "Meditaciones"}]
    vista = await http.get(
        f"{API}/{grupo}/views/messages", params={"category": "all", "q": "temario"}
    )
    assert (vista.status_code, vista.json()["items"]) == (200, [])
    cuentas = await http.get(f"{API}/{grupo}/views/topics", params={"category": "audio"})
    assert cuentas.json() == {"sin_tema": 0, "topics": [{"id": tema, "name": "Meditaciones", "count": 1}]}
    [fila] = (await http.get(f"{API}/{grupo}/topics")).json()["topics"]
    assert (fila["last"]["excerpt"], fila["last"]["kind"]) == ("", "audio")
    filas = {f["id"]: f for f in (await http.get(API)).json()}
    assert filas[grupo]["last_message"] == "Nota de voz"
    # Y nada de esto tocó el esquema: la base sigue sin las columnas.
    async with motor.connect() as c:
        assert (await c.execute(text(_COLUMNAS_0113))).scalar_one() == 0


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_pegada_con_la_api_en_marcha_se_ve_sin_reiniciar(entorno, hasta_la_0112) -> None:
    """La API ya arrancó y vio que faltaba; se pega la 0113 tal cual. Lo que
    se mandó en el rato sin ella queda como nota de voz (el relleno), y en
    cuanto caduca el «no», los nombres funcionan sin reiniciar."""
    http, motor, identidad = entorno
    grupo = await _grupo(motor)
    identidad["uid"] = ANA
    enviado = (
        await http.post(f"{API}/{grupo}/messages", json={"body": "", "attachments": _adjuntos(grupo)})
    ).json()
    nota, documento = enviado["attachments"]
    ruta = f"{API}/{grupo}/messages/{enviado['id']}/attachments/{documento['id']}"
    assert (await http.patch(ruta, json={"title": "Temario"})).status_code == 503

    _hacer(hasta_la_0112, SQL)
    try:
        # Todavía no: el «no» vale un minuto, y no cuesta una consulta por petición.
        assert (await http.patch(ruta, json={"title": "Temario"})).status_code == 503
        assert (await http.get(f"{API}/availability")).json()["attachment_titles"] is False
        esquema._no_hasta["message_attachments.title"] = 0.0  # pasa el minuto
        assert (await http.get(f"{API}/availability")).json()["attachment_titles"] is True
        puesto = await http.patch(ruta, json={"title": "Temario"})
        assert puesto.status_code == 200, puesto.text
        assert puesto.json()["title"] == "Temario"
        [mensaje] = (await http.get(f"{API}/{grupo}/messages")).json()
        assert [(a["title"], a["voice_note"]) for a in mensaje["attachments"]] == [
            (None, True),
            ("Temario", False),
        ]
        archivo = await http.post(
            f"{API}/{grupo}/messages",
            json={
                "body": "",
                "attachments": [
                    {"storage_path": f"{grupo}/{ANA}/clase.mp3", "kind": "audio", "voice_note": False}
                ],
            },
        )
        assert archivo.status_code == 201, archivo.text
        assert archivo.json()["attachments"][0]["voice_note"] is False
        assert nota["voice_note"] is True
    finally:
        # Que el módulo siguiente encuentre lo que espera: deshacerla aquí no
        # hace falta (cada fichero rehace el esquema), pero sí no dejar la
        # caché de este proceso con un «sí» de otra base.
        esquema.olvidar()
