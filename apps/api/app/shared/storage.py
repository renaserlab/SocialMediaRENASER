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
USER_BUCKETS = ("post-media", "avatars", "course-media")

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
