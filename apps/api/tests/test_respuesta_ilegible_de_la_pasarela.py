"""Cuando la pasarela contesta 200 y el cuerpo no se puede leer.

PASA. Un balanceador, un proxy corporativo o una página de mantenimiento
contestan HTML con 200 en lugar de reenviar la petición, y lo que llega no es
JSON. Antes, `respuesta.json()` levantaba la excepción del parser en mitad de la
ejecución del reembolso: quien llamaba recibía un 500 sin saber si el dinero se
había movido, y el expediente se quedaba en `refund_processing` con un error de
servidor por toda explicación.

LA REGLA ES LA MISMA QUE CON UN TIEMPO DE ESPERA AGOTADO: la petición salió con
su clave de idempotencia, así que el reembolso PUEDE existir. Se devuelve
`pending`, no `failed`. Darlo por fallido invitaría a un reintento, y como el
fallo no es terminal —eso también se comprueba aquí— el reintento repetiría la
misma clave; pero dejar el expediente en `failed` por una respuesta que nadie
entendió es afirmar algo que no se sabe.
"""

from __future__ import annotations

import httpx
import pytest

from app.modules.payments.reembolsos import RefundRequestToProvider, es_terminal
from app.modules.payments.stripe_refunds import StripeRefundProvider


PETICION = RefundRequestToProvider(
    external_transaction_id="pi_1",
    amount_minor=19900,
    currency="pen",
    idempotency_key="zrefund_1",
)


class _Http:
    """Un cliente que devuelve siempre la misma respuesta."""

    def __init__(self, respuesta: httpx.Response) -> None:
        self.respuesta = respuesta
        self.llamadas = 0

    async def post(self, *_args, **_kwargs) -> httpx.Response:
        self.llamadas += 1
        return self.respuesta

    async def get(self, *_args, **_kwargs) -> httpx.Response:
        self.llamadas += 1
        return self.respuesta


def _proveedor(cuerpo: bytes, *, tipo: str = "text/html") -> StripeRefundProvider:
    respuesta = httpx.Response(
        200, content=cuerpo, headers={"content-type": tipo},
        request=httpx.Request("POST", "https://api.stripe.test/v1/refunds"),
    )
    return StripeRefundProvider(cliente_http=_Http(respuesta))


@pytest.fixture(autouse=True)
def _con_stripe_encendido():
    """La bandera y una clave, para que el proveedor real llegue a llamar."""
    from app.core.config import get_settings

    ajustes = get_settings()
    previos = (
        ajustes.stripe_refunds_enabled,
        ajustes.stripe_secret_key,
        ajustes.stripe_api_base,
    )
    ajustes.stripe_refunds_enabled = True
    ajustes.stripe_secret_key = "sk_test_de_mentira"
    ajustes.stripe_api_base = "https://api.stripe.test"
    yield
    (
        ajustes.stripe_refunds_enabled,
        ajustes.stripe_secret_key,
        ajustes.stripe_api_base,
    ) = previos


@pytest.mark.asyncio
async def test_un_200_con_html_no_revienta_y_queda_pendiente():
    resultado = await _proveedor(b"<html>503 backend</html>").create_full_refund(
        PETICION
    )
    assert resultado.status == "pending"
    assert resultado.failure_code == "unreadable_response"
    # Y sin identificador: no nos inventamos una referencia que no vino.
    assert resultado.external_refund_id == ""


@pytest.mark.asyncio
async def test_un_json_que_no_es_un_objeto_tampoco_se_da_por_bueno():
    """`[]` o `"ok"` son JSON válido y no son una respuesta de reembolso."""
    resultado = await _proveedor(b"[]", tipo="application/json").create_full_refund(
        PETICION
    )
    assert resultado.status == "pending"
    assert resultado.failure_code == "unreadable_response"


@pytest.mark.asyncio
async def test_un_cuerpo_vacio_tambien_es_ilegible():
    resultado = await _proveedor(b"").create_full_refund(PETICION)
    assert resultado.status == "pending"


@pytest.mark.asyncio
async def test_consultar_el_estado_con_una_respuesta_ilegible_no_concluye_nada():
    """Preguntar y no entender la contestación no dice nada del reembolso."""
    resultado = await _proveedor(b"<html>").get_refund_status("re_1")
    assert resultado.status == "pending"
    assert resultado.failure_code == "unreadable_response"


def test_una_respuesta_ilegible_NO_es_un_fallo_terminal():
    """Si lo fuera, el reintento cambiaría de clave y podría pagar dos veces."""
    assert es_terminal("unreadable_response") is False


@pytest.mark.asyncio
async def test_una_respuesta_legible_sigue_traduciendose():
    """La guarda no puede haberse comido el camino normal."""
    respuesta = httpx.Response(
        200,
        json={"id": "re_1", "status": "succeeded", "amount": 19900},
        request=httpx.Request("POST", "https://api.stripe.test/v1/refunds"),
    )
    proveedor = StripeRefundProvider(cliente_http=_Http(respuesta))
    resultado = await proveedor.create_full_refund(PETICION)
    assert resultado.status == "succeeded"
    assert resultado.external_refund_id == "re_1"
    assert resultado.amount_minor == 19900


@pytest.mark.asyncio
async def test_el_motivo_del_fallo_se_acota_antes_de_guardarlo():
    """Lo escribe la pasarela y acaba en una columna nuestra y en una pantalla."""
    respuesta = httpx.Response(
        200,
        json={"id": "re_1", "status": "failed", "failure_reason": "x" * 500},
        request=httpx.Request("POST", "https://api.stripe.test/v1/refunds"),
    )
    proveedor = StripeRefundProvider(cliente_http=_Http(respuesta))
    resultado = await proveedor.create_full_refund(PETICION)
    assert resultado.status == "failed"
    assert len(resultado.failure_code) == 64
