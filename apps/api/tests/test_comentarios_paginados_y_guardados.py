"""Leer comentarios con la lista larga, y los guardados como hecho del servidor.

DOS COSAS QUE SE VEIAN BIEN CON TRES FILAS Y MAL CON CIEN.

1. Los comentarios se ordenaban de antiguo a nuevo y se recortaban con `limit`.
   Con 100 comentarios, el movil pedia 20 y recibia los 20 MAS ANTIGUOS: lo
   recien escrito no aparecia por ningun lado y no habia forma de llegar a el
   sin recorrer todas las paginas. Con tres comentarios de prueba el fallo no
   existe, y por eso sobrevivio.

2. Los guardados no se listaban desde ningun sitio: el movil cruzaba una lista
   de ids del telefono con el muro que tuviera en memoria. Se perdian al
   reinstalar, no se compartian entre dispositivos y podian seguir ensenando
   una publicacion ya retirada.

Las pruebas de abajo son las que impiden que las dos vuelvan.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.content.models import Comment
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

POSTS = "/api/v1/posts"
GUARDADOS = "/api/v1/saved-posts"

ANA = "bbbbbbbb-0000-0000-0000-000000000001"
BRUNO = "bbbbbbbb-0000-0000-0000-000000000002"


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
        from app.modules.notifications import device_tokens as _dt  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana", avatar_path="ana/foto.jpg"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

    async def _usuario_override() -> AuthUser:
        return AuthUser(
            id=identidad["uid"], email="quien@ejemplo.com", role="authenticated"
        )

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    await engine.dispose()


async def _publicar(http: AsyncClient, texto: str = "Algo que contar", media=None) -> str:
    cuerpo: dict = {"body": texto}
    if media:
        cuerpo["media"] = media
    respuesta = await http.post(POSTS, json=cuerpo)
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()["id"]


# --------------------------------------------------------------------------- #
# Comentarios: la lista larga
# --------------------------------------------------------------------------- #
async def _sembrar_comentarios(sesiones, post_id: str, cuantos: int, por_instante: int = 1):
    """Comentarios con la fecha PUESTA A MANO, no la del reloj.

    Hace falta porque en SQLite `now()` tiene resolucion de segundo: dejando la
    fecha a la base de datos, cien comentarios comparten instante y el orden lo
    acabaria decidiendo el azar de los uuid. Entonces la prueba pasaria o
    fallaria segun el sorteo, que es peor que no tenerla.

    `por_instante` sirve para lo contrario: forzar empates a proposito y
    comprobar que el desempate por id sostiene la paginacion.
    """
    inicio = datetime(2026, 1, 1, 12, 0, 0)
    async with sesiones() as db:
        for numero in range(cuantos):
            db.add(
                Comment(
                    post_id=post_id,
                    author_id=ANA,
                    body=f"comentario {numero}",
                    created_at=inicio + timedelta(seconds=numero // por_instante),
                )
            )
        await db.commit()


@pytest.mark.asyncio
async def test_la_primera_pagina_trae_lo_ultimo_que_se_escribio(entorno):
    """El caso exacto que fallaba: 50 comentarios y una pagina de 20."""
    http, sesiones, _ = entorno
    post_id = await _publicar(http)
    await _sembrar_comentarios(sesiones, post_id, 50)

    pagina = await http.get(f"{POSTS}/{post_id}/comments?limit=20")

    assert pagina.status_code == 200, pagina.text
    cuerpos = [c["body"] for c in pagina.json()]
    assert len(cuerpos) == 20
    assert cuerpos[0] == "comentario 49", (
        "la primera pagina no empieza por lo ultimo escrito: es el bug "
        "reportado, la lista sigue ordenada de antiguo a nuevo"
    )
    assert "comentario 0" not in cuerpos


@pytest.mark.asyncio
async def test_cien_comentarios_se_recorren_enteros_sin_duplicados(entorno):
    """Paginar con cursor tiene que cubrirlo todo y no repetir nada.

    Los cien van de DOS en DOS por instante: asi la mitad de los saltos de
    pagina caen sobre un empate de fecha y el desempate por id es lo que de
    verdad se esta probando. Sin el, el cursor se saltaria filas o las
    repetiria en cada empate.
    """
    http, sesiones, _ = entorno
    post_id = await _publicar(http)
    await _sembrar_comentarios(sesiones, post_id, 100, por_instante=2)

    vistos: list[str] = []
    cursor = ""
    for _ in range(20):  # tope de seguridad; con limit=20 bastan 5 vueltas
        pagina = await http.get(f"{POSTS}/{post_id}/comments?limit=20{cursor}")
        assert pagina.status_code == 200, pagina.text
        lote = pagina.json()
        if not lote:
            break
        vistos.extend(c["id"] for c in lote)
        ultimo = lote[-1]
        cursor = (
            f"&before_created_at={ultimo['created_at']}&before_id={ultimo['id']}"
        )

    assert len(vistos) == 100, f"no se recorrieron los cien: {len(vistos)}"
    assert len(set(vistos)) == 100, "la paginacion repite comentarios"


@pytest.mark.asyncio
async def test_leer_comentarios_no_pide_cuenta(entorno):
    """La lectura es publica y sigue siendolo: es la regla actual, no se cambia."""
    http, _, _ = entorno
    post_id = await _publicar(http)
    await http.post(f"{POSTS}/{post_id}/comments", json={"body": "hola"})

    # Se retira la identidad: la ruta no declara `get_current_user`, asi que
    # sin ella tiene que seguir respondiendo.
    app.dependency_overrides.pop(get_current_user, None)
    publico = await http.get(f"{POSTS}/{post_id}/comments")

    assert publico.status_code == 200, publico.text
    assert len(publico.json()) == 1


@pytest.mark.asyncio
async def test_el_contador_de_la_publicacion_sube_al_comentar(entorno):
    """Lo que ve quien vuelve al muro despues de comentar."""
    http, _, _ = entorno
    post_id = await _publicar(http)

    antes = (await http.get(f"{POSTS}/{post_id}")).json()["comments_count"]
    await http.post(f"{POSTS}/{post_id}/comments", json={"body": "uno"})
    await http.post(f"{POSTS}/{post_id}/comments", json={"body": "dos"})
    despues = (await http.get(f"{POSTS}/{post_id}")).json()["comments_count"]

    assert antes == 0
    assert despues == 2


@pytest.mark.asyncio
async def test_el_comentario_trae_el_avatar_de_quien_lo_escribio(entorno):
    """Sin esto la lista pinta el mismo marcador para todo el mundo."""
    http, _, _ = entorno
    post_id = await _publicar(http)

    creado = await http.post(f"{POSTS}/{post_id}/comments", json={"body": "hola"})
    listado = await http.get(f"{POSTS}/{post_id}/comments")

    assert creado.json()["author"]["avatar_path"] == "ana/foto.jpg"
    assert listado.json()[0]["author"]["avatar_path"] == "ana/foto.jpg"


@pytest.mark.asyncio
async def test_comentar_en_una_publicacion_que_no_existe_da_404(entorno):
    """Es el 404 que el movil conservaba como si el comentario fuera real."""
    http, _, _ = entorno
    inexistente = "bbbbbbbb-0000-0000-0000-0000000000ff"

    respuesta = await http.post(f"{POSTS}/{inexistente}/comments", json={"body": "x"})

    assert respuesta.status_code == 404, respuesta.text


# --------------------------------------------------------------------------- #
# Guardados: el hecho vive en el servidor
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_lo_guardado_se_puede_volver_a_pedir(entorno):
    """La prueba de que ya no hace falta la lista del telefono."""
    http, _, identidad = entorno
    identidad["uid"] = BRUNO
    de_bruno = await _publicar(http, "De Bruno")
    otra_de_bruno = await _publicar(http, "Otra de Bruno")
    identidad["uid"] = ANA

    assert (await http.post(f"{POSTS}/{de_bruno}/save")).status_code == 200
    listado = await http.get(GUARDADOS)

    assert listado.status_code == 200, listado.text
    ids = [p["id"] for p in listado.json()]
    assert ids == [de_bruno]
    assert otra_de_bruno not in ids
    assert listado.json()[0]["saved_by_me"] is True


@pytest.mark.asyncio
async def test_los_guardados_son_de_quien_pregunta(entorno):
    """Guardar es privado: lo de Ana no aparece en la lista de Bruno."""
    http, _, identidad = entorno
    post_id = await _publicar(http, "Publica")
    await http.post(f"{POSTS}/{post_id}/save")

    identidad["uid"] = BRUNO
    de_bruno = await http.get(GUARDADOS)

    assert de_bruno.status_code == 200, de_bruno.text
    assert de_bruno.json() == []


@pytest.mark.asyncio
async def test_lo_retirado_desaparece_de_los_guardados(entorno):
    """Uno de los tres motivos por los que la lista local mentia."""
    http, _, identidad = entorno
    identidad["uid"] = BRUNO
    post_id = await _publicar(http, "Se va a borrar")
    identidad["uid"] = ANA
    await http.post(f"{POSTS}/{post_id}/save")
    assert len((await http.get(GUARDADOS)).json()) == 1

    identidad["uid"] = BRUNO
    assert (await http.delete(f"{POSTS}/{post_id}")).status_code in (200, 204)
    identidad["uid"] = ANA

    assert (await http.get(GUARDADOS)).json() == []


@pytest.mark.asyncio
async def test_los_guardados_se_filtran_por_tipo_de_medio(entorno):
    """Es lo que necesita «Mis Audios»: los audios guardados y nada mas."""
    http, _, _ = entorno
    con_audio = await _publicar(
        http, "Episodio", media=[{"storage_path": "a/uno.m4a", "media_type": "audio"}]
    )
    con_foto = await _publicar(
        http, "Foto", media=[{"storage_path": "a/uno.jpg", "media_type": "image"}]
    )
    await http.post(f"{POSTS}/{con_audio}/save")
    await http.post(f"{POSTS}/{con_foto}/save")

    audios = await http.get(f"{GUARDADOS}?media=audio")

    assert audios.status_code == 200, audios.text
    assert [p["id"] for p in audios.json()] == [con_audio]
    assert len((await http.get(GUARDADOS)).json()) == 2


@pytest.mark.asyncio
async def test_los_guardados_se_paginan(entorno):
    """No se traen mil de golpe."""
    http, _, _ = entorno
    ids = [await _publicar(http, f"n{i}") for i in range(5)]
    for post_id in ids:
        await http.post(f"{POSTS}/{post_id}/save")

    primera = await http.get(f"{GUARDADOS}?limit=2&offset=0")
    segunda = await http.get(f"{GUARDADOS}?limit=2&offset=2")

    assert len(primera.json()) == 2
    assert len(segunda.json()) == 2
    assert set(p["id"] for p in primera.json()).isdisjoint(
        p["id"] for p in segunda.json()
    )


@pytest.mark.asyncio
async def test_desguardar_lo_saca_de_la_lista(entorno):
    http, _, _ = entorno
    post_id = await _publicar(http)
    await http.post(f"{POSTS}/{post_id}/save")

    await http.delete(f"{POSTS}/{post_id}/save")

    assert (await http.get(GUARDADOS)).json() == []
