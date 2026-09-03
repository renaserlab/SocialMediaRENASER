"""La clave de idempotencia, la recuperacion de un intento sin respuesta y la
ejecucion de una solicitud ya aprobada.

LO QUE PROTEGE ESTE FICHERO, y las tres cuestan dinero real:

1. **La clave solo cambia tras un fallo TERMINAL.** Un timeout o un 5xx pudieron
   llegar igualmente; mandar una clave nueva despues es como se paga dos veces
   el mismo reembolso.
2. **Ningun estado se queda sin salida.** Un intento sin respuesta deja la
   solicitud reintentable, y el reintento recupera la operacion que ya existia
   en vez de crear otra.
3. **Ningun fallo ni reintento retira acceso.** Eso solo lo hace un webhook
   verificado de reembolso completo.
"""

from __future__ import annotations

import asyncio
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
from app.modules.payments.reembolsos import RefundResult, clave_de_idempotencia
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.refunds.models import RefundRequest
from app.shared.database import Base, get_db

PAGOS = "/api/v1/payments"
ADMIN = "/api/v1/admin"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"  # autor del curso
JEFA = "aaaaaaaa-0000-0000-0000-000000000003"  # administracion
CURSO = "cccccccc-0000-0000-0000-000000000001"
ORDEN = "00000000-0000-0000-0000-0000000000a1"
PRECIO = 19900


class _PasarelaConMemoria:
    """Se comporta como la de verdad: la MISMA clave devuelve la MISMA operacion.

    El `guion` dice que pasa en cada llamada con una clave NUEVA:

        'timeout'   la peticion LLEGA y el reembolso se crea, pero no hay
                    respuesta; el servidor no llega a saber el identificador
        'http_502'  (o 503/504) la rechaza una capa intermedia; no se crea nada
        'declinada' dice que no de forma concluyente
        'ok'        creado y aceptado

    `reembolsos` es el numero de reembolsos que existen DE VERDAD ahi fuera: es
    lo que hay que mirar para saber si se ha pagado dos veces.
    """

    name = "memoria"

    def __init__(self, *guion: str) -> None:
        self.guion = list(guion)
        self.claves: list[str] = []
        self.reembolsos: dict[str, str] = {}

    async def create_full_refund(self, peticion) -> RefundResult:
        clave = peticion.idempotency_key
        self.claves.append(clave)
        if clave in self.reembolsos:
            return RefundResult(
                status="pending", external_refund_id=self.reembolsos[clave]
            )
        paso = self.guion.pop(0) if self.guion else "ok"
        if paso == "timeout":
            self.reembolsos[clave] = f"re_{len(self.reembolsos) + 1}"
            return RefundResult(
                status="pending",
                failure_code="network_timeout",
                failure_message="No hubo respuesta; puede haberse creado igual.",
            )
        if paso.startswith("http_"):
            return RefundResult(
                status="failed", failure_code=paso, failure_message="5xx"
            )
        if paso == "declinada":
            return RefundResult(
                status="failed",
                failure_code="card_declined",
                failure_message="La pasarela rechazo la devolucion.",
            )
        self.reembolsos[clave] = f"re_{len(self.reembolsos) + 1}"
        return RefundResult(
            status="pending", external_refund_id=self.reembolsos[clave]
        )

    async def get_refund_status(self, external_refund_id: str) -> RefundResult:
        return RefundResult(status="pending", external_refund_id=external_refund_id)


def _usar(monkeypatch, pasarela: _PasarelaConMemoria) -> _PasarelaConMemoria:
    monkeypatch.setattr(
        "app.modules.payments.reembolsos.proveedor_de_reembolsos", lambda: pasarela
    )
    return pasarela


@pytest_asyncio.fixture
async def entorno():
    """Curso de pago de Bruno, comprado y pagado por Ana. Stripe ENCENDIDO."""
    esquema.olvidar()
    ajustes = get_settings()
    anterior = {
        "feature_course_refunds": ajustes.feature_course_refunds,
        "stripe_refunds_enabled": ajustes.stripe_refunds_enabled,
        "stripe_payments_enabled": ajustes.stripe_payments_enabled,
    }
    ajustes.feature_course_refunds = True
    ajustes.stripe_refunds_enabled = True

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


# --------------------------------------------------------------------------- #
# Utilidades del circuito
# --------------------------------------------------------------------------- #


