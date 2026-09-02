"""Cuantas veces se guardo una publicacion: el numero, y solo el numero.

LO QUE SE REPORTO. Al guardar salia el aviso pero la tarjeta no cambiaba, y no
habia forma de saber cuanta gente habia guardado algo: el dato existia en
`saved_posts` desde el primer dia —es la tabla del boton de guardar— pero no lo
leia nadie. Lo que faltaba no era una tabla, era contarla.

POR ESO NO HAY MIGRACION. `saved_posts` ya esta en `content/models.py` y sus
filas ya se escriben desde `/posts/{id}/save`. Anadir una columna
`saves_count` a `posts` habria significado un contador desnormalizado que hay
que mantener a mano en dos endpoints y que se desincroniza en cuanto uno falle.

LAS CUATRO COSAS QUE SE FIJAN AQUI
----------------------------------
1. El numero sale en el muro Y en el detalle (y en guardados, y en el perfil).
2. NO hay N+1: una publicacion o setenta y cinco cuestan las mismas consultas,
   porque el contador de la pagina entera se resuelve con un solo GROUP BY.
3. Guardar dos veces no suma dos: la fila ya existe y no se duplica.
4. QUIEN guardo no se expone. Ni en la respuesta, ni por una ruta aparte.
   Reaccionar es publico —hay /posts/{id}/likes— y guardar no lo es.
"""

from __future__ import annotations

from uuid import uuid4

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.content.models import Post, SavedPost
from app.modules.profiles.models import Profile
from app.shared.database import Base, get_db

POSTS = "/api/v1/posts"
GUARDADOS = "/api/v1/saved-posts"

ANA = "cccccccc-0000-0000-0000-000000000001"
BRUNO = "cccccccc-0000-0000-0000-000000000002"
CARLA = "cccccccc-0000-0000-0000-000000000003"


@pytest_asyncio.fixture
async def entorno():
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
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(Profile(id=CARLA, full_name="Carla", username="carla"))
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
    app.dependency_overrides[get_optional_user] = _usuario_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    await engine.dispose()


async def _sembrar(sesiones, cuantas: int, guardan: list[str] | None = None) -> list[str]:
    """Publicaciones de Ana; `guardan` es quien guarda LA PRIMERA."""
    ids: list[str] = []
    async with sesiones() as db:
        for numero in range(cuantas):
            post = Post(
                id=str(uuid4()), author_id=ANA, body=f"post {numero}", status="published"
            )
            db.add(post)
            ids.append(post.id)
        await db.flush()
        for quien in guardan or []:
            db.add(SavedPost(post_id=ids[0], user_id=quien))
        await db.commit()
    return ids


def _escuchar(sesiones):
    """(consultas, quitar) para contar el SQL de verdad, no el que se cree."""
    consultas: list[str] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        consultas.append(statement)

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    return consultas, lambda: event.remove(motor, "before_cursor_execute", _anotar)


# --------------------------------------------------------------------------- #
# 1. El numero llega a donde se pinta
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_muro_trae_cuantas_veces_se_guardo_cada_publicacion(entorno):
    http, sesiones, _ = entorno
    ids = await _sembrar(sesiones, 2, guardan=[BRUNO, CARLA])

    respuesta = await http.get(f"{POSTS}?limit=10&offset=0")
    assert respuesta.status_code == 200, respuesta.text
    por_id = {p["id"]: p for p in respuesta.json()}
    assert por_id[ids[0]]["saves_count"] == 2
    # La que no ha guardado nadie dice cero, no se queda sin campo: el movil
    # pinta un numero, no un hueco.
    assert por_id[ids[1]]["saves_count"] == 0


