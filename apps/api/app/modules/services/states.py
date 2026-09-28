"""El ciclo de vida de una postulación de prestador. Lógica pura.

Sin base de datos y sin FastAPI a propósito: estas reglas deciden quién entra
a ofrecer servicios en Z, y se tienen que poder leer y probar sin montar nada.

DOS PREGUNTAS DISTINTAS, igual que en Productos y en la posventa de eventos:

    ¿existe ese salto?   -> si no, 409: es una combinación imposible
    ¿TÚ puedes darlo?    -> si no, 403: es un permiso que falta

LOS OCHO ESTADOS DEL BLOQUE 1A:

    draft ──▶ submitted ──▶ under_review ──▶ approved ──▶ suspended
                                  │  ▲  ▲                     │
                                  │  │  └─────────────────────┘
                                  │  └── resubmitted ◀── changes_requested
                                  ├──▶ changes_requested
                                  └──▶ rejected (final)

DECISIONES QUE AQUÍ SE TOMAN EN CERRADO, y por qué:

  1. TODO PASA POR `under_review`. Pedir correcciones, aprobar y rechazar se
     hacen desde una revisión abierta, que dice quién la tomó y cuándo. Una
     aprobación directa desde `submitted` sería una decisión sin revisión.
  2. APROBAR, RECHAZAR Y SUSPENDER SON DE ADMINISTRACIÓN. Revisar (tomar la
     postulación y pedir correcciones) también lo puede hacer curaduría. Es la
     separación del alcance: quien revisa documentos no autoriza por eso.
  3. SUSPENDER NO ES DEFINITIVO: vuelve a `under_review` para investigar. Salir
     de una suspensión sin que nadie revise es cómo vuelve a entrar lo que se
     suspendió por un motivo.
  4. `rejected` ES FINAL para esa postulación. Volver a postular es otra
     postulación, y la base solo lo permite cuando la anterior está rechazada.
  5. NO HAY `withdrawn` (retirada por el prestador) en este bloque: el mapa
     aprobado no lo trae. Añadirlo es un salto más aquí y en la migración.

EL MISMO MAPA VIVE EN LA MIGRACIÓN 0086, en un disparador de la postulación y
en un CHECK del historial. Una prueba compara los dos.

La EJECUCIÓN de los saltos (escribir el estado, el historial y los avisos) es
del Bloque 1B. Aquí solo el mapa, los validadores y los errores.
"""

from __future__ import annotations

from app.core.exceptions import AppError

# --------------------------------------------------------------------------- #
# Los estados. El valor es el que se guarda y el que viaja en la API.
# --------------------------------------------------------------------------- #
BORRADOR = "draft"
ENVIADA = "submitted"
EN_REVISION = "under_review"
CORRECCIONES_PEDIDAS = "changes_requested"
REENVIADA = "resubmitted"
APROBADA = "approved"
RECHAZADA = "rejected"
SUSPENDIDA = "suspended"

#: En el orden en que se recorren. Es el mismo CHECK de la migración.
ESTADOS: tuple[str, ...] = (
    BORRADOR,
    ENVIADA,
    EN_REVISION,
    CORRECCIONES_PEDIDAS,
    REENVIADA,
    APROBADA,
    RECHAZADA,
    SUSPENDIDA,
)

# --------------------------------------------------------------------------- #
# Quién puede dar cada paso. Son FUNCIONES, no roles de `profiles`: la misma
# persona puede revisar y decidir, pero el historial dice en calidad de qué.
# --------------------------------------------------------------------------- #
PRESTADOR = "provider"
REVISOR = "reviewer"
ADMINISTRACION = "admin"
SISTEMA = "system"

ACTORES: tuple[str, ...] = (PRESTADOR, REVISOR, ADMINISTRACION, SISTEMA)

#: `(desde, hasta) -> quiénes`. Lo que no está aquí, no existe.
TRANSICIONES: dict[tuple[str, str], frozenset[str]] = {
    # Quien postula envía su borrador.
    (BORRADOR, ENVIADA): frozenset({PRESTADOR}),
    # Z toma la postulación: queda escrito quién y cuándo.
    (ENVIADA, EN_REVISION): frozenset({REVISOR, ADMINISTRACION}),
    # Falta algo o algo no cuadra: vuelve a quien postuló, con motivo.
    (EN_REVISION, CORRECCIONES_PEDIDAS): frozenset({REVISOR, ADMINISTRACION}),
    (CORRECCIONES_PEDIDAS, REENVIADA): frozenset({PRESTADOR}),
    (REENVIADA, EN_REVISION): frozenset({REVISOR, ADMINISTRACION}),
    # EL VEREDICTO. Solo administración.
    (EN_REVISION, APROBADA): frozenset({ADMINISTRACION}),
    (EN_REVISION, RECHAZADA): frozenset({ADMINISTRACION}),
    # Permanencia: la suspensión se investiga.
    (APROBADA, SUSPENDIDA): frozenset({ADMINISTRACION}),
    (SUSPENDIDA, EN_REVISION): frozenset({REVISOR, ADMINISTRACION}),
}

