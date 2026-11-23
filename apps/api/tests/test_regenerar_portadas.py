"""Regenerar las portadas ya publicadas sin romper el pipeline.

Lo que se comprueba, sin red ni base:
- QUE SE TOCA: fuera las publicaciones borradas, los datos E2E y lo que se
  esta procesando; `--solo-negras` y el guardarrail de «la nueva tambien es
  negra».
- DONDE VA: siempre una ruta NUEVA (la app cachea la portada por ruta), dentro
  de la carpeta de derivados del medio, versionada; y el respaldo de S3 fuera
  de lo que borra la limpieza diaria.
- EL REGISTRO: reanudar salta lo aplicado y revertir toma lo ultimo de cada
  medio.
- CON FFMPEG: la medida de negro de una portada vieja coincide con la regla
  del poster de la API.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from app.modules.content import media_processing as mp
from app.modules.medios import limpieza

_RUTA = Path(__file__).resolve().parent.parent / "scripts" / "regenerar_portadas.py"
_spec = importlib.util.spec_from_file_location("regenerar_portadas", _RUTA)
rp = importlib.util.module_from_spec(_spec)
# Registrado antes de ejecutarlo: `dataclass` busca su modulo en sys.modules.
sys.modules["regenerar_portadas"] = rp
_spec.loader.exec_module(rp)

UID = "96378e29-0000-4000-8000-000000000001"
MID = "11111111-2222-4333-8444-555555555555"


def _video(**cambios) -> "rp.Video":
    base = dict(
        media_id=MID,
        post_id="aaaaaaaa-0000-4000-8000-000000000001",
        author_id=UID,
        storage_path=f"{UID}/video-123.mp4",
        poster_path=f"{UID}/derived/{MID}/poster.jpg",
        almacen="supabase",
        processing_status="ready",
        estado_post="published",
        texto="Clase de cerámica",
        autor="Luis Pérez",
    )
    base.update(cambios)
    return rp.Video(**base)


# --------------------------------------------------------------------------- #
# Que se toca
# --------------------------------------------------------------------------- #
def test_un_video_normal_es_candidato():
    assert rp.motivo_de_exclusion(_video()) is None


@pytest.mark.parametrize(
    ("cambios", "motivo"),
    [
        ({"estado_post": "deleted"}, "borrado"),
        ({"post_id": "e2e20000-0000-4000-8000-000000000001"}, "e2e"),
        ({"author_id": "e2e0a0a0-0000-4000-8000-000000000001"}, "e2e"),
        ({"media_id": "E2E30000-0000-4000-8000-000000000001"}, "e2e"),
        ({"autor": "Ana Prueba"}, "prueba"),
        ({"texto": "Video de la Prueba  "}, "prueba"),
        ({"processing_status": "processing"}, "procesando"),
        ({"processing_status": "pending"}, "procesando"),
        ({"storage_path": ""}, "sin_original"),
    ],
)
def test_exclusiones(cambios, motivo):
    assert rp.motivo_de_exclusion(_video(**cambios)) == motivo


def test_prueba_solo_al_final():
    # «Pruebas de sonido» o «prueba» en medio del texto no son datos E2E.
    assert rp.motivo_de_exclusion(_video(texto="Prueba de sonido en vivo")) is None
    assert rp.motivo_de_exclusion(_video(autor="Pruebasito Gómez")) is None


def test_ocultas_y_fallidas_si_se_regeneran():
    assert rp.motivo_de_exclusion(_video(estado_post="hidden")) is None
    assert rp.motivo_de_exclusion(_video(processing_status="failed")) is None


@pytest.mark.parametrize(
    ("clase", "solo_negras", "esperado"),
    [
        ("ok", False, True),
        ("ok", True, False),
        ("negra", True, True),
        ("sin_portada", True, True),
        ("ilegible", True, True),
    ],
)
def test_solo_negras(clase, solo_negras, esperado):
    assert rp.merece_regenerar(clase, solo_negras) is esperado


def test_clasificar_vieja():
    assert rp.clasificar_vieja(_video(poster_path=None), None, False) == "sin_portada"
    assert rp.clasificar_vieja(_video(), None, False) == "ilegible"
    assert rp.clasificar_vieja(_video(), 99.0, True) == "negra"
    assert rp.clasificar_vieja(_video(), float(mp.POSTER_MAX_NEGRO), True) == "negra"
    assert rp.clasificar_vieja(_video(), mp.POSTER_MAX_NEGRO - 0.5, True) == "ok"


def test_si_la_nueva_tambien_es_negra_no_se_cambia_una_portada_legible():
    assert not rp.adoptar_nueva("negra", 100.0)
    assert not rp.adoptar_nueva("ok", 95.0)
    assert rp.adoptar_nueva("negra", 12.0)
    # Sin portada, cualquier cosa es mejor que nada.
    assert rp.adoptar_nueva("sin_portada", 100.0)
    assert rp.adoptar_nueva("ilegible", 100.0)


# --------------------------------------------------------------------------- #
# Donde va
# --------------------------------------------------------------------------- #
def test_supabase_poster_del_procesado_va_a_v2_en_derived():
    nueva = rp.ruta_nueva(_video())
    assert nueva == f"{UID}/derived/{MID}/poster-v2.jpg"


def test_supabase_poster_del_telefono_va_a_derived_del_medio():
    v = _video(poster_path=f"{UID}/poster-1700000000-abc123.jpg")
    assert rp.ruta_nueva(v) == f"{UID}/derived/{MID}/poster-v2.jpg"


def test_supabase_sin_portada():
    assert rp.ruta_nueva(_video(poster_path=None)) == f"{UID}/derived/{MID}/poster-v2.jpg"


def test_supabase_una_segunda_regeneracion_sube_la_version():
    v = _video(poster_path=f"{UID}/derived/{MID}/poster-v2.jpg")
    assert rp.ruta_nueva(v) == f"{UID}/derived/{MID}/poster-v3.jpg"


def test_supabase_el_dueno_sale_de_la_ruta_del_original():
    # Igual que el procesado: el primer tramo del original es la carpeta.
    v = _video(storage_path="otro-uid/video.mp4", poster_path=None)
    assert rp.ruta_nueva(v).startswith("otro-uid/derived/")


def test_s3_usa_la_version_siguiente_como_el_procesado():
    carpeta = f"videos/{UID}/{MID}"
    v = _video(almacen="s3", storage_path=f"{carpeta}/original.mp4",
               poster_path=f"{carpeta}/poster-v1.jpg")
    assert rp.ruta_nueva(v) == f"{carpeta}/poster-v2.jpg"
    v.poster_path = f"{carpeta}/poster-v7.jpg"
    assert rp.ruta_nueva(v) == f"{carpeta}/poster-v8.jpg"


def test_s3_sin_portada_empieza_en_v1():
    carpeta = f"videos/{UID}/{MID}"
    v = _video(almacen="s3", storage_path=f"{carpeta}/original.mp4", poster_path=None)
    assert rp.ruta_nueva(v) == f"{carpeta}/poster-v1.jpg"


@pytest.mark.parametrize(
    "poster",
    [None, "poster.jpg", f"{UID}/derived/{MID}/poster.jpg", f"{UID}/derived/{MID}/poster-v4.jpg",
     f"{UID}/poster-x.jpg"],
)
@pytest.mark.parametrize("almacen", ["supabase", "s3"])
def test_la_ruta_nueva_nunca_es_la_actual_ni_el_original(poster, almacen):
    original = f"videos/{UID}/{MID}/original.mp4" if almacen == "s3" else f"{UID}/v.mp4"
    v = _video(almacen=almacen, storage_path=original, poster_path=poster)
    nueva = rp.ruta_nueva(v)
    assert nueva != poster
    assert nueva != original
    assert MID in nueva and nueva.endswith(".jpg")


def test_respaldo_s3_queda_fuera_de_la_limpieza_diaria():
    carpeta = f"videos/{UID}/{MID}"
    v = _video(almacen="s3", storage_path=f"{carpeta}/original.mp4",
               poster_path=f"{carpeta}/poster-v1.jpg")
    respaldo = rp.ruta_respaldo_s3(v)
    assert respaldo == f"{carpeta}/respaldo-portada/poster-v1.jpg"
    fila = {"carpeta": carpeta, "poster_path": f"{carpeta}/poster-v2.jpg",
            "feed_path": None, "stream_path": None}
    relativo = respaldo[len(carpeta) + 1:]
    assert not limpieza._es_derivado_viejo(relativo, fila)
    # Y la vieja, en cambio, si la borraria: por eso hace falta el respaldo.
    assert limpieza._es_derivado_viejo("poster-v1.jpg", fila)


def test_sin_respaldo_en_supabase_ni_fuera_de_la_carpeta():
    assert rp.ruta_respaldo_s3(_video()) is None
    v = _video(almacen="s3", poster_path="videos/otro/otro/poster-v1.jpg")
    assert rp.ruta_respaldo_s3(v) is None


# --------------------------------------------------------------------------- #
# Salidas de ffmpeg y registro
# --------------------------------------------------------------------------- #
def test_pblack_y_bytes_de_la_salida():
    salida = (
        "[Parsed_metadata_1 @ 0x1] frame:0 pts:0\n"
        "[Parsed_metadata_1 @ 0x1] lavfi.blackframe.pblack=97\n"
        "[AVIOContext @ 0x2] Statistics: 1048576 bytes read, 2 seeks\n"
        "[AVIOContext @ 0x3] Statistics: 1000 bytes read, 0 seeks\n"
    )
    assert rp.pblack_de_salida(salida) == 97.0
    assert rp.pblack_de_salida("nada") is None
    assert rp.bytes_leidos(salida) == 1049576


def test_registro_reanuda_y_revierte_lo_ultimo(tmp_path):
    ruta = tmp_path / "r.jsonl"
    reg = rp.Registro(ruta)
    reg.anotar(media_id="a", estado="subida", ref_vieja="x", ref_nueva="y")
    reg.anotar(media_id="a", estado="aplicado", ref_vieja="x", ref_nueva="y")
    reg.anotar(media_id="b", estado="subida", ref_vieja="p", ref_nueva="q")  # corte
    reg.anotar(media_id="c", estado="aplicado", ref_vieja="m", ref_nueva="n")
    reg.anotar(media_id="c", estado="revertido", ref_vieja="m", ref_nueva="n")
    with ruta.open("a") as f:
        f.write('{"media_id": "d", "esta')  # linea cortada
    lineas = rp.leer_registro(ruta)
    assert rp.ya_aplicados(lineas) == {"a"}
    assert [l["media_id"] for l in rp.para_revertir(lineas)] == ["a"]
    assert all("ts" in l for l in lineas)


def test_estimar():
    muestras = [{"segundos": 1.0, "bytes_leidos": 2_000_000, "bytes_poster": 100_000},
                {"segundos": 3.0, "bytes_leidos": 4_000_000, "bytes_poster": 100_000}]
    est = rp.estimar(10, muestras, 2, 5_000)
    assert est["segundos"] == 15  # 10 * (2 + 1) / 2
    assert est["bytes"] == 10 * 3_100_000 + 5_000
    assert rp.estimar(0, muestras, 2, 0)["segundos"] is None


def test_por_defecto_es_simulacro():
    args = rp.construir_parser().parse_args([])
    assert not args.aplicar and not args.revertir
    with pytest.raises(SystemExit):
        rp.construir_parser().parse_args(["--simulacro", "--aplicar"])


# --------------------------------------------------------------------------- #
# Con ffmpeg de verdad
# --------------------------------------------------------------------------- #
FFMPEG = shutil.which("ffmpeg")
requiere_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg no instalado")


def _imagen(destino: Path, filtro: str) -> bytes:
    subprocess.run(
        [FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", filtro, "-frames:v", "1", str(destino)],
        check=True,
    )
    return destino.read_bytes()


@requiere_ffmpeg
@pytest.mark.asyncio
async def test_medir_pblack_distingue_negra_de_normal(tmp_path):
    negra = _imagen(tmp_path / "n.jpg", "color=black:s=320x240")
    blanca = _imagen(tmp_path / "b.jpg", "color=white:s=320x240")
    # Casi negra con una franja de imagen: tambien cuenta como negra (>= 90 %).
    franja = _imagen(tmp_path / "f.jpg", "color=black:s=320x240,drawbox=y=0:h=12:color=white:t=fill")
    assert rp.es_negra(await rp.medir_pblack(FFMPEG, negra))
    assert rp.es_negra(await rp.medir_pblack(FFMPEG, franja))
    assert not rp.es_negra(await rp.medir_pblack(FFMPEG, blanca))


@requiere_ffmpeg
@pytest.mark.asyncio
async def test_extraer_midiendo_elige_lo_mismo_que_la_api(tmp_path):
    video = tmp_path / "fundido.mp4"
    subprocess.run(
        [FFMPEG, "-v", "error", "-y",
         "-f", "lavfi", "-i", "color=black:s=320x240:d=1.5",
         "-f", "lavfi", "-i", "color=white:s=320x240:d=1.5",
         "-filter_complex", "[0][1]concat=n=2:v=1",
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(video)],
        check=True,
    )
    api, script = tmp_path / "api.jpg", tmp_path / "script.jpg"
    assert await mp._extraer_poster(FFMPEG, str(video), api)
    ok, leidos = await rp.extraer_midiendo(FFMPEG, str(video), script)
    assert ok and leidos > 0
    assert not rp.es_negra(await rp.medir_pblack(FFMPEG, script.read_bytes()))
    assert api.read_bytes() == script.read_bytes()


def test_el_registro_es_json_por_linea(tmp_path):
    reg = rp.Registro(tmp_path / "sub" / "r.jsonl")
    reg.anotar(media_id="a", estado="aplicado", ref_vieja=None, ref_nueva="n")
    (linea,) = (tmp_path / "sub" / "r.jsonl").read_text().splitlines()
    assert json.loads(linea)["ref_vieja"] is None


# --------------------------------------------------------------------------- #
# El flujo de aplicar, con almacen y base falsos
# --------------------------------------------------------------------------- #
class _AlmacenFalso:
    def __init__(self, existe=True):
        self.subidas: dict[str, bytes] = {}
        self.copias: list[tuple[str, str]] = []
        self.existe = existe

    async def url_video(self, v):
        return "video.mp4"

    async def subir_poster(self, v, ruta, datos):
        self.subidas[ruta] = datos

    async def existe_s3(self, clave):
        return self.existe

    async def copiar_s3(self, origen, destino):
        self.copias.append((origen, destino))


def _preparar(monkeypatch, *, pblack_nueva, cas_ok):
    async def _extraer(ffmpeg, entrada, destino):
        destino.write_bytes(b"jpeg-nuevo")
        return True

    async def _pblack(ffmpeg, datos):
        return pblack_nueva

    cambios = []

    async def _cambiar(media_id, vieja, nueva):
        cambios.append((media_id, vieja, nueva))
        return cas_ok

    monkeypatch.setattr(mp, "_extraer_poster", _extraer)
    monkeypatch.setattr(rp, "medir_pblack", _pblack)
    monkeypatch.setattr(rp, "cambiar_ruta", _cambiar)
    return cambios


@pytest.mark.asyncio
async def test_aplicar_sube_a_ruta_nueva_respalda_y_anota(monkeypatch, tmp_path):
    cambios = _preparar(monkeypatch, pblack_nueva=10.0, cas_ok=True)
    carpeta = f"videos/{UID}/{MID}"
    v = _video(almacen="s3", storage_path=f"{carpeta}/original.mp4",
               poster_path=f"{carpeta}/poster-v1.jpg")
    alm, reg = _AlmacenFalso(), rp.Registro(tmp_path / "r.jsonl")
    r = rp.Resultado(v.media_id, v.almacen, v.poster_path, clase_vieja="negra", pblack_vieja=100.0)
    await rp.aplicar_uno(alm, "ffmpeg", v, r, reg)
    assert r.accion == "aplicado"
    assert list(alm.subidas) == [f"{carpeta}/poster-v2.jpg"]
    assert alm.copias == [(f"{carpeta}/poster-v1.jpg", f"{carpeta}/respaldo-portada/poster-v1.jpg")]
    assert cambios == [(MID, f"{carpeta}/poster-v1.jpg", f"{carpeta}/poster-v2.jpg")]
    lineas = rp.leer_registro(reg.ruta)
    assert [l["estado"] for l in lineas] == ["subida", "aplicado"]
    assert lineas[-1]["ref_vieja"] == f"{carpeta}/poster-v1.jpg"
    assert rp.ya_aplicados(lineas) == {MID}


@pytest.mark.asyncio
async def test_si_la_fila_cambio_no_se_pisa(monkeypatch, tmp_path):
    _preparar(monkeypatch, pblack_nueva=10.0, cas_ok=False)
    v = _video()
    reg = rp.Registro(tmp_path / "r.jsonl")
    r = rp.Resultado(v.media_id, v.almacen, v.poster_path, clase_vieja="negra")
    await rp.aplicar_uno(_AlmacenFalso(), "ffmpeg", v, r, reg)
    assert r.accion == "conflicto"
    assert rp.ya_aplicados(rp.leer_registro(reg.ruta)) == set()


@pytest.mark.asyncio
async def test_nueva_tambien_negra_no_sube_nada(monkeypatch, tmp_path):
    cambios = _preparar(monkeypatch, pblack_nueva=100.0, cas_ok=True)
    v = _video()
    alm, reg = _AlmacenFalso(), rp.Registro(tmp_path / "r.jsonl")
    r = rp.Resultado(v.media_id, v.almacen, v.poster_path, clase_vieja="negra")
    await rp.aplicar_uno(alm, "ffmpeg", v, r, reg)
    assert r.accion == "saltado_nueva_tambien_negra"
    assert not alm.subidas and not cambios and not reg.ruta.exists()


@pytest.mark.asyncio
async def test_revertir_repone_la_vieja_de_s3_y_vuelve_la_fila(monkeypatch, tmp_path):
    carpeta = f"videos/{UID}/{MID}"
    reg = rp.Registro(tmp_path / "r.jsonl")
    reg.anotar(media_id=MID, post_id="p", almacen="s3", estado="aplicado",
               ref_vieja=f"{carpeta}/poster-v1.jpg", ref_nueva=f"{carpeta}/poster-v2.jpg",
               respaldo=f"{carpeta}/respaldo-portada/poster-v1.jpg")
    alm = _AlmacenFalso(existe=False)  # la limpieza diaria ya la borro
    cambios = []

    async def _cambiar(media_id, vieja, nueva):
        cambios.append((media_id, vieja, nueva))
        return True

    monkeypatch.setattr(rp, "cambiar_ruta", _cambiar)
    monkeypatch.setattr(rp, "Almacenes", lambda client: alm)
    args = rp.construir_parser().parse_args(["--revertir", "--aplicar", "--registro", str(reg.ruta)])
    assert await rp.revertir(args) == 0
    assert alm.copias == [(f"{carpeta}/respaldo-portada/poster-v1.jpg", f"{carpeta}/poster-v1.jpg")]
    assert cambios == [(MID, f"{carpeta}/poster-v2.jpg", f"{carpeta}/poster-v1.jpg")]
    assert rp.para_revertir(rp.leer_registro(reg.ruta)) == []
