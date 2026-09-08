"""Borrar un curso: solo su autor, y solo si nadie lo compró."""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.catalog import esquema
from app.modules.catalog.models import Course
from app.modules.commerce import esquema as esquema_comercio
from app.modules.commerce.models import CommerceProduct, Entitlement, Order
from app.modules.gobernanza.models import AuditEvent
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db

CATALOGO = "/api/v1/catalog"
AUTORA = "aaaaaaaa-0000-0000-0000-000000000001"
AJENO = "bbbbbbbb-0000-0000-0000-000000000002"
CURSO = "cccccccc-0000-0000-0000-000000000001"
VENDIDO = "cccccccc-0000-0000-0000-000000000002"


@pytest_asyncio.fixture
async def entorno():
    esquema.olvidar()
    esquema_comercio.olvidar()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sesiones = async_sessionmaker(engine, expire_on_commit=False)

    async with sesiones() as db:
        db.add(Profile(id=AUTORA, full_name="Ana", username="ana"))
        db.add(Profile(id=AJENO, full_name="Bruno", username="bruno"))
        for cid in (CURSO, VENDIDO):
            db.add(
                Course(
                    id=cid,
                    author_id=AUTORA,
                    title="Respiración",
                    description="",
                    price_minor=4900,
                    currency="PEN",
                    status="draft",
                )
            )
        await db.flush()
        producto = CommerceProduct(course_id=VENDIDO)
        db.add(producto)
        await db.flush()
        db.add(
            Entitlement(
                user_id=AJENO,
                commerce_product_id=producto.id,
                status="active",
                source_provider="stripe",
            )
        )
        await db.commit()

    identidad = {"uid": AUTORA}

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
async def test_la_autora_borra_su_borrador_y_queda_constancia(entorno):
    http, _, sesiones = entorno
    respuesta = await http.delete(f"{CATALOGO}/courses/{CURSO}")
    assert respuesta.status_code == 204
    async with sesiones() as db:
        assert await db.get(Course, CURSO) is None
        notas = list(await db.scalars(select(AuditEvent)))
        assert [n.action for n in notas] == ["course.deleted"]


@pytest.mark.asyncio
async def test_un_curso_con_alumnos_NO_se_borra(entorno):
    """Es el fallo que esto cierra: el móvil lo borraba sin mirar."""
    http, _, sesiones = entorno
    respuesta = await http.delete(f"{CATALOGO}/courses/{VENDIDO}")
    assert respuesta.status_code == 409
    assert "course_has_buyers" in respuesta.text
    async with sesiones() as db:
        assert await db.get(Course, VENDIDO) is not None


@pytest.mark.asyncio
async def test_una_persona_ajena_no_puede_borrarlo(entorno):
    http, identidad, sesiones = entorno
    identidad["uid"] = AJENO
    respuesta = await http.delete(f"{CATALOGO}/courses/{CURSO}")
    assert respuesta.status_code in (403, 404)
    async with sesiones() as db:
        assert await db.get(Course, CURSO) is not None


@pytest.mark.asyncio
async def test_un_curso_que_no_existe_da_404(entorno):
    http, _, _ = entorno
    respuesta = await http.delete(
        f"{CATALOGO}/courses/00000000-0000-0000-0000-0000000000ff"
    )
    assert respuesta.status_code == 404


@pytest.mark.asyncio
async def test_borrar_dos_veces_no_deja_dos_notas(entorno):
    http, _, sesiones = entorno
    primera = await http.delete(f"{CATALOGO}/courses/{CURSO}")
    segunda = await http.delete(f"{CATALOGO}/courses/{CURSO}")
    assert primera.status_code == 204
    assert segunda.status_code == 404
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(AuditEvent)) == 1


@pytest.mark.asyncio
async def test_una_orden_pagada_tambien_lo_protege(entorno):
    """Aunque el derecho se haya revocado: alguien pagó por él."""
    http, _, sesiones = entorno
    async with sesiones() as db:
        producto = await db.scalar(
            select(CommerceProduct).where(CommerceProduct.course_id == VENDIDO)
        )
        derecho = await db.scalar(select(Entitlement))
        derecho.status = "revoked"
        db.add(
            Order(
                user_id=AJENO,
                commerce_product_id=producto.id,
                provider="stripe",
                channel="web",
                environment="sandbox",
                status="paid",
                amount_minor=4900,
                currency="PEN",
            )
        )
        await db.commit()

    respuesta = await http.delete(f"{CATALOGO}/courses/{VENDIDO}")
    assert respuesta.status_code == 409
