"""Pedirle un reembolso a la pasarela. Desacoplado y apagado por defecto.

TRES COSAS QUE ESTE MÓDULO GARANTIZA, y las tres cuestan dinero real si fallan:

1. **No se ejecuta sin bandera.** `STRIPE_REFUNDS_ENABLED` apagado significa
   que el circuito interno —solicitar, revisar, aprobar— funciona entero y no
   sale un céntimo de ninguna cuenta. Es lo que permite probarlo en staging
   antes de que la empresa tenga cuenta.
2. **No se paga dos veces.** La clave de idempotencia se deriva de la
   SOLICITUD, no del reintento: pulsar «reintentar» tres veces manda tres
   peticiones con la misma clave y la pasarela devuelve el mismo reembolso.
3. **No se inventa nada.** Sin credenciales falla en cerrado: el expediente
   queda en `failed` con el motivo, no en «procesando» para siempre.

EL DOBLE DE PRUEBAS VIVE AQUÍ, junto al real. No en `tests/`: así el escenario
«la pasarela devuelve pendiente» se puede reproducir desde una prueba y desde
un entorno de staging sin duplicar la lógica.
"""

from __future__ import annotations

import hashlib
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Mapping

logger = logging.getLogger("renaser.payments")


@dataclass(frozen=True)
class RefundRequestToProvider:
    """Lo que se le pide a la pasarela."""

    #: La transacción original. Es lo que se devuelve, no un importe suelto.
    external_transaction_id: str
    amount_minor: int
    currency: str
    #: Estable por solicitud. Un reintento reutiliza la misma.
    idempotency_key: str
    metadata: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class RefundResult:
    """Lo que contesta.

    `status` es uno de: 'succeeded', 'pending', 'failed'. Ninguno de los tres
    retira acceso por sí solo: eso lo hace el webhook confirmado, y solo si es
    total. Esta respuesta únicamente dice si la petición se aceptó.
    """

    status: str
    external_refund_id: str = ""
    failure_code: str = ""
    failure_message: str = ""


class RefundProvider(ABC):
    """Lo que tiene que saber hacer cualquier pasarela que devuelva dinero."""

    name: str

    @abstractmethod
    async def create_full_refund(
        self, peticion: RefundRequestToProvider
    ) -> RefundResult:
        """Pide la devolución TOTAL de una transacción."""

    @abstractmethod
    async def get_refund_status(self, external_refund_id: str) -> RefundResult:
        """Consulta cómo va."""


class NoConfigurado(RefundProvider):
    """Cuando no hay pasarela o está apagada.

    FALLA EN CERRADO Y LO DICE. No simula un reembolso con éxito: eso retiraría
    el acceso de alguien a quien no se le ha devuelto nada, que es exactamente
    el error que esta funcionalidad existe para evitar.
    """

    name = "no_configurado"

    async def create_full_refund(
        self, peticion: RefundRequestToProvider
    ) -> RefundResult:
        return RefundResult(
            status="failed",
            failure_code="provider_not_configured",
            failure_message=(
                "Los reembolsos automáticos están desactivados o sin configurar."
            ),
        )

    async def get_refund_status(self, external_refund_id: str) -> RefundResult:
        return RefundResult(status="failed", failure_code="provider_not_configured")


class DobleDeterminista(RefundProvider):
    """La pasarela de mentira, para pruebas y staging.

    DETERMINISTA a propósito: el resultado sale del importe, así que una prueba
    reproduce el escenario que quiere sin parchear nada ni depender del azar.

        importe termina en 00  →  éxito
        importe termina en 01  →  pendiente
        importe termina en 02  →  fallo
        importe termina en 03  →  respuesta inválida (status desconocido)

    Y RECUERDA LAS CLAVES QUE YA VIO: pedir dos veces con la misma clave de
    idempotencia devuelve el MISMO identificador de reembolso, igual que haría
    la pasarela real. Sin eso, una prueba de reintento pasaría aunque el código
    generase una clave distinta cada vez.
    """

    name = "doble"

    def __init__(self) -> None:
        self.vistas: dict[str, RefundResult] = {}
        self.llamadas: list[RefundRequestToProvider] = []

    async def create_full_refund(
        self, peticion: RefundRequestToProvider
    ) -> RefundResult:
        self.llamadas.append(peticion)
        if peticion.idempotency_key in self.vistas:
            return self.vistas[peticion.idempotency_key]

        final = peticion.amount_minor % 100
        if final == 1:
            resultado = RefundResult(
                status="pending", external_refund_id=_referencia(peticion)
            )
        elif final == 2:
            resultado = RefundResult(
                status="failed",
                failure_code="card_declined",
                failure_message="La pasarela rechazó la devolución.",
            )
        elif final == 3:
            resultado = RefundResult(status="lo_que_sea", external_refund_id="")
        else:
            resultado = RefundResult(
                status="succeeded", external_refund_id=_referencia(peticion)
            )
        self.vistas[peticion.idempotency_key] = resultado
        return resultado

    async def get_refund_status(self, external_refund_id: str) -> RefundResult:
        for resultado in self.vistas.values():
            if resultado.external_refund_id == external_refund_id:
                return resultado
        return RefundResult(status="failed", failure_code="not_found")


def _referencia(peticion: RefundRequestToProvider) -> str:
    """Un identificador estable para la misma clave. Como el de la pasarela."""
    huella = hashlib.sha256(peticion.idempotency_key.encode()).hexdigest()[:16]
    return f"re_doble_{huella}"


def clave_de_idempotencia(refund_request_id: str) -> str:
    """Derivada de la SOLICITUD, no del intento.

    Es lo que hace que reintentar no pague dos veces: los tres intentos mandan
    la misma clave y la pasarela reconoce que es la misma operación.
    """
    return f"zrefund_{refund_request_id}"


#: Estados que la pasarela puede devolver y que sabemos interpretar. Cualquier
#: otro se trata como fallo: una respuesta que no entendemos no puede darse por
#: buena cuando lo que está en juego es retirar el acceso de alguien.
ESTADOS_CONOCIDOS = frozenset({"succeeded", "pending", "failed"})


def proveedor_de_reembolsos() -> RefundProvider:
    """Cuál se usa AHORA, según la configuración.

    Sin `STRIPE_REFUNDS_ENABLED` no se devuelve el real ni aunque haya claves:
    la bandera es la última palabra, para que apagarla corte la ejecución sin
    tener que borrar credenciales.
    """
    from app.core.config import get_settings

    ajustes = get_settings()
    if not ajustes.stripe_refunds_enabled:
        return NoConfigurado()
    if not (ajustes.stripe_secret_key or "").strip():
        logger.error(
            "[pagos] STRIPE_REFUNDS_ENABLED esta encendido pero no hay clave "
            "secreta. Los reembolsos fallan en cerrado."
        )
        return NoConfigurado()
    from app.modules.payments.stripe_refunds import StripeRefundProvider

    return StripeRefundProvider()
