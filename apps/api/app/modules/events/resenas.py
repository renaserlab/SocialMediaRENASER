"""Reseñas de evento con asistencia verificada.

EL SELLO SE DERIVA, NO SE ESCRIBE. Una reseña existe porque hay un check-in
correcto de esa persona, con su entrada, en ese evento. La clave ajena a
`event_checkins` lo impone y este módulo lo comprueba antes: no hay ningún
booleano «verificada» que alguien pueda poner.

APAGADA HASTA QUE LA EMPRESA DECIDA. El plazo para opinar y el efecto de una
devolución posterior sobre el sello son decisiones que nadie ha tomado. Sin la
política `review_window` publicada, crear una reseña se rechaza con un código
estable —no con un 500— y la ficha del evento no enseña ninguna sección.

CINCO EJES Y UNA PREGUNTA GENERAL. La general no es la media: responde a otra
cosa —«¿entregó lo que anunció?»— y promediarlas exigiría decidir cuánto pesa
cada eje, que tampoco lo ha decidido nadie.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import AppError, ConflictError, NotFoundError
from app.modules.catalog.models import Event
from app.modules.events import esquema, politicas
from app.modules.events.models import EventCheckin, EventTicket
from app.modules.events.posventa_models import POLITICA_RESENAS, POLITICA_RESPUESTA
from app.modules.events.resenas_models import (
    EventReview,
    EventReviewModeration,
    EventReviewReply,
)

#: Los cinco del blueprint. En una tupla y no sueltos para que el resumen, el
#: contrato y las pruebas no puedan divergir.
EJES = ("content", "organization", "venue", "safety", "value")

VISIBLE = "visible"
ESCONDIDA = "hidden"
BORRADOR = "draft"


class ResenaNoPermitida(AppError):
    status_code = 409
    code = "event_review_not_allowed"


class ResenaDuplicada(ConflictError):
    code = "event_review_already_exists"


class ResenaNoEncontrada(NotFoundError):
    code = "event_review_not_found"


@dataclass(frozen=True)
class Resumen:
    """Lo que se enseña en la ficha. `promedio` es `None` cuando no hay nada.

    NO ES CERO. Un evento sin reseñas no tiene una puntuación de 0.0: no tiene
    puntuación. Pintar `0.0` o cinco estrellas vacías dice algo que nadie ha
    dicho.
    """

    total: int
    promedio: float | None
    histograma: dict[int, int]
    recomiendan_bps: int | None
    por_eje: dict[str, float | None]


def ahora() -> datetime:
    return datetime.now(timezone.utc)


async def exigir_disponible(db: AsyncSession) -> None:
    """Sin la 0067, 503 con código estable. No 404 ni 500."""
    from app.core.exceptions import ServiceUnavailableError

    if not await esquema.hay_resenas(db):
        raise ServiceUnavailableError(
            "Las reseñas de eventos todavía no están disponibles.",
            code="event_reviews_not_available",
        )


async def puede_resenar(
    db: AsyncSession, *, evento_id: str, usuario_id: str, momento: datetime | None = None
) -> tuple[bool, str, str | None]:
    """Si esta persona puede reseñar este evento, y por qué no.

    Devuelve `(puede, motivo, checkin_id)`. El motivo es un CÓDIGO estable: la
    aplicación lo traduce y una consulta lo puede agrupar.
    """
    momento = momento or ahora()

    if not await esquema.hay_resenas(db):
        return False, "reviews_not_available", None

    # LA POLÍTICA PRIMERO. El plazo para opinar no está decidido, y sin él no se
    # abre la función: no se supone ninguno.
    politica = await politicas.vigente(db, tipo=POLITICA_RESENAS, evento_id=evento_id)
    if politica is None:
        return False, "policy_not_configured", None

    evento = await db.get(Event, evento_id)
    if evento is None:
        return False, "event_not_found", None
    if evento.organizer_id == usuario_id:
        # Nadie valora lo suyo.
        return False, "own_event", None

    # CUÁNDO TERMINA, no cuándo empieza. En un festival de tres días la
    # diferencia son tres días de opinar sobre algo que sigue pasando. Se usa
    # `ends_at` y solo se cae a `starts_at` cuando no hay fin declarado.
    #
    # Y SIN FECHA NINGUNA NO SE RESEÑA. Saltarse la comprobación porque el dato
    # falta es dar por terminado un evento del que no se sabe nada.
    termina = getattr(evento, "ends_at", None) or getattr(evento, "starts_at", None)
    if termina is None:
        return False, "event_not_finished", None
    cuando = termina if termina.tzinfo else termina.replace(tzinfo=timezone.utc)
    if cuando > momento:
        return False, "event_not_finished", None

    # EL SELLO: un check-in correcto, de una entrada de ESTA persona, en ESTE
    # evento. Los tres a la vez, y por clave ajena real.
    acceso = await db.scalar(
        select(EventCheckin.id)
        .join(EventTicket, EventTicket.id == EventCheckin.ticket_id)
        .where(
            EventCheckin.event_id == evento_id,
            EventCheckin.result == "OK",
            EventTicket.owner_id == usuario_id,
            EventTicket.event_id == evento_id,
        )
        .order_by(EventCheckin.created_at)
        .limit(1)
    )
    if acceso is None:
        return False, "no_check_in", None

    ya = await db.scalar(
        select(EventReview.id).where(
            EventReview.event_id == evento_id, EventReview.author_id == usuario_id
        )
    )
    if ya is not None:
        return False, "already_reviewed", None

    return True, "ok", acceso


async def crear(
    db: AsyncSession,
    *,
    evento_id: str,
    usuario_id: str,
    overall: int,
    ejes: dict[str, int | None] | None = None,
    recomienda: bool | None = None,
    comentario: str | None = None,
    momento: datetime | None = None,
) -> EventReview:
    """Publica la reseña. Exige asistencia verificada y política publicada."""
    await exigir_disponible(db)
    momento = momento or ahora()

    puede, motivo, acceso = await puede_resenar(
        db, evento_id=evento_id, usuario_id=usuario_id, momento=momento
    )
    if not puede:
        if motivo == "already_reviewed":
            raise ResenaDuplicada("Ya valoraste este evento.")
        raise ResenaNoPermitida(
            "Todavía no puedes valorar este evento.", details={"reason": motivo}
        )

    entrada = await db.scalar(
        select(EventCheckin.ticket_id).where(EventCheckin.id == acceso)
    )
    valores = {eje: (ejes or {}).get(eje) for eje in EJES}

    resena = EventReview(
        event_id=evento_id,
        author_id=usuario_id,
        checkin_id=acceso,
        ticket_id=entrada,
        overall=int(overall),
        recommends=recomienda,
        comment=(comentario or "").strip()[:1000] or None,
        status=VISIBLE,
        created_at=momento,
        updated_at=momento,
        **valores,
    )
    try:
        async with db.begin_nested():
            db.add(resena)
            await db.flush()
    except IntegrityError:
        if resena in db:
            db.expunge(resena)
        raise ResenaDuplicada("Ya valoraste este evento.") from None

    from app.modules.events import avisos

    evento = await db.get(Event, evento_id)
    if evento is not None:
        await avisos.encolar(
            db,
            usuario_id=evento.organizer_id,
            tipo="event_review_received",
            entidad_id=resena.id,
        )
    await db.flush()
    return resena


async def editar(
    db: AsyncSession,
    *,
    resena_id: str,
    usuario_id: str,
    overall: int | None = None,
    ejes: dict[str, int | None] | None = None,
    recomienda: bool | None = None,
    comentario: str | None = None,
    momento: datetime | None = None,
) -> EventReview:
    """Solo su autor. Moderación puede esconder, no reescribir."""
    await exigir_disponible(db)
    momento = momento or ahora()
    resena = await db.get(EventReview, resena_id)
    if resena is None or resena.author_id != usuario_id:
        raise ResenaNoEncontrada("Reseña no encontrada.")

    if overall is not None:
        resena.overall = int(overall)
    for eje in EJES:
        if ejes is not None and eje in ejes:
            setattr(resena, eje, ejes[eje])
    if recomienda is not None:
        resena.recommends = recomienda
    if comentario is not None:
        resena.comment = comentario.strip()[:1000] or None
    resena.updated_at = momento
    await db.flush()
    return resena


async def moderar(
    db: AsyncSession,
    *,
    resena_id: str,
    actor_id: str,
    esconder: bool,
    motivo: str | None = None,
    momento: datetime | None = None,
) -> EventReview:
    """Esconde o vuelve a mostrar. NUNCA cambia autor ni puntuación.

    Con `UPDATE` condicional: dos moderadores sobre la misma reseña no se pisan.
    """
    await exigir_disponible(db)
    momento = momento or ahora()
    resena = await db.get(EventReview, resena_id)
    if resena is None:
        raise ResenaNoEncontrada("Reseña no encontrada.")

    desde = resena.status
    hasta = ESCONDIDA if esconder else VISIBLE
    if desde == hasta:
        return resena

    cambiadas = await db.execute(
        update(EventReview)
        .where(EventReview.id == resena_id, EventReview.status == desde)
        .values(
            status=hasta,
            moderation_reason=(motivo or "").strip()[:500] or None if esconder else None,
            moderated_by=actor_id if esconder else None,
            moderated_at=momento if esconder else None,
            updated_at=momento,
        )
    )
    if cambiadas.rowcount != 1:
        raise ConflictError(
            "Alguien moderó esta reseña mientras decidías.",
            code="event_review_changed",
        )

    db.add(
        EventReviewModeration(
            review_id=resena_id,
            actor_id=actor_id,
            from_status=desde,
            to_status=hasta,
            reason=(motivo or "").strip()[:500] or None,
            created_at=momento,
        )
    )
    await db.refresh(resena)
    return resena


async def resumen(db: AsyncSession, *, evento_id: str) -> Resumen:
    """Promedio, histograma y recomendación. EN UNA CONSULTA AGREGADA.

    Traer las reseñas para contarlas en memoria es N+1 disfrazado, y en un
    evento con mil asistentes es traer mil filas para calcular una media.
    """
    if not await esquema.hay_resenas(db):
        return Resumen(0, None, {}, None, {eje: None for eje in EJES})

    fila = (
        await db.execute(
            select(
                func.count(),
                func.avg(EventReview.overall),
                *[func.avg(getattr(EventReview, eje)) for eje in EJES],
                func.count(EventReview.recommends),
                func.sum(
                    func.cast(EventReview.recommends, __import__("sqlalchemy").Integer)
                ),
            ).where(
                EventReview.event_id == evento_id, EventReview.status == VISIBLE
            )
        )
    ).one()

    total = int(fila[0] or 0)
    if total == 0:
        # SIN RESEÑAS NO HAY PROMEDIO. `None`, y no `0.0`.
        return Resumen(0, None, {}, None, {eje: None for eje in EJES})

    promedio = round(float(fila[1]), 2) if fila[1] is not None else None
    por_eje = {
        eje: (round(float(fila[2 + i]), 2) if fila[2 + i] is not None else None)
        for i, eje in enumerate(EJES)
    }
    contestaron = int(fila[2 + len(EJES)] or 0)
    recomiendan = int(fila[3 + len(EJES)] or 0)
    # EN PUNTOS BÁSICOS y solo si alguien contestó: un porcentaje sobre cero
    # respuestas no es cero por ciento, es ninguno.
    bps = round(recomiendan * 10_000 / contestaron) if contestaron else None

    reparto = (
        await db.execute(
            select(EventReview.overall, func.count())
            .where(EventReview.event_id == evento_id, EventReview.status == VISIBLE)
            .group_by(EventReview.overall)
        )
    ).all()
    return Resumen(
        total=total,
        promedio=promedio,
        histograma={int(p): int(c) for p, c in reparto},
        recomiendan_bps=bps,
        por_eje=por_eje,
    )


async def listar(
    db: AsyncSession, *, evento_id: str, limite: int = 20, cursor: str | None = None
) -> list[EventReview]:
    """Las visibles, paginadas por cursor y con desempate estable."""
    if not await esquema.hay_resenas(db):
        return []
    consulta = select(EventReview).where(
        EventReview.event_id == evento_id, EventReview.status == VISIBLE
    )
    if cursor:
        from app.core.exceptions import ValidationAppError

        fecha, _, ident = cursor.partition("|")
        try:
            momento = datetime.fromisoformat(fecha)
        except ValueError:
            raise ValidationAppError(
                "Ese cursor no es válido.", code="event_review_cursor_invalid"
            ) from None
        # LA SEGUNDA MITAD TAMBIÉN SE VALIDA. Es un `uuid` y va a una columna
        # `uuid`: un cursor sin `|` deja la cadena vacía, que SQLite acepta y
        # PostgreSQL rechaza con un 500. Y esta ruta es ANÓNIMA.
        try:
            UUID(ident)
        except (ValueError, AttributeError, TypeError):
            raise ValidationAppError(
                "Ese cursor no es válido.", code="event_review_cursor_invalid"
            ) from None
        if momento.tzinfo is None:
            momento = momento.replace(tzinfo=timezone.utc)
        consulta = consulta.where(
            (EventReview.created_at < momento)
            | ((EventReview.created_at == momento) & (EventReview.id < ident))
        )
    consulta = consulta.order_by(
        EventReview.created_at.desc(), EventReview.id.desc()
    ).limit(max(1, min(int(limite), 100)))
    return list(await db.scalars(consulta))


async def respuestas_de(
    db: AsyncSession, *, resenas_ids: list[str]
) -> dict[str, EventReviewReply]:
    """Las respuestas VISIBLES de un lote de reseñas. Una consulta para todas.

    UNA POR RESEÑA, y lo impone un índice único parcial: varias respuestas del
    organizador debajo de una opinión serían una forma de hostigar a quien la
    escribió.

    Lista vacía = no se consulta. `in_([])` con la cadena vacía de relleno
    revienta contra una columna `uuid` en PostgreSQL.
    """
    if not resenas_ids or not await esquema.hay_resenas(db):
        return {}
    filas = await db.scalars(
        select(EventReviewReply).where(
            EventReviewReply.review_id.in_(resenas_ids),
            EventReviewReply.status == VISIBLE,
        )
    )
    return {fila.review_id: fila for fila in filas}


async def mia(
    db: AsyncSession, *, evento_id: str, usuario_id: str
) -> EventReview | None:
    """La reseña que esta persona escribió de este evento, si la hay.

    Incluye la ESCONDIDA por moderación: su autor tiene que poder ver lo que
    escribió. Quien la lea es solo esa persona.
    """
    if not await esquema.hay_resenas(db):
        return None
    return await db.scalar(
        select(EventReview).where(
            EventReview.event_id == evento_id,
            EventReview.author_id == usuario_id,
        )
    )


# --------------------------------------------------------------------------- #
# La respuesta del organizador. NACE APAGADA.
# --------------------------------------------------------------------------- #
async def responder(
    db: AsyncSession,
    *,
    resena_id: str,
    usuario_id: str,
    texto: str,
    momento: datetime | None = None,
) -> EventReviewReply:
    """Una respuesta VISIBLE por reseña, y solo si la política lo permite.

    Sin la política `organizer_reply` publicada se rechaza con un código
    estable: publicar una respuesta pública sin reglas de moderación ni límites
    aprobados es exponer a quien opinó.
    """
    await exigir_disponible(db)
    momento = momento or ahora()

    resena = await db.get(EventReview, resena_id)
    if resena is None:
        raise ResenaNoEncontrada("Reseña no encontrada.")

    evento = await db.get(Event, resena.event_id)
    if evento is None or evento.organizer_id != usuario_id:
        # 404 y no 403: quien no organiza ese evento no tiene por qué saber que
        # esa reseña existe.
        raise ResenaNoEncontrada("Reseña no encontrada.")

    politica = await politicas.vigente(
        db, tipo=POLITICA_RESPUESTA, evento_id=resena.event_id
    )
    if politica is None or not politicas.bandera(politica, "allow_reply"):
        raise ResenaNoPermitida(
            "Responder públicamente todavía no está habilitado.",
            code="event_reply_not_configured",
        )

    respuesta = EventReviewReply(
        review_id=resena_id,
        author_id=usuario_id,
        body=texto.strip()[:1000],
        status=VISIBLE,
        created_at=momento,
        updated_at=momento,
    )
    try:
        async with db.begin_nested():
            db.add(respuesta)
            await db.flush()
    except IntegrityError:
        if respuesta in db:
            db.expunge(respuesta)
        raise ConflictError(
            "Ya hay una respuesta publicada para esta reseña.",
            code="event_reply_already_exists",
        ) from None

    from app.modules.events import avisos

    await avisos.encolar(
        db,
        usuario_id=resena.author_id,
        tipo="event_review_replied",
        entidad_id=resena_id,
    )
    await db.flush()
    return respuesta


__all__ = [
    "mia",
    "respuestas_de",
    "EJES",
    "ESCONDIDA",
    "Resumen",
    "ResenaDuplicada",
    "ResenaNoEncontrada",
    "ResenaNoPermitida",
    "VISIBLE",
    "crear",
    "editar",
    "exigir_disponible",
    "listar",
    "moderar",
    "puede_resenar",
    "responder",
    "resumen",
]
