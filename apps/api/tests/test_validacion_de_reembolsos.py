"""Las puertas que tiene que pasar un reembolso para retirar un acceso comprado.

POR QUÉ ESTÁN AQUÍ Y NO EN UNA PRUEBA DE INTEGRACIÓN. Cada una de estas puertas
protege contra un caso concreto en el que alguien se queda sin el curso y sin el
dinero, y con la base de datos por medio la mitad de esos casos son incómodos de
montar. `validacion` es puro a propósito para poder probarlos todos.

LA REGLA DE LA CASA: en la duda, NO se retira el acceso. Un acceso de más se
corrige; quitarle el curso a quien no cobró, no.
"""

from __future__ import annotations

import pytest

from app.modules.payments import reembolsos
from app.modules.refunds import validacion
from app.modules.refunds.validacion import (
    CompraOriginal,
    NoConciliado,
    ReembolsoConfirmado,
)

COMPRA = CompraOriginal(
    id="orden-1",
    amount_minor=19900,
    currency="PEN",
    environment="production",
    provider="stripe",
)


def _confirmado(**cambios) -> ReembolsoConfirmado:
    base = {
        "external_refund_id": "re_1abc",
        "amount_minor": 19900,
        "currency": "PEN",
        "environment": "production",
        "provider": "stripe",
    }
    base.update(cambios)
    return ReembolsoConfirmado(**base)  # type: ignore[arg-type]


def test_lo_correcto_pasa():
    """La referencia validada es la que sale, para que se guarde esa y no otra."""
    assert validacion.exigir_conciliado(compra=COMPRA, confirmado=_confirmado()) == "re_1abc"


# --------------------------------------------------------------------------- #
# El importe
# --------------------------------------------------------------------------- #


def test_un_importe_ausente_no_se_convierte_en_el_esperado():
    """Era la coalescencia `amount_minor or orden.amount_minor`.

    Convertía «la pasarela no dijo cuánto» en «devolvió justo lo que debía». Es
    la forma más silenciosa de retirarle el curso a quien no cobró nada.
    """
    with pytest.raises(NoConciliado, match="no dice cuánto"):
        validacion.exigir_conciliado(compra=COMPRA, confirmado=_confirmado(amount_minor=None))


def test_un_importe_de_cero_tampoco():
    with pytest.raises(NoConciliado, match="no es positivo"):
        validacion.exigir_conciliado(compra=COMPRA, confirmado=_confirmado(amount_minor=0))


def test_un_importe_negativo_tampoco():
    with pytest.raises(NoConciliado, match="no es positivo"):
        validacion.exigir_conciliado(compra=COMPRA, confirmado=_confirmado(amount_minor=-19900))


def test_un_reembolso_parcial_no_retira_el_acceso():
    """Devolver 1 de 199 no puede quitar el curso entero."""
    with pytest.raises(NoConciliado, match="no es total"):
        validacion.exigir_conciliado(compra=COMPRA, confirmado=_confirmado(amount_minor=100))


def test_un_importe_mayor_que_la_orden_tampoco_cuadra():
    """No es «total y de sobra»: es que ese aviso no es de esta compra."""
    with pytest.raises(NoConciliado, match="no es total"):
        validacion.exigir_conciliado(compra=COMPRA, confirmado=_confirmado(amount_minor=25000))


def test_un_importe_que_no_es_entero_se_rechaza():
    """El dinero va en unidades menores enteras. Un decimal ya es un error."""
    with pytest.raises(NoConciliado, match="no es un entero"):
        validacion.exigir_conciliado(compra=COMPRA, confirmado=_confirmado(amount_minor=199.0))


def test_un_booleano_no_cuela_como_importe():
    """En Python `True` es 1, así que sin comprobarlo pasaría por un importe."""
    with pytest.raises(NoConciliado, match="no es un entero"):
        validacion.exigir_importe(True, esperado=1)


# --------------------------------------------------------------------------- #
# La moneda
# --------------------------------------------------------------------------- #


