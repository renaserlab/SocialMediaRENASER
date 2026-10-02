"""Borrar la cuenta sin PostgreSQL: el orden y los fallos del servicio.

Las reglas de la base (claves ajenas, historiales, la 0089) solo se pueden
probar contra PostgreSQL: están en `test_baja_de_cuenta_postgres.py`. Estas
cubren el CONTRATO del servicio (`modules/identity/baja.py`) donde no hay
PostgreSQL, que es la suite de siempre:

  - borra la cuenta y SUS archivos, no los de otra persona;
  - si Storage no contesta, no borra nada y responde 503;
  - si la base lo impide, responde 409 y NO TOCA NINGÚN ARCHIVO;
  - sin la 0089 completa, 503 antes de tocar nada;
  - con historia contractual de Servicios (F21), 409 antes de borrar o de
    tocar un archivo; y si no se puede mirar, 503;
  - la puerta de la 0089 se cierra ante cualquier fallo al mirar y guarda
    su respuesta hasta el próximo reinicio;
  - repetir es seguro.
"""

from __future__ import annotations

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.security import AuthUser, get_current_user
from app.main import create_app
from app.modules.identity import baja
from app.modules.profiles.models import Profile
from app.modules.services import conservacion
from app.modules.services.models import ServiceProvider
from app.modules.services.reserva_models import ServiceOrder
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


async def test_sin_la_0089_completa_no_se_toca_nada(entorno, monkeypatch) -> None:
    """Sin la 0089 completa, borrar podría chocar con un historial (y decir
    «tienes ventas» sería mentir) o llevarse una orden con dinero. La puerta va
    PRIMERO: 503, la cuenta sigue y no se ha borrado ningún archivo."""
    app, sesiones, almacen, estado = entorno
    _archivos(almacen)

    async def _sin_0089(db):
        return False

    monkeypatch.setattr(baja, "_hay_0089", _sin_0089)
    estado["chocar"]()
    r = await _borrar(app)
    assert r.status_code == 503, r.text
    assert r.json()["error"] == {
        "code": "account_deletion_unavailable", "message": baja.BajaNoDisponible.message, "details": None,
    }
    assert await _existe(sesiones, ANA)
    assert almacen.borrados == [] and len(almacen.de("post-media", ANA)) == 2


# --------------------------------------------------------------------------- #
# F21: la historia contractual de Servicios, antes de todo lo demás
# --------------------------------------------------------------------------- #
async def _con_un_pedido(sesiones, *, contrata: str, presta: str) -> None:
    """Un pedido de Servicios entre dos personas. Con sus modelos y en SQLite:
    la consulta es la misma en los dos motores."""
    from datetime import UTC, datetime
    from uuid import uuid4

    async with sesiones() as db:
        prestador = ServiceProvider(profile_id=presta, provider_type="individual", display_name="Clases")
        db.add(prestador)
        await db.flush()
        db.add(ServiceOrder(
            service_id=str(uuid4()), version_id=str(uuid4()), provider_id=prestador.id, client_id=contrata,
            environment="sandbox", price_model="free", title_snapshot="Clase de guitarra",
            provider_name_snapshot="Clases", confirmed_at=datetime.now(UTC),
        ))
        await db.commit()


@pytest.mark.parametrize("como", ["cliente", "prestador"])
async def test_con_historia_de_servicios_es_409_antes_de_borrar_y_de_tocar_un_archivo(entorno, como) -> None:
    app, sesiones, almacen, estado = entorno
    _archivos(almacen)
    if como == "cliente":
        await _con_un_pedido(sesiones, contrata=ANA, presta=BEA)
    else:
        await _con_un_pedido(sesiones, contrata=BEA, presta=ANA)
    # Si llegara a borrar, la base «chocaría» (otro código): no llega.
    estado["chocar"]()
    for _ in range(2):  # y repetir no cambia la respuesta
        r = await _borrar(app)
        assert r.status_code == 409, r.text
        assert r.json()["error"] == {
            "code": "service_history_requires_support", "message": baja.HistoriaDeServicios.message, "details": None,
        }
        assert await _existe(sesiones, ANA)
        assert almacen.borrados == [] and len(almacen.de("post-media", ANA)) == 2
    # La respuesta no dice qué tiene ni cuánto, remite a soporte y NO PROMETE
    # cerrar la cuenta: hoy nadie puede cerrarla sin destruir su historia.
    mensaje = r.json()["error"]["message"]
    assert "service_orders" not in r.text and "1" not in mensaje
    assert "soporte" in mensaje and "no se puede eliminar de forma automática" in mensaje
    assert "cerramos" not in mensaje and "la cerraremos" not in mensaje


async def test_la_historia_de_otra_persona_no_frena_la_mia(entorno) -> None:
    app, sesiones, _, _ = entorno
    await _con_un_pedido(sesiones, contrata=BEA, presta=BEA)
    assert (await _borrar(app)).status_code == 204
    assert not await _existe(sesiones, ANA) and await _existe(sesiones, BEA)
    async with sesiones() as db:
        assert len((await db.execute(select(ServiceOrder.id))).all()) == 1


