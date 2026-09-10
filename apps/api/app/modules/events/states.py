"""Los estados de un evento y las transiciones que existen de verdad.

Funciones puras: no tocan la base ni saben quién pide el cambio. Eso está en
`permissions.py`. Aquí solo vive «desde dónde se puede llegar a dónde», que es
lo que hace que un `PATCH` genérico no pueda mover el ciclo operativo.

POR QUÉ NO SE CAMBIA CON UN `PATCH`. Un campo editable llamado `estado` es una
invitación: el cliente manda `PUBLISHED` y se salta la admisión entera. Cada
transición es una acción con nombre, con su comprobación y con su rastro.

LOS DOCE DEL BLUEPRINT, Y LOS SIETE QUE SE GUARDAN. El contrato nombra doce
estados. Solo siete se escriben en la base; los otros cinco NO son columnas
porque no son decisiones de nadie:

  - `SOLD_OUT` se DERIVA del aforo. Guardado, se queda mintiendo en cuanto
    alguien cancela su reserva.
  - `IN_PROGRESS` y `COMPLETED_PENDING` se derivan de las fechas, igual que
    `time_state` en el catálogo.
  - `MODIFIED` se derivará de que exista una versión posterior a la vendida.
  - `SETTLED` depende de la liquidación, que este incremento no implementa.
    Escribirlo ahora sería afirmar que se transfirió un dinero que nadie movió.

`REJECTED` no está en la lista de estados del blueprint, y no se inventa: un
evento rechazado VUELVE A BORRADOR y el rechazo queda en la decisión de
admisión, con su motivo y su autor. Así nunca hay un evento «rechazado» que
pareciera publicado ni uno publicado que nadie aprobó.
"""

from __future__ import annotations

from datetime import datetime

from app.modules.catalog import eventos

BORRADOR = "DRAFT"
ENVIADO = "SUBMITTED"
CONDICIONAL = "CONDITIONAL"
APROBADO = "APPROVED"
PUBLICADO = "PUBLISHED"
SUSPENDIDO = "SUSPENDED"
CANCELADO = "CANCELLED"

#: Los que se guardan en `event_operations.workflow_status`. El CHECK de la
#: migración acepta EXACTAMENTE estos: los derivados no caben en la columna, y
#: por eso nadie puede escribir `SOLD_OUT` por descuido.
GUARDABLES = (
    BORRADOR,
    ENVIADO,
    CONDICIONAL,
    APROBADO,
    PUBLICADO,
    SUSPENDIDO,
    CANCELADO,
)

#: Derivados. Se calculan al responder; no son columnas.
AGOTADO = "SOLD_OUT"
EN_CURSO = "IN_PROGRESS"
PENDIENTE_DE_CIERRE = "COMPLETED_PENDING"

#: Las transiciones del Incremento 1, por la acción que las provoca.
#:
#: `cancel` NO está: cancelar abre el flujo de devoluciones, y este incremento
#: no cobra entradas ni las devuelve. Un `CANCELLED` sin devolución detrás sería
#: prometer una gestión que no existe. Para detener las ventas está `suspend`.
TRANSICIONES: dict[str, tuple[tuple[str, ...], str]] = {
    "submit": ((BORRADOR, CONDICIONAL), ENVIADO),
    "request_changes": ((ENVIADO, CONDICIONAL), BORRADOR),
    "reject": ((ENVIADO, CONDICIONAL), BORRADOR),
    "approve": ((ENVIADO, CONDICIONAL), APROBADO),
    "approve_conditional": ((ENVIADO,), CONDICIONAL),
    "publish": ((APROBADO,), PUBLICADO),
    "suspend": ((PUBLICADO,), SUSPENDIDO),
    "resume": ((SUSPENDIDO,), PUBLICADO),
}


class TransicionInvalida(ValueError):
    """Se pidió un cambio de estado que no existe desde donde está el evento."""


