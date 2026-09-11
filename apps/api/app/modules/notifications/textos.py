"""Los textos de cada aviso, en los tres idiomas.

POR QUÉ AQUÍ Y NO EN EL CLIENTE. El aviso in-app sí lo traduce el teléfono —solo
guarda el `type`—, pero el push llega cuando la aplicación está cerrada: quien
lo compone es el servidor y tiene que saber en qué idioma escribirlo.

QUÉ IDIOMA. El del DISPOSITIVO, que es el único que alguien eligió de verdad.
Viaja en `device_tokens.locale` desde la 0066; nulo significa «no lo dijo» y
entonces manda el de por defecto.

LO QUE NO SE ESCRIBE AQUÍ. Ningún importe, ninguna fecha prometida y ningún
plazo: un aviso no puede comprometer algo que la empresa no ha decidido. «Tu
devolución se está procesando» es un hecho; «recibirás el dinero en 5 días» es
una promesa que no podemos cumplir.
"""

from __future__ import annotations

IDIOMAS = ("es", "en", "pt")
POR_DEFECTO = "es"

#: `{tipo: {idioma: (título, cuerpo)}}`. `{actor}` se sustituye por el nombre de
#: quien lo provocó, cuando lo hay.
TEXTOS: dict[str, dict[str, tuple[str, str]]] = {
    # ------------------------------------------------------------------ #
    # Posventa de eventos
    # ------------------------------------------------------------------ #
    "event_case_submitted": {
        "es": ("Solicitud recibida", "Estamos revisando tu solicitud."),
        "en": ("Request received", "We are reviewing your request."),
        "pt": ("Solicitação recebida", "Estamos analisando sua solicitação."),
    },
    # LA CANCELACIÓN TOTAL. Los dos dicen que está EN EVALUACIÓN, que es un
    # hecho; ninguno promete una devolución, porque nadie la ha decidido.
    "event_cancelled_under_review": {
        "es": (
            "El evento se canceló",
            "Tu compra está en evaluación. Te avisaremos del resultado.",
        ),
        "en": (
            "The event was cancelled",
            "Your purchase is under review. We will let you know the outcome.",
        ),
        "pt": (
            "O evento foi cancelado",
            "Sua compra está em análise. Avisaremos sobre o resultado.",
        ),
    },
    "event_cancelled_organizer_notice": {
        "es": (
            "Cancelaste el evento",
            "Lo vendido queda retenido y en revisión.",
        ),
        "en": (
            "You cancelled the event",
            "Sales are on hold and under review.",
        ),
        "pt": (
            "Você cancelou o evento",
            "As vendas ficam retidas e em análise.",
        ),
    },
    "event_case_taken": {
        "es": ("Solicitud en revisión", "Alguien está mirando tu solicitud."),
        "en": ("Request under review", "Someone is looking at your request."),
        "pt": ("Solicitação em análise", "Alguém está analisando sua solicitação."),
    },
    "event_case_info_requested": {
        "es": ("Necesitamos un dato", "Abre tu solicitud para responder."),
        "en": ("We need a detail", "Open your request to reply."),
        "pt": ("Precisamos de um dado", "Abra sua solicitação para responder."),
    },
    "event_case_answered": {
        "es": ("Respuesta recibida", "Volvemos a revisar tu solicitud."),
        "en": ("Reply received", "We are reviewing your request again."),
        "pt": ("Resposta recebida", "Voltamos a analisar sua solicitação."),
    },
    "event_case_approved": {
        "es": ("Solicitud aprobada", "Revisa los detalles en tu solicitud."),
        "en": ("Request approved", "Check the details in your request."),
        "pt": ("Solicitação aprovada", "Veja os detalhes na sua solicitação."),
    },
    "event_case_rejected": {
        "es": ("Solicitud rechazada", "Puedes leer el motivo en tu solicitud."),
        "en": ("Request rejected", "You can read the reason in your request."),
        "pt": ("Solicitação recusada", "Você pode ler o motivo na sua solicitação."),
    },
    # APROBAR NO ES HABER PAGADO, y estos dos textos lo dicen distinto a
    # propósito: uno anuncia que empezó, el otro que terminó.
    "event_refund_started": {
        "es": ("Devolución iniciada", "La pedimos a la pasarela de pago."),
        "en": ("Refund started", "We requested it from the payment provider."),
        "pt": ("Devolução iniciada", "Solicitamos ao provedor de pagamento."),
    },
    "event_refund_confirmed": {
        "es": ("Devolución confirmada", "La pasarela confirmó el reembolso."),
        "en": ("Refund confirmed", "The provider confirmed the refund."),
        "pt": ("Devolução confirmada", "O provedor confirmou o reembolso."),
    },
    "event_ticket_held": {
        "es": ("Entrada retenida", "No sirve para entrar mientras la revisamos."),
        "en": ("Ticket on hold", "It will not admit you while we review it."),
        "pt": ("Ingresso retido", "Não serve para entrar enquanto analisamos."),
    },
    "event_ticket_restored": {
        "es": ("Entrada restaurada", "Ábrela para obtener un código nuevo."),
        "en": ("Ticket restored", "Open it to get a new code."),
        "pt": ("Ingresso restaurado", "Abra-o para obter um código novo."),
    },
    "event_ticket_revoked": {
        "es": ("Entrada anulada", "Ya no sirve para entrar al evento."),
        "en": ("Ticket revoked", "It no longer admits you to the event."),
        "pt": ("Ingresso cancelado", "Não serve mais para entrar no evento."),
    },
    # UN CAMBIO REGISTRADO NO ES UN DERECHO. El texto dice qué pasó y no
    # promete nada: si da derecho a algo lo decide una persona después.
    "event_changed": {
        "es": ("El evento cambió", "Revisa qué cambió antes de ir."),
        "en": ("The event changed", "Check what changed before you go."),
        "pt": ("O evento mudou", "Veja o que mudou antes de ir."),
    },
    "event_cancelled": {
        "es": ("Evento cancelado", "Abre tus entradas para ver qué sigue."),
        "en": ("Event cancelled", "Open your tickets to see what is next."),
        "pt": ("Evento cancelado", "Abra seus ingressos para ver o que vem."),
    },
    # ------------------------------------------------------------------ #
    # Reseñas
    # ------------------------------------------------------------------ #
    "event_review_received": {
        "es": ("Nueva reseña", "{actor} valoró tu evento."),
        "en": ("New review", "{actor} reviewed your event."),
        "pt": ("Nova avaliação", "{actor} avaliou seu evento."),
    },
    "event_review_replied": {
        "es": ("Respuesta del organizador", "Respondieron a tu reseña."),
        "en": ("Organizer replied", "Someone replied to your review."),
        "pt": ("Resposta do organizador", "Responderam à sua avaliação."),
    },
}

