"""Borrar la cuenta sin PostgreSQL: el orden y los fallos del servicio.

Las reglas de la base (claves ajenas, historiales, la 0089) solo se pueden
probar contra PostgreSQL: están en `test_baja_de_cuenta_postgres.py`. Estas
cubren el CONTRATO del servicio (`modules/identity/baja.py`) donde no hay
PostgreSQL, que es la suite de siempre:

  - borra la cuenta y SUS archivos, no los de otra persona;
  - si Storage no contesta, no borra nada y responde 503;
  - si la base lo impide, responde 409 y NO TOCA NINGÚN ARCHIVO;
  - sin la 0089, ese fallo no se presenta como «tienes ventas» (503);
  - repetir es seguro.
"""

from __future__ import annotations

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.security import AuthUser, get_current_user
from app.main import create_app
from app.modules.identity import baja
from app.modules.profiles.models import Profile
from app.shared import storage
from app.shared.database import Base, get_db
from tests.test_baja_de_cuenta_postgres import ALMACEN, StorageDeMentira, _ClienteReal

pytestmark = pytest.mark.asyncio

ANA = "11111111-1111-4111-8111-111111111111"
BEA = "22222222-2222-4222-8222-222222222222"
ME = "/api/v1/auth/me"


class _Causa(Exception):
    table_name = "product_orders"
    constraint_name = "product_orders_buyer_id_fkey"


class _Original(Exception):
    sqlstate = "23503"


def _choque() -> IntegrityError:
    original = _Original("violates foreign key constraint")
    original.__cause__ = _Causa()
    return IntegrityError("DELETE FROM profiles", {}, original)


class _SesionQueChoca(AsyncSession):
    """Como si la base dijera que la cuenta tiene un pedido (`restrict`)."""

    async def execute(self, sentencia, *args, **kwargs):
        if getattr(sentencia, "is_delete", False) and sentencia.table.name == "profiles":
            raise _choque()
        return await super().execute(sentencia, *args, **kwargs)


@pytest_asyncio.fixture()
async def entorno(monkeypatch):
    ajustes = get_settings()
    monkeypatch.setattr(ajustes, "supabase_url", ALMACEN)
    monkeypatch.setattr(ajustes, "supabase_service_role_key", "clave-de-prueba")
    almacen = StorageDeMentira()
    monkeypatch.setattr(
        storage.httpx, "AsyncClient",
        lambda **kw: _ClienteReal(transport=httpx.MockTransport(almacen.responder), **kw),
    )
    motor = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with motor.begin() as conexion:
        await conexion.run_sync(Base.metadata.create_all)
    normales = async_sessionmaker(motor, expire_on_commit=False)
    async with normales() as db:
        db.add_all([
            Profile(id=ANA, full_name="Ana", username="ana", role="user"),
            Profile(id=BEA, full_name="Bea", username="bea", role="user"),
        ])
        await db.commit()
    estado = {"sesiones": normales, "uid": ANA}
    app = create_app()

    async def _db():
        async with estado["sesiones"]() as db:
            yield db

    async def _usuario() -> AuthUser:
        return AuthUser(id=estado["uid"], email="x@y.test", role="authenticated")

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _usuario
    estado["chocar"] = lambda: estado.update(
        sesiones=async_sessionmaker(motor, expire_on_commit=False, class_=_SesionQueChoca)
    )
    try:
        yield app, normales, almacen, estado
    finally:
        app.dependency_overrides.clear()
        await motor.dispose()


async def _borrar(app) -> httpx.Response:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        return await http.delete(ME)


async def _existe(sesiones, uid: str) -> bool:
    async with sesiones() as db:
        return (await db.scalar(select(Profile).where(Profile.id == uid))) is not None


def _archivos(almacen) -> None:
    almacen.poner("post-media", f"{ANA}/foto.jpg", f"{ANA}/derived/m1/feed.mp4", f"{BEA}/suya.jpg")
    almacen.poner("service-provider-documents", f"{ANA}/solicitud/dni.png")


async def test_se_borra_la_cuenta_con_sus_archivos_y_no_los_ajenos(entorno) -> None:
    app, sesiones, almacen, _ = entorno
    _archivos(almacen)
    r = await _borrar(app)
    assert r.status_code == 204, r.text
    assert not await _existe(sesiones, ANA) and await _existe(sesiones, BEA)
    assert almacen.de("post-media", ANA) == [] and almacen.de("service-provider-documents", ANA) == []
    assert almacen.de("post-media", BEA) == [f"{BEA}/suya.jpg"]


async def test_si_storage_no_contesta_no_se_borra_nada(entorno) -> None:
    app, sesiones, almacen, _ = entorno
    _archivos(almacen)
    almacen.fallar_en = {"avatars"}
    r = await _borrar(app)
    assert r.status_code == 503 and r.json()["error"]["code"] == "account_deletion_storage_failed", r.text
    assert await _existe(sesiones, ANA)
    assert len(almacen.de("post-media", ANA)) == 2 and almacen.borrados == []


async def test_si_la_base_lo_impide_es_409_y_no_se_toca_ningun_archivo(entorno) -> None:
    app, sesiones, almacen, estado = entorno
    _archivos(almacen)
    estado["chocar"]()
    r = await _borrar(app)
    assert r.status_code == 409, r.text
    assert r.json()["error"] == {
        "code": "account_deletion_blocked",
        "message": baja.CuentaConRegistrosQueConservar.message,
        "details": {"reason": "products"},
    }
    assert await _existe(sesiones, ANA)
    assert almacen.borrados == [] and len(almacen.de("post-media", ANA)) == 2


async def test_sin_la_0089_un_choque_no_se_presenta_como_ventas(entorno, monkeypatch) -> None:
    """Antes de aplicar la 0089, el choque de la auditoría también es un 23xxx.
    Decir «tienes ventas» sería mentir: 503 y la cuenta sigue."""
    app, sesiones, almacen, estado = entorno

    async def _sin_0089(db):
        return False

    monkeypatch.setattr(baja, "_hay_0089", _sin_0089)
    estado["chocar"]()
    r = await _borrar(app)
    assert r.status_code == 503 and r.json()["error"]["code"] == "account_deletion_unavailable", r.text
    assert await _existe(sesiones, ANA)


async def test_repetir_la_baja_es_seguro(entorno) -> None:
    app, sesiones, almacen, _ = entorno
    _archivos(almacen)
    assert (await _borrar(app)).status_code == 204
    assert (await _borrar(app)).status_code == 204
    assert not await _existe(sesiones, ANA)


@pytest.mark.parametrize(
    ("tabla", "area"),
    [
        ("product_orders", "products"), ("products", "products"), ("owner_sale_balances", "earnings"),
        ("owner_transfers", "earnings"), ("event_orders", "events"), ("event_ticket_hold_items", "events"),
        ("orders", "courses"), ("commerce_products", "courses"), ("purchases", "courses"),
        ("refund_requests", "courses"), (None, "records"), ("algo_nuevo", "records"),
    ],
)
async def test_el_area_del_bloqueo_nunca_dice_la_tabla(tabla, area) -> None:
    assert baja._area(tabla) == area
