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
"""

from __future__ import annotations

import logging

import httpx

from app.core.config import get_settings

logger = logging.getLogger(__name__)

#: Buckets donde la aplicacion sube archivos de usuario. Cada subida se guarda
#: bajo `<id de usuario>/<nombre>`, de modo que ese prefijo delimita todo lo que
#: pertenece a una persona (ver `services/storage.ts` en el movil).
#: `seller-documents` (0085) sigue la misma regla: `<perfil>/<postulación>/...`.
USER_BUCKETS = ("post-media", "avatars", "course-media", "seller-documents")

_TIMEOUT = httpx.Timeout(15.0)


def storage_configured() -> bool:
    """True si hay credenciales para operar sobre Storage."""
    settings = get_settings()
    return bool(settings.supabase_url and settings.supabase_service_role_key)


def _headers() -> dict[str, str]:
    key = get_settings().supabase_service_role_key
    return {"Authorization": f"Bearer {key}", "apikey": key}


async def _list_prefix(client: httpx.AsyncClient, bucket: str, prefix: str) -> list[str]:
    """Nombres de los ficheros que cuelgan de `prefix` dentro de `bucket`."""
    url = f"{get_settings().supabase_url}/storage/v1/object/list/{bucket}"
    nombres: list[str] = []
    pagina = 0
    while True:
        # El listado viene paginado; sin recorrerlo entero, una cuenta con mucho
        # contenido dejaria ficheros sin borrar.
        respuesta = await client.post(
            url,
            headers=_headers(),
            json={"prefix": prefix, "limit": 100, "offset": pagina * 100},
        )
        respuesta.raise_for_status()
        lote = respuesta.json()
        if not lote:
            break
        nombres.extend(f"{prefix}/{item['name']}" for item in lote if item.get("name"))
        if len(lote) < 100:
            break
        pagina += 1
    return nombres


async def delete_user_files(user_id: str) -> int:
    """Borra todo lo que haya subido `user_id`. Devuelve cuantos ficheros quito.

    No propaga errores: si Storage falla, el borrado de la cuenta ya ha ocurrido
    en la base de datos y sería peor dejarlo a medias devolviendo un error al
    cliente. Se registra el fallo para poder repasarlo.
    """
    if not storage_configured():
        logger.warning(
            "No se pueden borrar los archivos de %s: falta "
            "SUPABASE_SERVICE_ROLE_KEY o SUPABASE_URL. Quedaran huerfanos en "
            "Storage y habra que limpiarlos a mano.",
            user_id,
        )
        return 0

    borrados = 0
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            for bucket in USER_BUCKETS:
                try:
                    rutas = await _list_prefix(client, bucket, user_id)
                    if not rutas:
                        continue
                    respuesta = await client.request(
                        "DELETE",
                        f"{get_settings().supabase_url}/storage/v1/object/{bucket}",
                        headers=_headers(),
                        json={"prefixes": rutas},
                    )
                    respuesta.raise_for_status()
                    borrados += len(rutas)
                except httpx.HTTPError:
                    # Un bucket que falle no debe impedir limpiar los demas.
                    logger.exception(
                        "Fallo al borrar los archivos de %s en el bucket %s",
                        user_id,
                        bucket,
                    )
    except Exception:  # noqa: BLE001 - nunca debe tumbar el borrado de cuenta
        logger.exception("Fallo inesperado limpiando Storage de %s", user_id)

    if borrados:
        logger.info("Borrados %d archivos de Storage de %s", borrados, user_id)
    return borrados


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
        logger.warning(
            "No se pudo borrar %s/%s: Storage devolvio %s",
            bucket,
            ruta,
            respuesta.status_code,
        )
        return False
    return True
