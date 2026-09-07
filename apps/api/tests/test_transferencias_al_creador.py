"""Pagarle al creador: el contrato, las puertas y por qué no se paga dos veces.

NADA DE ESTO ESTÁ ENCENDIDO. Las banderas nacen apagadas y la comisión en `-1`,
que no es «cero por ciento» sino «sin configurar». Estas pruebas las encienden
a mano sobre un doble determinista: comprueban la arquitectura, no que se pueda
mover dinero real —para eso hacen falta cuatro decisiones de la empresa que
están listadas en `docs/Z_DEVOLUCIONES_Y_LIQUIDACIONES.md`—.

LO QUE SE PROTEGE AQUÍ es lo mismo que en los reembolsos, del otro lado del
mostrador: que no se pague con la garantía abierta, que no se pague dos veces, y
que un tiempo de espera agotado no se confunda con un pago que no ocurrió.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.security import AuthUser
from app.modules.commerce import liquidacion
from app.modules.commerce.models import (
    CommerceProduct,
    Order,
    OwnerPayoutAccount,
    OwnerSaleBalance,
    OwnerTransfer,
)
from app.modules.commerce.transferencias import (
    DobleDeterminista,
    NoConfigurado,
    TransferRequest,
    clave_de_idempotencia,
    es_terminal,
    exigir_referencia,
    proveedor_de_transferencias,
)
from app.modules.catalog.models import Course
from app.modules.profiles.models import Profile
from app.shared.database import Base

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
CURSO = "cccccccc-0000-0000-0000-000000000001"
ORDEN = "00000000-0000-0000-0000-0000000000a1"
PRECIO = 19900
NETO = 17900


def _antes(horas: int) -> datetime:
    return datetime.now(timezone.utc) - timedelta(hours=horas)


@pytest_asyncio.fixture
async def sesiones():
    """Una venta pagada, con su saldo ya elegible y su cuenta lista."""
    ajustes = get_settings()
    previos = {
        "creator_transfers_enabled": ajustes.creator_transfers_enabled,
        "stripe_connect_enabled": ajustes.stripe_connect_enabled,
        "platform_fee_bps": ajustes.platform_fee_bps,
    }
    ajustes.creator_transfers_enabled = True
    ajustes.stripe_connect_enabled = True
    ajustes.platform_fee_bps = 1000

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    hacer = async_sessionmaker(engine, expire_on_commit=False)

    async with hacer() as db:
        db.add_all(
            [
                Profile(id=ANA, username="ana", full_name="Ana"),
                Profile(id=BRUNO, username="bruno", full_name="Bruno"),
            ]
        )
        db.add(
            Course(
                id=CURSO, author_id=BRUNO, title="Curso", description="",
                price_minor=PRECIO, currency="PEN", status="published",
            )
        )
        await db.flush()
        producto = CommerceProduct(
            kind="course_lifetime", course_id=CURSO, active=True
        )
        db.add(producto)
        await db.flush()
        db.add(
            Order(
                id=ORDEN, user_id=ANA, commerce_product_id=producto.id,
                provider="stripe", channel="web", environment="sandbox", amount_minor=PRECIO,
                currency="PEN", status="paid",
            )
        )
        cuenta = OwnerPayoutAccount(
            owner_id=BRUNO, provider="stripe", environment="sandbox",
            external_account_id="acct_bruno", onboarding_status="active",
            charges_enabled=True, payouts_enabled=True,
        )
        db.add(cuenta)
        await db.flush()
        db.add(
            OwnerSaleBalance(
                order_id=ORDEN, course_id=CURSO, owner_id=BRUNO,
                payout_account_id=cuenta.id,
                gross_amount_minor=PRECIO, platform_fee_minor=PRECIO - NETO,
                provider_fee_minor=0, net_amount_minor=NETO, currency="PEN",
                fee_rules_version="v1",
                status="eligible", available_at=_antes(1),
            )
        )
        await db.commit()

    yield hacer
    await engine.dispose()
    for clave, valor in previos.items():
        setattr(ajustes, clave, valor)


async def _saldo(hacer) -> OwnerSaleBalance:
    async with hacer() as db:
        return await db.scalar(select(OwnerSaleBalance))


def _usar(monkeypatch, doble):
    monkeypatch.setattr(
        "app.modules.commerce.transferencias.proveedor_de_transferencias",
        lambda: doble,
    )
    return doble


# --------------------------------------------------------------------------- #
# 1. El contrato: nada se mueve sin las tres banderas
# --------------------------------------------------------------------------- #


def test_sin_banderas_el_proveedor_falla_en_cerrado():
    """No simula un pago con éxito: eso marcaría el saldo como transferido sin
    que el creador hubiera cobrado nada."""
    ajustes = get_settings()
    previos = (ajustes.creator_transfers_enabled, ajustes.stripe_connect_enabled)
    ajustes.creator_transfers_enabled = False
    ajustes.stripe_connect_enabled = False
    try:
        assert isinstance(proveedor_de_transferencias(), NoConfigurado)
    finally:
        ajustes.creator_transfers_enabled, ajustes.stripe_connect_enabled = previos


@pytest.mark.asyncio
async def test_el_proveedor_apagado_no_devuelve_exito():
    resultado = await NoConfigurado().create_transfer(
        TransferRequest(
            destination_account_id="acct_1", amount_minor=NETO, currency="PEN",
            idempotency_key="k",
        )
    )
    assert resultado.status == "failed"
    assert resultado.failure_code == "provider_not_configured"
    assert resultado.external_transfer_id == ""


# --------------------------------------------------------------------------- #
# 2. La clave de idempotencia
# --------------------------------------------------------------------------- #


def test_la_clave_es_estable_por_saldo():
    """Tres reintentos mandan la misma clave y la pasarela devuelve el mismo
    pago en vez de crear tres."""
    assert clave_de_idempotencia("s1") == clave_de_idempotencia("s1", 0)
    assert clave_de_idempotencia("s1") == "ztransfer_s1"


def test_la_clave_solo_cambia_tras_un_fallo_CONCLUYENTE():
    assert clave_de_idempotencia("s1", 1) == "ztransfer_s1_r1"
    assert clave_de_idempotencia("s1", 1) != clave_de_idempotencia("s1", 2)


@pytest.mark.parametrize(
    "codigo,terminal",
    [
        ("account_closed", True),
        ("no_account", True),
        ("insufficient_funds", True),
        ("provider_not_configured", True),
        # Ambiguos: el dinero PUDO salir, así que se repite la misma clave.
        ("network_timeout", False),
        ("unreadable_response", False),
        ("http_500", False),
        ("http_409", False),
        ("", False),
        ("lo_que_sea", False),
    ],
)
def test_clasificacion_de_fallos(codigo, terminal):
    assert es_terminal(codigo) is terminal


@pytest.mark.asyncio
async def test_el_doble_recuerda_las_claves():
    """Sin esto, una prueba de reintento pasaría aunque el código generase una
    clave distinta cada vez, que es como se paga dos veces."""
    doble = DobleDeterminista()
    peticion = TransferRequest(
        destination_account_id="acct_1", amount_minor=NETO, currency="PEN",
        idempotency_key="ztransfer_1",
    )
    primero = await doble.create_transfer(peticion)
    segundo = await doble.create_transfer(peticion)
    assert primero.external_transfer_id == segundo.external_transfer_id
    assert len(doble.llamadas) == 2


# --------------------------------------------------------------------------- #
# 3. La referencia
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("malo", ["", "   ", "acct_1", "po_1", "tr_", "tr_1:x", "tr 1"])
def test_una_referencia_que_no_es_una_transferencia_se_rechaza(malo):
    with pytest.raises(ValueError):
        exigir_referencia(malo)


def test_una_referencia_valida_pasa():
    assert exigir_referencia(" tr_abc ") == "tr_abc"


# --------------------------------------------------------------------------- #
# 4. Las puertas
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_con_todo_en_orden_se_puede_transferir(sesiones):
    async with sesiones() as db:
        saldo = await db.scalar(select(OwnerSaleBalance))
        assert await liquidacion.puede_transferirse(db, saldo) is None


@pytest.mark.asyncio
async def test_sin_comision_configurada_no_se_transfiere(sesiones):
    """`-1` no es «cero por ciento»: es «nadie ha decidido cuánto»."""
    ajustes = get_settings()
    ajustes.platform_fee_bps = -1
    try:
        async with sesiones() as db:
            saldo = await db.scalar(select(OwnerSaleBalance))
            assert await liquidacion.puede_transferirse(db, saldo) == "fee_not_configured"
    finally:
        ajustes.platform_fee_bps = 1000


@pytest.mark.asyncio
async def test_con_la_garantia_SIN_EMPEZAR_no_se_transfiere(sesiones):
    """`available_at` nulo significa que la persona no ha entrado al curso: el
    reloj no ha arrancado y pagar ahí es pagar con la garantía entera delante."""
    async with sesiones() as db:
        saldo = await db.scalar(select(OwnerSaleBalance))
        saldo.available_at = None
        await db.commit()
        assert await liquidacion.puede_transferirse(db, saldo) == "guarantee_not_started"


@pytest.mark.asyncio
async def test_con_la_garantia_ABIERTA_no_se_transfiere(sesiones):
    async with sesiones() as db:
        saldo = await db.scalar(select(OwnerSaleBalance))
        saldo.available_at = datetime.now(timezone.utc) + timedelta(hours=10)
        await db.commit()
        assert await liquidacion.puede_transferirse(db, saldo) == "guarantee_open"


@pytest.mark.asyncio
async def test_con_una_orden_ya_reembolsada_no_se_transfiere(sesiones):
    async with sesiones() as db:
        orden = await db.get(Order, ORDEN)
        orden.status = "refunded"
        await db.commit()
        saldo = await db.scalar(select(OwnerSaleBalance))
        assert await liquidacion.puede_transferirse(db, saldo) == "order_not_payable"


@pytest.mark.asyncio
async def test_sin_onboarding_terminado_no_se_transfiere(sesiones):
    async with sesiones() as db:
        cuenta = await db.scalar(select(OwnerPayoutAccount))
        cuenta.onboarding_status = "incomplete"
        await db.commit()
        saldo = await db.scalar(select(OwnerSaleBalance))
        assert await liquidacion.puede_transferirse(db, saldo) == "onboarding_incomplete"


@pytest.mark.asyncio
async def test_la_cuenta_tiene_que_ser_la_DEL_PROPIETARIO(sesiones):
    """Pagar la venta de Bruno a la cuenta de otro es el peor error posible."""
    async with sesiones() as db:
        cuenta = await db.scalar(select(OwnerPayoutAccount))
        cuenta.owner_id = ANA
        await db.commit()
        saldo = await db.scalar(select(OwnerSaleBalance))
        assert await liquidacion.puede_transferirse(db, saldo) == "payout_account_mismatch"


@pytest.mark.asyncio
async def test_un_saldo_congelado_no_se_transfiere(sesiones):
    async with sesiones() as db:
        saldo = await db.scalar(select(OwnerSaleBalance))
        saldo.status = "frozen"
        await db.commit()
        assert await liquidacion.puede_transferirse(db, saldo) == "not_eligible"


# --------------------------------------------------------------------------- #
# 5. La ejecución
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_un_pago_con_exito_marca_el_saldo_transferido(sesiones, monkeypatch):
    doble = _usar(monkeypatch, DobleDeterminista())
    async with sesiones() as db:
        saldo = await db.scalar(select(OwnerSaleBalance))
        intento = await liquidacion.ejecutar_transferencia(db, saldo)
        await db.commit()
    assert intento is not None
    assert (await _saldo(sesiones)).status == "transferred"
    async with sesiones() as db:
        fila = await db.scalar(select(OwnerTransfer))
        assert fila.status == "completed"
        assert fila.external_transfer_id.startswith("tr_")
    assert len(doble.llamadas) == 1
    assert doble.llamadas[0].destination_account_id == "acct_bruno"


@pytest.mark.asyncio
async def test_dos_procesos_a_la_vez_solo_pagan_una(sesiones, monkeypatch):
    """El UPDATE condicional serializa: el segundo afecta a cero filas."""
    doble = _usar(monkeypatch, DobleDeterminista())
    async with sesiones() as db:
        saldo = await db.scalar(select(OwnerSaleBalance))
        assert await liquidacion.ejecutar_transferencia(db, saldo) is not None
        # El segundo relee el saldo, que ya no esta `eligible`.
        saldo2 = await db.scalar(select(OwnerSaleBalance))
        assert await liquidacion.ejecutar_transferencia(db, saldo2) is None
        await db.commit()
    assert len(doble.llamadas) == 1


@pytest.mark.asyncio
async def test_un_fallo_AMBIGUO_deja_el_pago_en_marcha(sesiones, monkeypatch):
    """Un tiempo de espera agotado NO significa que el dinero no haya salido.

    Se queda en `transferring` para que lo resuelva la conciliación, y no se
    devuelve a la cola: volver a `eligible` invitaría a un segundo pago.
    """
    class _Ambigua(DobleDeterminista):
        async def create_transfer(self, peticion):
            from app.modules.commerce.transferencias import TransferResult

            self.llamadas.append(peticion)
            return TransferResult(status="pending", failure_code="network_timeout")

    _usar(monkeypatch, _Ambigua())
    async with sesiones() as db:
        saldo = await db.scalar(select(OwnerSaleBalance))
        await liquidacion.ejecutar_transferencia(db, saldo)
        await db.commit()
    assert (await _saldo(sesiones)).status == "transferring"
    async with sesiones() as db:
        assert (await db.scalar(select(OwnerTransfer))).status == "processing"


@pytest.mark.asyncio
async def test_un_fallo_CONCLUYENTE_devuelve_el_saldo_a_la_cola(sesiones, monkeypatch):
    class _Rechaza(DobleDeterminista):
        async def create_transfer(self, peticion):
            from app.modules.commerce.transferencias import TransferResult

            self.llamadas.append(peticion)
            return TransferResult(status="failed", failure_code="account_closed")

    _usar(monkeypatch, _Rechaza())
    async with sesiones() as db:
        saldo = await db.scalar(select(OwnerSaleBalance))
        await liquidacion.ejecutar_transferencia(db, saldo)
        await db.commit()
    assert (await _saldo(sesiones)).status == "eligible"
    async with sesiones() as db:
        fila = await db.scalar(select(OwnerTransfer))
        assert fila.status == "failed"
        assert fila.failure_code == "account_closed"


@pytest.mark.asyncio
async def test_un_exito_SIN_identificador_no_marca_nada_como_pagado(
    sesiones, monkeypatch
):
    """Sin referencia no hay nada que conciliar ni que auditar."""
    class _SinId(DobleDeterminista):
        async def create_transfer(self, peticion):
            from app.modules.commerce.transferencias import TransferResult

            self.llamadas.append(peticion)
            return TransferResult(status="succeeded", external_transfer_id="")

    _usar(monkeypatch, _SinId())
    async with sesiones() as db:
        saldo = await db.scalar(select(OwnerSaleBalance))
        await liquidacion.ejecutar_transferencia(db, saldo)
        await db.commit()
    assert (await _saldo(sesiones)).status == "transferring"


@pytest.mark.asyncio
async def test_la_conciliacion_cierra_lo_que_quedo_en_marcha(sesiones, monkeypatch):
    doble = DobleDeterminista()

    class _Lenta(DobleDeterminista):
        async def create_transfer(self, peticion):
            from app.modules.commerce.transferencias import TransferResult

            self.llamadas.append(peticion)
            return TransferResult(
                status="pending", external_transfer_id="tr_lenta_1"
            )

        async def get_transfer_status(self, external_transfer_id):
            from app.modules.commerce.transferencias import TransferResult

            return TransferResult(
                status="succeeded", external_transfer_id=external_transfer_id
            )

    _usar(monkeypatch, _Lenta())
    async with sesiones() as db:
        saldo = await db.scalar(select(OwnerSaleBalance))
        await liquidacion.ejecutar_transferencia(db, saldo)
        await db.commit()
    assert (await _saldo(sesiones)).status == "transferring"

    async with sesiones() as db:
        intento = await db.scalar(select(OwnerTransfer))
        assert await liquidacion.conciliar_transferencia(db, intento) == "succeeded"
        await db.commit()
    assert (await _saldo(sesiones)).status == "transferred"
    assert doble is not None  # el doble base no se usó: lo hizo `_Lenta`


@pytest.mark.asyncio
async def test_conciliar_sin_referencia_no_concluye_nada(sesiones, monkeypatch):
    """Preguntar con una cadena vacía y tomar el «no encontrado» por un fallo
    marcaría como fallido un pago que pudo salir."""
    _usar(monkeypatch, DobleDeterminista())
    async with sesiones() as db:
        saldo = await db.scalar(select(OwnerSaleBalance))
        db.add(
            OwnerTransfer(
                balance_id=saldo.id, owner_id=BRUNO,
                payout_account_id=saldo.payout_account_id,
                amount_minor=NETO, currency="PEN", provider="stripe",
                environment="sandbox", idempotency_key="k", status="processing",
                attempts=1,
            )
        )
        await db.commit()
        intento = await db.scalar(select(OwnerTransfer))
        assert await liquidacion.conciliar_transferencia(db, intento) == "sin_referencia"


# --------------------------------------------------------------------------- #
# 6. El dinero retenido, visible
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_la_salud_de_los_saldos_saca_a_la_luz_lo_retenido(sesiones):
    """La señal que la documentación prometía vigilar y no tenía dónde verse.

    `pending` con `available_at` nulo son compras que nadie llegó a abrir: la
    garantía no ha arrancado, así que el saldo no tiene cuándo liberarse. Cien
    ventas así acumulan dinero parado hasta que alguien reclama.
    """
    from httpx import ASGITransport, AsyncClient

    from app.core.security import get_current_user
    from app.main import app
    from app.shared.database import get_db

    OTRA_ORDEN = "00000000-0000-0000-0000-0000000000a2"
    async with sesiones() as db:
        # Un saldo por orden: la 0049 lo impone, asi que hace falta otra venta.
        producto = await db.scalar(select(CommerceProduct))
        db.add(
            Order(
                id=OTRA_ORDEN, user_id=ANA, commerce_product_id=producto.id,
                provider="stripe", channel="web", environment="sandbox",
                amount_minor=PRECIO, currency="PEN", status="paid",
            )
        )
        await db.flush()
        # Sin fecha de vencimiento: es el que tiene que destacar.
        db.add(
            OwnerSaleBalance(
                order_id=OTRA_ORDEN, course_id=CURSO, owner_id=BRUNO,
                payout_account_id=None, gross_amount_minor=PRECIO,
                platform_fee_minor=PRECIO - NETO, provider_fee_minor=0,
                net_amount_minor=NETO, currency="PEN", fee_rules_version="v1",
                status="pending", available_at=None,
            )
        )
        await db.commit()

    identidad = {"uid": BRUNO}

    async def _sesion():
        async with sesiones() as db:
            yield db

    app.dependency_overrides[get_db] = _sesion
    app.dependency_overrides[get_current_user] = lambda: AuthUser(
        id=identidad["uid"], email="x@y.z"
    )
    try:
        transporte = ASGITransport(app=app)
        async with AsyncClient(transport=transporte, base_url="http://t") as http:
            # Quien no es administracion no lo ve. Se comprueba en el SERVIDOR.
            ajeno = await http.get("/api/v1/admin/owner-balances/health")
            assert ajeno.status_code == 403, ajeno.text

            async with sesiones() as db:
                perfil = await db.get(Profile, BRUNO)
                perfil.role = "admin"
                await db.commit()

            respuesta = await http.get("/api/v1/admin/owner-balances/health")
            assert respuesta.status_code == 200, respuesta.text
            cuerpo = respuesta.json()
            assert cuerpo["sin_fecha"] == 1
            assert cuerpo["por_estado"]["eligible"]["count"] == 1
            assert cuerpo["por_estado"]["eligible"]["net_amount_minor"] == NETO
            # Las siete claves siempre presentes, aunque valgan cero.
            assert cuerpo["por_estado"]["transferred"]["count"] == 0
    finally:
        app.dependency_overrides.clear()


async def _como_admin(sesiones):
    """Cliente HTTP autenticado como administración. Devuelve (http, cerrar)."""
    from httpx import ASGITransport, AsyncClient

    from app.core.security import get_current_user
    from app.main import app
    from app.shared.database import get_db

    async with sesiones() as db:
        perfil = await db.get(Profile, BRUNO)
        perfil.role = "admin"
        await db.commit()

    async def _sesion():
        async with sesiones() as db:
            yield db

    app.dependency_overrides[get_db] = _sesion
    app.dependency_overrides[get_current_user] = lambda: AuthUser(
        id=BRUNO, email="x@y.z"
    )
    http = AsyncClient(transport=ASGITransport(app=app), base_url="http://t")

    async def _cerrar() -> None:
        await http.aclose()
        app.dependency_overrides.clear()

    return http, _cerrar


@pytest.mark.asyncio
async def test_la_liquidacion_tiene_por_fin_quien_la_dispare(sesiones, monkeypatch):
    """El saldo vencido llega a `eligible` y se paga. Antes no lo hacía nadie.

    EL AGUJERO QUE ESTO CIERRA. `liberar_vencidos` y `ejecutar_transferencia`
    estaban escritas, documentadas y probadas, y no las llamaba ni un endpoint
    ni una tarea. Un saldo `pending` con la fecha ya pasada se quedaba ahí para
    siempre, así que `puede_transferirse` contestaba `not_eligible` eternamente
    y el dinero del propietario no salía aunque las banderas estuvieran puestas.
    """
    _usar(monkeypatch, DobleDeterminista())
    async with sesiones() as db:
        # El saldo de la fixture ya está `eligible`; se retrocede a `pending`
        # con la fecha vencida para que la pasada tenga que hacer las dos cosas.
        saldo = await db.scalar(select(OwnerSaleBalance))
        saldo.status = "pending"
        saldo.available_at = _antes(2)
        await db.commit()

    http, cerrar = await _como_admin(sesiones)
    try:
        respuesta = await http.post("/api/v1/admin/owner-balances/settle")
        assert respuesta.status_code == 200, respuesta.text
        cuerpo = respuesta.json()
        assert cuerpo["liberados"] == 1
        assert cuerpo["transferencias_intentadas"] == 1
        assert cuerpo["transferencias_completadas"] == 1
        assert cuerpo["fallidos"] == 0
    finally:
        await cerrar()

    async with sesiones() as db:
        saldo = await db.scalar(select(OwnerSaleBalance))
        assert saldo.status == "transferred"
        intento = await db.scalar(select(OwnerTransfer))
        assert intento is not None and intento.status == "completed"


@pytest.mark.asyncio
async def test_liquidar_dos_veces_no_paga_dos_veces(sesiones, monkeypatch):
    """Idempotente: la segunda pasada no encuentra nada que hacer."""
    _usar(monkeypatch, DobleDeterminista())
    http, cerrar = await _como_admin(sesiones)
    try:
        primera = (await http.post("/api/v1/admin/owner-balances/settle")).json()
        segunda = (await http.post("/api/v1/admin/owner-balances/settle")).json()
    finally:
        await cerrar()

    assert primera["transferencias_intentadas"] == 1
    assert segunda["transferencias_intentadas"] == 0
    async with sesiones() as db:
        assert len(list(await db.scalars(select(OwnerTransfer)))) == 1


@pytest.mark.asyncio
async def test_con_las_banderas_apagadas_se_libera_pero_no_se_paga(sesiones):
    """Liberar es contabilidad interna; transferir es dinero saliendo.

    Con `creator_transfers_enabled` apagada, el saldo tiene que poder llegar a
    `eligible` —eso solo mueve un estado— y ninguna transferencia debe
    intentarse. El motivo sale en `omitidos`, que es lo que explica el cero.
    """
    ajustes = get_settings()
    ajustes.creator_transfers_enabled = False
    async with sesiones() as db:
        saldo = await db.scalar(select(OwnerSaleBalance))
        saldo.status = "pending"
        saldo.available_at = _antes(2)
        await db.commit()

    http, cerrar = await _como_admin(sesiones)
    try:
        cuerpo = (await http.post("/api/v1/admin/owner-balances/settle")).json()
    finally:
        await cerrar()

    assert cuerpo["liberados"] == 1
    assert cuerpo["transferencias_intentadas"] == 0
    assert cuerpo["omitidos"] == {"transfers_disabled": 1}
    async with sesiones() as db:
        assert (await db.scalar(select(OwnerSaleBalance))).status == "eligible"
        assert await db.scalar(select(OwnerTransfer)) is None


@pytest.mark.asyncio
async def test_liberar_no_descongela_una_disputa(sesiones, monkeypatch):
    """Un contracargo congela el saldo. La liberacion no puede deshacerlo.

    LA CARRERA, Y HAY QUE PROVOCARLA DE VERDAD. `liberar_vencidos` lee los
    identificadores con `status = 'pending'` y despues escribe. Entre las dos
    sentencias cabe `charge.dispute.created`, que pone el saldo en `frozen` sin
    solicitud asociada; filtrando el UPDATE solo por `id`, lo devolvia a
    `eligible` y autorizaba un pago sobre dinero que el banco esta reclamando.

    CONGELARLO ANTES DE LLAMAR NO PRUEBA NADA: el propio SELECT lo descartaria
    y la funcion saldria por `if not ids`. Hay que colarse ENTRE las dos, y por
    eso se envuelve el `flush` que va justo despues de la lectura.
    """
    async with sesiones() as db:
        saldo = await db.scalar(select(OwnerSaleBalance))
        saldo.status = "pending"
        saldo.available_at = _antes(2)
        await db.commit()
        identificador = saldo.id

    async with sesiones() as db:
        original = db.execute
        llamadas = {"n": 0}

        async def _colarse(sentencia, *args, **kwargs):
            resultado = await original(sentencia, *args, **kwargs)
            # La PRIMERA sentencia de `liberar_vencidos` es el SELECT de
            # candidatos. Justo despues, y antes del UPDATE, entra la disputa.
            llamadas["n"] += 1
            if llamadas["n"] == 1:
                await original(
                    update(OwnerSaleBalance)
                    .where(OwnerSaleBalance.id == identificador)
                    .values(status="frozen", frozen_by_request_id=None)
                )
            return resultado

        monkeypatch.setattr(db, "execute", _colarse)
        movidos = await liquidacion.liberar_vencidos(db)
        monkeypatch.undo()
        await db.commit()

    # El UPDATE no encontro ninguna fila `pending`: no movio nada y lo dice.
    assert movidos == 0
    async with sesiones() as db:
        assert (await db.scalar(select(OwnerSaleBalance))).status == "frozen"


@pytest.mark.asyncio
async def test_un_saldo_que_falla_no_se_lleva_por_delante_a_los_demas(
    sesiones, monkeypatch
):
    """El `rollback` de una vuelta caduca los objetos de todas las demas.

    `Session.rollback()` expira TODO el mapa de identidad, no solo lo de la
    vuelta que fallo. Recorriendo una lista de objetos ya cargados, la vuelta
    siguiente leia `saldo.status` de uno caducado y disparaba una recarga
    perezosa: `MissingGreenlet` sin capturar, un 500, y los saldos restantes
    sin pagar. Justo lo contrario de lo que el `try` del bucle promete.
    """
    OTRA_ORDEN = "00000000-0000-0000-0000-0000000000a3"
    async with sesiones() as db:
        producto = await db.scalar(select(CommerceProduct))
        cuenta = await db.scalar(select(OwnerPayoutAccount))
        db.add(
            Order(
                id=OTRA_ORDEN, user_id=ANA, commerce_product_id=producto.id,
                provider="stripe", channel="web", environment="sandbox",
                amount_minor=PRECIO, currency="PEN", status="paid",
            )
        )
        await db.flush()
        db.add(
            OwnerSaleBalance(
                order_id=OTRA_ORDEN, course_id=CURSO, owner_id=BRUNO,
                payout_account_id=cuenta.id, gross_amount_minor=PRECIO,
                platform_fee_minor=PRECIO - NETO, provider_fee_minor=0,
                net_amount_minor=NETO, currency="PEN", fee_rules_version="v1",
                status="eligible", available_at=_antes(1),
            )
        )
        await db.commit()

    class _FallaLaPrimera(DobleDeterminista):
        """Revienta con el primer saldo y paga el segundo."""

        def __init__(self) -> None:
            super().__init__()
            self.veces = 0

        async def create_transfer(self, peticion):
            self.veces += 1
            if self.veces == 1:
                raise RuntimeError("la pasarela se cayo")
            return await super().create_transfer(peticion)

    _usar(monkeypatch, _FallaLaPrimera())

    http, cerrar = await _como_admin(sesiones)
    try:
        respuesta = await http.post("/api/v1/admin/owner-balances/settle")
        assert respuesta.status_code == 200, respuesta.text
        cuerpo = respuesta.json()
    finally:
        await cerrar()

    # Uno cae, el otro cobra. Antes caian los dos con un 500.
    assert cuerpo["fallidos"] == 1
    assert cuerpo["transferencias_completadas"] == 1
    async with sesiones() as db:
        estados = sorted(
            s.status for s in await db.scalars(select(OwnerSaleBalance))
        )
        assert estados == ["eligible", "transferred"], estados