#: Canal de Android. Todo lo de posventa va a «contenido»: no es una
#: interacción social y quien silencie los «me gusta» no quiere perderse esto.
CANALES: dict[str, str] = {tipo: "contenido" for tipo in TEXTOS}

#: Los que NO pueden sonar dos veces por el mismo suceso. Todos: cada uno
#: corresponde a un hecho que ocurre una vez, y el webhook de la pasarela se
#: reintenta.
DEDUPLICABLES: frozenset[str] = frozenset(TEXTOS)


def idioma_valido(locale: str | None) -> str:
    """El idioma pedido, o el de por defecto. Nunca uno que no existe."""
    limpio = (locale or "").strip().lower()[:2]
    return limpio if limpio in IDIOMAS else POR_DEFECTO


def texto(tipo: str, *, locale: str | None, actor: str | None = None) -> tuple[str, str] | None:
    """Título y cuerpo, o `None` si el tipo no tiene texto aquí.

    `None` no es un fallo: los tipos anteriores viven en `push.TEMPLATES` y
    esta tabla no los duplica.
    """
    porIdioma = TEXTOS.get(tipo)
    if porIdioma is None:
        return None
    titulo, cuerpo = porIdioma[idioma_valido(locale)]
    nombre = (actor or "").strip()
    return titulo, cuerpo.replace("{actor}", nombre or "Alguien")


def clave_de_suceso(tipo: str, *, entidad_id: str | None, usuario_id: str) -> str | None:
    """Qué identifica a este aviso como «el mismo suceso», o `None`.

    Va a una columna con índice único, así que es texto con separador fijo: sin
    él, dos claves distintas se podrían escribir igual.
    """
    if tipo not in DEDUPLICABLES:
        return None
    return f"{usuario_id}|{tipo}|{entidad_id or '-'}"


__all__ = [
    "CANALES",
    "DEDUPLICABLES",
    "IDIOMAS",
    "POR_DEFECTO",
    "TEXTOS",
    "clave_de_suceso",
    "idioma_valido",
    "texto",
]
