"""¿Se puede pedir la cancelación de esta compra, y con qué consecuencia?

CUATRO RESPUESTAS, Y NINGUNA SE INVENTA:

    ELEGIBLE                 la política vigente dice que sí, con estos números
    NO_ELEGIBLE              la política vigente dice que no, y por qué
    REQUIERE_REVISION        hay un hecho que la política no resuelve sola
    POLITICA_NO_CONFIGURADA  la empresa no lo ha decidido todavía

La cuarta no es un fallo. Es el estado de fábrica, y es el que evita que
«todavía no lo hemos decidido» se convierta en «no» o en «sí» por descuido.

QUÉ HACE ESTE MÓDULO Y QUÉ NO. Reúne HECHOS —estado del evento, del pedido y de
la entrada, fecha, si hubo check-in, si hay cambios registrados, devoluciones
anteriores, entorno y proveedor— y los contrasta con la política PUBLICADA. No
tiene ningún plazo escrito, ningún porcentaje y ninguna aprobación automática:
todo eso sale de `event_policies`, y si no hay política no sale de ningún sitio.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.catalog.models import Event
from app.modules.events import politicas
from app.modules.events.models import (
    ENTRADA_REVOCADA,
    ENTRADA_USADA,
    ENTRADA_VALIDA,
    ORDEN_PAGADA,
    EventOperations,
    EventOrder,
    EventTicket,
)
from app.modules.events.posventa_models import (
    EXPEDIENTES_VIVOS,
    POLITICA_ELEGIBILIDAD,
    SIN_CLASIFICAR,
    EventAftersaleCase,
    EventChange,
    EventPolicy,
)

ELEGIBLE = "eligible"
NO_ELEGIBLE = "not_eligible"
REQUIERE_REVISION = "needs_review"
POLITICA_NO_CONFIGURADA = "policy_not_configured"

#: Los motivos son CÓDIGOS, no frases. La aplicación los traduce a es/en/pt, y
#: una consulta puede agruparlos: un motivo escrito en prosa no se puede contar.
SIN_POLITICA = "policy_not_configured"
PEDIDO_NO_PAGADO = "order_not_paid"
SIN_ENTRADAS = "no_tickets"
EXPEDIENTE_ABIERTO = "case_already_open"
YA_DEVUELTO = "already_refunded"
EVENTO_TERMINADO = "event_finished"
PLAZO_VENCIDO = "window_closed"
YA_ENTRO = "checked_in"
ENTRADA_NO_VALIDA = "ticket_not_valid"
CAMBIO_SIN_CLASIFICAR = "change_unclassified"
EVENTO_CANCELADO = "event_cancelled"


@dataclass(frozen=True)
class Hechos:
    """Lo que de verdad ocurrió. Sin interpretar."""

    pedido_pagado: bool
    entradas: int
    entradas_validas: int
    entradas_usadas: int
    entradas_revocadas: int
    hubo_check_in: bool
    expediente_abierto: bool
    devoluciones_previas: int
    cambios_sin_clasificar: int
    evento_cancelado: bool
    evento_terminado: bool
    horas_hasta_el_evento: float | None
    provider: str
    environment: str


@dataclass(frozen=True)
class Veredicto:
    """La respuesta, y con qué reglas se dio.

    `politica_id` y `politica_version` van aquí para que la pantalla y el
    expediente puedan decir DESPUÉS con qué números se decidió. Sin eso, un
    cambio de política reescribe la explicación de lo ya resuelto.
    """

    resultado: str
    motivos: tuple[str, ...] = ()
    politica_id: str | None = None
    politica_version: str | None = None
    #: Lo que la política permite devolver, si lo dice. `None` NO es cero.
    porcentaje_bps: int | None = None
    hechos: Hechos | None = field(default=None, compare=False)

    @property
    def puede_pedir(self) -> bool:
        """Si tiene sentido ofrecer el botón.

        `REQUIERE_REVISION` cuenta: se puede registrar la solicitud para que
        una persona la mire. Lo que no se puede es prometer un resultado.
        """
        return self.resultado in (ELEGIBLE, REQUIERE_REVISION)


def ahora() -> datetime:
    return datetime.now(timezone.utc)


def _con_zona(momento: datetime | None) -> datetime | None:
    if momento is None:
        return None
    return momento if momento.tzinfo else momento.replace(tzinfo=timezone.utc)


async def reunir(
    db: AsyncSession, *, orden: EventOrder, momento: datetime | None = None
) -> Hechos:
    """Los hechos, en cuatro consultas agregadas. Ninguna lista en memoria."""
    momento = momento or ahora()

    por_estado = {
        f[0]: f[1]
        for f in (
            await db.execute(
                select(EventTicket.status, func.count())
                .where(EventTicket.order_id == orden.id)
                .group_by(EventTicket.status)
            )
        ).all()
    }
    usadas = por_estado.get(ENTRADA_USADA, 0)

    abierto = await db.scalar(
        select(func.count())
        .select_from(EventAftersaleCase)
        .where(
            EventAftersaleCase.order_id == orden.id,
            EventAftersaleCase.status.in_(EXPEDIENTES_VIVOS),
        )
    )
    previas = await db.scalar(
        select(func.count())
        .select_from(EventAftersaleCase)
        .where(
            EventAftersaleCase.order_id == orden.id,
            EventAftersaleCase.outcome.in_(("full_refund", "partial_refund")),
        )
    )
    sin_clasificar = await db.scalar(
        select(func.count())
        .select_from(EventChange)
        .where(
            EventChange.event_id == orden.event_id,
            EventChange.classification == SIN_CLASIFICAR,
        )
    )

    evento = await db.get(Event, orden.event_id)
    operacion = await db.get(EventOperations, orden.event_id)
    workflow = operacion.workflow_status if operacion else None
    empieza = _con_zona(getattr(evento, "starts_at", None))
    faltan = (empieza - momento).total_seconds() / 3600 if empieza else None

    return Hechos(
        pedido_pagado=orden.status == ORDEN_PAGADA,
        entradas=sum(por_estado.values()),
        entradas_validas=por_estado.get(ENTRADA_VALIDA, 0),
        entradas_usadas=usadas,
        entradas_revocadas=por_estado.get(ENTRADA_REVOCADA, 0),
        hubo_check_in=usadas > 0,
        expediente_abierto=bool(abierto),
        devoluciones_previas=int(previas or 0),
        cambios_sin_clasificar=int(sin_clasificar or 0),
        evento_cancelado=workflow == "CANCELLED",
        evento_terminado=bool(empieza and empieza < momento),
        horas_hasta_el_evento=faltan,
        provider=orden.provider,
        environment=orden.environment,
    )


async def evaluar(
    db: AsyncSession, *, orden: EventOrder, momento: datetime | None = None
) -> Veredicto:
    """El veredicto. Nunca decide con un valor que nadie ha configurado."""
    hechos = await reunir(db, orden=orden, momento=momento)

    # ---------------------------------------------------------------- #
    # 1. Lo que NO depende de ninguna política: hechos duros.
    # ---------------------------------------------------------------- #
    duros: list[str] = []
    if not hechos.pedido_pagado:
        duros.append(PEDIDO_NO_PAGADO)
    if hechos.entradas == 0:
        duros.append(SIN_ENTRADAS)
    if hechos.expediente_abierto:
        duros.append(EXPEDIENTE_ABIERTO)
    if hechos.devoluciones_previas > 0:
        duros.append(YA_DEVUELTO)
    if duros:
        return Veredicto(NO_ELEGIBLE, tuple(duros), hechos=hechos)

    # ---------------------------------------------------------------- #
    # 2. La política. Sin ella no se sigue.
    #
    # NO SE CONTINÚA CON VALORES SUPUESTOS. Un plazo ausente leído como cero
    # cerraría la ventana para todo el mundo y un porcentaje ausente leído
    # como cero regalaría el importe entero: las dos cosas cuadran.
    # ---------------------------------------------------------------- #
    politica = await politicas.vigente(
        db, tipo=POLITICA_ELEGIBILIDAD, evento_id=orden.event_id
    )
    if politica is None:
        return Veredicto(POLITICA_NO_CONFIGURADA, (SIN_POLITICA,), hechos=hechos)

    marca = _identidad(politica)

    # ---------------------------------------------------------------- #
    # 3. Lo que la política SÍ resuelve.
    # ---------------------------------------------------------------- #
    if hechos.evento_cancelado:
        # El evento cancelado es el caso de mayor impacto y su tratamiento es
        # una decisión aparte: si la política de elegibilidad no dice
        # expresamente qué hacer, va a revisión, no a «sí» ni a «no».
        if politicas.bandera(politica, "organizer_cancellation_auto"):
            return Veredicto(
                ELEGIBLE,
                (EVENTO_CANCELADO,),
                *marca,
                porcentaje_bps=politicas.numero(politica, "cancelled_event_bps"),
                hechos=hechos,
            )
        return Veredicto(REQUIERE_REVISION, (EVENTO_CANCELADO,), *marca, hechos=hechos)

    revision: list[str] = []

    if hechos.hubo_check_in:
        # YA ENTRÓ. El servicio pudo consumirse entero o a medias, y decidir
        # eso solo es una regla que nadie ha aprobado.
        if not politicas.bandera(politica, "allow_after_check_in"):
            return Veredicto(NO_ELEGIBLE, (YA_ENTRO,), *marca, hechos=hechos)
        revision.append(YA_ENTRO)

    # ¿QUEDA ALGO SOBRE LO QUE ACTUAR? Las revocadas ya no; las válidas sí, y
    # las USADAS también cuando se ha llegado hasta aquí, porque eso significa
    # que la política permite expresamente el caso de quien ya entró. Mirar
    # solo las válidas descartaba justo ese caso un paso después de haberlo
    # admitido, y devolvía «no» donde tocaba «a revisión».
    accionables = hechos.entradas_validas + hechos.entradas_usadas
    if accionables == 0:
        return Veredicto(NO_ELEGIBLE, (ENTRADA_NO_VALIDA,), *marca, hechos=hechos)

    if hechos.cambios_sin_clasificar > 0:
        # Hay un cambio del evento que nadie ha mirado. Puede ser una tilde o
        # puede ser la ciudad: hasta que se clasifique, no se decide solo.
        revision.append(CAMBIO_SIN_CLASIFICAR)

    horas = politicas.numero(politica, "window_hours_before_event")
    if horas is None:
        # La política existe pero no trae el plazo. No se supone ninguno.
        return Veredicto(REQUIERE_REVISION, (SIN_POLITICA,), *marca, hechos=hechos)

    if hechos.evento_terminado:
        if not politicas.bandera(politica, "allow_after_event"):
            return Veredicto(NO_ELEGIBLE, (EVENTO_TERMINADO,), *marca, hechos=hechos)
        revision.append(EVENTO_TERMINADO)
    elif hechos.horas_hasta_el_evento is not None and (
        hechos.horas_hasta_el_evento < horas
    ):
        return Veredicto(NO_ELEGIBLE, (PLAZO_VENCIDO,), *marca, hechos=hechos)

    if revision:
        return Veredicto(REQUIERE_REVISION, tuple(revision), *marca, hechos=hechos)

    return Veredicto(
        ELEGIBLE,
        (),
        *marca,
        porcentaje_bps=politicas.numero(politica, "refund_bps"),
        hechos=hechos,
    )


def _identidad(politica: EventPolicy) -> tuple[str, str]:
    return politica.id, politica.version


__all__ = [
    "ELEGIBLE",
    "NO_ELEGIBLE",
    "POLITICA_NO_CONFIGURADA",
    "REQUIERE_REVISION",
    "Hechos",
    "Veredicto",
    "evaluar",
    "reunir",
]
