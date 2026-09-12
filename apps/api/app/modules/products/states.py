"""El ciclo de vida de un producto. Lógica pura.

Sin base de datos y sin FastAPI a propósito: estas reglas se pueden leer y
probar sin montar nada, y son las que deciden si algo puede aparecer en el
catálogo de Z con un sello encima.

DOS PREGUNTAS DISTINTAS, igual que en la posventa de eventos:

    ¿existe ese salto?   -> si no, es un error de programación
    ¿TÚ puedes darlo?    -> si no, es un permiso que falta

LA CADENA ES LA DEL BLUEPRINT §5, letra por letra:

    draft → submitted → document_review → sample_requested → evaluation
          → conditionally_approved → approved → published
          → observation → suspended → removed

DOS COSAS QUE EL BLUEPRINT NO DICE Y AQUÍ SE DECIDEN EN CERRADO:

  1. UNA EVALUACIÓN RECHAZADA DEVUELVE EL PRODUCTO A BORRADOR. La cadena no
     tiene estado «rechazado», y dejarlo parado en `evaluation` sería un
     producto atascado para siempre. Volver a borrador es lo único que le
     permite corregir lo que falló; retirarlo es una decisión aparte, y la
     toma quien administra.
  2. `conditionally_approved` NO PUEDE PUBLICAR. Qué condiciones exactas se le
     exigen a un producto aprobado con condiciones es una decisión que la
     empresa no ha tomado, y publicarlo «mientras tanto» sería ponerle el sello
     de Z a algo que nadie autorizó del todo. No hay salto a `published` desde
     ahí: hay que volver a evaluar.
"""

from __future__ import annotations

from app.core.exceptions import AppError
from app.modules.products.models import (
    APROBADO,
    APROBADO_CON_CONDICIONES,
    BORRADOR,
    ENVIADO,
    EVALUACION,
    MUESTRA_PEDIDA,
    OBSERVACION,
    PUBLICADO,
    RETIRADO,
    REVISION_DOCUMENTAL,
    SUSPENDIDO,
)

#: Quién puede dar cada paso.
PROVEEDOR = "seller"
EVALUADOR = "evaluator"
ADMINISTRACION = "admin"
SISTEMA = "system"

#: CÓMO SE LLAMA CADA ACTOR EN LA AUDITORÍA.
#:
#: `audit_events.actor_role` solo admite `user`, `admin`, `moderator` y
#: `system` (0050, aplicada). Los actores de Productos son otros, así que se
#: traducen: quien vende actúa como usuario sobre lo suyo, y quien evalúa es
#: curaduría, que en ese vocabulario es `moderator`.
#:
#: NO SE AMPLÍA EL CHECK DE LA 0050. Está aplicada, media plataforma escribe en
#: esa tabla, y añadirle valores por esto haría que un rastro viejo dejara de
#: poder compararse con uno nuevo.
ROL_DE_AUDITORIA = {
    PROVEEDOR: "user",
    EVALUADOR: "moderator",
    ADMINISTRACION: "admin",
    SISTEMA: "system",
}

#: Los que no llevan a ningún sitio.
FINALES = frozenset({RETIRADO})

