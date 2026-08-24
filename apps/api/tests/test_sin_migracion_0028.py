"""La aplicacion tiene que funcionar SIN la migracion 0028.

POR QUE ESTA PRUEBA EXISTE, Y ES LA MISMA LECCION QUE LA 0027. Se escribio el
codigo de la V1.1 contra un esquema que todavia no estaba aplicado y la rama
entera dejo de funcionar contra la base real: cada peticion que tocaba
`post_topics` reventaba con un 500 que el navegador reportaba como error de
CORS, porque Starlette no anade cabeceras CORS a una excepcion sin capturar.
Horas buscando en el sitio equivocado.

La regla del proyecto: desplegar codigo no puede exigir que una migracion
concreta ya este puesta, y una vuelta atras no puede tumbar la aplicacion. Con
la 0028 se hacen mas cosas; sin ella, las de antes.

QUE CAMBIA SIN LA 0028:

- Un curso no puede llevar temas. Se crea y se edita igual; los temas se
  descartan y se dice que estan vacios, que es la verdad.
- Publicar NO exige un tema, porque exigir algo imposible dejaria el catalogo
  congelado.
- «Cursos para ti» no es una superficie que la base admita, asi que una
  impresion de esa seccion se guarda SIN contexto en vez de tumbar la peticion.

COMO SE COMPRUEBA. Se crea el esquema entero y despues se QUITA lo que anade la
0028, dejando la base exactamente como esta hoy produccion.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.learning.models import CourseLesson, CourseModule
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.modules.recommendations.models import BehaviorEvent, Topic
from app.shared.database import Base, get_db

CATALOGO = "/api/v1/catalog"
LEARNING = "/api/v1/learning"
RECOMENDACIONES = "/api/v1/recommendations"

IA = "11111111-1111-1111-1111-111111111111"
ANA = "aaaaaaaa-0000-0000-0000-000000000001"
PEDRO = "aaaaaaaa-0000-0000-0000-000000000002"


@pytest_asyncio.fixture
async def base_sin_0028():
    """El esquema tal y como esta HOY en produccion: con la 0027, sin la 0028."""
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
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

        # Y ahora se DESHACE la 0028, que es lo que se quiere probar.
        await conn.execute(text("drop table course_topics"))

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Topic(id=IA, slug="ia", name="Inteligencia Artificial", position=0))
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=PEDRO, full_name="Pedro", username="pedro"))
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


async def _curso_con_contenido(http, sesiones, **campos) -> str:
    respuesta = await http.post(
        f"{CATALOGO}/courses",
        json={
            "title": "Curso",
            "description": "Una descripción larga de verdad.",
            **campos,
        },
    )
    assert respuesta.status_code == 201, respuesta.text
    course_id = respuesta.json()["id"]
    async with sesiones() as db:
        modulo = CourseModule(course_id=course_id, title="Módulo", sort_order=0)
        db.add(modulo)
        await db.flush()
        db.add(
            CourseLesson(
                module_id=modulo.id,
                title="Lección",
                duration_seconds=900,
                sort_order=0,
            )
        )
        await db.commit()
    return course_id


# --------------------------------------------------------------------------- #
# Lo que reventaria
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_catalogo_carga(base_sin_0028):
    http, _, _ = base_sin_0028
    assert (await http.get(f"{CATALOGO}/courses")).status_code == 200


@pytest.mark.asyncio
async def test_se_puede_crear_un_curso(base_sin_0028):
    """Etiquetar es opcional; que no se pueda guardar la etiqueta no puede
    impedir crear el curso."""
    http, _, _ = base_sin_0028
    respuesta = await http.post(
        f"{CATALOGO}/courses", json={"title": "Nuevo", "topic_ids": [IA]}
    )
    assert respuesta.status_code == 201
    # Se crea, pero SIN temas: no hay donde guardarlos y no se finge que si.
    assert respuesta.json()["topic_ids"] == []


@pytest.mark.asyncio
async def test_mis_cursos_responde(base_sin_0028):
    http, _, _ = base_sin_0028
    assert (await http.get(f"{CATALOGO}/courses/mine")).status_code == 200


@pytest.mark.asyncio
async def test_se_puede_publicar_SIN_exigir_temas(base_sin_0028):
    """Exigir un tema imposible de guardar dejaria el catalogo congelado."""
    http, sesiones, _ = base_sin_0028
    course_id = await _curso_con_contenido(http, sesiones)
    respuesta = await http.post(f"{CATALOGO}/courses/{course_id}/publish")
    assert respuesta.status_code == 200
    cuerpo = respuesta.json()
    assert cuerpo["published"] is True, cuerpo["missing"]


@pytest.mark.asyncio
async def test_el_detalle_del_curso_responde(base_sin_0028):
    http, sesiones, _ = base_sin_0028
    course_id = await _curso_con_contenido(http, sesiones)
    respuesta = await http.get(f"{LEARNING}/courses/{course_id}")
    assert respuesta.status_code == 200
    assert respuesta.json()["topic_ids"] == []


@pytest.mark.asyncio
async def test_editar_un_curso_no_falla_por_los_temas(base_sin_0028):
    http, sesiones, _ = base_sin_0028
    course_id = await _curso_con_contenido(http, sesiones)
    respuesta = await http.patch(
        f"{CATALOGO}/courses/{course_id}",
        json={"title": "Otro nombre", "topic_ids": [IA]},
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["title"] == "Otro nombre"


@pytest.mark.asyncio
async def test_inscribirse_y_avanzar_sigue_funcionando(base_sin_0028):
    """El progreso no depende de la 0028 en absoluto, pero pasa por el mismo
    codigo que lee los temas al cerrar el curso."""
    http, sesiones, identidad = base_sin_0028
    course_id = await _curso_con_contenido(http, sesiones)
    await http.post(f"{CATALOGO}/courses/{course_id}/publish")

    identidad["uid"] = PEDRO
    assert (
        await http.post(f"{LEARNING}/courses/{course_id}/enroll")
    ).status_code == 200

    detalle = (await http.get(f"{LEARNING}/courses/{course_id}")).json()
    leccion_id = detalle["modules"][0]["lessons"][0]["id"]
    respuesta = await http.put(
        f"{LEARNING}/lessons/{leccion_id}/progress",
        json={"progress_seconds": 900, "completed": True},
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["course_completed"] is True


@pytest.mark.asyncio
async def test_la_senal_de_curso_terminado_se_guarda_sin_temas(base_sin_0028):
    """Se sigue aprendiendo; lo que no se puede es saber de que trataba."""
    http, sesiones, identidad = base_sin_0028
    course_id = await _curso_con_contenido(http, sesiones)
    await http.post(f"{CATALOGO}/courses/{course_id}/publish")
    identidad["uid"] = PEDRO
    await http.post(f"{LEARNING}/courses/{course_id}/enroll")
    detalle = (await http.get(f"{LEARNING}/courses/{course_id}")).json()
    await http.put(
        f"{LEARNING}/lessons/{detalle['modules'][0]['lessons'][0]['id']}/progress",
        json={"progress_seconds": 900, "completed": True},
    )
    async with sesiones() as db:
        senales = (
            await db.scalars(
                select(BehaviorEvent).where(
                    BehaviorEvent.event_type == "content_completed"
                )
            )
        ).all()
    assert len(senales) == 1
    assert senales[0].topic_ids is None


@pytest.mark.asyncio
async def test_la_biblioteca_responde(base_sin_0028):
    http, _, _ = base_sin_0028
    assert (await http.get(f"{LEARNING}/me/courses")).status_code == 200


@pytest.mark.asyncio
async def test_una_impresion_de_cursos_no_tumba_la_peticion(base_sin_0028):
    """`courses_for_you` no existe en el CHECK hasta la 0028.

    Escribirla haria fallar la fila entera contra PostgreSQL. Se guarda la
    senal SIN contexto: perder informacion es aceptable, perder la senal no.
    """
    http, sesiones, _ = base_sin_0028
    respuesta = await http.post(
        f"{RECOMENDACIONES}/events",
        json={
            "events": [
                {
                    "event_type": "content_impression",
                    "entity_type": "course",
                    "entity_id": "cccccccc-0000-0000-0000-000000000001",
                    "surface": "courses_for_you",
                    "algorithm_version": "course-v1",
                    "rank": 0,
                    "event_key": "c1",
                }
            ]
        },
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["accepted"] == 1

    async with sesiones() as db:
        senal = (
            await db.scalars(
                select(BehaviorEvent).where(
                    BehaviorEvent.event_type == "content_impression"
                )
            )
        ).one()
    assert senal.surface is None, "la superficie no puede escribirse todavia"
    assert senal.entity_type == "course"


@pytest.mark.asyncio
async def test_las_impresiones_de_las_otras_superficies_si_llevan_contexto(
    base_sin_0028,
):
    """Solo se recorta la superficie nueva. Las cinco de la 0027 siguen igual."""
    http, sesiones, _ = base_sin_0028
    await http.post(
        f"{RECOMENDACIONES}/events",
        json={
            "events": [
                {
                    "event_type": "profile_view",
                    "entity_type": "profile",
                    "entity_id": PEDRO,
                    "surface": "people_for_you",
                    "algorithm_version": "people-v1.1",
                    "rank": 2,
                    "event_key": "p1",
                }
            ]
        },
    )
    async with sesiones() as db:
        senal = (
            await db.scalars(
                select(BehaviorEvent).where(BehaviorEvent.event_type == "profile_view")
            )
        ).one()
    assert senal.surface == "people_for_you"
    assert senal.rank == 2


@pytest.mark.asyncio
async def test_el_esquema_se_detecta_una_sola_vez(base_sin_0028):
    """La comprobacion no puede costar una consulta por peticion.

    Se crea un curso primero: con el catalogo vacio no hay temas que leer y la
    comprobacion ni siquiera llega a hacerse.
    """
    from app.modules.recommendations import esquema as e

    http, sesiones, _ = base_sin_0028
    course_id = await _curso_con_contenido(http, sesiones)
    await http.post(f"{CATALOGO}/courses/{course_id}/publish")
    e.olvidar()

    await http.get(f"{CATALOGO}/courses")
    assert e._cache.get("course_topics") is False
    await http.get(f"{CATALOGO}/courses")
    assert e._cache.get("course_topics") is False


# --------------------------------------------------------------------------- #
# «Cursos para ti» sin la migración
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_recomendador_de_cursos_responde(base_sin_0028):
    """Sin `course_topics` nadie declara de qué trata un curso, así que la
    afinidad temática vale 0 para todos. No es un error: es que no se sabe.

    Lo que NO puede pasar es un 500, que además el navegador reportaría como
    un fallo de CORS y mandaría a buscar al sitio equivocado.
    """
    http, sesiones, _ = base_sin_0028
    course_id = await _curso_con_contenido(http, sesiones)
    await http.post(f"{CATALOGO}/courses/{course_id}/publish")

    respuesta = await http.get(f"{RECOMENDACIONES}/courses?limit=10")
    assert respuesta.status_code == 200
    datos = respuesta.json()
    assert datos["algorithm_version"] == "course-v1"
    # Sin temas, ninguno puede decir de qué trata. Se dice, no se disimula.
    assert datos["with_topics"] == 0


@pytest.mark.asyncio
async def test_los_cursos_recomendados_siguen_explicandose(base_sin_0028):
    """Sin tema no se puede explicar por el tema, pero sí decir la verdad."""
    http, sesiones, identidad = base_sin_0028
    course_id = await _curso_con_contenido(http, sesiones)
    await http.post(f"{CATALOGO}/courses/{course_id}/publish")

    identidad["uid"] = PEDRO  # no es el autor, así que sí es candidato
    items = (await http.get(f"{RECOMENDACIONES}/courses")).json()["items"]
    assert len(items) == 1
    assert items[0]["topic_ids"] == []
    motivos = [m["code"] for m in items[0]["reasons"]]
    assert motivos
    assert "COURSE_TOPIC_MATCH" not in motivos


@pytest.mark.asyncio
async def test_rechazar_un_curso_no_falla_por_los_temas(base_sin_0028):
    """El evento se guarda igual; lo que no lleva son los temas que enfriar."""
    http, sesiones, _ = base_sin_0028
    course_id = await _curso_con_contenido(http, sesiones)
    respuesta = await http.post(
        f"{RECOMENDACIONES}/events",
        json={
            "events": [
                {
                    "event_type": "not_interested",
                    "entity_type": "course",
                    "entity_id": course_id,
                    "event_key": "no-1",
                }
            ]
        },
    )
    assert respuesta.status_code == 200
    async with sesiones() as db:
        senal = (
            await db.scalars(
                select(BehaviorEvent).where(
                    BehaviorEvent.event_type == "not_interested"
                )
            )
        ).one()
    assert senal.topic_ids is None
