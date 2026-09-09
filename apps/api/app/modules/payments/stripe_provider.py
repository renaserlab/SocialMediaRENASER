"""Stripe Checkout alojado. **Solo para la web.**

## Por qué alojado y no un formulario propio

Un formulario de tarjeta propio significa que los datos de la tarjeta pasan por
nuestro código y por nuestro servidor, y eso arrastra el cumplimiento de PCI
entero. Checkout alojado lo pone Stripe: nosotros creamos la sesión desde el
servidor y mandamos a la persona a la URL que devuelve.

## Por qué no se usa el paquete `stripe`

Solo hacen falta dos cosas —crear una sesión y verificar una firma— y las dos
son HTTP y HMAC. `httpx` ya está en las dependencias y `hmac` es de la
biblioteca estándar. Una dependencia menos que auditar y que actualizar en la
ruta más sensible del proyecto.

## Los nombres de evento

Verificados el 26/08/2026 contra la lista vigente de tipos de evento de Stripe,
no de memoria:

- `checkout.session.completed` — la sesión terminó. **No implica cobrado**: con
  métodos de pago diferidos llega con `payment_status` en `unpaid`. Conceder
  aquí sin mirarlo regala el curso a quien elige transferencia y no la hace.
- `checkout.session.async_payment_succeeded` — el pago diferido sí llegó.
- `checkout.session.async_payment_failed` — no llegó.
- `checkout.session.expired` — la sesión caducó sin pagar.
- `charge.refunded`, `refund.created`, `refund.updated` — devoluciones. La
  documentación de `charge.refunded` remite a `refund.created` para el detalle;
  se escuchan las tres porque cuál llega depende del método de pago.

## La firma

`Stripe-Signature: t=<epoch>,v1=<hmac>`, donde el HMAC-SHA256 se calcula sobre
`f"{t}.{cuerpo}"` con el secreto del endpoint (`whsec_...`). Se compara con
`hmac.compare_digest` —no con `==`— y se rechaza lo que venga con más de cinco
minutos, que es lo que impide reenviar un aviso legítimo capturado hace un rato.

**Falla cerrado.** Si falta el secreto, si falta la cabecera o si el HMAC no
cuadra, se levanta excepción. Aceptar lo que llegue convertiría esta URL en la
forma más cómoda de regalarse el catálogo entero.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import time
from typing import Any

import httpx

from app.core.config import get_settings
from app.modules.payments.providers import (
    CheckoutRequest,
    CheckoutSession,
    PaymentEvent,
    PaymentProvider,
)

logger = logging.getLogger("renaser.payments")

#: Margen de tolerancia de la marca de tiempo de la firma, en segundos. Es el
#: valor que recomienda Stripe.
TOLERANCIA_FIRMA = 300

ESPERA_MAXIMA = 15.0

#: Qué evento deja la compra en qué estado. Lo que no esté aquí se ignora sin
#: fallar: Stripe manda muchos avisos y la mayoría no nos incumben.
EVENTOS: dict[str, str] = {
    "checkout.session.completed": "paid",
    "checkout.session.async_payment_succeeded": "paid",
    "checkout.session.async_payment_failed": "failed",
    "checkout.session.expired": "cancelled",
    # LOS TRES DE DEVOLUCION NO SE TRADUCEN AQUI. El estado real depende del
    # CONTENIDO del evento, no de su nombre, y eso lo resuelve `_estado_de_
    # devolucion` mas abajo. Se listan para que `EVENTOS` siga siendo la lista
    # de «lo que nos incumbe»; el valor es provisional.
    "charge.refunded": "refund_pendiente",
    "refund.created": "refund_pendiente",
    "refund.updated": "refund_pendiente",
    "refund.failed": "refund_pendiente",
    "charge.refund.updated": "refund_pendiente",
    # UNA DISPUTA NO ES UNA DEVOLUCION. La abre el banco del titular, no la
    # persona, y el dinero se retira sin pasar por nuestro circuito. No estaban
    # aqui, y eso tenia dos consecuencias malas: con las compras apagadas el
    # aviso salia con 503 y Stripe reintentaba en bucle hasta deshabilitar el
    # endpoint —dejando de entregar tambien las compras y devoluciones
    # legitimas—; y con las compras encendidas se descartaba en silencio.
    "charge.dispute.created": "disputa_abierta",
    "charge.dispute.funds_withdrawn": "disputa_fondos_retirados",
    "charge.dispute.closed": "disputa_cerrada",
}

#: Lo que Stripe llama a un reembolso que SI se completo.
REFUND_COMPLETADO = "succeeded"
#: Y lo que llama a los que no.
REFUND_PENDIENTE = frozenset({"pending", "requires_action"})
REFUND_FALLIDO = frozenset({"failed", "canceled"})


class StripeConfigError(RuntimeError):
    """Falta configuración de Stripe. No se simula nada: se falla."""


class StripeSignatureError(ValueError):
    """La firma no cuadra. El aviso no se procesa."""


def _cabecera(headers: dict[str, str], nombre: str) -> str:
    # Las cabeceras HTTP no distinguen mayúsculas; el dict que llega de
    # Starlette ya viene en minúsculas, pero un doble de pruebas puede no.
    objetivo = nombre.lower()
    for clave, valor in headers.items():
        if clave.lower() == objetivo:
            return valor
    return ""


def verificar_firma(
    *, body: bytes, signature: str, secret: str, ahora: float | None = None
) -> None:
    """Comprueba la firma oficial de Stripe. Levanta si no cuadra."""
    if not secret:
        raise StripeConfigError(
            "STRIPE_WEBHOOK_SECRET no está configurado; no hay con qué verificar."
        )
    if not signature:
        raise StripeSignatureError("El aviso llega sin cabecera Stripe-Signature.")

    marca = ""
    firmas: list[str] = []
    for parte in signature.split(","):
        clave, _, valor = parte.strip().partition("=")
        if clave == "t":
            marca = valor
        elif clave == "v1":
            firmas.append(valor)
    if not marca or not firmas:
        raise StripeSignatureError("Cabecera Stripe-Signature mal formada.")

    try:
        instante = int(marca)
    except ValueError as error:
        raise StripeSignatureError("Marca de tiempo no numérica.") from error

    referencia = time.time() if ahora is None else ahora
    if abs(referencia - instante) > TOLERANCIA_FIRMA:
        # Sin esto, cualquiera que capture un aviso legítimo puede reenviarlo
        # cuando quiera. La idempotencia lo pararía la segunda vez, pero la
        # primera no tiene por qué haber ocurrido todavía.
        raise StripeSignatureError("El aviso está fuera de la ventana de tiempo.")

    esperado = hmac.new(
        secret.encode("utf-8"),
        f"{marca}.".encode("utf-8") + body,
        hashlib.sha256,
    ).hexdigest()
    if not any(hmac.compare_digest(esperado, firma) for firma in firmas):
        raise StripeSignatureError("La firma no coincide.")


def _aplanar(prefijo: str, valor: Any, destino: dict[str, str]) -> None:
    """La API de Stripe es form-encoded con corchetes, no JSON."""
    if isinstance(valor, dict):
        for clave, sub in valor.items():
            _aplanar(f"{prefijo}[{clave}]", sub, destino)
    elif isinstance(valor, list):
        for indice, sub in enumerate(valor):
            _aplanar(f"{prefijo}[{indice}]", sub, destino)
    elif isinstance(valor, bool):
        destino[prefijo] = "true" if valor else "false"
    elif valor is not None:
        destino[prefijo] = str(valor)


class StripeProvider(PaymentProvider):
    """Checkout alojado de Stripe. Web y solo web."""

    #: Coincide con el CHECK de `provider_products.provider`, que admite
    #: 'revenuecat_test', 'google', 'apple' y 'stripe'.
    name = "stripe"

    #: **Stripe NO escribe en `purchases`.** Sus cobros van a `orders` y
    #: `payment_transactions` (migración 0035), y el acceso a `entitlements`.
    #: Por eso su nombre no está sujeto al CHECK de cuatro valores de la tabla
    #: antigua: nunca inserta ahí. Llamarse 'web' para caber en una columna que
    #: no toca sería mentir sobre quién cobró y dejaría de poder distinguirse
    #: de cualquier otro proveedor web en la contabilidad.
    dominio = "comercio"

    def __init__(self, *, cliente_http: httpx.AsyncClient | None = None) -> None:
        #: Se inyecta para poder simular la FRONTERA del proveedor en las
        #: pruebas sin salir a la red de verdad.
        self._http = cliente_http

    async def create_checkout(self, request: CheckoutRequest) -> CheckoutSession:
        ajustes = get_settings()
        if not ajustes.stripe_secret_key:
            raise StripeConfigError("STRIPE_SECRET_KEY no está configurado.")

        campos: dict[str, str] = {}
        _aplanar("mode", "payment", campos)
        _aplanar("success_url", request.return_url, campos)
        _aplanar("cancel_url", request.cancel_url or request.return_url, campos)
        _aplanar("client_reference_id", request.purchase_id, campos)
        if request.user_email:
            _aplanar("customer_email", request.user_email, campos)
        # EL IMPORTE LO PONE EL SERVIDOR, aquí y ahora. Se construye con
        # `price_data` en vez de apuntar a un Price de Stripe a propósito: un
        # Price es un segundo sitio donde vive el precio, y el día que alguien
        # cambie uno y no el otro se cobraría algo que nosotros no decidimos.
        _aplanar(
            "line_items",
            [
                {
                    "quantity": 1,
                    "price_data": {
                        "currency": request.currency.lower(),
                        "unit_amount": request.amount_minor,
                        "product_data": {"name": request.concepto},
                    },
                }
            ],
            campos,
        )
        metadata = dict(request.metadata)
        _aplanar("metadata", metadata, campos)
        # La misma metadata en el PaymentIntent: es lo que sobrevive hasta la
        # devolución, cuando la sesión de checkout ya no está en juego.
        _aplanar("payment_intent_data", {"metadata": metadata}, campos)

        cabeceras = {
            "Authorization": f"Bearer {ajustes.stripe_secret_key}",
            "Content-Type": "application/x-www-form-urlencoded",
            # Clave de idempotencia: si la persona da dos veces a comprar, o si
            # se reintenta la petición, Stripe devuelve LA MISMA sesión en vez
            # de abrir una segunda. Lleva el importe dentro para que un cambio
            # de precio sí genere una sesión nueva.
            "Idempotency-Key": (
                f"checkout:{request.purchase_id}:"
                f"{request.amount_minor}:{request.currency}"
            ),
        }
        url = f"{ajustes.stripe_api_base.rstrip('/')}/v1/checkout/sessions"
        try:
            if self._http is not None:
                respuesta = await self._http.post(
                    url, data=campos, headers=cabeceras, timeout=ESPERA_MAXIMA
                )
            else:  # pragma: no cover - salida real
                async with httpx.AsyncClient(timeout=ESPERA_MAXIMA) as cliente:
                    respuesta = await cliente.post(url, data=campos, headers=cabeceras)
        except httpx.HTTPError as error:
            raise StripeConfigError(f"Stripe no responde: {error}") from error

        if respuesta.status_code >= 400:
            logger.error("[pagos] Stripe rechazó el checkout: %s", respuesta.status_code)
            raise StripeConfigError(
                f"Stripe respondió {respuesta.status_code} al crear el checkout."
            )
        cuerpo = respuesta.json()
        destino = cuerpo.get("url")
        if not destino:
            raise StripeConfigError("Stripe no devolvió una URL de checkout.")
        return CheckoutSession(checkout_url=destino, provider_reference=cuerpo.get("id", ""))

    def verify_and_parse(self, *, body: bytes, headers: dict[str, str]) -> PaymentEvent:
        ajustes = get_settings()
        verificar_firma(
            body=body,
            signature=_cabecera(headers, "stripe-signature"),
            secret=ajustes.stripe_webhook_secret,
        )
        try:
            evento = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as error:
            raise StripeSignatureError("El cuerpo firmado no es JSON.") from error
        if not isinstance(evento, dict):
            raise StripeSignatureError("El cuerpo firmado no es un objeto.")
        return traducir_evento(evento)


def traducir_evento(evento: dict[str, Any]) -> PaymentEvent:
    """De un evento de Stripe a lo que entiende el resto del módulo.

    Se separa de la verificación para poder probar la traducción con eventos de
    ejemplo sin tener que firmarlos, y —más importante— para que quede claro
    que traducir NUNCA valida: aquí ya se ha comprobado la firma.
    """
    tipo = str(evento.get("type") or "")
    objeto = evento.get("data", {}).get("object", {})
    if not isinstance(objeto, dict):
        objeto = {}
    estado = EVENTOS.get(tipo, "ignorado")

    # `checkout.session.completed` no significa cobrado. Con métodos de pago
    # diferidos llega con `payment_status` en `unpaid` y el dinero puede no
    # llegar nunca.
    if tipo == "checkout.session.completed" and objeto.get("payment_status") != "paid":
        estado = "pendiente"

    # UN AVISO DE DEVOLUCION NO ES UNA DEVOLUCION. Aqui estaba el fallo: los
    # tres eventos de reembolso se traducian a 'refunded' por su NOMBRE, asi
    # que un reembolso pendiente, uno fallido y uno PARCIAL retiraban el acceso
    # igual que uno completo. Quien pedia devolver 1 de 199 perdia el curso
    # entero, y quien tenia un reembolso en tramite lo perdia antes de cobrar.
    if estado == "refund_pendiente":
        estado = _estado_de_devolucion(tipo, objeto)

    referencia = _referencia_de_cobro(objeto)
    interno = _identificador_interno(objeto)

    return PaymentEvent(
        refund_id=_identificador_del_reembolso(tipo, objeto),
        purchase_id=interno,
        dominio=_dominio(objeto),
        provider_transaction_id=referencia,
        status=estado,
        amount_minor=_importe(objeto),
        currency=str(objeto.get("currency") or "").upper(),
        event_id=str(evento.get("id") or ""),
        event_type=tipo,
        environment="production" if evento.get("livemode") else "sandbox",
        payload=evento,
    )


def _estado_de_devolucion(tipo: str, objeto: dict[str, Any]) -> str:
    """Que significa DE VERDAD este aviso de devolucion.

    Devuelve 'refunded' SOLO si el reembolso esta completado Y es total. Todo
    lo demas es 'refund_procesando', 'refund_fallido' o 'refund_parcial', y
    ninguno de los tres retira el acceso.

    LAS DOS FORMAS DEL EVENTO. `refund.*` trae el objeto reembolso, con su
    `status` y su `amount`. `charge.refunded` trae el COBRO, sin `status` de
    reembolso pero con `amount_refunded` y `amount`, que es lo que permite
    saber si se devolvio todo o una parte.
    """
    if tipo.startswith("refund.") or tipo == "charge.refund.updated":
        situacion = str(objeto.get("status") or "").lower()
        if situacion in REFUND_FALLIDO:
            return "refund_fallido"
        if situacion != REFUND_COMPLETADO:
            # Incluye 'pending', 'requires_action' y cualquier estado que
            # Stripe añada mañana. Lo desconocido NO concede ni retira nada.
            return "refund_procesando"
        # Completado. Falta saber si fue total, y para eso hace falta el cobro.
        devuelto = objeto.get("amount")
        cobrado = _importe_del_cobro(objeto)
        if isinstance(devuelto, int) and cobrado and devuelto < cobrado:
            return "refund_parcial"
        return "refunded"

    # `charge.refunded`: el objeto es el cobro.
    if not objeto.get("refunded", False):
        # Stripe lo marca `true` cuando el cobro quedo devuelto POR COMPLETO.
        devuelto = objeto.get("amount_refunded")
        cobrado = objeto.get("amount")
        if isinstance(devuelto, int) and isinstance(cobrado, int) and devuelto < cobrado:
            return "refund_parcial"
        return "refund_procesando"
    return "refunded"


def _identificador_del_reembolso(tipo: str, objeto: dict[str, Any]) -> str:
    """El `re_...` de este aviso, o cadena vacía si el aviso no lo trae.

    DOS FORMAS. En `refund.*` el objeto ES el reembolso, así que su `id` sirve.
    En `charge.refunded` el objeto es el COBRO: el reembolso solo aparece si
    Stripe expande la lista `refunds`, y muchas veces no lo hace.

    Cuando no viene se devuelve vacío, y eso deja el caso SIN CONCILIAR: se
    conserva el acceso y hace falta una revisión —o el `refund.updated` que
    llegará después con su identificador—. Inventarlo a partir del cobro es lo
    que hacía el código anterior, y ese identificador no existe en Stripe.
    """
    if tipo.startswith("refund.") or tipo == "charge.refund.updated":
        valor = objeto.get("id")
        return valor if isinstance(valor, str) and valor.startswith("re_") else ""

    reembolsos = objeto.get("refunds")
    datos = reembolsos.get("data") if isinstance(reembolsos, dict) else None
    if not isinstance(datos, list):
        return ""

    # EL MAS RECIENTE, y no «solo si hay uno». Stripe ordena la lista de nuevo a
    # viejo, asi que el primero es el que acaba de completar la devolucion.
    #
    # Exigir un unico elemento parecia lo prudente y era una regresion: devolver
    # 19 900 en dos tramos desde el panel es legitimo, y ahi Stripe manda
    # `refunded: true` con DOS entradas. Sin identificador el aviso no
    # conciliaba, y los `refund.updated` de cada tramo tampoco servian —su
    # importe es parcial—: la persona cobraba los 19 900 y conservaba el curso.
    #
    # Aqui solo se llega con el cobro devuelto POR COMPLETO (lo comprueba antes
    # `_estado_de_devolucion`), asi que el conjunto suma el total. La lista
    # entera queda en `payment_events` para poder auditarla.
    for entrada in datos:
        valor = entrada.get("id") if isinstance(entrada, dict) else None
        if isinstance(valor, str) and valor.startswith("re_"):
            return valor
    return ""


def _importe_del_cobro(objeto: dict[str, Any]) -> int:
    """El importe del cobro al que apunta un objeto reembolso.

    Stripe puede mandar `charge` como identificador o como objeto expandido.
    Sin el importe original no se puede saber si un reembolso fue total, y en
    la duda NO se revoca: es preferible un acceso de mas que quitarle el curso
    a quien no lo devolvio entero.
    """
    cobro = objeto.get("charge")
    if isinstance(cobro, dict):
        valor = cobro.get("amount")
        if isinstance(valor, int):
            return valor
    valor = objeto.get("charge_amount")
    return valor if isinstance(valor, int) else 0


def _dominio(objeto: dict[str, Any]) -> str:
    """De que dominio es este cobro, segun la metadata que le adjuntamos."""
    metadata = objeto.get("metadata")
    if isinstance(metadata, dict):
        valor = metadata.get("dominio")
        if isinstance(valor, str):
            return valor
    return ""


def _identificador_interno(objeto: dict[str, Any]) -> str:
    """Nuestro id de pedido, tal y como se lo adjuntamos al crear el cobro."""
    metadata = objeto.get("metadata")
    if isinstance(metadata, dict):
        pedido = metadata.get("order_id")
        if isinstance(pedido, str) and pedido:
            return pedido
    referencia = objeto.get("client_reference_id")
    return referencia if isinstance(referencia, str) else ""


def _referencia_de_cobro(objeto: dict[str, Any]) -> str:
    """El `payment_intent`, que es lo que une una devolución con su compra.

    Se prefiere al id de la sesión de checkout porque un evento de devolución
    trae `payment_intent` y NO trae la sesión. Guardar el intent como
    `external_transaction_id` es lo que permite encontrar el pedido cuando el
    dinero vuelve.
    """
    for clave in ("payment_intent", "id"):
        valor = objeto.get(clave)
        if isinstance(valor, str) and valor:
            return valor
        if isinstance(valor, dict) and isinstance(valor.get("id"), str):
            return valor["id"]
    return ""


def _importe(objeto: dict[str, Any]) -> int:
    for clave in ("amount_total", "amount", "amount_refunded"):
        valor = objeto.get(clave)
        if isinstance(valor, int):
            return valor
    return 0
