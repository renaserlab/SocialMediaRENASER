"""Recortar el video de una historia EN EL SERVIDOR.

QUE VIGILA ESTE FICHERO, y son las cuatro cosas que pueden romperse sin que
nadie se entere hasta que un video de cinco minutos aparezca en una historia:

  1. Un video mas largo que el tope NO se publica sin recortar. Ni con un
     `duration_ms` mentiroso, ni con el tramo mal puesto, ni cuando ffmpeg
     falla. El limite lo pone el SERVIDOR midiendo el archivo, no el cliente
     declarando un numero.
  2. El tramo elegido se respeta: lo que se guarda dura lo que se pidio.
  3. El ORIGINAL no se toca. El recorte es un derivado en una ruta nueva.
  4. Si ffmpeg falla, no se publica nada. No se cuela el video largo «como si»
     estuviera recortado.

NINGUNA PRUEBA EJECUTA FFMPEG. Se sustituyen las dos fronteras con el exterior
—medir el archivo subido y cortar— y se comprueban las DECISIONES, que es
exactamente lo que se puede romper editando codigo. Igual que
`test_procesado_de_video.py`.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.content import media_processing as mp
from app.modules.profiles.models import Profile
from app.modules.stories import recorte
from app.modules.stories.models import Story
from app.modules.stories.schemas import MAX_DURATION_MS
from app.shared.database import Base, get_db

ANA = str(uuid4())
BETO = str(uuid4())

ORIGINAL = f"{ANA}/video-largo.mp4"


@pytest_asyncio.fixture
async def entorno():
    """App real sobre SQLite en memoria.

    `stories.expires_at` lo rellena la BASE en produccion (`now() + 24 h`, en la
    migracion 0003) y el modelo lo deja a proposito sin default de aplicacion.
    SQLite no tiene ese default, asi que aqui se emula con un listener y se
    quita al terminar: sin el, cualquier insercion fallaria por NOT NULL y la
    prueba estaria midiendo la carencia de SQLite, no el endpoint.
    """

    def _caducidad(_mapper, _connection, target) -> None:
        if target.expires_at is None:
            target.expires_at = datetime.now(timezone.utc) + timedelta(hours=24)

    event.listen(Story, "before_insert", _caducidad)

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        from app.modules.catalog import models as _c  # noqa: F401
        from app.modules.communities import models as _co  # noqa: F401
        from app.modules.content import models as _ct  # noqa: F401
        from app.modules.learning import models as _l  # noqa: F401
        from app.modules.messaging import models as _m  # noqa: F401
        from app.modules.moderation import models as _mo  # noqa: F401
        from app.modules.notifications import device_tokens as _dt  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add_all(
            [
                Profile(id=ANA, full_name="Ana", username="ana"),
                Profile(id=BETO, full_name="Beto", username="beto"),
            ]
        )
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    app.dependency_overrides[get_db] = _db_override
    usuario = AuthUser(id=ANA, email="ana@ejemplo.com", role="authenticated")
    app.dependency_overrides[get_current_user] = lambda: usuario
    app.dependency_overrides[get_optional_user] = lambda: usuario

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones

    app.dependency_overrides.clear()
    event.remove(Story, "before_insert", _caducidad)
    await engine.dispose()


async def _cuantas_historias(sesiones) -> int:
    async with sesiones() as db:
        return await db.scalar(select(func.count()).select_from(Story))


async def _la_historia(sesiones) -> Story | None:
    async with sesiones() as db:
        return (await db.scalars(select(Story))).first()


def _mide(monkeypatch, duracion_ms: int | None) -> None:
    """Lo que «ffprobe» dice que dura el archivo ya subido."""

    async def _falso(_ruta: str) -> int | None:
        return duracion_ms

    monkeypatch.setattr(recorte, "duracion_del_original_ms", _falso)


# --------------------------------------------------------------------------- #
# 1. El tramo, como decision pura
# --------------------------------------------------------------------------- #
def test_un_tramo_normal_pasa_tal_cual():
    tramo = recorte.revisar_tramo(10_000, 35_000, 300_000)
    assert (tramo.inicio_ms, tramo.fin_ms) == (10_000, 35_000)
    assert tramo.duracion_ms == 25_000


def test_un_tramo_de_mas_de_treinta_segundos_se_rechaza():
    """Y se rechaza AQUI, antes de gastar un solo ciclo de ffmpeg."""
    with pytest.raises(Exception) as fallo:
        recorte.revisar_tramo(0, 45_000, 300_000)
    assert fallo.value.status_code == 422


def test_el_final_se_ajusta_al_final_del_video():
    """El movil calcula el tramo con la duracion que informa el reproductor, y
    esa cifra y la del contenedor se separan en centesimas. «Hasta el final» es
    el tramo que mas se elige: rechazarlo por un redondeo seria absurdo."""
    tramo = recorte.revisar_tramo(60_000, 80_500, 80_120)
    assert tramo.fin_ms == 80_120
    assert tramo.duracion_ms == 20_120


def test_el_corte_nunca_pasa_del_tope_aunque_se_admita_el_redondeo():
    """La tolerancia sirve para ADMITIR, no para publicar de mas.

    50 000-80 500 sobre un archivo de 80 120 ms son 30,12 s: se admite, porque
    es una diferencia de medida y no un video largo. Pero lo que se le pide a
    ffmpeg son 30 s clavados.
    """
    tramo = recorte.revisar_tramo(50_000, 80_500, 80_120)
    assert tramo.duracion_ms == MAX_DURATION_MS
    assert tramo.fin_ms == 80_000


def test_un_tramo_que_empieza_despues_del_final_se_rechaza():
    with pytest.raises(Exception) as fallo:
        recorte.revisar_tramo(90_000, 100_000, 60_000)
    assert fallo.value.status_code == 422


def test_un_tramo_de_menos_de_un_segundo_se_rechaza():
    """Es el minimo que admite el CHECK de la base: por debajo, el visor ni
    parpadea y la insercion fallaria al final de todo el trabajo."""
    with pytest.raises(Exception) as fallo:
        recorte.revisar_tramo(0, 400, 60_000)
    assert fallo.value.status_code == 422


def test_solo_es_largo_lo_que_pasa_del_tope_de_verdad():
    assert recorte.necesita_recorte(MAX_DURATION_MS) is False
    # Un contenedor que declara 30.02 s para un video de 30 s no es un video
    # largo: es un redondeo.
    assert recorte.necesita_recorte(MAX_DURATION_MS + 100) is False
    assert recorte.necesita_recorte(MAX_DURATION_MS + 5_000) is True


# --------------------------------------------------------------------------- #
# 2. Un video largo NO se publica sin recortar
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_video_largo_sin_tramo_no_se_publica(entorno, monkeypatch):
    """LA PRUEBA CENTRAL DEL ENCARGO.

    El cliente declara 30 000 ms —el tope justo— pero el archivo dura cinco
    minutos. Antes eso pasaba: Pydantic y el CHECK solo miran el numero. Ahora
    lo mira ffprobe, y sin tramo elegido no hay historia.
    """
    http, sesiones = entorno
    _mide(monkeypatch, 300_000)

    respuesta = await http.post(
        "/api/v1/stories",
        json={
            "storage_path": ORIGINAL,
            "media_type": "video",
            "duration_ms": MAX_DURATION_MS,
        },
    )

    assert respuesta.status_code == 422
    assert "300" in respuesta.json()["error"]["message"]
    assert await _cuantas_historias(sesiones) == 0


@pytest.mark.asyncio
async def test_un_video_largo_con_un_tramo_largo_tampoco_se_publica(
    entorno, monkeypatch
):
    """Elegir tramo no es un tramite: el tramo tambien tiene tope."""
    http, sesiones = entorno
    _mide(monkeypatch, 300_000)

    respuesta = await http.post(
        "/api/v1/stories",
        json={
            "storage_path": ORIGINAL,
            "media_type": "video",
            "duration_ms": 30_000,
            "trim": {"start_ms": 0, "end_ms": 120_000},
        },
    )

    assert respuesta.status_code == 422
    assert await _cuantas_historias(sesiones) == 0


@pytest.mark.asyncio
async def test_un_video_que_cabe_se_publica_con_la_duracion_MEDIDA(
    entorno, monkeypatch
):
    """La duracion que se guarda sale del archivo, no del cuerpo de la peticion.

    El cliente dice 30 s; el archivo dura 12,5. Se guarda 12 500: es la unica de
    las dos cifras que ha visto el archivo.
    """
    http, sesiones = entorno
    _mide(monkeypatch, 12_500)

    respuesta = await http.post(
        "/api/v1/stories",
        json={
            "storage_path": ORIGINAL,
            "media_type": "video",
            "duration_ms": 30_000,
        },
    )

    assert respuesta.status_code == 201
    assert respuesta.json()["duration_ms"] == 12_500
    # Sin recorte, la ruta es la del original: no se genera ningun derivado
    # para algo que ya cabe.
    assert respuesta.json()["storage_path"] == ORIGINAL


# --------------------------------------------------------------------------- #
# 3. El tramo elegido se respeta y el original no se toca
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_tramo_elegido_es_el_que_se_publica(entorno, monkeypatch):
    http, sesiones = entorno
    _mide(monkeypatch, 300_000)
    pedidos: list[recorte.Tramo] = []

    async def _recorte_falso(ruta: str, tramo: recorte.Tramo, dueno: str) -> str:
        pedidos.append(tramo)
        assert ruta == ORIGINAL
        assert dueno == ANA
        return f"{dueno}/derived/historias/abc.mp4"

    monkeypatch.setattr(recorte, "recortar", _recorte_falso)

    respuesta = await http.post(
        "/api/v1/stories",
        json={
            "storage_path": ORIGINAL,
            "media_type": "video",
            "duration_ms": 5_000,  # mentira del cliente: manda el tramo
            "trim": {"start_ms": 62_000, "end_ms": 90_000},
        },
    )

    assert respuesta.status_code == 201
    assert pedidos == [recorte.Tramo(62_000, 90_000)]
    cuerpo = respuesta.json()
    assert cuerpo["duration_ms"] == 28_000
    # EL ORIGINAL NO SE TOCA: la historia apunta a un derivado nuevo.
    assert cuerpo["storage_path"] == f"{ANA}/derived/historias/abc.mp4"
    assert cuerpo["storage_path"] != ORIGINAL

    guardada = await _la_historia(sesiones)
    assert guardada is not None
    assert guardada.storage_path != ORIGINAL
    assert guardada.duration_ms == 28_000


@pytest.mark.asyncio
async def test_el_recorte_escribe_en_una_ruta_nueva_y_no_toca_el_original(
    monkeypatch,
):
    """`recortar` de verdad, con ffmpeg y Storage sustituidos.

    Lo que se comprueba es lo unico que no puede fallar nunca: que la unica
    escritura que sale de aqui va a una ruta NUEVA, y que la del original no
    aparece por ninguna parte.
    """
    subidas: list[str] = []

    async def _firma(_client, ruta, expires=600):
        return f"https://firmada/{ruta}"

    async def _sube(_client, ruta, datos, tipo):
        subidas.append(ruta)

    async def _corta(_ffmpeg, _entrada, _tramo, destino: Path) -> bool:
        destino.write_bytes(b"video recortado")
        return True

    async def _probe(_ruta):
        return 1080, 1920, 28.0

    monkeypatch.setattr(mp, "processing_configured", lambda: True)
    monkeypatch.setattr(mp, "_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(mp, "_signed_url", _firma)
    monkeypatch.setattr(mp, "_upload", _sube)
    monkeypatch.setattr(mp, "_probe_video", _probe)
    monkeypatch.setattr(recorte, "_cortar", _corta)

    destino = await recorte.recortar(ORIGINAL, recorte.Tramo(62_000, 90_000), ANA)

    assert subidas == [destino]
    assert destino != ORIGINAL
    assert ORIGINAL not in subidas
    # Bajo el prefijo del dueño, que es lo que hace que el borrado de cuenta
    # (que barre por prefijo) tambien se lleve el derivado.
    assert destino.startswith(f"{ANA}/derived/historias/")
    assert destino.endswith(".mp4")


# --------------------------------------------------------------------------- #
# 4. Cuando ffmpeg falla
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_si_ffmpeg_falla_no_se_publica_nada(entorno, monkeypatch):
    """La degradacion honesta: mejor sin historia que con el video largo."""
    http, sesiones = entorno
    _mide(monkeypatch, 300_000)

    async def _firma(_client, ruta, expires=600):
        return f"https://firmada/{ruta}"

    async def _corta_mal(*_args, **_kwargs) -> bool:
        return False

    subidas: list[str] = []

    async def _sube(_client, ruta, datos, tipo):
        subidas.append(ruta)

    monkeypatch.setattr(mp, "processing_configured", lambda: True)
    monkeypatch.setattr(mp, "_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(mp, "_signed_url", _firma)
    monkeypatch.setattr(mp, "_upload", _sube)
    monkeypatch.setattr(recorte, "_cortar", _corta_mal)

    respuesta = await http.post(
        "/api/v1/stories",
        json={
            "storage_path": ORIGINAL,
            "media_type": "video",
            "duration_ms": 30_000,
            "trim": {"start_ms": 0, "end_ms": 30_000},
        },
    )

    assert respuesta.status_code == 503
    assert "no hemos publicado nada" in respuesta.json()["error"]["message"].lower()
    assert await _cuantas_historias(sesiones) == 0
    assert subidas == []


@pytest.mark.asyncio
async def test_si_ffmpeg_se_cuelga_tampoco_se_publica(entorno, monkeypatch):
    http, sesiones = entorno
    _mide(monkeypatch, 300_000)

    async def _firma(_client, ruta, expires=600):
        return f"https://firmada/{ruta}"

    async def _se_cuelga(*_args, **_kwargs):
        raise asyncio.TimeoutError()

    monkeypatch.setattr(mp, "processing_configured", lambda: True)
    monkeypatch.setattr(mp, "_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(mp, "_signed_url", _firma)
    monkeypatch.setattr(recorte, "_cortar", _se_cuelga)

    respuesta = await http.post(
        "/api/v1/stories",
        json={
            "storage_path": ORIGINAL,
            "media_type": "video",
            "duration_ms": 30_000,
            "trim": {"start_ms": 0, "end_ms": 30_000},
        },
    )

    assert respuesta.status_code == 503
    assert await _cuantas_historias(sesiones) == 0


@pytest.mark.asyncio
async def test_un_recorte_que_sale_mas_largo_del_tope_no_se_publica(monkeypatch):
    """La ultima linea: se comprueba lo que SALIO, no lo que se pidio.

    `-t 30` deberia bastar. «Deberia» no es una garantia, y si el archivo
    producido durase mas del tope, publicarlo seria justo el fallo que todo
    esto viene a impedir.
    """

    async def _firma(_client, ruta, expires=600):
        return f"https://firmada/{ruta}"

    async def _corta(_ffmpeg, _entrada, _tramo, destino: Path) -> bool:
        destino.write_bytes(b"x")
        return True

    async def _probe_largo(_ruta):
        return 1080, 1920, 300.0  # cinco minutos: algo salio muy mal

    subidas: list[str] = []

    async def _sube(_client, ruta, datos, tipo):
        subidas.append(ruta)

    monkeypatch.setattr(mp, "processing_configured", lambda: True)
    monkeypatch.setattr(mp, "_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(mp, "_signed_url", _firma)
    monkeypatch.setattr(mp, "_upload", _sube)
    monkeypatch.setattr(mp, "_probe_video", _probe_largo)
    monkeypatch.setattr(recorte, "_cortar", _corta)

    with pytest.raises(Exception) as fallo:
        await recorte.recortar(ORIGINAL, recorte.Tramo(0, 30_000), ANA)
    assert fallo.value.status_code == 503
    assert subidas == []


@pytest.mark.asyncio
async def test_sin_ffmpeg_en_la_maquina_no_se_publica_el_recorte(entorno, monkeypatch):
    """Un servidor sin ffmpeg no puede fingir que ha recortado."""
    http, sesiones = entorno
    _mide(monkeypatch, 300_000)
    monkeypatch.setattr(mp, "processing_configured", lambda: True)
    monkeypatch.setattr(mp, "_ffmpeg", lambda: None)

    respuesta = await http.post(
        "/api/v1/stories",
        json={
            "storage_path": ORIGINAL,
            "media_type": "video",
            "duration_ms": 30_000,
            "trim": {"start_ms": 0, "end_ms": 30_000},
        },
    )

    assert respuesta.status_code == 503
    assert await _cuantas_historias(sesiones) == 0


@pytest.mark.asyncio
async def test_sin_poder_medir_el_recorte_se_rechaza_y_lo_corto_sigue_pasando(
    entorno,
):
    """El caso «este servidor no sabe»: sin credenciales de Storage.

    Es el estado de toda la suite (ver `conftest`) y el de una maquina de
    desarrollo. No poder medir NO habilita a inventarse una medida:

      - con recorte pedido -> no se publica, porque recortar no se puede fingir;
      - sin recorte pedido -> se publica igual que antes de que todo esto
        existiera, con el tope de Pydantic sobre el numero del cliente.
    """
    http, sesiones = entorno

    con_recorte = await http.post(
        "/api/v1/stories",
        json={
            "storage_path": ORIGINAL,
            "media_type": "video",
            "duration_ms": 30_000,
            "trim": {"start_ms": 0, "end_ms": 30_000},
        },
    )
    assert con_recorte.status_code == 503
    assert await _cuantas_historias(sesiones) == 0

    sin_recorte = await http.post(
        "/api/v1/stories",
        json={
            "storage_path": f"{ANA}/corto.mp4",
            "media_type": "video",
            "duration_ms": 8_000,
        },
    )
    assert sin_recorte.status_code == 201
    assert sin_recorte.json()["duration_ms"] == 8_000


# --------------------------------------------------------------------------- #
# 5. Lo que no cambia
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_una_foto_se_publica_sin_pasar_por_ffmpeg(entorno, monkeypatch):
    """Una imagen no se mide ni se recorta: seria trabajo para nada."""
    http, sesiones = entorno

    async def _no_llamar(_ruta):
        raise AssertionError("una foto no se mide con ffprobe")

    monkeypatch.setattr(recorte, "duracion_del_original_ms", _no_llamar)

    respuesta = await http.post(
        "/api/v1/stories",
        json={
            "storage_path": f"{ANA}/foto.jpg",
            "media_type": "image",
            "duration_ms": 5_000,
        },
    )
    assert respuesta.status_code == 201
    assert await _cuantas_historias(sesiones) == 1


@pytest.mark.asyncio
async def test_una_foto_con_tramo_se_rechaza(entorno):
    http, sesiones = entorno
    respuesta = await http.post(
        "/api/v1/stories",
        json={
            "storage_path": f"{ANA}/foto.jpg",
            "media_type": "image",
            "duration_ms": 5_000,
            "trim": {"start_ms": 0, "end_ms": 10_000},
        },
    )
    assert respuesta.status_code == 422
    assert await _cuantas_historias(sesiones) == 0


@pytest.mark.asyncio
async def test_no_se_puede_publicar_el_archivo_de_otra_persona(entorno, monkeypatch):
    """El servidor lee el archivo con la `service_role`, que se salta la RLS.

    Sin esta comprobacion, pedir un recorte de `BETO/loquesea.mp4` haria que la
    API bajara el video de Beto y lo publicara como historia de Ana.
    """
    http, sesiones = entorno
    _mide(monkeypatch, 20_000)

    respuesta = await http.post(
        "/api/v1/stories",
        json={
            "storage_path": f"{BETO}/privado.mp4",
            "media_type": "video",
            "duration_ms": 10_000,
        },
    )
    assert respuesta.status_code == 403
    assert await _cuantas_historias(sesiones) == 0
