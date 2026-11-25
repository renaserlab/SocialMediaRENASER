"""MP4 intercalado y con el indice delante, SIN recodificar (remux).

EL PROBLEMA (medido el 24/11/2026). El compresor de la app en Android
(MediaMuxer) escribe TODO el video primero y TODO el audio al final: en un MP4
de 18,8 MB el primer paquete de audio estaba en el byte 17,6 MB. Para empezar a
reproducir, ExoPlayer necesita audio y video del mismo instante, asi que tiene
que bajarse casi el archivo entero antes de mostrar nada. El movil lo tapaba
con buffers mas grandes (#62/#64), pero la causa es el archivo.

LA SOLUCION. `ffmpeg -c copy -movflags +faststart`: ffmpeg lee las dos pistas
en orden de tiempo y las vuelve a escribir intercaladas, con el indice
(`moov`) al principio. No toca un solo fotograma: la calidad es identica, el
tamano casi el mismo y cuesta poquisimo (19 MB / 60 s: 0,12 s de CPU, 57 MB
de memoria, 0,1 s de reloj en un Ryzen; ver el PR).

`scripts/faststart.py` ya movia el indice, pero NO intercala: con el audio al
final el problema sigue igual. Por eso esto va aparte y usa ffmpeg.

EL ORIGINAL NO SE TOCA (regla del pipeline de media). El resultado es un
derivado nuevo (`feed-remux`) que se anota en `feed_path`: la app ya reproduce
`feed_path` antes que el original. Rollback = borrar la referencia.

Este modulo solo DECIDE y EJECUTA ffmpeg/ffprobe; donde se lee y se escribe lo
pone `media_processing` (y el relleno `rellenar_remux`).
"""

from __future__ import annotations

import json
import logging
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

logger = logging.getLogger(__name__)

#: Nombre del derivado. Empieza por `feed` A PROPOSITO: la app reconoce el MP4
#: del feed con `/(^|\/)feed[^/]*\.mp4$/` (`esMp4DelFeed`) y lo prefiere al
#: HLS en el muro. Y lleva `remux` para que nadie lo confunda con el
#: `feed-720` recodificado: este conserva la resolucion del original (ver
#: `calidades.con_feed_720`).
MARCA_REMUX = "feed-remux"

#: Por debajo de esto el desfase entre audio y video no se nota: con un
#: archivo intercalado normal los primeros paquetes de cada pista estan a unos
#: cientos de bytes (o como mucho un trozo de ~1 s). Se pide que se cumplan las
#: dos cosas: que sea mucho en bytes y mucho en segundos de reproduccion.
DESFASE_MINIMO_BYTES = 512 * 1024
DESFASE_MINIMO_S = 2.0

#: Cuanto puede cambiar el tamano o la duracion al remuxar sin sospechar.
#: Solo se reordena; si cambia mas, algo se perdio por el camino.
TOLERANCIA_TAMANO = 0.03
TOLERANCIA_DURACION_S = 0.5

ESPERA_PROBE_S = 120
ESPERA_REMUX_S = 600

Ejecutor = Callable[..., Awaitable[tuple[int, bytes, bytes]]]
Lector = Callable[[int, int], Awaitable[bytes]]


def es_remux(ruta: str | None) -> bool:
    """¿`ruta` es un derivado remuxado (misma resolucion que el original)?"""
    if not ruta:
        return False
    return ruta.rsplit("/", 1)[-1].startswith(MARCA_REMUX)


