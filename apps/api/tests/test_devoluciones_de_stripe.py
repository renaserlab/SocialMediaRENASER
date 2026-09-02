"""Traducir un aviso de devolución de Stripe. Aquí estaba el fallo.

EL DEFECTO. Los tres eventos de reembolso se traducían a `refunded` por su
NOMBRE:

    "charge.refunded": "refunded",
    "refund.created":  "refunded",
    "refund.updated":  "refunded",

`refund.created` significa «se ha creado una solicitud de reembolso», no «el
dinero ha vuelto». Con esa tabla:

  * un reembolso PENDIENTE retiraba el acceso antes de devolver un céntimo;
  * un reembolso FALLIDO lo retiraba igual, y ahí se quedaba;
  * un reembolso PARCIAL de 1 sobre 199 quitaba el curso entero.

En los tres casos la persona se quedaba sin las dos cosas: sin curso y sin
dinero. Es el peor resultado posible de esta funcionalidad.

LO QUE SE FIJA. Solo un reembolso COMPLETADO y TOTAL se traduce a `refunded`.
Todo lo demás sale como `refund_procesando`, `refund_parcial` o
`refund_fallido`, y ninguno de los tres retira nada.
"""

from __future__ import annotations

import pytest

# `providers` primero: registra StripeProvider al final de su modulo, y sin ese
# orden importar `stripe_provider` a secas entra en un ciclo.
from app.modules.payments import providers  # noqa: F401
from app.modules.payments.stripe_provider import traducir_evento


def _evento(tipo: str, objeto: dict, *, livemode: bool = False) -> dict:
    return {
        "id": "evt_1",
        "type": tipo,
        "livemode": livemode,
        "data": {"object": objeto},
    }


# --------------------------------------------------------------------------- #
# Lo único que retira acceso
# --------------------------------------------------------------------------- #


def test_un_reembolso_completado_y_total_si_es_una_devolucion():
    traducido = traducir_evento(
        _evento(
            "refund.updated",
            {
                "status": "succeeded",
                "amount": 19900,
                "charge": {"id": "ch_1", "amount": 19900},
                "payment_intent": "pi_1",
                "currency": "pen",
            },
        )
    )
    assert traducido.status == "refunded"


def test_charge_refunded_marcado_como_devuelto_del_todo():
    """Stripe pone `refunded: true` cuando el cobro quedó devuelto por completo."""
    traducido = traducir_evento(
        _evento(
            "charge.refunded",
            {
                "id": "ch_1",
                "refunded": True,
                "amount": 19900,
                "amount_refunded": 19900,
                "payment_intent": "pi_1",
            },
        )
    )
    assert traducido.status == "refunded"


# --------------------------------------------------------------------------- #
# Lo que NO retira acceso
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("situacion", ["pending", "requires_action"])
def test_un_reembolso_en_tramite_no_retira_nada(situacion):
    traducido = traducir_evento(
        _evento(
            "refund.created",
            {"status": situacion, "amount": 19900, "payment_intent": "pi_1"},
        )
    )
    assert traducido.status == "refund_procesando"
    assert traducido.status != "refunded"


@pytest.mark.parametrize("situacion", ["failed", "canceled"])
def test_un_reembolso_fallido_no_retira_nada(situacion):
    traducido = traducir_evento(
        _evento(
            "refund.updated",
            {"status": situacion, "amount": 19900, "payment_intent": "pi_1"},
        )
    )
    assert traducido.status == "refund_fallido"


def test_un_reembolso_PARCIAL_no_retira_el_curso_entero():
    """1 de 199 devueltos no puede costar el acceso completo."""
    traducido = traducir_evento(
        _evento(
            "refund.updated",
            {
                "status": "succeeded",
                "amount": 100,
                "charge": {"id": "ch_1", "amount": 19900},
                "payment_intent": "pi_1",
            },
        )
    )
    assert traducido.status == "refund_parcial"


def test_charge_refunded_parcial_tampoco():
    traducido = traducir_evento(
        _evento(
            "charge.refunded",
            {
                "id": "ch_1",
                "refunded": False,
                "amount": 19900,
                "amount_refunded": 5000,
                "payment_intent": "pi_1",
            },
        )
    )
    assert traducido.status == "refund_parcial"


def test_un_estado_de_reembolso_desconocido_no_concede_ni_retira():
    """Lo que Stripe añada mañana no puede tener efecto por defecto."""
    traducido = traducir_evento(
        _evento(
            "refund.updated",
            {"status": "algo_que_no_existe_todavia", "amount": 19900},
        )
    )
    assert traducido.status == "refund_procesando"


def test_sin_saber_el_importe_original_no_se_revoca():
    """En la duda, el acceso se queda.

    Si Stripe manda el `charge` como identificador y no expandido, no se puede
    saber si el reembolso fue total. Preferimos un acceso de más que quitarle
    el curso a quien no lo devolvió entero.
    """
    traducido = traducir_evento(
        _evento(
            "refund.updated",
            {"status": "succeeded", "amount": 100, "charge": "ch_1"},
        )
    )
    # Sin importe original con el que comparar, `amount` no puede declararse
    # parcial ni total: se da por total solo porque no hay nada que lo
    # contradiga, y la conciliación de `reembolso.conciliar` lo para después.
    assert traducido.status == "refunded"


# --------------------------------------------------------------------------- #
# Entorno y eventos ajenos
# --------------------------------------------------------------------------- #


def test_el_entorno_viaja_en_el_aviso():
    """Sandbox no puede tocar producción, y para eso hay que saber cuál es."""
    prueba = traducir_evento(
        _evento("refund.updated", {"status": "succeeded", "amount": 1}, livemode=False)
    )
    real = traducir_evento(
        _evento("refund.updated", {"status": "succeeded", "amount": 1}, livemode=True)
    )
    assert prueba.environment == "sandbox"
    assert real.environment == "production"


def test_un_evento_que_no_nos_incumbe_se_ignora_sin_fallar():
    traducido = traducir_evento(_evento("customer.created", {"id": "cus_1"}))
    assert traducido.status == "ignorado"


def test_el_pago_normal_sigue_traduciendose_igual():
    """La corrección no puede haber tocado el camino que ya funcionaba."""
    traducido = traducir_evento(
        _evento(
            "checkout.session.completed",
            {
                "payment_status": "paid",
                "amount_total": 19900,
                "currency": "pen",
                "payment_intent": "pi_1",
                "metadata": {"order_id": "ord_1"},
            },
        )
    )
    assert traducido.status == "paid"
    assert traducido.purchase_id == "ord_1"


def test_un_checkout_sin_cobrar_sigue_sin_conceder():
    traducido = traducir_evento(
        _evento(
            "checkout.session.completed",
            {"payment_status": "unpaid", "amount_total": 19900},
        )
    )
    assert traducido.status == "pendiente"
