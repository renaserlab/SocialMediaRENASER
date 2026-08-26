"""Derivados de media en segundo plano: version ligera de imagenes y posters.

El movil descargaba SIEMPRE el archivo original: fotos de hasta 6 MB y videos
de 96-161 MB (subidos antes de la compresion en el dispositivo). Este modulo
genera, DESPUES de responder la peticion de publicar:

- imagenes: una version para el feed (lado mayor 1080 px, WebP) que pesa una
  fraccion del original;
- videos: el poster (un fotograma), si el dispositivo no pudo generarlo.

Principios:
- El original NUNCA se toca: los derivados viven en rutas nuevas dentro de la
  carpeta del propietario y `storage_path` no cambia. Rollback = borrar la
  referencia.
- Todo fallo degrada a "se sirve el original", exactamente lo que pasaba antes.
- La transcodificacion de video NO corre aqui por defecto (0.1 CPU en el plan
  free de Render la haria eterna): la cubre scripts/procesar_media.py, que se
  ejecuta donde hay maquina. `VIDEO_TRANSCODE_ENABLED` existe para cuando la
  infraestructura crezca.

El trabajo corre en el mismo proceso (BackgroundTasks de FastAPI). Con el
volumen actual del proyecto es suficiente y no anade infraestructura; si las
subidas crecen, el mismo `process_media` puede moverse a una cola sin cambiar
nada mas.
"""

from __future__ import annotations

import asyncio
import io
import logging
import shutil
import tempfile
from pathlib import Path

import httpx
from sqlalchemy import select

from app.core.config import get_settings
from app.modules.content.models import PostMedia
from app.shared.database import SessionLocal

logger = logging.getLogger(__name__)

BUCKET = "post-media"

#: Lado mayor de la imagen del feed. 1080 es el estandar de las redes moviles:
#: mas no se distingue en un telefono y si se paga en datos.
FEED_MAX_SIDE = 1080
FEED_WEBP_QUALITY = 80

#: Un original ya pequeno no necesita derivado: generar uno solo anadiria una
#: copia mas que mantener sin ahorro que lo justifique.
FEED_MIN_BYTES = 250 * 1024

#: Lado mayor de la MINIATURA de imagen, la que se pinta en las cuadriculas.
#:
#: POR QUE HACIA FALTA. La celda de una cuadricula mide unos 118 puntos, y ahi
#: se estaba bajando la imagen del feed: 1080 px. Con sesenta publicaciones eso
#: son varios megas para pintar sesenta cuadraditos, y en una conexion normal
#: es exactamente el rato que el perfil se queda en negro.
#:
#: 400 y no 320 porque una pantalla de movil moderna pinta a tres veces la
#: densidad: 118 puntos son 354 pixeles reales, y con 320 la miniatura saldria
#: ligeramente borrosa justo en los telefonos buenos.
MINIATURA_MAX_SIDE = 400
#: Calidad mas baja que la del feed a proposito: a ese tamano no se distingue,
#: y es la mitad del peso.
MINIATURA_WEBP_QUALITY = 70

#: Por debajo de esto el original ya es mas pequeno que la miniatura que
#: generariamos: copiarlo seria pagar almacenamiento por nada.
MINIATURA_MIN_BYTES = 60 * 1024

_TIMEOUT = httpx.Timeout(60.0)


def processing_configured() -> bool:
    settings = get_settings()
    return bool(
        settings.media_processing_enabled
        and settings.supabase_url
        and settings.supabase_service_role_key
    )


def _headers() -> dict[str, str]:
    key = get_settings().supabase_service_role_key
    return {"Authorization": f"Bearer {key}", "apikey": key}


async def _download(client: httpx.AsyncClient, path: str) -> bytes:
    url = f"{get_settings().supabase_url}/storage/v1/object/{BUCKET}/{path}"
    respuesta = await client.get(url, headers=_headers())
    respuesta.raise_for_status()
    return respuesta.content


async def _upload(
    client: httpx.AsyncClient, path: str, data: bytes, content_type: str
) -> None:
    url = f"{get_settings().supabase_url}/storage/v1/object/{BUCKET}/{path}"
    respuesta = await client.post(
        url,
        headers={**_headers(), "Content-Type": content_type, "x-upsert": "true"},
        content=data,
    )
    respuesta.raise_for_status()


