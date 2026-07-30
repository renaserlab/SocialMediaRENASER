"""Esquemas del portal de pagos."""

from datetime import datetime

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


class CourseAccessRead(BaseModel):
    """Si la persona puede ver el contenido de un curso, y por qué."""

    course_id: str
    has_access: bool
    #: 'gratuito', 'comprado', 'autor', 'administracion' o 'sin_acceso'.
    #: Sirve para que la interfaz explique el motivo en vez de un no seco.
    reason: str = Field(default="sin_acceso")
