"""Una accion logica, un aviso logico.

EL FALLO QUE SE ARREGLA. La bandeja mostraba dos veces «Luis empezo a
seguirte». No era un fallo de pintado —y por eso no se arregla con un
`unique()` sobre la lista en el cliente—: eran DOS FILAS en `notifications`.
Llegaban porque el aviso se escribia dentro de un `if existing is None` sobre
`follows`, y al dejar de seguir esa fila SE BORRA: la vez siguiente la
comprobacion volvia a decir que era la primera. El aviso viejo seguia ahi.

LO QUE SE COMPRUEBA AQUI, y en este orden de importancia:

  1. Que seguir, dejar de seguir y volver a seguir deja UN aviso.
  2. Que la garantia esta EN LA BASE: el indice unico de la 0043 rechaza la
     segunda fila aunque se intente escribir a mano, saltandose el `if`. Es la
     unica forma de cerrar la carrera de dos peticiones simultaneas.
  3. Que los eventos que SI son distintos se conservan: dos comentarios de la
     misma persona en la misma publicacion siguen siendo dos avisos.
  4. Que el aviso NOMBRA AL ACTOR, y que el nombre sale de `profiles`.
  5. Que sin la 0043 todo lo anterior sigue funcionando (con el respaldo del
     SELECT previo), porque la migracion espera aprobacion y el codigo se
     despliega antes.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.content.models import Post
from app.modules.notifications import esquema as esquema_de_avisos
from app.modules.notifications.models import Notification
from app.modules.notifications.service import add_notification, clave_de_aviso
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

AVISOS = "/api/v1/notifications"
PERFILES = "/api/v1/profiles"
POSTS = "/api/v1/posts"

ANA = "dddddddd-0000-0000-0000-000000000001"
BRUNO = "dddddddd-0000-0000-0000-000000000002"

#: Lo que hace la migracion 0043, escrito con los MISMOS `alter table` del
#: script. Se aplica en la prueba y no en `Base.metadata` porque `dedupe_key`
#: vive fuera del ORM compartido a proposito (ver `deduplicacion.py`): asi la
#: base de una prueba es, por defecto, produccion de HOY.
LA_0043 = (
    "alter table notifications add column dedupe_key text",
    "create unique index notifications_dedupe_key_uidx on notifications (dedupe_key)",
)


async def _montar(con_la_0043: bool):
    cache.vaciar()
    esquema.olvidar()
    esquema_de_avisos.olvidar()

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
        from app.modules.recommendations import models as _r  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)
        if con_la_0043:
            for sentencia in LA_0043:
                await conn.execute(text(sentencia))

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add_all(
            [
                Profile(id=ANA, full_name="Ana Torres", username="ana"),
                Profile(id=BRUNO, full_name="Luis Ramos", username="luis"),
            ]
        )
        await db.commit()

    identidad = {"uid": BRUNO}

    async def _db_override():
        async with sesiones() as session:
            yield session

    async def _usuario_override() -> AuthUser:
        return AuthUser(
            id=identidad["uid"], email="quien@ejemplo.com", role="authenticated"
        )

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    app.dependency_overrides[get_optional_user] = _usuario_override
    http = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    return http, sesiones, identidad, engine


async def _desmontar(http, engine):
    await http.aclose()
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    await engine.dispose()
    esquema.olvidar()
    esquema_de_avisos.olvidar()


@pytest_asyncio.fixture
async def entorno():
    """Con la 0043 puesta: la garantia la da el indice unico."""
    http, sesiones, identidad, engine = await _montar(True)
    yield http, sesiones, identidad
    await _desmontar(http, engine)


@pytest_asyncio.fixture
async def sin_la_0043():
    """El esquema tal y como esta HOY en produccion: sin `dedupe_key`."""
    http, sesiones, identidad, engine = await _montar(False)
    yield http, sesiones, identidad
    await _desmontar(http, engine)


async def _avisos_de(sesiones, uid: str, tipo: str | None = None) -> int:
    async with sesiones() as db:
        consulta = select(func.count()).select_from(Notification).where(
            Notification.user_id == uid
        )
        if tipo:
            consulta = consulta.where(Notification.type == tipo)
        return await db.scalar(consulta) or 0


# --------------------------------------------------------------------------- #
# 1. El caso de la captura
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_seguir_dejar_de_seguir_y_volver_a_seguir_deja_un_solo_aviso(entorno):
    """EL FALLO EXACTO DE LA CAPTURA: dos «empezo a seguirte» iguales.

    Al dejar de seguir se borra la fila de `follows`, asi que el `if existing is
    None` del router volvia a dejar pasar la escritura. La persona no ha hecho
    nada nuevo: sigue siendo la misma persona siguiendola.
    """
    http, sesiones, _ = entorno
    await http.post(f"{PERFILES}/{ANA}/follow")
    await http.delete(f"{PERFILES}/{ANA}/follow")
    respuesta = await http.post(f"{PERFILES}/{ANA}/follow")

    assert respuesta.status_code == 200, respuesta.text
    assert await _avisos_de(sesiones, ANA, "follow") == 1


@pytest.mark.asyncio
async def test_seguir_dos_veces_seguidas_tampoco_duplica(entorno):
    http, sesiones, _ = entorno
    await http.post(f"{PERFILES}/{ANA}/follow")
    await http.post(f"{PERFILES}/{ANA}/follow")
    assert await _avisos_de(sesiones, ANA, "follow") == 1


@pytest.mark.asyncio
async def test_quitar_y_volver_a_poner_me_gusta_deja_un_solo_aviso(entorno):
    """`post_likes` tambien se borra al retirarlo: mismo mecanismo, mismo fallo."""
    http, sesiones, identidad = entorno
    identidad["uid"] = ANA
    publicacion = (await http.post(POSTS, json={"body": "Hola"})).json()

    identidad["uid"] = BRUNO
    await http.post(f"{POSTS}/{publicacion['id']}/like")
    await http.delete(f"{POSTS}/{publicacion['id']}/like")
    await http.post(f"{POSTS}/{publicacion['id']}/like")

    assert await _avisos_de(sesiones, ANA, "like") == 1


# --------------------------------------------------------------------------- #
# 2. La garantia esta en la base, no en un `if`
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_indice_unico_rechaza_el_segundo_aviso(entorno):
    """LA PRUEBA QUE IMPORTA: saltandose el router, la base sigue diciendo que no.

    Dos peticiones simultaneas leen las dos antes de que ninguna escriba, asi
    que ningun `if` las separa. Esto escribe la segunda fila A MANO, con la
    misma clave, y comprueba que la base la rechaza. Si esta prueba dejara de
    pasar, la idempotencia habria vuelto a ser una promesa del codigo.
    """
    _, sesiones, _ = entorno
    clave = clave_de_aviso(
        user_id=ANA, actor_id=BRUNO, type="follow", entity_id=None
    )
    assert clave is not None

    async with sesiones() as db:
        await db.execute(
            text(
                "insert into notifications (id, user_id, actor_id, type, payload,"
                " dedupe_key) values ('11111111-0000-0000-0000-000000000001',"
                " :u, :a, 'follow', '{}', :k)"
            ),
            {"u": ANA, "a": BRUNO, "k": clave},
        )
        await db.commit()

    async with sesiones() as db:
        with pytest.raises(IntegrityError):
            await db.execute(
                text(
                    "insert into notifications (id, user_id, actor_id, type,"
                    " payload, dedupe_key) values"
                    " ('11111111-0000-0000-0000-000000000002', :u, :a, 'follow',"
                    " '{}', :k)"
                ),
                {"u": ANA, "a": BRUNO, "k": clave},
            )
            await db.commit()


@pytest.mark.asyncio
async def test_dos_llamadas_seguidas_al_servicio_escriben_una_sola_fila(entorno):
    """`add_notification` dice si ESCRIBIO, y solo la primera lo hace.

    De ese valor depende que ademas suene el telefono: un aviso que no se ha
    creado no puede mandar un push, o la bandeja tendria una fila y el movil
    habria sonado dos veces.
    """
    _, sesiones, _ = entorno
    async with sesiones() as db:
        primera = await add_notification(
            db, user_id=ANA, actor_id=BRUNO, type="follow"
        )
        segunda = await add_notification(
            db, user_id=ANA, actor_id=BRUNO, type="follow"
        )
        await db.commit()

    assert primera is True
    assert segunda is False
    assert await _avisos_de(sesiones, ANA, "follow") == 1


@pytest.mark.asyncio
async def test_los_avisos_de_otra_persona_no_se_pisan(entorno):
    """La clave lleva al actor: dos personas siguiendo son dos avisos."""
    _, sesiones, _ = entorno
    otra = "dddddddd-0000-0000-0000-000000000003"
    async with sesiones() as db:
        db.add(Profile(id=otra, full_name="Celina Diaz", username="celina"))
        await db.commit()
    async with sesiones() as db:
        await add_notification(db, user_id=ANA, actor_id=BRUNO, type="follow")
        await add_notification(db, user_id=ANA, actor_id=otra, type="follow")
        await db.commit()

    assert await _avisos_de(sesiones, ANA, "follow") == 2


# --------------------------------------------------------------------------- #
# 3. Lo que SI es distinto se conserva
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_dos_comentarios_siguen_siendo_dos_avisos(entorno):
    """Deduplicar esto no quitaria un duplicado: escenderia el segundo comentario."""
    http, sesiones, identidad = entorno
    identidad["uid"] = ANA
    publicacion = (await http.post(POSTS, json={"body": "Hola"})).json()

    identidad["uid"] = BRUNO
    await http.post(f"{POSTS}/{publicacion['id']}/comments", json={"body": "Uno"})
    await http.post(f"{POSTS}/{publicacion['id']}/comments", json={"body": "Dos"})

    assert await _avisos_de(sesiones, ANA, "comment") == 2


# --------------------------------------------------------------------------- #
# 4. El aviso nombra al actor, y el nombre sale de `profiles`
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_aviso_dice_quien_empezo_a_seguirte(entorno):
    """«Luis empezo a seguirte», no «Alguien».

    El nombre viaja en `actor.full_name` y lo resuelve el JOIN contra
    `profiles`: NUNCA sale del token, que solo lleva id, correo y rol. Ese
    fallo ya llego a produccion cuatro veces en este repositorio.
    """
    http, _, identidad = entorno
    await http.post(f"{PERFILES}/{ANA}/follow")

    identidad["uid"] = ANA
    avisos = (await http.get(AVISOS)).json()

    assert len(avisos) == 1
    assert avisos[0]["type"] == "follow"
    assert avisos[0]["actor"]["full_name"] == "Luis Ramos"
    assert avisos[0]["actor"]["id"] == BRUNO


@pytest.mark.asyncio
async def test_el_nombre_sigue_al_perfil_y_no_a_lo_que_habia_al_avisar(entorno):
    """Se resuelve al LEER, asi que cambiar de nombre corrige los avisos viejos.

    Es la consecuencia buena de no guardar el nombre dentro de la notificacion:
    un nombre copiado el dia del aviso se queda desfasado para siempre.
    """
    http, sesiones, identidad = entorno
    await http.post(f"{PERFILES}/{ANA}/follow")

    async with sesiones() as db:
        perfil = await db.get(Profile, BRUNO)
        perfil.full_name = "Luis R. Ramos"
        await db.commit()

    identidad["uid"] = ANA
    avisos = (await http.get(AVISOS)).json()
    assert avisos[0]["actor"]["full_name"] == "Luis R. Ramos"


# --------------------------------------------------------------------------- #
# 5. Sin la 0043 (produccion de hoy)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_la_0043_seguir_sigue_funcionando(sin_la_0043):
    """LO MAS IMPORTANTE DE ESTE BLOQUE.

    Si esto fallara, desplegar el codigo antes de aprobar la migracion dejaria a
    nadie poder seguir a nadie.
    """
    http, sesiones, _ = sin_la_0043
    respuesta = await http.post(f"{PERFILES}/{ANA}/follow")
    assert respuesta.status_code == 200, respuesta.text
    assert await _avisos_de(sesiones, ANA, "follow") == 1


@pytest.mark.asyncio
async def test_sin_la_0043_el_duplicado_visible_tambien_se_evita(sin_la_0043):
    """El respaldo (un SELECT antes de escribir) cubre el caso de la captura.

    No cubre la carrera de dos peticiones simultaneas —ningun `if` puede—, y por
    eso la 0043 existe. Pero lo que la persona ve en la bandeja ya sale bien
    desde el dia del despliegue, sin esperar a la aprobacion.
    """
    http, sesiones, _ = sin_la_0043
    await http.post(f"{PERFILES}/{ANA}/follow")
    await http.delete(f"{PERFILES}/{ANA}/follow")
    await http.post(f"{PERFILES}/{ANA}/follow")
    assert await _avisos_de(sesiones, ANA, "follow") == 1


@pytest.mark.asyncio
async def test_sin_la_0043_los_comentarios_no_se_pierden(sin_la_0043):
    http, sesiones, identidad = sin_la_0043
    identidad["uid"] = ANA
    publicacion = (await http.post(POSTS, json={"body": "Hola"})).json()

    identidad["uid"] = BRUNO
    await http.post(f"{POSTS}/{publicacion['id']}/comments", json={"body": "Uno"})
    await http.post(f"{POSTS}/{publicacion['id']}/comments", json={"body": "Dos"})
    assert await _avisos_de(sesiones, ANA, "comment") == 2


@pytest.mark.asyncio
async def test_sin_la_0043_el_aviso_tambien_nombra_al_actor(sin_la_0043):
    http, _, identidad = sin_la_0043
    await http.post(f"{PERFILES}/{ANA}/follow")
    identidad["uid"] = ANA
    avisos = (await http.get(AVISOS)).json()
    assert avisos[0]["actor"]["full_name"] == "Luis Ramos"


# --------------------------------------------------------------------------- #
# 6. La clave, en aislado
# --------------------------------------------------------------------------- #
def test_la_clave_distingue_los_campos_aunque_falten():
    """Sin separador fijo, un `entity_id` ausente confundiria dos avisos.

    `a|follow|b|-` y `a|follow|b` con el hueco pegado serian la misma cadena
    para combinaciones distintas, y entonces el indice unico escondería avisos
    que no tienen nada que ver.
    """
    con_entidad = clave_de_aviso(
        user_id="a", actor_id="b", type="like", entity_id="c"
    )
    sin_entidad = clave_de_aviso(user_id="a", actor_id="b", type="like", entity_id=None)
    assert con_entidad != sin_entidad
    assert con_entidad is not None and sin_entidad is not None


def test_un_comentario_no_lleva_clave():
    """Clave nula = nunca choca. Es como se conserva lo que si es distinto."""
    assert (
        clave_de_aviso(user_id="a", actor_id="b", type="comment", entity_id="c") is None
    )


def test_una_mencion_tampoco():
    """Desetiquetar y volver a etiquetar es una mencion NUEVA, no un duplicado.

    Esta decidido y probado en `test_menciones_api.py`; aqui se fija para que
    nadie lo «arregle» metiendo `post_mention` en la lista de idempotentes.
    """
    assert (
        clave_de_aviso(
            user_id="a", actor_id="b", type="post_mention", entity_id="c"
        )
        is None
    )
