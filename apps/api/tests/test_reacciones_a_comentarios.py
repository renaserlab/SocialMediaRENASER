"""Reaccionar a un COMENTARIO (migracion 0048).

DOS MITADES, Y LA SEGUNDA ES LA QUE IMPORTA. La primera comprueba que con la
tabla puesta la cosa funciona. La segunda comprueba que SIN ella la aplicacion
sigue en pie: la 0048 esta escrita y sin aplicar, asi que hoy —y hasta que se
apruebe— la base real es la del segundo bloque.

Es la leccion de `recommendations/esquema.py`: desplegar codigo no puede exigir
que una migracion concreta ya este puesta. Cuando falto esa comprobacion, cada
peticion reventaba con un 500 que el navegador reportaba como error de CORS.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.content import router as content_router
from app.modules.content.models import CommentLike
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

POSTS = "/api/v1/posts"
COMENTARIOS = "/api/v1/comments"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"


async def _montar(con_la_0048: bool):
    """La misma base, con la tabla de la 0048 o sin ella."""
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

        tablas = list(Base.metadata.sorted_tables)
        if not con_la_0048:
            # Exactamente la base de hoy: todo menos lo que trae la 0048.
            tablas = [t for t in tablas if t.name != CommentLike.__tablename__]
        await conn.run_sync(Base.metadata.create_all, tables=tablas)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        await db.commit()
    return engine, sesiones


@pytest_asyncio.fixture
async def con_migracion():
    async for entorno in _entorno(True):
        yield entorno


@pytest_asyncio.fixture
async def sin_migracion():
    async for entorno in _entorno(False):
        yield entorno


async def _entorno(con_la_0048: bool):
    engine, sesiones = await _montar(con_la_0048)
    identidad = {"uid": ANA}

    async def _db_override():
        async with sesiones() as session:
            yield session

    async def _usuario_override() -> AuthUser:
        return AuthUser(
            id=identidad["uid"], email="quien@ejemplo.com", role="authenticated"
        )

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    # Leer comentarios NO pide sesion, pero saber a cuales reaccionaste si:
    # sin este override quien mira seria siempre anonimo y `viewer_reacted`
    # saldria false pasara lo que pasara, o sea la prueba no probaria nada.
    app.dependency_overrides[get_optional_user] = _usuario_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, identidad
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    await engine.dispose()


@pytest.fixture
def avisos(monkeypatch):
    """Retiene los push en vez de mandarlos. Igual que en reacciones y comentarios."""
    capturados: list[dict] = []

    def _retener(background, **kwargs):
        capturados.append(kwargs)

    monkeypatch.setattr(content_router, "encolar_push", _retener)
    return capturados


async def _comentario_de_bruno(http: AsyncClient, identidad: dict) -> tuple[str, str]:
    """Publica y comenta Bruno; despues vuelve a mandar Ana."""
    identidad["uid"] = BRUNO
    post_id = (await http.post(POSTS, json={"body": "Algo"})).json()["id"]
    respuesta = await http.post(f"{POSTS}/{post_id}/comments", json={"body": "Digo yo"})
    assert respuesta.status_code == 201, respuesta.text
    identidad["uid"] = ANA
    return post_id, respuesta.json()["id"]


# --------------------------------------------------------------------------- #
# Con la 0048 aplicada
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_reaccionar_a_un_comentario(con_migracion):
    http, identidad = con_migracion
    _, comment_id = await _comentario_de_bruno(http, identidad)

    respuesta = await http.post(f"{COMENTARIOS}/{comment_id}/like")

    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json() == {"reacted": True, "likes_count": 1}


@pytest.mark.asyncio
async def test_reaccionar_dos_veces_deja_una_sola_reaccion(con_migracion):
    """Idempotente: un reintento de la red no puede contar dos veces."""
    http, identidad = con_migracion
    _, comment_id = await _comentario_de_bruno(http, identidad)

    await http.post(f"{COMENTARIOS}/{comment_id}/like")
    segunda = await http.post(f"{COMENTARIOS}/{comment_id}/like")

    assert segunda.json()["likes_count"] == 1


@pytest.mark.asyncio
async def test_quitar_la_reaccion_y_volver_a_ponerla(con_migracion):
    http, identidad = con_migracion
    _, comment_id = await _comentario_de_bruno(http, identidad)

    await http.post(f"{COMENTARIOS}/{comment_id}/like")
    quitada = await http.delete(f"{COMENTARIOS}/{comment_id}/like")
    assert quitada.json() == {"reacted": False, "likes_count": 0}

    otra_vez = await http.post(f"{COMENTARIOS}/{comment_id}/like")
    assert otra_vez.json()["likes_count"] == 1


@pytest.mark.asyncio
async def test_el_comentario_llega_con_su_contador_y_si_tu_reaccionaste(con_migracion):
    """En el propio comentario: una peticion por fila serian veinte por pagina."""
    http, identidad = con_migracion
    post_id, comment_id = await _comentario_de_bruno(http, identidad)
    await http.post(f"{COMENTARIOS}/{comment_id}/like")

    lista = (await http.get(f"{POSTS}/{post_id}/comments")).json()

    assert lista[0]["likes_count"] == 1
    assert lista[0]["viewer_reacted"] is True


@pytest.mark.asyncio
async def test_la_reaccion_de_otro_cuenta_pero_no_sale_marcada(con_migracion):
    """`viewer_reacted` es de QUIEN MIRA, no «alguien reacciono»."""
    http, identidad = con_migracion
    post_id, comment_id = await _comentario_de_bruno(http, identidad)
    await http.post(f"{COMENTARIOS}/{comment_id}/like")

    identidad["uid"] = BRUNO
    lista = (await http.get(f"{POSTS}/{post_id}/comments")).json()

    assert lista[0]["likes_count"] == 1
    assert lista[0]["viewer_reacted"] is False


@pytest.mark.asyncio
async def test_reaccionar_a_un_comentario_que_no_existe(con_migracion):
    http, _ = con_migracion

    respuesta = await http.post(
        f"{COMENTARIOS}/aaaaaaaa-0000-0000-0000-00000000dead/like"
    )

    assert respuesta.status_code == 404, respuesta.text


@pytest.mark.asyncio
async def test_avisa_al_autor_del_comentario(con_migracion, avisos):
    http, identidad = con_migracion
    _, comment_id = await _comentario_de_bruno(http, identidad)
    avisos.clear()

    await http.post(f"{COMENTARIOS}/{comment_id}/like")

    assert len(avisos) == 1, avisos
    assert avisos[0]["notification_type"] == "comment_like"
    assert avisos[0]["user_ids"] == [BRUNO]
    assert avisos[0]["actor_name"] == "Ana"


@pytest.mark.asyncio
async def test_reaccionar_a_lo_propio_no_avisa(con_migracion, avisos):
    http, _ = con_migracion
    post_id = (await http.post(POSTS, json={"body": "Lo mio"})).json()["id"]
    comment_id = (
        await http.post(f"{POSTS}/{post_id}/comments", json={"body": "Y me comento"})
    ).json()["id"]
    avisos.clear()

    respuesta = await http.post(f"{COMENTARIOS}/{comment_id}/like")

    assert respuesta.status_code == 200
    assert avisos == []


@pytest.mark.asyncio
async def test_quitar_y_volver_a_reaccionar_no_avisa_dos_veces(con_migracion, avisos):
    """El fallo que ya se arreglo en el «me gusta» de una publicacion.

    Al retirar la reaccion la fila desaparece, asi que el `if` de «es la primera
    vez» volvia a decir que si. Sin idempotencia en el aviso, cada vaiven ponia
    otra fila en la bandeja y hacia sonar otro telefono.
    """
    http, identidad = con_migracion
    _, comment_id = await _comentario_de_bruno(http, identidad)
    avisos.clear()

    await http.post(f"{COMENTARIOS}/{comment_id}/like")
    await http.delete(f"{COMENTARIOS}/{comment_id}/like")
    await http.post(f"{COMENTARIOS}/{comment_id}/like")

    assert len(avisos) == 1, avisos


@pytest.mark.asyncio
async def test_dos_comentarios_del_mismo_hilo_avisan_por_separado(
    con_migracion, avisos
):
    """La clave de deduplicacion es el COMENTARIO, no la publicacion.

    Con el id de la publicacion en `entity_id`, reaccionar al segundo comentario
    contaria como «el mismo aviso» y su autor no se enteraria.
    """
    http, identidad = con_migracion
    identidad["uid"] = BRUNO
    post_id = (await http.post(POSTS, json={"body": "Algo"})).json()["id"]
    uno = (
        await http.post(f"{POSTS}/{post_id}/comments", json={"body": "Primero"})
    ).json()["id"]
    dos = (
        await http.post(f"{POSTS}/{post_id}/comments", json={"body": "Segundo"})
    ).json()["id"]
    identidad["uid"] = ANA
    avisos.clear()

    await http.post(f"{COMENTARIOS}/{uno}/like")
    await http.post(f"{COMENTARIOS}/{dos}/like")

    assert len(avisos) == 2, avisos


# --------------------------------------------------------------------------- #
# SIN la 0048 — que es la base de hoy
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_sin_la_migracion_los_comentarios_se_siguen_leyendo(sin_migracion):
    """Lo que NO puede pasar: que la lista entera reviente por una tabla que falta."""
    http, identidad = sin_migracion
    post_id, _ = await _comentario_de_bruno(http, identidad)

    respuesta = await http.get(f"{POSTS}/{post_id}/comments")

    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()[0]["likes_count"] == 0
    assert respuesta.json()[0]["viewer_reacted"] is False


@pytest.mark.asyncio
async def test_sin_la_migracion_reaccionar_responde_404_y_no_500(sin_migracion):
    """404 y no 500: un 500 sale sin cabeceras CORS y parece un fallo de red."""
    http, identidad = sin_migracion
    _, comment_id = await _comentario_de_bruno(http, identidad)

    assert (await http.post(f"{COMENTARIOS}/{comment_id}/like")).status_code == 404
    assert (await http.delete(f"{COMENTARIOS}/{comment_id}/like")).status_code == 404


@pytest.mark.asyncio
async def test_sin_la_migracion_se_sigue_pudiendo_comentar_y_responder(sin_migracion):
    """Las respuestas son de la 0001, no de la 0048: no dependen de ella."""
    http, identidad = sin_migracion
    post_id, comment_id = await _comentario_de_bruno(http, identidad)

    respuesta = await http.post(
        f"{POSTS}/{post_id}/comments",
        json={"body": "Te respondo", "parent_id": comment_id},
    )

    assert respuesta.status_code == 201, respuesta.text
    assert respuesta.json()["parent_id"] == comment_id
