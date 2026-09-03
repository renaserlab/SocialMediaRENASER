"""Apagar `FEATURE_COURSE_REFUNDS` cierra la puerta de entrada, no el edificio.

LA CONFUSION QUE ESTO ARREGLA. Un solo guardia mezclaba dos preguntas —«esta la
0049?» y «se admiten solicitudes nuevas?»— y se usaba tambien en administracion.
Resultado: apagar la bandera dejaba los expedientes YA abiertos sin nadie que
pudiera revisarlos, rechazarlos, reintentarlos ni conciliarlos, con el dinero
del propietario congelado y el alumno esperando.

Con la bandera apagada: no entran solicitudes nuevas, y TODO lo demas funciona.
Nada se borra, nada se devuelve y nadie pierde el acceso.
"""

from __future__ import annotations

import json

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
from app.modules.refunds.models import CourseRefundWindow, RefundRequest
from app.modules.refunds.service import ahora
from app.shared.database import Base, get_db

PAGOS = "/api/v1/payments"
ADMIN = "/api/v1/admin"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"  # autor del curso
JEFA = "aaaaaaaa-0000-0000-0000-000000000003"  # administracion
CURSO = "cccccccc-0000-0000-0000-000000000001"
ORDEN = "00000000-0000-0000-0000-0000000000a1"
PRECIO = 19900


class _PasarelaDeMentira:
    """Contesta siempre lo mismo y apunta lo que le preguntan."""

    name = "mentira"

    def __init__(self, estado: str = "pending") -> None:
        self.estado = estado
        self.creaciones: list[str] = []
        self.consultas: list[str] = []

    async def create_full_refund(self, peticion) -> RefundResult:
        self.creaciones.append(peticion.idempotency_key)
        return RefundResult(status=self.estado, external_refund_id="re_1")

    async def get_refund_status(self, external_refund_id: str) -> RefundResult:
        self.consultas.append(external_refund_id)
        return RefundResult(status=self.estado, external_refund_id=external_refund_id)


def _usar(monkeypatch, pasarela: _PasarelaDeMentira) -> _PasarelaDeMentira:
    monkeypatch.setattr(
        "app.modules.payments.reembolsos.proveedor_de_reembolsos", lambda: pasarela
    )
    return pasarela


