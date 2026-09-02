"""La máquina de estados de una solicitud de devolución.

SIN REACT, SIN BASE DE DATOS Y SIN FASTAPI a propósito: es lógica pura, así que
se puede probar entera sin montar nada. Las transiciones de un expediente que
mueve dinero son justo lo que hay que poder recorrer exhaustivamente en una
prueba, y eso no se hace levantando un servidor.

POR QUÉ UNA MÁQUINA Y NO UN `status = nuevo`. Porque «aprobada» después de
«reembolsada» es dinero devuelto dos veces, y «reembolsada» sin pasar por
«procesando» es acceso retirado sin que nadie confirmara el reembolso. Un campo
de texto libre admite las dos cosas; una tabla de transiciones, ninguna.
"""

from __future__ import annotations

from typing import Final

#: Recién creada por el alumno.
REQUESTED: Final = "requested"
#: Un administrador la tomó para revisarla.
UNDER_REVIEW: Final = "under_review"
#: Aprobada. Todavía NO se ha pedido el reembolso a la pasarela.
APPROVED: Final = "approved"
#: Pedido a la pasarela y esperando confirmación.
REFUND_PROCESSING: Final = "refund_processing"
#: Confirmado, total y conciliado. Es el ÚNICO estado que retira el acceso.
REFUNDED: Final = "refunded"
#: Rechazada con motivo. NO consume la garantía.
REJECTED: Final = "rejected"
#: La pasarela dijo que no pudo. Se puede reintentar.
FAILED: Final = "failed"
#: Retirada antes de resolverse. NO consume la garantía.
CANCELLED: Final = "cancelled"

ESTADOS: Final[frozenset[str]] = frozenset({
    REQUESTED, UNDER_REVIEW, APPROVED, REFUND_PROCESSING,
    REFUNDED, REJECTED, FAILED, CANCELLED,
})

#: Estados en los que el expediente sigue VIVO: hay dinero comprometido y no se
#: puede abrir otra solicitud sobre la misma orden. Tiene que coincidir con el
#: índice parcial `refund_requests_viva_por_orden` de la 0049; si divergen, la
#: base rechaza inserciones que el código creía válidas.
VIVOS: Final[frozenset[str]] = frozenset({
    REQUESTED, UNDER_REVIEW, APPROVED, REFUND_PROCESSING, FAILED,
})

#: Estados finales. De aquí no se sale.
FINALES: Final[frozenset[str]] = frozenset({REFUNDED, REJECTED, CANCELLED})

#: Lo que se puede hacer desde cada estado. Es la tabla completa: lo que no
#: está aquí, no se puede.
TRANSICIONES: Final[dict[str, frozenset[str]]] = {
    REQUESTED: frozenset({UNDER_REVIEW, CANCELLED}),
    UNDER_REVIEW: frozenset({APPROVED, REJECTED, CANCELLED}),
    APPROVED: frozenset({REFUND_PROCESSING}),
    REFUND_PROCESSING: frozenset({REFUNDED, FAILED}),
    # Un fallo de la pasarela se reintenta, o se abandona. Lo que NO hace es
    # saltar a «reembolsado»: eso sería dar por bueno lo que falló.
    FAILED: frozenset({REFUND_PROCESSING, CANCELLED}),
    REFUNDED: frozenset(),
    REJECTED: frozenset(),
    CANCELLED: frozenset(),
}

#: Quién puede provocar cada transición. El propietario del curso NO aparece en
#: ninguna: no aprueba, no rechaza y no ejecuta reembolsos.
#:
#: 'user'   el alumno dueño de la solicitud
#: 'admin'  administración de Z
#: 'system' un webhook verificado de la pasarela
ACTORES: Final[dict[str, frozenset[str]]] = {
    UNDER_REVIEW: frozenset({"admin"}),
    APPROVED: frozenset({"admin"}),
    REJECTED: frozenset({"admin"}),
    # El alumno puede retirar la suya mientras nadie la haya resuelto; la
    # administración también, para cerrar expedientes muertos.
    CANCELLED: frozenset({"user", "admin"}),
    # Ejecutar el reembolso lo dispara la administración al aprobar; el sistema
    # lo repite al reintentar automáticamente.
    REFUND_PROCESSING: frozenset({"admin", "system"}),
    # SOLO el sistema, y solo con un webhook verificado. Ni un administrador
    # puede declarar «reembolsado» a mano: eso retiraría el acceso sin que
    # nadie hubiera devuelto el dinero.
    REFUNDED: frozenset({"system"}),
    FAILED: frozenset({"system"}),
}


class TransicionInvalida(Exception):
    """Se intentó un salto que la máquina no permite."""

    def __init__(self, desde: str, hasta: str, motivo: str = "") -> None:
        self.desde = desde
        self.hasta = hasta
        super().__init__(motivo or f"No se puede pasar de '{desde}' a '{hasta}'.")


def puede(desde: str, hasta: str) -> bool:
    """Si la transición existe en la tabla."""
    return hasta in TRANSICIONES.get(desde, frozenset())


def puede_actor(rol: str, hasta: str) -> bool:
    """Si ese rol puede provocar esa transición."""
    return rol in ACTORES.get(hasta, frozenset())


def exigir(desde: str, hasta: str, *, rol: str) -> None:
    """Lanza si la transición no está permitida para ese actor.

    Se comprueban las dos cosas por separado para que el error diga cuál de las
    dos falló: no es lo mismo «ese salto no existe» que «ese salto existe pero
    tú no puedes darlo». Lo segundo es un intento de escalar permisos y merece
    quedar registrado como tal.
    """
    if desde == hasta:
        raise TransicionInvalida(desde, hasta, f"La solicitud ya está en '{hasta}'.")
    if not puede(desde, hasta):
        raise TransicionInvalida(desde, hasta)
    if not puede_actor(rol, hasta):
        raise TransicionInvalida(
            desde, hasta, f"Un actor '{rol}' no puede llevar una solicitud a '{hasta}'."
        )


def esta_vivo(estado: str) -> bool:
    """Si el expediente sigue abierto y bloquea otra solicitud sobre la orden."""
    return estado in VIVOS
