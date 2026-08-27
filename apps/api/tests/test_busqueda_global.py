"""La busqueda global de extremo a extremo, sobre una base de datos de verdad.

SQLite en memoria, mismo patron que el resto de la suite. Las personas de estos
escenarios viven los milisegundos que dura cada prueba: NUNCA llegan a Supabase.

QUE SE COMPRUEBA AQUI Y NO CABE EN UNA FUNCION PURA:

  - que una publicacion que NO esta en el feed descargado se encuentre igual
    (era el fallo concreto: la pantalla filtraba `state.posts`);
  - que un curso se encuentre sin traerse el catalogo entero;
  - que una persona se encuentre por lo que OFRECE, y que lo que declara querer
    APRENDER no salga por ningun lado;
  - que «quiero aprender a fabricar muebles» llegue a carpinteria;
  - que la busqueda siga funcionando con la capa de temas caida;
  - que los bloqueos y la visibilidad se respeten;
  - que paginar no repita ni se salte filas.

LA BASE DE ESTAS PRUEBAS NO TIENE LA 0034 NI LA 0040. Es a proposito: lo que se
esta comprobando es que el codigo funciona con el esquema que HAY hoy en
produccion. Con la ficha ampliada encuentra ademas por subtitulo; sin ella,
esto.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.catalog.models import Course, Event
from app.modules.content.models import Hashtag, Post, PostHashtag
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.modules.recommendations.models import (
    CourseTopic,
    PostTopic,
    Topic,
    UserTopicRelation,
)
from app.modules.search import temas
from app.modules.social_graph.models import Follow, UserBlock
from app.shared.database import Base, get_db

BUSCAR = "/api/v1/search"

ANA = "bbbbbbbb-0000-0000-0000-000000000001"
BRUNO = "bbbbbbbb-0000-0000-0000-000000000002"
CARLA = "bbbbbbbb-0000-0000-0000-000000000003"
DIEGO = "bbbbbbbb-0000-0000-0000-000000000004"
ELENA = "bbbbbbbb-0000-0000-0000-000000000005"

TEMA_CARPINTERIA = "cccccccc-0000-0000-0000-000000000001"
TEMA_FINANZAS = "cccccccc-0000-0000-0000-000000000002"


def _id(n: int, prefijo: str) -> str:
    return f"{prefijo}-0000-0000-0000-{n:012d}"


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
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.recommendations import models as _r  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add_all(
            [
                Profile(id=ANA, full_name="Ana Torres", username="ana", bio=""),
                Profile(
                    id=BRUNO,
                    full_name="Bruno Ramos",
                    username="bruno",
                    # La biografia dice a que se dedica: es informacion publica
                    # que la persona escribio para que la encuentren.
                    bio="Carpintero de barrio, hago muebles a medida.",
                ),
                Profile(id=CARLA, full_name="Carla Nunez", username="carla", bio=""),
                Profile(id=DIEGO, full_name="Diego Salas", username="diego", bio=""),
                Profile(id=ELENA, full_name="Elena Prado", username="elena", bio=""),
            ]
        )
        db.add_all(
            [
                Topic(
                    id=TEMA_CARPINTERIA,
                    slug="carpinteria",
                    name="Carpintería",
                    topic_group="oficios",
                    active=True,
                    position=1,
                ),
                Topic(
                    id=TEMA_FINANZAS,
                    slug="finanzas",
                    name="Finanzas",
                    topic_group="general",
                    active=True,
                    position=2,
                ),
            ]
        )
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="ana@ejemplo.com", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    app.dependency_overrides[get_optional_user] = _usuario_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    await engine.dispose()


async def _buscar(http: AsyncClient, q: str, **extra) -> dict:
    respuesta = await http.get(BUSCAR, params={"q": q, **extra})
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


# --------------------------------------------------------------------------- #
# Publicaciones: lo que antes era inencontrable
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_encuentra_una_publicacion_que_no_esta_en_el_feed_cargado(entorno):
    """EL FALLO CONCRETO QUE ARREGLA ESTE MODULO.

    La pantalla filtraba `state.posts`, o sea las ~20 publicaciones que el
    telefono ya se habia descargado. Aqui se escriben 60 publicaciones despues
    de la que se busca: en el muro, la vieja no estaria cargada ni de lejos.
    """
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(
            Post(
                id=_id(1, "dddddddd"),
                author_id=BRUNO,
                body="Terminé un ropero de cedro para un vecino",
                status="published",
                visibility="public",
            )
        )
        for n in range(2, 62):
            db.add(
                Post(
                    id=_id(n, "dddddddd"),
                    author_id=BRUNO,
                    body=f"Publicación de relleno numero {n}",
                    status="published",
                    visibility="public",
                )
            )
        await db.commit()

    datos = await _buscar(http, "ropero de cedro")
    ids = [p["id"] for p in datos["posts"]]
    assert _id(1, "dddddddd") in ids


@pytest.mark.asyncio
async def test_la_publicacion_llega_recortada_y_no_entera(entorno):
    """Filas de RESUMEN, no objetos gigantes: ni medios, ni contadores."""
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(
            Post(
                id=_id(90, "dddddddd"),
                author_id=BRUNO,
                body="cedro " * 200,
                status="published",
                visibility="public",
            )
        )
        await db.commit()

    datos = await _buscar(http, "cedro")
    fila = datos["posts"][0]
    assert len(fila["body"]) <= 240
    assert "media" not in fila and "likes_count" not in fila


# --------------------------------------------------------------------------- #
# Cursos: sin descargar el catalogo
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_encuentra_un_curso_sin_descargar_el_catalogo(entorno):
    """120 cursos publicados; la respuesta trae UNO.

    Antes esto se resolvia trayendose el catalogo entero al telefono y
    filtrandolo con un `includes`. Lo que se comprueba es que la respuesta es
    pequeña: si volviera el catalogo, este `len` seria 120.
    """
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(
            Course(
                id=_id(1, "eeeeeeee"),
                author_id=BRUNO,
                title="Ebanistería para principiantes",
                description="Cortes, uniones y acabados.",
                status="published",
            )
        )
        for n in range(2, 122):
            db.add(
                Course(
                    id=_id(n, "eeeeeeee"),
                    author_id=CARLA,
                    title=f"Curso de relleno {n}",
                    description="Nada que ver.",
                    status="published",
                )
            )
        await db.commit()

    datos = await _buscar(http, "ebanisteria")
    assert [c["id"] for c in datos["courses"]] == [_id(1, "eeeeeeee")]
    assert datos["next_offset"]["courses"] is None


@pytest.mark.asyncio
async def test_un_curso_en_borrador_no_sale_ni_para_su_autor(entorno):
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(
            Course(
                id=_id(200, "eeeeeeee"),
                author_id=ANA,
                title="Ebanistería secreta",
                description="Todavía sin terminar.",
                status="draft",
            )
        )
        await db.commit()

    datos = await _buscar(http, "ebanisteria")
    assert datos["courses"] == []


# --------------------------------------------------------------------------- #
# Personas: la oferta publica si, la demanda privada NUNCA
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_encuentra_una_persona_por_su_oferta_publica(entorno):
    """Carla no dice «carpinteria» en ningun texto suyo: solo la OFRECE."""
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(
            UserTopicRelation(
                id=_id(1, "ffffffff"),
                user_id=CARLA,
                topic_id=TEMA_CARPINTERIA,
                relation="teach",
            )
        )
        await db.commit()

    datos = await _buscar(http, "carpintería")
    encontradas = {p["id"]: p for p in datos["people"]}
    assert CARLA in encontradas
    assert "Carpintería" in encontradas[CARLA]["offer_topics"]


@pytest.mark.asyncio
async def test_no_expone_la_demanda_privada(entorno):
    """LA PRUEBA QUE NO PUEDE FALLAR NUNCA.

    Diego dijo que quiere APRENDER carpinteria (`learn`) y que busca
    orientacion sobre finanzas (`seek_guidance`). Ninguna de las dos cosas la
    escribio para que le encuentren: son la lista de lo que no sabe.

    Se comprueba por partida doble, que es como esta escrito el codigo:

      1. buscar «carpintería» NO le encuentra a el (el filtro de la consulta);
      2. y cuando aparece por otro motivo —su nombre—, sus `offer_topics` no
         mencionan ni carpinteria ni finanzas (el filtro de la respuesta).
    """
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add_all(
            [
                UserTopicRelation(
                    id=_id(2, "ffffffff"),
                    user_id=DIEGO,
                    topic_id=TEMA_CARPINTERIA,
                    relation="learn",
                ),
                UserTopicRelation(
                    id=_id(3, "ffffffff"),
                    user_id=DIEGO,
                    topic_id=TEMA_FINANZAS,
                    relation="seek_guidance",
                ),
                UserTopicRelation(
                    id=_id(4, "ffffffff"),
                    user_id=DIEGO,
                    topic_id=TEMA_FINANZAS,
                    relation="interest",
                ),
            ]
        )
        await db.commit()

    por_tema = await _buscar(http, "carpintería")
    assert DIEGO not in [p["id"] for p in por_tema["people"]]

    por_nombre = await _buscar(http, "Diego Salas")
    diego = next(p for p in por_nombre["people"] if p["id"] == DIEGO)
    assert diego["offer_topics"] == []

    # Y que el contrato entero no tenga por donde escaparse: ninguna palabra de
    # la demanda aparece en NINGUN sitio de la respuesta.
    crudo = (str(por_tema) + str(por_nombre)).lower()
    for palabra in ("learn", "seek_guidance", "interest", "finanzas"):
        assert palabra not in crudo


@pytest.mark.asyncio
async def test_un_perfil_privado_no_se_descubre_por_su_biografia(entorno):
    """Privado no es invisible: es «no me descubras».

    Se le encuentra escribiendo su nombre —quien lo escribe ya sabe que existe—
    pero no navegando resultados de un tema.
    """
    http, sesiones, _ = entorno
    async with sesiones() as db:
        elena = await db.get(Profile, ELENA)
        elena.is_private = True
        elena.bio = "Hago muebles de melamina"
        db.add(
            UserTopicRelation(
                id=_id(5, "ffffffff"),
                user_id=ELENA,
                topic_id=TEMA_CARPINTERIA,
                relation="can_help",
            )
        )
        await db.commit()

    por_tema = await _buscar(http, "muebles")
    assert ELENA not in [p["id"] for p in por_tema["people"]]

    por_nombre = await _buscar(http, "Elena Prado")
    assert ELENA in [p["id"] for p in por_nombre["people"]]


# --------------------------------------------------------------------------- #
# La parte «inteligente»
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_una_frase_natural_sobre_muebles_encuentra_carpinteria(entorno):
    """EL CASO DE ACEPTACION.

    «Quiero aprender a fabricar muebles» no contiene «carpintería» por ningun
    lado. Tiene que encontrar a la persona que la ofrece, el curso etiquetado
    con ese tema y la publicacion etiquetada con ese tema, aunque ninguno de los
    tres lleve escrita la palabra.
    """
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(
            UserTopicRelation(
                id=_id(6, "ffffffff"),
                user_id=CARLA,
                topic_id=TEMA_CARPINTERIA,
                relation="teach",
            )
        )
        db.add(
            Course(
                id=_id(300, "eeeeeeee"),
                author_id=CARLA,
                title="Taller de oficio manual",
                description="Trabajo con las manos.",
                status="published",
            )
        )
        db.add(
            Post(
                id=_id(300, "dddddddd"),
                author_id=CARLA,
                body="Así quedó el encargo de esta semana",
                status="published",
                visibility="public",
            )
        )
        await db.flush()
        db.add_all(
            [
                CourseTopic(course_id=_id(300, "eeeeeeee"), topic_id=TEMA_CARPINTERIA),
                PostTopic(post_id=_id(300, "dddddddd"), topic_id=TEMA_CARPINTERIA),
            ]
        )
        await db.commit()

    datos = await _buscar(http, "quiero aprender a fabricar muebles")

    assert [t["slug"] for t in datos["topics"]] == ["carpinteria"]
    assert CARLA in [p["id"] for p in datos["people"]]
    assert _id(300, "eeeeeeee") in [c["id"] for c in datos["courses"]]
    assert _id(300, "dddddddd") in [p["id"] for p in datos["posts"]]


@pytest.mark.asyncio
async def test_el_acento_no_separa_nada(entorno):
    """En un teclado de movil se escribe «carpinteria»; la base dice «Carpintería»."""
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(
            Post(
                id=_id(400, "dddddddd"),
                author_id=BRUNO,
                body="Curso de Carpintería este sábado",
                status="published",
                visibility="public",
            )
        )
        await db.commit()

    datos = await _buscar(http, "carpinteria")
    assert _id(400, "dddddddd") in [p["id"] for p in datos["posts"]]


@pytest.mark.asyncio
async def test_encuentra_por_etiqueta_aunque_el_texto_no_lo_diga(entorno):
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(
            Post(
                id=_id(500, "dddddddd"),
                author_id=BRUNO,
                body="Mira cómo quedó",
                status="published",
                visibility="public",
            )
        )
        db.add(Hashtag(id=_id(1, "aaaabbbb"), tag="melamina", display_tag="Melamina"))
        await db.flush()
        db.add(
            PostHashtag(
                post_id=_id(500, "dddddddd"), hashtag_id=_id(1, "aaaabbbb")
            )
        )
        await db.commit()

    datos = await _buscar(http, "melamina")
    assert _id(500, "dddddddd") in [p["id"] for p in datos["posts"]]
    assert "melamina" in [h["tag"] for h in datos["hashtags"]]


# --------------------------------------------------------------------------- #
# La busqueda no depende del recomendador
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_busqueda_funciona_con_la_capa_de_temas_caida(entorno, monkeypatch):
    """OBLIGATORIO: buscar no puede depender de que el recomendador este sano.

    Se simula el peor caso: la deteccion de temas revienta. Lo que se pierde es
    la inferencia («muebles» ya no lleva a carpinteria); lo que se conserva es
    todo lo lexico, que es la mayor parte de lo que la gente busca.
    """
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(
            Post(
                id=_id(600, "dddddddd"),
                author_id=BRUNO,
                body="Vendo herramientas de carpintería usadas",
                status="published",
                visibility="public",
            )
        )
        db.add(
            Course(
                id=_id(600, "eeeeeeee"),
                author_id=BRUNO,
                title="Carpintería desde cero",
                description="Empieza hoy.",
                status="published",
            )
        )
        await db.commit()

    async def _revienta(*_a, **_k):
        raise RuntimeError("el recomendador esta caido")

    monkeypatch.setattr(temas, "detectar", _revienta)

    datos = await _buscar(http, "carpintería")
    assert datos["topics"] == []
    assert _id(600, "dddddddd") in [p["id"] for p in datos["posts"]]
    assert _id(600, "eeeeeeee") in [c["id"] for c in datos["courses"]]
    assert BRUNO in [p["id"] for p in datos["people"]]


@pytest.mark.asyncio
async def test_la_busqueda_funciona_sin_la_tabla_de_temas(entorno):
    """Y con la taxonomia entera ausente, que es como estaba antes de la 0026."""
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(
            Post(
                id=_id(700, "dddddddd"),
                author_id=BRUNO,
                body="Clases de carpintería los sábados",
                status="published",
                visibility="public",
            )
        )
        await db.commit()
    async with sesiones() as db:
        await db.execute(text("drop table user_topic_relations"))
        await db.execute(text("drop table post_topics"))
        await db.execute(text("drop table course_topics"))
        await db.execute(text("drop table topics"))
        await db.commit()
    esquema.olvidar()

    datos = await _buscar(http, "carpintería")
    assert _id(700, "dddddddd") in [p["id"] for p in datos["posts"]]


def test_la_busqueda_no_importa_el_servicio_del_recomendador():
    """La dependencia es una TABLA, no un servicio, y se comprueba leyendo.

    Compartir el modelo `Topic` es compartir el esquema; llamar a
    `recommendations.service` seria heredar su disponibilidad, su cache y su
    ranking. Esta prueba existe para que la diferencia no se pierda el dia que
    alguien tenga prisa.
    """
    import pathlib

    carpeta = pathlib.Path(__file__).resolve().parents[1] / "app" / "modules" / "search"
    prohibidos = (
        "recommendations.service",
        "recommendations.repository",
        "recommendations.cache",
        "recommendations import service",
        "recommendations import cache",
    )
    for fichero in carpeta.glob("*.py"):
        codigo = fichero.read_text(encoding="utf-8")
        # Solo las lineas de import: los docstrings hablan de ellos a proposito.
        lineas = [
            l for l in codigo.splitlines() if l.startswith(("import ", "from "))
        ]
        for linea in lineas:
            for prohibido in prohibidos:
                assert prohibido not in linea, f"{fichero.name}: {linea}"


# --------------------------------------------------------------------------- #
# Bloqueos y visibilidad
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_respeta_bloqueos(entorno):
    """Quien te bloqueo no aparece, ni el ni lo que publica ni lo que enseña."""
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=BRUNO, blocked_id=ANA))
        db.add(
            Post(
                id=_id(800, "dddddddd"),
                author_id=BRUNO,
                body="Taller de carpintería en casa",
                status="published",
                visibility="public",
            )
        )
        db.add(
            Course(
                id=_id(800, "eeeeeeee"),
                author_id=BRUNO,
                title="Carpintería avanzada",
                description="Uniones complejas.",
                status="published",
            )
        )
        await db.commit()

    datos = await _buscar(http, "carpintería")
    assert BRUNO not in [p["id"] for p in datos["people"]]
    assert _id(800, "dddddddd") not in [p["id"] for p in datos["posts"]]
    assert _id(800, "eeeeeeee") not in [c["id"] for c in datos["courses"]]


@pytest.mark.asyncio
async def test_respeta_la_visibilidad_de_las_publicaciones(entorno):
    """`followers` solo para quien sigue; `circle` para nadie mas que su autor."""
    http, sesiones, identidad = entorno
    async with sesiones() as db:
        db.add_all(
            [
                Post(
                    id=_id(900, "dddddddd"),
                    author_id=BRUNO,
                    body="Solo seguidores: carpintería",
                    status="published",
                    visibility="followers",
                ),
                Post(
                    id=_id(901, "dddddddd"),
                    author_id=BRUNO,
                    body="Solo mi círculo: carpintería",
                    status="published",
                    visibility="circle",
                ),
                Post(
                    id=_id(902, "dddddddd"),
                    author_id=BRUNO,
                    body="Retirada: carpintería",
                    status="archived",
                    visibility="public",
                ),
            ]
        )
        await db.commit()

    # Ana todavia no sigue a Bruno.
    sin_seguir = await _buscar(http, "carpintería")
    ids = [p["id"] for p in sin_seguir["posts"]]
    assert _id(900, "dddddddd") not in ids
    assert _id(901, "dddddddd") not in ids
    assert _id(902, "dddddddd") not in ids

    async with sesiones() as db:
        db.add(Follow(follower_id=ANA, following_id=BRUNO))
        await db.commit()

    siguiendo = await _buscar(http, "carpintería")
    ids = [p["id"] for p in siguiendo["posts"]]
    assert _id(900, "dddddddd") in ids
    # El circulo sigue sin salir: ante la duda, fuera.
    assert _id(901, "dddddddd") not in ids

    # Y su autor si la encuentra: es suya.
    identidad["uid"] = BRUNO
    propia = await _buscar(http, "carpintería")
    assert _id(901, "dddddddd") in [p["id"] for p in propia["posts"]]


@pytest.mark.asyncio
async def test_sin_sesion_solo_se_ve_lo_publico(entorno):
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(
            Post(
                id=_id(950, "dddddddd"),
                author_id=BRUNO,
                body="Solo seguidores: carpintería",
                status="published",
                visibility="followers",
            )
        )
        await db.commit()

    async def _sin_usuario() -> AuthUser | None:
        return None

    app.dependency_overrides[get_optional_user] = _sin_usuario
    try:
        datos = await _buscar(http, "carpintería")
    finally:
        app.dependency_overrides.pop(get_optional_user, None)
    assert _id(950, "dddddddd") not in [p["id"] for p in datos["posts"]]


# --------------------------------------------------------------------------- #
# Paginacion y contrato
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_paginacion_sin_duplicados_ni_huecos(entorno):
    """Tres paginas de cinco sobre doce filas: doce ids distintos y ya esta.

    El orden total (puntuacion, fecha, id) es lo que lo garantiza: sin el
    desempate por id, dos filas empatadas pueden intercambiarse entre paginas y
    entonces una se repite y otra no sale nunca.
    """
    http, sesiones, _ = entorno
    async with sesiones() as db:
        for n in range(1, 13):
            db.add(
                Post(
                    id=_id(n, "abababab"),
                    author_id=BRUNO,
                    body="carpintería para todos",
                    status="published",
                    visibility="public",
                )
            )
        await db.commit()

    vistos: list[str] = []
    salto = 0
    for _ in range(3):
        datos = await _buscar(http, "carpintería", type="posts", limit=5, offset=salto)
        vistos.extend(p["id"] for p in datos["posts"])
        siguiente = datos["next_offset"]["posts"]
        if siguiente is None:
            break
        salto = siguiente

    assert len(vistos) == 12
    assert len(set(vistos)) == 12


@pytest.mark.asyncio
async def test_el_next_offset_dice_la_verdad(entorno):
    """«Hay mas» es un hecho comprobado —se pide uno de mas—, no una suposicion."""
    http, sesiones, _ = entorno
    async with sesiones() as db:
        for n in range(1, 4):
            db.add(
                Post(
                    id=_id(n, "acacacac"),
                    author_id=BRUNO,
                    body="carpintería",
                    status="published",
                    visibility="public",
                )
            )
        await db.commit()

    lleno = await _buscar(http, "carpintería", type="posts", limit=3)
    # Vienen 3 de 3: la pagina esta LLENA pero no hay mas.
    assert len(lleno["posts"]) == 3
    assert lleno["next_offset"]["posts"] is None


@pytest.mark.asyncio
async def test_el_tipo_acota_la_respuesta_a_un_solo_grupo(entorno):
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(
            Course(
                id=_id(1000, "eeeeeeee"),
                author_id=BRUNO,
                title="Carpintería",
                description="Desde cero.",
                status="published",
            )
        )
        await db.commit()

    datos = await _buscar(http, "carpintería", type="courses")
    assert len(datos["courses"]) == 1
    assert datos["people"] == [] and datos["posts"] == []
    assert set(datos["next_offset"]) == {"courses"}


@pytest.mark.asyncio
async def test_un_tipo_inventado_no_pasa(entorno):
    http, _, _ = entorno
    respuesta = await http.get(BUSCAR, params={"q": "algo", "type": "secretos"})
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_una_consulta_sin_nada_que_buscar_responde_vacio_y_no_error(entorno):
    """«y o» no es un error de quien busca: es una respuesta vacia y un 200.

    No queda ni una palabra de dos letras, asi que no hay nada que preguntarle a
    la base y se ahorran los cinco recorridos de tabla. Un 400 aqui seria
    culpar a quien escribio dos letras.
    """
    http, _, _ = entorno
    datos = await _buscar(http, "y o")
    assert datos["people"] == [] and datos["posts"] == [] and datos["courses"] == []
    assert datos["next_offset"] == {}


@pytest.mark.asyncio
async def test_una_consulta_de_solo_conectores_busca_igual_en_vez_de_no_dar_nada(
    entorno,
):
    """DECISION DELIBERADA de `normalizacion.terminos`, y conviene fijarla.

    Si al quitar las palabras vacias no queda nada, se buscan las que habia.
    Quien escribe «de la» no sabe que existe una lista de palabras vacias: darle
    algo —lo que sea— es mejor que darle un vacio que parece una averia.
    """
    http, _, _ = entorno
    respuesta = await http.get(BUSCAR, params={"q": "de la"})
    assert respuesta.status_code == 200
    # «Carla» contiene «la»: se busca de verdad, no se devuelve vacio.
    assert CARLA in [p["id"] for p in respuesta.json()["people"]]


@pytest.mark.asyncio
async def test_los_eventos_publicados_tambien_se_encuentran(entorno):
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(
            Event(
                id=_id(1, "efefefef"),
                organizer_id=BRUNO,
                title="Feria de carpintería",
                description="Muestra de oficios.",
                location="Lima",
                status="published",
            )
        )
        await db.commit()

    datos = await _buscar(http, "carpintería")
    assert _id(1, "efefefef") in [e["id"] for e in datos["events"]]
