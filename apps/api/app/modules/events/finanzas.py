"""Las finanzas de una venta de entradas.

NO ES OTRO MÓDULO FINANCIERO. Reutiliza `owner_sale_balances`, su máquina de
estados, `owner_payout_accounts`, `owner_transfers` y el adaptador de
transferencias, que ya no mencionan cursos por ninguna parte. Lo único que
había que generalizar eran dos columnas, y lo hace la 0068.

QUÉ SE CONGELA AL VENDER. El evento, el ORGANIZADOR BENEFICIARIO, el pedido, el
bruto, la moneda, la comisión, el neto y la versión de reglas. Cambiar después
el organizador del evento no redirige dinero ya vendido: el saldo apunta a quien
lo era cuando se cobró.

EL ENTORNO NO SE GUARDA EN EL SALDO: llega por la cuenta de cobro, que sí lo
tiene, y la cuenta se elige con el entorno DEL PEDIDO y no con el del proceso.
Elegirla con el del proceso hacía que un pedido de pruebas confirmado en una
réplica de producción apuntara a la cuenta de cobro real del organizador.

SIN COMISIÓN CONFIGURADA NO HAY SALDO. `platform_fee_bps = -1` significa que
nadie ha decidido el número; suponer 0 % transferiría el bruto y ninguna prueba
lo delataría, porque el resultado cuadra. `repartir()` devuelve `None` y aquí no
se escribe nada.

Y NADA SE LIBERA SOLO. La fecha de disponibilidad sale de una política de
retención publicada; sin ella el saldo se queda `pending` sin fecha, y el panel
dice por qué.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError
from app.modules.catalog.models import Event
from app.modules.commerce.liquidacion import repartir
from app.modules.commerce.models import OwnerSaleBalance
from app.modules.events import esquema, politicas
from app.modules.events.models import EventOrder
from app.modules.events.posventa_models import POLITICA_RESERVA, POLITICA_RETENCION
from app.modules.events.finanzas_models import EventDispute, EventDisputeEvent, OwnerSaleReserve

PENDIENTE = "pending"
RETENIDO = "frozen"
ELEGIBLE = "eligible"
EN_TRANSFERENCIA = "transferring"
TRANSFERIDO = "transferred"
CANCELADO = "cancelled"
FALLIDO = "failed"

#: Por qué un saldo todavía no está disponible. Códigos, no frases: la pantalla
#: los traduce y una consulta los agrupa.
SIN_COMISION = "fee_not_configured"
SIN_POLITICA_DE_RETENCION = "hold_policy_not_configured"
SIN_CUENTA = "payout_account_missing"
SIN_ORGANIZADOR = "organizer_missing"
RESERVA_VIVA = "reserve_held"
EXPEDIENTE_ABIERTO = "aftersale_case_open"
DISPUTA_ABIERTA = "dispute_open"
RETENCION_EN_CURSO = "hold_open"
#: El saldo ya no está en la cola: se canceló, se congeló o ya salió. La
#: pregunta «por qué no se libera» no se contesta con `None` para un saldo
#: cancelado por una devolución, porque `None` significa «nada lo impide».
SALDO_NO_PENDIENTE = "balance_not_pending"
#: La cuenta existe pero no sirve todavía: alta a medias, cobros apagados, o de
#: otra persona. Tenerla apuntada no es poder pagar en ella.
CUENTA_SIN_ALTA = "payout_account_not_ready"


logger = logging.getLogger(__name__)


class FinanzasNoDisponibles(AppError):
    status_code = 503
    code = "event_finance_not_available"


def ahora() -> datetime:
    return datetime.now(timezone.utc)


def _OwnerPayoutAccount():  # noqa: N802
    """La clase, importada tarde. Comercio ya la define y duplicarla aquí sería
    tener dos verdades sobre la misma tabla."""
    from app.modules.commerce.models import OwnerPayoutAccount

    return OwnerPayoutAccount


async def exigir_disponible(db: AsyncSession) -> None:
    if not await esquema.hay_finanzas(db):
        raise FinanzasNoDisponibles(
            "Las finanzas de eventos todavía no están disponibles."
        )


async def registrar_venta(
    db: AsyncSession, *, orden: EventOrder, momento: datetime | None = None
) -> OwnerSaleBalance | None:
    """Crea el saldo de una venta pagada. Idempotente por pedido.

    Devuelve `None` cuando no se puede crear —sin esquema, sin comisión, sin
    organizador— y eso NO es un fallo: es que falta una decisión. El pedido
    sigue pagado y las entradas emitidas.

    NO HACE `commit`: lo llama el webhook, dentro de su savepoint.
    """
    momento = momento or ahora()
    if not await esquema.hay_finanzas(db):
        return None
    if orden.status != "PAID":
        return None

    ya = await db.scalar(
        select(OwnerSaleBalance).where(OwnerSaleBalance.event_order_id == orden.id)
    )
    if ya is not None:
        # El webhook se reintenta. Un saldo por pedido, y ya está.
        return ya

    evento = await db.get(Event, orden.event_id)
    if evento is None or not evento.organizer_id:
        return None

    reparto = repartir(int(orden.total_minor))
    if reparto is None:
        # SIN COMISIÓN CONFIGURADA NO SE INVENTA UN REPARTO.
        return None

    cuenta = await _cuenta_de(db, evento.organizer_id, entorno=orden.environment)
    saldo = OwnerSaleBalance(
        event_id=orden.event_id,
        event_order_id=orden.id,
        # CONGELADO: quien organizaba cuando se cobró. Cambiar el organizador
        # después no redirige dinero ya vendido.
        owner_id=evento.organizer_id,
        payout_account_id=cuenta.id if cuenta is not None else None,
        gross_amount_minor=reparto.gross_minor,
        platform_fee_minor=reparto.platform_fee_minor,
        provider_fee_minor=reparto.provider_fee_minor,
        net_amount_minor=reparto.net_minor,
        currency=orden.currency,
        fee_rules_version=reparto.fee_rules_version,
        status=PENDIENTE,
        # SIN FECHA. La política de retención no está publicada, así que no se
        # supone ninguna: `available_at` nulo significa «el reloj no ha
        # empezado», y `puede_transferirse` ya lo trata como bloqueo.
        available_at=await _disponible_desde(db, orden=orden, momento=momento),
        created_at=momento,
        updated_at=momento,
    )
    try:
        async with db.begin_nested():
            db.add(saldo)
            await db.flush()
    except IntegrityError:
        if saldo in db:
            db.expunge(saldo)
        return await db.scalar(
            select(OwnerSaleBalance).where(OwnerSaleBalance.event_order_id == orden.id)
        )
    return saldo


async def _cuenta_de(db: AsyncSession, owner_id: str, *, entorno: str | None):
    """La cuenta de cobro del organizador EN EL ENTORNO DEL PEDIDO.

    No en el del proceso. Un pedido de pruebas confirmado por una réplica
    configurada como producción apuntaba a la cuenta de cobro real, y el saldo
    no guarda entorno: después no había forma de distinguirlos.

    Sin entorno en el pedido no se adivina ninguno: se devuelve `None` y el
    saldo nace sin cuenta, que es un bloqueo con su código.
    """
    from app.modules.commerce.models import OwnerPayoutAccount

    if not entorno:
        return None
    return await db.scalar(
        select(OwnerPayoutAccount).where(
            OwnerPayoutAccount.owner_id == owner_id,
            OwnerPayoutAccount.environment == entorno,
        )
    )


async def _disponible_desde(
    db: AsyncSession, *, orden: EventOrder, momento: datetime
) -> datetime | None:
    """Cuándo podría estar disponible, según la política de retención.

    `None` cuando no hay política: el reloj no empieza y el saldo se queda
    retenido. No se aproxima con la fecha del evento ni con ningún plazo.
    """
    politica = await politicas.vigente(
        db, tipo=POLITICA_RETENCION, evento_id=orden.event_id
    )
    if politica is None:
        return None
    dias = politicas.numero(politica, "hold_days")
    if dias is None:
        return None

    desde_el_evento = politicas.bandera(politica, "hold_from_event")
    base = momento
    if desde_el_evento:
        # DESDE QUE TERMINA, no desde que empieza. En un festival de tres días
        # la diferencia son tres días de reloj corriendo mientras el evento
        # todavía está pasando y todavía puede pasar cualquier cosa.
        evento = await db.get(Event, orden.event_id)
        cuando = getattr(evento, "ends_at", None) or getattr(
            evento, "starts_at", None
        )
        if cuando is None:
            return None
        base = cuando if cuando.tzinfo else cuando.replace(tzinfo=timezone.utc)
    return base + timedelta(days=int(dias))


@dataclass(frozen=True)
class Bloqueo:
    """Por qué un saldo no se puede liberar todavía. Código, no frase."""

    motivo: str
    detalle: str | None = None


async def por_que_no_se_libera(
    db: AsyncSession,
    *,
    saldo: OwnerSaleBalance,
    reservado: int | None = None,
    momento: datetime | None = None,
) -> Bloqueo | None:
    """La primera razón por la que este saldo sigue bloqueado, o `None`.

    SE COMPRUEBAN TODAS Y SE DEVUELVE LA PRIMERA, en orden de «lo que más
    claramente falta»: al organizador hay que decirle una cosa concreta, no
    siete a la vez.

    `reservado` se puede pasar ya calculado cuando quien llama lo tiene de una
    consulta agrupada; así una lista de doscientos saldos no hace doscientas
    sumas.
    """
    momento = momento or ahora()
    from app.core.config import get_settings

    if not get_settings().comision_configurada:
        return Bloqueo(SIN_COMISION)
    # EL ESTADO DEL PROPIO SALDO, LO PRIMERO. Un saldo cancelado por una
    # devolución ya no está en la cola, y contestar `None` —«nada lo impide»—
    # sobre dinero que ya se le devolvió al comprador era la peor respuesta
    # posible de esta función.
    if saldo.status not in (PENDIENTE, ELEGIBLE):
        return Bloqueo(SALDO_NO_PENDIENTE, saldo.status)
    if not saldo.owner_id:
        return Bloqueo(SIN_ORGANIZADOR)
    if saldo.payout_account_id is None:
        return Bloqueo(SIN_CUENTA)
    # TENER UNA CUENTA APUNTADA NO ES PODER PAGAR EN ELLA. Un alta a medias,
    # los cobros apagados o una cuenta de otra persona pasaban por «nada lo
    # impide»; el camino de Cursos sí lo exige y este no.
    cuenta = await db.get(_OwnerPayoutAccount(), saldo.payout_account_id)
    if (
        cuenta is None
        or not cuenta.payouts_enabled
        or (cuenta.onboarding_status or "") != "active"
        or cuenta.owner_id != saldo.owner_id
    ):
        return Bloqueo(CUENTA_SIN_ALTA)
    if saldo.available_at is None:
        return Bloqueo(SIN_POLITICA_DE_RETENCION)

    disponible = saldo.available_at
    if disponible.tzinfo is None:
        disponible = disponible.replace(tzinfo=timezone.utc)
    if disponible > momento:
        return Bloqueo(RETENCION_EN_CURSO, disponible.isoformat())

    if reservado is None:
        reservado = await reservado_de(db, saldo_id=saldo.id)
    if reservado > 0:
        return Bloqueo(RESERVA_VIVA, str(reservado))

    # POR SALDO O POR PEDIDO. Una disputa abierta antes de que existiera el
    # saldo se queda con `balance_id` nulo —y hoy, sin comisión configurada, no
    # existe ningún saldo, así que son todas—: filtrando solo por `balance_id`
    # no bloqueaban nada.
    abierta = await db.scalar(
        select(func.count())
        .select_from(EventDispute)
        .where(
            or_(
                EventDispute.balance_id == saldo.id,
                and_(
                    EventDispute.order_id.is_not(None),
                    EventDispute.order_id == saldo.event_order_id,
                ),
            ),
            EventDispute.status.in_(("open", "needs_response", "under_review")),
        )
    )
    if abierta:
        return Bloqueo(DISPUTA_ABIERTA)

    if saldo.event_order_id is not None:
        from app.modules.events.posventa_models import (
            EXPEDIENTES_VIVOS,
            EventAftersaleCase,
        )

        vivo = await db.scalar(
            select(func.count())
            .select_from(EventAftersaleCase)
            .where(
                EventAftersaleCase.order_id == saldo.event_order_id,
                EventAftersaleCase.status.in_(EXPEDIENTES_VIVOS),
            )
        )
        if vivo:
            return Bloqueo(EXPEDIENTE_ABIERTO)

    return None


async def liberar_vencidos(
    db: AsyncSession, *, limite: int = 200, momento: datetime | None = None
) -> dict[str, int]:
    """Pasa a `eligible` los saldos DE EVENTO que ya no tiene nada que impida.

    SU PROPIO CAMINO, Y NO EL DE CURSOS. El de Cursos mira una orden, una
    solicitud de devolución y una garantía que aquí no existen; usarlo saltaba
    reserva, disputa y expediente. Este pasa cada saldo por
    `por_que_no_se_libera`, que es donde viven las puertas.

    IDEMPOTENTE Y ACOTADO. Lo invoca un planificador EXTERNO: dentro de la API
    no hay temporizador, porque hay varias réplicas.

    NO TRANSFIERE NADA. `eligible` significa «nada lo impide», no «pagado».
    """
    momento = momento or ahora()
    if not await esquema.hay_finanzas(db):
        return {"mirados": 0, "liberados": 0, "bloqueados": 0}

    candidatos = list(
        await db.scalars(
            select(OwnerSaleBalance)
            .where(
                OwnerSaleBalance.event_order_id.is_not(None),
                OwnerSaleBalance.status == PENDIENTE,
                OwnerSaleBalance.available_at.is_not(None),
                OwnerSaleBalance.available_at <= momento,
            )
            .order_by(OwnerSaleBalance.available_at, OwnerSaleBalance.id)
            .limit(max(1, min(int(limite), 1000)))
        )
    )
    liberados = 0
    bloqueados = 0
    for saldo in candidatos:
        bloqueo = await por_que_no_se_libera(db, saldo=saldo, momento=momento)
        if bloqueo is not None:
            bloqueados += 1
            continue
        # COMPARAR Y ESCRIBIR EN LA MISMA SENTENCIA. Entre mirar las puertas y
        # escribir cabe un webhook de disputa; filtrando solo por `id`, este
        # UPDATE lo pisaría.
        hechas = await db.execute(
            update(OwnerSaleBalance)
            .where(
                OwnerSaleBalance.id == saldo.id,
                OwnerSaleBalance.status == PENDIENTE,
                OwnerSaleBalance.event_order_id.is_not(None),
            )
            .values(status=ELEGIBLE, updated_at=momento)
        )
        if (hechas.rowcount or 0) == 1:
            liberados += 1
        else:
            bloqueados += 1
    await db.flush()
    return {
        "mirados": len(candidatos),
        "liberados": liberados,
        "bloqueados": bloqueados,
    }


# --------------------------------------------------------------------------- #
# Reservas
# --------------------------------------------------------------------------- #
async def reservar(
    db: AsyncSession,
    *,
    saldo: OwnerSaleBalance,
    importe_minor: int,
    motivo: str,
    caso_id: str | None = None,
    politica_id: str | None = None,
    actor_id: str | None = None,
    momento: datetime | None = None,
) -> OwnerSaleReserve | None:
    """Retiene parte del saldo. Idempotente por saldo y motivo.

    NO CALCULA EL IMPORTE: se lo dan. Cuánto reservar es una política que nadie
    ha publicado, y este módulo no inventa porcentajes.
    """
    momento = momento or ahora()
    if importe_minor <= 0:
        return None

    reserva = OwnerSaleReserve(
        balance_id=saldo.id,
        amount_minor=int(importe_minor),
        currency=saldo.currency,
        reason=motivo,
        case_id=caso_id,
        policy_id=politica_id,
        status="held",
        created_by=actor_id,
        created_at=momento,
    )
    try:
        async with db.begin_nested():
            db.add(reserva)
            await db.flush()
    except IntegrityError:
        if reserva in db:
            db.expunge(reserva)
        return None
    return reserva


async def liberar_reserva(
    db: AsyncSession,
    *,
    reserva_id: str,
    motivo: str,
    consumida: bool = False,
    actor_id: str | None = None,
    momento: datetime | None = None,
) -> bool:
    """Suelta o consume una reserva. UPDATE condicional.

    NO MUEVE DINERO: deja de retenerlo. `consumida` significa que ese importe
    ya se fue por fuera —una disputa perdida— y no vuelve a la cola.

    Se guarda QUIÉN la soltó. Levantar una retención sobre dinero de otra
    persona sin dejar nombre no se puede auditar después; las que suelta el
    sistema al resolverse una disputa lo dejan nulo, que es su manera de decir
    que no lo decidió nadie.
    """
    momento = momento or ahora()
    hechas = await db.execute(
        update(OwnerSaleReserve)
        .where(OwnerSaleReserve.id == reserva_id, OwnerSaleReserve.status == "held")
        .values(
            status="consumed" if consumida else "released",
            released_at=momento,
            released_by=actor_id,
            release_reason=(motivo or "").strip()[:500] or None,
        )
    )
    return (hechas.rowcount or 0) == 1


async def reservado_de(db: AsyncSession, *, saldo_id: str) -> int:
    """Cuánto hay retenido ahora mismo sobre ese saldo."""
    valor = await db.scalar(
        select(func.coalesce(func.sum(OwnerSaleReserve.amount_minor), 0)).where(
            OwnerSaleReserve.balance_id == saldo_id,
            OwnerSaleReserve.status == "held",
        )
    )
    return int(valor or 0)


# --------------------------------------------------------------------------- #
# El dinero que vuelve
# --------------------------------------------------------------------------- #
async def atender_devolucion(
    db: AsyncSession,
    *,
    orden: EventOrder,
    importe_devuelto_minor: int | None,
    moneda: str | None,
    confirmada: bool,
    referencia: str | None = None,
    momento: datetime | None = None,
) -> str | None:
    """Mueve el saldo del evento cuando su cobro vuelve. Devuelve qué hizo.

    ESTO NO EXISTÍA, Y ES EL AGUJERO MÁS GRAVE QUE HABÍA. `liquidacion.cancelar`
    y sus hermanas filtran por `OwnerSaleBalance.order_id`, que en un saldo de
    evento es NULO, así que ninguna lo tocaba: una venta reembolsada, con las
    entradas ya revocadas y el expediente cerrado, volvía a estar «sin nada que
    lo impida» en cuanto vencía la retención.

    DOS CAMINOS, Y NINGUNO INVENTA UN NÚMERO:

      * devolución CONFIRMADA y TOTAL → el saldo se cancela. No hay nada que
        pagarle a nadie.
      * cualquier otra —parcial, o todavía sin confirmar— → se RETIENE el
        importe que dice el aviso, con el mecanismo de reservas que ya existe.
        Cuánto se le queda al organizador de una devolución parcial es una
        política que nadie ha publicado; bloquear lo devuelto es un hecho, y una
        persona lo suelta cuando haya decisión.

    Un saldo ya transferido NO se toca: recuperar dinero pagado a un tercero es
    una decisión de empresa, no algo que resuelva un webhook de madrugada.
    """
    momento = momento or ahora()
    if not await esquema.hay_finanzas(db):
        return None

    saldo = await db.scalar(
        select(OwnerSaleBalance).where(OwnerSaleBalance.event_order_id == orden.id)
    )
    if saldo is None:
        # Sin comisión configurada no hay saldo. No es un fallo: es que no se
        # creó nada que cancelar.
        return None
    if saldo.status in (EN_TRANSFERENCIA, TRANSFERIDO):
        logger.error(
            "[finanzas] el pedido de evento %s se devolvio con el saldo YA en %s. "
            "Queda para conciliacion manual: no se genera ninguna devolucion "
            "automatica contra el organizador.",
            orden.id,
            saldo.status,
        )
        return "already_transferred"
    if saldo.status == CANCELADO:
        return CANCELADO

    cobrado = int(orden.total_minor or 0)
    devuelto = int(importe_devuelto_minor or 0)
    misma_moneda = (moneda or "").strip().upper() == (
        orden.currency or ""
    ).strip().upper()
    # TOTAL ES LO QUE SE PAGÓ, y cero no es total.
    total = confirmada and misma_moneda and cobrado > 0 and devuelto >= cobrado

    if total:
        saldo.status = CANCELADO
        saldo.updated_at = momento
        await db.flush()
        return CANCELADO

    if devuelto > 0 and misma_moneda:
        await reservar(
            db,
            saldo=saldo,
            importe_minor=devuelto,
            motivo="refund",
            momento=momento,
        )
        return "reserved"

    # Sin importe utilizable se bloquea igual, por el expediente vivo que el
    # aviso acaba de abrir. Aquí no se escribe un número que no se sabe.
    return None


async def politica_de_reserva(db: AsyncSession, *, evento_id: str):
    """La política de reserva, o `None`. Sin ella no se calcula ninguna."""
    return await politicas.vigente(db, tipo=POLITICA_RESERVA, evento_id=evento_id)


# --------------------------------------------------------------------------- #
# Disputas
# --------------------------------------------------------------------------- #
async def abrir_o_actualizar_disputa(
    db: AsyncSession,
    *,
    externa: str,
    entorno: str,
    estado: str,
    orden: EventOrder | None = None,
    importe_minor: int | None = None,
    moneda: str | None = None,
    motivo: str | None = None,
    momento: datetime | None = None,
) -> EventDispute | None:
    """Abre la disputa o mueve su estado. Idempotente por referencia.

    ADMINISTRACIÓN NO DECIDE AQUÍ. Quién asume la pérdida se queda nulo hasta
    que haya política; esta función solo refleja lo que dice la pasarela.
    """
    momento = momento or ahora()
    if not await esquema.hay_finanzas(db):
        return None

    existente = await db.scalar(
        select(EventDispute).where(
            EventDispute.provider == "stripe",
            EventDispute.environment == entorno,
            EventDispute.external_id == externa,
        )
    )
    if existente is not None:
        # EL SALDO, SI YA EXISTE. Una disputa abierta antes de que hubiera saldo
        # —y hoy, sin comisión configurada, son todas— se quedaba con
        # `balance_id` nulo PARA SIEMPRE: nunca se reintentaba, y el día que la
        # comisión se configure esa disputa no bloquearía nada.
        if existente.balance_id is None and orden is not None:
            aparecido = await db.scalar(
                select(OwnerSaleBalance).where(
                    OwnerSaleBalance.event_order_id == orden.id
                )
            )
            if aparecido is not None:
                existente.balance_id = aparecido.id
                await _bloquear_lo_reclamado(
                    db, saldo=aparecido, disputa=existente, momento=momento
                )
        desde = existente.status
        if desde != estado:
            existente.status = estado
            existente.updated_at = momento
            if estado in ("won", "lost", "closed"):
                existente.resolved_at = momento
                # Y SE SUELTA LO BLOQUEADO. Sin esto la reserva vivía para
                # siempre: `liberar_reserva` no tenía ni un solo llamante, así
                # que ganar la disputa dejaba el saldo con `reserve_held` hasta
                # que alguien lo arreglara con SQL a mano.
                await _soltar_lo_reclamado(
                    db, disputa=existente, estado=estado, momento=momento
                )
            db.add(
                EventDisputeEvent(
                    dispute_id=existente.id,
                    from_status=desde,
                    to_status=estado,
                    actor_role="system",
                    created_at=momento,
                )
            )
            await db.flush()
        return existente

    saldo = None
    organizador = None
    if orden is not None:
        saldo = await db.scalar(
            select(OwnerSaleBalance).where(
                OwnerSaleBalance.event_order_id == orden.id
            )
        )
        evento = await db.get(Event, orden.event_id)
        organizador = evento.organizer_id if evento is not None else None

    disputa = EventDispute(
        provider="stripe",
        environment=entorno,
        external_id=externa,
        event_id=orden.event_id if orden is not None else None,
        order_id=orden.id if orden is not None else None,
        organizer_id=organizador,
        balance_id=saldo.id if saldo is not None else None,
        amount_minor=importe_minor,
        currency=(moneda or None),
        reason=(motivo or None),
        status=estado,
        created_at=momento,
        updated_at=momento,
        resolved_at=momento if estado in ("won", "lost", "closed") else None,
    )
    try:
        async with db.begin_nested():
            db.add(disputa)
            await db.flush()
    except IntegrityError:
        if disputa in db:
            db.expunge(disputa)
        return await db.scalar(
            select(EventDispute).where(
                EventDispute.provider == "stripe",
                EventDispute.environment == entorno,
                EventDispute.external_id == externa,
            )
        )

    db.add(
        EventDisputeEvent(
            dispute_id=disputa.id,
            from_status=None,
            to_status=estado,
            actor_role="system",
            created_at=momento,
        )
    )
    # BLOQUEA EL IMPORTE. No descuenta nada de ningún otro saldo: quién asume
    # la pérdida no está decidido.
    if saldo is not None:
        await _bloquear_lo_reclamado(
            db, saldo=saldo, disputa=disputa, momento=momento
        )
    await db.flush()
    return disputa


async def _bloquear_lo_reclamado(
    db: AsyncSession, *, saldo: OwnerSaleBalance, disputa: EventDispute, momento: datetime
) -> None:
    """Retiene lo que el banco reclama, si se puede expresar en ese saldo.

    LA MONEDA TIENE QUE SER LA MISMA. La reserva se guarda con la moneda DEL
    SALDO; escribir en ella el importe de una disputa en otra divisa sería un
    número de una moneda etiquetado con otra, que es peor que no tenerlo. En ese
    caso no se reserva nada y el bloqueo lo pone la disputa misma, que
    `por_que_no_se_libera` ya mira por pedido.
    """
    reclamado = int(disputa.amount_minor or 0)
    moneda = (disputa.currency or "").strip().upper()
    if reclamado <= 0 or (moneda and moneda != (saldo.currency or "").strip().upper()):
        return
    await reservar(
        db,
        saldo=saldo,
        importe_minor=reclamado,
        motivo="dispute",
        momento=momento,
    )


async def _soltar_lo_reclamado(
    db: AsyncSession, *, disputa: EventDispute, estado: str, momento: datetime
) -> None:
    """Suelta —o da por consumida— la reserva de una disputa que terminó.

    GANADA o CERRADA: se suelta, el dinero vuelve a la cola del organizador.
    PERDIDA: se marca consumida, porque ese importe se fue de verdad. Ni una ni
    otra mueven un céntimo por su cuenta: solo dejan de retener.
    """
    if disputa.balance_id is None:
        return
    reserva = await db.scalar(
        select(OwnerSaleReserve).where(
            OwnerSaleReserve.balance_id == disputa.balance_id,
            OwnerSaleReserve.reason == "dispute",
            OwnerSaleReserve.status == "held",
        )
    )
    if reserva is None:
        return
    await liberar_reserva(
        db,
        reserva_id=reserva.id,
        motivo=f"disputa {estado}",
        consumida=(estado == "lost"),
        momento=momento,
    )


__all__ = [
    "Bloqueo",
    "CUENTA_SIN_ALTA",
    "DISPUTA_ABIERTA",
    "EXPEDIENTE_ABIERTO",
    "FinanzasNoDisponibles",
    "RESERVA_VIVA",
    "RETENCION_EN_CURSO",
    "SIN_COMISION",
    "SIN_CUENTA",
    "SIN_ORGANIZADOR",
    "SALDO_NO_PENDIENTE",
    "SIN_POLITICA_DE_RETENCION",
    "abrir_o_actualizar_disputa",
    "atender_devolucion",
    "liberar_vencidos",
    "exigir_disponible",
    "liberar_reserva",
    "politica_de_reserva",
    "por_que_no_se_libera",
    "registrar_venta",
    "reservado_de",
    "reservar",
]
