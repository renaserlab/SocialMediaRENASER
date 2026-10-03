"""Los contratos de la reserva de Servicios (Incremento 5).

LO QUE SALE, SEGÚN QUIÉN PREGUNTA:

  * QUIEN CONTRATA ve su retención, el resumen, sus reservas con su
    fotografía, lo que aceptó, su historial y lo que él mismo escribió (la
    nota y, a domicilio, la dirección).
  * EL PRESTADOR ve las reservas de sus servicios, la identidad PÚBLICA de
    quien contrata (su nombre de usuario y su nombre visible, nunca el correo
    ni el teléfono) y lo que la atención necesita (la nota y, a domicilio, la
    dirección). Solo de una reserva confirmada, que en este incremento es lo
    único que existe.
  * ADMINISTRACIÓN ve lo operativo: estados, horarios e identificadores. Ni
    la nota ni la dirección.

Nada de esto sale en lo público de la agenda.
"""

from __future__ import annotations

from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field

from app.modules.services import agenda_calculo as calc
from app.modules.services import reserva as dominio
from app.modules.services import reserva_politica as limites
from app.modules.services.atencion_schemas import CuidadoRead
from app.modules.services.catalogo_models import ServiceVersion
from app.modules.services.reserva_models import (
    ServiceBooking,
    ServiceBookingAcceptance,
    ServiceBookingEvent,
    ServiceBookingIntake,
    ServiceHold,
    ServiceOrder,
)


def _local(momento: datetime, zona: str) -> tuple[date, str, str]:
    z = calc.zona(zona)
    if z is None:  # pragma: no cover - la base no deja guardar otra
        momento_local = momento
        return momento_local.date(), momento_local.strftime("%H:%M"), "+00:00"
    reloj = calc.reloj(momento, z)
    return reloj.date(), reloj.strftime("%H:%M"), calc.desplazamiento(reloj)


