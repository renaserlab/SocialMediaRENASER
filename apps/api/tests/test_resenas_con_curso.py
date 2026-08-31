"""De que curso habla una resena (migracion 0041), y por que no vale cualquiera.

QUE SE ANADE. Una resena puede decir, OPCIONALMENTE, sobre que curso de la
persona resenada habla. Hoy no podia: «me ayudo muchisimo» no distingue si fue
en una sesion 1:1, en su podcast o en un programa concreto, y quien lee un perfil
con cinco cursos no sabe cual se esta valorando.

LO QUE ESTAS PRUEBAS FIJAN, y es la parte que no puede vivir en el formulario:

  * que el curso lo valide el SERVIDOR contra la base y no se fie del cliente —no
    basta con que sea un uuid, tiene que ser un curso REAL y ADEMAS de la persona
    resenada—,
  * que sin la migracion 0041 aplicada NO se rompa nada: la resena se publica
    igual y el enlace se ignora en silencio, porque perder una opinion ya escrita
    por un adorno seria peor que publicarla sin el,
  * y que las resenas que ya existen sigan valiendo exactamente igual.

POR QUE ES UNA TABLA APARTE Y NO UNA COLUMNA `course_id` EN `profile_reviews`:
ver la cabecera de la migracion 0041 y `ReviewCourse` en `reviews/models.py`. En
corto: `select(ProfileReview)` pide TODAS las columnas mapeadas, asi que una
columna de mas en el modelo revienta contra la base real mientras la migracion
espera aprobacion — y un 500 sin cabeceras CORS se lee en el navegador como un
fallo de red.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.catalog.models import Course
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.reviews.models import ReviewCourse
from app.shared.database import Base, get_db

API = "/api/v1/reviews"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"    # escribe la resena
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"  # la recibe, y tiene cursos
CARLA = "aaaaaaaa-0000-0000-0000-000000000003"  # tiene OTRO curso

CURSO_DE_BRUNO = "bbbbbbbb-0000-0000-0000-000000000001"
OTRO_DE_BRUNO = "bbbbbbbb-0000-0000-0000-000000000002"
CURSO_DE_CARLA = "bbbbbbbb-0000-0000-0000-000000000003"
INEXISTENTE = "bbbbbbbb-0000-0000-0000-0000000000ff"


async def _montar(con_0041: bool):
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
        if not con_0041:
            # Se DESHACE la 0041, para dejar la base como esta hoy produccion.
            await conn.execute(text("drop table review_course"))

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(Profile(id=CARLA, full_name="Carla", username="carla"))
        db.add(Course(id=CURSO_DE_BRUNO, author_id=BRUNO, title="Liderazgo"))
        db.add(Course(id=OTRO_DE_BRUNO, author_id=BRUNO, title="Finanzas"))
        db.add(Course(id=CURSO_DE_CARLA, author_id=CARLA, title="Oratoria"))
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
    return engine, sesiones, identidad


async def _desmontar(engine) -> None:
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    esquema.olvidar()
    await engine.dispose()


@pytest_asyncio.fixture
async def entorno():
    engine, sesiones, identidad = await _montar(con_0041=True)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad
    await _desmontar(engine)


@pytest_asyncio.fixture
async def entorno_sin_0041():
    engine, sesiones, identidad = await _montar(con_0041=False)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad
    await _desmontar(engine)


def codigo(respuesta) -> str:
    return respuesta.json()["error"]["code"]


# --------------------------------------------------------------------------- #
# 1. El caso normal
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_resena_puede_decir_de_que_curso_habla(entorno):
    http, _, _ = entorno
    creada = await http.post(
        API,
        json={
            "reviewed_user_id": BRUNO,
            "body": "El módulo de equipos me cambió la forma de dirigir.",
            "course_id": CURSO_DE_BRUNO,
        },
    )
    assert creada.status_code == 201, creada.text
    assert creada.json()["course_id"] == CURSO_DE_BRUNO
    # El TITULO lo resuelve el servidor. Sin el, la tarjeta tendria que pedir el
    # curso por separado —una peticion por resena— solo para pintar un rotulo.
    assert creada.json()["course_title"] == "Liderazgo"

    # Y sale igual al leerla desde el perfil de Bruno, que es donde se lee.
    recibidas = await http.get(f"{API}/received/{BRUNO}")
    assert recibidas.json()[0]["course_title"] == "Liderazgo"


@pytest.mark.asyncio
async def test_el_curso_es_opcional_y_no_llevarlo_no_es_un_defecto(entorno):
    """La inmensa mayoria de las resenas no hablan de ningun curso."""
    http, _, _ = entorno
    creada = await http.post(
        API, json={"reviewed_user_id": BRUNO, "body": "Gran persona."}
    )
    assert creada.status_code == 201
    assert creada.json()["course_id"] is None
    assert creada.json()["course_title"] is None


# --------------------------------------------------------------------------- #
# 2. El servidor NO se fia del identificador que manda el cliente
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_no_vale_un_curso_de_otra_persona(entorno):
    """EL CASO QUE OBLIGA A VALIDAR CONTRA LA BASE.

    Si aqui bastara con que fuera un uuid, la opinion de Ana sobre Bruno podria
    colgar del curso de Carla: en el perfil de Carla apareceria como valoracion
    de su programa una resena que no habla de ella, y en el de Bruno un curso que
    no es suyo.
    """
    http, sesiones, _ = entorno
    respuesta = await http.post(
        API,
        json={
            "reviewed_user_id": BRUNO,
            "body": "Muy bueno.",
            "course_id": CURSO_DE_CARLA,
        },
    )
    assert respuesta.status_code == 422, respuesta.text
    assert codigo(respuesta) == "review_course_not_from_user"

    # Y NO deja rastro: se valida ANTES de escribir nada. Una resena a medias
    # —guardada pero sin su curso— seria peor que ninguna.
    async with sesiones() as db:
        assert (await db.scalars(select(ReviewCourse.review_id))).all() == []
    assert (await http.get(f"{API}/received/{BRUNO}")).json() == []


@pytest.mark.asyncio
async def test_un_curso_que_no_existe_es_404(entorno):
    http, _, _ = entorno
    respuesta = await http.post(
        API,
        json={
            "reviewed_user_id": BRUNO,
            "body": "Muy bueno.",
            "course_id": INEXISTENTE,
        },
    )
    assert respuesta.status_code == 404, respuesta.text


@pytest.mark.asyncio
async def test_un_identificador_con_basura_es_404_y_no_un_500(entorno):
    """Sin `ensure_uuid`, la cadena llega al driver y sale como 500.

    Y un 500 de Starlette viaja SIN cabeceras CORS, asi que en el navegador se
    disfraza de fallo de red: horas buscando en el sitio equivocado.
    """
    http, _, _ = entorno
    respuesta = await http.post(
        API,
        json={"reviewed_user_id": BRUNO, "body": "Muy bueno.", "course_id": "no-soy-un-uuid"},
    )
    assert respuesta.status_code == 404, respuesta.text


# --------------------------------------------------------------------------- #
# 3. Cambiar de opinion sobre el curso
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_editar_puede_cambiar_el_curso_y_tambien_quitarlo(entorno):
    """`None` explicito QUITA el enlace; no mandarlo lo deja como estaba.

    Sin esa diferencia no habria forma de deshacer un curso elegido por error:
    las dos cosas —«no lo toques» y «quitalo»— llegarian igual al servidor.
    """
    http, _, _ = entorno
    creada = await http.post(
        API,
        json={
            "reviewed_user_id": BRUNO,
            "body": "Muy bueno.",
            "course_id": CURSO_DE_BRUNO,
        },
    )
    resena_id = creada.json()["id"]

    # Cambiarlo por otro suyo.
    cambiada = await http.patch(f"{API}/{resena_id}", json={"course_id": OTRO_DE_BRUNO})
    assert cambiada.status_code == 200, cambiada.text
    assert cambiada.json()["course_title"] == "Finanzas"

    # Editar SOLO el texto no lo toca.
    solo_texto = await http.patch(f"{API}/{resena_id}", json={"body": "Buenísimo."})
    assert solo_texto.json()["course_id"] == OTRO_DE_BRUNO

    # Y `null` explicito lo quita.
    sin_curso = await http.patch(f"{API}/{resena_id}", json={"course_id": None})
    assert sin_curso.json()["course_id"] is None
    assert sin_curso.json()["course_title"] is None


@pytest.mark.asyncio
async def test_al_editar_tampoco_vale_el_curso_de_otro(entorno):
    http, _, _ = entorno
    creada = await http.post(
        API, json={"reviewed_user_id": BRUNO, "body": "Muy bueno."}
    )
    respuesta = await http.patch(
        f"{API}/{creada.json()['id']}", json={"course_id": CURSO_DE_CARLA}
    )
    assert respuesta.status_code == 422
    assert codigo(respuesta) == "review_course_not_from_user"


# --------------------------------------------------------------------------- #
# 4. SIN la migracion 0041 no se rompe nada
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_la_0041_la_resena_se_publica_igual(entorno_sin_0041):
    """Desplegar esto no puede exigir que la migracion ya este puesta.

    Es la misma leccion cara que cuentan la 0027, la 0029, la 0030 y la 0033: se
    escribio codigo contra un esquema que no estaba aplicado y cada peticion que
    tocaba la tabla nueva reventaba con un 500.

    El enlace se ignora EN SILENCIO en vez de responder 503, y aqui esa
    diferencia importa: el curso es un adorno de la resena, y perder una opinion
    ya escrita por un adorno seria un intercambio pesimo. Los medios si dan 503,
    porque sin su tabla no tendrian donde guardarse.
    """
    http, _, _ = entorno_sin_0041
    creada = await http.post(
        API,
        json={
            "reviewed_user_id": BRUNO,
            "body": "Me ayudó muchísimo.",
            "course_id": CURSO_DE_BRUNO,
        },
    )
    assert creada.status_code == 201, creada.text
    assert creada.json()["body"] == "Me ayudó muchísimo."
    assert creada.json()["course_id"] is None

    # Y el listado responde, que es lo que reventaba antes de existir esta regla.
    recibidas = await http.get(f"{API}/received/{BRUNO}")
    assert recibidas.status_code == 200
    assert len(recibidas.json()) == 1


@pytest.mark.asyncio
async def test_sin_la_0041_no_se_ofrece_el_selector(entorno_sin_0041):
    """`courses_available` es lo que permite a la hoja no ensenar el selector.

    Pedir un dato que se va a tirar sin decirlo es peor que no pedirlo.
    """
    http, _, _ = entorno_sin_0041
    disponibilidad = (await http.get(f"{API}/availability")).json()
    assert disponibilidad["available"] is True
    assert disponibilidad["courses_available"] is False


@pytest.mark.asyncio
async def test_con_la_0041_si_se_ofrece(entorno):
    http, _, _ = entorno
    disponibilidad = (await http.get(f"{API}/availability")).json()
    assert disponibilidad["available"] is True
    assert disponibilidad["courses_available"] is True
