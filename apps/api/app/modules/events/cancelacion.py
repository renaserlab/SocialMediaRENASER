"""Cancelar un evento entero. LA REGLA VIVE AQUÍ Y SOLO AQUÍ.

LA PREGUNTA QUE LA EMPRESA NO HA CONTESTADO:

    Si el organizador cancela completamente el evento, ¿Z exige SIEMPRE la
    devolución total, independientemente de la política particular?

Mientras no haya respuesta, `DEVOLUCION_TOTAL_OBLIGATORIA` vale `None`, que NO
es «no» ni «sí»: es «sin decidir». Y sin decidir no se devuelve automáticamente,
no se rechaza automáticamente, no se libera ningún saldo y no se transfiere nada.
Se BLOQUEA el importe, se abre el expediente, se avisa a las dos partes y se
deja para que lo mire una persona.

CUANDO LA EMPRESA CONTESTE, se cambia ese único valor. Por eso esta regla no
está repartida entre el endpoint, la pantalla y el webhook: repartida, cambiarla
significaría encontrar todos los sitios, y alguno se quedaría con la respuesta
vieja.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.catalog.models import Event
from app.modules.events import esquema
from app.modules.events.models import EventOrder
from app.modules.events.posventa_models import (
    EXPEDIENTES_VIVOS,
    EventAftersaleCase,
)

logger = logging.getLogger(__name__)

#: LA DECISIÓN EMPRESARIAL PENDIENTE, y el único sitio donde vive.
#:
#:   * `None`  — sin decidir. Se bloquea y se revisa a mano.
#:   * `True`  — Z exige devolución total pase lo que pase.
#:   * `False` — manda la política que aceptó cada compra.
#:
#: No se pone `False` «mientras tanto»: `False` es una respuesta, y nadie la ha
#: dado. Un valor por defecto elegido por comodidad es una decisión empresarial
#: tomada por descuido.
DEVOLUCION_TOTAL_OBLIGATORIA: bool | None = None

#: El expediente que abre una cancelación total. Ya existía en la 0064.
TIPO_DE_EXPEDIENTE = "event_cancelled"

#: Por qué se retiene el importe. Ya existía en la 0068.
MOTIVO_DE_RESERVA = "cancellation"

#: Lo que se le dice a quien revisa. Un código, no una frase.
PENDIENTE_DE_DECISION = "pending_business_decision"


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


def regla_vigente() -> str:
    """Qué toca hacer hoy. Una sola lectura, un solo sitio."""
    if DEVOLUCION_TOTAL_OBLIGATORIA is None:
        return PENDIENTE_DE_DECISION
    return "full_refund_required" if DEVOLUCION_TOTAL_OBLIGATORIA else "policy_applies"


async def cancelar_evento(
    db: AsyncSession,
    *,
    evento_id: str,
    actor_id: str | None,
    motivo: str,
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
        return Resultado(regla, 0, 0, 0, 0)

    pedidos = list(
        await db.scalars(
            select(EventOrder).where(
                EventOrder.event_id == evento_id, EventOrder.status == "PAID"
            )
        )
    )
    if not pedidos:
        return Resultado(regla, 0, 0, 0, 0)

    expedientes = 0
    bloqueados = 0
    sin_saldo = 0
    avisos = 0

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

        avisos += await _avisar(db, caso=caso, pedido=pedido)

    logger.info(
        "[eventos] cancelacion total del evento %s: regla=%s expedientes=%s "
        "saldos_bloqueados=%s sin_saldo=%s. NO se movio dinero.",
        evento_id,
        regla,
        expedientes,
        bloqueados,
        sin_saldo,
    )
    return Resultado(regla, expedientes, bloqueados, sin_saldo, avisos)


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
    """La causa y la regla aplicada, sin borrar lo anterior."""
    linea = f"[{regla}] {nota}"
    if not anterior:
        return linea[:2000]
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


async def _avisar(
    db: AsyncSession, *, caso: EventAftersaleCase, pedido: EventOrder
) -> int:
    """Le dice a las dos partes que está EN EVALUACIÓN. Nunca que se devolverá.

    El aviso no promete nada: un plazo o un importe aquí serían una decisión que
    nadie ha tomado, dicha con el tono de que ya está tomada.
    """
    from app.modules.events import avisos

    cuantos = 0
    for destinatario, tipo in (
        (caso.buyer_id, "event_cancelled_under_review"),
        (caso.organizer_id, "event_cancelled_organizer_notice"),
    ):
        if not destinatario:
            continue
        if await avisos.encolar(
            db, usuario_id=destinatario, tipo=tipo, entidad_id=caso.id
        ):
            cuantos += 1
    return cuantos


__all__ = [
    "DEVOLUCION_TOTAL_OBLIGATORIA",
    "MOTIVO_DE_RESERVA",
    "PENDIENTE_DE_DECISION",
    "Resultado",
    "TIPO_DE_EXPEDIENTE",
    "cancelar_evento",
    "regla_vigente",
]