def test_sin_moneda_no_se_concilia():
    """Comparar importes sin moneda no significa nada."""
    with pytest.raises(NoConciliado, match="no trae moneda"):
        validacion.exigir_conciliado(compra=COMPRA, confirmado=_confirmado(currency=None))


def test_otra_moneda_no_es_el_mismo_dinero():
    """19 900 soles y 19 900 dólares son el mismo número y distinto dinero."""
    with pytest.raises(NoConciliado, match="viene en USD"):
        validacion.exigir_conciliado(compra=COMPRA, confirmado=_confirmado(currency="USD"))


def test_la_moneda_se_compara_normalizada():
    """Stripe la manda en minúsculas; la orden la guarda en mayúsculas."""
    assert validacion.exigir_conciliado(compra=COMPRA, confirmado=_confirmado(currency="pen"))


# --------------------------------------------------------------------------- #
# El entorno y el proveedor
# --------------------------------------------------------------------------- #


def test_un_aviso_de_pruebas_no_toca_produccion():
    with pytest.raises(NoConciliado, match="viene de 'sandbox'"):
        validacion.exigir_conciliado(compra=COMPRA, confirmado=_confirmado(environment="sandbox"))


def test_un_aviso_de_otra_pasarela_no_cuenta():
    with pytest.raises(NoConciliado, match="es de 'paypal'"):
        validacion.exigir_conciliado(compra=COMPRA, confirmado=_confirmado(provider="paypal"))


# --------------------------------------------------------------------------- #
# La referencia
# --------------------------------------------------------------------------- #


def test_sin_referencia_no_hay_reembolso_que_aplicar():
    with pytest.raises(NoConciliado, match="no trae identificador"):
        validacion.exigir_referencia("")


def test_ni_con_espacios_en_blanco():
    with pytest.raises(NoConciliado, match="no trae identificador"):
        validacion.exigir_referencia("   ")


def test_el_payment_intent_no_identifica_un_reembolso():
    """`pi_...` es el COBRO. Guardarlo dejaba el expediente sin salida: conciliar
    preguntaba por un identificador que la pasarela no reconoce, para siempre."""
    with pytest.raises(NoConciliado, match="es otro objeto"):
        validacion.exigir_referencia("pi_3Abc")


def test_el_cargo_tampoco():
    with pytest.raises(NoConciliado, match="es otro objeto"):
        validacion.exigir_referencia("ch_3Abc")


def test_un_identificador_compuesto_por_nosotros_no_vale():
    """`pi_x:refund` era el que se componía antes. No existe en Stripe: no se
    puede consultar, ni auditar, ni cruzar contra otras órdenes."""
    with pytest.raises(NoConciliado, match="compuesto"):
        validacion.exigir_referencia("pi_1:refund")


def test_una_cadena_cualquiera_tampoco():
    with pytest.raises(NoConciliado, match="no es un identificador de reembolso"):
        validacion.exigir_referencia("reembolso-manual-42")


def test_el_prefijo_a_secas_no_es_un_identificador():
    with pytest.raises(NoConciliado, match="no es un identificador de reembolso"):
        validacion.exigir_referencia("re_")


# --------------------------------------------------------------------------- #
# El expediente
# --------------------------------------------------------------------------- #


def _expediente(**cambios):
    base = {
        "solicitud_order_id": "orden-1",
        "solicitud_user_id": "ana",
        "solicitud_course_id": "curso-1",
        "orden_id": "orden-1",
        "orden_user_id": "ana",
        "curso_de_la_orden": "curso-1",
    }
    base.update(cambios)
    return base


def test_el_expediente_de_otra_orden_no_vale():
    with pytest.raises(NoConciliado, match="no pertenece a esta orden"):
        validacion.exigir_expediente_de_la_compra(**_expediente(solicitud_order_id="orden-2"))


def test_el_expediente_de_otra_persona_no_vale():
    """Revocaría el acceso equivocado y consumiría una garantía ajena."""
    with pytest.raises(NoConciliado, match="de otra persona"):
        validacion.exigir_expediente_de_la_compra(**_expediente(solicitud_user_id="bruno"))