async def test_si_no_se_puede_mirar_la_historia_es_503_y_no_se_toca_nada(entorno, monkeypatch, caplog) -> None:
    """Cerrada ante cualquier fallo al mirar: una cuenta que no se pudo mirar
    no se da por limpia. Ni se borra, ni se llama a Storage, ni es un 204."""
    import logging

    app, sesiones, almacen, estado = entorno
    _archivos(almacen)

    async def _revienta(db, perfil_id):
        raise RuntimeError("la base no contesta")

    monkeypatch.setattr(conservacion, "de_la_persona", _revienta)
    with caplog.at_level(logging.WARNING):
        r = await _borrar(app)
    assert r.status_code == 503, r.text
    assert r.json()["error"] == {
        "code": "account_deletion_unavailable", "message": baja.BajaNoDisponible.message, "details": None,
    }
    assert "No se pudo mirar la historia de Servicios" in caplog.text
    assert await _existe(sesiones, ANA)
    assert almacen.borrados == [] and len(almacen.de("post-media", ANA)) == 2


async def test_la_puerta_de_la_0089_va_antes_que_la_historia(entorno, monkeypatch) -> None:
    app, sesiones, almacen, _ = entorno
    await _con_un_pedido(sesiones, contrata=ANA, presta=BEA)
    miradas = []

    async def _sin_0089(db):
        return False

    async def _mirar(db, perfil_id):
        miradas.append(perfil_id)
        return ()

    monkeypatch.setattr(baja, "_hay_0089", _sin_0089)
    monkeypatch.setattr(conservacion, "de_la_persona", _mirar)
    r = await _borrar(app)
    assert r.status_code == 503 and r.json()["error"]["code"] == "account_deletion_unavailable", r.text
    assert miradas == [] and almacen.borrados == []


#: Lo que añade cada migración de la contratación (0093) y de la atención (0094).
_DE_LA_0094 = ("service_reviews", "service_incident_entries", "service_incidents", "service_attendances")
_DE_LA_0093 = ("service_booking_events", "service_booking_acceptances", "service_booking_intakes",
               "service_bookings", "service_orders")


async def _sin_las_tablas(sesiones, *tablas: str) -> None:
    from sqlalchemy import text

    async with sesiones() as db:
        for tabla in tablas:
            await db.execute(text(f"drop table {tabla}"))
        await db.commit()


async def test_una_base_anterior_a_la_contratacion_no_rompe_la_baja(entorno) -> None:
    """Hallazgo de la revisión (02/10/2026). El código no exige que su
    migración esté aplicada: en una base sin las tablas de la contratación no
    puede haber historia contractual, y la baja sigue como siempre. Antes
    contestaba 503 para siempre."""
    app, sesiones, almacen, _ = entorno
    _archivos(almacen)
    await _sin_las_tablas(sesiones, *_DE_LA_0094, *_DE_LA_0093)
    assert (await _borrar(app)).status_code == 204
    assert not await _existe(sesiones, ANA)


async def test_con_la_contratacion_y_sin_la_atencion_se_mira_lo_que_hay(entorno) -> None:
    """Una base con la 0093 y sin la 0094: las familias de la atención no
    pueden tener nada, y las de la contratación se miran igual."""
    app, sesiones, almacen, estado = entorno
    await _con_un_pedido(sesiones, contrata=ANA, presta=BEA)
    await _sin_las_tablas(sesiones, *_DE_LA_0094)
    r = await _borrar(app)
    assert r.status_code == 409 and r.json()["error"]["code"] == "service_history_requires_support", r.text
    assert await _existe(sesiones, ANA) and almacen.borrados == []
    # Y quien no tiene nada en las que hay, se borra.
    estado["uid"] = "33333333-3333-4333-8333-333333333333"
    async with sesiones() as db:
        db.add(Profile(id=estado["uid"], full_name="Cora", username="cora", role="user"))
        await db.commit()
    assert (await _borrar(app)).status_code == 204


async def test_si_no_se_puede_saber_que_tablas_hay_es_503(entorno, monkeypatch) -> None:
    app, sesiones, almacen, _ = entorno

    async def _revienta(db):
        raise RuntimeError("el catálogo no contesta")

    monkeypatch.setattr(conservacion, "_tablas", _revienta)
    r = await _borrar(app)
    assert r.status_code == 503 and r.json()["error"]["code"] == "account_deletion_unavailable", r.text
    assert await _existe(sesiones, ANA) and almacen.borrados == []


class _Interbloqueo(Exception):
    sqlstate = "40P01"


class _SesionInterbloqueada(AsyncSession):
    """Como si PostgreSQL deshiciera la baja por un interbloqueo al borrar."""

    async def execute(self, sentencia, *args, **kwargs):
        if getattr(sentencia, "is_delete", False) and sentencia.table.name == "profiles":
            raise DBAPIError("DELETE FROM profiles", {}, _Interbloqueo("deadlock detected"))
        return await super().execute(sentencia, *args, **kwargs)


