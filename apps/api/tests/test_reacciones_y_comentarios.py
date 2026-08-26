"""Dar «me gusta» y comentar. Las dos acciones mas usadas de Z, sin una prueba.

POR QUE EXISTE ESTE FICHERO. Las dos rutas leian `current_user.full_name` para
poner el nombre en el aviso, y `AuthUser` NO tiene ese campo: solo `id`,
`email`, `role` y `claims`. La identidad sale del token, y el token no lleva el
nombre del perfil.

Lo que hacia que no se viera:

  1. El error salta DESPUES del `commit`. El «me gusta» se guardaba de verdad,
     asi que al recargar estaba ahi y parecia un fallo pasajero de la red.
  2. Starlette no pone cabeceras CORS en las excepciones sin capturar, asi que
     el navegador no enseña «error 500» sino un error de CORS, que manda a
     mirar la configuracion del servidor en vez del codigo.
  3. Ninguna prueba llamaba a estos dos endpoints.

Las tres cosas juntas son la receta de un fallo que sobrevive meses. Estas
pruebas cierran la tercera.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

POSTS = "/api/v1/posts"

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
        return AuthUser(
            id=identidad["uid"], email="quien@ejemplo.com", role="authenticated"
        )

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    await engine.dispose()


async def _publicacion_de_bruno(http: AsyncClient, identidad: dict) -> str:
    """Publica Bruno. El aviso solo existe si quien reacciona es OTRO."""
    identidad["uid"] = BRUNO
    respuesta = await http.post(POSTS, json={"body": "Algo que contar"})
    assert respuesta.status_code == 201, respuesta.text
    identidad["uid"] = ANA
    return respuesta.json()["id"]


@pytest.mark.asyncio
async def test_dar_me_gusta_a_la_publicacion_de_otro_no_revienta(entorno):
    """El caso exacto que fallaba: hay a quien avisar, asi que se pide el nombre."""
    http, _, identidad = entorno
    post_id = await _publicacion_de_bruno(http, identidad)

    respuesta = await http.post(f"{POSTS}/{post_id}/like")

    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["liked"] is True
    assert respuesta.json()["likes_count"] == 1


@pytest.mark.asyncio
async def test_comentar_la_publicacion_de_otro_no_revienta(entorno):
    http, _, identidad = entorno
    post_id = await _publicacion_de_bruno(http, identidad)

    respuesta = await http.post(
        f"{POSTS}/{post_id}/comments", json={"body": "Muy bueno"}
    )

    assert respuesta.status_code in (200, 201), respuesta.text
    assert respuesta.json()["body"] == "Muy bueno"


@pytest.mark.asyncio
async def test_quitar_el_me_gusta_y_volver_a_darlo(entorno):
    """Repetir la accion tampoco puede fallar: es lo que hace la gente."""
    http, _, identidad = entorno
    post_id = await _publicacion_de_bruno(http, identidad)

    assert (await http.post(f"{POSTS}/{post_id}/like")).status_code == 200
    assert (await http.delete(f"{POSTS}/{post_id}/like")).status_code == 200
    otra_vez = await http.post(f"{POSTS}/{post_id}/like")
    assert otra_vez.status_code == 200, otra_vez.text
    assert otra_vez.json()["likes_count"] == 1


@pytest.mark.asyncio
async def test_darse_me_gusta_a_uno_mismo_tampoco_revienta(entorno):
    """Sin aviso que mandar, pero la ruta es la misma y tiene que responder."""
    http, _, _ = entorno
    creada = await http.post(POSTS, json={"body": "Lo mio"})
    post_id = creada.json()["id"]

    respuesta = await http.post(f"{POSTS}/{post_id}/like")
    assert respuesta.status_code == 200, respuesta.text
