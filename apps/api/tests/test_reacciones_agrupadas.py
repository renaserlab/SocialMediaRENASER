"""Cien personas reaccionando son UN aviso, no cien.

LO QUE SE PIDIO: «que en notificaciones aparezca "A Edson le gusta tu video",
y si varias personas le dan like que no se llene de notificaciones, que sea
practico como Facebook: "Edson y 100 personas mas reaccionaron a tu video"
(ese 100 es un ejemplo, lo que debe aparecer es el numero real de personas), y
que al hacer click lo redirija a la publicacion y a la bandeja de todas las
personas que reaccionaron».

DOS DECISIONES QUE ESTAS PRUEBAS FIJAN:

1. Se agrupa AL LEER. Escribiendo haria falta un indice unico, y ese indice no
   se puede crear mientras existan los duplicados que ya hay guardados. Asi no
   se toca ni una fila de lo que ya esta en la base.

2. El numero sale de contar `post_likes` EN VIVO, no de un contador escrito en
   la notificacion. Un numero guardado se queda desfasado en cuanto alguien
   retira su reaccion, y ahi la notificacion mentiria.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.content.models import Post, PostLike
from app.modules.notifications.models import Notification
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

AUTORA = "aaaaaaaa-0000-0000-0000-00000000000a"
POST = "cccccccc-0000-0000-0000-00000000000c"
OTRO_POST = "cccccccc-0000-0000-0000-00000000000d"
ORIGEN = datetime(2026, 8, 27, 12, 0, 0, tzinfo=timezone.utc)


def _instante(segundos: int) -> datetime:
    return ORIGEN + timedelta(seconds=segundos)


def _fan(i: int) -> str:
    return f"bbbbbbbb-0000-0000-0000-{i:012d}"


@pytest_asyncio.fixture
async def entorno():
    cache.vaciar()
    esquema.olvidar()

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        from app.modules.bookings import models as _b  # noqa: F401
        from app.modules.catalog import models as _c  # noqa: F401
        from app.modules.communities import models as _co  # noqa: F401
        from app.modules.learning import models as _l  # noqa: F401
        from app.modules.messaging import models as _m  # noqa: F401
        from app.modules.moderation import models as _mo  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=AUTORA, full_name="Autora", username="autora"))
        db.add(
            Post(
                id=POST,
                author_id=AUTORA,
                body="mi video",
                status="published",
                visibility="public",
                created_at=_instante(0),
            )
        )
        db.add(
            Post(
                id=OTRO_POST,
                author_id=AUTORA,
                body="otra cosa",
                status="published",
                visibility="public",
                created_at=_instante(1),
            )
        )
        await db.commit()

    async def _db():
        async with sesiones() as s:
            yield s

    async def _usuario() -> AuthUser:
        return AuthUser(id=AUTORA, email="a@b.c", role="authenticated")

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _usuario

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http, sesiones

    app.dependency_overrides.clear()
    await engine.dispose()


async def _reaccionan(
    sesiones, cuantas: int, post_id: str = POST, *, desde: int = 0
) -> None:
    """`cuantas` personas reaccionan, cada una con su aviso, como hoy.

    `desde` desplaza los identificadores para poder poblar dos publicaciones
    con gente distinta sin chocar con el `username` unico.
    """
    async with sesiones() as db:
        for n in range(cuantas):
            i = desde + n
            uid = _fan(i)
            db.add(Profile(id=uid, full_name=f"Fan {i}", username=f"fan{i}"))
            db.add(PostLike(post_id=post_id, user_id=uid, created_at=_instante(i + 10)))
            db.add(
                Notification(
                    id=f"dddddddd-0000-0000-{post_id[-4:]}-{i:012d}",
                    user_id=AUTORA,
                    actor_id=uid,
                    type="like",
                    entity_type="post",
                    entity_id=post_id,
                    created_at=_instante(i + 10),
                )
            )
        await db.commit()


# --------------------------------------------------------------------------- #
# 1. Agrupacion
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_cien_reacciones_son_un_aviso_y_no_cien(entorno):
    http, sesiones = entorno
    await _reaccionan(sesiones, 100)

    respuesta = await http.get("/api/v1/notifications?limit=50")
    assert respuesta.status_code == 200, respuesta.text
    avisos = respuesta.json()

    de_me_gusta = [a for a in avisos if a["type"] == "like"]
    assert len(de_me_gusta) == 1, (
        f"{len(de_me_gusta)} avisos para la misma publicacion: la pantalla se "
        "llena y deja de servir para nada"
    )
    assert de_me_gusta[0]["entity_id"] == POST


@pytest.mark.asyncio
async def test_el_numero_es_el_real_de_personas(entorno):
    http, sesiones = entorno
    await _reaccionan(sesiones, 100)

    avisos = (await http.get("/api/v1/notifications?limit=50")).json()
    aviso = next(a for a in avisos if a["type"] == "like")
    assert aviso["group_count"] == 100, (
        "el numero que se enseña tiene que ser el de personas que reaccionaron"
    )


@pytest.mark.asyncio
async def test_el_aviso_conserva_a_quien_reacciono_ultimo(entorno):
    """«Edson y 99 personas mas»: Edson es el ultimo, no uno cualquiera."""
    http, sesiones = entorno
    await _reaccionan(sesiones, 5)

    avisos = (await http.get("/api/v1/notifications?limit=50")).json()
    aviso = next(a for a in avisos if a["type"] == "like")
    assert aviso["actor"]["id"] == _fan(4), "deberia salir quien reacciono ultimo"


@pytest.mark.asyncio
async def test_publicaciones_distintas_no_se_mezclan(entorno):
    http, sesiones = entorno
    await _reaccionan(sesiones, 3, POST)
    await _reaccionan(sesiones, 2, OTRO_POST, desde=100)

    avisos = (await http.get("/api/v1/notifications?limit=50")).json()
    de_me_gusta = [a for a in avisos if a["type"] == "like"]
    assert len(de_me_gusta) == 2, "cada publicacion tiene su propio aviso"
    por_post = {a["entity_id"]: a["group_count"] for a in de_me_gusta}
    assert por_post[POST] == 3
    assert por_post[OTRO_POST] == 2


@pytest.mark.asyncio
async def test_quitar_la_reaccion_baja_el_numero(entorno):
    """El numero se cuenta en vivo, no se guarda.

    Un contador escrito en la notificacion seguiria diciendo 3 despues de que
    alguien retirara su me gusta, y la notificacion mentiria.
    """
    http, sesiones = entorno
    await _reaccionan(sesiones, 3)

    async with sesiones() as db:
        fila = await db.get(PostLike, {"post_id": POST, "user_id": _fan(0)})
        await db.delete(fila)
        await db.commit()

    avisos = (await http.get("/api/v1/notifications?limit=50")).json()
    aviso = next(a for a in avisos if a["type"] == "like")
    assert aviso["group_count"] == 2


@pytest.mark.asyncio
async def test_el_coste_no_crece_con_el_numero_de_personas(entorno):
    """Agrupar no puede convertirse en una consulta por aviso."""
    from sqlalchemy import event

    http, sesiones = entorno
    await _reaccionan(sesiones, 40)

    consultas: list[str] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        if statement.lstrip().lower().startswith("select"):
            consultas.append(statement)

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    try:
        respuesta = await http.get("/api/v1/notifications?limit=50")
    finally:
        event.remove(motor, "before_cursor_execute", _anotar)

    assert respuesta.status_code == 200
    assert len(consultas) <= 2, (
        f"{len(consultas)} consultas para listar avisos: se esperan 2 (los "
        "avisos y el recuento en lote)"
    )


# --------------------------------------------------------------------------- #
# 2. La bandeja de quien reacciono
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_se_puede_ver_quien_reacciono(entorno):
    http, sesiones = entorno
    await _reaccionan(sesiones, 5)

    respuesta = await http.get(f"/api/v1/posts/{POST}/likes")
    assert respuesta.status_code == 200, respuesta.text
    gente = respuesta.json()
    assert len(gente) == 5
    assert {p["id"] for p in gente} == {_fan(i) for i in range(5)}


@pytest.mark.asyncio
async def test_quien_reacciono_sale_por_orden_de_reaccion(entorno):
    """Lo mas reciente primero: es lo que se espera al abrirlo desde un aviso."""
    http, sesiones = entorno
    await _reaccionan(sesiones, 3)

    gente = (await http.get(f"/api/v1/posts/{POST}/likes")).json()
    assert [p["id"] for p in gente] == [_fan(2), _fan(1), _fan(0)]


@pytest.mark.asyncio
async def test_la_bandeja_se_pagina(entorno):
    http, sesiones = entorno
    await _reaccionan(sesiones, 10)

    primera = (await http.get(f"/api/v1/posts/{POST}/likes?limit=4")).json()
    segunda = (await http.get(f"/api/v1/posts/{POST}/likes?limit=4&offset=4")).json()
    assert len(primera) == 4
    assert len(segunda) == 4
    assert not ({p["id"] for p in primera} & {p["id"] for p in segunda}), (
        "las paginas repiten personas"
    )


@pytest.mark.asyncio
async def test_una_publicacion_que_no_existe_no_filtra_nada(entorno):
    http, _ = entorno
    respuesta = await http.get("/api/v1/posts/cccccccc-0000-0000-0000-999999999999/likes")
    assert respuesta.status_code == 404


@pytest.mark.asyncio
async def test_una_publicacion_retirada_no_filtra_quien_reacciono(entorno):
    http, sesiones = entorno
    await _reaccionan(sesiones, 3)
    async with sesiones() as db:
        post = await db.get(Post, POST)
        post.status = "deleted"
        await db.commit()

    respuesta = await http.get(f"/api/v1/posts/{POST}/likes")
    assert respuesta.status_code == 404


@pytest.mark.asyncio
async def test_sin_sesion_no_se_puede_ver_quien_reacciono(entorno):
    """Una reaccion es una señal de comportamiento, no una relacion publica.

    El muro se lee sin cuenta (migracion 0018), pero el listado de quien
    reacciono a que no tiene por que ser descargable por cualquiera con la
    direccion. Mismo criterio que `oferta_de_un_perfil` en recomendaciones.
    """
    http, sesiones = entorno
    await _reaccionan(sesiones, 2)

    app.dependency_overrides.pop(get_current_user, None)
    try:
        respuesta = await http.get(f"/api/v1/posts/{POST}/likes")
        assert respuesta.status_code == 401, respuesta.text
    finally:
        async def _usuario() -> AuthUser:
            return AuthUser(id=AUTORA, email="a@b.c", role="authenticated")

        app.dependency_overrides[get_current_user] = _usuario
