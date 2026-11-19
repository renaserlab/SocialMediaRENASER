"""Derivados de media en segundo plano: version ligera de imagenes y posters.

El movil descargaba SIEMPRE el archivo original: fotos de hasta 6 MB y videos
de 96-161 MB (subidos antes de la compresion en el dispositivo). Este modulo
genera, DESPUES de responder la peticion de publicar:

- imagenes: una version para el feed (lado mayor 1080 px, WebP) que pesa una
  fraccion del original, y una miniatura para las cuadriculas;
- videos: el poster (un fotograma), un MP4 de 720p y, si se pide, HLS.

DE DONDE VIENE CADA COSA. La app movil ya comprime en el telefono antes de
subir (~2.5 Mbps) y saca el poster alli mismo, asi que sus videos llegan
listos. Desde la WEB no: la libreria de compresion no existe en navegador
(`compressionAvailable` es false), y por ahi entraba el original de 100+ MB sin
poster. Ese era el agujero, y es lo que cubre el procesado de video de aqui.

Principios:
- El original NUNCA se toca: los derivados viven en rutas nuevas dentro de la
  carpeta del propietario y `storage_path` no cambia. Rollback = borrar la
  referencia.
- Todo fallo degrada a "se sirve el original", exactamente lo que pasaba antes.
- Lo que ya llega ligero no se vuelve a codificar (ver `video_bitrate_umbral`):
  gastar CPU en mejorar un video que ya esta bien es gastarla para nada. La
  escalera HLS, que cuesta el triple, va ademas acotada a los videos donde la
  adaptacion llega a notarse (ver `merece_hls`).

EL TRABAJO CORRE EN EL MISMO PROCESO (BackgroundTasks de FastAPI), y por eso
hay dos frenos que no son opcionales:

1. Un SEMAFORO limita cuantos videos se codifican a la vez
   (`video_jobs_concurrentes`, 1 por defecto). Sin el, diez subidas
   simultaneas lanzan diez ffmpeg sobre 2 vCPU y frenan toda la API.
2. La SESION de base de datos no se mantiene abierta durante la codificacion.
   Ver `process_media`.

Si las subidas crecen de verdad, el siguiente paso es mover `process_media` a
una cola en su propia maquina. El codigo ya esta preparado para eso: es una
funcion que recibe un id y no depende de la peticion.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import re
import shutil
import subprocess
import sys
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

#: Espera de las llamadas a Storage. Generosa a proposito: aqui se bajan
#: originales de 100-160 MB y se suben decenas de segmentos HLS. httpx cuenta
#: este tiempo entre trozos, no de principio a fin, asi que un archivo grande
#: pero constante no lo agota; lo que corta es una conexion que se queda muda.
_TIMEOUT = httpx.Timeout(300.0)


def processing_configured() -> bool:
    settings = get_settings()
    return bool(
        settings.media_processing_enabled
        and settings.supabase_url
        and settings.supabase_service_role_key
    )


def procesado_s3_configurado() -> bool:
    """El procesado de los videos en S3 (spec §6): lee y escribe en el bucket
    de medios con el rol de la instancia, sin la service key de Supabase."""
    from app.modules.medios import banderas

    return bool(get_settings().media_processing_enabled and banderas.s3_configurado())


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


def _nice() -> str | None:
    return shutil.which("nice")


#: Cuanto se rebaja la prioridad de ffmpeg en Linux (0 = normal, 19 = minimo).
#: 10 lo deja claramente por detras de la API sin llegar al fondo, donde una
#: maquina ocupada podria dejar la codificacion sin avanzar nunca.
NICE_FFMPEG = 10


def _prioridad_baja(cmd: list[str]) -> tuple[list[str], dict[str, int]]:
    """ffmpeg cede el procesador a las peticiones de la API.

    QUE MITIGA: la LATENCIA mientras se codifica. El planificador atiende antes
    a uvicorn que a ffmpeg, asi que una peticion deja de esperar a que termine
    un fotograma.

    QUE NO MITIGA: los CREDITOS DE CPU. El trabajo es exactamente el mismo, se
    gastan los mismos ciclos y la t3.small quema los mismos creditos. Contra eso
    estan el semaforo, `merece_hls` y la alarma de CPUCreditBalance; esto no.

    Portable porque tiene que serlo: en Windows (desarrollo) es una clase de
    prioridad del proceso y en Linux (produccion) se antepone `nice`. Si `nice`
    no esta, se lanza normal: quedarse sin la rebaja no puede impedir que un
    video se procese.
    """
    if sys.platform == "win32":
        marca = getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)
        return cmd, ({"creationflags": marca} if marca else {})
    nice = _nice()
    if nice is None:
        return cmd, {}
    return [nice, "-n", str(NICE_FFMPEG), *cmd], {}


async def _run(cmd: list[str], timeout: float = 120) -> tuple[int, bytes, bytes]:
    lanzamiento, extra = _prioridad_baja(cmd)
    proceso = await asyncio.create_subprocess_exec(
        *lanzamiento,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        **extra,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proceso.communicate(), timeout)
    except asyncio.TimeoutError:
        proceso.kill()
        raise
    return proceso.returncode or 0, stdout, stderr


def rotacion_del_stream(stream: dict) -> int:
    """Cuantos grados hay que girar el video para verlo derecho.

    Un movil NO gira los pixeles al grabar en vertical: guarda un cuadro
    apaisado de 1920x1080 y anota aparte "esto va girado 90 grados". La nota
    viaja de dos formas segun quien codifique —una matriz de presentacion
    (`side_data_list`) o una etiqueta `rotate`—, asi que hay que mirar las dos.
    """
    for lado in stream.get("side_data_list") or []:
        valor = lado.get("rotation")
        if valor is not None:
            try:
                return int(float(valor)) % 360
            except (TypeError, ValueError):
                pass
    etiqueta = (stream.get("tags") or {}).get("rotate")
    if etiqueta is not None:
        try:
            return int(float(etiqueta)) % 360
        except (TypeError, ValueError):
            pass
    return 0


def dimensiones_visibles(
    ancho: int | None, alto: int | None, rotacion: int
) -> tuple[int | None, int | None]:
    """Las medidas TAL COMO SE VEN, no como estan guardadas en el contenedor.

    EL FALLO QUE CIERRA. Se guardaba en `post_media` el ancho y el alto que
    devuelve ffprobe, que son los del cuadro codificado. Para un video de movil
    grabado en vertical eso es 1920x1080 —apaisado— aunque se vea 1080x1920. La
    aplicacion, que dibuja la caja con esas medidas, pintaba entonces un
    rectangulo apaisado alrededor de un video vertical: las franjas negras.

    Curiosamente el POSTER si salia bien, porque ffmpeg endereza al decodificar
    y la miniatura se genera decodificando. De ahi el sintoma raro: portada
    correcta, video con franjas.
    """
    if not ancho or not alto:
        return ancho, alto
    if rotacion % 180 == 90:
        return alto, ancho
    return ancho, alto


async def _probe_video(url: str) -> tuple[int | None, int | None, float | None]:
    """(ancho, alto, duracion) leyendo solo la cabecera del archivo remoto.

    El ancho y el alto son los VISIBLES: si el contenedor dice que el video va
    girado, las medidas se devuelven ya intercambiadas (ver
    `dimensiones_visibles`).
    """
    ffprobe = _ffprobe()
    if not ffprobe:
        return None, None, None
    codigo, stdout, _ = await _run(
        [
            ffprobe,
            "-v", "error",
            "-select_streams", "v:0",
            # JSON y no CSV: la rotacion vive en una lista anidada
            # (`side_data_list`) que el formato plano no sabe representar.
            "-show_streams",
            "-show_format",
            "-of", "json",
            url,
        ]
    )
    if codigo != 0:
        return None, None, None
    try:
        datos = json.loads(stdout.decode() or "{}")
    except ValueError:
        return None, None, None
    streams = datos.get("streams") or []
    stream = streams[0] if streams else {}
    ancho = stream.get("width")
    alto = stream.get("height")
    ancho, alto = dimensiones_visibles(ancho, alto, rotacion_del_stream(stream))
    duracion = None
    for candidato in ((datos.get("format") or {}).get("duration"), stream.get("duration")):
        if candidato is None:
            continue
        try:
            duracion = float(candidato)
            break
        except (TypeError, ValueError):
            continue
    return ancho, alto, duracion


#: Escalera HLS: (nombre, lado menor en px, bitrate de video en kbps).
#: La misma que scripts/procesar_media.py, para que un video procesado aqui y
#: otro procesado alli se vean igual.
HLS_LADDER = [("360p", 360, 800), ("540p", 540, 1400), ("720p", 720, 2400)]

#: Espera maxima de una codificacion. Un video largo en una t3.small tarda
#: minutos; media hora es holgado y a la vez impide que un archivo corrupto
#: deje un ffmpeg colgado para siempre.
ESPERA_CODIFICACION_S = 1800

#: `veryfast` y no `medium` como en el script offline, a proposito. Con el
#: bitrate fijado, el preset decide cuanta CPU se gasta para acercarse a el.
#: `medium` da algo mas de calidad por bit y cuesta varias veces mas CPU, y
#: aqui la CPU se comparte con las peticiones de la aplicacion. El script,
#: que corre en una maquina dedicada, si puede permitirse `medium`.
PRESET_X264 = "veryfast"

#: Un solo video a la vez, por defecto. Se crea perezosamente porque el limite
#: sale de la configuracion y esta no esta disponible al importar el modulo.
_semaforo_video: asyncio.Semaphore | None = None


def _turno_de_video() -> asyncio.Semaphore:
    """El freno que impide que N subidas a la vez se coman la maquina."""
    global _semaforo_video
    if _semaforo_video is None:
        limite = max(1, get_settings().video_jobs_concurrentes)
        _semaforo_video = asyncio.Semaphore(limite)
    return _semaforo_video


def merece_transcodificar(tamano: int | None, duracion: float | None) -> bool:
    """¿Vale la pena recodificar este video?

    Solo si viene con un bitrate alto. La app movil ya sube a ~2.5 Mbps
    (`VIDEO_OPCIONES` en mediaCompressor.ts), asi que sus videos NO pasan por
    aqui: ya estan bien y recodificarlos seria gastar CPU para empeorar la
    calidad. Lo que si pasa es lo que entra por la web, que llega tal cual sale
    de la camara (10-12 Mbps medidos en el contenido real).

    SIN MEDIDAS NO SE TOCA. Si falta el tamano o la duracion no se puede
    calcular el bitrate, y ante la duda es mejor servir el original que quemar
    CPU en algo que a lo mejor ya estaba bien.
    """
    if not tamano or not duracion or duracion <= 0:
        return False
    bitrate = tamano * 8 / duracion
    return bitrate > get_settings().video_bitrate_umbral


def merece_hls(duracion: float | None, ancho: int | None, alto: int | None) -> bool:
    """¿Vale la pena la escalera HLS de este video?

    Mismo espiritu que `merece_transcodificar`, distinto motivo: alli se mide si
    el archivo viene gordo, aqui si la ADAPTACION va a llegar a notarse. Tres
    codificaciones cuestan el triple de CPU —y de creditos— que una, asi que
    solo se pagan donde compensan: video largo y con resolucion para que los
    peldanos se distingan (`video_hls_duracion_minima_s`,
    `video_hls_lado_menor_minimo`).

    El BITRATE no entra en la cuenta, y no es un olvido: lo que arregla HLS es
    una red mala, y eso no depende de lo gordo que venga el original.

    SIN MEDIDAS NO SE TOCA, igual que con el MP4: ante la duda, el original.
    """
    ajustes = get_settings()
    if not duracion or duracion < ajustes.video_hls_duracion_minima_s:
        return False
    if not ancho or not alto:
        return False
    # El lado MENOR, porque es el que fija `_escala`: un telefono graba en
    # vertical y mirar el ancho daria por bueno cualquier cosa.
    return min(ancho, alto) >= ajustes.video_hls_lado_menor_minimo


def _escala(lado_menor: int) -> str:
    """El lado MENOR al objetivo y el otro en proporcion (siempre par).

    Sirve igual para apaisado (1920x1080 -> x720) que para vertical
    (1080x1920 -> 720x), que es como graba un telefono.
    """
    return f"scale=w='if(gte(iw,ih),-2,{lado_menor})':h='if(gte(iw,ih),{lado_menor},-2)'"


async def _descargar_a_disco(client: httpx.AsyncClient, url: str, destino: Path) -> None:
    """Baja el original a disco por trozos.

    Por trozos y no a memoria porque un original de camara son 100-160 MB y la
    maquina tiene 2 GiB compartidos con la aplicacion: cargarlo entero en RAM
    para transcodificarlo es la clase de cosa que funciona en pruebas y mata el
    proceso el dia que coinciden dos.
    """
    async with client.stream("GET", url) as respuesta:
        respuesta.raise_for_status()
        with destino.open("wb") as salida:
            async for trozo in respuesta.aiter_bytes(1024 * 1024):
                salida.write(trozo)


async def _extraer_poster(ffmpeg: str, entrada: str, destino: Path) -> bool:
    codigo, _, stderr = await _run(
        [
            ffmpeg,
            "-v", "error",
            "-ss", "0.1",
            "-i", entrada,
            "-frames:v", "1",
            "-vf", f"scale='min({FEED_MAX_SIDE},iw)':-2",
            "-q:v", "3",
            str(destino),
        ]
    )
    if codigo != 0 or not destino.exists():
        logger.warning("No se pudo extraer el poster: %s", stderr[-300:])
        return False
    return True


async def _transcodificar_mp4(ffmpeg: str, origen: Path, destino: Path) -> bool:
    codigo, _, stderr = await _run(
        [
            ffmpeg, "-v", "error", "-y", "-i", str(origen),
            "-vf", _escala(720),
            "-c:v", "libx264", "-preset", PRESET_X264, "-profile:v", "main",
            "-b:v", "2400k", "-maxrate", "2600k", "-bufsize", "4800k",
            "-c:a", "aac", "-b:a", "128k",
            # El indice al principio: el reproductor arranca sin ir a buscarlo
            # al final del archivo.
            "-movflags", "+faststart",
            str(destino),
        ],
        timeout=ESPERA_CODIFICACION_S,
    )
    if codigo != 0 or not destino.exists():
        logger.warning("La transcodificacion a MP4 fallo: %s", stderr[-300:])
        return False
    return True


async def _generar_hls(
    ffmpeg: str, origen: Path, carpeta: Path, ancho: int | None, alto: int | None
) -> bool:
    """Escalera HLS en disposicion PLANA: master.m3u8, 360p.m3u8, 360p_000.ts...

    Plana a proposito: el endpoint que sirve las playlists firma
    `<stream_path>/<archivo>`, y con subcarpetas habria que reescribir rutas
    ademas de firmar.
    """
    carpeta.mkdir(parents=True, exist_ok=True)
    variantes: list[tuple[str, int, str]] = []
    for nombre, lado, kbps in HLS_LADDER:
        playlist = carpeta / f"{nombre}.m3u8"
        codigo, _, stderr = await _run(
            [
                ffmpeg, "-v", "error", "-y", "-i", str(origen),
                "-vf", _escala(lado),
                "-c:v", "libx264", "-preset", PRESET_X264, "-profile:v", "main",
                "-b:v", f"{kbps}k", "-maxrate", f"{int(kbps * 1.1)}k",
                "-bufsize", f"{kbps * 2}k",
                "-c:a", "aac", "-b:a", "96k",
                # Un keyframe cada 2 s para poder cortar segmentos exactos.
                "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
                "-hls_time", "4", "-hls_playlist_type", "vod",
                "-hls_segment_filename", str(carpeta / f"{nombre}_%03d.ts"),
                str(playlist),
            ],
            timeout=ESPERA_CODIFICACION_S,
        )
        if codigo != 0 or not playlist.exists():
            logger.warning("HLS %s fallo: %s", nombre, stderr[-300:])
            return False
        if ancho and alto:
            if ancho >= alto:
                res = f"{round(ancho * lado / alto / 2) * 2}x{lado}"
            else:
                res = f"{lado}x{round(alto * lado / ancho / 2) * 2}"
        else:
            res = ""
        variantes.append((nombre, kbps, res))

    lineas = ["#EXTM3U", "#EXT-X-VERSION:3"]
    for nombre, kbps, res in variantes:
        atributos = f"BANDWIDTH={(kbps + 96) * 1000}"
        if res:
            atributos += f",RESOLUTION={res}"
        lineas.append(f"#EXT-X-STREAM-INF:{atributos}")
        lineas.append(f"{nombre}.m3u8")
    (carpeta / "master.m3u8").write_text("\n".join(lineas) + "\n", encoding="ascii")
    return True


def _tipo_hls(nombre: str) -> str:
    if nombre.endswith(".m3u8"):
        return "application/vnd.apple.mpegurl"
    return "video/mp2t"


class MedioDesaparecido(RuntimeError):
    """La fila (o la cuenta) dejó de existir mientras se procesaba."""


_VERSION = re.compile(r"-v(\d+)(?:\.[a-z0-9]+)?$")


def _version(ruta: str | None) -> int:
    """La `n` de `poster-v<n>.jpg`, `feed-720-v<n>.mp4` o `hls-v<n>`; 0 si no
    tiene."""
    if not ruta:
        return 0
    coincide = _VERSION.search(ruta.rstrip("/"))
    return int(coincide.group(1)) if coincide else 0


def rutas_de_derivados(
    media: PostMedia, almacen: str, owner: str
) -> tuple[str, str, str]:
    """(poster, mp4 del feed, carpeta HLS) donde se escribe cada derivado.

    - Supabase: `<dueño>/derived/<medio>/…`, como siempre.
    - S3 (spec §2): `videos/<uid>/<medio>/poster-v<n>.jpg`,
      `feed-720-v<n>.mp4` y `hls-v<n>/`, con `n` = la versión siguiente a la
      que nombra la fila. VERSIONADOS porque CloudFront guarda cada objeto un
      año: un reproceso con el mismo nombre serviría la copia vieja. La versión
      anterior la borra la limpieza diaria a los 7 días.
    """
    if almacen == "s3":
        carpeta = f"videos/{owner}/{media.id}"
        return (
            f"{carpeta}/poster-v{_version(media.poster_path) + 1}.jpg",
            f"{carpeta}/feed-720-v{_version(media.feed_path) + 1}.mp4",
            f"{carpeta}/hls-v{_version(media.stream_path) + 1}",
        )
    base = f"{owner}/derived/{media.id}"
    return f"{base}/poster.jpg", f"{base}/feed.mp4", f"{base}/hls"


async def _process_video(
    client: httpx.AsyncClient,
    media: PostMedia,
    almacen: str = "supabase",
    owner: str | None = None,
    sigue_viva=None,
) -> None:
    """Poster, MP4 de 720p y —si se pide— HLS.

    QUE CAMBIO Y POR QUE. Antes esto solo sacaba el poster, y ni eso cuando
    faltaba ffmpeg en la imagen (que era siempre). El resultado: un video
    subido DESDE LA WEB se quedaba a tamano original y sin poster, porque la
    libreria que comprime en el telefono no existe en navegador.

    El trabajo caro va detras de un semaforo y con UNA sola descarga del
    original para las tres cosas.

    DOS ALMACENES (spec §6). Con S3 solo cambia de donde se lee y donde se
    escribe: el dueño llega de `post.author_id` (en S3 la clave empieza por
    `videos/`, no por el uid) y las URLs prefirmadas para ffmpeg se crean
    JUSTO ANTES de usarse, porque heredan las credenciales temporales del rol.
    """
    from app.modules.medios.almacen import CACHE_INMUTABLE, almacen_para

    alm = almacen_para(almacen, client)
    es_s3 = almacen == "s3"
    ffmpeg = _ffmpeg()
    ajustes = get_settings()

    async def _url() -> str:
        return await alm.url_de_lectura_temporal(
            media.storage_path, ESPERA_CODIFICACION_S + 600
        )

    comprobado_para: set[str] = set()

    async def _subir(ruta: str, datos: bytes, tipo: str) -> None:
        if es_s3:
            # ¿SIGUE EXISTIENDO LA FILA? Codificar tarda minutos, y en ese rato
            # la cuenta pudo darse de baja (que ya vació `videos/<uid>/`) o el
            # video pudo reemplazarse. Subir igual dejaría derivados sin dueño
            # en S3 (corrección M4 del QA). Se mira antes de cada derivado; los
            # segmentos de un mismo HLS comparten la comprobación.
            grupo = ruta_hls if ruta.startswith(f"{ruta_hls}/") else ruta
            if sigue_viva is not None and grupo not in comprobado_para:
                if not await sigue_viva():
                    raise MedioDesaparecido(media.id)
                comprobado_para.add(grupo)
            await alm.subir(ruta, datos, tipo, cache_control=CACHE_INMUTABLE)
        else:
            await _upload(client, ruta, datos, tipo)

    url = await _url()

    if media.width is None or media.duration_s is None:
        ancho, alto, duracion = await _probe_video(url)
        media.width = media.width or ancho
        media.height = media.height or alto
        media.duration_s = media.duration_s or duracion

    if not ffmpeg:
        return

    quiere_mp4 = (
        ajustes.video_transcode_enabled
        and not media.feed_path
        and merece_transcodificar(media.bytes, media.duration_s)
    )
    quiere_hls = (
        ajustes.video_hls_enabled
        and not media.stream_path
        and merece_hls(media.duration_s, media.width, media.height)
    )
    falta_poster = not media.poster_path

    if not falta_poster and not quiere_mp4 and not quiere_hls:
        return

    if owner is None:
        owner = media.storage_path.split("/", 1)[0]
    ruta_poster, ruta_feed, ruta_hls = rutas_de_derivados(media, almacen, owner)

    # CAMINO BARATO: solo falta el poster. Se saca leyendo por rangos unos
    # cientos de KB, sin bajar el archivo entero y sin ocupar el semaforo.
    if not quiere_mp4 and not quiere_hls:
        if es_s3:
            url = await _url()
        with tempfile.TemporaryDirectory() as tmp:
            destino = Path(tmp) / "poster.jpg"
            if not await _extraer_poster(ffmpeg, url, destino):
                return
            await _subir(ruta_poster, destino.read_bytes(), "image/jpeg")
            media.poster_path = ruta_poster
            logger.info("Poster generado para el video %s", media.id)
        return

    # CAMINO CARO: hace falta el archivo entero. De uno en uno.
    async with _turno_de_video():
        with tempfile.TemporaryDirectory() as tmp:
            carpeta = Path(tmp)
            local = carpeta / "original"
            if es_s3:
                # Dentro del semaforo y con boto3: un video en cola no puede
                # quedarse con una URL vencida (spec §6, M1).
                await alm.descargar_a_disco(media.storage_path, local)
            else:
                await _descargar_a_disco(client, url, local)

            if falta_poster:
                destino = carpeta / "poster.jpg"
                if await _extraer_poster(ffmpeg, str(local), destino):
                    await _subir(ruta_poster, destino.read_bytes(), "image/jpeg")
                    media.poster_path = ruta_poster

            if quiere_mp4:
                destino = carpeta / "feed.mp4"
                if await _transcodificar_mp4(ffmpeg, local, destino):
                    # Solo se adopta si de verdad ahorra: un derivado igual o
                    # mayor que el original no compensa la copia.
                    if destino.stat().st_size < local.stat().st_size * 0.9:
                        await _subir(ruta_feed, destino.read_bytes(), "video/mp4")
                        media.feed_path = ruta_feed
                        logger.info(
                            "Video %s: original %.1f MB -> feed %.1f MB",
                            media.id,
                            local.stat().st_size / 1048576,
                            destino.stat().st_size / 1048576,
                        )

            if quiere_hls:
                hls = carpeta / "hls"
                if await _generar_hls(ffmpeg, local, hls, media.width, media.height):
                    for archivo in sorted(hls.iterdir()):
                        await _subir(
                            f"{ruta_hls}/{archivo.name}",
                            archivo.read_bytes(),
                            _tipo_hls(archivo.name),
                        )
                    media.stream_path = ruta_hls
                    logger.info("HLS generado para el video %s", media.id)


# --------------------------------------------------------------------------- #
# Entrada
# --------------------------------------------------------------------------- #
#: Lo unico que este modulo puede escribir. Se listan para poder guardarlas
#: campo a campo en vez de volcar el objeto entero: la fila puede haber
#: cambiado mientras se codificaba, y machacarla seria perder ese cambio.
CAMPOS_DERIVADOS = (
    "width",
    "height",
    "duration_s",
    "bytes",
    "poster_path",
    "feed_path",
    "stream_path",
)


async def _retirar_derivados(
    media: PostMedia, almacen: str = "supabase", owner: str | None = None
) -> None:
    """Borra `<dueño>/derived/<medio>/`, lo haya llegado a anotar o no (una
    subida pudo terminar justo antes de un fallo). Si no hay nada, es un
    listado vacío.

    Mejor esfuerzo: esto corre en segundo plano y no tiene a quién contestar.
    Un fallo se registra sin la ruta.
    """
    from app.shared import storage

    if almacen == "s3":
        # En S3 la fila ya no existe: la baja borro `videos/<uid>/` o una
        # edicion movio el medio a `borrados/`. Lo que quede en su carpeta de
        # `videos/` son derivados recien subidos sin dueño.
        from app.modules.medios.almacen import S3Storage

        try:
            await S3Storage().borrar_prefijo(f"videos/{owner}/{media.id}/")
        except Exception:  # noqa: BLE001
            logger.warning("No se pudieron retirar los derivados huérfanos del medio %s", media.id)
        return

    carpeta = f"{media.storage_path.split('/', 1)[0]}/derived/{media.id}"
    try:
        await storage.borrar_carpeta(BUCKET, carpeta)
    except Exception:  # noqa: BLE001
        logger.warning("No se pudieron retirar los derivados huérfanos del medio %s", media.id)


async def process_media(media_id: str) -> None:
    """Procesa UN medio recien subido. Pensado para BackgroundTasks.

    LA SESION NO SE QUEDA ABIERTA MIENTRAS SE TRABAJA, y eso es lo importante
    aqui. Antes se abria una sesion, se hacia todo dentro y se cerraba al
    final. Con una imagen daba igual —son milisegundos—, pero transcodificar un
    video son MINUTOS, y durante todo ese rato la sesion mantiene su conexion
    ocupada. El pool son 5 conexiones mas 5 de reserva: dos o tres videos a la
    vez y la aplicacion entera se queda sin conexiones esperando a ffmpeg.

    Asi que son tres tramos: una sesion CORTA para leer y marcar «en curso»,
    el trabajo pesado SIN sesion, y otra sesion CORTA para guardar.

    Cualquier fallo marca `failed` y deja el original sirviendose como siempre.
    """
    if not processing_configured() and not procesado_s3_configurado():
        return

    # 1. Leer y marcar. Sesion corta.
    async with SessionLocal() as db:
        media = (
            await db.scalars(select(PostMedia).where(PostMedia.id == media_id))
        ).first()
        if media is None or media.media_type not in ("image", "video"):
            return
        # De que almacen es (migracion 0116) y, para S3, el dueño: se captura
        # AQUI de `post.author_id` (spec §6), no de la ruta.
        from app.modules.medios import publicacion as medios_publicacion
        from app.modules.content.models import Post

        almacen = (
            "s3" if await medios_publicacion.ids_en_s3(db, [media.id]) else "supabase"
        )
        if almacen == "s3" and (media.media_type != "video" or not procesado_s3_configurado()):
            return
        if almacen == "supabase" and not processing_configured():
            return
        owner = (
            await db.scalar(select(Post.author_id).where(Post.id == media.post_id))
            if almacen == "s3"
            else None
        )
        media.processing_status = "processing"
        await db.commit()
        # Se desliga de la sesion para poder seguir usandolo como un objeto
        # normal —los helpers escriben en sus atributos— sin que quede nada
        # atado a una conexion que va a cerrarse.
        db.expunge(media)

    # 2. El trabajo. Aqui no hay ninguna conexion a la base retenida.
    estado = "ready"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            if media.media_type == "image":
                await _process_image(client, media)
            elif almacen == "s3":

                async def _sigue_viva() -> bool:
                    async with SessionLocal() as db:
                        return (
                            await db.scalar(
                                select(PostMedia.id).where(PostMedia.id == media_id)
                            )
                        ) is not None

                await _process_video(client, media, "s3", owner, _sigue_viva)
            else:
                await _process_video(client, media)
    except MedioDesaparecido:
        # No es un fallo: la fila se fue. El paso 3 retira lo que se subió.
        logger.info("El medio %s desaparecio mientras se procesaba", media_id)
        estado = "failed"
    except Exception:  # noqa: BLE001 — el post ya existe; esto es mejora, no requisito
        logger.exception("Fallo procesando el medio %s", media_id)
        estado = "failed"

    # 3. Guardar lo que se haya conseguido. Sesion corta.
    #
    # Se guarda AUNQUE el estado sea `failed`: si se generaron el poster y el
    # MP4 y solo fallo el HLS, tirar los dos primeros seria absurdo.
    async with SessionLocal() as db:
        # CON BLOQUEO, y es lo que cierra una carrera con la baja de la cuenta
        # (o el borrado de la publicación): si se está borrando, esto espera a
        # que termine; y si la fila ya no está, lo que acaba de subirse a
        # `derived/` no tiene dueño. El barrido de la baja pudo pasar ANTES de
        # que se subiera, así que se retira aquí.
        fila = (
            await db.scalars(
                select(PostMedia).where(PostMedia.id == media_id).with_for_update()
            )
        ).first()
        if fila is None:
            await _retirar_derivados(media, almacen, owner)
            return
        for campo in CAMPOS_DERIVADOS:
            valor = getattr(media, campo, None)
            if valor is not None:
                setattr(fila, campo, valor)
        fila.processing_status = estado
        await db.commit()
