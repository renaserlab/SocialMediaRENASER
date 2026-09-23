"""Terminar un curso y el certificado que sale de ello.

Las tres garantías que sostienen todo lo demás:

  * **Terminar lo decide el servidor.** Ni un porcentaje que mande el cliente,
    ni haber abierto la última pantalla.
  * **El código público no se puede adivinar.** Es la única defensa de una
    página que cualquiera puede abrir sin sesión.
  * **La verificación pública no cuenta nada de la persona** más allá de lo que
    hace falta para verificar: ni correo, ni identificador, ni compra.
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
from app.modules.learning import certificados, esquema as esquema_aprendizaje
from app.modules.learning import finalizacion
from app.modules.learning.models import (
    CourseCertificate,
    CourseLesson,
    CourseModule,
    Purchase,
)
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db

LEARNING = "/api/v1/learning"
AUTORA = "cccccccc-0000-0000-0000-00000000000a"
BRUNO = "bbbbbbbb-0000-0000-0000-000000000002"
CARLA = "bbbbbbbb-0000-0000-0000-000000000003"
ADMIN = "dddddddd-0000-0000-0000-000000000004"
CURSO = "cccccccc-0000-0000-0000-000000000001"
PRECIO = 4900


# --------------------------------------------------------------------------- #
# 1. La regla, sin base de datos
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "totales,hechas,exige,aprobada,esperado",
    [
        (4, 4, False, False, True),   # sin evaluación, basta con las lecciones
        (4, 3, False, False, False),  # falta una lección
        (4, 4, True, False, False),   # hay evaluación y no está aprobada
        (4, 4, True, True, True),
        (4, 3, True, True, False),    # aprobó pero le falta contenido
        (0, 0, False, False, False),  # un curso sin lecciones NO está terminado
    ],
)
def test_cuando_un_curso_esta_terminado(totales, hechas, exige, aprobada, esperado):
    assert (
        finalizacion.esta_terminado(
            lecciones_totales=totales,
            lecciones_hechas=hechas,
            exige_evaluacion=exige,
            evaluacion_aprobada=aprobada,
        )
        is esperado
    )


def test_cero_de_cero_no_es_el_cien_por_cien():
    """Es el 100 % en aritmética y una afirmación falsa en producto."""
    assert (
        finalizacion.esta_terminado(
            lecciones_totales=0,
            lecciones_hechas=0,
            exige_evaluacion=False,
            evaluacion_aprobada=False,
        )
        is False
    )


def test_el_codigo_publico_no_es_correlativo():
    """Un código con año y contador se recorre entero en una tarde.

    Comprobar solo que no se repiten NO valdRÍA: un contador tampoco se repite.
    Lo que se comprueba es que no se parecen: 128 bits de azar en hexadecimal
    son 32 caracteres fijos, y dos códigos cualesquiera comparten un prefijo
    ridículo. Un correlativo comparte casi todo.
    """
    codigos = [certificados.nuevo_codigo_publico() for _ in range(300)]
    assert len(set(codigos)) == 300

    for codigo in codigos[:5]:
        assert codigo.startswith("ZC-")
        cuerpo = codigo[3:]
        assert len(cuerpo) == 32, "128 bits, ni uno menos"
        assert all(c in "0123456789abcdef" for c in cuerpo)

    def comun(a: str, b: str) -> int:
        n = 0
        for x, y in zip(a, b):
            if x != y:
                break
            n += 1
        return n

    ordenados = sorted(c[3:] for c in codigos)
    peor = max(comun(a, b) for a, b in zip(ordenados, ordenados[1:]))
    assert peor < 10, f"dos codigos comparten {peor} caracteres: son adivinables"


def test_el_nombre_cae_al_usuario_y_nunca_se_inventa():
    class Perfil:
        def __init__(self, full_name="", username=""):
            self.full_name = full_name
            self.username = username

    assert certificados.nombre_para_el_certificado(Perfil("Ana Pérez")) == "Ana Pérez"
    assert certificados.nombre_para_el_certificado(Perfil("", "ana")) == "@ana"
    # Sin nada, vacío. Un certificado a nombre de «Usuario» no certifica a nadie.
    assert certificados.nombre_para_el_certificado(Perfil()) == ""
    assert certificados.nombre_para_el_certificado(None) == ""


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

    lecciones: list[str] = []
    async with sesiones() as db:
        db.add(Profile(id=AUTORA, full_name="Carla Autora", username="carlaa"))
        db.add(Profile(id=BRUNO, full_name="Bruno Díaz", username="bruno"))
        db.add(Profile(id=CARLA, full_name="Carla", username="carla"))
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
        db.add(
            CourseVersion(
                course_id=CURSO, version=2, status="published", content_hash="abc"
            )
        )
        modulo = CourseModule(course_id=CURSO, title="Módulo", sort_order=0)
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

    identidad = {"uid": BRUNO}

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
        yield http, identidad, sesiones, lecciones
    for dep in (get_db, get_current_user, get_optional_user):
        app.dependency_overrides.pop(dep, None)
    await engine.dispose()


async def _terminar(http, lecciones):
    for leccion in lecciones:
        respuesta = await http.post(f"{LEARNING}/lessons/{leccion}/complete")
        assert respuesta.status_code == 200, respuesta.text


# --------------------------------------------------------------------------- #
# Terminar
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_terminar_las_lecciones_cierra_un_curso_sin_evaluacion(entorno):
    http, _, _, lecciones = entorno
    await _terminar(http, lecciones)

    estado = (await http.get(f"{LEARNING}/courses/{CURSO}/completion")).json()
    assert estado["completed"] is True
    assert estado["progress_percent"] == 100
    assert estado["lessons_completed"] == estado["lessons_total"] == 2
    assert estado["quiz_required"] is False
    assert estado["completed_at"] is not None


@pytest.mark.asyncio
async def test_con_una_leccion_pendiente_no_esta_terminado(entorno):
    http, _, _, lecciones = entorno
    await _terminar(http, lecciones[:1])

    estado = (await http.get(f"{LEARNING}/courses/{CURSO}/completion")).json()
    assert estado["completed"] is False
    assert estado["completed_at"] is None
    assert estado["progress_percent"] == 50


@pytest.mark.asyncio
async def test_con_evaluacion_publicada_hace_falta_aprobarla(entorno):
    http, identidad, _, lecciones = entorno
    identidad["uid"] = AUTORA
    await http.put(
        f"{LEARNING}/courses/{CURSO}/quiz",
        json={
            "title": "Final",
            "pass_percent": 70,
            "questions": [
                {
                    "prompt": "¿Cuál?",
                    "options": [
                        {"body": "Correcta", "is_correct": True},
                        {"body": "No", "is_correct": False},
                    ],
                }
            ],
        },
    )
    await http.post(f"{LEARNING}/courses/{CURSO}/quiz/publish")

    identidad["uid"] = BRUNO
    await _terminar(http, lecciones)
    estado = (await http.get(f"{LEARNING}/courses/{CURSO}/completion")).json()
    assert estado["quiz_required"] is True
    assert estado["completed"] is False, "faltan las lecciones no: falta aprobar"

    # Y al aprobarla, se cierra.
    vista = (await http.get(f"{LEARNING}/courses/{CURSO}/quiz")).json()
    intento = (await http.post(f"{LEARNING}/courses/{CURSO}/quiz/attempts")).json()
    pregunta = vista["questions"][0]
    buena = next(o for o in pregunta["options"] if o["body"] == "Correcta")
    await http.post(
        f"{LEARNING}/quiz-attempts/{intento['id']}/submit",
        json={"answers": [{"question_id": pregunta["id"], "option_id": buena["id"]}]},
    )

    estado = (await http.get(f"{LEARNING}/courses/{CURSO}/completion")).json()
    assert estado["quiz_passed"] is True
    assert estado["completed"] is True


@pytest.mark.asyncio
async def test_la_fecha_de_finalizacion_no_se_mueve(entorno):
    """Añadir una lección al curso no puede cambiar el día en que alguien lo
    terminó: sería reescribir su certificado."""
    http, _, sesiones, lecciones = entorno
    await _terminar(http, lecciones)
    primera = (await http.get(f"{LEARNING}/courses/{CURSO}/completion")).json()

    for _ in range(3):
        otra = (await http.get(f"{LEARNING}/courses/{CURSO}/completion")).json()
        assert otra["completed_at"] == primera["completed_at"]

    async with sesiones() as db:
        assert (
            await db.scalar(
                select(func.count()).select_from(
                    __import__(
                        "app.modules.learning.models", fromlist=["CourseCompletion"]
                    ).CourseCompletion
                )
            )
            == 1
        )


# --------------------------------------------------------------------------- #
# Emitir
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_no_se_emite_sin_terminar(entorno):
    http, _, sesiones, lecciones = entorno
    await _terminar(http, lecciones[:1])
    respuesta = await http.post(f"{LEARNING}/courses/{CURSO}/certificate")
    assert respuesta.status_code == 422
    assert "certificate_course_not_completed" in respuesta.text
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(CourseCertificate)) == 0


@pytest.mark.asyncio
async def test_se_emite_al_terminar_y_copia_lo_que_habia(entorno):
    http, _, sesiones, lecciones = entorno
    await _terminar(http, lecciones)
    respuesta = await http.post(f"{LEARNING}/courses/{CURSO}/certificate")
    assert respuesta.status_code == 201, respuesta.text
    cuerpo = respuesta.json()
    assert cuerpo["display_name"] == "Bruno Díaz"
    assert cuerpo["course_title"] == "Respiración"
    assert cuerpo["author_name"] == "Carla Autora"
    assert cuerpo["course_version"] == 2
    assert cuerpo["status"] == "valid"
    assert cuerpo["public_id"] in cuerpo["verify_url"]

    # Cambiar el nombre después NO cambia el certificado.
    async with sesiones() as db:
        perfil = await db.get(Profile, BRUNO)
        perfil.full_name = "Otro Nombre"
        await db.commit()
    mios = (await http.get(f"{LEARNING}/me/certificates")).json()
    assert mios[0]["display_name"] == "Bruno Díaz"


@pytest.mark.asyncio
async def test_dos_toques_no_emiten_dos_certificados(entorno):
    http, _, sesiones, lecciones = entorno
    await _terminar(http, lecciones)
    primero = await http.post(f"{LEARNING}/courses/{CURSO}/certificate")
    segundo = await http.post(f"{LEARNING}/courses/{CURSO}/certificate")
    assert primero.json()["public_id"] == segundo.json()["public_id"]
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(CourseCertificate)) == 1


@pytest.mark.asyncio
async def test_sin_acceso_vigente_no_hay_certificado(entorno):
    """Quien devolvió el curso no se lleva uno de camino a la puerta."""
    http, _, sesiones, lecciones = entorno
    await _terminar(http, lecciones)
    async with sesiones() as db:
        compra = await db.scalar(select(Purchase))
        compra.status = "refunded"
        await db.commit()

    respuesta = await http.post(f"{LEARNING}/courses/{CURSO}/certificate")
    assert respuesta.status_code == 403
    assert "certificate_access_required" in respuesta.text


@pytest.mark.asyncio
async def test_el_certificado_de_otro_no_sale_en_los_mios(entorno):
    http, identidad, _, lecciones = entorno
    await _terminar(http, lecciones)
    await http.post(f"{LEARNING}/courses/{CURSO}/certificate")

    identidad["uid"] = CARLA
    assert (await http.get(f"{LEARNING}/me/certificates")).json() == []


# --------------------------------------------------------------------------- #
# Verificación pública
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_cualquiera_verifica_con_el_codigo(entorno):
    http, identidad, _, lecciones = entorno
    await _terminar(http, lecciones)
    codigo = (await http.post(f"{LEARNING}/courses/{CURSO}/certificate")).json()[
        "public_id"
    ]

    identidad["uid"] = CARLA  # otra persona cualquiera
    respuesta = await http.get(f"{LEARNING}/certificates/{codigo}")
    assert respuesta.status_code == 200, respuesta.text
    cuerpo = respuesta.json()
    assert cuerpo["display_name"] == "Bruno Díaz"
    assert cuerpo["course_title"] == "Respiración"
    assert cuerpo["status"] == "valid"


@pytest.mark.asyncio
async def test_la_verificacion_no_cuenta_nada_mas(entorno):
    """Ni correo, ni identificador de usuario, ni compra, ni importe."""
    http, _, _, lecciones = entorno
    await _terminar(http, lecciones)
    codigo = (await http.post(f"{LEARNING}/courses/{CURSO}/certificate")).json()[
        "public_id"
    ]

    cuerpo = (await http.get(f"{LEARNING}/certificates/{codigo}")).json()
    assert set(cuerpo.keys()) == {
        "public_id",
        "display_name",
        "course_title",
        "author_name",
        "course_version",
        "completed_at",
        "issued_at",
        "status",
    }
    texto = (await http.get(f"{LEARNING}/certificates/{codigo}")).text
    for filtrado in (BRUNO, "x@y.z", str(PRECIO), CURSO):
        assert filtrado not in texto, f"«{filtrado}» no puede salir en público"


@pytest.mark.asyncio
async def test_un_codigo_que_no_existe_no_dice_si_existiria(entorno):
    http, _, _, _ = entorno
    respuesta = await http.get(f"{LEARNING}/certificates/ZC-0000000000000000")
    assert respuesta.status_code == 404
    assert "certificate_not_found" in respuesta.text


# --------------------------------------------------------------------------- #
# Revocar
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_solo_administracion_revoca(entorno):
    http, identidad, sesiones, lecciones = entorno
    await _terminar(http, lecciones)
    codigo = (await http.post(f"{LEARNING}/courses/{CURSO}/certificate")).json()[
        "public_id"
    ]

    respuesta = await http.post(
        f"{LEARNING}/admin/certificates/{codigo}/revoke",
        json={"reason": "Me arrepiento"},
    )
    assert respuesta.status_code == 403
    async with sesiones() as db:
        fila = await db.scalar(select(CourseCertificate))
        assert fila.status == "valid"


@pytest.mark.asyncio
async def test_revocar_no_borra(entorno):
    http, identidad, sesiones, lecciones = entorno
    await _terminar(http, lecciones)
    codigo = (await http.post(f"{LEARNING}/courses/{CURSO}/certificate")).json()[
        "public_id"
    ]

    identidad["uid"] = ADMIN
    respuesta = await http.post(
        f"{LEARNING}/admin/certificates/{codigo}/revoke",
        json={"reason": "Fraude documentado en el expediente 12."},
    )
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["status"] == "revoked"

    # Sigue existiendo, y la verificación pública lo dice.
    publica = (await http.get(f"{LEARNING}/certificates/{codigo}")).json()
    assert publica["status"] == "revoked"
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(CourseCertificate)) == 1

    # Y sigue en el historial de quien lo obtuvo.
    identidad["uid"] = BRUNO
    mios = (await http.get(f"{LEARNING}/me/certificates")).json()
    assert [c["status"] for c in mios] == ["revoked"]


@pytest.mark.asyncio
async def test_revocar_sin_motivo_no_se_puede(entorno):
    """Revocar sin motivo no se puede auditar."""
    http, identidad, _, lecciones = entorno
    await _terminar(http, lecciones)
    codigo = (await http.post(f"{LEARNING}/courses/{CURSO}/certificate")).json()[
        "public_id"
    ]
    identidad["uid"] = ADMIN
    assert (
        await http.post(
            f"{LEARNING}/admin/certificates/{codigo}/revoke", json={"reason": ""}
        )
    ).status_code == 422


@pytest.mark.asyncio
async def test_sin_la_migracion_se_dice_en_vez_de_fingir(entorno):
    http, _, sesiones, lecciones = entorno
    async with sesiones() as db:
        await db.execute(text("drop table course_certificates"))
        await db.execute(text("drop table course_completions"))
        await db.commit()
    esquema_aprendizaje.olvidar()

    respuesta = await http.post(f"{LEARNING}/courses/{CURSO}/certificate")
    assert respuesta.status_code == 503
    assert "course_certificates_not_available" in respuesta.text

    # Y la finalización se SIGUE calculando: lo que falta es su fecha.
    await _terminar(http, lecciones)
    estado = (await http.get(f"{LEARNING}/courses/{CURSO}/completion")).json()
    assert estado["completed"] is True
    assert estado["completed_at"] is None


# --------------------------------------------------------------------------- #
# Lo que encontró la revisión independiente
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_volver_a_completar_una_leccion_ya_hecha_no_rompe_nada(entorno):
    """Registrar la finalización es idempotente: la segunda vez no hace nada.

    NO prueba la carrera —para eso está la prueba de más abajo, que sí llega al
    choque—: prueba el camino normal, en el que la fila ya está y se sale antes.
    """
    http, _, sesiones, lecciones = entorno
    await _terminar(http, lecciones)

    # La finalización ya está anotada. Volver a completar una lección pasa otra
    # vez por `registrar`, que ahora choca contra la fila que ya existe.
    respuesta = await http.post(f"{LEARNING}/lessons/{lecciones[0]}/complete")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["completed"] is True
    assert respuesta.json()["course_completed"] is True

    async with sesiones() as db:
        from app.modules.learning.models import LessonProgress

        avance = await db.get(
            LessonProgress, {"user_id": BRUNO, "lesson_id": lecciones[0]}
        )
        assert avance is not None and avance.completed is True


@pytest.mark.asyncio
async def test_el_intento_que_cierra_el_curso_queda_enviado_y_con_su_nota(entorno):
    """`enviar_intento` vuelca el intento y DESPUÉS registra la finalización.

    Las dos cosas tienen que sobrevivir al mismo `commit`.
    """
    http, identidad, _, lecciones = entorno
    identidad["uid"] = AUTORA
    await http.put(
        f"{LEARNING}/courses/{CURSO}/quiz",
        json={
            "title": "Final",
            "pass_percent": 50,
            "questions": [
                {
                    "prompt": "¿Cuál?",
                    "options": [
                        {"body": "Correcta", "is_correct": True},
                        {"body": "No", "is_correct": False},
                    ],
                }
            ],
        },
    )
    await http.post(f"{LEARNING}/courses/{CURSO}/quiz/publish")

    identidad["uid"] = BRUNO
    await _terminar(http, lecciones)
    vista = (await http.get(f"{LEARNING}/courses/{CURSO}/quiz")).json()
    intento = (await http.post(f"{LEARNING}/courses/{CURSO}/quiz/attempts")).json()
    pregunta = vista["questions"][0]
    buena = next(o for o in pregunta["options"] if o["body"] == "Correcta")

    enviado = await http.post(
        f"{LEARNING}/quiz-attempts/{intento['id']}/submit",
        json={"answers": [{"question_id": pregunta["id"], "option_id": buena["id"]}]},
    )
    assert enviado.status_code == 200, enviado.text
    assert enviado.json()["status"] == "submitted"
    assert enviado.json()["score_percent"] == 100
    assert enviado.json()["passed"] is True

    # Y sigue enviado en el historial, no solo en la respuesta.
    historial = (await http.get(f"{LEARNING}/courses/{CURSO}/quiz/attempts")).json()
    assert [i["status"] for i in historial] == ["submitted"]


@pytest.mark.asyncio
async def test_devolver_y_volver_a_ganarlo_repone_el_certificado(entorno):
    """Solo puede haber uno por persona y curso: sin reponerlo, quien devolvió,
    recompró y volvió a terminar se quedaba con el revocado para siempre."""
    http, identidad, sesiones, lecciones = entorno
    await _terminar(http, lecciones)
    codigo = (await http.post(f"{LEARNING}/courses/{CURSO}/certificate")).json()[
        "public_id"
    ]

    identidad["uid"] = ADMIN
    await http.post(
        f"{LEARNING}/admin/certificates/{codigo}/revoke",
        json={"reason": "Devolución total confirmada."},
    )
    identidad["uid"] = BRUNO
    assert (await http.get(f"{LEARNING}/certificates/{codigo}")).json()[
        "status"
    ] == "revoked"

    # Vuelve a tenerlo y vuelve a terminarlo: el certificado vuelve a valer.
    repuesto = await http.post(f"{LEARNING}/courses/{CURSO}/certificate")
    assert repuesto.status_code == 201, repuesto.text
    assert repuesto.json()["status"] == "valid"
    assert repuesto.json()["public_id"] == codigo, "sigue siendo el mismo código"
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(CourseCertificate)) == 1


@pytest.mark.asyncio
async def test_sin_acceso_no_se_repone_un_revocado(entorno):
    """Reponer no puede ser la puerta de atrás del control de acceso."""
    http, identidad, sesiones, lecciones = entorno
    await _terminar(http, lecciones)
    codigo = (await http.post(f"{LEARNING}/courses/{CURSO}/certificate")).json()[
        "public_id"
    ]
    identidad["uid"] = ADMIN
    await http.post(
        f"{LEARNING}/admin/certificates/{codigo}/revoke", json={"reason": "Fraude."}
    )

    identidad["uid"] = BRUNO
    async with sesiones() as db:
        compra = await db.scalar(select(Purchase))
        compra.status = "refunded"
        await db.commit()

    respuesta = await http.post(f"{LEARNING}/courses/{CURSO}/certificate")
    assert respuesta.status_code == 403
    async with sesiones() as db:
        assert (await db.scalar(select(CourseCertificate))).status == "revoked"


@pytest.mark.asyncio
async def test_la_biblioteca_dice_lo_mismo_que_la_finalizacion(entorno):
    """Un curso con evaluación sin aprobar NO está finalizado en ninguna de las
    dos pantallas. Antes la biblioteca lo daba por terminado contando solo
    lecciones, y el certificado se rechazaba a continuación."""
    http, identidad, _, lecciones = entorno
    identidad["uid"] = AUTORA
    await http.put(
        f"{LEARNING}/courses/{CURSO}/quiz",
        json={
            "title": "Final",
            "pass_percent": 70,
            "questions": [
                {
                    "prompt": "¿Cuál?",
                    "options": [
                        {"body": "Correcta", "is_correct": True},
                        {"body": "No", "is_correct": False},
                    ],
                }
            ],
        },
    )
    await http.post(f"{LEARNING}/courses/{CURSO}/quiz/publish")

    identidad["uid"] = BRUNO
    await _terminar(http, lecciones)

    biblioteca = (await http.get(f"{LEARNING}/me/courses")).json()
    mio = next(c for c in biblioteca if c["id"] == CURSO)
    finalizacion_ = (await http.get(f"{LEARNING}/courses/{CURSO}/completion")).json()
    assert finalizacion_["completed"] is False
    assert mio["state"] != "completed", "la biblioteca no puede decir lo contrario"


@pytest.mark.asyncio
async def test_vaciar_una_evaluacion_publicada_no_deja_el_curso_sin_salida(entorno):
    """Sin esto, el curso entero se volvía imposible de terminar para todos.

    Una evaluación publicada y vacía sigue siendo obligatoria, y ninguna nota
    llega al mínimo: nadie puede aprobarla y nadie puede terminar el curso.
    """
    http, identidad, _, lecciones = entorno
    identidad["uid"] = AUTORA
    await http.put(
        f"{LEARNING}/courses/{CURSO}/quiz",
        json={
            "title": "Final",
            "pass_percent": 70,
            "questions": [
                {
                    "prompt": "¿Cuál?",
                    "options": [
                        {"body": "Correcta", "is_correct": True},
                        {"body": "No", "is_correct": False},
                    ],
                }
            ],
        },
    )
    await http.post(f"{LEARNING}/courses/{CURSO}/quiz/publish")

    vaciada = await http.put(
        f"{LEARNING}/courses/{CURSO}/quiz",
        json={"title": "Final", "pass_percent": 70, "questions": []},
    )
    assert vaciada.status_code == 200, vaciada.text
    assert vaciada.json()["status"] == "draft", "deja de ser obligatoria"

    identidad["uid"] = BRUNO
    await _terminar(http, lecciones)
    estado = (await http.get(f"{LEARNING}/courses/{CURSO}/completion")).json()
    assert estado["quiz_required"] is False
    assert estado["completed"] is True


@pytest.mark.asyncio
async def test_perder_la_carrera_no_deshace_el_trabajo_de_quien_la_pierde(
    entorno, monkeypatch
):
    """El choque contra la clave primaria se recoge en un SAVEPOINT.

    ESTA ES LA PRUEBA QUE LLEGA AL CHOQUE. En el camino normal no se alcanza
    —`registrar` sale antes cuando la fila ya está—, así que se reproduce lo
    único que lo provoca: dos peticiones que MIRARON a la vez y vieron el curso
    terminado y sin fecha, y una de las dos inserta después de la otra.

    Con el `db.rollback()` de antes, la que perdía la carrera perdía también su
    propio trabajo sin confirmar: aquí, el progreso que acababa de guardar.
    """
    from dataclasses import replace

    from app.modules.learning.models import CourseCompletion, LessonProgress

    http, _, sesiones, lecciones = entorno
    await _terminar(http, lecciones)

    # Lo que vio la petición que va a perder: terminado y todavía sin fecha.
    real = finalizacion.calcular

    async def como_antes_de_la_otra(db, *, user_id, course_id):
        estado = await real(db, user_id=user_id, course_id=course_id)
        return replace(estado, terminado=True, terminado_en=None)

    monkeypatch.setattr(finalizacion, "calcular", como_antes_de_la_otra)

    async with sesiones() as db:
        # Trabajo suyo, volcado y SIN confirmar.
        avance = await db.get(
            LessonProgress, {"user_id": BRUNO, "lesson_id": lecciones[0]}
        )
        assert avance is not None
        avance.progress_seconds = 777
        await db.flush()

        # Y ahora choca contra la fila que la otra petición ya dejó.
        await finalizacion.registrar(db, user_id=BRUNO, course_id=CURSO)
        await db.commit()

    async with sesiones() as db:
        avance = await db.get(
            LessonProgress, {"user_id": BRUNO, "lesson_id": lecciones[0]}
        )
        assert avance is not None
        assert avance.progress_seconds == 777, "el choque se llevó por delante su avance"
        # Y la finalización sigue siendo UNA, con la fecha de la primera.
        assert (
            await db.scalar(select(func.count()).select_from(CourseCompletion))
        ) == 1
