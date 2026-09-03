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
    #: Lo que la pasarela dice haber devuelto, en unidad menor. `None` si no lo
    #: informa. Sin esto, comprobar que el reembolso fue TOTAL no se puede: se
    #: acababa comparando la orden consigo misma.
    amount_minor: int | None = None
    #: Y en qué moneda lo dice. Comparar importes sin moneda no significa nada:
    #: 19 900 soles y 19 900 dólares son el mismo número y distinto dinero.
    currency: str | None = None


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

        # IMPORTE Y MONEDA, como la pasarela de verdad. Sin ellos la
        # conciliacion no puede cerrar nada —`exigir_moneda(None)` levanta— y el
        # camino feliz quedaba sin poder probarse ni en staging.
        final = peticion.amount_minor % 100
        if final == 1:
            resultado = RefundResult(
                status="pending",
                external_refund_id=_referencia(peticion),
                amount_minor=peticion.amount_minor,
                currency=peticion.currency,
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
                status="succeeded",
                external_refund_id=_referencia(peticion),
                amount_minor=peticion.amount_minor,
                currency=peticion.currency,
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


#: Motivos por los que el emisor dijo que NO, de forma concluyente.
#:
#: Los seis primeros son los valores REALES de `Refund.failure_reason` en
#: Stripe. Los siguientes son códigos de expedientes anteriores que siguen
#: vivos, y los dos últimos son nuestros y también concluyentes.
#:
#: `unknown` NO está aquí, y es deliberado: es lo que Stripe pone cuando ni él
#: sabe qué pasó. Tratarlo como concluyente cambiaría la clave de idempotencia
#: en el reintento y crearía un SEGUNDO reembolso.
FALLOS_TERMINALES = frozenset({
    "lost_or_stolen_card",
    "expired_or_canceled_card",
    "charge_for_pending_refund_disputed",
    "insufficient_funds",
    "declined",
    "merchant_request",
    #: De expedientes anteriores a los códigos reales.
    "card_declined",
    "charge_already_refunded",
    "charge_disputed",
    "expired_or_canceled_authorization",
    "charge_not_refundable",
    "provider_refund_failed",
    #: Nuestros, y concluyentes: no hay nada que reintentar.
    "provider_not_configured",
    "no_transaction",
    #: `canceled` es un estado REAL de `Refund` y es concluyente. Sin traducirlo,
    #: un reembolso cancelado caia en «estado desconocido», se trataba como
    #: ambiguo, y el expediente se quedaba en `refund_processing` sin salida.
    "refund_canceled",
})


def sanear_codigo(failure_code: object) -> str:
    """El código externo, acotado y sin sorpresas, para poder auditarlo.

    Lo escribe la pasarela, así que ni su longitud ni sus caracteres los
    decidimos nosotros. Se guarda saneado —minúsculas, sin espacios, 64
    caracteres— y la decisión de recuperación NO se toma leyendo su forma sino
    comparándolo con una lista explícita.
    """
    texto = failure_code if isinstance(failure_code, str) else ""
    limpio = "".join(c if (c.isalnum() or c in "_-.") else "_" for c in texto.strip().lower())
    return limpio[:64]


def es_terminal(failure_code: object) -> bool:
    """Si el emisor dijo que no, de forma concluyente.

    LISTA EXPLÍCITA Y NADA MÁS. Antes había además dos heurísticas: cualquier
    código que empezara por `provider_refund_failed` y —peor— cualquiera que
    contuviera un espacio, o sea cualquier motivo escrito en prosa. Un mensaje
    de un tiempo de espera agotado contiene espacios, así que un timeout podía
    acabar contando como concluyente, y eso cambia la clave de idempotencia:
    es exactamente cómo se paga dos veces.

    EN LA DUDA, AMBIGUO. Equivocarse hacia «ambiguo» cuesta un reintento que no
    hace nada; hacia «terminal», un cobro duplicado.
    """
    # SE COMPARA EL CODIGO TAL CUAL, no el saneado. `sanear_codigo` convierte
    # los espacios en `_`, asi que clasificar sobre el resultado colaria «card
    # declined» como `card_declined` y reintroduciria por la puerta de atras la
    # heuristica de prosa que este modulo acaba de quitar. Sanear es para
    # GUARDAR; clasificar es otra cosa.
    codigo = failure_code if isinstance(failure_code, str) else ""
    return codigo.strip().lower() in FALLOS_TERMINALES


#: Qué hacer con lo que contesta la pasarela. Es la tabla de la documentación,
#: escrita una sola vez y probada aparte.
APLICAR = "aplicar"
CONCILIAR = "conciliar"
CLAVE_NUEVA = "reintentar_con_clave_nueva"
MISMA_CLAVE = "reintentar_misma_clave"
NO_TOCAR = "no_tocar"


def recuperacion(status: object, failure_code: object = "") -> str:
    """De la respuesta de la pasarela a la acción, sin interpretaciones.

    - `succeeded`: aplicar, y solo tras conciliar importe, moneda y orden.
    - `pending`: conciliar más tarde; no se toca el acceso.
    - `failed` concluyente: se puede volver a intentar con clave NUEVA.
    - `failed` ambiguo: mismo intento, MISMA clave.
    - cualquier otra cosa: no se toca nada y no se crea otro reembolso.
    """
    situacion = status.strip().lower() if isinstance(status, str) else ""
    if situacion == "succeeded":
        return APLICAR
    if situacion == "pending":
        return CONCILIAR
    if situacion == "failed":
        return CLAVE_NUEVA if es_terminal(failure_code) else MISMA_CLAVE
    return NO_TOCAR


def clave_de_idempotencia(refund_request_id: str, intento: int = 0) -> str:
    """Derivada de la SOLICITUD y del número de fallos TERMINALES anteriores.

    POR QUÉ NO PUEDE SER SIEMPRE LA MISMA. Con una clave fija, el primer «no»
    de la pasarela queda grabado: reintentar reenvía la misma clave y Stripe
    devuelve LA MISMA respuesta fallida, para siempre. El botón de reintentar
    no serviría de nada nunca más.

    Y POR QUÉ NO PUEDE CAMBIAR EN CADA INTENTO. Un tiempo de espera agotado no
    significa que no se haya hecho. Mandar una clave nueva después de un
    timeout es exactamente cómo se paga dos veces.

    Así que cambia solo cuando el proveedor ha dicho que no de forma
    concluyente. El número sale de los eventos ya guardados —no de un contador
    en memoria—, así que sobrevive a reinicios y es el mismo para todos los
    procesos.

    El intento 0 conserva la clave antigua para no romper las solicitudes que
    ya estén en vuelo con ella.
    """
    if intento <= 0:
        return f"zrefund_{refund_request_id}"
    return f"zrefund_{refund_request_id}_r{intento}"


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