@pytest.mark.asyncio
async def test_el_detalle_trae_el_mismo_numero_que_el_muro(entorno):
    """Abrir la publicacion no puede hacer desaparecer el contador.

    Es la misma fila de acciones: si el detalle dijera cero, la persona veria
    el numero cambiar solo por haber tocado la tarjeta.
    """
    http, sesiones, _ = entorno
    ids = await _sembrar(sesiones, 1, guardan=[BRUNO, CARLA])

    detalle = await http.get(f"{POSTS}/{ids[0]}")
    assert detalle.status_code == 200, detalle.text
    assert detalle.json()["saves_count"] == 2


@pytest.mark.asyncio
async def test_la_lista_de_guardados_trae_el_total_no_el_propio(entorno):
    """En «Guardados» todo esta guardado por quien mira: el uno seria inutil.

    Lo que interesa es cuanta gente MAS lo guardo.
    """
    http, sesiones, _ = entorno
    ids = await _sembrar(sesiones, 1, guardan=[BRUNO, CARLA])
    assert (await http.post(f"{POSTS}/{ids[0]}/save")).status_code == 200

    lista = await http.get(GUARDADOS)
    assert lista.status_code == 200, lista.text
    datos = lista.json()
    assert len(datos) == 1
    assert datos[0]["saves_count"] == 3
    assert datos[0]["saved_by_me"] is True


@pytest.mark.asyncio
async def test_el_muro_de_un_perfil_tambien_lo_trae(entorno):
    http, sesiones, _ = entorno
    ids = await _sembrar(sesiones, 1, guardan=[BRUNO])

    respuesta = await http.get(f"{POSTS}?author_id={ANA}&limit=10&offset=0")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()[0]["saves_count"] == 1
    assert ids[0] == respuesta.json()[0]["id"]


# --------------------------------------------------------------------------- #
# 2. Sin N+1: la pagina entera en una consulta agrupada
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_contar_los_guardados_no_depende_del_tamano_de_la_pagina(entorno):
    """Cinco publicaciones y setenta y cinco cuestan LAS MISMAS consultas.

    Es la comprobacion de que el contador no se pide una vez por publicacion.
    Con un `SELECT` por fila esta prueba veria setenta consultas de diferencia.
    """
    http, sesiones, _ = entorno
    await _sembrar(sesiones, 75, guardan=[BRUNO, CARLA])

    # Una peticion de calentamiento ANTES de medir: la primera del proceso paga
    # ademas las comprobaciones de esquema (¿existe la tabla de
    # republicaciones? ¿la de hashtags?), que se recuerdan y no se repiten. Sin
    # esto se estaria comparando «la primera» contra «las demas» en vez de
    # cinco publicaciones contra setenta y cinco.
    await http.get(f"{POSTS}?limit=1&offset=0")

    consultas, quitar = _escuchar(sesiones)
    try:
        pocas = await http.get(f"{POSTS}?limit=5&offset=0")
        con_5 = len(consultas)
        consultas.clear()
        muchas = await http.get(f"{POSTS}?limit=75&offset=0")
        con_75 = len(consultas)
    finally:
        quitar()

    assert pocas.status_code == 200 and muchas.status_code == 200
    assert len(muchas.json()) == 75
    assert con_5 == con_75, (
        f"{con_5} consultas con 5 publicaciones y {con_75} con 75: "
        "el numero de consultas no puede crecer con la pagina"
    )


@pytest.mark.asyncio
async def test_el_contador_se_resuelve_con_una_sola_consulta_agrupada(entorno):
    """UNA consulta a `saved_posts` para toda la pagina, y lleva GROUP BY."""
    http, sesiones, _ = entorno
    await _sembrar(sesiones, 20, guardan=[BRUNO, CARLA])

    consultas, quitar = _escuchar(sesiones)
    try:
        respuesta = await http.get(f"{POSTS}?limit=20&offset=0")
    finally:
        quitar()
    assert respuesta.status_code == 200

    agrupadas = [
        sql
        for sql in consultas
        if "saved_posts" in sql and "group by" in sql.lower()
    ]
    assert len(agrupadas) == 1, (
        f"se esperaba una sola consulta agrupada sobre saved_posts, hubo "
        f"{len(agrupadas)}"
    )
    assert "count(" in agrupadas[0].lower()


