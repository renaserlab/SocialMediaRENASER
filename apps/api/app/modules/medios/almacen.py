"""`AlmacenDeMedios`: el mismo puñado de operaciones contra Supabase o contra S3.

Lo usa el procesado (`content/media_processing.py`), que solo cambia de dónde
lee y dónde escribe (spec §6). Las dos implementaciones tienen las mismas
operaciones: `url_de_lectura_temporal`, `descargar_a_disco`, `descargar`,
`subir` y `borrar_prefijo`.

S3 VA CON EL ROL DE LA INSTANCIA, nunca con claves guardadas: boto3 toma las
credenciales temporales de IMDSv2 (en el contenedor, eso exige el hop limit 2:
decisión pendiente, ver `infra/aws/02-plataforma.yaml`). Las URLs prefirmadas
heredan esas credenciales temporales: viven como mucho lo que viva la sesión
del rol, y por eso las de lectura para ffmpeg se crean justo antes de usarse.

boto3 es SÍNCRONO: todo lo que hace red pasa por `asyncio.to_thread` para no
parar el bucle de la API.
"""

from __future__ import annotations

import asyncio
import logging
import time
from functools import lru_cache
from pathlib import Path
from typing import Protocol

import httpx

from app.core.config import get_settings

logger = logging.getLogger("renaser.medios")

#: Todo derivado y todo original de S3 se sirve desde la caché de CloudFront
#: hasta un año: las claves son inmutables (los derivados van versionados).
CACHE_INMUTABLE = "public, max-age=31536000, immutable"

#: Prefijos del bucket (spec §2).
PREFIJO_VIDEOS = "videos"
PREFIJO_PENDIENTES = "pendientes"
PREFIJO_BORRADOS = "borrados"


class AlmacenDeMedios(Protocol):
    nombre: str

    async def url_de_lectura_temporal(self, clave: str, segundos: int) -> str: ...

    async def descargar_a_disco(self, clave: str, destino: Path) -> None: ...

    async def descargar(self, clave: str) -> bytes: ...

    async def subir(
        self, clave: str, datos: bytes, content_type: str, *, cache_control: str | None = None
    ) -> None: ...

    async def borrar_prefijo(self, prefijo: str) -> int: ...


# --------------------------------------------------------------------------- #
# Supabase (lo de siempre)
# --------------------------------------------------------------------------- #
class SupabaseStorage:
    """El bucket `post-media` de Supabase, por su API con la service key."""

    nombre = "supabase"

    def __init__(self, client: httpx.AsyncClient) -> None:
        self._client = client

    async def url_de_lectura_temporal(self, clave: str, segundos: int) -> str:
        from app.modules.content import media_processing as mp

        return await mp._signed_url(self._client, clave, expires=segundos)

    async def descargar_a_disco(self, clave: str, destino: Path) -> None:
        from app.modules.content import media_processing as mp

        url = await self.url_de_lectura_temporal(clave, 600)
        await mp._descargar_a_disco(self._client, url, destino)

    async def descargar(self, clave: str) -> bytes:
        from app.modules.content import media_processing as mp

        return await mp._download(self._client, clave)

    async def subir(
        self, clave: str, datos: bytes, content_type: str, *, cache_control: str | None = None
    ) -> None:
        from app.modules.content import media_processing as mp

        await mp._upload(self._client, clave, datos, content_type)

    async def borrar_prefijo(self, prefijo: str) -> int:
        from app.modules.content.media_processing import BUCKET
        from app.shared import storage

        return await storage.borrar_carpeta(BUCKET, prefijo)


# --------------------------------------------------------------------------- #
# S3
# --------------------------------------------------------------------------- #
@lru_cache(maxsize=4)
def _cliente_s3(region: str):
    import boto3
    from botocore.config import Config

    return boto3.client(
        "s3",
        region_name=region,
        # Estilo virtual y endpoint regional: las URLs prefirmadas salen como
        # `<bucket>.s3.us-east-1.amazonaws.com`, que es donde apunta el CORS.
        endpoint_url=f"https://s3.{region}.amazonaws.com",
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "virtual"},
            retries={"max_attempts": 4, "mode": "standard"},
        ),
    )


@lru_cache(maxsize=1)
def _cliente_cloudfront():
    import boto3

    return boto3.client("cloudfront")


def cliente_s3():
    return _cliente_s3(get_settings().medios_s3_region or "us-east-1")


def cliente_cloudfront():
    return _cliente_cloudfront()


def bucket() -> str:
    return get_settings().medios_s3_bucket.strip()


