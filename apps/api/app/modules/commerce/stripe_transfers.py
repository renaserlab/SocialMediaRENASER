"""Pagarle al creador con Stripe Connect.

Se separa de `stripe_provider.py` y de `stripe_refunds.py` a propósito: cobrar,
devolver y pagar a un tercero son tres operaciones distintas, con tres manejos
de fallo distintos, y mezclarlas haría que un cambio en una pudiera romper otra.

LO QUE ESTE MÓDULO NO HACE: decidir si un saldo se puede pagar. Eso lo resuelve
`liquidacion.puede_transferirse` —garantía vencida, sin reclamación viva, sin
disputa, con la cuenta lista— y aquí solo se ejecuta lo ya autorizado.

SOLO SE INSTANCIA CON LAS BANDERAS ENCENDIDAS. Ver
`transferencias.proveedor_de_transferencias`.
"""

from __future__ import annotations

import logging

import httpx

from app.modules.commerce.transferencias import (
    ESPERA_MAXIMA,
    TransferProvider,
    TransferRequest,
    TransferResult,
)

logger = logging.getLogger("renaser.commerce")

#: Estados que Stripe puede devolver y que sabemos interpretar. Cualquier otro
#: se trata como ambiguo: una respuesta que no entendemos no puede darse por
#: buena cuando lo que está en juego es el dinero de otra persona.
ESTADOS_CONOCIDOS = frozenset({"succeeded", "pending", "failed"})


class StripeTransferProvider(TransferProvider):
    """El adaptador real. Solo se instancia con las banderas encendidas."""

    name = "stripe"

    def __init__(self, *, cliente_http: httpx.AsyncClient | None = None) -> None:
        #: Inyectable para poder probar la traducción sin salir a la red.
        self._http = cliente_http

    async def create_transfer(self, peticion: TransferRequest) -> TransferResult:
        from app.core.config import get_settings

        ajustes = get_settings()
        campos = {
            "amount": str(peticion.amount_minor),
            "currency": peticion.currency.lower(),
            # LA CUENTA CONECTADA SALE DE NUESTRA TABLA, nunca de una petición.
            "destination": peticion.destination_account_id,
        }
        for clave, valor in peticion.metadata.items():
            campos[f"metadata[{clave}]"] = valor

        cabeceras = {
            "Authorization": f"Bearer {ajustes.stripe_secret_key}",
            "Content-Type": "application/x-www-form-urlencoded",
            # Derivada del SALDO. Tres reintentos mandan la misma clave y Stripe
            # devuelve la misma transferencia en vez de crear tres.
            "Idempotency-Key": peticion.idempotency_key,
        }
        url = f"{ajustes.stripe_api_base.rstrip('/')}/v1/transfers"

        try:
            if self._http is not None:
                respuesta = await self._http.post(
                    url, data=campos, headers=cabeceras, timeout=ESPERA_MAXIMA
                )
            else:  # pragma: no cover - salida real
                async with httpx.AsyncClient(timeout=ESPERA_MAXIMA) as cliente:
                    respuesta = await cliente.post(url, data=campos, headers=cabeceras)
        except httpx.HTTPError as error:
            # Un tiempo de espera agotado NO significa que el dinero no haya
            # salido. Por eso «pendiente» y no «fallido», y por eso la clave de
            # idempotencia importa tanto: el reintento no duplicará el pago.
            logger.error("[comercio] Stripe no responde a la transferencia: %s", error)
            return TransferResult(
                status="pending",
                failure_code="network_timeout",
                failure_message="No hubo respuesta; puede haberse creado igual.",
            )

        if respuesta.status_code >= 400:
            # NO se registra el cuerpo: lleva datos de la cuenta del creador.
            logger.error(
                "[comercio] Stripe rechazo la transferencia con %s",
                respuesta.status_code,
            )
            return TransferResult(
                status="failed",
                failure_code=f"http_{respuesta.status_code}",
                failure_message="La pasarela rechazó la transferencia.",
            )

        datos = _cuerpo(respuesta)
        if datos is None:
            # PENDIENTE, no fallido: la petición salió con su clave, así que la
            # transferencia puede existir.
            logger.error("[comercio] la respuesta de la transferencia no es legible")
            return TransferResult(
                status="pending",
                failure_code="unreadable_response",
                failure_message="Respuesta ilegible; puede haberse creado igual.",
            )
        return _traducir(datos)

    async def get_transfer_status(self, external_transfer_id: str) -> TransferResult:
        from app.core.config import get_settings

        ajustes = get_settings()
        url = f"{ajustes.stripe_api_base.rstrip('/')}/v1/transfers/{external_transfer_id}"
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
            logger.error("[comercio] no se pudo consultar la transferencia: %s", error)
            return TransferResult(status="pending", failure_code="network_timeout")
        if respuesta.status_code >= 400:
            return TransferResult(
                status="failed", failure_code=f"http_{respuesta.status_code}"
            )
        datos = _cuerpo(respuesta)
        if datos is None:
            return TransferResult(status="pending", failure_code="unreadable_response")
        return _traducir(datos)


def _cuerpo(respuesta) -> dict | None:
    """El JSON de la respuesta, o `None` si no hay forma de leerlo."""
    try:
        datos = respuesta.json()
    except Exception:  # el parser de httpx no promete un tipo concreto
        return None
    return datos if isinstance(datos, dict) else None


def _traducir(cuerpo: dict) -> TransferResult:
    """De la respuesta de Stripe a lo que entiende el módulo.

    UNA TRANSFERENCIA CREADA NO ES UNA TRANSFERENCIA COBRADA. El objeto
    `transfer` de Stripe no tiene `status`: existir ya significa que el dinero
    salió del saldo de la plataforma hacia la cuenta conectada. Lo que puede
    fallar después es el *payout* de esa cuenta a su banco, y eso es otro
    objeto y otro aviso.

    Por eso, con `reversed: true` se devuelve `failed`: la transferencia se
    deshizo y el creador no tiene ese dinero.
    """
    referencia = str(cuerpo.get("id") or "")
    bruto = cuerpo.get("amount")
    importe = bruto if isinstance(bruto, int) and not isinstance(bruto, bool) else None
    cruda = cuerpo.get("currency")
    moneda = str(cruda).upper() if isinstance(cruda, str) and cruda else None

    situacion = str(cuerpo.get("status") or "").lower()
    if situacion and situacion not in ESTADOS_CONOCIDOS:
        # Un estado que Stripe añada mañana no se da por bueno.
        return TransferResult(
            status="pending",
            external_transfer_id=referencia,
            failure_code="unknown_status",
            failure_message=f"Estado no reconocido: '{situacion}'.",
        )

    if cuerpo.get("reversed") is True:
        return TransferResult(
            status="failed",
            external_transfer_id=referencia,
            failure_code="transfer_reversed",
            failure_message="La transferencia se revirtió.",
            amount_minor=importe,
            currency=moneda,
        )

    if situacion == "failed":
        return TransferResult(
            status="failed",
            external_transfer_id=referencia,
            failure_code=str(cuerpo.get("failure_code") or "")[:64],
            amount_minor=importe,
            currency=moneda,
        )
    if situacion == "pending":
        return TransferResult(
            status="pending",
            external_transfer_id=referencia,
            amount_minor=importe,
            currency=moneda,
        )

    # Sin `status` —el caso normal de `transfer`— o `succeeded` explícito.
    return TransferResult(
        status="succeeded" if referencia else "pending",
        external_transfer_id=referencia,
        amount_minor=importe,
        currency=moneda,
    )
