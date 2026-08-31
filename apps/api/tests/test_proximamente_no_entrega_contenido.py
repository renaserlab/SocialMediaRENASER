"""«Próximamente» tiene que gobernar el SERVIDOR, no solo la pantalla.

POR QUÉ EXISTE ESTE FICHERO. `courses.coming_soon` era decorativo: la ficha del
curso lo devolvía, la aplicación lo pintaba, y el servidor seguía entregando el
temario con las RUTAS de los vídeos y el TEXTO íntegro de las lecciones escritas.

Y no era un descuido menor, por una razón concreta: `_tiene_acceso` devuelve
`True` en su primera línea cuando el curso es GRATUITO. El curso de la captura
—FORMACIÓN RENASER— es gratuito y está marcado «Próximamente». Es decir, un
curso anunciado y sin terminar repartía sus vídeos a cualquiera.

La pantalla ya no ofrece «Empezar curso» en ese estado, pero `/lesson/<id>` se
abre por enlace directo: arreglar solo lo que se ve deja la puerta puesta. Eso
es exactamente lo que estas pruebas impiden que vuelva a pasar.

LO QUE **SÍ** SE SIGUE ENTREGANDO, y es deliberado: títulos, duraciones y
descripciones. El temario es lo que vende el curso. Lo que no viaja es el
archivo ni el texto de la lección.
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
from app.shared.database import Base, get_db

CURSOS = "/api/v1/learning/courses"
LECCIONES = "/api/v1/learning/lessons"

#: Quien publica. Es quien gestiona el curso.
AUTORA = "cccccccc-0000-0000-0000-000000000001"
#: Cualquiera. Sin comprar nada, porque el curso es GRATIS.
CURIOSO = "cccccccc-0000-0000-0000-000000000002"

CURSO = "cccccccc-1111-0000-0000-000000000001"
MODULO = "cccccccc-2222-0000-0000-000000000001"
#: Lección de vídeo. Lo que no puede salir es `media_path`.
LECCION_VIDEO = "cccccccc-3333-0000-0000-000000000001"
#: Lección escrita. Aquí el contenido ES el texto y viaja en el JSON: el
#: almacenamiento no puede protegerlo porque no existe ningún archivo.
LECCION_TEXTO = "cccccccc-3333-0000-0000-000000000002"

RUTA_DEL_VIDEO = f"{AUTORA}/curso/leccion1.mp4"
TEXTO_DE_LA_LECCION = "El método completo, paso a paso, escrito entero aquí."


@pytest_asyncio.fixture
async def entorno():
    """Un curso GRATUITO, publicado y marcado «Próximamente»."""
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
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add_all(
            [
                Profile(id=AUTORA, full_name="Autora", username="autora"),
                Profile(id=CURIOSO, full_name="Curioso", username="curioso"),
            ]
        )
        db.add(
            Course(
                id=CURSO,
                author_id=AUTORA,
                title="FORMACIÓN RENASER",
                description="Programa",
                # GRATUITO: `_tiene_acceso` dice que sí a todo el mundo.
                price_minor=0,
                currency="USD",
                status="published",
                coming_soon=True,
            )
        )
        db.add(CourseModule(id=MODULO, course_id=CURSO, title="Módulo 1", sort_order=0))
        db.add(
            CourseLesson(
                id=LECCION_VIDEO,
                module_id=MODULO,
                title="Lección 1",
                media_path=RUTA_DEL_VIDEO,
                duration_seconds=600,
                sort_order=0,
            )
        )
        db.add(
            CourseLesson(
                id=LECCION_TEXTO,
                module_id=MODULO,
                title="Lección 2",
                body=TEXTO_DE_LA_LECCION,
                duration_seconds=300,
                sort_order=1,
            )
        )
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    app.dependency_overrides[get_db] = _db_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones
    app.dependency_overrides.clear()
    await engine.dispose()


def _como(uid: str) -> None:
    usuario = AuthUser(id=uid, email=f"{uid}@ejemplo.com", role="authenticated")
    app.dependency_overrides[get_current_user] = lambda: usuario
    app.dependency_overrides[get_optional_user] = lambda: usuario


async def _apagar_proximamente(sesiones) -> None:
    async with sesiones() as db:
        curso = await db.get(Course, CURSO)
        curso.coming_soon = False
        await db.commit()


# --------------------------------------------------------------------------- #
# 1. La ficha del curso
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_ficha_no_entrega_la_ruta_del_video_de_un_curso_anunciado(entorno):
    """El agujero exacto: curso GRATIS + «Próximamente» = vídeos para cualquiera."""
    http, _ = entorno
    _como(CURIOSO)

    respuesta = await http.get(f"{CURSOS}/{CURSO}")

    assert respuesta.status_code == 200, respuesta.text
    lecciones = respuesta.json()["modules"][0]["lessons"]
    assert lecciones[0]["media_path"] is None
    # Y el texto de la escrita tampoco, que es el que ni el almacenamiento
    # protege: no hay ningún archivo que proteger.
    assert TEXTO_DE_LA_LECCION not in respuesta.text


@pytest.mark.asyncio
async def test_la_ficha_sigue_enseñando_el_temario(entorno):
    """No se esconde el curso: se esconde el CONTENIDO.

    Títulos y duraciones son lo que vende el programa, y anunciarlo es
    justamente para lo que sirve «Próximamente».
    """
    http, _ = entorno
    _como(CURIOSO)

    cuerpo = (await http.get(f"{CURSOS}/{CURSO}")).json()

    assert cuerpo["coming_soon"] is True
    lecciones = cuerpo["modules"][0]["lessons"]
    assert [leccion["title"] for leccion in lecciones] == ["Lección 1", "Lección 2"]
    assert lecciones[0]["duration_seconds"] == 600
    # `has_media` dice que HAY vídeo sin decir dónde: es lo que deja a la
    # pantalla contar lecciones sin repartir rutas.
    assert lecciones[0]["has_media"] is True


@pytest.mark.asyncio
async def test_a_quien_gestiona_el_curso_se_le_entrega_todo(entorno):
    """Es como comprueba lo que va subiendo. Sin esto no podría montarlo."""
    http, _ = entorno
    _como(AUTORA)

    cuerpo = (await http.get(f"{CURSOS}/{CURSO}")).json()

    assert cuerpo["modules"][0]["lessons"][0]["media_path"] == RUTA_DEL_VIDEO


@pytest.mark.asyncio
async def test_al_quitar_proximamente_el_contenido_vuelve(entorno):
    """La condición es `coming_soon`, no otra cosa que se le parezca.

    Sin esta prueba, un arreglo que escondiera el contenido por cualquier otro
    motivo —el precio, el estado, la fecha— pasaría las de arriba igual.
    """
    http, sesiones = entorno
    _como(CURIOSO)
    await _apagar_proximamente(sesiones)

    cuerpo = (await http.get(f"{CURSOS}/{CURSO}")).json()

    assert cuerpo["coming_soon"] is False
    assert cuerpo["modules"][0]["lessons"][0]["media_path"] == RUTA_DEL_VIDEO


# --------------------------------------------------------------------------- #
# 2. La lección suelta: la puerta de atrás
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_enlace_directo_a_una_leccion_no_entrega_el_video(entorno):
    """`/lesson/<id>` se abre sin pasar por la ficha del curso.

    La pantalla ya no enlaza ahí desde que se arregló la ficha, pero un enlace
    guardado, compartido o adivinado sigue funcionando. Arreglar solo lo que se
    ve deja la puerta puesta.
    """
    http, _ = entorno
    _como(CURIOSO)

    respuesta = await http.get(f"{LECCIONES}/{LECCION_VIDEO}")

    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["media_path"] is None
    # El temario sí: es lo mismo que se enseña sin acceso.
    assert respuesta.json()["title"] == "Lección 1"


def test_una_leccion_escrita_sin_contenido_listo_no_manda_su_texto():
    """La lección ESCRITA es el caso sin archivo: el contenido ES el JSON.

    POR QUE ESTA PRUEBA NO PASA POR EL ENDPOINT. Que una lección conste como
    escrita depende de la 0034, y esa migración añade columnas repartidas por
    tres tablas que el modelo de SQLAlchemy NO mapea a propósito. Simular media
    migración en la base de pruebas hace que el sondeo diga «sí» y que el resto
    del código V2 pida columnas que ahí no existen: se rompen cinco pruebas por
    querer forzar una. Se comprueba entonces la función que decide.

    El endpoint le pasa a `_texto_visible` y a `_media_visible` EXACTAMENTE la
    misma expresión (`listo and tiene_acceso`), y que `listo` es falso en un
    curso «Próximamente» ya lo demuestran las pruebas del vídeo de aquí arriba.
    Lo que queda por fijar es lo de abajo: que con esa expresión en falso, el
    texto no sale.
    """
    from app.modules.learning.router import _texto_visible

    assert (
        _texto_visible(
            TEXTO_DE_LA_LECCION, kind="text", acceso=False, muestra=False
        )
        == ""
    )
    # Y que sí sale cuando el contenido está listo, para que la prueba no pase
    # por devolver siempre vacío.
    assert (
        _texto_visible(TEXTO_DE_LA_LECCION, kind="text", acceso=True, muestra=False)
        == TEXTO_DE_LA_LECCION
    )


def test_el_endpoint_condiciona_el_texto_y_el_video_con_lo_mismo():
    """Que nadie arregle uno de los dos y se deje el otro.

    Es el error natural aquí: `media_path` se ve en la pantalla y el `body` de
    una lección escrita no, así que es el que se olvida.
    """
    import inspect

    from app.modules.learning import router

    fuente = inspect.getsource(router.get_lesson_detail)
    assert fuente.count("acceso=listo and tiene_acceso") == 2, fuente


@pytest.mark.asyncio
async def test_quien_gestiona_abre_la_leccion_entera(entorno):
    http, _ = entorno
    _como(AUTORA)

    respuesta = await http.get(f"{LECCIONES}/{LECCION_VIDEO}")

    assert respuesta.json()["media_path"] == RUTA_DEL_VIDEO


@pytest.mark.asyncio
async def test_sin_proximamente_la_leccion_gratuita_se_abre_como_siempre(entorno):
    """Que no se rompa lo de siempre: un curso gratuito normal se ve entero."""
    http, sesiones = entorno
    _como(CURIOSO)
    await _apagar_proximamente(sesiones)

    respuesta = await http.get(f"{LECCIONES}/{LECCION_VIDEO}")

    assert respuesta.json()["media_path"] == RUTA_DEL_VIDEO
    assert TEXTO_DE_LA_LECCION in (
        await http.get(f"{LECCIONES}/{LECCION_TEXTO}")
    ).text
