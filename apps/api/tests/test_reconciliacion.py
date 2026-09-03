"""Conciliar con la pasarela, y el caso «Stripe apagado».

LO QUE PROTEGEN ESTAS PRUEBAS, y las tres cuestan dinero o acceso si fallan:

1. **Solo un exito confirmado retira el acceso.** `pending` y `failed` no tocan
   nada. Quitarle el curso a alguien antes de que le vuelva el dinero le deja
   sin las dos cosas.
2. **Conciliar dos veces no duplica nada.** Se pasa por el mismo camino que el
   webhook, que ya es idempotente.
3. **Apagado no es fallido.** Con `STRIPE_REFUNDS_ENABLED` en falso nunca se
   llamo a nadie, asi que el expediente no puede decir que la pasarela fallo.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.catalog.models import Course
from app.modules.commerce.models import (
    CommerceProduct,
    CourseEnrollment,
    Entitlement,
    Order,
    PaymentTransaction,
)
from app.modules.payments.reembolsos import RefundResult
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.refunds.models import RefundRequest
from app.shared.database import Base, get_db

PAGOS = "/api/v1/payments"
ADMIN = "/api/v1/admin"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"  # autor
JEFA = "aaaaaaaa-0000-0000-0000-000000000003"  # administracion
CURSO = "cccccccc-0000-0000-0000-000000000001"
ORDEN = "00000000-0000-0000-0000-0000000000a1"
ORDEN_2 = "00000000-0000-0000-0000-0000000000a2"
PRECIO = 19900


class _PasarelaDeMentira:
    """Contesta lo que le digan. No hace nada mas."""

    name = "mentira"

    def __init__(self, estado: str, *, codigo: str = "", mensaje: str = "") -> None:
        self.estado = estado
        self.codigo = codigo
        self.mensaje = mensaje
        self.consultas: list[str] = []

    async def create_full_refund(self, peticion):  # pragma: no cover
        return RefundResult(status=self.estado, external_refund_id="re_1")

    async def get_refund_status(self, external_refund_id: str) -> RefundResult:
        self.consultas.append(external_refund_id)
        # IMPORTE Y MONEDA, como la pasarela de verdad. Sin ellos la
        # conciliacion ya no cierra nada: comparar la orden consigo misma era
        # justo el agujero que se cerro.
        return RefundResult(
            status=self.estado,
            external_refund_id=external_refund_id,
            failure_code=getattr(self, "codigo", ""),
            failure_message=getattr(self, "mensaje", ""),
            amount_minor=PRECIO,
            currency="PEN",
        )


def _usar(monkeypatch, pasarela: _PasarelaDeMentira) -> _PasarelaDeMentira:
    monkeypatch.setattr(
        "app.modules.payments.reembolsos.proveedor_de_reembolsos",
        lambda: pasarela,
    )
    return pasarela


@pytest_asyncio.fixture
async def entorno():
    """Curso de pago de Bruno, comprado y pagado por Ana."""
    esquema.olvidar()
    ajustes = get_settings()
    anterior = {
        "feature_course_refunds": ajustes.feature_course_refunds,
        "stripe_refunds_enabled": ajustes.stripe_refunds_enabled,
        "stripe_payments_enabled": ajustes.stripe_payments_enabled,
    }
    ajustes.feature_course_refunds = True
    ajustes.stripe_refunds_enabled = False

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(Profile(id=JEFA, full_name="Jefa", username="jefa", role="admin"))
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
        producto = CommerceProduct(course_id=CURSO)
        db.add(producto)
        await db.flush()
        for orden_id, referencia in ((ORDEN, "pi_1"), (ORDEN_2, "pi_2")):
            db.add(
                Order(
                    id=orden_id,
                    user_id=ANA,
                    commerce_product_id=producto.id,
                    provider="stripe",
                    channel="web",
                    environment="sandbox",
                    status="paid",
                    amount_minor=PRECIO,
                    currency="PEN",
                )
            )
            db.add(
                PaymentTransaction(
                    order_id=orden_id,
                    provider="stripe",
                    environment="sandbox",
                    external_transaction_id=referencia,
                    kind="purchase",
                    amount_minor=PRECIO,
                    currency="PEN",
                )
            )
        db.add(
            Entitlement(
                user_id=ANA,
                commerce_product_id=producto.id,
                status="active",
                source_provider="stripe",
            )
        )
        db.add(CourseEnrollment(user_id=ANA, course_id=CURSO, source="entitlement"))
        await db.commit()

    identidad = {"uid": JEFA}

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
    for clave, valor in anterior.items():
        setattr(ajustes, clave, valor)


async def _sembrar_solicitud(
    sesiones,
    *,
    order_id: str = ORDEN,
    estado: str = "refund_processing",
    referencia: str | None = "re_1",
    antiguedad_horas: int = 0,
) -> str:
    """Un expediente ya en marcha, sin pasar por el circuito entero."""
    momento = datetime.now(timezone.utc) - timedelta(hours=antiguedad_horas)
    async with sesiones() as db:
        solicitud = RefundRequest(
            order_id=order_id,
            user_id=ANA,
            course_id=CURSO,
            status=estado,
            reason="not_as_expected",
            amount_minor=PRECIO,
            currency="PEN",
            external_refund_id=referencia,
            provider="stripe",
            environment="sandbox",
            updated_at=momento,
        )
        db.add(solicitud)
        await db.commit()
        return solicitud.id


async def _contar(sesiones, entidad, *filtros) -> int:
    async with sesiones() as db:
        return int(
            await db.scalar(select(func.count()).select_from(entidad).where(*filtros))
            or 0
        )


async def _estado(sesiones, request_id: str) -> str:
    async with sesiones() as db:
        return (await db.get(RefundRequest, request_id)).status


# --------------------------------------------------------------------------- #
# 1. Conciliar: exito
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_conciliar_con_exito_cierra_y_revoca(entorno, monkeypatch):
    http, _, sesiones = entorno
    pasarela = _usar(monkeypatch, _PasarelaDeMentira("succeeded"))
    solicitud = await _sembrar_solicitud(sesiones)

    respuesta = await http.post(f"{ADMIN}/refund-requests/{solicitud}/reconcile")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["status"] == "refunded"
    assert pasarela.consultas == ["re_1"]

    # El acceso se retira, la orden queda reembolsada y la matricula se conserva.
    assert await _contar(sesiones, Entitlement, Entitlement.status == "active") == 0
    assert await _contar(sesiones, Order, Order.status == "refunded") == 1
    assert await _contar(sesiones, CourseEnrollment) == 1


@pytest.mark.asyncio
async def test_conciliar_dos_veces_no_duplica_nada(entorno, monkeypatch):
    http, _, sesiones = entorno
    _usar(monkeypatch, _PasarelaDeMentira("succeeded"))
    solicitud = await _sembrar_solicitud(sesiones)

    primera = await http.post(f"{ADMIN}/refund-requests/{solicitud}/reconcile")
    assert primera.status_code == 200, primera.text
    segunda = await http.post(f"{ADMIN}/refund-requests/{solicitud}/reconcile")
    assert segunda.status_code == 200, segunda.text
    assert segunda.json()["status"] == "refunded"

    # UNA transaccion de reembolso, UN derecho revocado. No dos.
    assert (
        await _contar(
            sesiones, PaymentTransaction, PaymentTransaction.kind == "refund"
        )
        == 1
    )
    assert await _contar(sesiones, Entitlement, Entitlement.status == "revoked") == 1


# --------------------------------------------------------------------------- #
# 2. Conciliar: pendiente y fallo NO retiran acceso
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_conciliar_pendiente_no_cambia_estado_ni_revoca(entorno, monkeypatch):
    http, _, sesiones = entorno
    _usar(monkeypatch, _PasarelaDeMentira("pending"))
    solicitud = await _sembrar_solicitud(sesiones)

    respuesta = await http.post(f"{ADMIN}/refund-requests/{solicitud}/reconcile")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["status"] == "refund_processing"
    assert await _contar(sesiones, Entitlement, Entitlement.status == "active") == 1
    assert await _contar(sesiones, Order, Order.status == "refunded") == 0
    # Queda constancia, que es justo para lo que sirve conciliar.
    assert any(
        evento["reason"] and "pending" in evento["reason"]
        for evento in respuesta.json()["history"]
    )


@pytest.mark.asyncio
async def test_conciliar_fallido_marca_failed_y_no_revoca(entorno, monkeypatch):
    http, _, sesiones = entorno
    _usar(
        monkeypatch,
        _PasarelaDeMentira("failed", codigo="card_declined", mensaje="no pudo"),
    )
    solicitud = await _sembrar_solicitud(sesiones)

    respuesta = await http.post(f"{ADMIN}/refund-requests/{solicitud}/reconcile")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["status"] == "failed"
    assert await _contar(sesiones, Entitlement, Entitlement.status == "active") == 1


# --------------------------------------------------------------------------- #
# 3. Quien puede, y con que
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_sin_referencia_externa_es_un_error_claro(entorno, monkeypatch):
    http, _, sesiones = entorno
    _usar(monkeypatch, _PasarelaDeMentira("succeeded"))
    solicitud = await _sembrar_solicitud(sesiones, referencia=None)

    respuesta = await http.post(f"{ADMIN}/refund-requests/{solicitud}/reconcile")
    assert respuesta.status_code == 422, respuesta.text
    assert "refund_no_external_reference" in respuesta.text
    # Y no se ha tocado nada.
    assert await _estado(sesiones, solicitud) == "refund_processing"


@pytest.mark.asyncio
async def test_quien_no_es_administracion_no_concilia(entorno, monkeypatch):
    http, identidad, sesiones = entorno
    _usar(monkeypatch, _PasarelaDeMentira("succeeded"))
    solicitud = await _sembrar_solicitud(sesiones)
    identidad["uid"] = BRUNO  # el autor del curso: juez y parte

    respuesta = await http.post(f"{ADMIN}/refund-requests/{solicitud}/reconcile")
    assert respuesta.status_code == 403, respuesta.text
    assert await _contar(sesiones, Entitlement, Entitlement.status == "active") == 1


# --------------------------------------------------------------------------- #
# 4. La barrida de las estancadas
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_reconciliar_estancadas_solo_toca_las_viejas(entorno, monkeypatch):
    _, _, sesiones = entorno
    from app.modules.refunds.router import reconciliar_estancadas

    _usar(monkeypatch, _PasarelaDeMentira("succeeded"))
    vieja = await _sembrar_solicitud(sesiones, antiguedad_horas=72)
    reciente = await _sembrar_solicitud(
        sesiones, order_id=ORDEN_2, referencia="re_2", antiguedad_horas=0
    )

    async with sesiones() as db:
        hechas = await reconciliar_estancadas(db, horas=24, limite=50)
    assert hechas == 1
    assert await _estado(sesiones, vieja) == "refunded"
    assert await _estado(sesiones, reciente) == "refund_processing"


@pytest.mark.asyncio
async def test_reconciliar_estancadas_dos_veces_es_inofensivo(entorno, monkeypatch):
    _, _, sesiones = entorno
    from app.modules.refunds.router import reconciliar_estancadas

    _usar(monkeypatch, _PasarelaDeMentira("succeeded"))
    await _sembrar_solicitud(sesiones, antiguedad_horas=72)

    async with sesiones() as db:
        await reconciliar_estancadas(db, horas=24)
    async with sesiones() as db:
        # Ya no queda ninguna en `refund_processing`: la segunda pasada no
        # encuentra nada que hacer.
        assert await reconciliar_estancadas(db, horas=24) == 0
    assert (
        await _contar(
            sesiones, PaymentTransaction, PaymentTransaction.kind == "refund"
        )
        == 1
    )


# --------------------------------------------------------------------------- #
# 5. Caso 6.6: apagado NO es fallido
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_aprobar_con_stripe_apagado_deja_approved_y_no_revoca(entorno):
    """Nunca se intento el reembolso, asi que no se puede decir que fallo."""
    http, identidad, sesiones = entorno
    ajustes = get_settings()
    assert ajustes.stripe_refunds_enabled is False

    identidad["uid"] = ANA
    from app.modules.refunds import service as devoluciones

    async with sesiones() as db:
        await devoluciones.asegurar_ventana(
            db, user_id=ANA, course_id=CURSO, order_id=ORDEN
        )
        await db.commit()

    pedida = await http.post(
        f"{PAGOS}/refund-requests", json={"order_id": ORDEN, "reason": "other"}
    )
    assert pedida.status_code == 201, pedida.text
    solicitud = pedida.json()["id"]

    identidad["uid"] = JEFA
    assert (
        await http.post(f"{ADMIN}/refund-requests/{solicitud}/take")
    ).status_code == 200
    aprobada = await http.post(
        f"{ADMIN}/refund-requests/{solicitud}/approve", json={"notes": "vale"}
    )
    assert aprobada.status_code == 200, aprobada.text

    cuerpo = aprobada.json()
    assert cuerpo["status"] == "approved"
    assert cuerpo["status"] != "failed"
    # NADIE pierde el acceso, y la orden sigue pagada.
    assert await _contar(sesiones, Entitlement, Entitlement.status == "active") == 1
    assert await _contar(sesiones, Order, Order.status == "refunded") == 0
    # Y el expediente dice la verdad: falta habilitar la ejecucion externa.
    motivos = " ".join(
        (evento["reason"] or "") for evento in cuerpo["history"]
    ).lower()
    assert "habilitacion" in motivos or "habilitación" in motivos


# --------------------------------------------------------------------------- #
# 6. Caso 6.3: las compras apagadas no bloquean las devoluciones
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_un_aviso_de_devolucion_se_procesa_con_las_compras_apagadas(
    entorno, monkeypatch
):
    """Apagar las ventas nuevas no puede dejar el dinero ya cobrado aqui."""
    http, _, sesiones = entorno
    ajustes = get_settings()
    ajustes.stripe_payments_enabled = False

    from app.modules.payments import providers as modulo_de_pasarelas
    from app.modules.payments.providers import PaymentEvent

    class _StripeDeMentira:
        name = "stripe"

        def verify_and_parse(self, *, body, headers):
            datos = json.loads(body)
            return PaymentEvent(
                purchase_id="",
                provider_transaction_id=datos["intento"],
                status=datos["estado"],
                amount_minor=datos["importe"],
                currency="PEN",
                event_id=datos["event_id"],
                # EL `re_...` REAL. La doble no lo mandaba, y sin el un aviso
                # de devolucion ya no retira acceso: `pi_...` identifica el
                # COBRO, no el reembolso, y Stripe si manda el suyo.
                refund_id=datos.get("reembolso", "re_de_prueba_1"),
                event_type="charge.refunded",
                environment="sandbox",
                payload=datos,
            )

    anterior = modulo_de_pasarelas.PROVIDERS.get("stripe")
    modulo_de_pasarelas.PROVIDERS["stripe"] = _StripeDeMentira()
    try:
        cuerpo = json.dumps(
            {
                "intento": "pi_1",
                "estado": "refunded",
                "importe": PRECIO,
                "event_id": "evt_devolucion_1",
            }
        ).encode()
        aviso = await http.post(
            f"{PAGOS}/webhook/stripe",
            content=cuerpo,
            headers={"content-type": "application/json"},
        )
        # Ni 503 ni error: la devolucion se procesa.
        assert aviso.status_code == 204, aviso.text
        assert await _contar(sesiones, Order, Order.status == "refunded") == 1
        assert await _contar(sesiones, Entitlement, Entitlement.status == "active") == 0

        # Pero una COMPRA nueva sigue bloqueada.
        compra = json.dumps(
            {
                "intento": "pi_9",
                "estado": "paid",
                "importe": PRECIO,
                "event_id": "evt_compra_1",
            }
        ).encode()
        respuesta = await http.post(
            f"{PAGOS}/webhook/stripe",
            content=compra,
            headers={"content-type": "application/json"},
        )
        assert respuesta.status_code == 503, respuesta.text
    finally:
        if anterior is not None:
            modulo_de_pasarelas.PROVIDERS["stripe"] = anterior
        else:  # pragma: no cover
            modulo_de_pasarelas.PROVIDERS.pop("stripe", None)
