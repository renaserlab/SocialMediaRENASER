"""Esquemas del portal de pagos."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class CheckoutCreate(BaseModel):
    """Petición para empezar a comprar un curso.

    Solo lleva el curso. El importe NO se acepta del cliente: se lee del propio
    curso en el servidor. Si viniera de fuera, cualquiera podría comprar un
    curso de 300 por 1.
    """

    course_id: str


class CheckoutRead(BaseModel):
    """Respuesta con lo necesario para pagar."""

    purchase_id: str
    #: A dónde mandar al usuario. En móvil se abre en el navegador del sistema.
    checkout_url: str
    amount_minor: int
    currency: str


class PurchaseRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    course_id: str
    status: str
    amount_minor: int
    currency: str
    purchased_at: datetime


class EstadoDeOrdenRead(BaseModel):
    """En qué quedó una orden concreta. Para la pantalla de vuelta del pago.

    POR QUÉ EXISTE. Al volver de la pasarela, el navegador trae `?order=<id>` y
    nada más. Sin este endpoint, la pantalla solo podía creerse ese parámetro —o
    la ausencia de él— para decidir si felicitar a alguien por una compra. Un
    parámetro de la barra de direcciones lo escribe cualquiera.

    `has_access` va aparte de `status` A PROPÓSITO, y no es redundante: la orden
    puede estar `paid` y el acceso todavía no concedido porque el aviso de la
    pasarela no ha llegado. La pantalla necesita distinguir «pagado, dándote
    acceso» de «ya puedes entrar», y esa diferencia dura segundos pero es
    exactamente cuando la persona está mirando.
    """

    id: str
    course_id: str
    course_title: str = ""
    #: 'pending', 'paid', 'failed', 'cancelled' o 'refunded'.
    status: str
    amount_minor: int
    currency: str
    #: Si el acceso ya está concedido. Lo resuelve el comercio, no la orden.
    has_access: bool

    # ---- Lo que hace falta para la constancia (no fiscal) ------------------ #
    created_at: datetime
    #: Cuándo se confirmó el cobro. Nulo mientras no se haya confirmado.
    paid_at: datetime | None = None
    provider: str = ""
    #: Qué versión del curso se compró. Nulo en las compras anteriores al
    #: versionado: ahí no hay forma de saberlo y decir «1» sería inventarlo.
    course_version: int | None = None
    #: Las horas de garantía que se prometieron en ESTA compra.
    guarantee_hours: int | None = None
    #: Si esta compra se hizo sabiendo que no tendría garantía.
    repurchase_without_guarantee: bool = False


class CourseAccessRead(BaseModel):
    """Si la persona puede ver el contenido de un curso, y por qué."""

    course_id: str
    has_access: bool
    #: 'gratuito', 'comprado', 'autor', 'administracion' o 'sin_acceso'.
    #: Sirve para que la interfaz explique el motivo en vez de un no seco.
    reason: str = Field(default="sin_acceso")


# ---------------------------------------------------------------------------
# Compra nativa (Google Play / App Store a través de RevenueCat)
# ---------------------------------------------------------------------------


class NativeSyncCreate(BaseModel):
    """Lo único que la aplicación móvil puede enviar al sincronizar.

    NO lleva producto, ni importe, ni transacción, ni entitlement, ni un
    «he comprado». Es un DISPARADOR: el servidor le pregunta a RevenueCat qué
    compras tiene de verdad ese `appUserID` —que es el UUID de Supabase de
    quien firma el JWT— y actúa sobre esa respuesta.

    `platform` es una ETIQUETA para apuntar el canal del pedido cuando la
    tienda no lo dice (el Test Store no distingue Android de iOS). No decide
    nada sobre el acceso: aunque se mienta, el acceso sale de RevenueCat.
    """

    platform: Literal["ios", "android"] | None = None


class NativeSyncRead(BaseModel):
    """Qué ha cambiado tras sincronizar."""

    #: Cursos a los que se acaba de conceder acceso.
    granted: list[str] = Field(default_factory=list)
    #: Cursos cuyo acceso se ha retirado (devolución confirmada).
    revoked: list[str] = Field(default_factory=list)
    #: Cursos a los que ya se tenía acceso. Restaurar dos veces no es un error.
    unchanged: list[str] = Field(default_factory=list)
    #: Identificadores de tienda que no están dados de alta en
    #: `provider_products`. No conceden nada; se devuelven para poder detectar
    #: un producto mal configurado sin entrar a los registros del servidor.
    unknown_products: list[str] = Field(default_factory=list)


class StoreProductRead(BaseModel):
    """Qué se puede comprar para un curso en una plataforma concreta.

    Existe para que la pantalla NUNCA enseñe un botón muerto: si un curso no
    tiene producto dado de alta para esa tienda, `available` es false y la
    interfaz lo dice con palabras en vez de ofrecer una compra imposible.
    """

    course_id: str
    #: 'ios' | 'android' | 'web'
    platform: str
    available: bool
    #: 'revenuecat_test' | 'google' | 'apple' | 'stripe', o null si no hay.
    provider: str | None = None
    #: Identificador EN LA TIENDA, para pedírselo al SDK. En web no se usa.
    product_id: str | None = None
    #: Precio de catálogo, en unidad menor. Es referencia y precio WEB: en
    #: tienda manda el precio localizado del `StoreProduct`, que solo conoce el
    #: dispositivo.
    price_minor: int = 0
    currency: str = "PEN"
    #: Por qué no está disponible: 'gratuito', 'ya_comprado', 'sin_producto',
    #: 'pagos_apagados', 'no_publicado'. Vacío si sí lo está.
    reason: str = ""


class PurchaseHistoryRead(BaseModel):
    """Una compra del historial, reconstruida desde el servidor.

    Nunca desde AsyncStorage: en el teléfono no hay forma de saber si algo se
    devolvió, y quien reinstale se quedaría sin historial.
    """

    id: str
    course_id: str
    #: 'pending' | 'paid' | 'failed' | 'cancelled' | 'refunded'
    status: str
    amount_minor: int
    currency: str
    provider: str
    channel: str
    purchased_at: datetime | None = None
    #: QUE VERSION DEL CURSO SE COMPRO, si se sabe (0050).
    #:
    #: `None` en todo lo anterior a esa migracion, y eso NO es un hueco que
    #: haya que rellenar: el temario no guarda marca temporal, asi que no hay
    #: forma de saber que contenido se vendio. La pantalla tiene que saber
    #: distinguir «version 2» de «no consta».
    course_version: int | None = None
    #: La promesa de garantia que se enseño, en horas. Hoy 168 para todos.
    guarantee_hours: int | None = None
    #: Si HOY se puede ver el curso. Va aparte del estado del pedido porque no
    #: siempre coinciden: un pedido devuelto sigue existiendo con su fecha, y
    #: lo que cambia es que el acceso ya no está.
    has_access: bool = False