def test_el_expediente_de_otro_curso_no_vale():
    with pytest.raises(NoConciliado, match="de otro curso"):
        validacion.exigir_expediente_de_la_compra(**_expediente(solicitud_course_id="curso-9"))


# --------------------------------------------------------------------------- #
# Clasificar el fallo: de aquí sale si el reintento cambia de clave
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "motivo",
    [
        # Los valores REALES de `Refund.failure_reason` en Stripe.
        "lost_or_stolen_card",
        "expired_or_canceled_card",
        "charge_for_pending_refund_disputed",
        "insufficient_funds",
        "declined",
        "merchant_request",
        # Nuestros, y concluyentes.
        "provider_not_configured",
        "no_transaction",
    ],
)
def test_los_motivos_concluyentes_permiten_una_clave_nueva(motivo):
    assert reembolsos.es_terminal(motivo) is True
    assert reembolsos.recuperacion("failed", motivo) == reembolsos.CLAVE_NUEVA


@pytest.mark.parametrize(
    "motivo",
    [
        # Lo que Stripe pone cuando NI EL sabe qué pasó.
        "unknown",
        "network_timeout",
        "unreadable_response",
        "unknown_status",
        "no_refund_reference",
        "http_409",
        "http_500",
        "idempotency_error",
        "",
        # Y cualquier cosa que Stripe añada mañana.
        "algo_que_no_existe_todavia",
    ],
)
def test_lo_ambiguo_repite_la_misma_clave(motivo):
    """Cambiar de clave tras un fallo que NO es concluyente es cómo se paga dos
    veces: la primera petición pudo haberse creado igual."""
    assert reembolsos.es_terminal(motivo) is False
    assert reembolsos.recuperacion("failed", motivo) == reembolsos.MISMA_CLAVE


def test_un_motivo_en_prosa_ya_no_cuenta_como_concluyente():
    """LA HEURÍSTICA QUE SE QUITÓ. `es_terminal` daba por concluyente cualquier
    código con un espacio, o sea cualquier motivo escrito en prosa. El mensaje
    de un tiempo de espera agotado lleva espacios, así que un timeout podía
    acabar clasificado como terminal, cambiar la clave y duplicar el reembolso.
    """
    assert reembolsos.es_terminal("No hubo respuesta; puede haberse creado igual.") is False


def test_el_codigo_externo_se_sanea_para_auditarlo():
    """Lo escribe la pasarela: ni su longitud ni sus caracteres los decidimos."""
    saneado = reembolsos.sanear_codigo("  Card DECLINED\n<script>  ")
    assert len(saneado) <= 64
    assert saneado == "card_declined__script_"
    assert reembolsos.sanear_codigo("x" * 500) == "x" * 64
    assert reembolsos.sanear_codigo(None) == ""


@pytest.mark.parametrize(
    "situacion,esperado",
    [
        ("succeeded", reembolsos.APLICAR),
        ("pending", reembolsos.CONCILIAR),
        ("requires_action", reembolsos.NO_TOCAR),
        ("lo_que_sea", reembolsos.NO_TOCAR),
        ("", reembolsos.NO_TOCAR),
        (None, reembolsos.NO_TOCAR),
    ],
)
def test_la_tabla_de_recuperacion(situacion, esperado):
    """Un estado que no entendemos NO retira acceso y NO crea otro reembolso."""
    assert reembolsos.recuperacion(situacion) == esperado


# --------------------------------------------------------------------------- #
# Lo que encontró la revisión independiente
# --------------------------------------------------------------------------- #


def test_un_motivo_en_prosa_no_cuela_por_el_saneado():
    """LA HEURÍSTICA VOLVÍA POR LA PUERTA DE ATRÁS.

    `sanear_codigo` convierte los espacios en `_`, así que clasificar sobre su
    resultado haría que «card declined» se leyera como `card_declined` y
    contara como concluyente. Sanear es para GUARDAR; clasificar es otra cosa,
    y se hace sobre el código tal cual.
    """
    assert reembolsos.sanear_codigo("card declined") == "card_declined"
    assert reembolsos.es_terminal("card declined") is False
    assert reembolsos.es_terminal("card_declined") is True


