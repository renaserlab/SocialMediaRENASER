"""De dónde vino una petición, guardado de forma que no identifique a nadie.

QUÉ HABÍA ANTES: nada. Cero usos de `request.client`, `X-Forwarded-For` o
`User-Agent` en todo el backend. La identidad salía solo del JWT. Un
consentimiento sin contexto de origen es más débil de lo que la propia política
pretende demostrar.

LA REGLA QUE ORDENA TODO ESTE FICHERO: **la IP en claro no se guarda nunca, y el
agente de usuario completo tampoco.** Una IP es un dato personal y una cadena de
agente completa es una huella digital del aparato. Lo que hace falta para
resolver un caso de abuso es poder decir «estas dos aceptaciones vienen del
mismo sitio», y para eso basta con una huella y un prefijo de red.

  * `ip_hash`  — SHA-256 de la IP con la sal del servidor. Compara sin leer.
  * `ip_prefix`— /24 en IPv4, /48 en IPv6. Agrupa sin identificar.
  * `user_agent_family` — «Chrome 141», «okhttp», «Expo». Nada más.

SIN SAL NO HAY HUELLA. Con una sal vacía, el conjunto de IPv4 se recorre entero
en segundos y el hash deja de proteger: es reversible por fuerza bruta. Por eso
`ip_hash` queda en `None` si no hay sal configurada, en vez de escribir algo que
aparenta protección y no la da.
"""

from __future__ import annotations

import hashlib
import ipaddress
import re
import uuid
from contextvars import ContextVar
from dataclasses import dataclass

#: El identificador de la petición en curso. Se rellena en el middleware y lo
#: lee quien audita, sin tener que pasarlo por veinte firmas de función.
_peticion: ContextVar[str | None] = ContextVar("renaser_request_id", default=None)


def nuevo_request_id() -> str:
    return uuid.uuid4().hex


def fijar_request_id(valor: str | None) -> object:
    return _peticion.set(valor)


def request_id() -> str | None:
    return _peticion.get()


@dataclass(frozen=True)
class OrigenDeLaPeticion:
    """Lo único que se guarda del origen. Todo opcional: puede no saberse."""

    ip_hash: str | None = None
    ip_prefix: str | None = None
    user_agent_family: str | None = None
    request_id: str | None = None


#: Familias que se reconocen, en el orden en que se buscan. El orden importa:
#: casi todos los navegadores dicen ser varios a la vez, y el primero que casa
#: gana. Chrome antes que Safari porque Chrome también dice «Safari».
_FAMILIAS: tuple[tuple[str, str], ...] = (
    ("edg", "Edge"),
    ("chrome", "Chrome"),
    ("firefox", "Firefox"),
    ("safari", "Safari"),
    ("okhttp", "okhttp"),
    ("expo", "Expo"),
    ("dart", "Dart"),
    ("curl", "curl"),
)


def familia_del_agente(agente: str | None) -> str | None:
    """«Chrome 141» a partir de la cadena entera, o `None`.

    Se descarta todo lo demás a propósito. La cadena completa incluye sistema,
    versión exacta, arquitectura y a veces el modelo del teléfono: junta lo
    suficiente para reconocer a una persona entre miles.
    """
    if not agente:
        return None
    bajo = agente.lower()
    for aguja, nombre in _FAMILIAS:
        if aguja in bajo:
            version = re.search(rf"{aguja}/(\d+)", bajo)
            return f"{nombre} {version.group(1)}" if version else nombre
    return "otro"


def _primera_ip(cabecera: str | None, respaldo: str | None) -> str | None:
    """La IP de quien pide, o `None`.

    `X-Forwarded-For` es una lista y la primera entrada es la del cliente… si
    quien la escribió es de fiar. **Cualquiera puede mandar esa cabecera**, así
    que solo se usa cuando la configuración declara que hay un proxy delante;
    si no, se usa la del socket. Confiar en ella siempre sería dejar que quien
    quiera elija qué IP se le apunta.
    """
    from app.core.config import get_settings

    if cabecera and getattr(get_settings(), "trust_proxy_headers", False):
        primera = cabecera.split(",")[0].strip()
        if primera:
            return primera
    return (respaldo or "").strip() or None


def _prefijo(ip: str) -> str | None:
    try:
        direccion = ipaddress.ip_address(ip)
    except ValueError:
        return None
    if direccion.version == 4:
        red = ipaddress.ip_network(f"{ip}/24", strict=False)
    else:
        red = ipaddress.ip_network(f"{ip}/48", strict=False)
    return str(red)


def _huella(ip: str) -> str | None:
    from app.core.config import get_settings

    sal = (getattr(get_settings(), "ip_hash_salt", "") or "").strip()
    if not sal:
        # Sin sal, el hash de una IPv4 se revierte por fuerza bruta en segundos.
        # Escribirlo daría una sensación de protección que no existe.
        return None
    return hashlib.sha256(f"{sal}|{ip}".encode("utf-8")).hexdigest()


def leer_origen(peticion) -> OrigenDeLaPeticion:
    """Traduce una petición de FastAPI a lo poco que se puede guardar.

    Recibe el objeto entero y devuelve solo lo normalizado: quien llama no llega
    a tener la IP en claro en una variable, que es la forma de que no acabe en
    un registro por descuido.
    """
    cabeceras = getattr(peticion, "headers", {}) or {}
    cliente = getattr(peticion, "client", None)
    ip = _primera_ip(
        cabeceras.get("x-forwarded-for"), getattr(cliente, "host", None)
    )
    return OrigenDeLaPeticion(
        ip_hash=_huella(ip) if ip else None,
        ip_prefix=_prefijo(ip) if ip else None,
        user_agent_family=familia_del_agente(cabeceras.get("user-agent")),
        request_id=request_id(),
    )