# --------------------------------------------------------------------------- #
# 3. Guardar es idempotente
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_guardar_dos_veces_no_suma_dos(entorno):
    """El boton se puede pulsar dos veces; el numero no se puede inventar una.

    Tambien cubre el reintento de una red lenta: la peticion que llega
    duplicada no puede dejar dos filas.
    """
    http, sesiones, _ = entorno
    ids = await _sembrar(sesiones, 1)

    assert (await http.post(f"{POSTS}/{ids[0]}/save")).status_code == 200
    assert (await http.post(f"{POSTS}/{ids[0]}/save")).status_code == 200

    detalle = await http.get(f"{POSTS}/{ids[0]}")
    assert detalle.json()["saves_count"] == 1


@pytest.mark.asyncio
async def test_quitar_de_guardados_resta_y_nunca_baja_de_cero(entorno):
    http, sesiones, _ = entorno
    ids = await _sembrar(sesiones, 1, guardan=[BRUNO])

    await http.post(f"{POSTS}/{ids[0]}/save")
    assert (await http.get(f"{POSTS}/{ids[0]}")).json()["saves_count"] == 2

    # Quitar dos veces: la segunda no tiene nada que borrar y no puede dejar
    # el contador por debajo de lo que hay en la tabla.
    assert (await http.delete(f"{POSTS}/{ids[0]}/save")).status_code == 200
    assert (await http.delete(f"{POSTS}/{ids[0]}/save")).status_code == 200
    assert (await http.get(f"{POSTS}/{ids[0]}")).json()["saves_count"] == 1


# --------------------------------------------------------------------------- #
# 4. Quien guardo NO se expone
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_publicacion_no_dice_quien_la_guardo(entorno):
    """Solo el numero y `saved_by_me`, que habla de quien pregunta.

    Reaccionar es publico y tiene su lista (/posts/{id}/likes). Guardar es
    apartar algo para uno mismo: publicar quien lo hizo seria delatar algo que
    nadie eligio contar.
    """
    http, sesiones, _ = entorno
    ids = await _sembrar(sesiones, 1, guardan=[BRUNO, CARLA])

    datos = (await http.get(f"{POSTS}/{ids[0]}")).json()
    assert datos["saves_count"] == 2
    crudo = str(datos)
    assert BRUNO not in crudo and CARLA not in crudo
    assert "bruno" not in crudo and "carla" not in crudo
    # Y ninguna clave que suene a lista de personas que guardaron.
    assert not [k for k in datos if k.startswith("saved_by") and k != "saved_by_me"]
    assert "savers" not in datos and "saved_by_users" not in datos


@pytest.mark.asyncio
async def test_no_existe_una_ruta_que_liste_quien_guardo(entorno):
    """El equivalente de /likes para guardados NO puede existir."""
    http, sesiones, _ = entorno
    ids = await _sembrar(sesiones, 1, guardan=[BRUNO, CARLA])

    rutas = {r.path for r in app.routes if hasattr(r, "path")}
    assert "/api/v1/posts/{post_id}/saves" not in rutas
    assert "/api/v1/posts/{post_id}/saved-by" not in rutas
    assert (await http.get(f"{POSTS}/{ids[0]}/saves")).status_code == 404


@pytest.mark.asyncio
async def test_quien_no_ha_entrado_ve_el_numero_pero_no_estado_propio(entorno):
    """El contador es publico; `saved_by_me` sin sesion es falso, no un error."""
    http, sesiones, _ = entorno
    ids = await _sembrar(sesiones, 1, guardan=[BRUNO, CARLA])
    app.dependency_overrides.pop(get_optional_user, None)

    datos = (await http.get(f"{POSTS}/{ids[0]}")).json()
    assert datos["saves_count"] == 2
    assert datos["saved_by_me"] is False
