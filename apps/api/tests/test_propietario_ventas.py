"""La vista comercial del propietario, de punta a punta.

LO QUE PROTEGEN ESTAS PRUEBAS:

1. **Quien ve el dinero.** El autor, y la administracion. Nadie mas. Un fallo
   aqui no da un error: publica cuanto factura otra persona.
2. **Lo que NUNCA sale.** Se comprueba el TEXTO CRUDO de la respuesta, no los
   campos del esquema: un campo nuevo que se cuele por un `model_dump` no lo
   detectaria una comprobacion campo a campo, y esto si.
3. **Que sin la 0049 responda ceros y no un 500.**
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.catalog.models import Course
from app.modules.commerce.models import (
    CommerceProduct,
    Order,
    OwnerSaleBalance,
    PaymentTransaction,
)
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.shared.database import Base, get_db

COMERCIO = "/api/v1/commerce"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"  # compradora
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"  # autor del curso
JEFA = "aaaaaaaa-0000-0000-0000-000000000003"  # administracion
CARLA = "aaaaaaaa-0000-0000-0000-000000000004"  # ajena
MODERA = "aaaaaaaa-0000-0000-0000-000000000005"  # modera contenido, no dinero
CURSO = "cccccccc-0000-0000-0000-000000000001"
OTRO_CURSO = "cccccccc-0000-0000-0000-000000000002"
ORDEN_A = "00000000-0000-0000-0000-0000000000a1"
ORDEN_C = "00000000-0000-0000-0000-0000000000a2"
PRECIO = 19900


@pytest_asyncio.fixture
async def entorno():
    """Curso de Bruno con dos ventas: una viva y una devuelta."""
    esquema.olvidar()

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana Perez", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(Profile(id=JEFA, full_name="Jefa", username="jefa", role="admin"))
        db.add(Profile(id=CARLA, full_name="Carla", username="carla"))
        db.add(
            Profile(
                id=MODERA, full_name="Modera", username="modera", role="moderator"
            )
        )
        db.add(
            Course(
                id=CURSO,
                author_id=BRUNO,
                title="Curso de pago",
                price_minor=PRECIO,
                currency="PEN",
                status="published",
            )
        )
        db.add(
            Course(
                id=OTRO_CURSO,
                author_id=CARLA,
                title="Curso de Carla",
                price_minor=PRECIO,
                currency="PEN",
                status="published",
            )
        )
        producto = CommerceProduct(course_id=CURSO)
        db.add(producto)
        await db.flush()

        for orden_id, comprador, estado_orden in (
            (ORDEN_A, ANA, "paid"),
            (ORDEN_C, CARLA, "refunded"),
        ):
            db.add(
                Order(
                    id=orden_id,
                    user_id=comprador,
                    commerce_product_id=producto.id,
                    provider="stripe",
                    channel="web",
                    environment="sandbox",
                    status=estado_orden,
                    amount_minor=PRECIO,
                    currency="PEN",
                )
            )
        # El identificador de la pasarela existe en la base: si el endpoint lo
        # filtrara, la prueba del texto crudo lo veria.
        db.add(
            PaymentTransaction(
                order_id=ORDEN_A,
                provider="stripe",
                environment="sandbox",
                external_transaction_id="pi_secreto_de_stripe",
                kind="purchase",
                amount_minor=PRECIO,
                currency="PEN",
            )
        )
        db.add(
            OwnerSaleBalance(
                order_id=ORDEN_A,
                course_id=CURSO,
                owner_id=BRUNO,
                gross_amount_minor=PRECIO,
                platform_fee_minor=1990,
                provider_fee_minor=10,
                net_amount_minor=PRECIO - 1990 - 10,
                currency="PEN",
                fee_rules_version="v1",
                status="pending",
            )
        )
        db.add(
            OwnerSaleBalance(
                order_id=ORDEN_C,
                course_id=CURSO,
                owner_id=BRUNO,
                gross_amount_minor=PRECIO,
                platform_fee_minor=1990,
                provider_fee_minor=10,
                net_amount_minor=PRECIO - 1990 - 10,
                currency="PEN",
                fee_rules_version="v1",
                status="cancelled",
            )
        )
        await db.commit()

    identidad = {"uid": BRUNO}

    async def _db_override():
        async with sesiones() as sesion:
            yield sesion

    async def _usuario() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, identidad, sesiones
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    await engine.dispose()


# --------------------------------------------------------------------------- #
# Quien puede ver que
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_el_autor_ve_su_resumen(entorno):
    http, _, _ = entorno
    respuesta = await http.get(f"{COMERCIO}/courses/{CURSO}/summary")
    assert respuesta.status_code == 200, respuesta.text
    cuerpo = respuesta.json()
    assert cuerpo["course_id"] == CURSO
    assert cuerpo["paid_students"] == 1
    assert cuerpo["refunds"] == 1
    # La venta cancelada NO suma al neto: ese dinero ya no es de nadie.
    assert cuerpo["net_amount_minor"] == PRECIO - 1990 - 10
    assert cuerpo["balances"]["pending"]["count"] == 1
    assert cuerpo["balances"]["cancelled"]["count"] == 1
    # Las siete claves estan siempre, aunque valgan cero.
    for estado in (
        "pending", "frozen", "eligible", "transferring", "transferred",
        "cancelled", "failed",
    ):
        assert estado in cuerpo["balances"]


@pytest.mark.asyncio
async def test_un_usuario_ajeno_recibe_403(entorno):
    http, identidad, _ = entorno
    identidad["uid"] = CARLA
    assert (await http.get(f"{COMERCIO}/courses/{CURSO}/summary")).status_code == 403
    assert (await http.get(f"{COMERCIO}/courses/{CURSO}/sales")).status_code == 403


@pytest.mark.asyncio
async def test_la_compradora_tampoco_ve_las_ventas(entorno):
    """Haber comprado no da acceso a la contabilidad de quien vende."""
    http, identidad, _ = entorno
    identidad["uid"] = ANA
    assert (await http.get(f"{COMERCIO}/courses/{CURSO}/summary")).status_code == 403


@pytest.mark.asyncio
async def test_la_administracion_lo_ve_todo(entorno):
    http, identidad, _ = entorno
    identidad["uid"] = JEFA
    respuesta = await http.get(f"{COMERCIO}/courses/{CURSO}/summary")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["paid_students"] == 1


@pytest.mark.asyncio
async def test_quien_solo_modera_no_ve_la_caja_de_nadie(entorno):
    """MODERAR CONTENIDO Y MIRAR EL DINERO DE OTRO SON DOS PERMISOS DISTINTOS.

    Aqui lo eran solo en el nombre: el guardia usaba `is_admin`, que incluye a
    `moderator`, asi que la cuenta creada para ocultar una publicacion o
    resolver un reporte veia importes brutos, comision de plataforma, neto del
    autor y el listado de ventas de CUALQUIER curso.
    """
    http, identidad, _ = entorno
    identidad["uid"] = MODERA
    assert (await http.get(f"{COMERCIO}/courses/{CURSO}/summary")).status_code == 403
    assert (await http.get(f"{COMERCIO}/courses/{CURSO}/sales")).status_code == 403


@pytest.mark.asyncio
async def test_el_autor_no_ve_el_curso_de_otro(entorno):
    http, _, _ = entorno
    assert (
        await http.get(f"{COMERCIO}/courses/{OTRO_CURSO}/summary")
    ).status_code == 403


@pytest.mark.asyncio
async def test_un_curso_que_no_existe_es_404(entorno):
    http, _, _ = entorno
    inexistente = "cccccccc-0000-0000-0000-00000000ffff"
    assert (
        await http.get(f"{COMERCIO}/courses/{inexistente}/summary")
    ).status_code == 404


# --------------------------------------------------------------------------- #
# Las ventas
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_las_ventas_salen_paginadas_y_con_lo_justo(entorno):
    http, _, _ = entorno
    respuesta = await http.get(f"{COMERCIO}/courses/{CURSO}/sales")
    assert respuesta.status_code == 200, respuesta.text
    ventas = respuesta.json()
    assert len(ventas) == 2
    primera = ventas[0]
    assert primera["currency"] == "PEN"
    assert primera["gross_amount_minor"] == PRECIO
    assert primera["net_amount_minor"] == PRECIO - 1990 - 10
    assert primera["status"] in ("pending", "cancelled")
    assert primera["sold_at"]
    # Del comprador, lo minimo y nada mas.
    assert set(primera["buyer"]) == {"id", "name", "username", "avatar_path"}

    una = await http.get(f"{COMERCIO}/courses/{CURSO}/sales?limit=1")
    assert len(una.json()) == 1


# --------------------------------------------------------------------------- #
# Lo que NUNCA se filtra
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_no_se_filtra_nada_sensible(entorno):
    """Se mira el TEXTO CRUDO, no los campos: un campo nuevo tambien se ve."""
    http, _, _ = entorno
    crudo = (await http.get(f"{COMERCIO}/courses/{CURSO}/summary")).text
    crudo += (await http.get(f"{COMERCIO}/courses/{CURSO}/sales")).text

    prohibidos = (
        "pi_secreto_de_stripe",  # identificador de la pasarela
        "explanation",           # motivo privado de la devolucion
        "review_notes",          # notas de quien revisa
        "reviewer_id",
        "external_refund_id",
        "external_transaction_id",
        "frozen_by_request_id",
        "payout_account_id",
        "email",
    )
    for prohibido in prohibidos:
        assert prohibido not in crudo, f"se filtro '{prohibido}'"


# --------------------------------------------------------------------------- #
# Sin la 0049
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_sin_liquidaciones_responde_ceros_y_no_un_500(entorno, monkeypatch):
    http, _, _ = entorno

    async def _no_hay(_db):
        return False

    monkeypatch.setattr(
        "app.modules.refunds.esquema.hay_liquidaciones", _no_hay
    )
    respuesta = await http.get(f"{COMERCIO}/courses/{CURSO}/summary")
    assert respuesta.status_code == 200, respuesta.text
    cuerpo = respuesta.json()
    assert cuerpo["settlement_available"] is False
    assert cuerpo["paid_students"] == 0
    assert cuerpo["net_amount_minor"] == 0
    assert cuerpo["balances"]["pending"]["count"] == 0

    ventas = await http.get(f"{COMERCIO}/courses/{CURSO}/sales")
    assert ventas.status_code == 200
    assert ventas.json() == []
