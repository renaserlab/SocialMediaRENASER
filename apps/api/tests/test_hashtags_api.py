"""Los hashtags de extremo a extremo, sobre una base de datos de verdad.

SQLite en memoria, mismo patron que el resto de la suite. Las personas de estos
escenarios viven los milisegundos que dura cada prueba: NUNCA llegan a Supabase.

Lo que se comprueba aqui y no cabe en una funcion pura: que la etiqueta se
guarde de verdad al publicar, que la cuenta de publicaciones sea la REAL (y no
la de una tabla que incluye lo borrado), que dos publicaciones que escriben la
etiqueta distinto acaben en la misma, y que editar el texto mueva la
publicacion de etiqueta en vez de dejarla colgada de una palabra que ya no dice.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.content.models import Hashtag, Post, PostHashtag
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

POSTS = "/api/v1/posts"
HASHTAGS = "/api/v1/hashtags"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"


@pytest_asyncio.fixture
async def entorno():
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
        from app.modules.notifications import device_tokens as _dt  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="ana@ejemplo.com", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    await engine.dispose()


async def _publicar(http: AsyncClient, texto: str) -> dict:
    respuesta = await http.post(POSTS, json={"body": texto})
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()


# --------------------------------------------------------------------------- #
# Se guardan de verdad, y las extrae el servidor
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_publicar_guarda_las_etiquetas_del_texto(entorno):
    http, sesiones, _ = entorno
    publicacion = await _publicar(http, "Aprendiendo #Python y #IA")

    async with sesiones() as db:
        filas = (
            await db.execute(
                select(Hashtag.tag)
                .join(PostHashtag, PostHashtag.hashtag_id == Hashtag.id)
                .where(PostHashtag.post_id == publicacion["id"])
            )
        ).all()
    assert sorted(fila[0] for fila in filas) == ["ia", "python"]


@pytest.mark.asyncio
async def test_la_respuesta_devuelve_las_etiquetas_como_se_escribieron(entorno):
    """Lo que ve quien publica es lo que quedo guardado, no lo que pidio."""
    http, _, _ = entorno
    publicacion = await _publicar(http, "Sobre #MiNegocio")
    assert publicacion["hashtags"] == ["MiNegocio"]


@pytest.mark.asyncio
async def test_el_cliente_no_puede_colgar_una_publicacion_de_una_etiqueta(entorno):
    """LA RAZON DE QUE EL SERVIDOR EXTRAIGA Y NO ACEPTE UNA LISTA.

    Si el cliente pudiera mandar las etiquetas, cualquiera aparecería en
    #python sin que la palabra estuviera en su texto. Eso es spam de etiquetas,
    y aqui se comprueba que ese campo sencillamente no existe: se manda y no
    pasa nada.
    """
    http, _, _ = entorno
    respuesta = await http.post(
        POSTS, json={"body": "Nada que ver", "hashtags": ["python"]}
    )
    assert respuesta.status_code == 201
    assert respuesta.json()["hashtags"] == []


@pytest.mark.asyncio
async def test_una_publicacion_sin_etiquetas_se_publica_igual(entorno):
    http, _, _ = entorno
    publicacion = await _publicar(http, "Hoy fue un buen dia")
    assert publicacion["hashtags"] == []


# --------------------------------------------------------------------------- #
# Sin duplicados
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_misma_etiqueta_repetida_deja_una_sola_fila(entorno):
    """Escribirla tres veces es enfasis, no tres etiquetas."""
    http, sesiones, _ = entorno
    publicacion = await _publicar(http, "#ia por aqui, #IA por alla y #Ia otra vez")

    async with sesiones() as db:
        cuantas = await db.scalar(
            select(func.count())
            .select_from(PostHashtag)
            .where(PostHashtag.post_id == publicacion["id"])
        )
    assert cuantas == 1


@pytest.mark.asyncio
async def test_dos_publicaciones_comparten_UNA_fila_de_etiqueta(entorno):
    """#IA y #ia en publicaciones distintas son la MISMA etiqueta.

    Si se crearan dos filas, la etiqueta quedaria partida en dos para siempre y
    cada mitad tendria la mitad de las publicaciones.
    """
    http, sesiones, _ = entorno
    await _publicar(http, "Primera sobre #IA")
    await _publicar(http, "Segunda sobre #ia")

    async with sesiones() as db:
        cuantas = await db.scalar(
            select(func.count()).select_from(Hashtag).where(Hashtag.tag == "ia")
        )
    assert cuantas == 1


# --------------------------------------------------------------------------- #
# La cuenta REAL de publicaciones
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_cuenta_es_el_numero_real_de_publicaciones(entorno):
    http, _, _ = entorno
    await _publicar(http, "Una de #python")
    await _publicar(http, "Otra de #Python")
    await _publicar(http, "Y otra mas de #PYTHON")
    await _publicar(http, "Esta va de otra cosa")

    respuesta = await http.get(f"{HASHTAGS}/python")
    assert respuesta.status_code == 200
    assert respuesta.json()["posts_count"] == 3


@pytest.mark.asyncio
async def test_lo_borrado_no_cuenta(entorno):
    """Un numero que no cuadra con la lista de debajo es peor que no ponerlo."""
    http, _, _ = entorno
    await _publicar(http, "Una de #python")
    condenada = await _publicar(http, "Otra de #python")

    borrado = await http.delete(f"{POSTS}/{condenada['id']}")
    assert borrado.status_code == 204

    detalle = await http.get(f"{HASHTAGS}/python")
    assert detalle.json()["posts_count"] == 1

    listado = await http.get(f"{HASHTAGS}/python/posts")
    assert len(listado.json()) == 1


@pytest.mark.asyncio
async def test_una_etiqueta_que_nadie_uso_dice_cero_y_no_es_un_404(entorno):
    """Un 404 haria pensar que la ruta esta mal escrita."""
    http, _, _ = entorno
    respuesta = await http.get(f"{HASHTAGS}/inexistente")
    assert respuesta.status_code == 200
    assert respuesta.json()["posts_count"] == 0


@pytest.mark.asyncio
async def test_la_url_en_mayusculas_encuentra_la_misma_etiqueta(entorno):
    """Quien entre a /hashtag/PYTHON tiene que ver las de #python."""
    http, _, _ = entorno
    await _publicar(http, "Una de #python")
    respuesta = await http.get(f"{HASHTAGS}/PYTHON")
    assert respuesta.json()["tag"] == "python"
    assert respuesta.json()["posts_count"] == 1


