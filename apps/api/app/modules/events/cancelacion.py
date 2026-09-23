"""Cancelar un evento entero. LA REGLA VIVE AQUÍ Y SOLO AQUÍ.

LA EMPRESA YA CONTESTÓ:

    Si el organizador cancela totalmente un evento que no se realizará,
    corresponde devolver al comprador el 100 % de lo pagado por la entrada,
    aunque su política particular diga otra cosa.

Es una regla de Z y PREVALECE sobre cualquier condición del organizador que la
contradiga. Por eso vive en una constante y no en un `if` repartido por
endpoints, pantallas y webhooks: quien necesita saber si rige pregunta aquí.

DECIDIR NO ES HABER PAGADO, y es la distinción que sostiene todo lo demás. Esta
cancelación deja el expediente en `refund_pending` con el importe: eso significa
«corresponde devolver». Que el dinero volvió de verdad solo lo dice un aviso
verificado del proveedor, que es el único camino a `resolved`. Aquí no se marca
nada como pagado, no se revoca ninguna entrada y no se libera ningún saldo: lo
vendido se RETIENE, que es reversible, mientras pagar no lo es.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.catalog.models import Event
from app.modules.events import esquema
from app.modules.events.models import EventOrder
from app.modules.events.posventa_models import (
    APROBADO,
    DEVOLUCION_PENDIENTE,
    EN_REVISION,
    ENVIADO,
    ESPERANDO,
    EXPEDIENTES_VIVOS,
    RESUELTO,
    EventAftersaleCase,
)

logger = logging.getLogger(__name__)

#: LA DECISIÓN EMPRESARIAL, y el único sitio donde vive.
#:
#:   * `True`  — Z exige devolución total pase lo que pase.   <- confirmada
#:   * `False` — manda la política que aceptó cada compra.
#:   * `None`  — sin decidir. Se bloquea y se revisa a mano.
#:
#: Contestada el 12/09/2026: `True`. El tri-estado se conserva porque `None` es
#: la única postura que no adelanta una decisión, y volverá a hacer falta la
#: próxima vez que aparezca una pregunta sin respuesta.
DEVOLUCION_TOTAL_OBLIGATORIA: bool | None = True

#: El código con el que se anota la excepción. Un código, no una frase: así se
#: puede contar cuántos expedientes se resolvieron por mandato de Z y no por la
#: política del organizador.
MANDATO = "z_mandatory_full_refund"

#: EL 100 %, en puntos básicos. Es la misma unidad que `cancelled_event_bps`,
#: para poder comparar lo que promete una política con lo que Z exige.
BPS_DEL_MANDATO = 10_000

#: DESDE DÓNDE PUEDE DECIDIR EL MANDATO. Los estados en los que todavía no se
#: ha decidido nada sobre el dinero.
#:
#: `refund_pending` y `refund_processing` NO están: en el primero la decisión ya
#: es la correcta y en el segundo el dinero va de camino. `failed` tampoco: un
#: intento que falló necesita que lo mire una persona, y rearmarlo solo haría un
#: bucle contra el mismo fallo.
ANTES_DE_DECIDIR = (ENVIADO, EN_REVISION, ESPERANDO, APROBADO)

#: El expediente que abre una cancelación total. Ya existía en la 0064.
TIPO_DE_EXPEDIENTE = "event_cancelled"

#: Por qué se retiene el importe. Ya existía en la 0068.
MOTIVO_DE_RESERVA = "cancellation"

#: Lo que se le dice a quien revisa. Un código, no una frase.
PENDIENTE_DE_DECISION = "pending_business_decision"

#: CUÁNTOS PEDIDOS SE ATIENDEN POR LLAMADA.
#:
#: Atender cada pedido cuesta una docena de viajes a la base —expediente,
#: política aceptada, saldo, reserva y dos avisos— y todo esto corre con la fila
#: del evento bloqueada. Sin cota, un evento de quinientas compras se convertía
#: en cinco mil idas y vueltas en una sola petición: agotaba el tiempo, se
#: deshacía entero, y reintentar volvía a empezar desde cero. Justo el evento que
#: más importa cancelar bien era el único que no se podía cancelar.
#:
#: Con cota, la primera llamada deja el evento CANCELADO —eso siempre pasa— y
#: devuelve cuántos quedan. Es reanudable porque abrir un expediente y retener
#: un importe son las dos idempotentes.
POR_TANDA = 100


def ahora() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class Resultado:
    """Qué se hizo con una cancelación. Ningún importe se movió."""

    #: Qué regla se aplicó: `pending_business_decision`, `full_refund_required`
    #: o `policy_applies`.
    regla: str
    expedientes: int
    saldos_bloqueados: int
    #: Pedidos pagados que no tenían saldo. Sin comisión configurada son todos,
    #: y no es un fallo: es que no había nada que bloquear.
    sin_saldo: int
    avisos: int
    #: Expedientes en los que se decidió que corresponde la devolución total.
    #: NO es dinero devuelto: es dinero que Z debe.
    devoluciones_decididas: int = 0
    #: Pedidos pagados que quedan por atender. Mayor que cero significa que hay
    #: que volver a llamar: el evento YA está cancelado y lo vendido se atiende
    #: por tandas.
    pendientes: int = 0


def regla_vigente() -> str:
    """Qué toca hacer hoy. Una sola lectura, un solo sitio."""
    if DEVOLUCION_TOTAL_OBLIGATORIA is None:
        return PENDIENTE_DE_DECISION
    return "full_refund_required" if DEVOLUCION_TOTAL_OBLIGATORIA else "policy_applies"


def _elevables() -> tuple[str, ...]:
    """Los estados de los que el mandato todavía puede sacar una decisión.

    Vacío cuando el mandato no rige: entonces un expediente vivo está atendido
    por el solo hecho de existir, y volver a mirarlo solo repetiría notas.
    """
    return ANTES_DE_DECIDIR if rige_el_mandato() else ()


def rige_el_mandato() -> bool:
    """Si Z exige la devolución total cuando el organizador cancela.

    LO PREGUNTAN TRES SITIOS —la cancelación, la elegibilidad y la aprobación—
    y ninguno guarda su propia copia. Una cuarta copia sería una respuesta vieja
    esperando a que alguien cambie la de aquí.
    """
    return DEVOLUCION_TOTAL_OBLIGATORIA is True


async def aplica_a(db: AsyncSession, *, orden: EventOrder) -> bool:
    """Si el mandato rige para esta compra: evento cancelado y regla activa.

    LO OPERATIVO MANDA. `events.status` es visibilidad —un evento cancelado se
    esconde— y `EventOperations.workflow_status` es lo que de verdad pasó. Mirar
    la visibilidad haría que ocultar un evento pareciera cancelarlo.
    """
    if not rige_el_mandato():
        return False
    from app.modules.events.models import EventOperations
    from app.modules.events.states import CANCELADO as EVENTO_CANCELADO

    operacion = await db.get(EventOperations, orden.event_id)
    return operacion is not None and operacion.workflow_status == EVENTO_CANCELADO


async def por_devolver(db: AsyncSession, *, pedido: EventOrder) -> int:
    """Cuánto queda por devolverle, en unidades menores. El 100 % MENOS lo ya
    devuelto.

    SOLO CUENTA LO QUE VOLVIÓ DE VERDAD: un expediente `resolved` con resultado
    de devolución. Uno decidido y sin ejecutar no ha devuelto nada, y restarlo
    dejaría al comprador con la mitad de lo que Z le debe.
    """
    pagado = int(getattr(pedido, "total_minor", 0) or 0)
    if pagado <= 0 or not await esquema.hay_posventa(db):
        return max(0, pagado)
    ya = await db.scalar(
        select(func.coalesce(func.sum(EventAftersaleCase.refund_amount_minor), 0)).where(
            EventAftersaleCase.order_id == pedido.id,
            EventAftersaleCase.status == RESUELTO,
            EventAftersaleCase.outcome.in_(("full_refund", "partial_refund")),
        )
    )
    return max(0, pagado - int(ya or 0))


async def decidir_la_devolucion(
    db: AsyncSession,
    *,
    caso: EventAftersaleCase,
    pedido: EventOrder,
    actor_id: str | None,
    momento: datetime,
) -> bool:
    """Deja constancia de que CORRESPONDE devolver el 100 %. No devuelve nada.

    El expediente queda en `refund_pending` con el importe y la moneda, y el
    historial dice que lo decidió el mandato de Z y no una persona. De ahí solo
    sale ejecutando contra el proveedor, y de la ejecución solo sale con un
    aviso verificado: por eso esto no puede acabar diciendo «devuelto».

    IDEMPOTENTE: un expediente que ya pasó de la decisión no se toca, así que
    reintentar una cancelación —o atender la siguiente tanda— no lo mueve dos
    veces ni duplica su historial.
    """
    from app.modules.events import posventa
    from app.modules.events import posventa_estados as maquina

    if not rige_el_mandato() or caso.status not in ANTES_DE_DECIDIR:
        return False

    importe = await por_devolver(db, pedido=pedido)
    if importe <= 0:
        logger.info(
            "[eventos] el pedido %s ya tenia devuelto todo lo pagado: el mandato "
            "no decide nada nuevo.",
            pedido.id,
        )
        return False

    # UN RESULTADO ANTERIOR QUE DIGA OTRA COSA DEJA DE VALER. Si alguien aprobó
    # este expediente aplicando una política de «sin devolución», el mandato
    # prevalece: se retira ese resultado y se anota por qué. No se reescribe
    # ninguna política —la versión que aceptó esa compra es intocable—, se
    # rectifica la DECISIÓN.
    if caso.outcome in ("no_refund", "partial_refund"):
        caso.internal_notes = _anotar(
            caso.internal_notes,
            f"el resultado anterior ({caso.outcome}) queda sin efecto",
            MANDATO,
        )
        caso.outcome = None
        await db.flush()

    try:
        await posventa.transicionar(
            db,
            expediente_id=caso.id,
            hasta=DEVOLUCION_PENDIENTE,
            actor_id=actor_id,
            actor_rol=maquina.SISTEMA,
            motivo=MANDATO,
            importe_minor=importe,
            moneda=pedido.currency,
            momento=momento,
        )
    except posventa.ExpedienteCambiado:
        # Alguien lo movió entre mirar y escribir. No se fuerza: la siguiente
        # llamada lo vuelve a mirar con su estado nuevo.
        logger.warning(
            "[eventos] el expediente %s cambio mientras se aplicaba el mandato",
            caso.id,
        )
        return False
    return True


async def cancelar_evento(
    db: AsyncSession,
    *,
    evento_id: str,
    actor_id: str | None,
    motivo: str,
    limite: int = POR_TANDA,
    momento: datetime | None = None,
) -> Resultado:
    """Cancela el evento y deja todo lo vendido BLOQUEADO y a la vista.

    QUÉ HACE, EXACTAMENTE:

      1. abre —o recupera— un expediente por cada pedido pagado;
      2. retiene el importe del saldo de cada uno, si existe;
      3. avisa a quien compró y a quien organiza;
      4. deja constancia de la causa y de la política que regía.

    QUÉ NO HACE, Y ES LO IMPORTANTE: no devuelve, no rechaza, no libera ningún
    saldo y no transfiere nada. Ni un céntimo se mueve por este camino.

    NO CAMBIA EL ESTADO DEL EVENTO: de eso se encarga quien llama, en la misma
    transacción. Aquí se atiende lo vendido.
    """
    momento = momento or ahora()
    regla = regla_vigente()
    if not await esquema.hay_ordenes(db):
        return Resultado(regla, 0, 0, 0, 0, 0, 0)

    # LOS QUE QUEDAN POR ATENDER, y solo una tanda.
    #
    # NO ES «LOS QUE NO TIENEN EXPEDIENTE VIVO». Quien ya había pedido una
    # devolución tiene el suyo abierto en `submitted`, y filtrarlo entero dejaba
    # justo a esa persona sin la devolución que Z le debe: su solicitud no se
    # duplica, se ELEVA. Lo que sí está atendido es un expediente que ya pasó de
    # la decisión —el dinero va de camino, o falló y lo mira alguien—.
    atendidos = tuple(e for e in EXPEDIENTES_VIVOS if e not in _elevables())
    sin_atender = select(EventOrder).where(
        EventOrder.event_id == evento_id,
        EventOrder.status == "PAID",
    )
    if await esquema.hay_posventa(db):
        sin_atender = sin_atender.where(
            ~select(EventAftersaleCase.id)
            .where(
                EventAftersaleCase.order_id == EventOrder.id,
                EventAftersaleCase.status.in_(atendidos),
            )
            .exists()
        )
    quedan = int(
        await db.scalar(
            select(func.count()).select_from(sin_atender.subquery())
        )
        or 0
    )
    pedidos = list(
        await db.scalars(
            sin_atender.order_by(EventOrder.created_at, EventOrder.id).limit(
                max(1, min(int(limite), 500))
            )
        )
    )
    if not pedidos:
        return Resultado(regla, 0, 0, 0, 0, 0, 0)

    expedientes = 0
    bloqueados = 0
    sin_saldo = 0
    avisos = 0
    decididas = 0

    for pedido in pedidos:
        caso = await _expediente_de(
            db,
            pedido=pedido,
            actor_id=actor_id,
            motivo=motivo,
            momento=momento,
        )
        if caso is None:
            continue
        expedientes += 1

        retenido = await _bloquear_lo_vendido(
            db, pedido=pedido, caso=caso, momento=momento
        )
        if retenido is None:
            sin_saldo += 1
        elif retenido:
            bloqueados += 1

        # PRIMERO SE RETIENE, DESPUÉS SE DECIDE. Al revés, entre las dos cosas
        # cabría una liberación por vencimiento sobre un importe que ya se debe.
        if await decidir_la_devolucion(
            db, caso=caso, pedido=pedido, actor_id=actor_id, momento=momento
        ):
            decididas += 1

        avisos += await _avisar(db, caso=caso, pedido=pedido)

    logger.info(
        "[eventos] cancelacion total del evento %s: regla=%s expedientes=%s "
        "saldos_bloqueados=%s sin_saldo=%s devoluciones_decididas=%s. "
        "NO se movio dinero: decidir no es haber pagado.",
        evento_id,
        regla,
        expedientes,
        bloqueados,
        sin_saldo,
        decididas,
    )
    return Resultado(
        regla,
        expedientes,
        bloqueados,
        sin_saldo,
        avisos,
        decididas,
        max(0, quedan - len(pedidos)),
    )


async def _expediente_de(
    db: AsyncSession,
    *,
    pedido: EventOrder,
    actor_id: str | None,
    motivo: str,
    momento: datetime,
) -> EventAftersaleCase | None:
    """Abre el expediente de esta compra, o recupera el que ya estuviera vivo.

    UNO VIVO POR PEDIDO, y lo impone un índice parcial de la 0064. Si el
    comprador ya tenía una solicitud abierta, se usa esa: abrirle otra sería
    partir su caso en dos.
    """
    from app.modules.events import aceptacion, posventa
    from app.modules.events.posventa_models import POLITICA_ELEGIBILIDAD

    if not await esquema.hay_posventa(db):
        return None

    vivo = await db.scalar(
        select(EventAftersaleCase).where(
            EventAftersaleCase.order_id == pedido.id,
            EventAftersaleCase.status.in_(EXPEDIENTES_VIVOS),
        )
    )
    # LA POLÍTICA QUE REGÍA PARA ESTA COMPRA, no la de hoy.
    regia = await aceptacion.la_que_rige(
        db, orden_id=pedido.id, tipo=POLITICA_ELEGIBILIDAD
    )
    nota = (
        f"cancelación del evento: {motivo}".strip()[:500]
        if motivo
        else "cancelación del evento"
    )

    if vivo is not None:
        # Se anota la causa sin pisar lo que escribió el comprador.
        vivo.internal_notes = _anotar(vivo.internal_notes, nota, regla_vigente())
        if regia is not None and vivo.policy_id is None:
            vivo.policy_id = regia.id
        vivo.updated_at = momento
        await db.flush()
        return vivo

    from app.modules.events import posventa_estados as maquina

    evento = await db.get(Event, pedido.event_id)
    organizador = getattr(evento, "organizer_id", None)
    if not organizador:
        return None
    caso = await posventa.abrir(
        db,
        orden=pedido,
        organizador_id=organizador,
        tipo=TIPO_DE_EXPEDIENTE,
        motivo=nota,
        actor_id=actor_id,
        actor_rol=maquina.ORGANIZADOR,
        origen="organizer",
    )
    if caso is None:
        return None
    caso.internal_notes = _anotar(caso.internal_notes, nota, regla_vigente())
    if regia is not None:
        caso.policy_id = regia.id
    caso.updated_at = momento
    await db.flush()
    return caso


def _anotar(anterior: str | None, nota: str, regla: str) -> str:
    """La causa y la regla aplicada, sin borrar lo anterior.

    IDEMPOTENTE: si esa línea exacta ya está, no se repite. Un reintento no es
    un hecho nuevo, y la nota interna tiene un tope de dos mil caracteres que se
    llenaría de copias hasta tapar lo que escribió una persona.
    """
    linea = f"[{regla}] {nota}"
    if not anterior:
        return linea[:2000]
    if linea in anterior:
        return anterior
    return f"{anterior}\n{linea}"[:2000]


async def _bloquear_lo_vendido(
    db: AsyncSession,
    *,
    pedido: EventOrder,
    caso: EventAftersaleCase,
    momento: datetime,
) -> bool | None:
    """Retiene el neto del saldo de esta compra. `None` si no hay saldo.

    SE RETIENE EL NETO ENTERO, y no un porcentaje: cuánto le corresponde al
    organizador de un evento cancelado es justo la decisión que falta. Retener
    todo es la única postura que no la adelanta —y es reversible, mientras que
    pagar no lo es—.
    """
    from app.modules.commerce.models import OwnerSaleBalance
    from app.modules.events import finanzas

    if not await esquema.hay_finanzas(db):
        return None
    saldo = await db.scalar(
        select(OwnerSaleBalance).where(OwnerSaleBalance.event_order_id == pedido.id)
    )
    if saldo is None:
        # Sin comisión configurada no se creó ninguno. No hay nada que bloquear.
        return None
    if saldo.status in (finanzas.EN_TRANSFERENCIA, finanzas.TRANSFERIDO):
        logger.error(
            "[eventos] el evento se cancelo con el saldo del pedido %s ya en %s. "
            "Queda para conciliacion manual: no se genera ninguna devolucion "
            "automatica contra el organizador.",
            pedido.id,
            saldo.status,
        )
        return False
    reserva = await finanzas.reservar(
        db,
        saldo=saldo,
        importe_minor=int(saldo.net_amount_minor or 0),
        motivo=MOTIVO_DE_RESERVA,
        caso_id=caso.id,
        momento=momento,
    )
    return reserva is not None


#: QUÉ SE LE DICE A CADA PARTE, SEGÚN LA REGLA QUE RIGE. La tabla está aquí y
#: no en los textos porque es la regla la que decide qué se puede prometer.
AVISOS = {
    "full_refund_required": (
        "event_cancelled_full_refund",
        "event_cancelled_organizer_full_refund",
    ),
    PENDIENTE_DE_DECISION: (
        "event_cancelled_under_review",
        "event_cancelled_organizer_notice",
    ),
    "policy_applies": (
        "event_cancelled_under_review",
        "event_cancelled_organizer_notice",
    ),
}


async def _avisar(
    db: AsyncSession, *, caso: EventAftersaleCase, pedido: EventOrder
) -> int:
    """Le dice a las dos partes lo que se ha DECIDIDO. Nunca que ya se pagó.

    Bajo el mandato el aviso sí dice que corresponde la devolución total, porque
    eso es un hecho decidido. Lo que sigue sin decir es cuándo llega el dinero:
    el plazo bancario no lo decidimos nosotros.
    """
    from app.modules.events import avisos

    al_comprador, al_organizador = AVISOS[regla_vigente()]
    cuantos = 0
    # AL COMPRADOR, POR SU EXPEDIENTE: uno por persona y por compra.
    if caso.buyer_id and await avisos.encolar(
        db,
        usuario_id=caso.buyer_id,
        tipo=al_comprador,
        entidad_id=caso.id,
    ):
        cuantos += 1
    # A QUIEN ORGANIZA, POR EL EVENTO. Con el identificador del expediente, la
    # clave anti-duplicado era distinta en cada pedido y el mismo teléfono
    # recibía quinientas veces «cancelaste el evento». Canceló uno, no
    # quinientos.
    if caso.organizer_id and await avisos.encolar(
        db,
        usuario_id=caso.organizer_id,
        tipo=al_organizador,
        entidad_id=caso.event_id,
    ):
        cuantos += 1
    return cuantos


__all__ = [
    "BPS_DEL_MANDATO",
    "DEVOLUCION_TOTAL_OBLIGATORIA",
    "MANDATO",
    "MOTIVO_DE_RESERVA",
    "PENDIENTE_DE_DECISION",
    "Resultado",
    "TIPO_DE_EXPEDIENTE",
    "aplica_a",
    "cancelar_evento",
    "decidir_la_devolucion",
    "por_devolver",
    "regla_vigente",
    "rige_el_mandato",
]
