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

from app.core.config import Settings, get_settings
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


# --------------------------------------------------------------------------- #
# 5. A quien le toca la escalera HLS
#
# HLS son TRES codificaciones del mismo video en vez de una. El criterio de aqui
# es lo que impide que encender el interruptor multiplique por tres el gasto de
# creditos de la t3.small a cambio de nada.
# --------------------------------------------------------------------------- #
def test_un_clip_corto_no_lleva_hls():
    """15 s son cuatro segmentos de 4 s: el video se acaba antes de que el
    reproductor tenga con que medir la red y cambiar de variante. Las tres
    codificaciones se pagarian enteras para que no se note nada."""
    assert mp.merece_hls(15.0, 1080, 1920) is False


def test_un_video_largo_y_grande_si_lleva_hls():
    """Vertical de movil, minuto y medio: aqui la calidad adaptativa se nota."""
    assert mp.merece_hls(90.0, 1080, 1920) is True


def test_el_criterio_mira_el_lado_menor_no_el_ancho():
    """Un telefono graba en vertical. Si se mirara el ancho, un 480x854 pasaria
    por bueno con sus 854 px, que es justo el error que evita `_escala`."""
    assert mp.merece_hls(90.0, 1280, 720) is True
    assert mp.merece_hls(90.0, 480, 854) is False


def test_un_original_de_baja_resolucion_no_lleva_hls():
    """Con 480p el peldano alto es un reescalado hacia arriba: triple de CPU
    para tres copias que no se distinguen entre si."""
    assert mp.merece_hls(120.0, 854, 480) is False


def test_sin_medidas_no_hay_hls():
    """Misma regla que en el MP4: sin datos, el original."""
    assert mp.merece_hls(None, 1080, 1920) is False
    assert mp.merece_hls(90.0, None, 1920) is False
    assert mp.merece_hls(90.0, 1080, None) is False
    assert mp.merece_hls(0, 1080, 1920) is False


def test_los_umbrales_de_hls_son_configuracion():
    """Se pueden mover sin desplegar codigo, como el umbral de bitrate."""
    ajustes = get_settings()
    duracion = ajustes.video_hls_duracion_minima_s
    lado = ajustes.video_hls_lado_menor_minimo
    try:
        ajustes.video_hls_duracion_minima_s = 5.0
        ajustes.video_hls_lado_menor_minimo = 360
        assert mp.merece_hls(15.0, 854, 480) is True
    finally:
        ajustes.video_hls_duracion_minima_s = duracion
        ajustes.video_hls_lado_menor_minimo = lado


def test_hls_sigue_apagado_por_defecto():
    """Lo enciende una persona que ha mirado el saldo de creditos de CPU y la
    alarma que lo vigila, no un despliegue que se lo encuentra puesto."""
    assert Settings.model_fields["video_hls_enabled"].default is False


# --------------------------------------------------------------------------- #
# 6. La prioridad de ffmpeg
#
# Rebajarla mejora la LATENCIA de las peticiones mientras se codifica. NO ahorra
# creditos de CPU: el trabajo es el mismo. De eso se ocupan el semaforo, el
# criterio de HLS y la alarma de CloudWatch.
# --------------------------------------------------------------------------- #
def test_en_linux_ffmpeg_va_por_detras_de_la_api(monkeypatch):
    monkeypatch.setattr(mp.sys, "platform", "linux")
    monkeypatch.setattr(mp, "_nice", lambda: "/usr/bin/nice")
    cmd, extra = mp._prioridad_baja(["ffmpeg", "-i", "x.mp4"])
    assert cmd[:3] == ["/usr/bin/nice", "-n", str(mp.NICE_FFMPEG)]
    assert cmd[3:] == ["ffmpeg", "-i", "x.mp4"], "los argumentos no se tocan"
    assert extra == {}, "`creationflags` es de Windows: en Linux reventaria"


def test_sin_nice_el_video_se_procesa_igual(monkeypatch):
    """Perder la rebaja de prioridad es peor rendimiento, no una averia."""
    monkeypatch.setattr(mp.sys, "platform", "linux")
    monkeypatch.setattr(mp, "_nice", lambda: None)
    cmd, extra = mp._prioridad_baja(["ffmpeg", "-i", "x.mp4"])
    assert cmd == ["ffmpeg", "-i", "x.mp4"]
    assert extra == {}


def test_en_windows_no_se_antepone_nice(monkeypatch):
    """El desarrollo es Windows y alli `nice` no existe: anteponerlo dejaria el
    procesado de video roto en local."""
    monkeypatch.setattr(mp.sys, "platform", "win32")
    monkeypatch.setattr(
        mp.subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 16384, raising=False
    )
    cmd, extra = mp._prioridad_baja(["ffmpeg", "-i", "x.mp4"])
    assert cmd == ["ffmpeg", "-i", "x.mp4"]
    assert extra == {"creationflags": 16384}


@pytest.mark.asyncio
async def test_todo_ffmpeg_sale_con_la_prioridad_rebajada(monkeypatch):
    """Que exista el ayudante no basta: tiene que usarlo `_run`, que es por
    donde pasan el poster, el MP4 y los tres peldanos de HLS."""
    visto: dict = {}

    class _ProcesoFalso:
        returncode = 0

        async def communicate(self):
            return b"", b""

    async def _exec_falso(*cmd, **kwargs):
        visto["cmd"] = list(cmd)
        visto["kwargs"] = kwargs
        return _ProcesoFalso()

    monkeypatch.setattr(
        mp, "_prioridad_baja", lambda cmd: (["ANTEPUESTO", *cmd], {"marca": 1})
    )
    monkeypatch.setattr(mp.asyncio, "create_subprocess_exec", _exec_falso)

    codigo, _, _ = await mp._run(["ffmpeg", "-version"])
    assert codigo == 0
    assert visto["cmd"] == ["ANTEPUESTO", "ffmpeg", "-version"]
    assert visto["kwargs"].get("marca") == 1


