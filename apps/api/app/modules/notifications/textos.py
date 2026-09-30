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
    # BAJO EL MANDATO DE Z. Aquí sí se dice que corresponde la devolución
    # total, porque es una decisión tomada. Lo que sigue sin decirse es CUÁNDO
    # llega el dinero: el plazo bancario no lo decidimos nosotros, y «ya te lo
    # devolvimos» sería falso hasta que lo confirme el proveedor.
    "event_cancelled_full_refund": {
        "es": (
            "El evento se canceló",
            "Te corresponde el 100 % de lo que pagaste. Te avisaremos cuando "
            "el dinero esté de vuelta.",
        ),
        "en": (
            "The event was cancelled",
            "You are owed 100% of what you paid. We will let you know when the "
            "money is back.",
        ),
        "pt": (
            "O evento foi cancelado",
            "Você tem direito a 100 % do que pagou. Avisaremos quando o "
            "dinheiro voltar.",
        ),
    },
    "event_cancelled_organizer_full_refund": {
        "es": (
            "Cancelaste el evento",
            "Lo vendido queda retenido: a quien compró le corresponde el 100 %.",
        ),
        "en": (
            "You cancelled the event",
            "Sales are on hold: buyers are owed 100% of what they paid.",
        ),
        "pt": (
            "Você cancelou o evento",
            "As vendas ficam retidas: quem comprou tem direito a 100 %.",
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
    # ------------------------------------------------------------------ #
    # Envíos de Productos
    #
    # NINGUNO DICE CUÁNDO LLEGARÁ. No hay transportista elegido, ni cobertura,
    # ni plazo aprobado: una fecha aquí sería una promesa que nadie ha hecho y
    # que se lee como un compromiso. Dicen qué pasó y dónde mirarlo.
    # ------------------------------------------------------------------ #
    "product_shipment_dispatched": {
        "es": ("Tu pedido salió", "Abre el pedido para ver el seguimiento."),
        "en": ("Your order shipped", "Open the order to see its tracking."),
        "pt": ("Seu pedido saiu", "Abra o pedido para ver o acompanhamento."),
    },
    # SE AVISA AUNQUE LO HAYA DICHO QUIEN VENDE, y es justo por eso: es la
    # única forma de que quien compró pueda desmentirlo si no es verdad.
    "product_shipment_delivered": {
        "es": ("Tu pedido figura entregado", "Ábrelo si no lo has recibido."),
        "en": ("Your order is marked delivered", "Open it if it has not arrived."),
        "pt": ("Seu pedido consta como entregue", "Abra-o se não o recebeu."),
    },
    "product_shipment_failed": {
        "es": ("No se pudo entregar", "Abre el pedido para ver el motivo."),
        "en": ("Delivery did not succeed", "Open the order to see why."),
        "pt": ("Não foi possível entregar", "Abra o pedido para ver o motivo."),
    },
    # ------------------------------------------------------------------ #
    # Incidencias de Productos
    #
    # NINGUNO PROMETE DINERO. «Resuelta» dice que hay una decisión, no que
    # haya un reembolso hecho: devolver el dinero es del Incremento 9 y no
    # existe. Un texto que dijera «te devolvemos el importe» haría que alguien
    # esperara un abono que nadie ha ordenado.
    # ------------------------------------------------------------------ #
    "product_incident_opened": {
        "es": ("Reportaron un problema", "Tienes que responder a este caso."),
        "en": ("A problem was reported", "This case needs your answer."),
        "pt": ("Relataram um problema", "Este caso precisa da sua resposta."),
    },
    "product_incident_answered": {
        "es": ("Respondieron a tu caso", "Ábrelo para ver qué proponen."),
        "en": ("Your case got a reply", "Open it to see what they propose."),
        "pt": ("Responderam ao seu caso", "Abra-o para ver o que propõem."),
    },
    "product_incident_more_evidence": {
        "es": ("Piden más evidencia", "Ábrelo para ver qué falta."),
        "en": ("More evidence requested", "Open it to see what is missing."),
        "pt": ("Pedem mais evidências", "Abra-o para ver o que falta."),
    },
    "product_incident_mediation": {
        "es": ("Tu caso pasó a revisión de Z", "Lo está mirando una persona."),
        "en": ("Your case went to Z review", "A person is looking at it."),
        "pt": ("Seu caso foi para revisão da Z", "Uma pessoa está analisando."),
    },
    # «HAY UNA DECISIÓN», NO «TE DEVOLVIMOS EL DINERO».
    "product_incident_resolved": {
        "es": ("Hay una decisión sobre tu caso", "Ábrelo para leerla."),
        "en": ("There is a decision on your case", "Open it to read it."),
        "pt": ("Há uma decisão sobre seu caso", "Abra-o para lê-la."),
    },
    # ------------------------------------------------------------------ #
    # Admisión de prestadores de Servicios
    #
    # NINGUNO LLEVA DATOS: ni documentos, ni motivos, ni notas. Dicen qué
    # pasó; el detalle se lee en la postulación, con sesión.
    # ------------------------------------------------------------------ #
    "service_application_review_started": {
        "es": ("Tu postulación está en revisión", "El equipo de Z la está revisando."),
        "en": ("Your application is under review", "The Z team is reviewing it."),
        "pt": ("Sua candidatura está em análise", "A equipe da Z está analisando."),
    },
    "service_application_changes_requested": {
        "es": ("Hay que corregir tu postulación", "Ábrela para ver qué falta."),
        "en": ("Your application needs changes", "Open it to see what is missing."),
        "pt": ("Sua candidatura precisa de ajustes", "Abra-a para ver o que falta."),
    },
    "service_application_approved": {
        "es": ("Tu postulación fue aprobada", "Ya eres prestador de Servicios en Z."),
        "en": ("Your application was approved", "You are now a service provider on Z."),
        "pt": ("Sua candidatura foi aprovada", "Agora você é prestador de serviços na Z."),
    },
    "service_application_rejected": {
        "es": ("Hay una decisión sobre tu postulación", "Ábrela para leer el motivo."),
        "en": ("There is a decision on your application", "Open it to read the reason."),
        "pt": ("Há uma decisão sobre sua candidatura", "Abra-a para ler o motivo."),
    },
    "service_application_suspended": {
        "es": ("Tu cuenta de prestador está suspendida", "Ábrela para leer el motivo."),
        "en": ("Your provider account is suspended", "Open it to read the reason."),
        "pt": ("Sua conta de prestador está suspensa", "Abra-a para ler o motivo."),
    },
    "service_application_withdrawn": {
        "es": ("Retiraste tu postulación", "Puedes empezar otra cuando quieras."),
        "en": ("You withdrew your application", "You can start a new one anytime."),
        "pt": ("Você retirou sua candidatura", "Você pode começar outra quando quiser."),
    },
    "service_document_observed": {
        "es": ("Un documento necesita cambios", "Ábrelo para ver qué corregir."),
        "en": ("A document needs changes", "Open it to see what to fix."),
        "pt": ("Um documento precisa de ajustes", "Abra-o para ver o que corrigir."),
    },
    "service_credential_observed": {
        "es": ("Una credencial necesita cambios", "Ábrela para ver qué corregir."),
        "en": ("A credential needs changes", "Open it to see what to fix."),
        "pt": ("Uma credencial precisa de ajustes", "Abra-a para ver o que corrigir."),
    },
    "service_credential_rejected": {
        "es": ("Una credencial no fue aceptada", "Ábrela para leer el motivo."),
        "en": ("A credential was not accepted", "Open it to read the reason."),
        "pt": ("Uma credencial não foi aceita", "Abra-a para ler o motivo."),
    },
    "service_application_submitted": {
        "es": ("Nueva postulación de prestador", "Hay una postulación esperando revisión."),
        "en": ("New provider application", "An application is waiting for review."),
        "pt": ("Nova candidatura de prestador", "Há uma candidatura aguardando análise."),
    },
    "service_application_resubmitted": {
        "es": ("Una postulación se reenvió", "Trae las correcciones que pediste."),
        "en": ("An application was resubmitted", "It includes the changes you asked for."),
        "pt": ("Uma candidatura foi reenviada", "Ela traz os ajustes que você pediu."),
    },
    "service_application_withdrawn_review": {
        "es": ("Una postulación se retiró", "Quien postuló la retiró antes de la decisión."),
        "en": ("An application was withdrawn", "The applicant withdrew it before a decision."),
        "pt": ("Uma candidatura foi retirada", "Quem se candidatou a retirou antes da decisão."),
    },
    # Z Servicios · catálogo (Incremento 2). Sin títulos ni motivos: quien lo
    # abre lee el detalle en el servicio.
    "service_catalog_review_started": {
        "es": ("Revisamos tu servicio", "El equipo de Z empezó a revisar lo que enviaste."),
        "en": ("We're reviewing your service", "The Z team started reviewing what you submitted."),
        "pt": ("Estamos revisando seu serviço", "A equipe da Z começou a revisar o que você enviou."),
    },
    "service_catalog_changes_requested": {
        "es": ("Tu servicio necesita cambios", "Ábrelo para leer qué corregir."),
        "en": ("Your service needs changes", "Open it to read what to fix."),
        "pt": ("Seu serviço precisa de ajustes", "Abra-o para ler o que corrigir."),
    },
    "service_catalog_approved": {
        "es": ("Tu servicio fue aprobado", "Falta que el equipo de Z lo publique."),
        "en": ("Your service was approved", "The Z team still has to publish it."),
        "pt": ("Seu serviço foi aprovado", "Falta a equipe da Z publicá-lo."),
    },
    "service_catalog_published": {
        "es": ("Tu servicio está publicado", "Ya se puede ver en Z."),
        "en": ("Your service is published", "It can now be seen on Z."),
        "pt": ("Seu serviço está publicado", "Já pode ser visto na Z."),
    },
    "service_catalog_suspended": {
        "es": ("Tu servicio fue suspendido", "Ábrelo para leer el motivo."),
        "en": ("Your service was suspended", "Open it to read the reason."),
        "pt": ("Seu serviço foi suspenso", "Abra-o para ler o motivo."),
    },
    "service_catalog_reinstated": {
        "es": ("Tu servicio vuelve a estar visible", "El equipo de Z levantó la suspensión."),
        "en": ("Your service is visible again", "The Z team lifted the suspension."),
        "pt": ("Seu serviço está visível de novo", "A equipe da Z retirou a suspensão."),
    },
    "service_catalog_retired": {
        "es": ("Tu servicio salió del catálogo", "Ábrelo para leer el motivo."),
        "en": ("Your service left the catalog", "Open it to read the reason."),
        "pt": ("Seu serviço saiu do catálogo", "Abra-o para ler o motivo."),
    },
    "service_catalog_published_suspended": {
        "es": ("Tu versión nueva está lista", "El servicio sigue suspendido: se verá cuando Z levante la suspensión."),
        "en": ("Your new version is ready", "The service is still suspended: it will be visible when Z lifts the suspension."),
        "pt": ("Sua nova versão está pronta", "O serviço continua suspenso: ficará visível quando a Z retirar a suspensão."),
    },
    "service_catalog_submitted": {
        "es": ("Nuevo servicio para revisar", "Un prestador envió un servicio."),
        "en": ("New service to review", "A provider submitted a service."),
        "pt": ("Novo serviço para revisar", "Um prestador enviou um serviço."),
    },
    "service_catalog_resubmitted": {
        "es": ("Un servicio volvió corregido", "Trae los cambios que pediste."),
        "en": ("A service came back corrected", "It includes the changes you requested."),
        "pt": ("Um serviço voltou corrigido", "Traz os ajustes que você pediu."),
    },
    "service_catalog_withdrawn_review": {
        "es": ("Un servicio se retiró de la revisión", "El prestador lo retiró antes de publicarse."),
        "en": ("A service was withdrawn from review", "The provider withdrew it before publication."),
        "pt": ("Um serviço foi retirado da revisão", "O prestador o retirou antes da publicação."),
    },
    # Z Servicios, Incremento 5: la reserva. Sin fecha, hora, importe ni
    # dirección: quien lo abre lee el detalle en la reserva.
    "service_booking_confirmed": {
        "es": ("Tu reserva está confirmada", "Ábrela para ver el detalle."),
        "en": ("Your booking is confirmed", "Open it to see the details."),
        "pt": ("Sua reserva está confirmada", "Abra-a para ver os detalhes."),
    },
    "service_booking_received": {
        "es": ("Tienes una reserva nueva", "Ábrela para ver el detalle."),
        "en": ("You have a new booking", "Open it to see the details."),
        "pt": ("Você tem uma nova reserva", "Abra-a para ver os detalhes."),
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
