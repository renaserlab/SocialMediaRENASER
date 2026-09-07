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
import logging
import re
import uuid
from contextvars import ContextVar
from dataclasses import dataclass

logger = logging.getLogger("renaser.contexto")

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
            if aguja == "safari":
                # EN SAFARI EL NÚMERO NO VA DETRÁS DEL NOMBRE. `Safari/605.1.15`
                # es la compilación de WebKit, no la versión del navegador: esa
                # está en `Version/17.0`. Guardar «Safari 605» sería apuntar un
                # dato que parece una versión y no lo es, en una tabla que
                # alguien va a leer para investigar algo.
                version = re.search(r"version/(\d{1,4})", bajo)
            else:
                version = re.search(rf"{aguja}/(\d{{1,4}})", bajo)
            return f"{nombre} {version.group(1)}" if version else nombre
    return "otro"


#: Lo unico que se acepta como identificador de peticion venido de fuera.
#: Letras, digitos, punto, guion y guion bajo: cubre un uuid, un ULID y lo que
#: generan los proxys habituales, y deja fuera espacios, saltos de linea,
#: caracteres de control y cualquier cosa que no sea latin-1.
_ADMISIBLE = re.compile(r"\A[A-Za-z0-9._-]{1,64}\Z")


def identificador_admisible(valor: str | None) -> str | None:
    """El identificador entrante si es presentable, o `None`.

    Se rechaza entero en vez de limpiarlo. Un valor saneado a medias sigue
    siendo texto elegido por quien pide, y este dato viaja a la tabla de
    auditoria, a cada linea de registro y de vuelta en una cabecera de
    respuesta: los tres sitios donde una cadena con caracteres de control deja
    de poder leerse con confianza.
    """
    if not valor:
        return None
    return valor if _ADMISIBLE.match(valor) else None


def _ip_del_cliente(cabecera: str | None, respaldo: str | None) -> str | None:
    """La IP de quien pide, o `None`. NO es la primera de la cadena.

    `X-Forwarded-For` es una lista, y **cualquiera puede mandarla**: solo se mira
    cuando la configuración declara que hay un proxy delante.

    SE TOMA LA ÚLTIMA ENTRADA, NO LA PRIMERA, y esto es lo que hace que la
    cabecera valga para algo. Un proxy no reemplaza el valor: AÑADE al final la
    dirección desde la que le llegó la conexión. Si el cliente manda
    `X-Forwarded-For: 9.9.9.9`, lo que llega es `9.9.9.9, <la de verdad>`.
    Leyendo la primera se guardaba exactamente el texto que eligió quien pide, y
    con ello se podía falsificar el origen de un consentimiento o incriminar a
    otro prefijo de red. La última la escribió nuestro proxy.

    Y SE VALIDA QUE SEA UNA IP antes de devolverla: si no lo es, no vale ni para
    agrupar, y hashear texto arbitrario del cliente solo llena una columna.
    """
    from app.core.config import get_settings

    if cabecera and getattr(get_settings(), "trust_proxy_headers", False):
        partes = [p.strip() for p in cabecera.split(",") if p.strip()]
        if partes:
            ultima = partes[-1]
            try:
                ipaddress.ip_address(ultima)
                return ultima
            except ValueError:
                # Cabecera malformada: se ignora entera y se usa el socket.
                pass
    directa = (respaldo or "").strip()
    if not directa:
        return None
    try:
        ipaddress.ip_address(directa)
    except ValueError:
        return None
    return directa


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


#: Longitud mínima de la sal. Por debajo, se trata como si no hubiera.
#:
#: NO ES UN NÚMERO DE ADORNO. El espacio entero de IPv4 son 2^32 direcciones: se
#: recorre en minutos. Lo único que impide reconstruir una IP a partir de su
#: huella es no conocer la sal, así que una sal de cuatro caracteres se adivina
#: junto con la dirección y la protección desaparece sin que nadie se entere.
LARGO_MINIMO_DE_SAL = 32


def _huella(ip: str) -> str | None:
    import hmac

    from app.core.config import get_settings

    sal = (getattr(get_settings(), "ip_hash_salt", "") or "").strip()
    if len(sal) < LARGO_MINIMO_DE_SAL:
        # Sin sal —o con una demasiado corta— el hash se revierte por fuerza
        # bruta. Se devuelve `None` y no un hash: escribirlo daría una sensación
        # de protección que no existe, y eso es peor que no tener nada, porque
        # nadie vuelve a mirarlo.
        if sal:
            logger.warning(
                "[contexto] IP_HASH_SALT tiene %d caracteres y hacen falta %d: "
                "no se guarda ninguna huella de IP",
                len(sal),
                LARGO_MINIMO_DE_SAL,
            )
        return None
    # HMAC y no `sha256(sal + ip)`: con la concatenación simple, conocer el
    # hash de una entrada permite extender el mensaje. Aquí no es explotable,
    # pero HMAC es la construcción correcta y no cuesta nada.
    return hmac.new(sal.encode("utf-8"), ip.encode("utf-8"), hashlib.sha256).hexdigest()


def leer_origen(peticion) -> OrigenDeLaPeticion:
    """Traduce una petición de FastAPI a lo poco que se puede guardar.

    Recibe el objeto entero y devuelve solo lo normalizado: quien llama no llega
    a tener la IP en claro en una variable, que es la forma de que no acabe en
    un registro por descuido.
    """
    cabeceras = getattr(peticion, "headers", {}) or {}
    cliente = getattr(peticion, "client", None)
    ip = _ip_del_cliente(
        cabeceras.get("x-forwarded-for"), getattr(cliente, "host", None)
    )
    return OrigenDeLaPeticion(
        ip_hash=_huella(ip) if ip else None,
        ip_prefix=_prefijo(ip) if ip else None,
        user_agent_family=familia_del_agente(cabeceras.get("user-agent")),
        request_id=request_id(),
    )
