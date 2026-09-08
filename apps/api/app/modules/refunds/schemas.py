"""Lo que entra y lo que sale por la API de devoluciones.

LO QUE EL CLIENTE PUEDE MANDAR ES DELIBERADAMENTE POCO: qué orden y por qué.
Ni importe, ni moneda, ni curso, ni estado, ni identificador de la pasarela.
Todo eso lo resuelve el servidor desde la orden. Un esquema de entrada que
acepta un `amount_minor` es un esquema que deja elegir cuánto se devuelve, por
mucho que después haya un `if` que lo compruebe.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

MotivoDeDevolucion = Literal[
    "not_as_expected", "content_quality", "technical_problem", "other"
]


class RefundRequestCreate(BaseModel):
    """Crear una solicitud. Dos campos, y ninguno es dinero."""

    order_id: str
    reason: MotivoDeDevolucion
    #: Opcional y PRIVADA: no se le enseña al propietario del curso.
    explanation: str | None = Field(default=None, max_length=2000)


class RefundEligibilityRead(BaseModel):
    """El estado de la garantía, resuelto en el servidor.

    `server_time` va delante a propósito: la pantalla calcula su cuenta atrás a
    partir de esta hora y no de la del teléfono, que puede estar mal puesta o
    movida a mano para estirar el plazo.
    """

    server_time: datetime
    eligible: bool
    #: Código, no frase: la pantalla lo traduce a los tres idiomas.
    reason_code: str | None = None
    first_accessed_at: datetime | None = None
    expires_at: datetime | None = None
    seconds_remaining: int = 0
    refund_used: bool = False
    refund_used_at: datetime | None = None
    active_request_id: str | None = None
    active_request_status: str | None = None
    order_id: str | None = None
    amount_minor: int = 0
    currency: str = ""


class RefundRequestRead(BaseModel):
    """Una solicitud, como la ve quien la pidió."""

    id: str
    order_id: str
    course_id: str
    course_title: str = ""
    status: str
    reason: str
    explanation: str | None = None
    amount_minor: int
    currency: str
    requested_at: datetime
    resolved_at: datetime | None = None
    #: El motivo del rechazo SÍ se le dice a quien lo pidió: es su expediente.
    #: Lo que no sale nunca por aquí son las notas internas de revisión.
    review_notes: str | None = None

    model_config = ConfigDict(from_attributes=True)


class RefundEventRead(BaseModel):
    """Una línea del historial. Solo para administración."""

    id: str
    from_status: str | None
    to_status: str
    actor_role: str
    reason: str | None = None
    notes: str | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AdminRefundRead(RefundRequestRead):
    """Lo mismo, más lo que solo administración puede ver."""

    user_id: str
    user_name: str = ""
    reviewer_id: str | None = None
    external_refund_id: str | None = None
    provider: str | None = None
    environment: str | None = None
    #: Contexto, NO regla. En V1 el porcentaje consumido no rechaza nada por sí
    #: solo: una solicitud que entró en plazo entra en plazo, haya visto la
    #: persona una lección o todas.
    progress_percent: int = 0
    history: list[RefundEventRead] = Field(default_factory=list)


class AdminDecision(BaseModel):
    """Aprobar, rechazar o cancelar.

    `notes` es obligatorio al rechazar y lo exige el endpoint, no este esquema:
    aquí sería opcional para las otras dos acciones y acabaría en un `if` de
    todas formas. Mejor un solo sitio donde se decide.
    """

    notes: str | None = Field(default=None, max_length=2000)


class PolicyAcceptanceCreate(BaseModel):
    """«Sé que esta recompra no tiene garantía»."""

    course_id: str
    accepted: bool
    #: Por dónde se va a comprar. Opcional: en la web no hace falta, porque la
    #: orden lo dice. En las tiendas la orden no existe hasta después del cobro,
    #: así que sin esto no se puede saber a qué compra correspondió la firma.
    #:
    #: NO DECIDE NADA, y por eso puede venir del cliente sin riesgo: es una
    #: etiqueta para el rastro. Lo que concede el acceso lo sigue resolviendo el
    #: servidor contra RevenueCat.
    provider: Literal["stripe", "apple", "google"] | None = None
    #: El identificador del producto en esa tienda.
    product_id: str | None = Field(default=None, max_length=255)


class RepurchaseNoticeRead(BaseModel):
    """Lo que hay que enseñar antes de dejar recomprar.

    El TEXTO viaja desde el servidor porque es lo que hay que poder demostrar
    después. Si viviera en la aplicación, cambiaría con cada despliegue y las
    aceptaciones antiguas apuntarían a una redacción que ya no existe.
    """

    requires_acceptance: bool
    policy_version: str = ""
    notice: str = ""
    checkbox_label: str = ""
    refund_used_at: datetime | None = None
