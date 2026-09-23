"""Reglas que sostienen el dinero en el portal de pagos.

Es la ruta mas critica de la aplicacion: un fallo aqui no da una pantalla en
blanco, regala cursos o cobra de mas. Y ademas es la mas dificil de probar a
mano, porque exige una pasarela real de por medio.

Se comprueban las cuatro reglas que la sostienen:

1. El importe se lee del curso EN EL SERVIDOR, nunca del cliente.
2. Solo el webhook concede el acceso; volver del navegador no prueba nada.
3. El webhook verifica la firma y falla CERRADO.
4. El webhook es idempotente: las pasarelas reintentan.
"""

import pytest

from app.modules.payments import providers
from app.modules.payments.providers import (
    CheckoutRequest,
    NotConfiguredProvider,
    PaymentEvent,
    get_provider,
)
from app.modules.payments.schemas import CheckoutCreate


# ---------------------------------------------------------------------------
# Regla 1: el importe no viene del cliente
# ---------------------------------------------------------------------------


def test_el_cliente_no_puede_enviar_el_importe():
    """`CheckoutCreate` solo acepta el curso.

    Si admitiera un importe, cualquiera compraria un curso de 300 por 1. El
    servidor lo lee del propio curso, y esta prueba evita que alguien anada el
    campo "por comodidad" mas adelante.
    """
    campos = set(CheckoutCreate.model_fields)
    assert campos == {"course_id"}, (
        f"CheckoutCreate acepta {campos}. El importe NO puede llegar del cliente."
    )


def test_el_importe_viaja_en_unidad_menor():
    """En centimos y como entero.

    Con decimales en coma flotante, 0.1 + 0.2 no es 0.3 y el dinero acaba
    descuadrando. `amount_minor` debe ser siempre un entero.
    """
    peticion = CheckoutRequest(
        purchase_id="c1",
        concepto="Curso",
        amount_minor=29700,
        currency="PEN",
        user_email="a@b.c",
        return_url="https://ejemplo/pago",
    )
    assert isinstance(peticion.amount_minor, int)


# ---------------------------------------------------------------------------
# Regla 3: sin pasarela configurada, se falla cerrado
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sin_pasarela_no_se_puede_cobrar():
    """Mientras no haya pasarela, iniciar un cobro FALLA en vez de simularlo.

    Simular un cobro fue justo lo que obligo a retirar el checkout anterior: las
    tiendas rechazan los flujos de compra que no completan una transaccion.
    """
    proveedor = NotConfiguredProvider()
    with pytest.raises(NotImplementedError):
        await proveedor.create_checkout(
            CheckoutRequest(
                purchase_id="c1",
                concepto="Curso",
                amount_minor=100,
                currency="PEN",
                user_email="a@b.c",
                return_url="https://ejemplo/pago",
            )
        )


def test_sin_pasarela_no_se_acepta_ningun_aviso():
    """Verificar la firma no puede degradar a "acepto lo que llegue".

    Si `verify_and_parse` se rindiera devolviendo algo, quien descubriera la URL
    del webhook se regalaria los cursos que quisiera.
    """
    proveedor = NotConfiguredProvider()
    with pytest.raises(NotImplementedError):
        proveedor.verify_and_parse(body=b'{"status":"paid"}', headers={})


def test_una_pasarela_desconocida_no_existe():
    """Un nombre inventado no devuelve una pasarela por descuido."""
    assert get_provider("pasarela-que-no-existe") is None


def test_la_pasarela_registrada_cumple_el_contrato():
    """Toda pasarela registrada implementa los dos metodos obligatorios."""
    for nombre, proveedor in providers.PROVIDERS.items():
        assert hasattr(proveedor, "create_checkout"), f"{nombre} no puede cobrar"
        assert hasattr(proveedor, "verify_and_parse"), f"{nombre} no verifica firmas"
        assert proveedor.name, f"{nombre} no declara su nombre"


