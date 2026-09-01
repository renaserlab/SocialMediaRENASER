"""La fila de historias enseñaba las de TODO EL MUNDO, bloqueados incluidos.

POR QUÉ EXISTE ESTE FICHERO. `GET /stories` era, literalmente, «todas las
historias vigentes»:

    select(Story, Profile).join(...).where(Story.expires_at > now)

Sin mirar quién las publicó. De ahí salían tres cosas, y la segunda es grave:

  1. **No se podía limitar.** Con mil personas publicando se traía las mil. Está
     medido en `docs/Z_MEDICION_MENSAJES_EXPLORE.md`: 534 KB con quinientos
     autores.
  2. **Las historias de alguien a quien bloqueaste se veían.** La API lee con
     identidad de servicio, que **se salta la RLS**, así que la política de la
     tabla no salvaba esto. El corte tiene que estar en la consulta, como en el
     muro, y en los dos sentidos.
  3. No sabía distinguir «de quien sigo», que es justo lo que necesita la
     bandeja de mensajes.

Lo que NO cambia, y por eso hay pruebas que lo fijan: sin pedir nada, el
endpoint sigue devolviendo lo de siempre. Una versión ya instalada no puede
cambiar de comportamiento porque el servidor aprenda a filtrar.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.profiles.models import Profile
from app.modules.social_graph.models import Follow, UserBlock
from app.modules.stories.models import Story
from app.shared.database import Base, get_db

HISTORIAS = "/api/v1/stories"

#: Quien mira la fila.
ANA = str(uuid4())
#: A quien sigue.
BETO = str(uuid4())
#: A quien NO sigue y no ha bloqueado.
CARLA = str(uuid4())
#: A quien Ana bloqueó.
DIEGO = str(uuid4())
#: Quien bloqueó a Ana. El corte tiene que valer también en este sentido.
ELENA = str(uuid4())


@pytest_asyncio.fixture
async def entorno():
    """Cinco personas con historia vigente, y Ana mirando.

    `stories.expires_at` lo rellena la BASE en producción (`now() + 24 h`, de la
    0003) y el modelo lo deja a propósito sin valor por defecto de aplicación.
    SQLite no tiene ese default, así que aquí se emula con un listener y se
    quita al terminar: sin él, insertar fallaría por NOT NULL y la prueba
    estaría midiendo la carencia de SQLite, no el endpoint.
    """

    def _caducidad(_mapper, _connection, target) -> None:
        if target.expires_at is None:
            target.expires_at = datetime.now(timezone.utc) + timedelta(hours=24)

    event.listen(Story, "before_insert", _caducidad)

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
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
        for uid, nombre in (
            (ANA, "ana"),
            (BETO, "beto"),
            (CARLA, "carla"),
            (DIEGO, "diego"),
            (ELENA, "elena"),
        ):
            db.add(Profile(id=uid, full_name=nombre.capitalize(), username=nombre))
            db.add(
                Story(
                    author_id=uid,
                    storage_path=f"{uid}/historia.jpg",
                    media_type="image",
                    duration_ms=5000,
                )
            )
        db.add(Follow(follower_id=ANA, following_id=BETO))
        db.add(UserBlock(blocker_id=ANA, blocked_id=DIEGO))
        # En el otro sentido: Elena bloqueó a Ana.
        db.add(UserBlock(blocker_id=ELENA, blocked_id=ANA))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    app.dependency_overrides[get_db] = _db_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones
    app.dependency_overrides.clear()
    event.remove(Story, "before_insert", _caducidad)
    await engine.dispose()


def _como(uid: str) -> None:
    usuario = AuthUser(id=uid, email=f"{uid}@ejemplo.com", role="authenticated")
    app.dependency_overrides[get_current_user] = lambda: usuario
    app.dependency_overrides[get_optional_user] = lambda: usuario


async def _autores(http: AsyncClient, consulta: str = "") -> set[str]:
    respuesta = await http.get(f"{HISTORIAS}{consulta}")
    assert respuesta.status_code == 200, respuesta.text
    return {grupo["author"]["username"] for grupo in respuesta.json()}


# --------------------------------------------------------------------------- #
# 1. Los bloqueos. Es la parte que era un fallo, no una mejora.
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_no_se_ven_las_historias_de_quien_bloqueaste(entorno):
    http, _ = entorno
    _como(ANA)

    assert "diego" not in await _autores(http)


@pytest.mark.asyncio
async def test_tampoco_las_de_quien_te_bloqueo_a_ti(entorno):
    """El corte va en los dos sentidos.

    Con uno solo bastaría con no bloquear de vuelta para seguir apareciendo en
    la fila de quien te bloqueó. Es el mismo razonamiento del muro.
    """
    http, _ = entorno
    _como(ANA)

    assert "elena" not in await _autores(http)


@pytest.mark.asyncio
async def test_el_bloqueo_no_esconde_a_quien_no_tiene_nada_que_ver(entorno):
    """Que el filtro no se pase de largo: Carla no está bloqueada."""
    http, _ = entorno
    _como(ANA)

    assert {"ana", "beto", "carla"} <= await _autores(http)


# --------------------------------------------------------------------------- #
# 2. «De quien sigo», que es lo que necesita la bandeja
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_pidiendo_following_solo_llegan_los_seguidos(entorno):
    http, _ = entorno
    _como(ANA)

    assert await _autores(http, "?feed=following") == {"ana", "beto"}


@pytest.mark.asyncio
async def test_las_propias_entran_aunque_no_te_sigas_a_ti_mismo(entorno):
    """Nadie se sigue a sí mismo, y la primera burbuja de la fila es la tuya.

    Sin esta excepción, `feed=following` dejaría fuera tus propias historias y
    con ellas el sitio desde donde se publica.
    """
    http, _ = entorno
    _como(ANA)

    assert "ana" in await _autores(http, "?feed=following")


@pytest.mark.asyncio
async def test_sin_pedir_nada_sigue_llegando_todo_lo_visible(entorno):
    """LA PRUEBA QUE PROTEGE A LAS VERSIONES YA INSTALADAS.

    `feed` es opcional y por omisión no filtra por seguimiento. Un binario que
    no sabe que este parámetro existe tiene que seguir viendo lo mismo que veía;
    lo único que cambia para él —y a mejor— es que ya no le llegan las historias
    de quien tiene bloqueado.
    """
    http, _ = entorno
    _como(ANA)

    assert await _autores(http) == {"ana", "beto", "carla"}


# --------------------------------------------------------------------------- #
# 3. El tope
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_tope_corta_por_autores_y_no_por_historias(entorno):
    """Cortar por historias partiría el último grupo por la mitad.

    Y eso no es un detalle: el visor avanza por los tramos de un grupo, así que
    un grupo truncado es una barra de progreso que cuenta tramos que no llegan.
    """
    http, _ = entorno
    _como(ANA)

    respuesta = await http.get(f"{HISTORIAS}?limit=1")

    grupos = respuesta.json()
    assert len(grupos) <= 2  # el limitado, más el propio que entra siempre
    for grupo in grupos:
        # Ningún grupo llega vacío ni a medias.
        assert len(grupo["items"]) >= 1


@pytest.mark.asyncio
async def test_las_propias_entran_aunque_el_tope_las_dejara_fuera(entorno):
    http, _ = entorno
    _como(ANA)

    assert "ana" in await _autores(http, "?limit=1")


@pytest.mark.asyncio
async def test_sin_sesion_no_revienta_y_no_filtra_por_nadie(entorno):
    """Sin sesión no hay a quién bloquear ni a quién seguir.

    El filtro tiene que quedarse quieto, no equivocarse de persona ni fallar.
    """
    http, _ = entorno
    app.dependency_overrides[get_optional_user] = lambda: None

    respuesta = await http.get(HISTORIAS)

    assert respuesta.status_code == 200, respuesta.text
    # Las cinco: sin sesión no se puede aplicar ningún corte personal.
    assert len(respuesta.json()) == 5
