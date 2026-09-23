"""Valoraciones de cursos: quién puede, qué se calcula y qué no se guarda."""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.catalog import esquema
from app.modules.catalog.models import Course, CourseReview
from app.modules.commerce import esquema as esquema_comercio
from app.modules.commerce.models import CommerceProduct, Entitlement, Order
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db

CATALOGO = "/api/v1/catalog"
ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "bbbbbbbb-0000-0000-0000-000000000002"
AUTORA = "cccccccc-0000-0000-0000-00000000000a"
MODERADOR = "dddddddd-0000-0000-0000-000000000003"
CURSO = "cccccccc-0000-0000-0000-000000000001"
PRECIO = 4900


@pytest_asyncio.fixture
async def entorno():
    esquema.olvidar()
    esquema_comercio.olvidar()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    sesiones = async_sessionmaker(engine, expire_on_commit=False)

    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(Profile(id=AUTORA, full_name="Carla", username="carla"))
        db.add(
            Profile(id=MODERADOR, full_name="Marta", username="marta", role="moderator")
        )
        db.add(
            Course(
                id=CURSO,
                author_id=AUTORA,
                title="Respiración",
                description="",
                price_minor=PRECIO,
                currency="PEN",
                status="published",
            )
        )
        await db.flush()
        producto = CommerceProduct(course_id=CURSO)
        db.add(producto)
        await db.flush()
        # Ana compró y tiene acceso. Bruno no ha comprado.
        db.add(
            Order(
                user_id=ANA,
                commerce_product_id=producto.id,
                provider="stripe",
                channel="web",
                environment="sandbox",
                status="paid",
                amount_minor=PRECIO,
                currency="PEN",
            )
        )
        db.add(
            Entitlement(
                user_id=ANA,
                commerce_product_id=producto.id,
                status="active",
                source_provider="stripe",
            )
        )
        await db.commit()

    identidad = {"uid": ANA}

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


async def _valorar(http, rating: int, comment: str | None = None):
    return await http.post(
        f"{CATALOGO}/courses/{CURSO}/reviews",
        json={"rating": rating, "comment": comment},
    )


# --------------------------------------------------------------------------- #
# Quién puede valorar
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_quien_compro_y_tiene_acceso_puede_valorar(entorno):
    http, _, _ = entorno
    respuesta = await _valorar(http, 5, "Muy bueno")
    assert respuesta.status_code == 201, respuesta.text
    cuerpo = respuesta.json()
    assert cuerpo["rating"] == 5
    assert cuerpo["verified_purchase"] is True
    assert cuerpo["is_mine"] is True
    assert cuerpo["author_name"] == "Ana"


@pytest.mark.asyncio
async def test_sin_compra_no_se_puede_valorar(entorno):
    http, identidad, _ = entorno
    identidad["uid"] = BRUNO
    respuesta = await _valorar(http, 5)
    assert respuesta.status_code == 422
    assert "review_purchase_required" in respuesta.text


@pytest.mark.asyncio
async def test_la_autora_no_puede_valorar_su_propio_curso(entorno):
    """Valorar lo propio no es una opinion, es publicidad."""
    http, identidad, _ = entorno
    identidad["uid"] = AUTORA
    respuesta = await _valorar(http, 5)
    assert respuesta.status_code == 422
    assert "review_owner_not_allowed" in respuesta.text


@pytest.mark.asyncio
async def test_quien_devolvio_ya_no_puede_valorar(entorno):
    """Compro, pero su acceso ya no esta vivo."""
    http, _, sesiones = entorno
    async with sesiones() as db:
        derecho = await db.scalar(select(Entitlement))
        derecho.status = "revoked"
        await db.commit()

    respuesta = await _valorar(http, 5)
    assert respuesta.status_code == 422
    assert "review_access_required" in respuesta.text


# --------------------------------------------------------------------------- #
# La puntuación
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
@pytest.mark.parametrize("puntuacion", [1, 5])
async def test_los_extremos_valen(entorno, puntuacion):
    http, _, _ = entorno
    assert (await _valorar(http, puntuacion)).status_code == 201