def test_un_reembolso_cancelado_es_concluyente():
    """`canceled` es un estado real de `Refund`. Tratarlo como desconocido
    dejaba el expediente en `refund_processing` sin salida automática."""
    assert reembolsos.es_terminal("refund_canceled") is True
    assert reembolsos.recuperacion("failed", "refund_canceled") == reembolsos.CLAVE_NUEVA


@pytest.mark.asyncio
async def test_el_doble_informa_importe_y_moneda():
    """Sin ellos la conciliación no puede cerrar nada —`exigir_moneda(None)`
    levanta— y el camino feliz quedaba sin poder probarse ni en staging."""
    doble = reembolsos.DobleDeterminista()
    peticion = reembolsos.RefundRequestToProvider(
        external_transaction_id="pi_1",
        amount_minor=19900,
        currency="PEN",
        idempotency_key="zrefund_1",
    )
    resultado = await doble.create_full_refund(peticion)
    assert resultado.status == "succeeded"
    assert resultado.amount_minor == 19900
    assert resultado.currency == "PEN"
    # Y el pendiente también, que es el que va a conciliación.
    pendiente = await doble.create_full_refund(
        reembolsos.RefundRequestToProvider(
            external_transaction_id="pi_2",
            amount_minor=19901,
            currency="PEN",
            idempotency_key="zrefund_2",
        )
    )
    assert pendiente.status == "pending"
    assert pendiente.amount_minor == 19901
    assert pendiente.currency == "PEN"


def test_un_total_devuelto_en_dos_tramos_sigue_identificando_su_reembolso():
    """EXIGIR UN SOLO REEMBOLSO ERA UNA REGRESIÓN.

    Devolver 19 900 en dos operaciones desde el panel de Stripe es legítimo y
    frecuente. Ahí llega `charge.refunded` con `refunded: true` y DOS entradas
    en `refunds.data`. Con la regla de «solo si hay uno» no salía identificador,
    el aviso no conciliaba, y los `refund.updated` de cada tramo tampoco servían
    porque su importe es parcial: la persona cobraba los 19 900 y conservaba el
    curso, para siempre.
    """
    from app.modules.payments import providers  # noqa: F401
    from app.modules.payments.stripe_provider import traducir_evento

    evento = {
        "id": "evt_1",
        "type": "charge.refunded",
        "livemode": False,
        "data": {
            "object": {
                "id": "ch_1",
                "payment_intent": "pi_1",
                "amount": 19900,
                "amount_refunded": 19900,
                "refunded": True,
                "currency": "pen",
                "refunds": {
                    "object": "list",
                    "data": [
                        {"id": "re_segundo", "amount": 14900},
                        {"id": "re_primero", "amount": 5000},
                    ],
                },
            }
        },
    }
    traducido = traducir_evento(evento)
    assert traducido.status == "refunded"
    # El más reciente: Stripe ordena la lista de nuevo a viejo, y es el que
    # acaba de completar la devolución.
    assert traducido.refund_id == "re_segundo"


def test_sin_ningun_identificador_valido_sigue_sin_conciliar():
    """La otra mitad de la regla: si no hay ni un `re_...`, no se retira nada."""
    from app.modules.payments import providers  # noqa: F401
    from app.modules.payments.stripe_provider import traducir_evento

    evento = {
        "id": "evt_1",
        "type": "charge.refunded",
        "livemode": False,
        "data": {
            "object": {
                "id": "ch_1",
                "payment_intent": "pi_1",
                "amount": 19900,
                "amount_refunded": 19900,
                "refunded": True,
                "currency": "pen",
                "refunds": {"object": "list", "data": [{"amount": 19900}]},
            }
        },
    }
    assert traducir_evento(evento).refund_id == ""
