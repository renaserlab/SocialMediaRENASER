"""El procesado de video en el servidor: a quien toca y a quien no.

POR QUE EXISTE ESTE FICHERO. Hasta el 27/08/2026 la imagen de Docker no traia
ffmpeg, asi que un video subido DESDE LA WEB se quedaba a tamano original y sin
poster: la libreria que comprime en el telefono no existe en navegador. Ahora
el servidor puede cubrir ese hueco, y eso trae un riesgo nuevo que estas
pruebas vigilan.

EL RIESGO: transcodificar es caro. La maquina es una t3.small (2 vCPU) con
creditos de CPU, y el trabajo corre en el MISMO proceso que atiende las
peticiones. Dos cosas tienen que seguir siendo verdad:

  1. Lo que ya llega ligero NO se recodifica. Los videos de la app suben a
     ~2.5 Mbps; recodificarlos gastaria CPU para empeorar la calidad.
  2. Los videos se procesan de uno en uno. Sin ese freno, diez subidas a la vez
     lanzan diez ffmpeg y frenan toda la API.

Ninguna prueba de aqui ejecuta ffmpeg: se comprueban las DECISIONES, que es lo
que se puede romper sin darse cuenta.
"""

from __future__ import annotations

import asyncio

import pytest

from app.core.config import get_settings
from app.modules.content import media_processing as mp


# --------------------------------------------------------------------------- #
# 1. A quien se recodifica
# --------------------------------------------------------------------------- #
def test_un_video_de_la_app_no_se_vuelve_a_codificar():
    """~2.5 Mbps es lo que sube el movil. Ya esta bien: no se toca."""
    # 19 MB para 60 s = ~2.5 Mbps
    assert mp.merece_transcodificar(19 * 1024 * 1024, 60.0) is False


def test_un_video_subido_desde_la_web_si_se_recodifica():
    """100 MB en 67 s = ~12.5 Mbps. Es el caso real medido en produccion."""
    assert mp.merece_transcodificar(105_485_416, 67.5) is True


def test_sin_medidas_no_se_toca():
    """Sin tamano o sin duracion no hay bitrate que juzgar.

    Ante la duda se sirve el original, que es lo que se hacia antes de que
    existiera nada de esto. Quemar CPU adivinando es peor.
    """
    assert mp.merece_transcodificar(None, 60.0) is False
    assert mp.merece_transcodificar(100_000_000, None) is False
    assert mp.merece_transcodificar(100_000_000, 0) is False
    assert mp.merece_transcodificar(0, 60.0) is False


def test_el_umbral_se_puede_mover_sin_tocar_codigo():
    """Es configuracion, no una constante escrita a fuego."""
    ajustes = get_settings()
    original = ajustes.video_bitrate_umbral
    try:
        ajustes.video_bitrate_umbral = 1_000_000  # 1 Mbps
        # 19 MB / 60 s = ~2.5 Mbps: ahora SI supera el umbral.
        assert mp.merece_transcodificar(19 * 1024 * 1024, 60.0) is True
    finally:
        ajustes.video_bitrate_umbral = original


# --------------------------------------------------------------------------- #
# 2. El freno de concurrencia
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_los_videos_se_procesan_de_uno_en_uno():
    """El semaforo es lo que impide que N subidas se coman la maquina.

    Se comprueba de verdad: dos tareas entran a la vez y se anota cuantas
    estan dentro al mismo tiempo. Si alguien quita el semaforo, aqui salen 2.
    """
    mp._semaforo_video = None  # se recrea leyendo la configuracion
    ajustes = get_settings()
    original = ajustes.video_jobs_concurrentes
    try:
        ajustes.video_jobs_concurrentes = 1
        dentro = 0
        maximo = 0

        async def trabajo():
            nonlocal dentro, maximo
            async with mp._turno_de_video():
                dentro += 1
                maximo = max(maximo, dentro)
                await asyncio.sleep(0.01)
                dentro -= 1

        await asyncio.gather(*(trabajo() for _ in range(4)))
        assert maximo == 1, (
            f"{maximo} videos codificando a la vez: el freno no esta puesto"
        )
    finally:
        ajustes.video_jobs_concurrentes = original
        mp._semaforo_video = None


@pytest.mark.asyncio
async def test_el_limite_de_concurrencia_es_configurable():
    mp._semaforo_video = None
    ajustes = get_settings()
    original = ajustes.video_jobs_concurrentes
    try:
        ajustes.video_jobs_concurrentes = 2
        assert mp._turno_de_video()._value == 2
    finally:
        ajustes.video_jobs_concurrentes = original
        mp._semaforo_video = None


# --------------------------------------------------------------------------- #
# 3. La escalera de resoluciones
# --------------------------------------------------------------------------- #
def test_la_escala_respeta_el_lado_menor_en_vertical_y_apaisado():
    """Un telefono graba en vertical. Fijar el ANCHO dejaria un 720x1280
    convertido en algo enorme; hay que fijar el lado menor."""
    filtro = mp._escala(720)
    assert "gte(iw,ih)" in filtro, "la formula tiene que mirar la orientacion"
    assert "720" in filtro
    # -2 = «el otro lado, en proporcion y par». Los codecs exigen pares.
    assert "-2" in filtro


def test_la_escalera_hls_va_de_menor_a_mayor():
    lados = [lado for _, lado, _ in mp.HLS_LADDER]
    assert lados == sorted(lados), "el master.m3u8 lista las variantes en orden"
    assert lados == [360, 540, 720]


# --------------------------------------------------------------------------- #
# 4. Lo que este modulo puede escribir
# --------------------------------------------------------------------------- #
def test_solo_se_escriben_columnas_derivadas():
    """NUNCA `storage_path`.

    El original no se toca: es la garantia que hace que todo esto sea
    reversible. Si alguien anade `storage_path` a la lista, un fallo de
    procesado podria dejar la publicacion apuntando a un archivo que no existe.
    """
    assert "storage_path" not in mp.CAMPOS_DERIVADOS
    assert "id" not in mp.CAMPOS_DERIVADOS
    assert "post_id" not in mp.CAMPOS_DERIVADOS
    assert set(mp.CAMPOS_DERIVADOS) == {
        "width",
        "height",
        "duration_s",
        "bytes",
        "poster_path",
        "feed_path",
        "stream_path",
    }
