# -*- coding: utf-8 -*-
"""Reprocesa la media YA subida: posters, imagenes ligeras, MP4 720p y HLS.

Por que existe: los videos publicados antes de la compresion en el dispositivo
pesan 96-161 MB (1080p a 10-12 Mbps) y las fotos hasta 6 MB. El movil los
descargaba tal cual. El backend genera derivados para lo NUEVO al publicarse;
este script cubre lo EXISTENTE, y ademas produce el empaquetado HLS, que es
demasiado pesado para el plan gratuito de Render (0.1 CPU): se corre aqui, en
una maquina normal, donde un video de un minuto tarda segundos y no horas.

Que hace por cada medio:
  imagen  -> version feed (lado mayor 1080, WebP) si el original es pesado.
  video   -> poster (fotograma), MP4 720p ~2.4 Mbps con faststart y, con
             --hls, la escalera 360/540/720 en segmentos de 4 s + master.m3u8.

Garantias:
  - El ORIGINAL nunca se toca: todo va a rutas nuevas bajo
    <dueño>/derived/<media_id>/... y storage_path no cambia.
  - La base de datos solo se actualiza si el derivado se genero y VALIDO
    (duracion del MP4 = la del original, ±1 s).
  - --dry-run enseña que haria, sin subir ni escribir nada.
  - Repetible: lo ya procesado (feed_path/stream_path presentes) se salta.

Uso: la direccion del proyecto se lee de apps/mobile/.env y la SERVICE ROLE KEY
se pide por teclado, oculta y sin guardarse en ningun sitio. NO hace falta
ponerla en ningun archivo ni en la linea de comandos:

  python scripts/procesar_media.py --dry-run          # ensayo, no toca nada
  python scripts/procesar_media.py --images
  python scripts/procesar_media.py --videos --hls
  python scripts/procesar_media.py --media-id <uuid>  # uno concreto

Para automatizarlo (CI), admite tambien SUPABASE_URL y
SUPABASE_SERVICE_ROLE_KEY por entorno.

Requisitos: ffmpeg y ffprobe en el PATH (videos); `pip install pillow`
(imagenes).
"""

from __future__ import annotations

import argparse
import getpass
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

BUCKET = "post-media"

FEED_MAX_SIDE = 1080
FEED_WEBP_QUALITY = 80
FEED_MIN_BYTES = 250 * 1024

#: Umbral a partir del cual un video merece MP4 optimizado: por debajo ya es
#: razonable y una copia mas no aporta.
VIDEO_BITRATE_UMBRAL = 3_500_000  # bits por segundo

#: Escalera HLS: (nombre, lado menor, bitrate de video en kbps).
HLS_LADDER = [("360p", 360, 800), ("540p", 540, 1400), ("720p", 720, 2400)]

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")


def _direccion_del_proyecto() -> str:
    """La URL de Supabase, que NO es secreta (viaja en la app).

    Se lee de `apps/mobile/.env` para no tener que escribirla a mano. Si no
    esta, se pregunta.
    """
    entorno = Path(__file__).resolve().parent.parent / "apps" / "mobile" / ".env"
    if entorno.exists():
        for linea in entorno.read_text(encoding="utf-8").splitlines():
            if linea.startswith("EXPO_PUBLIC_SUPABASE_URL="):
                return linea.split("=", 1)[1].strip().rstrip("/")
    return input("Direccion del proyecto Supabase (https://<ref>.supabase.co): ").strip().rstrip("/")


def _clave_de_servicio() -> str:
    """Pide la service role key SIN que aparezca en pantalla ni en el historial.

    Pegarla en la linea de comandos la deja escrita en el historial de la
    consola (en Windows, `ConsoleHost_history.txt`), donde sobrevive a la
    sesion y a cualquiera que abra ese fichero. Escrita aqui no se guarda en
    ningun sitio: vive solo mientras el script corre.

    La variable de entorno se sigue admitiendo para poder automatizarlo.
    """
    print(
        "\nNecesito la SERVICE ROLE KEY de Supabase.\n"
        "  Panel > Project Settings > API Keys > service_role (la secreta).\n"
        "  No se vera al escribirla y no se guarda en ningun archivo.\n"
    )
    clave = getpass.getpass("service_role key: ").strip()
    if not clave:
        raise SystemExit("Sin clave no se puede continuar.")
    return clave


