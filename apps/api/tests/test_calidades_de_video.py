"""Calidades de video elegidas una vez por video (escalera 480/560/720).

Lo que importa probar, por orden:

1. APAGADO NO CAMBIA NADA: con las banderas de fábrica no se codifica nada
   extra, no se consulta la columna nueva y el feed sale igual que antes.
2. Las reglas de la escalera (qué peldaños, nunca hacia arriba, tope de
   duración) y el comando de ffmpeg (una sola pasada, `faststart`, hilos).
3. Encendido: el procesado sube los peldaños a S3 y el feed los entrega
   firmados, de menor a mayor y con el principal (`media_url`) arriba.
4. Sin la migración 0117 nada se rompe.

S3 y CloudFront simulados con `moto`, como en `test_medios_s3.py` (de donde se
reutilizan las fixtures). ffmpeg NO se ejecuta: se simula `_run`.
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import text

from app.core.config import get_settings
from app.modules.content import media_processing as mp
from app.modules.content.models import PostMedia
from app.modules.medios import calidades

# Fixtures y ayudas de la batería de S3: pytest usa las fixtures importadas.
from tests.test_medios_s3 import (  # noqa: F401
    ANA,
    BUCKET,
    NUEVA,
    _como,
    _post_s3,
    _verificar_url,
    ajustes,
    entorno,
    s3,
)


# --------------------------------------------------------------------------- #
# 1. De fábrica, apagado
# --------------------------------------------------------------------------- #
def test_las_banderas_nacen_apagadas():
    from app.core.config import Settings

    fabrica = Settings.model_fields
    assert fabrica["video_calidades_enabled"].default is False
    assert fabrica["video_calidades_lectura"].default is False
    assert fabrica["video_calidades_hilos"].default == 1


@pytest.mark.asyncio
async def test_apagada_no_consulta_la_base():
    # Con la bandera apagada `puede_generar` ni toca la sesión: un None
    # reventaría al primer uso.
    assert get_settings().video_calidades_enabled is False
    assert await calidades.puede_generar(None, "m1") is False  # type: ignore[arg-type]
    assert calidades.merece_calidades(30.0, 720, 1280, False) is False


# --------------------------------------------------------------------------- #
# 2. Reglas puras
# --------------------------------------------------------------------------- #
def test_peldanos_por_debajo_del_principal_y_nunca_hacia_arriba():
    lados = lambda principal: [p.lado for p in calidades.peldanos_para(principal)]  # noqa: E731
    assert lados(720) == [480, 560]  # lo normal: la app sube a 720p
    assert lados(1080) == [480, 560, 720]
    assert lados(540) == [480]
    assert lados(480) == []
    assert lados(None) == []


def test_el_principal_es_el_feed_720_si_existe_y_si_no_el_original():
    assert calidades.lado_del_principal(1080, 1920, True) == 720
    assert calidades.lado_del_principal(720, 1280, False) == 720
    assert calidades.lado_del_principal(1280, 540, False) == 540
    assert calidades.lado_del_principal(None, 1280, False) is None


def test_merece_respeta_tope_de_duracion_y_medidas(monkeypatch):
    monkeypatch.setattr(get_settings(), "video_calidades_enabled", True)
    assert calidades.merece_calidades(30.0, 720, 1280, False) is True
    assert calidades.merece_calidades(None, 720, 1280, False) is False
    assert calidades.merece_calidades(30.0, None, None, False) is False
    assert calidades.merece_calidades(30.0, 480, 854, False) is False  # nada por debajo
    tope = get_settings().video_calidades_duracion_maxima_s
    assert calidades.merece_calidades(tope + 1, 720, 1280, False) is False


def test_una_sola_pasada_con_faststart_y_un_hilo(tmp_path):
    salidas = [(p, tmp_path / f"{p.lado}.mp4") for p in calidades.peldanos_para(720)]
    cmd = calidades.comando("ffmpeg", tmp_path / "original", salidas)
    assert cmd.count("-i") == 1  # se decodifica UNA vez
    filtro = cmd[cmd.index("-filter_complex") + 1]
    assert filtro.startswith("[0:v]split=2")
    assert cmd.count("+faststart") == 2
    assert cmd.count("0:a?") == 2  # un video mudo no falla
    assert cmd[cmd.index("-threads") + 1] == "1"
    assert str(tmp_path / "480.mp4") in cmd and str(tmp_path / "560.mp4") in cmd


def test_armar_variantes_ordena_y_omite_lo_que_no_se_puede_firmar():
    guardadas = [
        {"alto": 560, "clave": "videos/u/m/calidades-v1/560p.mp4", "bitrate": 1_350_000},
        {"alto": 480, "clave": "videos/u/m/calidades-v1/480p.mp4", "bitrate": 970_000},
        {"alto": 480, "clave": "videos/u/m/repetida.mp4"},  # repetida
        {"alto": 900, "clave": "videos/u/m/x.mp4"},  # no está por debajo del principal
        {"alto": 360, "clave": "videos/OTRA/m/x.mp4"},  # otra carpeta
        "basura",
    ]

    def firmar(clave):
        return f"https://cdn/{clave}?f" if clave and clave.startswith("videos/u/m/") else None

    lista = calidades.armar_variantes(
        guardadas, url_principal="https://cdn/principal", lado_principal=720,
        bitrate_principal=2_500_000, firmar=firmar,
    )
    assert [v["alto"] for v in lista] == [480, 560, 720]
    assert lista[-1] == {"alto": 720, "url": "https://cdn/principal", "bitrate": 2_500_000}
    assert lista[0]["url"].endswith("480p.mp4?f")
    # Sin nada usable debajo, no se manda nada (la app hace lo de hoy).
    assert calidades.armar_variantes(
        [], url_principal="u", lado_principal=720, bitrate_principal=None, firmar=firmar
    ) is None
    assert calidades.armar_variantes(
        guardadas, url_principal=None, lado_principal=720, bitrate_principal=None, firmar=firmar
    ) is None


# --------------------------------------------------------------------------- #
# 3. Procesado (sin ffmpeg real)
# --------------------------------------------------------------------------- #
def _ffmpeg_simulado(llamadas: list[list[str]]):
    async def _run(cmd, timeout=120):
        llamadas.append(cmd)
        for i, arg in enumerate(cmd):
            if arg == "+faststart":
                Path(cmd[i + 1]).write_bytes(b"p" * 1000)
        return 0, b"", b""

    return _run


@pytest.mark.asyncio
async def test_sin_la_lista_el_procesado_no_codifica_nada_extra(s3, monkeypatch):
    medio = PostMedia(id="m1", storage_path="videos/ana/m1/original.mp4", media_type="video",
                      width=720, height=1280, duration_s=30.0, bytes=100_000,
                      poster_path="videos/ana/m1/poster-v1.jpg")
    s3.put_object(Bucket=BUCKET, Key=medio.storage_path, Body=b"v" * 100_000)
    monkeypatch.setattr(get_settings(), "video_calidades_enabled", True)
    llamadas: list[list[str]] = []
    monkeypatch.setattr(mp, "_ffmpeg", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(mp, "_run", _ffmpeg_simulado(llamadas))
    async with httpx.AsyncClient() as client:
        await mp._process_video(client, medio, "s3", "ana")  # calidades=None
    assert llamadas == []


@pytest.mark.asyncio
async def test_encendido_sube_los_peldanos_a_s3(s3, monkeypatch):
    medio = PostMedia(id="m2", storage_path="videos/ana/m2/original.mp4", media_type="video",
                      width=720, height=1280, duration_s=30.0, bytes=100_000,
                      poster_path="videos/ana/m2/poster-v1.jpg")
    s3.put_object(Bucket=BUCKET, Key=medio.storage_path, Body=b"v" * 100_000)
    monkeypatch.setattr(get_settings(), "video_calidades_enabled", True)
    llamadas: list[list[str]] = []
    monkeypatch.setattr(mp, "_ffmpeg", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(mp, "_run", _ffmpeg_simulado(llamadas))
    salida: list[dict] = []
    async with httpx.AsyncClient() as client:
        await mp._process_video(client, medio, "s3", "ana", calidades=salida)
    assert len(llamadas) == 1  # una sola pasada
    assert [v["alto"] for v in salida] == [480, 560]
    assert salida[0]["clave"] == "videos/ana/m2/calidades-v1/480p.mp4"
    assert salida[0]["bitrate"] == round(1000 * 8 / 30.0)
    cuerpo = s3.get_object(Bucket=BUCKET, Key=salida[1]["clave"])["Body"].read()
    assert cuerpo == b"p" * 1000
    # Ni el póster ni el principal cambian.
    assert medio.poster_path == "videos/ana/m2/poster-v1.jpg"
    assert medio.feed_path is None


@pytest.mark.asyncio
async def test_un_peldano_que_no_ahorra_no_se_adopta(s3, monkeypatch):
    medio = PostMedia(id="m3", storage_path="videos/ana/m3/original.mp4", media_type="video",
                      width=720, height=1280, duration_s=30.0, bytes=1000,
                      poster_path="videos/ana/m3/poster-v1.jpg")
    s3.put_object(Bucket=BUCKET, Key=medio.storage_path, Body=b"v" * 1000)  # igual de pesado
    monkeypatch.setattr(get_settings(), "video_calidades_enabled", True)
    monkeypatch.setattr(mp, "_ffmpeg", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(mp, "_run", _ffmpeg_simulado([]))
    salida: list[dict] = []
    async with httpx.AsyncClient() as client:
        await mp._process_video(client, medio, "s3", "ana", calidades=salida)
    assert salida == []
    assert "Contents" not in s3.list_objects_v2(Bucket=BUCKET, Prefix="videos/ana/m3/calidades")


@pytest.mark.asyncio
async def test_si_ffmpeg_falla_el_video_queda_como_hoy(s3, monkeypatch):
    medio = PostMedia(id="m4", storage_path="videos/ana/m4/original.mp4", media_type="video",
                      width=720, height=1280, duration_s=30.0, bytes=100_000,
                      poster_path="videos/ana/m4/poster-v1.jpg")
    s3.put_object(Bucket=BUCKET, Key=medio.storage_path, Body=b"v" * 100_000)
    monkeypatch.setattr(get_settings(), "video_calidades_enabled", True)

    async def _falla(cmd, timeout=120):
        return 1, b"", b"error"

    monkeypatch.setattr(mp, "_ffmpeg", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(mp, "_run", _falla)
    salida: list[dict] = []
    async with httpx.AsyncClient() as client:
        await mp._process_video(client, medio, "s3", "ana", calidades=salida)
    assert salida == []


# --------------------------------------------------------------------------- #
# 4. Lo que entrega el feed
# --------------------------------------------------------------------------- #
async def _con_0117(sesiones) -> None:
    async with sesiones() as db:
        await db.execute(text("ALTER TABLE post_media ADD COLUMN variantes JSON"))
        await db.commit()


async def _guardar_peldanos(sesiones, media_id: str) -> None:
    carpeta = f"videos/{ANA}/{media_id}"
    async with sesiones() as db:
        await calidades.guardar(
            db,
            media_id,
            [
                {"alto": 480, "clave": f"{carpeta}/calidades-v1/480p.mp4", "bitrate": 970_000, "bytes": 1},
                {"alto": 560, "clave": f"{carpeta}/calidades-v1/560p.mp4", "bitrate": 1_350_000, "bytes": 1},
            ],
        )
        await db.commit()


@pytest.mark.asyncio
async def test_con_la_lectura_apagada_el_feed_sale_igual(entorno, monkeypatch):
    http, sesiones, s3_ = entorno
    await _con_0117(sesiones)
    post_id, media_id = await _post_s3(sesiones, s3_)
    await _guardar_peldanos(sesiones, media_id)

    async def _no_deberia(*_a, **_k):
        raise AssertionError("con la lectura apagada no se consulta la columna")

    monkeypatch.setattr(calidades, "leer", _no_deberia)
    _como(None)
    medio = (await http.get(f"/api/v1/posts/{post_id}", headers=NUEVA)).json()["media"][0]
    assert medio["variantes"] is None
    assert urlsplit(medio["media_url"]).path.endswith("/feed-720-v1.mp4")


@pytest.mark.asyncio
async def test_encendida_entrega_las_variantes_firmadas(entorno, ajustes, monkeypatch):
    http, sesiones, s3_ = entorno
    monkeypatch.setattr(ajustes, "video_calidades_lectura", True)
    await _con_0117(sesiones)
    post_id, media_id = await _post_s3(sesiones, s3_)
    await _guardar_peldanos(sesiones, media_id)
    _como(None)
    lista = (await http.get("/api/v1/posts", headers=NUEVA)).json()
    medio = next(p for p in lista if p["id"] == post_id)["media"][0]
    variantes = medio["variantes"]
    assert [v["alto"] for v in variantes] == [480, 560, 720]
    assert urlsplit(variantes[0]["url"]).path == f"/videos/{ANA}/{media_id}/calidades-v1/480p.mp4"
    for v in variantes:
        _verificar_url(v["url"])
    # La de arriba ES `media_url` (el feed-720), con su bitrate nominal.
    assert variantes[-1]["url"] == medio["media_url"]
    assert variantes[-1]["bitrate"] == calidades.BITRATE_FEED_720


@pytest.mark.asyncio
async def test_sin_la_0117_y_encendida_no_se_rompe(entorno, ajustes, monkeypatch):
    http, sesiones, s3_ = entorno
    monkeypatch.setattr(ajustes, "video_calidades_lectura", True)
    monkeypatch.setattr(ajustes, "video_calidades_enabled", True)
    post_id, media_id = await _post_s3(sesiones, s3_)
    _como(None)
    respuesta = await http.get(f"/api/v1/posts/{post_id}", headers=NUEVA)
    assert respuesta.status_code == 200
    assert respuesta.json()["media"][0]["variantes"] is None
    async with sesiones() as db:
        assert await calidades.puede_generar(db, media_id) is False


@pytest.mark.asyncio
async def test_puede_generar_solo_una_vez(entorno, ajustes, monkeypatch):
    _http, sesiones, s3_ = entorno
    monkeypatch.setattr(ajustes, "video_calidades_enabled", True)
    await _con_0117(sesiones)
    _post_id, media_id = await _post_s3(sesiones, s3_)
    async with sesiones() as db:
        assert await calidades.puede_generar(db, media_id) is True
    await _guardar_peldanos(sesiones, media_id)
    async with sesiones() as db:
        assert await calidades.puede_generar(db, media_id) is False


def test_un_id_cualquiera_no_choca(tmp_path):
    # Las claves salen de la carpeta del medio, nunca de la entrada del cliente.
    media_id = str(uuid4())
    peldano = calidades.peldanos_para(720)[0]
    assert calidades.clave_de(f"videos/u/{media_id}", peldano) == (
        f"videos/u/{media_id}/calidades-v1/480p.mp4"
    )


# --------------------------------------------------------------------------- #
# 5. Relleno de los videos ya publicados (`medios/rellenar_calidades.py`)
# --------------------------------------------------------------------------- #
async def _con_medidas(sesiones, media_id: str, *, duracion=30.0, estado="ready") -> None:
    async with sesiones() as db:
        medio = await db.get(PostMedia, media_id)
        medio.width, medio.height, medio.duration_s = 720, 1280, duracion
        medio.processing_status = estado
        await db.commit()


@pytest.mark.asyncio
async def test_relleno_apagado_o_sin_0117_no_hace_nada(entorno, ajustes, monkeypatch, capsys):
    from app.modules.medios import rellenar_calidades as relleno

    _http, sesiones, _s3 = entorno
    llamados: list[str] = []

    async def _procesar(media_id):
        llamados.append(media_id)

    assert await relleno.principal(["--aplicar"], sesiones=sesiones, procesar=_procesar) == 1
    monkeypatch.setattr(ajustes, "video_calidades_enabled", True)
    calidades.fijar(None)
    assert await relleno.principal(["--aplicar"], sesiones=sesiones, procesar=_procesar) == 1
    assert llamados == []
    assert "0117" in capsys.readouterr().out


@pytest.mark.asyncio
async def test_relleno_elige_solo_s3_vivos_sin_variantes_y_en_seco_no_procesa(
    entorno, ajustes, monkeypatch
):
    from app.modules.content.models import Post
    from app.modules.medios import rellenar_calidades as relleno
    from tests.test_medios_s3 import _post_supabase

    _http, sesiones, s3_ = entorno
    monkeypatch.setattr(ajustes, "video_calidades_enabled", True)
    await _con_0117(sesiones)
    _p1, bueno = await _post_s3(sesiones, s3_)
    await _con_medidas(sesiones, bueno)
    _p2, hecho = await _post_s3(sesiones, s3_)
    await _con_medidas(sesiones, hecho)
    await _guardar_peldanos(sesiones, hecho)
    _p3, largo = await _post_s3(sesiones, s3_)
    await _con_medidas(sesiones, largo, duracion=600.0)
    p4, borrado = await _post_s3(sesiones, s3_)
    await _con_medidas(sesiones, borrado)
    async with sesiones() as db:
        (await db.get(Post, p4)).status = "deleted"
        await db.commit()
    await _post_supabase(sesiones)

    async with sesiones() as db:
        lista = await relleno.pendientes(db, 50)
    assert [p.media_id for p in lista] == [bueno]

    llamados: list[str] = []

    async def _procesar(media_id):
        llamados.append(media_id)

    assert await relleno.principal([], sesiones=sesiones, procesar=_procesar) == 0
    assert llamados == []


@pytest.mark.asyncio
async def test_relleno_aplicado_procesa_y_devuelve_ready_si_falla(entorno, ajustes, monkeypatch):
    from app.modules.medios import rellenar_calidades as relleno

    _http, sesiones, s3_ = entorno
    monkeypatch.setattr(ajustes, "video_calidades_enabled", True)
    await _con_0117(sesiones)
    _p1, sale_bien = await _post_s3(sesiones, s3_)
    await _con_medidas(sesiones, sale_bien)
    _p2, sale_mal = await _post_s3(sesiones, s3_)
    await _con_medidas(sesiones, sale_mal)

    async def _procesar(media_id):
        if media_id == sale_bien:
            await _guardar_peldanos(sesiones, media_id)
            return
        # Como `process_media` ante un corte de red: marca `failed`.
        async with sesiones() as db:
            (await db.get(PostMedia, media_id)).processing_status = "failed"
            await db.commit()
        raise RuntimeError("sin red")

    assert await relleno.principal(["--aplicar"], sesiones=sesiones, procesar=_procesar) == 1
    async with sesiones() as db:
        assert (await db.get(PostMedia, sale_mal)).processing_status == "ready"
        assert await calidades.puede_generar(db, sale_bien) is False
