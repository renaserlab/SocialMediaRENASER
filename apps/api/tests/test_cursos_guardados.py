"""Guardar un curso para después: idempotencia, orden y quién ve qué."""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.catalog import esquema
from app.modules.catalog.models import Course, SavedCourse
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db

CATALOGO = "/api/v1/catalog"
ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "bbbbbbbb-0000-0000-0000-000000000002"
CURSO = "cccccccc-0000-0000-0000-000000000001"
OTRO = "cccccccc-0000-0000-0000-000000000002"
BORRADOR = "cccccccc-0000-0000-0000-000000000003"


@pytest_asyncio.fixture
async def entorno():
    esquema.olvidar()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sesiones = async_sessionmaker(engine, expire_on_commit=False)

    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        for cid, titulo, estado in (
            (CURSO, "Respiración", "published"),
            (OTRO, "Finanzas", "published"),
            (BORRADOR, "Sin publicar", "draft"),
        ):
            db.add(
                Course(
                    id=cid,
                    author_id=BRUNO,
                    title=titulo,
                    description="",
                    price_minor=4900,
                    currency="PEN",
                    status=estado,
                )
            )
        await db.commit()

    identidad = {"uid": ANA}

    async def _db():
        async with sesiones() as sesion:
            yield sesion

    async def _usuario() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _usuario
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, identidad, sesiones
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    await engine.dispose()


@pytest.mark.asyncio
async def test_guardar_dos_veces_deja_una_sola_fila(entorno):
    """La clave primaria compuesta es la que lo impide, no un `if`."""
    http, _, sesiones = entorno
    primera = await http.put(f"{CATALOGO}/courses/{CURSO}/saved")
    segunda = await http.put(f"{CATALOGO}/courses/{CURSO}/saved")
    assert primera.status_code == 204
    assert segunda.status_code == 204
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(SavedCourse)) == 1


@pytest.mark.asyncio
async def test_quitar_dos_veces_no_es_un_error(entorno):
    http, _, sesiones = entorno
    await http.put(f"{CATALOGO}/courses/{CURSO}/saved")
    primera = await http.delete(f"{CATALOGO}/courses/{CURSO}/saved")
    segunda = await http.delete(f"{CATALOGO}/courses/{CURSO}/saved")
    assert primera.status_code == 204
    assert segunda.status_code == 204
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(SavedCourse)) == 0


@pytest.mark.asyncio
async def test_cada_persona_ve_solo_lo_suyo(entorno):
    http, identidad, _ = entorno
    await http.put(f"{CATALOGO}/courses/{CURSO}/saved")
    identidad["uid"] = BRUNO
    mios = (await http.get(f"{CATALOGO}/courses/saved")).json()
    assert mios == []
    identidad["uid"] = ANA
    mios = (await http.get(f"{CATALOGO}/courses/saved")).json()
    assert [c["id"] for c in mios] == [CURSO]


@pytest.mark.asyncio
async def test_un_borrador_ajeno_no_se_puede_guardar(entorno):
    """404 y no 403: decir «prohibido» confirmaría que ese curso existe."""
    http, _, _ = entorno
    respuesta = await http.put(f"{CATALOGO}/courses/{BORRADOR}/saved")
    assert respuesta.status_code == 404


@pytest.mark.asyncio
async def test_un_curso_inexistente_responde_igual_que_uno_oculto(entorno):
    http, _, _ = entorno
    oculto = await http.put(f"{CATALOGO}/courses/{BORRADOR}/saved")
    inexistente = await http.put(
        f"{CATALOGO}/courses/00000000-0000-0000-0000-0000000000ff/saved"
    )
    assert oculto.status_code == inexistente.status_code == 404
    assert oculto.json() == inexistente.json()


@pytest.mark.asyncio
async def test_un_identificador_que_no_es_uuid_no_revienta(entorno):
    http, _, _ = entorno
    respuesta = await http.put(f"{CATALOGO}/courses/no-soy-uuid/saved")
    assert respuesta.status_code in (404, 422)


@pytest.mark.asyncio
async def test_la_lista_pagina_con_un_orden_estable(entorno):
    """Sin desempate, dos guardados del mismo instante bailan entre páginas."""
    http, _, _ = entorno
    await http.put(f"{CATALOGO}/courses/{CURSO}/saved")
    await http.put(f"{CATALOGO}/courses/{OTRO}/saved")

    primera = (await http.get(f"{CATALOGO}/courses/saved?limit=1&offset=0")).json()
    segunda = (await http.get(f"{CATALOGO}/courses/saved?limit=1&offset=1")).json()
    assert len(primera) == len(segunda) == 1
    assert primera[0]["id"] != segunda[0]["id"], "la misma fila en las dos páginas"

    # Y repetir la consulta da lo mismo: el orden no depende de la suerte.
    repetida = (await http.get(f"{CATALOGO}/courses/saved?limit=1&offset=0")).json()
    assert repetida[0]["id"] == primera[0]["id"]


@pytest.mark.asyncio
async def test_sin_la_migracion_se_dice_en_vez_de_fingir(entorno):
    """503 y no una lista vacía: vacío haría pensar que no guardó nada."""
    http, _, sesiones = entorno
    async with sesiones() as db:
        await db.execute(text("drop table saved_courses"))
        await db.commit()
    esquema.olvidar()

    assert (await http.get(f"{CATALOGO}/courses/saved")).status_code == 503
    assert (await http.put(f"{CATALOGO}/courses/{CURSO}/saved")).status_code == 503
