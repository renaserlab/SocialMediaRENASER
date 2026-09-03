"""Pagarle al creador. El contrato, el doble y la pasarela real.

APAGADO POR DEFECTO Y SIN ATAJOS. `CREATOR_TRANSFERS_ENABLED` y
`STRIPE_CONNECT_ENABLED` nacen en `false`, y `PLATFORM_FEE_BPS` en `-1`, que no
es «cero por ciento» sino «sin configurar». Con cualquiera de los tres sin
poner, aquí no sale un céntimo hacia ninguna parte.

POR QUÉ ESTÁ SEPARADO DE `liquidacion.py`. Aquel decide **si** un saldo se puede
pagar —garantía vencida, sin reclamación, sin disputa— y esto decide **cómo** se
paga. Mezclarlos haría que un cambio en la pasarela pudiera mover una regla de
negocio, que es exactamente lo que no puede pasar con dinero de un tercero.

LO QUE FALTA PARA ENCENDERLO está en `docs/Z_DEVOLUCIONES_Y_LIQUIDACIONES.md`:
cuenta de Stripe de la empresa, verificación, cuentas conectadas de cada creador
y la decisión de cuánto se queda la plataforma. Ninguna de las cuatro es una
decisión de ingeniería, y ninguna se inventa aquí.
"""

from __future__ import annotations

import hashlib
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Mapping

logger = logging.getLogger("renaser.commerce")

#: Cuánto se espera a la pasarela. Igual que en los reembolsos.
ESPERA_MAXIMA = 15.0


@dataclass(frozen=True)
class TransferRequest:
    """Lo que se le pide a la pasarela."""

    #: La cuenta conectada del creador (`acct_...`). Sale de nuestra tabla, no
    #: de nada que mande el cliente.
    destination_account_id: str
    amount_minor: int
    currency: str
    #: Estable por saldo. Un reintento reutiliza la misma y no paga dos veces.
    idempotency_key: str
    metadata: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class TransferResult:
    """Lo que contesta.

    `status` es uno de: 'succeeded', 'pending', 'failed'. Ninguno de los tres
    marca el saldo como pagado por sí solo: eso lo hace la conciliación con el
    identificador real, igual que en los reembolsos.
    """

    status: str
    external_transfer_id: str = ""
    failure_code: str = ""
    failure_message: str = ""
    #: Lo que la pasarela dice haber transferido. `None` si no lo informa.
    amount_minor: int | None = None
    currency: str | None = None


class TransferProvider(ABC):
    """Lo que tiene que saber hacer cualquier pasarela que pague a un tercero."""

    name: str

    @abstractmethod
    async def create_transfer(self, peticion: TransferRequest) -> TransferResult:
        """Envía el dinero a la cuenta conectada."""

    @abstractmethod
    async def get_transfer_status(self, external_transfer_id: str) -> TransferResult:
        """Consulta cómo acabó."""


class NoConfigurado(TransferProvider):
    """Cuando no hay pasarela o está apagada.

    FALLA EN CERRADO Y LO DICE. No simula un pago con éxito: eso marcaría el
    saldo como transferido sin que el creador hubiera cobrado nada, y ese es el
    error que esta funcionalidad existe para evitar.
    """

    name = "no_configurado"

    async def create_transfer(self, peticion: TransferRequest) -> TransferResult:
        return TransferResult(
            status="failed",
            failure_code="provider_not_configured",
            failure_message="Las transferencias a creadores están desactivadas.",
        )

    async def get_transfer_status(self, external_transfer_id: str) -> TransferResult:
        return TransferResult(status="failed", failure_code="provider_not_configured")


class DobleDeterminista(TransferProvider):
    """La pasarela de mentira, para pruebas y staging.

    DETERMINISTA a propósito: el resultado sale del importe, así que una prueba
    reproduce el escenario que quiere sin parchear nada.

        importe termina en 00  →  éxito
        importe termina en 01  →  pendiente
        importe termina en 02  →  fallo
        importe termina en 03  →  respuesta con estado desconocido

    Y RECUERDA LAS CLAVES: pedir dos veces con la misma clave de idempotencia
    devuelve el MISMO identificador, igual que haría la pasarela real. Sin eso,
    una prueba de reintento pasaría aunque el código generase una clave distinta
    cada vez, que es como se paga dos veces.
    """

    name = "doble"

    def __init__(self) -> None:
        self.vistas: dict[str, TransferResult] = {}
        self.llamadas: list[TransferRequest] = []

    async def create_transfer(self, peticion: TransferRequest) -> TransferResult:
        self.llamadas.append(peticion)
        if peticion.idempotency_key in self.vistas:
            return self.vistas[peticion.idempotency_key]

        final = peticion.amount_minor % 100
        if final == 1:
            resultado = TransferResult(
                status="pending",
                external_transfer_id=_referencia(peticion),
                amount_minor=peticion.amount_minor,
                currency=peticion.currency,
            )
        elif final == 2:
            resultado = TransferResult(
                status="failed",
                failure_code="insufficient_funds",
                failure_message="La cuenta de la plataforma no tiene saldo.",
            )
        elif final == 3:
            resultado = TransferResult(status="lo_que_sea")
        else:
            resultado = TransferResult(
                status="succeeded",
                external_transfer_id=_referencia(peticion),
                amount_minor=peticion.amount_minor,
                currency=peticion.currency,
            )
        self.vistas[peticion.idempotency_key] = resultado
        return resultado

    async def get_transfer_status(self, external_transfer_id: str) -> TransferResult:
        for resultado in self.vistas.values():
            if resultado.external_transfer_id == external_transfer_id:
                return resultado
        return TransferResult(status="failed", failure_code="not_found")


