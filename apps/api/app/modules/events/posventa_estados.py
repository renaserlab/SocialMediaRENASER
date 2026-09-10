"""La máquina de estados del expediente de posventa. Lógica pura.

Sin base de datos y sin FastAPI a propósito: estas reglas se pueden leer y
probar sin montar nada, y son las que deciden qué se puede hacer con el dinero
de alguien.

DOS PREGUNTAS DISTINTAS, y hay que poder distinguirlas:

    ¿existe ese salto?      -> si no, es un error de programación
    ¿TÚ puedes darlo?       -> si no, es un permiso que falta

Contestarlas con el mismo error hace que un fallo de permisos parezca un fallo
del servidor, y al revés.

Y LOS ACTORES VAN POR TRANSICIÓN, NO POR DESTINO. `resolved` se alcanza por dos
caminos que no son iguales: desde `approved`, cuando no hay dinero que mover
—se decidió que la entrada se queda—, lo cierra quien administra; desde
`refund_processing`, cuando el dinero volvió de verdad, solo lo cierra un aviso
verificado del proveedor. Una tabla por destino no sabría distinguirlos, y
aprobar acabaría pudiendo declarar «devuelto».
"""

from __future__ import annotations

from app.core.exceptions import AppError
from app.modules.events.posventa_models import (
    APROBADO,
    CANCELADO,
    DEVOLUCION_EN_CURSO,
    DEVOLUCION_PENDIENTE,
    EN_REVISION,
    ENVIADO,
    ESPERANDO,
    FALLIDO,
    RECHAZADO,
    RESUELTO,
)

#: Quién puede dar cada paso.
COMPRADOR = "buyer"
ORGANIZADOR = "organizer"
SOPORTE = "support"
ADMINISTRACION = "admin"
SISTEMA = "system"

#: Los que no llevan a ningún sitio. Un expediente aquí está cerrado.
FINALES = frozenset({RESUELTO, RECHAZADO, CANCELADO})

#: `(desde, hasta) -> quiénes`. Lo que no está aquí, no existe.
TRANSICIONES: dict[tuple[str, str], frozenset[str]] = {
    # Triaje
    (ENVIADO, EN_REVISION): frozenset({SOPORTE, ADMINISTRACION}),
    (ENVIADO, ESPERANDO): frozenset({SOPORTE, ADMINISTRACION}),
    (ENVIADO, RECHAZADO): frozenset({ADMINISTRACION}),
    (ENVIADO, CANCELADO): frozenset({COMPRADOR, ADMINISTRACION}),
    (EN_REVISION, ESPERANDO): frozenset({SOPORTE, ADMINISTRACION}),
    (EN_REVISION, APROBADO): frozenset({ADMINISTRACION}),
    (EN_REVISION, RECHAZADO): frozenset({ADMINISTRACION}),
    (EN_REVISION, CANCELADO): frozenset({COMPRADOR, ADMINISTRACION}),
    (ESPERANDO, EN_REVISION): frozenset({COMPRADOR, SOPORTE, ADMINISTRACION}),
    (ESPERANDO, RECHAZADO): frozenset({ADMINISTRACION}),
    (ESPERANDO, CANCELADO): frozenset({COMPRADOR, ADMINISTRACION}),
    # Decisión
    (APROBADO, DEVOLUCION_PENDIENTE): frozenset({ADMINISTRACION}),
    # SIN DINERO QUE MOVER. Se decidió que la entrada se queda, o que no
    # corresponde devolución: eso lo cierra quien administra.
    (APROBADO, RESUELTO): frozenset({ADMINISTRACION}),
    (APROBADO, CANCELADO): frozenset({ADMINISTRACION}),
    # Ejecución
    (DEVOLUCION_PENDIENTE, DEVOLUCION_EN_CURSO): frozenset({ADMINISTRACION, SISTEMA}),
    (DEVOLUCION_PENDIENTE, FALLIDO): frozenset({SISTEMA}),
    (DEVOLUCION_PENDIENTE, CANCELADO): frozenset({ADMINISTRACION}),
    # EL DINERO VOLVIÓ: solo lo dice un aviso verificado del proveedor. Ni un
    # administrador puede declarar «devuelto» a mano, porque aprobar no es
    # haber pagado y la pantalla del comprador enseña esto como un hecho.
    (DEVOLUCION_EN_CURSO, RESUELTO): frozenset({SISTEMA}),
    (DEVOLUCION_EN_CURSO, FALLIDO): frozenset({SISTEMA}),
    # Reintento
    (FALLIDO, DEVOLUCION_PENDIENTE): frozenset({ADMINISTRACION}),
    (FALLIDO, DEVOLUCION_EN_CURSO): frozenset({ADMINISTRACION, SISTEMA}),
    (FALLIDO, RESUELTO): frozenset({SISTEMA}),
    (FALLIDO, CANCELADO): frozenset({ADMINISTRACION}),
}

#: Los estados desde los que el comprador todavía puede retirar su solicitud.
RETIRABLES = frozenset({ENVIADO, EN_REVISION, ESPERANDO})


class SaltoInexistente(AppError):
    """Ese paso no está en la máquina. Es un error de programación."""

    status_code = 409
    code = "event_case_transition_invalid"


class SaltoNoPermitido(AppError):
    """El paso existe, pero no para quien lo pide."""

    status_code = 403
    code = "event_case_transition_forbidden"


def existe(desde: str, hasta: str) -> bool:
    return (desde, hasta) in TRANSICIONES


def quienes(desde: str, hasta: str) -> frozenset[str]:
    return TRANSICIONES.get((desde, hasta), frozenset())


def es_final(estado: str) -> bool:
    return estado in FINALES


def exigir(desde: str, hasta: str, actor: str) -> None:
    """Se para si el salto no existe o no es de quien lo pide."""
    if desde == hasta:
        raise SaltoInexistente(f"El expediente ya está {desde}.")
    if not existe(desde, hasta):
        raise SaltoInexistente(
            f"Un expediente {desde} no puede pasar a {hasta}.",
            details={"from": desde, "to": hasta},
        )
    if actor not in quienes(desde, hasta):
        raise SaltoNoPermitido(
            "No tienes permiso para dar ese paso.",
            details={"from": desde, "to": hasta},
        )


def siguientes(desde: str, actor: str) -> tuple[str, ...]:
    """Lo que ESTE actor puede hacer ahora. Para pintar botones, no para decidir."""
    return tuple(
        sorted(h for (d, h), q in TRANSICIONES.items() if d == desde and actor in q)
    )


__all__ = [
    "ADMINISTRACION",
    "COMPRADOR",
    "FINALES",
    "ORGANIZADOR",
    "RETIRABLES",
    "SISTEMA",
    "SOPORTE",
    "SaltoInexistente",
    "SaltoNoPermitido",
    "TRANSICIONES",
    "es_final",
    "exigir",
    "existe",
    "quienes",
    "siguientes",
]