async def _signed_url(client: httpx.AsyncClient, path: str, expires: int = 600) -> str:
    """URL firmada de corta vida para que ffmpeg lea por HTTP (con rangos)."""
    url = f"{get_settings().supabase_url}/storage/v1/object/sign/{BUCKET}/{path}"
    respuesta = await client.post(
        url, headers=_headers(), json={"expiresIn": expires}
    )
    respuesta.raise_for_status()
    return f"{get_settings().supabase_url}/storage/v1{respuesta.json()['signedURL']}"


# --------------------------------------------------------------------------- #
# Imagenes (Pillow)
# --------------------------------------------------------------------------- #
def _make_feed_image(original: bytes) -> tuple[bytes, int, int, int, int] | None:
    """(derivado_webp, ancho_orig, alto_orig, ancho_deriv, alto_deriv).

    None si Pillow no esta instalado o el formato no se puede leer: entonces
    solo se registran las medidas que se puedan y se sirve el original.
    """
    try:
        from PIL import Image, ImageOps
    except ImportError:
        logger.warning("Pillow no esta instalado: no se generan derivados de imagen.")
        return None

    with Image.open(io.BytesIO(original)) as img:
        # Aplica la rotacion EXIF ANTES de medir: una foto vertical de movil
        # viene como apaisada + marca de giro, y sin esto el derivado (y las
        # medidas guardadas) saldrian tumbados.
        img = ImageOps.exif_transpose(img)
        ancho, alto = img.size
        lado_mayor = max(ancho, alto)
        if lado_mayor > FEED_MAX_SIDE:
            escala = FEED_MAX_SIDE / lado_mayor
            img = img.resize((round(ancho * escala), round(alto * escala)), Image.LANCZOS)
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGB")
        salida = io.BytesIO()
        img.save(salida, format="WEBP", quality=FEED_WEBP_QUALITY, method=4)
        return salida.getvalue(), ancho, alto, img.size[0], img.size[1]


def _make_thumbnail(original: bytes) -> bytes | None:
    """La version de cuadricula. `None` si no se puede leer el formato."""
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return None

    try:
        with Image.open(io.BytesIO(original)) as img:
            img = ImageOps.exif_transpose(img)
            ancho, alto = img.size
            lado_mayor = max(ancho, alto)
            if lado_mayor > MINIATURA_MAX_SIDE:
                escala = MINIATURA_MAX_SIDE / lado_mayor
                img = img.resize(
                    (round(ancho * escala), round(alto * escala)), Image.LANCZOS
                )
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGB")
            salida = io.BytesIO()
            img.save(
                salida, format="WEBP", quality=MINIATURA_WEBP_QUALITY, method=4
            )
            return salida.getvalue()
    except Exception:
        # Una imagen ilegible NO puede tumbar el procesado: sin miniatura la
        # cuadricula cae al derivado del feed, que es lo que hacia antes.
        logger.warning("No se pudo generar la miniatura", exc_info=True)
        return None


async def _process_image(client: httpx.AsyncClient, media: PostMedia) -> None:
    original = await _download(client, media.storage_path)
    media.bytes = media.bytes or len(original)

    # La MINIATURA primero, porque es la que decide si un perfil se ve o se
    # queda en negro. Va en `poster_path`, que ya existia para el fotograma de
    # los videos y significa exactamente lo mismo: «lo que se pinta en una
    # celda». Reutilizarla evita una migracion y hace que la cuadricula trate
    # igual a fotos y videos.
    if not media.poster_path and len(original) >= MINIATURA_MIN_BYTES:
        miniatura = await asyncio.to_thread(_make_thumbnail, original)
        if miniatura is not None and len(miniatura) < len(original) * 0.9:
            thumb_path = f"{media.storage_path.split('/', 1)[0]}/derived/{media.id}/thumb.webp"
            await _upload(client, thumb_path, miniatura, "image/webp")
            media.poster_path = thumb_path
            logger.info(
                "Imagen %s: miniatura %.1f KB (original %.1f KB)",
                media.id,
                len(miniatura) / 1024,
                len(original) / 1024,
            )

    resultado = await asyncio.to_thread(_make_feed_image, original)
    if resultado is None:
        return
    derivado, ancho, alto, _dw, _dh = resultado
    media.width = media.width or ancho
    media.height = media.height or alto

    # Un derivado que no ahorra de verdad no compensa la copia extra.
    if len(original) < FEED_MIN_BYTES or len(derivado) >= len(original) * 0.9:
        return

    owner = media.storage_path.split("/", 1)[0]
    feed_path = f"{owner}/derived/{media.id}/feed.webp"
    await _upload(client, feed_path, derivado, "image/webp")
    media.feed_path = feed_path
    logger.info(
        "Imagen %s: original %.1f KB -> feed %.1f KB",
        media.id,
        len(original) / 1024,
        len(derivado) / 1024,
    )


