"""Remux intercalado + faststart de los MP4 que sube Android.

El compresor de Android escribe TODO el video y despues TODO el audio (medido:
primer audio en el byte 17,6 MB de un MP4 de 18,8 MB). ExoPlayer necesitaba
bajarse casi el archivo entero para arrancar. Aqui se prueba:

1. las DECISIONES (que se considera sin intercalar, como se llama el derivado,
   que las calidades no lo tomen por un 720p, que la limpieza lo reconozca);
2. con ffmpeg de verdad (si esta, como en CI): que un MP4 fabricado sin
   intercalar se detecta, se remuxa sin recodificar y sale bien;
3. el procesado de un video nuevo: el original no se toca y `feed_path`
   apunta al derivado.
"""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.core.config import get_settings
from app.modules.content import media_processing as mp
from app.modules.content import remux
from app.modules.medios import calidades, limpieza

HAY_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
con_ffmpeg = pytest.mark.skipif(not HAY_FFMPEG, reason="hace falta ffmpeg/ffprobe")


# --------------------------------------------------------------------------- #
# 1. Decisiones
# --------------------------------------------------------------------------- #
def _diag(**kw) -> remux.Diagnostico:
    base = dict(tamano=19_000_000, duracion=60.0, pos_video=52_200, pos_audio=52_458, moov_delante=True)
    base.update(kw)
    return remux.Diagnostico(**base)


def test_un_mp4_intercalado_y_con_indice_delante_no_se_toca():
    d = _diag()
    assert d.intercalado and not d.necesita_remux
    assert d.motivo == "bien"


def test_el_de_android_con_el_audio_al_final_se_remuxa():
    # El caso medido: 18,8 MB con el primer audio en el byte 17,6 MB.
    d = _diag(tamano=18_800_000, pos_video=40, pos_audio=17_600_000)
    assert not d.intercalado
    assert d.necesita_remux
    assert d.desfase_s > 50
    assert "sin intercalar" in d.motivo


def test_indice_al_final_tambien_se_remuxa_aunque_este_intercalado():
    d = _diag(moov_delante=False)
    assert d.intercalado and d.necesita_remux
    assert d.motivo == "indice al final"


def test_un_trozo_de_un_segundo_entre_pistas_es_intercalado_normal():
    # Un original de camara a 12 Mbps intercala en trozos de ~1 s: 1,5 MB de
    # desfase entre el primer video y el primer audio no es un problema.
    d = _diag(tamano=90_000_000, duracion=60.0, pos_video=40, pos_audio=1_500_000)
    assert d.intercalado and not d.necesita_remux


def test_un_clip_minusculo_no_merece_el_trabajo():
    d = _diag(tamano=400_000, duracion=3.0, pos_video=40, pos_audio=390_000)
    assert d.intercalado


def test_un_video_mudo_no_tiene_nada_que_intercalar():
    d = _diag(pos_audio=None)
    assert d.intercalado and not d.necesita_remux
    assert _diag(pos_audio=None, moov_delante=False).necesita_remux


def test_sin_pista_de_video_no_se_remuxa():
    assert not _diag(pos_video=None, moov_delante=False).necesita_remux


def test_el_orden_de_los_bloques():
    assert remux.orden_de_atomos([(b"ftyp", 0), (b"moov", 32), (b"mdat", 9000)]) is True
    assert remux.orden_de_atomos([(b"ftyp", 0), (b"mdat", 32), (b"moov", 9000)]) is False
    assert remux.orden_de_atomos([(b"ftyp", 0)]) is None


def test_el_resultado_se_descarta_si_cambia_de_mas():
    antes = _diag(pos_audio=17_000_000)
    assert remux.resultado_valido(antes, _diag()) is None
    assert "tamano" in remux.resultado_valido(antes, _diag(tamano=10_000_000))
    assert "duracion" in remux.resultado_valido(antes, _diag(duracion=30.0))
    assert "pistas" in remux.resultado_valido(antes, _diag(pos_audio=None))
    assert "sigue mal" in remux.resultado_valido(antes, _diag(moov_delante=False))
    assert remux.resultado_valido(antes, None) is not None


def test_el_comando_copia_sin_recodificar_y_pone_el_indice_delante():
    cmd = remux.comando_remux("ffmpeg", Path("in"), Path("out.mp4"))
    assert cmd[cmd.index("-c") + 1] == "copy"
    assert "+faststart" in cmd
    assert "libx264" not in cmd and "aac" not in cmd


