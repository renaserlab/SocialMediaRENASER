"""El versionado de cursos: lo que se congela, cuándo, y qué no se puede tocar.

LO QUE SE PROTEGE AQUÍ es lo contrario de lo que había: hasta la 0050, editar un
curso reescribía lo que alguien ya había comprado. La orden congelaba el importe
y la moneda, y nada más, así que a «¿qué compró exactamente esta persona?» no
había respuesta.

LAS PRUEBAS QUE MÁS VALEN son las de lo que NO debe pasar: que republicar sin
cambios no invente una versión, que dos publicaciones simultáneas no dejen dos
vigentes, y que una orden antigua no acabe apuntando a una versión reconstruida
como si fuera la que se vendió.
"""

from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.catalog import versiones
from app.modules.catalog.models import Course, CourseVersion
from app.modules.commerce.models import CommerceProduct, Order
from app.modules.gobernanza import esquema as esquema_gobernanza
from app.modules.learning.models import CourseLesson, CourseModule
from app.modules.profiles.models import Profile
from app.modules.recommendations.models import CourseTopic, Topic
from app.shared.database import Base, get_db

CATALOGO = "/api/v1/catalog"
ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
CURSO = "cccccccc-0000-0000-0000-000000000001"


@pytest_asyncio.fixture
async def entorno():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    hacer = async_sessionmaker(engine, expire_on_commit=False)
    esquema_gobernanza.olvidar()

    async with hacer() as db:
        db.add_all(
            [
                Profile(id=ANA, username="ana", full_name="Ana"),
                Profile(id=BRUNO, username="bruno", full_name="Bruno"),
            ]
        )
        curso = Course(
            id=CURSO,
            author_id=BRUNO,
            title="Curso de Bruno",
            description="Una descripcion larga de sobra para pasar el minimo de treinta.",
            price_minor=19900,
            currency="PEN",
            status="draft",
        )
        db.add(curso)
        await db.flush()
        modulo = CourseModule(course_id=CURSO, title="Modulo 1", sort_order=1)
        db.add(modulo)
        await db.flush()
        db.add(
            CourseLesson(
                module_id=modulo.id, title="Leccion 1", sort_order=1, duration_seconds=600
            )
        )
        # Publicar exige al menos un tema (la regla de siempre, sin la 0034).
        tema = Topic(slug="negocios", name="Negocios")
        db.add(tema)
        await db.flush()
        db.add(CourseTopic(course_id=CURSO, topic_id=tema.id))
        await db.commit()

    identidad = {"uid": BRUNO}

    async def _sesion():
        async with hacer() as db:
            yield db

    async def _usuario() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _sesion
    app.dependency_overrides[get_current_user] = _usuario
    app.dependency_overrides[get_optional_user] = _usuario
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://t"
        ) as http:
            yield http, hacer, identidad
    finally:
        app.dependency_overrides.clear()
        esquema_gobernanza.olvidar()


async def _publicar(http) -> None:
    respuesta = await http.post(f"{CATALOGO}/courses/{CURSO}/publish")
    assert respuesta.status_code == 200, respuesta.text
    # `published: false` tambien devuelve 200: es «te falta esto», no un error.
    # Sin esta comprobacion, una prueba de versionado se quedaria en verde
    # midiendo un curso que nunca llego a publicarse.
    cuerpo = respuesta.json()
    assert cuerpo["published"] is True, cuerpo.get("missing")


# --------------------------------------------------------------------------- #
# Crear versiones
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_publicar_congela_lo_que_el_curso_ofrece(entorno) -> None:
    http, sesiones, _ = entorno
    await _publicar(http)

    async with sesiones() as db:
        version = await db.scalar(select(CourseVersion))
        assert version is not None
        assert version.version == 1
        assert version.status == "published"
        assert version.origin == "publish", "una publicacion real no es un backfill"
        assert version.snapshot["title"] == "Curso de Bruno"
        # EL TEMARIO ENTRA EN LA FOTOGRAFIA. Es lo que no se puede reconstruir
        # despues: `course_modules` y `course_lessons` no tienen marca temporal.
        assert version.snapshot["modules"][0]["lessons"][0]["title"] == "Leccion 1"


@pytest.mark.asyncio
async def test_republicar_sin_cambios_no_crea_otra_version(entorno) -> None:
    """Republicar no es versionar.

    Una version identica a la anterior solo ensucia el historial y confunde a
    quien mire «¿que compre?»: dos numeros distintos para el mismo contenido.
    """
    http, sesiones, _ = entorno
    await _publicar(http)
    await http.post(f"{CATALOGO}/courses/{CURSO}/unpublish")
    await _publicar(http)

    async with sesiones() as db:
        todas = list(await db.scalars(select(CourseVersion)))
        assert len(todas) == 1, [v.version for v in todas]
        assert todas[0].status == "published"


