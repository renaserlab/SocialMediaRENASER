"""El ciclo de vida del catálogo de Servicios. Lógica pura (Incremento 2).

Sin base de datos y sin FastAPI, como `states.py` de la admisión: estas reglas
deciden qué ve el público, y se tienen que poder leer y probar sin montar nada.

DOS COSAS DISTINTAS, DOS MAPAS:

  EL SERVICIO es la identidad estable de la oferta:

      draft ──▶ published ◀──▶ suspended
        │           │               │
        └───────────┴───────────────┴──▶ retired (final)

  LA VERSIÓN es su contenido. Solo el borrador se edita:

      draft ──▶ submitted ──▶ under_review ──▶ approved ──▶ published ──▶ superseded
        │           │              │   │           │
        │           │              │   └──▶ changes_requested (cerrada)
        └───────────┴──────────────┴───────────────┴──▶ withdrawn (cerrada)

DECISIONES QUE AQUÍ SE TOMAN EN CERRADO, y por qué:

  1. PEDIR CAMBIOS CIERRA ESA VERSIÓN. La corrección es una versión NUEVA que
     sale de ella (`based_on_version_id`): así cada decisión revisó
     exactamente lo que se envió y nada se reescribe después. Reenviar es
     enviar esa versión nueva (el historial lo llama `resubmitted`).
  2. APROBAR Y PUBLICAR SON DOS PASOS, LOS DOS DE ADMINISTRACIÓN. La empresa no
     ha decidido quién publica tras aprobar; separados, publicar sigue siendo
     una decisión expresa. Curaduría toma la revisión y pide cambios.
  3. LA PUBLICADA ANTERIOR SIGUE VISIBLE hasta que se publica la nueva, que la
     supera en la misma transacción. Nunca hay dos publicadas.
  4. SUSPENDER NO BORRA NADA y saca el servicio del público. Reactivarlo es
     una acción expresa de administración, con motivo. Publicar una versión
     nueva de un servicio suspendido NO lo reactiva.
  5. RETIRAR es final: el servicio sale del catálogo para siempre, con su
     historia intacta. Lo hace administración.
  6. RETIRAR UNA VERSIÓN es de quien la propuso, antes de publicarse. No toca
     la publicada.

EL MISMO MAPA VIVE EN LA BASE (0090, `services_salto_valido` y
`service_versions_salto_valido`). Una prueba compara los dos.
"""

from __future__ import annotations

from app.core.exceptions import AppError
from app.modules.services.states import ACTORES, ADMINISTRACION, PRESTADOR, REVISOR, SISTEMA

# --------------------------------------------------------------------------- #
# El servicio
# --------------------------------------------------------------------------- #
SERVICIO_BORRADOR = "draft"
SERVICIO_PUBLICADO = "published"
SERVICIO_SUSPENDIDO = "suspended"
SERVICIO_RETIRADO = "retired"

ESTADOS_DEL_SERVICIO: tuple[str, ...] = (
    SERVICIO_BORRADOR,
    SERVICIO_PUBLICADO,
    SERVICIO_SUSPENDIDO,
    SERVICIO_RETIRADO,
)

TRANSICIONES_DEL_SERVICIO: dict[tuple[str, str], frozenset[str]] = {
    # La primera publicación la hace administración al publicar una versión.
    (SERVICIO_BORRADOR, SERVICIO_PUBLICADO): frozenset({ADMINISTRACION}),
    (SERVICIO_PUBLICADO, SERVICIO_SUSPENDIDO): frozenset({ADMINISTRACION}),
    (SERVICIO_SUSPENDIDO, SERVICIO_PUBLICADO): frozenset({ADMINISTRACION}),
    (SERVICIO_BORRADOR, SERVICIO_RETIRADO): frozenset({ADMINISTRACION}),
    (SERVICIO_PUBLICADO, SERVICIO_RETIRADO): frozenset({ADMINISTRACION}),
    (SERVICIO_SUSPENDIDO, SERVICIO_RETIRADO): frozenset({ADMINISTRACION}),
}

#: Lo que ve el público: SOLO esto, con su versión publicada y su prestador
#: activo.
VISIBLE_AL_PUBLICO = frozenset({SERVICIO_PUBLICADO})

# --------------------------------------------------------------------------- #
# La versión
# --------------------------------------------------------------------------- #
BORRADOR = "draft"
ENVIADA = "submitted"
EN_REVISION = "under_review"
CAMBIOS_PEDIDOS = "changes_requested"
APROBADA = "approved"
PUBLICADA = "published"
SUPERADA = "superseded"
RETIRADA = "withdrawn"

ESTADOS_DE_LA_VERSION: tuple[str, ...] = (
    BORRADOR,
    ENVIADA,
    EN_REVISION,
    CAMBIOS_PEDIDOS,
    APROBADA,
    PUBLICADA,
    SUPERADA,
    RETIRADA,
)