def _media(**kw):
    base = dict(id="m1", storage_path="u-1/video.mp4", feed_path=None, poster_path=None, stream_path=None)
    base.update(kw)
    return SimpleNamespace(**base)


def test_la_ruta_del_derivado_en_supabase_vive_en_derived():
    assert mp.ruta_de_remux(_media(), "supabase", "u-1") == "u-1/derived/m1/feed-remux.mp4"


def test_la_ruta_del_derivado_en_s3_va_versionada():
    assert mp.ruta_de_remux(_media(), "s3", "u-1") == "videos/u-1/m1/feed-remux-v1.mp4"
    previo = _media(feed_path="videos/u-1/m1/feed-remux-v1.mp4")
    assert mp.ruta_de_remux(previo, "s3", "u-1") == "videos/u-1/m1/feed-remux-v2.mp4"


def test_la_app_lo_reconoce_como_mp4_del_feed():
    # Misma expresion que `esMp4DelFeed` en apps/mobile/src/lib/elegirFuenteDeVideo.ts.
    import re

    patron = re.compile(r"(^|/)feed[^/]*\.mp4$", re.I)
    for ruta in ("u-1/derived/m1/feed-remux.mp4", "videos/u-1/m1/feed-remux-v3.mp4"):
        assert patron.search(ruta)
        assert remux.es_remux(ruta)
    assert not remux.es_remux("videos/u-1/m1/feed-720-v1.mp4")
    assert not remux.es_remux("u-1/derived/m1/feed.mp4")
    assert not remux.es_remux(None)


def test_las_calidades_no_toman_el_remux_por_un_720p():
    # Un original 1080p remuxado sigue siendo 1080p: le corresponde el
    # peldaño de 720 y su bitrate real, no el nominal del feed-720.
    con_remux = _media(feed_path="videos/u-1/m1/feed-remux-v1.mp4")
    con_720 = _media(feed_path="videos/u-1/m1/feed-720-v1.mp4")
    assert calidades.con_feed_720(con_remux) is False
    assert calidades.con_feed_720(con_720) is True
    assert calidades.con_feed_720(_media()) is False
    lado = calidades.lado_del_principal(1080, 1920, calidades.con_feed_720(con_remux))
    assert lado == 1080
    assert [p.lado for p in calidades.peldanos_para(lado)] == [480, 560, 720]


def test_la_limpieza_reconoce_las_versiones_viejas_del_remux():
    fila = {
        "carpeta": "videos/u-1/m1",
        "poster_path": None,
        "feed_path": "videos/u-1/m1/feed-remux-v2.mp4",
        "stream_path": None,
    }
    assert limpieza._es_derivado_viejo("feed-remux-v1.mp4", fila) is True
    assert limpieza._es_derivado_viejo("feed-remux-v2.mp4", fila) is False
    # Si despues llego un feed-720, el remux queda viejo.
    fila["feed_path"] = "videos/u-1/m1/feed-720-v1.mp4"
    assert limpieza._es_derivado_viejo("feed-remux-v2.mp4", fila) is True


def test_el_remux_se_puede_apagar_sin_tocar_codigo(monkeypatch):
    assert get_settings().video_remux_enabled is True
    monkeypatch.setenv("VIDEO_REMUX_ENABLED", "false")
    from app.core.config import Settings

    assert Settings().video_remux_enabled is False


# --------------------------------------------------------------------------- #
# 2. Con ffmpeg de verdad
# --------------------------------------------------------------------------- #
def _fabricar(carpeta: Path, segundos: int = 20) -> tuple[Path, Path]:
    """(intercalado, sin_intercalar) del mismo contenido."""
    from tests._mp4_sin_intercalar import desintercalar

    bueno = carpeta / "bueno.mp4"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30",
            "-f", "lavfi", "-i", "sine=frequency=440",
            "-t", str(segundos), "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "2500k",
            "-c:a", "aac", "-shortest", "-movflags", "+faststart", str(bueno),
        ],
        check=True,
    )
    malo = carpeta / "android.mp4"
    malo.write_bytes(desintercalar(bueno.read_bytes(), moov_delante=True))
    return bueno, malo