async def _pedir_y_aprobar(http, identidad, sesiones) -> str:
    """Ana entra, pide la devolucion y la Jefa la aprueba. Devuelve el id.

    Aprobar EJECUTA: con Stripe encendido, este es el primer intento.
    """
    from app.modules.refunds import service as devoluciones

    identidad["uid"] = ANA
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
    return solicitud


async def _solicitud(sesiones, request_id: str) -> RefundRequest:
    async with sesiones() as db:
        return await db.get(RefundRequest, request_id)


async def _contar(sesiones, entidad, *filtros) -> int:
    async with sesiones() as db:
        return int(
            await db.scalar(select(func.count()).select_from(entidad).where(*filtros))
            or 0
        )


async def _reintentar(http, request_id: str):
    return await http.post(f"{ADMIN}/refund-requests/{request_id}/retry")


# --------------------------------------------------------------------------- #
# 1. La clave de idempotencia
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_el_primer_intento_usa_la_clave_de_la_solicitud(entorno, monkeypatch):
    http, identidad, sesiones = entorno
    pasarela = _usar(monkeypatch, _PasarelaConMemoria("ok"))
    solicitud = await _pedir_y_aprobar(http, identidad, sesiones)
    assert pasarela.claves == [f"zrefund_{solicitud}"]


@pytest.mark.asyncio
@pytest.mark.parametrize("ambiguo", ["timeout", "http_502", "http_503", "http_504"])
async def test_tras_un_fallo_ambiguo_el_reintento_repite_la_misma_clave(
    entorno, monkeypatch, ambiguo
):
    """Es LA prueba de no pagar dos veces: la peticion pudo llegar."""
    http, identidad, sesiones = entorno
    pasarela = _usar(monkeypatch, _PasarelaConMemoria(ambiguo, "ok"))
    solicitud = await _pedir_y_aprobar(http, identidad, sesiones)

    assert (await _reintentar(http, solicitud)).status_code == 200
    assert pasarela.claves == [f"zrefund_{solicitud}"] * 2


@pytest.mark.asyncio
async def test_tras_una_declinacion_el_siguiente_intento_usa_r1(entorno, monkeypatch):
    """`card_declined` es concluyente: repetir la clave devolveria el mismo no."""
    http, identidad, sesiones = entorno
    pasarela = _usar(monkeypatch, _PasarelaConMemoria("declinada", "ok"))
    solicitud = await _pedir_y_aprobar(http, identidad, sesiones)
    assert (await _solicitud(sesiones, solicitud)).status == "failed"

    assert (await _reintentar(http, solicitud)).status_code == 200
    assert pasarela.claves == [
        f"zrefund_{solicitud}",
        f"zrefund_{solicitud}_r1",
    ]


@pytest.mark.asyncio
async def test_dos_declinaciones_llevan_a_r2(entorno, monkeypatch):
    http, identidad, sesiones = entorno
    pasarela = _usar(
        monkeypatch, _PasarelaConMemoria("declinada", "declinada", "ok")
    )
    solicitud = await _pedir_y_aprobar(http, identidad, sesiones)
    assert (await _reintentar(http, solicitud)).status_code == 200
    assert (await _reintentar(http, solicitud)).status_code == 200
    assert pasarela.claves[-1] == f"zrefund_{solicitud}_r2"


@pytest.mark.asyncio
async def test_un_ambiguo_entre_dos_terminales_no_incrementa(entorno, monkeypatch):
    """El 503 del medio no cuenta: el numero sigue siendo el de los NO reales."""
    http, identidad, sesiones = entorno
    pasarela = _usar(
        monkeypatch,
        _PasarelaConMemoria("declinada", "http_503", "declinada", "ok"),
    )
    solicitud = await _pedir_y_aprobar(http, identidad, sesiones)
    for _ in range(3):
        assert (await _reintentar(http, solicitud)).status_code == 200

    assert pasarela.claves == [
        f"zrefund_{solicitud}",  # primer intento
        f"zrefund_{solicitud}_r1",  # tras la declinacion
        f"zrefund_{solicitud}_r1",  # el 503 NO incrementa
        f"zrefund_{solicitud}_r2",  # tras la segunda declinacion
    ]


