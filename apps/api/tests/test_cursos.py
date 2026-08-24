"""La plataforma de cursos: quien puede que, y quien paga que.

SQLite en memoria, igual que el resto de la suite. Las personas y los cursos de
estos escenarios viven los milisegundos que dura cada prueba: NUNCA llegan a
Supabase, y ninguna compra de aqui es una compra.

LO QUE FIJAN ESTAS PRUEBAS, y por que merece la pena escribirlas:

1. **Un curso de pago no se regala.** El endpoint de inscripcion creaba acceso
   `paid` por importe 0 para cualquier curso, sin mirar el precio. El muro de
   pago de la 0016 estaba bien hecho y esta puerta lo rodeaba por dentro.
2. **Crear no es publicar.** Rellenar el titulo publicaba en el catalogo un
   curso sin un solo modulo.
3. **El autor manda sobre lo suyo, y solo sobre lo suyo.**
4. **El precio admite centavos.** El contrato anterior no podia expresar 49.90.
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
from app.modules.learning.models import CourseLesson, CourseModule, Purchase
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache
from app.modules.recommendations.models import Topic
from app.shared.database import Base, get_db

CATALOGO = "/api/v1/catalog"
LEARNING = "/api/v1/learning"

IA = "11111111-1111-1111-1111-111111111111"
COCINA = "22222222-2222-2222-2222-222222222222"
INACTIVO = "44444444-4444-4444-4444-444444444444"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"  # crea cursos
PEDRO = "aaaaaaaa-0000-0000-0000-000000000002"  # alumno cualquiera
ADMIN = "aaaaaaaa-0000-0000-0000-000000000003"  # modera


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
        db.add(Topic(id=IA, slug="ia", name="Inteligencia Artificial", position=0))
        db.add(Topic(id=COCINA, slug="cocina", name="Cocina", position=1))
        db.add(Topic(id=INACTIVO, slug="retirado", name="Retirado", active=False))
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=PEDRO, full_name="Pedro", username="pedro"))
        db.add(Profile(id=ADMIN, full_name="Admin", username="admin", role="admin"))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

    async def _usuario_override() -> AuthUser:
        return AuthUser(
            id=identidad["uid"], email="quien@ejemplo.com", role="authenticated"
        )

    async def _opcional_override() -> AuthUser | None:
        # `None` es «nadie ha iniciado sesion», que es un caso real de estas
        # pantallas: el catalogo se puede mirar sin cuenta.
        if identidad["uid"] is None:
            return None
        return await _usuario_override()

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    app.dependency_overrides[get_optional_user] = _opcional_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    await engine.dispose()


def engine_de(sesiones):
    """El motor detras de la fabrica de sesiones, para poder escuchar consultas."""
    return sesiones.kw["bind"]


async def _crear_curso(http: AsyncClient, **campos) -> dict:
    cuerpo = {"title": "Curso", "description": "Descripción", **campos}
    respuesta = await http.post(f"{CATALOGO}/courses", json=cuerpo)
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()


async def _con_contenido(sesiones, course_id: str) -> str:
    """Un modulo con una leccion. Devuelve el id de la leccion."""
    async with sesiones() as db:
        modulo = CourseModule(course_id=course_id, title="Módulo 1", sort_order=0)
        db.add(modulo)
        await db.flush()
        leccion = CourseLesson(
            module_id=modulo.id, title="Lección 1", duration_seconds=600, sort_order=0
        )
        db.add(leccion)
        await db.commit()
        return leccion.id


# --------------------------------------------------------------------------- #
# 1. Ciclo de vida: crear NO es publicar
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_crear_un_curso_lo_deja_en_borrador(entorno):
    """Rellenar la ficha es empezar, no terminar."""
    http, _, _ = entorno
    curso = await _crear_curso(http)
    assert curso["status"] == "draft"


@pytest.mark.asyncio
async def test_un_borrador_no_sale_en_el_catalogo_publico(entorno):
    http, _, _ = entorno
    await _crear_curso(http, title="Todavía no")
    listado = await http.get(f"{CATALOGO}/courses")
    assert listado.status_code == 200
    assert listado.json() == []


@pytest.mark.asyncio
async def test_el_autor_ve_sus_borradores(entorno):
    """Si no, un curso recien creado parece no haberse guardado."""
    http, _, _ = entorno
    creado = await _crear_curso(http, title="Mío")
    mios = await http.get(f"{CATALOGO}/courses/mine")
    assert mios.status_code == 200
    assert [c["id"] for c in mios.json()] == [creado["id"]]


@pytest.mark.asyncio
async def test_los_borradores_de_otro_no_son_mios(entorno):
    http, _, identidad = entorno
    await _crear_curso(http, title="De Ana")
    identidad["uid"] = PEDRO
    mios = await http.get(f"{CATALOGO}/courses/mine")
    assert mios.json() == []


@pytest.mark.asyncio
async def test_un_borrador_ajeno_no_se_puede_abrir_por_su_id(entorno):
    """Conocer el identificador no puede ser la llave.

    Antes el detalle devolvia cualquier curso por id, asi que el temario entero
    de un borrador se leia con solo tenerlo.
    """
    http, _, identidad = entorno
    curso = await _crear_curso(http, title="Secreto")
    identidad["uid"] = PEDRO
    respuesta = await http.get(f"{LEARNING}/courses/{curso['id']}")
    assert respuesta.status_code == 404


@pytest.mark.asyncio
async def test_su_autor_si_lo_abre(entorno):
    http, _, _ = entorno
    curso = await _crear_curso(http, title="Secreto")
    respuesta = await http.get(f"{LEARNING}/courses/{curso['id']}")
    assert respuesta.status_code == 200
    assert respuesta.json()["can_manage"] is True


# --------------------------------------------------------------------------- #
# 2. Publicacion: el servidor valida, no React
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_curso_vacio_no_se_publica(entorno):
    http, _, _ = entorno
    curso = await _crear_curso(http, title="Vacío", description="Corta")
    respuesta = await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")
    assert respuesta.status_code == 200
    cuerpo = respuesta.json()
    assert cuerpo["published"] is False
    assert cuerpo["status"] == "draft"
    assert cuerpo["missing"]


@pytest.mark.asyncio
async def test_se_dicen_TODAS_las_cosas_que_faltan(entorno):
    """De una en una, guardando y reintentando, la gente abandona."""
    http, _, _ = entorno
    curso = await _crear_curso(http, title="Vacío", description="Corta")
    faltan = (await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")).json()[
        "missing"
    ]
    assert len(faltan) >= 2
    assert any("descripción" in f for f in faltan)
    assert any("módulo" in f for f in faltan)


@pytest.mark.asyncio
async def test_sin_lecciones_tampoco(entorno):
    http, sesiones, _ = entorno
    curso = await _crear_curso(
        http, description="Una descripción larga de verdad.", topic_ids=[IA]
    )
    async with sesiones() as db:
        db.add(CourseModule(course_id=curso["id"], title="Módulo", sort_order=0))
        await db.commit()
    cuerpo = (await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")).json()
    assert cuerpo["published"] is False
    assert any("lección" in f for f in cuerpo["missing"])


@pytest.mark.asyncio
async def test_un_curso_completo_si_se_publica(entorno):
    http, sesiones, _ = entorno
    curso = await _crear_curso(
        http, description="Una descripción larga de verdad.", topic_ids=[IA]
    )
    await _con_contenido(sesiones, curso["id"])
    respuesta = await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")
    assert respuesta.json() == {
        "id": curso["id"],
        "status": "published",
        "published": True,
        "missing": [],
    }
    publico = await http.get(f"{CATALOGO}/courses")
    assert [c["id"] for c in publico.json()] == [curso["id"]]


@pytest.mark.asyncio
async def test_otro_usuario_no_publica_mi_curso(entorno):
    http, sesiones, identidad = entorno
    curso = await _crear_curso(
        http, description="Una descripción larga de verdad.", topic_ids=[IA]
    )
    await _con_contenido(sesiones, curso["id"])
    identidad["uid"] = PEDRO
    respuesta = await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")
    assert respuesta.status_code == 403


@pytest.mark.asyncio
async def test_la_administracion_si_puede_moderar(entorno):
    http, sesiones, identidad = entorno
    curso = await _crear_curso(
        http, description="Una descripción larga de verdad.", topic_ids=[IA]
    )
    await _con_contenido(sesiones, curso["id"])
    identidad["uid"] = ADMIN
    assert (
        await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")
    ).json()["published"] is True


@pytest.mark.asyncio
async def test_retirar_un_curso_no_borra_nada(entorno):
    """Despublicar es esconder, no destruir."""
    http, sesiones, _ = entorno
    curso = await _crear_curso(
        http, description="Una descripción larga de verdad.", topic_ids=[IA]
    )
    leccion_id = await _con_contenido(sesiones, curso["id"])
    await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")

    respuesta = await http.post(f"{CATALOGO}/courses/{curso['id']}/unpublish")
    assert respuesta.status_code == 200
    assert respuesta.json()["status"] == "hidden"
    assert (await http.get(f"{CATALOGO}/courses")).json() == []

    async with sesiones() as db:
        assert await db.get(CourseLesson, leccion_id) is not None


@pytest.mark.asyncio
async def test_editar_no_puede_publicar_por_la_puerta_de_atras(entorno):
    """`status` no viaja en el PATCH: publicar tiene validaciones propias."""
    http, _, _ = entorno
    curso = await _crear_curso(http)
    await http.patch(f"{CATALOGO}/courses/{curso['id']}", json={"status": "published"})
    detalle = await http.get(f"{LEARNING}/courses/{curso['id']}")
    assert detalle.json()["status"] == "draft"


# --------------------------------------------------------------------------- #
# 3. Precio: centavos de extremo a extremo
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "centavos",
    [0, 4990, 50, 99999, 100],
)
async def test_el_precio_se_guarda_tal_cual_llega(entorno, centavos):
    """49.90 tiene que poder existir. Con el contrato anterior no podia."""
    http, _, _ = entorno
    curso = await _crear_curso(http, price_minor=centavos)
    assert curso["price_minor"] == centavos


@pytest.mark.asyncio
async def test_el_contrato_viejo_sigue_funcionando(entorno):
    """Un cliente ya instalado manda `price` en unidad mayor."""
    http, _, _ = entorno
    curso = await _crear_curso(http, price=49)
    assert curso["price_minor"] == 4900


@pytest.mark.asyncio
async def test_si_vienen_los_dos_manda_el_bueno(entorno):
    http, _, _ = entorno
    curso = await _crear_curso(http, price=49, price_minor=4990)
    assert curso["price_minor"] == 4990


@pytest.mark.asyncio
async def test_un_precio_negativo_se_rechaza(entorno):
    http, _, _ = entorno
    respuesta = await http.post(
        f"{CATALOGO}/courses", json={"title": "X", "price_minor": -1}
    )
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_una_moneda_inventada_se_rechaza(entorno):
    http, _, _ = entorno
    respuesta = await http.post(
        f"{CATALOGO}/courses", json={"title": "X", "currency": "pesos"}
    )
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_editar_sin_tocar_el_precio_lo_deja_igual(entorno):
    """El fallo clasico: un PATCH de titulo que pone el precio a 0."""
    http, _, _ = entorno
    curso = await _crear_curso(http, price_minor=4990)
    editado = await http.patch(
        f"{CATALOGO}/courses/{curso['id']}", json={"title": "Otro nombre"}
    )
    assert editado.json()["price_minor"] == 4990


# --------------------------------------------------------------------------- #
# 4. EL AGUJERO: un curso de pago no se regala
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_curso_gratuito_se_puede_empezar(entorno):
    http, sesiones, identidad = entorno
    curso = await _crear_curso(
        http,
        description="Una descripción larga de verdad.",
        price_minor=0,
        topic_ids=[IA],
    )
    await _con_contenido(sesiones, curso["id"])
    await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")

    identidad["uid"] = PEDRO
    respuesta = await http.post(f"{LEARNING}/courses/{curso['id']}/enroll")
    assert respuesta.status_code == 200
    assert respuesta.json() == {"enrolled": True}


@pytest.mark.asyncio
async def test_un_curso_de_pago_NO_se_regala(entorno):
    """La prueba de regresion del agujero.

    Antes esta llamada creaba `Purchase(status='paid', amount_minor=0)` para un
    curso de 200 soles. Y la llamaba el boton «Empezar curso», asi que no hacia
    falta ni saltarse la aplicacion.
    """
    http, sesiones, identidad = entorno
    curso = await _crear_curso(
        http,
        description="Una descripción larga de verdad.",
        price_minor=20000,
        topic_ids=[IA],
    )
    await _con_contenido(sesiones, curso["id"])
    await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")

    identidad["uid"] = PEDRO
    respuesta = await http.post(f"{LEARNING}/courses/{curso['id']}/enroll")
    assert respuesta.status_code == 403
    assert respuesta.json()["error"]["code"] == "course_requires_purchase"

    async with sesiones() as db:
        compras = (
            await db.scalars(select(Purchase).where(Purchase.user_id == PEDRO))
        ).all()
    assert compras == [], "no puede quedar ninguna fila de acceso"


@pytest.mark.asyncio
async def test_tampoco_se_regala_llamandolo_dos_veces(entorno):
    """Insistir no cambia la respuesta."""
    http, sesiones, identidad = entorno
    curso = await _crear_curso(
        http,
        description="Una descripción larga de verdad.",
        price_minor=9900,
        topic_ids=[IA],
    )
    await _con_contenido(sesiones, curso["id"])
    await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")
    identidad["uid"] = PEDRO
    for _ in range(3):
        assert (
            await http.post(f"{LEARNING}/courses/{curso['id']}/enroll")
        ).status_code == 403


@pytest.mark.asyncio
async def test_un_borrador_no_se_puede_empezar(entorno):
    http, sesiones, identidad = entorno
    curso = await _crear_curso(http)
    await _con_contenido(sesiones, curso["id"])
    identidad["uid"] = PEDRO
    assert (
        await http.post(f"{LEARNING}/courses/{curso['id']}/enroll")
    ).status_code == 404


# --------------------------------------------------------------------------- #
# 5. Acceso al contenido: las mismas cuatro vias que la base de datos
# --------------------------------------------------------------------------- #
async def _curso_de_pago(http, sesiones) -> str:
    curso = await _crear_curso(
        http,
        description="Una descripción larga de verdad.",
        price_minor=15000,
        topic_ids=[IA],
    )
    await _con_contenido(sesiones, curso["id"])
    await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")
    return curso["id"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "estado,esperado",
    [("paid", True), ("pending", False), ("refunded", False), ("cancelled", False)],
)
async def test_solo_una_compra_pagada_da_acceso(entorno, estado, esperado):
    """`pending` es un cobro empezado, no un cobro."""
    http, sesiones, identidad = entorno
    course_id = await _curso_de_pago(http, sesiones)
    async with sesiones() as db:
        db.add(
            Purchase(
                user_id=PEDRO,
                course_id=course_id,
                provider="web",
                amount_minor=15000,
                currency="PEN",
                status=estado,
            )
        )
        await db.commit()

    identidad["uid"] = PEDRO
    detalle = await http.get(f"{LEARNING}/courses/{course_id}")
    assert detalle.json()["has_access"] is esperado


@pytest.mark.asyncio
async def test_el_autor_entra_a_su_propio_curso_de_pago(entorno):
    http, sesiones, _ = entorno
    course_id = await _curso_de_pago(http, sesiones)
    detalle = await http.get(f"{LEARNING}/courses/{course_id}")
    assert detalle.json()["has_access"] is True


@pytest.mark.asyncio
async def test_la_administracion_entra(entorno):
    http, sesiones, identidad = entorno
    course_id = await _curso_de_pago(http, sesiones)
    identidad["uid"] = ADMIN
    detalle = await http.get(f"{LEARNING}/courses/{course_id}")
    assert detalle.json()["has_access"] is True


@pytest.mark.asyncio
async def test_sin_nada_no_hay_acceso(entorno):
    http, sesiones, identidad = entorno
    course_id = await _curso_de_pago(http, sesiones)
    identidad["uid"] = PEDRO
    detalle = await http.get(f"{LEARNING}/courses/{course_id}")
    cuerpo = detalle.json()
    assert cuerpo["has_access"] is False
    # El temario SI se ve: es lo que vende el curso. Lo que no se entrega es el
    # video, y de eso se encarga la RLS del almacenamiento.
    assert cuerpo["lessons_total"] == 1


@pytest.mark.asyncio
async def test_un_curso_gratuito_es_accesible_para_cualquiera(entorno):
    http, sesiones, identidad = entorno
    curso = await _crear_curso(
        http,
        description="Una descripción larga de verdad.",
        price_minor=0,
        topic_ids=[IA],
    )
    await _con_contenido(sesiones, curso["id"])
    await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")
    identidad["uid"] = PEDRO
    assert (await http.get(f"{LEARNING}/courses/{curso['id']}")).json()[
        "has_access"
    ] is True


# --------------------------------------------------------------------------- #
# 6. Autoria: el autor manda sobre lo suyo, y SOLO sobre lo suyo
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_autor_edita_su_curso(entorno):
    http, _, _ = entorno
    curso = await _crear_curso(http)
    respuesta = await http.patch(
        f"{CATALOGO}/courses/{curso['id']}", json={"title": "Nuevo título"}
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["title"] == "Nuevo título"


@pytest.mark.asyncio
async def test_otro_usuario_no_edita_mi_curso(entorno):
    http, _, identidad = entorno
    curso = await _crear_curso(http)
    identidad["uid"] = PEDRO
    respuesta = await http.patch(
        f"{CATALOGO}/courses/{curso['id']}", json={"title": "Secuestrado"}
    )
    assert respuesta.status_code == 403


@pytest.mark.asyncio
async def test_can_manage_lo_decide_el_servidor(entorno):
    """La aplicacion no puede deducirlo sola: necesita saber quien es el autor."""
    http, sesiones, identidad = entorno
    curso = await _crear_curso(
        http, description="Una descripción larga de verdad.", topic_ids=[IA]
    )
    await _con_contenido(sesiones, curso["id"])
    await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")

    assert (await http.get(f"{LEARNING}/courses/{curso['id']}")).json()["can_manage"]

    identidad["uid"] = PEDRO
    assert not (await http.get(f"{LEARNING}/courses/{curso['id']}")).json()["can_manage"]

    identidad["uid"] = ADMIN
    assert (await http.get(f"{LEARNING}/courses/{curso['id']}")).json()["can_manage"]


@pytest.mark.asyncio
async def test_el_detalle_dice_quien_es_el_autor(entorno):
    http, _, _ = entorno
    curso = await _crear_curso(http)
    assert (await http.get(f"{LEARNING}/courses/{curso['id']}")).json()[
        "author_id"
    ] == ANA


# --------------------------------------------------------------------------- #
# 7. Temas del curso
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_curso_puede_decir_de_que_trata(entorno):
    http, _, _ = entorno
    curso = await _crear_curso(http, topic_ids=[IA, COCINA])
    assert set(curso["topic_ids"]) == {IA, COCINA}


@pytest.mark.asyncio
async def test_editar_los_temas_los_REEMPLAZA(entorno):
    """Editar tiene que poder QUITAR un tema mal elegido."""
    http, _, _ = entorno
    curso = await _crear_curso(http, topic_ids=[IA, COCINA])
    editado = await http.patch(
        f"{CATALOGO}/courses/{curso['id']}", json={"topic_ids": [COCINA]}
    )
    assert editado.json()["topic_ids"] == [COCINA]


@pytest.mark.asyncio
async def test_un_tema_inventado_se_rechaza(entorno):
    http, _, _ = entorno
    respuesta = await http.post(
        f"{CATALOGO}/courses",
        json={"title": "X", "topic_ids": ["99999999-9999-9999-9999-999999999999"]},
    )
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_un_tema_retirado_se_rechaza(entorno):
    http, _, _ = entorno
    respuesta = await http.post(
        f"{CATALOGO}/courses", json={"title": "X", "topic_ids": [INACTIVO]}
    )
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_hay_un_tope_de_temas(entorno):
    """Veinte temas es no clasificar nada."""
    http, sesiones, _ = entorno
    async with sesiones() as db:
        extras = []
        for i in range(6):
            tid = f"5555555{i}-5555-5555-5555-555555555555"
            db.add(Topic(id=tid, slug=f"t{i}", name=f"Tema {i}", position=10 + i))
            extras.append(tid)
        await db.commit()
    respuesta = await http.post(
        f"{CATALOGO}/courses", json={"title": "X", "topic_ids": extras}
    )
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_sin_tema_no_se_publica(entorno):
    """Un curso sin tema no se puede recomendar a nadie."""
    http, sesiones, _ = entorno
    curso = await _crear_curso(http, description="Una descripción larga de verdad.")
    await _con_contenido(sesiones, curso["id"])
    cuerpo = (await http.post(f"{CATALOGO}/courses/{curso['id']}/publish")).json()
    assert cuerpo["published"] is False
    assert any("tema" in f for f in cuerpo["missing"])


@pytest.mark.asyncio
async def test_no_se_pueden_etiquetar_cursos_ajenos(entorno):
    http, _, identidad = entorno
    curso = await _crear_curso(http)
    identidad["uid"] = PEDRO
    respuesta = await http.patch(
        f"{CATALOGO}/courses/{curso['id']}", json={"topic_ids": [COCINA]}
    )
    assert respuesta.status_code == 403


# --------------------------------------------------------------------------- #
# 8. Rendimiento: nada de una consulta por modulo
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_detalle_no_crece_con_los_modulos(entorno):
    """Antes: una consulta por modulo. Diez modulos, once viajes."""
    http, sesiones, _ = entorno
    curso = await _crear_curso(
        http, description="Una descripción larga de verdad.", topic_ids=[IA]
    )
    async with sesiones() as db:
        for i in range(8):
            modulo = CourseModule(
                course_id=curso["id"], title=f"Módulo {i}", sort_order=i
            )
            db.add(modulo)
            await db.flush()
            for j in range(3):
                db.add(
                    CourseLesson(
                        module_id=modulo.id,
                        title=f"Lección {i}.{j}",
                        duration_seconds=600,
                        sort_order=j,
                    )
                )
        await db.commit()

    from sqlalchemy import event

    consultas: list[str] = []

    def _contar(conn, cursor, statement, *args):  # noqa: ANN001
        consultas.append(statement)

    event.listen(engine_de(sesiones).sync_engine, "before_cursor_execute", _contar)
    try:
        detalle = await http.get(f"{LEARNING}/courses/{curso['id']}")
    finally:
        event.remove(engine_de(sesiones).sync_engine, "before_cursor_execute", _contar)

    assert detalle.status_code == 200
    assert detalle.json()["lessons_total"] == 24
    selects = [c for c in consultas if c.lstrip().lower().startswith("select")]
    assert len(selects) <= 8, f"{len(selects)} consultas: {selects}"