@con_ffmpeg
@pytest.mark.asyncio
async def test_detecta_el_mp4_de_android_y_lo_deja_intercalado(tmp_path):
    bueno, malo = _fabricar(tmp_path)
    antes_bytes = hashlib.sha256(malo.read_bytes()).hexdigest()

    d_bueno = await remux.diagnosticar(mp._run, "ffprobe", str(bueno), remux.lector_de_archivo(bueno))
    d_malo = await remux.diagnosticar(mp._run, "ffprobe", str(malo), remux.lector_de_archivo(malo))
    assert d_bueno is not None and not d_bueno.necesita_remux
    assert d_malo is not None and d_malo.necesita_remux
    # El audio entero al final: el desfase es casi todo el archivo.
    assert d_malo.desfase_bytes > d_malo.tamano * 0.8

    destino = tmp_path / "salida.mp4"
    despues = await remux.remuxar(mp._run, "ffmpeg", "ffprobe", malo, destino)
    assert despues is not None, "el remux debia servir"
    assert despues.intercalado and despues.moov_delante is True
    assert despues.desfase_bytes < 64 * 1024
    # El original queda byte a byte igual.
    assert hashlib.sha256(malo.read_bytes()).hexdigest() == antes_bytes
    # Sin recodificar: mismos paquetes de video (mismo tamaño total).
    assert abs(destino.stat().st_size - malo.stat().st_size) < malo.stat().st_size * 0.03


@con_ffmpeg
@pytest.mark.asyncio
async def test_un_archivo_que_no_es_video_no_se_remuxa(tmp_path):
    falso = tmp_path / "x.mp4"
    falso.write_bytes(b"esto no es un mp4" * 100)
    assert await remux.remuxar(mp._run, "ffmpeg", "ffprobe", falso, tmp_path / "o.mp4") is None
    assert not (tmp_path / "o.mp4").exists()


# --------------------------------------------------------------------------- #
# 3. El procesado de un video nuevo (Supabase)
# --------------------------------------------------------------------------- #
@con_ffmpeg
@pytest.mark.asyncio
async def test_un_video_de_la_app_sin_intercalar_sale_con_feed_remux(tmp_path, monkeypatch):
    _, malo = _fabricar(tmp_path)
    subidas: dict[str, bytes] = {}

    async def firmar(client, ruta, expires=600):
        return str(malo)  # ffprobe lee la ruta local igual que una URL

    async def descargar(client, url, destino):
        shutil.copyfile(url, destino)

    async def subir(client, ruta, datos, tipo):
        subidas[ruta] = datos

    async def diagnosticar_url(client, url):
        return await remux.diagnosticar(mp._run, "ffprobe", url, remux.lector_de_archivo(Path(url)))

    monkeypatch.setattr(mp, "_signed_url", firmar)
    monkeypatch.setattr(mp, "_descargar_a_disco", descargar)
    monkeypatch.setattr(mp, "_upload", subir)
    monkeypatch.setattr(mp, "diagnosticar_url", diagnosticar_url)

    media = SimpleNamespace(
        id=str(uuid.uuid4()), storage_path="u-1/video.mp4", feed_path=None,
        poster_path="u-1/poster.jpg",  # el poster ya vino del telefono
        stream_path=None, width=360, height=640, duration_s=20.0,
        bytes=malo.stat().st_size,  # ~2.5 Mbps: no se recodifica
    )
    await mp._process_video(None, media)

    esperado = f"u-1/derived/{media.id}/feed-remux.mp4"
    assert media.feed_path == esperado
    assert list(subidas) == [esperado], "solo se sube el derivado; el original no se toca"
    copia = tmp_path / "subido.mp4"
    copia.write_bytes(subidas[esperado])
    d = await remux.diagnosticar(mp._run, "ffprobe", str(copia), remux.lector_de_archivo(copia))
    assert d is not None and not d.necesita_remux


