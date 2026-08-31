"""Publicar un curso y que se pueda ENCONTRAR y RECOMENDAR, sin esperar.

REPRODUCE EL CASO REAL, no una aproximacion: una persona crea un curso, lo
etiqueta, lo publica por la misma URL que usa la aplicacion, y OTRA persona lo
busca escribiendo palabras del tema —«quiero aprender a fabricar muebles»— sin
haber cargado nunca ese curso en su telefono.

DOS COSAS DISTINTAS SE COMPRUEBAN AQUI, y conviene no mezclarlas:

  1. LA BUSQUEDA. No tiene memoria: pregunta a la base en cada consulta. Lo que
     se fija es que un curso publicado hace un segundo salga por TEMA, y que
     mientras era borrador no saliera. La busqueda tiene que funcionar aunque el
     recomendador falle, asi que se comprueba por su cuenta.

  2. EL RECOMENDADOR. Si tiene memoria corta y por PERSONA. Ese es el fallo que
     se arregla: la memoria se invalidaba solo para el AUTOR, y sus propios
     cursos estan excluidos de sus propias recomendaciones, asi que invalidar al
     autor no servia para nada. Para todos los demas el curso recien publicado
     no existia hasta que su entrada caducara sola —hasta un minuto—, que es
     justo el minuto en el que el autor mira si funciono.

Se comprueba pidiendo las recomendaciones ANTES de publicar (para que quede una
entrada guardada) y otra vez DESPUES. Sin la invalidacion, la segunda respuesta
es la primera repetida.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.catalog.models import Course
from app.modules.learning.models import CourseLesson, CourseModule
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.modules.recommendations.models import CourseTopic, Topic, UserTopicRelation
from app.shared.database import Base, get_db

BUSCAR = "/api/v1/search"
RECOMENDADOS = "/api/v1/recommendations/courses"
CATALOGO = "/api/v1/catalog/courses"

CARPINTERIA = "eeeeeeee-1111-0000-0000-000000000001"
COCINA = "eeeeeeee-1111-0000-0000-000000000002"

#: Quien publica el curso.
CARLOS = "eeeeeeee-0000-0000-0000-000000000001"
#: Quien lo busca. Nunca ha cargado ese curso en su telefono.
ANA = "eeeeeeee-0000-0000-0000-000000000002"

CURSO = "eeeeeeee-2222-0000-0000-000000000001"
MODULO = "eeeeeeee-3333-0000-0000-000000000001"
LECCION = "eeeeeeee-4444-0000-0000-000000000001"

#: La consulta del caso de referencia del proyecto. Ni «carpinteria» ni el
#: titulo del curso aparecen en ella: llega por el vocabulario de temas.
LA_CONSULTA = "quiero aprender a fabricar muebles"


@pytest_asyncio.fixture
async def entorno():
    cache.vaciar()
    esquema.olvidar()

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        from app.modules.bookings import models as _b  # noqa: F401
        from app.modules.catalog import models as _c  # noqa: F401
        from app.modules.communities import models as _co  # noqa: F401
        from app.modules.content import models as _ct  # noqa: F401
        from app.modules.learning import models as _l  # noqa: F401
        from app.modules.messaging import models as _m  # noqa: F401
        from app.modules.moderation import models as _mo  # noqa: F401
        from app.modules.notifications import device_tokens as _dt  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.recommendations import models as _r  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add_all(
            [
                Topic(id=CARPINTERIA, slug="carpinteria", name="Carpintería", position=1),
                Topic(id=COCINA, slug="cocina", name="Cocina", position=2),
                Profile(id=CARLOS, full_name="Carlos Vega", username="carlos"),
                Profile(id=ANA, full_name="Ana Torres", username="ana"),
                # Ana declara que quiere aprender carpinteria. Es lo que hace
                # que el recomendador tenga algo con lo que encajar el curso.
                UserTopicRelation(
                    user_id=ANA, topic_id=CARPINTERIA, relation="learn"
                ),
            ]
        )
        # El curso, en BORRADOR. Con todo lo que exige publicar: titulo,
        # descripcion larga, un tema, un modulo y una leccion. Gratuito y sin
        # muestras, para que no entren ademas los requisitos de cobro.
        db.add(
            Course(
                id=CURSO,
                author_id=CARLOS,
                title="Muebles de madera a medida",
                description=(
                    "Aprende a diseñar y construir muebles resistentes con "
                    "herramientas de taller y acabados duraderos."
                ),
                status="draft",
                price_minor=0,
                currency="PEN",
                highlights=["Construir una mesa desde cero"],
            )
        )
        db.add(CourseModule(id=MODULO, course_id=CURSO, title="Empezar", sort_order=0))
        db.add(
            CourseLesson(
                id=LECCION, module_id=MODULO, title="La madera", sort_order=0
            )
        )
        db.add(CourseTopic(course_id=CURSO, topic_id=CARPINTERIA, source="manual"))
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
        yield http, identidad
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    await engine.dispose()
    esquema.olvidar()


async def _publicar(http, identidad) -> dict:
    """Publica el curso por la MISMA URL que usa la aplicacion."""
    identidad["uid"] = CARLOS
    respuesta = await http.post(f"{CATALOGO}/{CURSO}/publish")
    identidad["uid"] = ANA
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


# --------------------------------------------------------------------------- #
# La busqueda
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_borrador_no_se_encuentra(entorno):
    """Un curso a medias es de su autor y de nadie mas, tampoco de el."""
    http, _ = entorno
    datos = (await http.get(BUSCAR, params={"q": LA_CONSULTA})).json()
    assert [c["id"] for c in datos["courses"]] == []


@pytest.mark.asyncio
async def test_al_publicarlo_se_encuentra_por_el_tema(entorno):
    """EL CASO DE LA QUEJA. Ni «carpinteria» ni el titulo estan en la consulta.

    «muebles» lleva a `carpinteria` por el vocabulario, y `carpinteria` es un id
    que se cruza contra `course_topics`. Y la persona que busca NO tiene ese
    curso descargado: sale de la base, que es donde estan todas las filas.
    """
    http, identidad = entorno
    resultado = await _publicar(http, identidad)
    assert resultado["published"] is True, resultado

    datos = (await http.get(BUSCAR, params={"q": LA_CONSULTA})).json()
    assert CURSO in [c["id"] for c in datos["courses"]]
    # Y se dice POR QUE se encontro: sin esa linea, encontrar carpinteria
    # escribiendo «muebles» se lee como un fallo.
    assert "carpinteria" in [t["slug"] for t in datos["topics"]]


@pytest.mark.asyncio
async def test_tambien_se_encuentra_sin_sesion(entorno):
    """Buscar no exige cuenta, igual que el muro se lee sin cuenta."""
    http, identidad = entorno
    await _publicar(http, identidad)

    app.dependency_overrides[get_optional_user] = lambda: None
    try:
        datos = (await http.get(BUSCAR, params={"q": LA_CONSULTA})).json()
    finally:
        app.dependency_overrides.pop(get_optional_user, None)
    assert CURSO in [c["id"] for c in datos["courses"]]


@pytest.mark.asyncio
async def test_la_busqueda_no_depende_de_que_el_recomendador_acierte(entorno):
    """Buscar por el TITULO funciona aunque la capa de temas no aporte nada."""
    http, identidad = entorno
    await _publicar(http, identidad)
    datos = (await http.get(BUSCAR, params={"q": "muebles de madera"})).json()
    assert CURSO in [c["id"] for c in datos["courses"]]


# --------------------------------------------------------------------------- #
# El recomendador
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_curso_recien_publicado_entra_en_recomendaciones_al_momento(entorno):
    """EL FALLO DE LA MEMORIA CORTA, reproducido de principio a fin.

    La primera peticion deja una entrada guardada para Ana. Si publicar no la
    invalidara, la segunda devolveria esa misma respuesta —sin el curso— durante
    hasta un minuto. Invalidar solo al AUTOR no valia: sus cursos ni siquiera
    entran en sus propias recomendaciones.
    """
    http, identidad = entorno

    antes = (await http.get(RECOMENDADOS)).json()
    assert CURSO not in [c["id"] for c in antes["items"]]

    await _publicar(http, identidad)

    despues = (await http.get(RECOMENDADOS)).json()
    assert CURSO in [c["id"] for c in despues["items"]]


@pytest.mark.asyncio
async def test_retirarlo_lo_saca_de_las_recomendaciones_al_momento(entorno):
    """La otra mitad: seguir recomendando lo retirado manda a una puerta cerrada."""
    http, identidad = entorno
    await _publicar(http, identidad)
    assert CURSO in [c["id"] for c in (await http.get(RECOMENDADOS)).json()["items"]]

    identidad["uid"] = CARLOS
    respuesta = await http.post(f"{CATALOGO}/{CURSO}/unpublish")
    identidad["uid"] = ANA
    assert respuesta.status_code == 200, respuesta.text

    assert CURSO not in [c["id"] for c in (await http.get(RECOMENDADOS)).json()["items"]]


@pytest.mark.asyncio
async def test_su_autor_no_se_recomienda_su_propio_curso(entorno):
    """Que Z le descubra a alguien su propio curso no le aporta nada.

    Va aqui, junto a lo anterior, porque es la razon por la que invalidar solo
    al autor no arreglaba nada: para el, ese curso nunca fue un candidato.
    """
    http, identidad = entorno
    await _publicar(http, identidad)

    identidad["uid"] = CARLOS
    mios = (await http.get(RECOMENDADOS)).json()
    assert CURSO not in [c["id"] for c in mios["items"]]
