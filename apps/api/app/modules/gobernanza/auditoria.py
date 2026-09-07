"""Dejar constancia de una operación sensible. En la MISMA transacción.

LA PROPIEDAD QUE SE BUSCA es «no existe cambio sin su registro». En una
transacción aparte, un fallo entre el `commit` del cambio y el de la auditoría
deja dinero movido sin rastro — precisamente el caso indefendible. Por eso aquí
solo se hace `flush`: confirma quien hizo la operación, y si esa operación se
deshace, el rastro se deshace con ella.

Y SI LA AUDITORÍA FALLA, FALLA LA OPERACIÓN. La excepción propaga. Es una tabla
local, sin dependencias externas: el único fallo realista es un CHECK mal
cumplido o la base caída, y en los dos casos abortar es lo correcto. Lo que no
puede pasar es mover dinero y tragarse en silencio que no se pudo anotar.

Corolario: aquí dentro NO se llama a nada de red. Un aviso a un sistema externo,
si algún día lo hay, va después del commit y es best-effort.

QUÉ NO SUSTITUYE. `refund_request_events` sigue siendo la máquina de estados del
expediente de devolución, con sus claves foráneas y las consultas de negocio que
se apoyan en ella. Esto es el rastro transversal: publicar un curso, congelar un
saldo, lanzar una transferencia. Antes, la única respuesta a «¿quién movió este
dinero?» era una línea de registro que nadie conserva.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.gobernanza import esquema
from app.modules.gobernanza.contexto import OrigenDeLaPeticion, request_id
from app.modules.gobernanza.models import AuditEvent

logger = logging.getLogger("renaser.auditoria")

#: Lo que NUNCA entra en `payload`, aunque alguien lo pase por descuido. No es
#: una lista de buenas intenciones: se filtra de verdad, abajo.
PROHIBIDO = frozenset(
    {
        "authorization",
        "cookie",
        "headers",
        "body",
        "payload_completo",
        "raw",
        "token",
        "secret",
        "password",
        "signature",
        "ip",
        "user_agent",
        "email",
    }
)


def _limpio(datos: dict[str, Any] | None) -> dict[str, Any]:
    """Solo identificadores y códigos.

    Se filtra por nombre de clave y se recorta el largo: un `payload` es para
    poder reconstruir qué pasó, no para archivar la petición. Guardar el cuerpo
    de un aviso de pasarela aquí sería copiar datos de tarjeta a una tabla que
    lee administración.
    """
    if not datos:
        return {}
    salida: dict[str, Any] = {}
    for clave, valor in datos.items():
        if clave.lower() in PROHIBIDO:
            continue
        if isinstance(valor, str) and len(valor) > 300:
            valor = valor[:300]
        if isinstance(valor, (dict, list)) and len(str(valor)) > 1000:
            continue
        salida[clave] = valor
    return salida


async def anotar(
    db: AsyncSession,
    *,
    action: str,
    entity_type: str,
    entity_id: str,
    actor_id: str | None = None,
    actor_role: str = "system",
    outcome: str = "ok",
    previous_state: str | None = None,
    new_state: str | None = None,
    reason: str | None = None,
    external_reference: str | None = None,
    payload: dict[str, Any] | None = None,
    origen: OrigenDeLaPeticion | None = None,
) -> AuditEvent | None:
    """Escribe el rastro. Devuelve `None` si la 0050 no está aplicada.

    NO HACE `commit`. Quien llama decide cuándo, y así el rastro vive o muere
    con la operación que describe.

    `outcome` distingue lo intentado de lo conseguido: `denied` es «se pidió y
    se rechazó», `error` es «se intentó y falló». Un rastro que solo sabe contar
    éxitos no sirve para investigar nada, que es para lo único que sirve.
    """
    if not await esquema.hay_gobernanza(db):
        # Sin las tablas no se puede auditar. Se registra y se sigue: negarse a
        # publicar un curso porque falta una migración sería peor, y la 0050 se
        # aplica a mano.
        logger.warning(
            "[auditoria] sin la 0050 aplicada: %s sobre %s/%s no deja rastro",
            action,
            entity_type,
            entity_id,
        )
        return None

    evento = AuditEvent(
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        actor_id=actor_id,
        actor_role=actor_role,
        outcome=outcome,
        previous_state=previous_state,
        new_state=new_state,
        reason=reason,
        external_reference=external_reference,
        payload=_limpio(payload),
        request_id=(origen.request_id if origen else None) or request_id(),
        ip_hash=origen.ip_hash if origen else None,
        ip_prefix=origen.ip_prefix if origen else None,
        user_agent_family=origen.user_agent_family if origen else None,
    )
    db.add(evento)
    await db.flush()
    return evento
