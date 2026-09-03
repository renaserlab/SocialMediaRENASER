"""Pedirle a Stripe la devolución total de un cobro.

Se separa de `stripe_provider.py` a propósito: aquel resuelve cobrar y
verificar avisos, y ya es largo. Devolver dinero es una operación distinta, con
su propia clave de idempotencia y su propio manejo de fallos, y mezclarla allí
haría que un cambio en el cobro pudiera romper el reembolso.

LO QUE ESTE MÓDULO NO HACE: retirar accesos. Aquí solo se pide. Quien decide
que el acceso se va es el webhook confirmado, y solo si el reembolso fue total
—ver `refunds/reembolso.py`—. Que Stripe conteste `succeeded` a esta petición
no es suficiente: el webhook es la confirmación que se concilia.
"""

from __future__ import annotations

import logging

import httpx

from app.modules.payments.reembolsos import (
    ESTADOS_CONOCIDOS,
    RefundProvider,
    RefundRequestToProvider,
    RefundResult,
)

logger = logging.getLogger("renaser.payments")

ESPERA_MAXIMA = 15.0


class StripeRefundProvider(RefundProvider):
    """El adaptador real. Solo se instancia con la bandera encendida."""

    name = "stripe"

    def __init__(self, *, cliente_http: httpx.AsyncClient | None = None) -> None:
        #: Inyectable para poder probar la traducción de respuestas sin salir a
        #: la red. En producción es `None` y se abre un cliente por llamada.
        self._http = cliente_http

    async def create_full_refund(
        self, peticion: RefundRequestToProvider
    ) -> RefundResult:
        from app.core.config import get_settings

        ajustes = get_settings()
        # NO SE MANDA EL IMPORTE. Stripe devuelve el cobro ENTERO cuando se
        # omite `amount`, y eso es exactamente lo que se quiere: mandar un
        # número abre la puerta a un reembolso parcial por un error de cálculo,
        # y un parcial no retira el acceso pero sí saca el dinero.
        campos = {
            "payment_intent": peticion.external_transaction_id,
            "reason": "requested_by_customer",
        }
        for clave, valor in peticion.metadata.items():
            campos[f"metadata[{clave}]"] = str(valor)

        cabeceras = {
            "Authorization": f"Bearer {ajustes.stripe_secret_key}",
            "Content-Type": "application/x-www-form-urlencoded",
            # Derivada de la SOLICITUD. Tres reintentos mandan la misma clave y
            # Stripe devuelve el mismo reembolso en vez de crear tres.
            "Idempotency-Key": peticion.idempotency_key,
        }
        url = f"{ajustes.stripe_api_base.rstrip('/')}/v1/refunds"

        try:
            if self._http is not None:
                respuesta = await self._http.post(
                    url, data=campos, headers=cabeceras, timeout=ESPERA_MAXIMA
                )
            else:  # pragma: no cover - salida real
                async with httpx.AsyncClient(timeout=ESPERA_MAXIMA) as cliente:
                    respuesta = await cliente.post(url, data=campos, headers=cabeceras)
        except httpx.HTTPError as error:
            # Un tiempo de espera agotado NO significa que no se haya hecho: la
            # petición pudo llegar. Por eso se devuelve «pendiente» y no
            # «fallido», y por eso la clave de idempotencia importa tanto —el
            # reintento no duplicará nada—.
            logger.error("[pagos] Stripe no responde al reembolso: %s", error)
            return RefundResult(
                status="pending",
                failure_code="network_timeout",
                failure_message="No hubo respuesta; puede haberse creado igual.",
            )

        if respuesta.status_code >= 400:
            # NO se registra el cuerpo: puede llevar datos del cobro.
            logger.error(
                "[pagos] Stripe rechazo el reembolso con %s", respuesta.status_code
            )
            return RefundResult(
                status="failed",
                failure_code=f"http_{respuesta.status_code}",
                failure_message="La pasarela rechazó la devolución.",
            )

        datos = _cuerpo(respuesta)
        if datos is None:
            # PENDIENTE, no fallido. La peticion salio con su clave de
            # idempotencia, asi que el reembolso PUEDE existir; darlo por
            # fallido invitaria a un reintento con clave nueva.
            logger.error("[pagos] la respuesta del reembolso no es legible")
            return RefundResult(
                status="pending",
                failure_code="unreadable_response",
                failure_message="Respuesta ilegible; puede haberse creado igual.",
            )
        return _traducir(datos)

    async def get_refund_status(self, external_refund_id: str) -> RefundResult:
        from app.core.config import get_settings

        ajustes = get_settings()
        url = (
            f"{ajustes.stripe_api_base.rstrip('/')}/v1/refunds/{external_refund_id}"
        )
        cabeceras = {"Authorization": f"Bearer {ajustes.stripe_secret_key}"}
        try:
            if self._http is not None:
                respuesta = await self._http.get(
                    url, headers=cabeceras, timeout=ESPERA_MAXIMA
                )
            else:  # pragma: no cover - salida real
                async with httpx.AsyncClient(timeout=ESPERA_MAXIMA) as cliente:
                    respuesta = await cliente.get(url, headers=cabeceras)
        except httpx.HTTPError as error:
            logger.error("[pagos] no se pudo consultar el reembolso: %s", error)
            return RefundResult(status="pending", failure_code="network_timeout")
        if respuesta.status_code >= 400:
            return RefundResult(
                status="failed", failure_code=f"http_{respuesta.status_code}"
            )
        datos = _cuerpo(respuesta)
        if datos is None:
            # Consultar y no entender la respuesta no dice nada del reembolso.
            return RefundResult(status="pending", failure_code="unreadable_response")
        return _traducir(datos)


def _cuerpo(respuesta) -> dict | None:
    """El JSON de la respuesta, o `None` si no hay forma de leerlo.

    Un 200 que no trae JSON casi siempre es un intermediario contestando en
    lugar de Stripe. Antes esto reventaba con la excepcion del parser en mitad
    de la ejecucion de un reembolso, y quien llama recibia un 500 sin saber si
    el dinero se movio.
    """
    try:
        datos = respuesta.json()
    except Exception:  # el parser de httpx no promete un tipo concreto
        return None
    return datos if isinstance(datos, dict) else None


def _traducir(cuerpo: dict) -> RefundResult:
    """De la respuesta de Stripe a lo que entiende el módulo.

    Un estado que no conocemos se trata como FALLO y no como éxito. Es la misma
    regla que en los webhooks: lo que no se entiende no puede tener el efecto
    más grave, que aquí sería dar por devuelto un dinero que no se movió.
    """
    situacion = str(cuerpo.get("status") or "").lower()
    bruto = cuerpo.get("amount")
    devuelto = bruto if isinstance(bruto, int) else None
    referencia = str(cuerpo.get("id") or "")
    if situacion == "succeeded":
        return RefundResult(
            status="succeeded",
            external_refund_id=referencia,
            amount_minor=devuelto,
        )
    if situacion in {"pending", "requires_action"}:
        return RefundResult(
            status="pending",
            external_refund_id=referencia,
            amount_minor=devuelto,
        )
    if situacion in ESTADOS_CONOCIDOS:
        return RefundResult(
            status=situacion,
            external_refund_id=referencia,
            # Acotado: lo escribe la pasarela y acaba en una columna nuestra.
            failure_code=str(cuerpo.get("failure_reason") or "")[:64],
        )
    return RefundResult(
        status="failed",
        external_refund_id=referencia,
        failure_code="unknown_status",
        failure_message=f"Stripe devolvió un estado desconocido: '{situacion}'.",
    )
