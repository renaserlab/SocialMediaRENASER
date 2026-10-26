"""Bloquear, desbloquear y borrar un mensaje para todos.

DOS TRABAJOS QUE COMPARTEN FICHERO PORQUE COMPARTEN LA MISMA IDEA: una accion
que se puede repetir sin que el resultado cambie, y un limite de quien puede
hacerla.

BLOQUEO. Lo que se prueba aqui no es que exista el endpoint —existe desde la
0001— sino que se comporte como la pantalla necesita para poder ofrecer
«Desbloquear»:

  * bloquear DOS VECES no es un error (sin el `if` previo, la segunda reventaba
    con una violacion de clave primaria, que sale como 500 por pulsar dos veces
    o por el reintento de una red lenta),
  * desbloquear dos veces tampoco,
  * bloquear DESHACE el seguimiento en los dos sentidos, y desbloquear NO lo
    devuelve: eso seria decidir por dos personas que quieren volver a seguirse,
  * y mientras dure el bloqueo, el CONTENIDO se corta en los dos sentidos.

BORRADO DE MENSAJES. Semantica conservadora, la de WhatsApp: quien lo escribio
lo borra PARA TODOS, y lo que queda es una lapida. No desaparece sin dejar
hueco, porque entonces la conversacion mentiria: quien esta al otro lado leyo
algo que ahora no esta y no sabria que se borro ni que hubo nada ahi.

Y EN UN CHAT DE DOS NADIE BORRA MENSAJES AJENOS, salvo la moderacion. Si el
otro lado pudiera borrar lo que le dijeron, una conversacion dejaria de ser
prueba de nada. En un GRUPO, desde el 26/10/2026 (D4), tambien puede quien lo
administra; eso se prueba en `test_admin_borra_mensajes.py`, y lo de aqui —un
miembro cualquiera no borra lo de otro— sigue valiendo alli.

EL ROL SE LEE DE `profiles`, NUNCA DEL TOKEN. En el JWT de Supabase `role` vale
siempre "authenticated": comprobarlo contra "admin" no se cumple jamas. Ese
fallo ya llego a produccion cuatro veces en este proyecto, y por eso hay una
prueba con un administrador de verdad.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.messaging import esquema as esquema_mensajes
from app.modules.messaging.models import Message
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.reviews.models import ProfileReview
from app.modules.social_graph.models import Follow, UserBlock
from app.shared.database import Base, get_db

PERFILES = "/api/v1/profiles"
CHATS = "/api/v1/conversations"
RESENAS = "/api/v1/reviews"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
CARLA = "aaaaaaaa-0000-0000-0000-000000000003"   # ajena a todo
DIEGO = "aaaaaaaa-0000-0000-0000-000000000004"   # administra


@pytest_asyncio.fixture
async def entorno():
    esquema.olvidar()
    esquema_mensajes.olvidar()

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        from app.modules.bookings import models as _b  # noqa: F401
        from app.modules.catalog import models as _c  # noqa: F401
        from app.modules.communities import models as _co  # noqa: F401
        from app.modules.content import models as _ct  # noqa: F401
        from app.modules.learning import models as _l  # noqa: F401
        from app.modules.live import models as _li  # noqa: F401
        from app.modules.messaging import models as _m  # noqa: F401
        from app.modules.moderation import models as _mo  # noqa: F401
        from app.modules.notifications import device_tokens as _dt  # noqa: F401
        from app.modules.notifications import models as _n  # noqa: F401
        from app.modules.reviews import models as _r  # noqa: F401
        from app.modules.social_graph import models as _s  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(Profile(id=CARLA, full_name="Carla", username="carla"))
        db.add(Profile(id=DIEGO, full_name="Diego", username="diego", role="admin"))
        await db.commit()

    identidad = {"uid": ANA}

    async def _db_override():
        async with sesiones() as session:
            yield session

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

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
    esquema.olvidar()
    esquema_mensajes.olvidar()
    await engine.dispose()


def codigo(respuesta) -> str:
    return respuesta.json()["error"]["code"]


# =========================================================================== #
# 1. Bloquear y desbloquear
# =========================================================================== #
@pytest.mark.asyncio
async def test_bloquear_y_desbloquear(entorno):
    http, sesiones, _ = entorno

    bloqueo = await http.post(f"{PERFILES}/{BRUNO}/block")
    assert bloqueo.status_code == 200, bloqueo.text
    assert bloqueo.json() == {"blocked": True}

    desbloqueo = await http.delete(f"{PERFILES}/{BRUNO}/block")
    assert desbloqueo.status_code == 200, desbloqueo.text
    assert desbloqueo.json() == {"blocked": False}

    async with sesiones() as db:
        assert (await db.scalars(select(UserBlock.blocked_id))).all() == []


@pytest.mark.asyncio
async def test_bloquear_dos_veces_es_idempotente(entorno):
    """SIN ESTO, la segunda vez reventaba con una violacion de clave primaria.

    Y un 500 se lo lleva quien pulse dos veces, o quien tenga una red lenta que
    reintente la peticion. Lo que la persona queria —que esa cuenta este
    bloqueada— ya esta hecho: es un exito, no un error.
    """
    http, sesiones, _ = entorno

    assert (await http.post(f"{PERFILES}/{BRUNO}/block")).status_code == 200
    segunda = await http.post(f"{PERFILES}/{BRUNO}/block")
    assert segunda.status_code == 200, segunda.text
    assert segunda.json() == {"blocked": True}

    # Y sigue habiendo UNA fila, no dos.
    async with sesiones() as db:
        assert len((await db.scalars(select(UserBlock.blocked_id))).all()) == 1


@pytest.mark.asyncio
async def test_desbloquear_dos_veces_tambien(entorno):
    """Desbloquear lo que no estaba bloqueado no es un error: el resultado que
    se buscaba —esa cuenta no esta bloqueada— ya es el que hay."""
    http, _, _ = entorno
    await http.post(f"{PERFILES}/{BRUNO}/block")
    assert (await http.delete(f"{PERFILES}/{BRUNO}/block")).status_code == 200
    repetido = await http.delete(f"{PERFILES}/{BRUNO}/block")
    assert repetido.status_code == 200
    assert repetido.json() == {"blocked": False}


@pytest.mark.asyncio
async def test_desbloquear_a_alguien_que_nunca_se_bloqueo_no_falla(entorno):
    http, _, _ = entorno
    respuesta = await http.delete(f"{PERFILES}/{CARLA}/block")
    assert respuesta.status_code == 200
    assert respuesta.json() == {"blocked": False}


@pytest.mark.asyncio
async def test_bloquear_deshace_el_seguimiento_en_los_dos_sentidos(entorno):
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(Follow(follower_id=ANA, following_id=BRUNO))
        db.add(Follow(follower_id=BRUNO, following_id=ANA))
        await db.commit()

    await http.post(f"{PERFILES}/{BRUNO}/block")

    async with sesiones() as db:
        assert (await db.scalars(select(Follow.follower_id))).all() == []


@pytest.mark.asyncio
async def test_desbloquear_no_devuelve_el_seguimiento(entorno):
    """A PROPOSITO. Restaurarlo seria decidir por dos personas que quieren
    volver a seguirse; cada una vuelve a seguir si quiere."""
    http, sesiones, _ = entorno
    async with sesiones() as db:
        db.add(Follow(follower_id=ANA, following_id=BRUNO))
        await db.commit()

    await http.post(f"{PERFILES}/{BRUNO}/block")
    await http.delete(f"{PERFILES}/{BRUNO}/block")

    async with sesiones() as db:
        assert (await db.scalars(select(Follow.follower_id))).all() == []


@pytest.mark.asyncio
async def test_nadie_se_bloquea_a_si_mismo(entorno):
    http, _, _ = entorno
    assert (await http.post(f"{PERFILES}/{ANA}/block")).status_code == 422


@pytest.mark.asyncio
async def test_un_id_con_basura_es_404_y_no_un_500(entorno):
    """Sin `ensure_uuid` la cadena llega al driver y el manejador de DBAPIError
    la convierte en un 404 silencioso — o en un 500, segun por donde caiga. Un
    500 de Starlette viaja SIN cabeceras CORS y en el navegador se disfraza de
    fallo de red."""
    http, _, _ = entorno
    assert (await http.post(f"{PERFILES}/no-soy-un-uuid/block")).status_code == 404
    assert (await http.delete(f"{PERFILES}/no-soy-un-uuid/block")).status_code == 404


@pytest.mark.asyncio
async def test_mientras_dure_el_bloqueo_el_contenido_sigue_oculto(entorno):
    """La otra mitad de «el perfil sigue accesible para poder desbloquear».

    Accesible LO MINIMO: se puede llegar al perfil para pulsar «Desbloquear»,
    pero lo que el bloqueo esconde sigue escondido. El corte es SIMETRICO —a
    quien bloqueaste y a quien te bloqueo—, porque cortar un solo sentido no
    protegeria de nada: bastaria con no bloquear a su vez.
    """
    http, sesiones, identidad = entorno

    # Carla escribe una resena sobre Bruno, y Ana la ve.
    identidad["uid"] = CARLA
    await http.post(RESENAS, json={"reviewed_user_id": BRUNO, "body": "Muy bueno."})
    identidad["uid"] = ANA
    assert len((await http.get(f"{RESENAS}/received/{BRUNO}")).json()) == 1

    # Ana bloquea a Bruno: su perfil deja de tener nada que enseñar.
    await http.post(f"{PERFILES}/{BRUNO}/block")
    assert (await http.get(f"{RESENAS}/received/{BRUNO}")).json() == []
    # Y tampoco se le puede escribir una.
    prohibida = await http.post(
        RESENAS, json={"reviewed_user_id": BRUNO, "body": "Ya no."}
    )
    assert prohibida.status_code == 403
    assert codigo(prohibida) == "review_blocked"

    # Al desbloquear, vuelve a verse. Nada se ha perdido por el camino.
    await http.delete(f"{PERFILES}/{BRUNO}/block")
    assert len((await http.get(f"{RESENAS}/received/{BRUNO}")).json()) == 1


@pytest.mark.asyncio
async def test_el_corte_vale_tambien_desde_el_otro_lado(entorno):
    """Quien fue bloqueado tampoco ve a quien le bloqueo."""
    http, _, identidad = entorno
    identidad["uid"] = CARLA
    await http.post(RESENAS, json={"reviewed_user_id": BRUNO, "body": "Muy bueno."})

    # Bruno bloquea a Ana; Ana no ha bloqueado a nadie.
    identidad["uid"] = BRUNO
    await http.post(f"{PERFILES}/{ANA}/block")

    identidad["uid"] = ANA
    assert (await http.get(f"{RESENAS}/received/{BRUNO}")).json() == []


# =========================================================================== #
# 2. Borrar un mensaje
# =========================================================================== #
async def _chat_con_un_mensaje(http, identidad, autor: str) -> tuple[str, str]:
    """Un chat directo entre Ana y Bruno con un mensaje de `autor`."""
    identidad["uid"] = ANA
    conv = (await http.post(f"{CHATS}/direct", json={"user_id": BRUNO})).json()["id"]
    identidad["uid"] = autor
    mensaje = (
        await http.post(f"{CHATS}/{conv}/messages", json={"body": "hola"})
    ).json()["id"]
    return conv, mensaje


@pytest.mark.asyncio
async def test_quien_lo_escribio_lo_borra_para_todos(entorno):
    """Y lo que queda es una LAPIDA, no un hueco.

    Si el mensaje desapareciera sin dejar rastro, la conversacion mentiria: quien
    esta al otro lado leyo algo que ahora no esta y no sabria que se ha borrado.
    """
    http, _, identidad = entorno
    conv, mensaje = await _chat_con_un_mensaje(http, identidad, autor=ANA)

    identidad["uid"] = ANA
    borrado = await http.delete(f"{CHATS}/{conv}/messages/{mensaje}")
    assert borrado.status_code == 204, borrado.text

    # Para el OTRO: la burbuja sigue ahi, marcada y sin texto.
    identidad["uid"] = BRUNO
    historial = (await http.get(f"{CHATS}/{conv}/messages")).json()
    assert len(historial) == 1
    assert historial[0]["id"] == mensaje
    assert historial[0]["deleted_at"] is not None
    # EL TEXTO NO VIAJA. Esconderlo en la pantalla no serviria: lo que sale del
    # servidor lo puede leer cualquier cliente, incluida la respuesta cruda.
    assert historial[0]["body"] == ""


@pytest.mark.asyncio
async def test_para_quien_lo_escribio_tambien_desaparece(entorno):
    """«Borrar para todos» incluye a quien lo borra: no es «ocultar para el otro»."""
    http, _, identidad = entorno
    conv, mensaje = await _chat_con_un_mensaje(http, identidad, autor=ANA)

    identidad["uid"] = ANA
    await http.delete(f"{CHATS}/{conv}/messages/{mensaje}")
    historial = (await http.get(f"{CHATS}/{conv}/messages")).json()
    assert historial[0]["body"] == ""
    assert historial[0]["deleted_at"] is not None


@pytest.mark.asyncio
async def test_nadie_borra_el_mensaje_de_otro(entorno):
    """LA REGLA QUE DA SENTIDO AL RESTO, en un chat de dos.

    Bruno esta EN la conversacion y aun asi no puede borrar lo que escribio Ana.
    Si pudiera, una conversacion dejaria de ser prueba de nada —bastaria con
    quitar lo que incomoda— y no habria forma de reportar un mensaje abusivo.
    (En un grupo, quien lo administra si puede: D4, `test_admin_borra_mensajes.py`.)
    """
    http, _, identidad = entorno
    conv, mensaje = await _chat_con_un_mensaje(http, identidad, autor=ANA)

    identidad["uid"] = BRUNO
    respuesta = await http.delete(f"{CHATS}/{conv}/messages/{mensaje}")
    assert respuesta.status_code == 403, respuesta.text
    assert codigo(respuesta) == "message_not_yours"

    # Y sigue ahi, intacto.
    assert (await http.get(f"{CHATS}/{conv}/messages")).json()[0]["body"] == "hola"


@pytest.mark.asyncio
async def test_quien_no_esta_en_la_conversacion_ni_se_entera_de_que_existe(entorno):
    """403 por no ser miembro, ANTES de mirar el mensaje.

    Al reves —mirar primero el mensaje— la diferencia entre un 404 y un 403
    diria si ese identificador existe, que es informacion de una conversacion
    ajena.
    """
    http, _, identidad = entorno
    conv, mensaje = await _chat_con_un_mensaje(http, identidad, autor=ANA)

    identidad["uid"] = CARLA
    respuesta = await http.delete(f"{CHATS}/{conv}/messages/{mensaje}")
    assert respuesta.status_code == 403


@pytest.mark.asyncio
async def test_la_moderacion_si_puede_y_el_rol_sale_de_profiles(entorno):
    """EL ROL VIVE EN `profiles`, NO EN EL TOKEN.

    En el JWT de Supabase `role` vale siempre "authenticated". Diego llega aqui
    con ese mismo `role` en el token y con `role='admin'` en su fila: si la
    comprobacion mirara el token, esto seria un 403. Ese fallo ya llego a
    produccion cuatro veces en este proyecto.
    """
    http, sesiones, identidad = entorno
    conv, mensaje = await _chat_con_un_mensaje(http, identidad, autor=ANA)

    # Diego no es miembro del chat; se le mete para poder moderar dentro.
    from app.modules.messaging.models import ConversationMember

    async with sesiones() as db:
        db.add(ConversationMember(conversation_id=conv, user_id=DIEGO))
        await db.commit()

    identidad["uid"] = DIEGO
    assert (await http.delete(f"{CHATS}/{conv}/messages/{mensaje}")).status_code == 204


@pytest.mark.asyncio
async def test_borrar_dos_veces_no_cambia_la_fecha(entorno):
    """IDEMPOTENTE, y la marca es la del borrado DE VERDAD.

    Volver a marcarla convertiria la fecha en «la del ultimo toque en un boton»,
    que no es lo que dice significar.
    """
    http, sesiones, identidad = entorno
    conv, mensaje = await _chat_con_un_mensaje(http, identidad, autor=ANA)

    identidad["uid"] = ANA
    assert (await http.delete(f"{CHATS}/{conv}/messages/{mensaje}")).status_code == 204
    async with sesiones() as db:
        primera = (await db.get(Message, mensaje)).deleted_at

    assert (await http.delete(f"{CHATS}/{conv}/messages/{mensaje}")).status_code == 204
    async with sesiones() as db:
        assert (await db.get(Message, mensaje)).deleted_at == primera


@pytest.mark.asyncio
async def test_un_mensaje_que_no_existe_es_404(entorno):
    http, _, identidad = entorno
    conv, _ = await _chat_con_un_mensaje(http, identidad, autor=ANA)
    identidad["uid"] = ANA
    fantasma = "dddddddd-0000-0000-0000-0000000000ff"
    assert (await http.delete(f"{CHATS}/{conv}/messages/{fantasma}")).status_code == 404


@pytest.mark.asyncio
async def test_un_mensaje_de_otra_conversacion_no_se_borra_desde_esta(entorno):
    """La ruta lleva las DOS cosas y las dos tienen que casar. Sin comprobarlo,
    ser miembro de CUALQUIER chat bastaria para borrar en todos."""
    http, _, identidad = entorno
    conv_a, mensaje_a = await _chat_con_un_mensaje(http, identidad, autor=ANA)

    identidad["uid"] = ANA
    conv_b = (await http.post(f"{CHATS}/direct", json={"user_id": CARLA})).json()["id"]

    respuesta = await http.delete(f"{CHATS}/{conv_b}/messages/{mensaje_a}")
    assert respuesta.status_code == 404


@pytest.mark.asyncio
async def test_un_mensaje_borrado_no_arrastra_sus_adjuntos(entorno):
    """Los FICHEROS del bucket se quedan —borrarlos rompe la integridad y es
    irreversible—, pero dejan de entregarse: la lapida no lleva nada."""
    http, sesiones, identidad = entorno
    conv, mensaje = await _chat_con_un_mensaje(http, identidad, autor=ANA)

    from app.modules.messaging.models import MessageAttachment

    async with sesiones() as db:
        db.add(
            MessageAttachment(
                message_id=mensaje,
                conversation_id=conv,
                storage_path=f"{conv}/{ANA}/foto.jpg",
                kind="image",
            )
        )
        await db.commit()

    identidad["uid"] = ANA
    assert (await http.get(f"{CHATS}/{conv}/messages")).json()[0]["attachments"]

    await http.delete(f"{CHATS}/{conv}/messages/{mensaje}")
    historial = (await http.get(f"{CHATS}/{conv}/messages")).json()
    assert historial[0]["attachments"] == []

    # La fila del adjunto NO se ha borrado: la limpieza de huerfanos tiene su
    # sitio y decide con toda la informacion delante.
    async with sesiones() as db:
        assert (await db.scalars(select(MessageAttachment.id))).all()


@pytest.mark.asyncio
async def test_un_mensaje_borrado_deja_de_contar_como_no_leido(entorno):
    """COHERENCIA CON LA BANDEJA, que es el motivo de que `deleted_at` exista.

    Una lapida no es algo pendiente de leer. Si contara, el contador diria que
    hay un mensaje sin leer y al abrir el chat no habria nada que leer.
    """
    http, _, identidad = entorno
    conv, mensaje = await _chat_con_un_mensaje(http, identidad, autor=BRUNO)

    identidad["uid"] = ANA
    fila = next(c for c in (await http.get(CHATS)).json() if c["id"] == conv)
    assert fila["unread_count"] == 1

    identidad["uid"] = BRUNO
    await http.delete(f"{CHATS}/{conv}/messages/{mensaje}")

    identidad["uid"] = ANA
    # El chat se queda sin nada vivo, asi que sale de la bandeja igual que un
    # chat directo en el que nunca se escribio.
    assert conv not in [c["id"] for c in (await http.get(CHATS)).json()]