@pytest.mark.asyncio
async def test_el_numero_de_terminales_sobrevive_a_una_sesion_nueva(
    entorno, monkeypatch
):
    """Sale de lo PERSISTIDO, no de un contador en memoria."""
    http, identidad, sesiones = entorno
    _usar(monkeypatch, _PasarelaConMemoria("declinada", "http_502", "declinada"))
    solicitud = await _pedir_y_aprobar(http, identidad, sesiones)
    assert (await _reintentar(http, solicitud)).status_code == 200
    assert (await _reintentar(http, solicitud)).status_code == 200

    from app.modules.refunds.router import _fallos_terminales

    async with sesiones() as db:
        assert await _fallos_terminales(db, solicitud) == 2
    assert clave_de_idempotencia(solicitud, 2) == f"zrefund_{solicitud}_r2"


# --------------------------------------------------------------------------- #
# 2. Recuperacion: ningun estado sin salida
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
@pytest.mark.parametrize("ambiguo", ["timeout", "http_502", "http_503", "http_504"])
async def test_un_fallo_ambiguo_deja_la_solicitud_reintentable(
    entorno, monkeypatch, ambiguo
):
    """Antes se quedaba sin accion valida: ni `retry` ni `reconcile` servian."""
    http, identidad, sesiones = entorno
    _usar(monkeypatch, _PasarelaConMemoria(ambiguo, "ok"))
    solicitud = await _pedir_y_aprobar(http, identidad, sesiones)

    fila = await _solicitud(sesiones, solicitud)
    assert fila.status == "refund_processing"
    assert not fila.external_refund_id
    # Y desde ahi SI hay algo que hacer.
    respuesta = await _reintentar(http, solicitud)
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["external_refund_id"]


@pytest.mark.asyncio
async def test_el_reintento_tras_un_timeout_recupera_el_mismo_reembolso(
    entorno, monkeypatch
):
    """Stripe SI lo creo. La misma clave lo recupera; no aparece un segundo."""
    http, identidad, sesiones = entorno
    pasarela = _usar(monkeypatch, _PasarelaConMemoria("timeout"))
    solicitud = await _pedir_y_aprobar(http, identidad, sesiones)
    assert len(pasarela.reembolsos) == 1

    respuesta = await _reintentar(http, solicitud)
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["external_refund_id"] == "re_1"
    # UN solo reembolso logico ahi fuera, aunque se pidiera dos veces.
    assert len(pasarela.reembolsos) == 1


@pytest.mark.asyncio
async def test_un_pending_con_identificador_se_queda_para_conciliar(
    entorno, monkeypatch
):
    http, identidad, sesiones = entorno
    pasarela = _usar(monkeypatch, _PasarelaConMemoria("ok"))
    solicitud = await _pedir_y_aprobar(http, identidad, sesiones)

    fila = await _solicitud(sesiones, solicitud)
    assert fila.status == "refund_processing"
    assert fila.external_refund_id == "re_1"
    conciliada = await http.post(f"{ADMIN}/refund-requests/{solicitud}/reconcile")
    assert conciliada.status_code == 200, conciliada.text
    assert conciliada.json()["status"] == "refund_processing"
    assert len(pasarela.claves) == 1


@pytest.mark.asyncio
async def test_con_referencia_el_reintento_no_crea_otro_reembolso(
    entorno, monkeypatch
):
    """La regla mas cara del fichero: si ya hay identificador, no se pide otro."""
    http, identidad, sesiones = entorno
    pasarela = _usar(monkeypatch, _PasarelaConMemoria("ok"))
    solicitud = await _pedir_y_aprobar(http, identidad, sesiones)

    assert (await _reintentar(http, solicitud)).status_code == 200
    assert len(pasarela.claves) == 1
    assert len(pasarela.reembolsos) == 1


@pytest.mark.asyncio
async def test_dos_administradores_reintentando_a_la_vez_no_crean_dos(
    entorno, monkeypatch
):
    http, identidad, sesiones = entorno
    pasarela = _usar(monkeypatch, _PasarelaConMemoria("timeout"))
    solicitud = await _pedir_y_aprobar(http, identidad, sesiones)

    primera, segunda = await asyncio.gather(
        _reintentar(http, solicitud), _reintentar(http, solicitud)
    )
    assert {primera.status_code, segunda.status_code} == {200}
    # Da igual cuantas veces se pidiera: la clave es la misma y el reembolso uno.
    assert len(pasarela.reembolsos) == 1
    assert set(pasarela.claves) == {f"zrefund_{solicitud}"}