# --------------------------------------------------------------------------- #
# Buscar por etiqueta
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_listado_devuelve_las_publicaciones_de_la_etiqueta(entorno):
    http, _, _ = entorno
    suya = await _publicar(http, "Esta si, de #python")
    await _publicar(http, "Esta no, de #cocina")

    respuesta = await http.get(f"{HASHTAGS}/python/posts")
    assert respuesta.status_code == 200
    cuerpo = respuesta.json()
    assert [p["id"] for p in cuerpo] == [suya["id"]]


@pytest.mark.asyncio
async def test_el_listado_viene_de_la_mas_nueva_a_la_mas_vieja(entorno):
    """La mas nueva delante: esto es un feed, no un archivo historico.

    LAS FECHAS SE PONEN A MANO, y hace falta. Contra SQLite dos publicaciones
    creadas en la misma prueba comparten `created_at` al milisegundo, y con
    empate manda el desempate por id, que es un UUID aleatorio. Publicar dos
    veces seguidas y esperar un orden concreto seria comprobar el azar: la
    prueba pasaria o fallaria segun que UUID toco.

    Contra PostgreSQL no pasa —dos peticiones distintas traen instantes
    distintos— pero la prueba tiene que comprobar el ORDEN POR FECHA, que es la
    regla, y no el desempate, que solo existe para que paginar no repita filas.
    """
    http, sesiones, _ = entorno
    primera = await _publicar(http, "Primera de #python")
    segunda = await _publicar(http, "Segunda de #python")

    async with sesiones() as db:
        await db.execute(
            update(Post)
            .where(Post.id == primera["id"])
            .values(created_at=datetime(2026, 1, 1, tzinfo=timezone.utc))
        )
        await db.execute(
            update(Post)
            .where(Post.id == segunda["id"])
            .values(created_at=datetime(2026, 6, 1, tzinfo=timezone.utc))
        )
        await db.commit()

    ids = [p["id"] for p in (await http.get(f"{HASHTAGS}/python/posts")).json()]
    assert ids == [segunda["id"], primera["id"]]


