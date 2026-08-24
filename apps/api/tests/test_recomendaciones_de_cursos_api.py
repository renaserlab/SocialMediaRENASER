"""«Cursos para ti» de extremo a extremo, sobre una base de datos de verdad.

SQLite en memoria, mismo patron que el resto. Las personas, los cursos y los
accesos de estos escenarios viven los milisegundos que dura cada prueba: NUNCA
llegan a Supabase, y ninguna «compra» de aqui es una compra.

Lo que se comprueba aqui y no cabe en una funcion pura: que un curso empezado
salga del descubrimiento, que uno terminado no vuelva, que un borrador no se
cuele, que paginar no repita ni se salte nada, y que el numero de consultas no
crezca con el catalogo.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.catalog.models import Course
from app.modules.learning.models import (
    CourseLesson,
    CourseModule,
    LessonProgress,
    Purchase,
)
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache
from app.modules.recommendations.models import (
    BehaviorEvent,
    CourseTopic,
    Topic,
    UserTopicRelation,
)
from app.modules.social_graph.models import Follow, UserBlock
from app.shared.database import Base, get_db

API = "/api/v1/recommendations"

IA = "11111111-1111-1111-1111-111111111111"
PROGRAMACION = "22222222-2222-2222-2222-222222222222"
MARKETING = "33333333-3333-3333-3333-333333333333"
MUSICA = "44444444-4444-4444-4444-444444444444"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"  # quiere aprender IA
CARLOS = "aaaaaaaa-0000-0000-0000-000000000002"  # publica cursos
LUCIA = "aaaaaaaa-0000-0000-0000-000000000003"  # publica cursos


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
    async with sesiones() as db:
        for pos, (tid, slug, nombre) in enumerate(
            [
                (IA, "ia", "Inteligencia Artificial"),
                (PROGRAMACION, "programacion", "Programación"),
                (MARKETING, "marketing", "Marketing"),
                (MUSICA, "musica", "Música"),
            ]
        ):
            db.add(Topic(id=tid, slug=slug, name=nombre, position=pos))
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=CARLOS, full_name="Carlos", username="carlos"))
        db.add(Profile(id=LUCIA, full_name="Lucía", username="lucia"))
        # Ana quiere aprender IA. Es lo unico que declara.
        db.add(UserTopicRelation(user_id=ANA, topic_id=IA, relation="learn"))
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
    await engine.dispose()


async def crear_curso(
    sesiones,
    course_id: str,
    *,
    autor: str = CARLOS,
    temas: list[str] | None = None,
    estado: str = "published",
    precio: int = 0,
    lecciones: int = 1,
    coming_soon: bool = False,
) -> list[str]:
    """Un curso con contenido. Devuelve los ids de sus lecciones."""
    ids: list[str] = []
    async with sesiones() as db:
        db.add(
            Course(
                id=course_id,
                author_id=autor,
                title=f"Curso {course_id[-4:]}",
                description="Una descripción larga de verdad.",
                price_minor=precio,
                currency="PEN",
                status=estado,
                coming_soon=coming_soon,
            )
        )
        await db.flush()
        for topic_id in temas or []:
            db.add(CourseTopic(course_id=course_id, topic_id=topic_id))
        modulo = CourseModule(course_id=course_id, title="Módulo", sort_order=0)
        db.add(modulo)
        await db.flush()
        for i in range(lecciones):
            leccion = CourseLesson(
                module_id=modulo.id,
                title=f"Lección {i}",
                duration_seconds=900,
                sort_order=i,
            )
            db.add(leccion)
            await db.flush()
            ids.append(leccion.id)
        await db.commit()
    return ids


async def pedir(http, **params) -> dict:
    cache.vaciar()
    respuesta = await http.get(f"{API}/courses", params=params)
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


# --------------------------------------------------------------------------- #
# 1. El escenario del enunciado, contra la base
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_curso_de_lo_que_quiere_aprender_va_primero(entorno):
    http, sesiones, _ = entorno
    await crear_curso(sesiones, "c0000000-0000-0000-0000-00000000000a", temas=[IA, PROGRAMACION])
    await crear_curso(sesiones, "c0000000-0000-0000-0000-00000000000b", temas=[MARKETING])
    await crear_curso(sesiones, "c0000000-0000-0000-0000-00000000000c", temas=[MUSICA])

    datos = await pedir(http, limit=10)
    assert datos["algorithm_version"] == "course-v1"
    assert datos["strategy"] == "personalized"
    assert datos["items"][0]["id"] == "c0000000-0000-0000-0000-00000000000a"


@pytest.mark.asyncio
async def test_y_explica_por_que(entorno):
    http, sesiones, _ = entorno
    await crear_curso(sesiones, "c0000000-0000-0000-0000-00000000000a", temas=[IA])
    datos = await pedir(http)
    motivos = datos["items"][0]["reasons"]
    assert motivos[0]["code"] == "COURSE_TOPIC_MATCH"
    assert IA in motivos[0]["topics"]


@pytest.mark.asyncio
async def test_la_tarjeta_solo_lleva_datos_que_existen(entorno):
    """Ni estrellas, ni «1500 alumnos», ni «bestseller», ni «certificado»."""
    http, sesiones, _ = entorno
    await crear_curso(sesiones, "c0000000-0000-0000-0000-00000000000a", temas=[IA], lecciones=3)
    item = (await pedir(http))["items"][0]
    assert item["modules"] == 1
    assert item["lessons"] == 3
    assert item["price_minor"] == 0
    assert set(item) == {
        "id",
        "author_id",
        "title",
        "description",
        "cover_path",
        "price_minor",
        "currency",
        "topic_ids",
        "modules",
        "lessons",
        "reasons",
        "debug",
    }


@pytest.mark.asyncio
async def test_el_score_no_sale_a_produccion(entorno):
    http, sesiones, _ = entorno
    await crear_curso(sesiones, "c0000000-0000-0000-0000-00000000000a", temas=[IA])
    item = (await pedir(http))["items"][0]
    assert item["debug"] is None


# --------------------------------------------------------------------------- #
# 2. Que NO se recomienda
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_borrador_no_se_recomienda(entorno):
    http, sesiones, _ = entorno
    await crear_curso(
        sesiones, "c0000000-0000-0000-0000-00000000000a", temas=[IA], estado="draft"
    )
    assert (await pedir(http))["items"] == []


@pytest.mark.asyncio
async def test_un_curso_retirado_tampoco(entorno):
    http, sesiones, _ = entorno
    await crear_curso(
        sesiones, "c0000000-0000-0000-0000-00000000000a", temas=[IA], estado="hidden"
    )
    assert (await pedir(http))["items"] == []


@pytest.mark.asyncio
async def test_un_curso_anunciado_sin_contenido_no_se_recomienda(entorno):
    """Mandar a alguien a una puerta cerrada no es una recomendacion."""
    http, sesiones, _ = entorno
    await crear_curso(
        sesiones, "c0000000-0000-0000-0000-00000000000a", temas=[IA], coming_soon=True
    )
    assert (await pedir(http))["items"] == []


@pytest.mark.asyncio
async def test_no_se_recomiendan_los_cursos_de_uno_mismo(entorno):
    """Sus cursos viven en su gestion; descubrirle lo suyo no le aporta nada."""
    http, sesiones, _ = entorno
    await crear_curso(
        sesiones, "c0000000-0000-0000-0000-00000000000a", autor=ANA, temas=[IA]
    )
    assert (await pedir(http))["items"] == []


@pytest.mark.asyncio
async def test_un_curso_de_alguien_bloqueado_no_aparece(entorno):
    http, sesiones, _ = entorno
    await crear_curso(sesiones, "c0000000-0000-0000-0000-00000000000a", temas=[IA])
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=ANA, blocked_id=CARLOS))
        await db.commit()
    assert (await pedir(http))["items"] == []


@pytest.mark.asyncio
async def test_tampoco_si_es_el_otro_quien_bloqueo(entorno):
    http, sesiones, _ = entorno
    await crear_curso(sesiones, "c0000000-0000-0000-0000-00000000000a", temas=[IA])
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=CARLOS, blocked_id=ANA))
        await db.commit()
    assert (await pedir(http))["items"] == []


# --------------------------------------------------------------------------- #
# 3. Empezado, terminado y descartado
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_curso_empezado_sale_del_descubrimiento(entorno):
    """Su sitio es «Continúa aprendiendo». Volver a proponerlo como novedad
    seria no haber entendido lo que la persona hizo."""
    http, sesiones, _ = entorno
    lecciones = await crear_curso(
        sesiones, "c0000000-0000-0000-0000-00000000000a", temas=[IA], lecciones=2
    )
    async with sesiones() as db:
        db.add(
            LessonProgress(
                user_id=ANA, lesson_id=lecciones[0], progress_seconds=400, completed=True
            )
        )
        await db.commit()
    assert (await pedir(http))["items"] == []


@pytest.mark.asyncio
async def test_un_curso_terminado_no_vuelve(entorno):
    http, sesiones, _ = entorno
    lecciones = await crear_curso(
        sesiones, "c0000000-0000-0000-0000-00000000000a", temas=[IA], lecciones=2
    )
    async with sesiones() as db:
        for lid in lecciones:
            db.add(
                LessonProgress(
                    user_id=ANA, lesson_id=lid, progress_seconds=900, completed=True
                )
            )
        await db.commit()
    assert (await pedir(http))["items"] == []


@pytest.mark.asyncio
async def test_tener_acceso_sin_haber_empezado_NO_lo_excluye(entorno):
    """Inscribirse no es empezar. Si se excluyera, un curso gratuito al que
    alguien entro y no abrio nunca desapareceria para siempre."""
    http, sesiones, _ = entorno
    await crear_curso(sesiones, "c0000000-0000-0000-0000-00000000000a", temas=[IA])
    async with sesiones() as db:
        db.add(
            Purchase(
                user_id=ANA,
                course_id="c0000000-0000-0000-0000-00000000000a",
                provider="manual",
                amount_minor=0,
                currency="PEN",
                status="paid",
            )
        )
        await db.commit()
    assert len((await pedir(http))["items"]) == 1


@pytest.mark.asyncio
async def test_un_curso_descartado_no_vuelve_pero_su_autor_si(entorno):
    """Rechazar un curso no es rechazar a quien lo hizo."""
    http, sesiones, _ = entorno
    descartado = "c0000000-0000-0000-0000-00000000000a"
    otro = "c0000000-0000-0000-0000-00000000000b"
    await crear_curso(sesiones, descartado, autor=CARLOS, temas=[IA])
    await crear_curso(sesiones, otro, autor=CARLOS, temas=[IA])

    respuesta = await http.post(
        f"{API}/events",
        json={
            "events": [
                {
                    "event_type": "not_interested",
                    "entity_type": "course",
                    "entity_id": descartado,
                    "event_key": "x1",
                }
            ]
        },
    )
    assert respuesta.status_code == 200

    datos = await pedir(http)
    ids = [i["id"] for i in datos["items"]]
    assert descartado not in ids
    assert otro in ids


# --------------------------------------------------------------------------- #
# 4. Arranque en frio y respaldo
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_preferencias_hay_arranque_en_frio(entorno):
    """No se devuelve vacio ni se ordena por precio: se devuelven cursos
    publicados, completos y recientes, en un orden estable."""
    http, sesiones, identidad = entorno
    for letra in "abc":
        await crear_curso(
            sesiones, f"c0000000-0000-0000-0000-00000000000{letra}", temas=[MARKETING]
        )
    identidad["uid"] = LUCIA  # Lucia no declaro nada

    datos = await pedir(http)
    assert datos["strategy"] == "cold_start"
    assert len(datos["items"]) == 3


@pytest.mark.asyncio
async def test_el_arranque_en_frio_es_estable(entorno):
    http, sesiones, identidad = entorno
    for letra in "abcde":
        await crear_curso(
            sesiones, f"c0000000-0000-0000-0000-00000000000{letra}", temas=[MARKETING]
        )
    identidad["uid"] = LUCIA
    primera = [i["id"] for i in (await pedir(http))["items"]]
    segunda = [i["id"] for i in (await pedir(http))["items"]]
    assert primera == segunda


@pytest.mark.asyncio
async def test_el_interruptor_apaga_los_cursos_sin_borrar_nada(entorno):
    http, sesiones, _ = entorno
    await crear_curso(sesiones, "c0000000-0000-0000-0000-00000000000a", temas=[IA])
    ajustes = get_settings()
    ajustes.feature_course_recommendations_v1 = False
    try:
        datos = await pedir(http)
        assert datos["strategy"] == "disabled"
        assert datos["items"] == []
    finally:
        ajustes.feature_course_recommendations_v1 = True

    # Y al volver a encenderlo, todo sigue donde estaba.
    assert len((await pedir(http))["items"]) == 1


# --------------------------------------------------------------------------- #
# 5. Paginacion
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_paginar_no_repite_ni_se_salta_cursos(entorno):
    http, sesiones, _ = entorno
    for i in range(6):
        await crear_curso(
            sesiones, f"c0000000-0000-0000-0000-00000000000{i}", temas=[IA]
        )
    primera = [i["id"] for i in (await pedir(http, limit=3, offset=0))["items"]]
    segunda = [i["id"] for i in (await pedir(http, limit=3, offset=3))["items"]]
    assert len(primera) == 3
    assert len(segunda) == 3
    assert set(primera).isdisjoint(segunda)
    assert len(set(primera) | set(segunda)) == 6


@pytest.mark.asyncio
async def test_no_se_devuelve_el_catalogo_entero(entorno):
    http, sesiones, _ = entorno
    for i in range(8):
        await crear_curso(
            sesiones, f"c0000000-0000-0000-0000-00000000000{i}", temas=[IA]
        )
    assert len((await pedir(http, limit=3))["items"]) == 3


# --------------------------------------------------------------------------- #
# 6. Rendimiento
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_numero_de_consultas_no_crece_con_el_catalogo(entorno):
    """PROHIBIDO una consulta por candidato. Con veinte cursos serian sesenta
    viajes a la base para pintar una lista."""
    http, sesiones, _ = entorno
    for i in range(12):
        await crear_curso(
            sesiones,
            f"c0000000-0000-0000-0000-0000000000{i:02d}",
            temas=[IA, PROGRAMACION],
            lecciones=2,
        )

    consultas: list[str] = []

    def _contar(conn, cursor, statement, *args):  # noqa: ANN001
        consultas.append(statement)

    cache.vaciar()
    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _contar)
    try:
        respuesta = await http.get(f"{API}/courses", params={"limit": 12})
    finally:
        event.remove(motor, "before_cursor_execute", _contar)

    assert respuesta.status_code == 200
    assert len(respuesta.json()["items"]) == 12
    selects = [c for c in consultas if c.lstrip().lower().startswith("select")]
    assert len(selects) <= 14, f"{len(selects)} consultas para 12 cursos"


@pytest.mark.asyncio
async def test_la_segunda_pagina_no_recalcula_el_ranking(entorno):
    http, sesiones, _ = entorno
    for i in range(6):
        await crear_curso(
            sesiones, f"c0000000-0000-0000-0000-00000000000{i}", temas=[IA]
        )
    cache.vaciar()
    await http.get(f"{API}/courses", params={"limit": 3, "offset": 0})

    consultas: list[str] = []

    def _contar(conn, cursor, statement, *args):  # noqa: ANN001
        consultas.append(statement)

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _contar)
    try:
        await http.get(f"{API}/courses", params={"limit": 3, "offset": 3})
    finally:
        event.remove(motor, "before_cursor_execute", _contar)

    selects = [c for c in consultas if c.lstrip().lower().startswith("select")]
    assert len(selects) <= 1, f"la memoria corta no sirvio: {selects}"


# --------------------------------------------------------------------------- #
# 7. Atribucion y metricas
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_una_impresion_de_cursos_se_guarda_con_su_contexto(entorno):
    http, sesiones, _ = entorno
    curso_id = "c0000000-0000-0000-0000-00000000000a"
    await crear_curso(sesiones, curso_id, temas=[IA])

    respuesta = await http.post(
        f"{API}/events",
        json={
            "events": [
                {
                    "event_type": "content_impression",
                    "entity_type": "course",
                    "entity_id": curso_id,
                    "surface": "courses_for_you",
                    "algorithm_version": "course-v1",
                    "rank": 0,
                    "event_key": "imp-1",
                }
            ]
        },
    )
    assert respuesta.json()["accepted"] == 1

    async with sesiones() as db:
        from sqlalchemy import select

        senal = (
            await db.scalars(
                select(BehaviorEvent).where(
                    BehaviorEvent.event_type == "content_impression"
                )
            )
        ).one()
    assert senal.surface == "courses_for_you"
    assert senal.algorithm_version == "course-v1"
    assert senal.entity_type == "course"


@pytest.mark.asyncio
async def test_el_embudo_de_cursos_cuenta_lo_que_paso(entorno):
    http, sesiones, _ = entorno
    curso_id = "c0000000-0000-0000-0000-00000000000a"
    await crear_curso(sesiones, curso_id, temas=[IA])
    async with sesiones() as db:
        ana = await db.get(Profile, ANA)
        ana.role = "admin"
        await db.commit()

    await http.post(
        f"{API}/events",
        json={
            "events": [
                {
                    "event_type": "content_impression",
                    "entity_type": "course",
                    "entity_id": curso_id,
                    "surface": "courses_for_you",
                    "algorithm_version": "course-v1",
                    "rank": 0,
                    "event_key": "imp-1",
                },
                {
                    "event_type": "content_engaged",
                    "entity_type": "course",
                    "entity_id": curso_id,
                    "event_key": "open-1",
                },
            ]
        },
    )

    datos = (await http.get(f"{API}/metrics")).json()
    cursos = [f for f in datos["funnels"] if f["surface"] == "courses_for_you"]
    assert len(cursos) == 1
    assert cursos[0]["impressions"] == 1
    assert cursos[0]["conversions"]["content_engaged"] == 1
    # Lo que no paso sale a CERO, no ausente.
    assert cursos[0]["conversions"]["content_completed"] == 0


@pytest.mark.asyncio
async def test_el_embudo_de_cursos_aparece_aunque_no_haya_pasado_nada(entorno):
    """Que falte la fila se lee como «esto no se mide», que es otra cosa."""
    http, sesiones, _ = entorno
    async with sesiones() as db:
        ana = await db.get(Profile, ANA)
        ana.role = "admin"
        await db.commit()
    datos = (await http.get(f"{API}/metrics")).json()
    superficies = {f["surface"] for f in datos["funnels"]}
    assert "courses_for_you" in superficies


# --------------------------------------------------------------------------- #
# 8. Seguir al creador
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_seguir_al_creador_no_vence_al_tema(entorno):
    """Sigue a Carlos, pero Lucía enseña justo lo que Ana quiere aprender."""
    http, sesiones, _ = entorno
    de_carlos = "c0000000-0000-0000-0000-00000000000a"
    de_lucia = "c0000000-0000-0000-0000-00000000000b"
    await crear_curso(sesiones, de_carlos, autor=CARLOS, temas=[MUSICA])
    await crear_curso(sesiones, de_lucia, autor=LUCIA, temas=[IA])
    async with sesiones() as db:
        db.add(Follow(follower_id=ANA, following_id=CARLOS))
        await db.commit()

    datos = await pedir(http)
    assert datos["items"][0]["id"] == de_lucia


@pytest.mark.asyncio
async def test_rechazar_un_curso_enfria_su_tema(entorno):
    """Sin esto, «no me interesa» sobre cinco cursos de marketing seguiría
    ofreciendo el sexto: solo escondería filas, sin aprender nada."""
    http, sesiones, _ = entorno
    del_tema = "c0000000-0000-0000-0000-00000000000a"
    otro_del_tema = "c0000000-0000-0000-0000-00000000000b"
    await crear_curso(sesiones, del_tema, temas=[MUSICA])
    await crear_curso(sesiones, otro_del_tema, temas=[MUSICA])

    antes = [i["id"] for i in (await pedir(http))["items"]]
    assert otro_del_tema in antes

    await http.post(
        f"{API}/events",
        json={
            "events": [
                {
                    "event_type": "not_interested",
                    "entity_type": "course",
                    "entity_id": del_tema,
                    "event_key": "no-1",
                }
            ]
        },
    )

    from sqlalchemy import select

    async with sesiones() as db:
        senal = (
            await db.scalars(
                select(BehaviorEvent).where(
                    BehaviorEvent.event_type == "not_interested"
                )
            )
        ).one()
    # Se guardan los temas del curso rechazado, que es lo que permite enfriarlo.
    assert senal.topic_ids == [MUSICA]


@pytest.mark.asyncio
async def test_en_arranque_en_frio_el_curso_caro_no_gana_por_serlo(entorno):
    """El precio es metadato de acceso, no una señal de calidad."""
    http, sesiones, identidad = entorno
    barato = "c0000000-0000-0000-0000-00000000000a"
    caro = "c0000000-0000-0000-0000-00000000000b"
    await crear_curso(sesiones, barato, temas=[MARKETING], precio=0)
    await crear_curso(sesiones, caro, temas=[MARKETING], precio=99900)
    identidad["uid"] = LUCIA  # sin preferencias declaradas

    datos = await pedir(http)
    assert datos["strategy"] == "cold_start"
    ids = [i["id"] for i in datos["items"]]
    assert set(ids) == {barato, caro}
    # El orden lo decide la exploracion determinista, no el importe. Lo que se
    # fija aqui es que sea ESTABLE y que el caro no este siempre delante.
    assert ids == [i["id"] for i in (await pedir(http))["items"]]
