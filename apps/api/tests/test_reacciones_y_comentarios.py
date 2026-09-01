"""Dar «me gusta» y comentar. Las dos acciones mas usadas de Z, sin una prueba.

POR QUE EXISTE ESTE FICHERO. Las dos rutas leian `current_user.full_name` para
poner el nombre en el aviso, y `AuthUser` NO tiene ese campo: solo `id`,
`email`, `role` y `claims`. La identidad sale del token, y el token no lleva el
nombre del perfil.

Lo que hacia que no se viera:

  1. El error salta DESPUES del `commit`. El «me gusta» se guardaba de verdad,
     asi que al recargar estaba ahi y parecia un fallo pasajero de la red.
  2. Starlette no pone cabeceras CORS en las excepciones sin capturar, asi que
     el navegador no enseña «error 500» sino un error de CORS, que manda a
     mirar la configuracion del servidor en vez del codigo.
  3. Ninguna prueba llamaba a estos dos endpoints.

Las tres cosas juntas son la receta de un fallo que sobrevive meses. Estas
pruebas cierran la tercera.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.content import router as content_router
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

POSTS = "/api/v1/posts"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
# Una tercera para separar «autor de la publicacion» de «autor del comentario».
CARLA = "aaaaaaaa-0000-0000-0000-000000000003"


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
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    await engine.dispose()


@pytest.fixture
def avisos(monkeypatch):
    """Retiene los avisos en vez de mandarlos, para poder mirarlos por dentro.

    Se parchea `encolar_push` en el modulo del router y no en el suyo propio
    porque el router lo importo por nombre (`from ... import encolar_push`): a
    partir de ese momento su copia es la que se llama, y cambiar el original no
    tendria efecto.

    `encolar_push` es SINCRONA —solo programa la tarea— porque el envio ya no
    ocurre dentro de la peticion: esperaba a `exp.host` con la conexion a la
    base ocupada. Aqui se retiene lo que se habria programado.

    Lo que se vigila con esto NO es que salga el push, sino DE DONDE sale el
    nombre. Es el unico dato del aviso que no venia en la peticion y hay que ir
    a buscarlo, o sea el unico que se puede buscar en el sitio equivocado.
    Volver a leerlo del token pasaria las pruebas de mas abajo sin despeinarse,
    porque el endpoint seguiria devolviendo 200.
    """
    capturados: list[dict] = []

    def _retener(background, **kwargs):
        capturados.append(kwargs)

    monkeypatch.setattr(content_router, "encolar_push", _retener)
    return capturados


async def _publicacion_de_bruno(http: AsyncClient, identidad: dict) -> str:
    """Publica Bruno. El aviso solo existe si quien reacciona es OTRO."""
    identidad["uid"] = BRUNO
    respuesta = await http.post(POSTS, json={"body": "Algo que contar"})
    assert respuesta.status_code == 201, respuesta.text
    identidad["uid"] = ANA
    return respuesta.json()["id"]


@pytest.mark.asyncio
async def test_dar_me_gusta_a_la_publicacion_de_otro_no_revienta(entorno):
    """El caso exacto que fallaba: hay a quien avisar, asi que se pide el nombre."""
    http, _, identidad = entorno
    post_id = await _publicacion_de_bruno(http, identidad)

    respuesta = await http.post(f"{POSTS}/{post_id}/like")

    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["liked"] is True
    assert respuesta.json()["likes_count"] == 1


@pytest.mark.asyncio
async def test_comentar_la_publicacion_de_otro_no_revienta(entorno):
    http, _, identidad = entorno
    post_id = await _publicacion_de_bruno(http, identidad)

    respuesta = await http.post(
        f"{POSTS}/{post_id}/comments", json={"body": "Muy bueno"}
    )

    assert respuesta.status_code in (200, 201), respuesta.text
    assert respuesta.json()["body"] == "Muy bueno"


@pytest.mark.asyncio
async def test_quitar_el_me_gusta_y_volver_a_darlo(entorno):
    """Repetir la accion tampoco puede fallar: es lo que hace la gente."""
    http, _, identidad = entorno
    post_id = await _publicacion_de_bruno(http, identidad)

    assert (await http.post(f"{POSTS}/{post_id}/like")).status_code == 200
    assert (await http.delete(f"{POSTS}/{post_id}/like")).status_code == 200
    otra_vez = await http.post(f"{POSTS}/{post_id}/like")
    assert otra_vez.status_code == 200, otra_vez.text
    assert otra_vez.json()["likes_count"] == 1


@pytest.mark.asyncio
async def test_darse_me_gusta_a_uno_mismo_tampoco_revienta(entorno):
    """Sin aviso que mandar, pero la ruta es la misma y tiene que responder."""
    http, _, _ = entorno
    creada = await http.post(POSTS, json={"body": "Lo mio"})
    post_id = creada.json()["id"]

    respuesta = await http.post(f"{POSTS}/{post_id}/like")
    assert respuesta.status_code == 200, respuesta.text


# --------------------------------------------------------------------------- #
# De donde sale el nombre del aviso
# --------------------------------------------------------------------------- #
#
# Las pruebas de arriba comprueban que la ruta no revienta. Estas comprueban lo
# otro, que es lo que de verdad se rompio: que el nombre venga del PERFIL.
# Distinguir una cosa de otra importa porque leer el nombre del sitio
# equivocado no siempre revienta —si el campo existiera en `AuthUser`, la ruta
# respondaria 200 tan feliz— y entonces solo se notaria en el movil de otra
# persona, en un aviso con el nombre cambiado o viejo.


@pytest.mark.asyncio
async def test_el_aviso_del_me_gusta_lleva_el_nombre_del_perfil(entorno, avisos):
    """«Ana» esta en `profiles`; en la identidad del token no hay ningun nombre."""
    http, _, identidad = entorno
    post_id = await _publicacion_de_bruno(http, identidad)

    assert (await http.post(f"{POSTS}/{post_id}/like")).status_code == 200

    assert len(avisos) == 1, avisos
    assert avisos[0]["notification_type"] == "like"
    assert avisos[0]["user_ids"] == [BRUNO]
    assert avisos[0]["actor_name"] == "Ana"


@pytest.mark.asyncio
async def test_el_aviso_del_comentario_lleva_el_nombre_del_perfil(entorno, avisos):
    http, _, identidad = entorno
    post_id = await _publicacion_de_bruno(http, identidad)

    respuesta = await http.post(f"{POSTS}/{post_id}/comments", json={"body": "Va"})
    assert respuesta.status_code in (200, 201), respuesta.text

    assert len(avisos) == 1, avisos
    assert avisos[0]["notification_type"] == "comment"
    assert avisos[0]["user_ids"] == [BRUNO]
    assert avisos[0]["actor_name"] == "Ana"


@pytest.mark.asyncio
async def test_el_nombre_del_aviso_se_lee_al_avisar_y_no_es_una_foto_antigua(
    entorno, avisos
):
    """Cambiar de nombre tiene efecto en el siguiente aviso, no dentro de una hora.

    Esta es la prueba que sujeta la decision de NO meter `full_name` en
    `AuthUser`. Un dato sacado del token seria el del momento en que se emitio,
    y el token dura una hora larga: quien se cambie el nombre seguiria firmando
    los avisos con el anterior hasta que le tocara renovar. Leyendolo del perfil
    al momento de avisar, no hay ventana en la que el aviso mienta.
    """
    http, sesiones, identidad = entorno
    post_id = await _publicacion_de_bruno(http, identidad)

    async with sesiones() as db:
        ana = await db.get(Profile, ANA)
        ana.full_name = "Ana Torres"
        await db.commit()

    assert (await http.post(f"{POSTS}/{post_id}/like")).status_code == 200

    assert avisos[0]["actor_name"] == "Ana Torres"


# --------------------------------------------------------------------------- #
# Respuestas a comentarios
# --------------------------------------------------------------------------- #
#
# `comments.parent_id` existia desde la 0001 y NADIE lo validaba: llegaba del
# cliente y se guardaba tal cual. Con eso se podia colgar una respuesta de un
# comentario de OTRA publicacion —dos hilos mezclados— o de un id que no
# existe, que deja una fila que ninguna pantalla sabe pintar.


async def _comentario(http: AsyncClient, post_id: str, texto: str, padre=None) -> dict:
    cuerpo: dict = {"body": texto}
    if padre is not None:
        cuerpo["parent_id"] = padre
    respuesta = await http.post(f"{POSTS}/{post_id}/comments", json=cuerpo)
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()


@pytest.mark.asyncio
async def test_una_respuesta_se_guarda_colgada_de_su_comentario(entorno):
    http, _, identidad = entorno
    post_id = await _publicacion_de_bruno(http, identidad)
    raiz = await _comentario(http, post_id, "El primero")

    respuesta = await _comentario(http, post_id, "Te respondo", padre=raiz["id"])

    assert respuesta["parent_id"] == raiz["id"]


@pytest.mark.asyncio
async def test_un_comentario_normal_sigue_sin_padre(entorno):
    """Lo de siempre no cambia: sin `parent_id`, la fila queda con null."""
    http, _, identidad = entorno
    post_id = await _publicacion_de_bruno(http, identidad)

    assert (await _comentario(http, post_id, "Suelto"))["parent_id"] is None


@pytest.mark.asyncio
async def test_responder_a_un_comentario_que_no_existe_no_se_guarda(entorno):
    http, _, identidad = entorno
    post_id = await _publicacion_de_bruno(http, identidad)

    respuesta = await http.post(
        f"{POSTS}/{post_id}/comments",
        json={"body": "A la nada", "parent_id": "aaaaaaaa-0000-0000-0000-00000000dead"},
    )

    assert respuesta.status_code == 404, respuesta.text
    assert (await http.get(f"{POSTS}/{post_id}/comments")).json() == []


@pytest.mark.asyncio
async def test_responder_con_un_padre_que_no_es_un_uuid_no_revienta(entorno):
    """Un `parent_id` con basura tiene que ser un 404, no un 500 de la base."""
    http, _, identidad = entorno
    post_id = await _publicacion_de_bruno(http, identidad)

    respuesta = await http.post(
        f"{POSTS}/{post_id}/comments", json={"body": "Hola", "parent_id": "no-es-uuid"}
    )

    assert respuesta.status_code == 404, respuesta.text


@pytest.mark.asyncio
async def test_no_se_puede_colgar_una_respuesta_de_otra_publicacion(entorno):
    """El caso que mezclaba hilos: el padre existe, pero no vive aqui."""
    http, _, identidad = entorno
    una = await _publicacion_de_bruno(http, identidad)
    otra = await _publicacion_de_bruno(http, identidad)
    ajeno = await _comentario(http, otra, "En la otra")

    respuesta = await http.post(
        f"{POSTS}/{una}/comments", json={"body": "Colandome", "parent_id": ajeno["id"]}
    )

    assert respuesta.status_code == 404, respuesta.text


@pytest.mark.asyncio
async def test_responder_a_una_respuesta_cuelga_del_mismo_raiz(entorno):
    """UN SOLO NIVEL, y decidido en el servidor.

    Si el limite viviera solo en la pantalla, cada superficie tendria que
    repetirlo y la fila guardada seguiria pudiendo tener profundidad diez.
    """
    http, _, identidad = entorno
    post_id = await _publicacion_de_bruno(http, identidad)
    raiz = await _comentario(http, post_id, "El primero")
    primera = await _comentario(http, post_id, "Respondo", padre=raiz["id"])

    segunda = await _comentario(http, post_id, "Y yo", padre=primera["id"])

    assert segunda["parent_id"] == raiz["id"]


@pytest.mark.asyncio
async def test_responder_avisa_al_autor_del_comentario_y_al_de_la_publicacion(
    entorno, avisos
):
    """Dos personas distintas, dos avisos distintos: cada una se entera de lo suyo."""
    http, _, identidad = entorno
    # Publica una tercera persona para que autor y comentarista no coincidan.
    post_id = await _publicacion_de_bruno(http, identidad)
    identidad["uid"] = CARLA
    raiz = await _comentario(http, post_id, "Digo yo")
    identidad["uid"] = ANA
    avisos.clear()

    await _comentario(http, post_id, "Te respondo", padre=raiz["id"])

    por_tipo = {a["notification_type"]: a for a in avisos}
    assert set(por_tipo) == {"comment", "comment_reply"}
    assert por_tipo["comment"]["user_ids"] == [BRUNO]
    assert por_tipo["comment_reply"]["user_ids"] == [CARLA]


@pytest.mark.asyncio
async def test_si_el_autor_comento_lo_suyo_solo_recibe_un_aviso(entorno, avisos):
    """Un comentario no puede poner dos filas en la misma bandeja."""
    http, _, identidad = entorno
    post_id = await _publicacion_de_bruno(http, identidad)
    identidad["uid"] = BRUNO
    raiz = await _comentario(http, post_id, "Lo mio, comentado por mi")
    identidad["uid"] = ANA
    avisos.clear()

    await _comentario(http, post_id, "Te respondo", padre=raiz["id"])

    assert [a["notification_type"] for a in avisos] == ["comment_reply"]
    assert avisos[0]["user_ids"] == [BRUNO]


@pytest.mark.asyncio
async def test_responderse_a_uno_mismo_no_se_avisa_a_uno_mismo(entorno, avisos):
    http, _, _ = entorno
    creada = await http.post(POSTS, json={"body": "Lo mio"})
    post_id = creada.json()["id"]
    raiz = await _comentario(http, post_id, "Me contesto solo")
    avisos.clear()

    await _comentario(http, post_id, "Efectivamente", padre=raiz["id"])

    assert avisos == []


@pytest.mark.asyncio
async def test_comentar_lo_propio_tampoco_manda_push(entorno, avisos):
    """`add_notification` ya se callaba, pero el push salia igual.

    Se programaba sin mirar si el aviso llego a escribirse, asi que comentar tu
    propia publicacion te hacia sonar el telefono a ti.
    """
    http, _, _ = entorno
    creada = await http.post(POSTS, json={"body": "Lo mio"})

    await _comentario(http, creada.json()["id"], "Y me comento")

    assert avisos == []
