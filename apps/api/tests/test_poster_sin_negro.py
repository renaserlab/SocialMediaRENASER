"""El poster de un video no puede salir negro.

EL FALLO. El poster se sacaba siempre en 0.1 s. Muchos videos de telefono, y
todos los que empiezan con un fundido, tienen ahi un fotograma negro, asi que en
el muro se veia un rectangulo oscuro hasta que llegaba el primer fotograma del
reproductor.

LO QUE SE COMPRUEBA. Primero las decisiones (los comandos y el orden de los
respaldos), sin lanzar nada. Despues, si hay ffmpeg en la maquina, con videos
sinteticos de verdad: uno que arranca en negro, uno todo negro y uno de 0.3 s.
Sin ffmpeg esas pruebas se saltan (la imagen de la API si lo lleva).
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from app.modules.content import media_processing as mp

FFMPEG = shutil.which("ffmpeg")


# --------------------------------------------------------------------------- #
# 1. Los comandos, sin ffmpeg
# --------------------------------------------------------------------------- #
def test_primero_se_busca_un_fotograma_no_negro_en_los_primeros_segundos():
    cmds = mp.comandos_de_poster("ffmpeg", "entrada.mp4", Path("p.jpg"))
    primero = cmds[0]
    # Se limita lo que se LEE (opcion de entrada, antes de -i).
    assert primero.index("-t") < primero.index("-i")
    assert primero[primero.index("-t") + 1] == str(mp.POSTER_VENTANA_S)
    filtro = primero[primero.index("-vf") + 1]
    assert filtro.startswith("blackframe=amount=0")
    assert "function=less" in filtro
    # El escalado va DESPUES de elegir el fotograma: se mide el original.
    assert filtro.index("blackframe") < filtro.index("scale=")
    assert primero[primero.index("-frames:v") + 1] == "1"


def test_los_respaldos_son_1s_luego_0_1s_luego_el_principio():
    cmds = mp.comandos_de_poster("ffmpeg", "entrada.mp4", Path("p.jpg"))
    segundos = [c[c.index("-ss") + 1] for c in cmds[1:]]
    assert segundos == ["1", "0.1", "0"]
    # Los respaldos no filtran negro: son el comportamiento de siempre.
    assert all("blackframe" not in " ".join(c) for c in cmds[1:])


def test_la_ventana_es_corta_para_no_gastar_cpu():
    # La API corre en una t3.small: mas de unos segundos de decodificacion por
    # video quemaria creditos de CPU sin mejorar la portada.
    assert 1 <= mp.POSTER_VENTANA_S <= 5


@pytest.mark.asyncio
async def test_si_el_primer_intento_no_escribe_nada_se_pasa_al_respaldo(monkeypatch, tmp_path):
    lanzados: list[list[str]] = []

    async def _run(cmd, timeout=120):
        lanzados.append(cmd)
        # Solo el respaldo de 1 s «encuentra» fotograma.
        if "-ss" in cmd and cmd[cmd.index("-ss") + 1] == "1":
            Path(cmd[-1]).write_bytes(b"jpeg")
        return 0, b"", b""

    monkeypatch.setattr(mp, "_run", _run)
    destino = tmp_path / "poster.jpg"
    assert await mp._extraer_poster("ffmpeg", "x.mp4", destino)
    assert len(lanzados) == 2, "se para en cuanto hay poster"
    assert destino.read_bytes() == b"jpeg"


@pytest.mark.asyncio
async def test_lo_normal_es_un_solo_ffmpeg(monkeypatch, tmp_path):
    lanzados: list[list[str]] = []

    async def _run(cmd, timeout=120):
        lanzados.append(cmd)
        Path(cmd[-1]).write_bytes(b"jpeg")
        return 0, b"", b""

    monkeypatch.setattr(mp, "_run", _run)
    assert await mp._extraer_poster("ffmpeg", "x.mp4", tmp_path / "poster.jpg")
    assert len(lanzados) == 1


@pytest.mark.asyncio
async def test_un_fallo_de_ffmpeg_no_corta_la_cadena(monkeypatch, tmp_path):
    async def _run(cmd, timeout=120):
        if "blackframe" in " ".join(cmd):
            return 1, b"", b"filtro no disponible"
        Path(cmd[-1]).write_bytes(b"jpeg")
        return 0, b"", b""

    monkeypatch.setattr(mp, "_run", _run)
    assert await mp._extraer_poster("ffmpeg", "x.mp4", tmp_path / "poster.jpg")


@pytest.mark.asyncio
async def test_sin_ningun_fotograma_devuelve_false_y_no_deja_basura(monkeypatch, tmp_path):
    async def _run(cmd, timeout=120):
        Path(cmd[-1]).write_bytes(b"")  # archivo vacio: no vale
        return 0, b"", b""

    monkeypatch.setattr(mp, "_run", _run)
    destino = tmp_path / "poster.jpg"
    assert not await mp._extraer_poster("ffmpeg", "x.mp4", destino)
    assert not destino.exists()


# --------------------------------------------------------------------------- #
# 2. Con ffmpeg de verdad
# --------------------------------------------------------------------------- #
def _crear(destino: Path, *filtro: str) -> None:
    subprocess.run(
        [FFMPEG, "-v", "error", "-y", *filtro, "-c:v", "libx264", "-preset", "ultrafast",
         "-pix_fmt", "yuv420p", str(destino)],
        check=True,
    )


def _luma_media(imagen: Path) -> float:
    """Brillo medio (0-255) del poster, leido con el propio ffmpeg."""
    salida = subprocess.run(
        [FFMPEG, "-v", "error", "-i", str(imagen), "-vf", "scale=8:8,format=gray",
         "-f", "rawvideo", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return sum(salida) / len(salida)


requiere_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg no instalado")


@requiere_ffmpeg
@pytest.mark.asyncio
async def test_un_video_que_arranca_en_negro_no_da_poster_negro(tmp_path):
    video = tmp_path / "fundido.mp4"
    _crear(
        video,
        "-f", "lavfi", "-i", "color=black:s=320x240:d=1.5",
        "-f", "lavfi", "-i", "color=white:s=320x240:d=1.5",
        "-filter_complex", "[0][1]concat=n=2:v=1",
    )
    destino = tmp_path / "poster.jpg"
    assert await mp._extraer_poster(FFMPEG, str(video), destino)
    assert _luma_media(destino) > 200, "el poster tiene que ser el fotograma blanco"


@requiere_ffmpeg
@pytest.mark.asyncio
async def test_un_video_todo_negro_sigue_teniendo_poster(tmp_path):
    video = tmp_path / "negro.mp4"
    _crear(video, "-f", "lavfi", "-i", "color=black:s=320x240:d=4")
    destino = tmp_path / "poster.jpg"
    assert await mp._extraer_poster(FFMPEG, str(video), destino)
    assert destino.stat().st_size > 0


@requiere_ffmpeg
@pytest.mark.asyncio
async def test_un_clip_de_menos_de_un_segundo_no_se_rompe(tmp_path):
    video = tmp_path / "corto.mp4"
    _crear(video, "-f", "lavfi", "-i", "color=black:s=320x240:d=0.3")
    destino = tmp_path / "poster.jpg"
    assert await mp._extraer_poster(FFMPEG, str(video), destino)
    assert destino.stat().st_size > 0
