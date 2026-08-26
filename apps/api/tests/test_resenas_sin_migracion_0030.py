"""La aplicacion tiene que funcionar SIN la migracion 0030.

POR QUE ESTA PRUEBA EXISTE, Y ES LA MISMA LECCION QUE LA 0027, LA 0028 Y LA
0029. Se escribio codigo contra un esquema que todavia no estaba aplicado y la
rama entera dejo de funcionar contra la base real: cada peticion que tocaba la
tabla que faltaba reventaba con un 500 que el navegador reportaba como error de
CORS, porque Starlette NO anade cabeceras CORS a una excepcion sin capturar. Un
fallo de esquema disfrazado de fallo de red: horas buscando donde no era.

La regla del proyecto: desplegar codigo no puede exigir que una migracion
concreta ya este puesta. La 0030 no se aplicara hasta que la apruebe una
persona, y este modulo tiene que poder estar en produccion HOY.

QUE CAMBIA SIN LA 0030:

- Las resenas recibidas de cualquier perfil responden VACIO. No es un error:
  «todavia no le ha escrito nadie» es exactamente lo que significa una lista
  vacia, y sin la tabla es literalmente cierto.
- `/reviews/mine` responde vacio por lo mismo.
- `/reviews/availability` responde `false`, que es lo que permite a la
  aplicacion NO ensenar el boton «Escribir resena» en vez de ofrecerlo y fallar
  al pulsarlo.
- Publicar, editar, borrar y esconder responden 503 con `reviews_not_available`:
  la funcion existe, lo que falta es que este montada. 503 y no 404, que haria
  pensar que la ruta esta mal escrita y se buscaria en el cliente.
- LO DEMAS DE LA APLICACION SIGUE IGUAL, que es el punto entero de la regla.
  `testimonials` incluida: la galeria de los perfiles no depende de esto.

COMO SE COMPRUEBA. Se crea el esquema entero y despues se QUITAN las dos tablas
que anade la 0030, dejando la base exactamente como esta hoy produccion.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

API = "/api/v1/reviews"
CATALOGO = "/api/v1/catalog"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"

#: Una resena que no existe porque no puede existir: sin tabla no hay ninguna.
#: Tiene que ser un uuid valido para que lo que se compruebe sea la falta de
#: esquema y no la validacion del identificador.
RESENA = "eeeeeeee-0000-0000-0000-000000000001"


@pytest_asyncio.fixture
async def base_sin_0030():
    """El esquema tal y como esta HOY en produccion: sin las tablas de resena."""
    cache.vaciar()
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

        # Y ahora se DESHACE la 0030, que es lo que se quiere probar. Primero
        # los archivos, que dependen de la resena, para no dejar referencias
        # colgando.
        await conn.execute(text("drop table review_media"))
        await conn.execute(text("drop table profile_reviews"))

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
    await engine.dispose()


def codigo(respuesta) -> str:
    return respuesta.json()["error"]["code"]


# --------------------------------------------------------------------------- #
# Lo que reventaria
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_las_resenas_de_un_perfil_responden_vacio_y_no_revientan(base_sin_0030):
    """Un 500 aqui saldria en el movil como un fallo de red y mandaria a buscar
    al sitio equivocado. Una lista vacia dice la verdad: no hay ninguna."""
    respuesta = await base_sin_0030[0].get(f"{API}/received/{BRUNO}")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json() == []


@pytest.mark.asyncio
async def test_las_mias_tambien_responden_vacio(base_sin_0030):
    respuesta = await base_sin_0030[0].get(f"{API}/mine")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json() == []


@pytest.mark.asyncio
async def test_la_disponibilidad_dice_que_no(base_sin_0030):
    """Es lo que permite a la aplicacion no ensenar el boton de escribir.
    Ofrecerlo y responder 503 al pulsarlo es la misma pantalla cargando de
    siempre, solo que con otro motivo."""
    respuesta = await base_sin_0030[0].get(f"{API}/availability")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json() == {"available": False}


@pytest.mark.asyncio
async def test_todo_lo_que_escribe_responde_503_y_no_500(base_sin_0030):
    """Ninguna de estas puede acabar en una excepcion sin capturar."""
    http = base_sin_0030[0]
    peticiones = [
        http.post(API, json={"reviewed_user_id": BRUNO, "body": "Muy bien."}),
        http.patch(f"{API}/{RESENA}", json={"body": "Otro texto."}),
        http.delete(f"{API}/{RESENA}"),
        http.post(f"{API}/{RESENA}/hide"),
    ]
    for peticion in peticiones:
        respuesta = await peticion
        assert respuesta.status_code == 503, respuesta.text
        assert codigo(respuesta) == "reviews_not_available"


@pytest.mark.asyncio
async def test_la_autoresena_sigue_prohibida_aunque_no_haya_tabla(base_sin_0030):
    """El orden importa: se comprueba el esquema ANTES que la autoresena, asi
    que aqui gana el 503. Lo que no puede pasar es que sin tabla se cuele algo
    que con tabla se rechaza."""
    respuesta = await base_sin_0030[0].post(
        API, json={"reviewed_user_id": ANA, "body": "Sobre mí."}
    )
    assert respuesta.status_code in (422, 503)
    assert codigo(respuesta) in ("review_self_not_allowed", "reviews_not_available")


@pytest.mark.asyncio
async def test_el_esquema_se_detecta_una_sola_vez(base_sin_0030):
    """La comprobacion no puede costar una consulta por peticion: se hace una
    vez por proceso y se recuerda, por eso la 0030 pide reiniciar la API."""
    http = base_sin_0030[0]
    esquema.olvidar()

    await http.get(f"{API}/received/{BRUNO}")
    assert esquema._cache.get("profile_reviews") is False
    await http.get(f"{API}/received/{BRUNO}")
    assert esquema._cache.get("profile_reviews") is False


# --------------------------------------------------------------------------- #
# Y el resto de la aplicacion, intacto
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_resto_de_la_aplicacion_sigue_funcionando(base_sin_0030):
    """El punto entero de la regla: quitar la 0030 quita las resenas y NADA
    mas. Si tumbara el catalogo, una vuelta atras dejaria la app inservible."""
    http = base_sin_0030[0]
    assert (await http.get("/health")).status_code == 200
    assert (await http.get(f"{CATALOGO}/courses")).status_code == 200
