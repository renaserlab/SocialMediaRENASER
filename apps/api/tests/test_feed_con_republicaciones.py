"""El muro mezcla lo publicado y lo republicado en un solo orden.

POR QUE EXISTE ESTE FICHERO. Republicar ya funcionaba: la tabla, el endpoint de
escritura y el contador del boton estaban puestos y probados. Lo que no existia
era un sitio donde MIRAR lo republicado: `/reposts` no lo llamaba nadie en toda
la aplicacion, asi que compartir algo era una accion sin consecuencia visible.

Aqui se prueba la mezcla, que es la parte que se puede romper de verdad:

  * el orden lo marca la fecha de la REPUBLICACION, no la del original;
  * la paginacion no se salta ni repite elementos al cruzar las dos corrientes;
  * los filtros del muro se aplican tambien por el camino nuevo;
  * los bloqueos cortan por las DOS personas que hay detras;
  * y nada de esto cambia el muro de quien no lo pide.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from urllib.parse import quote
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.content.models import Comment, Post, PostLike, PostMedia
from app.modules.content.reposts import PostRepost
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.modules.social_graph.models import Follow, UserBlock
from app.shared.database import Base, get_db

ANA = str(uuid4())  # publica
BETO = str(uuid4())  # republica
CARLA = str(uuid4())  # mira el muro

BASE = datetime(2026, 8, 1, 12, 0, 0, tzinfo=timezone.utc)


def _cuando(minutos: int) -> datetime:
    return BASE + timedelta(minutes=minutos)


@pytest_asyncio.fixture
async def entorno():
    """Muro con tres publicaciones de Ana y la tabla de la 0042 creada."""
    cache.vaciar()
    esquema.olvidar()

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        from app.modules.catalog import models as _c  # noqa: F401
        from app.modules.communities import models as _co  # noqa: F401
        from app.modules.learning import models as _l  # noqa: F401
        from app.modules.messaging import models as _m  # noqa: F401
        from app.modules.moderation import models as _mo  # noqa: F401
        from app.modules.notifications import device_tokens as _dt  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    ids: dict[str, str] = {}

    async with sesiones() as db:
        db.add_all(
            [
                Profile(id=ANA, full_name="Ana", username="ana"),
                Profile(id=BETO, full_name="Beto", username="beto"),
                Profile(id=CARLA, full_name="Carla", username="carla"),
            ]
        )
        # Minuto 0, 10 y 20. La mas nueva es "tres".
        for nombre, minuto in (("uno", 0), ("dos", 10), ("tres", 20)):
            post = Post(
                author_id=ANA,
                body=nombre,
                status="published",
                created_at=_cuando(minuto),
            )
            db.add(post)
            await db.flush()
            ids[nombre] = post.id
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    app.dependency_overrides[get_db] = _db_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, ids
    app.dependency_overrides.clear()
    await engine.dispose()


def _como(uid: str) -> None:
    usuario = AuthUser(id=uid, email=f"{uid}@ejemplo.com", role="authenticated")
    app.dependency_overrides[get_current_user] = lambda: usuario
    app.dependency_overrides[get_optional_user] = lambda: usuario


async def _republica(sesiones, quien: str, post_id: str, minuto: int) -> str:
    """Inserta la republicacion directamente: la fecha tiene que ser la nuestra.

    Por el endpoint la pondria `now()` y el orden dejaria de ser comprobable.
    """
    async with sesiones() as db:
        fila = PostRepost(
            author_id=quien, post_id=post_id, comentario="", created_at=_cuando(minuto)
        )
        db.add(fila)
        await db.commit()
        return fila.id


async def _muro(http: AsyncClient, **params) -> list[dict]:
    consulta = "&".join(f"{k}={v}" for k, v in params.items())
    respuesta = await http.get(f"/api/v1/posts?{consulta}")
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


# --------------------------------------------------------------------------- #
# 1. Quien no lo pide, no lo nota
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_pedirlo_el_muro_no_cambia(entorno):
    """El parametro esta apagado por defecto y este endpoint tiene cuatro usos.

    La galeria de un perfil, un circulo y el feed de video piden por aqui. En
    ninguno de los tres una republicacion significa lo mismo, asi que mezclarlas
    para todos habria cambiado tres pantallas sin que nadie lo pidiera.
    """
    http, sesiones, ids = entorno
    _como(CARLA)
    await _republica(sesiones, BETO, ids["uno"], minuto=90)

    cuerpos = [p["body"] for p in await _muro(http, limit=10)]

    assert cuerpos == ["tres", "dos", "uno"]
    assert all(p.get("repost") is None for p in await _muro(http, limit=10))


# --------------------------------------------------------------------------- #
# 2. Lo republicado aparece, y con su cabecera
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_republicacion_aparece_en_el_muro_con_quien_la_comparte(entorno):
    http, sesiones, ids = entorno
    _como(CARLA)
    await _republica(sesiones, BETO, ids["uno"], minuto=90)

    muro = await _muro(http, limit=10, with_reposts="true")

    assert [p["body"] for p in muro] == ["uno", "tres", "dos", "uno"]
    compartida = muro[0]
    assert compartida["repost"]["author"]["username"] == "beto"
    # La autoria NO se sustituye: sigue firmando Ana.
    assert compartida["author"]["username"] == "ana"


@pytest.mark.asyncio
async def test_el_orden_lo_marca_la_fecha_de_la_republicacion(entorno):
    """Compartir hoy algo de hace un mes tiene que verse hoy.

    Es la regla que justifica toda la mezcla. Si se ordenara por la fecha del
    original, la republicacion caeria al fondo del muro junto a lo que comparte
    y no la veria nadie: republicar no serviria para nada.
    """
    http, sesiones, ids = entorno
    _como(CARLA)
    # Se republica la MAS VIEJA, y se republica la ULTIMA.
    await _republica(sesiones, BETO, ids["uno"], minuto=90)

    muro = await _muro(http, limit=10, with_reposts="true")

    assert muro[0]["body"] == "uno"
    assert muro[0]["repost"] is not None
    # La original sigue en su sitio, al fondo.
    assert muro[-1]["body"] == "uno"
    assert muro[-1]["repost"] is None


# --------------------------------------------------------------------------- #
# 3. Los contadores son los de verdad
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_republicacion_lleva_los_me_gusta_del_original(entorno):
    """Antes de esto la lista de republicaciones pasaba `0, 0, 0, 0` a mano.

    Una publicacion con me gusta y comentarios salia con cero en cuanto alguien
    la compartia, y el corazon aparecia apagado aunque estuviera dado. El dato
    estaba en la base: simplemente no se pedia.
    """
    http, sesiones, ids = entorno
    _como(CARLA)
    async with sesiones() as db:
        db.add(PostLike(post_id=ids["uno"], user_id=CARLA))
        db.add(PostLike(post_id=ids["uno"], user_id=ANA))
        db.add(
            Comment(
                post_id=ids["uno"], author_id=ANA, body="bueno", status="published"
            )
        )
        await db.commit()
    await _republica(sesiones, BETO, ids["uno"], minuto=90)

    muro = await _muro(http, limit=10, with_reposts="true")

    compartida = muro[0]
    assert compartida["likes_count"] == 2
    assert compartida["comments_count"] == 1
    assert compartida["liked_by_me"] is True


@pytest.mark.asyncio
async def test_la_misma_publicacion_dos_veces_no_comparte_objeto(entorno):
    """El original y su republicacion son dos elementos distintos.

    Se hidratan de un unico diccionario por id, asi que sin copiar de por medio
    ponerle la cabecera a la republicacion se la pondria tambien al original.
    """
    http, sesiones, ids = entorno
    _como(CARLA)
    await _republica(sesiones, BETO, ids["tres"], minuto=90)

    muro = await _muro(http, limit=10, with_reposts="true")

    assert [p["repost"] is not None for p in muro] == [True, False, False, False]


# --------------------------------------------------------------------------- #
# 4. Los filtros del muro valen para las dos corrientes
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_lo_que_el_muro_excluye_no_entra_republicado(entorno):
    """`exclude_media=audio` es lo que manda el muro en cada peticion.

    Los audios son episodios del podcast y tienen su seccion. Si el filtro no se
    aplicara tambien a la corriente de republicaciones, un audio entraria en el
    muro por la puerta de atras en cuanto alguien lo compartiera.
    """
    http, sesiones, ids = entorno
    _como(CARLA)
    async with sesiones() as db:
        podcast = Post(
            author_id=ANA, body="episodio", status="published", created_at=_cuando(5)
        )
        db.add(podcast)
        await db.flush()
        db.add(
            PostMedia(
                post_id=podcast.id,
                storage_path=f"{ANA}/voz.m4a",
                media_type="audio",
            )
        )
        await db.commit()
        audio_id = podcast.id
    await _republica(sesiones, BETO, audio_id, minuto=90)

    muro = await _muro(http, limit=10, with_reposts="true", exclude_media="audio")

    assert [p["body"] for p in muro] == ["tres", "dos", "uno"]


# --------------------------------------------------------------------------- #
# 5. Paginacion: ni un hueco ni un duplicado
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_recorrer_el_muro_por_paginas_no_salta_ni_repite(entorno):
    """Dos corrientes y una sola paginacion: es lo que se puede romper.

    Se pide de dos en dos hasta el final y se compara con el orden completo. Un
    error al pedir «cuantas de cada corriente» se ve aqui como un elemento que
    falta o que sale dos veces, que es exactamente el sintoma que tendria una
    persona haciendo scroll.
    """
    http, sesiones, ids = entorno
    _como(CARLA)
    await _republica(sesiones, BETO, ids["uno"], minuto=5)
    await _republica(sesiones, BETO, ids["dos"], minuto=15)
    await _republica(sesiones, BETO, ids["tres"], minuto=25)

    entero = await _muro(http, limit=50, with_reposts="true")
    assert len(entero) == 6

    por_paginas: list[dict] = []
    for salto in range(0, 6, 2):
        por_paginas += await _muro(
            http, limit=2, offset=salto, with_reposts="true"
        )

    def firma(p: dict) -> tuple[str, str]:
        return (p["id"], (p.get("repost") or {}).get("id", ""))

    assert [firma(p) for p in por_paginas] == [firma(p) for p in entero]
    assert len({firma(p) for p in por_paginas}) == 6


@pytest.mark.asyncio
async def test_el_cursor_tambien_cruza_las_dos_corrientes(entorno):
    """El cursor del muro apunta a lo que ORDENA, y eso cambia segun el elemento.

    Para una publicacion es su fecha y su id; para una republicacion son los de
    la republicacion. Compararlo siempre contra `posts` haria que la paginacion
    saltara hacia atras al llegar a una compartida.
    """
    http, sesiones, ids = entorno
    _como(CARLA)
    repost_id = await _republica(sesiones, BETO, ids["uno"], minuto=25)

    entero = await _muro(http, limit=50, with_reposts="true")
    assert entero[0]["repost"]["id"] == repost_id

    # "Lo que hay despues de la republicacion": su propia fecha y su propio id.
    cursor = quote(entero[0]["repost"]["created_at"])
    siguiente = await _muro(
        http,
        limit=50,
        with_reposts="true",
        before_created_at=cursor,
        before_id=repost_id,
    )

    assert [p["body"] for p in siguiente] == ["tres", "dos", "uno"]
    assert all(p["repost"] is None for p in siguiente)


# --------------------------------------------------------------------------- #
# 6. Bloqueos: hay DOS personas detras de una republicacion
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_bloquear_a_quien_republica_lo_esconde_del_muro(entorno):
    http, sesiones, ids = entorno
    _como(CARLA)
    await _republica(sesiones, BETO, ids["uno"], minuto=90)
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=CARLA, blocked_id=BETO))
        await db.commit()

    muro = await _muro(http, limit=10, with_reposts="true")

    assert [p["body"] for p in muro] == ["tres", "dos", "uno"]


@pytest.mark.asyncio
async def test_bloquear_al_autor_original_esconde_tambien_lo_republicado(entorno):
    """Si no, bloquear dejaria de servir en cuanto un tercero republicara.

    Es la parte que un `join` a secas se deja siempre: se filtra por quien
    comparte y se olvida de quien escribio.
    """
    http, sesiones, ids = entorno
    _como(CARLA)
    await _republica(sesiones, BETO, ids["uno"], minuto=90)
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=CARLA, blocked_id=ANA))
        await db.commit()

    muro = await _muro(http, limit=10, with_reposts="true")

    assert muro == []


# --------------------------------------------------------------------------- #
# 7. "Siguiendo": se sigue a quien comparte, no a quien escribio
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_en_siguiendo_llega_lo_que_comparte_alguien_a_quien_sigo(entorno):
    """Para eso sirve republicar: traer al muro a alguien a quien no sigues."""
    http, sesiones, ids = entorno
    _como(CARLA)
    async with sesiones() as db:
        db.add(Follow(follower_id=CARLA, following_id=BETO))
        await db.commit()
    await _republica(sesiones, BETO, ids["uno"], minuto=90)

    muro = await _muro(http, limit=10, with_reposts="true", feed="following")

    # Carla NO sigue a Ana, asi que de la corriente de publicaciones no llega
    # nada. Lo unico que ve es lo que Beto comparte.
    assert [p["body"] for p in muro] == ["uno"]
    assert muro[0]["repost"]["author"]["username"] == "beto"


# --------------------------------------------------------------------------- #
# 8. Sin la migracion, el muro sigue siendo el muro
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_la_tabla_de_la_0042_el_muro_responde_igual(entorno):
    """Desplegar codigo no puede exigir que una migracion concreta ya este puesta.

    La regla de la 0027 en adelante. Aqui se comprueba por el camino nuevo, que
    es el que podria darla por hecha.
    """
    http, sesiones, _ = entorno
    _como(CARLA)
    async with sesiones() as db:
        await db.execute(text("drop table post_reposts"))
        await db.commit()
    esquema.olvidar()

    muro = await _muro(http, limit=10, with_reposts="true")

    assert [p["body"] for p in muro] == ["tres", "dos", "uno"]
