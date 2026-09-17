"""Incremento 5 de Productos: pedido y compra protegida, contra PostgreSQL.

LO QUE DEFIENDEN ESTAS PRUEBAS, y por qué cada una:

  1. SIN POLÍTICA APROBADA NO SE VENDE. Ni con todas las banderas encendidas.
  2. ENCENDER UNA BANDERA NO BASTA. Son cinco y una política.
  3. DOS COMPRADORES NO SE LLEVAN LA MISMA ÚLTIMA UNIDAD. Con el orden de las
     transacciones fijado a mano: si no se fija, la prueba pasa por suerte.
  4. SI FALTA UNA UNIDAD, NO SE RESERVA NINGUNA. Todo o nada.
  5. LA MISMA CLAVE NO CREA DOS PEDIDOS, y reutilizarla con otro cuerpo es un
     conflicto, no un «te devuelvo el anterior».
  6. EL SERVIDOR CALCULA EL IMPORTE. El cliente no manda ninguno.
  7. LA VUELTA DEL NAVEGADOR NO CONFIRMA DINERO. Solo un aviso verificado.
  8. UN AVISO REPETIDO NO COBRA DOS VECES, y uno de otro importe, otra moneda u
     otro entorno no confirma nada.
  9. UN PAGO PARCIAL NO PAGA.
 10. LIBERAR OCURRE EXACTAMENTE UNA VEZ, venga de cancelar o de vencer.
 11. UN PAGO TARDÍO NO SE COBRA EN SILENCIO NI SE NIEGA EN SILENCIO.
 12. EL PROVEEDOR VE SUS PEDIDOS PAGADOS Y NADA MÁS. Ni cobros, ni compradores,
     ni direcciones de otros.
 13. NI EL HISTORIAL NI LA AUDITORÍA GUARDAN DATOS PERSONALES.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.exceptions import AppError
from app.modules.payments.providers import CheckoutSession
from app.modules.products import carts, esquema, inventory, pagos, pedidos, politicas
from app.modules.products.models import (
    PEDIDO_CANCELADO,
    PEDIDO_EN_REVISION,
    PEDIDO_FALLIDO,
    PEDIDO_PAGADO,
    PEDIDO_PENDIENTE,
    PEDIDO_PROCESANDO,
    PEDIDO_VENCIDO,
    InventoryMovement,
    ProductOrder,
    ProductOrderEvent,
    ProductOrderItem,
)
from tests.test_productos_carrito import con_existencias, variantes_de
from tests.test_productos_catalogo import publicado
from tests.test_productos_dominio import (  # noqa: F401
    SIN_POSTGRES,
    URL,
    base_aplicada,
    persona,
    sesiones,
    vendedor,
)

TEXTO = (
    "Condiciones de venta de prueba. Plazos, desistimiento y devolucion "
    "escritos para que el texto tenga la longitud minima que exige la base."
)

DIRECCION = {
    "recipient_name": "Quien recibe",
    "phone": "+51987654321",
    "country_code": "PE",
    "region": "Lima",
    "city": "Lima",
    "district": "Miraflores",
    "address_line": "Avenida siempre viva 742",
    "reference": "Frente al parque",
    "postal_code": "15074",
    "instructions": None,
}


@pytest.fixture()
def motor(base_aplicada):
    return create_async_engine(
        URL.replace("postgresql://", "postgresql+asyncpg://", 1), pool_size=20
    )


@pytest.fixture()
def venta_encendida(monkeypatch):
    """Las cinco condiciones, encendidas A MANO y solo para esta prueba.

    NO SE TOCA EL `.env` NI NINGÚN VALOR POR DEFECTO. Que la configuración de
    fábrica no venda es justamente lo que otra prueba comprueba.
    """
    ajustes = get_settings()
    for nombre, valor in (
        ("feature_product_sales", True),
        ("payments_enabled", True),
        ("stripe_payments_enabled", True),
        ("product_reservation_minutes", 30),
        ("stripe_secret_key", "sk_test_de_mentira_para_la_prueba"),
    ):
        monkeypatch.setattr(ajustes, nombre, valor, raising=False)
    return ajustes


class PasarelaDeMentira:
    """La FRONTERA del proveedor, simulada. No sale a la red.

    Se simula el borde y nada más: la firma, la barrera anti-repetición y la
    máquina de estados son las de verdad.
    """

    name = "stripe"

    def __init__(self, *, revienta: bool = False) -> None:
        self.revienta = revienta
        self.llamadas: list = []

    async def create_checkout(self, request):
        self.llamadas.append(request)
        if self.revienta:
            raise RuntimeError("la pasarela no contesta")
        return CheckoutSession(
            checkout_url=f"https://checkout.example/{request.purchase_id}",
            provider_reference=f"cs_{request.purchase_id[:12]}",
        )


class AvisoDeMentira:
    """Un aviso YA VERIFICADO, como el que entrega el webhook compartido."""

    def __init__(
        self,
        *,
        purchase_id: str,
        status: str = "paid",
        amount_minor: int | None = None,
        currency: str | None = "PEN",
        environment: str = "sandbox",
        transaction: str = "pi_de_prueba",
        event_type: str = "checkout.session.completed",
    ) -> None:
        self.purchase_id = purchase_id
        self.status = status
        self.amount_minor = amount_minor
        self.currency = currency
        self.environment = environment
        self.provider_transaction_id = transaction
        self.event_type = event_type
        self.event_id = "evt_" + uuid.uuid4().hex[:12]
        self.dominio = pagos.DOMINIO
        self.payload: dict = {}


# --------------------------------------------------------------------------- #
# Montaje
# --------------------------------------------------------------------------- #
async def politica_publicada(
    sesiones, *, pais="PE", moneda="PEN", texto=TEXTO, vigente_desde=None
) -> str:
    async with sesiones() as db:
        politica = await politicas.publicar(
            db,
            pais=pais,
            entidad="Entidad de prueba S.A.C.",
            moneda=moneda,
            texto=texto,
            incident_report_hours=72,
            return_shipment_days=7,
            withdrawal_days=7,
            buyer_pays_return_for_remorse=True,
            seller_pays_return_for_defect=True,
            warranty_rules_url=None,
            effective_at=vigente_desde,
            actor_id=None,
        )
        await db.commit()
        return politica.id


async def bolsa_con(sesiones, *, unidades=5, en_la_bolsa=2):
    """Un producto publicado con existencias y alguien con la bolsa llena."""
    producto_id, version_id, dueno = await publicado(sesiones)
    variantes = await variantes_de(sesiones, version_id)
    await con_existencias(sesiones, producto_id, variantes[0].sku, unidades)
    comprador = await persona(sesiones, "compra")
    async with sesiones() as db:
        await carts.anadir(
            db,
            usuario_id=comprador,
            producto_id=producto_id,
            variante_id=variantes[0].id,
            cantidad=en_la_bolsa,
        )
        await db.commit()
    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
    return producto_id, variantes, comprador, bolsa.items[0].seller_id


async def crear_pedido(
    sesiones, *, comprador, seller_id, politica_id, clave=None, direccion=None
):
    async with sesiones() as db:
        politica = await politicas.exigir_vigente(
            db, pais=(direccion or DIRECCION)["country_code"]
        )
        creado = await pedidos.crear(
            db,
            usuario_id=comprador,
            seller_id=seller_id,
            direccion=dict(direccion or DIRECCION),
            policy_id=politica_id,
            policy_terms_sha256=politica.terms_sha256,
            clave=clave or ("k-" + uuid.uuid4().hex[:10]),
        )
        return creado


# =========================================================================== #
# 1. Sin política no se vende
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_politica_no_se_vende_ni_con_todo_encendido(
    sesiones, venta_encendida
) -> None:
    """LA REGLA PRINCIPAL. Cinco banderas encendidas y aun así no se vende:
    falta la decisión legal, y esa no la toma un interruptor."""
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await pedidos.crear(
                db,
                usuario_id=comprador,
                seller_id=seller_id,
                direccion=dict(DIRECCION),
                policy_id=str(uuid.uuid4()),
                policy_terms_sha256="a" * 64,
                clave="k1",
            )
    assert fallo.value.code == "product_policy_not_configured"
    assert fallo.value.status_code == 409


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_politica_con_fecha_futura_todavia_no_vende(
    sesiones, venta_encendida
) -> None:
    """PUBLICADA NO ES VIGENTE. Una política que entra en vigor mañana existe
    para poder revisarla; elegirla hoy dejaría comprar bajo condiciones que
    todavía no son las de nadie."""
    manana = datetime.now(timezone.utc) + timedelta(days=1)
    await politica_publicada(sesiones, vigente_desde=manana)
    async with sesiones() as db:
        assert await politicas.vigente(db, pais="PE") is None
        assert await politicas.paises_con_politica(db) == []


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_publicar_sin_plazos_no_se_puede(sesiones) -> None:
    """EL CHECK DE LA BASE, no un `if` nuestro. Una política publicada sin
    plazo de desistimiento no puede existir."""
    from app.modules.products.models import POLITICA_PUBLICADA, ProductPolicy

    async with sesiones() as db:
        db.add(
            ProductPolicy(
                country_code="AR",
                seller_entity="Entidad",
                version=1,
                currency="ARS",
                terms=TEXTO,
                terms_sha256=politicas.huella(TEXTO),
                status=POLITICA_PUBLICADA,
                effective_at=datetime.now(timezone.utc),
                published_at=datetime.now(timezone.utc),
                withdrawal_days=None,
            )
        )
        with pytest.raises(Exception):
            await db.commit()
        await db.rollback()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_huella_no_cambia_entre_saltos_de_linea() -> None:
    """CRLF Y LF SON EL MISMO PÁRRAFO. Sin normalizar, pegar el texto desde
    otro editor cambiaría la huella sin cambiar una palabra, y todos los
    pedidos anteriores parecerían citar algo distinto."""
    unix = "Primera linea\nSegunda linea"
    windows = "Primera linea\r\nSegunda linea"
    assert politicas.huella(unix) == politicas.huella(windows)


# =========================================================================== #
# 2. Encender una bandera no basta
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_bandera_sola_no_habilita_la_venta(sesiones, monkeypatch) -> None:
    """CINCO CONDICIONES. Se enciende una cada vez y se comprueba que las otras
    cuatro siguen bloqueando: una defensa que se cae con un interruptor no es
    una defensa."""
    ajustes = get_settings()
    todas = (
        ("feature_product_sales", True),
        ("payments_enabled", True),
        ("stripe_payments_enabled", True),
        ("product_reservation_minutes", 30),
        ("stripe_secret_key", "sk_test_x"),
    )
    for nombre, valor in todas:
        monkeypatch.setattr(ajustes, nombre, valor, raising=False)
        faltan = pedidos.por_que_no_se_puede_vender()
        assert faltan, f"encender {nombre} basto para habilitar la venta"
        monkeypatch.undo()
    #: Y con las cinco, la puerta de configuración se abre —que no es lo mismo
    #: que poder vender: todavía hace falta la política.
    for nombre, valor in todas:
        monkeypatch.setattr(ajustes, nombre, valor, raising=False)
    assert pedidos.por_que_no_se_puede_vender() == []


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_duracion_de_reserva_no_se_vende(sesiones, monkeypatch) -> None:
    """CERO NO ES UN VALOR POR DEFECTO SILENCIOSO: es «sin configurar»."""
    ajustes = get_settings()
    for nombre, valor in (
        ("feature_product_sales", True),
        ("payments_enabled", True),
        ("stripe_payments_enabled", True),
        ("stripe_secret_key", "sk_test_x"),
        ("product_reservation_minutes", 0),
    ):
        monkeypatch.setattr(ajustes, nombre, valor, raising=False)
    assert "product_reservation_minutes" in pedidos.por_que_no_se_puede_vender()
    with pytest.raises(AppError) as fallo:
        pedidos.exigir_venta_habilitada()
    assert fallo.value.code == "product_sales_not_enabled"
    assert fallo.value.status_code == 503


# =========================================================================== #
# 3. Crear el pedido: importes, reserva y congelación
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_crear_congela_precios_y_reserva_el_inventario(
    sesiones, venta_encendida
) -> None:
    producto_id, variantes, comprador, seller_id = await bolsa_con(
        sesiones, unidades=5, en_la_bolsa=2
    )
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    assert creado.estrenado is True
    assert creado.orden.status == PEDIDO_PENDIENTE
    #: EL IMPORTE LO CALCULA EL SERVIDOR: 18000 x 2.
    assert creado.orden.subtotal_minor == 36_000
    assert creado.orden.total_minor == creado.orden.subtotal_minor
    assert creado.orden.currency == "PEN"
    assert creado.orden.reserved_until is not None

    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        lineas = await pedidos.lineas_de(db, creado.orden.id)
        direccion = await pedidos.direccion_de(db, creado.orden.id)
    assert hay.reserved == 2
    assert hay.available == 3
    assert len(lineas) == 1
    assert lineas[0].unit_price_minor == 18_000
    assert lineas[0].name_snapshot
    assert direccion is not None and direccion.district == "Miraflores"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_las_lineas_de_un_pedido_no_se_pueden_editar(
    sesiones, venta_encendida
) -> None:
    """UN IMPORTE QUE SE PUEDE EDITAR DESPUÉS DE COBRARLO NO ES UN IMPORTE.
    Lo impone un disparador, no una costumbre del servidor."""
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    async with sesiones() as db:
        linea = (await pedidos.lineas_de(db, creado.orden.id))[0]
        linea.unit_price_minor = 1
        with pytest.raises(Exception):
            await db.commit()
        await db.rollback()


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_pedido_congela_la_politica_que_se_acepto(
    sesiones, venta_encendida
) -> None:
    """PUBLICAR LA SIGUIENTE NO LE CAMBIA LAS REGLAS A QUIEN YA COMPRÓ."""
    #: UN PAIS PROPIO PARA ESTA PRUEBA. La base es de modulo y otras pruebas ya
    #: publicaron versiones de PE: contar «la 1 y la 2» alli seria contar lo que
    #: dejo otra prueba.
    direccion = {**DIRECCION, "country_code": "BO", "district": None}
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones, pais="BO")
    creado = await crear_pedido(
        sesiones,
        comprador=comprador,
        seller_id=seller_id,
        politica_id=politica_id,
        direccion=direccion,
    )
    guardada = creado.orden.policy_terms_sha256
    await politica_publicada(
        sesiones, pais="BO", texto=TEXTO + " Version dos, otro texto."
    )
    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
        vigente = await politicas.exigir_vigente(db, pais="BO")
    assert orden.policy_terms_sha256 == guardada
    assert orden.policy_version == 1
    assert vigente.version == 2
    assert vigente.terms_sha256 != guardada


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_aceptar_una_politica_que_ya_cambio_no_compra(
    sesiones, venta_encendida
) -> None:
    """UNA ACEPTACIÓN DE UN TEXTO QUE YA NO RIGE NO ES UNA ACEPTACIÓN."""
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    vieja = await politica_publicada(sesiones)
    async with sesiones() as db:
        huella_vieja = (await db.get(
            __import__(
                "app.modules.products.models", fromlist=["ProductPolicy"]
            ).ProductPolicy,
            vieja,
        )).terms_sha256
    await politica_publicada(sesiones, texto=TEXTO + " Version dos.")
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await pedidos.crear(
                db,
                usuario_id=comprador,
                seller_id=seller_id,
                direccion=dict(DIRECCION),
                policy_id=vieja,
                policy_terms_sha256=huella_vieja,
                clave="k-vieja",
            )
    assert fallo.value.code == "product_policy_changed"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_moneda_que_la_politica_no_admite_no_compra(
    sesiones, venta_encendida
) -> None:
    """COBRAR EN UNA MONEDA QUE LA POLÍTICA NO CONTEMPLA deja el comprobante
    sin respaldo."""
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones, moneda="USD")
    async with sesiones() as db:
        politica = await politicas.exigir_vigente(db, pais="PE")
        with pytest.raises(AppError) as fallo:
            await pedidos.crear(
                db,
                usuario_id=comprador,
                seller_id=seller_id,
                direccion=dict(DIRECCION),
                policy_id=politica.id,
                policy_terms_sha256=politica.terms_sha256,
                clave="k-moneda",
            )
    assert fallo.value.code == "product_policy_currency_mismatch"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_direccion_sin_distrito_en_peru_no_se_acepta(
    sesiones, venta_encendida
) -> None:
    """DONDE LA DIRECCIÓN NO SE ENTIENDE SIN DISTRITO, es obligatorio."""
    sin_distrito = {**DIRECCION, "district": None}
    with pytest.raises(AppError) as fallo:
        pedidos.validar_direccion(sin_distrito)
    assert fallo.value.code == "product_address_invalid"
    assert fallo.value.details["field"] == "district"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_direccion_no_guarda_coordenadas(sesiones, venta_encendida) -> None:
    """NI LATITUD NI LONGITUD. Para entregar un paquete basta la dirección."""
    from app.modules.products.models import ProductOrderAddress

    columnas = set(ProductOrderAddress.__table__.columns.keys())
    assert not columnas & {"latitude", "longitude", "geo", "document_number"}


# =========================================================================== #
# 4. Todo o nada, y la última unidad
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_si_falta_una_unidad_no_se_reserva_ninguna(
    sesiones, venta_encendida
) -> None:
    """MEDIO PEDIDO RESERVADO ES INVENTARIO APARTADO POR UNA COMPRA QUE NADIE
    VA A COMPLETAR.

    EL ESTADO SE MONTA POR EL CAMINO REAL. No se puede meter en la bolsa mas de
    lo que hay —`anadir` ya lo impide— asi que lo que se reproduce es lo que si
    pasa: se llena la bolsa cuando alcanzaba y OTRA PERSONA se lleva las
    unidades de la segunda linea antes de que esta compre.
    """
    producto_id, version_id, _ = await publicado(sesiones)
    variantes = await variantes_de(sesiones, version_id)
    #: La primera variante tiene de sobra; de la segunda hay exactamente dos.
    await con_existencias(sesiones, producto_id, variantes[0].sku, 10)
    await con_existencias(sesiones, producto_id, variantes[1].sku, 2)
    politica_id = await politica_publicada(sesiones)

    comprador = await persona(sesiones, "compra")
    async with sesiones() as db:
        for variante, cuantas in ((variantes[0], 2), (variantes[1], 2)):
            await carts.anadir(
                db,
                usuario_id=comprador,
                producto_id=producto_id,
                variante_id=variante.id,
                cantidad=cuantas,
            )
        await db.commit()
        bolsa = await carts.leer(db, usuario_id=comprador)
        seller_id = bolsa.items[0].seller_id

    #: OTRA PERSONA SE LLEVA UNA DE LAS DOS de la segunda variante, por el
    #: camino real: su propio pedido, con su propia reserva.
    otra = await persona(sesiones, "otra")
    async with sesiones() as db:
        await carts.anadir(
            db,
            usuario_id=otra,
            producto_id=producto_id,
            variante_id=variantes[1].id,
            cantidad=1,
        )
        await db.commit()
    await crear_pedido(
        sesiones, comprador=otra, seller_id=seller_id, politica_id=politica_id
    )

    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await pedidos.crear(
                db,
                usuario_id=comprador,
                seller_id=seller_id,
                direccion=dict(DIRECCION),
                policy_id=politica_id,
                policy_terms_sha256=(
                    await politicas.exigir_vigente(db, pais="PE")
                ).terms_sha256,
                clave="k-todo-o-nada",
            )
    assert fallo.value.code == "product_cart_not_purchasable"

    async with sesiones() as db:
        primera = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        segunda = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[1].sku
        )
        pedidos_creados = await db.scalar(
            select(func.count())
            .select_from(ProductOrder)
            .where(ProductOrder.buyer_id == comprador)
        )
    #: NI UNA UNIDAD DE LA PRIMERA LINEA, aunque de esa hubiera de sobra.
    assert primera.reserved == 0, "se reservo la primera linea de un pedido que fallo"
    #: Y lo que aparta la segunda es SOLO lo de la otra persona.
    assert segunda.reserved == 1
    assert pedidos_creados == 0


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_si_la_reserva_falla_a_media_lista_no_queda_nada(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """LA OTRA CAPA: que la transaccion entera se deshaga.

    La comprobacion de arriba mira el carrito ANTES de bloquear nada; esta mira
    que si la reserva falla con las filas ya bloqueadas —la carrera de verdad,
    que ocurre entre leer y bloquear— no quede ni el pedido ni media reserva.
    El fallo se inyecta en la segunda unidad porque reproducir esa ventana a
    mano es lo unico que no se puede hacer de forma determinista.
    """
    producto_id, version_id, _ = await publicado(sesiones)
    variantes = await variantes_de(sesiones, version_id)
    await con_existencias(sesiones, producto_id, variantes[0].sku, 10)
    await con_existencias(sesiones, producto_id, variantes[1].sku, 10)
    politica_id = await politica_publicada(sesiones)
    comprador = await persona(sesiones, "compra")
    async with sesiones() as db:
        for variante in (variantes[0], variantes[1]):
            await carts.anadir(
                db,
                usuario_id=comprador,
                producto_id=producto_id,
                variante_id=variante.id,
                cantidad=2,
            )
        await db.commit()
        bolsa = await carts.leer(db, usuario_id=comprador)
        seller_id = bolsa.items[0].seller_id

    real = inventory.reservar
    vistas: list[str] = []

    async def reservar_con_una_averia(db, **kwargs):
        vistas.append(kwargs["sku"])
        if len(vistas) == 2:
            raise inventory.NoAlcanza("Alguien se la llevo mientras tanto.")
        return await real(db, **kwargs)

    monkeypatch.setattr(inventory, "reservar", reservar_con_una_averia)
    async with sesiones() as db:
        with pytest.raises(AppError):
            await pedidos.crear(
                db,
                usuario_id=comprador,
                seller_id=seller_id,
                direccion=dict(DIRECCION),
                policy_id=politica_id,
                policy_terms_sha256=(
                    await politicas.exigir_vigente(db, pais="PE")
                ).terms_sha256,
                clave="k-averia",
            )
        await db.rollback()

    assert len(vistas) == 2, "no se intento reservar la segunda unidad"
    #: Y EN ORDEN ESTABLE, que es lo que impide que dos compras se abracen.
    assert vistas == sorted(vistas)
    async with sesiones() as db:
        primera = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        movimientos = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(
                InventoryMovement.product_id == producto_id,
                InventoryMovement.kind == "reservation",
            )
        )
        pedidos_creados = await db.scalar(
            select(func.count())
            .select_from(ProductOrder)
            .where(ProductOrder.buyer_id == comprador)
        )
    assert primera.reserved == 0, "quedo media reserva de un pedido que no existe"
    assert movimientos == 0, "quedo un movimiento de un pedido que no existe"
    assert pedidos_creados == 0


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_compradores_no_se_llevan_la_misma_ultima_unidad(
    sesiones, motor, venta_encendida
) -> None:
    """EL ORDEN, FIJADO A MANO. Sin fijarlo, la prueba pasaría por suerte: A
    bloquea y no confirma, B tiene que quedarse esperando, A se lleva la
    unidad y solo entonces B despierta y se estrella.
    """
    producto_id, version_id, _ = await publicado(sesiones)
    variantes = await variantes_de(sesiones, version_id)
    await con_existencias(sesiones, producto_id, variantes[0].sku, 1)
    politica_id = await politica_publicada(sesiones)
    uno = await persona(sesiones, "uno")
    dos = await persona(sesiones, "dos")
    async with sesiones() as db:
        for quien in (uno, dos):
            await carts.anadir(
                db,
                usuario_id=quien,
                producto_id=producto_id,
                variante_id=variantes[0].id,
                cantidad=1,
            )
        await db.commit()
    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=uno)
        seller_id = bolsa.items[0].seller_id
        huella = (await politicas.exigir_vigente(db, pais="PE")).terms_sha256

    Sesion = async_sessionmaker(motor, expire_on_commit=False)
    empezo = asyncio.Event()
    suelta = asyncio.Event()

    async def compra(quien: str, *, espera: bool):
        async with Sesion() as db:
            if espera:
                await empezo.wait()
            creado = await pedidos.crear(
                db,
                usuario_id=quien,
                seller_id=seller_id,
                direccion=dict(DIRECCION),
                policy_id=politica_id,
                policy_terms_sha256=huella,
                clave="k-" + quien[:8],
            )
            return creado.orden.id

    async def primera():
        async with Sesion() as db:
            #: Toma la fila del inventario y NO confirma: es el cerrojo que la
            #: segunda tiene que encontrarse puesto.
            await inventory._bloqueada(
                db, product_id=producto_id, sku=variantes[0].sku, crear=False
            )
            empezo.set()
            await suelta.wait()
            await db.rollback()

    bloqueo = asyncio.create_task(primera())
    segunda = asyncio.create_task(compra(dos, espera=True))
    await empezo.wait()
    await asyncio.sleep(0.5)
    #: LO QUE DE VERDAD DEMUESTRA EL BLOQUEO DE FILA. Si la segunda compra
    #: hubiera terminado ya, el `for update` no estaria ordenando nada y la
    #: prueba estaria pasando por casualidad.
    assert not segunda.done(), "la segunda compra no se quedo esperando el cerrojo"
    suelta.set()
    await bloqueo

    ganadora = await segunda
    assert ganadora is not None

    #: Y LA QUE LLEGA DESPUES NO SE LLEVA LA MISMA UNIDAD.
    with pytest.raises(AppError):
        await compra(uno, espera=False)

    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        cuantos = await db.scalar(
            select(func.count())
            .select_from(ProductOrderItem)
            .where(ProductOrderItem.product_id == producto_id)
        )
    assert hay.reserved == 1, "se reservo mas de lo que hay"
    assert hay.available == 0
    #: UNA unidad, UNA linea de pedido.
    assert cuantos == 1


# =========================================================================== #
# 5. Idempotencia
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_misma_clave_no_crea_dos_pedidos(sesiones, venta_encendida) -> None:
    producto_id, variantes, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    uno = await crear_pedido(
        sesiones,
        comprador=comprador,
        seller_id=seller_id,
        politica_id=politica_id,
        clave="doble-toque",
    )
    dos = await crear_pedido(
        sesiones,
        comprador=comprador,
        seller_id=seller_id,
        politica_id=politica_id,
        clave="doble-toque",
    )
    assert uno.orden.id == dos.orden.id
    assert dos.estrenado is False
    async with sesiones() as db:
        cuantos = await db.scalar(
            select(func.count())
            .select_from(ProductOrder)
            .where(ProductOrder.buyer_id == comprador)
        )
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert cuantos == 1
    #: Y NO RESERVÓ DOS VECES.
    assert hay.reserved == 2


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_reutilizar_la_clave_con_otro_cuerpo_es_un_conflicto(
    sesiones, venta_encendida
) -> None:
    """QUIEN REINTENTA CON OTRO CONTENIDO NO ESTÁ REINTENTANDO. Devolverle el
    pedido anterior le diría «hecho» sobre una dirección que no es la suya."""
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    await crear_pedido(
        sesiones,
        comprador=comprador,
        seller_id=seller_id,
        politica_id=politica_id,
        clave="misma-clave",
    )
    otra = {**DIRECCION, "address_line": "Otra calle completamente distinta"}
    with pytest.raises(AppError) as fallo:
        await crear_pedido(
            sesiones,
            comprador=comprador,
            seller_id=seller_id,
            politica_id=politica_id,
            clave="misma-clave",
            direccion=otra,
        )
    assert fallo.value.code == "product_order_key_reused"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_pedido_vivo_a_la_vez(sesiones, venta_encendida) -> None:
    """ABRIR PEDIDOS SIN PAGAR NINGUNO APARTARÍA EXISTENCIAS SIN LÍMITE."""
    _, _, comprador, seller_id = await bolsa_con(sesiones, unidades=20, en_la_bolsa=1)
    politica_id = await politica_publicada(sesiones)
    primero = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    with pytest.raises(AppError) as fallo:
        await crear_pedido(
            sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
        )
    assert fallo.value.code == "product_order_already_open"
    assert fallo.value.details["order_id"] == primero.orden.id


# =========================================================================== #
# 6. El checkout
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_iniciar_el_pago_no_marca_nada_pagado(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """ABRIR UN CHECKOUT NO ES COBRAR."""
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    falsa = PasarelaDeMentira()
    monkeypatch.setattr(pagos, "get_provider", lambda _n: falsa)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
        intento = await pagos.iniciar_pago(db, orden=orden, correo="x@y.test")
    assert intento.checkout_url.startswith("https://")
    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
    assert orden.status == PEDIDO_PROCESANDO
    assert orden.paid_at is None
    assert orden.provider == "stripe"

    #: LA METADATA IDENTIFICA EL COBRO SIN AMBIGÜEDAD.
    peticion = falsa.llamadas[0]
    assert peticion.metadata["dominio"] == "producto"
    assert peticion.metadata["order_id"] == creado.orden.id
    assert peticion.metadata["buyer_id"] == comprador
    assert peticion.metadata["environment"] == orden.environment
    #: Y EL IMPORTE SALE DEL SERVIDOR.
    assert peticion.amount_minor == orden.total_minor
    #: LAS URL DE VUELTA LAS PONE EL SERVIDOR, y son DISTINTAS.
    assert peticion.return_url != peticion.cancel_url
    assert creado.orden.id in peticion.return_url


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_si_la_pasarela_falla_el_pedido_no_finge_un_cobro(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """NO SE QUEDA FINGIENDO PAGO. Sigue pendiente, que es la verdad."""
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    monkeypatch.setattr(
        pagos, "get_provider", lambda _n: PasarelaDeMentira(revienta=True)
    )
    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
        with pytest.raises(RuntimeError):
            await pagos.iniciar_pago(db, orden=orden, correo="x@y.test")
        await db.rollback()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
    assert orden.status == PEDIDO_PENDIENTE
    assert orden.provider == "none"
    assert orden.external_payment_id is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_abre_un_cobro_de_un_pedido_cancelado(
    sesiones, venta_encendida, monkeypatch
) -> None:
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    async with sesiones() as db:
        await pedidos.cancelar(
            db, orden_id=creado.orden.id, usuario_id=comprador
        )
    monkeypatch.setattr(pagos, "get_provider", lambda _n: PasarelaDeMentira())
    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
        with pytest.raises(AppError) as fallo:
            await pagos.iniciar_pago(db, orden=orden, correo="x@y.test")
    assert fallo.value.code == "product_order_not_payable"


# =========================================================================== #
# 7. El webhook
# =========================================================================== #
async def con_cobro_abierto(sesiones, monkeypatch, **kwargs):
    producto_id, variantes, comprador, seller_id = await bolsa_con(sesiones, **kwargs)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    monkeypatch.setattr(pagos, "get_provider", lambda _n: PasarelaDeMentira())
    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
        await pagos.iniciar_pago(db, orden=orden, correo="x@y.test")
    return producto_id, variantes, comprador, creado.orden.id


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_aviso_verificado_paga_y_vacia_solo_lo_comprado(
    sesiones, venta_encendida, monkeypatch
) -> None:
    producto_id, variantes, comprador, orden_id = await con_cobro_abierto(
        sesiones, monkeypatch
    )
    async with sesiones() as db:
        await pagos.atender_aviso(
            db, AvisoDeMentira(purchase_id=orden_id, amount_minor=36_000)
        )
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        bolsa = await carts.leer(db, usuario_id=comprador)
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert orden.status == PEDIDO_PAGADO
    assert orden.paid_at is not None
    assert orden.external_payment_id == "pi_de_prueba"
    #: LA RESERVA SE CONSUME: las unidades siguen comprometidas y el pedido deja
    #: de estar sujeto al vencimiento.
    assert orden.reservation_settled_at is not None
    assert orden.reserved_until is None
    assert hay.reserved == 2
    assert hay.available == 3
    #: Y LA BOLSA SE QUEDA SIN LO COMPRADO.
    assert bolsa.items == []


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_mismo_aviso_dos_veces_no_cobra_dos_veces(
    sesiones, venta_encendida, monkeypatch
) -> None:
    producto_id, variantes, _, orden_id = await con_cobro_abierto(sesiones, monkeypatch)
    aviso = AvisoDeMentira(purchase_id=orden_id, amount_minor=36_000)
    for _ in range(3):
        async with sesiones() as db:
            await pagos.atender_aviso(db, aviso)
            await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        eventos = await db.scalar(
            select(func.count())
            .select_from(ProductOrderEvent)
            .where(
                ProductOrderEvent.order_id == orden_id,
                ProductOrderEvent.to_status == PEDIDO_PAGADO,
            )
        )
    assert orden.status == PEDIDO_PAGADO
    assert hay.reserved == 2
    assert eventos == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_pago_parcial_no_paga(sesiones, venta_encendida, monkeypatch) -> None:
    """NI DE MENOS NI DE MÁS."""
    _, _, _, orden_id = await con_cobro_abierto(sesiones, monkeypatch)
    async with sesiones() as db:
        nota = await pagos.atender_aviso(
            db, AvisoDeMentira(purchase_id=orden_id, amount_minor=1_000)
        )
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
    assert orden.status == PEDIDO_EN_REVISION
    assert orden.review_reason
    assert nota is not None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_otra_moneda_u_otro_entorno_no_confirman(
    sesiones, venta_encendida, monkeypatch
) -> None:
    for extra in ({"currency": "USD"}, {"environment": "production"}):
        _, _, _, orden_id = await con_cobro_abierto(sesiones, monkeypatch)
        async with sesiones() as db:
            await pagos.atender_aviso(
                db,
                AvisoDeMentira(
                    purchase_id=orden_id, amount_minor=36_000, **extra
                ),
            )
            await db.commit()
        async with sesiones() as db:
            orden = await db.get(ProductOrder, orden_id)
        assert orden.status == PEDIDO_EN_REVISION, extra


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_aviso_sin_importe_no_confirma(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """LA AUSENCIA DE UN DATO NO VALE COMO COINCIDENCIA."""
    _, _, _, orden_id = await con_cobro_abierto(sesiones, monkeypatch)
    async with sesiones() as db:
        await pagos.atender_aviso(
            db, AvisoDeMentira(purchase_id=orden_id, amount_minor=None)
        )
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
    assert orden.status == PEDIDO_EN_REVISION


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_aviso_de_fallo_no_suelta_la_reserva(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """UN PAGO FALLIDO NO ES EL FINAL: la tarjeta puede reintentarse mientras
    la reserva siga viva, y soltar aquí le quitaría a quien lo intenta la
    última unidad que estaba a punto de pagar."""
    producto_id, variantes, _, orden_id = await con_cobro_abierto(sesiones, monkeypatch)
    async with sesiones() as db:
        await pagos.atender_aviso(
            db,
            AvisoDeMentira(
                purchase_id=orden_id, status="failed", event_type="payment_failed"
            ),
        )
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert orden.status == PEDIDO_FALLIDO
    assert hay.reserved == 2


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_devolucion_no_deshace_nada_y_queda_para_conciliar(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """DEVOLVER EL IMPORTE Y DESHACER LA VENTA SON DOS DECISIONES. La segunda
    no existe todavía y no se inventa."""
    producto_id, variantes, _, orden_id = await con_cobro_abierto(sesiones, monkeypatch)
    async with sesiones() as db:
        await pagos.atender_aviso(
            db, AvisoDeMentira(purchase_id=orden_id, amount_minor=36_000)
        )
        await db.commit()
    async with sesiones() as db:
        nota = await pagos.atender_aviso(
            db,
            AvisoDeMentira(
                purchase_id=orden_id, status="refunded", event_type="charge.refunded"
            ),
        )
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert orden.status == PEDIDO_PAGADO
    assert hay.reserved == 2
    assert nota is not None and "conciliar" in nota


# =========================================================================== #
# 8. Cancelar, vencer y el pago tardío
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cancelar_suelta_la_reserva_una_sola_vez(
    sesiones, venta_encendida
) -> None:
    producto_id, variantes, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    for _ in range(3):
        async with sesiones() as db:
            orden = await pedidos.cancelar(
                db, orden_id=creado.orden.id, usuario_id=comprador
            )
        assert orden.status == PEDIDO_CANCELADO
    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        liberaciones = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(
                InventoryMovement.product_id == producto_id,
                InventoryMovement.kind == "release",
            )
        )
    assert hay.reserved == 0
    assert hay.available == 5
    assert liberaciones == 1, "se libero mas de una vez"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_pedido_de_otro_no_se_puede_cancelar(
    sesiones, venta_encendida
) -> None:
    """404, NUNCA 403: decir «existe pero no es tuyo» ya cuenta que existe."""
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    otro = await persona(sesiones, "otro")
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await pedidos.cancelar(db, orden_id=creado.orden.id, usuario_id=otro)
    assert fallo.value.status_code == 404
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await pedidos.leer(db, orden_id=creado.orden.id, usuario_id=otro)
    assert fallo.value.status_code == 404


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_vencer_suelta_una_vez_y_es_idempotente(
    sesiones, venta_encendida
) -> None:
    producto_id, variantes, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    #: Se adelanta el reloj en vez de esperar media hora.
    despues = datetime.now(timezone.utc) + timedelta(hours=2)
    async with sesiones() as db:
        #: `>= 1` y no `== 1`: la base es de modulo y el barrido tambien vence
        #: lo que dejaron pendiente otras pruebas. Lo que esta prueba defiende
        #: es que ESTE pedido vence una vez y suelta una vez.
        assert await pedidos.vencer(db, momento=despues) >= 1
    async with sesiones() as db:
        assert await pedidos.vencer(db, momento=despues) == 0
    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        liberaciones = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(
                InventoryMovement.product_id == producto_id,
                InventoryMovement.kind == "release",
            )
        )
    assert orden.status == PEDIDO_VENCIDO
    assert orden.expired_at is not None
    assert hay.reserved == 0
    assert liberaciones == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_vencer_no_toca_un_pedido_ya_pagado(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """VENCER UN PEDIDO PAGADO LE QUITARÍA A ALGUIEN LO QUE ACABA DE COMPRAR."""
    producto_id, variantes, _, orden_id = await con_cobro_abierto(sesiones, monkeypatch)
    async with sesiones() as db:
        await pagos.atender_aviso(
            db, AvisoDeMentira(purchase_id=orden_id, amount_minor=36_000)
        )
        await db.commit()
    despues = datetime.now(timezone.utc) + timedelta(days=7)
    async with sesiones() as db:
        await pedidos.vencer(db, momento=despues)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert orden.status == PEDIDO_PAGADO
    assert hay.reserved == 2


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_pago_tardio_queda_en_revision_y_no_reserva_nada(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """NI SE COBRA EN SILENCIO NI SE NIEGA EN SILENCIO. El dinero entró y la
    reserva ya no está: puede que las unidades sigan ahí y puede que no."""
    producto_id, variantes, _, orden_id = await con_cobro_abierto(sesiones, monkeypatch)
    despues = datetime.now(timezone.utc) + timedelta(hours=2)
    async with sesiones() as db:
        assert await pedidos.vencer(db, momento=despues) >= 1
    async with sesiones() as db:
        nota = await pagos.atender_aviso(
            db, AvisoDeMentira(purchase_id=orden_id, amount_minor=36_000)
        )
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert orden.status == PEDIDO_EN_REVISION
    assert orden.review_reason
    assert orden.paid_at is None, "un pago tardio no puede marcarse como pagado"
    assert hay.reserved == 0, "un pago tardio no puede volver a reservar"
    assert nota is not None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_nadie_puede_escribir_pagado_sin_cobro(sesiones) -> None:
    """NINGÚN ADMINISTRADOR PUEDE INVENTAR UNA CONFIRMACIÓN DEL PROVEEDOR.
    Lo impide el CHECK de la base, no una comprobación del servidor."""
    from app.modules.products.models import ProductPolicy

    async with sesiones() as db:
        politica_id = await politica_publicada(sesiones)
    async with sesiones() as db:
        politica = await db.get(ProductPolicy, politica_id)
        quien = await persona(sesiones, "falso")
        prov = await persona(sesiones, "provf")
        seller_id = await vendedor(sesiones, prov)
        db.add(
            ProductOrder(
                buyer_id=quien,
                seller_id=seller_id,
                status=PEDIDO_PAGADO,
                currency="PEN",
                subtotal_minor=100,
                total_minor=100,
                provider="none",
                environment="sandbox",
                idempotency_key="k-falso",
                request_fingerprint="a" * 64,
                policy_id=politica.id,
                policy_version=politica.version,
                policy_terms_sha256=politica.terms_sha256,
                policy_country=politica.country_code,
            )
        )
        with pytest.raises(Exception):
            await db.commit()
        await db.rollback()


# =========================================================================== #
# 9. Quién ve qué
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_proveedor_solo_ve_sus_pedidos_pagados(
    sesiones, venta_encendida, monkeypatch
) -> None:
    producto_id, variantes, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    async with sesiones() as db:
        #: PENDIENTE DE PAGO: el proveedor no lo ve.
        assert await pedidos.del_proveedor(db, seller_id=seller_id) == []

    monkeypatch.setattr(pagos, "get_provider", lambda _n: PasarelaDeMentira())
    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
        await pagos.iniciar_pago(db, orden=orden, correo="x@y.test")
    async with sesiones() as db:
        await pagos.atender_aviso(
            db, AvisoDeMentira(purchase_id=creado.orden.id, amount_minor=36_000)
        )
        await db.commit()

    async with sesiones() as db:
        suyos = await pedidos.del_proveedor(db, seller_id=seller_id)
        otro = await persona(sesiones, "provb")
        ajeno = await vendedor(sesiones, otro)
        de_otro = await pedidos.del_proveedor(db, seller_id=ajeno)
    assert [o.id for o in suyos] == [creado.orden.id]
    assert de_otro == []


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_historial_no_guarda_datos_personales(
    sesiones, venta_encendida
) -> None:
    """EL HISTORIAL SE LEE PARA AUDITAR UN ESTADO, no para recomponer a quién
    se le mandó qué."""
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    async with sesiones() as db:
        historial = await pedidos.historial_de(db, creado.orden.id)
    assert historial
    prohibidos = (
        DIRECCION["recipient_name"],
        DIRECCION["phone"],
        DIRECCION["address_line"],
        DIRECCION["postal_code"],
    )
    for evento in historial:
        texto = f"{evento.reason or ''}{evento.to_status}{evento.from_status or ''}"
        for dato in prohibidos:
            assert dato not in texto


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_la_auditoria_de_la_reserva_no_lleva_la_direccion(
    sesiones, venta_encendida
) -> None:
    """LA AUDITORÍA DEL ALMACÉN GUARDA SKU Y CANTIDADES, no domicilios."""
    from app.modules.gobernanza.models import AuditEvent

    _, _, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    async with sesiones() as db:
        filas = list(
            await db.scalars(
                select(AuditEvent).where(
                    AuditEvent.action == "product_inventory.reservation"
                )
            )
        )
    assert filas
    for fila in filas:
        texto = str(fila.payload)
        assert DIRECCION["address_line"] not in texto
        assert DIRECCION["phone"] not in texto


# =========================================================================== #
# 10. Degradación sin las migraciones
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_sin_la_0078_los_pedidos_contestan_503(sesiones, monkeypatch) -> None:
    """DEGRADACIÓN SEGURA. Sin la migración, 503 con su código y el catálogo,
    las fotografías, el inventario y el carrito siguen funcionando."""

    async def _no_hay(db):
        return False

    monkeypatch.setattr(esquema, "hay_pedidos", _no_hay)
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await esquema.exigir_pedidos(db)
        preparacion = await pedidos.preparar(db, usuario_id=str(uuid.uuid4()))
    assert fallo.value.code == "product_orders_not_available"
    assert fallo.value.status_code == 503
    assert preparacion.disponible is False
    assert "migration_0078" in preparacion.pending_configuration


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_preparar_cuenta_lo_que_falta_sin_reventar(sesiones) -> None:
    """ESTA RUTA EXISTE PARA CONTAR POR QUÉ NO SE PUEDE COMPRAR. Un 503 aquí
    dejaría a la pantalla sin poder explicar nada."""
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    async with sesiones() as db:
        p = await pedidos.preparar(db, usuario_id=comprador)
    assert p.disponible is False
    assert "feature_product_sales" in p.pending_configuration
    assert "payments_enabled" in p.pending_configuration
    assert "product_reservation_minutes" in p.pending_configuration
    assert len(p.groups) == 1
    assert p.groups[0].seller_id == seller_id
    assert p.groups[0].units == 2


# =========================================================================== #
# 11. Lo que encontro la revision independiente
#
# Los seis defectos, cada uno reproducido ANTES de corregirlo. Ninguna de estas
# pruebas existia: la suite de arriba pasaba entera con los seis dentro.
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_pedido_fallido_suelta_su_reserva_al_vencer(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """EL PEOR DEFECTO DEL INCREMENTO, y no liberaba dos veces: no liberaba nunca.

    El barrido buscaba por `PEDIDO_EN_CURSO`, asi que un pedido que caia en
    `PAYMENT_FAILED` —lo provoca cualquier tarjeta rechazada— salia de esa lista
    con las unidades apartadas y ya no las soltaba nadie: ni el barrido, que no
    lo veia; ni cancelar, que lo rechaza; ni el reintento, que exige que la
    reserva siga viva.
    """
    producto_id, variantes, _, orden_id = await con_cobro_abierto(sesiones, monkeypatch)
    async with sesiones() as db:
        await pagos.atender_aviso(
            db,
            AvisoDeMentira(
                purchase_id=orden_id, status="failed", event_type="payment_failed"
            ),
        )
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert orden.status == PEDIDO_FALLIDO
    #: Sigue apartando: se puede reintentar mientras la reserva viva.
    assert hay.reserved == 2

    despues = datetime.now(timezone.utc) + timedelta(hours=2)
    async with sesiones() as db:
        await pedidos.vencer(db, momento=despues)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        liberaciones = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(
                InventoryMovement.product_id == producto_id,
                InventoryMovement.kind == "release",
            )
        )
    assert orden.status == PEDIDO_VENCIDO
    assert orden.reservation_settled_at is not None
    assert hay.reserved == 0, "el pedido fallido se quedo con las unidades"
    assert liberaciones == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_pedido_en_revision_suelta_la_reserva_y_sigue_en_revision(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """SUELTA LO QUE APARTABA Y NO SE MUEVE DE LA COLA.

    Ahi hay un cobro que no cuadra y una persona tiene que mirarlo: marcarlo
    «vencido» lo sacaria de la cola y haria desaparecer el problema de la vista
    sin haberlo resuelto.
    """
    producto_id, variantes, _, orden_id = await con_cobro_abierto(sesiones, monkeypatch)
    async with sesiones() as db:
        await pagos.atender_aviso(
            db, AvisoDeMentira(purchase_id=orden_id, amount_minor=1)
        )
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert orden.status == PEDIDO_EN_REVISION
    assert hay.reserved == 2

    despues = datetime.now(timezone.utc) + timedelta(hours=2)
    async with sesiones() as db:
        await pedidos.vencer(db, momento=despues)
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert hay.reserved == 0, "el pedido en revision se quedo con las unidades"
    assert orden.reservation_settled_at is not None
    assert orden.status == PEDIDO_EN_REVISION, "salio de la cola sin que nadie lo mirara"
    assert orden.expired_at is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_pedido_fallido_impide_abrir_otro_hasta_que_suelta(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """EL CANDADO MIRA SI TODAVIA APARTA, no si todavia se puede pagar.

    Con el criterio anterior, un pedido fallido no contaba: el mismo comprador
    encadenaba intentos y cada uno apartaba mas existencias, para siempre.
    """
    producto_id, variantes, comprador, orden_id = await con_cobro_abierto(
        sesiones, monkeypatch, unidades=20, en_la_bolsa=2
    )
    politica_id = await politica_publicada(sesiones)
    async with sesiones() as db:
        await pagos.atender_aviso(
            db,
            AvisoDeMentira(
                purchase_id=orden_id, status="failed", event_type="payment_failed"
            ),
        )
        await db.commit()
    async with sesiones() as db:
        bolsa = await carts.leer(db, usuario_id=comprador)
    seller_id = (await _pedido_de(sesiones, orden_id)).seller_id

    with pytest.raises(AppError) as fallo:
        await crear_pedido(
            sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
        )
    assert fallo.value.code == "product_order_already_open"

    #: Y EN CUANTO SUELTA, SE PUEDE. El candado lo cierra la reserva, no el
    #: estado: cuando el barrido la suelta, se levanta solo.
    despues = datetime.now(timezone.utc) + timedelta(hours=2)
    async with sesiones() as db:
        await pedidos.vencer(db, momento=despues)
    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert hay.reserved == 0
    _ = bolsa


async def _pedido_de(sesiones, orden_id):
    async with sesiones() as db:
        return await db.get(ProductOrder, orden_id)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cancelar_un_pedido_que_ya_no_se_puede_cancelar_da_409_y_no_500(
    sesiones, venta_encendida
) -> None:
    """EL MENSAJE SE COMPONE ANTES DEL `rollback`.

    Deshacer la transaccion caduca los objetos del ORM, y leer `orden.status`
    despues disparaba una recarga perezosa que en asincrono revienta con
    `MissingGreenlet`: quien pulsaba «cancelar» sobre un pedido ya vencido
    recibia un 500 en vez del 409 que la ruta promete.
    """
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    despues = datetime.now(timezone.utc) + timedelta(hours=2)
    async with sesiones() as db:
        await pedidos.vencer(db, momento=despues)

    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await pedidos.cancelar(
                db, orden_id=creado.orden.id, usuario_id=comprador
            )
    assert fallo.value.code == "product_order_not_payable"
    assert fallo.value.status_code == 409
    assert "EXPIRED" in str(fallo.value)


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_puede_cancelar_un_pedido_pagado(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """CANCELAR UN PEDIDO PAGADO SERIA UN REEMBOLSO, y no existe."""
    producto_id, variantes, comprador, orden_id = await con_cobro_abierto(
        sesiones, monkeypatch
    )
    async with sesiones() as db:
        await pagos.atender_aviso(
            db, AvisoDeMentira(purchase_id=orden_id, amount_minor=36_000)
        )
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await pedidos.cancelar(db, orden_id=orden_id, usuario_id=comprador)
    assert fallo.value.code == "product_order_not_payable"
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert orden.status == PEDIDO_PAGADO
    assert hay.reserved == 2, "cancelar solto las unidades de una venta hecha"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_version_republicada_bloquea_la_compra(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """NO SE COMPRA AL PRECIO DE UNA VERSION RETIRADA.

    La linea del carrito apunta a la version con la que se metio, y el precio
    sale DE ESA VERSION: si el proveedor republico, el pedido se congelaba al
    precio de una version que ya no esta en catalogo —ni el que se ofrece hoy ni
    el que nadie acepta— y el cobro salia por ese importe. En la bolsa basta con
    avisar; para cobrar, no.

    El carrito marca esa linea con `version_changed` y `purchasable: True`,
    porque en la bolsa republicar no impide nada. Esa es exactamente la forma
    que se construye aqui.
    """
    fallo = await _crear_con_bolsa_falsa(
        sesiones,
        monkeypatch,
        [_linea_falsa(issues=["version_changed"], purchasable=True)],
    )
    assert fallo.code == "product_cart_not_purchasable"
    assert "version_changed" in (fallo.details or {}).get("issues", [])


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_movimiento_de_la_reserva_no_lleva_el_id_de_quien_compra(
    sesiones, venta_encendida
) -> None:
    """EL PROVEEDOR NO TIENE POR QUE SABER QUIEN APARTO QUE.

    La ruta de movimientos de un SKU es suya y devuelve `actor_id`. Firmando la
    reserva con la cuenta del comprador, el proveedor sabia quien aparto que y
    cuando, incluso de pedidos que nunca se pagaron: justo lo que
    `del_proveedor` evita al entregar solo los pagados.
    """
    producto_id, variantes, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    async with sesiones() as db:
        await pedidos.cancelar(db, orden_id=creado.orden.id, usuario_id=comprador)

    async with sesiones() as db:
        movimientos = list(
            await db.scalars(
                select(InventoryMovement).where(
                    InventoryMovement.product_id == producto_id,
                    InventoryMovement.kind.in_(("reservation", "release")),
                )
            )
        )
    assert movimientos
    for movimiento in movimientos:
        assert movimiento.actor_id is None, (
            f"el movimiento {movimiento.kind} lleva un identificador de persona"
        )
        assert movimiento.actor_role == "system"

    #: Y LA AUDITORIA TAMPOCO. Una fila que dice «system» y lleva el
    #: identificador de una persona no es auditable en ninguna direccion.
    from app.modules.gobernanza.models import AuditEvent

    async with sesiones() as db:
        filas = list(
            await db.scalars(
                select(AuditEvent).where(
                    AuditEvent.action.in_(
                        ("product_inventory.reservation", "product_inventory.release")
                    )
                )
            )
        )
    for fila in filas:
        assert fila.actor_id != comprador


# =========================================================================== #
# 12. Lo que dejaron al descubierto las mutaciones
# =========================================================================== #
def _linea_falsa(**campos):
    """Una linea de carrito construida a mano, para poder llegar a guardias que
    el camino normal ya no deja alcanzar."""
    base = dict(
        item_id="i-1",
        product_id=str(uuid.uuid4()),
        version_id=str(uuid.uuid4()),
        variant_id=str(uuid.uuid4()),
        name="Algo",
        variant_name=None,
        sku="SKU-1",
        seller_id="v-1",
        seller_name="Tienda",
        image_path=None,
        image_url=None,
        alt_text=None,
        quantity=1,
        unit_price_minor=1000,
        currency="PEN",
        line_total_minor=1000,
        seen_price_minor=1000,
        seen_currency="PEN",
        available=10,
        issues=[],
        purchasable=True,
        added_at=None,
    )
    base.update(campos)
    return carts.Linea(**base)


async def _crear_con_bolsa_falsa(sesiones, monkeypatch, lineas):
    """Llama a `crear` con un carrito inventado. Devuelve el fallo.

    EL PROVEEDOR ES REAL: `crear` lo busca en la base antes de leer el carrito,
    y una ficha inventada no llegaria a la guardia que se quiere probar.
    """
    politica_id = await politica_publicada(sesiones)
    comprador = await persona(sesiones, "falsa")
    duena = await persona(sesiones, "provfalsa")
    seller_id = await vendedor(sesiones, duena)
    lineas = [
        carts.Linea(**{**linea.__dict__, "seller_id": seller_id}) for linea in lineas
    ]

    async def _leer(db, *, usuario_id, firmar=None):
        return carts.Carrito(items=list(lineas), currency="PEN", disponible=True)

    monkeypatch.setattr(carts, "leer", _leer)
    async with sesiones() as db:
        #: El carrito TIENE que existir: `crear` lo bloquea antes de leerlo.
        await carts._carrito_bloqueado(db, usuario_id=comprador, crear=True)
        await db.commit()
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await pedidos.crear(
                db,
                usuario_id=comprador,
                seller_id=seller_id,
                direccion=dict(DIRECCION),
                policy_id=politica_id,
                policy_terms_sha256=(
                    await politicas.exigir_vigente(db, pais="PE")
                ).terms_sha256,
                clave="k-" + uuid.uuid4().hex[:8],
            )
    return fallo.value


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_linea_bloqueada_no_compra_aunque_venga_marcada_comprable(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """DOS CAPAS, Y SE COMPRUEBAN LAS DOS. `purchasable` y la lista de avisos
    dicen lo mismo por dos caminos; una linea que llegue con las dos en
    desacuerdo no se compra."""
    fallo = await _crear_con_bolsa_falsa(
        sesiones,
        monkeypatch,
        [_linea_falsa(issues=["insufficient_stock"], purchasable=True)],
    )
    assert fallo.code == "product_cart_not_purchasable"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_monedas_en_la_misma_bolsa_no_se_suman(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """SUMAR SOLES CON EUROS DA UN NUMERO QUE NO ES DINERO.

    `anadir` ya lo impide, asi que este estado no se alcanza por el camino
    normal. La guardia existe igual porque de aqui sale el importe que se cobra.
    """
    fallo = await _crear_con_bolsa_falsa(
        sesiones,
        monkeypatch,
        [
            _linea_falsa(item_id="a", currency="PEN"),
            _linea_falsa(item_id="b", currency="USD"),
        ],
    )
    assert fallo.code == "product_cart_currency_mismatch"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_una_linea_sin_precio_no_se_convierte_en_cero(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """`None` NO ES GRATIS. Un `or 0` aqui regala el producto."""
    #: CON OTRA LINEA CON PRECIO AL LADO, a proposito. Sola, un `or 0` dejaba
    #: el subtotal en cero y saltaba la guardia de «un importe de cero no se
    #: cobra»: la prueba fallaba igual y no medía lo que dice medir.
    fallo = await _crear_con_bolsa_falsa(
        sesiones,
        monkeypatch,
        [
            _linea_falsa(item_id="a", unit_price_minor=1_000, line_total_minor=1_000),
            _linea_falsa(item_id="b", unit_price_minor=None, line_total_minor=None),
        ],
    )
    assert fallo.code == "product_cart_not_purchasable"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_importe_fuera_del_rango_seguro_de_javascript_no_se_cobra(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """POR ENCIMA DE 2^53-1, EL CLIENTE VE OTRO NUMERO.

    Estos importes viajan en un JSON que lee JavaScript: cobrar uno que el
    cliente no puede representar es cobrar algo que nadie ha visto.
    """
    from app.modules.products.models import MAXIMO_SEGURO_EN_JS

    fallo = await _crear_con_bolsa_falsa(
        sesiones,
        monkeypatch,
        [
            _linea_falsa(
                unit_price_minor=MAXIMO_SEGURO_EN_JS,
                line_total_minor=MAXIMO_SEGURO_EN_JS + 1,
            )
        ],
    )
    assert fallo.code == "product_cart_not_purchasable"
    assert (fallo.details or {}).get("subtotal_minor") == MAXIMO_SEGURO_EN_JS + 1


@SIN_POSTGRES
def test_la_reserva_se_suma_por_unidad_de_almacen_y_en_orden_estable() -> None:
    """DOS VARIANTES PUEDEN COMPARTIR LA CAJA DEL ALMACEN.

    Reservarlas por separado usaria la misma clave de idempotencia sobre la
    misma unidad, y la segunda se tragaria como si fuera un reintento: unidades
    vendidas que nunca se apartaron. Y el orden estable es lo que impide que dos
    compras sobre las mismas dos unidades se abracen.
    """

    class _L:
        def __init__(self, product_id, sku, quantity):
            self.product_id = product_id
            self.sku = sku
            self.quantity = quantity

    lineas = [
        _L("p2", "B", 1),
        _L("p1", "B", 3),
        _L("p1", "A", 2),
        _L("p1", "B", 4),
    ]
    salida = pedidos._por_unidad_de_almacen(lineas)
    assert salida == [("p1", "A", 2), ("p1", "B", 7), ("p2", "B", 1)]
    assert salida == sorted(salida), "el orden de bloqueo no es estable"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_liberar_dos_veces_la_misma_reserva_suelta_una_sola_vez(
    sesiones, venta_encendida
) -> None:
    """LA CAPA DE ABAJO, PROBADA SOLA.

    `cancelar` y `vencer` ya no dejan llegar aqui dos veces, asi que la guardia
    interna solo se ejercita llamandola a mano. Es la que aguanta si dos
    procesos se colaran a la vez por la de arriba.
    """
    producto_id, variantes, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    momento = datetime.now(timezone.utc)
    async with sesiones() as db:
        orden = await pedidos._bloqueado(db, creado.orden.id)
        await pedidos._liberar_reserva(db, orden=orden, momento=momento)
        await pedidos._liberar_reserva(db, orden=orden, momento=momento)
        await db.commit()
    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        liberaciones = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(
                InventoryMovement.product_id == producto_id,
                InventoryMovement.kind == "release",
            )
        )
    assert hay.reserved == 0
    assert liberaciones == 1


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_dos_barridos_a_la_vez_sueltan_una_sola_vez(
    sesiones, motor, venta_encendida
) -> None:
    """EL BARRIDO RECOMPRUEBA BAJO EL CERROJO.

    Dos planificadores —o dos replicas— pueden llamarlo a la vez. Quien llega
    segundo se encuentra la fila bloqueada, espera, y al leerla ve que la
    reserva ya se decidio.
    """
    producto_id, variantes, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    despues = datetime.now(timezone.utc) + timedelta(hours=2)
    Sesion = async_sessionmaker(motor, expire_on_commit=False)

    async def barrer():
        async with Sesion() as db:
            return await pedidos.vencer(db, momento=despues)

    await asyncio.gather(barrer(), barrer(), return_exceptions=True)

    async with sesiones() as db:
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        liberaciones = await db.scalar(
            select(func.count())
            .select_from(InventoryMovement)
            .where(
                InventoryMovement.product_id == producto_id,
                InventoryMovement.kind == "release",
            )
        )
    assert hay.reserved == 0
    assert liberaciones == 1, "dos barridos soltaron dos veces"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_un_cobro_que_llega_con_la_reserva_ya_vencida_no_confirma(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """LA VENTANA ENTRE QUE LA RESERVA VENCE Y EL BARRIDO PASA.

    El pedido sigue en `PAYMENT_PROCESSING` —nadie lo ha vencido todavia— pero
    su reserva ya caduco. Confirmar ahi seria vender unidades que el barrido va
    a soltar en cuanto corra.
    """
    _, _, _, orden_id = await con_cobro_abierto(sesiones, monkeypatch)
    despues = datetime.now(timezone.utc) + timedelta(hours=2)
    async with sesiones() as db:
        with pytest.raises(AppError) as fallo:
            await pedidos.confirmar_pago(
                db,
                orden_id=orden_id,
                provider="stripe",
                environment="sandbox",
                external_payment_id="pi_tarde",
                amount_minor=36_000,
                currency="PEN",
                momento=despues,
            )
        await db.rollback()
    assert fallo.value.code == "product_order_payment_mismatch"
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
    assert orden.status == PEDIDO_PROCESANDO
    assert orden.paid_at is None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_otro_cobro_sobre_un_pedido_ya_pagado_no_lo_vuelve_a_pagar(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """DOS COBROS DISTINTOS SOBRE EL MISMO PEDIDO ES CONCILIACION, no una
    confirmacion. Y no se pisa la referencia del que si pago."""
    _, _, _, orden_id = await con_cobro_abierto(sesiones, monkeypatch)
    async with sesiones() as db:
        await pagos.atender_aviso(
            db,
            AvisoDeMentira(
                purchase_id=orden_id, amount_minor=36_000, transaction="pi_bueno"
            ),
        )
        await db.commit()
    async with sesiones() as db:
        nota = await pagos.atender_aviso(
            db,
            AvisoDeMentira(
                purchase_id=orden_id, amount_minor=36_000, transaction="pi_otro"
            ),
        )
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        pagados = await db.scalar(
            select(func.count())
            .select_from(ProductOrderEvent)
            .where(
                ProductOrderEvent.order_id == orden_id,
                ProductOrderEvent.to_status == PEDIDO_PAGADO,
            )
        )
    assert orden.status == PEDIDO_PAGADO
    assert orden.external_payment_id == "pi_bueno", "se piso la referencia del cobro"
    assert pagados == 1
    assert nota is not None


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_abre_un_cobro_de_un_pedido_vencido(
    sesiones, venta_encendida, monkeypatch
) -> None:
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    despues = datetime.now(timezone.utc) + timedelta(hours=2)
    async with sesiones() as db:
        await pedidos.vencer(db, momento=despues)
    monkeypatch.setattr(pagos, "get_provider", lambda _n: PasarelaDeMentira())
    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
        with pytest.raises(AppError) as fallo:
            await pagos.iniciar_pago(db, orden=orden, correo="x@y.test")
    assert fallo.value.code == "product_order_not_payable"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_cancelar_mientras_se_abre_el_cobro_no_deja_el_pedido_procesando(
    sesiones, venta_encendida, monkeypatch, motor
) -> None:
    """LA VENTANA DE LA LLAMADA HTTP.

    Entre leer el pedido y volver de la pasarela hay una llamada que puede
    tardar segundos. Quien cancele en ese hueco se encontraba
    `PAYMENT_PROCESSING` escrito encima de su `CANCELLED` —y el CHECK de la base
    rechazando la transaccion con un 500—. Aqui la pasarela cancela el pedido
    desde dentro, que es como se reproduce ese hueco sin depender del reloj.
    """
    producto_id, variantes, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    Sesion = async_sessionmaker(motor, expire_on_commit=False)

    class PasarelaQueTarda(PasarelaDeMentira):
        async def create_checkout(self, request):
            async with Sesion() as otra:
                await pedidos.cancelar(
                    otra, orden_id=creado.orden.id, usuario_id=comprador
                )
            return await super().create_checkout(request)

    monkeypatch.setattr(pagos, "get_provider", lambda _n: PasarelaQueTarda())
    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
        with pytest.raises(AppError) as fallo:
            await pagos.iniciar_pago(db, orden=orden, correo="x@y.test")
    assert fallo.value.code == "product_order_not_payable"
    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
    assert orden.status == PEDIDO_CANCELADO
    assert orden.provider == "none"
    assert hay.reserved == 0


@SIN_POSTGRES
def test_la_cola_de_conciliacion_no_reparte_direcciones() -> None:
    """LA REVISION ES AUDITADA Y NO LLEVA DOMICILIOS.

    La 0078 justifica no poner ninguna politica de lectura sobre estas tablas
    diciendo que las direcciones solo las ven quien compra, quien tiene que
    entregar y una revision AUDITADA. La revision existia; la auditoria, no. Y
    la ruta pedia el rol ANCHO —curaduria— para una cola con dinero dentro.

    Se comprueba sobre el CODIGO de la ruta porque es donde vive la tentacion:
    devolver el molde completo es una linea mas corta que devolverlo sin
    direccion.
    """
    from pathlib import Path

    fuente = Path(__file__).resolve().parents[1] / "app" / "modules" / "products"
    texto = (fuente / "router.py").read_text(encoding="utf-8")
    trozo = texto[texto.index("async def pedidos_en_revision") :]
    trozo = trozo[: trozo.index("@admin_router.post")]

    assert "exigir_publicador" in trozo, "la cola pide el rol ancho"
    assert "exigir_evaluador" not in trozo
    assert "con_direccion=False" in trozo, "la cola devuelve direcciones"
    assert "auditoria.anotar" in trozo, "mirar la cola no deja rastro"
    assert 'action="product_order.review_queue"' in trozo
    #: Y QUE EL RASTRO SEA DE LO QUE SE MIRO. Dejar la llamada escrita pero
    #: recorrer otra cosa —una lista vacia— pasaria la comprobacion de arriba y
    #: no anotaria nada.
    assert "for orden in ordenes:" in trozo
    assert "entity_id=orden.id" in trozo


@SIN_POSTGRES
def test_el_molde_del_pedido_sabe_devolver_uno_sin_direccion() -> None:
    """Y la puerta de verdad esta en el molde, no en la ruta."""
    import inspect

    from app.modules.products.router import _pedido

    firma = inspect.signature(_pedido)
    assert "con_direccion" in firma.parameters
    assert firma.parameters["con_direccion"].default is True


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_no_se_abre_un_cobro_de_un_pedido_en_revision(
    sesiones, venta_encendida, monkeypatch
) -> None:
    """EL UNICO ESTADO NO PAGABLE CON LA RESERVA TODAVIA VIVA.

    Cancelar y vencer sueltan la reserva, asi que ahi la guardia del estado
    queda tapada por la de la reserva. `UNDER_REVIEW` no: el pedido sigue
    apartando mientras una persona lo mira, y abrir un cobro nuevo encima de un
    expediente abierto es exactamente lo que no puede pasar.
    """
    _, _, _, orden_id = await con_cobro_abierto(sesiones, monkeypatch)
    async with sesiones() as db:
        await pagos.atender_aviso(
            db, AvisoDeMentira(purchase_id=orden_id, amount_minor=1)
        )
        await db.commit()
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
    assert orden.status == PEDIDO_EN_REVISION
    assert orden.reservation_settled_at is None
    assert orden.reserved_until is not None

    monkeypatch.setattr(pagos, "get_provider", lambda _n: PasarelaDeMentira())
    async with sesiones() as db:
        orden = await db.get(ProductOrder, orden_id)
        with pytest.raises(AppError) as fallo:
            await pagos.iniciar_pago(db, orden=orden, correo="x@y.test")
    assert fallo.value.code == "product_order_not_payable"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_barrido_no_vence_un_pedido_que_se_pago_mientras_esperaba(
    sesiones, motor, venta_encendida
) -> None:
    """LA RECOMPROBACION BAJO EL CERROJO, con el orden fijado a mano.

    Entre que el barrido hace la lista y toma la fila puede llegar el aviso de
    Stripe. Sin esta segunda lectura, el barrido venceria un pedido que acaba de
    pagarse y le quitaria a alguien lo que acaba de comprar.

    La carrera se fija a mano: otra sesion toma la fila y no la suelta, el
    barrido se queda esperando, y solo entonces el pedido pasa a pagado.
    """
    producto_id, variantes, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    despues = datetime.now(timezone.utc) + timedelta(hours=2)
    Sesion = async_sessionmaker(motor, expire_on_commit=False)
    tomada = asyncio.Event()
    suelta = asyncio.Event()

    async def retener_y_pagar():
        async with Sesion() as db:
            orden = await pedidos._bloqueado(db, creado.orden.id)
            tomada.set()
            await suelta.wait()
            #: Se paga A MANO porque lo que se esta probando es el barrido, no
            #: el cobro: `confirmar_pago` ya tiene sus propias pruebas.
            orden.status = PEDIDO_PAGADO
            orden.paid_at = despues
            orden.provider = "stripe"
            orden.external_payment_id = "pi_de_la_carrera"
            orden.reservation_settled_at = despues
            orden.reserved_until = None
            await db.commit()

    async def barrer():
        async with Sesion() as db:
            return await pedidos.vencer(db, momento=despues)

    retencion = asyncio.create_task(retener_y_pagar())
    await tomada.wait()
    barrido = asyncio.create_task(barrer())
    await asyncio.sleep(0.5)
    assert not barrido.done(), "el barrido no se quedo esperando el cerrojo"
    suelta.set()
    await retencion
    await barrido

    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
        hay = await inventory.de_la_unidad(
            db, product_id=producto_id, sku=variantes[0].sku
        )
        #: SOBRE ESTE PEDIDO, no sobre el numero que devuelve el barrido: la
        #: base es de modulo y ahi dentro hay pendientes de otras pruebas que
        #: este barrido tambien vence, con toda la razon.
        vencimientos = await db.scalar(
            select(func.count())
            .select_from(ProductOrderEvent)
            .where(
                ProductOrderEvent.order_id == creado.orden.id,
                ProductOrderEvent.reason == "reservation_expired",
            )
        )
    assert vencimientos == 0, "el barrido vencio un pedido que ya estaba pagado"
    assert orden.status == PEDIDO_PAGADO
    assert orden.expired_at is None
    assert hay.reserved == 2, "el barrido solto las unidades de una venta hecha"


@SIN_POSTGRES
@pytest.mark.asyncio
async def test_el_barrido_no_suelta_una_reserva_que_ya_solto_otro(
    sesiones, motor, venta_encendida
) -> None:
    """LA OTRA RECOMPROBACION BAJO EL CERROJO, tambien con el orden fijado.

    Dos planificadores —o dos replicas— pueden hacer la lista a la vez. El
    segundo tiene que ver, al tomar la fila, que la reserva ya se decidio: si no
    la mira, vuelve a contar como suyo un pedido que otro ya cerro.
    """
    _, _, comprador, seller_id = await bolsa_con(sesiones)
    politica_id = await politica_publicada(sesiones)
    creado = await crear_pedido(
        sesiones, comprador=comprador, seller_id=seller_id, politica_id=politica_id
    )
    despues = datetime.now(timezone.utc) + timedelta(hours=2)
    Sesion = async_sessionmaker(motor, expire_on_commit=False)
    tomada = asyncio.Event()
    suelta = asyncio.Event()

    async def retener_y_cancelar():
        async with Sesion() as db:
            await pedidos._bloqueado(db, creado.orden.id)
            tomada.set()
            await suelta.wait()
            await pedidos.cancelar(
                db, orden_id=creado.orden.id, usuario_id=comprador
            )

    async def barrer():
        async with Sesion() as db:
            return await pedidos.vencer(db, momento=despues)

    retencion = asyncio.create_task(retener_y_cancelar())
    await tomada.wait()
    barrido = asyncio.create_task(barrer())
    await asyncio.sleep(0.5)
    assert not barrido.done(), "el barrido no se quedo esperando el cerrojo"
    suelta.set()
    await retencion
    await barrido

    async with sesiones() as db:
        orden = await db.get(ProductOrder, creado.orden.id)
        #: SOBRE ESTE PEDIDO, por lo mismo que arriba.
        vencimientos = await db.scalar(
            select(func.count())
            .select_from(ProductOrderEvent)
            .where(
                ProductOrderEvent.order_id == creado.orden.id,
                ProductOrderEvent.reason == "reservation_expired",
            )
        )
    assert vencimientos == 0, "el barrido conto un pedido que otro ya habia cerrado"
    assert orden.status == PEDIDO_CANCELADO, "el barrido piso la cancelacion"
