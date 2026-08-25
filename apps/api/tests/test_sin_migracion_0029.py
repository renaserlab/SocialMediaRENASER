"""La aplicacion tiene que funcionar SIN la migracion 0029.

POR QUE ESTA PRUEBA EXISTE, Y ES LA MISMA LECCION QUE LA 0027 Y LA 0028. Se
escribio el codigo de la V1.1 contra un esquema que todavia no estaba aplicado y
la rama entera dejo de funcionar contra la base real: cada peticion que tocaba
`post_topics` reventaba con un 500 que el navegador reportaba como error de
CORS, porque Starlette no anade cabeceras CORS a una excepcion sin capturar.
Horas buscando en el sitio equivocado.

La regla del proyecto: desplegar codigo no puede exigir que una migracion
concreta ya este puesta, y una vuelta atras no puede tumbar la aplicacion. Con
la 0029 hay transmisiones en vivo; sin ella, no las hay, y eso se dice.

QUE CAMBIA SIN LA 0029:

- El listado de emisiones responde VACIO. No es un error: «no hay emisiones» es
  exactamente lo que significa una lista vacia, y es la verdad.
- El historial de chat de cualquier emision responde vacio por lo mismo.
- Crear una emision responde 503 con `live_not_available`: la funcion existe
  pero todavia no esta montada. 503 y no 404, que haria pensar que la ruta esta
  mal escrita.
- Lo demas de la aplicacion sigue igual, que es el punto entero de la regla.

COMO SE COMPRUEBA. Se crea el esquema entero y despues se QUITAN las tres tablas
que anade la 0029, dejando la base exactamente como esta hoy produccion.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.live import limites
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

LIVE = "/api/v1/live"
CATALOGO = "/api/v1/catalog"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"

#: Una emision que no existe porque no puede existir: sin tablas no hay ninguna.
#: Tiene que ser un uuid valido para que lo que se compruebe sea la falta de
#: esquema y no la validacion del identificador.
EMISION = "eeeeeeee-0000-0000-0000-000000000001"


@pytest_asyncio.fixture
async def base_sin_0029():
    """El esquema tal y como esta HOY en produccion: sin las tablas de directo."""
    cache.vaciar()
    esquema.olvidar()
    limites.vaciar()

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
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

        # Y ahora se DESHACE la 0029, que es lo que se quiere probar. Primero
        # las que dependen de la sala, para no dejar referencias colgando.
        await conn.execute(text("drop table live_reaction_totals"))
        await conn.execute(text("drop table live_messages"))
        await conn.execute(text("drop table live_sessions"))

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

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
    limites.vaciar()
    await engine.dispose()


def codigo(respuesta) -> str:
    return respuesta.json()["error"]["code"]


# --------------------------------------------------------------------------- #
# Lo que reventaria
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_listado_de_emisiones_responde_vacio_y_no_revienta(base_sin_0029):
    """Una lista vacia no es un error: es que nadie esta emitiendo, que sin las
    tablas es literalmente cierto. Un 500 aqui saldria en el movil como un fallo
    de red y mandaria a buscar al sitio equivocado."""
    http, _, _ = base_sin_0029
    respuesta = await http.get(f"{LIVE}/sessions")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json() == []


@pytest.mark.asyncio
async def test_el_listado_tampoco_revienta_pidiendo_las_terminadas(base_sin_0029):
    http, _, _ = base_sin_0029
    respuesta = await http.get(f"{LIVE}/sessions", params={"include_ended": True})
    assert respuesta.status_code == 200
    assert respuesta.json() == []


@pytest.mark.asyncio
async def test_el_historial_de_chat_responde_vacio(base_sin_0029):
    """Por la misma razon que el listado: no hay mensajes porque no hay donde
    guardarlos, y eso es exactamente lo que dice una lista vacia."""
    http, _, _ = base_sin_0029
    respuesta = await http.get(f"{LIVE}/sessions/{EMISION}/messages")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json() == []


@pytest.mark.asyncio
async def test_crear_una_emision_responde_503(base_sin_0029):
    """503 y no 404: la funcion existe, lo que falta es que este montada. Un 404
    haria pensar que la ruta esta mal escrita y se buscaria en el cliente."""
    http, _, _ = base_sin_0029
    respuesta = await http.post(f"{LIVE}/sessions", json={"title": "Directo"})
    assert respuesta.status_code == 503, respuesta.text
    assert codigo(respuesta) == "live_not_available"


@pytest.mark.asyncio
async def test_todo_lo_que_escribe_responde_503_y_no_500(base_sin_0029):
    """Ninguna de estas puede acabar en una excepcion sin capturar: el 500 se
    queda sin cabeceras CORS y el fallo de esquema se disfraza de fallo de red."""
    http, _, _ = base_sin_0029
    peticiones = [
        http.get(f"{LIVE}/sessions/{EMISION}"),
        http.patch(f"{LIVE}/sessions/{EMISION}", json={"title": "Otro"}),
        http.post(f"{LIVE}/sessions/{EMISION}/start"),
        http.post(f"{LIVE}/sessions/{EMISION}/end"),
        http.post(f"{LIVE}/sessions/{EMISION}/cancel"),
        http.post(f"{LIVE}/sessions/{EMISION}/viewers", params={"count": 3}),
        http.post(f"{LIVE}/sessions/{EMISION}/messages", json={"body": "hola"}),
        http.post(
            f"{LIVE}/sessions/{EMISION}/reactions", json={"counts": {"corazon": 1}}
        ),
        http.post(f"{LIVE}/sessions/{EMISION}/credential"),
    ]
    for peticion in peticiones:
        respuesta = await peticion
        assert respuesta.status_code == 503, respuesta.text
        assert codigo(respuesta) == "live_not_available"


@pytest.mark.asyncio
async def test_esconder_un_mensaje_tampoco_revienta(base_sin_0029):
    http, _, _ = base_sin_0029
    respuesta = await http.post(f"{LIVE}/messages/{EMISION}/hide")
    assert respuesta.status_code == 503
    assert codigo(respuesta) == "live_not_available"


@pytest.mark.asyncio
async def test_el_esquema_se_detecta_una_sola_vez(base_sin_0029):
    """La comprobacion no puede costar una consulta por peticion: se hace una
    vez por proceso y se recuerda, por eso la 0029 pide reiniciar la API."""
    http, _, _ = base_sin_0029
    esquema.olvidar()

    await http.get(f"{LIVE}/sessions")
    assert esquema._cache.get("live_sessions") is False
    await http.get(f"{LIVE}/sessions")
    assert esquema._cache.get("live_sessions") is False


# --------------------------------------------------------------------------- #
# Y el resto de la aplicacion, intacto
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_resto_de_la_aplicacion_sigue_funcionando(base_sin_0029):
    """El punto entero de la regla: quitar la 0029 quita los directos y NADA
    mas. Si tumbara el catalogo, una vuelta atras dejaria la app inservible."""
    http, _, _ = base_sin_0029
    assert (await http.get("/health")).status_code == 200
    assert (await http.get(f"{CATALOGO}/courses")).status_code == 200
