"""Qué le pasa a una entrada por culpa de un expediente.

UN SOLO SITIO. Antes de esto, «retirar el acceso» era algo que podía ocurrir
desde el webhook, desde la revisión o desde una cancelación de evento, y cada
camino tenía sus propias condiciones. Aquí están las condiciones, una vez.

LO QUE NO REVOCA, Y ES CASI TODO:

    abrir una solicitud            no revoca
    pasarla a revisión             no revoca
    aprobarla                      no revoca; aprobar no es haber devuelto
    un intento de cobro devuelto   no revoca hasta que esté confirmado
    un timeout                     no revoca
    una respuesta ilegible         no revoca
    un aviso sin importe, moneda
      o referencia válida          no revoca
    una devolución PARCIAL         no revoca sin política que lo diga
    cancelar el evento             no revoca por sí solo

Lo único que puede revocar es una devolución TOTAL, CONFIRMADA, del pedido
correcto, y solo si la política publicada dice que revoque. Sin política, la
entrada se queda retenida y a la vista de una persona: retenida es reversible y
revocada no.

Y RESTAURAR NO DEVUELVE LA CREDENCIAL VIEJA. Levantar una retención no puede
reactivar un QR que estuvo fuera de servicio: se invalida y su dueño recibe uno
nuevo al abrir su entrada. Las reglas criptográficas no se repiten aquí; se
piden a `tickets`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError
from app.modules.events import esquema, politicas
from app.modules.events import tickets as emision
from app.modules.events.models import ENTRADA_REVOCADA, ENTRADA_VALIDA, EventTicket
from app.modules.events.posventa_models import (
    POLITICA_EFECTO_ENTRADA,
    EventAftersaleCase,
    EventAftersaleCaseTicket,
)

NINGUNO = "none"
EN_REVISION = "under_review"
BLOQUEADA = "blocked"
CANCELADA = "cancelled"
REVOCADA = "revoked"
RESTAURADA = "restored"

EFECTOS = (NINGUNO, EN_REVISION, BLOQUEADA, CANCELADA, REVOCADA, RESTAURADA)

#: Los que impiden pasar por la puerta y SE PUEDEN LEVANTAR. Es la diferencia
#: que importa: retener es reversible, revocar no.
RETIENEN = frozenset({EN_REVISION, BLOQUEADA})
#: Los que ya no se levantan solos.
TERMINALES = frozenset({CANCELADA, REVOCADA})


class EfectoNoPermitido(AppError):
    """Ese efecto no se puede aplicar desde aquí, o no con estos hechos."""

    status_code = 409
    code = "event_ticket_effect_not_allowed"


@dataclass(frozen=True)
class Resultado:
    """Qué se aplicó de verdad. `cambiadas` es cero cuando ya estaba así."""

    efecto: str
    cambiadas: int
    revocadas: int = 0


def ahora() -> datetime:
    return datetime.now(timezone.utc)


async def retencion_viva(db: AsyncSession, entrada_id: str) -> str | None:
    """El efecto que retiene esta entrada ahora mismo, o `None`.

    Lo consulta la PUERTA antes de dejar pasar. Una consulta por índice; si la
    0064/0065 no están, no hay retención posible y no se consulta nada.
    """
    if not await esquema.hay_posventa(db):
        return None
    return await db.scalar(
        select(EventAftersaleCaseTicket.effect).where(
            EventAftersaleCaseTicket.ticket_id == entrada_id,
            EventAftersaleCaseTicket.effect.in_(tuple(RETIENEN)),
        )
    )


async def aplicar(
    db: AsyncSession,
    *,
    caso: EventAftersaleCase,
    efecto: str,
    actor_id: str | None,
    motivo: str | None = None,
    momento: datetime | None = None,
) -> Resultado:
    """Aplica un efecto a todas las entradas del expediente.

    IDEMPOTENTE Y CONDICIONAL: el `where` incluye el efecto que se espera
    encontrar, así que aplicar dos veces lo mismo cambia cero filas y dos
    procesos concurrentes no dejan efectos distintos sobre la misma entrada.

    NO REVOCA. Revocar tiene su propia función y sus propias condiciones.
    """
    if efecto not in EFECTOS:
        raise ValueError(f"Efecto desconocido: {efecto}")
    if efecto == REVOCADA:
        raise EfectoNoPermitido(
            "Revocar no se aplica desde aquí: exige una devolución confirmada.",
        )
    momento = momento or ahora()

    if efecto == NINGUNO:
        # Levantar una retención. Los terminales no se levantan.
        desde = tuple(RETIENEN)
        valores = {
            "effect": NINGUNO,
            "effect_reason": None,
            "effect_at": None,
            "effect_by": None,
        }
    else:
        # Solo se pisa lo que NO es terminal: una entrada revocada o cancelada
        # no vuelve a «en revisión» por un paso posterior del expediente.
        desde = (NINGUNO, EN_REVISION, BLOQUEADA, RESTAURADA)
        valores = {
            "effect": efecto,
            "effect_reason": (motivo or "").strip()[:500] or None,
            "effect_at": momento,
            "effect_by": actor_id,
        }

    hechas = await db.execute(
        update(EventAftersaleCaseTicket)
        .where(
            EventAftersaleCaseTicket.case_id == caso.id,
            EventAftersaleCaseTicket.effect.in_(desde),
            EventAftersaleCaseTicket.effect != efecto,
        )
        .values(**valores)
    )
    await _anotar(
        db,
        caso=caso,
        efecto=efecto,
        cambiadas=hechas.rowcount or 0,
        actor_id=actor_id,
        motivo=motivo,
    )
    return Resultado(efecto=efecto, cambiadas=hechas.rowcount or 0)


async def revocar_por_devolucion(
    db: AsyncSession,
    *,
    caso: EventAftersaleCase,
    importe_devuelto_minor: int | None,
    moneda: str | None,
    referencia: str | None,
    confirmada: bool,
    actor_id: str | None = None,
    momento: datetime | None = None,
) -> Resultado:
    """El ÚNICO camino que retira el acceso, y con cinco condiciones.

    1. La devolución tiene que estar CONFIRMADA. Un intento, un timeout o una
       respuesta que no se entiende no son una devolución.
    2. Tiene que traer importe, moneda y referencia. La ausencia de un dato no
       vale como coincidencia: sin importe no se puede saber si fue total.
    3. La moneda tiene que ser la del pedido.
    4. Tiene que ser TOTAL. Una parcial no retira la entrada entera salvo que
       una política publicada lo diga expresamente.
    5. La política de efecto sobre la entrada tiene que decir que se revoque.
       Sin política, la entrada se queda RETENIDA —reversible— y a la vista.
    """
    momento = momento or ahora()

    if not confirmada:
        return await _retener(
            db, caso=caso, motivo="devolución sin confirmar", actor_id=actor_id,
            momento=momento,
        )
    if importe_devuelto_minor is None or not moneda or not (referencia or "").strip():
        return await _retener(
            db, caso=caso, motivo="aviso incompleto", actor_id=actor_id, momento=momento
        )
    if (caso.currency or "").strip().upper() and (
        moneda.strip().upper() != (caso.currency or "").strip().upper()
    ):
        return await _retener(
            db, caso=caso, motivo="moneda distinta", actor_id=actor_id, momento=momento
        )

    politica = await politicas.vigente(
        db, tipo=POLITICA_EFECTO_ENTRADA, evento_id=caso.event_id
    )
    if politica is None:
        return await _retener(
            db, caso=caso, motivo="sin política de efecto", actor_id=actor_id,
            momento=momento,
        )

    total = (
        caso.refund_amount_minor is not None
        and int(importe_devuelto_minor) >= int(caso.refund_amount_minor)
    )
    if not total and not politicas.bandera(politica, "revoke_on_partial_refund"):
        return await _retener(
            db, caso=caso, motivo="devolución parcial", actor_id=actor_id,
            momento=momento,
        )
    if not politicas.bandera(politica, "revoke_on_refund"):
        return await _retener(
            db, caso=caso, motivo="la política no revoca", actor_id=actor_id,
            momento=momento,
        )

    return await _revocar(
        db, caso=caso, motivo="devolución confirmada", actor_id=actor_id, momento=momento
    )


async def _retener(
    db: AsyncSession,
    *,
    caso: EventAftersaleCase,
    motivo: str,
    actor_id: str | None,
    momento: datetime,
) -> Resultado:
    """Retiene en vez de revocar. Reversible, y a la vista de una persona."""
    return await aplicar(
        db, caso=caso, efecto=EN_REVISION, actor_id=actor_id, motivo=motivo,
        momento=momento,
    )


async def _revocar(
    db: AsyncSession,
    *,
    caso: EventAftersaleCase,
    motivo: str,
    actor_id: str | None,
    momento: datetime,
) -> Resultado:
    """Retira el acceso de verdad: QR, código y puerta.

    La entrada pasa a `REVOKED` con una escritura CONDICIONAL, así que dos
    procesos no la revocan dos veces ni pisan una que ya se usó.
    """
    entradas = list(
        await db.scalars(
            select(EventAftersaleCaseTicket.ticket_id).where(
                EventAftersaleCaseTicket.case_id == caso.id
            )
        )
    )
    revocadas = 0
    for entrada_id in entradas:
        hechas = await db.execute(
            update(EventTicket)
            .where(
                EventTicket.id == entrada_id,
                EventTicket.status == ENTRADA_VALIDA,
            )
            .values(
                status=ENTRADA_REVOCADA,
                revoked_at=momento,
                revoked_reason=motivo[:200],
            )
        )
        revocadas += hechas.rowcount or 0

    await db.execute(
        update(EventAftersaleCaseTicket)
        .where(
            EventAftersaleCaseTicket.case_id == caso.id,
            EventAftersaleCaseTicket.effect != REVOCADA,
        )
        .values(
            effect=REVOCADA,
            effect_reason=motivo[:500],
            effect_at=momento,
            effect_by=actor_id,
        )
    )
    await _anotar(
        db, caso=caso, efecto=REVOCADA, cambiadas=len(entradas), actor_id=actor_id,
        motivo=motivo,
    )
    return Resultado(efecto=REVOCADA, cambiadas=len(entradas), revocadas=revocadas)


async def restaurar(
    db: AsyncSession,
    *,
    caso: EventAftersaleCase,
    actor_id: str,
    motivo: str,
    momento: datetime | None = None,
) -> Resultado:
    """Devuelve el acceso, INVALIDANDO la credencial que estuvo fuera.

    Levantar una retención no puede reactivar un QR que ya no estaba en juego:
    quien lo tuviera fotografiado volvería a poder entrar. Se invalida y su
    dueño recibe uno nuevo la próxima vez que abra su entrada.

    EXIGE AUTORIZACIÓN EXPLÍCITA: no es un efecto secundario de cerrar un caso.
    """
    momento = momento or ahora()
    entradas = list(
        await db.scalars(
            select(EventAftersaleCaseTicket.ticket_id).where(
                EventAftersaleCaseTicket.case_id == caso.id
            )
        )
    )
    devueltas = 0
    for entrada_id in entradas:
        hechas = await db.execute(
            update(EventTicket)
            .where(
                EventTicket.id == entrada_id,
                EventTicket.status == ENTRADA_REVOCADA,
            )
            .values(status=ENTRADA_VALIDA, revoked_at=None, revoked_reason=None)
        )
        devueltas += hechas.rowcount or 0
        # LA CREDENCIAL VIEJA NO VUELVE. Las reglas están en `tickets`.
        await emision.invalidar_credencial(db, entrada_id=entrada_id)

    await db.execute(
        update(EventAftersaleCaseTicket)
        .where(EventAftersaleCaseTicket.case_id == caso.id)
        .values(
            effect=RESTAURADA,
            effect_reason=motivo[:500],
            effect_at=momento,
            effect_by=actor_id,
        )
    )
    await _anotar(
        db, caso=caso, efecto=RESTAURADA, cambiadas=len(entradas), actor_id=actor_id,
        motivo=motivo,
    )
    return Resultado(efecto=RESTAURADA, cambiadas=len(entradas), revocadas=devueltas)


async def _anotar(
    db: AsyncSession,
    *,
    caso: EventAftersaleCase,
    efecto: str,
    cambiadas: int,
    actor_id: str | None,
    motivo: str | None,
) -> None:
    """El rastro. Sin el motivo del comprador y sin notas internas."""
    from app.modules.gobernanza import auditoria

    await auditoria.anotar(
        db,
        actor_id=actor_id,
        actor_role="user" if actor_id else "system",
        action="event.ticket_effect",
        entity_type="event_aftersale_case",
        entity_id=caso.id,
        outcome="ok",
        new_state=efecto,
        reason=(motivo or "")[:200] or None,
        payload={
            "evento": caso.event_id,
            "pedido": caso.order_id,
            "entradas": cambiadas,
        },
    )


__all__ = [
    "BLOQUEADA",
    "CANCELADA",
    "EFECTOS",
    "EN_REVISION",
    "EfectoNoPermitido",
    "NINGUNO",
    "RESTAURADA",
    "RETIENEN",
    "REVOCADA",
    "Resultado",
    "aplicar",
    "restaurar",
    "retencion_viva",
    "revocar_por_devolucion",
]
