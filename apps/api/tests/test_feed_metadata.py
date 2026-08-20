"""El feed entrega la metadata de los medios y sabe paginar por cursor.

Estas dos cosas sostienen la carga rapida del movil: con las medidas y el
poster la tarjeta se pinta al instante sin descargar el archivo, y con el
cursor la paginacion no repite ni salta publicaciones cuando entra contenido
nuevo entre pagina y pagina.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.main import app
from app.modules.content.models import Post, PostMedia
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db


@pytest_asyncio.fixture
async def cliente():
    """App real sobre una base SQLite en memoria, con datos de muro."""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        # Importa el resto de modelos para que create_all conozca sus tablas.
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

    autor_id = str(uuid4())
    base = datetime(2026, 8, 1, 12, 0, 0, tzinfo=timezone.utc)
    posts: list[Post] = []
    async with sesiones() as db:
        db.add(Profile(id=autor_id, full_name="Ana", username="ana"))
        for i in range(3):
            post = Post(
                author_id=autor_id,
                body=f"post {i}",
                status="published",
                created_at=base + timedelta(minutes=i),
            )
            db.add(post)
            posts.append(post)
        await db.flush()
        # El mas reciente lleva un video con toda su metadata.
        db.add(
            PostMedia(
                post_id=posts[2].id,
                storage_path=f"{autor_id}/video.mp4",
                media_type="video",
                width=720,
                height=1280,
                duration_s=42.5,
                bytes=9_000_000,
                poster_path=f"{autor_id}/poster.jpg",
                feed_path=f"{autor_id}/derived/x/feed.mp4",
            )
        )
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    app.dependency_overrides[get_db] = _db_override
    transporte = ASGITransport(app=app)
    async with AsyncClient(transport=transporte, base_url="http://test") as http:
        yield http, posts
    app.dependency_overrides.pop(get_db, None)
    await engine.dispose()


@pytest.mark.asyncio
async def test_el_feed_incluye_la_metadata_del_medio(cliente):
    http, _ = cliente
    respuesta = await http.get("/api/v1/posts?limit=10&offset=0")
    assert respuesta.status_code == 200
    datos = respuesta.json()
    assert [p["body"] for p in datos] == ["post 2", "post 1", "post 0"]

    medio = datos[0]["media"][0]
    assert medio["media_type"] == "video"
    assert medio["width"] == 720
    assert medio["height"] == 1280
    assert medio["duration_s"] == 42.5
    assert medio["poster_path"].endswith("poster.jpg")
    assert medio["feed_path"].endswith("feed.mp4")


@pytest.mark.asyncio
async def test_el_cursor_devuelve_solo_lo_anterior(cliente):
    http, posts = cliente
    # "Antes del post 2": deben venir el 1 y el 0, sin repetir el 2. El cursor
    # viaja URL-codificado (el `+` de la zona horaria se perderia como espacio);
    # URLSearchParams en el movil lo codifica igual.
    from urllib.parse import quote

    cursor = quote(posts[2].created_at.isoformat())
    respuesta = await http.get(
        f"/api/v1/posts?limit=10&before_created_at={cursor}&before_id={posts[2].id}"
    )
    assert respuesta.status_code == 200
    assert [p["body"] for p in respuesta.json()] == ["post 1", "post 0"]


@pytest.mark.asyncio
async def test_un_cursor_ilegible_no_revienta_la_consulta(cliente):
    http, _ = cliente
    respuesta = await http.get("/api/v1/posts?before_created_at=ayer-por-la-tarde")
    assert respuesta.status_code == 422