def destino(accion: str, actual: str) -> str:
    """A dónde lleva `accion` desde `actual`, o error si no lleva a ningún sitio."""
    if accion not in TRANSICIONES:
        raise TransicionInvalida(f"«{accion}» no es una acción del ciclo del evento.")
    desde, hacia = TRANSICIONES[accion]
    if actual not in desde:
        raise TransicionInvalida(
            f"Un evento en {actual} no admite «{accion}»: solo desde {', '.join(desde)}."
        )
    return hacia


def puede(accion: str, actual: str) -> bool:
    try:
        destino(accion, actual)
    except TransicionInvalida:
        return False
    return True


def es_publico(workflow: str) -> bool:
    """Si el evento se enseña en el catálogo.

    Solo `PUBLISHED`. Un evento ENVIADO no aparece en ninguna búsqueda, que es
    el primer criterio de aceptación del blueprint; uno SUSPENDIDO deja de
    aparecer mientras se resuelve.
    """
    return workflow == PUBLICADO


def es_publico_de_verdad(workflow: str | None, status: str) -> bool:
    """Si este evento esta publicado, MIRE DONDE MIRE.

    Manda el estado operativo cuando el evento lo tiene. Sin fila de ciclo
    —un evento anterior a la 0060, o cualquier camino que no la escriba— manda
    el `status` de siempre.

    POR QUE NO VALE SUPONER `PUBLISHED`. Es lo que se hacia, y falla en
    ABIERTO: un borrador sin ciclo operativo se daba por publicado y abria la
    puerta del evento, que es justo el oraculo de credenciales que la puerta
    existe para cerrar. La ausencia de un dato no puede leerse como el valor
    mas permisivo, exactamente igual que un aviso de cobro sin importe no vale
    como importe coincidente.
    """
    if workflow is not None:
        return es_publico(workflow)
    return status == "published"


def admite_reservas(workflow: str) -> bool:
    """Solo lo publicado admite gente. Suspendido y cancelado, no."""
    return workflow == PUBLICADO


#: Los estados por los que un evento TODAVIA no se ha enseñado nunca.
#:
#: Importa para elegir el código de error: quien pide reservar uno de estos
#: recibe 404, no 403 ni 409. Un «no admite reservas» sobre un borrador ajeno
#: confirma que existe y que alguien está preparando algo. `SUSPENDED` no está
#: en la lista porque ese evento SÍ se enseñó: quien tiene el enlace ya sabe que
#: existe, y un 404 ahí solo consigue que parezca un error de la aplicación.
NUNCA_FUE_PUBLICO = (BORRADOR, ENVIADO, CONDICIONAL, APROBADO)


def se_puede_saber_que_existe(workflow: str | None, status: str) -> bool:
    """Si a quien pregunta se le puede confirmar que este evento existe."""
    if workflow is not None:
        return workflow not in NUNCA_FUE_PUBLICO
    # Sin ciclo operativo, la visibilidad de siempre.
    return status == "published"


def motivo_para_no_reservar(
    evento, momento: datetime, workflow: str | None = None
) -> str | None:
    """Por qué no se puede reservar este evento, o `None` si sí se puede.

    Manda el estado OPERATIVO cuando el evento lo tiene. Sin la 0060 aplicada no
    hay ciclo operativo y la regla es la de siempre: solo lo publicado.
    """
    if workflow is not None:
        if not admite_reservas(workflow):
            return "Ese evento no admite reservas."
    elif evento.status != "published":
        return "Ese evento no admite reservas."

    if eventos.estado_de(evento, momento) == eventos.ANTERIOR:
        return "Ese evento ya terminó."
    return None


def estado_visible(workflow: str, *, lleno: bool, temporal: str) -> str:
    """El estado que se enseña, con los derivados ya resueltos.

    El orden importa: un evento que ya pasó es `COMPLETED_PENDING` aunque
    estuviera agotado, y uno suspendido lo es aunque quede sitio.
    """
    if workflow != PUBLICADO:
        return workflow
    if temporal == eventos.ANTERIOR:
        return PENDIENTE_DE_CIERRE
    if lleno:
        return AGOTADO
    return PUBLICADO