async def test_un_interbloqueo_al_borrar_es_503_y_se_puede_reintentar(entorno) -> None:
    """La última red: si la baja y otra operación de la misma cuenta se
    esperan la una a la otra, no es un 500. No se borró nada ni se tocó un
    archivo, y repetir la petición la termina."""
    app, sesiones, almacen, estado = entorno
    _archivos(almacen)
    normales = estado["sesiones"]
    estado["sesiones"] = async_sessionmaker(normales.kw["bind"], expire_on_commit=False, class_=_SesionInterbloqueada)
    r = await _borrar(app)
    assert r.status_code == 503 and r.json()["error"]["code"] == "account_deletion_unavailable", r.text
    assert await _existe(sesiones, ANA)
    assert almacen.borrados == [] and len(almacen.de("post-media", ANA)) == 2
    estado["sesiones"] = normales
    assert (await _borrar(app)).status_code == 204


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


async def test_lo_de_despues_de_confirmar_nunca_se_escapa(monkeypatch, caplog) -> None:
    """Cualquier fallo al retirar lo ajeno (no solo los de Storage) se registra:
    la cuenta ya está borrada y nada de esto puede convertirse en un error."""
    import logging

    async def revienta(conversaciones):
        raise AttributeError("respuesta inesperada")

    monkeypatch.setattr(storage, "borrar_conversaciones", revienta)
    with caplog.at_level(logging.ERROR):
        await baja.retirar_conversaciones(ANA, ["c-1", "c-2"])
    registro = " ".join(r.getMessage() for r in caplog.records)
    assert "c-1" in registro and "c-2" in registro


# --------------------------------------------------------------------------- #
# La puerta de la 0089, sin base: cerrada ante la duda, y lo que recuerda
# --------------------------------------------------------------------------- #
class _SesionDePuerta:
    """Lo que la puerta usa de la sesión. `respuestas`: lo que contesta cada
    consulta, en orden; una excepción se lanza."""

    def __init__(self, *respuestas, conexion_rota: bool = False) -> None:
        self.respuestas = list(respuestas)
        self.consultas = 0
        self.conexion_rota = conexion_rota

    async def connection(self):
        from types import SimpleNamespace

        if self.conexion_rota:
            raise OSError("la base no contesta")
        return SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))

    async def scalar(self, sentencia):
        self.consultas += 1
        respuesta = self.respuestas.pop(0)
        if isinstance(respuesta, Exception):
            raise respuesta
        return respuesta


@pytest.fixture()
def puerta_limpia():
    baja.olvidar()
    yield
    baja.olvidar()


@pytest.mark.parametrize(
    "fallo",
    [
        IntegrityError("select", {}, _Original("x")),
        DBAPIError("select", {}, Exception("timeout")),
        RuntimeError("inesperado"),
    ],
)
async def test_la_puerta_se_cierra_si_falla_al_mirar(puerta_limpia, fallo, caplog) -> None:
    import logging

    sesion = _SesionDePuerta(fallo, True)
    with caplog.at_level(logging.WARNING):
        assert await baja._hay_0089(sesion) is False
    assert "No se pudo comprobar la 0089" in caplog.text
    # El fallo NO se recuerda: la siguiente vez vuelve a mirar.
    assert await baja._hay_0089(sesion) is True
    assert sesion.consultas == 2


async def test_la_puerta_se_cierra_si_no_hay_conexion(puerta_limpia) -> None:
    assert await baja._hay_0089(_SesionDePuerta(conexion_rota=True)) is False


async def test_la_puerta_recuerda_el_si_y_el_no_hasta_olvidar(puerta_limpia) -> None:
    """Como la de Servicios: se mira una vez por proceso. Tras aplicar una
    migración hay que reiniciar la API (`olvidar` hace lo mismo en pruebas)."""
    si = _SesionDePuerta(1)
    assert await baja._hay_0089(si) is True and await baja._hay_0089(si) is True
    assert si.consultas == 1
    baja.olvidar()
    no = _SesionDePuerta(False)
    assert await baja._hay_0089(no) is False and await baja._hay_0089(no) is False
    assert no.consultas == 1


async def test_la_puerta_no_mira_el_numero_de_la_migracion() -> None:
    """Mira capacidades del catálogo, no un número ni un historial de
    migraciones (que en Supabase ni se rellena al pegar el SQL a mano)."""
    sql = str(baja._LO_QUE_NECESITA_LA_BAJA).lower()
    assert "schema_migrations" not in sql and "0089" not in sql
    for pieza in (
        "es_anonimizacion_por_baja", "auditoria_solo_anadir", "event_orders_con_dinero_no_se_borran",
        "orders_con_dinero_no_se_borran", "tgenabled", "tgtype", "confdeltype", "attnotnull",
    ):
        assert pieza in sql, pieza