@pytest.mark.asyncio
async def test_si_ya_esta_bien_no_se_baja_nada(monkeypatch):
    bajadas: list = []

    async def firmar(client, ruta, expires=600):
        return "https://x/firmado"

    async def descargar(*a):
        bajadas.append(a)

    async def diagnosticar_url(client, url):
        return _diag()

    monkeypatch.setattr(mp, "_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(mp, "_signed_url", firmar)
    monkeypatch.setattr(mp, "_descargar_a_disco", descargar)
    monkeypatch.setattr(mp, "diagnosticar_url", diagnosticar_url)
    media = SimpleNamespace(
        id="m1", storage_path="u-1/video.mp4", feed_path=None, poster_path="u-1/p.jpg",
        stream_path=None, width=720, height=1280, duration_s=20.0, bytes=6_000_000,
    )
    await mp._process_video(None, media)
    assert bajadas == [] and media.feed_path is None


@pytest.mark.asyncio
async def test_con_el_remux_apagado_ni_se_mide(monkeypatch):
    medidas: list = []

    async def firmar(client, ruta, expires=600):
        return "https://x/firmado"

    async def diagnosticar_url(client, url):
        medidas.append(url)
        return _diag(pos_audio=17_000_000)

    monkeypatch.setattr(get_settings(), "video_remux_enabled", False)
    monkeypatch.setattr(mp, "_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(mp, "_signed_url", firmar)
    monkeypatch.setattr(mp, "diagnosticar_url", diagnosticar_url)
    media = SimpleNamespace(
        id="m1", storage_path="u-1/video.mp4", feed_path=None, poster_path="u-1/p.jpg",
        stream_path=None, width=720, height=1280, duration_s=20.0, bytes=6_000_000,
    )
    await mp._process_video(None, media)
    assert medidas == [] and media.feed_path is None


# --------------------------------------------------------------------------- #
# 4. El relleno de lo ya publicado (`content/rellenar_remux.py`)
# --------------------------------------------------------------------------- #
from tests.test_medios_s3 import ANA, _post_s3, ajustes, entorno, s3  # noqa: E402,F401


async def _video_supabase(sesiones, *, feed_path=None) -> str:
    from app.modules.content.models import Post, PostMedia

    async with sesiones() as db:
        post = Post(author_id=ANA, body="video")
        db.add(post)
        await db.flush()
        medio = PostMedia(
            post_id=post.id, storage_path=f"{ANA}/video.mp4", media_type="video", feed_path=feed_path
        )
        db.add(medio)
        await db.commit()
        return medio.id


@pytest.mark.asyncio
async def test_relleno_en_seco_lista_y_no_escribe_nada(entorno, ajustes, monkeypatch, capsys):
    from app.modules.content import rellenar_remux as relleno
    from app.modules.content.models import PostMedia

    _http, sesiones, s3_ = entorno
    _p, s3_sin_feed = await _post_s3(sesiones, s3_, con_feed=False)
    _p, s3_con_feed = await _post_s3(sesiones, s3_, con_feed=True)
    sb_malo = await _video_supabase(sesiones)
    sb_bueno = await _video_supabase(sesiones)

    async def _url(client, almacen, ruta):
        return f"{almacen}:{ruta}"

    malos = {f"s3:videos/{ANA}/{s3_sin_feed}/original.mp4", f"supabase:{ANA}/video.mp4"}
    vistos: list[str] = []

    async def diagnosticar_url(client, url):
        vistos.append(url)
        if url in malos:
            return _diag(pos_video=40, pos_audio=17_000_000)
        return _diag()

    monkeypatch.setattr(relleno, "_url", _url)
    monkeypatch.setattr(mp, "diagnosticar_url", diagnosticar_url)
    monkeypatch.setattr(mp, "_ffprobe", lambda: "ffprobe")
    remuxados: list[str] = []

    async def remuxar_medio(media_id, sesiones=None):
        remuxados.append(media_id)
        return "remuxado"

    monkeypatch.setattr(relleno, "remuxar_medio", remuxar_medio)

    assert await relleno.principal([], sesiones=sesiones) == 0
    salida = capsys.readouterr().out
    assert remuxados == [], "en seco no se toca nada"
    assert "REMUXAR" in salida and "En seco" in salida
    # El de S3 con feed-720 se mira por su feed (lo que reproduce el movil).
    assert any("feed-720-v1.mp4" in v for v in vistos)
    async with sesiones() as db:
        assert (await db.get(PostMedia, s3_sin_feed)).feed_path is None

    # Con --aplicar, solo los originales sin intercalar que se reproducen.
    assert await relleno.principal(["--aplicar"], sesiones=sesiones) == 0
    assert s3_sin_feed in remuxados
    assert s3_con_feed not in remuxados
    # Los dos de Supabase comparten ruta en la prueba: ambos sin intercalar.
    assert sb_malo in remuxados and sb_bueno in remuxados


@pytest.mark.asyncio
async def test_relleno_es_repetible_lo_que_ya_tiene_feed_se_salta(entorno):
    from app.modules.content import rellenar_remux as relleno

    _http, sesiones, _s3 = entorno
    hecho = await _video_supabase(sesiones, feed_path=f"{ANA}/derived/x/feed-remux.mp4")
    assert await relleno.remuxar_medio(hecho, sesiones=sesiones) == "ya tiene feed"
    assert await relleno.remuxar_medio(str(uuid.uuid4()), sesiones=sesiones) == "sin fila"


def test_relleno_dry_run_y_aplicar_son_excluyentes():
    import asyncio as _asyncio

    from app.modules.content import rellenar_remux as relleno

    with pytest.raises(SystemExit):
        _asyncio.run(relleno.principal(["--dry-run", "--aplicar"]))