def _pedir(url: str, *, method: str = "GET", data: bytes | None = None,
           headers: dict | None = None) -> tuple[int, bytes]:
    peticion = urllib.request.Request(url, method=method, data=data, headers={
        "Authorization": f"Bearer {SERVICE_KEY}",
        "apikey": SERVICE_KEY,
        **(headers or {}),
    })
    try:
        with urllib.request.urlopen(peticion, timeout=300) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:  # type: ignore[attr-defined]
        return e.code, e.read()


def rest_lista(filtro: str) -> list[dict]:
    codigo, cuerpo = _pedir(f"{SUPABASE_URL}/rest/v1/post_media?{filtro}")
    if codigo != 200:
        raise SystemExit(f"PostgREST respondio {codigo}: {cuerpo[:300]!r}")
    return json.loads(cuerpo)


def rest_actualiza(media_id: str, cambios: dict, dry_run: bool) -> None:
    if dry_run:
        print(f"    [dry-run] PATCH post_media {media_id}: {cambios}")
        return
    codigo, cuerpo = _pedir(
        f"{SUPABASE_URL}/rest/v1/post_media?id=eq.{media_id}",
        method="PATCH",
        data=json.dumps(cambios).encode(),
        headers={"Content-Type": "application/json", "Prefer": "return=minimal"},
    )
    if codigo not in (200, 204):
        raise RuntimeError(f"PATCH fallo ({codigo}): {cuerpo[:300]!r}")


def storage_descarga(path: str, destino: Path) -> None:
    codigo, cuerpo = _pedir(f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{path}")
    if codigo != 200:
        raise RuntimeError(f"descarga fallo ({codigo}) para {path}")
    destino.write_bytes(cuerpo)


def storage_sube(path: str, datos: bytes, content_type: str, dry_run: bool) -> None:
    if dry_run:
        print(f"    [dry-run] subiria {path} ({len(datos)/1024:.0f} KB)")
        return
    codigo, cuerpo = _pedir(
        f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{path}",
        method="POST",
        data=datos,
        headers={"Content-Type": content_type, "x-upsert": "true"},
    )
    if codigo not in (200, 201):
        raise RuntimeError(f"subida fallo ({codigo}) para {path}: {cuerpo[:200]!r}")


# --------------------------------------------------------------------------- #
# ffmpeg
# --------------------------------------------------------------------------- #
def _ffmpeg_ok() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def probe(archivo: Path) -> dict:
    salida = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,codec_name:format=duration,size,bit_rate",
            "-of", "json", str(archivo),
        ],
        capture_output=True, text=True, check=True,
    )
    datos = json.loads(salida.stdout)
    stream = (datos.get("streams") or [{}])[0]
    formato = datos.get("format") or {}
    return {
        "width": stream.get("width"),
        "height": stream.get("height"),
        "codec": stream.get("codec_name"),
        "duration": float(formato.get("duration") or 0),
        "bytes": int(formato.get("size") or 0),
        "bitrate": int(formato.get("bit_rate") or 0),
    }


def extrae_poster(video: Path, destino: Path) -> bool:
    resultado = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-ss", "0.1", "-i", str(video),
            "-frames:v", "1", "-vf", f"scale='min({FEED_MAX_SIDE},iw)':-2",
            "-q:v", "3", str(destino),
        ],
        capture_output=True,
    )
    return resultado.returncode == 0 and destino.exists()


def _escala(lado_menor: int) -> str:
    # El lado MENOR del video va al objetivo, el otro en proporcion (par).
    # Vale para apaisado (1920x1080 -> x720) y vertical (1080x1920 -> 720x).
    return (
        f"scale=w='if(gte(iw,ih),-2,{lado_menor})':h='if(gte(iw,ih),{lado_menor},-2)'"
    )


def transcodifica_mp4(video: Path, destino: Path) -> bool:
    resultado = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y", "-i", str(video),
            "-vf", _escala(720),
            "-c:v", "libx264", "-preset", "medium", "-profile:v", "main",
            "-b:v", "2400k", "-maxrate", "2600k", "-bufsize", "4800k",
            "-c:a", "aac", "-b:a", "128k",
            # El indice al principio: el reproductor arranca sin ir a buscarlo
            # al final del archivo (mismo objetivo que scripts/faststart.py).
            "-movflags", "+faststart",
            str(destino),
        ],
        capture_output=True,
    )
    return resultado.returncode == 0 and destino.exists()