# ---------------------------------------------------------------------------
# Un video vertical se guarda como vertical
# ---------------------------------------------------------------------------


def test_un_video_girado_se_mide_como_se_ve() -> None:
    """El movil guarda el vertical como un cuadro apaisado mas una nota.

    Grabar en vertical no gira los pixeles: el archivo lleva un cuadro de
    1920x1080 y la instruccion «girar 90 grados» al reproducir. Guardar en la
    base de datos el 1920x1080 es guardar que el video es apaisado, y con eso
    la aplicacion dibuja una caja apaisada alrededor de un video vertical: las
    franjas negras que se ven hoy en el muro.
    """
    girado = {"width": 1920, "height": 1080, "side_data_list": [{"rotation": -90}]}
    assert mp.rotacion_del_stream(girado) == 270
    assert mp.dimensiones_visibles(1920, 1080, 270) == (1080, 1920)


def test_la_rotacion_tambien_puede_venir_como_etiqueta() -> None:
    """Segun quien codifique, la nota viaja como `tags.rotate` y no como matriz."""
    etiquetado = {"width": 1920, "height": 1080, "tags": {"rotate": "90"}}
    assert mp.rotacion_del_stream(etiquetado) == 90
    assert mp.dimensiones_visibles(1920, 1080, 90) == (1080, 1920)


def test_un_video_apaisado_no_se_toca() -> None:
    assert mp.rotacion_del_stream({"width": 1920, "height": 1080}) == 0
    assert mp.dimensiones_visibles(1920, 1080, 0) == (1920, 1080)
    # 180 grados es del reves, pero sigue siendo apaisado.
    assert mp.dimensiones_visibles(1920, 1080, 180) == (1920, 1080)


def test_una_rotacion_ilegible_no_rompe_el_procesado() -> None:
    """Antes que inventarse una medida, se deja el video como estaba."""
    assert mp.rotacion_del_stream({"side_data_list": [{"rotation": "no-es-un-numero"}]}) == 0
    assert mp.rotacion_del_stream({"tags": {"rotate": None}}) == 0
    assert mp.dimensiones_visibles(None, None, 90) == (None, None)


# --------------------------------------------------------------------------- #
# Derivados sin dueño (revisión del 29/09/2026)
#
# Transcodificar tarda minutos. Si mientras tanto se borra la cuenta (o la
# publicación), la baja barre Storage ANTES de que se suban los derivados, y
# estos se quedaban para siempre: el paso final veía la fila borrada y volvía
# sin limpiar.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_si_la_fila_desaparece_mientras_se_procesa_se_retiran_los_derivados(monkeypatch):
    import uuid

    from sqlalchemy import delete
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.modules.content.models import PostMedia
    from app.shared import storage

    motor = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with motor.begin() as conexion:
        await conexion.run_sync(PostMedia.__table__.create)
    sesiones = async_sessionmaker(motor, expire_on_commit=False)
    medio = str(uuid.uuid4())
    async with sesiones() as db:
        db.add(PostMedia(id=medio, post_id=str(uuid.uuid4()), storage_path="u-1/video.mp4", media_type="video"))
        await db.commit()

    async def procesar(client, media):
        media.feed_path = f"u-1/derived/{media.id}/feed.mp4"
        # La baja de la cuenta llega mientras tanto.
        async with sesiones() as db:
            await db.execute(delete(PostMedia).where(PostMedia.id == media.id))
            await db.commit()

    retiradas: list[tuple[str, str]] = []

    async def borrar_carpeta(bucket, prefijo):
        retiradas.append((bucket, prefijo))
        return 1

    monkeypatch.setattr(mp, "SessionLocal", sesiones)
    monkeypatch.setattr(mp, "processing_configured", lambda: True)
    monkeypatch.setattr(mp, "_process_video", procesar)
    monkeypatch.setattr(storage, "borrar_carpeta", borrar_carpeta)
    try:
        await mp.process_media(medio)
    finally:
        await motor.dispose()

    assert retiradas == [("post-media", f"u-1/derived/{medio}")]


@pytest.mark.asyncio
async def test_si_la_fila_sigue_no_se_retira_nada(monkeypatch):
    import uuid

    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.modules.content.models import PostMedia
    from app.shared import storage

    motor = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with motor.begin() as conexion:
        await conexion.run_sync(PostMedia.__table__.create)
    sesiones = async_sessionmaker(motor, expire_on_commit=False)
    medio = str(uuid.uuid4())
    async with sesiones() as db:
        db.add(PostMedia(id=medio, post_id=str(uuid.uuid4()), storage_path="u-1/video.mp4", media_type="video"))
        await db.commit()

    async def procesar(client, media):
        media.feed_path = f"u-1/derived/{media.id}/feed.mp4"

    retiradas: list = []

    async def borrar_carpeta(bucket, prefijo):
        retiradas.append((bucket, prefijo))
        return 0

    monkeypatch.setattr(mp, "SessionLocal", sesiones)
    monkeypatch.setattr(mp, "processing_configured", lambda: True)
    monkeypatch.setattr(mp, "_process_video", procesar)
    monkeypatch.setattr(storage, "borrar_carpeta", borrar_carpeta)
    try:
        await mp.process_media(medio)
        async with sesiones() as db:
            fila = await db.get(PostMedia, medio)
            assert fila.feed_path == f"u-1/derived/{medio}/feed.mp4"
    finally:
        await motor.dispose()
    assert retiradas == []
