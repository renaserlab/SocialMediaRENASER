"""Lo que ve el PROPIETARIO de un curso sobre sus ventas.

LA LISTA DE LO QUE NUNCA SALE POR AQUI, y cada uno estuvo a punto de salir:

    motivo privado de una devolucion   no
    notas de revision de administracion no
    identificadores de la pasarela      no
    correo, telefono o pais del comprador no

El propietario tiene derecho a saber cuanto ha vendido y cuanto se le debe. No
tiene derecho a saber por que alguien pidio la devolucion: eso es del alumno y
de quien la revisa. Por eso estos esquemas son cerrados y enumeran campo a
campo lo que se publica, en vez de serializar el modelo entero.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

#: Los estados de saldo que se publican, en el orden en que se leen.
ESTADOS_DE_SALDO = (
    "pending",
    "frozen",
    "eligible",
    "transferring",
    "transferred",
    "cancelled",
    "failed",
)


class SaldoPorEstado(BaseModel):
    """Cuantas ventas y cuanto dinero hay en cada estado."""

    count: int = 0
    net_amount_minor: int = 0


class BalancesRetenidos(BaseModel):
    """Cuanto dinero de creadores hay parado, y cuanto lleva parado.

    Es la consulta que hace visible la señal que la documentacion prometia
    vigilar: `pending` sin fecha de vencimiento son compras que nadie llego a
    abrir, asi que la garantia no ha arrancado y el saldo no tiene cuando
    liberarse.
    """

    por_estado: dict[str, SaldoPorEstado]
    #: `pending` con `available_at` nulo: sin fecha para liberarse.
    sin_fecha: int = 0
    #: Los mismos, con mas de `dias` desde la venta.
    sin_fecha_antiguos: int = 0
    #: Congelados sin moverse en mas de `dias`: expedientes o disputas sin cerrar.
    congelados_antiguos: int = 0
    dias: int = 30


class OwnerCourseSummary(BaseModel):
    """El resumen comercial de un curso, para su autor."""

    course_id: str
    course_title: str
    currency: str
    #: Personas distintas con una compra pagada.
    paid_students: int = 0
    #: Devoluciones consumadas. Ni motivos ni notas: solo cuantas.
    refunds: int = 0

    gross_amount_minor: int = 0
    platform_fee_minor: int = 0
    provider_fee_minor: int = 0
    net_amount_minor: int = 0

    #: Clave = estado del saldo. Siempre estan las siete, aunque valgan cero:
    #: una pantalla que tiene que preguntar si la clave existe acaba pintando
    #: huecos distintos segun el curso.
    balances: dict[str, SaldoPorEstado] = {}
    #: Falso cuando la 0049 no esta aplicada: el resumen sale en ceros y la
    #: pantalla puede decirlo en vez de mentir con un total que no ha calculado.
    settlement_available: bool = True


class Comprador(BaseModel):
    """Lo MINIMO para poner cara a una venta. Nada mas."""

    id: str
    name: str = ""
    username: str | None = None
    avatar_path: str | None = None


class OwnerSaleRead(BaseModel):
    """Una venta, tal y como la ve quien la cobra."""

    id: str
    sold_at: datetime
    gross_amount_minor: int
    platform_fee_minor: int
    provider_fee_minor: int
    net_amount_minor: int
    currency: str
    #: Estado del SALDO, no de la devolucion. `cancelled` significa «esta venta
    #: ya no genera dinero»; por que, no es asunto de esta pantalla.
    status: str
    available_at: datetime | None = None
    buyer: Comprador | None = None


class ResultadoDeLiquidacion(BaseModel):
    """Lo que hizo una pasada de liquidacion. Numeros, nunca importes sueltos.

    NO LLEVA IMPORTES A PROPOSITO: es un parte de trabajo, no un extracto. El
    dinero se consulta en `/admin/owner-balances/health`, que ya lo desglosa por
    estado.
    """

    #: Saldos que pasaron de `pending` a `eligible` en esta pasada.
    liberados: int = 0
    #: Intentos de transferencia lanzados contra la pasarela.
    transferencias_intentadas: int = 0
    #: De esos, los que la pasarela dio por completados.
    transferencias_completadas: int = 0
    #: Saldos elegibles que NO se intentaron, agrupados por el motivo que
    #: devolvio `puede_transferirse`: `transfers_disabled`, `guarantee_open`,
    #: `payout_account_not_ready`... Es lo que explica un cero.
    omitidos: dict[str, int] = {}
    #: Saldos en los que la pasada fallo y se dejo para la siguiente.
    fallidos: int = 0
