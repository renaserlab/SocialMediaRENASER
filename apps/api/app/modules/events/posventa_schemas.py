"""Los contratos de la posventa de eventos.

LO QUE NO SALE DE AQUÍ: las notas internas, los parámetros de la política y el
motivo interno de una decisión. El comprador ve su expediente y su estado; el
organizador ve el impacto; quien administra ve lo demás.

Y NO SE PROMETE NADA. El veredicto de elegibilidad lleva códigos de motivo, no
frases, y un importe solo cuando la política publicada lo dice. `null` es
«nadie lo ha decidido», y la pantalla tiene que enseñarlo como tal.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class VeredictoDePosventa(BaseModel):
    """¿Se puede pedir algo con esta compra, y con qué consecuencia?"""

    #: `eligible`, `not_eligible`, `needs_review` o `policy_not_configured`.
    resultado: str
    #: Códigos estables, no frases: la aplicación los traduce a es/en/pt y una
    #: consulta puede agruparlos.
    motivos: list[str] = Field(default_factory=list)
    #: Si tiene sentido ofrecer el botón. `needs_review` cuenta: se puede
    #: registrar la solicitud, lo que no se puede es prometer un resultado.
    puede_pedir: bool = False
    #: Con qué reglas se decidió. `null` cuando no hay ninguna publicada.
    politica_version: str | None = None
    #: Lo que la política permite devolver, en puntos básicos. **`null` NO es
    #: cero**: es que nadie ha decidido el número.
    porcentaje_bps: int | None = None


class AbrirExpedienteRequest(BaseModel):
    order_id: str
    #: `buyer_cancellation`, `refund_request`, `essential_change`, `exception`…
    kind: str
    reason: str | None = Field(default=None, max_length=1000)


class LineaDeHistorial(BaseModel):
    """Un paso del expediente. SIN la nota interna."""

    from_status: str | None = None
    to_status: str
    actor_role: str
    reason: str | None = None
    created_at: datetime


class ExpedienteRead(BaseModel):
    """El expediente, como lo ve quien lo abrió.

    NO LLEVA `internal_notes`. Está en su propia columna precisamente para que
    no se pueda colar aquí por descuido.
    """

    id: str
    event_id: str
    order_id: str
    kind: str
    status: str
    #: Lo que dijo quien lo abrió. Es suyo, así que sí lo ve.
    reason: str | None = None
    outcome: str | None = None
    #: `null` mientras no haya decisión. Nunca cero.
    refund_amount_minor: int | None = None
    currency: str | None = None
    created_at: datetime
    updated_at: datetime
    resolved_at: datetime | None = None
    #: Lo que ESTE actor puede hacer ahora. Para pintar botones, no para decidir.
    acciones: list[str] = Field(default_factory=list)


class ExpedienteDeAdministracion(ExpedienteRead):
    """Lo mismo, más lo que solo ve quien administra."""

    buyer_id: str
    organizer_id: str
    internal_notes: str | None = None
    assignee_id: str | None = None
    policy_id: str | None = None
    provider: str
    environment: str


class PaginaDeExpedientes(BaseModel):
    items: list[ExpedienteRead] = Field(default_factory=list)
    next_cursor: str | None = None


class DecisionRequest(BaseModel):
    """Aprobar, rechazar o pedir información.

    `reason` se le enseña a la persona; `notes` no sale nunca de administración.
    """

    reason: str | None = Field(default=None, max_length=500)
    notes: str | None = Field(default=None, max_length=2000)
    #: Obligatorio al cerrar con resultado: sin política no se explica nada.
    outcome: str | None = None
    refund_amount_minor: int | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, min_length=3, max_length=3)


class ResponderRequest(BaseModel):
    """La explicación que el comprador manda cuando se le pide información."""

    reason: str = Field(min_length=1, max_length=1000)


class EntradaAfectadaRead(BaseModel):
    """Una entrada del expediente. SIN credencial y SIN código.

    El comprador ya sabe cuáles son sus entradas; lo que necesita aquí es
    saber en qué estado quedó cada una, y eso no exige repartir nada que
    admita en una puerta.
    """

    ticket_id: str
    name: str
    #: `VALID`, `USED` o `REVOKED`.
    status: str
    #: Cómo estaba al abrirse el expediente. Congelado.
    status_at_open: str
    #: `none`, `under_review`, `blocked`, `cancelled`, `revoked` o `restored`.
    effect: str


class PoliticaAplicadaRead(BaseModel):
    """Con qué reglas se resolvió, para poder explicarlo después.

    NO LLEVA `params`. Los números son de administración; al comprador le
    corresponde saber qué versión se le aplicó y qué texto la acompañaba.
    """

    policy_type: str
    version: str
    published_at: datetime | None = None
    body: str | None = None


class RetiroRequest(BaseModel):
    """Retirar la propia solicitud. Solo el motivo.

    Antes reutilizaba `DecisionRequest`, que publica en el contrato del
    comprador campos que solo toca administración. El código los ignoraba, pero
    el OpenAPI decía lo contrario.
    """

    reason: str | None = Field(default=None, max_length=500)


class PublicarPoliticaRequest(BaseModel):
    """Publicar una decisión de la empresa.

    `params` son los números y `body` el texto. Van separados porque uno se
    calcula y el otro se enseña.
    """

    policy_type: str
    version: str = Field(min_length=1, max_length=32)
    params: dict = Field(default_factory=dict)
    event_id: str | None = None
    body: str | None = None
    locale: str = "es"


class PoliticaRead(BaseModel):
    id: str
    policy_type: str
    scope: str
    event_id: str | None = None
    version: str
    status: str
    params: dict = Field(default_factory=dict)
    params_sha256: str
    published_at: datetime | None = None


class CambioRead(BaseModel):
    """Un cambio registrado del evento. Sin clasificar es SIN CLASIFICAR."""

    id: str
    event_id: str
    field: str
    previous_value: str | None = None
    new_value: str | None = None
    #: `pending` no es «no esencial»: es que nadie lo ha mirado.
    classification: str
    classified_at: datetime | None = None
    created_at: datetime


class ClasificarCambioRequest(BaseModel):
    classification: str
    reason: str | None = Field(default=None, max_length=500)


__all__ = [
    "AbrirExpedienteRequest",
    "CambioRead",
    "ClasificarCambioRequest",
    "DecisionRequest",
    "ExpedienteDeAdministracion",
    "ExpedienteRead",
    "LineaDeHistorial",
    "PaginaDeExpedientes",
    "PoliticaRead",
    "EntradaAfectadaRead",
    "PoliticaAplicadaRead",
    "PublicarPoliticaRequest",
    "ResponderRequest",
    "RetiroRequest",
    "VeredictoDePosventa",
]