@pytest.mark.asyncio
async def test_el_listado_se_pagina(entorno):
    http, _, _ = entorno
    for i in range(5):
        await _publicar(http, f"Numero {i} de #python")

    primera = await http.get(f"{HASHTAGS}/python/posts?limit=2&offset=0")
    segunda = await http.get(f"{HASHTAGS}/python/posts?limit=2&offset=2")
    assert len(primera.json()) == 2
    assert len(segunda.json()) == 2
    # Sin solapes: si la paginacion se descuadrara, se repetirian publicaciones.
    assert not {p["id"] for p in primera.json()} & {p["id"] for p in segunda.json()}


@pytest.mark.asyncio
async def test_buscar_etiquetas_por_prefijo(entorno):
    """Quien escribe «pyt» busca «#python», no «#micropython»."""
    http, _, _ = entorno
    await _publicar(http, "De #python")
    await _publicar(http, "De #micropython")

    encontradas = (await http.get(f"{HASHTAGS}/search?q=pyt")).json()
    assert [h["tag"] for h in encontradas] == ["python"]


@pytest.mark.asyncio
async def test_buscar_ordena_por_uso(entorno):
    """Una etiqueta con tres publicaciones es mas util que una con una."""
    http, _, _ = entorno
    await _publicar(http, "De #casa")
    await _publicar(http, "De #casita")
    await _publicar(http, "Otra de #casita")

    encontradas = (await http.get(f"{HASHTAGS}/search?q=cas")).json()
    assert [h["tag"] for h in encontradas] == ["casita", "casa"]


@pytest.mark.asyncio
async def test_buscar_con_acento_encuentra_lo_escrito_sin_acento(entorno):
    http, _, _ = entorno
    await _publicar(http, "De #programacion")
    encontradas = (await http.get(f"{HASHTAGS}/search?q=programación")).json()
    assert [h["tag"] for h in encontradas] == ["programacion"]


# --------------------------------------------------------------------------- #
# Editar
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_editar_el_texto_cambia_las_etiquetas(entorno):
    """Quitar una almohadilla tiene que quitar la etiqueta.

    Si no, la publicacion seguiria apareciendo en una busqueda por una palabra
    que ya no dice.
    """
    http, _, _ = entorno
    publicacion = await _publicar(http, "Antes era de #python")

    editada = await http.patch(
        f"{POSTS}/{publicacion['id']}", json={"body": "Ahora es de #cocina"}
    )
    assert editada.status_code == 200
    assert editada.json()["hashtags"] == ["cocina"]

    assert (await http.get(f"{HASHTAGS}/python")).json()["posts_count"] == 0
    assert (await http.get(f"{HASHTAGS}/cocina")).json()["posts_count"] == 1


@pytest.mark.asyncio
async def test_editar_sin_tocar_el_texto_deja_las_etiquetas(entorno):
    """No hay nada que recalcular: el texto es su unica fuente."""
    http, _, _ = entorno
    publicacion = await _publicar(http, "De #python")

    editada = await http.patch(
        f"{POSTS}/{publicacion['id']}", json={"visibility": "followers"}
    )
    assert editada.status_code == 200
    assert editada.json()["hashtags"] == ["python"]


# --------------------------------------------------------------------------- #
# El feed las devuelve
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_feed_devuelve_las_etiquetas_de_cada_publicacion(entorno):
    http, _, _ = entorno
    await _publicar(http, "Una de #python")

    feed = (await http.get(f"{POSTS}?limit=10")).json()
    assert feed[0]["hashtags"] == ["python"]


@pytest.mark.asyncio
async def test_el_detalle_devuelve_las_etiquetas(entorno):
    http, _, _ = entorno
    publicacion = await _publicar(http, "Una de #python")

    detalle = (await http.get(f"{POSTS}/{publicacion['id']}")).json()
    assert detalle["hashtags"] == ["python"]


@pytest.mark.asyncio
async def test_el_tope_por_publicacion_se_aplica_al_guardar(entorno):
    """Y publicar NO falla: se indexan las diez primeras y el texto se guarda entero."""
    http, sesiones, _ = entorno
    texto = " ".join(f"#e{i}" for i in range(18))
    publicacion = await _publicar(http, texto)

    assert len(publicacion["hashtags"]) == 10
    # El texto no se toca: no se pierde nada de lo que la persona escribio.
    assert publicacion["body"] == texto

    async with sesiones() as db:
        cuantas = await db.scalar(
            select(func.count())
            .select_from(PostHashtag)
            .where(PostHashtag.post_id == publicacion["id"])
        )
    assert cuantas == 10
