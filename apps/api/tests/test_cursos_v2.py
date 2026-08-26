"""Cursos V2: la ficha ampliada, la revision y lo que hace falta para publicar.

SQLite en memoria, igual que el resto de la suite. Nada de esto llega a
Supabase.

COMO SE PRUEBA UNA MIGRACION QUE TODAVIA NO ESTA APLICADA. `Base.metadata`
—de donde salen las tablas de los tests— NO conoce las columnas de la 0034: se
declaran aparte, en `catalog/cursos_v2.py`, justamente para que ningun
`select(Course)` las pida contra una base que no las tiene. Eso deja la base de
una prueba, por defecto, en el estado de produccion de HOY.

Asi que la prueba que quiere la 0034 la APLICA, con los mismos `alter table` del
script. Y la que quiere comprobar que hoy no se rompe nada, simplemente no la
aplica. «Funciona sin la migracion» pasa de ser una promesa a ser algo que falla
si alguien lo rompe.

LO QUE FIJA ESTE FICHERO:

1. **La revision es un eje aparte de la visibilidad.** `status` sigue siendo el
   enum compartido con publicaciones, eventos y audios.
2. **Aprobar no publica, y publicar no aprueba.** Cada decision tiene su dueno.
3. **Se dice TODO lo que falta de una vez.** De una en una la gente abandona.
4. **Una compra desbloquea algo real.** Un curso de pago con todas las lecciones
   en muestra se ve entero sin pagar.
5. **La ruta del video no se regala.** El temario se entrega sin acceso porque
   es lo que vende el curso; el archivo, no.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.catalog import esquema as esquema_de_catalogo
from app.modules.learning.models import CourseLesson, CourseModule, Purchase
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache
from app.modules.recommendations.models import Topic
from app.shared.database import Base, get_db

CATALOGO = "/api/v1/catalog"
LEARNING = "/api/v1/learning"

IA = "11111111-1111-1111-1111-111111111111"
COCINA = "22222222-2222-2222-2222-222222222222"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"  # crea cursos
PEDRO = "aaaaaaaa-0000-0000-0000-000000000002"  # alumno cualquiera
ADMIN = "aaaaaaaa-0000-0000-0000-000000000003"  # revisa

#: Los mismos `alter table` de `supabase/migrations/0034_cursos_v2.sql`, en la
#: version que SQLite entiende. Si el script cambia, esto cambia con el: son la
#: misma decision escrita dos veces, y la prueba solo sirve si dicen lo mismo.
MIGRACION_0034 = (
    "alter table courses add column subtitle text",
    "alter table courses add column promo_video_path text",
    "alter table courses add column primary_topic_id char(32)",
    "alter table courses add column language text not null default 'es'",
    "alter table courses add column level text",
    "alter table courses add column target_audience json",
    "alter table courses add column prerequisites json",
    "alter table courses add column review_status text not null default 'draft'",
    "alter table courses add column submitted_at timestamp",
    "alter table courses add column reviewed_at timestamp",
    "alter table courses add column reviewed_by char(32)",
    "alter table courses add column rejection_reason text",
    "alter table course_modules add column description text not null default ''",
    "alter table course_lessons add column kind text not null default 'video'",
    "alter table course_lessons add column is_preview boolean not null default 0",
)


async def _levantar(con_0034: bool):
    """Una base nueva, con o sin la 0034 aplicada."""
    cache.vaciar()
    esquema_de_catalogo.olvidar()

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
        if con_0034:
            for sentencia in MIGRACION_0034:
                await conn.execute(text(sentencia))

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Topic(id=IA, slug="ia", name="Inteligencia Artificial", position=0))
        db.add(Topic(id=COCINA, slug="cocina", name="Cocina", position=1))
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=PEDRO, full_name="Pedro", username="pedro"))
        db.add(Profile(id=ADMIN, full_name="Admin", username="admin", role="admin"))
        await db.commit()
    return engine, sesiones


async def _cliente(sesiones):
    identidad = {"uid": ANA}

    async def _db_override():
        async with sesiones() as session:
            yield session

    async def _usuario_override() -> AuthUser:
        return AuthUser(
            id=identidad["uid"], email="quien@ejemplo.com", role="authenticated"
        )

    async def _opcional_override() -> AuthUser | None:
        if identidad["uid"] is None:
            return None
        return await _usuario_override()

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    app.dependency_overrides[get_optional_user] = _opcional_override
    return identidad


def _soltar() -> None:
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    # La memoria del esquema vive en el PROCESO: sin esto, la prueba siguiente
    # heredaria un «la 0034 esta puesta» que en su base es mentira.
    esquema_de_catalogo.olvidar()


@pytest_asyncio.fixture
async def entorno():
    """La base CON la 0034, que es el mundo despues de aprobar la migracion."""
    engine, sesiones = await _levantar(con_0034=True)
    identidad = await _cliente(sesiones)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad
    _soltar()
    await engine.dispose()


@pytest_asyncio.fixture
async def sin_0034():
    """La base tal y como esta HOY en produccion."""
    engine, sesiones = await _levantar(con_0034=False)
    identidad = await _cliente(sesiones)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad
    _soltar()
    await engine.dispose()


# --------------------------------------------------------------------------- #
# Ayudas
# --------------------------------------------------------------------------- #
FICHA_COMPLETA = {
    "title": "Liderazgo consciente",
    "description": "Una descripción larga de verdad, de más de treinta caracteres.",
    "subtitle": "Dirigir sin apagarte",
    "primary_topic_id": IA,
    "level": "beginner",
    "language": "es",
    "highlights": ["Tomar decisiones difíciles sin quemarte"],
    "target_audience": ["Quien acaba de liderar un equipo"],
    "prerequisites": ["Ninguno"],
}


async def _crear(http: AsyncClient, **campos) -> dict:
    cuerpo = {"title": "Curso", "description": "Descripción", **campos}
    respuesta = await http.post(f"{CATALOGO}/courses", json=cuerpo)
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()


async def _con_contenido(
    sesiones, course_id: str, *, muestra: bool = False, lecciones: int = 1
) -> list[str]:
    """Un modulo con N lecciones. Devuelve sus ids."""
    ids: list[str] = []
    async with sesiones() as db:
        modulo = CourseModule(course_id=course_id, title="Módulo 1", sort_order=0)
        db.add(modulo)
        await db.flush()
        for i in range(lecciones):
            leccion = CourseLesson(
                module_id=modulo.id,
                title=f"Lección {i + 1}",
                media_path=f"{ANA}/{course_id}/leccion-{i}.mp4",
                duration_seconds=600,
                sort_order=i,
            )
            db.add(leccion)
            await db.flush()
            ids.append(leccion.id)
        await db.commit()
    if muestra:
        await _marcar_muestra(sesiones, ids)
    return ids


async def _marcar_muestra(sesiones, lesson_ids: list[str]) -> None:
    async with sesiones() as db:
        for lid in lesson_ids:
            await db.execute(
                text("update course_lessons set is_preview = 1 where id = :id"),
                {"id": lid.replace("-", "")},
            )
        await db.commit()


async def _sembrar_temas(sesiones, cuantos: int) -> list[str]:
    """`cuantos` temas activos mas, distintos de IA y COCINA."""
    ids: list[str] = []
    async with sesiones() as db:
        for i in range(cuantos):
            tid = f"5555555{i}-5555-5555-5555-555555555555"
            db.add(Topic(id=tid, slug=f"t{i}", name=f"Tema {i}", position=10 + i))
            ids.append(tid)
        await db.commit()
    return ids


async def _listo_para_revision(http, sesiones, **extra) -> dict:
    curso = await _crear(http, **{**FICHA_COMPLETA, **extra})
    await _con_contenido(sesiones, curso["id"])
    return curso


async def _aprobado(http, sesiones, identidad, **extra) -> dict:
    curso = await _listo_para_revision(http, sesiones, **extra)
    assert (await http.post(f"{CATALOGO}/courses/{curso['id']}/submit")).json()[
        "submitted"
    ] is True
    quien = identidad["uid"]
    identidad["uid"] = ADMIN
    respuesta = await http.post(
        f"{CATALOGO}/courses/{curso['id']}/review", json={"decision": "approve"}
    )
    assert respuesta.status_code == 200, respuesta.text
    identidad["uid"] = quien
    return curso


# --------------------------------------------------------------------------- #
# 1. La ficha ampliada
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_curso_nace_con_la_ficha_que_le_pusieron(entorno):
    http, _, _ = entorno
    curso = await _crear(http, **FICHA_COMPLETA)
    assert curso["subtitle"] == "Dirigir sin apagarte"
    assert curso["level"] == "beginner"
    assert curso["language"] == "es"
    assert curso["primary_topic_id"] == IA
    assert curso["highlights"] == ["Tomar decisiones difíciles sin quemarte"]
    assert curso["target_audience"] == ["Quien acaba de liderar un equipo"]
    assert curso["prerequisites"] == ["Ninguno"]
    # Y sigue naciendo borrador y sin revisar: crear no es publicar ni enviar.
    assert curso["status"] == "draft"
    assert curso["review_status"] == "draft"


@pytest.mark.asyncio
async def test_editar_el_titulo_no_borra_la_ficha(entorno):
    """El fallo clasico: un PATCH de un campo que vacia los demas."""
    http, _, _ = entorno
    curso = await _crear(http, **FICHA_COMPLETA)
    editado = await http.patch(
        f"{CATALOGO}/courses/{curso['id']}", json={"title": "Otro nombre"}
    )
    cuerpo = editado.json()
    assert cuerpo["title"] == "Otro nombre"
    assert cuerpo["level"] == "beginner"
    assert cuerpo["subtitle"] == "Dirigir sin apagarte"
    assert cuerpo["highlights"] == ["Tomar decisiones difíciles sin quemarte"]


@pytest.mark.asyncio
async def test_la_categoria_principal_tambien_es_un_tema_del_curso(entorno):
    """Si no, el curso queda clasificado en todo menos en lo que trata.

    Se comprueba el CONJUNTO y no el orden a proposito: las filas de
    `course_topics` se escriben en la misma transaccion, asi que su `created_at`
    es identico y ordenarlas por esa columna no decide nada. Cual es la
    principal lo dice `primary_topic_id`, que para eso existe.
    """
    http, _, _ = entorno
    curso = await _crear(http, primary_topic_id=IA, topic_ids=[COCINA])
    assert curso["primary_topic_id"] == IA
    assert set(curso["topic_ids"]) == {IA, COCINA}


@pytest.mark.asyncio
async def test_elegir_categoria_no_gasta_uno_de_los_cinco_temas(entorno):
    """Son 1 + 5, no 5 en total: la categoria es la categoria y los cinco son
    «el resto».

    Contandola, elegir categoria dejaba al autor con cuatro huecos en vez de
    cinco, y encima sin saber por que se le habia encogido la lista.
    """
    http, sesiones, _ = entorno
    cinco = await _sembrar_temas(sesiones, 5)
    curso = await _crear(http, primary_topic_id=IA, topic_ids=cinco)
    assert curso["primary_topic_id"] == IA
    assert set(curso["topic_ids"]) == {IA, *cinco}
    assert len(curso["topic_ids"]) == 6


@pytest.mark.asyncio
async def test_el_sexto_tema_del_autor_si_se_rechaza(entorno):
    """El tope sigue siendo un tope: cinco elige el autor, la sexta no."""
    http, sesiones, _ = entorno
    seis = await _sembrar_temas(sesiones, 6)
    respuesta = await http.post(
        f"{CATALOGO}/courses",
        json={"title": "X", "primary_topic_id": IA, "topic_ids": seis},
    )
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_cambiar_de_categoria_no_deja_la_anterior_de_polizon(entorno):
    """La categoria vieja no puede quedarse ocupando un hueco del autor."""
    http, sesiones, _ = entorno
    cinco = await _sembrar_temas(sesiones, 5)
    curso = await _crear(http, primary_topic_id=IA, topic_ids=cinco)
    editado = await http.patch(
        f"{CATALOGO}/courses/{curso['id']}", json={"primary_topic_id": COCINA}
    )
    cuerpo = editado.json()
    assert cuerpo["primary_topic_id"] == COCINA
    assert set(cuerpo["topic_ids"]) == {COCINA, *cinco}
    assert IA not in cuerpo["topic_ids"], "la categoria anterior no se queda dentro"


@pytest.mark.asyncio
async def test_cambiar_solo_la_categoria_no_borra_los_demas_temas(entorno):
    http, _, _ = entorno
    curso = await _crear(http, topic_ids=[IA, COCINA])
    editado = await http.patch(
        f"{CATALOGO}/courses/{curso['id']}", json={"primary_topic_id": COCINA}
    )
    cuerpo = editado.json()
    assert cuerpo["primary_topic_id"] == COCINA
    assert set(cuerpo["topic_ids"]) == {IA, COCINA}


@pytest.mark.asyncio
async def test_una_categoria_inventada_se_rechaza(entorno):
    http, _, _ = entorno
    respuesta = await http.post(
        f"{CATALOGO}/courses",
        json={
            "title": "X",
            "primary_topic_id": "99999999-9999-9999-9999-999999999999",
        },
    )
    assert respuesta.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize("nivel", ["experto", "BEGINNER", ""])
async def test_un_nivel_inventado_se_rechaza(entorno, nivel):
    http, _, _ = entorno
    respuesta = await http.post(
        f"{CATALOGO}/courses", json={"title": "X", "level": nivel}
    )
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_las_frases_vacias_no_se_guardan(entorno):
    """Una viñeta sin texto se pinta igual, y parece un fallo de la app."""
    http, _, _ = entorno
    curso = await _crear(
        http, highlights=["  ", "Algo real", "Algo real", ""], prerequisites=[" "]
    )
    assert curso["highlights"] == ["Algo real"]
    assert curso["prerequisites"] == []


# --------------------------------------------------------------------------- #
# 2. Validaciones de publicacion: TODAS de una vez y en el servidor
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_se_dicen_todos_los_requisitos_que_faltan_juntos(entorno):
    http, _, _ = entorno
    curso = await _crear(http, title="Vacío", description="Corta")
    cuerpo = (await http.get(f"{CATALOGO}/courses/{curso['id']}/requirements")).json()
    assert cuerpo["ready"] is False
    faltan = " || ".join(cuerpo["missing"])
    for pista in ("descripción", "resultado de aprendizaje", "categoría", "nivel",
                  "módulo"):
        assert pista in faltan, f"no se avisa de «{pista}»: {faltan}"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "quita,pista",
    [
        ("description", "descripción"),
        ("highlights", "resultado de aprendizaje"),
        ("primary_topic_id", "categoría"),
        ("level", "nivel"),
    ],
)
async def test_cada_requisito_de_la_ficha_se_comprueba(entorno, quita, pista):
    http, sesiones, _ = entorno
    campos = {k: v for k, v in FICHA_COMPLETA.items() if k != quita}
    if quita == "description":
        campos["description"] = "Corta"
    if quita == "highlights":
        campos["highlights"] = []
    curso = await _crear(http, **campos)
    await _con_contenido(sesiones, curso["id"])
    cuerpo = (await http.get(f"{CATALOGO}/courses/{curso['id']}/requirements")).json()
    assert cuerpo["ready"] is False
    assert any(pista in f for f in cuerpo["missing"]), cuerpo["missing"]


@pytest.mark.asyncio
async def test_sin_modulo_y_sin_leccion_tampoco(entorno):
    http, sesiones, _ = entorno
    curso = await _crear(http, **FICHA_COMPLETA)
    faltan = (
        await http.get(f"{CATALOGO}/courses/{curso['id']}/requirements")
    ).json()["missing"]
    assert any("módulo" in f for f in faltan)

    async with sesiones() as db:
        db.add(CourseModule(course_id=curso["id"], title="Módulo", sort_order=0))
        await db.commit()
    faltan = (
        await http.get(f"{CATALOGO}/courses/{curso['id']}/requirements")
    ).json()["missing"]
    assert any("lección" in f for f in faltan)


@pytest.mark.asyncio
async def test_un_curso_completo_esta_listo(entorno):
    http, sesiones, _ = entorno
    curso = await _listo_para_revision(http, sesiones)
    cuerpo = (await http.get(f"{CATALOGO}/courses/{curso['id']}/requirements")).json()
    assert cuerpo == {
        "id": curso["id"],
        "status": "draft",
        "review_status": "draft",
        "ready": True,
        "missing": [],
        "review_available": True,
    }


@pytest.mark.asyncio
async def test_los_requisitos_son_de_quien_gestiona_el_curso(entorno):
    http, sesiones, identidad = entorno
    curso = await _listo_para_revision(http, sesiones)
    identidad["uid"] = PEDRO
    assert (
        await http.get(f"{CATALOGO}/courses/{curso['id']}/requirements")
    ).status_code == 403


# --------------------------------------------------------------------------- #
# 3. Cobrar tiene que desbloquear algo real
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_curso_de_pago_con_todo_en_muestra_no_se_publica(entorno):
    """Se veria entero sin pagar: quien compre habra pagado por nada."""
    http, sesiones, _ = entorno
    curso = await _crear(http, **FICHA_COMPLETA, price_minor=15000)
    await _con_contenido(sesiones, curso["id"], muestra=True)
    faltan = (
        await http.get(f"{CATALOGO}/courses/{curso['id']}/requirements")
    ).json()["missing"]
    assert any("fuera de la muestra" in f for f in faltan), faltan


@pytest.mark.asyncio
async def test_un_curso_de_pago_con_una_leccion_cerrada_si(entorno):
    http, sesiones, _ = entorno
    curso = await _crear(http, **FICHA_COMPLETA, price_minor=15000)
    ids = await _con_contenido(sesiones, curso["id"], lecciones=2)
    await _marcar_muestra(sesiones, ids[:1])
    cuerpo = (await http.get(f"{CATALOGO}/courses/{curso['id']}/requirements")).json()
    assert cuerpo["ready"] is True, cuerpo["missing"]


@pytest.mark.asyncio
async def test_un_curso_gratuito_no_puede_tener_muestras(entorno):
    """En uno gratuito ya se abren todas: la muestra no significa nada."""
    http, sesiones, _ = entorno
    curso = await _crear(http, **FICHA_COMPLETA, price_minor=0)
    await _con_contenido(sesiones, curso["id"], muestra=True)
    faltan = (
        await http.get(f"{CATALOGO}/courses/{curso['id']}/requirements")
    ).json()["missing"]
    assert any("gratuito" in f for f in faltan), faltan


# --------------------------------------------------------------------------- #
# 4. Revision: enviar, aprobar, rechazar
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_no_se_envia_a_revision_un_curso_a_medias(entorno):
    """Mandarlo asi solo sirve para que alguien lo mire y lo devuelva."""
    http, _, _ = entorno
    curso = await _crear(http, title="Vacío", description="Corta")
    cuerpo = (await http.post(f"{CATALOGO}/courses/{curso['id']}/submit")).json()
    assert cuerpo["submitted"] is False
    assert cuerpo["review_status"] == "draft"
    assert cuerpo["missing"]


@pytest.mark.asyncio
async def test_un_curso_completo_se_envia_a_revision(entorno):
    http, sesiones, _ = entorno
    curso = await _listo_para_revision(http, sesiones)
    cuerpo = (await http.post(f"{CATALOGO}/courses/{curso['id']}/submit")).json()
    assert cuerpo == {
        "id": curso["id"],
        "review_status": "pending_review",
        "submitted": True,
        "missing": [],
    }


@pytest.mark.asyncio
async def test_insistir_no_adelanta_la_cola(entorno):
    """Reescribir `submitted_at` mandaria al final a quien ya esperaba."""
    http, sesiones, _ = entorno
    curso = await _listo_para_revision(http, sesiones)
    await http.post(f"{CATALOGO}/courses/{curso['id']}/submit")
    primero = (await http.get(f"{CATALOGO}/courses/mine")).json()[0]["submitted_at"]
    for _ in range(3):
        assert (await http.post(f"{CATALOGO}/courses/{curso['id']}/submit")).json()[
            "submitted"
        ] is True
    assert (await http.get(f"{CATALOGO}/courses/mine")).json()[0][
        "submitted_at"
    ] == primero


@pytest.mark.asyncio
async def test_solo_la_administracion_resuelve_una_revision(entorno):
    http, sesiones, identidad = entorno
    curso = await _listo_para_revision(http, sesiones)
    await http.post(f"{CATALOGO}/courses/{curso['id']}/submit")
    # Ni siquiera su autor: aprobarse a uno mismo no es revisar.
    respuesta = await http.post(
        f"{CATALOGO}/courses/{curso['id']}/review", json={"decision": "approve"}
    )
    assert respuesta.status_code == 403
    identidad["uid"] = PEDRO
    assert (
        await http.post(
            f"{CATALOGO}/courses/{curso['id']}/review", json={"decision": "approve"}
        )
    ).status_code == 403


@pytest.mark.asyncio
async def test_aprobar_deja_constancia_y_no_publica(entorno):
    """Aprobar y publicar son de dos personas distintas."""
    http, sesiones, identidad = entorno
    curso = await _aprobado(http, sesiones, identidad)
    mio = (await http.get(f"{CATALOGO}/courses/mine")).json()[0]
    assert mio["review_status"] == "approved"
    assert mio["reviewed_at"] is not None
    # Y sigue SIN estar en el catalogo: eso lo decide su autor.
    assert mio["status"] == "draft"
    assert (await http.get(f"{CATALOGO}/courses")).json() == []


@pytest.mark.asyncio
async def test_rechazar_sin_motivo_no_se_puede(entorno):
    """Un «no» sin explicación es un muro sin puerta."""
    http, sesiones, identidad = entorno
    curso = await _listo_para_revision(http, sesiones)
    await http.post(f"{CATALOGO}/courses/{curso['id']}/submit")
    identidad["uid"] = ADMIN
    for cuerpo in ({"decision": "reject"}, {"decision": "reject", "reason": "no"}):
        respuesta = await http.post(
            f"{CATALOGO}/courses/{curso['id']}/review", json=cuerpo
        )
        assert respuesta.status_code == 422, respuesta.text


@pytest.mark.asyncio
async def test_rechazar_con_motivo_llega_a_su_autor(entorno):
    http, sesiones, identidad = entorno
    curso = await _listo_para_revision(http, sesiones)
    await http.post(f"{CATALOGO}/courses/{curso['id']}/submit")
    identidad["uid"] = ADMIN
    await http.post(
        f"{CATALOGO}/courses/{curso['id']}/review",
        json={"decision": "reject", "reason": "La portada no es tuya."},
    )
    identidad["uid"] = ANA
    mio = (await http.get(f"{CATALOGO}/courses/mine")).json()[0]
    assert mio["review_status"] == "rejected"
    assert mio["rejection_reason"] == "La portada no es tuya."


@pytest.mark.asyncio
async def test_volver_a_enviar_limpia_el_rechazo_anterior(entorno):
    """La petición nueva no arrastra el «no» de la anterior, ya resuelta."""
    http, sesiones, identidad = entorno
    curso = await _listo_para_revision(http, sesiones)
    await http.post(f"{CATALOGO}/courses/{curso['id']}/submit")
    identidad["uid"] = ADMIN
    await http.post(
        f"{CATALOGO}/courses/{curso['id']}/review",
        json={"decision": "reject", "reason": "La portada no es tuya."},
    )
    identidad["uid"] = ANA
    assert (await http.post(f"{CATALOGO}/courses/{curso['id']}/submit")).json()[
        "review_status"
    ] == "pending_review"
    mio = (await http.get(f"{CATALOGO}/courses/mine")).json()[0]
    assert mio["rejection_reason"] is None


@pytest.mark.asyncio
async def test_el_motivo_del_rechazo_no_es_para_todo_el_mundo(entorno):
    """Es para quien tiene que corregirlo, no para quien mira el curso."""
    http, sesiones, identidad = entorno
    curso = await _listo_para_revision(http, sesiones, price_minor=0)
    await http.post(f"{CATALOGO}/courses/{curso['id']}/submit")
    identidad["uid"] = ADMIN
    await http.post(
        f"{CATALOGO}/courses/{curso['id']}/review",
        json={"decision": "reject", "reason": "La portada no es tuya."},
    )
    # Su autor lo ve en el detalle del curso.
    identidad["uid"] = ANA
    detalle = (await http.get(f"{LEARNING}/courses/{curso['id']}")).json()
    assert detalle["rejection_reason"] == "La portada no es tuya."
    # Y la administracion tambien, porque tambien gestiona.
    identidad["uid"] = ADMIN
    assert (await http.get(f"{LEARNING}/courses/{curso['id']}")).json()[
        "rejection_reason"
    ] == "La portada no es tuya."


@pytest.mark.asyncio
async def test_la_cola_de_revision_es_solo_de_administracion(entorno):
    http, sesiones, identidad = entorno
    curso = await _listo_para_revision(http, sesiones)
    await http.post(f"{CATALOGO}/courses/{curso['id']}/submit")
    assert (await http.get(f"{CATALOGO}/courses/review-queue")).status_code == 403
    identidad["uid"] = ADMIN
    cola = await http.get(f"{CATALOGO}/courses/review-queue")
    assert cola.status_code == 200
    assert [c["id"] for c in cola.json()] == [curso["id"]]


@pytest.mark.asyncio
async def test_la_cola_se_vacia_al_resolver(entorno):
    http, sesiones, identidad = entorno
    await _aprobado(http, sesiones, identidad)
    identidad["uid"] = ADMIN
    assert (await http.get(f"{CATALOGO}/courses/review-queue")).json() == []


# --------------------------------------------------------------------------- #
# 5. Publicar exige que alguien lo haya mirado
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_curso_sin_revisar_no_se_publica(entorno):
    http, sesiones, _ = entorno
    curso = await _listo_para_revision(http, sesiones)
    cuerpo = (await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")).json()
    assert cuerpo["published"] is False
    assert any("revisión" in f for f in cuerpo["missing"]), cuerpo["missing"]
    assert (await http.get(f"{CATALOGO}/courses")).json() == []


@pytest.mark.asyncio
async def test_un_curso_en_revision_tampoco(entorno):
    http, sesiones, _ = entorno
    curso = await _listo_para_revision(http, sesiones)
    await http.post(f"{CATALOGO}/courses/{curso['id']}/submit")
    cuerpo = (await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")).json()
    assert cuerpo["published"] is False
    assert any("en revisión" in f for f in cuerpo["missing"]), cuerpo["missing"]


@pytest.mark.asyncio
async def test_aprobado_si_se_publica(entorno):
    http, sesiones, identidad = entorno
    curso = await _aprobado(http, sesiones, identidad, price_minor=0)
    respuesta = await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")
    assert respuesta.json()["published"] is True
    assert [c["id"] for c in (await http.get(f"{CATALOGO}/courses")).json()] == [
        curso["id"]
    ]


@pytest.mark.asyncio
async def test_retirar_no_deshace_la_revision(entorno):
    """Son dos ejes: quitarlo del catálogo no lo devuelve a sin revisar."""
    http, sesiones, identidad = entorno
    curso = await _aprobado(http, sesiones, identidad, price_minor=0)
    await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")
    retirado = (await http.post(f"{CATALOGO}/courses/{curso['id']}/unpublish")).json()
    assert retirado["status"] == "hidden"
    assert retirado["review_status"] == "approved"
    # Y volver a publicarlo no necesita otra revision.
    assert (await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")).json()[
        "published"
    ] is True


# --------------------------------------------------------------------------- #
# 6. La ruta del video no se regala
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_temario_de_un_curso_de_pago_no_reparte_las_rutas(entorno):
    """REGRESION. El detalle devolvia `media_path` de TODAS las lecciones a
    cualquiera que abriera la ficha de un curso de pago.

    No era una brecha —el bucket es privado y sus politicas exigen
    `has_course_access`— pero es informacion que no hace falta dar.
    """
    http, sesiones, identidad = entorno
    curso = await _aprobado(http, sesiones, identidad, price_minor=15000)
    await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")

    identidad["uid"] = PEDRO
    detalle = (await http.get(f"{LEARNING}/courses/{curso['id']}")).json()
    lecciones = [l for m in detalle["modules"] for l in m["lessons"]]
    assert lecciones, "el temario sí se ve: es lo que vende el curso"
    assert all(l["media_path"] is None for l in lecciones), lecciones
    # El temario en si NO se esconde: titulo y duracion siguen ahi.
    assert all(l["title"] for l in lecciones)
    assert detalle["duration_seconds_total"] == 600
    # Y se sigue sabiendo que HAY video. Sin esto, esconder la ruta convertiria
    # «no tienes acceso» en «esta leccion todavia no tiene video», que son dos
    # cosas distintas: una se resuelve comprando y la otra esperando.
    assert all(l["has_media"] is True for l in lecciones)

    # Y por su propio id tampoco.
    suelta = (await http.get(f"{LEARNING}/lessons/{lecciones[0]['id']}")).json()
    assert suelta["media_path"] is None
    assert suelta["has_media"] is True
    assert suelta["title"]


@pytest.mark.asyncio
async def test_una_leccion_sin_video_no_se_confunde_con_una_bloqueada(entorno):
    """«Todavía no hay vídeo» y «no tienes acceso» se resuelven distinto."""
    http, sesiones, identidad = entorno
    curso = await _aprobado(http, sesiones, identidad, price_minor=15000)
    await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")
    async with sesiones() as db:
        await db.execute(
            text("update course_lessons set media_path = null"),
        )
        await db.commit()

    identidad["uid"] = PEDRO
    detalle = (await http.get(f"{LEARNING}/courses/{curso['id']}")).json()
    lecciones = [l for m in detalle["modules"] for l in m["lessons"]]
    assert all(l["media_path"] is None for l in lecciones)
    assert all(l["has_media"] is False for l in lecciones)


@pytest.mark.asyncio
async def test_una_leccion_de_muestra_si_entrega_su_ruta(entorno):
    """Para eso es una muestra: se puede probar antes de comprar."""
    http, sesiones, identidad = entorno
    curso = await _crear(http, **FICHA_COMPLETA, price_minor=15000)
    ids = await _con_contenido(sesiones, curso["id"], lecciones=2)
    await _marcar_muestra(sesiones, ids[:1])
    await http.post(f"{CATALOGO}/courses/{curso['id']}/submit")
    identidad["uid"] = ADMIN
    await http.post(
        f"{CATALOGO}/courses/{curso['id']}/review", json={"decision": "approve"}
    )
    identidad["uid"] = ANA
    await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")

    identidad["uid"] = PEDRO
    detalle = (await http.get(f"{LEARNING}/courses/{curso['id']}")).json()
    lecciones = [l for m in detalle["modules"] for l in m["lessons"]]
    muestras = [l for l in lecciones if l["is_preview"]]
    cerradas = [l for l in lecciones if not l["is_preview"]]
    assert len(muestras) == 1 and len(cerradas) == 1
    assert muestras[0]["media_path"] is not None
    assert cerradas[0]["media_path"] is None


@pytest.mark.asyncio
async def test_quien_compro_recibe_todas_las_rutas(entorno):
    http, sesiones, identidad = entorno
    curso = await _aprobado(http, sesiones, identidad, price_minor=15000)
    await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")
    async with sesiones() as db:
        db.add(
            Purchase(
                user_id=PEDRO,
                course_id=curso["id"],
                provider="web",
                amount_minor=15000,
                currency="PEN",
                status="paid",
            )
        )
        await db.commit()
    identidad["uid"] = PEDRO
    detalle = (await http.get(f"{LEARNING}/courses/{curso['id']}")).json()
    lecciones = [l for m in detalle["modules"] for l in m["lessons"]]
    assert all(l["media_path"] for l in lecciones)


@pytest.mark.asyncio
async def test_el_autor_ve_sus_propias_rutas(entorno):
    """Si no, no podria ni previsualizar el video que acaba de subir."""
    http, sesiones, _ = entorno
    curso = await _crear(http, **FICHA_COMPLETA, price_minor=15000)
    await _con_contenido(sesiones, curso["id"])
    detalle = (await http.get(f"{LEARNING}/courses/{curso['id']}")).json()
    lecciones = [l for m in detalle["modules"] for l in m["lessons"]]
    assert all(l["media_path"] for l in lecciones)


# --------------------------------------------------------------------------- #
# 7. SIN la 0034: hoy, contra produccion, no se rompe nada
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_la_0034_un_curso_se_crea_y_se_edita_igual(sin_0034):
    http, _, _ = sin_0034
    curso = await _crear(http, **FICHA_COMPLETA)
    assert curso["status"] == "draft"
    # La ficha se acepta y NO se guarda: no hay donde. Lo que no puede pasar es
    # que no se pueda crear el curso por esto.
    assert curso["subtitle"] is None
    assert curso["level"] is None
    assert curso["language"] == "es"
    assert curso["review_status"] == "draft"
    editado = await http.patch(
        f"{CATALOGO}/courses/{curso['id']}", json={"title": "Otro", "level": "advanced"}
    )
    assert editado.status_code == 200
    assert editado.json()["title"] == "Otro"


@pytest.mark.asyncio
async def test_sin_la_0034_highlights_si_se_guarda(sin_0034):
    """`highlights` es de la 0013, no de la 0034: hoy ya existe."""
    http, _, _ = sin_0034
    curso = await _crear(http, highlights=["Algo real"])
    assert curso["highlights"] == ["Algo real"]


@pytest.mark.asyncio
async def test_sin_la_0034_se_publica_con_las_reglas_de_siempre(sin_0034):
    """Ni categoría, ni nivel, ni revisión: lo de hoy, exactamente."""
    http, sesiones, _ = sin_0034
    curso = await _crear(
        http,
        title="Curso",
        description="Una descripción larga de verdad, más de treinta.",
        topic_ids=[IA],
    )
    await _con_contenido(sesiones, curso["id"])
    cuerpo = (await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")).json()
    assert cuerpo["published"] is True, cuerpo["missing"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "metodo,ruta",
    [
        ("post", "/submit"),
        ("post", "/review"),
    ],
)
async def test_sin_la_0034_la_revision_responde_503(sin_0034, metodo, ruta):
    """503 y no 404 —la ruta existe— ni 500 —nada se ha roto—."""
    http, _, identidad = sin_0034
    curso = await _crear(http)
    identidad["uid"] = ADMIN
    respuesta = await getattr(http, metodo)(
        f"{CATALOGO}/courses/{curso['id']}{ruta}",
        json={"decision": "approve"},
    )
    assert respuesta.status_code == 503, respuesta.text
    assert respuesta.json()["error"]["code"] == "course_review_not_available"


@pytest.mark.asyncio
async def test_sin_la_0034_la_cola_responde_503(sin_0034):
    http, _, identidad = sin_0034
    identidad["uid"] = ADMIN
    respuesta = await http.get(f"{CATALOGO}/courses/review-queue")
    assert respuesta.status_code == 503
    assert respuesta.json()["error"]["code"] == "course_review_not_available"


@pytest.mark.asyncio
async def test_sin_la_0034_los_requisitos_dicen_que_no_hay_revision(sin_0034):
    http, sesiones, _ = sin_0034
    curso = await _crear(
        http,
        description="Una descripción larga de verdad, más de treinta.",
        topic_ids=[IA],
    )
    await _con_contenido(sesiones, curso["id"])
    cuerpo = (await http.get(f"{CATALOGO}/courses/{curso['id']}/requirements")).json()
    assert cuerpo["review_available"] is False
    assert cuerpo["ready"] is True, cuerpo["missing"]


@pytest.mark.asyncio
async def test_sin_la_0034_ninguna_leccion_es_muestra(sin_0034):
    """Y por eso la ruta del video sigue sin salir de un curso de pago."""
    http, sesiones, identidad = sin_0034
    curso = await _crear(
        http,
        description="Una descripción larga de verdad, más de treinta.",
        price_minor=15000,
        topic_ids=[IA],
    )
    await _con_contenido(sesiones, curso["id"])
    await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")
    identidad["uid"] = PEDRO
    detalle = (await http.get(f"{LEARNING}/courses/{curso['id']}")).json()
    lecciones = [l for m in detalle["modules"] for l in m["lessons"]]
    assert lecciones
    assert all(l["is_preview"] is False for l in lecciones)
    assert all(l["kind"] == "video" for l in lecciones)
    assert all(l["media_path"] is None for l in lecciones)