@pytest.mark.asyncio
@pytest.mark.parametrize("puntuacion", [0, 6, -1, 100])
async def test_fuera_de_rango_se_rechaza(entorno, puntuacion):
    http, _, sesiones = entorno
    assert (await _valorar(http, puntuacion)).status_code == 422
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(CourseReview)) == 0


@pytest.mark.asyncio
async def test_el_cliente_no_decide_si_esta_verificado(entorno):
    """`verified` lo decide el SERVIDOR mirando la compra.

    Con BRUNO no se probaba nada: como no ha comprado, el 422 llegaba por
    `review_purchase_required` antes de mirar la bandera. Hace falta ANA, que SI
    puede valorar, mandando la bandera al reves de la verdad.
    """
    http, _, _ = entorno
    respuesta = await http.post(
        f"{CATALOGO}/courses/{CURSO}/reviews",
        json={"rating": 5, "verified_purchase": False, "verified": False},
    )
    assert respuesta.status_code == 201, respuesta.text
    assert respuesta.json()["verified_purchase"] is True, "manda la compra, no el JSON"


@pytest.mark.asyncio
async def test_devolver_apaga_el_sello_de_una_valoracion_ya_publicada(entorno):
    """El sello se deriva al leer: no se guarda con la valoracion.

    Ana valoro cuando tenia el curso. Al devolverlo su opinion sigue ahi
    --es suya-- pero deja de presentarse como compra activa.
    """
    http, _, sesiones = entorno
    assert (await _valorar(http, 5)).status_code == 201
    primera = (await http.get(f"{CATALOGO}/courses/{CURSO}/reviews")).json()
    assert primera[0]["verified_purchase"] is True

    async with sesiones() as db:
        derecho = await db.scalar(select(Entitlement))
        derecho.status = "revoked"
        await db.commit()

    listado = (await http.get(f"{CATALOGO}/courses/{CURSO}/reviews")).json()
    assert listado[0]["verified_purchase"] is False


@pytest.mark.asyncio
async def test_poner_el_curso_gratis_no_sella_a_quien_devolvio(entorno):
    """El sello habla de haber PAGADO, no de poder entrar.

    Resolverlo con el acceso al curso era el error: ese cortocircuita en
    `price_minor <= 0`, asi que bajar el precio a cero sellaba de golpe hasta
    las valoraciones de quien ya habia devuelto.
    """
    http, _, sesiones = entorno
    assert (await _valorar(http, 5)).status_code == 201
    async with sesiones() as db:
        derecho = await db.scalar(select(Entitlement))
        derecho.status = "revoked"
        curso = await db.get(Course, CURSO)
        curso.price_minor = 0
        await db.commit()

    listado = (await http.get(f"{CATALOGO}/courses/{CURSO}/reviews")).json()
    assert listado[0]["verified_purchase"] is False


# --------------------------------------------------------------------------- #
# Una por persona y curso
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_valorar_dos_veces_da_conflicto_y_no_dos_votos(entorno):
    http, _, sesiones = entorno
    assert (await _valorar(http, 5)).status_code == 201
    segunda = await _valorar(http, 1)
    assert segunda.status_code == 409
    assert "course_review_exists" in segunda.text
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(CourseReview)) == 1


@pytest.mark.asyncio
async def test_una_recompra_no_da_un_segundo_voto(entorno):
    """Comprar otra vez no multiplica la opinion de la misma persona."""
    http, _, sesiones = entorno
    await _valorar(http, 4)
    async with sesiones() as db:
        producto = await db.scalar(select(CommerceProduct))
        db.add(
            Order(
                user_id=ANA,
                commerce_product_id=producto.id,
                provider="stripe",
                channel="web",
                environment="sandbox",
                status="paid",
                amount_minor=PRECIO,
                currency="PEN",
            )
        )
        await db.commit()

    assert (await _valorar(http, 1)).status_code == 409
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(CourseReview)) == 1


