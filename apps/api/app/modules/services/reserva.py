"""LA RESERVA DE SERVICIOS (Incremento 5): retener, contratar y consultar.

EL RECORRIDO: una persona elige un horario de la agenda pública → lo RETIENE
unos minutos (`retener`) → revisa el resumen (`resumen`) → acepta las
condiciones y CONFIRMA (`confirmar`): nacen, en la misma transacción, el
PEDIDO, la RESERVA, lo que se aceptó y el historial, y la retención queda
consumida. Después consulta sus reservas; el prestador, las de sus servicios.

UNA SOLA AUTORIDAD PARA CADA COSA:

  * QUÉ HORARIO ESTÁ LIBRE lo decide el cálculo de la agenda
    (`agenda_calculo.horarios_del_dia`), el mismo que enseña lo público, con
    lo ya ocupado dentro (`agenda.ocupaciones`). Lo que el teléfono eligió no
    prueba nada: retener y confirmar lo vuelven a calcular.
  * QUE DOS RESERVAS NO SE PISEN lo impide la BASE (la exclusión y los
    índices únicos de la 0093). Aquí, además, se ponen en fila las escrituras
    de un servicio (la fila de `services`, bloqueada, como la agenda) para que
    la competencia termine en un 409 limpio y no en un interbloqueo.
  * LOS SALTOS de una retención (activa → consumida, liberada o vencida) los
    da solo este módulo; la base impide cualquier otro.
  * EL VENCIMIENTO lo decide la HORA: una retención `active` cuyo
    `expires_at` ya pasó está vencida aunque el barrido no haya pasado. Al
    retener, las vencidas del servicio se marcan dentro de la misma
    transacción; el barrido (`vencer_retenciones`) solo limpia.
  * EL COBRO: hoy no existe (`reserva_politica.cobro_disponible`). Solo se
    contrata lo gratuito; lo que tiene precio se prepara y se detiene con
    `service_booking_payments_not_configured`, sin fingir nada.

ORDEN DE LOS CERROJOS, siempre el mismo: la fila del servicio (FOR NO KEY
UPDATE, ver `_poner_en_fila`), después la retención; y, para el tope por
persona y para su clave de idempotencia, un cerrojo de transacción de esa
persona. Nunca uno global.

LO PRIVADO: la nota y la dirección de quien contrata viven en
`service_booking_intakes` y solo las ven esa persona y el prestador de una
reserva confirmada. Nunca en el historial, en un aviso ni en lo público.
"""

from __future__ import annotations

import functools
import hashlib
import json
import secrets
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import and_, func, or_, select, text, true, update
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.exceptions import ConflictError, NotFoundError, ServiceUnavailableError, ValidationAppError
from app.modules.services import agenda as agenda_de_servicio
from app.modules.services import agenda_calculo as calc
from app.modules.services import agenda_politica as limites_de_la_agenda
from app.modules.services import avisos, catalogo, descubrimiento, politicas
from app.modules.services import reserva_politica as limites
from app.modules.services import service as admision_service
from app.modules.services.admision import ClaveReutilizada, exigir_clave_valida
from app.modules.services.agenda_models import AGENDA_ACTIVA
from app.modules.services.catalogo_models import (
    A_CONSULTAR,
    A_DOMICILIO,
    GRATIS,
    MODALIDADES,
    PRECIO_DESDE,
    PRECIO_FIJO,
    Service,
    ServiceVersion,
)
from app.modules.services.models import (
    POLITICA_CONDICIONES_DE_CONTRATACION,
    ServicePolicy,
    ServiceProvider,
)
from app.modules.services.reserva_models import (
    ACEPTA_CONDICIONES_DE_Z,
    ACEPTA_CONDICIONES_DEL_SERVICIO,
    CLIENTE,
    OCUPAN,
    PAGO_NO_REQUERIDO,
    PASARELA_NINGUNA,
    PEDIDO_CONFIRMADO,
    RESERVA_CONFIRMADA,
    RESERVA_CONFIRMADA_EVENTO,
    RETENCION_ACTIVA,
    RETENCION_CONSUMIDA,
    RETENCION_CREADA,
    RETENCION_LIBERADA,
    RETENCION_SOLTADA,
    RETENCION_VENCIDA,
    RETENCION_VENCIO,
    SISTEMA,
    ServiceBooking,
    ServiceBookingAcceptance,
    ServiceBookingEvent,
    ServiceBookingIntake,
    ServiceHold,
    ServiceOrder,
)
from app.modules.services.service import CursorInvalido

UTC = timezone.utc


# --------------------------------------------------------------------------- #
# Errores (códigos estables; la app los traduce)
# --------------------------------------------------------------------------- #
class ClaveRequerida(ValidationAppError):
    code = "idempotency_key_required"
    message = "Esta acción necesita una clave de idempotencia."


class RetencionInvalida(ValidationAppError):
    code = "service_hold_invalid"
    message = "Ese horario no se entiende."


class HorarioNoDisponible(ConflictError):
    code = "service_slot_not_available"
    message = "Ese horario ya no está disponible."


class RetencionYaActiva(ConflictError):
    code = "service_hold_already_active"
    message = "Ya tienes apartado ese horario."


class LimiteDeRetenciones(ConflictError):
    code = "service_hold_limit_reached"
    message = "Ya tienes varios horarios apartados. Termina o suelta alguno."


class RetencionNoEncontrada(NotFoundError):
    code = "service_hold_not_found"
    message = "No encontramos ese horario apartado."


class RetencionVencida(ConflictError):
    code = "service_hold_expired"
    message = "El tiempo para confirmar ese horario terminó."


class RetencionNoActiva(ConflictError):
    code = "service_hold_not_active"
    message = "Ese horario ya no está apartado."


class RetencionConsumida(ConflictError):
    code = "service_hold_already_consumed"
    message = "Ese horario ya se reservó."


class ServicioPropio(ConflictError):
    code = "service_booking_own_service"
    message = "No puedes contratar tu propio servicio."


class ServicioNoDisponible(ConflictError):
    code = "service_booking_service_unavailable"
    message = "Este servicio ya no está disponible."


class VersionCambiada(ConflictError):
    code = "service_booking_version_changed"
    message = "El servicio cambió mientras lo revisabas."


class PagosNoConfigurados(ServiceUnavailableError):
    code = "service_booking_payments_not_configured"
    message = "Todavía no se pueden pagar servicios en Z."


class PrecioNoCerrado(ConflictError):
    code = "service_booking_price_not_closed"
    message = "El precio de este servicio todavía no está cerrado."


class PropuestaRequerida(ConflictError):
    code = "service_booking_quote_required"
    message = "Este servicio se cotiza antes de contratarse."


