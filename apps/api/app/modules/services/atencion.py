"""La atención de una reserva de Servicios (Incremento 6).

Lo que le pasa a una reserva DESPUÉS de confirmarse: cancelarla, cambiarla de
horario, llegar, empezar, terminar, confirmar que se hizo, decir que alguien
no vino, y los dos barridos (recordar y cerrar lo que ya se puede cerrar).

UNA SOLA AUTORIDAD: cada salto tiene aquí su función, su actor, su momento, su
línea en el historial (`service_booking_events`, el mismo de la reserva) y su
`Idempotency-Key`. Nadie cambia un estado por otra vía. Y la BASE (0094)
impone lo crítico: una reserva solo se cancela o se reprograma si la atención
no empezó, una cancelada no sigue ocupando su horario, una reprogramada no
ocupa el anterior, `closed` es final.

`acciones_disponibles` es la ÚNICA lista de lo que se puede hacer: la API la
manda en cada detalle y la app solo enseña eso. Cada transición vuelve a
comprobar lo mismo, con los mismos datos.

ORDEN DE LOS CERROJOS, el de la reserva y siempre el mismo: la fila del
servicio (FOR NO KEY UPDATE), la de la reserva (FOR NO KEY UPDATE: no choca
con la clave ajena de quien escribe una fila que apunta a ella), las
retenciones y, al final, el cerrojo de la persona (su clave de idempotencia).

EL DINERO NO SE MUEVE. Una reserva solo puede ser gratuita (0093); cancelar o
reportar una ausencia deja escrito que su efecto económico «no aplica».
`estado_del_efecto` es la única función que lo decide, y ningún estado que
devuelve dice que algo se ejecutó.

LOS PLAZOS son provisionales y configurables (`reserva_politica`): ninguno es
una decisión tomada aquí.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from sqlalchemy import and_, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.exceptions import ConflictError, ValidationAppError
from app.modules.services import avisos, descubrimiento
from app.modules.services import reserva as reserva_dominio
from app.modules.services import reserva_politica as limites
from app.modules.services.admision import ClaveReutilizada
from app.modules.services.agenda import _es_uuid
from app.modules.services.atencion_models import (
    AUSENTE_EL_CLIENTE,
    AUSENTE_EL_PRESTADOR,
    CASOS_VIVOS,
    CASO_EN_CURSO,
    CASO_RESUELTO,
    CASO_RETIRADO,
    CERRADA,
    CON_CODIGO,
    EFECTO_BLOQUEADO,
    EFECTO_NO_APLICA,
    EFECTO_PENDIENTE,
    EN_CURSO,
    RESENA_PUBLICADA,
    SIN_EFECTO,
    TERMINADA,
    ServiceAttendance,
    ServiceIncident,
    ServiceReview,
)
from app.modules.services.models import PRESTADOR_ACTIVO, ServiceProvider
from app.modules.services.reserva_models import (
    ADMINISTRACION,
    ATENCION_CERRADA_EVENTO,
    ATENCION_CONFIRMADA,
    ATENCION_INICIADA,
    ATENCION_TERMINADA_EVENTO,
    AUSENCIA_REPORTADA,
    CLIENTE,
    CODIGO_EMITIDO,
    PAGO_NO_REQUERIDO,
    PRESTADOR,
    RESERVA_CANCELADA,
    RESERVA_CANCELADA_EVENTO,
    RESERVA_CONFIRMADA,
    RESERVA_RECORDADA,
    RESERVA_REPROGRAMADA,
    RETENCION_ACTIVA,
    RETENCION_CONSUMIDA,
    RETENCION_LIBERADA,
    SISTEMA,
    ServiceBooking,
    ServiceBookingEvent,
    ServiceHold,
    ServiceOrder,
)

_utc = reserva_dominio._utc
_ahora = reserva_dominio._ahora
ReservaNoEncontrada = reserva_dominio.ReservaNoEncontrada

#: Los motivos de una cancelación: estables, sin textos jurídicos.
MOTIVOS_DE_CANCELACION = ("change_of_plans", "unavailable", "operational", "other")

# Las acciones, con el nombre que viaja en `available_actions`.
CANCELAR = "cancel"
REPROGRAMAR = "reschedule"
PEDIR_CODIGO = "issue_code"
INICIAR = "start"
TERMINAR = "complete"
CONFIRMAR = "confirm"
REPORTAR_AUSENCIA = "report_absence"
ABRIR_CASO = "open_incident"
ESCRIBIR_EN_EL_CASO = "add_incident_entry"
RETIRAR_EL_CASO = "withdraw_incident"
APELAR = "appeal_incident"
RESENAR = "review"
RESPONDER_RESENA = "reply_review"


# --------------------------------------------------------------------------- #
# Errores (códigos estables; la app los traduce)
# --------------------------------------------------------------------------- #
class ReservaYaCancelada(ConflictError):
    code = "service_booking_already_cancelled"
    message = "Esta reserva ya estaba cancelada."


class AccionNoDisponible(ConflictError):
    """La acción no corresponde al estado o al momento de la reserva."""

    code = "service_booking_action_not_available"
    message = "Esa acción ya no está disponible para esta reserva."


class ReprogramacionTardia(ConflictError):
    code = "service_booking_reschedule_too_late"
    message = "Ya no hay tiempo para cambiar el horario de esta reserva."


class ReprogramacionAgotada(ConflictError):
    code = "service_booking_reschedule_limit"
    message = "Esta reserva ya no admite más cambios de horario."


class MotivoRequerido(ValidationAppError):
    code = "service_booking_reason_required"
    message = "Indica el motivo."


class FueraDeLaVentana(ConflictError):
    code = "service_attention_not_in_window"
    message = "Todavía no es el momento, o ya pasó."


class CodigoIncorrecto(ConflictError):
    code = "service_attention_code_invalid"
    message = "Ese código no es el de esta reserva."


class CodigoBloqueado(ConflictError):
    code = "service_attention_code_blocked"
    message = "Demasiados intentos con el código."


class CasoAbierto(ConflictError):
    code = "service_attention_incident_open"
    message = "Hay un caso abierto sobre esta atención."


class PrestadorSuspendido(ConflictError):
    code = "service_attention_provider_not_active"
    message = "Tu cuenta de prestador no está activa."


# --------------------------------------------------------------------------- #
# El dinero: lo que se solicita y su estado. Nunca «ejecutado».
# --------------------------------------------------------------------------- #
def estado_del_efecto(pedido: ServiceOrder | None, efecto: str) -> str:
    """En qué queda un efecto económico SOLICITADO sobre un pedido.

      * sin efecto, o sin nada cobrado (lo único que existe hoy): «no aplica»;
      * con dinero y sin cobro disponible (banderas, pasarela o adaptador):
        «bloqueado»;
      * con dinero y cobro disponible: «pendiente», a la espera del adaptador.

    NINGUNO DICE QUE SE EJECUTÓ: eso solo podrá decirlo una pasarela."""
    if efecto == SIN_EFECTO or pedido is None:
        return EFECTO_NO_APLICA
    if pedido.payment_status == PAGO_NO_REQUERIDO or int(pedido.total_minor or 0) <= 0:
        return EFECTO_NO_APLICA
    return EFECTO_PENDIENTE if limites.cobro_disponible() else EFECTO_BLOQUEADO


# --------------------------------------------------------------------------- #
# Lo que se puede hacer: UNA lista, calculada aquí
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Plazos:
    """Los momentos de una reserva, con la política de ahora."""

    llegada_desde: datetime
    ausencia_desde: datetime
    reprogramar_hasta: datetime
    #: Hasta cuándo se abre un caso por un motivo ordinario (los de seguridad
    #: no tienen plazo), y hasta cuándo se reseña (`None` si no está cerrada).
    caso_hasta: datetime
    resena_hasta: datetime | None
    apelar_hasta: datetime | None


def plazos(
    reserva: ServiceBooking,
    atencion: ServiceAttendance | None,
    caso: ServiceIncident | None,
    politica: limites.PoliticaDeAtencion,
) -> Plazos:
    inicio, fin = _utc(reserva.starts_at), _utc(reserva.ends_at)
    terminada = max(fin, _utc(atencion.completed_at)) if atencion and atencion.completed_at else fin
    cerrada = _utc(atencion.closed_at) if atencion and atencion.closed_at else None
    resuelta = _utc(caso.resolved_at) if caso is not None and caso.resolved_at else None
    return Plazos(
        llegada_desde=inicio - timedelta(minutes=politica.llegada_minutos),
        ausencia_desde=inicio + timedelta(minutes=politica.tolerancia_minutos),
        reprogramar_hasta=inicio - timedelta(hours=politica.reprogramar_horas_antes),
        caso_hasta=terminada + timedelta(hours=politica.caso_horas),
        resena_hasta=cerrada + timedelta(days=politica.resena_dias) if cerrada else None,
        apelar_hasta=resuelta + timedelta(days=politica.apelacion_dias) if resuelta else None,
    )


def acciones_disponibles(
    *,
    rol: str,
    usuario_id: str,
    reserva: ServiceBooking,
    atencion: ServiceAttendance | None,
    caso: ServiceIncident | None,
    resena: ServiceReview | None,
    ahora: datetime,
    politica: limites.PoliticaDeAtencion,
    reprogramaciones: int,
    version_vigente: str | None,
    prestador_activo: bool,
    retiro_el_suyo: bool = False,
    hay_otro_decisor: bool = True,
) -> list[str]:
    """LO QUE ESA PERSONA PUEDE HACER AHORA con esa reserva. Las transiciones
    comprueban exactamente esto: lo que no está aquí, el servidor lo rechaza.

    `caso` es EL de la reserva (`caso_de`): el vivo o el decidido y, si no
    hay, el último retirado. Un caso retirado no impide abrir otro, salvo a
    quien retiró el suyo (`retiro_el_suyo`). Y apelar solo se ofrece si en
    administración hay OTRA persona que pueda resolverlo (`hay_otro_decisor`):
    quien resolvió no resuelve su apelación."""
    inicio, fin = _utc(reserva.starts_at), _utc(reserva.ends_at)
    p = plazos(reserva, atencion, caso, politica)
    confirmada = reserva.status == RESERVA_CONFIRMADA
    estado = atencion.status if atencion is not None else None
    sin_empezar = estado in (None, CON_CODIGO)
    caso_vivo = caso is not None and caso.status in CASOS_VIVOS
    acciones: list[str] = []

    if confirmada and sin_empezar and ahora < inicio:
        acciones.append(CANCELAR)
    if confirmada and sin_empezar and ahora >= p.ausencia_desde and ahora <= p.caso_hasta:
        acciones.append(REPORTAR_AUSENCIA)
    sin_caso = caso is None or caso.status == CASO_RETIRADO
    if confirmada and sin_caso and not retiro_el_suyo and ahora >= inicio:
        acciones.append(ABRIR_CASO)
    if caso_vivo:
        acciones.append(ESCRIBIR_EN_EL_CASO)
    if caso is not None and caso.status == CASO_EN_CURSO and caso.opened_by == usuario_id:
        acciones.append(RETIRAR_EL_CASO)
    if (
        caso is not None and caso.status == CASO_RESUELTO and caso.resolutions == 1
        and politica.apelaciones >= 1 and hay_otro_decisor
        and p.apelar_hasta is not None and ahora <= p.apelar_hasta
    ):
        acciones.append(APELAR)

    if rol == CLIENTE:
        if (
            confirmada and sin_empezar and ahora <= p.reprogramar_hasta
            and reprogramaciones < politica.reprogramaciones
            and version_vigente is not None and version_vigente == reserva.version_id
        ):
            acciones.append(REPROGRAMAR)
        if confirmada and sin_empezar and p.llegada_desde <= ahora <= fin:
            acciones.append(PEDIR_CODIGO)
        if confirmada and estado in (EN_CURSO, TERMINADA) and not caso_vivo:
            acciones.append(CONFIRMAR)
        if (
            confirmada and estado == CERRADA and resena is None
            and p.resena_hasta is not None and ahora <= p.resena_hasta
        ):
            acciones.append(RESENAR)
    elif rol == PRESTADOR:
        if confirmada and sin_empezar and prestador_activo and p.llegada_desde <= ahora <= fin:
            acciones.append(INICIAR)
        if confirmada and estado == EN_CURSO:
            acciones.append(TERMINAR)
        if resena is not None and resena.status == RESENA_PUBLICADA and resena.reply is None:
            acciones.append(RESPONDER_RESENA)
    return acciones


# --------------------------------------------------------------------------- #
# Lo que se enseña de la atención en el detalle de una reserva
# --------------------------------------------------------------------------- #
@dataclass
class Cuidado:
    rol: str
    acciones: list[str]
    atencion: ServiceAttendance | None
    caso: ServiceIncident | None
    resena: ServiceReview | None
    plazos: Plazos
    politica: limites.PoliticaDeAtencion
    reprogramaciones: int
    #: La cancelación y los cambios de horario, leídos del historial.
    cancelacion: ServiceBookingEvent | None
    cambios: list[ServiceBookingEvent] = field(default_factory=list)
    efecto: str = EFECTO_NO_APLICA
    #: El plazo ordinario para abrir un caso ya pasó (solo queda el de seguridad).
    caso_fuera_de_plazo: bool = False


async def caso_de(db: AsyncSession, reserva_id: str) -> ServiceIncident | None:
    """EL caso de una reserva: el vivo o el decidido (la base no admite más
    de uno) y, si no hay ninguno, el último retirado."""
    return await db.scalar(
        select(ServiceIncident).where(ServiceIncident.booking_id == reserva_id)
        .order_by(ServiceIncident.status == CASO_RETIRADO, ServiceIncident.created_at.desc(),
                  ServiceIncident.id.desc())
        .limit(1).execution_options(populate_existing=True)
    )


async def retiro_el_suyo(db: AsyncSession, reserva_id: str, usuario_id: str) -> bool:
    """¿Esa persona ya abrió y retiró un caso de esta reserva? Entonces no
    abre otro (como mucho hay dos casos por reserva, uno retirado por cada
    parte). A LA OTRA PARTE no le afecta: conserva el suyo."""
    return bool(
        await db.scalar(
            select(func.count()).select_from(ServiceIncident)
            .where(ServiceIncident.booking_id == reserva_id, ServiceIncident.status == CASO_RETIRADO,
                   ServiceIncident.opened_by == usuario_id)
        )
    )


async def hay_otro_decisor(
    db: AsyncSession, reserva: ServiceBooking, prestador: ServiceProvider | None, caso: ServiceIncident
) -> bool:
    """¿Hay en administración alguien que pueda resolver una apelación de
    este caso? Ni quien lo resolvió ni quien es parte. Si no hay nadie, la
    apelación no se ofrece: sería un caso vivo que nadie puede cerrar."""
    from app.modules.profiles.models import Profile
    from app.modules.services.permissions import ROLES_QUE_DECIDEN

    fuera = [x for x in (caso.resolved_by, reserva.client_id, prestador.profile_id if prestador else None) if x]
    return bool(
        await db.scalar(
            select(func.count()).select_from(Profile)
            .where(Profile.role.in_(tuple(ROLES_QUE_DECIDEN)), Profile.id.not_in(fuera))
        )
    )


async def _version_vigente(db: AsyncSession, reserva: ServiceBooking) -> str | None:
    """La versión publicada del servicio HOY, si sigue siendo público para
    quien contrató. `None` si ya no lo es (y entonces no se reprograma)."""
    try:
        _, vigente, _, _ = await descubrimiento.publico(db, reserva.service_id, mira=reserva.client_id)
    except descubrimiento.ServicioNoPublico:
        return None
    return vigente.id


async def _sucesos(db: AsyncSession, reserva_id: str, accion: str) -> list[ServiceBookingEvent]:
    return list(
        await db.scalars(
            select(ServiceBookingEvent)
            .where(ServiceBookingEvent.booking_id == reserva_id, ServiceBookingEvent.action == accion)
            .order_by(ServiceBookingEvent.created_at, ServiceBookingEvent.id)
        )
    )


async def cuidado(
    db: AsyncSession,
    reserva: ServiceBooking,
    *,
    rol: str,
    usuario_id: str,
    prestador: ServiceProvider | None = None,
    ahora: datetime | None = None,
) -> Cuidado:
    """Todo lo de la atención de una reserva, para quien la mira."""
    ahora = ahora or _ahora()
    politica = limites.PoliticaDeAtencion.de()
    atencion = await db.get(ServiceAttendance, reserva.id)
    caso = await caso_de(db, reserva.id)
    resena = await db.scalar(select(ServiceReview).where(ServiceReview.booking_id == reserva.id))
    cambios = await _sucesos(db, reserva.id, RESERVA_REPROGRAMADA)
    cancelaciones = await _sucesos(db, reserva.id, RESERVA_CANCELADA_EVENTO)
    if prestador is None:
        prestador = await db.get(ServiceProvider, reserva.provider_id)
    vigente = await _version_vigente(db, reserva) if rol == CLIENTE and reserva.status == RESERVA_CONFIRMADA else None
    pedido = await db.get(ServiceOrder, reserva.order_id)
    # Solo se pregunta lo que puede cambiar la respuesta.
    retirado = caso is not None and caso.status == CASO_RETIRADO and await retiro_el_suyo(db, reserva.id, usuario_id)
    apelable = caso is not None and caso.status == CASO_RESUELTO and int(caso.resolutions) == 1
    otro = await hay_otro_decisor(db, reserva, prestador, caso) if apelable else False
    los_plazos = plazos(reserva, atencion, caso, politica)
    return Cuidado(
        rol=rol,
        acciones=acciones_disponibles(
            rol=rol, usuario_id=usuario_id, reserva=reserva, atencion=atencion, caso=caso, resena=resena,
            ahora=ahora, politica=politica, reprogramaciones=len(cambios), version_vigente=vigente,
            prestador_activo=prestador is not None and prestador.status == PRESTADOR_ACTIVO,
            retiro_el_suyo=retirado, hay_otro_decisor=otro,
        ),
        atencion=atencion, caso=caso, resena=resena, plazos=los_plazos,
        caso_fuera_de_plazo=ahora > los_plazos.caso_hasta,
        politica=politica, reprogramaciones=len(cambios),
        cancelacion=cancelaciones[-1] if cancelaciones else None, cambios=cambios,
        efecto=estado_del_efecto(pedido, SIN_EFECTO),
    )


# --------------------------------------------------------------------------- #
# Abrir una transición: la reserva de quien actúa, en fila, y su clave
# --------------------------------------------------------------------------- #
@dataclass
class Contexto:
    reserva: ServiceBooking
    prestador: ServiceProvider | None
    rol: str
    usuario_id: str
    clave: str
    ahora: datetime
    #: La línea que ya dejó ESTA MISMA petición, si se repite.
    previo: ServiceBookingEvent | None
    politica: limites.PoliticaDeAtencion


async def reserva_de(
    db: AsyncSession, *, usuario_id: str, reserva_id: str, rol: str
) -> tuple[ServiceBooking, ServiceProvider | None]:
    """La reserva de QUIEN ACTÚA (quien contrata o su prestador). Lo ajeno es
    un 404, sin decir si existe."""
    reserva = await db.get(ServiceBooking, reserva_id) if _es_uuid(reserva_id) else None
    if reserva is None:
        raise ReservaNoEncontrada()
    prestador = await db.get(ServiceProvider, reserva.provider_id)
    if rol == CLIENTE:
        if reserva.client_id is None or reserva.client_id != usuario_id:
            raise ReservaNoEncontrada()
    elif rol == PRESTADOR:
        if prestador is None or prestador.profile_id != usuario_id:
            raise ReservaNoEncontrada()
    elif rol != ADMINISTRACION:
        raise ReservaNoEncontrada()
    return reserva, prestador


async def en_fila(db: AsyncSession, reserva: ServiceBooking, *, con_el_servicio: bool = False) -> ServiceBooking:
    """La fila de la reserva, BLOQUEADA hasta el final de la transacción. La
    del SERVICIO, antes, solo cuando se va a tocar su horario (cancelar y
    reprogramar): lo demás no hace esperar a quien reserva ese servicio. La
    reserva, FOR NO KEY UPDATE: quien escribe una fila que apunta a ella (su
    clave ajena) no se queda esperando."""
    if con_el_servicio:
        await reserva_dominio._poner_en_fila(db, reserva.service_id)
    elif (await db.connection()).dialect.name == "postgresql":
        await db.execute(text(f"set local lock_timeout = '{int(limites.ESPERA_DEL_CERROJO_MS)}ms'"))
    fila = await db.scalar(
        select(ServiceBooking)
        .where(ServiceBooking.id == reserva.id)
        .with_for_update(key_share=True)
        .execution_options(populate_existing=True)
    )
    if fila is None:  # pragma: no cover - una reserva no se borra suelta
        raise ReservaNoEncontrada()
    return fila


async def abrir(
    db: AsyncSession,
    *,
    usuario_id: str,
    reserva_id: str,
    rol: str,
    clave: str | None,
    accion: str,
    huella: str | None = None,
    ahora: datetime | None = None,
    horario: bool = False,
) -> Contexto:
    """Lo común a toda transición: la clave, la reserva de quien actúa, los
    cerrojos en su orden y la idempotencia (la misma clave con lo mismo es la
    misma petición; con otra cosa, 409). `horario`: la transición toca el
    horario del servicio (cancelar, reprogramar)."""
    clave = reserva_dominio._exigir_clave(clave)
    ahora = ahora or _ahora()
    reserva, prestador = await reserva_de(db, usuario_id=usuario_id, reserva_id=reserva_id, rol=rol)
    reserva = await en_fila(db, reserva, con_el_servicio=horario)
    await reserva_dominio._en_fila_la_persona(db, usuario_id)
    previo = await reserva_dominio._por_clave(db, usuario_id, clave)
    if previo is not None and (
        previo.action != accion
        or previo.booking_id != reserva.id
        or (huella is not None and (previo.details or {}).get("request_sha256") != huella)
    ):
        raise ClaveReutilizada(details={"action": previo.action})
    return Contexto(reserva, prestador, rol, usuario_id, clave, ahora, previo, limites.PoliticaDeAtencion.de())


async def _atencion(db: AsyncSession, reserva_id: str) -> ServiceAttendance | None:
    return await db.get(ServiceAttendance, reserva_id, populate_existing=True)


async def anotar(
    db: AsyncSession, c: Contexto, accion: str, *, desde: str | None, hasta: str, detalles: dict | None = None,
    retencion_id: str | None = None,
) -> ServiceBookingEvent:
    return await reserva_dominio._anotar(
        db, servicio_id=c.reserva.service_id, accion=accion, desde=desde, hasta=hasta, ahora=c.ahora,
        retencion_id=retencion_id, reserva_id=c.reserva.id, actor_id=c.usuario_id, rol=c.rol, clave=c.clave,
        detalles=detalles,
    )


async def avisar(db: AsyncSession, usuario_id: str | None, tipo: str, reserva_id: str, suceso_id: str) -> None:
    """Un aviso a UNA persona, sobre la reserva. Si la cuenta ya no existe, nada."""
    if usuario_id:
        await avisos.avisar(
            db, usuario_id=usuario_id, tipo=tipo, solicitud_id=reserva_id, suceso_id=suceso_id,
            entidad=avisos.ENTIDAD_RESERVA,
        )


def _la_otra_parte(c: Contexto) -> str | None:
    if c.rol == CLIENTE:
        return c.prestador.profile_id if c.prestador is not None else None
    return c.reserva.client_id


# --------------------------------------------------------------------------- #
# Cancelar
# --------------------------------------------------------------------------- #
@reserva_dominio.sin_esperas_largas
async def cancelar(
    db: AsyncSession, *, usuario_id: str, reserva_id: str, rol: str, motivo: str | None, nota: str | None,
    clave: str | None, ahora: datetime | None = None,
) -> ServiceBooking:
    """Cancela una reserva que todavía no empezó. Quien contrata o su
    prestador; el prestador explica por qué. EL HORARIO SE LIBERA en la misma
    transacción, y el pedido y lo aceptado se quedan. Sin dinero: su efecto
    económico «no aplica»."""
    motivo = (motivo or "").strip() or "other"
    nota = (nota or "").strip() or None
    if motivo not in MOTIVOS_DE_CANCELACION:
        raise MotivoRequerido(details={"field": "reason"})
    if nota is not None and len(nota) > limites.MOTIVO_MAXIMO:
        raise MotivoRequerido(details={"field": "note", "max": limites.MOTIVO_MAXIMO})
    if rol == PRESTADOR and nota is None:
        raise MotivoRequerido(details={"field": "note"})
    huella = reserva_dominio._huella({"reason": motivo, "note": nota})
    c = await abrir(db, usuario_id=usuario_id, reserva_id=reserva_id, rol=rol, clave=clave,
                    accion=RESERVA_CANCELADA_EVENTO, huella=huella, ahora=ahora, horario=True)
    if c.previo is not None:
        return c.reserva
    if c.reserva.status == RESERVA_CANCELADA:
        raise ReservaYaCancelada()
    atencion = await _atencion(db, c.reserva.id)
    if (
        c.reserva.status != RESERVA_CONFIRMADA
        or (atencion is not None and atencion.status != CON_CODIGO)
        or c.ahora >= _utc(c.reserva.starts_at)
    ):
        raise AccionNoDisponible(details={"action": CANCELAR})

    retencion = await db.scalar(
        select(ServiceHold).where(ServiceHold.id == c.reserva.hold_id).with_for_update()
        .execution_options(populate_existing=True)
    )
    pedido = await db.get(ServiceOrder, c.reserva.order_id)
    # PRIMERO la reserva, DESPUÉS su horario: la base no deja liberar una
    # retención con su reserva confirmada.
    c.reserva.status = RESERVA_CANCELADA
    await db.flush()
    if retencion is not None and retencion.status == RETENCION_CONSUMIDA:
        retencion.status = RETENCION_LIBERADA
        retencion.consumed_at = None
        retencion.released_at = c.ahora
        retencion.updated_at = c.ahora
        await db.flush()
    evento = await anotar(
        db, c, RESERVA_CANCELADA_EVENTO, desde=RESERVA_CONFIRMADA, hasta=RESERVA_CANCELADA,
        retencion_id=c.reserva.hold_id,
        detalles={"reason": motivo, "note": nota, "financial_effect_status": estado_del_efecto(pedido, SIN_EFECTO),
                  "request_sha256": huella},
    )
    await avisar(
        db, _la_otra_parte(c),
        avisos.CANCELADA_POR_QUIEN_CONTRATA if rol == CLIENTE else avisos.CANCELADA_POR_EL_PRESTADOR,
        c.reserva.id, evento.id,
    )
    return c.reserva


# --------------------------------------------------------------------------- #
# Reprogramar
# --------------------------------------------------------------------------- #
@reserva_dominio.sin_esperas_largas
async def reprogramar(
    db: AsyncSession, *, cliente_id: str, reserva_id: str, retencion_id: str, clave: str | None,
    ahora: datetime | None = None,
) -> ServiceBooking:
    """Mueve la reserva al horario que quien contrata YA APARTÓ (una retención
    suya, activa, del mismo servicio). En UNA transacción: la retención nueva
    se consume, la reserva cambia de horario y la anterior se libera. Si algo
    falla, no cambia nada y la reserva original sigue en pie.

    EL CONTRATO NO CAMBIA: misma versión, mismo precio, mismas condiciones. Si
    el servicio publicó otra versión, no se reprograma (409)."""
    if not _es_uuid(retencion_id):
        raise reserva_dominio.RetencionNoEncontrada()
    huella = reserva_dominio._huella({"hold_id": retencion_id})
    c = await abrir(db, usuario_id=cliente_id, reserva_id=reserva_id, rol=CLIENTE, clave=clave,
                    accion=RESERVA_REPROGRAMADA, huella=huella, ahora=ahora, horario=True)
    if c.previo is not None:
        return c.reserva
    atencion = await _atencion(db, c.reserva.id)
    if c.reserva.status != RESERVA_CONFIRMADA or (atencion is not None and atencion.status != CON_CODIGO):
        raise AccionNoDisponible(details={"action": REPROGRAMAR})
    p = plazos(c.reserva, atencion, None, c.politica)
    if c.ahora > p.reprogramar_hasta:
        raise ReprogramacionTardia(details={"hours": c.politica.reprogramar_horas_antes})
    hechas = len(await _sucesos(db, c.reserva.id, RESERVA_REPROGRAMADA))
    if hechas >= c.politica.reprogramaciones:
        raise ReprogramacionAgotada(details={"max": c.politica.reprogramaciones})

    nueva = await db.scalar(
        select(ServiceHold)
        .where(ServiceHold.id == retencion_id, ServiceHold.client_id == cliente_id)
        .with_for_update().execution_options(populate_existing=True)
    )
    if nueva is None or nueva.service_id != c.reserva.service_id or nueva.id == c.reserva.hold_id:
        raise reserva_dominio.RetencionNoEncontrada()
    if nueva.status == RETENCION_CONSUMIDA:
        raise reserva_dominio.RetencionConsumida()
    if nueva.status != RETENCION_ACTIVA:
        raise reserva_dominio.RetencionNoActiva()
    if _utc(nueva.expires_at) <= c.ahora:
        raise reserva_dominio.RetencionVencida()
    if _utc(nueva.starts_at) <= c.ahora:
        raise reserva_dominio.HorarioNoDisponible()

    # EL MISMO CONTRATO: el servicio sigue siendo público para esa persona y
    # su versión publicada es la que contrató.
    try:
        _, vigente, _, _ = await descubrimiento.publico(db, c.reserva.service_id, mira=cliente_id)
    except descubrimiento.ServicioNoPublico:
        raise reserva_dominio.ServicioNoDisponible() from None
    if vigente.id != c.reserva.version_id or nueva.version_id != c.reserva.version_id \
            or nueva.modality != c.reserva.modality:
        raise reserva_dominio.VersionCambiada()
    await reserva_dominio.horario_vigente(db, nueva, vigente, ahora=c.ahora)

    anterior = await db.scalar(
        select(ServiceHold).where(ServiceHold.id == c.reserva.hold_id).with_for_update()
        .execution_options(populate_existing=True)
    )
    de = {"hold_id": c.reserva.hold_id, "starts_at": _utc(c.reserva.starts_at).isoformat(),
          "ends_at": _utc(c.reserva.ends_at).isoformat()}
    # 1) el horario nuevo queda ocupado por la reserva; 2) la reserva se
    # mueve; 3) el anterior se libera. En ese orden, y la base comprueba al
    # confirmar que ninguno quedó a medias.
    nueva.status = RETENCION_CONSUMIDA
    nueva.consumed_at = c.ahora
    nueva.updated_at = c.ahora
    await db.flush()
    r = c.reserva
    r.hold_id = nueva.id
    r.starts_at, r.ends_at = nueva.starts_at, nueva.ends_at
    r.occupied_from, r.occupied_until = nueva.occupied_from, nueva.occupied_until
    r.timezone, r.local_date = nueva.timezone, nueva.local_date
    r.buffer_before_minutes = int((_utc(nueva.starts_at) - _utc(nueva.occupied_from)).total_seconds() // 60)
    r.buffer_after_minutes = int((_utc(nueva.occupied_until) - _utc(nueva.ends_at)).total_seconds() // 60)
    r.capacity, r.seat = nueva.capacity, nueva.seat
    await db.flush()
    if anterior is not None and anterior.status == RETENCION_CONSUMIDA:
        anterior.status = RETENCION_LIBERADA
        anterior.consumed_at = None
        anterior.released_at = c.ahora
        anterior.updated_at = c.ahora
        await db.flush()
    evento = await anotar(
        db, c, RESERVA_REPROGRAMADA, desde=RESERVA_CONFIRMADA, hasta=RESERVA_CONFIRMADA, retencion_id=nueva.id,
        detalles={"from": de, "to": {"hold_id": nueva.id, "starts_at": _utc(nueva.starts_at).isoformat(),
                                     "ends_at": _utc(nueva.ends_at).isoformat()},
                  "request_sha256": huella},
    )
    await avisar(db, _la_otra_parte(c), avisos.REPROGRAMADA, r.id, evento.id)
    return r


# --------------------------------------------------------------------------- #
# Llegar, empezar, terminar, confirmar
# --------------------------------------------------------------------------- #
def _codigo_nuevo() -> str:
    return f"{secrets.randbelow(10 ** limites.CODIGO_DE_ASISTENCIA_CIFRAS):0{limites.CODIGO_DE_ASISTENCIA_CIFRAS}d}"


def _en_la_ventana(c: Contexto) -> bool:
    desde = _utc(c.reserva.starts_at) - timedelta(minutes=c.politica.llegada_minutos)
    return desde <= c.ahora <= _utc(c.reserva.ends_at)


@reserva_dominio.sin_esperas_largas
async def pedir_codigo(
    db: AsyncSession, *, cliente_id: str, reserva_id: str, clave: str | None, ahora: datetime | None = None
) -> ServiceAttendance:
    """EL CÓDIGO DE ASISTENCIA de quien contrata: lo enseña (o lo dicta) al
    prestador, y con él la atención empieza con la SEÑAL FUERTE. Pedirlo otra
    vez devuelve el mismo."""
    c = await abrir(db, usuario_id=cliente_id, reserva_id=reserva_id, rol=CLIENTE, clave=clave,
                    accion=CODIGO_EMITIDO, ahora=ahora)
    atencion = await _atencion(db, c.reserva.id)
    if atencion is not None and atencion.status == CON_CODIGO:
        return atencion
    if c.reserva.status != RESERVA_CONFIRMADA or atencion is not None or not _en_la_ventana(c):
        raise (FueraDeLaVentana() if c.reserva.status == RESERVA_CONFIRMADA and atencion is None
               else AccionNoDisponible(details={"action": PEDIR_CODIGO}))
    atencion = ServiceAttendance(
        booking_id=c.reserva.id, status=CON_CODIGO, checkin_code=_codigo_nuevo(), checkin_attempts=0,
        started_with_code=False, created_at=c.ahora, updated_at=c.ahora,
    )
    db.add(atencion)
    await db.flush()
    await anotar(db, c, CODIGO_EMITIDO, desde=None, hasta=CON_CODIGO)
    return atencion


@dataclass
class Inicio:
    atencion: ServiceAttendance | None
    #: Falso si el código no era ese: el intento queda contado y la ruta
    #: contesta 409 DESPUÉS de guardarlo.
    correcto: bool
    intentos_restantes: int = 0


@reserva_dominio.sin_esperas_largas
async def iniciar(
    db: AsyncSession, *, usuario_id: str, reserva_id: str, codigo: str | None, clave: str | None,
    ahora: datetime | None = None,
) -> Inicio:
    """El prestador EMPIEZA la atención. Con el código de quien contrata es la
    señal fuerte; sin él, una declaración suya, que por sí sola no cierra nada
    (hará falta que quien contrata confirme)."""
    codigo = (codigo or "").strip() or None
    c = await abrir(db, usuario_id=usuario_id, reserva_id=reserva_id, rol=PRESTADOR, clave=clave,
                    accion=ATENCION_INICIADA, ahora=ahora)
    atencion = await _atencion(db, c.reserva.id)
    if c.previo is not None:
        return Inicio(atencion, True)
    if c.prestador is None or c.prestador.status != PRESTADOR_ACTIVO:
        raise PrestadorSuspendido()
    if c.reserva.status != RESERVA_CONFIRMADA or (atencion is not None and atencion.status != CON_CODIGO):
        raise AccionNoDisponible(details={"action": INICIAR})
    if not _en_la_ventana(c):
        raise FueraDeLaVentana()
    if codigo is not None:
        if atencion is None or atencion.checkin_code is None:
            raise CodigoIncorrecto(details={"attempts_left": limites.INTENTOS_DEL_CODIGO})
        if atencion.checkin_attempts >= limites.INTENTOS_DEL_CODIGO:
            raise CodigoBloqueado()
        if not secrets.compare_digest(codigo, atencion.checkin_code):
            atencion.checkin_attempts += 1
            atencion.updated_at = c.ahora
            await db.flush()
            return Inicio(atencion, False, limites.INTENTOS_DEL_CODIGO - atencion.checkin_attempts)
    desde = atencion.status if atencion is not None else None
    if atencion is None:
        atencion = ServiceAttendance(booking_id=c.reserva.id, status=EN_CURSO, checkin_attempts=0,
                                     created_at=c.ahora)
        db.add(atencion)
    atencion.status = EN_CURSO
    atencion.started_at = c.ahora
    atencion.started_with_code = codigo is not None
    atencion.updated_at = c.ahora
    await db.flush()
    await anotar(db, c, ATENCION_INICIADA, desde=desde, hasta=EN_CURSO, detalles={"with_code": codigo is not None})
    return Inicio(atencion, True)


@reserva_dominio.sin_esperas_largas
async def terminar(
    db: AsyncSession, *, usuario_id: str, reserva_id: str, clave: str | None, ahora: datetime | None = None
) -> ServiceAttendance:
    """El prestador marca la atención como REALIZADA. No la cierra ni libera
    nada: falta que quien contrata confirme (o que el plazo pase, con la
    señal fuerte y sin un caso)."""
    c = await abrir(db, usuario_id=usuario_id, reserva_id=reserva_id, rol=PRESTADOR, clave=clave,
                    accion=ATENCION_TERMINADA_EVENTO, ahora=ahora)
    atencion = await _atencion(db, c.reserva.id)
    if c.previo is not None and atencion is not None:
        return atencion
    if c.reserva.status != RESERVA_CONFIRMADA or atencion is None or atencion.status != EN_CURSO:
        raise AccionNoDisponible(details={"action": TERMINAR})
    atencion.status = TERMINADA
    atencion.completed_at = c.ahora
    atencion.updated_at = c.ahora
    await db.flush()
    evento = await anotar(db, c, ATENCION_TERMINADA_EVENTO, desde=EN_CURSO, hasta=TERMINADA)
    await avisar(db, c.reserva.client_id, avisos.ATENCION_POR_CONFIRMAR, c.reserva.id, evento.id)
    return atencion


async def _caso_vivo(db: AsyncSession, reserva_id: str) -> bool:
    return bool(
        await db.scalar(
            select(func.count()).select_from(ServiceIncident)
            .where(ServiceIncident.booking_id == reserva_id, ServiceIncident.status.in_(CASOS_VIVOS))
        )
    )


def cerrar(atencion: ServiceAttendance, *, por: str, ahora: datetime) -> None:
    """Deja la atención CERRADA (verificada). Es final."""
    atencion.status = CERRADA
    atencion.completed_at = atencion.completed_at or ahora
    atencion.closed_at = ahora
    atencion.closed_by = por
    atencion.updated_at = ahora


@reserva_dominio.sin_esperas_largas
async def confirmar(
    db: AsyncSession, *, cliente_id: str, reserva_id: str, clave: str | None, ahora: datetime | None = None
) -> ServiceAttendance:
    """Quien contrata CONFIRMA que la atención se realizó: queda cerrada y
    verificada. Con un caso abierto no se confirma: primero se resuelve."""
    c = await abrir(db, usuario_id=cliente_id, reserva_id=reserva_id, rol=CLIENTE, clave=clave,
                    accion=ATENCION_CONFIRMADA, ahora=ahora)
    atencion = await _atencion(db, c.reserva.id)
    if c.previo is not None and atencion is not None:
        return atencion
    if c.reserva.status != RESERVA_CONFIRMADA or atencion is None or atencion.status not in (EN_CURSO, TERMINADA):
        raise AccionNoDisponible(details={"action": CONFIRMAR})
    if await _caso_vivo(db, c.reserva.id):
        raise CasoAbierto()
    desde = atencion.status
    atencion.confirmed_at = c.ahora
    cerrar(atencion, por=CLIENTE, ahora=c.ahora)
    await db.flush()
    await anotar(db, c, ATENCION_CONFIRMADA, desde=desde, hasta=CERRADA)
    return atencion


# --------------------------------------------------------------------------- #
# La inasistencia
# --------------------------------------------------------------------------- #
@reserva_dominio.sin_esperas_largas
async def reportar_ausencia(
    db: AsyncSession, *, usuario_id: str, reserva_id: str, rol: str, clave: str | None,
    ahora: datetime | None = None,
) -> ServiceAttendance:
    """Una parte dice que LA OTRA no vino. Solo pasada la tolerancia y si la
    atención no empezó. Es una DECLARACIÓN, no un fallo: a la otra parte se le
    avisa y puede contestar abriendo un caso; y no tiene efecto económico."""
    c = await abrir(db, usuario_id=usuario_id, reserva_id=reserva_id, rol=rol, clave=clave,
                    accion=AUSENCIA_REPORTADA, ahora=ahora)
    atencion = await _atencion(db, c.reserva.id)
    if c.previo is not None and atencion is not None:
        return atencion
    if c.reserva.status != RESERVA_CONFIRMADA or (atencion is not None and atencion.status != CON_CODIGO):
        raise AccionNoDisponible(details={"action": REPORTAR_AUSENCIA})
    p = plazos(c.reserva, atencion, None, c.politica)
    if c.ahora < p.ausencia_desde or c.ahora > p.caso_hasta:
        raise FueraDeLaVentana(details={"from": p.ausencia_desde.isoformat()})
    desde = atencion.status if atencion is not None else None
    hasta = AUSENTE_EL_PRESTADOR if rol == CLIENTE else AUSENTE_EL_CLIENTE
    if atencion is None:
        atencion = ServiceAttendance(booking_id=c.reserva.id, status=hasta, checkin_attempts=0,
                                     started_with_code=False, created_at=c.ahora)
        db.add(atencion)
    atencion.status = hasta
    atencion.no_show_reported_at = c.ahora
    atencion.updated_at = c.ahora
    await db.flush()
    pedido = await db.get(ServiceOrder, c.reserva.order_id)
    evento = await anotar(
        db, c, AUSENCIA_REPORTADA, desde=desde, hasta=hasta,
        detalles={"absent": PRESTADOR if rol == CLIENTE else CLIENTE,
                  "financial_effect_status": estado_del_efecto(pedido, SIN_EFECTO)},
    )
    await avisar(
        db, _la_otra_parte(c),
        avisos.AUSENCIA_DEL_PRESTADOR if rol == CLIENTE else avisos.AUSENCIA_DE_QUIEN_CONTRATA,
        c.reserva.id, evento.id,
    )
    return atencion


# --------------------------------------------------------------------------- #
# Los barridos: recordar y cerrar lo que ya se puede cerrar
# --------------------------------------------------------------------------- #
@dataclass
class Tareas:
    recordadas: int = 0
    cerradas: int = 0
    #: Terminadas sin la señal fuerte cuyo plazo ya pasó: NO se cierran solas.
    sin_verificar: int = 0
    saltadas: int = 0


async def _reserva_libre(db: AsyncSession, reserva_id: str) -> ServiceBooking | None:
    """La reserva, bloqueada SI NADIE LA TIENE. Si alguien está en ella, se
    deja para la próxima pasada."""
    consulta = select(ServiceBooking).where(ServiceBooking.id == reserva_id).execution_options(populate_existing=True)
    if (await db.connection()).dialect.name == "postgresql":
        consulta = consulta.with_for_update(key_share=True, skip_locked=True)
    return await db.scalar(consulta)


async def _ya_recordada(db: AsyncSession, reserva_id: str) -> bool:
    """¿Se recordó ya ESTE horario? El recordatorio es de un horario: uno
    anterior al último cambio de horario era del viejo, y el nuevo se recuerda
    cuando toca."""
    recordatorios = await _sucesos(db, reserva_id, RESERVA_RECORDADA)
    if not recordatorios:
        return False
    cambios = await _sucesos(db, reserva_id, RESERVA_REPROGRAMADA)
    return not cambios or _utc(recordatorios[-1].created_at) > _utc(cambios[-1].created_at)


async def _recordar(db: AsyncSession, reserva_id: str, *, ahora: datetime, hasta: datetime) -> bool:
    reserva = await _reserva_libre(db, reserva_id)
    if reserva is None or reserva.status != RESERVA_CONFIRMADA:
        return False
    if not (ahora < _utc(reserva.starts_at) <= hasta) or await _ya_recordada(db, reserva.id):
        return False
    evento = await reserva_dominio._anotar(
        db, servicio_id=reserva.service_id, accion=RESERVA_RECORDADA, desde=RESERVA_CONFIRMADA,
        hasta=RESERVA_CONFIRMADA, ahora=ahora, reserva_id=reserva.id, rol=SISTEMA,
    )
    prestador = await db.get(ServiceProvider, reserva.provider_id)
    await avisar(db, reserva.client_id, avisos.RECORDATORIO_A_QUIEN_CONTRATA, reserva.id, evento.id)
    await avisar(db, prestador.profile_id if prestador else None, avisos.RECORDATORIO_AL_PRESTADOR,
                 reserva.id, evento.id)
    return True


async def _cerrar_sola(db: AsyncSession, reserva_id: str, *, ahora: datetime, limite: datetime) -> bool:
    reserva = await _reserva_libre(db, reserva_id)
    if reserva is None:
        return False
    atencion = await _atencion(db, reserva.id)
    if (
        atencion is None or atencion.status != TERMINADA or not atencion.started_with_code
        or _utc(atencion.completed_at) > limite or await _caso_vivo(db, reserva.id)
    ):
        return False
    cerrar(atencion, por=SISTEMA, ahora=ahora)
    await db.flush()
    evento = await reserva_dominio._anotar(
        db, servicio_id=reserva.service_id, accion=ATENCION_CERRADA_EVENTO, desde=TERMINADA, hasta=CERRADA,
        ahora=ahora, reserva_id=reserva.id, rol=SISTEMA,
    )
    await avisar(db, reserva.client_id, avisos.RESENA_DISPONIBLE, reserva.id, evento.id)
    return True


async def tareas(db: AsyncSession, *, lote: int | None = None, ahora: datetime | None = None) -> Tareas:
    """LOS BARRIDOS, por lotes e idempotentes (repetirlos no hace nada):

      * RECORDAR las reservas que empiezan pronto, una vez por horario (si
        después cambia de horario, el nuevo se recuerda cuando toca);
      * CERRAR las atenciones terminadas cuyo plazo de confirmación pasó, solo
        con la señal fuerte y sin un caso vivo. Sin la señal fuerte NO se
        cierran: se cuentan, y esperan a quien contrata o a un caso.

    CADA FILA SE CONFIRMA ANTES DE PASAR A LA SIGUIENTE: una que falle no
    tumba el lote, y el barrido no deja un lote entero de reservas
    bloqueadas hasta el final. Lo que otra petición tiene bloqueado se
    salta. LO QUE NO SE PUEDE CERRAR NO OCUPA EL LOTE (no deja atrás a las
    que sí). NADIE LLAMA A ESTO TODAVÍA: el planificador es una decisión de
    la empresa. No mueve dinero."""
    ahora = ahora or _ahora()
    lote = max(1, min(int(lote or limites.LOTE_DE_TAREAS), limites.LOTE_MAXIMO_DE_TAREAS))
    politica = limites.PoliticaDeAtencion.de()
    hecho = Tareas()

    hasta = ahora + timedelta(hours=politica.recordatorio_horas)
    # Ya recordadas: con un recordatorio POSTERIOR a su último cambio de horario
    # (el de antes de reprogramar era del horario viejo).
    cambio = aliased(ServiceBookingEvent)
    ya = select(ServiceBookingEvent.booking_id).where(
        ServiceBookingEvent.action == RESERVA_RECORDADA,
        ~select(cambio.id).where(
            cambio.booking_id == ServiceBookingEvent.booking_id, cambio.action == RESERVA_REPROGRAMADA,
            cambio.created_at >= ServiceBookingEvent.created_at,
        ).exists(),
    )
    por_recordar = list(
        await db.scalars(
            select(ServiceBooking.id)
            .where(ServiceBooking.status == RESERVA_CONFIRMADA, ServiceBooking.starts_at > ahora,
                   ServiceBooking.starts_at <= hasta, ServiceBooking.id.not_in(ya))
            .order_by(ServiceBooking.starts_at, ServiceBooking.id).limit(lote)
        )
    )
    limite = ahora - timedelta(hours=politica.confirmacion_horas)
    vencida = and_(ServiceAttendance.status == TERMINADA, ServiceAttendance.completed_at <= limite)
    con_caso_vivo = (
        select(ServiceIncident.id)
        .where(ServiceIncident.booking_id == ServiceAttendance.booking_id, ServiceIncident.status.in_(CASOS_VIVOS))
        .exists()
    )
    # SOLO LAS QUE SE PUEDEN CERRAR: las que no tienen la señal fuerte o
    # tienen un caso vivo se quedarían para siempre a la cabeza del lote.
    vencidas = list(
        await db.scalars(
            select(ServiceAttendance.booking_id)
            .where(vencida, ServiceAttendance.started_with_code.is_(True), ~con_caso_vivo)
            .order_by(ServiceAttendance.completed_at, ServiceAttendance.booking_id).limit(lote)
        )
    )
    hecho.sin_verificar = int(
        await db.scalar(
            select(func.count()).select_from(ServiceAttendance)
            .where(vencida, ServiceAttendance.started_with_code.is_(False))
        ) or 0
    )
    await db.commit()

    for reserva_id in por_recordar:
        try:
            recordada = await _recordar(db, reserva_id, ahora=ahora, hasta=hasta)
            await db.commit()
            hecho.recordadas += int(recordada)
        except Exception:  # noqa: BLE001 - una fila no tumba el lote
            await db.rollback()
            avisos.logger.exception("[servicios] no se pudo recordar la reserva %s", reserva_id)
            hecho.saltadas += 1
    for reserva_id in vencidas:
        try:
            cerrada = await _cerrar_sola(db, reserva_id, ahora=ahora, limite=limite)
            await db.commit()
            hecho.cerradas += int(cerrada)
        except Exception:  # noqa: BLE001
            await db.rollback()
            avisos.logger.exception("[servicios] no se pudo cerrar la atención %s", reserva_id)
            hecho.saltadas += 1
    return hecho


__all__ = [
    "ABRIR_CASO",
    "APELAR",
    "AccionNoDisponible",
    "CANCELAR",
    "CONFIRMAR",
    "CasoAbierto",
    "CodigoBloqueado",
    "CodigoIncorrecto",
    "Contexto",
    "Cuidado",
    "ESCRIBIR_EN_EL_CASO",
    "FueraDeLaVentana",
    "INICIAR",
    "Inicio",
    "MOTIVOS_DE_CANCELACION",
    "MotivoRequerido",
    "PEDIR_CODIGO",
    "Plazos",
    "PrestadorSuspendido",
    "REPORTAR_AUSENCIA",
    "REPROGRAMAR",
    "RESENAR",
    "RESPONDER_RESENA",
    "RETIRAR_EL_CASO",
    "ReprogramacionAgotada",
    "ReprogramacionTardia",
    "ReservaYaCancelada",
    "TERMINAR",
    "Tareas",
    "abrir",
    "acciones_disponibles",
    "anotar",
    "avisar",
    "caso_de",
    "cancelar",
    "cerrar",
    "confirmar",
    "cuidado",
    "en_fila",
    "estado_del_efecto",
    "iniciar",
    "pedir_codigo",
    "plazos",
    "reportar_ausencia",
    "reprogramar",
    "reserva_de",
    "tareas",
    "terminar",
]
