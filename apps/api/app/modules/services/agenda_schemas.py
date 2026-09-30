"""Los contratos de la agenda de Servicios (Incremento 4).

DOS VISTAS, Y NO SE MEZCLAN:

    del prestador   su agenda entera: configuración, semana, excepciones,
                    bloqueos CON su motivo privado, lo que falta para que el
                    público vea horarios y los límites que la gobiernan.
    pública         solo horarios: fechas con cuántos hay y, para una fecha,
                    cada inicio y fin. Ni reglas, ni bloqueos, ni motivos, ni
                    identificadores de nada que no sea el servicio.

LAS FECHAS VIAJAN SIN AMBIGÜEDAD: cada horario lleva su instante UTC
(`starts_at`, `ends_at`) y, calculadas por el servidor en la zona de la agenda,
la fecha y la hora locales y su desplazamiento. Las franjas se escriben
«HH:MM» (hasta «24:00» como fin) y las fechas, «AAAA-MM-DD», siempre en la
zona de la agenda.

LAS ENTRADAS PROHÍBEN CAMPOS DESCONOCIDOS.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.modules.services import agenda as dominio
from app.modules.services import agenda_calculo as calc
from app.modules.services import agenda_politica as limites
from app.modules.services.agenda_models import (
    ServiceScheduleBlock,
    ServiceScheduleException,
    ServiceScheduleRule,
)
from app.modules.services.catalogo_schemas import Modalidad

EstadoDeLaAgenda = Literal["active", "paused"]
TipoDeExcepcion = Literal["closed", "extra", "replace"]


class _Entrada(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    def cambios(self) -> dict:
        """Solo lo que llegó (un campo ausente no se toca)."""
        return {c: getattr(self, c) for c in self.model_fields_set}


# --------------------------------------------------------------------------- #
# Entradas
# --------------------------------------------------------------------------- #
class AgendaConfigurar(_Entrada):
    """La configuración ENTERA: lo que no llega vuelve a su valor de fábrica."""

    timezone: str = Field(min_length=3, max_length=limites.ZONA_MAXIMA)
    status: EstadoDeLaAgenda = "active"
    buffer_before_minutes: int = Field(default=0, ge=0, le=limites.SEPARACION_MAXIMA)
    buffer_after_minutes: int = Field(default=0, ge=0, le=limites.SEPARACION_MAXIMA)
    slot_interval_minutes: int | None = Field(
        default=None, ge=limites.INTERVALO_MINIMO, le=limites.INTERVALO_MAXIMO
    )
    #: Cambiar la zona de una agenda con semana o excepciones lo exige.
    confirm_timezone_change: bool = False


class ReglaCrear(_Entrada):
    weekday: int = Field(ge=1, le=7)
    start: str = Field(max_length=5)
    end: str = Field(max_length=5)
    modality: Modalidad
    capacity: int = Field(default=1, ge=1, le=limites.CAPACIDAD_MAXIMA)
    active: bool = True


class ReglaEditar(_Entrada):
    weekday: int | None = Field(default=None, ge=1, le=7)
    start: str | None = Field(default=None, max_length=5)
    end: str | None = Field(default=None, max_length=5)
    modality: Modalidad | None = None
    capacity: int | None = Field(default=None, ge=1, le=limites.CAPACIDAD_MAXIMA)
    active: bool | None = None


class ExcepcionCrear(_Entrada):
    date: str = Field(max_length=10)
    kind: TipoDeExcepcion
    #: Sin franja, `closed` cierra el día entero.
    start: str | None = Field(default=None, max_length=5)
    end: str | None = Field(default=None, max_length=5)
    modality: Modalidad | None = None
    capacity: int | None = Field(default=None, ge=1, le=limites.CAPACIDAD_MAXIMA)


class ExcepcionEditar(_Entrada):
    date: str | None = Field(default=None, max_length=10)
    kind: TipoDeExcepcion | None = None
    start: str | None = Field(default=None, max_length=5)
    end: str | None = Field(default=None, max_length=5)
    modality: Modalidad | None = None
    capacity: int | None = Field(default=None, ge=1, le=limites.CAPACIDAD_MAXIMA)


class BloqueoCrear(_Entrada):
    """Fecha y hora LOCALES de la agenda; el servidor las convierte."""

    start_date: str = Field(max_length=10)
    start_time: str = Field(max_length=5)
    end_date: str = Field(max_length=10)
    end_time: str = Field(max_length=5)
    #: PRIVADO: solo lo verá el prestador.
    reason: str | None = Field(default=None, max_length=limites.MOTIVO_MAXIMO)


# --------------------------------------------------------------------------- #
# Salidas
# --------------------------------------------------------------------------- #
class HorarioRead(BaseModel):
    """Un horario POSIBLE. No está apartado para nadie."""

    starts_at: datetime
    ends_at: datetime
    #: La fecha y las horas LOCALES de la agenda, y su desplazamiento: en la
    #: noche en que se atrasa el reloj, dos horarios pueden decir «01:30».
    date: date
    time: str
    end_time: str
    utc_offset: str
    #: Capacidad TEÓRICA (personas por horario). Aún no se descuenta nada.
    capacity: int

    @classmethod
    def desde(cls, h: calc.Horario, zona: str) -> "HorarioRead":
        z = calc.zona(zona)
        inicio, fin = calc.reloj(h.inicio, z), calc.reloj(h.fin, z)
        return cls(
            starts_at=h.inicio,
            ends_at=h.fin,
            date=h.fecha,
            time=inicio.strftime("%H:%M"),
            end_time=fin.strftime("%H:%M"),
            utc_offset=calc.desplazamiento(inicio),
            capacity=h.capacidad,
        )


class ReglaRead(BaseModel):
    id: str
    weekday: int
    start: str
    end: str
    modality: str
    capacity: int
    active: bool

    @classmethod
    def desde(cls, r: ServiceScheduleRule) -> "ReglaRead":
        return cls(
            id=r.id, weekday=r.weekday, start=calc.hora(r.start_minute), end=calc.hora(r.end_minute),
            modality=r.modality, capacity=r.capacity, active=r.active,
        )


class ExcepcionRead(BaseModel):
    id: str
    date: date
    kind: str
    start: str | None
    end: str | None
    modality: str | None
    capacity: int | None

    @classmethod
    def desde(cls, e: ServiceScheduleException) -> "ExcepcionRead":
        return cls(
            id=e.id, date=e.on_date, kind=e.kind,
            start=calc.hora(e.start_minute) if e.start_minute is not None else None,
            end=calc.hora(e.end_minute) if e.end_minute is not None else None,
            modality=e.modality, capacity=e.capacity,
        )


class BloqueoRead(BaseModel):
    """SOLO EN LA AGENDA DEL PRESTADOR: lleva el motivo privado."""

    id: str
    starts_at: datetime
    ends_at: datetime
    start_date: date
    start_time: str
    end_date: date
    end_time: str
    reason: str | None

    @classmethod
    def desde(cls, b: ServiceScheduleBlock, zona: str) -> "BloqueoRead":
        z = calc.zona(zona)
        inicio = calc.reloj(dominio._utc(b.starts_at), z)
        fin = calc.reloj(dominio._utc(b.ends_at), z)
        return cls(
            id=b.id, starts_at=inicio, ends_at=fin,
            start_date=inicio.date(), start_time=inicio.strftime("%H:%M"),
            end_date=fin.date(), end_time=fin.strftime("%H:%M"),
            reason=b.reason,
        )


class ServicioDeLaAgendaRead(BaseModel):
    """Lo que la agenda toma del servicio. La duración, la modalidad y la
    capacidad son de la versión publicada (o, sin ella, de la que se prepara)."""

    status: str
    title: str | None
    modality: str | None
    duration_minutes: int | None
    capacity: int
    #: Las modalidades en que se puede preparar una franja.
    offered_modalities: list[str]
    publicly_visible: bool


class LimitesDeLaAgendaRead(BaseModel):
    """Los límites que aplica el servidor, para que la app no los invente."""

    notice_minutes: int
    horizon_days: int
    grid_minutes: int = limites.REJILLA_MINUTOS
    max_buffer_minutes: int = limites.SEPARACION_MAXIMA
    min_interval_minutes: int = limites.INTERVALO_MINIMO
    max_interval_minutes: int = limites.INTERVALO_MAXIMO
    max_rules: int = limites.REGLAS_MAXIMAS
    max_exceptions: int = limites.EXCEPCIONES_MAXIMAS
    max_blocks: int = limites.BLOQUEOS_MAXIMOS
    max_block_days: int = limites.BLOQUEO_MAXIMO_DIAS
    max_advance_days: int = limites.ADELANTO_MAXIMO_DIAS
    reason_max_length: int = limites.MOTIVO_MAXIMO


class AgendaPrivadaRead(BaseModel):
    service_id: str
    configured: bool
    timezone: str | None
    status: str | None
    buffer_before_minutes: int
    buffer_after_minutes: int
    slot_interval_minutes: int | None
    #: «Hoy» en la zona de la agenda.
    today: date | None
    rules: list[ReglaRead]
    #: Las de hoy en adelante.
    exceptions: list[ExcepcionRead]
    #: Los que todavía no terminaron.
    blocks: list[BloqueoRead]
    service: ServicioDeLaAgendaRead
    #: El primer horario que vería una persona (con la versión publicada o,
    #: sin ella, la que se prepara).
    next_available: HorarioRead | None
    #: Por qué el público todavía no ve horarios (vacío si ya los ve).
    issues: list[str]
    can_edit: bool
    limits: LimitesDeLaAgendaRead

    @classmethod
    def desde(cls, a: dominio.AgendaPrivada) -> "AgendaPrivadaRead":
        agenda = a.agenda
        referencia = a.hechos.referencia
        zona = agenda.timezone if agenda is not None else None
        return cls(
            service_id=a.servicio.id,
            configured=agenda is not None,
            timezone=zona,
            status=agenda.status if agenda is not None else None,
            buffer_before_minutes=agenda.buffer_before_minutes if agenda is not None else 0,
            buffer_after_minutes=agenda.buffer_after_minutes if agenda is not None else 0,
            slot_interval_minutes=agenda.slot_interval_minutes if agenda is not None else None,
            today=a.hoy,
            rules=[ReglaRead.desde(r) for r in a.reglas],
            exceptions=[ExcepcionRead.desde(e) for e in a.excepciones],
            blocks=[BloqueoRead.desde(b, zona) for b in a.bloqueos] if zona else [],
            service=ServicioDeLaAgendaRead(
                status=a.servicio.status,
                title=referencia.title if referencia else None,
                modality=referencia.modality if referencia else None,
                duration_minutes=referencia.duration_minutes if referencia else None,
                capacity=a.hechos.capacidad_maxima,
                offered_modalities=a.hechos.ofrecidas,
                publicly_visible=a.publico,
            ),
            next_available=HorarioRead.desde(a.proximo, zona) if a.proximo and zona else None,
            issues=a.motivos,
            can_edit=a.puede_editar,
            limits=LimitesDeLaAgendaRead(
                notice_minutes=a.politica.antelacion_minutos, horizon_days=a.politica.horizonte_dias
            ),
        )


class DiaRead(BaseModel):
    date: date
    #: Cuántos horarios POSIBLES tiene. No es un «quedan».
    count: int


class CalendarioRead(BaseModel):
    """Las fechas con horarios de un rango. `status`: `active`, `paused` o
    `not_configured`; sin agenda activa, `days` va vacío."""

    timezone: str | None
    status: str
    modality: str | None
    duration_minutes: int | None
    today: date | None
    last_date: date | None
    from_date: date | None
    to_date: date | None
    days: list[DiaRead]
    next: HorarioRead | None
    #: Solo en la vista previa del prestador: por qué el público no ve horarios.
    issues: list[str] = []

    @classmethod
    def desde(cls, c: dominio.Calendario, *, con_motivos: bool) -> "CalendarioRead":
        return cls(
            timezone=c.zona, status=c.estado, modality=c.modalidad, duration_minutes=c.duracion,
            today=c.hoy, last_date=c.ultima, from_date=c.desde, to_date=c.hasta,
            days=[DiaRead(date=f, count=n) for f, n in c.dias],
            next=HorarioRead.desde(c.proximo, c.zona) if c.proximo and c.zona else None,
            issues=c.motivos if con_motivos else [],
        )


class PaginaDeHorariosRead(BaseModel):
    timezone: str | None
    status: str
    date: date
    modality: str | None
    duration_minutes: int | None
    items: list[HorarioRead]
    next_cursor: str | None

    @classmethod
    def desde(cls, p: dominio.PaginaDeHorarios) -> "PaginaDeHorariosRead":
        return cls(
            timezone=p.zona, status=p.estado, date=p.fecha, modality=p.modalidad, duration_minutes=p.duracion,
            items=[HorarioRead.desde(h, p.zona) for h in p.horarios] if p.zona else [],
            next_cursor=p.siguiente,
        )


__all__ = [
    "AgendaConfigurar",
    "AgendaPrivadaRead",
    "BloqueoCrear",
    "BloqueoRead",
    "CalendarioRead",
    "DiaRead",
    "ExcepcionCrear",
    "ExcepcionEditar",
    "ExcepcionRead",
    "HorarioRead",
    "PaginaDeHorariosRead",
    "ReglaCrear",
    "ReglaEditar",
    "ReglaRead",
]
