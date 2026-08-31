"""Republicar: sin duplicar el archivo, sin perder la autoria, sin recursion y
respetando los bloqueos.

Las cuatro reglas del encargo, cada una con su prueba. Las dos primeras se
comprueban sobre la RESPUESTA (que es lo que ve la aplicacion) y las dos ultimas
sobre el comportamiento del endpoint, que es donde de verdad se pueden romper.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.content.models import Post, PostMedia
from app.modules.content.reposts import PostRepost
from app.modules.profiles.models import Profile
from app.modules.social_graph.models import UserBlock
from app.shared.database import Base, get_db

ANA = str(uuid4())      # autora original
BETO = str(uuid4())     # republica
CARLA = str(uuid4())    # mira el feed


@pytest_asyncio.fixture
async def entorno():
    """App real sobre SQLite en memoria, con la tabla de la 0042 creada."""
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
    base = datetime(2026, 8, 1, 12, 0, 0, tzinfo=timezone.utc)

    async with sesiones() as db:
        db.add_all(
            [
                Profile(id=ANA, full_name="Ana", username="ana"),
                Profile(id=BETO, full_name="Beto", username="beto"),
                Profile(id=CARLA, full_name="Carla", username="carla"),
            ]
        )
        post = Post(author_id=ANA, body="lo mio", status="published", created_at=base)
        db.add(post)
        await db.flush()
        db.add(
            PostMedia(
                post_id=post.id,
                storage_path=f"{ANA}/video.mp4",
                media_type="video",
                width=1080,
                height=1920,
            )
        )
        await db.commit()
        post_id = post.id

    async def _db_override():
        async with sesiones() as session:
            yield session

    app.dependency_overrides[get_db] = _db_override
    transporte = ASGITransport(app=app)
    async with AsyncClient(transport=transporte, base_url="http://test") as http:
        yield http, sesiones, post_id, base
    app.dependency_overrides.clear()
    await engine.dispose()


def _como(uid: str) -> None:
    usuario = AuthUser(id=uid, email=f"{uid}@ejemplo.com", role="authenticated")
    app.dependency_overrides[get_current_user] = lambda: usuario
    app.dependency_overrides[get_optional_user] = lambda: usuario


# --------------------------------------------------------------------------- #
# 1. El archivo no se duplica
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_republicacion_no_crea_ni_una_fila_de_medios(entorno):
    """Republicar no copia el video: lo referencia.

    Copiarlo seria pagar el almacenamiento dos veces y, sobre todo, imposible de
    hacer bien: la politica de Storage ata cada objeto a la carpeta de su dueno,
    asi que la copia tendria que subirse con otra identidad.
    """
    http, sesiones, post_id, _ = entorno
    _como(BETO)

    respuesta = await http.post(f"/api/v1/posts/{post_id}/repost", json={"comentario": ""})
    assert respuesta.status_code == 201

    async with sesiones() as db:
        from sqlalchemy import func, select

        medios = await db.scalar(select(func.count()).select_from(PostMedia))
        publicaciones = await db.scalar(select(func.count()).select_from(Post))
    # Sigue habiendo UN medio y UNA publicacion: la republicacion vive en su
    # propia tabla y no es ni un post ni un archivo.
    assert medios == 1
    assert publicaciones == 1


@pytest.mark.asyncio
async def test_la_republicacion_sirve_el_medio_del_original(entorno):
    http, _, post_id, _ = entorno
    _como(BETO)
    await http.post(f"/api/v1/posts/{post_id}/repost", json={})

    lista = (await http.get(f"/api/v1/reposts?author_id={BETO}")).json()
    assert len(lista) == 1
    assert lista[0]["id"] == post_id
    assert lista[0]["media"][0]["storage_path"] == f"{ANA}/video.mp4"


# --------------------------------------------------------------------------- #
# 2. La autoria se conserva y se distingue
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_se_distinguen_las_dos_personas_y_las_dos_fechas(entorno):
    """`author` es quien lo escribio; `repost`, quien lo comparte.

    Si republicar cambiara el autor, seria una forma comoda de apropiarse del
    trabajo ajeno.
    """
    http, _, post_id, base = entorno
    _como(BETO)
    await http.post(f"/api/v1/posts/{post_id}/repost", json={"comentario": "esto hay que verlo"})

    elemento = (await http.get(f"/api/v1/reposts?author_id={BETO}")).json()[0]

    # Autor original, intacto.
    assert elemento["author"]["id"] == ANA
    assert elemento["author"]["username"] == "ana"
    # Quien republica, aparte.
    assert elemento["repost"]["author"]["id"] == BETO
    assert elemento["repost"]["author"]["username"] == "beto"
    assert elemento["repost"]["comentario"] == "esto hay que verlo"
    # Post original identificado, y dos fechas distintas.
    assert elemento["id"] == post_id
    assert elemento["created_at"].startswith("2026-08-01")
    assert elemento["repost"]["created_at"] != elemento["created_at"]


# --------------------------------------------------------------------------- #
# 3. No hay recursion
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_republicar_una_republicacion_apunta_al_original(entorno):
    """Carla republica lo que vio republicado por Beto.

    Lo que le llega en la lista es el id del post ORIGINAL —una republicacion no
    tiene id de publicacion propio— asi que su republicacion sale de Ana, no de
    Beto. La cadena no se puede formar porque no se puede escribir.
    """
    http, sesiones, post_id, _ = entorno
    _como(BETO)
    await http.post(f"/api/v1/posts/{post_id}/repost", json={})

    _como(CARLA)
    visto = (await http.get("/api/v1/reposts?feed=author&author_id=" + BETO)).json()[0]
    await http.post(f"/api/v1/posts/{visto['id']}/repost", json={})

    async with sesiones() as db:
        from sqlalchemy import select

        destinos = (await db.scalars(select(PostRepost.post_id))).all()
    # Las dos republicaciones apuntan al MISMO post original.
    assert set(destinos) == {post_id}


@pytest.mark.asyncio
async def test_republicar_dos_veces_no_crea_dos_filas(entorno):
    http, sesiones, post_id, _ = entorno
    _como(BETO)
    primera = await http.post(f"/api/v1/posts/{post_id}/repost", json={})
    segunda = await http.post(f"/api/v1/posts/{post_id}/repost", json={})
    assert primera.status_code == 201 and segunda.status_code == 201
    assert primera.json()["id"] == segunda.json()["id"]

    async with sesiones() as db:
        from sqlalchemy import func, select

        assert await db.scalar(select(func.count()).select_from(PostRepost)) == 1


@pytest.mark.asyncio
async def test_deshacer_es_idempotente(entorno):
    http, sesiones, post_id, _ = entorno
    _como(BETO)
    await http.post(f"/api/v1/posts/{post_id}/repost", json={})
    assert (await http.delete(f"/api/v1/posts/{post_id}/repost")).status_code == 204
    assert (await http.delete(f"/api/v1/posts/{post_id}/repost")).status_code == 204

    async with sesiones() as db:
        from sqlalchemy import func, select

        assert await db.scalar(select(func.count()).select_from(PostRepost)) == 0


# --------------------------------------------------------------------------- #
# 4. Los bloqueos se respetan en los DOS extremos
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_quien_bloqueo_al_autor_original_no_lo_ve_por_un_repost(entorno):
    """El agujero clasico: bloqueas a alguien y reaparece porque un tercero le
    republico. Filtrar solo por quien republica lo deja abierto."""
    http, sesiones, post_id, _ = entorno
    _como(BETO)
    await http.post(f"/api/v1/posts/{post_id}/repost", json={})

    async with sesiones() as db:
        db.add(UserBlock(blocker_id=CARLA, blocked_id=ANA))
        await db.commit()

    _como(CARLA)
    assert (await http.get(f"/api/v1/reposts?author_id={BETO}")).json() == []


@pytest.mark.asyncio
async def test_quien_bloqueo_a_quien_republica_tampoco_lo_ve(entorno):
    http, sesiones, post_id, _ = entorno
    _como(BETO)
    await http.post(f"/api/v1/posts/{post_id}/repost", json={})

    async with sesiones() as db:
        db.add(UserBlock(blocker_id=CARLA, blocked_id=BETO))
        await db.commit()

    _como(CARLA)
    assert (await http.get(f"/api/v1/reposts?author_id={BETO}")).json() == []


@pytest.mark.asyncio
async def test_el_corte_vale_en_los_dos_sentidos(entorno):
    """Que la otra persona no te bloquee de vuelta no es una via de escape."""
    http, sesiones, post_id, _ = entorno
    _como(BETO)
    await http.post(f"/api/v1/posts/{post_id}/repost", json={})

    async with sesiones() as db:
        # Ana bloquea a Carla; Carla no ha bloqueado a nadie.
        db.add(UserBlock(blocker_id=ANA, blocked_id=CARLA))
        await db.commit()

    _como(CARLA)
    assert (await http.get(f"/api/v1/reposts?author_id={BETO}")).json() == []


@pytest.mark.asyncio
async def test_no_se_puede_republicar_a_quien_has_bloqueado(entorno):
    http, sesiones, post_id, _ = entorno
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=BETO, blocked_id=ANA))
        await db.commit()

    _como(BETO)
    respuesta = await http.post(f"/api/v1/posts/{post_id}/repost", json={})
    # 404 y no 403: quien bloquea no tiene por que enterarse de que le buscaron.
    assert respuesta.status_code == 404


# --------------------------------------------------------------------------- #
# El feed sigue contando lo que hay
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_muro_dice_cuantas_veces_se_republico_y_si_fui_yo(entorno):
    http, _, post_id, _ = entorno
    _como(BETO)
    await http.post(f"/api/v1/posts/{post_id}/repost", json={})

    propio = (await http.get("/api/v1/posts?limit=10")).json()[0]
    assert propio["reposts_count"] == 1
    assert propio["reposted_by_me"] is True

    _como(CARLA)
    ajeno = (await http.get("/api/v1/posts?limit=10")).json()[0]
    assert ajeno["reposts_count"] == 1
    assert ajeno["reposted_by_me"] is False


@pytest.mark.asyncio
async def test_una_publicacion_normal_no_dice_que_es_una_republicacion(entorno):
    http, _, _, _ = entorno
    _como(CARLA)
    elemento = (await http.get("/api/v1/posts?limit=10")).json()[0]
    assert elemento["repost"] is None
    assert elemento["reposts_count"] == 0
