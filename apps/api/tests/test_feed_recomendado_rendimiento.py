"""Desplazarse por el feed de Inicio no puede volver a ordenarlo entero.

EL FALLO QUE FIJA ESTE FICHERO, con numeros medidos sobre esta misma prueba.

`GET /recommendations/content` ordenaba el feed COMPLETO en cada peticion y se
quedaba con la rodaja `[offset:offset+limite]`. El ranking de personas ya
estaba en memoria —lo guarda `cache` desde hace tiempo— pero la parte de
CONTENIDO no: los bloqueos, los 300 candidatos, sus reacciones, sus temas, los
temas de sus autores, sus etiquetas y la afinidad con ellas se volvian a pedir
en cada pagina. Doce consultas por pagina que devolvian exactamente lo mismo
que en la anterior, porque el ranking estaba cacheado y la semilla de
exploracion solo cambia una vez al dia. Contando consultas con un escucha de
SQLAlchemy: 28 la primera pagina y 12 cada una de las siguientes; cuatro
paginas de scroll, 64 consultas.

Y ADEMAS ESTABA MAL PAGINADO. Al reordenar en cada pagina, una publicacion
nueva que entrara mientras alguien se desplaza corria la ventana un puesto: la
pagina siguiente repetia lo ultimo ya visto. Congelar el orden unos segundos
—lo que `cursos_para` ya hacia— arregla las dos cosas a la vez.

POR QUE SE CUENTAN CONSULTAS Y NO TIEMPO. El tiempo depende de la maquina; el
numero de consultas es la propiedad que se quiere fijar. Contra SQLite en
memoria doce consultas son microsegundos y la suite pasaria en verde con el
problema dentro; contra Supabase cada una es un viaje por la red.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.content.models import Post, PostMedia
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.modules.recommendations.models import (
    PostTopic,
    RecommendationPreference,
    Topic,
    UserTopicRelation,
)
from app.modules.social_graph.models import UserBlock
from app.shared.database import Base, get_db

API = "/api/v1/recommendations/content"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
CARPINTERIA = "11111111-1111-1111-1111-111111111111"

#: Un instante fijo del que colgar todo: el `now()` de SQLite tiene resolucion
#: de segundo y varias publicaciones seguidas compartirian hora.
ORIGEN = datetime(2026, 8, 20, 12, 0, 0, tzinfo=timezone.utc)


def _instante(segundos: int) -> datetime:
    return ORIGEN + timedelta(seconds=segundos)


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
        from app.modules.notifications import device_tokens as _dt  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Topic(id=CARPINTERIA, slug="carpinteria", name="Carpintería"))
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(
            RecommendationPreference(
                user_id=ANA,
                onboarding_version=1,
                completed_at=_instante(0),
                goals=["aprender"],
                preferred_connection_types=["mentor"],
                preferred_content_formats=["video"],
                offer_modes=["online"],
            )
        )
        db.add(UserTopicRelation(user_id=ANA, topic_id=CARPINTERIA, relation="learn"))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=ANA, email="a@b.c", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http, sesiones

    app.dependency_overrides.clear()
    await engine.dispose()


async def _sembrar(sesiones, autores: int, por_autor: int, *, desde: int = 0) -> None:
    """Publicaciones de varios autores, para que `sin_rachas` tenga que actuar."""
    async with sesiones() as db:
        for a in range(autores):
            autor = f"bbbbbbbb-0000-0000-0000-{a:012d}"
            if desde == 0:
                db.add(
                    Profile(
                        id=autor,
                        full_name=f"Autor {a}",
                        username=f"autor{a}",
                        created_at=_instante(a),
                    )
                )
                db.add(
                    UserTopicRelation(
                        user_id=autor, topic_id=CARPINTERIA, relation="teach"
                    )
                )
            for j in range(por_autor):
                i = desde + a * 1000 + j
                post_id = f"cccccccc-0000-0000-0000-{i:012d}"
                db.add(
                    Post(
                        id=post_id,
                        author_id=autor,
                        body=f"publicacion {i}",
                        status="published",
                        visibility="public",
                        created_at=_instante(i),
                    )
                )
                db.add(
                    PostMedia(
                        id=f"dddddddd-0000-0000-0000-{i:012d}",
                        post_id=post_id,
                        storage_path=f"m/{i}.mp4",
                        media_type="video",
                        sort_order=0,
                        feed_path=f"m/{i}_400.jpg",
                    )
                )
                db.add(PostTopic(post_id=post_id, topic_id=CARPINTERIA, source="author"))
        await db.commit()


def _escuchar(sesiones):
    """Devuelve (consultas, quitar) para contar el SQL de verdad."""
    consultas: list[tuple[str, object]] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        consultas.append((statement, args[0] if args else ()))

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    return consultas, lambda: event.remove(motor, "before_cursor_execute", _anotar)


def _selects(consultas) -> list[str]:
    return [s for s, _ in consultas if s.lstrip().lower().startswith("select")]


async def _contar(http, sesiones, url: str) -> tuple[int, dict]:
    consultas, quitar = _escuchar(sesiones)
    try:
        respuesta = await http.get(url)
    finally:
        quitar()
    assert respuesta.status_code == 200, respuesta.text
    return len(_selects(consultas)), respuesta.json()


# --------------------------------------------------------------------------- #
# 1. Paginar no puede volver a ordenar el feed
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_las_paginas_siguientes_no_reordenan_el_feed_entero(entorno):
    """PROHIBIDO recalcular el orden en cada pagina del scroll.

    La primera paga el ranking; de la segunda en adelante solo se paga LEER
    las publicaciones de esa pagina. Se exige que la segunda y la cuarta
    cuesten LO MISMO: un tope fijo se puede cumplir por casualidad, que dos
    paginas distintas cuesten igual solo pasa si de verdad no se reordena.
    """
    http, sesiones = entorno
    await _sembrar(sesiones, autores=6, por_autor=10)

    # Un viaje en vacio primero: lo que se cachea por proceso no debe contarse.
    assert (await http.get(API, params={"limit": 10})).status_code == 200
    cache.vaciar()

    primera, cuerpo1 = await _contar(http, sesiones, f"{API}?limit=10")
    segunda, cuerpo2 = await _contar(http, sesiones, f"{API}?limit=10&offset=10")
    cuarta, _ = await _contar(http, sesiones, f"{API}?limit=10&offset=30")

    assert len(cuerpo1["items"]) == 10
    assert len(cuerpo2["items"]) == 10

    assert segunda == cuarta, (
        f"{segunda} consultas para la pagina 2 y {cuarta} para la 4: "
        "el orden se sigue recalculando en cada pagina"
    )
    assert segunda <= 6, (
        f"{segunda} consultas para pintar una pagina ya ordenada: "
        "leer las publicaciones del lote son cinco (publicaciones, medios, "
        "temas, etiquetas y menciones)"
    )
    assert primera > segunda, (
        "la primera pagina deberia ser la unica que paga el orden; "
        "si cuestan lo mismo es que la memoria corta no se esta usando"
    )


@pytest.mark.asyncio
async def test_el_coste_de_una_pagina_no_crece_con_el_catalogo(entorno):
    """Cinco publicaciones y setenta y cinco cuestan lo mismo por pagina.

    Es la comprobacion de que no hay un N+1 escondido: ni una consulta por
    publicacion, ni una por autor.
    """
    http, sesiones = entorno
    await _sembrar(sesiones, autores=1, por_autor=5)
    assert (await http.get(API, params={"limit": 30})).status_code == 200

    cache.vaciar()
    con_5, cuerpo_5 = await _contar(http, sesiones, f"{API}?limit=30")
    assert len(cuerpo_5["items"]) == 5

    await _sembrar(sesiones, autores=1, por_autor=70, desde=500)
    cache.vaciar()
    con_75, cuerpo_75 = await _contar(http, sesiones, f"{API}?limit=30")
    assert len(cuerpo_75["items"]) == 30

    assert con_5 == con_75, (
        f"{con_5} consultas con 5 publicaciones y {con_75} con 75: "
        "el coste crece con el catalogo"
    )


# --------------------------------------------------------------------------- #
# 2. Ninguna consulta identica dos veces en la misma peticion
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_los_bloqueos_se_preguntan_una_sola_vez(entorno):
    """`user_blocks` se pedia DOS veces: para filtrar el feed y en el ranking.

    SE MIRA ESTA TABLA Y NO «ninguna consulta repetida en general», y la
    diferencia importa. Hay consultas con el mismo TEXTO que preguntan cosas
    distintas —`relaciones_de` se usa para los candidatos y para los autores de
    las publicaciones, y sus listas de ids solo coinciden por casualidad en un
    escenario pequeno—; ademas el orden de esos ids sale de un `set`, asi que
    una comprobacion general daria verde o rojo segun el `PYTHONHASHSEED` de
    cada ejecucion. Los bloqueos, en cambio, son UNA pregunta con UN argumento:
    el usuario. Preguntarla dos veces es siempre un fallo.
    """
    http, sesiones = entorno
    await _sembrar(sesiones, autores=4, por_autor=5)
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=ANA, blocked_id="bbbbbbbb-0000-0000-0000-000000000003"))
        await db.commit()

    assert (await http.get(API, params={"limit": 10})).status_code == 200
    cache.vaciar()

    consultas, quitar = _escuchar(sesiones)
    try:
        respuesta = await http.get(API, params={"limit": 10})
    finally:
        quitar()
    assert respuesta.status_code == 200

    a_bloqueos = [
        " ".join(s.split())
        for s in _selects(consultas)
        if "from user_blocks" in " ".join(s.split()).lower()
    ]
    assert len(a_bloqueos) == 1, (
        f"{len(a_bloqueos)} consultas a user_blocks en una sola peticion: "
        f"{a_bloqueos}"
    )
    # Y el bloqueo sigue surtiendo efecto: no es que se haya quitado la
    # consulta, es que se hace una vez y se reparte.
    ids = {p["id"] for p in respuesta.json()["items"]}
    del_bloqueado = {
        f"cccccccc-0000-0000-0000-{3 * 1000 + j:012d}" for j in range(5)
    }
    assert not (ids & del_bloqueado), "el feed trae publicaciones de un bloqueado"


# --------------------------------------------------------------------------- #
# 3. La memoria corta no puede cambiar lo que se ve
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_las_paginas_no_repiten_ni_se_saltan_publicaciones(entorno):
    """Es para lo que sirve congelar el orden: paginar sin duplicados.

    Antes se reordenaba en cada pagina, asi que una publicacion nueva entre
    pagina y pagina corria la ventana y repetia lo ya visto.
    """
    http, sesiones = entorno
    await _sembrar(sesiones, autores=5, por_autor=6)

    assert (await http.get(API, params={"limit": 10})).status_code == 200
    cache.vaciar()

    primera = (await http.get(API, params={"limit": 10})).json()["items"]

    # Ahora entra una publicacion NUEVA, como pasa mientras alguien se desplaza.
    await _sembrar(sesiones, autores=1, por_autor=1, desde=9_000)

    segunda = (await http.get(API, params={"limit": 10, "offset": 10})).json()["items"]
    tercera = (await http.get(API, params={"limit": 10, "offset": 20})).json()["items"]

    vistos = [p["id"] for p in primera + segunda + tercera]
    assert len(set(vistos)) == len(vistos), "hay publicaciones repetidas entre paginas"
    assert len(vistos) == 30


@pytest.mark.asyncio
async def test_el_feed_filtrado_por_medio_no_hereda_el_orden_del_general(entorno):
    """`media` va en la CLAVE de la memoria corta.

    Sin eso, pedir solo imagenes despues del feed general devolveria el orden
    del general —con videos dentro— porque la entrada guardada seria la misma.
    """
    http, sesiones = entorno
    await _sembrar(sesiones, autores=3, por_autor=4)  # todo son videos
    async with sesiones() as db:
        db.add(
            Post(
                id="cccccccc-1111-0000-0000-000000000000",
                author_id="bbbbbbbb-0000-0000-0000-000000000000",
                body="una foto",
                status="published",
                visibility="public",
                created_at=_instante(50_000),
            )
        )
        db.add(
            PostMedia(
                id="dddddddd-1111-0000-0000-000000000000",
                post_id="cccccccc-1111-0000-0000-000000000000",
                storage_path="m/foto.jpg",
                media_type="image",
                sort_order=0,
            )
        )
        await db.commit()

    general = (await http.get(API, params={"limit": 30})).json()["items"]
    solo_imagen = (await http.get(API, params={"limit": 30, "media": "image"})).json()[
        "items"
    ]

    assert len(general) == 13
    assert [p["id"] for p in solo_imagen] == ["cccccccc-1111-0000-0000-000000000000"], (
        "el feed de imagenes ha devuelto el orden guardado del feed general"
    )


@pytest.mark.asyncio
async def test_decir_que_algo_no_interesa_se_nota_en_la_pagina_siguiente(entorno):
    """La memoria corta NO puede retrasar un «no me interesa» un minuto.

    `cache.invalidar` borra por usuario, asi que la entrada de contenido cae
    con el resto. Si alguien la guardara con otra clave, esto lo detecta.
    """
    http, sesiones = entorno
    await _sembrar(sesiones, autores=3, por_autor=4)

    antes = (await http.get(API, params={"limit": 30})).json()["items"]
    descartado = antes[0]["id"]

    respuesta = await http.post(
        "/api/v1/recommendations/events",
        json={
            "events": [
                {
                    "event_type": "not_interested",
                    "entity_type": "post",
                    "entity_id": descartado,
                }
            ]
        },
    )
    assert respuesta.status_code == 200, respuesta.text

    despues = (await http.get(API, params={"limit": 30})).json()["items"]
    assert descartado not in [p["id"] for p in despues], (
        "la publicacion descartada sigue en el feed: la memoria corta no se invalido"
    )