@pytest.mark.asyncio
async def test_ningun_fallo_ni_reintento_retira_el_acceso(entorno, monkeypatch):
    http, identidad, sesiones = entorno
    _usar(
        monkeypatch, _PasarelaConMemoria("timeout", "declinada", "http_504", "ok")
    )
    solicitud = await _pedir_y_aprobar(http, identidad, sesiones)
    for _ in range(3):
        await _reintentar(http, solicitud)

    assert await _contar(sesiones, Entitlement, Entitlement.status == "active") == 1
    assert await _contar(sesiones, Order, Order.status == "refunded") == 0
    assert (
        await _contar(
            sesiones, PaymentTransaction, PaymentTransaction.kind == "refund"
        )
        == 0
    )


# --------------------------------------------------------------------------- #
# 3. El webhook cierra lo que el timeout dejo abierto
# --------------------------------------------------------------------------- #


class _StripeDeMentira:
    """Traduce el cuerpo de la prueba a un evento ya verificado."""

    name = "stripe"

    def verify_and_parse(self, *, body, headers):
        from app.modules.payments.providers import PaymentEvent

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


async def _avisar_reembolso(http, *, event_id: str):
    from app.modules.payments import providers as modulo

    anterior = modulo.PROVIDERS.get("stripe")
    modulo.PROVIDERS["stripe"] = _StripeDeMentira()
    try:
        cuerpo = json.dumps(
            {
                "intento": "pi_1",
                "estado": "refunded",
                "importe": PRECIO,
                "event_id": event_id,
            }
        ).encode()
        return await http.post(
            f"{PAGOS}/webhook/stripe",
            content=cuerpo,
            headers={"content-type": "application/json"},
        )
    finally:
        if anterior is not None:
            modulo.PROVIDERS["stripe"] = anterior
        else:  # pragma: no cover
            modulo.PROVIDERS.pop("stripe", None)


@pytest.mark.asyncio
async def test_un_webhook_posterior_al_timeout_cierra_el_expediente(
    entorno, monkeypatch
):
    """El reembolso existia de verdad. Cuando se confirma, ahi si se retira."""
    http, identidad, sesiones = entorno
    _usar(monkeypatch, _PasarelaConMemoria("timeout"))
    solicitud = await _pedir_y_aprobar(http, identidad, sesiones)
    assert (await _solicitud(sesiones, solicitud)).status == "refund_processing"

    aviso = await _avisar_reembolso(http, event_id="evt_1")
    assert aviso.status_code == 204, aviso.text
    assert (await _solicitud(sesiones, solicitud)).status == "refunded"
    assert await _contar(sesiones, Entitlement, Entitlement.status == "active") == 0
    # La matricula y el progreso se conservan.
    assert await _contar(sesiones, CourseEnrollment) == 1


@pytest.mark.asyncio
async def test_el_webhook_repetido_no_reembolsa_dos_veces(entorno, monkeypatch):
    http, identidad, sesiones = entorno
    _usar(monkeypatch, _PasarelaConMemoria("timeout"))
    solicitud = await _pedir_y_aprobar(http, identidad, sesiones)

    assert (await _avisar_reembolso(http, event_id="evt_1")).status_code == 204
    assert (await _avisar_reembolso(http, event_id="evt_1")).status_code == 204
    assert (await _avisar_reembolso(http, event_id="evt_2")).status_code == 204

    assert (await _solicitud(sesiones, solicitud)).status == "refunded"
    assert (
        await _contar(
            sesiones, PaymentTransaction, PaymentTransaction.kind == "refund"
        )
        == 1
    )
    assert await _contar(sesiones, Entitlement, Entitlement.status == "revoked") == 1


# --------------------------------------------------------------------------- #
# 4. Ejecutar una solicitud aprobada
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_aprobar_con_stripe_apagado_no_llama_a_nadie(entorno, monkeypatch):
    http, identidad, sesiones = entorno
    ajustes = get_settings()
    ajustes.stripe_refunds_enabled = False
    pasarela = _usar(monkeypatch, _PasarelaConMemoria("ok"))

    solicitud = await _pedir_y_aprobar(http, identidad, sesiones)
    assert (await _solicitud(sesiones, solicitud)).status == "approved"
    assert pasarela.claves == []
    assert await _contar(sesiones, Entitlement, Entitlement.status == "active") == 1