def _referencia(peticion: TransferRequest) -> str:
    """Un identificador estable para la misma clave, como el de la pasarela."""
    huella = hashlib.sha256(peticion.idempotency_key.encode()).hexdigest()[:16]
    return f"tr_doble_{huella}"


#: Prefijo de un identificador de transferencia de Stripe.
PREFIJO_TRANSFERENCIA = "tr_"

#: Motivos por los que la pasarela dijo que no de forma CONCLUYENTE.
#:
#: Misma regla que en los reembolsos y por el mismo motivo: en la duda, ambiguo.
#: Equivocarse hacia «ambiguo» cuesta un reintento que no hace nada; hacia
#: «terminal», un pago duplicado a un tercero.
FALLOS_TERMINALES = frozenset({
    "account_closed",
    "account_frozen",
    "no_account",
    "invalid_destination",
    "insufficient_funds",
    "balance_insufficient",
    "provider_not_configured",
    "transfers_not_allowed",
    #: La transferencia se deshizo: el creador no tiene ese dinero y no hay
    #: nada que esperar. Sin esto el saldo se quedaba en `transferring` para
    #: siempre, que es un estado desde el que `puede_transferirse` dice que no.
    "transfer_reversed",
})


def es_terminal(failure_code: object) -> bool:
    """Si no tiene sentido volver a intentarlo con una clave nueva."""
    codigo = failure_code if isinstance(failure_code, str) else ""
    return codigo.strip().lower() in FALLOS_TERMINALES


def clave_de_idempotencia(balance_id: str, intento: int = 0) -> str:
    """Derivada del SALDO y del número de fallos TERMINALES anteriores.

    Es la misma regla que en los reembolsos, y por el mismo motivo. Con una
    clave fija, el primer «no» queda grabado y reintentar devolvería siempre la
    misma respuesta fallida. Cambiándola en cada intento, un tiempo de espera
    agotado —que NO significa que el dinero no haya salido— produciría un
    segundo pago.

    El intento 0 conserva la clave antigua para no romper transferencias que ya
    estén en vuelo con ella.
    """
    if intento <= 0:
        return f"ztransfer_{balance_id}"
    return f"ztransfer_{balance_id}_r{intento}"


def exigir_referencia(referencia: str | None) -> str:
    """El identificador real de la transferencia, o se levanta.

    Sin esto, cualquier cadena que devolviera la pasarela acabaría en la columna
    y la conciliación preguntaría por algo que no existe, para siempre. Es el
    mismo fallo que ya costó un expediente sin salida en los reembolsos.
    """
    valor = (referencia or "").strip()
    if not valor or ":" in valor or " " in valor:
        raise ValueError("La pasarela no devolvió un identificador de transferencia.")
    if not valor.startswith(PREFIJO_TRANSFERENCIA) or len(valor) <= len(
        PREFIJO_TRANSFERENCIA
    ):
        raise ValueError(f"'{valor}' no es un identificador de transferencia.")
    return valor


def proveedor_de_transferencias() -> TransferProvider:
    """Cuál se usa AHORA, según la configuración.

    Las tres puertas, y la bandera es la última palabra: apagarla corta la
    ejecución sin tener que borrar credenciales.
    """
    from app.core.config import get_settings

    ajustes = get_settings()
    if not ajustes.creator_transfers_enabled or not ajustes.stripe_connect_enabled:
        return NoConfigurado()
    if not (ajustes.stripe_secret_key or "").strip():
        logger.error(
            "[comercio] las transferencias estan encendidas pero no hay clave "
            "secreta. Fallan en cerrado."
        )
        return NoConfigurado()
    from app.modules.commerce.stripe_transfers import StripeTransferProvider

    return StripeTransferProvider()