@pytest.mark.asyncio
async def test_cambiar_el_contenido_crea_una_version_nueva(entorno) -> None:
    http, sesiones, _ = entorno
    await _publicar(http)

    respuesta = await http.patch(
        f"{CATALOGO}/courses/{CURSO}", json={"title": "Otro titulo"}
    )
    assert respuesta.status_code == 200, respuesta.text
    await _publicar(http)

    async with sesiones() as db:
        todas = sorted(await db.scalars(select(CourseVersion)), key=lambda v: v.version)
        assert [v.version for v in todas] == [1, 2]
        # LA ANTERIOR NO SE BORRA NI SE EDITA: es lo que alguien compro.
        assert todas[0].status == "superseded"
        assert todas[0].snapshot["title"] == "Curso de Bruno"
        assert todas[1].status == "published"
        assert todas[1].snapshot["title"] == "Otro titulo"


@pytest.mark.asyncio
async def test_cambiar_el_precio_NO_crea_version(entorno) -> None:
    """El precio es OFERTA, no contenido.

    Cambiarlo no puede invalidar el temario que alguien esta viendo. Va
    congelado en la orden, que es donde importa.
    """
    http, sesiones, _ = entorno
    await _publicar(http)
    await http.patch(f"{CATALOGO}/courses/{CURSO}", json={"price_minor": 29900})
    await _publicar(http)

    async with sesiones() as db:
        assert len(list(await db.scalars(select(CourseVersion)))) == 1


@pytest.mark.asyncio
async def test_solo_hay_una_version_vigente_por_curso(entorno) -> None:
    http, sesiones, _ = entorno
    await _publicar(http)
    await http.patch(f"{CATALOGO}/courses/{CURSO}", json={"title": "Segundo"})
    await _publicar(http)
    await http.patch(f"{CATALOGO}/courses/{CURSO}", json={"title": "Tercero"})
    await _publicar(http)

    async with sesiones() as db:
        vigentes = list(
            await db.scalars(
                select(CourseVersion).where(CourseVersion.status == "published")
            )
        )
        assert len(vigentes) == 1
        assert vigentes[0].version == 3


@pytest.mark.asyncio
async def test_la_base_impide_dos_versiones_vigentes_del_mismo_curso(entorno) -> None:
    """La invariante, comprobada DONDE de verdad se sostiene: en el indice.

    POR QUE NO SE PRUEBA LANZANDO DOS PETICIONES A LA VEZ. Porque aqui no
    probaria nada: SQLite en memoria comparte UNA sola conexion entre todas las
    sesiones, asi que dos peticiones «simultaneas» se serializan y el resultado
    verde no dice nada sobre PostgreSQL. Fingir esa concurrencia es peor que no
    probarla: da una confianza que no existe.

    Lo que si se puede comprobar aqui, y es lo que de verdad importa, es que la
    BASE rechaza el segundo `published`. `publish_course` lee, valida y escribe
    sin bloqueo: un `if` en Python lo pasan dos peticiones, este indice no.

    La ejecucion real de esa carrera sobre PostgreSQL queda pendiente y esta
    declarada como tal en `docs/Z_REQUISITOS_Y_DECISIONES.md`.
    """
    from sqlalchemy.exc import IntegrityError

    http, sesiones, _ = entorno
    await _publicar(http)

    async with sesiones() as db:
        vigente_actual = await db.scalar(
            select(CourseVersion).where(CourseVersion.status == "published")
        )
        assert vigente_actual is not None
        db.add(
            CourseVersion(
                course_id=CURSO,
                version=vigente_actual.version + 1,
                status="published",
                content_hash="otra",
                snapshot={"title": "colada por la puerta de atras"},
            )
        )
        with pytest.raises(IntegrityError):
            await db.flush()


@pytest.mark.asyncio
async def test_retirar_el_curso_no_borra_la_version(entorno) -> None:
    """Despublicar no destruye historial: es lo que alguien compro."""
    http, sesiones, _ = entorno
    await _publicar(http)
    await http.post(f"{CATALOGO}/courses/{CURSO}/unpublish")

    async with sesiones() as db:
        todas = list(await db.scalars(select(CourseVersion)))
        assert len(todas) == 1
        assert todas[0].status == "superseded"