@pytest.mark.asyncio
async def test_al_encender_stripe_se_ejecuta_desde_approved(entorno, monkeypatch):
    """La interfaz ofrece «Reintentar»; el backend tiene que aceptarlo."""
    http, identidad, sesiones = entorno
    ajustes = get_settings()
    ajustes.stripe_refunds_enabled = False
    pasarela = _usar(monkeypatch, _PasarelaConMemoria("ok"))
    solicitud = await _pedir_y_aprobar(http, identidad, sesiones)

    ajustes.stripe_refunds_enabled = True
    respuesta = await _reintentar(http, solicitud)
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["status"] == "refund_processing"
    assert pasarela.claves == [f"zrefund_{solicitud}"]


@pytest.mark.asyncio
async def test_dos_pulsaciones_desde_approved_ejecutan_una_sola_vez(
    entorno, monkeypatch
):
    http, identidad, sesiones = entorno
    ajustes = get_settings()
    ajustes.stripe_refunds_enabled = False
    pasarela = _usar(monkeypatch, _PasarelaConMemoria("ok"))
    solicitud = await _pedir_y_aprobar(http, identidad, sesiones)

    ajustes.stripe_refunds_enabled = True
    primera, segunda = await asyncio.gather(
        _reintentar(http, solicitud), _reintentar(http, solicitud)
    )
    assert {primera.status_code, segunda.status_code} == {200}
    # UNA ejecucion: la transicion a `refund_processing` es un UPDATE
    # condicional, asi que la segunda pulsacion no llega a la pasarela.
    assert len(pasarela.claves) == 1
    assert len(pasarela.reembolsos) == 1


@pytest.mark.asyncio
async def test_desde_un_estado_no_ejecutable_se_dice_claro(entorno, monkeypatch):
    http, identidad, sesiones = entorno
    _usar(monkeypatch, _PasarelaConMemoria("ok"))
    from app.modules.refunds import service as devoluciones

    identidad["uid"] = ANA
    async with sesiones() as db:
        await devoluciones.asegurar_ventana(
            db, user_id=ANA, course_id=CURSO, order_id=ORDEN
        )
        await db.commit()
    pedida = await http.post(
        f"{PAGOS}/refund-requests", json={"order_id": ORDEN, "reason": "other"}
    )
    solicitud = pedida.json()["id"]

    identidad["uid"] = JEFA
    respuesta = await _reintentar(http, solicitud)
    assert respuesta.status_code == 422, respuesta.text
    assert "refund_invalid_transition" in respuesta.text


# --------------------------------------------------------------------------- #
# Un aviso de fallo que NO habla del reembolso en curso
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_un_refund_failed_de_OTRO_reembolso_no_mata_el_expediente(
    entorno, monkeypatch
):
    """UN COBRO PUEDE ACUMULAR VARIOS REEMBOLSOS.

    Un parcial antiguo que fallo, mas el total que esta en marcha. Sin comparar
    identificadores, el `refund.failed` del parcial mandaba el expediente del
    total a `failed` con un motivo TERMINAL. A partir de ahi el expediente
    miente, y «reintentar» suelta la referencia viva y pide un SEGUNDO
    reembolso: los dos liquidan.
    """
    from app.modules.payments import providers as modulo

    http, identidad, sesiones = entorno
    _usar(monkeypatch, _PasarelaConMemoria("ok"))
    solicitud = await _pedir_y_aprobar(http, identidad, sesiones)

    # El expediente esta en marcha con SU referencia.
    async with sesiones() as db:
        fila = await db.get(RefundRequest, solicitud)
        fila.status = "refund_processing"
        fila.external_refund_id = "re_del_total"
        await db.commit()

    anterior = modulo.PROVIDERS.get("stripe")
    modulo.PROVIDERS["stripe"] = _StripeDeMentira()
    try:
        cuerpo = json.dumps(
            {
                "intento": "pi_1",
                "estado": "refund_fallido",
                "importe": 100,
                "event_id": "evt_parcial_fallido",
                # El de OTRO reembolso del mismo cobro.
                "reembolso": "re_del_parcial",
            }
        ).encode()
        aviso = await http.post(
            f"{PAGOS}/webhook/stripe",
            content=cuerpo,
            headers={"content-type": "application/json"},
        )
        assert aviso.status_code == 204, aviso.text
    finally:
        if anterior is not None:
            modulo.PROVIDERS["stripe"] = anterior
        else:  # pragma: no cover
            modulo.PROVIDERS.pop("stripe", None)

    # El expediente NO se movio y conserva su referencia.
    fila = await _solicitud(sesiones, solicitud)
    assert fila.status == "refund_processing"
    assert fila.external_refund_id == "re_del_total"
