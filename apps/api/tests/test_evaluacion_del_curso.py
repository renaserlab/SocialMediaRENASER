"""La evaluación final: quién la escribe, quién la responde y quién pone la nota.

La garantía que sostiene todo lo demás es que LA RESPUESTA CORRECTA NO SALE de
la API mientras alguien está respondiendo. Si sale, la evaluación no mide nada
y el certificado que salga de ella tampoco.

La segunda es que la nota la calcula el SERVIDOR. Un cliente que pudiera
declarar la suya convertiría el certificado en un adorno.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.catalog.models import Course, CourseVersion
from app.modules.learning import esquema as esquema_aprendizaje
from app.modules.learning import evaluacion
from app.modules.learning.models import (
    CourseLesson,
    CourseModule,
    Purchase,
    QuizAttempt,
)
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db

LEARNING = "/api/v1/learning"
AUTORA = "cccccccc-0000-0000-0000-00000000000a"
BRUNO = "bbbbbbbb-0000-0000-0000-000000000002"
CARLA = "bbbbbbbb-0000-0000-0000-000000000003"
MODERADOR = "dddddddd-0000-0000-0000-000000000003"
ADMIN = "dddddddd-0000-0000-0000-000000000004"
CURSO = "cccccccc-0000-0000-0000-000000000001"
PRECIO = 4900

CUATRO_PREGUNTAS = {
    "title": "Evaluación final",
    "pass_percent": 70,
    "questions": [
        {
            "prompt": f"Pregunta {i}",
            "options": [
                {"body": "Correcta", "is_correct": True},
                {"body": "Incorrecta", "is_correct": False},
                {"body": "Tampoco", "is_correct": False},
            ],
        }
        for i in range(1, 5)
    ],
}


# --------------------------------------------------------------------------- #
# 1. Las reglas, sin base de datos
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "aciertos,total,esperado",
    [(0, 4, 0), (1, 4, 25), (2, 4, 50), (3, 4, 75), (4, 4, 100), (1, 3, 33)],
)
def test_la_nota_se_calcula_sobre_el_total_de_preguntas(aciertos, total, esperado):
    assert evaluacion.puntaje(aciertos, total) == esperado


def test_los_extremos_de_la_nota_se_dicen_tal_cual():
    """A diferencia del avance del curso, aquí 0 y 100 son resultados reales."""
    assert evaluacion.puntaje(0, 10) == 0
    assert evaluacion.puntaje(10, 10) == 100


def test_una_evaluacion_sin_preguntas_no_revienta():
    """Publicarla ya está prohibido, pero una fila antigua no puede tumbar una
    pantalla."""
    assert evaluacion.puntaje(0, 0) == 0


def test_dejar_en_blanco_no_sube_la_nota():
    """El total sale de las preguntas, NO de lo respondido: contar solo lo
    contestado premiaría dejar preguntas sin responder."""
    correctas = {"p1": "a", "p2": "a", "p3": "a", "p4": "a"}
    nota, aprobado = evaluacion.califica({"p1": "a"}, correctas, 70)
    assert nota == 25
    assert aprobado is False


def test_el_minimo_es_el_de_cada_evaluacion():
    correctas = {"p1": "a", "p2": "a"}
    assert evaluacion.califica({"p1": "a"}, correctas, 50) == (50, True)
    assert evaluacion.califica({"p1": "a"}, correctas, 51) == (50, False)


@pytest.mark.parametrize(
    "preguntas,esperado",
    [
        ([], "quiz_without_questions"),
        ([("p", [True])], "quiz_option_count_invalid"),
        ([("p", [True, False, False, False, False, False])], "quiz_option_count_invalid"),
        ([("p", [False, False])], "quiz_answer_missing"),
        ([("p", [True, False])], None),
    ],
)
def test_cuando_no_se_puede_publicar(preguntas, esperado):
    assert evaluacion.motivo_para_no_publicar(preguntas) == esperado


# --------------------------------------------------------------------------- #
# 2. Los endpoints
# --------------------------------------------------------------------------- #


@pytest_asyncio.fixture
async def entorno():
    esquema_aprendizaje.olvidar()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sesiones = async_sessionmaker(engine, expire_on_commit=False)

    async with sesiones() as db:
        db.add(Profile(id=AUTORA, full_name="Carla A", username="carlaa"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(Profile(id=CARLA, full_name="Carla", username="carla"))
        db.add(
            Profile(id=MODERADOR, full_name="Marta", username="marta", role="moderator")
        )
        db.add(Profile(id=ADMIN, full_name="Ada", username="ada", role="admin"))
        db.add(
            Course(
                id=CURSO,
                author_id=AUTORA,
                title="Respiración",
                description="Una descripción larga de verdad.",
                price_minor=PRECIO,
                currency="PEN",
                status="published",
            )
        )
        await db.flush()
        modulo = CourseModule(course_id=CURSO, title="Módulo", sort_order=0)
        db.add(modulo)
        await db.flush()
        db.add(
            CourseLesson(
                module_id=modulo.id, title="Lección", duration_seconds=900, sort_order=0
            )
        )
        db.add(
            Purchase(
                user_id=BRUNO,
                course_id=CURSO,
                provider="stripe",
                amount_minor=PRECIO,
                currency="PEN",
                status="paid",
            )
        )
        await db.commit()

    identidad = {"uid": AUTORA}

    async def _db():
        async with sesiones() as sesion:
            yield sesion

    async def _usuario() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _usuario
    app.dependency_overrides[get_optional_user] = _usuario
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, identidad, sesiones
    for dep in (get_db, get_current_user, get_optional_user):
        app.dependency_overrides.pop(dep, None)
    await engine.dispose()


async def _publicar(http, identidad, cuestionario=None):
    """Escribe y publica la evaluación como la autora, y devuelve el borrador."""
    antes = identidad["uid"]
    identidad["uid"] = AUTORA
    guardada = await http.put(
        f"{LEARNING}/courses/{CURSO}/quiz", json=cuestionario or CUATRO_PREGUNTAS
    )
    assert guardada.status_code == 200, guardada.text
    publicada = await http.post(f"{LEARNING}/courses/{CURSO}/quiz/publish")
    assert publicada.status_code == 200, publicada.text
    identidad["uid"] = antes
    return publicada.json()


async def _responder(http, aciertos: int):
    """Empieza un intento y responde bien las `aciertos` primeras preguntas."""
    vista = (await http.get(f"{LEARNING}/courses/{CURSO}/quiz")).json()
    intento = (await http.post(f"{LEARNING}/courses/{CURSO}/quiz/attempts")).json()
    respuestas = []
    for indice, pregunta in enumerate(vista["questions"]):
        # La correcta es la que la autora escribió como «Correcta». El alumno no
        # la ve marcada: aquí se usa el texto justamente porque no hay bandera.
        buena = next(o for o in pregunta["options"] if o["body"] == "Correcta")
        mala = next(o for o in pregunta["options"] if o["body"] != "Correcta")
        respuestas.append(
            {
                "question_id": pregunta["id"],
                "option_id": (buena if indice < aciertos else mala)["id"],
            }
        )
    return await http.post(
        f"{LEARNING}/quiz-attempts/{intento['id']}/submit",
        json={"answers": respuestas},
    )


# --------------------------------------------------------------------------- #
# La respuesta correcta no sale
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_el_alumno_no_recibe_cual_es_la_correcta(entorno):
    """Es la garantía entera: si sale, la evaluación no mide nada."""
    http, identidad, _ = entorno
    await _publicar(http, identidad)
    identidad["uid"] = BRUNO

    respuesta = await http.get(f"{LEARNING}/courses/{CURSO}/quiz")
    assert respuesta.status_code == 200, respuesta.text
    assert "is_correct" not in respuesta.text
    for pregunta in respuesta.json()["questions"]:
        for opcion in pregunta["options"]:
            assert set(opcion.keys()) == {"id", "body"}


@pytest.mark.asyncio
async def test_el_alumno_no_entra_al_borrador(entorno):
    """El borrador SÍ lleva las correctas, así que es de quien gestiona."""
    http, identidad, _ = entorno
    await _publicar(http, identidad)
    identidad["uid"] = BRUNO
    assert (
        await http.get(f"{LEARNING}/courses/{CURSO}/quiz/draft")
    ).status_code == 403


@pytest.mark.asyncio
async def test_un_tercero_no_escribe_la_evaluacion_de_otro(entorno):
    http, identidad, _ = entorno
    identidad["uid"] = CARLA
    respuesta = await http.put(
        f"{LEARNING}/courses/{CURSO}/quiz", json=CUATRO_PREGUNTAS
    )
    assert respuesta.status_code == 403


@pytest.mark.asyncio
async def test_moderacion_NO_toca_las_respuestas_correctas(entorno):
    """Moderar no es decidir quién se certifica.

    `_puede_gestionar` —la regla del resto del temario— incluye a `moderator`,
    que existe para ocultar contenido y resolver reportes. Aquí no vale: quien
    cambia la alternativa correcta cambia quién aprueba, y con ello quién
    obtiene un certificado verificable.
    """
    http, identidad, _ = entorno
    identidad["uid"] = MODERADOR
    for peticion in (
        http.put(f"{LEARNING}/courses/{CURSO}/quiz", json=CUATRO_PREGUNTAS),
        http.post(f"{LEARNING}/courses/{CURSO}/quiz/publish"),
        http.get(f"{LEARNING}/courses/{CURSO}/quiz/draft"),
    ):
        assert (await peticion).status_code == 403


@pytest.mark.asyncio
async def test_administracion_con_poder_real_si_puede_y_queda_anotado(entorno):
    """`admin` —la misma que mueve dinero— sí, y con rastro.

    Alguien tiene que poder arreglar una evaluación cuyo autor desapareció. Lo
    que no puede es hacerlo en silencio: es una decisión sobre el logro de
    terceros.
    """
    http, identidad, sesiones = entorno
    identidad["uid"] = ADMIN
    respuesta = await http.put(
        f"{LEARNING}/courses/{CURSO}/quiz", json=CUATRO_PREGUNTAS
    )
    assert respuesta.status_code == 200, respuesta.text

    async with sesiones() as db:
        from app.modules.gobernanza.models import AuditEvent

        acciones = list(
            await db.scalars(select(AuditEvent.action).where(AuditEvent.actor_id == ADMIN))
        )
    assert "course_quiz.written" in acciones


@pytest.mark.asyncio
async def test_el_autor_edita_lo_suyo_sin_dejar_rastro_de_auditoria(entorno):
    """Que alguien edite su propio curso no es un hecho que investigar."""
    http, identidad, sesiones = entorno
    identidad["uid"] = AUTORA
    assert (
        await http.put(f"{LEARNING}/courses/{CURSO}/quiz", json=CUATRO_PREGUNTAS)
    ).status_code == 200

    async with sesiones() as db:
        from app.modules.gobernanza.models import AuditEvent

        assert (
            await db.scalar(select(func.count()).select_from(AuditEvent)) == 0
        )


@pytest.mark.asyncio
async def test_sin_acceso_al_curso_no_hay_evaluacion(entorno):
    http, identidad, _ = entorno
    await _publicar(http, identidad)
    identidad["uid"] = CARLA
    respuesta = await http.get(f"{LEARNING}/courses/{CURSO}/quiz")
    assert respuesta.status_code == 403
    assert "course_quiz_access_required" in respuesta.text


@pytest.mark.asyncio
async def test_sin_publicar_el_alumno_no_la_ve(entorno):
    """Un borrador a medias delante de alguien es peor que nada."""
    http, identidad, _ = entorno
    identidad["uid"] = AUTORA
    await http.put(f"{LEARNING}/courses/{CURSO}/quiz", json=CUATRO_PREGUNTAS)
    identidad["uid"] = BRUNO
    respuesta = await http.get(f"{LEARNING}/courses/{CURSO}/quiz")
    assert respuesta.status_code == 404
    assert "course_quiz_not_found" in respuesta.text


# --------------------------------------------------------------------------- #
# Publicar
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_no_se_publica_sin_preguntas(entorno):
    http, identidad, _ = entorno
    identidad["uid"] = AUTORA
    await http.put(
        f"{LEARNING}/courses/{CURSO}/quiz",
        json={"title": "Vacía", "pass_percent": 70, "questions": []},
    )
    respuesta = await http.post(f"{LEARNING}/courses/{CURSO}/quiz/publish")
    assert respuesta.status_code == 422
    assert "quiz_without_questions" in respuesta.text


@pytest.mark.asyncio
async def test_no_se_publica_una_pregunta_sin_correcta(entorno):
    http, identidad, _ = entorno
    identidad["uid"] = AUTORA
    await http.put(
        f"{LEARNING}/courses/{CURSO}/quiz",
        json={
            "title": "A medias",
            "pass_percent": 70,
            "questions": [
                {
                    "prompt": "¿Cuál?",
                    "options": [
                        {"body": "Una", "is_correct": False},
                        {"body": "Otra", "is_correct": False},
                    ],
                }
            ],
        },
    )
    respuesta = await http.post(f"{LEARNING}/courses/{CURSO}/quiz/publish")
    assert respuesta.status_code == 422
    assert "quiz_answer_missing" in respuesta.text


@pytest.mark.asyncio
async def test_dos_correctas_en_una_pregunta_se_rechazan_al_guardar(entorno):
    """La base lo sostiene con un índice único parcial; aquí se avisa antes."""
    http, identidad, _ = entorno
    identidad["uid"] = AUTORA
    respuesta = await http.put(
        f"{LEARNING}/courses/{CURSO}/quiz",
        json={
            "title": "Dos",
            "pass_percent": 70,
            "questions": [
                {
                    "prompt": "¿Cuál?",
                    "options": [
                        {"body": "Una", "is_correct": True},
                        {"body": "Otra", "is_correct": True},
                    ],
                }
            ],
        },
    )
    assert respuesta.status_code == 422
    assert "quiz_multiple_correct" in respuesta.text


@pytest.mark.asyncio
@pytest.mark.parametrize("cuantas", [1, 6])
async def test_el_numero_de_alternativas_tiene_limites(entorno, cuantas):
    """Menos de dos no es una pregunta de opción; más de cinco no cabe."""
    http, identidad, _ = entorno
    identidad["uid"] = AUTORA
    respuesta = await http.put(
        f"{LEARNING}/courses/{CURSO}/quiz",
        json={
            "title": "Límites",
            "pass_percent": 70,
            "questions": [
                {
                    "prompt": "¿Cuál?",
                    "options": [
                        {"body": f"Opción {i}", "is_correct": i == 0}
                        for i in range(cuantas)
                    ],
                }
            ],
        },
    )
    assert respuesta.status_code == 422


# --------------------------------------------------------------------------- #
# Responder
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_la_nota_la_calcula_el_servidor(entorno):
    http, identidad, _ = entorno
    await _publicar(http, identidad)
    identidad["uid"] = BRUNO

    respuesta = await _responder(http, aciertos=3)
    assert respuesta.status_code == 200, respuesta.text
    cuerpo = respuesta.json()
    assert cuerpo["score_percent"] == 75
    assert cuerpo["passed"] is True
    assert cuerpo["status"] == "submitted"


@pytest.mark.asyncio
async def test_no_aprueba_quien_no_llega_al_minimo(entorno):
    http, identidad, _ = entorno
    await _publicar(http, identidad)
    identidad["uid"] = BRUNO
    cuerpo = (await _responder(http, aciertos=2)).json()
    assert cuerpo["score_percent"] == 50
    assert cuerpo["passed"] is False


@pytest.mark.asyncio
async def test_el_cliente_no_declara_su_propia_nota(entorno):
    """Mandar la nota en el cuerpo no cambia nada: no se lee."""
    http, identidad, _ = entorno
    await _publicar(http, identidad)
    identidad["uid"] = BRUNO

    vista = (await http.get(f"{LEARNING}/courses/{CURSO}/quiz")).json()
    intento = (await http.post(f"{LEARNING}/courses/{CURSO}/quiz/attempts")).json()
    fallidas = [
        {
            "question_id": p["id"],
            "option_id": next(o for o in p["options"] if o["body"] != "Correcta")["id"],
        }
        for p in vista["questions"]
    ]
    respuesta = await http.post(
        f"{LEARNING}/quiz-attempts/{intento['id']}/submit",
        json={"answers": fallidas, "score_percent": 100, "passed": True},
    )
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["score_percent"] == 0
    assert respuesta.json()["passed"] is False


@pytest.mark.asyncio
async def test_una_respuesta_de_otra_pregunta_se_rechaza(entorno):
    http, identidad, _ = entorno
    await _publicar(http, identidad)
    identidad["uid"] = BRUNO
    vista = (await http.get(f"{LEARNING}/courses/{CURSO}/quiz")).json()
    intento = (await http.post(f"{LEARNING}/courses/{CURSO}/quiz/attempts")).json()

    primera, segunda = vista["questions"][0], vista["questions"][1]
    respuesta = await http.post(
        f"{LEARNING}/quiz-attempts/{intento['id']}/submit",
        json={
            "answers": [
                {"question_id": primera["id"], "option_id": segunda["options"][0]["id"]}
            ]
        },
    )
    assert respuesta.status_code == 422
    assert "quiz_option_unknown" in respuesta.text


@pytest.mark.asyncio
async def test_dos_toques_no_abren_dos_intentos(entorno):
    """Un solo intento abierto por persona: lo sostiene un índice único."""
    http, identidad, sesiones = entorno
    await _publicar(http, identidad)
    identidad["uid"] = BRUNO

    primero = await http.post(f"{LEARNING}/courses/{CURSO}/quiz/attempts")
    segundo = await http.post(f"{LEARNING}/courses/{CURSO}/quiz/attempts")
    assert primero.json()["id"] == segundo.json()["id"]
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(QuizAttempt)) == 1


@pytest.mark.asyncio
async def test_un_intento_enviado_no_se_vuelve_a_enviar(entorno):
    """Reenviarlo sería ir probando respuestas hasta acertar."""
    http, identidad, _ = entorno
    await _publicar(http, identidad)
    identidad["uid"] = BRUNO

    vista = (await http.get(f"{LEARNING}/courses/{CURSO}/quiz")).json()
    intento = (await http.post(f"{LEARNING}/courses/{CURSO}/quiz/attempts")).json()
    fallidas = [
        {
            "question_id": p["id"],
            "option_id": next(o for o in p["options"] if o["body"] != "Correcta")["id"],
        }
        for p in vista["questions"]
    ]
    primero = await http.post(
        f"{LEARNING}/quiz-attempts/{intento['id']}/submit", json={"answers": fallidas}
    )
    assert primero.json()["score_percent"] == 0

    buenas = [
        {
            "question_id": p["id"],
            "option_id": next(o for o in p["options"] if o["body"] == "Correcta")["id"],
        }
        for p in vista["questions"]
    ]
    segundo = await http.post(
        f"{LEARNING}/quiz-attempts/{intento['id']}/submit", json={"answers": buenas}
    )
    assert segundo.status_code == 409
    assert "quiz_attempt_already_submitted" in segundo.text
    # Y la nota sigue siendo la primera.
    historial = (await http.get(f"{LEARNING}/courses/{CURSO}/quiz/attempts")).json()
    assert [i["score_percent"] for i in historial] == [0]


@pytest.mark.asyncio
async def test_no_se_envia_el_intento_de_otra_persona(entorno):
    http, identidad, _ = entorno
    await _publicar(http, identidad)
    identidad["uid"] = BRUNO
    intento = (await http.post(f"{LEARNING}/courses/{CURSO}/quiz/attempts")).json()

    identidad["uid"] = CARLA
    respuesta = await http.post(
        f"{LEARNING}/quiz-attempts/{intento['id']}/submit", json={"answers": []}
    )
    assert respuesta.status_code == 404


# --------------------------------------------------------------------------- #
# Reintentos e historial
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_se_puede_reintentar_y_queda_el_historial(entorno):
    http, identidad, _ = entorno
    await _publicar(http, identidad)
    identidad["uid"] = BRUNO

    assert (await _responder(http, aciertos=1)).json()["score_percent"] == 25
    assert (await _responder(http, aciertos=4)).json()["score_percent"] == 100

    historial = (await http.get(f"{LEARNING}/courses/{CURSO}/quiz/attempts")).json()
    assert len(historial) == 2
    assert sorted(i["score_percent"] for i in historial) == [25, 100]


@pytest.mark.asyncio
async def test_para_terminar_cuenta_el_mejor_intento(entorno):
    """Volver a intentarlo no puede empeorar lo que ya se consiguió."""
    http, identidad, _ = entorno
    await _publicar(http, identidad)
    identidad["uid"] = BRUNO

    await _responder(http, aciertos=4)
    await _responder(http, aciertos=0)

    vista = (await http.get(f"{LEARNING}/courses/{CURSO}/quiz")).json()
    assert vista["best_attempt"]["score_percent"] == 100
    assert vista["best_attempt"]["passed"] is True


@pytest.mark.asyncio
async def test_el_historial_es_solo_el_propio(entorno):
    http, identidad, _ = entorno
    await _publicar(http, identidad)
    identidad["uid"] = BRUNO
    await _responder(http, aciertos=4)

    identidad["uid"] = CARLA
    assert (await http.get(f"{LEARNING}/courses/{CURSO}/quiz/attempts")).json() == []


# --------------------------------------------------------------------------- #
# La versión estudiada
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_el_intento_queda_atado_a_la_version_del_curso(entorno):
    http, identidad, sesiones = entorno
    async with sesiones() as db:
        db.add(
            CourseVersion(
                course_id=CURSO, version=2, status="published", content_hash="abc"
            )
        )
        await db.commit()
    await _publicar(http, identidad)
    identidad["uid"] = BRUNO
    await _responder(http, aciertos=4)

    historial = (await http.get(f"{LEARNING}/courses/{CURSO}/quiz/attempts")).json()
    assert historial[0]["course_version"] == 2


@pytest.mark.asyncio
async def test_reescribir_la_evaluacion_no_cambia_una_nota_ya_puesta(entorno):
    """La nota se GUARDA, y no es una caché: recalcularla contra las preguntas
    de hoy cambiaría lo que alguien sacó el mes pasado."""
    http, identidad, _ = entorno
    await _publicar(http, identidad)
    identidad["uid"] = BRUNO
    assert (await _responder(http, aciertos=4)).json()["score_percent"] == 100

    identidad["uid"] = AUTORA
    await http.put(
        f"{LEARNING}/courses/{CURSO}/quiz",
        json={
            "title": "Otra cosa",
            "pass_percent": 90,
            "questions": [
                {
                    "prompt": "Nueva",
                    "options": [
                        {"body": "Correcta", "is_correct": True},
                        {"body": "No", "is_correct": False},
                    ],
                }
            ],
        },
    )

    identidad["uid"] = BRUNO
    historial = (await http.get(f"{LEARNING}/courses/{CURSO}/quiz/attempts")).json()
    assert historial[0]["score_percent"] == 100
    assert historial[0]["passed"] is True


@pytest.mark.asyncio
async def test_sin_la_migracion_se_dice_en_vez_de_fingir(entorno):
    http, identidad, sesiones = entorno
    async with sesiones() as db:
        await db.execute(text("drop table quiz_answers"))
        await db.execute(text("drop table quiz_attempts"))
        await db.execute(text("drop table quiz_options"))
        await db.execute(text("drop table quiz_questions"))
        await db.execute(text("drop table course_quizzes"))
        await db.commit()
    esquema_aprendizaje.olvidar()

    identidad["uid"] = BRUNO
    respuesta = await http.get(f"{LEARNING}/courses/{CURSO}/quiz")
    assert respuesta.status_code == 503
    assert "course_quiz_not_available" in respuesta.text