def es_no_existe(error: Exception) -> bool:
    """Un 404 o un 403 de S3. El 403 de HeadObject se trata como «no existe»:
    `ListBucket` va acotado por prefijo y, sin él, S3 contesta 403 en vez de
    404 a un objeto que no está (spec §5, L-g)."""
    from botocore.exceptions import ClientError

    if not isinstance(error, ClientError):
        return False
    codigo = str(error.response.get("Error", {}).get("Code", ""))
    estado = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    return codigo in {"404", "403", "NoSuchKey", "NotFound", "AccessDenied"} or estado in {
        403,
        404,
    }


def listar(prefijo: str) -> list[dict]:
    """Todos los objetos bajo `prefijo` (paginado). Síncrono."""
    s3 = cliente_s3()
    objetos: list[dict] = []
    for pagina in s3.get_paginator("list_objects_v2").paginate(
        Bucket=bucket(), Prefix=prefijo
    ):
        objetos.extend(pagina.get("Contents") or [])
    return objetos


def borrar_claves(claves: list[str]) -> int:
    """Borra claves de 1000 en 1000. Lanza si S3 dice que alguna falló."""
    s3 = cliente_s3()
    borradas = 0
    for i in range(0, len(claves), 1000):
        lote = claves[i : i + 1000]
        respuesta = s3.delete_objects(
            Bucket=bucket(),
            Delete={"Objects": [{"Key": c} for c in lote], "Quiet": True},
        )
        errores = respuesta.get("Errors") or []
        if errores:
            raise RuntimeError(f"S3 no borro {len(errores)} objeto(s)")
        borradas += len(lote)
    return borradas


def borrar_prefijo_sync(prefijo: str) -> int:
    claves = [o["Key"] for o in listar(prefijo)]
    return borrar_claves(claves) if claves else 0


def mover_prefijo_sync(origen: str, destino: str) -> int:
    """Copia `origen/…` a `destino/…` y después borra el origen.

    Copiar primero y borrar después: si algo falla a mitad, el archivo queda
    en los dos sitios (se reintenta), nunca en ninguno.
    """
    s3 = cliente_s3()
    origen = origen.rstrip("/") + "/"
    destino = destino.rstrip("/") + "/"
    claves = [o["Key"] for o in listar(origen)]
    for clave in claves:
        s3.copy_object(
            Bucket=bucket(),
            Key=destino + clave[len(origen) :],
            CopySource={"Bucket": bucket(), "Key": clave},
            # COPY conserva Content-Type y Cache-Control del original.
            MetadataDirective="COPY",
        )
    if claves:
        borrar_claves(claves)
    return len(claves)


def invalidar_sync(rutas: list[str]) -> str | None:
    """Invalidación de CloudFront (comodines incluidos). `None` sin
    distribución configurada."""
    distribucion = get_settings().cloudfront_medios_distribucion_id.strip()
    if not distribucion or not rutas:
        return None
    respuesta = cliente_cloudfront().create_invalidation(
        DistributionId=distribucion,
        InvalidationBatch={
            "Paths": {"Quantity": len(rutas), "Items": rutas},
            "CallerReference": f"zeta-{time.time_ns()}",
        },
    )
    return respuesta.get("Invalidation", {}).get("Id")


class S3Storage:
    """El bucket de medios, con el rol de la instancia."""

    nombre = "s3"

    async def url_de_lectura_temporal(self, clave: str, segundos: int) -> str:
        # Firmar no hace red: no hace falta hilo.
        return cliente_s3().generate_presigned_url(
            "get_object", Params={"Bucket": bucket(), "Key": clave}, ExpiresIn=segundos
        )

    async def descargar_a_disco(self, clave: str, destino: Path) -> None:
        # `download_file` baja por trozos y renueva credenciales solo: mejor que
        # una URL prefirmada que podría vencer con las credenciales del rol.
        await asyncio.to_thread(cliente_s3().download_file, bucket(), clave, str(destino))

    async def descargar(self, clave: str) -> bytes:
        def _bajar() -> bytes:
            return cliente_s3().get_object(Bucket=bucket(), Key=clave)["Body"].read()

        return await asyncio.to_thread(_bajar)

    async def subir(
        self, clave: str, datos: bytes, content_type: str, *, cache_control: str | None = None
    ) -> None:
        def _subir() -> None:
            cliente_s3().put_object(
                Bucket=bucket(),
                Key=clave,
                Body=datos,
                ContentType=content_type,
                CacheControl=cache_control or CACHE_INMUTABLE,
            )

        await asyncio.to_thread(_subir)

    async def borrar_prefijo(self, prefijo: str) -> int:
        return await asyncio.to_thread(borrar_prefijo_sync, prefijo)


def almacen_para(nombre: str, client: httpx.AsyncClient) -> AlmacenDeMedios:
    return S3Storage() if nombre == "s3" else SupabaseStorage(client)