#: Los que no llevan a ningún sitio.
FINALES = frozenset({RECHAZADA})

#: DONDE QUIEN POSTULA PUEDE SEGUIR ESCRIBIENDO. Ni `submitted` ni nada
#: posterior: editar lo que alguien está revisando cambia el objeto de la
#: revisión a mitad de camino.
EDITABLES = frozenset({BORRADOR, CORRECCIONES_PEDIDAS})

#: LAS QUE OCUPAN EL HUECO de la postulación viva del prestador. Es el índice
#: `service_provider_applications_una_viva` de la 0086.
VIVAS = frozenset(set(ESTADOS) - FINALES)

#: LAS QUE ESPERAN A Z. Es lo que la bandeja enseña por defecto.
PENDIENTES_DE_Z = frozenset({ENVIADA, EN_REVISION, REENVIADA})


class SaltoInexistente(AppError):
    """Ese paso no está en el mapa. Una combinación imposible."""

    status_code = 409
    code = "service_application_transition_invalid"


class SaltoNoPermitido(AppError):
    """El paso existe, pero no para quien lo pide."""

    status_code = 403
    code = "service_application_transition_forbidden"


class EstadoDesconocido(AppError):
    """Un estado que no es ninguno de los ocho. Error de programación."""

    status_code = 422
    code = "service_application_status_unknown"


def es_estado(valor: str) -> bool:
    return valor in ESTADOS


def existe(desde: str, hasta: str) -> bool:
    return (desde, hasta) in TRANSICIONES


def quienes(desde: str, hasta: str) -> frozenset[str]:
    return TRANSICIONES.get((desde, hasta), frozenset())


def es_final(estado: str) -> bool:
    return estado in FINALES


def es_editable(estado: str) -> bool:
    return estado in EDITABLES


def exigir(desde: str, hasta: str, actor: str) -> None:
    """Se para si el salto no existe o no es de quien lo pide.

    Primero que los dos estados existan, después que el salto exista y al final
    el actor: un estado mal escrito no puede acabar en un «no tienes permiso».
    """
    for estado in (desde, hasta):
        if not es_estado(estado):
            raise EstadoDesconocido(
                "Ese estado no existe.", details={"status": estado}
            )
    if actor not in ACTORES:
        raise SaltoNoPermitido(
            "No tienes permiso para dar ese paso.",
            details={"from": desde, "to": hasta},
        )
    if desde == hasta:
        raise SaltoInexistente(
            "La postulación ya está en ese estado.",
            details={"from": desde, "to": hasta},
        )
    if not existe(desde, hasta):
        raise SaltoInexistente(
            "La postulación no puede pasar a ese estado desde el actual.",
            details={"from": desde, "to": hasta},
        )
    if actor not in quienes(desde, hasta):
        raise SaltoNoPermitido(
            "No tienes permiso para dar ese paso.",
            details={"from": desde, "to": hasta},
        )


def siguientes(desde: str, actor: str) -> tuple[str, ...]:
    """Lo que ESTE actor puede hacer ahora. Para pintar botones, no para
    decidir: quien decide es `exigir`, en el servidor."""
    return tuple(
        sorted(h for (d, h), q in TRANSICIONES.items() if d == desde and actor in q)
    )


__all__ = [
    "ACTORES",
    "ADMINISTRACION",
    "APROBADA",
    "BORRADOR",
    "CORRECCIONES_PEDIDAS",
    "EDITABLES",
    "EN_REVISION",
    "ENVIADA",
    "ESTADOS",
    "EstadoDesconocido",
    "FINALES",
    "PENDIENTES_DE_Z",
    "PRESTADOR",
    "RECHAZADA",
    "REENVIADA",
    "REVISOR",
    "SISTEMA",
    "SUSPENDIDA",
    "SaltoInexistente",
    "SaltoNoPermitido",
    "TRANSICIONES",
    "VIVAS",
    "es_editable",
    "es_estado",
    "es_final",
    "exigir",
    "existe",
    "quienes",
    "siguientes",
]