class ConfirmacionDelPrestador(ConflictError):
    code = "service_booking_provider_confirmation_required"
    message = "Este servicio necesita que el prestador acepte la solicitud."


class CondicionesNoPublicadas(ConflictError):
    code = "service_booking_terms_unavailable"
    message = "Las condiciones de contratación todavía no están publicadas."


class CondicionesCambiadas(ConflictError):
    code = "service_booking_terms_changed"
    message = "Las condiciones cambiaron: vuelve a leerlas."


class DatosInvalidos(ValidationAppError):
    code = "service_booking_data_invalid"
    message = "Revisa los datos de la contratación."


class ReservaNoEncontrada(NotFoundError):
    code = "service_booking_not_found"
    message = "No encontramos esa reserva."


class Ocupado(ConflictError):
    code = "service_booking_busy"
    message = "Hay mucha gente reservando ahora mismo. Inténtalo de nuevo."


# --------------------------------------------------------------------------- #
# Lo que se puede contratar
# --------------------------------------------------------------------------- #
#: Cómo se contrata un servicio, según su precio.
CONTRATA_GRATIS = "free"
CONTRATA_CON_PAGO = "paid"
CONTRATA_A_CONSULTAR = "quote_required"
CONTRATA_PRECIO_ABIERTO = "price_not_closed"


def forma_de_contratar(version: ServiceVersion) -> str:
    """Gratuito se confirma; con precio fijo se prepara y se detiene (no hay
    cobro); «desde» no tiene precio cerrado; «a consultar» se cotiza antes."""
    return {
        GRATIS: CONTRATA_GRATIS,
        PRECIO_FIJO: CONTRATA_CON_PAGO,
        PRECIO_DESDE: CONTRATA_PRECIO_ABIERTO,
        A_CONSULTAR: CONTRATA_A_CONSULTAR,
    }.get(version.price_model or "", CONTRATA_A_CONSULTAR)


def _exigir_que_se_pueda_apartar(version: ServiceVersion, politica: limites.Politica) -> None:
    """Lo que NUNCA llegará a contratarse no aparta un horario: nadie lo
    ocupa diez minutos para nada."""
    forma = forma_de_contratar(version)
    if forma == CONTRATA_A_CONSULTAR:
        raise PropuestaRequerida()
    if forma == CONTRATA_PRECIO_ABIERTO:
        raise PrecioNoCerrado()
    if version.modality not in politica.modalidades_inmediatas:
        raise ConfirmacionDelPrestador(details={"modality": version.modality})


async def se_puede_apartar(db: AsyncSession, servicio_id: str) -> bool:
    """¿Ofrece la app «Continuar» en los horarios de este servicio? Solo si
    su versión publicada tiene un precio que se contrata (gratis, o con
    precio para PREPARAR la contratación) y una modalidad que se confirma
    sola. Lo demás no aparta nada (y el servidor lo diría con un 409)."""
    version = await catalogo.publicada(db, servicio_id)
    if version is None:
        return False
    try:
        _exigir_que_se_pueda_apartar(version, limites.Politica.de())
    except (PropuestaRequerida, PrecioNoCerrado, ConfirmacionDelPrestador):
        return False
    return True


# --------------------------------------------------------------------------- #
# Utilidades
# --------------------------------------------------------------------------- #
def _ahora() -> datetime:
    return datetime.now(UTC)


def _utc(momento: datetime) -> datetime:
    """SQLite devuelve instantes sin zona; PostgreSQL, con ella."""
    return momento if momento.tzinfo else momento.replace(tzinfo=UTC)


def _exigir_clave(clave: str | None) -> str:
    limpia = exigir_clave_valida(clave)
    if limpia is None:
        raise ClaveRequerida()
    return limpia


