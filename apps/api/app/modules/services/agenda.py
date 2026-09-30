"""LA AGENDA DEL PRESTADOR (Incremento 4): configurarla y consultar horarios.

QUIÉN: el dueño del servicio, con prestador ACTIVO, sobre un servicio que no
esté retirado. Un borrador también prepara su agenda; el público no la ve
hasta que el servicio sea público (`descubrimiento.condiciones_publicas`). Lo
ajeno es el mismo 404 que lo que no existe.

CADA ESCRITURA, en una transacción y en este orden (como `catalogo.py`):

  1. BLOQUEA LA FILA DEL SERVICIO. Dos cambios de agenda, o un cambio y una
     retirada del servicio, no se cruzan: el segundo espera y entra viendo lo
     que dejó el primero.
  2. REPETICIÓN: si la misma `Idempotency-Key` ya dejó su evento, devuelve la
     agenda sin escribir nada.
  3. VALIDA lo que depende del servicio o de «hoy» (la modalidad que ofrece,
     su capacidad, que la fecha no haya pasado, cuántas caben).
  4. ESCRIBE la fila y su evento del historial. LOS CRUCES LOS IMPIDE LA BASE
     (restricciones de exclusión de la 0092): aquí solo se traduce su error a
     un 409 estable. No hay otra comprobación que pueda desalinearse con ella.

EL MOTIVO DE UN BLOQUEO ES PRIVADO: sale solo en la agenda del propio
prestador. Nunca en lo público, en el historial ni en un error.

NINGUNA FUNCIÓN DE AQUÍ CREA UNA RESERVA, UNA RETENCIÓN NI UN MOVIMIENTO DE
DINERO: el incremento termina al enseñar un horario.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError, ValidationAppError
from app.modules.services import agenda_calculo as calc
from app.modules.services import agenda_politica as limites
from app.modules.services import catalogo
from app.modules.services import catalogo_estados as estados
from app.modules.services import descubrimiento, esquema
from app.modules.services.admision import ClaveReutilizada
from app.modules.services.agenda_models import (
    AGENDA_ACTIVA,
    AGENDA_EN_PAUSA,
    CERRADA,
    ESTADOS_DE_LA_AGENDA,
    ServiceSchedule,
    ServiceScheduleBlock,
    ServiceScheduleEvent,
    ServiceScheduleException,
    ServiceScheduleRule,
)
from app.modules.services.catalogo_models import Service, ServiceVersion
from app.modules.services.models import PRESTADOR_ACTIVO, ServiceProvider
from app.modules.services.service import CursorInvalido
from app.modules.services.states import PRESTADOR

# --------------------------------------------------------------------------- #
# Errores (códigos estables)
# --------------------------------------------------------------------------- #
class AgendaInexistente(ConflictError):
    code = "service_schedule_missing"
    message = "Este servicio todavía no tiene agenda. Elige primero su zona horaria."


class ZonaInvalida(ValidationAppError):
    code = "service_schedule_timezone_invalid"
    message = "Esa zona horaria no existe. Usa una como «America/Lima»."


class CambioDeZonaSinConfirmar(ConflictError):
    code = "service_schedule_timezone_unconfirmed"
    message = "Cambiar la zona mueve tus horarios semanales y tus excepciones. Confírmalo."


class AjustesInvalidos(ValidationAppError):
    code = "service_schedule_settings_invalid"
    message = "La preparación, el descanso y el intervalo van de 5 en 5 minutos."


class HoraInvalida(ValidationAppError):
    code = "service_schedule_time_invalid"
    message = "La franja no es válida: el inicio va antes del fin, de 5 en 5 minutos."


class ExcepcionInvalida(ValidationAppError):
    code = "service_schedule_exception_invalid"
    message = "Esa excepción no es coherente con su tipo."


class ModalidadNoOfrecida(ValidationAppError):
    code = "service_schedule_modality_invalid"
    message = "El servicio no se ofrece en esa modalidad."


class CapacidadInvalida(ValidationAppError):
    code = "service_schedule_capacity_invalid"
    message = "La capacidad va de 1 a la que admite el servicio."


class Cruce(ConflictError):
    code = "service_schedule_overlap"
    message = "Esa franja se cruza con otra que ya tienes ese día."


class FechaInvalida(ValidationAppError):
    code = "service_schedule_date_invalid"
    message = "Esa fecha ya pasó, está demasiado lejos o esa hora no existe ese día."


class BloqueoInvalido(ValidationAppError):
    code = "service_schedule_block_invalid"
    message = "El bloqueo no es válido: el fin va después del inicio y aún no pasó."


class LimiteAlcanzado(ConflictError):
    code = "service_schedule_limit_reached"
    message = "Llegaste al máximo que admite la agenda."


class ElementoNoEncontrado(NotFoundError):
    code = "service_schedule_item_not_found"
    message = "No encontramos ese elemento de la agenda."


class BloqueoEnUso(ConflictError):
    """Para el Incremento 5: hoy no hay contrataciones que un bloqueo proteja."""

    code = "service_schedule_block_in_use"
    message = "Ese bloqueo protege una contratación futura."


class RangoInvalido(ValidationAppError):
    code = "service_availability_range_invalid"
    message = "Ese rango de fechas no es válido."


class FueraDelHorizonte(ValidationAppError):
    code = "service_availability_out_of_horizon"
    message = "Esa fecha está fuera de las que se pueden consultar."


class ModalidadNoDisponible(ValidationAppError):
    code = "service_availability_modality_invalid"
    message = "Este servicio no se ofrece en esa modalidad."


# --------------------------------------------------------------------------- #
# Lo que dice el servicio
# --------------------------------------------------------------------------- #
@dataclass
class Hechos:
    """Las dos versiones que importan: la PUBLICADA (la que ve el público) y
    la ABIERTA (la que el prestador prepara)."""

    publicada: ServiceVersion | None
    abierta: ServiceVersion | None

    @property
    def referencia(self) -> ServiceVersion | None:
        """La que manda en la vista previa: la publicada, si no la abierta."""
        return self.publicada or self.abierta

    @property
    def ofrecidas(self) -> list[str]:
        """Las modalidades que se pueden preparar: la publicada y la que viene."""
        return sorted({v.modality for v in (self.publicada, self.abierta) if v is not None and v.modality})

    @property
    def capacidad_maxima(self) -> int:
        """UNO si es individual. Si el servicio atiende a varios, lo que dice."""
        return max([v.capacity or 1 for v in (self.publicada, self.abierta) if v is not None] or [1])


async def hechos_de(db: AsyncSession, servicio_id: str) -> Hechos:
    return Hechos(await catalogo.publicada(db, servicio_id), await catalogo.abierta(db, servicio_id))


def _servicio_de(version: ServiceVersion | None) -> calc.Servicio | None:
    if version is None or not version.duration_minutes or not version.modality:
        return None
    return calc.Servicio(
        duracion=int(version.duration_minutes), modalidad=version.modality, capacidad=int(version.capacity or 1)
    )


# --------------------------------------------------------------------------- #
# Lecturas y cerrojos
# --------------------------------------------------------------------------- #
def _ahora() -> datetime:
    return datetime.now(timezone.utc)


def _utc(momento: datetime) -> datetime:
    """SQLite devuelve instantes sin zona; PostgreSQL, con ella."""
    return momento if momento.tzinfo else momento.replace(tzinfo=timezone.utc)


async def agenda_de(db: AsyncSession, servicio_id: str) -> ServiceSchedule | None:
    return await db.scalar(
        select(ServiceSchedule)
        .where(ServiceSchedule.service_id == servicio_id)
        .execution_options(populate_existing=True)
    )


async def _para_escribir(db: AsyncSession, usuario_id: str, servicio_id: str) -> Service:
    """El servicio PROPIO y BLOQUEADO, de un prestador activo y no retirado."""
    servicio, prestador = await catalogo.mio(db, usuario_id, servicio_id)
    catalogo.exigir_activo(prestador)
    if servicio.status == estados.SERVICIO_RETIRADO:
        raise catalogo.ServicioRetirado()
    return servicio


async def _exigir_agenda(db: AsyncSession, servicio_id: str) -> ServiceSchedule:
    agenda = await agenda_de(db, servicio_id)
    if agenda is None:
        raise AgendaInexistente()
    return agenda


def _zona_de(agenda: ServiceSchedule):
    z = calc.zona(agenda.timezone)
    if z is None:  # pragma: no cover - la base no deja guardar otra
        raise ZonaInvalida()
    return z


async def _reglas(db: AsyncSession, servicio_id: str) -> list[ServiceScheduleRule]:
    return list(
        await db.scalars(
            select(ServiceScheduleRule)
            .where(ServiceScheduleRule.service_id == servicio_id)
            .order_by(ServiceScheduleRule.weekday, ServiceScheduleRule.start_minute, ServiceScheduleRule.id)
        )
    )


async def _excepciones(
    db: AsyncSession, servicio_id: str, desde: date, hasta: date | None = None
) -> list[ServiceScheduleException]:
    consulta = select(ServiceScheduleException).where(
        ServiceScheduleException.service_id == servicio_id, ServiceScheduleException.on_date >= desde
    )
    if hasta is not None:
        consulta = consulta.where(ServiceScheduleException.on_date <= hasta)
    return list(
        await db.scalars(
            consulta.order_by(
                ServiceScheduleException.on_date,
                ServiceScheduleException.start_minute.nulls_first(),
                ServiceScheduleException.id,
            )
        )
    )


async def _bloqueos(
    db: AsyncSession, servicio_id: str, desde: datetime, hasta: datetime | None = None
) -> list[ServiceScheduleBlock]:
    consulta = select(ServiceScheduleBlock).where(
        ServiceScheduleBlock.service_id == servicio_id, ServiceScheduleBlock.ends_at > desde
    )
    if hasta is not None:
        consulta = consulta.where(ServiceScheduleBlock.starts_at < hasta)
    return list(
        await db.scalars(consulta.order_by(ServiceScheduleBlock.starts_at, ServiceScheduleBlock.id))
    )


async def ocupaciones(
    db: AsyncSession, servicio_id: str, *, ahora: datetime, excepto: str | None = None
) -> tuple[calc.Ocupacion, ...]:
    """LO YA OCUPADO (Incremento 5): cada retención VIVA y cada reserva, por
    venir. Una retención `active` cuyo vencimiento ya pasó NO ocupa aunque el
    barrido no haya pasado: el vencimiento lo decide la hora, no la limpieza.
    Sin la 0093 no hay nada que ocupe. `excepto` es la retención propia
    (al confirmar, la que se revalida no se cuenta contra sí misma)."""
    if not await esquema.hay_reservas(db):
        return ()
    from app.modules.services.reserva_models import OCUPAN, RETENCION_CONSUMIDA, ServiceHold

    consulta = select(ServiceHold.starts_at, ServiceHold.occupied_from, ServiceHold.occupied_until).where(
        ServiceHold.service_id == servicio_id,
        ServiceHold.status.in_(OCUPAN),
        ServiceHold.occupied_until > ahora,
        or_(ServiceHold.status == RETENCION_CONSUMIDA, ServiceHold.expires_at > ahora),
    )
    if excepto is not None:
        consulta = consulta.where(ServiceHold.id != excepto)
    filas = (await db.execute(consulta.order_by(ServiceHold.starts_at, ServiceHold.id))).all()
    return tuple(calc.Ocupacion(_utc(s), _utc(d), _utc(h)) for s, d, h in filas)


async def _datos(
    db: AsyncSession,
    agenda: ServiceSchedule,
    servicio: calc.Servicio,
    *,
    ahora: datetime,
    politica: limites.Politica,
    excepto: str | None = None,
) -> calc.Datos:
    """Todo lo que el cálculo necesita desde HOY hasta el HORIZONTE, en
    cuatro lecturas acotadas (la cuarta, lo ya ocupado)."""
    z = _zona_de(agenda)
    hoy = calc.hoy(z, ahora)
    ultima = calc.ultima_fecha(z, ahora, politica)
    reglas = await _reglas(db, agenda.service_id)
    excepciones = await _excepciones(db, agenda.service_id, hoy, ultima)
    bloqueos = await _bloqueos(db, agenda.service_id, ahora, calc.ventana(ahora, politica)[1] + timedelta(days=1))
    return calc.Datos(
        configuracion=calc.Configuracion(
            zona=z,
            preparacion=agenda.buffer_before_minutes,
            descanso=agenda.buffer_after_minutes,
            intervalo=agenda.slot_interval_minutes,
        ),
        servicio=servicio,
        reglas=tuple(
            calc.Regla(r.weekday, r.start_minute, r.end_minute, r.modality, r.capacity, r.active) for r in reglas
        ),
        excepciones=tuple(
            calc.Excepcion(e.on_date, e.kind, e.start_minute, e.end_minute, e.modality, e.capacity)
            for e in excepciones
        ),
        bloqueos=tuple(calc.Bloqueo(_utc(b.starts_at), _utc(b.ends_at)) for b in bloqueos),
        ocupaciones=await ocupaciones(db, agenda.service_id, ahora=ahora, excepto=excepto),
    )


# --------------------------------------------------------------------------- #
# Historial
# --------------------------------------------------------------------------- #
async def _por_clave(
    db: AsyncSession, servicio_id: str, clave: str | None, accion: str
) -> ServiceScheduleEvent | None:
    """El evento que ya dejó ESTA clave. Usada para OTRA acción es un error."""
    if not clave:
        return None
    previo = await db.scalar(
        select(ServiceScheduleEvent).where(
            ServiceScheduleEvent.service_id == servicio_id, ServiceScheduleEvent.idempotency_key == clave
        )
    )
    if previo is not None and previo.action != accion:
        raise ClaveReutilizada(details={"action": previo.action})
    return previo


async def _registrar(
    db: AsyncSession,
    *,
    servicio_id: str,
    accion: str,
    usuario_id: str,
    detalles: dict,
    clave: str | None = None,
    ahora: datetime,
) -> None:
    """Una línea del historial. NUNCA el motivo de un bloqueo."""
    assert "reason" not in detalles, "el motivo de un bloqueo no va al historial"
    db.add(
        ServiceScheduleEvent(
            service_id=servicio_id,
            action=accion,
            actor_id=usuario_id,
            actor_role=PRESTADOR,
            details=detalles,
            idempotency_key=clave,
            created_at=ahora,
        )
    )
    await db.flush()


def _lo_mismo(previo: ServiceScheduleEvent, esperado: dict) -> None:
    """Repetir con la misma `Idempotency-Key` es repetir LO MISMO. Con otro
    contenido es otra alta que llega con una clave ya usada: 409, y no un 200
    que haría creer que se guardó. Se compara con lo que dejó el historial,
    sin los identificadores."""
    guardado = {k: v for k, v in (previo.details or {}).items() if not k.endswith("_id")}
    if guardado != esperado:
        raise ClaveReutilizada(details={"action": previo.action})


def _estado_sql(error: IntegrityError) -> str | None:
    """El SQLSTATE del error de la base, venga del controlador que venga."""
    for causa in (error.orig, getattr(error.orig, "__cause__", None)):
        estado = getattr(causa, "sqlstate", None) or getattr(causa, "pgcode", None)
        if estado:
            return estado
    return None


def _cruce(error: IntegrityError) -> bool:
    """¿Lo rechazó una restricción de exclusión (23P01)? Solo eso es un cruce."""
    return _estado_sql(error) == "23P01"


async def _con_zona_de_la_base(db: AsyncSession, fila: ServiceSchedule) -> None:
    """Guarda la configuración. La zona la validó `calc.zona` (tzdata); el
    disparador de la 0092 la valida contra la base de zonas de PostgreSQL. Si
    las dos bases no coinciden (una zona recién creada en una y no en la
    otra), es un 422, nunca un 500: el disparador es el único que responde
    `check_violation` SIN nombre de restricción."""
    try:
        async with db.begin_nested():
            db.add(fila)
            await db.flush()
    except IntegrityError as error:
        sin_nombre = not any(
            getattr(causa, "constraint_name", None) for causa in (error.orig, getattr(error.orig, "__cause__", None))
        )
        if _estado_sql(error) == "23514" and sin_nombre:
            raise ZonaInvalida() from None
        raise


async def _guardar(db: AsyncSession, fila) -> None:  # noqa: ANN001
    """Añade o actualiza `fila`. Un cruce que la base rechaza es un 409."""
    try:
        async with db.begin_nested():
            db.add(fila)
            await db.flush()
    except IntegrityError as error:
        if _cruce(error):
            raise Cruce() from None
        raise


# --------------------------------------------------------------------------- #
# Validaciones que no son de forma
# --------------------------------------------------------------------------- #
def _franja(inicio: str | None, fin: str | None) -> tuple[int, int]:
    a = calc.minuto_de(inicio, admite_24=False)
    b = calc.minuto_de(fin, admite_24=True)
    if a is None or b is None or a >= b:
        raise HoraInvalida()
    return a, b


def _modalidad(modalidad: str | None, hechos: Hechos) -> str:
    if modalidad not in hechos.ofrecidas:
        raise ModalidadNoOfrecida(details={"offered": hechos.ofrecidas})
    return modalidad  # type: ignore[return-value]


def _capacidad(capacidad: int | None, hechos: Hechos) -> int:
    valor = 1 if capacidad is None else capacidad
    if not 1 <= valor <= min(hechos.capacidad_maxima, limites.CAPACIDAD_MAXIMA):
        raise CapacidadInvalida(details={"max": hechos.capacidad_maxima})
    return valor


def _fecha(texto: str | None, error: type[Exception] = FechaInvalida) -> date:
    if not isinstance(texto, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", texto):
        raise error()
    try:
        return date.fromisoformat(texto)
    except ValueError:
        raise error() from None


def _fecha_futura(fecha: date, hoy: date) -> date:
    if fecha < hoy or fecha > hoy + timedelta(days=limites.ADELANTO_MAXIMO_DIAS):
        raise FechaInvalida()
    return fecha


def _separacion(valor: int) -> int:
    if not 0 <= valor <= limites.SEPARACION_MAXIMA or valor % limites.REJILLA_MINUTOS:
        raise AjustesInvalidos()
    return valor


def _intervalo(valor: int | None) -> int | None:
    if valor is None:
        return None
    if not limites.INTERVALO_MINIMO <= valor <= limites.INTERVALO_MAXIMO or valor % limites.REJILLA_MINUTOS:
        raise AjustesInvalidos()
    return valor


# --------------------------------------------------------------------------- #
# La agenda del prestador (lectura)
# --------------------------------------------------------------------------- #
@dataclass
class AgendaPrivada:
    servicio: Service
    hechos: Hechos
    agenda: ServiceSchedule | None
    reglas: list[ServiceScheduleRule] = field(default_factory=list)
    excepciones: list[ServiceScheduleException] = field(default_factory=list)
    bloqueos: list[ServiceScheduleBlock] = field(default_factory=list)
    hoy: date | None = None
    proximo: calc.Horario | None = None
    motivos: list[str] = field(default_factory=list)
    puede_editar: bool = False
    publico: bool = False
    politica: limites.Politica = field(default_factory=limites.Politica.de)


async def _es_publico(db: AsyncSession, servicio_id: str) -> bool:
    try:
        await descubrimiento.publico(db, servicio_id)
    except descubrimiento.ServicioNoPublico:
        return False
    return True


async def leer(db: AsyncSession, *, usuario_id: str, servicio_id: str, ahora: datetime | None = None) -> AgendaPrivada:
    """La agenda PROPIA, con lo que falta para que el público vea horarios."""
    servicio, prestador = await catalogo.mio(db, usuario_id, servicio_id, bloquear_fila=False)
    await db.refresh(servicio)
    return await _privada(db, servicio, prestador, ahora=ahora or _ahora())


async def _privada(
    db: AsyncSession, servicio: Service, prestador: ServiceProvider, *, ahora: datetime
) -> AgendaPrivada:
    politica = limites.Politica.de()
    hechos = await hechos_de(db, servicio.id)
    agenda = await agenda_de(db, servicio.id)
    salida = AgendaPrivada(
        servicio=servicio,
        hechos=hechos,
        agenda=agenda,
        puede_editar=prestador.status == PRESTADOR_ACTIVO and servicio.status != estados.SERVICIO_RETIRADO,
        publico=await _es_publico(db, servicio.id),
        politica=politica,
    )
    if not salida.publico:
        salida.motivos.append("service_not_public")
    if agenda is None:
        salida.motivos.append("schedule_missing")
        return salida
    z = _zona_de(agenda)
    salida.hoy = calc.hoy(z, ahora)
    salida.reglas = await _reglas(db, servicio.id)
    salida.excepciones = await _excepciones(db, servicio.id, salida.hoy)
    salida.bloqueos = await _bloqueos(db, servicio.id, ahora)
    if agenda.status == AGENDA_EN_PAUSA:
        # En pausa nadie ve horarios: no hay «próximo» que enseñar.
        salida.motivos.append("schedule_paused")
        return salida
    referencia = _servicio_de(hechos.referencia)
    if referencia is None:
        salida.motivos.append("service_incomplete")
        return salida
    salida.proximo = calc.proximo(
        await _datos(db, agenda, referencia, ahora=ahora, politica=politica),
        modalidad=referencia.modalidad, ahora=ahora, politica=politica,
    )
    if salida.proximo is None:
        salida.motivos.append("no_availability")
    return salida


# --------------------------------------------------------------------------- #
# Escrituras
# --------------------------------------------------------------------------- #
@dataclass
class Escrito:
    creado: bool
    repetido: bool = False


async def configurar(
    db: AsyncSession,
    *,
    usuario_id: str,
    servicio_id: str,
    zona: str,
    estado: str,
    preparacion: int,
    descanso: int,
    intervalo: int | None,
    confirmar_zona: bool,
    ahora: datetime | None = None,
) -> Escrito:
    """Crea la agenda o la sustituye entera. Repetirla igual no escribe nada."""
    ahora = ahora or _ahora()
    servicio = await _para_escribir(db, usuario_id, servicio_id)
    if calc.zona(zona) is None:
        raise ZonaInvalida()
    if estado not in ESTADOS_DE_LA_AGENDA:
        raise AjustesInvalidos()
    nuevo = {
        "timezone": zona,
        "status": estado,
        "buffer_before_minutes": _separacion(preparacion),
        "buffer_after_minutes": _separacion(descanso),
        "slot_interval_minutes": _intervalo(intervalo),
    }
    agenda = await agenda_de(db, servicio.id)
    if agenda is None:
        await _con_zona_de_la_base(
            db, ServiceSchedule(service_id=servicio.id, created_by=usuario_id, created_at=ahora, updated_at=ahora, **nuevo)
        )
        await _registrar(db, servicio_id=servicio.id, accion="schedule_created", usuario_id=usuario_id, detalles=nuevo, ahora=ahora)
        return Escrito(creado=True)

    cambios = {c: [getattr(agenda, c), v] for c, v in nuevo.items() if getattr(agenda, c) != v}
    if not cambios:
        return Escrito(creado=False, repetido=True)
    if "timezone" in cambios and not confirmar_zona:
        # CAMBIAR LA ZONA NO ES SILENCIOSO: la semana y las excepciones son
        # horas LOCALES y pasan a leerse en la nueva. Los bloqueos no se
        # mueven: son instantes.
        hay = await db.scalar(
            select(func.count()).select_from(ServiceScheduleRule).where(ServiceScheduleRule.service_id == servicio.id)
        ) or await db.scalar(
            select(func.count())
            .select_from(ServiceScheduleException)
            .where(
                ServiceScheduleException.service_id == servicio.id,
                ServiceScheduleException.on_date >= calc.hoy(_zona_de(agenda), ahora),
            )
        )
        if hay:
            raise CambioDeZonaSinConfirmar(details={"from": agenda.timezone, "to": zona})
    for campo, (_, valor) in cambios.items():
        setattr(agenda, campo, valor)
    agenda.updated_at = ahora
    await _con_zona_de_la_base(db, agenda)
    await _registrar(
        db, servicio_id=servicio.id, accion="schedule_updated", usuario_id=usuario_id,
        detalles={"changes": cambios}, ahora=ahora,
    )
    return Escrito(creado=False)


def _regla_en_detalle(r: ServiceScheduleRule) -> dict:
    return {
        "rule_id": r.id, "weekday": r.weekday, "start": calc.hora(r.start_minute), "end": calc.hora(r.end_minute),
        "modality": r.modality, "capacity": r.capacity, "active": r.active,
    }


async def crear_regla(
    db: AsyncSession,
    *,
    usuario_id: str,
    servicio_id: str,
    dia: int,
    inicio: str,
    fin: str,
    modalidad: str,
    capacidad: int | None,
    activa: bool,
    clave: str | None,
    ahora: datetime | None = None,
) -> Escrito:
    ahora = ahora or _ahora()
    servicio = await _para_escribir(db, usuario_id, servicio_id)
    await _exigir_agenda(db, servicio.id)
    if not 1 <= dia <= 7:
        raise HoraInvalida()
    a, b = _franja(inicio, fin)
    previo = await _por_clave(db, servicio.id, clave, "rule_created")
    if previo is not None:
        _lo_mismo(previo, {
            "weekday": dia, "start": calc.hora(a), "end": calc.hora(b), "modality": modalidad,
            "capacity": 1 if capacidad is None else capacidad, "active": activa,
        })
        return Escrito(creado=False, repetido=True)
    hechos = await hechos_de(db, servicio.id)
    cuantas = await db.scalar(
        select(func.count()).select_from(ServiceScheduleRule).where(ServiceScheduleRule.service_id == servicio.id)
    )
    if cuantas >= limites.REGLAS_MAXIMAS:
        raise LimiteAlcanzado(details={"max": limites.REGLAS_MAXIMAS})
    regla = ServiceScheduleRule(
        service_id=servicio.id, weekday=dia, start_minute=a, end_minute=b,
        modality=_modalidad(modalidad, hechos), capacity=_capacidad(capacidad, hechos),
        active=activa, created_at=ahora, updated_at=ahora,
    )
    await _guardar(db, regla)
    await _registrar(
        db, servicio_id=servicio.id, accion="rule_created", usuario_id=usuario_id,
        detalles=_regla_en_detalle(regla), clave=clave, ahora=ahora,
    )
    return Escrito(creado=True)


async def _regla_propia(db: AsyncSession, servicio_id: str, regla_id: str) -> ServiceScheduleRule:
    regla = await db.get(ServiceScheduleRule, regla_id, populate_existing=True) if _es_uuid(regla_id) else None
    if regla is None or regla.service_id != servicio_id:
        raise ElementoNoEncontrado()
    return regla


def _es_uuid(valor: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", valor or ""))


async def editar_regla(
    db: AsyncSession,
    *,
    usuario_id: str,
    servicio_id: str,
    regla_id: str,
    cambios: dict,
    ahora: datetime | None = None,
) -> Escrito:
    """Solo lo que llega. Activarla o cambiar su modalidad vuelve a mirar
    qué ofrece el servicio."""
    ahora = ahora or _ahora()
    servicio = await _para_escribir(db, usuario_id, servicio_id)
    await _exigir_agenda(db, servicio.id)
    regla = await _regla_propia(db, servicio.id, regla_id)
    antes = _regla_en_detalle(regla)
    hechos = await hechos_de(db, servicio.id)
    if "weekday" in cambios:
        if cambios["weekday"] is None or not 1 <= cambios["weekday"] <= 7:
            raise HoraInvalida()
        regla.weekday = cambios["weekday"]
    if "start" in cambios or "end" in cambios:
        regla.start_minute, regla.end_minute = _franja(
            cambios.get("start", calc.hora(regla.start_minute)), cambios.get("end", calc.hora(regla.end_minute))
        )
    activando = cambios.get("active") is True and not regla.active
    if "modality" in cambios or activando:
        regla.modality = _modalidad(cambios.get("modality", regla.modality), hechos)
    if "capacity" in cambios or activando:
        if "capacity" in cambios and cambios["capacity"] is None:
            # Un nulo explícito no es «uno»: es un error de quien llama.
            raise CapacidadInvalida(details={"max": hechos.capacidad_maxima})
        regla.capacity = _capacidad(cambios.get("capacity", regla.capacity), hechos)
    if "active" in cambios:
        if cambios["active"] is None:
            raise HoraInvalida()
        regla.active = bool(cambios["active"])
    despues = _regla_en_detalle(regla)
    if despues == antes:
        return Escrito(creado=False, repetido=True)
    regla.updated_at = ahora
    await _guardar(db, regla)
    await _registrar(
        db, servicio_id=servicio.id, accion="rule_updated", usuario_id=usuario_id,
        detalles={"rule_id": regla.id, "before": antes, "after": despues}, ahora=ahora,
    )
    return Escrito(creado=False)


async def borrar_regla(
    db: AsyncSession, *, usuario_id: str, servicio_id: str, regla_id: str, ahora: datetime | None = None
) -> Escrito:
    ahora = ahora or _ahora()
    servicio = await _para_escribir(db, usuario_id, servicio_id)
    await _exigir_agenda(db, servicio.id)
    regla = await _regla_propia(db, servicio.id, regla_id)
    detalle = _regla_en_detalle(regla)
    await db.execute(delete(ServiceScheduleRule).where(ServiceScheduleRule.id == regla.id))
    await _registrar(db, servicio_id=servicio.id, accion="rule_deleted", usuario_id=usuario_id, detalles=detalle, ahora=ahora)
    return Escrito(creado=False)


# --------------------------------------------------------------------------- #
# Excepciones
# --------------------------------------------------------------------------- #
def _excepcion_en_detalle(e: ServiceScheduleException) -> dict:
    return {
        "exception_id": e.id, "date": e.on_date.isoformat(), "kind": e.kind,
        "start": calc.hora(e.start_minute) if e.start_minute is not None else None,
        "end": calc.hora(e.end_minute) if e.end_minute is not None else None,
        "modality": e.modality, "capacity": e.capacity,
    }


def _aplicar_excepcion(
    e: ServiceScheduleException, datos: dict, hechos: Hechos, hoy: date
) -> None:
    """Deja `e` coherente con su tipo, o un 422. `datos` ya trae lo que no cambia."""
    e.on_date = _fecha_futura(_fecha(datos.get("date")), hoy)
    tipo = datos.get("kind")
    if tipo not in (CERRADA, "extra", "replace"):
        raise ExcepcionInvalida()
    e.kind = tipo
    inicio, fin = datos.get("start"), datos.get("end")
    if tipo == CERRADA:
        if datos.get("modality") is not None or datos.get("capacity") is not None:
            raise ExcepcionInvalida()
        if inicio is None and fin is None:
            e.start_minute = e.end_minute = None
        else:
            e.start_minute, e.end_minute = _franja(inicio, fin)
        e.modality = e.capacity = None
        return
    if inicio is None or fin is None:
        raise ExcepcionInvalida()
    e.start_minute, e.end_minute = _franja(inicio, fin)
    e.modality = _modalidad(datos.get("modality"), hechos)
    e.capacity = _capacidad(datos.get("capacity"), hechos)


async def crear_excepcion(
    db: AsyncSession, *, usuario_id: str, servicio_id: str, datos: dict, clave: str | None, ahora: datetime | None = None
) -> Escrito:
    ahora = ahora or _ahora()
    servicio = await _para_escribir(db, usuario_id, servicio_id)
    agenda = await _exigir_agenda(db, servicio.id)
    hoy = calc.hoy(_zona_de(agenda), ahora)
    excepcion = ServiceScheduleException(service_id=servicio.id, created_at=ahora, updated_at=ahora)
    _aplicar_excepcion(excepcion, datos, await hechos_de(db, servicio.id), hoy)
    previo = await _por_clave(db, servicio.id, clave, "exception_created")
    if previo is not None:
        _lo_mismo(previo, {k: v for k, v in _excepcion_en_detalle(excepcion).items() if k != "exception_id"})
        return Escrito(creado=False, repetido=True)
    cuantas = await db.scalar(
        select(func.count())
        .select_from(ServiceScheduleException)
        .where(ServiceScheduleException.service_id == servicio.id, ServiceScheduleException.on_date >= hoy)
    )
    if cuantas >= limites.EXCEPCIONES_MAXIMAS:
        raise LimiteAlcanzado(details={"max": limites.EXCEPCIONES_MAXIMAS})
    await _guardar(db, excepcion)
    await _registrar(
        db, servicio_id=servicio.id, accion="exception_created", usuario_id=usuario_id,
        detalles=_excepcion_en_detalle(excepcion), clave=clave, ahora=ahora,
    )
    return Escrito(creado=True)


async def _excepcion_propia(db: AsyncSession, servicio_id: str, ident: str) -> ServiceScheduleException:
    fila = await db.get(ServiceScheduleException, ident, populate_existing=True) if _es_uuid(ident) else None
    if fila is None or fila.service_id != servicio_id:
        raise ElementoNoEncontrado()
    return fila


async def editar_excepcion(
    db: AsyncSession, *, usuario_id: str, servicio_id: str, excepcion_id: str, cambios: dict, ahora: datetime | None = None
) -> Escrito:
    """Lo que no llega se queda. Una excepción de un día que ya pasó no se edita."""
    ahora = ahora or _ahora()
    servicio = await _para_escribir(db, usuario_id, servicio_id)
    agenda = await _exigir_agenda(db, servicio.id)
    excepcion = await _excepcion_propia(db, servicio.id, excepcion_id)
    hoy = calc.hoy(_zona_de(agenda), ahora)
    if excepcion.on_date < hoy:
        raise FechaInvalida()
    antes = _excepcion_en_detalle(excepcion)
    datos = {**antes, **cambios}
    if datos.get("kind") == CERRADA:
        # Lo que cierra no lleva modalidad ni capacidad: las de antes (de una
        # apertura) no se arrastran. Solo cuenta lo que llegue explícito.
        datos["modality"], datos["capacity"] = cambios.get("modality"), cambios.get("capacity")
    _aplicar_excepcion(excepcion, datos, await hechos_de(db, servicio.id), hoy)
    despues = _excepcion_en_detalle(excepcion)
    if despues == antes:
        return Escrito(creado=False, repetido=True)
    excepcion.updated_at = ahora
    await _guardar(db, excepcion)
    await _registrar(
        db, servicio_id=servicio.id, accion="exception_updated", usuario_id=usuario_id,
        detalles={"exception_id": excepcion.id, "before": antes, "after": despues}, ahora=ahora,
    )
    return Escrito(creado=False)


async def borrar_excepcion(
    db: AsyncSession, *, usuario_id: str, servicio_id: str, excepcion_id: str, ahora: datetime | None = None
) -> Escrito:
    ahora = ahora or _ahora()
    servicio = await _para_escribir(db, usuario_id, servicio_id)
    await _exigir_agenda(db, servicio.id)
    excepcion = await _excepcion_propia(db, servicio.id, excepcion_id)
    detalle = _excepcion_en_detalle(excepcion)
    await db.execute(delete(ServiceScheduleException).where(ServiceScheduleException.id == excepcion.id))
    await _registrar(db, servicio_id=servicio.id, accion="exception_deleted", usuario_id=usuario_id, detalles=detalle, ahora=ahora)
    return Escrito(creado=False)


# --------------------------------------------------------------------------- #
# Bloqueos
# --------------------------------------------------------------------------- #
def _bloqueo_en_detalle(b: ServiceScheduleBlock) -> dict:
    """SIN EL MOTIVO: es privado y el historial no lo guarda."""
    return {"block_id": b.id, "starts_at": _utc(b.starts_at).isoformat(), "ends_at": _utc(b.ends_at).isoformat()}


def _momento_local(fecha: str | None, hora_: str | None, z, hoy: date, *, admite_24: bool) -> datetime:  # noqa: ANN001
    """Fecha y hora locales de la agenda → instante. ACOTADAS ANTES de
    convertir: un «9999-12-31 24:00» desbordaría el calendario (un 500). Una
    hora que no existe ese día (el reloj salta) se lleva al salto, como en la
    semana: «hasta las 24:00» la víspera de un cambio a medianoche es el final
    de ese día."""
    dia = _fecha(fecha)
    margen = limites.BLOQUEO_MAXIMO_DIAS + 1
    if not hoy - timedelta(days=margen) <= dia <= hoy + timedelta(days=limites.ADELANTO_MAXIMO_DIAS + margen):
        raise FechaInvalida()
    minuto = calc.minuto_de(hora_, admite_24=admite_24)
    if minuto is None:
        raise HoraInvalida()
    return calc.instante(dia, minuto, z)


async def crear_bloqueo(
    db: AsyncSession, *, usuario_id: str, servicio_id: str, datos: dict, clave: str | None, ahora: datetime | None = None
) -> Escrito:
    ahora = ahora or _ahora()
    servicio = await _para_escribir(db, usuario_id, servicio_id)
    agenda = await _exigir_agenda(db, servicio.id)
    z = _zona_de(agenda)
    hoy = calc.hoy(z, ahora)
    inicio = _momento_local(datos.get("start_date"), datos.get("start_time"), z, hoy, admite_24=False)
    fin = _momento_local(datos.get("end_date"), datos.get("end_time"), z, hoy, admite_24=True)
    previo = await _por_clave(db, servicio.id, clave, "block_created")
    if previo is not None:
        # El motivo no está en el historial (es privado): se comparan los instantes.
        _lo_mismo(previo, {"starts_at": inicio.isoformat(), "ends_at": fin.isoformat()})
        return Escrito(creado=False, repetido=True)
    if fin <= inicio or fin <= ahora or fin - inicio > timedelta(days=limites.BLOQUEO_MAXIMO_DIAS):
        raise BloqueoInvalido()
    if inicio > ahora + timedelta(days=limites.ADELANTO_MAXIMO_DIAS):
        raise FechaInvalida()
    motivo = (datos.get("reason") or "").strip() or None
    if motivo is not None and len(motivo) > limites.MOTIVO_MAXIMO:
        raise BloqueoInvalido()
    cuantos = await db.scalar(
        select(func.count())
        .select_from(ServiceScheduleBlock)
        .where(ServiceScheduleBlock.service_id == servicio.id, ServiceScheduleBlock.ends_at > ahora)
    )
    if cuantos >= limites.BLOQUEOS_MAXIMOS:
        raise LimiteAlcanzado(details={"max": limites.BLOQUEOS_MAXIMOS})
    bloqueo = ServiceScheduleBlock(service_id=servicio.id, starts_at=inicio, ends_at=fin, reason=motivo, created_at=ahora)
    await _guardar(db, bloqueo)
    await _registrar(
        db, servicio_id=servicio.id, accion="block_created", usuario_id=usuario_id,
        detalles=_bloqueo_en_detalle(bloqueo), clave=clave, ahora=ahora,
    )
    return Escrito(creado=True)


async def _contrataciones_que_protege(db: AsyncSession, bloqueo: ServiceScheduleBlock) -> int:
    """Retirar un bloqueo no puede dejar sin protección una contratación
    futura. Desde el Incremento 5 NINGUNA depende de un bloqueo: una reserva
    se protege SOLA (su retención consumida ocupa el horario en la base,
    exclusión `service_holds_sin_cruces`), así que retirar un bloqueo nunca la
    deja al descubierto: cero, siempre. Se queda como punto único por si una
    regla futura (la aceptación del prestador, por ejemplo) lo necesitara."""
    del db, bloqueo
    return 0


async def borrar_bloqueo(
    db: AsyncSession, *, usuario_id: str, servicio_id: str, bloqueo_id: str, ahora: datetime | None = None
) -> Escrito:
    ahora = ahora or _ahora()
    servicio = await _para_escribir(db, usuario_id, servicio_id)
    await _exigir_agenda(db, servicio.id)
    fila = await db.get(ServiceScheduleBlock, bloqueo_id, populate_existing=True) if _es_uuid(bloqueo_id) else None
    if fila is None or fila.service_id != servicio.id:
        raise ElementoNoEncontrado()
    if await _contrataciones_que_protege(db, fila) > 0:  # pragma: no cover - ninguna depende de un bloqueo
        raise BloqueoEnUso()
    detalle = _bloqueo_en_detalle(fila)
    await db.execute(delete(ServiceScheduleBlock).where(ServiceScheduleBlock.id == fila.id))
    await _registrar(db, servicio_id=servicio.id, accion="block_deleted", usuario_id=usuario_id, detalles=detalle, ahora=ahora)
    return Escrito(creado=False)


# --------------------------------------------------------------------------- #
# Consultar horarios: lo público y la vista previa
# --------------------------------------------------------------------------- #
ACTIVA = "active"
EN_PAUSA = "paused"
SIN_CONFIGURAR = "not_configured"


@dataclass
class Calendario:
    zona: str | None
    estado: str
    modalidad: str | None
    duracion: int | None
    hoy: date | None
    ultima: date | None
    desde: date | None
    hasta: date | None
    dias: list[tuple[date, int]]
    proximo: calc.Horario | None
    motivos: list[str] = field(default_factory=list)


@dataclass
class PaginaDeHorarios:
    zona: str | None
    estado: str
    fecha: date
    modalidad: str | None
    duracion: int | None
    horarios: list[calc.Horario]
    siguiente: str | None


def _estado(agenda: ServiceSchedule | None) -> str:
    if agenda is None or calc.zona(agenda.timezone) is None:
        return SIN_CONFIGURAR
    return ACTIVA if agenda.status == AGENDA_ACTIVA else EN_PAUSA


def _rango(desde: str | None, hasta: str | None, hoy: date, ultima: date) -> tuple[date, date]:
    """El rango pedido, o el de siempre: desde hoy, tantos días como se
    consultan de una vez. Lo abusivo es un 422 estable."""
    fuera = FueraDelHorizonte(details={"today": hoy.isoformat(), "last_date": ultima.isoformat()})
    inicio = _fecha(desde, RangoInvalido) if desde else hoy
    # EL INICIO SE ACOTA ANTES DE SUMARLE NADA: «9999-12-31» + 30 días
    # desbordaría el calendario (un 500 en una ruta pública).
    if inicio < hoy or inicio > ultima:
        raise fuera
    fin = _fecha(hasta, RangoInvalido) if hasta else min(inicio + timedelta(days=limites.DIAS_POR_CONSULTA - 1), ultima)
    if fin < inicio or (fin - inicio).days + 1 > limites.DIAS_POR_CONSULTA:
        raise RangoInvalido(details={"max_days": limites.DIAS_POR_CONSULTA})
    if fin > ultima:
        raise fuera
    return inicio, fin


async def _calendario(
    db: AsyncSession,
    agenda: ServiceSchedule | None,
    version: ServiceVersion | None,
    *,
    desde: str | None,
    hasta: str | None,
    modalidad: str | None,
    ahora: datetime,
) -> Calendario:
    servicio = _servicio_de(version)
    if modalidad is not None and (servicio is None or modalidad != servicio.modalidad):
        raise ModalidadNoDisponible()
    estado = _estado(agenda)
    if estado == SIN_CONFIGURAR or servicio is None:
        return Calendario(
            None if estado == SIN_CONFIGURAR else agenda.timezone, estado if servicio else SIN_CONFIGURAR,
            servicio.modalidad if servicio else None, servicio.duracion if servicio else None,
            None, None, None, None, [], None,
        )
    politica = limites.Politica.de()
    z = _zona_de(agenda)
    hoy = calc.hoy(z, ahora)
    ultima = calc.ultima_fecha(z, ahora, politica)
    inicio, fin = _rango(desde, hasta, hoy, ultima)
    if estado != ACTIVA:
        return Calendario(agenda.timezone, estado, servicio.modalidad, servicio.duracion, hoy, ultima, inicio, fin, [], None)
    datos = await _datos(db, agenda, servicio, ahora=ahora, politica=politica)
    por_dia = calc.dias(
        datos, modalidad=servicio.modalidad, desde_fecha=inicio, hasta_fecha=fin, ahora=ahora, politica=politica
    )
    return Calendario(
        agenda.timezone, estado, servicio.modalidad, servicio.duracion, hoy, ultima, inicio, fin,
        [(f, len(h)) for f, h in sorted(por_dia.items())],
        calc.proximo(datos, modalidad=servicio.modalidad, ahora=ahora, politica=politica),
    )


async def _horarios(
    db: AsyncSession,
    agenda: ServiceSchedule | None,
    version: ServiceVersion | None,
    *,
    fecha: str,
    modalidad: str | None,
    cursor: str | None,
    limite: int,
    ahora: datetime,
) -> PaginaDeHorarios:
    dia = _fecha(fecha, RangoInvalido)
    servicio = _servicio_de(version)
    if modalidad is not None and (servicio is None or modalidad != servicio.modalidad):
        raise ModalidadNoDisponible()
    estado = _estado(agenda) if servicio is not None else SIN_CONFIGURAR
    vacia = PaginaDeHorarios(
        agenda.timezone if estado != SIN_CONFIGURAR else None, estado, dia,
        servicio.modalidad if servicio else None, servicio.duracion if servicio else None, [], None,
    )
    if estado == SIN_CONFIGURAR:
        return vacia
    politica = limites.Politica.de()
    z = _zona_de(agenda)
    _rango(fecha, fecha, calc.hoy(z, ahora), calc.ultima_fecha(z, ahora, politica))
    if estado != ACTIVA:
        return vacia
    despues: datetime | None = None
    if cursor:
        try:
            despues = datetime.fromisoformat(cursor)
        except ValueError:
            raise CursorInvalido() from None
        if despues.tzinfo is None:
            raise CursorInvalido()
    datos = await _datos(db, agenda, servicio, ahora=ahora, politica=politica)
    primero, ultimo = calc.ventana(ahora, politica)
    todos = calc.horarios_del_dia(dia, datos, modalidad=servicio.modalidad, desde=primero, hasta=ultimo)
    if despues is not None:
        todos = [h for h in todos if h.inicio > despues]
    limite = max(1, min(int(limite), limites.HORARIOS_MAXIMOS_POR_PAGINA))
    pagina = todos[:limite]
    siguiente = pagina[-1].inicio.isoformat() if len(todos) > limite else None
    return PaginaDeHorarios(agenda.timezone, estado, dia, servicio.modalidad, servicio.duracion, pagina, siguiente)


async def _publico(db: AsyncSession, servicio_id: str, mira: str | None) -> tuple[Service, ServiceVersion]:
    """Solo lo público (`condiciones_publicas`); lo demás es el 404 de siempre."""
    try:
        servicio, version, _, _ = await descubrimiento.publico(db, servicio_id, mira=mira)
    except descubrimiento.ServicioNoPublico:
        raise catalogo.ServicioNoEncontrado() from None
    return servicio, version


async def calendario_publico(
    db: AsyncSession,
    *,
    servicio_id: str,
    mira: str | None,
    desde: str | None,
    hasta: str | None,
    modalidad: str | None,
    ahora: datetime | None = None,
) -> Calendario:
    servicio, version = await _publico(db, servicio_id, mira)
    return await _calendario(
        db, await agenda_de(db, servicio.id), version,
        desde=desde, hasta=hasta, modalidad=modalidad, ahora=ahora or _ahora(),
    )


async def horarios_publicos(
    db: AsyncSession,
    *,
    servicio_id: str,
    mira: str | None,
    fecha: str,
    modalidad: str | None,
    cursor: str | None,
    limite: int,
    ahora: datetime | None = None,
) -> PaginaDeHorarios:
    servicio, version = await _publico(db, servicio_id, mira)
    return await _horarios(
        db, await agenda_de(db, servicio.id), version,
        fecha=fecha, modalidad=modalidad, cursor=cursor, limite=limite, ahora=ahora or _ahora(),
    )


async def calendario_previo(
    db: AsyncSession,
    *,
    usuario_id: str,
    servicio_id: str,
    desde: str | None,
    hasta: str | None,
    modalidad: str | None,
    ahora: datetime | None = None,
) -> Calendario:
    """Lo que vería una persona, sobre la versión publicada (o, si todavía no
    hay, la que se prepara), aunque el servicio aún no sea público. Con los
    motivos por los que el público todavía no lo ve."""
    ahora = ahora or _ahora()
    servicio, prestador = await catalogo.mio(db, usuario_id, servicio_id, bloquear_fila=False)
    privada = await _privada(db, servicio, prestador, ahora=ahora)
    salida = await _calendario(
        db, privada.agenda, privada.hechos.referencia, desde=desde, hasta=hasta, modalidad=modalidad, ahora=ahora
    )
    salida.motivos = privada.motivos
    return salida


async def horarios_previos(
    db: AsyncSession,
    *,
    usuario_id: str,
    servicio_id: str,
    fecha: str,
    modalidad: str | None,
    cursor: str | None,
    limite: int,
    ahora: datetime | None = None,
) -> PaginaDeHorarios:
    servicio, _ = await catalogo.mio(db, usuario_id, servicio_id, bloquear_fila=False)
    hechos = await hechos_de(db, servicio.id)
    return await _horarios(
        db, await agenda_de(db, servicio.id), hechos.referencia,
        fecha=fecha, modalidad=modalidad, cursor=cursor, limite=limite, ahora=ahora or _ahora(),
    )


__all__ = [
    "ACTIVA",
    "AgendaPrivada",
    "Calendario",
    "EN_PAUSA",
    "Escrito",
    "Hechos",
    "PaginaDeHorarios",
    "SIN_CONFIGURAR",
    "agenda_de",
    "borrar_bloqueo",
    "borrar_excepcion",
    "borrar_regla",
    "calendario_previo",
    "calendario_publico",
    "configurar",
    "crear_bloqueo",
    "crear_excepcion",
    "crear_regla",
    "editar_excepcion",
    "editar_regla",
    "hechos_de",
    "horarios_previos",
    "horarios_publicos",
    "leer",
]