# --------------------------------------------------------------------------- #
# Editar y retirar
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_se_edita_la_propia(entorno):
    http, _, _ = entorno
    mia = (await _valorar(http, 2, "Regular")).json()
    respuesta = await http.patch(
        f"{CATALOGO}/courses/{CURSO}/reviews/{mia['id']}",
        json={"rating": 5, "comment": "Mejoró"},
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["rating"] == 5
    assert respuesta.json()["comment"] == "Mejoró"


@pytest.mark.asyncio
async def test_nadie_edita_la_de_otro(entorno):
    http, identidad, _ = entorno
    mia = (await _valorar(http, 5)).json()
    identidad["uid"] = BRUNO
    respuesta = await http.patch(
        f"{CATALOGO}/courses/{CURSO}/reviews/{mia['id']}", json={"rating": 1}
    )
    assert respuesta.status_code == 403


@pytest.mark.asyncio
async def test_una_valoracion_de_otro_curso_no_se_puede_tocar(entorno):
    """Identificadores cruzados: 404, no una edicion silenciosa."""
    http, _, _ = entorno
    mia = (await _valorar(http, 5)).json()
    otro = "cccccccc-0000-0000-0000-0000000000ff"
    respuesta = await http.patch(
        f"{CATALOGO}/courses/{otro}/reviews/{mia['id']}", json={"rating": 1}
    )
    assert respuesta.status_code == 404


@pytest.mark.asyncio
async def test_se_retira_la_propia(entorno):
    http, _, sesiones = entorno
    mia = (await _valorar(http, 5)).json()
    respuesta = await http.delete(f"{CATALOGO}/courses/{CURSO}/reviews/{mia['id']}")
    assert respuesta.status_code == 204
    async with sesiones() as db:
        assert await db.scalar(select(func.count()).select_from(CourseReview)) == 0


# --------------------------------------------------------------------------- #
# Moderación
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_moderar_oculta_pero_no_cambia_la_puntuacion(entorno):
    http, identidad, sesiones = entorno
    mia = (await _valorar(http, 5, "Insultos")).json()
    identidad["uid"] = MODERADOR
    respuesta = await http.post(
        f"{CATALOGO}/courses/{CURSO}/reviews/{mia['id']}/hide"
    )
    assert respuesta.status_code == 200
    async with sesiones() as db:
        fila = await db.get(CourseReview, mia["id"])
        assert fila.status == "hidden"
        assert fila.rating == 5, "moderar no toca la puntuacion"
        assert fila.user_id == ANA, "ni el autor"


@pytest.mark.asyncio
async def test_una_valoracion_oculta_no_cuenta_en_el_promedio(entorno):
    http, identidad, _ = entorno
    mia = (await _valorar(http, 1)).json()
    antes = (await http.get(f"{CATALOGO}/courses/{CURSO}/reviews/summary")).json()
    assert antes["average"] == 1.0 and antes["total"] == 1

    identidad["uid"] = MODERADOR
    await http.post(f"{CATALOGO}/courses/{CURSO}/reviews/{mia['id']}/hide")

    despues = (await http.get(f"{CATALOGO}/courses/{CURSO}/reviews/summary")).json()
    assert despues["average"] is None
    assert despues["total"] == 0


# --------------------------------------------------------------------------- #
# Resumen y listado
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_sin_valoraciones_el_promedio_es_nulo_y_no_cero(entorno):
    """Un 0,0 diria que el curso esta mal valorado. `null` dice que no hay."""
    http, _, _ = entorno
    resumen = (await http.get(f"{CATALOGO}/courses/{CURSO}/reviews/summary")).json()
    assert resumen["average"] is None
    assert resumen["total"] == 0
    assert resumen["distribution"] == {"1": 0, "2": 0, "3": 0, "4": 0, "5": 0}


@pytest.mark.asyncio
async def test_el_promedio_y_la_distribucion_salen_de_las_filas(entorno):
    http, _, sesiones = entorno
    await _valorar(http, 5)
    # Otra persona con compra propia, para tener dos votos.
    async with sesiones() as db:
        producto = await db.scalar(select(CommerceProduct))
        db.add(
            Order(
                user_id=BRUNO,
                commerce_product_id=producto.id,
                provider="stripe",
                channel="web",
                environment="sandbox",
                status="paid",
                amount_minor=PRECIO,
                currency="PEN",
            )
        )
        db.add(
            Entitlement(
                user_id=BRUNO,
                commerce_product_id=producto.id,
                status="active",
                source_provider="stripe",
            )
        )
        await db.commit()

    http_bruno = http
    entorno[1]["uid"] = BRUNO
    await _valorar(http_bruno, 2)

    resumen = (await http.get(f"{CATALOGO}/courses/{CURSO}/reviews/summary")).json()
    assert resumen["total"] == 2
    assert resumen["average"] == 3.5
    assert resumen["distribution"]["5"] == 1
    assert resumen["distribution"]["2"] == 1


@pytest.mark.asyncio
async def test_el_listado_no_expone_el_motivo_interno_de_moderacion(entorno):
    http, identidad, sesiones = entorno
    mia = (await _valorar(http, 3)).json()
    async with sesiones() as db:
        fila = await db.get(CourseReview, mia["id"])
        fila.moderation_reason = "revisado por soporte"
        await db.commit()

    listado = (await http.get(f"{CATALOGO}/courses/{CURSO}/reviews")).json()
    assert len(listado) == 1
    for campo in listado[0]:
        assert "moderation" not in campo, f"«{campo}» es interno"
    assert "revisado por soporte" not in str(listado)


@pytest.mark.asyncio
async def test_sin_la_migracion_se_dice_en_vez_de_fingir(entorno):
    http, _, sesiones = entorno
    async with sesiones() as db:
        await db.execute(text("drop table course_reviews"))
        await db.commit()
    esquema.olvidar()

    assert (await http.get(f"{CATALOGO}/courses/{CURSO}/reviews")).status_code == 503
    assert (
        await http.get(f"{CATALOGO}/courses/{CURSO}/reviews/summary")
    ).status_code == 503
    assert (await _valorar(http, 5)).status_code == 503


# --------------------------------------------------------------------------- #
# Moderar no se deshace desde el cliente
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_quien_no_modera_no_puede_ocultar(entorno):
    """El 403 es la unica pieza que sostiene esto: no hay nada mas.

    Sin la comprobacion, cualquiera con sesion oculta la valoracion que no le
    guste, incluida la de la competencia.
    """
    http, identidad, sesiones = entorno
    mia = (await _valorar(http, 1)).json()
    identidad["uid"] = BRUNO
    respuesta = await http.post(f"{CATALOGO}/courses/{CURSO}/reviews/{mia['id']}/hide")
    assert respuesta.status_code == 403
    async with sesiones() as db:
        assert (await db.get(CourseReview, mia["id"])).status == "visible"


@pytest.mark.asyncio
async def test_la_autora_ve_su_valoracion_oculta_pero_nadie_mas(entorno):
    """Si no la ve no puede editarla, y el 409 la deja sin salida.

    Es tambien lo que dice la politica de la 0056: `status = 'visible' or
    user_id = auth.uid()`.
    """
    http, identidad, _ = entorno
    mia = (await _valorar(http, 1, "Insultos")).json()
    identidad["uid"] = MODERADOR
    await http.post(f"{CATALOGO}/courses/{CURSO}/reviews/{mia['id']}/hide")

    ajenas = (await http.get(f"{CATALOGO}/courses/{CURSO}/reviews")).json()
    assert ajenas == [], "para el resto del mundo, oculta es oculta"

    identidad["uid"] = ANA
    propias = (await http.get(f"{CATALOGO}/courses/{CURSO}/reviews")).json()
    assert [v["id"] for v in propias] == [mia["id"]]
    assert propias[0]["is_mine"] is True
    # Y se le dice que esta en revision: verla listada sin mas la daria por
    # publicada, y no entenderia por que la media no se movio.
    assert propias[0]["hidden"] is True
    assert mia["hidden"] is False, "al publicarla no lo estaba"


@pytest.mark.asyncio
async def test_una_oculta_no_se_retira_para_volver_a_publicarla(entorno):
    """Borrarla y valorar otra vez deshace la moderacion.

    Con la fila fuera la unicidad deja de dar 409 y vuelve el mismo texto,
    visible. El limite tiene que estar en el DELETE.
    """
    http, identidad, sesiones = entorno
    mia = (await _valorar(http, 1, "Insultos")).json()
    identidad["uid"] = MODERADOR
    await http.post(f"{CATALOGO}/courses/{CURSO}/reviews/{mia['id']}/hide")

    identidad["uid"] = ANA
    respuesta = await http.delete(f"{CATALOGO}/courses/{CURSO}/reviews/{mia['id']}")
    assert respuesta.status_code == 409
    assert "course_review_moderated" in respuesta.text
    async with sesiones() as db:
        fila = await db.get(CourseReview, mia["id"])
        assert fila is not None and fila.status == "hidden"

    assert (await _valorar(http, 5, "Otra cosa")).status_code == 409


# --------------------------------------------------------------------------- #
# Editar cambia solo lo que se manda
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_subir_la_puntuacion_no_borra_el_comentario(entorno):
    """Un PATCH cambia lo que trae. Antes se comportaba como un PUT."""
    http, _, _ = entorno
    mia = (await _valorar(http, 3, "Me costo el modulo 2")).json()
    respuesta = await http.patch(
        f"{CATALOGO}/courses/{CURSO}/reviews/{mia['id']}", json={"rating": 5}
    )
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["rating"] == 5
    assert respuesta.json()["comment"] == "Me costo el modulo 2"


@pytest.mark.asyncio
async def test_el_comentario_se_vacia_solo_si_se_pide(entorno):
    """Mandar `null` SI lo borra: lo que no vale es borrarlo sin pedirlo."""
    http, _, _ = entorno
    mia = (await _valorar(http, 3, "Me arrepiento de esto")).json()
    respuesta = await http.patch(
        f"{CATALOGO}/courses/{CURSO}/reviews/{mia['id']}",
        json={"comment": None},
    )
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["comment"] is None
    assert respuesta.json()["rating"] == 3, "y la puntuacion se queda"


@pytest.mark.asyncio
async def test_un_patch_vacio_no_pasa_por_valido(entorno):
    http, _, _ = entorno
    mia = (await _valorar(http, 3, "Bien")).json()
    respuesta = await http.patch(
        f"{CATALOGO}/courses/{CURSO}/reviews/{mia['id']}", json={}
    )
    assert respuesta.status_code == 422
    assert "course_review_no_changes" in respuesta.text


# --------------------------------------------------------------------------- #
# El listado es publico: no puede crecer con cada valoracion
# --------------------------------------------------------------------------- #


def _contar_selects(sesiones):
    """Devuelve (consultas, quitar) para contar el SQL de verdad."""
    consultas: list[str] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        consultas.append(statement)

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    return consultas, lambda: event.remove(motor, "before_cursor_execute", _anotar)


async def _poblar(sesiones, desde: int, cuantas: int) -> None:
    async with sesiones() as db:
        for i in range(desde, desde + cuantas):
            uid = f"eeeeeeee-0000-0000-0000-{i:012d}"
            db.add(Profile(id=uid, full_name=f"Persona {i}", username=f"p{i}"))
            db.add(CourseReview(course_id=CURSO, user_id=uid, rating=4))
        await db.commit()


async def _selects_del_listado(http, sesiones) -> int:
    consultas, quitar = _contar_selects(sesiones)
    try:
        respuesta = await http.get(f"{CATALOGO}/courses/{CURSO}/reviews")
    finally:
        quitar()
    assert respuesta.status_code == 200, respuesta.text
    return len([c for c in consultas if c.lstrip().lower().startswith("select")])


@pytest.mark.asyncio
async def test_el_listado_no_hace_una_consulta_por_valoracion(entorno):
    """Con el sello resuelto fila a fila eran dos sentencias por valoracion.

    A cien por pagina y sin sesion eso son doscientas consultas que cualquiera
    puede pedir. Lo que se comprueba es que el numero NO depende de cuantas hay.
    """
    http, _, sesiones = entorno
    await _poblar(sesiones, 0, 1)
    con_una = await _selects_del_listado(http, sesiones)

    await _poblar(sesiones, 1, 20)
    con_veintiuna = await _selects_del_listado(http, sesiones)

    assert con_veintiuna == con_una, (
        f"{con_una} consultas con una valoracion y {con_veintiuna} con veintiuna"
    )
