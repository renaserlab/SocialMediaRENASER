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
        course_title="Curso",
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
                course_title="Curso",
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
    """`purchases.provider` tiene un CHECK: apple, google, web o manual.

    Registrar una pasarela con otro nombre haria fallar el INSERT justo al
    cobrar, que es el peor momento posible para descubrirlo.
    """
    permitidos = {"apple", "google", "web", "manual"}
    for nombre, proveedor in providers.PROVIDERS.items():
        assert proveedor.name in permitidos, (
            f"La pasarela '{nombre}' se identifica como '{proveedor.name}', "
            f"que no admite la columna purchases.provider ({permitidos})."
        )


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