@pytest_asyncio.fixture
async def entorno():
    """Todo montado y la bandera APAGADA: es el escenario que se prueba."""
    esquema.olvidar()
    ajustes = get_settings()
    anterior = {
        "feature_course_refunds": ajustes.feature_course_refunds,
        "stripe_refunds_enabled": ajustes.stripe_refunds_enabled,
        "stripe_payments_enabled": ajustes.stripe_payments_enabled,
    }
    ajustes.feature_course_refunds = False
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
        db.add(
            Order(
                id=ORDEN,
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
                order_id=ORDEN,
                provider="stripe",
                environment="sandbox",
                external_transaction_id="pi_1",
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
        # La garantia arranco ANTES de apagar la bandera.
        momento = ahora()
        db.add(
            CourseRefundWindow(
                user_id=ANA,
                course_id=CURSO,
                order_id=ORDEN,
                first_accessed_at=momento,
                expires_at=momento.replace(year=momento.year + 1),
            )
        )
        await db.commit()

    identidad = {"uid": ANA}

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


async def _sembrar(
    sesiones,
    *,
    estado: str = "requested",
    referencia: str | None = None,
) -> str:
    """Un expediente abierto de antes de apagar la bandera."""
    async with sesiones() as db:
        solicitud = RefundRequest(
            order_id=ORDEN,
            user_id=ANA,
            course_id=CURSO,
            status=estado,
            reason="not_as_expected",
            amount_minor=PRECIO,
            currency="PEN",
            external_refund_id=referencia,
            provider="stripe",
            environment="sandbox",
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


async def _nada_se_movio(sesiones) -> None:
    """Ni acceso retirado, ni dinero devuelto, ni expedientes borrados."""
    assert await _contar(sesiones, Entitlement, Entitlement.status == "active") == 1
    assert await _contar(sesiones, Order, Order.status == "paid") == 1
    assert (
        await _contar(
            sesiones, PaymentTransaction, PaymentTransaction.kind == "refund"
        )
        == 0
    )
    assert await _contar(sesiones, CourseEnrollment) == 1


# --------------------------------------------------------------------------- #
# 1. La puerta de entrada SI se cierra
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_no_se_admiten_solicitudes_nuevas(entorno):
    http, _, sesiones = entorno
    respuesta = await http.post(
        f"{PAGOS}/refund-requests", json={"order_id": ORDEN, "reason": "other"}
    )
    assert respuesta.status_code == 503, respuesta.text
    assert "refunds_disabled" in respuesta.text
    assert await _contar(sesiones, RefundRequest) == 0

    # Y la ficha del curso se pinta igual: no es un error, es un «no».
    elegibilidad = await http.get(f"{PAGOS}/courses/{CURSO}/refund-eligibility")
    assert elegibilidad.status_code == 200
    assert elegibilidad.json()["reason_code"] == "disabled"


# --------------------------------------------------------------------------- #
# 2. El alumno sigue viendo y pudiendo retirar lo suyo
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_el_alumno_ve_su_historial_y_su_solicitud(entorno):
    http, _, sesiones = entorno
    solicitud = await _sembrar(sesiones)

    mias = await http.get(f"{PAGOS}/refund-requests/mine")
    assert mias.status_code == 200, mias.text
    assert [fila["id"] for fila in mias.json()] == [solicitud]

    detalle = await http.get(f"{PAGOS}/refund-requests/{solicitud}")
    assert detalle.status_code == 200, detalle.text
    assert detalle.json()["status"] == "requested"


@pytest.mark.asyncio
async def test_el_alumno_puede_retirar_la_suya(entorno):
    http, _, sesiones = entorno
    solicitud = await _sembrar(sesiones)

    respuesta = await http.post(f"{PAGOS}/refund-requests/{solicitud}/cancel")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["status"] == "cancelled"
    await _nada_se_movio(sesiones)


# --------------------------------------------------------------------------- #
# 3. Administracion sigue resolviendo lo abierto
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_administracion_lista_abre_toma_y_rechaza(entorno):
    http, identidad, sesiones = entorno
    solicitud = await _sembrar(sesiones)
    identidad["uid"] = JEFA

    bandeja = await http.get(f"{ADMIN}/refund-requests")
    assert bandeja.status_code == 200, bandeja.text
    assert [fila["id"] for fila in bandeja.json()] == [solicitud]

    detalle = await http.get(f"{ADMIN}/refund-requests/{solicitud}")
    assert detalle.status_code == 200, detalle.text

    tomada = await http.post(f"{ADMIN}/refund-requests/{solicitud}/take")
    assert tomada.status_code == 200, tomada.text
    rechazada = await http.post(
        f"{ADMIN}/refund-requests/{solicitud}/reject", json={"notes": "fuera de plazo"}
    )
    assert rechazada.status_code == 200, rechazada.text
    assert rechazada.json()["status"] == "rejected"
    await _nada_se_movio(sesiones)


@pytest.mark.asyncio
async def test_administracion_puede_cancelar_un_expediente_muerto(entorno):
    http, identidad, sesiones = entorno
    solicitud = await _sembrar(sesiones)
    identidad["uid"] = JEFA

    respuesta = await http.post(
        f"{ADMIN}/refund-requests/{solicitud}/cancel", json={"notes": "duplicada"}
    )
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["status"] == "cancelled"
    await _nada_se_movio(sesiones)


@pytest.mark.asyncio
async def test_administracion_puede_aprobar_y_reintentar(entorno, monkeypatch):
    http, identidad, sesiones = entorno
    ajustes = get_settings()
    ajustes.stripe_refunds_enabled = True
    pasarela = _usar(monkeypatch, _PasarelaDeMentira("pending"))
    solicitud = await _sembrar(sesiones, estado="under_review")
    identidad["uid"] = JEFA

    aprobada = await http.post(
        f"{ADMIN}/refund-requests/{solicitud}/approve", json={"notes": "vale"}
    )
    assert aprobada.status_code == 200, aprobada.text
    assert aprobada.json()["status"] == "refund_processing"
    assert pasarela.creaciones == [f"zrefund_{solicitud}"]

    # Y el reintento tambien: con referencia, pregunta en vez de crear otro.
    reintentada = await http.post(f"{ADMIN}/refund-requests/{solicitud}/retry")
    assert reintentada.status_code == 200, reintentada.text
    assert len(pasarela.creaciones) == 1
    # Nada de esto retira acceso: eso lo hace el webhook confirmado.
    await _nada_se_movio(sesiones)


@pytest.mark.asyncio
async def test_administracion_puede_conciliar(entorno, monkeypatch):
    http, identidad, sesiones = entorno
    _usar(monkeypatch, _PasarelaDeMentira("pending"))
    solicitud = await _sembrar(sesiones, estado="refund_processing", referencia="re_1")
    identidad["uid"] = JEFA

    respuesta = await http.post(f"{ADMIN}/refund-requests/{solicitud}/reconcile")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["status"] == "refund_processing"
    await _nada_se_movio(sesiones)


# --------------------------------------------------------------------------- #
# 4. Los webhooks no se enteran de la bandera
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_los_webhooks_siguen_procesandose(entorno):
    """El dinero ya cobrado no se queda aqui porque se apagara una bandera."""
    http, _, sesiones = entorno
    solicitud = await _sembrar(sesiones, estado="refund_processing", referencia="re_1")

    from app.modules.payments import providers as modulo
    from app.modules.payments.providers import PaymentEvent

    class _StripeDeMentira:
        name = "stripe"

        def verify_and_parse(self, *, body, headers):
            datos = json.loads(body)
            return PaymentEvent(
                purchase_id="",
                provider_transaction_id=datos["intento"],
                status="refunded",
                amount_minor=datos["importe"],
                currency="PEN",
                event_id=datos["event_id"],
                event_type="charge.refunded",
                environment="sandbox",
                payload=datos,
            )

    anterior = modulo.PROVIDERS.get("stripe")
    modulo.PROVIDERS["stripe"] = _StripeDeMentira()
    try:
        aviso = await http.post(
            f"{PAGOS}/webhook/stripe",
            content=json.dumps(
                {"intento": "pi_1", "importe": PRECIO, "event_id": "evt_1"}
            ).encode(),
            headers={"content-type": "application/json"},
        )
    finally:
        if anterior is not None:
            modulo.PROVIDERS["stripe"] = anterior
        else:  # pragma: no cover
            modulo.PROVIDERS.pop("stripe", None)

    assert aviso.status_code == 204, aviso.text
    assert await _estado(sesiones, solicitud) == "refunded"
    assert await _contar(sesiones, Entitlement, Entitlement.status == "active") == 0


# --------------------------------------------------------------------------- #
# 5. Lo que la bandera apagada NO puede desproteger
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_la_recompra_sigue_exigiendo_la_aceptacion(entorno):
    """Quien ya gasto su garantia la gasto, este la bandera como este."""
    from app.core.exceptions import ConflictError
    from app.modules.payments.router import _exigir_aceptacion_de_recompra
    from app.modules.refunds import service as devoluciones

    _, _, sesiones = entorno
    async with sesiones() as db:
        ventana = await db.scalar(select(CourseRefundWindow))
        ventana.refund_used_at = ahora()
        await db.commit()

    async with sesiones() as db:
        assert await devoluciones.ya_devolvio(db, user_id=ANA, course_id=CURSO)
        with pytest.raises(ConflictError):
            await _exigir_aceptacion_de_recompra(db, user_id=ANA, course_id=CURSO)

    # Y aceptar sigue siendo posible: si no, no podria recomprar nunca.
    async with sesiones() as db:
        aceptada = await devoluciones.registrar_aceptacion(
            db, user_id=ANA, course_id=CURSO, order_id=None, fecha_legible="2026-01-01"
        )
        assert aceptada.policy_hash
        await db.commit()
    async with sesiones() as db:
        await _exigir_aceptacion_de_recompra(db, user_id=ANA, course_id=CURSO)


@pytest.mark.asyncio
async def test_aceptar_la_recompra_funciona_con_la_bandera_apagada(entorno):
    http, _, sesiones = entorno
    async with sesiones() as db:
        ventana = await db.scalar(select(CourseRefundWindow))
        ventana.refund_used_at = ahora()
        await db.commit()

    aviso = await http.get(f"{PAGOS}/courses/{CURSO}/repurchase-notice")
    assert aviso.status_code == 200, aviso.text
    assert aviso.json()["requires_acceptance"] is True

    aceptada = await http.post(
        f"{PAGOS}/repurchase-acceptance", json={"course_id": CURSO, "accepted": True}
    )
    assert aceptada.status_code == 204, aceptada.text


# --------------------------------------------------------------------------- #
# 6. Si de verdad falta la migracion, eso SI se corta
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_sin_la_0049_la_respuesta_es_controlada(entorno):
    """503 con su codigo, nunca un 500 que el navegador toma por fallo de red."""
    http, identidad, sesiones = entorno
    solicitud = await _sembrar(sesiones)
    # La 0049 deja de estar: es lo que ve el codigo desplegado antes que ella.
    esquema._cache["refund_requests"] = False

    detalle = await http.get(f"{PAGOS}/refund-requests/{solicitud}")
    assert detalle.status_code == 503, detalle.text
    assert "refunds_not_available" in detalle.text

    identidad["uid"] = JEFA
    admin = await http.get(f"{ADMIN}/refund-requests/{solicitud}")
    assert admin.status_code == 503, admin.text
    # Y las listas responden vacio en vez de romper la pantalla.
    assert (await http.get(f"{ADMIN}/refund-requests")).json() == []