TRANSICIONES_DE_LA_VERSION: dict[tuple[str, str], frozenset[str]] = {
    (BORRADOR, ENVIADA): frozenset({PRESTADOR}),
    (ENVIADA, EN_REVISION): frozenset({REVISOR, ADMINISTRACION}),
    (EN_REVISION, CAMBIOS_PEDIDOS): frozenset({REVISOR, ADMINISTRACION}),
    (EN_REVISION, APROBADA): frozenset({ADMINISTRACION}),
    (APROBADA, PUBLICADA): frozenset({ADMINISTRACION}),
    # La publicada anterior, al publicar la siguiente.
    (PUBLICADA, SUPERADA): frozenset({SISTEMA}),
    # Retirar lo propio antes de que se publique; y el sistema al retirar el
    # servicio entero.
    (BORRADOR, RETIRADA): frozenset({PRESTADOR, SISTEMA}),
    (ENVIADA, RETIRADA): frozenset({PRESTADOR, SISTEMA}),
    (EN_REVISION, RETIRADA): frozenset({PRESTADOR, SISTEMA}),
    (APROBADA, RETIRADA): frozenset({PRESTADOR, SISTEMA}),
}

#: Donde el prestador escribe.
EDITABLES = frozenset({BORRADOR})

#: Las que ocupan el hueco de «la abierta» (índice `service_versions_una_abierta`).
ABIERTAS = frozenset({BORRADOR, ENVIADA, EN_REVISION, APROBADA})

#: Las que esperan al equipo de Z: la bandeja por defecto.
PENDIENTES_DE_Z = frozenset({ENVIADA, EN_REVISION, APROBADA})

#: Desde dónde puede retirar el prestador.
RETIRABLES = frozenset(d for (d, h) in TRANSICIONES_DE_LA_VERSION if h == RETIRADA)


class SaltoInexistente(AppError):
    """Ese paso no está en el mapa, o ya se dio."""

    status_code = 409
    code = "service_catalog_transition_invalid"


class SaltoNoPermitido(AppError):
    """El paso existe, pero no para quien lo pide."""

    status_code = 403
    code = "service_catalog_transition_forbidden"


def _exigir(mapa: dict, estados: tuple[str, ...], desde: str, hasta: str, actor: str) -> None:
    if desde not in estados or hasta not in estados or actor not in ACTORES:
        raise SaltoInexistente("Ese paso no existe.", details={"from": desde, "to": hasta})
    if desde == hasta or (desde, hasta) not in mapa:
        raise SaltoInexistente(
            "Ese paso no se puede dar desde el estado actual.",
            details={"from": desde, "to": hasta},
        )
    if actor not in mapa[(desde, hasta)]:
        raise SaltoNoPermitido(
            "No tienes permiso para dar ese paso.",
            details={"from": desde, "to": hasta},
        )


def exigir_version(desde: str, hasta: str, actor: str) -> None:
    _exigir(TRANSICIONES_DE_LA_VERSION, ESTADOS_DE_LA_VERSION, desde, hasta, actor)


def exigir_servicio(desde: str, hasta: str, actor: str) -> None:
    _exigir(TRANSICIONES_DEL_SERVICIO, ESTADOS_DEL_SERVICIO, desde, hasta, actor)


def siguientes_de_la_version(desde: str, actor: str) -> list[str]:
    return [h for (d, h), quienes in TRANSICIONES_DE_LA_VERSION.items() if d == desde and actor in quienes]


def siguientes_del_servicio(desde: str, actor: str) -> list[str]:
    return [h for (d, h), quienes in TRANSICIONES_DEL_SERVICIO.items() if d == desde and actor in quienes]


__all__ = [
    "ABIERTAS",
    "APROBADA",
    "BORRADOR",
    "CAMBIOS_PEDIDOS",
    "EDITABLES",
    "EN_REVISION",
    "ENVIADA",
    "ESTADOS_DEL_SERVICIO",
    "ESTADOS_DE_LA_VERSION",
    "PENDIENTES_DE_Z",
    "PUBLICADA",
    "RETIRABLES",
    "RETIRADA",
    "SERVICIO_BORRADOR",
    "SERVICIO_PUBLICADO",
    "SERVICIO_RETIRADO",
    "SERVICIO_SUSPENDIDO",
    "SUPERADA",
    "SaltoInexistente",
    "SaltoNoPermitido",
    "TRANSICIONES_DEL_SERVICIO",
    "TRANSICIONES_DE_LA_VERSION",
    "VISIBLE_AL_PUBLICO",
    "exigir_servicio",
    "exigir_version",
    "siguientes_de_la_version",
    "siguientes_del_servicio",
]