# --------------------------------------------------------------------------- #
# Diagnostico
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Diagnostico:
    tamano: int | None
    duracion: float | None
    #: Posicion del primer paquete de cada pista (None = no hay esa pista).
    pos_video: int | None
    pos_audio: int | None
    #: El indice va antes que los datos. None = no se pudo saber.
    moov_delante: bool | None

    @property
    def desfase_bytes(self) -> int | None:
        if self.pos_video is None or self.pos_audio is None:
            return None
        return abs(self.pos_audio - self.pos_video)

    @property
    def desfase_s(self) -> float | None:
        """El desfase expresado en segundos de reproduccion (bytes / bitrate)."""
        if self.desfase_bytes is None or not self.tamano or not self.duracion:
            return None
        return self.desfase_bytes / (self.tamano / self.duracion)

    @property
    def intercalado(self) -> bool:
        if self.desfase_bytes is None:
            # Sin audio (o sin video) no hay nada que intercalar.
            return True
        if self.desfase_bytes <= DESFASE_MINIMO_BYTES:
            return True
        segundos = self.desfase_s
        return segundos is not None and segundos <= DESFASE_MINIMO_S

    @property
    def necesita_remux(self) -> bool:
        if self.pos_video is None:
            return False  # sin pista de video: no es lo que se arregla aqui
        return (not self.intercalado) or self.moov_delante is False

    @property
    def motivo(self) -> str:
        partes = []
        if not self.intercalado:
            partes.append("sin intercalar")
        if self.moov_delante is False:
            partes.append("indice al final")
        return ", ".join(partes) or "bien"


def orden_de_atomos(cabeceras: list[tuple[bytes, int]]) -> bool | None:
    """True si `moov` va antes que `mdat`. `cabeceras` = [(tipo, inicio)]."""
    tipos = [t for t, _ in cabeceras]
    if b"moov" not in tipos or b"mdat" not in tipos:
        return None
    return tipos.index(b"moov") < tipos.index(b"mdat")


async def atomos_de_primer_nivel(leer: Lector, tamano: int) -> list[tuple[bytes, int]]:
    """[(tipo, inicio)] de los bloques de primer nivel, leyendo SOLO sus
    cabeceras (16 bytes cada una): sirve igual para un archivo en disco que
    para uno remoto pedido por rangos."""
    salida: list[tuple[bytes, int]] = []
    i = 0
    while i + 8 <= tamano and len(salida) < 64:
        cab = await leer(i, 16)
        if len(cab) < 8:
            break
        tam, tipo = struct.unpack(">I4s", cab[:8])
        largo_cab = 8
        if tam == 1:
            if len(cab) < 16:
                break
            tam = struct.unpack(">Q", cab[8:16])[0]
            largo_cab = 16
        elif tam == 0:
            tam = tamano - i
        if tam < largo_cab:
            break
        salida.append((tipo, i))
        i += tam
    return salida


def lector_de_archivo(ruta: Path) -> Lector:
    async def _leer(inicio: int, n: int) -> bytes:
        with ruta.open("rb") as f:
            f.seek(inicio)
            return f.read(n)

    return _leer


async def _probe_json(ejecutar: Ejecutor, ffprobe: str, entrada: str, *args: str) -> dict | None:
    codigo, salida, _ = await ejecutar(
        [ffprobe, "-v", "error", *args, "-of", "json", entrada], timeout=ESPERA_PROBE_S
    )
    if codigo != 0:
        return None
    try:
        return json.loads(salida or b"{}")
    except ValueError:
        return None


async def _primer_paquete(
    ejecutar: Ejecutor, ffprobe: str, entrada: str, selector: str
) -> int | None:
    """Posicion en bytes del primer paquete de la pista `selector` (v:0, a:0).

    ffprobe la saca del indice: con `-select_streams` y `%+#1` lee UN paquete
    de esa pista, sin recorrer el archivo (en remoto, un par de rangos).
    """
    datos = await _probe_json(
        ejecutar, ffprobe, entrada,
        "-select_streams", selector,
        "-show_entries", "packet=pos",
        "-read_intervals", "%+#1",
    )
    for paquete in (datos or {}).get("packets") or []:
        try:
            return int(paquete["pos"])
        except (KeyError, TypeError, ValueError):
            continue
    return None


