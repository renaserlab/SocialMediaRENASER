"""Responder una historia: el mensaje conserva a QUE respondia, y sobrevive.

QUE SE COMPRUEBA AQUI. El flujo entero del visor: alguien ve la historia de
Bruno, contesta, y lo que llega al chat es un mensaje normal —Realtime, no
leidos, borrable, paginado— que ADEMAS sabe de que historia venia.

LAS DOS COSAS QUE DE VERDAD IMPORTAN, y que son el motivo de este fichero:

1. EL CONTEXTO ES ESTRUCTURA, NO TEXTO. La URL de la historia no se mete dentro
   del cuerpo del mensaje. Se comprueba explicitamente que `body` sale tal cual
   se escribio: si alguien «resolviera» esto pegando un enlace en el texto,
   estas pruebas lo cazan.

2. EL MENSAJE SOBREVIVE A LA HISTORIA. Una historia dura 24 horas; el mensaje
   que la responde dura para siempre, asi que la inmensa mayoria de las
   respuestas a historias que existen apuntan a algo que ya no esta. Ese es el
   caso NORMAL y aqui se prueba como tal: se borra la historia y se comprueba
   que el mensaje sigue entero, legible, y sabiendo todavia de quien era.

DE QUIEN ERA LA HISTORIA LO DECIDE EL SERVIDOR. La peticion solo manda
`story_id`; el duenno se lee de la fila. Aceptarlo del cuerpo dejaria que
cualquiera atribuyera su mensaje a la historia de otra persona, y es justo el
dato que sobrevive cuando la historia desaparece: mentir ahi seria mentir para
siempre.

LA CONVERSACION SE OBTIENE POR EL CAMINO QUE YA EXISTE, `POST
/conversations/direct`, que es idempotente desde la 0039. Aqui se comprueba que
responder dos historias de la misma persona no crea dos chats con ella, que es
exactamente el fallo que esa migracion cerro.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, event, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.messaging import esquema as esquema_mensajes
from app.modules.messaging.models import Conversation, ConversationMember
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.modules.stories.models import Story
from app.shared.database import Base, get_db

API = "/api/v1/conversations"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
CHAT = "cccccccc-0000-0000-0000-000000000001"

HISTORIA = "55555555-0000-0000-0000-000000000001"
OTRA_HISTORIA = "55555555-0000-0000-0000-000000000002"

AHORA = datetime(2026, 8, 31, 12, 0, 0, tzinfo=timezone.utc)


@pytest_asyncio.fixture
async def entorno():
    """Ana y Bruno hablan; Bruno tiene dos historias vigentes."""
    cache.vaciar()
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
        from app.modules.social_graph import models as _s  # noqa: F401
        from app.modules.stories import models as _st  # noqa: F401

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(Conversation(id=CHAT, kind="direct", created_by=ANA))
        db.add(ConversationMember(conversation_id=CHAT, user_id=ANA))
        db.add(ConversationMember(conversation_id=CHAT, user_id=BRUNO))
        db.add(
            Story(
                id=HISTORIA,
                author_id=BRUNO,
                storage_path=f"{BRUNO}/historia.jpg",
                media_type="image",
                caption="En la playa",
                expires_at=AHORA + timedelta(hours=20),
            )
        )
        db.add(
            Story(
                id=OTRA_HISTORIA,
                author_id=BRUNO,
                storage_path=f"{BRUNO}/otra.mp4",
                media_type="video",
                caption="",
                expires_at=AHORA + timedelta(hours=22),
            )
        )
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http, sesiones, identidad

    app.dependency_overrides.clear()
    await engine.dispose()


# --------------------------------------------------------------------------- #
# 1. Responder una historia deja CONTEXTO ESTRUCTURADO
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_responder_una_historia_crea_un_mensaje_con_contexto(entorno):
    """Lo pedido: el mensaje conserva referencia estructurada a la historia."""
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages",
        json={"body": "¡Qué envidia!", "story_id": HISTORIA},
    )
    assert respuesta.status_code == 201

    cuerpo = respuesta.json()
    contexto = cuerpo["story_context"]
    assert contexto is not None, "el mensaje ha perdido a que historia respondia"
    assert contexto["story_id"] == HISTORIA
    assert contexto["available"] is True
    # De quien era, para poder escribir «respondiste a la historia de Bruno».
    assert contexto["story_owner"]["id"] == BRUNO
    assert contexto["story_owner"]["username"] == "bruno"
    # Y con que se responde, para pintar la miniatura.
    assert contexto["media_path"] == f"{BRUNO}/historia.jpg"
    assert contexto["media_type"] == "image"
    assert contexto["caption"] == "En la playa"


@pytest.mark.asyncio
async def test_la_historia_no_se_cuela_dentro_del_texto(entorno):
    """EL CUERPO DEL MENSAJE ES DE QUIEN LO ESCRIBE. Nada mas.

    Es la prueba que caza el atajo prohibido: «meter la URL de la historia en el
    texto y llamarlo resuelto». Si alguien lo hiciera, `body` dejaria de ser lo
    que se tecleo y esto fallaria.
    """
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages",
        json={"body": "hola", "story_id": HISTORIA},
    )
    assert respuesta.json()["body"] == "hola"

    # Y tampoco al releerlo del historial.
    historial = (await http.get(f"{API}/{CHAT}/messages")).json()
    assert historial[0]["body"] == "hola"
    assert HISTORIA not in historial[0]["body"]
    assert "http" not in historial[0]["body"]


@pytest.mark.asyncio
async def test_el_duenno_de_la_historia_lo_decide_el_servidor(entorno):
    """No se acepta de la peticion, ni aunque la peticion insista.

    `story_owner_id` es el dato que sobrevive cuando la historia desaparece. Si
    viniera del cuerpo, cualquiera podria atribuir su mensaje a la historia de
    otra persona y esa mentira quedaria para siempre.
    """
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages",
        json={
            "body": "hola",
            "story_id": HISTORIA,
            # Intento de decidirlo desde fuera: se ignora.
            "story_owner_id": ANA,
            "story_context": {"story_owner": {"id": ANA}},
        },
    )
    assert respuesta.status_code == 201
    assert respuesta.json()["story_context"]["story_owner"]["id"] == BRUNO


@pytest.mark.asyncio
async def test_el_otro_lado_recibe_el_mensaje_con_normalidad(entorno):
    """Bruno lo lee como cualquier otro mensaje, y ve que era por su historia."""
    http, _, identidad = entorno
    await http.post(f"{API}/{CHAT}/messages", json={"body": "guapa", "story_id": HISTORIA})

    identidad["uid"] = BRUNO
    historial = (await http.get(f"{API}/{CHAT}/messages")).json()
    assert len(historial) == 1
    assert historial[0]["body"] == "guapa"
    assert historial[0]["sender"]["id"] == ANA
    assert historial[0]["story_context"]["story_id"] == HISTORIA


@pytest.mark.asyncio
async def test_un_mensaje_normal_no_lleva_contexto(entorno):
    """`null` y no un objeto vacio: la diferencia con «respondia a algo borrado»."""
    http, _, _ = entorno
    await http.post(f"{API}/{CHAT}/messages", json={"body": "hola"})
    historial = (await http.get(f"{API}/{CHAT}/messages")).json()
    assert historial[0]["story_context"] is None


# --------------------------------------------------------------------------- #
# 2. LA HISTORIA DESAPARECE Y EL MENSAJE SIGUE AHI
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_si_borran_la_historia_el_mensaje_sigue_existiendo_y_legible(entorno):
    """EL CASO NORMAL, no el raro: al dia siguiente ya no hay historia.

    El mensaje no se borra, no se vacia y no revienta el historial. Lo unico que
    cambia es que su contexto pasa a estar DEGRADADO: sin puntero a la historia,
    pero sabiendo todavia de quien era. Eso es lo que deja escribir «Historia no
    disponible» en vez de un hueco sin explicacion.
    """
    http, sesiones, _ = entorno
    await http.post(
        f"{API}/{CHAT}/messages", json={"body": "me encanta", "story_id": HISTORIA}
    )

    # La historia se va, como se va cada historia a las 24 horas.
    #
    # EL PRAGMA NO ES UN ADORNO DE LA PRUEBA. En SQLite las claves ajenas vienen
    # APAGADAS por defecto, asi que sin el, `on delete set null` no se aplica:
    # `story_id` se quedaria apuntando a una fila que ya no existe y esta prueba
    # pasaria sin comprobar nada de lo que dice comprobar —lo verifique de la
    # peor manera, viendola pasar en verde antes de encenderlo—. En produccion
    # es PostgreSQL quien lo garantiza siempre; aqui hay que pedirlo.
    #
    # Se enciende SOLO aqui y no en el fixture porque con las claves ajenas
    # activas durante la carga inicial, el orden en que SQLAlchemy escribe las
    # filas de siembra deja de valer y no es lo que esta prueba quiere examinar.
    async with sesiones() as db:
        await db.execute(text("pragma foreign_keys=ON"))
        await db.execute(delete(Story).where(Story.id == HISTORIA))
        await db.commit()

    historial = (await http.get(f"{API}/{CHAT}/messages")).json()
    assert len(historial) == 1, "el mensaje ha desaparecido con la historia"

    mensaje = historial[0]
    # 1. El mensaje esta ENTERO.
    assert mensaje["body"] == "me encanta"
    assert mensaje["deleted_at"] is None
    # 2. Y se sigue entendiendo que respondia a una historia...
    contexto = mensaje["story_context"]
    assert contexto is not None, (
        "al borrarse la historia se ha perdido que esto era una respuesta; "
        "el `on delete set null` deberia dejar la fila en su sitio"
    )
    # 3. ...a una que ya no esta...
    assert contexto["available"] is False
    assert contexto["story_id"] is None
    assert contexto["media_path"] is None
    # 4. ...pero sin olvidar de quien era.
    assert contexto["story_owner"]["id"] == BRUNO
    assert contexto["story_owner"]["full_name"] == "Bruno"


@pytest.mark.asyncio
async def test_una_historia_caducada_pero_aun_en_la_base_sigue_contando(entorno):
    """Caducar y estar borrada no son lo mismo.

    Una historia caducada que el barrido todavia no se ha llevado sigue diciendo
    la verdad sobre a que se respondia. La vigencia decide si la historia SE VE,
    no si el hecho ocurrio.
    """
    http, sesiones, _ = entorno
    async with sesiones() as db:
        await db.execute(
            update(Story)
            .where(Story.id == HISTORIA)
            .values(expires_at=AHORA - timedelta(days=2))
        )
        await db.commit()

    respuesta = await http.post(
        f"{API}/{CHAT}/messages", json={"body": "tarde", "story_id": HISTORIA}
    )
    assert respuesta.status_code == 201
    assert respuesta.json()["story_context"]["available"] is True


@pytest.mark.asyncio
async def test_responder_a_una_historia_que_ya_no_existe_manda_el_mensaje(entorno):
    """El texto es de quien lo escribio. No se le quita por una tabla.

    Entre abrir el visor y pulsar «enviar» pueden pasar minutos, y en ese hueco
    su autor ha podido borrar la historia. Perder el mensaje seria el peor de los
    desenlaces: se manda, sin contexto.
    """
    http, sesiones, _ = entorno
    async with sesiones() as db:
        await db.execute(delete(Story).where(Story.id == HISTORIA))
        await db.commit()

    respuesta = await http.post(
        f"{API}/{CHAT}/messages", json={"body": "lo vi antes", "story_id": HISTORIA}
    )
    assert respuesta.status_code == 201, "se ha perdido el mensaje de alguien"
    assert respuesta.json()["body"] == "lo vi antes"
    assert respuesta.json()["story_context"] is None


@pytest.mark.asyncio
async def test_un_id_de_historia_con_mala_forma_es_un_404_y_no_un_500(entorno):
    """Un id que no es un uuid llegaba hasta el driver y salia como 500."""
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages", json={"body": "hola", "story_id": "no-soy-un-uuid"}
    )
    assert respuesta.status_code == 404


# --------------------------------------------------------------------------- #
# 3. Convive con lo que ya hacia el chat
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_mensaje_borrado_no_ensena_a_que_respondia(entorno):
    """Una lapida no cuenta nada, tampoco el contexto.

    Decirlo seria filtrar parte de lo que su autor acaba de retirar: «respondio
    a la historia de Bruno a las 3 de la manana» es informacion, aunque el texto
    ya no este.
    """
    http, _, _ = entorno
    enviado = await http.post(
        f"{API}/{CHAT}/messages", json={"body": "ups", "story_id": HISTORIA}
    )
    message_id = enviado.json()["id"]

    borrado = await http.delete(f"{API}/{CHAT}/messages/{message_id}")
    assert borrado.status_code == 204

    historial = (await http.get(f"{API}/{CHAT}/messages")).json()
    assert historial[0]["deleted_at"] is not None
    assert historial[0]["body"] == ""
    assert historial[0]["story_context"] is None


@pytest.mark.asyncio
async def test_responder_dos_historias_no_crea_dos_chats_con_la_misma_persona(entorno):
    """Se usa el camino que YA existe para obtener-o-crear. Es idempotente.

    Es el fallo que cerro la 0039: dos conversaciones con la misma persona. Si
    responder una historia se inventara su propio camino de creacion, volveria a
    abrirse por otro sitio.
    """
    http, _, _ = entorno
    primera = await http.post(f"{API}/direct", json={"user_id": BRUNO})
    segunda = await http.post(f"{API}/direct", json={"user_id": BRUNO})
    assert primera.status_code == 200 and segunda.status_code == 200
    assert primera.json()["id"] == segunda.json()["id"] == CHAT

    conv = primera.json()["id"]
    for historia in (HISTORIA, OTRA_HISTORIA):
        assert (
            await http.post(
                f"{API}/{conv}/messages", json={"body": "hey", "story_id": historia}
            )
        ).status_code == 201

    # Y sigue habiendo UNA sola conversacion en la bandeja.
    assert len((await http.get(API)).json()) == 1


@pytest.mark.asyncio
async def test_el_historial_no_hace_una_consulta_por_mensaje_para_el_contexto(entorno):
    """Abrir un chat no puede costar una consulta por burbuja.

    Es la misma regla que ya cumplen los adjuntos: el numero de consultas del
    historial no depende de cuantos mensajes trae la pagina.
    """
    http, sesiones, _ = entorno
    for i in range(8):
        await http.post(
            f"{API}/{CHAT}/messages",
            json={"body": f"m{i}", "story_id": HISTORIA if i % 2 else OTRA_HISTORIA},
        )

    consultas: list[str] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        texto = statement.lower()
        if "message_story_context" in texto:
            consultas.append(texto)

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    try:
        historial = (await http.get(f"{API}/{CHAT}/messages")).json()
    finally:
        event.remove(motor, "before_cursor_execute", _anotar)

    assert len(historial) == 8
    assert all(m["story_context"] is not None for m in historial)
    assert len(consultas) == 1, (
        f"el contexto de historia cuesta {len(consultas)} consultas para una "
        "pagina de 8 mensajes; tiene que ser UNA"
    )


@pytest.mark.asyncio
async def test_un_historial_sin_contextos_no_pregunta_por_un_id_vacio(entorno):
    """`columna_uuid.in_(lista or [""])` esta prohibido en este proyecto.

    La cadena vacia pasa en SQLite y asyncpg la rechaza; el error acaba
    convertido en un 404 silencioso. Con la lista vacia se vuelve pronto.
    """
    http, sesiones, _ = entorno
    # Un mensaje, y despues borrado: la lista de ids vivos se queda vacia.
    enviado = await http.post(f"{API}/{CHAT}/messages", json={"body": "hola"})
    await http.delete(f"{API}/{CHAT}/messages/{enviado.json()['id']}")

    sentencias: list[str] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        sentencias.append(statement.lower())

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    try:
        assert (await http.get(f"{API}/{CHAT}/messages")).status_code == 200
    finally:
        event.remove(motor, "before_cursor_execute", _anotar)

    assert not [s for s in sentencias if "message_story_context" in s], (
        "se ha consultado el contexto sin ningun mensaje vivo del que colgarlo"
    )


@pytest.mark.asyncio
async def test_la_conversacion_sube_a_lo_alto_de_la_bandeja(entorno):
    """Responder una historia es escribir: la conversacion se actualiza igual.

    Sin esto, un chat que solo tuviera respuestas a historias se quedaria al
    fondo de la bandeja con la fecha de la ultima vez que se hablo «de verdad».
    """
    http, _, _ = entorno
    await http.post(f"{API}/{CHAT}/messages", json={"body": "hey", "story_id": HISTORIA})

    fila = (await http.get(API)).json()[0]
    assert fila["id"] == CHAT
    assert fila["last_message"] == "hey"