# --------------------------------------------------------------------------- #
# La orden
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_una_orden_nueva_apunta_a_la_version_vigente(entorno) -> None:
    from app.modules.commerce import service as comercio

    http, sesiones, _ = entorno
    await _publicar(http)

    async with sesiones() as db:
        producto = CommerceProduct(kind="course_lifetime", course_id=CURSO, active=True)
        db.add(producto)
        await db.flush()
        orden = await comercio.crear_orden(
            db,
            user_id=ANA,
            commerce_product_id=producto.id,
            provider="stripe",
            channel="web",
            environment="sandbox",
        )
        await db.commit()
        vigente = await versiones.vigente(db, CURSO)
        assert orden.course_version_id == vigente.id
        assert orden.snapshot_origin == "live"
        # LA PROMESA DE GARANTIA, CONGELADA. Hoy es 168 para todos; guardarla
        # aqui no cambia ningun plazo vivo y evita una segunda migracion sobre
        # ordenes ya pagadas el dia que deje de ser unica.
        assert orden.guarantee_hours == 168
        assert orden.guarantee_policy == "refund_v1"


@pytest.mark.asyncio
async def test_una_orden_historica_se_queda_sin_version(entorno) -> None:
    """Y ESO ES LO CORRECTO, no una carencia.

    `course_modules` y `course_lessons` no tienen ninguna marca temporal, y el
    movil las edita directamente contra Supabase sin dejar rastro. No hay forma
    de saber que contenido se vendio, asi que rellenar `course_version_id` con
    la version de hoy seria AFIRMAR algo que no se sabe.
    """
    http, sesiones, _ = entorno

    async with sesiones() as db:
        producto = CommerceProduct(kind="course_lifetime", course_id=CURSO, active=True)
        db.add(producto)
        await db.flush()
        db.add(
            Order(
                user_id=ANA,
                commerce_product_id=producto.id,
                provider="stripe",
                channel="web",
                environment="sandbox",
                amount_minor=19900,
                currency="PEN",
                status="paid",
            )
        )
        await db.commit()

    # Se publica DESPUES: la version nace ahora, la orden es de antes.
    await _publicar(http)

    async with sesiones() as db:
        orden = await db.scalar(select(Order))
        assert orden.course_version_id is None
        assert orden.snapshot_origin == "legacy"


@pytest.mark.asyncio
async def test_editar_el_curso_no_cambia_lo_que_dice_una_orden_vieja(entorno) -> None:
    """El defecto que motiva toda esta ronda, escrito como prueba."""
    from app.modules.commerce import service as comercio

    http, sesiones, _ = entorno
    await _publicar(http)

    async with sesiones() as db:
        producto = CommerceProduct(kind="course_lifetime", course_id=CURSO, active=True)
        db.add(producto)
        await db.flush()
        orden = await comercio.crear_orden(
            db,
            user_id=ANA,
            commerce_product_id=producto.id,
            provider="stripe",
            channel="web",
            environment="sandbox",
        )
        await db.commit()
        version_comprada = orden.course_version_id

    # El autor lo reescribe entero y vuelve a publicar.
    await http.patch(
        f"{CATALOGO}/courses/{CURSO}",
        json={
            "title": "Curso completamente distinto",
            "description": "Otra descripcion, tambien larga de sobra para el minimo.",
        },
    )
    await _publicar(http)

    async with sesiones() as db:
        orden = await db.scalar(select(Order))
        assert orden.course_version_id == version_comprada
        comprada = await db.get(CourseVersion, version_comprada)
        assert comprada.snapshot["title"] == "Curso de Bruno"
        assert comprada.status == "superseded"


# --------------------------------------------------------------------------- #
# El endpoint
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_la_version_publicada_se_puede_consultar(entorno) -> None:
    http, _, identidad = entorno
    await _publicar(http)

    identidad["uid"] = ANA  # cualquiera: es la ficha de un curso publicado
    respuesta = await http.get(f"{CATALOGO}/courses/{CURSO}/version")
    assert respuesta.status_code == 200, respuesta.text
    cuerpo = respuesta.json()
    assert cuerpo["version"] == 1
    # LA DISTINCION QUE NO SE PUEDE PERDER: sin ella, una version reconstruida
    # por el backfill pasa por ser la que se vendio.
    assert cuerpo["reconstruida"] is False
    assert cuerpo["snapshot"]["title"] == "Curso de Bruno"


@pytest.mark.asyncio
async def test_un_curso_sin_version_responde_404_y_no_se_inventa_una(entorno) -> None:
    http, _, _ = entorno
    respuesta = await http.get(f"{CATALOGO}/courses/{CURSO}/version")
    assert respuesta.status_code == 404
    assert "course_version_not_available" in respuesta.text
