"""Los contratos de la atención y la posventa de Servicios (Incremento 6).

Lo que entra es lo mínimo y se valida en el dominio (los códigos de error son
los suyos). Lo que sale nunca lleva: una nota interna, la ruta de una
evidencia, un correo, un teléfono ni un importe inventado. El efecto económico
es siempre «lo solicitado y su estado», y ese estado nunca dice «ejecutado».
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.modules.services import atencion as dominio
from app.modules.services import posventa
from app.modules.services import reserva as reserva_dominio
from app.modules.services import reserva_politica as limites
from app.modules.services.atencion_models import (
    CON_CODIGO,
    EFECTO_NO_APLICA,
    EJES_DE_RESENA,
    EVIDENCIA,
    ServiceAttendance,
    ServiceIncident,
    ServiceIncidentEntry,
    ServiceReview,
)
from app.modules.services.reserva_models import CLIENTE, PRESTADOR, ServiceBooking, ServiceBookingEvent

_utc = reserva_dominio._utc


def _momento(valor: datetime | None) -> datetime | None:
    return _utc(valor) if valor is not None else None


# --------------------------------------------------------------------------- #
# Lo que entra
# --------------------------------------------------------------------------- #
class _Cerrado(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CancelarReserva(_Cerrado):
    #: Uno de `atencion.MOTIVOS_DE_CANCELACION`.
    reason: str = Field(default="other", max_length=40)
    note: str | None = Field(default=None, max_length=limites.MOTIVO_MAXIMO)


class ReprogramarReserva(_Cerrado):
    #: La retención del horario NUEVO, ya apartada por quien contrata.
    hold_id: str = Field(max_length=64)


class IniciarAtencion(_Cerrado):
    #: El código de quien contrata. Sin él, la atención empieza sin la señal fuerte.
    code: str | None = Field(default=None, max_length=12)


class AbrirCaso(_Cerrado):
    reason: str = Field(max_length=40)
    description: str = Field(max_length=limites.DESCRIPCION_DEL_CASO[1] + 200)


class EscribirEnElCaso(_Cerrado):
    body: str = Field(max_length=limites.ENTRADA_MAXIMA + 200)


class EscribirDesdeAdministracion(_Cerrado):
    body: str = Field(max_length=limites.ENTRADA_MAXIMA + 200)
    #: Una nota interna NO sale de administración.
    internal: bool = False


class ResolverCaso(_Cerrado):
    outcome: str = Field(max_length=40)
    resolution: str = Field(max_length=limites.ENTRADA_MAXIMA + 200)
    attention_effect: str = Field(default="none", max_length=40)
    #: Lo que se SOLICITA. Aquí no se ejecuta nada.
    financial_effect: str = Field(default="none", max_length=40)
    internal_note: str | None = Field(default=None, max_length=limites.ENTRADA_MAXIMA + 200)


class CrearResena(_Cerrado):
    rating: int
    fulfillment: int | None = None
    quality: int | None = None
    punctuality: int | None = None
    clarity: int | None = None
    recommends: bool
    comment: str = Field(max_length=limites.COMENTARIO_DE_RESENA[1] + 200)


class ResponderResena(_Cerrado):
    reply: str = Field(max_length=limites.RESPUESTA_MAXIMA + 200)


class ModerarResena(_Cerrado):
    #: `publish` o `hide`.
    action: str = Field(max_length=20)
    #: Obligatorio al esconder: uno de `posventa.MOTIVOS_DE_MODERACION`.
    reason: str | None = Field(default=None, max_length=40)


# --------------------------------------------------------------------------- #
# Lo que sale: la atención en el detalle de una reserva
# --------------------------------------------------------------------------- #
class AtencionRead(BaseModel):
    status: str
    started_at: datetime | None
    completed_at: datetime | None
    confirmed_at: datetime | None
    closed_at: datetime | None
    closed_by: str | None
    #: LA SEÑAL FUERTE: empezó con el código de quien contrata.
    with_code: bool
    #: Solo para quien contrata, y solo mientras la atención no empezó.
    checkin_code: str | None = None
    #: Solo para el prestador: cuántos intentos le quedan con el código.
    code_attempts_left: int | None = None

    @classmethod
    def desde(cls, a: ServiceAttendance | None, *, rol: str) -> "AtencionRead | None":
        if a is None:
            return None
        return cls(
            status=a.status, started_at=_momento(a.started_at), completed_at=_momento(a.completed_at),
            confirmed_at=_momento(a.confirmed_at), closed_at=_momento(a.closed_at), closed_by=a.closed_by,
            with_code=bool(a.started_with_code),
            checkin_code=a.checkin_code if rol == CLIENTE and a.status == CON_CODIGO else None,
            code_attempts_left=(limites.INTENTOS_DEL_CODIGO - int(a.checkin_attempts or 0))
            if rol == PRESTADOR and a.status == CON_CODIGO else None,
        )


class CancelacionRead(BaseModel):
    #: `client` o `provider`.
    by: str
    reason: str
    note: str | None
    at: datetime
    #: Lo económico de cancelar: hoy, siempre `not_applicable`.
    financial_effect_status: str

    @classmethod
    def desde(cls, e: ServiceBookingEvent | None) -> "CancelacionRead | None":
        if e is None:
            return None
        d = e.details or {}
        return cls(by=e.actor_role, reason=str(d.get("reason") or "other"), note=d.get("note"),
                   at=_utc(e.created_at),
                   financial_effect_status=str(d.get("financial_effect_status") or EFECTO_NO_APLICA))


class CambioDeHorarioRead(BaseModel):
    from_starts_at: datetime
    to_starts_at: datetime
    at: datetime

    @classmethod
    def desde(cls, e: ServiceBookingEvent) -> "CambioDeHorarioRead":
        d = e.details or {}
        return cls(from_starts_at=datetime.fromisoformat(d["from"]["starts_at"]),
                   to_starts_at=datetime.fromisoformat(d["to"]["starts_at"]), at=_utc(e.created_at))


class PlazosRead(BaseModel):
    """Los momentos y los límites, con la política DE ESTA RESERVA (la que se
    congeló al confirmarla; sus valores, provisionales). Es lo que la app
    enseña ANTES de cancelar o de cambiar el horario. La política en sí no
    viaja: solo lo que resulta de ella."""

    cancel_until: datetime
    reschedule_until: datetime
    reschedules_left: int
    checkin_opens_at: datetime
    absence_from: datetime
    incident_until: datetime
    review_until: datetime | None
    appeal_until: datetime | None
    #: Lo económico de cancelar hoy esta reserva. Nunca un importe inventado.
    cancellation_financial_effect: str


class CasoDeLaReservaRead(BaseModel):
    id: str
    status: str
    reason: str
    opened_by_me: bool
    outcome: str | None

    @classmethod
    def desde(cls, caso: ServiceIncident | None, *, usuario_id: str) -> "CasoDeLaReservaRead | None":
        if caso is None:
            return None
        return cls(id=caso.id, status=caso.status, reason=caso.reason,
                   opened_by_me=caso.opened_by == usuario_id, outcome=caso.outcome)


class ResenaRead(BaseModel):
    """Una reseña. `verified` es siempre cierto: la base no guarda una reseña
    sin su atención cerrada. `status` solo viaja en la propia y en moderación.

    NO DICE QUIÉN LA ESCRIBIÓ: la identidad pública de quien reseña es una
    decisión de la empresa todavía pendiente, y la lista es pública (también
    para quien no tiene sesión). Solo moderación lo sabe (`ResenaAdminRead`)."""

    id: str
    rating: int
    fulfillment: int | None
    quality: int | None
    punctuality: int | None
    clarity: int | None
    recommends: bool
    comment: str
    verified: bool = True
    reply: str | None
    replied_at: datetime | None
    created_at: datetime
    status: str | None = None

    @classmethod
    def desde(cls, r: ServiceReview | None, *, con_estado: bool = False) -> "ResenaRead | None":
        if r is None:
            return None
        return cls(
            id=r.id, rating=r.rating,
            **{eje: getattr(r, eje) for eje in EJES_DE_RESENA},
            recommends=bool(r.recommends), comment=r.comment, reply=r.reply, replied_at=_momento(r.replied_at),
            created_at=_utc(r.created_at), status=r.status if con_estado else None,
        )


class CuidadoRead(BaseModel):
    """Todo lo de la atención de una reserva, para quien la mira. LAS ACCIONES
    son las del servidor: la app no ofrece ninguna que no esté aquí."""

    available_actions: list[str]
    #: Los motivos con los que esa parte puede abrir un caso AHORA (vacío si no
    #: puede abrirlo). Pasado el plazo ordinario, solo el de seguridad.
    incident_reasons: list[str]
    attendance: AtencionRead | None
    cancellation: CancelacionRead | None
    reschedules: list[CambioDeHorarioRead]
    deadlines: PlazosRead
    incident: CasoDeLaReservaRead | None
    review: ResenaRead | None

    @classmethod
    def desde(cls, c: dominio.Cuidado, reserva: ServiceBooking, *, usuario_id: str) -> "CuidadoRead":
        p = c.plazos
        return cls(
            available_actions=c.acciones,
            incident_reasons=list(posventa.motivos_para_abrir(c.rol, fuera_de_plazo=c.caso_fuera_de_plazo))
            if dominio.ABRIR_CASO in c.acciones else [],
            attendance=AtencionRead.desde(c.atencion, rol=c.rol),
            cancellation=CancelacionRead.desde(c.cancelacion),
            reschedules=[CambioDeHorarioRead.desde(e) for e in c.cambios],
            deadlines=PlazosRead(
                cancel_until=_utc(reserva.starts_at), reschedule_until=p.reprogramar_hasta,
                reschedules_left=max(0, c.politica.reprogramaciones - c.reprogramaciones),
                checkin_opens_at=p.llegada_desde, absence_from=p.ausencia_desde, incident_until=p.caso_hasta,
                review_until=p.resena_hasta, appeal_until=p.apelar_hasta,
                cancellation_financial_effect=c.efecto,
            ),
            incident=CasoDeLaReservaRead.desde(c.caso, usuario_id=usuario_id),
            # La propia, con su estado; la de un servicio propio, solo si ya se ve.
            review=ResenaRead.desde(c.resena, con_estado=True)
            if c.resena is not None and (c.rol == CLIENTE or c.resena.status == "published") else None,
        )


class CodigoRead(BaseModel):
    checkin_code: str


# --------------------------------------------------------------------------- #
# El expediente
# --------------------------------------------------------------------------- #
class EntradaRead(BaseModel):
    id: str
    #: `message`, `evidence`, `resolution`, `appeal` (y `internal_note`, solo en administración).
    kind: str
    author_role: str
    mine: bool
    body: str | None
    #: De una evidencia: su tipo y su peso. NUNCA su ruta: se mira con un
    #: enlace firmado que se pide aparte y caduca.
    content_type: str | None
    byte_size: int | None
    created_at: datetime

    @classmethod
    def desde(cls, e: ServiceIncidentEntry, *, usuario_id: str) -> "EntradaRead":
        return cls(
            id=e.id, kind=e.kind, author_role=e.author_role, mine=e.author_id == usuario_id, body=e.body,
            content_type=e.content_type if e.kind == EVIDENCIA else None,
            byte_size=e.byte_size if e.kind == EVIDENCIA else None, created_at=_utc(e.created_at),
        )


class ExpedienteRead(BaseModel):
    id: str
    booking_id: str
    status: str
    reason: str
    description: str
    opened_by_me: bool
    created_at: datetime
    #: Lo resuelto (lo vigente): `null` hasta que alguien resuelve.
    outcome: str | None
    attention_effect: str | None
    #: EL DINERO: lo solicitado y su estado. Nunca «ejecutado».
    financial_effect: str | None
    financial_effect_status: str | None
    resolved_at: datetime | None
    appealed_by: str | None
    appealed_at: datetime | None
    appeal_until: datetime | None
    entries: list[EntradaRead]
    available_actions: list[str]

    @classmethod
    def desde(cls, x: posventa.Expediente, *, usuario_id: str) -> "ExpedienteRead":
        caso = x.caso
        plazos = dominio.plazos(x.reserva, None, caso, dominio.politica_de(x.reserva))
        return cls(
            id=caso.id, booking_id=caso.booking_id, status=caso.status, reason=caso.reason,
            description=caso.description, opened_by_me=caso.opened_by == usuario_id,
            created_at=_utc(caso.created_at), outcome=caso.outcome, attention_effect=caso.attention_effect,
            financial_effect=caso.financial_effect, financial_effect_status=caso.financial_effect_status,
            resolved_at=_momento(caso.resolved_at), appealed_by=caso.appealed_by,
            appealed_at=_momento(caso.appealed_at), appeal_until=plazos.apelar_hasta,
            entries=[EntradaRead.desde(e, usuario_id=usuario_id) for e in x.entradas],
            available_actions=x.acciones,
        )


class EnlaceRead(BaseModel):
    url: str
    expires_in: int


# --------------------------------------------------------------------------- #
# Administración
# --------------------------------------------------------------------------- #
class CasoAdminRead(BaseModel):
    """Una línea de la bandeja. Sin nada privado de las partes."""

    id: str
    booking_id: str
    booking_code: str
    title: str
    provider_name: str
    status: str
    reason: str
    created_at: datetime
    outcome: str | None
    financial_effect: str | None
    financial_effect_status: str | None
    resolutions: int

    @classmethod
    def desde(cls, caso: ServiceIncident, reserva: ServiceBooking) -> "CasoAdminRead":
        return cls(
            id=caso.id, booking_id=reserva.id, booking_code=reserva.booking_code, title=reserva.title_snapshot,
            provider_name=reserva.provider_name_snapshot, status=caso.status, reason=caso.reason,
            created_at=_utc(caso.created_at), outcome=caso.outcome, financial_effect=caso.financial_effect,
            financial_effect_status=caso.financial_effect_status, resolutions=int(caso.resolutions),
        )


class PaginaDeCasosRead(BaseModel):
    items: list[CasoAdminRead]
    next_cursor: str | None


class ExpedienteAdminRead(ExpedienteRead):
    booking_code: str
    title: str
    provider_name: str
    starts_at: datetime
    booking_status: str
    resolutions: int
    #: Los efectos en la atención que el servidor aceptaría AHORA a quien
    #: mira. Vacío si no puede resolver. Una atención cerrada no se desmiente.
    attention_effects: list[str]

    @classmethod
    def del_expediente(cls, x: posventa.Expediente, *, usuario_id: str) -> "ExpedienteAdminRead":
        base = ExpedienteRead.desde(x, usuario_id=usuario_id)
        r = x.reserva
        return cls(**base.model_dump(), booking_code=r.booking_code, title=r.title_snapshot,
                   provider_name=r.provider_name_snapshot, starts_at=_utc(r.starts_at), booking_status=r.status,
                   resolutions=int(x.caso.resolutions), attention_effects=x.efectos)


class ResenaAdminRead(ResenaRead):
    booking_id: str
    service_id: str
    #: Solo aquí: quién la escribió (`null` si su cuenta ya no existe).
    author_id: str | None

    @classmethod
    def de_moderacion(cls, r: ServiceReview) -> "ResenaAdminRead":
        base = ResenaRead.desde(r, con_estado=True)
        return cls(**base.model_dump(), booking_id=r.booking_id, service_id=r.service_id, author_id=r.author_id)


class PaginaDeResenasAdminRead(BaseModel):
    items: list[ResenaAdminRead]
    next_cursor: str | None


class ResumenDeResenasRead(BaseModel):
    """`average` es `null` cuando no hay reseñas. NO es cero."""

    total: int
    average: float | None
    #: En puntos básicos; `null` si no hay ninguna.
    recommend_bps: int | None
    by_axis: dict[str, float | None]


class PaginaDeResenasRead(BaseModel):
    #: Falso si las reseñas todavía no están disponibles (sin la 0094 o con la
    #: contratación apagada): la ficha no enseña la sección.
    available: bool
    items: list[ResenaRead]
    next_cursor: str | None
    summary: ResumenDeResenasRead | None


class TareasRead(BaseModel):
    reminded: int
    closed: int
    #: Terminadas sin la señal fuerte y con el plazo vencido: NO se cierran solas.
    unverified: int
    skipped: int


__all__ = [
    "AbrirCaso",
    "AtencionRead",
    "CancelarReserva",
    "CasoAdminRead",
    "CodigoRead",
    "CrearResena",
    "CuidadoRead",
    "EnlaceRead",
    "EntradaRead",
    "EscribirDesdeAdministracion",
    "EscribirEnElCaso",
    "ExpedienteAdminRead",
    "ExpedienteRead",
    "IniciarAtencion",
    "ModerarResena",
    "PaginaDeCasosRead",
    "PaginaDeResenasAdminRead",
    "PaginaDeResenasRead",
    "ReprogramarReserva",
    "ResenaAdminRead",
    "ResenaRead",
    "ResolverCaso",
    "ResponderResena",
    "ResumenDeResenasRead",
    "TareasRead",
]
