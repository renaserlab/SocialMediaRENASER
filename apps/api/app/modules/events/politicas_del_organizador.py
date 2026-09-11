"""Cada organizador escribe sus propias reglas de cambios y devoluciones.

NO ES UN MODELO NUEVO. `event_policies` ya sabía representar una política de
evento: alcance, tipo, versión, borrador o publicada, texto para quien compra,
parámetros y huella. Lo que faltaba era el CICLO DE VIDA —nadie creaba
borradores, `publicar()` iba directo a publicada— y la puerta de propiedad.

QUÉ PUEDE DECIDIR UN ORGANIZADOR, Y QUÉ NO. Decide lo que le PROMETE a quien
compra: cuándo se puede pedir un cambio o una devolución, y qué pasa con la
entrada. NO decide cómo se mueve el dinero de la plataforma —ejecución del
reembolso, retención, reserva, quién asume una disputa, saldo negativo—, porque
eso es dinero de terceros y autoconcedérselo sería exactamente el agujero que
`TIPOS_DEL_ORGANIZADOR` cierra.

LO PUBLICADO NO SE TOCA. Lo impone un disparador de la 0069, no una convención:
para cambiar una regla se publica una versión nueva, y las compras anteriores
conservan la que aceptaron.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import ConflictError, NotFoundError, ValidationAppError
from app.modules.catalog.models import Event
from app.modules.events import esquema, politicas
from app.modules.events.posventa_models import (
    BORRADOR,
    POLITICA_EFECTO_ENTRADA,
    POLITICA_ELEGIBILIDAD,
    PUBLICADA,
    SUPERADA,
    EventPolicy,
)

#: LO QUE UN ORGANIZADOR PUEDE DECIDIR. Lo que le promete a quien compra.
#:
#: Deliberadamente NO incluye `refund_execution`, `settlement_hold`,
#: `settlement_reserve`, `dispute_liability` ni `negative_balance`: eso es cómo
#: se mueve el dinero, y decidirlo sobre el propio cobro es autoconcederse una
#: excepción. Tampoco `review_window` ni `organizer_reply`, que son reglas de
#: producto de la plataforma y no condiciones de venta.
TIPOS_DEL_ORGANIZADOR = (POLITICA_ELEGIBILIDAD, POLITICA_EFECTO_ENTRADA)

#: Al menos una de estas claves tiene que decir algo, o la política no
#: configura nada y solo aparenta hacerlo.
CLAVES_CON_SENTIDO: dict[str, tuple[str, ...]] = {
    POLITICA_ELEGIBILIDAD: (
        "window_hours_before_event",
        "days_after_event",
        "refund_bps",
        "cancelled_event_bps",
        "allow_buyer_cancellation",
        "allow_exchange",
    ),
    POLITICA_EFECTO_ENTRADA: (
        "revoke_on_refund",
        "revoke_on_partial_refund",
        "hold_on_dispute",
        "restore_on_rejected_refund",
    ),
}

#: Largo del texto que lee quien compra. Ni un tuit ni un contrato entero.
LARGO_DEL_TEXTO = 5_000


class PoliticaNoEncontrada(NotFoundError):
    code = "event_policy_not_found"


class PoliticaNoEditable(ConflictError):
    code = "event_policy_not_editable"


def _validar_contradicciones(tipo: str, params: dict[str, Any]) -> None:
    """Rechaza lo que no puede significar nada. NO juzga el negocio.

    Aquí no se opina sobre si un plazo es corto o un porcentaje es bajo: eso lo
    decide quien organiza. Lo que se rechaza es una combinación que se
    contradice a sí misma, porque publicada dejaría al comprador leyendo una
    promesa que el código no puede cumplir.
    """
    # Revocar en una devolución PARCIAL pero no en la total es imposible de
    # sostener: lo menos implica lo más.
    if params.get("revoke_on_partial_refund") is True and (
        params.get("revoke_on_refund") is not True
    ):
        raise ValidationAppError(
            "Si se revoca con una devolución parcial, también con la total.",
            code="event_policy_contradictory",
            details={"params": ["revoke_on_partial_refund", "revoke_on_refund"]},
        )

    # Permitir cancelar y a la vez no dejar ninguna ventana para hacerlo.
    if params.get("allow_buyer_cancellation") is True:
        ventana = params.get("window_hours_before_event")
        plazo = params.get("days_after_event")
        if ventana is None and plazo is None:
            raise ValidationAppError(
                "Si se permite cancelar, hay que decir hasta cuándo.",
                code="event_policy_contradictory",
                details={"params": ["window_hours_before_event", "days_after_event"]},
            )

    # Y una política que no habilita nada pero se publica como si habilitara.
    con_sentido = CLAVES_CON_SENTIDO.get(tipo, ())
    if con_sentido and not any(clave in params for clave in con_sentido):
        raise ValidationAppError(
            "Esta política no decide nada todavía.",
            code="event_policy_empty",
            details={"expected_any_of": list(con_sentido)},
        )


async def _evento_del_organizador(
    db: AsyncSession, *, evento_id: str, usuario_id: str
) -> Event:
    """El evento de quien pregunta. 404 para el ajeno, nunca 403.

    Decir «existe pero no es tuyo» ya cuenta que existe.
    """
    evento = await db.get(Event, evento_id)
    if evento is None or evento.organizer_id != usuario_id:
        raise NotFoundError("Evento no encontrado.")
    return evento


def _exigir_tipo_del_organizador(tipo: str) -> None:
    if tipo not in TIPOS_DEL_ORGANIZADOR:
        raise ValidationAppError(
            "Ese tipo de política no lo decide quien organiza.",
            code="event_policy_type_not_allowed",
            details={"allowed": list(TIPOS_DEL_ORGANIZADOR)},
        )


async def listar(
    db: AsyncSession, *, evento_id: str, usuario_id: str, tipo: str | None = None
) -> list[EventPolicy]:
    """Todas las del evento: el borrador, la vigente y las superadas.

    Las superadas SE LEEN y no se tocan: son lo que aceptaron las compras de su
    momento, y esconderlas haría imposible explicar una decisión pasada.
    """
    await _evento_del_organizador(db, evento_id=evento_id, usuario_id=usuario_id)
    if not await esquema.hay_posventa(db):
        return []
    consulta = select(EventPolicy).where(
        EventPolicy.scope == "event", EventPolicy.event_id == evento_id
    )
    if tipo:
        consulta = consulta.where(EventPolicy.policy_type == tipo)
    return list(
        await db.scalars(
            consulta.order_by(
                EventPolicy.policy_type,
                EventPolicy.created_at.desc(),
                EventPolicy.id.desc(),
            )
        )
    )


async def borrador_de(
    db: AsyncSession, *, evento_id: str, tipo: str
) -> EventPolicy | None:
    """El borrador vivo de ese tipo, si lo hay. Uno como mucho."""
    return await db.scalar(
        select(EventPolicy).where(
            EventPolicy.scope == "event",
            EventPolicy.event_id == evento_id,
            EventPolicy.policy_type == tipo,
            EventPolicy.status == BORRADOR,
        )
    )


async def guardar_borrador(
    db: AsyncSession,
    *,
    evento_id: str,
    usuario_id: str,
    tipo: str,
    version: str,
    params: dict[str, Any],
    body: str | None = None,
) -> EventPolicy:
    """Crea el borrador o reescribe el que haya. UNO por tipo y evento.

    NO VALIDA CONTRADICCIONES: un borrador a medias es lo normal mientras se
    escribe. Se validan al publicar, que es cuando alguien va a leerlo.

    Sí valida las cotas, porque un `refund_bps` de nueve millones no es «a
    medias», es un número que no existe.
    """
    await esquema.exigir_posventa(db)
    await _evento_del_organizador(db, evento_id=evento_id, usuario_id=usuario_id)
    _exigir_tipo_del_organizador(tipo)
    if not isinstance(params, dict):
        raise ValidationAppError(
            "Los parámetros de una política son un objeto.",
            code="event_policy_params_invalid",
        )
    politicas._exigir_parametros_sensatos(params)
    texto = (body or "").strip() or None
    if texto is not None and len(texto) > LARGO_DEL_TEXTO:
        raise ValidationAppError(
            "El texto de la política es demasiado largo.",
            code="event_policy_body_too_long",
        )

    # EL NOMBRE DE LA VIGENTE NO SE REUTILIZA, y se dice AL GUARDAR. Saltaba
    # solo al publicar, después de haber escrito el borrador entero.
    vigente = await vigente_del_evento(db, evento_id=evento_id, tipo=tipo)
    if vigente is not None and vigente.version == version:
        raise ConflictError(
            "Ya hay una versión publicada con ese nombre.",
            code="event_policy_version_taken",
        )

    borrador = await borrador_de(db, evento_id=evento_id, tipo=tipo)
    if borrador is not None:
        borrador.version = version
        borrador.params = dict(params)
        borrador.params_sha256 = politicas.huella(params)
        borrador.body = texto
        await db.flush()
        return borrador

    borrador = EventPolicy(
        policy_type=tipo,
        scope="event",
        event_id=evento_id,
        jurisdiction="PE",
        locale="es",
        version=version,
        status=BORRADOR,
        params=dict(params),
        params_sha256=politicas.huella(params),
        body=texto,
        created_by=usuario_id,
    )
    db.add(borrador)
    await db.flush()
    return borrador


async def descartar_borrador(
    db: AsyncSession, *, politica_id: str, usuario_id: str
) -> None:
    """Tira un borrador. Solo un borrador: lo publicado no se borra."""
    await esquema.exigir_posventa(db)
    politica = await db.get(EventPolicy, politica_id)
    if politica is None or politica.scope != "event":
        raise PoliticaNoEncontrada("Política no encontrada.")
    await _evento_del_organizador(
        db, evento_id=politica.event_id, usuario_id=usuario_id
    )
    _exigir_tipo_del_organizador(politica.policy_type)
    if politica.status != BORRADOR:
        raise PoliticaNoEditable(
            "Una política publicada no se borra: se publica otra versión."
        )
    await db.delete(politica)
    await db.flush()


async def publicar_borrador(
    db: AsyncSession, *, politica_id: str, usuario_id: str
) -> EventPolicy:
    """Publica el borrador y supersede la vigente, EN LA MISMA TRANSACCIÓN.

    El estado intermedio de «ninguna vigente» o «dos vigentes» no puede existir.

    LO QUE YA SE VENDIÓ NO CAMBIA. Las compras anteriores guardan en
    `event_order_policy_acceptances` el identificador y la huella de la versión
    que aceptaron; publicar una nueva no las toca.
    """
    await esquema.exigir_posventa(db)
    politica = await db.get(EventPolicy, politica_id)
    if politica is None or politica.scope != "event":
        raise PoliticaNoEncontrada("Política no encontrada.")
    evento_id = politica.event_id
    await _evento_del_organizador(db, evento_id=evento_id, usuario_id=usuario_id)
    if politica.status != BORRADOR:
        raise PoliticaNoEditable("Esa política ya está publicada.")
    _exigir_tipo_del_organizador(politica.policy_type)

    params = dict(politica.params or {})
    politicas._exigir_parametros_sensatos(params)
    _validar_contradicciones(politica.policy_type, params)
    if not params and not (politica.body or "").strip():
        raise ValidationAppError(
            "No se publica una política vacía.", code="event_policy_empty"
        )

    momento = politicas.ahora()
    vigente = await db.scalar(
        select(EventPolicy).where(
            EventPolicy.scope == "event",
            EventPolicy.event_id == evento_id,
            EventPolicy.policy_type == politica.policy_type,
            EventPolicy.jurisdiction == politica.jurisdiction,
            EventPolicy.locale == politica.locale,
            EventPolicy.status == PUBLICADA,
            EventPolicy.effective_to.is_(None),
        )
    )
    if vigente is not None:
        if vigente.version == politica.version:
            raise ConflictError(
                "Ya hay una versión publicada con ese nombre.",
                code="event_policy_version_taken",
            )
        # El disparador de la 0069 solo admite ESTE cambio sobre una publicada.
        vigente.status = SUPERADA
        vigente.effective_to = momento
        await db.flush()

    politica.status = PUBLICADA
    politica.effective_from = momento
    politica.published_at = momento
    politica.published_by = usuario_id
    await db.flush()
    return politica


async def vigente_del_evento(
    db: AsyncSession, *, evento_id: str, tipo: str
) -> EventPolicy | None:
    """La publicada de ESE evento. Sin caer a la global.

    `politicas.vigente` sí cae a la global, y para decidir está bien. Para
    enseñarle a quien organiza «tu evento tiene política propia o no la tiene»,
    caer mentiría.
    """
    if not await esquema.hay_posventa(db):
        return None
    return await db.scalar(
        select(EventPolicy).where(
            EventPolicy.scope == "event",
            EventPolicy.event_id == evento_id,
            EventPolicy.policy_type == tipo,
            EventPolicy.status == PUBLICADA,
            EventPolicy.effective_to.is_(None),
        )
    )


__all__ = [
    "CLAVES_CON_SENTIDO",
    "LARGO_DEL_TEXTO",
    "PoliticaNoEditable",
    "PoliticaNoEncontrada",
    "TIPOS_DEL_ORGANIZADOR",
    "borrador_de",
    "descartar_borrador",
    "guardar_borrador",
    "listar",
    "publicar_borrador",
    "vigente_del_evento",
]
