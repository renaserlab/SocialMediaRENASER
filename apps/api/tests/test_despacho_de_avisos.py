"""Quién vacía la cola de entregas, y cuándo (`notifications/despacho.py`).

LO REPORTADO (auditoría del 04/10/2026; pedido el 05/10): los avisos de
Servicios —«tienes una reserva nueva», «tu postulación fue aprobada»— no
llegaban al teléfono con la aplicación cerrada. Se guardaban en la cola y la
cola solo salía por una ruta de administración que nadie llamaba.

LO QUE SE DEFIENDE AQUÍ:

  * que la petición que encola deja dicho que hay algo que enviar, y que al
    terminar se envía;
  * que una petición que falla no dispara nada;
  * que nunca hay dos pasadas a la vez en un proceso, y que lo pedido en medio
    no se queda sin atender;
  * que apagado —como nace— no lanza nada por detrás;
  * que una pasada de verdad envía, marca y no repite;
  * que el planificador de Servicios programa la suya sin esperarla.
"""

from __future__ import annotations

import asyncio
import inspect
from datetime import datetime, timezone

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.main import app  # noqa: F401 - registra todos los modelos en `Base`
from app.modules.notifications import despacho, entregas, esquema, push
from app.modules.notifications.device_tokens import DeviceToken
from app.modules.notifications.models import NotificationDelivery
from app.modules.profiles.models import Profile
from app.modules.services import procesos_router
from app.shared import database
from app.shared.database import Base

ANA = "aaaaaaaa-0000-0000-0000-00000000000a"
BRUNO = "aaaaaaaa-0000-0000-0000-00000000000b"
#: Uno de los 44 avisos de Servicios, todos con su texto para el teléfono.
TIPO = "service_application_approved"


@pytest.fixture(autouse=True)
def _despacho_de_fabrica():
    """Cada prueba empieza y acaba con el despacho como nace: apagado y parado."""

    def _limpio() -> None:
        despacho.apagar()
        despacho._en_curso = False
        despacho._otra_vez = False

    _limpio()
    yield
    _limpio()


