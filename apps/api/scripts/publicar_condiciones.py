"""Publica unas condiciones del piloto de Z Servicios, por las rutas de
administración que ya existen. Es el procedimiento de
`docs/Z_SERVICIOS_CONDICIONES_PILOTO_V1.md`, sin pasos a mano.

NO PUBLICA SI NO SE LE DICE. Sin `--publicar` prepara el borrador, comprueba
su huella contra la del servidor y se detiene:

    python scripts/publicar_condiciones.py --tipo prestador --api https://…
        Crea (o corrige) el borrador y compara su huella. No publica.

    python scripts/publicar_condiciones.py --tipo prestador --api https://… --publicar
        Lo mismo y, SOLO si la huella coincide, publica.

EL TOKEN de la sesión de administración se lee de la variable de entorno
`Z_ADMIN_TOKEN`. Nunca se escribe en un argumento, en un fichero ni en la
salida. Lo único que se imprime es el tipo, la versión, el tamaño, la huella y
el estado.

SE NIEGA A SEGUIR si el texto lleva un marcador PENDIENTE, si la huella del
borrador no es la del texto local, o si el servidor contesta otra cosa que la
esperada. Repetirlo es seguro: si esas condiciones ya están publicadas, lo
dice y no toca nada.

Hace falta que en ese servidor `FEATURE_SERVICES` esté encendida (las rutas de
administración contestan 503 con ella apagada) y que la cuenta tenga el rol
`admin`.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import condiciones_del_piloto as condiciones  # noqa: E402

BASE = "/api/v1/admin/services/policies"
VARIABLE_DEL_TOKEN = "Z_ADMIN_TOKEN"
#: El token de una sesión de administración NO viaja en claro: HTTPS, o una
#: API en este mismo equipo.
DESTINO_ADMITIDO = re.compile(r"^(https://[^\s/]+|http://(localhost|127\.0\.0\.1)(:\d+)?)/?$")


class NoSePublica(Exception):
    """Algo no es lo esperado: se detiene sin publicar."""


class EstadoDesconocido(NoSePublica):
    """La orden de publicar se envió y lo que volvió no es lo esperado: puede
    estar publicada o no. Repetir el guion lo aclara (si lo está, lo dice)."""


def _es_politica(respuesta) -> bool:
    return isinstance(respuesta, dict) and isinstance(respuesta.get("id"), str)


class _SinRedirecciones(urllib.request.HTTPRedirectHandler):
    """`urlopen` sigue las redirecciones y REENVÍA la cabecera de autorización
    al destino, también si es otro servidor o va por http. La API no redirige:
    una redirección es un error, y el token no sale de donde se le mandó."""

    def redirect_request(self, *_args, **_kwargs):  # noqa: ANN002, ANN003, ANN201
        return None


async def publicar(pedir, cual: str, *, de_verdad: bool, decir=print) -> dict:
    """El recorrido: lo vigente, el borrador, la vista previa, la huella y,
    solo si se pide y coincide, publicar. `pedir(metodo, ruta, cuerpo)` hace
    la petición y devuelve `(estado, json)`.

    Devuelve `{"estado": …, "version": …, "huella": …}`; `estado` es
    `already_published`, `draft_ready` o `published`.
    """
    datos = condiciones.CONDICIONES[cual]
    texto = condiciones.leer(datos.texto)
    if condiciones.pendientes(texto):
        raise NoSePublica("El texto lleva marcadores PENDIENTE: no se publica.")
    cuerpo = condiciones.peticion(texto, cual)
    esperada = condiciones.huella(texto)
    decir(f"Tipo:    {datos.tipo}")
    decir(f"Tamaño:  {len(texto)} caracteres")
    decir(f"Huella:  {esperada}")

    estado, lista = await pedir("GET", f"{BASE}?kind={datos.tipo}&country={condiciones.PAIS}", None)
    if estado != 200 or not isinstance(lista, list) or not all(isinstance(p, dict) for p in lista):
        raise NoSePublica(f"No se pudo leer lo publicado (HTTP {estado}).")
    # Se vuelve a filtrar AQUÍ: lo que decide si se publica otra vez no puede
    # depender de que el servidor (o un intermediario) respetara el filtro.
    generales = [
        p for p in lista
        if p.get("kind") == datos.tipo and p.get("country_code") == condiciones.PAIS and p.get("category") is None
    ]
    vigente = next((p for p in generales if p.get("status") == "published"), None)
    if vigente is not None and vigente.get("body_sha256") == esperada:
        decir(f"Ya publicada: versión {vigente['version']}. No se toca nada.")
        return {"estado": "already_published", "version": vigente["version"], "huella": esperada}

    estado, borrador = await pedir("POST", f"{BASE}/{datos.ruta}/draft", cuerpo)
    if estado not in (200, 201) or not _es_politica(borrador):
        raise NoSePublica(f"No se pudo crear el borrador (HTTP {estado}).")
    if borrador.get("body") != texto or borrador.get("title") != datos.titulo or borrador.get("parameters"):
        # Ya había un borrador, y el servidor lo devuelve SIN TOCARLO: con su
        # texto y CON SUS PARÁMETROS. La huella solo cubre el texto, así que
        # los parámetros de ese borrador (qué documentos se exigen, si se puede
        # volver a postular) se publicarían sin que nadie los hubiera mirado.
        # Las condiciones del piloto van sin parámetros: se corrige todo.
        estado, borrador = await pedir(
            "PATCH", f"{BASE}/{borrador['id']}", {"title": datos.titulo, "body": texto, "parameters": {}}
        )
        if estado != 200 or not _es_politica(borrador):
            raise NoSePublica(f"No se pudo corregir el borrador (HTTP {estado}).")
    if borrador.get("parameters"):
        raise NoSePublica("El borrador lleva parámetros que este texto no decide: no se publica.")

    estado, vista = await pedir("GET", f"{BASE}/{borrador['id']}/preview", None)
    if estado != 200 or not isinstance(vista, dict):
        raise NoSePublica(f"No se pudo leer la vista previa (HTTP {estado}).")
    if vista.get("sha256") != esperada:
        raise NoSePublica("La huella del borrador NO es la del texto local: no se publica.")
    decir(f"Borrador: versión {vista['version']}, la huella coincide.")
    if not de_verdad:
        decir("No se publicó (falta --publicar).")
        return {"estado": "draft_ready", "version": vista["version"], "huella": esperada}

    try:
        estado, publicada = await pedir("POST", f"{BASE}/{borrador['id']}/publish", None)
    except NoSePublica as motivo:
        # La orden de publicar ya salió: que no llegue la respuesta no dice que
        # no se publicara.
        raise EstadoDesconocido(str(motivo)) from None
    if (
        estado != 200
        or not isinstance(publicada, dict)
        or publicada.get("status") != "published"
        or publicada.get("body_sha256") != esperada
        or publicada.get("parameters")
    ):
        raise EstadoDesconocido(f"La publicación no contestó lo esperado (HTTP {estado}).")
    decir(f"Publicada: versión {publicada['version']}.")
    return {"estado": "published", "version": publicada["version"], "huella": esperada}


def _por_http(api: str, token: str):
    """Las peticiones de verdad, con la biblioteca estándar."""

    abridor = urllib.request.build_opener(_SinRedirecciones)

    async def pedir(metodo: str, ruta: str, cuerpo: dict | None):
        peticion = urllib.request.Request(
            api.rstrip("/") + ruta,
            method=metodo,
            data=json.dumps(cuerpo).encode("utf-8") if cuerpo is not None else None,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        try:
            with abridor.open(peticion, timeout=30) as respuesta:  # noqa: S310 - la URL la da quien lo ejecuta
                crudo = respuesta.read().decode("utf-8", errors="replace")
                estado = respuesta.status
        except urllib.error.HTTPError as error:
            # Solo el estado (también un 3xx: no se sigue): el cuerpo no se imprime.
            return error.code, None
        except (urllib.error.URLError, TimeoutError, OSError):
            # Sin red no hay nada a medias que explicar: ni traza ni dirección.
            raise NoSePublica("No se pudo conectar con la API.") from None
        try:
            return estado, json.loads(crudo or "null")
        except ValueError:
            # Un 200 que no es JSON (una página de un intermediario) no es una
            # respuesta de la API: se trata como si no hubiera contestado.
            return estado, None

    return pedir


def main(argumentos: list[str] | None = None) -> int:
    analizador = argparse.ArgumentParser(description="Publica unas condiciones del piloto por las rutas de administración.")
    analizador.add_argument("--tipo", choices=sorted(condiciones.CONDICIONES), required=True)
    analizador.add_argument("--api", required=True, help="La dirección de la API, sin la ruta (https://…).")
    analizador.add_argument("--publicar", action="store_true", help="Publica si la huella coincide. Sin esto, no publica.")
    opciones = analizador.parse_args(argumentos)
    if not DESTINO_ADMITIDO.match(opciones.api):
        print("La dirección de la API tiene que ser https://… (sin ruta): el token no viaja en claro.", file=sys.stderr)
        return 2
    token = os.environ.get(VARIABLE_DEL_TOKEN, "").strip()
    if not token:
        print(f"Falta la variable de entorno {VARIABLE_DEL_TOKEN} (el token de una sesión de administración).", file=sys.stderr)
        return 2
    try:
        asyncio.run(publicar(_por_http(opciones.api, token), opciones.tipo, de_verdad=opciones.publicar))
    except EstadoDesconocido as motivo:
        print(
            f"NO SE SABE SI SE PUBLICÓ. {motivo} Repite la misma orden: si ya está publicada lo dice y no toca nada.",
            file=sys.stderr,
        )
        return 3
    except NoSePublica as motivo:
        print(f"NO SE PUBLICÓ. {motivo}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