#: `(desde, hasta) -> quiénes`. Lo que no está aquí, no existe.
TRANSICIONES: dict[tuple[str, str], frozenset[str]] = {
    # Postulación del producto
    (BORRADOR, ENVIADO): frozenset({PROVEEDOR}),
    # SE PUEDE RETIRAR LO ENVIADO mientras nadie lo haya mirado. Después no:
    # un producto en revisión documental ya ocupó el tiempo de alguien.
    (ENVIADO, BORRADOR): frozenset({PROVEEDOR, ADMINISTRACION}),
    # Admisión
    (ENVIADO, REVISION_DOCUMENTAL): frozenset({EVALUADOR, ADMINISTRACION}),
    (REVISION_DOCUMENTAL, MUESTRA_PEDIDA): frozenset({EVALUADOR, ADMINISTRACION}),
    (REVISION_DOCUMENTAL, EVALUACION): frozenset({EVALUADOR, ADMINISTRACION}),
    (MUESTRA_PEDIDA, EVALUACION): frozenset({EVALUADOR, ADMINISTRACION}),
    # LA DOCUMENTACIÓN NO CUADRA: vuelve a quien lo postuló, con motivo.
    (REVISION_DOCUMENTAL, BORRADOR): frozenset({EVALUADOR, ADMINISTRACION}),
    (MUESTRA_PEDIDA, BORRADOR): frozenset({EVALUADOR, ADMINISTRACION}),
    # EL VEREDICTO. Lo escribe el SISTEMA a partir de la evaluación decidida:
    # que un producto esté aprobado es consecuencia de una puntuación y una
    # evidencia, no de que alguien pulse «aprobar».
    (EVALUACION, APROBADO): frozenset({SISTEMA}),
    (EVALUACION, APROBADO_CON_CONDICIONES): frozenset({SISTEMA}),
    (EVALUACION, BORRADOR): frozenset({SISTEMA, ADMINISTRACION}),
    # PUBLICACIÓN CONTROLADA. Solo desde `approved`, y solo quien administra.
    # Desde `conditionally_approved` NO HAY SALTO: ver la cabecera.
    (APROBADO, PUBLICADO): frozenset({ADMINISTRACION}),
    (APROBADO, BORRADOR): frozenset({ADMINISTRACION}),
    (APROBADO_CON_CONDICIONES, EVALUACION): frozenset({EVALUADOR, ADMINISTRACION}),
    (APROBADO_CON_CONDICIONES, BORRADOR): frozenset({ADMINISTRACION}),
    # Permanencia
    (PUBLICADO, OBSERVACION): frozenset({ADMINISTRACION}),
    (PUBLICADO, SUSPENDIDO): frozenset({ADMINISTRACION}),
    (OBSERVACION, PUBLICADO): frozenset({ADMINISTRACION}),
    (OBSERVACION, SUSPENDIDO): frozenset({ADMINISTRACION}),
    (SUSPENDIDO, PUBLICADO): frozenset({ADMINISTRACION}),
    # Retirada. NO SE VUELVE: quitar un producto del catálogo y devolverlo sin
    # que nadie lo mire otra vez es cómo se cuela algo retirado por un motivo.
    (PUBLICADO, RETIRADO): frozenset({ADMINISTRACION}),
    (OBSERVACION, RETIRADO): frozenset({ADMINISTRACION}),
    (SUSPENDIDO, RETIRADO): frozenset({ADMINISTRACION}),
    (BORRADOR, RETIRADO): frozenset({PROVEEDOR, ADMINISTRACION}),
}

#: Desde dónde el proveedor puede seguir editando su versión borrador.
#:
#: NO INCLUYE `submitted` NI NADA POSTERIOR: editar lo que alguien está
#: evaluando cambia el objeto de la evaluación a mitad de camino, y el sello
#: acabaría puesto sobre un texto que el evaluador no vio.
EDITABLES = frozenset({BORRADOR})

#: Los estados en los que el producto está visible en el catálogo público.
#:
#: `observation` SÍ: observar es vigilar, no esconder. `suspended` no.
EN_CATALOGO = frozenset({PUBLICADO, OBSERVACION})


class SaltoInexistente(AppError):
    """Ese paso no está en la máquina. Es un error de programación."""

    status_code = 409
    code = "product_transition_invalid"


class SaltoNoPermitido(AppError):
    """El paso existe, pero no para quien lo pide."""

    status_code = 403
    code = "product_transition_forbidden"


def existe(desde: str, hasta: str) -> bool:
    return (desde, hasta) in TRANSICIONES


def quienes(desde: str, hasta: str) -> frozenset[str]:
    return TRANSICIONES.get((desde, hasta), frozenset())


def es_final(estado: str) -> bool:
    return estado in FINALES


def exigir(desde: str, hasta: str, actor: str) -> None:
    """Se para si el salto no existe o no es de quien lo pide."""
    if desde == hasta:
        raise SaltoInexistente(f"El producto ya está {desde}.")
    if not existe(desde, hasta):
        raise SaltoInexistente(
            f"Un producto {desde} no puede pasar a {hasta}.",
            details={"from": desde, "to": hasta},
        )
    if actor not in quienes(desde, hasta):
        raise SaltoNoPermitido(
            "No tienes permiso para dar ese paso.",
            details={"from": desde, "to": hasta},
        )


def siguientes(desde: str, actor: str) -> tuple[str, ...]:
    """Lo que ESTE actor puede hacer ahora. Para pintar botones, no para
    decidir."""
    return tuple(
        sorted(h for (d, h), q in TRANSICIONES.items() if d == desde and actor in q)
    )


__all__ = [
    "ADMINISTRACION",
    "ROL_DE_AUDITORIA",
    "EDITABLES",
    "EN_CATALOGO",
    "EVALUADOR",
    "FINALES",
    "PROVEEDOR",
    "SISTEMA",
    "SaltoInexistente",
    "SaltoNoPermitido",
    "TRANSICIONES",
    "es_final",
    "exigir",
    "existe",
    "quienes",
    "siguientes",
]
