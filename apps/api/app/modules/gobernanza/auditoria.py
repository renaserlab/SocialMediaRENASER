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

import ipaddress
import logging
import re
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.gobernanza import esquema
from app.modules.gobernanza.contexto import OrigenDeLaPeticion, request_id
from app.modules.gobernanza.models import AuditEvent

logger = logging.getLogger("renaser.auditoria")

#: Trozos de nombre que descartan una clave. SE BUSCAN COMO SUBCADENA.
#:
#: LA IGUALDAD EXACTA NO SERVIA DE NADA, y era lo que habia: `token` no casa con
#: `access_token` ni con `api_key`; `email` no casa con `user_email` ni con
#: `correo`. Cualquiera de esos nombres —los que escribe cualquiera sin pensar—
#: pasaba entero a una tabla que se sirve por API.
#:
#: AQUI SOLO VAN LOS LARGOS, los que no aparecen dentro de otra palabra por
#: casualidad.
FRAGMENTOS_PROHIBIDOS = (
    "authorization",
    "auth_",
    "cookie",
    "header",
    "token",
    "secret",
    "password",
    "passwd",
    "clave",
    "signature",
    "api_key",
    "apikey",
    "correo",
    "telefono",
    "direccion",
    "address",
    "tarjeta",
    "mail",
    "agent",
)

#: Y estos, SOLO COMO TROZO COMPLETO del nombre, separado por `_`, `.` o `-`.
#:
#: POR QUE NO PUEDEN IR ARRIBA. Son cortos y aparecen dentro de palabras que no
#: tienen nada que ver: buscando `ip` como subcadena se borraban `description`,
#: `subscription_id`, `recipient_id`, `zip` y `participants`; con `card`,
#: `discard` y `wildcard`; con `raw`, `drawer`; con `firma`, `confirmado`.
#:
#: Y ESO NO ES UN FALLO INOFENSIVO POR SER CERRADO. La nota de auditoria pierde
#: en silencio el identificador que la hacia util, la fila se escribe igual y
#: nadie se entera hasta que alguien intenta reconstruir que paso con ella.
SEGMENTOS_PROHIBIDOS = frozenset(
    {"ip", "ips", "body", "raw", "card", "phone", "dni", "firma", "addr"}
)

_SEPARADORES = re.compile(r"[_.\-]+")

#: Y ADEMAS SE MIRA EL VALOR, porque filtrar solo por el nombre deja pasar
#: `{"nota": "1.2.3.4 / juan@ejemplo.com"}`. No es un detector perfecto ni
#: pretende serlo: descarta lo que inequivocamente no debe estar ahi.
_IPV4 = re.compile(r"(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w.])")
_CORREO = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
#: Candidato a IPv6: solo digitos hexadecimales y dos puntos. Lo que decide
#: de verdad es `ipaddress`, no este patron.
_POSIBLE_IPV6 = re.compile(r"[0-9A-Fa-f:]{3,}")


def _clave_prohibida(clave: object) -> bool:
    nombre = str(clave).lower()
    if any(trozo in nombre for trozo in FRAGMENTOS_PROHIBIDOS):
        return True
    return any(t in SEGMENTOS_PROHIBIDOS for t in _SEPARADORES.split(nombre))


def _hay_ipv6(texto: str) -> bool:
    """Una IPv6 dentro de un texto cualquiera.

    NO SE HACE CON UNA EXPRESION REGULAR. Una que reconozca IPv6 de verdad
    —abreviada, con ceros omitidos, con IPv4 al final— es ilegible y falla por
    los bordes; una sencilla marca `12:34:56` como si fuera una direccion. Se
    saca lo que TIENE FORMA de candidato y se le pregunta a `ipaddress`, que es
    quien lo sabe.
    """
    for trozo in _POSIBLE_IPV6.findall(texto):
        if trozo.count(":") < 2:
            continue
        try:
            if ipaddress.ip_address(trozo).version == 6:
                return True
        except ValueError:
            continue
    return False


def _valor_sospechoso(valor: object) -> bool:
    if not isinstance(valor, str):
        return False
    return bool(_IPV4.search(valor) or _CORREO.search(valor)) or _hay_ipv6(valor)


def _limpio(datos: dict[str, Any] | None, _profundidad: int = 0) -> dict[str, Any]:
    """Solo identificadores y códigos, y RECURSIVAMENTE.

    Un `payload` es para poder reconstruir qué pasó, no para archivar la
    petición. Guardar el cuerpo de un aviso de pasarela aquí sería copiar datos
    de tarjeta a una tabla que lee administración.

    FILTRAR SOLO EL PRIMER NIVEL NO SIRVE DE NADA. Comparando únicamente las
    claves de arriba, un `{"contexto": {"ip": "…", "authorization": "…"}}` pasa
    entero: el diccionario anidado no se llama como ninguna clave prohibida. Y
    `payload` SÍ sale por `GET /admin/audit-events`, así que era una fuga real.
    Ahora se baja hasta el fondo.

    LA PROFUNDIDAD SE ACOTA porque un documento hondo es, por definición, algo
    que no es un identificador ni un código.
    """
    if not datos:
        return {}
    if _profundidad >= 3:
        return {}
    salida: dict[str, Any] = {}
    for clave, valor in datos.items():
        if _clave_prohibida(clave):
            continue
        if _valor_sospechoso(valor):
            continue
        if isinstance(valor, dict):
            limpio = _limpio(valor, _profundidad + 1)
            if limpio:
                salida[clave] = limpio
            continue
        if isinstance(valor, (list, tuple, set)):
            # Solo escalares dentro de una lista: una lista de documentos es
            # justo lo que no cabe aquí.
            salida[clave] = [
                v[:300] if isinstance(v, str) else v
                for v in list(valor)[:20]
                if (isinstance(v, (str, int, float, bool)) or v is None)
                and not _valor_sospechoso(v)
            ]
            continue
        if isinstance(valor, str) and len(valor) > 300:
            valor = valor[:300]
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
