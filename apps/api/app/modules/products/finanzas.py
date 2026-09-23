"""Las finanzas de una venta de producto (Incremento 9, migración 0082).

NO ES OTRO MÓDULO FINANCIERO. Reutiliza `owner_sale_balances` con su máquina de
estados, `owner_sale_reserves`, `owner_payout_accounts`, `owner_transfers` y el
adaptador de transferencias, que no mencionan cursos ni eventos por ninguna
parte. Lo único que había que generalizar era **una columna**, y lo hace la 0082.

SIN COMISIÓN CONFIGURADA NO HAY SALDO. `platform_fee_bps = -1` significa que
nadie ha decidido el número; suponer 0 % transferiría el bruto entero y ninguna
prueba lo delataría, porque la cuenta cuadra. `repartir()` devuelve `None` y aquí
no se escribe nada. Es la misma decisión que tomó Eventos.

QUÉ SE CONGELA AL VENDER. El pedido, el PROVEEDOR BENEFICIARIO, el bruto, la
moneda, la comisión, el neto y la versión de reglas. Cambiar después el
responsable comercial de un producto no redirige dinero ya vendido: el saldo
apunta a quien lo era cuando se cobró. Y **nunca se recalcula una venta histórica
con la comisión de hoy**.

EL ENTORNO NO SE GUARDA EN EL SALDO: llega por la cuenta de cobro, que sí lo
tiene, y la cuenta se elige con el entorno DEL PEDIDO y no con el del proceso.
Elegirla con el del proceso hacía que un pedido de pruebas confirmado en una
réplica de producción apuntara a la cuenta de cobro real del proveedor.

Y NADA SE LIBERA SOLO. El reloj de la protección sale del plazo que la política
publicada fijó y que quien compró aceptó —congelado en el pedido por su
`policy_id`—, no de un 72 escrito aquí: el blueprint §13 dice que ningún
componente define plazos por su cuenta. La conformidad lo adelanta; una
reclamación, una devolución o una disputa lo paran.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError
from app.modules.commerce.liquidacion import repartir
from app.modules.commerce.models import OwnerSaleBalance
from app.modules.events.finanzas_models import OwnerSaleReserve
from app.modules.products import esquema
from app.modules.products import estados_de_incidencia as maquina
from app.modules.products.finanzas_models import (
    DEVOLUCION_CONFIRMADA,
    DEVOLUCION_EN_MARCHA,
    DISPUTA_VIVA,
    ProductDispute,
    ProductRefund,
)
from app.modules.products.models import (
    PEDIDO_PAGADO,
    ProductIncident,
    ProductOrder,
    ProductPolicy,
    ProductSeller,
    ProductShipment,
)

logger = logging.getLogger("renaser.products")

# --------------------------------------------------------------------------- #
# Los estados del saldo. SON LOS QUE YA EXISTEN, no un enum paralelo.
# --------------------------------------------------------------------------- #
PENDIENTE = "pending"
RETENIDO = "frozen"
ELEGIBLE = "eligible"
EN_TRANSFERENCIA = "transferring"
TRANSFERIDO = "transferred"
CANCELADO = "cancelled"
FALLIDO = "failed"

#: Los que todavía no se han pagado y todavía se pueden mover.
SALDO_ABIERTO = (PENDIENTE, ELEGIBLE)

# --------------------------------------------------------------------------- #
# Por qué un saldo no se libera. CÓDIGOS, no frases: la pantalla los traduce y
# una consulta los puede agrupar.
# --------------------------------------------------------------------------- #
SIN_COMISION = "fee_not_configured"
SALDO_NO_PENDIENTE = "balance_not_pending"
SIN_PROVEEDOR = "seller_missing"
SIN_CUENTA = "payout_account_missing"
CUENTA_SIN_ALTA = "payout_account_not_ready"
PEDIDO_NO_PAGADO = "order_not_paid"
SIN_ENTREGA = "not_delivered"
SIN_POLITICA_DE_PROTECCION = "protection_policy_not_configured"
PROTECCION_EN_CURSO = "protection_window_open"
RESERVA_VIVA = "reserve_held"
RECLAMACION_ABIERTA = "incident_open"
DEVOLUCION_VIVA = "refund_pending"
#: UNA PARCIAL CONFIRMADA NO ES UNA DEVOLUCION EN MARCHA, y decirlo asi
#: era mentir con consecuencias: el bloqueo no se levantaba nunca porque
#: `confirmed` es terminal, y quien vende leia «se esta tramitando algo»
#: sobre un expediente cerrado hacia semanas.
#:
#: EL BLOQUEO ES CORRECTO Y SE QUEDA. El neto se calculo sobre el bruto
#: entero y una parte volvio a quien compro; quien la absorbe —Z o quien
#: vende— es una decision que la empresa no ha tomado. Lo que cambia es
#: que ahora lo DICE, con su propio codigo, y sale en la lista de
#: decisiones pendientes en vez de parecer una espera.
DEVOLUCION_SIN_ASIGNAR = "refund_unallocated"
DISPUTA_ABIERTA_BLOQUEA = "dispute_open"
SALDO_NEGATIVO = "negative_balance"

BLOQUEOS = (
    SIN_COMISION,
    SALDO_NO_PENDIENTE,
    SIN_PROVEEDOR,
    SIN_CUENTA,
    CUENTA_SIN_ALTA,
    PEDIDO_NO_PAGADO,
    SIN_ENTREGA,
    SIN_POLITICA_DE_PROTECCION,
    PROTECCION_EN_CURSO,
    RESERVA_VIVA,
    RECLAMACION_ABIERTA,
    DEVOLUCION_VIVA,
    DISPUTA_ABIERTA_BLOQUEA,
    SALDO_NEGATIVO,
)

#: LOS MOTIVOS DE UNA RESERVA. Son los de la 0068, que ya los trae cerrados por
#: un CHECK; aquí solo se nombran los que Productos usa.
RESERVA_POR_RECLAMACION = "aftersale_case"
RESERVA_POR_DEVOLUCION = "refund"
RESERVA_POR_DISPUTA = "dispute"

RESERVA_VIVA_ESTADO = "held"
RESERVA_SOLTADA = "released"
RESERVA_CONSUMIDA = "consumed"


class FinanzasNoDisponibles(AppError):
    status_code = 503
    code = "product_finance_not_available"


@dataclass(frozen=True)
class Bloqueo:
    """Por qué un saldo no se puede liberar todavía. Código, no frase."""

    motivo: str
    detalle: str | None = None


def ahora() -> datetime:
    return datetime.now(timezone.utc)


def _con_zona(momento: datetime | None) -> datetime | None:
    if momento is None:
        return None
    return momento if momento.tzinfo is not None else momento.replace(tzinfo=timezone.utc)


async def exigir_disponible(db: AsyncSession) -> None:
    """Sin la 0082, 503 con código estable. No 404 ni 500."""
    await esquema.exigir_finanzas(db)


def _OwnerPayoutAccount():  # noqa: N802
    """Importado tarde, igual que en Eventos: evita un ciclo de importación."""
    from app.modules.commerce.models import OwnerPayoutAccount

    return OwnerPayoutAccount


# --------------------------------------------------------------------------- #
# Registrar la venta. Lo llama el aviso de cobro, y solo él.
# --------------------------------------------------------------------------- #
async def registrar_venta(
    db: AsyncSession, *, orden: ProductOrder, momento: datetime | None = None
) -> OwnerSaleBalance | None:
    """Escribe la fotografía inmutable de una venta cobrada.

    DEVUELVE `None` Y NO REVIENTA cuando no se puede. Lo llama el aviso de cobro,
    que ya marcó el pedido como pagado: una excepción aquí desharía ese marcado
    y dejaría un cobro real sin pedido pagado, que es mucho peor que un saldo que
    todavía no existe. Los tres motivos de `None` son:

      1. la 0082 no está aplicada;
      2. no hay comisión configurada —y eso lo decide la empresa—;
      3. ya había un saldo para este pedido, porque el aviso llegó dos veces.

    EL PROVEEDOR BENEFICIARIO SE CONGELA AQUÍ. Es el perfil que responde del
    pedido en el momento del cobro; cambiar después el responsable comercial no
    redirige dinero ya vendido.
    """
    if not await esquema.hay_finanzas(db):
        logger.info("Productos: sin la 0082 no se registra el saldo de %s", orden.id)
        return None

    from app.core.config import get_settings

    if not get_settings().comision_configurada:
        # NI UN SALDO SIN COMISIÓN. Suponer 0 % transferiría el bruto entero.
        logger.info(
            "Productos: sin comisión configurada no se registra el saldo de %s",
            orden.id,
        )
        return None

    reparto = repartir(int(orden.total_minor))
    if reparto is None:
        return None

    dueno = await db.scalar(
        select(ProductSeller.profile_id).where(ProductSeller.id == orden.seller_id)
    )
    if dueno is None:
        logger.warning("Productos: el pedido %s no tiene proveedor", orden.id)
        return None

    cuenta = await _cuenta_de(db, dueno, entorno=orden.environment)

    saldo = OwnerSaleBalance(
        product_order_id=orden.id,
        owner_id=dueno,
        payout_account_id=cuenta.id if cuenta is not None else None,
        gross_amount_minor=reparto.gross_minor,
        platform_fee_minor=reparto.platform_fee_minor,
        provider_fee_minor=reparto.provider_fee_minor,
        net_amount_minor=reparto.net_minor,
        currency=orden.currency,
        fee_rules_version=reparto.fee_rules_version,
        status=PENDIENTE,
        #: LA FECHA NO SE PONE AQUÍ. Se calcula cuando el paquete llega, con el
        #: plazo que la política del pedido fijó: sin entrega no hay reloj.
        available_at=None,
    )
    #: PUNTO DE GUARDADO, NO `rollback` DE TODA LA SESIÓN. Esto lo llama el
    #: aviso de cobro, que YA marcó el pedido como pagado en la misma
    #: transacción: deshacerla entera por un saldo repetido borraría ese
    #: marcado y dejaría un cobro real sin pedido pagado. Es el mismo error
    #: que la revisión del Incremento 8 encontró en `resenas.crear`, y aquí
    #: costaría muchísimo más.
    punto = await db.begin_nested()
    db.add(saldo)
    try:
        await db.flush()
    except IntegrityError:
        # EL AVISO LLEGÓ DOS VECES. Lo decide el índice único de la 0082, no un
        # `select` de antes, que no sirve bajo concurrencia.
        await punto.rollback()
        logger.info("Productos: ya había saldo para el pedido %s", orden.id)
        return None
    return saldo


async def _cuenta_de(db: AsyncSession, dueno: str, *, entorno: str | None):  # noqa: ANN202
    """La cuenta de cobro que aplica, EN EL ENTORNO DEL PEDIDO.

    Elegirla con el entorno del proceso hacía que un pedido de pruebas
    confirmado en una réplica de producción apuntara a la cuenta real.
    """
    Cuenta = _OwnerPayoutAccount()
    consulta = select(Cuenta).where(Cuenta.owner_id == dueno)
    if entorno and "environment" in Cuenta.__table__.c:
        consulta = consulta.where(Cuenta.environment == entorno)
    return await db.scalar(consulta.order_by(Cuenta.created_at.desc()).limit(1))


async def saldo_del_pedido(
    db: AsyncSession, *, orden_id: str
) -> OwnerSaleBalance | None:
    if not await esquema.hay_finanzas(db):
        return None
    return await db.scalar(
        select(OwnerSaleBalance).where(OwnerSaleBalance.product_order_id == orden_id)
    )


# --------------------------------------------------------------------------- #
# El reloj de la protección.
# --------------------------------------------------------------------------- #
async def horas_de_proteccion(
    db: AsyncSession, *, orden: ProductOrder
) -> int | None:
    """Cuántas horas se protege esta compra, según la política QUE SE ACEPTÓ.

    `None` = la política del pedido no lo fija. **No se supone un 72.** El
    blueprint escribe 72 horas en §9 y en §13 dice que «ningún componente define
    plazos por su cuenta» y que la orden conserva su versión de política: lo
    segundo manda, porque es lo que le prometieron a quien compró. Acortárselo
    después con otro número le quitaría un derecho que ya tenía.
    """
    politica = await db.get(ProductPolicy, orden.policy_id)
    if politica is None:
        return None
    horas = getattr(politica, "incident_report_hours", None)
    if horas is None or int(horas) <= 0:
        return None
    return int(horas)


async def cuando_se_puede_liberar(
    db: AsyncSession, *, orden: ProductOrder, envio: ProductShipment | None
) -> datetime | None:
    """Cuándo deja de estar protegida esta compra, o `None` si todavía no se sabe.

    DOS CAMINOS, Y LA CONFORMIDAD MANDA. Si quien compró dio la conformidad, es
    ese instante: el blueprint §9 dice «liberar de inmediato». Si no, es la
    entrega más las horas de la política. Sin entrega no hay reloj, y eso no es
    un error: es que el paquete todavía no ha llegado.
    """
    if envio is None:
        return None
    conformidad = _con_zona(envio.conformity_at)
    if conformidad is not None:
        return conformidad
    entrega = _con_zona(envio.delivered_at)
    if entrega is None:
        return None
    horas = await horas_de_proteccion(db, orden=orden)
    if horas is None:
        return None
    return entrega + timedelta(hours=horas)


# --------------------------------------------------------------------------- #
# Por qué no se libera.
# --------------------------------------------------------------------------- #
async def reservado_de(db: AsyncSession, *, saldo_id: str) -> int:
    """Cuánto de este saldo está retenido por una reserva viva."""
    total = await db.scalar(
        select(func.coalesce(func.sum(OwnerSaleReserve.amount_minor), 0)).where(
            OwnerSaleReserve.balance_id == saldo_id,
            OwnerSaleReserve.status == RESERVA_VIVA_ESTADO,
        )
    )
    return int(total or 0)


async def por_que_no_se_libera(
    db: AsyncSession,
    *,
    saldo: OwnerSaleBalance,
    reservado: int | None = None,
    momento: datetime | None = None,
) -> Bloqueo | None:
    """La primera razón por la que este saldo sigue bloqueado, o `None`.

    SE COMPRUEBAN TODAS Y SE DEVUELVE LA PRIMERA, en orden de «lo que más
    claramente falta»: a quien vende hay que decirle una cosa concreta, no
    catorce a la vez.

    Y NO SE LIBERA SOLO PORQUE VENCIÓ UNA FECHA. El plazo es una condición
    necesaria y no suficiente: una reclamación abierta, una devolución en marcha,
    una disputa, una reserva viva o una cuenta de cobro a medias lo siguen
    bloqueando, y cada una tiene su propio código.

    `reservado` se puede pasar ya calculado cuando quien llama lo tiene de una
    consulta agrupada; así una lista de doscientos saldos no hace doscientas
    sumas.
    """
    momento = momento or ahora()
    from app.core.config import get_settings

    if not get_settings().comision_configurada:
        return Bloqueo(SIN_COMISION)

    # EL ESTADO DEL PROPIO SALDO, LO PRIMERO. Un saldo cancelado por una
    # devolución ya no está en la cola, y contestar «nada lo impide» sobre
    # dinero que ya volvió al comprador es la peor respuesta posible.
    if saldo.status not in SALDO_ABIERTO:
        return Bloqueo(SALDO_NO_PENDIENTE, saldo.status)
    if not saldo.owner_id:
        return Bloqueo(SIN_PROVEEDOR)
    if saldo.net_amount_minor is not None and int(saldo.net_amount_minor) < 0:
        # NO SE PAGA UN SALDO NEGATIVO, y qué se hace con él es una decisión que
        # la empresa no ha tomado: se dice y se para.
        return Bloqueo(SALDO_NEGATIVO, str(saldo.net_amount_minor))
    # PRIMERO LA VENTA, DESPUÉS LA CUENTA, Y EL ORDEN IMPORTA. Lo que más
    # claramente falta en un pedido que todavía no ha llegado es la entrega, no
    # una cuenta de cobro: contestar «te falta la cuenta» sobre un paquete que
    # va de camino le manda a quien vende a arreglar algo que no cambia nada, y
    # encima hoy no puede arreglarlo porque el alta de Connect no existe.
    orden = await db.get(ProductOrder, saldo.product_order_id)
    if orden is None or orden.status != PEDIDO_PAGADO:
        return Bloqueo(PEDIDO_NO_PAGADO)

    envio = await db.get(ProductShipment, saldo.product_order_id)
    if envio is None or envio.delivered_at is None:
        # SIN ENTREGA NO HAY NADA QUE LIBERAR. El reloj de la protección empieza
        # cuando el paquete llega, no cuando se cobra.
        return Bloqueo(SIN_ENTREGA)

    cuando = await cuando_se_puede_liberar(db, orden=orden, envio=envio)
    if cuando is None:
        return Bloqueo(SIN_POLITICA_DE_PROTECCION)
    if cuando > momento:
        return Bloqueo(PROTECCION_EN_CURSO, cuando.isoformat())

    if saldo.payout_account_id is None:
        return Bloqueo(SIN_CUENTA)

    # TENER UNA CUENTA APUNTADA NO ES PODER PAGAR EN ELLA. Un alta a medias, los
    # cobros apagados o una cuenta de otra persona pasarían por «nada lo impide».
    cuenta = await db.get(_OwnerPayoutAccount(), saldo.payout_account_id)
    if (
        cuenta is None
        or not cuenta.payouts_enabled
        or (cuenta.onboarding_status or "") != "active"
        or cuenta.owner_id != saldo.owner_id
    ):
        return Bloqueo(CUENTA_SIN_ALTA)

    if reservado is None:
        reservado = await reservado_de(db, saldo_id=saldo.id)
    if reservado > 0:
        return Bloqueo(RESERVA_VIVA, str(reservado))

    # UNA RECLAMACIÓN VIVA, O UNA RESUELTA QUE DEJÓ ALGO DEBIENDO Y NO SE HA
    # EJECUTADO. La segunda es la que se olvida, y la dejó escrita y probada el
    # Incremento 7 para que este la usara.
    casos = list(
        await db.scalars(
            select(ProductIncident).where(
                ProductIncident.order_id == saldo.product_order_id
            )
        )
    )
    for caso in casos:
        if maquina.bloquea_el_dinero(
            caso.status, caso.resolution, caso.financial_effect
        ):
            return Bloqueo(RECLAMACION_ABIERTA, caso.id)

    #: DOS PREGUNTAS DISTINTAS, Y ANTES ERAN UNA. «Hay algo en marcha» y «se
    #: devolvio dinero de esta venta» bloquean las dos, pero no son lo mismo y
    #: no se arreglan igual.
    viva = await db.scalar(
        select(func.count())
        .select_from(ProductRefund)
        .where(
            ProductRefund.order_id == saldo.product_order_id,
            ProductRefund.status.in_(DEVOLUCION_EN_MARCHA),
        )
    )
    if viva:
        return Bloqueo(DEVOLUCION_VIVA)

    #: YA CONFIRMADA. Para una TOTAL no se llega aqui —el saldo esta cancelado y
    #: el primer bloqueo salta antes—, asi que en la practica esto es la parcial:
    #: el dinero salio, el resto no se paga, y quien lo asume esta sin decidir.
    devuelto = await db.scalar(
        select(func.count())
        .select_from(ProductRefund)
        .where(
            ProductRefund.order_id == saldo.product_order_id,
            ProductRefund.status == DEVOLUCION_CONFIRMADA,
        )
    )
    if devuelto:
        return Bloqueo(DEVOLUCION_SIN_ASIGNAR)

    # POR SALDO O POR PEDIDO. Una disputa abierta antes de que existiera el saldo
    # se queda con `balance_id` nulo, y filtrando solo por `balance_id` no
    # bloquearía nada. Es la misma corrección que costó la 0068.
    disputa = await db.scalar(
        select(func.count())
        .select_from(ProductDispute)
        .where(
            or_(
                ProductDispute.balance_id == saldo.id,
                and_(
                    ProductDispute.order_id.is_not(None),
                    ProductDispute.order_id == saldo.product_order_id,
                ),
            ),
            ProductDispute.status.in_(DISPUTA_VIVA),
        )
    )
    if disputa:
        return Bloqueo(DISPUTA_ABIERTA_BLOQUEA)

    return None


async def liberar_vencidos(
    db: AsyncSession, *, limite: int = 200, momento: datetime | None = None
) -> dict[str, int]:
    """Pasa a `eligible` los saldos DE PRODUCTO que ya no tiene nada que impida.

    SU PROPIO CAMINO, Y NO EL DE CURSOS NI EL DE EVENTOS. El de Cursos mira una
    orden y una garantía que aquí no existen; el de Eventos mira expedientes de
    evento. Este pasa cada saldo por `por_que_no_se_libera`, que es la única
    fuente de la regla.

    IDEMPOTENTE, y se lanza desde fuera: la API puede tener varias réplicas y un
    temporizador dentro de FastAPI se ejecutaría una vez por cada una.
    """
    await exigir_disponible(db)
    momento = momento or ahora()

    candidatos = list(
        await db.scalars(
            select(OwnerSaleBalance)
            .where(
                OwnerSaleBalance.product_order_id.is_not(None),
                OwnerSaleBalance.status == PENDIENTE,
            )
            .order_by(OwnerSaleBalance.created_at)
            .limit(max(1, int(limite)))
        )
    )

    cuenta = {"mirados": 0, "liberados": 0, "bloqueados": 0}
    for candidato in candidatos:
        cuenta["mirados"] += 1
        #: CON CERROJO DE FILA, Y RELEYENDO EL ESTADO. Entre la comprobación y
        #: la escritura cabía una confirmación de devolución que cancelara el
        #: saldo: `_confirmar` sí lo lee con cerrojo, pero esto no lo pedía, así
        #: que el cerrojo del otro lado no protegía nada y se pisaba un
        #: `cancelled` con `eligible`. Dinero ya devuelto al comprador quedaba
        #: marcado como cobrable y contaba en el panel.
        saldo = await db.get(OwnerSaleBalance, candidato.id, with_for_update=True)
        if saldo is None or saldo.status != PENDIENTE:
            cuenta["bloqueados"] += 1
            continue
        bloqueo = await por_que_no_se_libera(db, saldo=saldo, momento=momento)
        if bloqueo is not None:
            cuenta["bloqueados"] += 1
            continue
        saldo.status = ELEGIBLE
        saldo.updated_at = momento
        cuenta["liberados"] += 1
    await db.flush()
    return cuenta


# --------------------------------------------------------------------------- #
# Las reservas: estructura, nunca política.
# --------------------------------------------------------------------------- #
async def reservar(
    db: AsyncSession,
    *,
    saldo: OwnerSaleBalance,
    importe_minor: int,
    motivo: str,
    incidencia_id: str | None = None,
    creado_por: str | None = None,
    momento: datetime | None = None,
) -> OwnerSaleReserve:
    """Aparta un importe de un saldo, con su motivo y su expediente.

    NI UN PORCENTAJE NI UNA DURACIÓN. El importe lo pasa quien llama, y de dónde
    sale es una decisión de la empresa: aquí solo se guarda lo que alguien
    decidió y quién fue.

    UNA RESERVA VIVA POR SALDO Y MOTIVO. Dos por lo mismo serían el mismo dinero
    retenido dos veces, y lo impide un índice único parcial de la 0068.
    """
    await exigir_disponible(db)
    momento = momento or ahora()
    if int(importe_minor) <= 0:
        raise AppError(
            "Una reserva de cero no retiene nada.",
            code="product_reserve_amount_invalid",
        )
    reserva = OwnerSaleReserve(
        balance_id=saldo.id,
        amount_minor=int(importe_minor),
        currency=saldo.currency,
        reason=motivo,
        product_incident_id=incidencia_id,
        status=RESERVA_VIVA_ESTADO,
        created_by=creado_por,
        created_at=momento,
    )
    #: PUNTO DE GUARDADO, NO `rollback` DE TODA LA SESIÓN. Quien más llama a
    #: esto es `devoluciones.aprobar`, que para cuando llega aquí YA escribió
    #: la devolución y su fila de historial: deshacer la transacción entera se
    #: las llevaba por delante, y como el choque se traga a propósito —«ya
    #: estaba apartado, que es lo que se quería»— nadie se enteraba. Quedaba
    #: una anotación de auditoría afirmando una devolución que no existe.
    #: Es el mismo error que `registrar_venta` ya evitaba, y aquí costaba más.
    punto = await db.begin_nested()
    db.add(reserva)
    try:
        await db.flush()
    except IntegrityError:
        await punto.rollback()
        raise AppError(
            "Ya hay una reserva viva por ese motivo en este saldo.",
            code="product_reserve_already_held",
        ) from None
    return reserva


async def soltar_reserva(
    db: AsyncSession,
    *,
    reserva: OwnerSaleReserve,
    consumida: bool,
    actor_id: str | None = None,
    motivo: str | None = None,
    momento: datetime | None = None,
) -> OwnerSaleReserve:
    """Suelta o consume una reserva. Las dos cosas son distintas.

    `released` = el dinero vuelve a estar disponible para el proveedor.
    `consumed` = se gastó en devolverle al comprador, y no vuelve.

    QUIÉN LA SOLTÓ PUEDE SER NADIE: cuando la suelta el sistema al cerrarse un
    expediente, poner ahí un nombre sería mentir.
    """
    await exigir_disponible(db)
    momento = momento or ahora()
    if reserva.status != RESERVA_VIVA_ESTADO:
        return reserva
    reserva.status = RESERVA_CONSUMIDA if consumida else RESERVA_SOLTADA
    reserva.released_at = momento
    reserva.released_by = actor_id
    reserva.release_reason = (motivo or "").strip()[:500] or None
    await db.flush()
    return reserva


async def reservas_de(
    db: AsyncSession, *, saldo_id: str, solo_vivas: bool = False
) -> list[OwnerSaleReserve]:
    consulta = select(OwnerSaleReserve).where(OwnerSaleReserve.balance_id == saldo_id)
    if solo_vivas:
        consulta = consulta.where(OwnerSaleReserve.status == RESERVA_VIVA_ESTADO)
    return list(
        await db.scalars(consulta.order_by(OwnerSaleReserve.created_at.desc()))
    )


# --------------------------------------------------------------------------- #
# Lo que ve quien vende.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Resumen:
    """El saldo de un proveedor, sumado.

    TODO NULO SI NO HAY NADA, y ningún cero de relleno: sin comisión configurada
    no hay ni un saldo, y decir «0,00» daría a entender que vendió y no cobró.
    """

    moneda: str | None
    bruto_minor: int
    comision_minor: int
    neto_minor: int
    retenido_minor: int
    disponible_minor: int
    cuantas_ventas: int
    comision_configurada: bool
    #: Cuántos saldos hay en cada estado, para que la pantalla no lo deduzca.
    por_estado: dict[str, int]


async def resumen_del_proveedor(
    db: AsyncSession, *, usuario_id: str
) -> Resumen:
    """Lo que hay que enseñarle a quien vende, en DOS consultas.

    SIN COMISIÓN CONFIGURADA NO SE INVENTA NADA: la moneda viaja nula, los
    importes en cero **y la bandera dice por qué**, para que la pantalla escriba
    «pendiente de configuración» en vez de un balance falso.
    """
    ajustes_ok = True
    from app.core.config import get_settings

    ajustes_ok = get_settings().comision_configurada

    vacio = Resumen(
        moneda=None,
        bruto_minor=0,
        comision_minor=0,
        neto_minor=0,
        retenido_minor=0,
        disponible_minor=0,
        cuantas_ventas=0,
        comision_configurada=ajustes_ok,
        por_estado={},
    )
    if not await esquema.hay_finanzas(db):
        return vacio

    filas = (
        await db.execute(
            select(
                OwnerSaleBalance.currency,
                OwnerSaleBalance.status,
                func.count(OwnerSaleBalance.id),
                func.coalesce(func.sum(OwnerSaleBalance.gross_amount_minor), 0),
                func.coalesce(func.sum(OwnerSaleBalance.platform_fee_minor), 0),
                func.coalesce(func.sum(OwnerSaleBalance.net_amount_minor), 0),
            )
            .where(
                OwnerSaleBalance.owner_id == usuario_id,
                OwnerSaleBalance.product_order_id.is_not(None),
            )
            .group_by(OwnerSaleBalance.currency, OwnerSaleBalance.status)
        )
    ).all()
    if not filas:
        return vacio

    monedas = {f[0] for f in filas if f[0]}
    bruto = sum(int(f[3]) for f in filas)
    comision = sum(int(f[4]) for f in filas)
    neto = sum(int(f[5]) for f in filas)
    cuantas = sum(int(f[2]) for f in filas)
    por_estado = {}
    for fila in filas:
        por_estado[fila[1]] = por_estado.get(fila[1], 0) + int(fila[2])

    async def _apartado(solo_liberables: bool) -> int:
        consulta = (
            select(func.coalesce(func.sum(OwnerSaleReserve.amount_minor), 0))
            .select_from(OwnerSaleReserve)
            .join(
                OwnerSaleBalance,
                OwnerSaleBalance.id == OwnerSaleReserve.balance_id,
            )
            .where(
                OwnerSaleBalance.owner_id == usuario_id,
                OwnerSaleBalance.product_order_id.is_not(None),
                OwnerSaleReserve.status == RESERVA_VIVA_ESTADO,
            )
        )
        if solo_liberables:
            consulta = consulta.where(
                OwnerSaleBalance.status.in_((ELEGIBLE, EN_TRANSFERENCIA))
            )
        return int(await db.scalar(consulta) or 0)

    #: LO APARTADO, ENTERO, que es lo que se enseña.
    retenido = await _apartado(False)

    #: Y LO APARTADO SOBRE LO QUE YA SE PODRIA PAGAR, que es lo unico que se
    #: puede RESTAR del disponible.
    #:
    #: ANTES SE RESTABA EL TOTAL, y eso mezcla dos conjuntos distintos: una
    #: retencion sobre un saldo que todavia no esta para pagar —porque el
    #: paquete va de camino, o porque hay una disputa— no tiene nada que ver con
    #: el dinero que si esta listo, y le bajaba la cifra a quien vende por una
    #: venta que no entraba en ella.
    apartado_de_lo_liberable = await _apartado(True)

    disponible = sum(
        int(f[5]) for f in filas if f[1] in (ELEGIBLE, EN_TRANSFERENCIA)
    )

    return Resumen(
        #: UNA SOLA MONEDA O NINGUNA. Sumar dos monedas distintas da un número
        #: que no significa nada, así que si hay más de una se dice que no se
        #: sabe y la pantalla lo separa.
        moneda=next(iter(monedas)) if len(monedas) == 1 else None,
        bruto_minor=bruto,
        comision_minor=comision,
        neto_minor=neto,
        retenido_minor=retenido,
        disponible_minor=max(0, disponible - apartado_de_lo_liberable),
        cuantas_ventas=cuantas,
        comision_configurada=ajustes_ok,
        por_estado=por_estado,
    )


async def saldos_del_proveedor(
    db: AsyncSession,
    *,
    usuario_id: str,
    antes_de: tuple[datetime, str] | None = None,
    limite: int = 20,
) -> list[OwnerSaleBalance]:
    """Los movimientos, de lo más nuevo a lo más viejo, con cursor estable."""
    await exigir_disponible(db)
    consulta = select(OwnerSaleBalance).where(
        OwnerSaleBalance.owner_id == usuario_id,
        OwnerSaleBalance.product_order_id.is_not(None),
    )
    if antes_de is not None:
        creado, ident = antes_de
        consulta = consulta.where(
            (OwnerSaleBalance.created_at < creado)
            | (
                (OwnerSaleBalance.created_at == creado)
                & (OwnerSaleBalance.id < ident)
            )
        )
    return list(
        await db.scalars(
            consulta.order_by(
                OwnerSaleBalance.created_at.desc(), OwnerSaleBalance.id.desc()
            ).limit(max(1, min(int(limite), 50)))
        )
    )


__all__ = [
    "BLOQUEOS",
    "CANCELADO",
    "CUENTA_SIN_ALTA",
    "DEVOLUCION_VIVA",
    "DISPUTA_ABIERTA_BLOQUEA",
    "ELEGIBLE",
    "EN_TRANSFERENCIA",
    "FALLIDO",
    "PENDIENTE",
    "PEDIDO_NO_PAGADO",
    "PROTECCION_EN_CURSO",
    "RECLAMACION_ABIERTA",
    "RESERVA_CONSUMIDA",
    "RESERVA_POR_DEVOLUCION",
    "RESERVA_POR_DISPUTA",
    "RESERVA_POR_RECLAMACION",
    "RESERVA_SOLTADA",
    "RESERVA_VIVA",
    "RESERVA_VIVA_ESTADO",
    "RETENIDO",
    "SALDO_ABIERTO",
    "SALDO_NEGATIVO",
    "SALDO_NO_PENDIENTE",
    "SIN_COMISION",
    "SIN_CUENTA",
    "SIN_ENTREGA",
    "SIN_POLITICA_DE_PROTECCION",
    "SIN_PROVEEDOR",
    "TRANSFERIDO",
    "Bloqueo",
    "FinanzasNoDisponibles",
    "Resumen",
    "ahora",
    "cuando_se_puede_liberar",
    "exigir_disponible",
    "horas_de_proteccion",
    "liberar_vencidos",
    "por_que_no_se_libera",
    "registrar_venta",
    "reservado_de",
    "reservar",
    "reservas_de",
    "resumen_del_proveedor",
    "saldo_del_pedido",
    "saldos_del_proveedor",
    "soltar_reserva",
]