def genera_hls(video: Path, carpeta: Path) -> bool:
    """Escalera HLS en disposicion PLANA: master.m3u8, 360p.m3u8, 360p_000.ts...

    Plana a proposito: el endpoint del backend firma `<stream_path>/<archivo>`
    y con subcarpetas habria que reescribir rutas ademas de firmar.
    """
    carpeta.mkdir(parents=True, exist_ok=True)
    variantes = []
    for nombre, lado, kbps in HLS_LADDER:
        playlist = carpeta / f"{nombre}.m3u8"
        resultado = subprocess.run(
            [
                "ffmpeg", "-v", "error", "-y", "-i", str(video),
                "-vf", _escala(lado),
                "-c:v", "libx264", "-preset", "medium", "-profile:v", "main",
                "-b:v", f"{kbps}k", "-maxrate", f"{int(kbps*1.1)}k",
                "-bufsize", f"{kbps*2}k",
                "-c:a", "aac", "-b:a", "96k",
                # Un keyframe cada 2 s para poder cortar segmentos exactos.
                "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
                "-hls_time", "4", "-hls_playlist_type", "vod",
                "-hls_segment_filename", str(carpeta / f"{nombre}_%03d.ts"),
                str(playlist),
            ],
            capture_output=True,
        )
        if resultado.returncode != 0 or not playlist.exists():
            print(f"    HLS {nombre} fallo: {resultado.stderr[-300:]!r}")
            return False
        info = probe(video)
        ancho, alto = info["width"] or 0, info["height"] or 0
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


# --------------------------------------------------------------------------- #
# Imagenes
# --------------------------------------------------------------------------- #
def procesa_imagen(fila: dict, dry_run: bool) -> None:
    media_id, ruta = fila["id"], fila["storage_path"]
    print(f"  imagen {media_id} ({ruta})")
    try:
        from PIL import Image, ImageOps
    except ImportError:
        print("    Pillow no instalado (pip install pillow); se salta.")
        return

    with tempfile.TemporaryDirectory() as tmp:
        original = Path(tmp) / "original"
        storage_descarga(ruta, original)
        datos = original.read_bytes()
        with Image.open(io.BytesIO(datos)) as img:
            img = ImageOps.exif_transpose(img)
            ancho, alto = img.size
            cambios: dict = {}
            if not fila.get("width"):
                cambios.update(width=ancho, height=alto)
            if not fila.get("bytes"):
                cambios["bytes"] = len(datos)
            if len(datos) >= FEED_MIN_BYTES and not fila.get("feed_path"):
                lado_mayor = max(ancho, alto)
                if lado_mayor > FEED_MAX_SIDE:
                    escala = FEED_MAX_SIDE / lado_mayor
                    img = img.resize(
                        (round(ancho * escala), round(alto * escala)), Image.LANCZOS
                    )
                if img.mode not in ("RGB", "RGBA"):
                    img = img.convert("RGB")
                salida = io.BytesIO()
                img.save(salida, format="WEBP", quality=FEED_WEBP_QUALITY, method=4)
                derivado = salida.getvalue()
                if len(derivado) < len(datos) * 0.9:
                    dueno = ruta.split("/", 1)[0]
                    feed_path = f"{dueno}/derived/{media_id}/feed.webp"
                    storage_sube(feed_path, derivado, "image/webp", dry_run)
                    cambios["feed_path"] = feed_path
                    print(
                        f"    {len(datos)/1024:.0f} KB -> {len(derivado)/1024:.0f} KB"
                    )
    if cambios:
        rest_actualiza(media_id, cambios, dry_run)