def _huella(contenido: dict) -> str:
    return hashlib.sha256(json.dumps(contenido, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _instante(texto: str | None) -> datetime:
    """Un instante ISO CON su desplazamiento. Sin él, no se adivina."""
    if not isinstance(texto, str) or not 10 <= len(texto) <= 40:
        raise RetencionInvalida(details={"field": "starts_at"})
    try:
        momento = datetime.fromisoformat(texto.strip().replace("Z", "+00:00"))
    except ValueError:
        raise RetencionInvalida(details={"field": "starts_at"}) from None
    if momento.tzinfo is None or momento.year < 2000 or momento.year > 9000:
        raise RetencionInvalida(details={"field": "starts_at"})
    return momento.astimezone(UTC)


def _estado_sql(error: BaseException) -> str | None:
    for causa in (getattr(error, "orig", None), getattr(getattr(error, "orig", None), "__cause__", None)):
        estado = getattr(causa, "sqlstate", None) or getattr(causa, "pgcode", None)
        if estado:
            return estado
    return None


def _restriccion(error: IntegrityError) -> str | None:
    for causa in (error.orig, getattr(error.orig, "__cause__", None)):
        nombre = getattr(causa, "constraint_name", None)
        if nombre:
            return nombre
    return None


#: Un cerrojo que no llegó a tiempo y un interbloqueo que PostgreSQL deshizo.
_ESPERAS_FALLIDAS = ("55P03", "40P01")


def sin_esperas_largas(funcion):
    """Un cerrojo que no llega a tiempo (55P03) o un interbloqueo (40P01) es un
    409 `service_booking_busy`, nunca un 500. El orden de los cerrojos los
    evita; esto es la última red."""

    @functools.wraps(funcion)
    async def envuelta(*args, **kwargs):
        try:
            return await funcion(*args, **kwargs)
        except DBAPIError as error:
            if _estado_sql(error) in _ESPERAS_FALLIDAS:
                raise Ocupado() from None
            raise

    return envuelta


async def _poner_en_fila(db: AsyncSession, servicio_id: str) -> Service:
    """La fila del servicio, BLOQUEADA hasta el final de la transacción, sin
    esperar más de lo razonable.

    FOR NO KEY UPDATE, NO FOR UPDATE. Sigue en fila con las demás
    contrataciones del servicio y con quien lo edita o lo bloquea (FOR UPDATE),
    pero NO choca con la comprobación de una clave ajena (FOR KEY SHARE) de
    quien escribe una fila que apunta al servicio. El barrido bloquea una
    retención, la vence y después escribe su línea del historial: con FOR
    UPDATE aquí, quien tenía el servicio y esperaba esa retención y el barrido
    se esperaban el uno al otro (40P01, hallazgo de la revisión del 30/09)."""
    if (await db.connection()).dialect.name == "postgresql":
        await db.execute(text(f"set local lock_timeout = '{int(limites.ESPERA_DEL_CERROJO_MS)}ms'"))
    servicio = await db.scalar(
        select(Service)
        .where(Service.id == servicio_id)
        .with_for_update(key_share=True)
        .execution_options(populate_existing=True)
    )
    if servicio is None:
        raise catalogo.ServicioNoEncontrado()
    return servicio


async def _en_fila_la_persona(db: AsyncSession, cliente_id: str) -> None:
    """Lo de UNA persona, en fila: su tope de retenciones y su clave de
    idempotencia (la misma clave a la vez en dos retenciones de servicios
    distintos no comparte otro cerrojo). No es global: dos personas distintas
    nunca se esperan aquí."""
    if (await db.connection()).dialect.name == "postgresql":
        await db.execute(
            text("select pg_advisory_xact_lock(hashtextextended(:clave, 0))"),
            {"clave": f"service_holds:{cliente_id}"},
        )


def estado_efectivo(retencion: ServiceHold, ahora: datetime | None = None) -> str:
    """El estado que vale: una activa cuyo plazo ya pasó está VENCIDA, la haya
    barrido alguien o no."""
    ahora = ahora or _ahora()
    if retencion.status == RETENCION_ACTIVA and _utc(retencion.expires_at) <= ahora:
        return RETENCION_VENCIDA
    return retencion.status


async def _por_clave(db: AsyncSession, cliente_id: str, clave: str) -> ServiceBookingEvent | None:
    return await db.scalar(
        select(ServiceBookingEvent).where(
            ServiceBookingEvent.actor_id == cliente_id, ServiceBookingEvent.idempotency_key == clave
        )
    )


async def _anotar(
    db: AsyncSession,
    *,
    servicio_id: str,
    accion: str,
    desde: str | None,
    hasta: str,
    ahora: datetime,
    retencion_id: str | None = None,
    reserva_id: str | None = None,
    actor_id: str | None = None,
    rol: str = CLIENTE,
    clave: str | None = None,
    detalles: dict | None = None,
) -> ServiceBookingEvent:
    """Una línea del historial. NUNCA la nota ni la dirección."""
    evento = ServiceBookingEvent(
        service_id=servicio_id,
        hold_id=retencion_id,
        booking_id=reserva_id,
        action=accion,
        from_status=desde,
        to_status=hasta,
        actor_id=actor_id,
        actor_role=rol,
        idempotency_key=clave,
        details=detalles or {},
        created_at=ahora,
    )
    db.add(evento)
    await db.flush()
    return evento


async def _vencer(db: AsyncSession, filtro, *, ahora: datetime, lote: int | None = None) -> int:
    """Marca VENCIDAS las activas cuyo plazo pasó, con su línea en el
    historial. Idempotente: una ya vencida no se vuelve a tocar."""
    candidatas = select(ServiceHold.id).where(
        ServiceHold.status == RETENCION_ACTIVA, ServiceHold.expires_at <= ahora, filtro
    ).order_by(ServiceHold.expires_at, ServiceHold.id)
    if lote is not None:
        candidatas = candidatas.limit(lote)
    if (await db.connection()).dialect.name == "postgresql":
        # Lo que otra transacción está confirmando o soltando, se salta.
        candidatas = candidatas.with_for_update(skip_locked=True)
    ids = list(await db.scalars(candidatas))
    if not ids:
        return 0
    filas = (
        await db.execute(
            update(ServiceHold)
            .where(ServiceHold.id.in_(ids), ServiceHold.status == RETENCION_ACTIVA)
            .values(status=RETENCION_VENCIDA, expired_at=ahora, updated_at=ahora)
            .returning(ServiceHold.id, ServiceHold.service_id)
            .execution_options(synchronize_session=False)
        )
    ).all()
    for retencion_id, servicio_id in filas:
        await _anotar(
            db, servicio_id=servicio_id, accion=RETENCION_VENCIO, desde=RETENCION_ACTIVA,
            hasta=RETENCION_VENCIDA, ahora=ahora, retencion_id=retencion_id, rol=SISTEMA,
        )
    return len(filas)


async def _publico_para(db: AsyncSession, servicio_id: str, cliente_id: str) -> tuple:
    try:
        return await descubrimiento.publico(db, servicio_id, mira=cliente_id)
    except descubrimiento.ServicioNoPublico:
        raise catalogo.ServicioNoEncontrado() from None


def _slot(datos: calc.Datos, momento: datetime, *, desde: datetime, hasta: datetime) -> calc.Horario | None:
    """El horario que empieza en `momento`, si el cálculo lo ofrece."""
    fecha = calc.reloj(momento, datos.configuracion.zona).date()
    for horario in calc.horarios_del_dia(fecha, datos, modalidad=datos.servicio.modalidad, desde=desde, hasta=hasta):
        if horario.inicio == momento:
            return horario
    return None


async def _plaza_libre(
    db: AsyncSession, servicio_id: str, inicio: datetime, capacidad: int, *, ahora: datetime, excepto: str | None
) -> int | None:
    tomadas = set(
        await db.scalars(
            select(ServiceHold.seat).where(
                ServiceHold.service_id == servicio_id,
                ServiceHold.starts_at == inicio,
                ServiceHold.status.in_(OCUPAN),
                or_(ServiceHold.status == RETENCION_CONSUMIDA, ServiceHold.expires_at > ahora),
                *([ServiceHold.id != excepto] if excepto else []),
            )
        )
    )
    return next((p for p in range(1, capacidad + 1) if p not in tomadas), None)


# --------------------------------------------------------------------------- #
# Retener
# --------------------------------------------------------------------------- #
@dataclass
class Retenido:
    retencion: ServiceHold
    creada: bool


@sin_esperas_largas
async def retener(
    db: AsyncSession,
    *,
    cliente_id: str,
    servicio_id: str,
    inicio: str | None,
    modalidad: str | None,
    clave: str | None,
    ahora: datetime | None = None,
) -> Retenido:
    """Aparta un horario que la agenda ofrece EN ESTE MOMENTO. Repetir con la
    misma clave y lo mismo devuelve la misma retención (sin alargarla); con
    otra cosa es un 409. Si la persona ya tenía otro horario apartado de este
    servicio, se suelta en la misma transacción (y solo si el nuevo se
    consigue)."""
    clave = _exigir_clave(clave)
    ahora = ahora or _ahora()
    momento = _instante(inicio)
    if modalidad is not None and modalidad not in MODALIDADES:
        raise RetencionInvalida(details={"field": "modality"})
    huella = _huella({"service_id": servicio_id, "starts_at": momento.isoformat(), "modality": modalidad})
    politica = limites.Politica.de()

    await _poner_en_fila(db, servicio_id)
    previo = await _por_clave(db, cliente_id, clave)
    if previo is not None:
        if previo.action != RETENCION_CREADA or (previo.details or {}).get("request_sha256") != huella:
            raise ClaveReutilizada(details={"action": previo.action})
        return Retenido(await db.get(ServiceHold, previo.hold_id, populate_existing=True), creada=False)

    servicio, version, prestador, _ = await _publico_para(db, servicio_id, cliente_id)
    if prestador.profile_id == cliente_id:
        raise ServicioPropio()
    _exigir_que_se_pueda_apartar(version, politica)
    agenda = await agenda_de_servicio.agenda_de(db, servicio.id)
    servicio_calc = agenda_de_servicio._servicio_de(version)
    if agenda is None or agenda.status != AGENDA_ACTIVA or calc.zona(agenda.timezone) is None or servicio_calc is None:
        raise HorarioNoDisponible()
    if modalidad is not None and modalidad != servicio_calc.modalidad:
        raise HorarioNoDisponible(details={"modality": servicio_calc.modalidad})

    # Lo vencido de este servicio deja de ocupar AHORA, no cuando pase el barrido.
    await _vencer(db, ServiceHold.service_id == servicio.id, ahora=ahora)
    propia = await db.scalar(
        select(ServiceHold)
        .where(
            ServiceHold.service_id == servicio.id,
            ServiceHold.client_id == cliente_id,
            ServiceHold.status == RETENCION_ACTIVA,
        )
        .execution_options(populate_existing=True)
    )
    if propia is not None and _utc(propia.starts_at) == momento:
        # SIN RENOVACIONES SILENCIOSAS: la misma retención no se alarga.
        raise RetencionYaActiva(details={"hold_id": propia.id})

    politica_agenda = limites_de_la_agenda.Politica.de()
    datos = await agenda_de_servicio._datos(
        db, agenda, servicio_calc, ahora=ahora, politica=politica_agenda, excepto=propia.id if propia else None
    )
    desde, hasta = calc.ventana(ahora, politica_agenda)
    horario = _slot(datos, momento, desde=desde, hasta=hasta)
    if horario is None:
        raise HorarioNoDisponible()

    await _en_fila_la_persona(db, cliente_id)
    activas = await db.scalar(
        select(func.count())
        .select_from(ServiceHold)
        .where(
            ServiceHold.client_id == cliente_id,
            ServiceHold.status == RETENCION_ACTIVA,
            ServiceHold.expires_at > ahora,
            *([ServiceHold.id != propia.id] if propia else []),
        )
    )
    if activas >= politica.retenciones_activas:
        raise LimiteDeRetenciones(details={"max": politica.retenciones_activas})
    plaza = await _plaza_libre(
        db, servicio.id, momento, horario.capacidad, ahora=ahora, excepto=propia.id if propia else None
    )
    if plaza is None:
        raise HorarioNoDisponible()

    if propia is not None:
        propia.status = RETENCION_LIBERADA
        propia.released_at = ahora
        propia.updated_at = ahora
        await db.flush()
        await _anotar(
            db, servicio_id=servicio.id, accion=RETENCION_SOLTADA, desde=RETENCION_ACTIVA,
            hasta=RETENCION_LIBERADA, ahora=ahora, retencion_id=propia.id, actor_id=cliente_id,
            detalles={"reason": "replaced"},
        )

    c = datos.configuracion
    retencion = ServiceHold(
        service_id=servicio.id,
        version_id=version.id,
        client_id=cliente_id,
        status=RETENCION_ACTIVA,
        starts_at=horario.inicio,
        ends_at=horario.fin,
        occupied_from=horario.inicio - timedelta(minutes=c.preparacion),
        occupied_until=horario.fin + timedelta(minutes=c.descanso),
        timezone=agenda.timezone,
        local_date=horario.fecha,
        modality=servicio_calc.modalidad,
        capacity=horario.capacidad,
        seat=plaza,
        expires_at=ahora + timedelta(minutes=politica.retencion_minutos),
        created_at=ahora,
        updated_at=ahora,
    )
    try:
        async with db.begin_nested():
            db.add(retencion)
            await db.flush()
            await _anotar(
                db, servicio_id=servicio.id, accion=RETENCION_CREADA, desde=None, hasta=RETENCION_ACTIVA,
                ahora=ahora, retencion_id=retencion.id, actor_id=cliente_id, clave=clave,
                detalles={
                    "starts_at": retencion.starts_at.isoformat(), "seat": plaza,
                    "expires_at": retencion.expires_at.isoformat(), "modality": retencion.modality,
                    "request_sha256": huella,
                },
            )
    except IntegrityError as error:
        if _restriccion(error) == "service_booking_events_una_por_clave":
            raise ClaveReutilizada(details={"action": RETENCION_CREADA}) from None
        if _estado_sql(error) in ("23P01", "23505"):
            # Otra persona lo tomó a la vez: la base decidió.
            raise HorarioNoDisponible() from None
        raise
    return Retenido(retencion, creada=True)


async def _retencion_propia(db: AsyncSession, cliente_id: str, retencion_id: str, *, bloquear: bool = False) -> ServiceHold:
    """La retención de QUIEN PREGUNTA. Lo ajeno es un 404."""
    if not agenda_de_servicio._es_uuid(retencion_id):
        raise RetencionNoEncontrada()
    consulta = select(ServiceHold).where(ServiceHold.id == retencion_id).execution_options(populate_existing=True)
    if bloquear:
        consulta = consulta.with_for_update()
    retencion = await db.scalar(consulta)
    if retencion is None or retencion.client_id is None or retencion.client_id != cliente_id:
        raise RetencionNoEncontrada()
    return retencion


async def retencion(db: AsyncSession, *, cliente_id: str, retencion_id: str) -> ServiceHold:
    return await _retencion_propia(db, cliente_id, retencion_id)


async def reserva_de_la_retencion(db: AsyncSession, retencion_id: str) -> ServiceBooking | None:
    return await db.scalar(select(ServiceBooking).where(ServiceBooking.hold_id == retencion_id))


# --------------------------------------------------------------------------- #
# Soltar
# --------------------------------------------------------------------------- #
@sin_esperas_largas
async def liberar(
    db: AsyncSession, *, cliente_id: str, retencion_id: str, clave: str | None, ahora: datetime | None = None
) -> ServiceHold:
    """Suelta el horario. Soltar lo ya soltado (o lo vencido) es lo mismo:
    200. Lo ya reservado no se suelta aquí (409)."""
    clave = _exigir_clave(clave)
    ahora = ahora or _ahora()
    primera = await _retencion_propia(db, cliente_id, retencion_id)
    await _poner_en_fila(db, primera.service_id)
    fila = await _retencion_propia(db, cliente_id, retencion_id, bloquear=True)
    await _en_fila_la_persona(db, cliente_id)
    previo = await _por_clave(db, cliente_id, clave)
    if previo is not None:
        if previo.action != RETENCION_SOLTADA or previo.hold_id != fila.id:
            raise ClaveReutilizada(details={"action": previo.action})
        return fila
    if fila.status == RETENCION_CONSUMIDA:
        reserva = await reserva_de_la_retencion(db, fila.id)
        raise RetencionConsumida(details={"booking_id": reserva.id if reserva else None})
    if fila.status in (RETENCION_LIBERADA, RETENCION_VENCIDA):
        return fila
    if _utc(fila.expires_at) <= ahora:
        await _vencer(db, ServiceHold.id == fila.id, ahora=ahora)
        await db.refresh(fila)
        return fila
    fila.status = RETENCION_LIBERADA
    fila.released_at = ahora
    fila.updated_at = ahora
    await db.flush()
    await _anotar(
        db, servicio_id=fila.service_id, accion=RETENCION_SOLTADA, desde=RETENCION_ACTIVA, hasta=RETENCION_LIBERADA,
        ahora=ahora, retencion_id=fila.id, actor_id=cliente_id, clave=clave, detalles={"reason": "client"},
    )
    return fila


# --------------------------------------------------------------------------- #
# El resumen antes de confirmar
# --------------------------------------------------------------------------- #
@dataclass
class Resumen:
    retencion: ServiceHold
    estado: str
    version: ServiceVersion
    prestador: ServiceProvider
    forma: str
    version_vigente: bool
    condiciones: ServicePolicy | None
    condiciones_del_servicio: str | None
    huella_del_servicio: str | None
    pide_direccion: bool
    se_confirma_solo: bool
    cobro_disponible: bool
    reserva_id: str | None
    ahora: datetime


def _condiciones_del_servicio(version: ServiceVersion) -> tuple[str | None, str | None]:
    texto = version.conditions if (version.conditions or "").strip() else None
    return texto, (politicas.huella(texto) if texto else None)


async def _condiciones_de_z(db: AsyncSession, prestador: ServiceProvider) -> ServicePolicy | None:
    return await politicas.vigente(db, tipo=POLITICA_CONDICIONES_DE_CONTRATACION, pais=prestador.country_code)


async def resumen(db: AsyncSession, *, cliente_id: str, retencion_id: str, ahora: datetime | None = None) -> Resumen:
    """Lo que se va a contratar, con la fotografía de la retención y lo que
    hay que aceptar HOY. Solo lectura."""
    ahora = ahora or _ahora()
    fila = await _retencion_propia(db, cliente_id, retencion_id)
    version = await db.get(ServiceVersion, fila.version_id)
    servicio = await db.get(Service, fila.service_id)
    prestador = await db.get(ServiceProvider, servicio.provider_id) if servicio else None
    if version is None or prestador is None:  # pragma: no cover - la base no lo deja
        raise RetencionNoEncontrada()
    vigente = await catalogo.publicada(db, fila.service_id)
    texto, huella = _condiciones_del_servicio(version)
    politica = limites.Politica.de()
    reserva = await reserva_de_la_retencion(db, fila.id) if fila.status == RETENCION_CONSUMIDA else None
    return Resumen(
        retencion=fila,
        estado=estado_efectivo(fila, ahora),
        version=version,
        prestador=prestador,
        forma=forma_de_contratar(version),
        version_vigente=vigente is not None and vigente.id == version.id,
        condiciones=await _condiciones_de_z(db, prestador),
        condiciones_del_servicio=texto,
        huella_del_servicio=huella,
        pide_direccion=fila.modality == A_DOMICILIO,
        se_confirma_solo=fila.modality in politica.modalidades_inmediatas,
        cobro_disponible=limites.cobro_disponible(),
        reserva_id=reserva.id if reserva else None,
        ahora=ahora,
    )


# --------------------------------------------------------------------------- #
# Confirmar
# --------------------------------------------------------------------------- #
@dataclass
class Confirmado:
    reserva: ServiceBooking
    creada: bool


def _texto_opcional(valor: object, maximo: int, campo: str) -> str | None:
    if valor is None:
        return None
    if not isinstance(valor, str):
        raise DatosInvalidos(details={"field": campo})
    limpio = valor.strip()
    if not limpio:
        return None
    if len(limpio) > maximo:
        raise DatosInvalidos(details={"field": campo, "max": maximo})
    return limpio


def datos_de_la_atencion(modalidad: str, datos: dict) -> dict:
    """SOLO LO NECESARIO: una nota opcional y, A DOMICILIO, el distrito y la
    dirección (la referencia, opcional). En otra modalidad, una dirección es un
    error: no se guarda lo que no hace falta."""
    salida = {
        "note": _texto_opcional(datos.get("note"), limites.NOTA_MAXIMA, "note"),
        "district": _texto_opcional(datos.get("district"), limites.DISTRITO_MAXIMO, "district"),
        "address_line": _texto_opcional(datos.get("address_line"), limites.DIRECCION_MAXIMA, "address_line"),
        "address_reference": _texto_opcional(
            datos.get("address_reference"), limites.REFERENCIA_MAXIMA, "address_reference"
        ),
    }
    if modalidad == A_DOMICILIO:
        for campo in ("district", "address_line"):
            if salida[campo] is None:
                raise DatosInvalidos(details={"field": campo, "required": True})
    elif any(salida[c] for c in ("district", "address_line", "address_reference")):
        raise DatosInvalidos(details={"field": "address", "not_needed": True})
    return salida


def _codigo() -> str:
    letras = "".join(secrets.choice(limites.ALFABETO_DEL_CODIGO) for _ in range(8))
    return f"{letras[:4]}-{letras[4:]}"


async def horario_vigente(db: AsyncSession, fila: ServiceHold, vigente: ServiceVersion, *, ahora: datetime) -> None:
    """EL HORARIO de una retención, OTRA VEZ, con la agenda de AHORA y sin
    contarse a sí misma. La antelación y el horizonte se miden desde que se
    retuvo: un horario que se apartó a tiempo no caduca por los minutos que
    se tarda en leer. Lo usan confirmar y reprogramar."""
    agenda = await agenda_de_servicio.agenda_de(db, fila.service_id)
    servicio_calc = agenda_de_servicio._servicio_de(vigente)
    if agenda is None or agenda.status != AGENDA_ACTIVA or calc.zona(agenda.timezone) is None or servicio_calc is None:
        raise HorarioNoDisponible()
    politica_agenda = limites_de_la_agenda.Politica.de()
    datos_agenda = await agenda_de_servicio._datos(
        db, agenda, servicio_calc, ahora=ahora, politica=politica_agenda, excepto=fila.id
    )
    desde, hasta = calc.ventana(_utc(fila.created_at), politica_agenda)
    horario = _slot(datos_agenda, _utc(fila.starts_at), desde=desde, hasta=hasta)
    if (
        horario is None
        or horario.fin != _utc(fila.ends_at)
        or servicio_calc.modalidad != fila.modality
        or horario.ocupadas >= horario.capacidad
    ):
        raise HorarioNoDisponible()


@sin_esperas_largas
async def confirmar(
    db: AsyncSession,
    *,
    cliente_id: str,
    retencion_id: str,
    datos: dict,
    clave: str | None,
    ahora: datetime | None = None,
) -> Confirmado:
    """CONTRATA. Todo se vuelve a comprobar, en fila con el servicio: la
    retención (suya, activa y a tiempo), el servicio (público para esa
    persona), la versión (la misma que retuvo), el precio (hoy, solo gratis),
    la modalidad (se confirma sola), las condiciones (las vigentes, por su
    huella), los datos y EL HORARIO (el cálculo de la agenda, sin contarse a sí
    misma). Nacen juntos el pedido, la reserva, lo aceptado y el historial."""
    clave = _exigir_clave(clave)
    ahora = ahora or _ahora()
    primera = await _retencion_propia(db, cliente_id, retencion_id)
    huella = _huella({"hold_id": primera.id, **{k: datos.get(k) for k in sorted(datos)}})
    await _poner_en_fila(db, primera.service_id)
    fila = await _retencion_propia(db, cliente_id, retencion_id, bloquear=True)
    # La misma clave a la vez en OTRA retención (de otro servicio) no comparte
    # ninguno de los cerrojos de arriba: sin este, las dos escribían su línea y
    # la segunda chocaba con el índice único (un 500).
    await _en_fila_la_persona(db, cliente_id)

    previo = await _por_clave(db, cliente_id, clave)
    if previo is not None:
        if (
            previo.action != RESERVA_CONFIRMADA_EVENTO
            or previo.hold_id != fila.id
            or (previo.details or {}).get("request_sha256") != huella
        ):
            raise ClaveReutilizada(details={"action": previo.action})
        return Confirmado(await db.get(ServiceBooking, previo.booking_id, populate_existing=True), creada=False)

    if fila.status == RETENCION_CONSUMIDA:
        reserva = await reserva_de_la_retencion(db, fila.id)
        raise RetencionConsumida(details={"booking_id": reserva.id if reserva else None})
    if fila.status == RETENCION_LIBERADA:
        raise RetencionNoActiva()
    if fila.status == RETENCION_VENCIDA or _utc(fila.expires_at) <= ahora:
        raise RetencionVencida()
    # LO QUE YA EMPEZÓ NO SE CONTRATA, aunque la retención siga viva: la
    # ventana del horario se mide desde que se retuvo y, con una antelación
    # menor que los minutos de la retención, seguiría dentro.
    if _utc(fila.starts_at) <= ahora:
        raise HorarioNoDisponible()

    try:
        servicio, vigente, prestador, _ = await descubrimiento.publico(db, fila.service_id, mira=cliente_id)
    except descubrimiento.ServicioNoPublico:
        raise ServicioNoDisponible() from None
    if prestador.profile_id == cliente_id:  # pragma: no cover - retener ya lo impide
        raise ServicioPropio()
    if vigente.id != fila.version_id:
        raise VersionCambiada()

    forma = forma_de_contratar(vigente)
    if forma == CONTRATA_A_CONSULTAR:
        raise PropuestaRequerida()
    if forma == CONTRATA_PRECIO_ABIERTO:
        raise PrecioNoCerrado()
    if forma != CONTRATA_GRATIS:
        # SIN COBRO NO HAY CONTRATACIÓN DE PAGO, y no se finge ninguna: ni
        # pedido, ni reserva, ni un «pagado». La retención vence sola (o la
        # suelta la app). Aunque las banderas se encendieran, no hay adaptador
        # y la 0093 solo admite pedidos gratuitos.
        raise PagosNoConfigurados(details={"payments_available": limites.cobro_disponible()})
    politica = limites.Politica.de()
    if fila.modality not in politica.modalidades_inmediatas:
        raise ConfirmacionDelPrestador(details={"modality": fila.modality})

    atencion = datos_de_la_atencion(fila.modality, datos)
    condiciones = await _condiciones_de_z(db, prestador)
    if condiciones is None:
        raise CondicionesNoPublicadas()
    if datos.get("terms_policy_id") != condiciones.id or datos.get("terms_sha256") != condiciones.body_sha256:
        raise CondicionesCambiadas(
            details={"kind": ACEPTA_CONDICIONES_DE_Z, "policy_id": condiciones.id, "version": condiciones.version}
        )
    texto_del_servicio, huella_del_servicio = _condiciones_del_servicio(vigente)
    if huella_del_servicio is not None and datos.get("service_conditions_sha256") != huella_del_servicio:
        raise CondicionesCambiadas(details={"kind": ACEPTA_CONDICIONES_DEL_SERVICIO})

    await horario_vigente(db, fila, vigente, ahora=ahora)

    nombre = (prestador.display_name or "").strip() or "—"
    titulo = (vigente.title or "").strip() or "—"
    pedido = ServiceOrder(
        service_id=fila.service_id,
        version_id=vigente.id,
        provider_id=prestador.id,
        client_id=cliente_id,
        status=PEDIDO_CONFIRMADO,
        payment_status=PAGO_NO_REQUERIDO,
        payment_provider=PASARELA_NINGUNA,
        environment=get_settings().payments_environment,
        price_model=vigente.price_model,
        price_minor=None,
        currency=None,
        total_minor=0,
        title_snapshot=titulo,
        provider_name_snapshot=nombre,
        created_at=ahora,
        confirmed_at=ahora,
    )
    db.add(pedido)
    await db.flush()
    reserva = None
    for _ in range(5):
        candidata = ServiceBooking(
            booking_code=_codigo(),
            order_id=pedido.id,
            hold_id=fila.id,
            service_id=fila.service_id,
            version_id=vigente.id,
            provider_id=prestador.id,
            client_id=cliente_id,
            status=RESERVA_CONFIRMADA,
            starts_at=fila.starts_at,
            ends_at=fila.ends_at,
            occupied_from=fila.occupied_from,
            occupied_until=fila.occupied_until,
            timezone=fila.timezone,
            local_date=fila.local_date,
            modality=fila.modality,
            duration_minutes=int(vigente.duration_minutes),
            buffer_before_minutes=int((_utc(fila.starts_at) - _utc(fila.occupied_from)).total_seconds() // 60),
            buffer_after_minutes=int((_utc(fila.occupied_until) - _utc(fila.ends_at)).total_seconds() // 60),
            capacity=fila.capacity,
            seat=fila.seat,
            title_snapshot=titulo,
            provider_name_snapshot=nombre,
            location_area_snapshot=(vigente.location_area or "").strip() or None,
            created_at=ahora,
            confirmed_at=ahora,
        )
        try:
            async with db.begin_nested():
                db.add(candidata)
                await db.flush()
            reserva = candidata
            break
        except IntegrityError as error:
            if _restriccion(error) != "service_bookings_codigo_unico":
                raise
    if reserva is None:  # pragma: no cover - 32^8 códigos
        raise Ocupado()

    if atencion["note"] or atencion["address_line"]:
        db.add(ServiceBookingIntake(booking_id=reserva.id, client_id=cliente_id, created_at=ahora, **atencion))
    db.add(
        ServiceBookingAcceptance(
            order_id=pedido.id, kind=ACEPTA_CONDICIONES_DE_Z, policy_id=condiciones.id,
            policy_version=condiciones.version, sha256=condiciones.body_sha256,
            accepted_by=cliente_id, accepted_at=ahora,
        )
    )
    if huella_del_servicio is not None:
        db.add(
            ServiceBookingAcceptance(
                order_id=pedido.id, kind=ACEPTA_CONDICIONES_DEL_SERVICIO, version_id=vigente.id,
                sha256=huella_del_servicio, accepted_by=cliente_id, accepted_at=ahora,
            )
        )
    fila.status = RETENCION_CONSUMIDA
    fila.consumed_at = ahora
    fila.updated_at = ahora
    await db.flush()
    evento = await _anotar(
        db, servicio_id=fila.service_id, accion=RESERVA_CONFIRMADA_EVENTO, desde=RETENCION_ACTIVA,
        hasta=RESERVA_CONFIRMADA, ahora=ahora, retencion_id=fila.id, reserva_id=reserva.id,
        actor_id=cliente_id, clave=clave,
        detalles={
            "booking_code": reserva.booking_code, "order_id": pedido.id, "price_model": pedido.price_model,
            "payment_status": pedido.payment_status, "terms_version": condiciones.version,
            "request_sha256": huella,
        },
    )
    # LOS AVISOS: el hecho, sin la dirección ni la nota. Un fallo no deshace
    # la reserva (cada aviso va en su propio savepoint).
    await avisos.avisar(
        db, usuario_id=cliente_id, tipo=avisos.RESERVA_CONFIRMADA, solicitud_id=reserva.id,
        suceso_id=evento.id, entidad=avisos.ENTIDAD_RESERVA,
    )
    await avisos.avisar(
        db, usuario_id=prestador.profile_id, tipo=avisos.RESERVA_RECIBIDA, solicitud_id=reserva.id,
        suceso_id=evento.id, entidad=avisos.ENTIDAD_RESERVA,
    )
    return Confirmado(reserva, creada=True)


# --------------------------------------------------------------------------- #
# Consultar
# --------------------------------------------------------------------------- #
POR_VENIR = "upcoming"
PASADAS = "past"
AMBITOS = (POR_VENIR, PASADAS)


@dataclass
class Pagina:
    reservas: list[ServiceBooking]
    siguiente: str | None


def _cursor_de(reserva: ServiceBooking) -> str:
    return f"{_utc(reserva.starts_at).isoformat()}|{reserva.id}"


def _leer_cursor(cursor: str | None) -> tuple[datetime, str] | None:
    if not cursor:
        return None
    try:
        momento, ident = cursor.split("|", 1)
        instante = datetime.fromisoformat(momento)
    except ValueError:
        raise CursorInvalido() from None
    if instante.tzinfo is None or not agenda_de_servicio._es_uuid(ident):
        raise CursorInvalido()
    return instante, ident


async def _pagina(
    db: AsyncSession, filtro, *, ambito: str, cursor: str | None, limite: int, ahora: datetime
) -> Pagina:
    if ambito not in AMBITOS:
        raise DatosInvalidos(details={"field": "scope"})
    limite = max(1, min(int(limite), limites.RESERVAS_MAXIMAS_POR_PAGINA))
    consulta = select(ServiceBooking).where(filtro)
    punto = _leer_cursor(cursor)
    # POR VENIR es lo confirmado que todavía no terminó; lo cancelado (0094)
    # y lo terminado son PASADAS.
    if ambito == POR_VENIR:
        consulta = consulta.where(ServiceBooking.ends_at > ahora, ServiceBooking.status == RESERVA_CONFIRMADA)
        if punto:
            consulta = consulta.where(
                or_(ServiceBooking.starts_at > punto[0],
                    and_(ServiceBooking.starts_at == punto[0], ServiceBooking.id > punto[1]))
            )
        consulta = consulta.order_by(ServiceBooking.starts_at, ServiceBooking.id)
    else:
        consulta = consulta.where(
            or_(ServiceBooking.ends_at <= ahora, ServiceBooking.status != RESERVA_CONFIRMADA)
        )
        if punto:
            consulta = consulta.where(
                or_(ServiceBooking.starts_at < punto[0],
                    and_(ServiceBooking.starts_at == punto[0], ServiceBooking.id < punto[1]))
            )
        consulta = consulta.order_by(ServiceBooking.starts_at.desc(), ServiceBooking.id.desc())
    filas = list(await db.scalars(consulta.limit(limite + 1)))
    siguiente = _cursor_de(filas[limite - 1]) if len(filas) > limite else None
    return Pagina(filas[:limite], siguiente)


async def mis_reservas(
    db: AsyncSession, *, cliente_id: str, ambito: str, cursor: str | None, limite: int, ahora: datetime | None = None
) -> Pagina:
    return await _pagina(
        db, ServiceBooking.client_id == cliente_id, ambito=ambito, cursor=cursor, limite=limite,
        ahora=ahora or _ahora(),
    )


async def _prestador_de(db: AsyncSession, usuario_id: str) -> ServiceProvider | None:
    return await admision_service.prestador_de(db, usuario_id)


async def reservas_del_prestador(
    db: AsyncSession, *, usuario_id: str, ambito: str, cursor: str | None, limite: int, ahora: datetime | None = None
) -> Pagina:
    """Las reservas de los servicios de quien pregunta. Sin ser prestador, ninguna."""
    prestador = await _prestador_de(db, usuario_id)
    if prestador is None:
        _leer_cursor(cursor)
        return Pagina([], None)
    return await _pagina(
        db, ServiceBooking.provider_id == prestador.id, ambito=ambito, cursor=cursor, limite=limite,
        ahora=ahora or _ahora(),
    )


@dataclass
class Detalle:
    reserva: ServiceBooking
    pedido: ServiceOrder
    atencion: ServiceBookingIntake | None
    aceptaciones: list[ServiceBookingAcceptance]
    historial: list[ServiceBookingEvent]
    cliente: object | None = None
    extra: dict = field(default_factory=dict)


async def _detalle(db: AsyncSession, reserva: ServiceBooking) -> Detalle:
    pedido = await db.get(ServiceOrder, reserva.order_id)
    atencion = await db.get(ServiceBookingIntake, reserva.id)
    aceptaciones = list(
        await db.scalars(
            select(ServiceBookingAcceptance)
            .where(ServiceBookingAcceptance.order_id == reserva.order_id)
            .order_by(ServiceBookingAcceptance.kind)
        )
    )
    historial = list(
        await db.scalars(
            select(ServiceBookingEvent)
            .where(or_(ServiceBookingEvent.booking_id == reserva.id, ServiceBookingEvent.hold_id == reserva.hold_id))
            .order_by(ServiceBookingEvent.created_at, ServiceBookingEvent.id)
        )
    )
    return Detalle(reserva, pedido, atencion, aceptaciones, historial)


async def mi_reserva(db: AsyncSession, *, cliente_id: str, reserva_id: str) -> Detalle:
    """La reserva de QUIEN PREGUNTA. Lo ajeno es un 404."""
    reserva = await db.get(ServiceBooking, reserva_id) if agenda_de_servicio._es_uuid(reserva_id) else None
    if reserva is None or reserva.client_id is None or reserva.client_id != cliente_id:
        raise ReservaNoEncontrada()
    return await _detalle(db, reserva)


async def reserva_del_prestador(db: AsyncSession, *, usuario_id: str, reserva_id: str) -> Detalle:
    """La reserva de un servicio PROPIO, con lo que la atención necesita. Lo
    ajeno es un 404."""
    prestador = await _prestador_de(db, usuario_id)
    reserva = await db.get(ServiceBooking, reserva_id) if agenda_de_servicio._es_uuid(reserva_id) else None
    if prestador is None or reserva is None or reserva.provider_id != prestador.id:
        raise ReservaNoEncontrada()
    detalle = await _detalle(db, reserva)
    if reserva.client_id is not None:
        from app.modules.profiles.models import Profile

        detalle.cliente = await db.get(Profile, reserva.client_id)
    return detalle


# --------------------------------------------------------------------------- #
# Administración
# --------------------------------------------------------------------------- #
@dataclass
class PaginaDeRetenciones:
    retenciones: list[ServiceHold]
    siguiente: str | None


async def retenciones_para_administrar(
    db: AsyncSession, *, estado: str | None, cursor: str | None, limite: int, ahora: datetime | None = None
) -> PaginaDeRetenciones:
    """Consulta operativa: las retenciones, las más recientes primero. Sin
    datos de la persona más allá de su identificador."""
    ahora = ahora or _ahora()
    limite = max(1, min(int(limite), limites.RESERVAS_MAXIMAS_POR_PAGINA))
    consulta = select(ServiceHold)
    if estado == RETENCION_VENCIDA:
        consulta = consulta.where(
            or_(ServiceHold.status == RETENCION_VENCIDA,
                and_(ServiceHold.status == RETENCION_ACTIVA, ServiceHold.expires_at <= ahora))
        )
    elif estado == RETENCION_ACTIVA:
        consulta = consulta.where(ServiceHold.status == RETENCION_ACTIVA, ServiceHold.expires_at > ahora)
    elif estado is not None:
        if estado not in (RETENCION_CONSUMIDA, RETENCION_LIBERADA):
            raise DatosInvalidos(details={"field": "status"})
        consulta = consulta.where(ServiceHold.status == estado)
    punto = _leer_cursor(cursor)
    if punto:
        consulta = consulta.where(
            or_(ServiceHold.created_at < punto[0],
                and_(ServiceHold.created_at == punto[0], ServiceHold.id < punto[1]))
        )
    filas = list(
        await db.scalars(consulta.order_by(ServiceHold.created_at.desc(), ServiceHold.id.desc()).limit(limite + 1))
    )
    siguiente = None
    if len(filas) > limite:
        ultima = filas[limite - 1]
        siguiente = f"{_utc(ultima.created_at).isoformat()}|{ultima.id}"
    return PaginaDeRetenciones(filas[:limite], siguiente)


async def reservas_para_administrar(
    db: AsyncSession, *, ambito: str, cursor: str | None, limite: int, ahora: datetime | None = None
) -> Pagina:
    return await _pagina(db, true(), ambito=ambito, cursor=cursor, limite=limite, ahora=ahora or _ahora())


@sin_esperas_largas
async def vencer_retenciones(db: AsyncSession, *, lote: int | None = None, ahora: datetime | None = None) -> int:
    """EL BARRIDO: marca vencidas, por lotes, las activas cuyo plazo pasó.
    Idempotente (una vencida no se toca dos veces) y sin esperar a nadie (lo
    que otra transacción tiene bloqueado se salta y queda para la próxima).
    NO ES LA AUTORIDAD: el vencimiento ya lo decide la hora."""
    lote = max(1, min(int(lote or limites.LOTE_DEL_BARRIDO), limites.LOTE_MAXIMO_DEL_BARRIDO))
    return await _vencer(db, true(), ahora=ahora or _ahora(), lote=lote)


__all__ = [
    "AMBITOS",
    "CONTRATA_A_CONSULTAR",
    "CONTRATA_CON_PAGO",
    "CONTRATA_GRATIS",
    "CONTRATA_PRECIO_ABIERTO",
    "ClaveRequerida",
    "CondicionesCambiadas",
    "CondicionesNoPublicadas",
    "ConfirmacionDelPrestador",
    "Confirmado",
    "DatosInvalidos",
    "Detalle",
    "HorarioNoDisponible",
    "LimiteDeRetenciones",
    "Ocupado",
    "PASADAS",
    "POR_VENIR",
    "Pagina",
    "PagosNoConfigurados",
    "PrecioNoCerrado",
    "PropuestaRequerida",
    "ReservaNoEncontrada",
    "Resumen",
    "RetencionConsumida",
    "RetencionInvalida",
    "RetencionNoActiva",
    "RetencionNoEncontrada",
    "RetencionVencida",
    "RetencionYaActiva",
    "Retenido",
    "ServicioNoDisponible",
    "ServicioPropio",
    "VersionCambiada",
    "confirmar",
    "datos_de_la_atencion",
    "estado_efectivo",
    "forma_de_contratar",
    "liberar",
    "mi_reserva",
    "mis_reservas",
    "reserva_del_prestador",
    "reservas_del_prestador",
    "reservas_para_administrar",
    "resumen",
    "retencion",
    "retenciones_para_administrar",
    "retener",
    "se_puede_apartar",
    "vencer_retenciones",
]
