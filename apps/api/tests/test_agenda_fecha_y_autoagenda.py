"""Dos reglas que la agenda no tenia: ni consigo mismo, ni hacia atras.

QUE ESTABA ROTO.

  1. NADA impedia agendar para una fecha que YA HABIA PASADO. La fila se creaba,
     salia en la agenda de las dos partes y se podia aceptar. Peor: bastaba con
     pedir la sesion para manana y «reprogramarla» al mes pasado, porque el
     cambio de fecha no pasaba por ninguna comprobacion. Una agenda que admite
     fechas pasadas no es una agenda.

  2. La auto-agenda si estaba cortada, pero sin codigo de error propio, asi que
     la aplicacion no podia distinguirla de cualquier otro rechazo. Aqui se fija
     ademas por que no puede existir: una sesion donde quien pide y quien da son
     la misma cuenta se puede aceptar a si misma, completar sola, y acabar dando
     el sello de «interaccion verificada» a una resena que nadie ha vivido.

DONDE SE DECIDE. En el SERVIDOR, con el reloj del servidor. El del telefono lo
elige quien lo lleva: atrasarlo un dia seria todo lo que hace falta para colar
una fecha pasada si la comprobacion viviera alli. La aplicacion lo comprueba
tambien, pero solo para no dejar escribir algo que se va a rechazar.

Y SE COMPARAN INSTANTES, NUNCA CADENAS. «02/09/2026» y «2026-09-02» son la misma
fecha y dos textos distintos, y `'10:00' < '9:00'` es cierto como texto.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.bookings.models import Booking
from app.modules.bookings.schemas import es_momento_futuro
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.shared.database import Base, get_db

API = "/api/v1/bookings"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"    # pide la sesion
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"  # se la piden


# =========================================================================== #
# 1. La regla, en el limite exacto y sin esperar a que pase el tiempo
# =========================================================================== #
#
# `ahora` se pasa por parametro justamente para esto: probar el borde de una
# regla temporal esperando a que ocurra es una prueba lenta y ademas inestable.
AHORA = datetime(2026, 9, 1, 12, 0, 0, tzinfo=timezone.utc)


def test_un_segundo_despues_de_ahora_es_futuro():
    assert es_momento_futuro(AHORA + timedelta(seconds=1), AHORA)


def test_un_segundo_antes_de_ahora_ya_no_lo_es():
    assert not es_momento_futuro(AHORA - timedelta(seconds=1), AHORA)


def test_el_instante_exacto_de_ahora_no_cuenta_como_futuro():
    """El borde se cierra hacia el pasado: `>` y no `>=`.

    Una sesion «para ahora mismo» no se puede preparar ni avisar, y dejar el
    borde abierto significaria aceptar todo lo que llegue con el mismo segundo
    del reloj — que en PostgreSQL, con microsegundos, casi nunca es lo mismo.
    """
    assert not es_momento_futuro(AHORA, AHORA)


def test_sin_fecha_no_hay_nada_que_validar():
    """Acordarla por chat es legitimo: es lo unico que habia antes del selector."""
    assert es_momento_futuro(None, AHORA)


def test_la_zona_horaria_decide_y_no_la_hora_escrita():
    """LAS 13:00 DE LIMA Y LAS 13:00 DE MADRID SON MOMENTOS DISTINTOS.

    Escritas son la MISMA cadena, y comparando texto darian el mismo resultado.
    Comparando instantes contra las 12:00 UTC, la de Madrid (UTC+2) ya paso y la
    de Lima (UTC-5) todavia no: exactamente la diferencia entre rechazar y
    aceptar. Es todo el motivo por el que aqui no se comparan fechas escritas.
    """
    lima = timezone(timedelta(hours=-5))
    madrid = timezone(timedelta(hours=2))
    # Las 13:00 en Madrid son las 11:00 UTC: ya pasaron.
    assert not es_momento_futuro(datetime(2026, 9, 1, 13, 0, tzinfo=madrid), AHORA)
    # Las 13:00 en Lima son las 18:00 UTC: todavia no.
    assert es_momento_futuro(datetime(2026, 9, 1, 13, 0, tzinfo=lima), AHORA)


def test_un_instante_sin_zona_se_lee_como_utc_y_no_revienta():
    """`datetime.now(utc) > naive` lanza TypeError, y eso seria un 500.

    Un 500 de Starlette viaja SIN cabeceras CORS, asi que en el navegador se
    disfraza de fallo de red. La aplicacion manda siempre UTC, pero un cliente
    que no sea el nuestro puede mandar un instante sin zona.
    """
    assert es_momento_futuro(datetime(2026, 9, 1, 12, 0, 1), AHORA)
    assert not es_momento_futuro(datetime(2026, 9, 1, 11, 59, 59), AHORA)


# =========================================================================== #
# 2. Los endpoints
# =========================================================================== #
@pytest_asyncio.fixture
async def entorno():
    esquema.olvidar()

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        from app.modules.bookings import models as _b  # noqa: F401
        from app.modules.catalog import models as _c  # noqa: F401
        from app.modules.communities import models as _co  # noqa: F401
        from app.modules.content import models as _ct  # noqa: F401
        from app.modules.learning import models as _l  # noqa: F401
        from app.modules.live import models as _li  # noqa: F401
        from app.modules.messaging import models as _m  # noqa: F401
        from app.modules.moderation import models as _mo  # noqa: F401
        from app.modules.notifications import device_tokens as _dt  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.reviews import models as _r  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        await db.commit()

    identidad = {"uid": ANA}

    async def _db_override():
        async with sesiones() as session:
            yield session

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    app.dependency_overrides[get_optional_user] = _usuario_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    esquema.olvidar()
    await engine.dispose()


def codigo(respuesta) -> str:
    return respuesta.json()["error"]["code"]


def _dentro_de(**kwargs) -> str:
    return (datetime.now(timezone.utc) + timedelta(**kwargs)).isoformat()


def _hace(**kwargs) -> str:
    return (datetime.now(timezone.utc) - timedelta(**kwargs)).isoformat()


async def _contar(sesiones) -> int:
    async with sesiones() as db:
        return await db.scalar(select(func.count()).select_from(Booking)) or 0


# --------------------------------------------------------------------------- #
# 2.a Nadie se agenda consigo mismo
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_nadie_se_agenda_una_sesion_consigo_mismo(entorno):
    http, sesiones, _ = entorno
    respuesta = await http.post(
        API,
        json={"provider_id": ANA, "topic": "Conmigo", "scheduled_at": _dentro_de(days=1)},
    )
    assert respuesta.status_code == 422, respuesta.text
    assert codigo(respuesta) == "booking_self_not_allowed"
    # Y no deja rastro: la fila ni se intenta.
    assert await _contar(sesiones) == 0


# --------------------------------------------------------------------------- #
# 2.b Ni hacia atras
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_no_se_agenda_para_una_fecha_que_ya_paso(entorno):
    http, sesiones, _ = entorno
    respuesta = await http.post(
        API,
        json={"provider_id": BRUNO, "topic": "Ayer", "scheduled_at": _hace(days=1)},
    )
    assert respuesta.status_code == 422, respuesta.text
    assert codigo(respuesta) == "booking_date_in_past"
    assert await _contar(sesiones) == 0


@pytest.mark.asyncio
async def test_un_segundo_en_el_pasado_ya_se_rechaza(entorno):
    """El limite exacto, contra el reloj del SERVIDOR."""
    http, _, _ = entorno
    respuesta = await http.post(
        API,
        json={"provider_id": BRUNO, "topic": "Casi", "scheduled_at": _hace(seconds=1)},
    )
    assert respuesta.status_code == 422
    assert codigo(respuesta) == "booking_date_in_past"


@pytest.mark.asyncio
async def test_una_fecha_futura_se_acepta(entorno):
    http, _, _ = entorno
    respuesta = await http.post(
        API,
        json={"provider_id": BRUNO, "topic": "Mañana", "scheduled_at": _dentro_de(days=1)},
    )
    assert respuesta.status_code == 201, respuesta.text


@pytest.mark.asyncio
async def test_sin_fecha_se_sigue_pudiendo_pedir(entorno):
    """Se acuerda por chat. Es el caso que existia antes del selector y sigue
    valiendo: exigir fecha aqui romperia lo que ya funcionaba."""
    http, _, _ = entorno
    respuesta = await http.post(API, json={"provider_id": BRUNO, "topic": "Cuando puedas"})
    assert respuesta.status_code == 201, respuesta.text
    assert respuesta.json()["scheduled_at"] is None


# --------------------------------------------------------------------------- #
# 2.c Reprogramar tampoco es una puerta trasera
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_reprogramar_al_pasado_se_rechaza(entorno):
    """EL AGUJERO QUE QUEDABA. Sin esto bastaba con pedir la sesion para manana
    y «reprogramarla» al mes pasado: la comprobacion de crear se saltaba en un
    paso."""
    http, sesiones, identidad = entorno
    creada = await http.post(
        API,
        json={"provider_id": BRUNO, "topic": "Mañana", "scheduled_at": _dentro_de(days=1)},
    )
    reserva_id = creada.json()["id"]

    respuesta = await http.patch(
        f"{API}/{reserva_id}",
        json={"status": "reschedule_requested", "scheduled_at": _hace(days=30)},
    )
    assert respuesta.status_code == 422, respuesta.text
    assert codigo(respuesta) == "booking_date_in_past"

    # Y la reserva se queda como estaba: ni la fecha ni el estado cambian.
    async with sesiones() as db:
        reserva = await db.get(Booking, reserva_id)
        assert reserva.status == "pending"


@pytest.mark.asyncio
async def test_reprogramar_hacia_adelante_si_vale(entorno):
    http, _, identidad = entorno
    creada = await http.post(
        API,
        json={"provider_id": BRUNO, "topic": "Mañana", "scheduled_at": _dentro_de(days=1)},
    )
    respuesta = await http.patch(
        f"{API}/{creada.json()['id']}",
        json={"status": "reschedule_requested", "scheduled_at": _dentro_de(days=8)},
    )
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["status"] == "reschedule_requested"


@pytest.mark.asyncio
async def test_completar_una_sesion_que_ya_ocurrio_sigue_siendo_posible(entorno):
    """LO QUE NO SE PUEDE ROMPER AL ARREGLAR LO ANTERIOR.

    Dar por hecha una sesion es hablar del PASADO por definicion. Si la
    comprobacion de fecha se aplicara a cualquier peticion —y no solo a las que
    traen fecha nueva—, nadie podria marcar como completada una sesion que ya
    ocurrio... que es justamente lo que da el sello de «interaccion verificada»
    a una resena.
    """
    http, sesiones, identidad = entorno
    creada = await http.post(
        API,
        json={"provider_id": BRUNO, "topic": "Hoy", "scheduled_at": _dentro_de(minutes=5)},
    )
    reserva_id = creada.json()["id"]

    identidad["uid"] = BRUNO
    assert (
        await http.patch(f"{API}/{reserva_id}", json={"status": "accepted"})
    ).status_code == 200

    # La sesion ocurre y el tiempo pasa: la fecha queda atras.
    async with sesiones() as db:
        reserva = await db.get(Booking, reserva_id)
        reserva.scheduled_at = datetime.now(timezone.utc) - timedelta(hours=2)
        await db.commit()

    completada = await http.patch(f"{API}/{reserva_id}", json={"status": "completed"})
    assert completada.status_code == 200, completada.text
    assert completada.json()["status"] == "completed"
