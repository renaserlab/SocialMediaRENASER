"""La aplicacion tiene que funcionar SIN la migracion 0032.

Misma leccion que la 0027, la 0028, la 0029 y la 0031, y por el mismo motivo:
desplegar codigo no puede exigir que una migracion concreta ya este puesta. La
0032 espera aprobacion humana y HOY NO ESTA APLICADA en produccion, asi que
esto no es una hipotesis: es el estado real contra el que se va a desplegar.

QUE CAMBIA SIN LA 0032:

- Publicar funciona IGUAL, incluso mandando gente etiquetada. La publicacion
  sale; simplemente no queda etiquetado nadie.
- No sale NINGUNA notificacion de mencion. Y esto es lo importante de verdad:
  avisar de una mencion que no llego a guardarse seria mentir a quien recibe el
  aviso, que abriria la publicacion y no se encontraria por ningun lado.
- Buscar a quien etiquetar SIGUE funcionando: buscar personas no depende de
  esta tabla. Lo que no se puede es guardar el resultado.

COMO SE COMPRUEBA. Se crea el esquema entero y despues se QUITA la tabla que
anade la 0032, dejando la base exactamente como esta hoy produccion.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.notifications.models import Notification
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

POSTS = "/api/v1/posts"
CANDIDATOS = "/api/v1/mentions/candidates"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"


@pytest_asyncio.fixture
async def base_sin_0032():
    """El esquema tal y como esta HOY en produccion: sin `post_mentions`."""
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

        # Y ahora se DESHACE la 0032, que es lo que se quiere probar.
        await conn.execute(text("drop table post_mentions"))

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
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
        yield http, sesiones
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    await engine.dispose()
    # Que la siguiente prueba no herede «no hay tabla de menciones».
    esquema.olvidar()


@pytest.mark.asyncio
async def test_publicar_etiquetando_a_alguien_sigue_funcionando(base_sin_0032):
    """LO MAS IMPORTANTE DE ESTE FICHERO.

    Si esto fallara, un movil ya actualizado que mandara el campo nuevo dejaria
    a la persona sin poder publicar hasta que se aprobara la migracion.
    """
    http, _ = base_sin_0032
    respuesta = await http.post(
        POSTS, json={"body": "Con el equipo", "mentioned_user_ids": [BRUNO]}
    )
    assert respuesta.status_code == 201, respuesta.text


@pytest.mark.asyncio
async def test_no_se_etiqueta_a_nadie(base_sin_0032):
    http, _ = base_sin_0032
    respuesta = await http.post(
        POSTS, json={"body": "Con el equipo", "mentioned_user_ids": [BRUNO]}
    )
    assert respuesta.json()["mentions"] == []


@pytest.mark.asyncio
async def test_no_se_manda_NINGUNA_notificacion(base_sin_0032):
    """Avisar de una mencion que no se guardo seria mentir a quien lo recibe.

    Abriria la publicacion y no se encontraria etiquetado por ningun lado.
    """
    http, sesiones = base_sin_0032
    await http.post(
        POSTS, json={"body": "Con el equipo", "mentioned_user_ids": [BRUNO]}
    )
    async with sesiones() as db:
        cuantas = await db.scalar(
            select(func.count())
            .select_from(Notification)
            .where(Notification.type == "post_mention")
        )
    assert cuantas == 0


@pytest.mark.asyncio
async def test_editar_etiquetando_no_revienta(base_sin_0032):
    http, _ = base_sin_0032
    creada = await http.post(POSTS, json={"body": "Con el equipo"})
    respuesta = await http.patch(
        f"{POSTS}/{creada.json()['id']}", json={"mentioned_user_ids": [BRUNO]}
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["mentions"] == []


@pytest.mark.asyncio
async def test_el_feed_no_revienta(base_sin_0032):
    http, _ = base_sin_0032
    await http.post(
        POSTS, json={"body": "Con el equipo", "mentioned_user_ids": [BRUNO]}
    )
    respuesta = await http.get(f"{POSTS}?limit=10")
    assert respuesta.status_code == 200
    assert respuesta.json()[0]["mentions"] == []


@pytest.mark.asyncio
async def test_el_detalle_no_revienta(base_sin_0032):
    http, _ = base_sin_0032
    creada = await http.post(POSTS, json={"body": "Con el equipo"})
    respuesta = await http.get(f"{POSTS}/{creada.json()['id']}")
    assert respuesta.status_code == 200
    assert respuesta.json()["mentions"] == []


@pytest.mark.asyncio
async def test_buscar_a_quien_etiquetar_SIGUE_funcionando(base_sin_0032):
    """Buscar personas no depende de esta tabla.

    Se comprueba a proposito: apagar de mas es tan malo como apagar de menos, y
    dejar la busqueda vacia haria pensar que no hay nadie en la aplicacion.
    """
    http, _ = base_sin_0032
    respuesta = await http.get(f"{CANDIDATOS}?q=bruno")
    assert respuesta.status_code == 200
    assert [p["id"] for p in respuesta.json()] == [BRUNO]
