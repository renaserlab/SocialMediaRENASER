"""El progreso de verdad: cuanto se vio, cuando cuenta y quien lo dice.

`lesson_progress.progress_seconds` existia en la base desde la migracion 0001
y NADIE lo escribia: no habia endpoint que lo tocara y el movil nunca llamaba
a completar. Un curso podia verse entero y quedar al 0 %.

Estas pruebas cubren las dos mitades:

- **Las reglas puras** (`progreso.py`), que no necesitan base de datos y son
  las que evitan que «completada» signifique tres cosas distintas segun la
  pantalla.
- **El endpoint**, que es donde importa que el servidor no se crea lo que le
  cuentan: sin acotar los segundos, mandar 999999 marcaria cualquier curso
  como terminado y envenenaria justo lo que se quiere medir.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.catalog.models import Course
from app.modules.learning import progreso
from app.modules.learning.models import CourseLesson, CourseModule, Purchase
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache
from app.modules.recommendations.models import BehaviorEvent, Topic
from app.shared.database import Base, get_db

LEARNING = "/api/v1/learning"
IA = "11111111-1111-1111-1111-111111111111"
ANA = "aaaaaaaa-0000-0000-0000-000000000001"
PEDRO = "aaaaaaaa-0000-0000-0000-000000000002"


# --------------------------------------------------------------------------- #
# 1. Las reglas, sin base de datos
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "enviados,duracion,esperado",
    [
        (0, 900, 0),
        (450, 900, 450),
        (901, 900, 900),  # redondeo del reproductor, no mentira
        (999_999, 900, 900),  # esto si lo era
        (-5, 900, 0),
        (100, 0, 100),  # sin duracion declarada, se guarda lo que dice
    ],
)
def test_los_segundos_se_acotan_a_la_duracion_real(enviados, duracion, esperado):
    assert progreso.segundos_validos(enviados, duracion) == esperado


def test_un_video_sin_duracion_no_acepta_cualquier_cosa():
    """Doce horas de tope: por encima es un error o un intento."""
    assert progreso.segundos_validos(10**9, 0) == progreso.SEGUNDOS_MAXIMOS_SIN_DURACION


@pytest.mark.parametrize(
    "segundos,duracion,esperado",
    [
        (900, 900, True),
        (828, 900, True),  # 92 %: los creditos no hacen falta
        (827, 900, False),
        (720, 900, False),  # 80 % se alcanza dejandolo de fondo
        (0, 900, False),
    ],
)
def test_el_umbral_de_completado(segundos, duracion, esperado):
    assert (
        progreso.esta_completa(segundos=segundos, duracion=duracion) is esperado
    )


def test_el_reproductor_puede_decir_que_termino():
    """Eso lo sabe el cliente mejor que nadie y no hay motivo para discutirlo."""
    assert progreso.esta_completa(segundos=0, duracion=900, declarado=True) is True


def test_una_leccion_sin_duracion_no_se_completa_sola():
    """No hay contra que comparar: suponerlo seria inventarselo."""
    assert progreso.esta_completa(segundos=10_000, duracion=0) is False
    assert progreso.esta_completa(segundos=0, duracion=0, declarado=True) is True


@pytest.mark.parametrize(
    "hechas,total,esperado",
    [(0, 10, 0), (1, 10, 10), (10, 10, 100), (9, 10, 90), (1, 300, 1), (0, 0, 0)],
)
def test_el_porcentaje_no_miente_en_los_extremos(hechas, total, esperado):
    """Un curso empezado no muestra 0 %, y uno al que le falta algo no muestra
    100 %: las dos cifras invitan a cerrar la pantalla y las dos son falsas."""
    assert progreso.porcentaje(hechas, total) == esperado


# --------------------------------------------------------------------------- #
# 2. El endpoint
# --------------------------------------------------------------------------- #
@pytest_asyncio.fixture
async def entorno():
    cache.vaciar()
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

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    lecciones: list[str] = []
    async with sesiones() as db:
        db.add(Topic(id=IA, slug="ia", name="Inteligencia Artificial", position=0))
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=PEDRO, full_name="Pedro", username="pedro"))
        curso = Course(
            id="cccccccc-0000-0000-0000-000000000001",
            author_id=ANA,
            title="Curso de IA",
            description="Una descripción larga de verdad.",
            price_minor=0,
            currency="PEN",
            status="published",
        )
        db.add(curso)
        await db.flush()
        modulo = CourseModule(course_id=curso.id, title="Módulo", sort_order=0)
        db.add(modulo)
        await db.flush()
        for i in range(2):
            leccion = CourseLesson(
                module_id=modulo.id,
                title=f"Lección {i}",
                duration_seconds=900,
                sort_order=i,
            )
            db.add(leccion)
            await db.flush()
            lecciones.append(leccion.id)
        await db.commit()
        curso_id = curso.id

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": PEDRO}

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    app.dependency_overrides[get_optional_user] = _usuario_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad, curso_id, lecciones
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    await engine.dispose()


@pytest.mark.asyncio
async def test_el_progreso_se_guarda(entorno):
    http, _, _, _, lecciones = entorno
    respuesta = await http.put(
        f"{LEARNING}/lessons/{lecciones[0]}/progress", json={"progress_seconds": 300}
    )
    assert respuesta.status_code == 200
    cuerpo = respuesta.json()
    assert cuerpo["progress_seconds"] == 300
    assert cuerpo["completed"] is False


@pytest.mark.asyncio
async def test_volver_atras_no_pierde_lo_avanzado(entorno):
    """Repasar el minuto 2 de un video ya visto no es perder el progreso."""
    http, _, _, _, lecciones = entorno
    await http.put(
        f"{LEARNING}/lessons/{lecciones[0]}/progress", json={"progress_seconds": 800}
    )
    respuesta = await http.put(
        f"{LEARNING}/lessons/{lecciones[0]}/progress", json={"progress_seconds": 120}
    )
    assert respuesta.json()["progress_seconds"] == 800


@pytest.mark.asyncio
async def test_no_se_puede_terminar_un_curso_mintiendo(entorno):
    """La regresion que importa: 999999 segundos no completa nada por si solo."""
    http, _, _, _, lecciones = entorno
    respuesta = await http.put(
        f"{LEARNING}/lessons/{lecciones[0]}/progress",
        json={"progress_seconds": 999_999},
    )
    cuerpo = respuesta.json()
    assert cuerpo["progress_seconds"] == 900
    # 900 de 900 SI es completar: lo que no se acepta es el numero inventado.
    assert cuerpo["completed"] is True
    assert cuerpo["course_completed"] is False  # queda otra leccion


@pytest.mark.asyncio
async def test_es_idempotente(entorno):
    """Es un PUT: mandarlo dos veces deja exactamente el mismo estado."""
    http, sesiones, _, _, lecciones = entorno
    for _ in range(3):
        await http.put(
            f"{LEARNING}/lessons/{lecciones[0]}/progress",
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
    assert len(senales) == 0, "el curso no esta terminado: falta una leccion"


@pytest.mark.asyncio
async def test_terminar_la_ultima_leccion_cierra_el_curso(entorno):
    http, sesiones, _, curso_id, lecciones = entorno
    for lid in lecciones:
        respuesta = await http.put(
            f"{LEARNING}/lessons/{lid}/progress",
            json={"progress_seconds": 900, "completed": True},
        )
    assert respuesta.json()["course_completed"] is True
    assert respuesta.json()["course_progress_percent"] == 100

    async with sesiones() as db:
        senales = (
            await db.scalars(
                select(BehaviorEvent).where(
                    BehaviorEvent.event_type == "content_completed"
                )
            )
        ).all()
    assert len(senales) == 1, "una senal, ni ninguna ni una por reintento"
    assert senales[0].entity_type == "course"
    assert senales[0].entity_id == curso_id
    # La afirma el SERVIDOR: que alguien acabo un curso se deduce de que no le
    # queda ninguna leccion, no de que el movil lo diga.
    assert senales[0].source == "server"


@pytest.mark.asyncio
async def test_repetir_la_ultima_leccion_no_duplica_la_senal(entorno):
    http, sesiones, _, _, lecciones = entorno
    for lid in lecciones:
        await http.put(
            f"{LEARNING}/lessons/{lid}/progress",
            json={"progress_seconds": 900, "completed": True},
        )
    for _ in range(3):
        await http.put(
            f"{LEARNING}/lessons/{lecciones[-1]}/progress",
            json={"progress_seconds": 900, "completed": True},
        )
    async with sesiones() as db:
        total = len(
            (
                await db.scalars(
                    select(BehaviorEvent).where(
                        BehaviorEvent.event_type == "content_completed"
                    )
                )
            ).all()
        )
    assert total == 1


@pytest.mark.asyncio
async def test_sin_acceso_no_se_guarda_progreso(entorno):
    """Antes se podia marcar completada cualquier leccion sin tener el curso."""
    http, sesiones, _, curso_id, lecciones = entorno
    async with sesiones() as db:
        curso = await db.get(Course, curso_id)
        curso.price_minor = 15000
        await db.commit()

    respuesta = await http.put(
        f"{LEARNING}/lessons/{lecciones[0]}/progress", json={"progress_seconds": 100}
    )
    assert respuesta.status_code == 403
    assert respuesta.json()["error"]["code"] == "course_access_required"


@pytest.mark.asyncio
async def test_con_la_compra_pagada_si(entorno):
    http, sesiones, _, curso_id, lecciones = entorno
    async with sesiones() as db:
        curso = await db.get(Course, curso_id)
        curso.price_minor = 15000
        db.add(
            Purchase(
                user_id=PEDRO,
                course_id=curso_id,
                provider="web",
                amount_minor=15000,
                currency="PEN",
                status="paid",
            )
        )
        await db.commit()

    assert (
        await http.put(
            f"{LEARNING}/lessons/{lecciones[0]}/progress",
            json={"progress_seconds": 100},
        )
    ).status_code == 200


@pytest.mark.asyncio
async def test_completar_pasa_por_el_mismo_camino(entorno):
    """Dos formas de completar que puedan discrepar acaban discrepando."""
    http, _, _, _, lecciones = entorno
    respuesta = await http.post(f"{LEARNING}/lessons/{lecciones[0]}/complete")
    assert respuesta.status_code == 200
    cuerpo = respuesta.json()
    assert cuerpo["completed"] is True
    assert cuerpo["progress_seconds"] == 900


# --------------------------------------------------------------------------- #
# 3. La biblioteca sale del servidor
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_biblioteca_esta_vacia_sin_acceso_a_nada(entorno):
    http, _, _, _, _ = entorno
    assert (await http.get(f"{LEARNING}/me/courses")).json() == []


@pytest.mark.asyncio
async def test_un_curso_empezado_esta_en_progreso(entorno):
    http, _, _, curso_id, lecciones = entorno
    await http.post(f"{LEARNING}/courses/{curso_id}/enroll")
    await http.put(
        f"{LEARNING}/lessons/{lecciones[0]}/progress",
        json={"progress_seconds": 900, "completed": True},
    )
    biblioteca = (await http.get(f"{LEARNING}/me/courses")).json()
    assert len(biblioteca) == 1
    fila = biblioteca[0]
    assert fila["state"] == "in_progress"
    assert fila["progress_percent"] == 50
    assert fila["next_lesson_id"] == lecciones[1]


@pytest.mark.asyncio
async def test_un_curso_terminado_esta_completado(entorno):
    http, _, _, curso_id, lecciones = entorno
    await http.post(f"{LEARNING}/courses/{curso_id}/enroll")
    for lid in lecciones:
        await http.put(
            f"{LEARNING}/lessons/{lid}/progress",
            json={"progress_seconds": 900, "completed": True},
        )
    fila = (await http.get(f"{LEARNING}/me/courses")).json()[0]
    assert fila["state"] == "completed"
    assert fila["progress_percent"] == 100
    assert fila["next_lesson_id"] is None


@pytest.mark.asyncio
async def test_un_curso_con_acceso_pero_sin_empezar(entorno):
    http, _, _, curso_id, _ = entorno
    await http.post(f"{LEARNING}/courses/{curso_id}/enroll")
    fila = (await http.get(f"{LEARNING}/me/courses")).json()[0]
    assert fila["state"] == "not_started"
    assert fila["progress_percent"] == 0
    assert fila["lessons_total"] == 2


@pytest.mark.asyncio
async def test_la_biblioteca_no_pregunta_una_vez_por_curso(entorno):
    """Numero de consultas CONSTANTE, no proporcional a los cursos.

    Se mide comparando una biblioteca de un curso con una de seis, en vez de
    contra un tope escrito a mano: el tope caducaba en cuanto la biblioteca
    aprendia a mirar una cosa mas —le paso con la evaluacion final— y entonces
    la prueba fallaba sin que hubiera aparecido ningun N+1.
    """
    from sqlalchemy import event

    http, sesiones, _, curso_id, _ = entorno
    await http.post(f"{LEARNING}/courses/{curso_id}/enroll")

    def _escuchar():
        consultas: list[str] = []

        def _contar(conn, cursor, statement, *args):  # noqa: ANN001
            consultas.append(statement)

        motor = sesiones.kw["bind"].sync_engine
        event.listen(motor, "before_cursor_execute", _contar)
        return consultas, lambda: event.remove(motor, "before_cursor_execute", _contar)

    async def _selects() -> tuple[int, int]:
        consultas, quitar = _escuchar()
        try:
            respuesta = await http.get(f"{LEARNING}/me/courses")
        finally:
            quitar()
        selects = [c for c in consultas if c.lstrip().lower().startswith("select")]
        return len(selects), len(respuesta.json())

    con_uno, cuantos_uno = await _selects()
    assert cuantos_uno == 1

    async with sesiones() as db:
        for i in range(5):
            otro = Course(
                author_id=ANA,
                title=f"Otro {i}",
                description="x",
                price_minor=0,
                currency="PEN",
                status="published",
            )
            db.add(otro)
            await db.flush()
            db.add(
                Purchase(
                    user_id=PEDRO,
                    course_id=otro.id,
                    provider="manual",
                    amount_minor=0,
                    currency="PEN",
                    status="paid",
                )
            )
        await db.commit()

    con_seis, cuantos_seis = await _selects()
    assert cuantos_seis == 6
    assert con_seis == con_uno, (
        f"{con_uno} consultas con un curso y {con_seis} con seis"
    )


@pytest.mark.asyncio
async def test_un_curso_sin_lecciones_no_rompe_la_biblioteca(entorno):
    """Mismo fallo que en el chat de los directos, en otro sitio.

    La biblioteca resolvía el progreso con `lesson_id.in_(lista or [""])`. Un
    curso al que alguien tiene acceso pero que todavía no tiene ninguna lección
    deja esa lista vacía, y entonces la cadena vacía viajaba a una columna
    `uuid`. En SQLite cuela; PostgreSQL la rechaza y la biblioteca entera
    respondería con un error.

    No es un caso raro: es el estado de todo curso gratuito recién creado al
    que alguien entró antes de que su autor le pusiera contenido.
    """
    http, sesiones, _, _, _ = entorno
    vacio = "cccccccc-0000-0000-0000-0000000000ff"
    async with sesiones() as db:
        db.add(
            Course(
                id=vacio,
                author_id=ANA,
                title="Todavía sin contenido",
                description="x",
                price_minor=0,
                currency="PEN",
                status="published",
            )
        )
        db.add(
            Purchase(
                user_id=PEDRO,
                course_id=vacio,
                provider="manual",
                amount_minor=0,
                currency="PEN",
                status="paid",
            )
        )
        await db.commit()

    respuesta = await http.get(f"{LEARNING}/me/courses")
    assert respuesta.status_code == 200
    fila = next(c for c in respuesta.json() if c["id"] == vacio)
    assert fila["lessons_total"] == 0
    assert fila["state"] == "not_started"
    assert fila["next_lesson_id"] is None
