"""Borrado de archivos en Supabase Storage.

La base de datos no sabe nada de los ficheros: al eliminar una cuenta caian en
cascada sus filas, pero las fotos, videos y audios seguian ocupando sitio en los
buckets. La politica de privacidad promete que se borran, asi que tienen que
borrarse de verdad.

Por que no basta con SQL: los bytes viven en el almacenamiento de objetos y la
tabla `storage.objects` es solo su indice. Borrar la fila dejaria el fichero
huerfano e imposible de localizar. Hay que pedirselo a la API de Storage.

Esa API exige la clave `service_role`, que da acceso total y por eso vive
UNICAMENTE en el backend, nunca en la aplicacion movil.

SI ALGO NO SE PUEDE BORRAR, SE DICE. `delete_user_files` lanza
`BorradoIncompleto` en vez de tragarse el fallo: quien borra la cuenta lo hace
ANTES de confirmar la transaccion y, si los archivos no se van, la cuenta
tampoco (ver `modules/identity/baja.py`).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence

import httpx

from app.core.config import get_settings

logger = logging.getLogger(__name__)

#: Buckets donde la aplicacion sube archivos de usuario. Cada subida se guarda
#: bajo `<id de usuario>/<nombre>`, de modo que ese prefijo delimita todo lo que
#: pertenece a una persona (ver `services/storage.ts` en el movil).
#: `seller-documents` (0085) sigue la misma regla: `<perfil>/<postulación>/...`,
#: y `service-provider-documents` (0088, Servicios) también. Las imágenes del
#: catálogo de Servicios (`service-media`, 0090) van bajo
#: `<perfil>/<servicio>/<versión>/`: el perfil del prestador, primero.
USER_BUCKETS = (
    "post-media",
    "avatars",
    "course-media",
    "seller-documents",
    "service-provider-documents",
    "service-media",
)

_TIMEOUT = httpx.Timeout(15.0)

#: Adjuntos de chat (0033). NO van bajo `<perfil>/`: van bajo
#: `<conversacion>/<quien sube>/<archivo>`, así que se barren conversación a
#: conversación (ver `delete_user_files` y `borrar_conversaciones`).
DEPOSITO_DE_CHAT = "message-media"

#: Cuántos nombres se piden borrar en una sola petición.
LOTE_DE_BORRADO = 100

#: Cuántas peticiones de listado van a la vez. El listado no es recursivo:
#: una cuenta con doscientos vídeos procesados son cientos de carpetas, y de
#: una en una la baja tardaba más de lo que el teléfono espera.
LISTADOS_A_LA_VEZ = 8

#: Hasta dónde se baja en las carpetas. Lo más hondo que escribe la aplicación
#: es `<perfil>/derived/<medio>/hls/<archivo>` (cuatro niveles); el tope es
#: holgado a propósito. PASARLO NO SE CALLA: una carpeta más honda es una que
#: no se sabe borrar, y la baja se detiene antes de borrar nada.
PROFUNDIDAD_MAXIMA = 16


class CarpetaDemasiadoHonda(ValueError):
    """Hay carpetas por debajo de `PROFUNDIDAD_MAXIMA`: no se pueden barrer."""


def storage_configured() -> bool:
    """True si hay credenciales para operar sobre Storage."""
    settings = get_settings()
    return bool(settings.supabase_url and settings.supabase_service_role_key)


def _headers() -> dict[str, str]:
    key = get_settings().supabase_service_role_key
    return {"Authorization": f"Bearer {key}", "apikey": key}


async def _list_prefix(
    client: httpx.AsyncClient,
    bucket: str,
    prefix: str,
    profundidad: int = 0,
    turnos: asyncio.Semaphore | None = None,
) -> list[str]:
    """Nombres de los ficheros que cuelgan de `prefix` dentro de `bucket`.

    EL LISTADO DE STORAGE NO ES RECURSIVO: una carpeta llega como una entrada
    con `id` nulo, y borrar su nombre no borra nada (se borran nombres exactos).
    Los documentos de postulación viven en `<perfil>/<postulación>/<archivo>`:
    sin bajar a las carpetas, el borrado de la cuenta los dejaba en el depósito.

    Las subcarpetas se listan A LA VEZ, con `turnos` como límite.
    """
    turnos = turnos or asyncio.Semaphore(LISTADOS_A_LA_VEZ)
    url = f"{get_settings().supabase_url}/storage/v1/object/list/{bucket}"
    nombres: list[str] = []
    carpetas: list[str] = []
    pagina = 0
    while True:
        # El listado viene paginado; sin recorrerlo entero, una cuenta con mucho
        # contenido dejaria ficheros sin borrar.
        async with turnos:
            respuesta = await client.post(
                url,
                headers=_headers(),
                json={"prefix": prefix, "limit": 100, "offset": pagina * 100},
            )
        respuesta.raise_for_status()
        lote = respuesta.json()
        if not lote:
            break
        for item in lote:
            nombre = item.get("name")
            if not nombre:
                continue
            ruta = f"{prefix}/{nombre}"
            # Carpeta: `id` presente y nulo.
            if "id" in item and item["id"] is None:
                if profundidad >= PROFUNDIDAD_MAXIMA:
                    raise CarpetaDemasiadoHonda(bucket)
                carpetas.append(ruta)
                continue
            nombres.append(ruta)
        if len(lote) < 100:
            break
        pagina += 1
    # Se espera a TODAS aunque una falle: si no, las demás seguirían vivas con
    # el cliente ya cerrado. Después se relanza el primer fallo.
    subcarpetas = await asyncio.gather(
        *(_list_prefix(client, bucket, c, profundidad + 1, turnos) for c in carpetas),
        return_exceptions=True,
    )
    for sub in subcarpetas:
        if isinstance(sub, BaseException):
            raise sub
        nombres.extend(sub)
    return nombres


async def _borrar_nombres(client: httpx.AsyncClient, bucket: str, rutas: list[str]) -> int:
    for desde in range(0, len(rutas), LOTE_DE_BORRADO):
        respuesta = await client.request(
            "DELETE",
            f"{get_settings().supabase_url}/storage/v1/object/{bucket}",
            headers=_headers(),
            json={"prefixes": rutas[desde : desde + LOTE_DE_BORRADO]},
        )
        respuesta.raise_for_status()
    return len(rutas)


async def delete_user_files(user_id: str, *, conversaciones: Sequence[str] = ()) -> int:
    """Borra todo lo que haya subido `user_id`. Devuelve cuantos ficheros quito.

    - En cada depósito de `USER_BUCKETS`, todo lo que cuelga de `<perfil>/`,
      bajando a las carpetas.
    - En `message-media`, lo suyo dentro de cada una de sus conversaciones
      (`<conversacion>/<perfil>/`).

    SOLO LO SUYO. Lo de las demás personas en las conversaciones que se van
    enteras con la cuenta lo retira `borrar_conversaciones`, y DESPUÉS de
    confirmar la baja: si la baja se deshiciera, esas conversaciones
    volverían, y sus adjuntos no pueden haberse perdido por el camino.

    UN ARCHIVO QUE YA NO ESTÁ NO ES UN FALLO: Storage borra nombres exactos y
    los que no encuentra simplemente no los devuelve. Repetir es seguro.

    SI ALGO FALLA, LANZA `BorradoIncompleto`, y el mensaje solo nombra
    depósitos, nunca rutas: llevan el perfil y la postulación. Si falla al
    LISTAR (o hay carpetas más hondas que el tope), no se ha borrado nada. Si
    falla al BORRAR, se intentan los demás depósitos y lo ya borrado no
    vuelve: repetir termina el trabajo.

    SIN CREDENCIALES, en producción LANZA `StorageNoConfigurado`: una cuenta
    no puede darse por borrada con sus archivos dentro. Fuera de producción
    (desarrollo, pruebas) avisa y sigue, porque ahí no hay nada que borrar.
    """
    if not storage_configured():
        if get_settings().is_production:
            raise StorageNoConfigurado(
                "Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY: no se pueden "
                "borrar los archivos de la cuenta."
            )
        logger.warning(
            "No se pueden borrar los archivos de %s: falta "
            "SUPABASE_SERVICE_ROLE_KEY o SUPABASE_URL.",
            user_id,
        )
        return 0

    objetivos = [(bucket, user_id) for bucket in USER_BUCKETS]
    objetivos += [(DEPOSITO_DE_CHAT, f"{c}/{user_id}") for c in conversaciones]

    borrados = 0
    fallidos: list[str] = []
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        # PRIMERO SE LISTA TODO, y a la vez. Si un depósito no contesta, no se
        # borra nada: la cuenta sigue entera, con todos sus archivos.
        turnos = asyncio.Semaphore(LISTADOS_A_LA_VEZ)
        listados = await asyncio.gather(
            *(_list_prefix(client, bucket, prefijo, 0, turnos) for bucket, prefijo in objetivos),
            return_exceptions=True,
        )
        pendientes: list[tuple[str, list[str]]] = []
        for (bucket, _), listado in zip(objetivos, listados):
            if isinstance(listado, (httpx.HTTPError, ValueError)):
                # SIN LA RUTA NI LA EXCEPCIÓN: las dos pueden llevarla.
                logger.warning("No se pudo listar lo de %s en %s", user_id, bucket)
                fallidos.append(bucket)
            elif isinstance(listado, BaseException):
                raise listado
            else:
                pendientes.append((bucket, listado))
        if fallidos:
            raise BorradoIncompleto(
                "No se pudieron listar los archivos en: " + ", ".join(sorted(set(fallidos)))
            )

        # Después se borra, en lotes. Un depósito que falle aquí no impide
        # limpiar los demás; lo ya borrado no vuelve, y repetir termina.
        for bucket, rutas in pendientes:
            try:
                borrados += await _borrar_nombres(client, bucket, rutas)
            except httpx.HTTPError:
                logger.warning("No se pudo borrar lo de %s en %s", user_id, bucket)
                fallidos.append(bucket)

    if fallidos:
        raise BorradoIncompleto(
            "No se pudieron borrar los archivos en: " + ", ".join(sorted(set(fallidos)))
        )
    if borrados:
        logger.info("Borrados %d archivos de Storage de %s", borrados, user_id)
    return borrados


async def borrar_conversaciones(conversaciones: Sequence[str]) -> list[str]:
    """Retira TODO lo de `message-media/<conversacion>/` de conversaciones que
    YA NO EXISTEN (se borraron en cascada con la cuenta que las creó), y
    devuelve las que NO se pudieron retirar.

    Se llama después de confirmar la baja. Sin conversación no hay miembros, y
    la política de lectura de `message-media` exige ser miembro: lo que quede
    aquí no lo puede abrir nadie desde la aplicación.

    CADA CONVERSACIÓN POR SU LADO, y a la vez: una que falle (Storage caído, o
    una carpeta más honda que el tope que otro miembro creó bajo la suya) no
    impide retirar las demás, y solo ella queda en la lista.
    """
    if not conversaciones:
        return []
    _exigir_configurado()
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        turnos = asyncio.Semaphore(LISTADOS_A_LA_VEZ)

        async def una(conversacion: str) -> None:
            rutas = await _list_prefix(client, DEPOSITO_DE_CHAT, str(conversacion), 0, turnos)
            await _borrar_nombres(client, DEPOSITO_DE_CHAT, rutas)

        resultados = await asyncio.gather(
            *(una(c) for c in conversaciones), return_exceptions=True
        )
    return [str(c) for c, r in zip(conversaciones, resultados) if isinstance(r, BaseException)]


async def borrar_carpeta(bucket: str, prefijo: str) -> int:
    """Borra todo lo que cuelga de `bucket/prefijo`, bajando a las carpetas.

    Para lo que se subió y se quedó sin dueño: el procesado de un vídeo que
    terminó después de que se borrara la cuenta o la publicación.
    """
    _exigir_configurado()
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        rutas = await _list_prefix(client, bucket, prefijo)
        return await _borrar_nombres(client, bucket, rutas)


# --------------------------------------------------------------------------- #
# Subir, firmar y borrar un objeto concreto
#
# POR QUE ESTA AQUI Y NO EN `modules/products`. Porque hablar con Storage es lo
# mismo para todo el mundo —la misma URL, la misma clave de servicio, los mismos
# errores— y tener dos copias de estas cuatro funciones garantiza que un dia una
# de ellas deje de comprobar algo que la otra si comprueba.
#
# LA CLAVE `service_role` NO SALE DE AQUI. Ninguna de estas funciones devuelve
# ni registra la clave; lo que sale es una URL firmada de vida corta.
# --------------------------------------------------------------------------- #
class StorageNoConfigurado(RuntimeError):
    """No hay credenciales para operar sobre Storage."""


class StorageFallo(RuntimeError):
    """Storage contesto algo que no es un exito."""


class BorradoIncompleto(StorageFallo):
    """Al borrar una cuenta, algún depósito no se dejó listar o borrar."""


def _exigir_configurado() -> None:
    if not storage_configured():
        raise StorageNoConfigurado(
            "Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY."
        )


async def subir_objeto(
    bucket: str, ruta: str, datos: bytes, content_type: str, *, sobrescribir: bool = False
) -> None:
    """Sube `datos` a `bucket/ruta`.

    `sobrescribir` va en False por defecto a proposito: el nombre lo genera el
    servidor y es unico, asi que una segunda subida a la misma ruta significa
    que algo se esta pisando y conviene que falle.
    """
    _exigir_configurado()
    url = f"{get_settings().supabase_url}/storage/v1/object/{bucket}/{ruta}"
    cabeceras = {**_headers(), "Content-Type": content_type}
    if sobrescribir:
        cabeceras["x-upsert"] = "true"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        respuesta = await client.post(url, headers=cabeceras, content=datos)
    if respuesta.status_code >= 400:
        raise StorageFallo(f"Storage devolvio {respuesta.status_code} al subir")


async def firmar_objetos(
    bucket: str, rutas: list[str], *, segundos: int = 3600
) -> dict[str, str]:
    """`ruta -> URL firmada`, en UNA sola llamada.

    Firmar de una en una serian nueve viajes para pintar una portada. Lo que no
    se pueda firmar simplemente no aparece en el diccionario: quien llama decide
    que hacer con una imagen que no esta, y la alternativa —inventar una URL—
    pinta una foto rota.
    """
    if not rutas:
        return {}
    _exigir_configurado()
    base = get_settings().supabase_url
    unicas = list(dict.fromkeys(rutas))
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        respuesta = await client.post(
            f"{base}/storage/v1/object/sign/{bucket}",
            headers=_headers(),
            json={"expiresIn": segundos, "paths": unicas},
        )
    if respuesta.status_code >= 400:
        raise StorageFallo(f"Storage devolvio {respuesta.status_code} al firmar")
    firmadas: dict[str, str] = {}
    for item in respuesta.json():
        ruta = item.get("path")
        firma = item.get("signedURL") or item.get("signedUrl")
        if ruta and firma:
            firmadas[ruta] = f"{base}/storage/v1{firma}"
    return firmadas


async def borrar_objeto(bucket: str, ruta: str) -> bool:
    """Borra `bucket/ruta`. Devuelve si Storage dijo que si."""
    _exigir_configurado()
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        respuesta = await client.request(
            "DELETE",
            f"{get_settings().supabase_url}/storage/v1/object/{bucket}",
            headers=_headers(),
            json={"prefixes": [ruta]},
        )
    if respuesta.status_code >= 400:
        # SIN LA RUTA: lleva el perfil y la postulación, y un documento de
        # identidad no tiene por qué quedar señalado en un registro.
        logger.warning(
            "No se pudo borrar un objeto de %s: Storage devolvio %s",
            bucket,
            respuesta.status_code,
        )
        return False
    return True