# --------------------------------------------------------------------------- #
# Videos (ffmpeg, si esta en el sistema)
# --------------------------------------------------------------------------- #
def _ffmpeg() -> str | None:
    return shutil.which("ffmpeg")


def _ffprobe() -> str | None:
    return shutil.which("ffprobe")


async def _run(cmd: list[str], timeout: float = 120) -> tuple[int, bytes, bytes]:
    proceso = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proceso.communicate(), timeout)
    except asyncio.TimeoutError:
        proceso.kill()
        raise
    return proceso.returncode or 0, stdout, stderr


async def _probe_video(url: str) -> tuple[int | None, int | None, float | None]:
    """(ancho, alto, duracion) leyendo solo la cabecera del archivo remoto."""
    ffprobe = _ffprobe()
    if not ffprobe:
        return None, None, None
    codigo, stdout, _ = await _run(
        [
            ffprobe,
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height:format=duration",
            "-of", "csv=p=0",
            url,
        ]
    )
    if codigo != 0:
        return None, None, None
    ancho = alto = None
    duracion = None
    for linea in stdout.decode().strip().splitlines():
        partes = [p for p in linea.strip().split(",") if p]
        if len(partes) == 2 and partes[0].isdigit():
            ancho, alto = int(partes[0]), int(partes[1])
        elif len(partes) == 1:
            try:
                duracion = float(partes[0])
            except ValueError:
                pass
    return ancho, alto, duracion


async def _process_video(client: httpx.AsyncClient, media: PostMedia) -> None:
    """Poster y medidas. La transcodificacion NO corre aqui (ver cabecera)."""
    ffmpeg = _ffmpeg()
    url = await _signed_url(client, media.storage_path)

    if media.width is None or media.duration_s is None:
        ancho, alto, duracion = await _probe_video(url)
        media.width = media.width or ancho
        media.height = media.height or alto
        media.duration_s = media.duration_s or duracion

    if media.poster_path or not ffmpeg:
        return

    # Un solo fotograma: con faststart el indice esta al principio y ffmpeg
    # descarga unos cientos de KB por rangos, no el archivo entero.
    with tempfile.TemporaryDirectory() as tmp:
        destino = Path(tmp) / "poster.jpg"
        codigo, _, stderr = await _run(
            [
                ffmpeg,
                "-v", "error",
                "-ss", "0.1",
                "-i", url,
                "-frames:v", "1",
                "-vf", f"scale='min({FEED_MAX_SIDE},iw)':-2",
                "-q:v", "3",
                str(destino),
            ]
        )
        if codigo != 0 or not destino.exists():
            logger.warning("No se pudo extraer poster de %s: %s", media.id, stderr[-300:])
            return
        owner = media.storage_path.split("/", 1)[0]
        poster_path = f"{owner}/derived/{media.id}/poster.jpg"
        await _upload(client, poster_path, destino.read_bytes(), "image/jpeg")
        media.poster_path = poster_path
        logger.info("Poster generado para el video %s", media.id)


# --------------------------------------------------------------------------- #
# Entrada
# --------------------------------------------------------------------------- #
async def process_media(media_id: str) -> None:
    """Procesa UN medio recien subido. Pensado para BackgroundTasks.

    Sesion propia: la de la peticion ya se cerro cuando esto corre. Cualquier
    fallo marca `failed` y deja el original sirviendose como siempre.
    """
    if not processing_configured():
        return
    async with SessionLocal() as db:
        media = (
            await db.scalars(select(PostMedia).where(PostMedia.id == media_id))
        ).first()
        if media is None or media.media_type not in ("image", "video"):
            return
        media.processing_status = "processing"
        await db.commit()
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                if media.media_type == "image":
                    await _process_image(client, media)
                else:
                    await _process_video(client, media)
            media.processing_status = "ready"
        except Exception:  # noqa: BLE001 — el post ya existe; esto es mejora, no requisito
            logger.exception("Fallo procesando el medio %s", media_id)
            media.processing_status = "failed"
        await db.commit()
