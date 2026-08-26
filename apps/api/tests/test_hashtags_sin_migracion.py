"""La aplicacion tiene que funcionar SIN la migracion 0031.

POR QUE ESTA PRUEBA EXISTE, Y ES LA MISMA LECCION QUE LA 0027, LA 0028 Y LA
0029. Se escribio el codigo de la V1.1 contra un esquema que todavia no estaba
aplicado y la rama entera dejo de funcionar contra la base real: cada peticion
que tocaba `post_topics` reventaba con un 500 que el navegador reportaba como
error de CORS, porque Starlette no anade cabeceras CORS a una excepcion sin
capturar. Horas buscando en el sitio equivocado.

La regla del proyecto: desplegar codigo no puede exigir que una migracion
concreta ya este puesta. La 0031 espera aprobacion humana y HOY NO ESTA
APLICADA en produccion, asi que esto no es una hipotesis: es el estado real
contra el que se va a desplegar.

QUE CAMBIA SIN LA 0031:

- Publicar funciona IGUAL. El texto se guarda tal cual, con sus almohadillas
  visibles, porque las almohadillas son parte de lo que la persona escribio.
  Lo unico que no ocurre es el indexado.
- Cada publicacion responde con `hashtags` vacio. No es un error: es que no hay
  ninguna etiqueta, que es exactamente la verdad.
- Buscar etiquetas responde vacio, y una etiqueta concreta dice cero
  publicaciones. Ni 404 ni 503: la pantalla ya sabe decir «todavia no hay nada».
- Editar sigue funcionando, incluso cambiando el texto.

COMO SE COMPRUEBA. Se crea el esquema entero y despues se QUITAN las dos tablas
que anade la 0031, dejando la base exactamente como esta hoy produccion.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

POSTS = "/api/v1/posts"
HASHTAGS = "/api/v1/hashtags"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"


@pytest_asyncio.fixture
async def base_sin_0031():
    """El esquema tal y como esta HOY en produccion: sin tablas de etiquetas."""
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

        # Y ahora se DESHACE la 0031, que es lo que se quiere probar. Primero la
        # que depende de la otra, para no dejar referencias colgando.
        await conn.execute(text("drop table post_hashtags"))
        await conn.execute(text("drop table hashtags"))

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=ANA, email="ana@ejemplo.com", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    await engine.dispose()
    # Que la siguiente prueba no herede «no hay tablas de etiquetas».
    esquema.olvidar()


@pytest.mark.asyncio
async def test_publicar_con_almohadillas_sigue_funcionando(base_sin_0031):
    """LO MAS IMPORTANTE DE ESTE FICHERO.

    Si esto fallara, nadie podria publicar nada que llevase una almohadilla
    hasta que un humano aprobara la migracion. Un adorno no puede impedir
    publicar.
    """
    respuesta = await base_sin_0031.post(POSTS, json={"body": "Aprendiendo #Python"})
    assert respuesta.status_code == 201, respuesta.text


@pytest.mark.asyncio
async def test_el_texto_se_guarda_entero_con_sus_almohadillas(base_sin_0031):
    """No se indexa, pero no se pierde ni un caracter de lo que se escribio."""
    respuesta = await base_sin_0031.post(POSTS, json={"body": "Sobre #Python y #IA"})
    assert respuesta.json()["body"] == "Sobre #Python y #IA"


@pytest.mark.asyncio
async def test_la_publicacion_responde_sin_etiquetas(base_sin_0031):
    respuesta = await base_sin_0031.post(POSTS, json={"body": "Sobre #Python"})
    assert respuesta.json()["hashtags"] == []


@pytest.mark.asyncio
async def test_el_feed_no_revienta(base_sin_0031):
    await base_sin_0031.post(POSTS, json={"body": "Sobre #Python"})
    respuesta = await base_sin_0031.get(f"{POSTS}?limit=10")
    assert respuesta.status_code == 200
    assert respuesta.json()[0]["hashtags"] == []


@pytest.mark.asyncio
async def test_el_detalle_no_revienta(base_sin_0031):
    creada = await base_sin_0031.post(POSTS, json={"body": "Sobre #Python"})
    respuesta = await base_sin_0031.get(f"{POSTS}/{creada.json()['id']}")
    assert respuesta.status_code == 200
    assert respuesta.json()["hashtags"] == []


@pytest.mark.asyncio
async def test_editar_el_texto_no_revienta(base_sin_0031):
    """Editar dispara la re-extraccion de etiquetas; sin tablas, no hace nada."""
    creada = await base_sin_0031.post(POSTS, json={"body": "Antes de #python"})
    respuesta = await base_sin_0031.patch(
        f"{POSTS}/{creada.json()['id']}", json={"body": "Ahora de #cocina"}
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["hashtags"] == []


@pytest.mark.asyncio
async def test_buscar_etiquetas_responde_vacio(base_sin_0031):
    respuesta = await base_sin_0031.get(f"{HASHTAGS}/search?q=pyt")
    assert respuesta.status_code == 200
    assert respuesta.json() == []


@pytest.mark.asyncio
async def test_una_etiqueta_concreta_dice_cero_y_no_falla(base_sin_0031):
    """Cero publicaciones y no un 404: la ruta esta bien, no hay contenido."""
    respuesta = await base_sin_0031.get(f"{HASHTAGS}/python")
    assert respuesta.status_code == 200
    assert respuesta.json()["posts_count"] == 0


@pytest.mark.asyncio
async def test_el_listado_de_una_etiqueta_responde_vacio(base_sin_0031):
    respuesta = await base_sin_0031.get(f"{HASHTAGS}/python/posts")
    assert respuesta.status_code == 200
    assert respuesta.json() == []


@pytest.mark.asyncio
async def test_borrar_una_publicacion_sigue_funcionando(base_sin_0031):
    creada = await base_sin_0031.post(POSTS, json={"body": "Sobre #python"})
    respuesta = await base_sin_0031.delete(f"{POSTS}/{creada.json()['id']}")
    assert respuesta.status_code == 204
