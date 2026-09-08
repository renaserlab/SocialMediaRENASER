"""Notas privadas de una lección: de quién son y quién no puede leerlas.

Lo que estas pruebas sostienen es una sola frase: una nota es de quien la
escribió y de nadie más. No hay ruta para leer la de otra persona —ni para el
autor del curso, ni para moderación—, así que lo que se comprueba es que
NINGUNA de las que existen la devuelve.
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
from app.modules.learning.models import (
    CourseLesson,
    CourseModule,
    LessonNote,
    Purchase,
)
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db

LEARNING = "/api/v1/learning"
AUTORA = "cccccccc-0000-0000-0000-00000000000a"
BRUNO = "bbbbbbbb-0000-0000-0000-000000000002"
CARLA = "bbbbbbbb-0000-0000-0000-000000000003"
MODERADOR = "dddddddd-0000-0000-0000-000000000003"
CURSO = "cccccccc-0000-0000-0000-000000000001"
PRECIO = 4900


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
        lecciones = []
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
        # Bruno compró. Carla no.
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


async def _anotar(http, leccion: str, texto: str, segundos=None, clave=None):
    cuerpo: dict = {"body": texto}
    if segundos is not None:
        cuerpo["position_seconds"] = segundos
    cabeceras = {"Idempotency-Key": clave} if clave else None
    return await http.post(
        f"{LEARNING}/lessons/{leccion}/notes", json=cuerpo, headers=cabeceras
    )


# --------------------------------------------------------------------------- #
# De quién es una nota
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_quien_compro_puede_anotar_y_lo_ve(entorno):
    http, _, _, lecciones = entorno
    respuesta = await _anotar(http, lecciones[0], "Aplicar esto al equipo", 522)
    assert respuesta.status_code == 201, respuesta.text
    cuerpo = respuesta.json()
    assert cuerpo["body"] == "Aplicar esto al equipo"
    assert cuerpo["position_seconds"] == 522
    assert cuerpo["lesson_id"] == lecciones[0]

    listado = (await http.get(f"{LEARNING}/lessons/{lecciones[0]}/notes")).json()
    assert [n["id"] for n in listado] == [cuerpo["id"]]


@pytest.mark.asyncio
async def test_sin_acceso_al_curso_no_se_anota(entorno):
    """Tomar apuntes de una lección que no se puede abrir no es un caso real, y
    sin la comprobación cualquiera escribiría filas de cualquier curso."""
    http, identidad, sesiones, lecciones = entorno
    identidad["uid"] = CARLA
    respuesta = await _anotar(http, lecciones[0], "Nota de alguien sin acceso")
    assert respuesta.status_code == 403
    assert "lesson_notes_access_required" in respuesta.text
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(LessonNote)) == 0


@pytest.mark.asyncio
async def test_la_autora_del_curso_no_ve_las_notas_de_su_alumno(entorno):
    """Una nota privada que el vendedor puede leer no es privada."""
    http, identidad, _, lecciones = entorno
    assert (await _anotar(http, lecciones[0], "Esto no lo entendí")).status_code == 201

    identidad["uid"] = AUTORA
    ajenas = (await http.get(f"{LEARNING}/lessons/{lecciones[0]}/notes")).json()
    assert ajenas == []


@pytest.mark.asyncio
async def test_moderacion_tampoco_las_ve(entorno):
    """No se moderan: no se publican en ningún sitio."""
    http, identidad, _, lecciones = entorno
    assert (await _anotar(http, lecciones[0], "Apunte privado")).status_code == 201

    identidad["uid"] = MODERADOR
    assert (await http.get(f"{LEARNING}/lessons/{lecciones[0]}/notes")).json() == []


@pytest.mark.asyncio
async def test_otro_alumno_tampoco(entorno):
    http, identidad, sesiones, lecciones = entorno
    assert (await _anotar(http, lecciones[0], "Mi apunte")).status_code == 201

    # Carla compra después: tiene acceso al curso, pero no a lo que otro escribió.
    async with sesiones() as db:
        db.add(
            Purchase(
                user_id=CARLA,
                course_id=CURSO,
                provider="stripe",
                amount_minor=PRECIO,
                currency="PEN",
                status="paid",
            )
        )
        await db.commit()
    identidad["uid"] = CARLA
    assert (await http.get(f"{LEARNING}/lessons/{lecciones[0]}/notes")).json() == []


@pytest.mark.asyncio
async def test_no_se_edita_ni_se_borra_la_de_otro(entorno):
    """404 y no 403: decir «existe pero no es tuya» ya cuenta algo de lo que
    otra persona escribió."""
    http, identidad, sesiones, lecciones = entorno
    mia = (await _anotar(http, lecciones[0], "Mi apunte")).json()

    identidad["uid"] = AUTORA
    assert (
        await http.patch(f"{LEARNING}/notes/{mia['id']}", json={"body": "Cambiada"})
    ).status_code == 404
    assert (await http.delete(f"{LEARNING}/notes/{mia['id']}")).status_code == 404

    async with sesiones() as db:
        fila = await db.get(LessonNote, mia["id"])
        assert fila is not None and fila.body == "Mi apunte"


# --------------------------------------------------------------------------- #
# La versión estudiada
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_la_nota_queda_atada_a_la_version_que_se_estudiaba(entorno):
    http, _, sesiones, lecciones = entorno
    async with sesiones() as db:
        db.add(
            CourseVersion(
                course_id=CURSO, version=3, status="published", content_hash="abc"
            )
        )
        await db.commit()

    cuerpo = (await _anotar(http, lecciones[0], "Sobre la versión 3")).json()
    assert cuerpo["course_version"] == 3


@pytest.mark.asyncio
async def test_sin_version_publicada_no_se_inventa_una(entorno):
    """Hoy es el caso de todo curso que no se ha vuelto a publicar."""
    http, _, _, lecciones = entorno
    cuerpo = (await _anotar(http, lecciones[0], "Sin versión")).json()
    assert cuerpo["course_version"] is None


@pytest.mark.asyncio
async def test_editar_no_cambia_la_version_anotada(entorno):
    """Dice cuándo se estudió, no cuándo se corrigió la falta de ortografía."""
    http, _, sesiones, lecciones = entorno
    async with sesiones() as db:
        db.add(
            CourseVersion(
                course_id=CURSO, version=1, status="published", content_hash="abc"
            )
        )
        await db.commit()
    mia = (await _anotar(http, lecciones[0], "Con falta")).json()

    async with sesiones() as db:
        await db.execute(
            text("update course_versions set status = 'superseded' where version = 1")
        )
        db.add(
            CourseVersion(
                course_id=CURSO, version=2, status="published", content_hash="def"
            )
        )
        await db.commit()

    editada = await http.patch(
        f"{LEARNING}/notes/{mia['id']}", json={"body": "Sin falta"}
    )
    assert editada.status_code == 200, editada.text
    assert editada.json()["body"] == "Sin falta"
    assert editada.json()["course_version"] == 1, "la versión estudiada era la 1"


# --------------------------------------------------------------------------- #
# Lo que no se acepta
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
@pytest.mark.parametrize("texto", ["", "   ", "\n\t "])
async def test_una_nota_vacia_no_es_una_nota(entorno, texto):
    http, _, sesiones, lecciones = entorno
    assert (await _anotar(http, lecciones[0], texto)).status_code == 422
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(LessonNote)) == 0


@pytest.mark.asyncio
async def test_el_texto_tiene_tope(entorno):
    http, _, _, lecciones = entorno
    assert (await _anotar(http, lecciones[0], "x" * 2001)).status_code == 422
    assert (await _anotar(http, lecciones[0], "x" * 2000)).status_code == 201


@pytest.mark.asyncio
async def test_una_posicion_negativa_se_rechaza(entorno):
    http, _, _, lecciones = entorno
    assert (await _anotar(http, lecciones[0], "Nota", -1)).status_code == 422


@pytest.mark.asyncio
async def test_sin_posicion_no_se_pone_cero(entorno):
    """Cero diría «al principio del vídeo», y no es lo que pasó."""
    http, _, _, lecciones = entorno
    assert (await _anotar(http, lecciones[0], "Nota")).json()["position_seconds"] is None


@pytest.mark.asyncio
async def test_un_doble_toque_no_crea_dos_notas(entorno):
    """La unicidad la sostiene la clave primaria: el id se DERIVA de la clave."""
    http, _, sesiones, lecciones = entorno
    primera = await _anotar(http, lecciones[0], "Apunte", clave="abc-123")
    segunda = await _anotar(http, lecciones[0], "Apunte", clave="abc-123")
    assert primera.status_code == 201
    assert segunda.status_code == 201
    assert primera.json()["id"] == segunda.json()["id"]
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(LessonNote)) == 1


@pytest.mark.asyncio
async def test_la_misma_clave_en_otra_leccion_si_crea_otra_nota(entorno):
    """Sin el ámbito, reusar la clave devolvería la nota de la lección anterior."""
    http, _, sesiones, lecciones = entorno
    a = await _anotar(http, lecciones[0], "Apunte", clave="misma")
    b = await _anotar(http, lecciones[1], "Apunte", clave="misma")
    assert a.json()["id"] != b.json()["id"]
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(LessonNote)) == 2


# --------------------------------------------------------------------------- #
# Editar y retirar
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_se_edita_la_propia(entorno):
    http, _, _, lecciones = entorno
    mia = (await _anotar(http, lecciones[0], "Primera versión", 100)).json()
    editada = await http.patch(
        f"{LEARNING}/notes/{mia['id']}", json={"body": "Segunda versión"}
    )
    assert editada.status_code == 200
    assert editada.json()["body"] == "Segunda versión"
    assert editada.json()["position_seconds"] == 100, "un PATCH cambia lo que trae"


@pytest.mark.asyncio
async def test_un_patch_vacio_no_pasa_por_valido(entorno):
    http, _, _, lecciones = entorno
    mia = (await _anotar(http, lecciones[0], "Nota")).json()
    respuesta = await http.patch(f"{LEARNING}/notes/{mia['id']}", json={})
    assert respuesta.status_code == 422
    assert "lesson_note_no_changes" in respuesta.text


@pytest.mark.asyncio
async def test_no_se_deja_vacia_al_editar(entorno):
    http, _, _, lecciones = entorno
    mia = (await _anotar(http, lecciones[0], "Nota")).json()
    assert (
        await http.patch(f"{LEARNING}/notes/{mia['id']}", json={"body": "   "})
    ).status_code == 422


@pytest.mark.asyncio
async def test_se_retira_la_propia_y_se_borra_de_verdad(entorno):
    """Es suya: no se oculta, se borra."""
    http, _, sesiones, lecciones = entorno
    mia = (await _anotar(http, lecciones[0], "Nota")).json()
    assert (await http.delete(f"{LEARNING}/notes/{mia['id']}")).status_code == 204
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(LessonNote)) == 0


# --------------------------------------------------------------------------- #
# El listado
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_las_notas_de_otra_leccion_no_se_mezclan(entorno):
    http, _, _, lecciones = entorno
    await _anotar(http, lecciones[0], "De la primera")
    await _anotar(http, lecciones[1], "De la segunda")

    primera = (await http.get(f"{LEARNING}/lessons/{lecciones[0]}/notes")).json()
    assert [n["body"] for n in primera] == ["De la primera"]


@pytest.mark.asyncio
async def test_sin_la_migracion_se_dice_en_vez_de_fingir(entorno):
    """Sin la 0057 no hay notas: 503 con su código, no una lista vacía que
    diría «no has escrito nada»."""
    http, _, sesiones, lecciones = entorno
    async with sesiones() as db:
        await db.execute(text("drop table lesson_notes"))
        await db.commit()
    esquema_aprendizaje.olvidar()

    listado = await http.get(f"{LEARNING}/lessons/{lecciones[0]}/notes")
    assert listado.status_code == 503
    assert "lesson_notes_not_available" in listado.text
    creacion = await _anotar(http, lecciones[0], "Nota")
    assert creacion.status_code == 503
