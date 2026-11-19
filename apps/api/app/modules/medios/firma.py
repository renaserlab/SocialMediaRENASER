"""Firma de lectura de CloudFront y token corto de HLS (spec §4 y §7).

POLÍTICA PERSONALIZADA CON COMODÍN POR ARCHIVO. El recurso firmado es
`https://<dist>/videos/<uid>/<media_id>/*`: la misma firma sirve para el MP4,
el póster y cada segmento HLS de ese video (y el `*` final cubre también la
query). Lo que se mueve a `borrados/` sale del comodín: por eso borrar corta el
acceso aunque una firma siga vigente (corrección N1).

VENCIMIENTO POR VENTANAS. Se firma con vencimiento = inicio de la hora actual
+ 6 h. Dentro de la misma hora la URL de un video sale IDÉNTICA para todos los
pedidos, y así la caché de disco del teléfono (expo-video, expo-image) la
reconoce. Vida útil real: entre 5 y 6 h.

RSA 2048 CON SHA256 (`Hash-Algorithm=SHA256`). La clave privada llega en base64
de una línea (`CLOUDFRONT_MEDIOS_PRIVATE_KEY_B64`): ver `config.py`. Si falta o
no se puede leer, no se firma (las filas `s3` salen sin URL) y se avisa en el
log UNA vez; nunca se escribe la clave.

LRU. Firmar es una operación RSA de ~0,1–0,5 ms; igual se guarda en memoria
por (recurso, vencimiento) para no repetirla en cada página del muro.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import time
from functools import lru_cache

from app.core.config import get_settings

logger = logging.getLogger("renaser.medios")

#: Ventana de firma: el vencimiento se ancla al inicio de la hora.
VENTANA_S = 3600
#: Vida añadida al inicio de la ventana.
VIDA_S = 6 * 3600

#: Algoritmo de la firma. CloudFront acepta SHA256 con el parámetro
#: `Hash-Algorithm`; SHA1 queda solo por si alguna librería lo exigiera.
ALGORITMO = "SHA256"

_aviso_dado = False


def vencimiento_de_ventana(ahora: float | None = None) -> int:
    """Inicio de la hora actual + 6 h, en segundos epoch."""
    ahora = time.time() if ahora is None else ahora
    return int(ahora // VENTANA_S) * VENTANA_S + VIDA_S


def _b64_cloudfront(datos: bytes) -> str:
    """Base64 con las sustituciones que CloudFront pide en la query."""
    return (
        base64.b64encode(datos)
        .decode("ascii")
        .replace("+", "-")
        .replace("=", "_")
        .replace("/", "~")
    )


@lru_cache(maxsize=4)
def _clave_privada(b64: str):
    """La clave privada, leída una vez por valor del secreto."""
    from cryptography.hazmat.primitives import serialization

    pem = base64.b64decode("".join(b64.split()), validate=True)
    return serialization.load_pem_private_key(pem, password=None)


def _clave_o_nada():
    """La clave configurada, o `None` (con un aviso, una sola vez)."""
    global _aviso_dado
    ajustes = get_settings()
    b64 = (ajustes.cloudfront_medios_private_key_b64 or "").strip()
    if not b64 or not ajustes.cloudfront_medios_key_pair_id.strip():
        return None
    try:
        return _clave_privada(b64)
    except Exception:  # noqa: BLE001 — cualquier fallo de lectura: no se firma
        if not _aviso_dado:
            # SIN el valor: solo que no se pudo leer.
            logger.error(
                "CLOUDFRONT_MEDIOS_PRIVATE_KEY_B64 no se puede leer: los videos "
                "en S3 salen sin URL firmada."
            )
            _aviso_dado = True
        return None


def firma_configurada() -> bool:
    ajustes = get_settings()
    return bool(ajustes.cloudfront_medios_dominio.strip()) and _clave_o_nada() is not None


def _dominio() -> str:
    dominio = get_settings().cloudfront_medios_dominio.strip().rstrip("/")
    if dominio.startswith("https://"):
        dominio = dominio[len("https://") :]
    return dominio


def recurso_de_carpeta(carpeta: str) -> str:
    """`https://<dist>/<carpeta>/*`. `carpeta` es `videos/<uid>/<media_id>`."""
    return f"https://{_dominio()}/{carpeta.strip('/')}/*"


@lru_cache(maxsize=4096)
def _query_firmada(recurso: str, vence: int, key_pair_id: str, clave_b64: str) -> str:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding

    politica = json.dumps(
        {
            "Statement": [
                {
                    "Resource": recurso,
                    "Condition": {"DateLessThan": {"AWS:EpochTime": vence}},
                }
            ]
        },
        separators=(",", ":"),
    ).encode("utf-8")
    hash_ = hashes.SHA256() if ALGORITMO == "SHA256" else hashes.SHA1()  # noqa: S303
    firma = _clave_privada(clave_b64).sign(politica, padding.PKCS1v15(), hash_)
    partes = [
        f"Policy={_b64_cloudfront(politica)}",
        f"Signature={_b64_cloudfront(firma)}",
        f"Key-Pair-Id={key_pair_id}",
    ]
    if ALGORITMO == "SHA256":
        partes.append("Hash-Algorithm=SHA256")
    return "&".join(partes)


def query_de_carpeta(carpeta: str, vence: int | None = None) -> str | None:
    """La query (`Policy=…&Signature=…&Key-Pair-Id=…`) que abre `carpeta/*`.

    `None` si la firma no está configurada: quien llama deja la URL vacía.
    """
    if _clave_o_nada() is None or not _dominio():
        return None
    ajustes = get_settings()
    vence = vencimiento_de_ventana() if vence is None else vence
    return _query_firmada(
        recurso_de_carpeta(carpeta),
        int(vence),
        ajustes.cloudfront_medios_key_pair_id.strip(),
        "".join(ajustes.cloudfront_medios_private_key_b64.split()),
    )


def url_firmada(clave: str, query: str) -> str:
    """URL absoluta de CloudFront para una clave de S3, con la query dada."""
    return f"https://{_dominio()}/{clave.lstrip('/')}?{query}"


def carpeta_de_clave(clave: str) -> str | None:
    """`videos/<uid>/<media_id>` de cualquier clave de ese medio; `None` si la
    clave no es de `videos/` (nunca se firma otra cosa)."""
    partes = clave.strip("/").split("/")
    if len(partes) < 4 or partes[0] != "videos":
        return None
    return "/".join(partes[:3])


# --------------------------------------------------------------------------- #
# Token corto del HLS
# --------------------------------------------------------------------------- #
#: El reproductor nativo no manda la sesión al pedir listas HLS. La API decide
#: la visibilidad al EMITIR este token (con el mismo predicado) y la vuelve a
#: comprobar en cada pedido (corrección N2). El token ata `media_id` y
#: vencimiento con un HMAC cuya clave se deriva de la clave de firma de
#: CloudFront: sin firma configurada no hay HLS de S3, y así no hace falta un
#: secreto más que rotar.


def _clave_hmac() -> bytes | None:
    b64 = "".join((get_settings().cloudfront_medios_private_key_b64 or "").split())
    if not b64 or _clave_o_nada() is None:
        return None
    return hashlib.sha256(b"zeta-hls-v1|" + b64.encode("ascii")).digest()


def _mac(clave: bytes, media_id: str, quien: str, vence: int) -> str:
    return hmac.new(clave, f"{media_id}|{quien}|{vence}".encode(), hashlib.sha256).hexdigest()[:40]


def token_hls(media_id: str, viewer_id: str | None, vence: int | None = None) -> str | None:
    """`<vence>.<quien>.<mac>`. Lleva a QUIEN se emitió (o `-` sin cuenta)
    para que el endpoint vuelva a aplicar el predicado de ESA persona en cada
    pedido: un bloqueo o un borrado cortan al instante (corrección N2)."""
    clave = _clave_hmac()
    if clave is None:
        return None
    vence = vencimiento_de_ventana() if vence is None else int(vence)
    quien = viewer_id or "-"
    return f"{vence}.{quien}.{_mac(clave, media_id, quien, vence)}"


def validar_token_hls(
    media_id: str, token: str | None, ahora: float | None = None
) -> tuple[int, str | None] | None:
    """`(vence, viewer_id)` si el token vale para `media_id`; si no, `None`."""
    clave = _clave_hmac()
    if clave is None or not token or token.count(".") != 2:
        return None
    crudo_vence, quien, mac = token.split(".")
    try:
        vence = int(crudo_vence)
    except ValueError:
        return None
    ahora = time.time() if ahora is None else ahora
    if vence <= ahora or not quien:
        return None
    esperado = _mac(clave, media_id, quien, vence)
    if not hmac.compare_digest(esperado.encode(), mac.encode("utf-8", "replace")):
        return None
    return vence, (None if quien == "-" else quien)


def olvidar() -> None:
    """Para las pruebas: que una clave no herede la memoria de la anterior."""
    global _aviso_dado
    _aviso_dado = False
    _clave_privada.cache_clear()
    _query_firmada.cache_clear()
