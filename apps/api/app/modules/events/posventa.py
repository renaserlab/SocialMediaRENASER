"""El expediente de posventa: abrirlo, moverlo y dejar rastro.

ESTE MÓDULO NO MUEVE DINERO. Decide y registra; ejecutar el reembolso contra la
pasarela es otra cosa y está apagada. Aprobar una solicitud no es afirmar que el
dinero llegó, y la máquina de estados lo impone: a `resolved` desde
`refund_processing` solo se llega con un aviso verificado del proveedor.

NO HACE `commit`: quien llama decide cuándo, para que el expediente viva o
muera con lo que lo rodea.

Y TAMPOCO HACE `rollback`. Los dos sitios que necesitan deshacer algo —el
choque del índice parcial al abrir, y el UPDATE condicional que no encuentra su
fila— lo hacen dentro de su PROPIO savepoint. Así se pueden llamar desde el
webhook, que ya corre dentro de uno: un `Session.rollback()` ahí deshace la
transacción entera y se lleva la fila anti-repetición que impide procesar el
mismo aviso dos veces.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError, NotFoundError, ValidationAppError
from app.modules.events import posventa_estados as maquina
from app.modules.events.models import EventOrder, EventTicket
from app.modules.events.posventa_models import (
    CANCELADO,
    ENVIADO,
    EXPEDIENTES_VIVOS,
    RECHAZADO,
    RESUELTO,
    TIPOS_DE_EXPEDIENTE,
    EventAftersaleCase,
    EventAftersaleCaseEvent,
    EventAftersaleCaseTicket,
)

#: Los resultados que puede tener un expediente cerrado.
RESULTADOS = (
    "full_refund",
    "partial_refund",
    "no_refund",
    "credit",
    "ticket_revoked",
    "ticket_kept",
    "escalated",
)


class ExpedienteNoEncontrado(NotFoundError):
    code = "event_case_not_found"


class ExpedienteAbierto(AppError):
    """Ya hay uno vivo sobre este pedido.

    Lleva el identificador del que estorba: sin él, quien vuelve a pedir se
    queda mirando un error sin salida en vez de ir al expediente que ya tiene.
    """

    status_code = 409
    code = "event_case_already_open"


class ExpedienteCambiado(AppError):
    """Alguien lo movió mientras tú decidías.

    NO SE PISA. Dos revisores mirando el mismo caso resolverían dos veces sobre
    el mismo dinero; el segundo tiene que releer y volver a decidir.
    """

    status_code = 409
    code = "event_case_changed"


@dataclass(frozen=True)
class Movimiento:
    """Lo que un paso dejó escrito."""

    expediente: EventAftersaleCase
    desde: str
    hasta: str


def ahora() -> datetime:
    return datetime.now(timezone.utc)


async def abrir(
    db: AsyncSession,
    *,
    orden: EventOrder,
    organizador_id: str,
    tipo: str,
    actor_id: str | None,
    actor_rol: str = maquina.COMPRADOR,
    motivo: str | None = None,
    origen: str = "buyer",
    momento: datetime | None = None,
) -> EventAftersaleCase:
    """Abre un expediente y congela qué entradas tenía y cómo estaban.

    UNO VIVO POR PEDIDO, y lo garantiza el índice parcial de la 0064: dos
    peticiones a la vez pasarían las dos por cualquier comprobación previa y
    dejarían dos decisiones sobre el mismo dinero.

    NO REVOCA NADA. Presentar una solicitud no retira la entrada: eso ocurre en
    el punto que diga la política, y normalmente cuando el dinero ya volvió.
    """
    if tipo not in TIPOS_DE_EXPEDIENTE:
        # 422 Y NO 500: el tipo llega del cliente.
        raise ValidationAppError(
            "Ese tipo de solicitud no existe.", code="event_case_kind_invalid"
        )
    momento = momento or ahora()

    # LOS IDENTIFICADORES, EN VARIABLES, ANTES DE TOCAR NADA. `orden` es un
    # objeto del ORM: en cuanto la transacción se deshace queda caducado, y
    # leerle un atributo dispara una recarga perezosa que en asíncrono revienta
    # con `MissingGreenlet`. Abajo hay un `rollback` en el camino del choque.
    pedido_id = orden.id
    evento_id = orden.event_id
    comprador_id = orden.buyer_id
    proveedor = orden.provider
    entorno = orden.environment

    expediente = EventAftersaleCase(
        event_id=evento_id,
        order_id=pedido_id,
        buyer_id=comprador_id,
        organizer_id=organizador_id,
        kind=tipo,
        status=ENVIADO,
        origin=origen,
        buyer_reason=(motivo or "").strip()[:1000] or None,
        provider=proveedor,
        environment=entorno,
        created_at=momento,
        updated_at=momento,
    )
    # SAVEPOINT PROPIO, NO `rollback`. Esto se llama también desde el webhook,
    # dentro del savepoint que protege la fila anti-repetición de `payment_events`:
    # un `Session.rollback()` ahí deshace la transacción ENTERA y se lleva por
    # delante justo el registro que impide procesar el aviso dos veces.
    try:
        async with db.begin_nested():
            # EL `add` VA DENTRO. Deshacer el savepoint no saca el objeto de la
            # sesión: si se añade fuera, el siguiente `flush` reintenta la misma
            # inserción y la transacción queda inservible.
            db.add(expediente)
            await db.flush()
    except IntegrityError:
        # El índice parcial lo rechazó: ya hay uno vivo. Se saca el intento de
        # la sesión —si deshacer el savepoint no lo sacó ya— y se busca cuál,
        # para poder llevar a la persona hasta él.
        if expediente in db:
            db.expunge(expediente)
        vivo = await db.scalar(
            select(EventAftersaleCase).where(
                EventAftersaleCase.order_id == pedido_id,
                EventAftersaleCase.status.in_(EXPEDIENTES_VIVOS),
            )
        )
        raise ExpedienteAbierto(
            "Ya tienes una solicitud abierta sobre esta compra.",
            details={"case_id": vivo.id} if vivo is not None else None,
        ) from None

    # LAS ENTRADAS, CONGELADAS. Si después se usan o se revocan, sigue
    # constando qué había cuando se pidió.
    entradas = list(
        await db.scalars(select(EventTicket).where(EventTicket.order_id == pedido_id))
    )
    for entrada in entradas:
        db.add(
            EventAftersaleCaseTicket(
                case_id=expediente.id,
                ticket_id=entrada.id,
                status_at_open=entrada.status,
                created_at=momento,
            )
        )

    await _anotar(
        db,
        expediente=expediente,
        desde=None,
        hasta=ENVIADO,
        actor_id=actor_id,
        actor_rol=actor_rol,
        motivo=motivo,
        momento=momento,
    )
    await db.flush()
    return expediente


async def para_el_aviso(
    db: AsyncSession, *, orden: EventOrder, tipo_de_aviso: str
) -> EventAftersaleCase:
    """El expediente al que pertenece un aviso del proveedor.

    Si ya hay uno vivo sobre ese pedido, ese. Si no lo hay, se abre uno de
    origen `system`: un reembolso hecho desde el panel de la pasarela no tiene
    solicitud detrás, y sin expediente no habría dónde registrar qué le pasó a
    las entradas ni quién tiene que mirarlo.

    NO DECIDE NADA sobre el dinero ni sobre el acceso: eso es de `efectos`.
    """
    vivo = await db.scalar(
        select(EventAftersaleCase)
        .where(
            EventAftersaleCase.order_id == orden.id,
            EventAftersaleCase.status.in_(EXPEDIENTES_VIVOS),
        )
        .order_by(EventAftersaleCase.created_at.desc())
    )
    if vivo is not None:
        return vivo

    from app.modules.catalog.models import Event

    evento = await db.get(Event, orden.event_id)
    return await abrir(
        db,
        orden=orden,
        organizador_id=evento.organizer_id if evento is not None else orden.buyer_id,
        tipo="exception",
        actor_id=None,
        actor_rol=maquina.SISTEMA,
        motivo=None,
        origen="system",
    )


async def transicionar(
    db: AsyncSession,
    *,
    expediente_id: str,
    hasta: str,
    actor_id: str | None,
    actor_rol: str,
    motivo: str | None = None,
    notas: str | None = None,
    referencia: str | None = None,
    politica_id: str | None = None,
    resultado: str | None = None,
    importe_minor: int | None = None,
    moneda: str | None = None,
    momento: datetime | None = None,
) -> Movimiento:
    """Mueve el expediente, con UPDATE CONDICIONAL.

    LA CARRERA REAL: dos revisores con el mismo caso abierto en pantalla. Los
    dos leen `under_review`, los dos pulsan. Lo que impide que las dos
    escrituras cuenten no es el `if` de arriba sino el `where status = :desde`,
    que la base resuelve fila a fila: uno cambia una fila y el otro cero.
    """
    momento = momento or ahora()
    expediente = await db.get(EventAftersaleCase, expediente_id)
    if expediente is None:
        raise ExpedienteNoEncontrado("Expediente no encontrado.")

    desde = expediente.status
    maquina.exigir(desde, hasta, actor_rol)

    if resultado is not None and resultado not in RESULTADOS:
        raise ValidationAppError(
            "Ese resultado no existe.", code="event_case_outcome_invalid"
        )
    # SIN POLÍTICA NO HAY RESULTADO, y lo exige también la base. Aquí se dice
    # antes para que el error sea comprensible en vez de una violación de CHECK.
    if resultado is not None and politica_id is None and expediente.policy_id is None:
        raise AppError(
            "No se puede cerrar un expediente sin decir con qué reglas se decidió.",
            code="event_case_outcome_without_policy",
            status_code=409,
        )
    if (importe_minor is None) != (moneda is None):
        raise AppError(
            "Un importe sin moneda no es un importe.",
            code="event_case_amount_without_currency",
            status_code=409,
        )

    valores: dict[str, object] = {"status": hasta, "updated_at": momento}
    if politica_id is not None:
        valores["policy_id"] = politica_id
    if resultado is not None:
        valores["outcome"] = resultado
    if importe_minor is not None:
        valores["refund_amount_minor"] = importe_minor
        valores["currency"] = moneda
    if referencia is not None:
        valores["external_refund_id"] = referencia
    if hasta in (RESUELTO, RECHAZADO, CANCELADO):
        valores["resolved_at"] = momento

    # EN SAVEPOINT, por lo mismo: `update()` sincroniza evaluando el criterio
    # contra el mapa de identidad, así que el objeto en memoria queda con el
    # estado nuevo aunque `rowcount` sea 0 y hay que deshacerlo. Hacerlo con un
    # `rollback` suelto deshacía también lo que hubiera escrito quien llama.
    async with db.begin_nested() as punto:
        cambiadas = await db.execute(
            update(EventAftersaleCase)
            .where(
                EventAftersaleCase.id == expediente_id,
                EventAftersaleCase.status == desde,
            )
            .values(**valores)
        )
        if cambiadas.rowcount != 1:
            await punto.rollback()
    if cambiadas.rowcount != 1:
        raise ExpedienteCambiado(
            "Alguien movió este expediente mientras decidías. Vuelve a mirarlo.",
            details={"expected": desde},
        )

    await db.refresh(expediente)

    # AL CERRAR SIN REVOCAR, SE LEVANTA LA RETENCIÓN. Sin esto, a quien pidió y
    # se le denegó le quedaba la entrada «en revisión» para siempre: pagó, no
    # se le devolvió nada y el día del evento la puerta le decía que no. Y el
    # siguiente expediente sobre ese pedido chocaba con el índice único.
    if hasta in (RESUELTO, RECHAZADO, CANCELADO):
        from app.modules.events import efectos

        await efectos.aplicar(
            db,
            caso=expediente,
            efecto=efectos.NINGUNO,
            actor_id=actor_id,
            momento=momento,
        )

    await _anotar(
        db,
        expediente=expediente,
        desde=desde,
        hasta=hasta,
        actor_id=actor_id,
        actor_rol=actor_rol,
        motivo=motivo,
        notas=notas,
        referencia=referencia,
        momento=momento,
    )
    await db.flush()
    return Movimiento(expediente=expediente, desde=desde, hasta=hasta)


async def _anotar(
    db: AsyncSession,
    *,
    expediente: EventAftersaleCase,
    desde: str | None,
    hasta: str,
    actor_id: str | None,
    actor_rol: str,
    motivo: str | None = None,
    notas: str | None = None,
    referencia: str | None = None,
    momento: datetime,
) -> None:
    """Una línea de historial. SOLO AÑADIR: la base rechaza modificarla.

    `notas` es la anotación interna y no sale en ninguna respuesta del
    comprador ni del organizador: por eso va en su propia columna y no mezclada
    con el motivo.
    """
    db.add(
        EventAftersaleCaseEvent(
            case_id=expediente.id,
            from_status=desde,
            to_status=hasta,
            actor_id=actor_id,
            actor_role=actor_rol,
            reason=(motivo or "").strip()[:500] or None,
            notes=(notas or "").strip()[:2000] or None,
            external_reference=referencia,
            created_at=momento,
        )
    )

    from app.modules.gobernanza import auditoria

    await auditoria.anotar(
        db,
        actor_id=actor_id,
        actor_role="user" if actor_rol != maquina.SISTEMA else "system",
        action="event.aftersale_case",
        entity_type="event_aftersale_case",
        entity_id=expediente.id,
        outcome="ok",
        previous_state=desde,
        new_state=hasta,
        # NI EL MOTIVO NI LAS NOTAS. El motivo puede llevar datos personales y
        # las notas son internas; el rastro necesita saber QUÉ pasó, no leerlo.
        payload={"evento": expediente.event_id, "pedido": expediente.order_id},
    )


async def leer(
    db: AsyncSession, *, expediente_id: str, usuario_id: str | None = None
) -> EventAftersaleCase:
    """El expediente. Con `usuario_id`, solo si es suyo.

    404 Y NO 403 para el que no es suyo: un 403 confirma que ese identificador
    es un expediente real de otra persona.
    """
    expediente = await db.get(EventAftersaleCase, expediente_id)
    if expediente is None:
        raise ExpedienteNoEncontrado("Expediente no encontrado.")
    if usuario_id is not None and expediente.buyer_id != usuario_id:
        raise ExpedienteNoEncontrado("Expediente no encontrado.")
    return expediente


async def historial(
    db: AsyncSession, *, expediente_id: str
) -> list[EventAftersaleCaseEvent]:
    """Las líneas, en orden. Con desempate por `id` para que sea estable."""
    return list(
        await db.scalars(
            select(EventAftersaleCaseEvent)
            .where(EventAftersaleCaseEvent.case_id == expediente_id)
            .order_by(
                EventAftersaleCaseEvent.created_at, EventAftersaleCaseEvent.id
            )
        )
    )


async def mios(
    db: AsyncSession, *, usuario_id: str, limite: int = 20, cursor: str | None = None
) -> list[EventAftersaleCase]:
    """Los expedientes de quien pregunta. Orden estable, filtrado en la base."""
    consulta = select(EventAftersaleCase).where(
        EventAftersaleCase.buyer_id == usuario_id
    )
    if cursor:
        # UN CURSOR ILEGIBLE NO ES UN FALLO DEL SERVIDOR. Llega del cliente, y
        # `fromisoformat` sobre basura lanzaba un `ValueError` que nadie captura:
        # 500 por un parametro mal escrito.
        fecha, _, ident = cursor.partition("|")
        try:
            momento = datetime.fromisoformat(fecha)
        except ValueError:
            raise ValidationAppError(
                "Ese cursor no es valido.", code="event_case_cursor_invalid"
            ) from None
        if momento.tzinfo is None:
            # Sin zona, la comparacion contra una columna `timestamptz` falla
            # dentro de la base y llega disfrazada de otra cosa.
            momento = momento.replace(tzinfo=timezone.utc)
        consulta = consulta.where(
            (EventAftersaleCase.created_at < momento)
            | (
                (EventAftersaleCase.created_at == momento)
                & (EventAftersaleCase.id < ident)
            )
        )
    consulta = consulta.order_by(
        EventAftersaleCase.created_at.desc(), EventAftersaleCase.id.desc()
    ).limit(max(1, min(int(limite), 100)))
    return list(await db.scalars(consulta))


async def cuantos_vivos(db: AsyncSession, *, evento_id: str) -> int:
    """Cuántos expedientes abiertos tiene un evento. Consulta agregada."""
    valor = await db.scalar(
        select(func.count())
        .select_from(EventAftersaleCase)
        .where(
            EventAftersaleCase.event_id == evento_id,
            EventAftersaleCase.status.in_(EXPEDIENTES_VIVOS),
        )
    )
    return valor or 0


__all__ = [
    "ExpedienteAbierto",
    "ExpedienteCambiado",
    "ExpedienteNoEncontrado",
    "Movimiento",
    "RESULTADOS",
    "abrir",
    "cuantos_vivos",
    "historial",
    "leer",
    "mios",
    "transicionar",
]
