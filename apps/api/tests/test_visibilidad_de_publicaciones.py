"""El predicado común de visibilidad en CADA endpoint que devuelve `PostRead`.

Spec de los medios en S3, §7 («Predicado común de visibilidad», corrección C3)
y la prueba agregada tras el QA: anónimo, seguidor, círculo, autor, admin,
bloqueo y borrador, en `/posts`, `/posts/{id}`, `/posts?ids=`, `/saved-posts`,
`/reposts` y `/hashtags/{name}/posts` (los dos últimos pasan por
`leer_posts_por_id` y `_hidratar_publicaciones`, que también usa el muro con
republicaciones y el recomendador).

Y la otra mitad, que importa igual: con `publicaciones_visibilidad = abierta`
(de fábrica) NADA cambia respecto a antes.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import get_settings
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.communities.models import Circle, CircleMember
from app.modules.content.models import Hashtag, Post, PostHashtag, SavedPost
from app.modules.content.reposts import PostRepost
from app.modules.profiles.models import Profile
from app.modules.social_graph.models import Follow, UserBlock
from app.shared.database import Base, get_db

AUTORA = str(uuid4())
SEGUIDOR = str(uuid4())
MIEMBRO = str(uuid4())
EXTRANA = str(uuid4())
ADMIN = str(uuid4())
BLOQUEADA = str(uuid4())
REPUBLICA = str(uuid4())

TODOS = {
    "anonimo": None,
    "autora": AUTORA,
    "seguidor": SEGUIDOR,
    "miembro": MIEMBRO,
    "extrana": EXTRANA,
    "admin": ADMIN,
    "bloqueada": BLOQUEADA,
}

#: Quién ve cada publicación con el predicado estricto.
ESPERADO = {
    "publica": {"anonimo", "autora", "seguidor", "miembro", "extrana", "admin"},
    "seguidores": {"autora", "seguidor", "admin"},
    "circulo": {"autora", "miembro", "admin"},
    "circulo_sin_id": {"autora", "admin"},
    "borrador": {"autora", "admin"},
}


@pytest_asyncio.fixture
async def entorno():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        from app.modules.catalog import models as _c  # noqa: F401
        from app.modules.learning import models as _l  # noqa: F401
        from app.modules.messaging import models as _m  # noqa: F401
        from app.modules.moderation import models as _mo  # noqa: F401
        from app.modules.notifications import device_tokens as _dt  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)
    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    base = datetime(2026, 11, 1, 12, 0, 0, tzinfo=timezone.utc)
    ids: dict[str, str] = {}
    async with sesiones() as db:
        db.add_all(
            [
                Profile(id=AUTORA, full_name="Autora", username="autora"),
                Profile(id=SEGUIDOR, full_name="Seguidor", username="seguidor"),
                Profile(id=MIEMBRO, full_name="Miembro", username="miembro"),
                Profile(id=EXTRANA, full_name="Extraña", username="extrana"),
                Profile(id=ADMIN, full_name="Admin", username="admin", role="admin"),
                Profile(id=BLOQUEADA, full_name="Bloqueada", username="bloqueada"),
                Profile(id=REPUBLICA, full_name="Republica", username="republica"),
            ]
        )
        circulo = Circle(owner_id=AUTORA, name="Círculo")
        db.add(circulo)
        await db.flush()
        db.add_all(
            [
                Follow(follower_id=SEGUIDOR, following_id=AUTORA),
                CircleMember(circle_id=circulo.id, user_id=MIEMBRO),
                # La autora bloqueó a «bloqueada»: no se ven en ningún sentido.
                UserBlock(blocker_id=AUTORA, blocked_id=BLOQUEADA),
            ]
        )
        etiqueta = Hashtag(tag="zeta", display_tag="zeta")
        db.add(etiqueta)
        await db.flush()
        casos = [
            ("publica", "public", "published", None),
            ("seguidores", "followers", "published", None),
            ("circulo", "circle", "published", circulo.id),
            ("circulo_sin_id", "circle", "published", None),
            ("borrador", "public", "draft", None),
        ]
        for i, (nombre, visibilidad, estado, circle_id) in enumerate(casos):
            post = Post(
                author_id=AUTORA,
                body=f"{nombre} #zeta",
                visibility=visibilidad,
                status=estado,
                circle_id=circle_id,
                created_at=base + timedelta(minutes=i),
            )
            db.add(post)
            await db.flush()
            ids[nombre] = post.id
            db.add(PostHashtag(post_id=post.id, hashtag_id=etiqueta.id))
            db.add(PostRepost(author_id=REPUBLICA, post_id=post.id, comentario=""))
            # Todos lo guardaron (antes de que existiera el predicado).
            for uid in TODOS.values():
                if uid:
                    db.add(SavedPost(post_id=post.id, user_id=uid))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    app.dependency_overrides[get_db] = _db_override
    transporte = ASGITransport(app=app)
    async with AsyncClient(transport=transporte, base_url="http://test") as http:
        yield http, ids
    app.dependency_overrides.clear()
    await engine.dispose()


def _como(uid: str | None) -> None:
    if uid is None:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides[get_optional_user] = lambda: None
        return
    usuario = AuthUser(id=uid, email=f"{uid}@ejemplo.com", role="authenticated")
    app.dependency_overrides[get_current_user] = lambda: usuario
    app.dependency_overrides[get_optional_user] = lambda: usuario


def _nombres(ids: dict[str, str], lista: list[dict]) -> set[str]:
    inverso = {v: k for k, v in ids.items()}
    return {inverso[p["id"]] for p in lista if p["id"] in inverso}


def _visibles_para(quien: str, publicadas_solamente: bool) -> set[str]:
    salida = {nombre for nombre, gente in ESPERADO.items() if quien in gente}
    if publicadas_solamente:
        salida.discard("borrador")
    return salida


@pytest.fixture
def estricta(monkeypatch):
    monkeypatch.setattr(get_settings(), "publicaciones_visibilidad", "estricta")


@pytest.mark.asyncio
@pytest.mark.parametrize("quien", list(TODOS))
async def test_el_muro_aplica_el_predicado(entorno, estricta, quien):
    http, ids = entorno
    _como(TODOS[quien])
    lista = (await http.get("/api/v1/posts?limit=50")).json()
    assert _nombres(ids, lista) == _visibles_para(quien, True)


@pytest.mark.asyncio
@pytest.mark.parametrize("quien", list(TODOS))
async def test_el_muro_con_republicaciones_aplica_el_predicado(entorno, estricta, quien):
    http, ids = entorno
    _como(TODOS[quien])
    lista = (await http.get("/api/v1/posts?limit=50&with_reposts=true")).json()
    assert _nombres(ids, lista) == _visibles_para(quien, True)


@pytest.mark.asyncio
@pytest.mark.parametrize("quien", list(TODOS))
async def test_el_detalle_aplica_el_predicado(entorno, estricta, quien):
    """Lo que no se puede ver es un 404 limpio, como lo que no existe. Antes
    el detalle devolvía hasta los borradores a cualquiera."""
    http, ids = entorno
    _como(TODOS[quien])
    for nombre, post_id in ids.items():
        respuesta = await http.get(f"/api/v1/posts/{post_id}")
        assert (respuesta.status_code == 200) == (quien in ESPERADO[nombre]), (quien, nombre)
        if respuesta.status_code != 200:
            assert respuesta.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("quien", list(TODOS))
async def test_pedir_por_ids_aplica_el_predicado(entorno, estricta, quien):
    http, ids = entorno
    _como(TODOS[quien])
    lista = (await http.get(f"/api/v1/posts?ids={','.join(ids.values())}")).json()
    assert _nombres(ids, lista) == _visibles_para(quien, True)


@pytest.mark.asyncio
@pytest.mark.parametrize("quien", [q for q in TODOS if q != "anonimo"])
async def test_los_guardados_aplican_el_predicado(entorno, estricta, quien):
    http, ids = entorno
    _como(TODOS[quien])
    lista = (await http.get("/api/v1/saved-posts?limit=50")).json()
    assert _nombres(ids, lista) == _visibles_para(quien, True)


@pytest.mark.asyncio
@pytest.mark.parametrize("quien", list(TODOS))
async def test_las_republicaciones_aplican_el_predicado(entorno, estricta, quien):
    http, ids = entorno
    _como(TODOS[quien])
    lista = (await http.get(f"/api/v1/reposts?author_id={REPUBLICA}&limit=50")).json()
    assert _nombres(ids, lista) == _visibles_para(quien, True)


@pytest.mark.asyncio
@pytest.mark.parametrize("quien", list(TODOS))
async def test_las_etiquetas_aplican_el_predicado(entorno, estricta, quien):
    http, ids = entorno
    _como(TODOS[quien])
    lista = (await http.get("/api/v1/hashtags/zeta/posts?limit=50")).json()
    assert _nombres(ids, lista) == _visibles_para(quien, True)


@pytest.mark.asyncio
async def test_lo_borrado_no_lo_ve_ni_administracion(entorno, estricta):
    http, ids = entorno
    _como(AUTORA)
    assert (await http.delete(f"/api/v1/posts/{ids['publica']}")).status_code == 204
    for uid in (AUTORA, ADMIN):
        _como(uid)
        assert (await http.get(f"/api/v1/posts/{ids['publica']}")).status_code == 404


# --------------------------------------------------------------------------- #
# De fábrica no cambia nada
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_de_fabrica_el_muro_sigue_como_antes(entorno):
    """`abierta`: sin filas en S3, el predicado no añade nada a la consulta y
    el muro enseña lo mismo que antes del cambio (las de seguidores y círculo
    incluidas, que es justo el agujero que cierra `estricta`)."""
    assert get_settings().publicaciones_visibilidad == "abierta"
    http, ids = entorno
    _como(None)
    lista = (await http.get("/api/v1/posts?limit=50")).json()
    assert _nombres(ids, lista) == {"publica", "seguidores", "circulo", "circulo_sin_id"}


@pytest.mark.asyncio
async def test_de_fabrica_el_detalle_sigue_como_antes(entorno):
    http, ids = entorno
    _como(None)
    # Antes del cambio el detalle devolvía hasta el borrador: se mantiene
    # mientras la visibilidad estricta no se encienda (fase 1).
    for post_id in ids.values():
        assert (await http.get(f"/api/v1/posts/{post_id}")).status_code == 200
