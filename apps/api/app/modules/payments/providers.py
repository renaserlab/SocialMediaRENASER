"""Abstracción de pasarela de pago.

La pasarela WEB ya está elegida: **Stripe Checkout alojado**
(`stripe_provider.StripeProvider`). El resto del módulo sigue sin hablar con
ella en concreto: habla con esta interfaz, y por eso añadirla no ha obligado a
tocar el router más que para enchufarla.

**Stripe es SOLO web.** En móvil se compra con Google Play y la App Store a
través de RevenueCat (`revenuecat.py` + `nativo.py`), que no pasa por aquí:
esas compras no tienen checkout que abrir ni firma que verificar, se consultan
servidor a servidor. Meter Stripe en el flujo nativo de compra de cursos es
motivo de rechazo en las dos tiendas.

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
from collections.abc import Mapping
from dataclasses import dataclass, field


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
    #: A dónde vuelve si CANCELA. Volver a la página de «gracias por tu compra»
    #: después de cancelar es mentirle sobre lo que acaba de pasar.
    cancel_url: str = ""
    #: Identificadores INTERNOS que se le adjuntan al cobro para poder
    #: reconciliarlo después (pedido, usuario, curso, producto comercial).
    #: Nunca lleva importes: el importe manda desde `amount_minor`, que se leyó
    #: del servidor.
    metadata: Mapping[str, str] = field(default_factory=dict)


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

    #: Referencia interna del cobro. En el flujo antiguo era el id de
    #: `purchases`; en el nuevo, el de `orders`. Los dos son nuestros y salen
    #: de la metadata que le adjuntamos al crear el checkout, nunca de un campo
    #: que el proveedor rellene por su cuenta.
    purchase_id: str
    provider_transaction_id: str
    #: 'paid', 'cancelled', 'failed' o 'refunded'. Cualquier otro valor se
    #: ignora sin fallar: hay estados intermedios que no nos interesan.
    status: str
    amount_minor: int
    currency: str
    #: Identificador del AVISO (no del cobro). Es la clave anti-replay contra
    #: `payment_events.external_event_id`: si Stripe lo manda diez veces, se
    #: procesa una. Vacío en el flujo antiguo, que no tenía esa tabla.
    event_id: str = ""
    #: Nombre del evento tal y como lo manda el proveedor
    #: (`checkout.session.completed`, `refund.created`...). Se guarda entero
    #: para poder investigar después sin adivinar.
    event_type: str = ""
    #: 'production' si el aviso viene del entorno real, 'sandbox' si no. Un
    #: aviso de pruebas NO puede conceder nada en producción.
    environment: str = "sandbox"
    #: El cuerpo verificado, para dejarlo en `payment_events.payload`.
    payload: Mapping[str, object] = field(default_factory=dict)


#: Nombres que admite `purchases.provider` (esquema ANTIGUO, migración inicial).
NOMBRES_EN_PURCHASES = frozenset({"apple", "google", "web", "manual"})

#: Nombres que admite `provider_products.provider` y `orders.provider` (esquema
#: NUEVO, migración 0035).
NOMBRES_EN_COMERCIO = frozenset({"revenuecat_test", "google", "apple", "stripe"})


class PaymentProvider(ABC):
    """Contrato que debe cumplir cualquier pasarela que se conecte."""

    #: Identificador corto. **Tiene que caber en la columna donde esta pasarela
    #: escriba**, y cuál es esa columna lo dice `dominio`. Registrar una
    #: pasarela con un nombre que su columna no admite hace fallar el INSERT
    #: justo en el momento de cobrar, que es el peor sitio para enterarse.
    name: str

    #: En qué esquema apunta sus cobros esta pasarela. Existe para que la regla
    #: de arriba se pueda COMPROBAR en vez de recordarse:
    #:
    #: - `'purchases'` → tabla `purchases`, con su CHECK de cuatro valores. Es
    #:   el camino heredado.
    #: - `'comercio'` → `orders` y `payment_transactions` de la 0035, cuyo
    #:   CHECK es otro y sí admite 'stripe'.
    #:
    #: Por defecto `'purchases'`: quien añada una pasarela nueva y no piense en
    #: esto queda sujeto al límite más estricto, que es el lado seguro.
    dominio: str = "purchases"

    @property
    def nombres_admitidos(self) -> frozenset[str]:
        """Los nombres que acepta la columna en la que esta pasarela escribe."""
        return (
            NOMBRES_EN_COMERCIO if self.dominio == "comercio" else NOMBRES_EN_PURCHASES
        )

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


#: Pasarelas disponibles, por nombre.
#:
#: `web` es la del flujo ANTIGUO (tabla `purchases`) y sigue sin configurar.
#: `stripe` es la del flujo nuevo (dominio comercial de la 0035) y solo se usa
#: desde la web. Que convivan es temporal: el trasvase de `purchases` a
#: `entitlements` lo hace la migración 0036, y hasta que termine las dos rutas
#: tienen que seguir funcionando.
PROVIDERS: dict[str, PaymentProvider] = {
    "web": NotConfiguredProvider(),
}


def get_provider(name: str) -> PaymentProvider | None:
    return PROVIDERS.get(name)


# Se registra al final y con importación local para no morder la cola: el
# módulo de Stripe necesita `CheckoutRequest` y `PaymentProvider`, que se
# definen justo arriba.
from app.modules.payments.stripe_provider import StripeProvider  # noqa: E402

PROVIDERS["stripe"] = StripeProvider()