async def diagnosticar(
    ejecutar: Ejecutor,
    ffprobe: str,
    entrada: str,
    leer: Lector | None = None,
) -> Diagnostico | None:
    """Mide un MP4 (ruta local o URL firmada). None si ffprobe no puede leerlo.

    Solo LEE: sobre una URL son unos pocos pedidos por rangos (cabeceras de
    los bloques e indice), no el archivo entero.
    """
    formato = await _probe_json(
        ejecutar, ffprobe, entrada,
        "-show_entries", "format=size,duration:stream=codec_type",
    )
    if not formato or "format" not in formato:
        return None
    try:
        tamano = int(formato["format"].get("size") or 0) or None
    except (TypeError, ValueError):
        tamano = None
    try:
        duracion = float(formato["format"].get("duration") or 0) or None
    except (TypeError, ValueError):
        duracion = None
    tipos = {s.get("codec_type") for s in formato.get("streams") or []}
    pos_video = (
        await _primer_paquete(ejecutar, ffprobe, entrada, "v:0") if "video" in tipos else None
    )
    pos_audio = (
        await _primer_paquete(ejecutar, ffprobe, entrada, "a:0") if "audio" in tipos else None
    )
    moov = None
    if leer is not None and tamano:
        try:
            moov = orden_de_atomos(await atomos_de_primer_nivel(leer, tamano))
        except Exception:  # noqa: BLE001 — sin este dato se decide con el resto
            logger.debug("No se pudo leer el orden de los bloques", exc_info=True)
    return Diagnostico(tamano, duracion, pos_video, pos_audio, moov)


# --------------------------------------------------------------------------- #
# Remux
# --------------------------------------------------------------------------- #
def comando_remux(ffmpeg: str, origen: Path, destino: Path) -> list[str]:
    """`-c copy`: se reordena, no se recodifica.

    Solo la primera pista de video y la primera de audio (si hay): un telefono
    puede meter pistas de datos (metadatos Samsung, `mett`) que el muxer de
    MP4 no acepta copiar, y harian fallar todo por algo que nadie reproduce.
    La rotacion viaja con la pista (matriz de presentacion), asi que el video
    girado sigue viendose derecho.
    """
    return [
        ffmpeg, "-v", "error", "-y", "-i", str(origen),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c", "copy",
        "-map_metadata", "0",
        # Indice al principio. Intercalar no hace falta pedirlo: ffmpeg
        # escribe los paquetes en orden de tiempo.
        "-movflags", "+faststart",
        "-f", "mp4",
        str(destino),
    ]


def resultado_valido(antes: Diagnostico, despues: Diagnostico | None) -> str | None:
    """None si el remux sirve; si no, el motivo para descartarlo."""
    if despues is None:
        return "ffprobe no pudo leer el resultado"
    if despues.necesita_remux:
        return f"sigue mal ({despues.motivo})"
    if (antes.pos_audio is None) != (despues.pos_audio is None):
        return "cambio el numero de pistas"
    if antes.tamano and despues.tamano:
        if abs(despues.tamano - antes.tamano) > antes.tamano * TOLERANCIA_TAMANO:
            return f"el tamano cambio demasiado ({antes.tamano} -> {despues.tamano})"
    if antes.duracion and despues.duracion:
        if abs(despues.duracion - antes.duracion) > max(
            TOLERANCIA_DURACION_S, antes.duracion * 0.02
        ):
            return f"la duracion cambio ({antes.duracion:.2f} -> {despues.duracion:.2f})"
    return None


async def remuxar(
    ejecutar: Ejecutor,
    ffmpeg: str,
    ffprobe: str,
    origen: Path,
    destino: Path,
    antes: Diagnostico | None = None,
) -> Diagnostico | None:
    """Remuxa `origen` en `destino` y lo comprueba. Devuelve el diagnostico
    del resultado si sirve; None (y sin `destino`) si no."""
    if antes is None:
        antes = await diagnosticar(ejecutar, ffprobe, str(origen), lector_de_archivo(origen))
    if antes is None:
        return None
    codigo, _, stderr = await ejecutar(
        comando_remux(ffmpeg, origen, destino), timeout=ESPERA_REMUX_S
    )
    if codigo != 0 or not destino.exists():
        logger.warning("El remux fallo: %s", stderr[-300:])
        destino.unlink(missing_ok=True)
        return None
    despues = await diagnosticar(ejecutar, ffprobe, str(destino), lector_de_archivo(destino))
    problema = resultado_valido(antes, despues)
    if problema:
        logger.warning("Remux descartado: %s", problema)
        destino.unlink(missing_ok=True)
        return None
    return despues