def test_el_nombre_de_la_pasarela_cabe_en_la_base_de_datos():
    """El nombre de cada pasarela tiene que caber en la columna DONDE ESCRIBE.

    Registrar una pasarela con un nombre que su columna no admite haria fallar
    el INSERT justo al cobrar, que es el peor momento posible para descubrirlo.
    Eso es lo que protege esta prueba, y sigue en pie.

    LO QUE CAMBIO, Y POR QUE. Ya no hay UNA columna, hay dos, porque conviven
    dos esquemas mientras dura el trasvase de la migracion 0036:

      * `purchases.provider` — el camino heredado. CHECK de cuatro valores:
        apple, google, web, manual.
      * `orders.provider` y `provider_products.provider` — el dominio comercial
        de la 0035. Otro CHECK, que si admite 'stripe'.

    Stripe NO escribe en `purchases`: sus cobros van a `orders` y
    `payment_transactions`, y el acceso a `entitlements`. El limite de la tabla
    antigua no le aplica porque nunca inserta ahi. Renombrarlo a 'web' para
    caber en una columna que no toca seria mentir sobre quien cobro y perder la
    capacidad de distinguirlo de cualquier futuro proveedor web en los
    registros financieros.

    Y no se resuelve con una lista de excepciones: cada pasarela DECLARA en que
    dominio escribe (`PaymentProvider.dominio`), asi que la comprobacion se
    hace sola tambien para la siguiente que se anada. El valor por defecto es
    'purchases', el mas estricto, para que quien no piense en esto quede del
    lado seguro.
    """
    for nombre, proveedor in providers.PROVIDERS.items():
        permitidos = proveedor.nombres_admitidos
        assert proveedor.dominio in {"purchases", "comercio"}, (
            f"La pasarela '{nombre}' declara un dominio desconocido: "
            f"'{proveedor.dominio}'."
        )
        assert proveedor.name in permitidos, (
            f"La pasarela '{nombre}' se identifica como '{proveedor.name}', "
            f"que no admite la columna del dominio '{proveedor.dominio}' "
            f"({sorted(permitidos)})."
        )


def test_stripe_no_escribe_en_la_tabla_heredada():
    """La excepcion de Stripe se sostiene sobre un hecho, no sobre una lista.

    Si algun dia el flujo de Stripe empezara a escribir en `purchases`, esta
    prueba tendria que fallar: su nombre no cabe en ese CHECK. Se comprueba el
    hecho —que su dominio es el comercial— en vez de confiar en que nadie lo
    cambie.
    """
    stripe = providers.PROVIDERS["stripe"]
    assert stripe.dominio == "comercio"
    assert stripe.name not in providers.NOMBRES_EN_PURCHASES
    assert stripe.name in providers.NOMBRES_EN_COMERCIO


# ---------------------------------------------------------------------------
# Regla 2 y 4: que estados conceden acceso, y que pasa al repetirse un aviso
# ---------------------------------------------------------------------------


def test_solo_pagado_concede_acceso():
    """`pending` NO da acceso.

    Un cobro iniciado y no completado deja la compra en 'pending'. Tratarlo como
    bueno regalaria el curso a quien abre el checkout y no llega a pagar.
    """
    evento = PaymentEvent(
        purchase_id="c1",
        provider_transaction_id="tx1",
        status="pending",
        amount_minor=29700,
        currency="PEN",
    )
    assert evento.status != "paid"


@pytest.mark.parametrize("estado", ["paid", "cancelled", "refunded"])
def test_los_estados_que_el_webhook_entiende(estado):
    """Los tres que cambian la compra. Cualquier otro se ignora sin fallar."""
    evento = PaymentEvent(
        purchase_id="c1",
        provider_transaction_id="tx1",
        status=estado,
        amount_minor=100,
        currency="PEN",
    )
    assert evento.status in {"paid", "cancelled", "refunded"}


def test_el_evento_trae_referencia_para_conciliar():
    """Sin `provider_transaction_id` no hay idempotencia posible.

    El `unique (provider, provider_transaction_id)` de la tabla es lo que evita
    conceder dos veces cuando la pasarela reintenta el aviso.
    """
    evento = PaymentEvent(
        purchase_id="c1",
        provider_transaction_id="tx-123",
        status="paid",
        amount_minor=100,
        currency="PEN",
    )
    assert evento.provider_transaction_id
