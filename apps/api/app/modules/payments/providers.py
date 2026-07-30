"""Abstracción de pasarela de pago.

Todavía no hay pasarela elegida (Culqi, Stripe, Mercado Pago...), así que el
resto del módulo no habla con ninguna en concreto: habla con esta interfaz. El
día que se decida, se escribe una clase que la implemente y se registra en
`PROVIDERS`; nada más del código de pagos cambia.

Las dos operaciones que necesita cualquier pasarela:

1. **Iniciar el cobro**: se le dice cuánto y por qué, y devuelve lo que el
   cliente necesita para pagar (normalmente una URL de checkout).
2. **Verificar el aviso de vuelta**: la pasarela llama a nuestro webhook para
   confirmar. Hay que comprobar que ese aviso viene de verdad de ella y no de
   alguien que descubrió la URL.

El punto 2 es el que de verdad importa. Sin verificar la firma, cualquiera
podría regalarse cursos con una petición.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True)
class CheckoutRequest:
    """Lo que se le pide a la pasarela para iniciar un cobro."""

    purchase_id: str
    course_title: str
    #: En la unidad MENOR de la moneda (céntimos). Nunca en decimales: los
    #: flotantes pierden precisión y en dinero eso acaba en descuadres.
    amount_minor: int
    currency: str
    user_email: str
    #: A dónde vuelve el usuario tras pagar.
    return_url: str


@dataclass(frozen=True)
class CheckoutSession:
    """Lo que hay que devolverle al cliente para que pague."""

    #: URL a la que se manda al usuario. En la app se abre en el navegador del
    #: sistema, no dentro de la aplicación.
    checkout_url: str
    #: Referencia del cobro en la pasarela, para conciliar después.
    provider_reference: str


@dataclass(frozen=True)
class PaymentEvent:
    """Un aviso de la pasarela, ya verificado y traducido."""

    purchase_id: str
    provider_transaction_id: str
    #: 'paid', 'cancelled' o 'refunded'. Cualquier otro valor se ignora.
    status: str
    amount_minor: int
    currency: str


class PaymentProvider(ABC):
    """Contrato que debe cumplir cualquier pasarela que se conecte."""

    #: Identificador corto. Debe coincidir con el CHECK de la columna
    #: `purchases.provider`, que hoy admite: apple, google, web, manual.
    name: str

    @abstractmethod
    async def create_checkout(self, request: CheckoutRequest) -> CheckoutSession:
        """Inicia el cobro y devuelve a dónde mandar al usuario."""

    @abstractmethod
    def verify_and_parse(self, *, body: bytes, headers: dict[str, str]) -> PaymentEvent:
        """Comprueba que el aviso viene de la pasarela y lo traduce.

        DEBE lanzar una excepción si la firma no cuadra. Fallar aquí en abierto
        —aceptar lo que llegue— convierte el webhook en una forma de regalarse
        cursos: basta con descubrir la URL y enviar un `paid`.
        """


class NotConfiguredProvider(PaymentProvider):
    """Marcador de posición mientras no se elige pasarela.

    Existe para que el módulo entero se pueda desplegar, probar y revisar sin
    haber decidido el proveedor. Falla de forma explícita en vez de simular un
    cobro, que es justo el error que llevó a quitar la pasarela anterior.
    """

    name = "web"

    async def create_checkout(self, request: CheckoutRequest) -> CheckoutSession:
        raise NotImplementedError(
            "No hay pasarela de pago configurada. Implementa PaymentProvider "
            "para la elegida y regístrala en PROVIDERS."
        )

    def verify_and_parse(self, *, body: bytes, headers: dict[str, str]) -> PaymentEvent:
        raise NotImplementedError(
            "No hay pasarela de pago configurada; no se puede verificar el aviso."
        )


#: Pasarelas disponibles, por nombre. Al implementar una real se añade aquí.
PROVIDERS: dict[str, PaymentProvider] = {
    "web": NotConfiguredProvider(),
}


def get_provider(name: str) -> PaymentProvider | None:
    return PROVIDERS.get(name)