@pytest_asyncio.fixture
async def cola(monkeypatch):
    """Una base en memoria con la cola, Ana con teléfono y Bruno sin él."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    hacer = async_sessionmaker(engine, expire_on_commit=False)
    async with hacer() as db:
        db.add_all(
            [
                Profile(id=ANA, username="ana", full_name="Ana"),
                Profile(id=BRUNO, username="bruno", full_name="Bruno"),
                DeviceToken(token="ExponentPushToken[ana]", user_id=ANA, platform="android"),
            ]
        )
        await db.commit()
    esquema.olvidar_entregas()
    # La pasada abre su PROPIA sesión: que sea contra esta base.
    monkeypatch.setattr(database, "SessionLocal", hacer)
    # EL RELOJ, SIN ZONA, y solo aquí. SQLite devuelve las fechas sin zona y la
    # cola compara «¿toca ya?» también en memoria (el UPDATE del ORM evalúa la
    # condición sobre las filas que tiene cargadas): con el reloj de verdad,
    # que lleva zona, eso es un TypeError que en PostgreSQL no existe. Lo que
    # la cola hace con la base real —turnos, reintentos, el índice único— está
    # en `test_avisos_de_posventa.py`; aquí se prueba quién la dispara.
    monkeypatch.setattr(
        entregas, "ahora", lambda: datetime.now(timezone.utc).replace(tzinfo=None)
    )
    try:
        yield hacer
    finally:
        esquema.olvidar_entregas()
        await engine.dispose()


@pytest.fixture
def expo(monkeypatch):
    """Expo de mentira: apunta lo que se le manda y contesta que salió."""
    enviados: list[dict] = []

    class _Respuesta:
        def __init__(self, cuantos: int) -> None:
            self._cuantos = cuantos

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {"data": [{"status": "ok", "id": str(n)} for n in range(self._cuantos)]}

    class _Cliente:
        def __init__(self, *a, **k) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc) -> bool:
            return False

        async def post(self, url, json):  # noqa: A002 - la firma de httpx
            enviados.extend(json)
            return _Respuesta(len(json))

    monkeypatch.setattr(push.httpx, "AsyncClient", _Cliente)
    return enviados


async def _estados(hacer) -> dict[str, str]:
    async with hacer() as db:
        filas = (await db.execute(select(NotificationDelivery.user_id, NotificationDelivery.status))).all()
    return {usuario: estado for usuario, estado in filas}


# --------------------------------------------------------------------------- #
# 1. La petición que encola lo deja dicho
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_encolar_lo_anota_en_la_sesion(cola):
    async with cola() as db:
        assert entregas.MARCA_DE_ENCOLADO not in db.info
        fila = await entregas.encolar(db, usuario_id=ANA, tipo=TIPO, entidad_id="postulacion-1")
        assert fila is not None
        assert db.info[entregas.MARCA_DE_ENCOLADO] is True
        await db.commit()


@pytest.mark.asyncio
async def test_un_suceso_que_ya_estaba_no_anota_nada(cola):
    """No hay nada nuevo que enviar: no se programa una pasada para nada."""
    async with cola() as db:
        await entregas.encolar(db, usuario_id=ANA, tipo=TIPO, entidad_id="postulacion-1")
        await db.commit()
    async with cola() as db:
        repetida = await entregas.encolar(db, usuario_id=ANA, tipo=TIPO, entidad_id="postulacion-1")
        assert repetida is None
        assert entregas.MARCA_DE_ENCOLADO not in db.info


def test_al_terminar_la_peticion_se_despacha_solo_si_encolo(monkeypatch):
    llamadas: list[str] = []
    monkeypatch.setattr(despacho, "despachar", lambda: llamadas.append("despacha") or True)

    class _Sesion:
        def __init__(self, info: dict) -> None:
            self.info = info

    limpia = _Sesion({})
    despacho.tras_la_peticion(limpia)
    assert llamadas == []

    con_entregas = _Sesion({entregas.MARCA_DE_ENCOLADO: True})
    despacho.tras_la_peticion(con_entregas)
    assert llamadas == ["despacha"]
    # Y la marca se gasta: la misma sesión no dispara dos veces.
    despacho.tras_la_peticion(con_entregas)
    assert llamadas == ["despacha"]


def test_al_terminar_la_peticion_nunca_lanza(monkeypatch):
    """Corre al cerrar la sesión de CUALQUIER petición: un aviso no puede
    convertir en error una operación que ya terminó bien."""

    def _roto() -> bool:
        raise RuntimeError("sin bucle, sin red, sin nada")

    monkeypatch.setattr(despacho, "despachar", _roto)

    class _Sesion:
        info = {entregas.MARCA_DE_ENCOLADO: True}

    despacho.tras_la_peticion(_Sesion())
    despacho.tras_la_peticion(object())  # ni siquiera es una sesión


@pytest.mark.asyncio
async def test_la_sesion_de_la_peticion_despacha_al_terminar_bien(monkeypatch):
    """`get_db` es quien lo llama, con la petición ya resuelta."""
    vistas: list[dict] = []
    monkeypatch.setattr(despacho, "tras_la_peticion", lambda sesion: vistas.append(dict(sesion.info)))

    class _Sesion:
        def __init__(self) -> None:
            self.info: dict = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc) -> bool:
            return False

    monkeypatch.setattr(database, "SessionLocal", _Sesion)

    peticion = database.get_db()
    sesion = await peticion.__anext__()
    assert vistas == [], "se despachó antes de que la petición terminara"
    sesion.info[entregas.MARCA_DE_ENCOLADO] = True
    with pytest.raises(StopAsyncIteration):
        await peticion.__anext__()
    assert vistas == [{entregas.MARCA_DE_ENCOLADO: True}]


@pytest.mark.asyncio
async def test_una_peticion_que_falla_no_despacha(monkeypatch):
    """Si la operación reventó no hay nada confirmado que enviar."""
    vistas: list[object] = []
    monkeypatch.setattr(despacho, "tras_la_peticion", vistas.append)

    class _Sesion:
        info = {entregas.MARCA_DE_ENCOLADO: True}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc) -> bool:
            return False

    monkeypatch.setattr(database, "SessionLocal", _Sesion)

    peticion = database.get_db()
    await peticion.__anext__()
    with pytest.raises(RuntimeError):
        await peticion.athrow(RuntimeError("la operación falló"))
    assert vistas == []


# --------------------------------------------------------------------------- #
# 2. Una pasada a la vez, y nada por detrás si está apagado
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_apagado_como_nace_no_lanza_nada(monkeypatch):
    """Importar la aplicación —una prueba, un guion— no deja tareas sueltas."""
    corridas: list[int] = []

    async def _vaciar(limite: int = despacho.LOTE):
        corridas.append(1)
        return None

    monkeypatch.setattr(despacho, "vaciar", _vaciar)
    assert despacho.encendido() is False
    assert despacho.despachar() is False
    await asyncio.sleep(0)
    assert corridas == []
    assert not despacho._tareas


@pytest.mark.asyncio
async def test_encendido_despacha_sin_hacer_esperar(monkeypatch):
    suelta = asyncio.Event()
    corridas: list[int] = []

    async def _vaciar(limite: int = despacho.LOTE):
        corridas.append(1)
        await suelta.wait()
        return None

    monkeypatch.setattr(despacho, "vaciar", _vaciar)
    despacho.encender()
    assert despacho.despachar() is True  # vuelve en el acto: la pasada aún no acabó
    await asyncio.sleep(0)
    assert corridas == [1]
    suelta.set()
    await asyncio.gather(*list(despacho._tareas))
    assert despacho._en_curso is False


@pytest.mark.asyncio
async def test_nunca_dos_pasadas_a_la_vez_y_lo_pedido_en_medio_da_una_vuelta_mas(monkeypatch):
    """El pool son cinco conexiones más cinco: diez reservas seguidas no pueden
    ser diez pasadas hablando con Expo a la vez."""
    sueltas: list[asyncio.Event] = []
    a_la_vez = 0
    maximo = 0

    async def _vaciar(limite: int = despacho.LOTE):
        nonlocal a_la_vez, maximo
        a_la_vez += 1
        maximo = max(maximo, a_la_vez)
        suelta = asyncio.Event()
        sueltas.append(suelta)
        await suelta.wait()
        a_la_vez -= 1
        return None

    monkeypatch.setattr(despacho, "vaciar", _vaciar)
    despacho.encender()
    assert despacho.despachar() is True
    await asyncio.sleep(0)
    # Tres peticiones más encolan mientras la primera pasada habla con Expo.
    assert [despacho.despachar() for _ in range(3)] == [False, False, False]
    assert len(sueltas) == 1
    sueltas[0].set()
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert len(sueltas) == 2, "lo pedido en medio se quedó sin atender"
    sueltas[1].set()
    await asyncio.gather(*list(despacho._tareas))
    assert len(sueltas) == 2, "tres peticiones en medio son UNA vuelta más, no tres"
    assert maximo == 1
    # Y terminada, la siguiente vuelve a programarse.
    assert despacho.despachar() is True
    await asyncio.sleep(0)
    sueltas[2].set()
    await asyncio.gather(*list(despacho._tareas))


@pytest.mark.asyncio
async def test_un_lote_lleno_da_otra_vuelta(monkeypatch):
    """Si salieron tantas como caben en una pasada, probablemente queda más."""
    cuentas = [
        {"intentadas": despacho.LOTE, "enviadas": despacho.LOTE, "sin_destino": 0, "reintentables": 0, "fallidas": 0},
        {"intentadas": 3, "enviadas": 3, "sin_destino": 0, "reintentables": 0, "fallidas": 0},
    ]
    corridas: list[int] = []

    async def _vaciar(limite: int = despacho.LOTE):
        corridas.append(1)
        return cuentas[len(corridas) - 1]

    monkeypatch.setattr(despacho, "vaciar", _vaciar)
    despacho.encender()
    despacho.despachar()
    await asyncio.gather(*list(despacho._tareas))
    assert len(corridas) == 2


# --------------------------------------------------------------------------- #
# 3. Una pasada de verdad
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_una_pasada_envia_marca_y_no_repite(cola, expo, caplog):
    async with cola() as db:
        await entregas.encolar(db, usuario_id=ANA, tipo=TIPO, entidad_id="postulacion-1")
        await entregas.encolar(db, usuario_id=BRUNO, tipo=TIPO, entidad_id="postulacion-2")
        await db.commit()

    with caplog.at_level("INFO", logger=despacho.logger.name):
        cuenta = await despacho.vaciar()

    assert cuenta == {"intentadas": 2, "enviadas": 1, "sin_destino": 1, "reintentables": 0, "fallidas": 0}
    # A Ana le sale, en su idioma y por el canal que existe en el teléfono.
    assert [m["to"] for m in expo] == ["ExponentPushToken[ana]"]
    assert expo[0]["title"] and expo[0]["body"]
    assert expo[0]["priority"] == "high"
    assert expo[0]["channelId"].endswith(push.SUFIJO_DE_CANAL)
    # Las dos quedan cerradas: Bruno no tiene teléfono y reintentar no lo crea.
    assert await _estados(cola) == {ANA: entregas.ENVIADA, BRUNO: entregas.ENVIADA}
    # El registro dice cuántas, nunca a quién.
    registro = " ".join(r.getMessage() for r in caplog.records)
    assert "intentadas=2 enviadas=1 sin_destino=1" in registro
    assert ANA not in registro and "ExponentPushToken" not in registro

    # Repetir no manda nada dos veces.
    assert (await despacho.vaciar())["intentadas"] == 0
    assert len(expo) == 1


@pytest.mark.asyncio
async def test_si_expo_falla_la_entrega_queda_para_el_reintento(cola, monkeypatch):
    async def _expo_caido(sesion, *, usuario_id: str, tipo: str, locale: str) -> bool:
        raise RuntimeError("Expo no contesta")

    monkeypatch.setattr(push, "enviar_de_la_cola", _expo_caido)
    async with cola() as db:
        await entregas.encolar(db, usuario_id=ANA, tipo=TIPO, entidad_id="postulacion-1")
        await db.commit()

    cuenta = await despacho.vaciar()
    assert cuenta["reintentables"] == 1 and cuenta["enviadas"] == 0
    assert await _estados(cola) == {ANA: entregas.PENDIENTE}
    # Y no vuelve a salir hasta que toque: la pasada siguiente no la ve.
    assert (await despacho.vaciar())["intentadas"] == 0


@pytest.mark.asyncio
async def test_la_pasada_nunca_lanza(monkeypatch):
    def _sin_base():
        raise RuntimeError("sin base de datos")

    monkeypatch.setattr(database, "SessionLocal", _sin_base)
    assert await despacho.vaciar() is None


@pytest.mark.asyncio
async def test_sin_la_cola_desplegada_la_pasada_no_hace_nada(cola, monkeypatch):
    async def _no_hay(db) -> bool:
        return False

    monkeypatch.setattr(esquema, "hay_entregas", _no_hay)
    assert await despacho.vaciar() is None


# --------------------------------------------------------------------------- #
# 4. De punta a punta, y los dos sitios que lo disparan
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_de_la_peticion_al_telefono(cola, expo):
    """Lo que pasa en producción: la petición encola y confirma, `get_db` la
    cierra y el aviso sale solo, sin que nadie llame a nada más."""
    despacho.encender()

    peticion = database.get_db()
    db = await peticion.__anext__()
    await entregas.encolar(db, usuario_id=ANA, tipo=TIPO, entidad_id="postulacion-1")
    await db.commit()
    assert expo == [], "se envió antes de terminar la petición"
    with pytest.raises(StopAsyncIteration):
        await peticion.__anext__()

    await asyncio.gather(*list(despacho._tareas))
    assert [m["to"] for m in expo] == ["ExponentPushToken[ana]"]
    assert await _estados(cola) == {ANA: entregas.ENVIADA}


def test_el_planificador_programa_la_pasada_y_no_la_espera():
    """EventBridge corta la llamada a los cinco segundos: los reintentos se
    programan, no se esperan."""
    fuente = inspect.getsource(procesos_router.correr)
    assert "despacho.despachar()" in fuente
    assert "await despacho" not in fuente
    # Después de los dos barridos: lo que recuerden ya está en la cola.
    assert fuente.index("atencion.tareas(db)") < fuente.index("despacho.despachar()")


def test_solo_despacha_el_proceso_que_sirve():
    """Lo enciende el arranque de la aplicación y lo apaga su cierre."""
    from app import main

    fuente = inspect.getsource(main.lifespan)
    assert fuente.index("despacho.encender()") < fuente.index("yield") < fuente.index("despacho.apagar()")
    assert "finally:" in fuente


def test_la_sesion_de_la_peticion_es_quien_avisa():
    fuente = inspect.getsource(database.get_db)
    assert fuente.index("yield session") < fuente.index("despacho.tras_la_peticion(session)")
