"""Los avisos que manda 100ms cuando pasa algo en una sala.

## Cómo se comprueba que el aviso es suyo

100ms **no firma el cuerpo** como hace Stripe. Lo que ofrece es una cabecera de
autorización que se declara al dar de alta el webhook en su panel, y que llega
igual en cada aviso. Así que lo que se compara aquí es un secreto compartido,
con `compare_digest` y no con `==`.

**Esto es más débil que una firma HMAC, y conviene decirlo.** Un secreto
compartido demuestra que quien llama lo conoce; una firma demuestra además que
el cuerpo no se tocó por el camino. La mitigación es que el aviso **no se cree
por sí solo**: nada de lo que dice mueve dinero ni concede accesos, y lo único
que puede hacer es cerrar una emisión que ya existía y que ya estaba viva.

`verificar` está aislada a propósito: el día que la cuenta tenga firma, se
cambia esa función y no se toca nada más.

## Lo que un webhook NO puede hacer

- Abrir una emisión que nadie creó.
- Cambiar de dueño una emisión.
- Marcar como viva una que nadie inició desde Z.
- Repetir un efecto: cada aviso se procesa una vez (ver `evento_ya_visto`).

Un aviso perdido no rompe nada: la conciliación pregunta al proveedor.
"""

from __future__ import annotations

import hmac
import logging

logger = logging.getLogger("renaser.live")

#: Cabecera donde 100ms manda lo que se configuró al dar de alta el webhook.
CABECERA = "authorization"


class WebhookInvalido(ValueError):
    """El aviso no se puede atribuir al proveedor. No se procesa."""


def verificar(*, cabeceras: dict[str, str], secreto: str) -> None:
    """Comprueba que el aviso viene de quien dice. Levanta si no.

    FALLA EN CERRADO. Sin secreto configurado no se acepta ningún aviso: dejar
    la puerta abierta «hasta que se configure» convierte esta URL en la forma
    más cómoda de cerrarle la emisión a cualquiera.
    """
    esperado = (secreto or "").strip()
    if not esperado:
        raise WebhookInvalido("No hay secreto de webhook configurado.")

    recibido = ""
    for clave, valor in cabeceras.items():
        if clave.lower() == CABECERA:
            recibido = (valor or "").strip()
            break
    if not recibido:
        raise WebhookInvalido("El aviso llega sin cabecera de autorización.")

    # Se admite tanto el secreto pelado como con el prefijo `Bearer`, porque el
    # panel de 100ms deja escribir la cabecera entera y es fácil poner uno u
    # otro. Comparar con `compare_digest` y no con `==`: la comparación normal
    # termina en la primera letra distinta y eso se puede medir.
    candidatos = [recibido]
    if recibido.lower().startswith("bearer "):
        candidatos.append(recibido[7:].strip())
    for candidato in candidatos:
        if hmac.compare_digest(candidato, esperado):
            return
    raise WebhookInvalido("La autorización del aviso no cuadra.")