# --------------------------------------------------------------------------- #
# Entradas
# --------------------------------------------------------------------------- #
class RetencionCrear(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: El INSTANTE del horario elegido, con su desplazamiento (el `starts_at`
    #: que dio la agenda pública). El servidor vuelve a calcularlo.
    starts_at: str = Field(min_length=10, max_length=40)
    modality: str | None = Field(default=None, max_length=16)


class ReservaConfirmar(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: Las condiciones de contratación que se leyeron y aceptan: su versión y
    #: su huella. Si cambiaron entretanto, 409.
    terms_policy_id: str = Field(min_length=1, max_length=64)
    terms_sha256: str = Field(min_length=64, max_length=64)
    #: La huella de las condiciones del servicio, si el servicio las tiene.
    service_conditions_sha256: str | None = Field(default=None, min_length=64, max_length=64)
    note: str | None = Field(default=None, max_length=limites.NOTA_MAXIMA + 50)
    district: str | None = Field(default=None, max_length=limites.DISTRITO_MAXIMO + 50)
    address_line: str | None = Field(default=None, max_length=limites.DIRECCION_MAXIMA + 50)
    address_reference: str | None = Field(default=None, max_length=limites.REFERENCIA_MAXIMA + 50)

    def datos(self) -> dict:
        return self.model_dump()


# --------------------------------------------------------------------------- #
# La retención
# --------------------------------------------------------------------------- #
class RetencionRead(BaseModel):
    id: str
    service_id: str
    #: El estado que VALE: una activa cuyo plazo pasó dice `expired`.
    status: str
    starts_at: datetime
    ends_at: datetime
    date: date
    time: str
    end_time: str
    utc_offset: str
    timezone: str
    modality: str
    expires_at: datetime
    #: La hora del SERVIDOR al responder: la cuenta atrás se hace con ella,
    #: no con el reloj del teléfono.
    server_now: datetime
    seconds_left: int
    booking_id: str | None = None

    @classmethod
    def desde(cls, h: ServiceHold, *, ahora: datetime, reserva_id: str | None = None) -> "RetencionRead":
        inicio = dominio._utc(h.starts_at)
        fin = dominio._utc(h.ends_at)
        fecha, hora, desplazamiento = _local(inicio, h.timezone)
        _, hora_fin, _ = _local(fin, h.timezone)
        estado = dominio.estado_efectivo(h, ahora)
        vence = dominio._utc(h.expires_at)
        return cls(
            id=h.id, service_id=h.service_id, status=estado, starts_at=inicio, ends_at=fin, date=fecha,
            time=hora, end_time=hora_fin, utc_offset=desplazamiento, timezone=h.timezone, modality=h.modality,
            expires_at=vence, server_now=ahora,
            seconds_left=max(0, int((vence - ahora).total_seconds())) if estado == "active" else 0,
            booking_id=reserva_id,
        )


# --------------------------------------------------------------------------- #
# El resumen antes de confirmar
# --------------------------------------------------------------------------- #
class PrecioRead(BaseModel):
    #: `free`, `fixed`, `from` u `on_request`. Sin importe, `null`: nunca un 0
    #: que no existe.
    model: str | None
    amount_minor: int | None
    currency: str | None


class ServicioDelResumenRead(BaseModel):
    id: str
    version_id: str
    title: str | None
    modality: str | None
    duration_minutes: int | None
    #: Lo PÚBLICO del lugar (la zona de la ficha). Nunca una dirección.
    location_area: str | None
    provider_name: str | None
    price: PrecioRead


class CondicionesRead(BaseModel):
    policy_id: str
    version: int
    title: str
    body: str
    sha256: str


class CondicionesDelServicioRead(BaseModel):
    text: str
    sha256: str


class ContratacionRead(BaseModel):
    #: `free` (se confirma), `paid` (se prepara y se detiene: no hay cobro),
    #: `price_not_closed` o `quote_required` (no se contratan).
    kind: str
    #: ¿Se puede confirmar AHORA, con lo que dice el servidor?
    confirmable: bool
    payments_available: bool
    provider_confirmation_required: bool
    #: La versión retenida ya no es la publicada: hay que volver a elegir.
    version_changed: bool
    terms_available: bool
    #: Lo que falta, en códigos estables (la app los traduce).
    blockers: list[str]


class ResumenRead(BaseModel):
    hold: RetencionRead
    service: ServicioDelResumenRead
    contract: ContratacionRead
    terms: CondicionesRead | None
    service_conditions: CondicionesDelServicioRead | None
    requires_address: bool
    limits: dict

    @classmethod
    def desde(cls, r: dominio.Resumen) -> "ResumenRead":
        v: ServiceVersion = r.version
        bloqueos: list[str] = []
        if r.estado != "active":
            bloqueos.append(f"hold_{r.estado}")
        if not r.version_vigente:
            bloqueos.append("version_changed")
        if r.forma == dominio.CONTRATA_CON_PAGO and not r.cobro_disponible:
            bloqueos.append("payments_not_configured")
        if r.forma in (dominio.CONTRATA_A_CONSULTAR, dominio.CONTRATA_PRECIO_ABIERTO):
            bloqueos.append(r.forma)
        if not r.se_confirma_solo:
            bloqueos.append("provider_confirmation_required")
        if r.condiciones is None:
            bloqueos.append("terms_unavailable")
        return cls(
            hold=RetencionRead.desde(r.retencion, ahora=r.ahora, reserva_id=r.reserva_id),
            service=ServicioDelResumenRead(
                id=r.retencion.service_id,
                version_id=v.id,
                title=v.title,
                modality=v.modality,
                duration_minutes=v.duration_minutes,
                location_area=(v.location_area or None) if v.modality == "in_person" else None,
                provider_name=r.prestador.display_name,
                price=PrecioRead(model=v.price_model, amount_minor=v.price_minor, currency=v.currency),
            ),
            contract=ContratacionRead(
                kind=r.forma,
                confirmable=not bloqueos,
                payments_available=r.cobro_disponible,
                provider_confirmation_required=not r.se_confirma_solo,
                version_changed=not r.version_vigente,
                terms_available=r.condiciones is not None,
                blockers=bloqueos,
            ),
            terms=CondicionesRead(
                policy_id=r.condiciones.id, version=r.condiciones.version, title=r.condiciones.title,
                body=r.condiciones.body, sha256=r.condiciones.body_sha256,
            ) if r.condiciones else None,
            service_conditions=CondicionesDelServicioRead(
                text=r.condiciones_del_servicio, sha256=r.huella_del_servicio
            ) if r.condiciones_del_servicio and r.huella_del_servicio else None,
            requires_address=r.pide_direccion,
            limits={
                "note_max_length": limites.NOTA_MAXIMA,
                "district_max_length": limites.DISTRITO_MAXIMO,
                "address_max_length": limites.DIRECCION_MAXIMA,
                "reference_max_length": limites.REFERENCIA_MAXIMA,
            },
        )


# --------------------------------------------------------------------------- #
# La reserva
# --------------------------------------------------------------------------- #
class PrecioDeLaReservaRead(BaseModel):
    """La FOTOGRAFÍA del precio. Gratis: sin importe ni moneda y total cero;
    y nada se cobró (`payment_status = not_required`)."""

    model: str
    amount_minor: int | None
    currency: str | None
    total_minor: int
    payment_status: str


class ReservaRead(BaseModel):
    id: str
    code: str
    status: str
    service_id: str
    title: str
    provider_name: str
    starts_at: datetime
    ends_at: datetime
    date: date
    time: str
    end_time: str
    utc_offset: str
    timezone: str
    modality: str
    duration_minutes: int
    location_area: str | None
    confirmed_at: datetime

    @classmethod
    def desde(cls, b: ServiceBooking) -> "ReservaRead":
        inicio, fin = dominio._utc(b.starts_at), dominio._utc(b.ends_at)
        fecha, hora, desplazamiento = _local(inicio, b.timezone)
        _, hora_fin, _ = _local(fin, b.timezone)
        return cls(
            id=b.id, code=b.booking_code, status=b.status, service_id=b.service_id, title=b.title_snapshot,
            provider_name=b.provider_name_snapshot, starts_at=inicio, ends_at=fin, date=fecha, time=hora,
            end_time=hora_fin, utc_offset=desplazamiento, timezone=b.timezone, modality=b.modality,
            duration_minutes=b.duration_minutes,
            location_area=b.location_area_snapshot if b.modality == "in_person" else None,
            confirmed_at=dominio._utc(b.confirmed_at),
        )


class PaginaDeReservasRead(BaseModel):
    items: list[ReservaRead]
    next_cursor: str | None


class AtencionRead(BaseModel):
    note: str | None
    district: str | None
    address_line: str | None
    address_reference: str | None

    @classmethod
    def desde(cls, a: ServiceBookingIntake | None) -> "AtencionRead | None":
        if a is None:
            return None
        return cls(note=a.note, district=a.district, address_line=a.address_line,
                   address_reference=a.address_reference)


class AceptacionRead(BaseModel):
    kind: str
    version: int | None
    sha256: str
    accepted_at: datetime

    @classmethod
    def desde(cls, a: ServiceBookingAcceptance) -> "AceptacionRead":
        return cls(kind=a.kind, version=a.policy_version, sha256=a.sha256, accepted_at=dominio._utc(a.accepted_at))


#: Lo que no es historia de la reserva para sus partes: cada mensaje o
#: evidencia de un caso (se leen en el expediente) y la moderación de una
#: reseña (es de administración).
ACCIONES_QUE_NO_SE_ENSENAN = ("incident_entry_added", "review_moderated", "attendance_code_issued")


class SucesoRead(BaseModel):
    #: Una de `reserva_models.ACCIONES`.
    action: str
    status: str
    at: datetime

    @classmethod
    def desde(cls, e: ServiceBookingEvent) -> "SucesoRead":
        return cls(action=e.action, status=e.to_status, at=dominio._utc(e.created_at))


class ReservaDetalleRead(ReservaRead):
    price: PrecioDeLaReservaRead
    intake: AtencionRead | None
    acceptances: list[AceptacionRead]
    history: list[SucesoRead]
    #: La atención y la posventa (Incremento 6): lo que se puede hacer, la
    #: llegada, el caso, la reseña. `null` mientras la base no tenga la 0094:
    #: entonces la app no ofrece ninguna de esas acciones.
    care: CuidadoRead | None = None

    @classmethod
    def del_detalle(cls, d: dominio.Detalle) -> "ReservaDetalleRead":
        o: ServiceOrder = d.pedido
        return cls(
            **ReservaRead.desde(d.reserva).model_dump(),
            price=PrecioDeLaReservaRead(
                model=o.price_model, amount_minor=o.price_minor, currency=o.currency, total_minor=o.total_minor,
                payment_status=o.payment_status,
            ),
            intake=AtencionRead.desde(d.atencion),
            acceptances=[AceptacionRead.desde(a) for a in d.aceptaciones],
            # El historial que ven las partes: lo que le pasó a la reserva. Las
            # entradas del expediente y la moderación no son suyas.
            history=[SucesoRead.desde(e) for e in d.historial if e.action not in ACCIONES_QUE_NO_SE_ENSENAN],
            care=d.extra.get("care"),
        )


class ClienteRead(BaseModel):
    """La identidad PÚBLICA de quien contrata. Nunca su correo ni su teléfono."""

    username: str | None
    name: str | None


class ReservaDelPrestadorRead(ReservaDetalleRead):
    #: `null` si la cuenta ya no existe.
    client: ClienteRead | None

    @classmethod
    def del_detalle_del_prestador(cls, d: dominio.Detalle) -> "ReservaDelPrestadorRead":
        base = ReservaDetalleRead.del_detalle(d)
        perfil = d.cliente
        return cls(
            **base.model_dump(),
            client=ClienteRead(username=perfil.username, name=(perfil.full_name or None)) if perfil else None,
        )


# --------------------------------------------------------------------------- #
# Administración: lo operativo, sin nada privado
# --------------------------------------------------------------------------- #
class RetencionAdminRead(BaseModel):
    id: str
    service_id: str
    client_id: str | None
    status: str
    starts_at: datetime
    expires_at: datetime
    created_at: datetime

    @classmethod
    def desde(cls, h: ServiceHold, *, ahora: datetime) -> "RetencionAdminRead":
        return cls(
            id=h.id, service_id=h.service_id, client_id=h.client_id, status=dominio.estado_efectivo(h, ahora),
            starts_at=dominio._utc(h.starts_at), expires_at=dominio._utc(h.expires_at),
            created_at=dominio._utc(h.created_at),
        )


class PaginaDeRetencionesAdminRead(BaseModel):
    items: list[RetencionAdminRead]
    next_cursor: str | None


class ReservaAdminRead(BaseModel):
    id: str
    code: str
    status: str
    service_id: str
    provider_id: str
    client_id: str | None
    title: str
    starts_at: datetime
    modality: str
    confirmed_at: datetime

    @classmethod
    def desde(cls, b: ServiceBooking) -> "ReservaAdminRead":
        return cls(
            id=b.id, code=b.booking_code, status=b.status, service_id=b.service_id, provider_id=b.provider_id,
            client_id=b.client_id, title=b.title_snapshot, starts_at=dominio._utc(b.starts_at),
            modality=b.modality, confirmed_at=dominio._utc(b.confirmed_at),
        )


class PaginaDeReservasAdminRead(BaseModel):
    items: list[ReservaAdminRead]
    next_cursor: str | None


class BarridoRead(BaseModel):
    expired: int


__all__ = [
    "BarridoRead",
    "PaginaDeReservasAdminRead",
    "PaginaDeReservasRead",
    "PaginaDeRetencionesAdminRead",
    "ReservaConfirmar",
    "ReservaDelPrestadorRead",
    "ReservaDetalleRead",
    "ReservaRead",
    "ResumenRead",
    "RetencionCrear",
    "RetencionRead",
]