# --------------------------------------------------------------------------- #
# Videos
# --------------------------------------------------------------------------- #
def procesa_video(fila: dict, dry_run: bool, con_hls: bool) -> None:
    media_id, ruta = fila["id"], fila["storage_path"]
    print(f"  video {media_id} ({ruta})")
    if not _ffmpeg_ok():
        print("    ffmpeg/ffprobe no estan en el PATH; se salta.")
        return

    with tempfile.TemporaryDirectory() as tmp:
        original = Path(tmp) / "original.mp4"
        storage_descarga(ruta, original)
        info = probe(original)
        print(
            f"    {info['bytes']/1024/1024:.1f} MB, {info['duration']:.1f}s, "
            f"{info['width']}x{info['height']}, {info['bitrate']/1000:.0f} kbps"
        )
        dueno = ruta.split("/", 1)[0]
        cambios: dict = {}
        for campo, valor in (
            ("width", info["width"]),
            ("height", info["height"]),
            ("duration_s", info["duration"]),
            ("bytes", info["bytes"]),
        ):
            if not fila.get(campo) and valor:
                cambios[campo] = valor

        if not fila.get("poster_path"):
            poster = Path(tmp) / "poster.jpg"
            if extrae_poster(original, poster):
                poster_path = f"{dueno}/derived/{media_id}/poster.jpg"
                storage_sube(poster_path, poster.read_bytes(), "image/jpeg", dry_run)
                cambios["poster_path"] = poster_path

        if not fila.get("feed_path") and info["bitrate"] > VIDEO_BITRATE_UMBRAL:
            optimizado = Path(tmp) / "feed.mp4"
            if transcodifica_mp4(original, optimizado):
                # Validacion antes de referenciar: misma duracion (±1 s).
                salida = probe(optimizado)
                if abs(salida["duration"] - info["duration"]) <= 1:
                    feed_path = f"{dueno}/derived/{media_id}/feed.mp4"
                    storage_sube(
                        feed_path, optimizado.read_bytes(), "video/mp4", dry_run
                    )
                    cambios["feed_path"] = feed_path
                    print(
                        f"    MP4 feed: {info['bytes']/1024/1024:.1f} MB -> "
                        f"{salida['bytes']/1024/1024:.1f} MB"
                    )
                else:
                    print("    MP4 optimizado DESCARTADO: la duracion no cuadra.")
            else:
                print("    fallo la transcodificacion MP4.")

        if con_hls and not fila.get("stream_path"):
            carpeta = Path(tmp) / "hls"
            if genera_hls(original, carpeta):
                stream_path = f"{dueno}/derived/{media_id}/hls"
                for archivo in sorted(carpeta.iterdir()):
                    tipo = (
                        "application/vnd.apple.mpegurl"
                        if archivo.suffix == ".m3u8"
                        else "video/mp2t"
                    )
                    storage_sube(
                        f"{stream_path}/{archivo.name}",
                        archivo.read_bytes(),
                        tipo,
                        dry_run,
                    )
                cambios["stream_path"] = stream_path
                total = sum(f.stat().st_size for f in carpeta.iterdir())
                print(f"    HLS: {len(list(carpeta.iterdir()))} archivos, {total/1024/1024:.1f} MB")

        if cambios:
            cambios["processing_status"] = "ready"
            rest_actualiza(media_id, cambios, dry_run)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="no sube ni escribe nada")
    parser.add_argument("--images", action="store_true", help="solo imagenes")
    parser.add_argument("--videos", action="store_true", help="solo videos")
    parser.add_argument("--hls", action="store_true", help="genera tambien la escalera HLS")
    parser.add_argument("--media-id", help="procesa solo este medio")
    parser.add_argument("--limit", type=int, default=100)
    args = parser.parse_args()

    # Lo que no venga por entorno se resuelve aqui: la direccion se lee del
    # proyecto y la clave se pide por teclado, oculta.
    global SUPABASE_URL, SERVICE_KEY
    if not SUPABASE_URL:
        SUPABASE_URL = _direccion_del_proyecto()
    if not SERVICE_KEY:
        SERVICE_KEY = _clave_de_servicio()

    ambos = not args.images and not args.videos
    seleccion = "id,storage_path,media_type,width,height,duration_s,bytes,poster_path,feed_path,stream_path"

    if args.media_id:
        filas = rest_lista(f"id=eq.{args.media_id}&select={seleccion}")
    else:
        filas = rest_lista(
            f"media_type=in.(image,video)&select={seleccion}&limit={args.limit}"
        )

    print(f"{len(filas)} medios a revisar" + (" [DRY-RUN]" if args.dry_run else ""))
    for fila in filas:
        try:
            if fila["media_type"] == "image" and (ambos or args.images):
                if fila.get("feed_path") and fila.get("width"):
                    continue  # ya procesada
                procesa_imagen(fila, args.dry_run)
            elif fila["media_type"] == "video" and (ambos or args.videos):
                completo = (
                    fila.get("poster_path")
                    and fila.get("feed_path")
                    and (fila.get("stream_path") or not args.hls)
                )
                if completo:
                    continue
                procesa_video(fila, args.dry_run, args.hls)
        except Exception as error:  # noqa: BLE001 — un medio no debe parar el lote
            print(f"    ERROR en {fila['id']}: {error}")
    print("Hecho.")


if __name__ == "__main__":
    sys.exit(main())
