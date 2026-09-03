"""Qué tiene que cumplir un reembolso para retirar un acceso comprado.

Falla en cerrado: **lo que no se puede demostrar, no se aplica**. Un dato
ausente no se sustituye por el esperado; deja el caso sin conciliar, conserva el
acceso y pide revisión.

Es puro a propósito —no toca la base de datos ni la red— para poder probar cada
puerta por separado. La única comprobación que necesita consultar vive en
`reembolso.aplicar`: que la referencia no esté ya atada a otra orden.

Documentación funcional: `docs/Z_DEVOLUCIONES_Y_LIQUIDACIONES.md`.
"""

from __future__ import annotations

from dataclasses import dataclass


class NoConciliado(Exception):
    """El aviso no cuadra con la orden. No se toca nada."""


#: Un reembolso de Stripe se identifica así y no de otra forma.
PREFIJO_REEMBOLSO = "re_"

#: Objetos de Stripe que NO son un reembolso y que se colaban como si lo fueran.
#: `pi_` es el cobro —lo que une la devolución con su compra— y `ch_` el cargo;
#: ninguno de los dos sirve para preguntarle a la pasarela por un reembolso.
PREFIJOS_AJENOS = ("pi_", "ch_", "cs_", "in_", "py_", "seti_", "txn_", "sub_", "cus_")


@dataclass(frozen=True)
class ReembolsoConfirmado:
    """Lo que dice la PASARELA. Nada de esto sale de nuestra base de datos."""

    external_refund_id: str
    amount_minor: int | None
    currency: str | None
    environment: str
    provider: str = "stripe"


@dataclass(frozen=True)
class CompraOriginal:
    """Lo NUESTRO, contra lo que se compara."""

    id: str
    amount_minor: int
    currency: str
    environment: str
    provider: str


def exigir_referencia(referencia: str | None) -> str:
    """El identificador real del reembolso, o se levanta.

    Se rechaza el `payment_intent` y el cargo porque no identifican un
    reembolso: guardarlos dejaba el expediente sin salida —conciliar preguntaba
    por un id que la pasarela no reconoce— y hacía imposible detectar que dos
    órdenes distintas estaban usando la misma referencia.

    También se rechaza cualquier id compuesto por nosotros (`pi_x:refund`): un
    identificador sintético no se puede consultar ni auditar contra Stripe.
    """
    valor = (referencia or "").strip()
    if not valor:
        raise NoConciliado("El aviso no trae identificador de reembolso.")
    if ":" in valor or " " in valor:
        raise NoConciliado(f"'{valor}' es un identificador compuesto, no uno de Stripe.")
    if valor.startswith(PREFIJOS_AJENOS):
        raise NoConciliado(
            f"'{valor}' no identifica un reembolso: es otro objeto de la pasarela."
        )
    if not valor.startswith(PREFIJO_REEMBOLSO) or len(valor) <= len(PREFIJO_REEMBOLSO):
        raise NoConciliado(f"'{valor}' no es un identificador de reembolso ('re_...').")
    return valor


def exigir_importe(amount_minor: object, *, esperado: int) -> int:
    """El importe devuelto, presente, entero, positivo y EXACTAMENTE el total.

    Un importe ausente o cero NO se convierte en el esperado. Esa coalescencia
    —`amount_minor or orden.amount_minor`— convertía «la pasarela no dijo
    cuánto» en «devolvió justo lo que debía», que es la forma más silenciosa de
    retirarle el curso a quien no cobró nada.

    `bool` se excluye a mano: en Python es un entero, y `True` valdría 1.
    """
    if amount_minor is None:
        raise NoConciliado("El aviso no dice cuánto se devolvió.")
    if isinstance(amount_minor, bool) or not isinstance(amount_minor, int):
        raise NoConciliado(f"El importe devuelto no es un entero: {amount_minor!r}.")
    if amount_minor <= 0:
        raise NoConciliado(f"El importe devuelto no es positivo: {amount_minor}.")
    if amount_minor != esperado:
        raise NoConciliado(
            f"Reembolso de {amount_minor} sobre una orden de {esperado}: no es total."
        )
    return amount_minor


def exigir_moneda(currency: str | None, *, esperada: str) -> str:
    """La moneda, presente y la misma. Comparar importes sin esto no significa nada.

    19 900 soles y 19 900 dólares son el mismo número y no el mismo dinero.
    """
    valor = (currency or "").strip().upper()
    if not valor:
        raise NoConciliado("El aviso no trae moneda.")
    referencia = (esperada or "").strip().upper()
    if not referencia:
        raise NoConciliado("La orden no tiene moneda: no hay contra qué comparar.")
    if valor != referencia:
        raise NoConciliado(f"El reembolso viene en {valor} y la orden es en {referencia}.")
    return valor


def exigir_conciliado(
    *, compra: CompraOriginal, confirmado: ReembolsoConfirmado
) -> str:
    """Todas las puertas, de la más barata a la más cara. Devuelve la referencia.

    El ORDEN importa poco para la corrección y mucho para el diagnóstico: el
    mensaje que sale es el de la primera puerta cerrada, así que conviene que
    sea la más específica.
    """
    referencia = exigir_referencia(confirmado.external_refund_id)

    if (confirmado.provider or "").strip() != (compra.provider or "").strip():
        raise NoConciliado(
            f"El aviso es de '{confirmado.provider}' y la orden se cobró con "
            f"'{compra.provider}'."
        )
    # Sandbox no toca producción, y al revés: sin esto una prueba retira un
    # acceso real.
    if (confirmado.environment or "").strip() != (compra.environment or "").strip():
        raise NoConciliado(
            f"El aviso viene de '{confirmado.environment}' y la orden es de "
            f"'{compra.environment}'."
        )
    exigir_moneda(confirmado.currency, esperada=compra.currency)
    exigir_importe(confirmado.amount_minor, esperado=compra.amount_minor)
    return referencia


def exigir_expediente_de_la_compra(
    *,
    solicitud_order_id: str,
    solicitud_user_id: str,
    solicitud_course_id: str,
    orden_id: str,
    orden_user_id: str,
    curso_de_la_orden: str,
) -> None:
    """Que el expediente sea el de ESTA compra: misma orden, persona y curso.

    Un expediente apuntando a otra compra revocaría el acceso equivocado y
    consumiría la garantía de quien no pidió nada.
    """
    if solicitud_order_id != orden_id:
        raise NoConciliado("La solicitud no pertenece a esta orden.")
    if solicitud_user_id != orden_user_id:
        raise NoConciliado("La solicitud es de otra persona.")
    if solicitud_course_id != curso_de_la_orden:
        raise NoConciliado("La solicitud es de otro curso.")
