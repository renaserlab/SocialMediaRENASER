"""La aplicacion tiene que funcionar SIN la migracion 0033.

POR QUE ESTA PRUEBA EXISTE, Y ES LA MISMA LECCION QUE LA 0027, LA 0028 Y LA
0029. Se escribio codigo contra un esquema que todavia no estaba aplicado y la
rama entera dejo de funcionar contra la base real: cada peticion que tocaba la
tabla nueva reventaba con un 500 que el navegador ademas reportaba como error de
CORS, porque Starlette no anade cabeceras CORS a una excepcion sin capturar.
Horas buscando en el sitio equivocado.

La regla del proyecto: desplegar codigo no puede exigir que una migracion
concreta ya este puesta. La 0033 espera aprobacion humana, asi que HOY, contra
produccion, esto es lo que tiene que pasar:

- Mandar un mensaje de solo TEXTO funciona exactamente igual que siempre. Esto
  es lo importante: la mensajeria no puede degradarse por una funcion que
  todavia no esta.
- El historial responde con `attachments: []` en todos los mensajes. No es un
  error: no hay adjuntos, y una lista vacia significa eso.
- Mandar un mensaje CON archivos responde 503 y `chat_attachments_not_available`.
  503 y no 404 —que haria pensar que la ruta esta mal escrita— ni 500 —que haria
  pensar que algo se ha roto—. La funcion existe, todavia no esta montada.
- El texto sigue siendo OBLIGATORIO, porque sin la 0033 la restriccion
  `char_length(body) between 1 and 5000` sigue puesta en la tabla y un mensaje
  vacio no entraria. Se rechaza con un 422 legible en vez de dejar que reviente
  contra la base.
- Y el listado de conversaciones, que es lo que se acaba de optimizar, sigue
  respondiendo y sin consultar la tabla que no existe.

COMO SE COMPRUEBA. Se crea el esquema entero y despues se QUITA la tabla que
anade la 0033, dejando la base exactamente como esta hoy produccion.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.messaging import esquema as esquema_mensajes
from app.modules.messaging.models import Conversation, ConversationMember
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

API = "/api/v1/conversations"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
CHAT = "cccccccc-0000-0000-0000-000000000001"


@pytest_asyncio.fixture
async def base_sin_0033():
    """El esquema tal y como esta HOY en produccion: sin `message_attachments`."""
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

        await conn.run_sync(Base.metadata.create_all)

        # Y ahora se DESHACE la 0033, que es lo que se quiere probar.
        await conn.execute(text("drop table message_attachments"))

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(Conversation(id=CHAT, kind="direct", created_by=ANA))
        db.add(ConversationMember(conversation_id=CHAT, user_id=ANA))
        db.add(ConversationMember(conversation_id=CHAT, user_id=BRUNO))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=ANA, email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http, sesiones

    app.dependency_overrides.clear()
    await engine.dispose()


@pytest.mark.asyncio
async def test_un_mensaje_de_texto_funciona_igual_que_siempre(base_sin_0033):
    """Lo que ya existia no puede degradarse por una funcion que todavia no esta."""
    http, _ = base_sin_0033
    respuesta = await http.post(f"{API}/{CHAT}/messages", json={"body": "hola"})
    assert respuesta.status_code == 201
    assert respuesta.json()["body"] == "hola"
    assert respuesta.json()["attachments"] == []


@pytest.mark.asyncio
async def test_el_historial_responde_sin_adjuntos_y_sin_romperse(base_sin_0033):
    http, _ = base_sin_0033
    await http.post(f"{API}/{CHAT}/messages", json={"body": "uno"})
    await http.post(f"{API}/{CHAT}/messages", json={"body": "dos"})

    respuesta = await http.get(f"{API}/{CHAT}/messages")
    assert respuesta.status_code == 200
    cuerpo = respuesta.json()
    assert len(cuerpo) == 2
    assert all(m["attachments"] == [] for m in cuerpo)


@pytest.mark.asyncio
async def test_mandar_un_archivo_responde_503_con_un_codigo_que_se_entiende(
    base_sin_0033,
):
    """Ni 404 ni 500: la funcion existe, todavia no esta puesta."""
    http, _ = base_sin_0033
    respuesta = await http.post(
        f"{API}/{CHAT}/messages",
        json={
            "body": "mira",
            "attachments": [
                {"storage_path": f"{CHAT}/{ANA}/1.jpg", "kind": "image"}
            ],
        },
    )
    assert respuesta.status_code == 503
    assert respuesta.json()["error"]["code"] == "chat_attachments_not_available"


@pytest.mark.asyncio
async def test_un_mensaje_vacio_se_rechaza_con_422_y_no_contra_la_tabla(base_sin_0033):
    """Sin la 0033 la tabla exige al menos un caracter en `body`.

    Dejar que la peticion llegue hasta la base convertiria un dato invalido en
    un 500 —y en un falso error de CORS en el navegador—. Se rechaza antes.
    """
    http, _ = base_sin_0033
    respuesta = await http.post(f"{API}/{CHAT}/messages", json={"body": "   "})
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_el_listado_de_conversaciones_no_toca_la_tabla_que_no_existe(
    base_sin_0033,
):
    """Lo que se acaba de optimizar tiene que seguir funcionando sin la 0033."""
    http, _ = base_sin_0033
    await http.post(f"{API}/{CHAT}/messages", json={"body": "hola"})

    respuesta = await http.get(API)
    assert respuesta.status_code == 200
    fila = respuesta.json()[0]
    assert fila["id"] == CHAT
    assert fila["last_message"] == "hola"
    assert fila["other"]["id"] == BRUNO


@pytest.mark.asyncio
async def test_la_comprobacion_de_esquema_se_hace_una_vez_por_proceso(base_sin_0033):
    """Si se preguntara en cada peticion, cada mensaje costaria un viaje de mas.

    Mirar el esquema no es gratis: el inspector lanza sus propias sentencias
    contra el catalogo de la base. Hacerlo una vez y quedarse con la respuesta
    es lo que permite que el codigo pueda funcionar sin la migracion SIN pagarlo
    en cada peticion.
    """
    http, sesiones = base_sin_0033
    await http.post(f"{API}/{CHAT}/messages", json={"body": "hola"})

    # Todavia no se ha mirado nada.
    assert esquema_mensajes._cache == {}

    assert (await http.get(f"{API}/{CHAT}/messages")).status_code == 200
    # Se ha averiguado, y se ha guardado.
    #
    # SON CUATRO ENTRADAS Y NO UNA porque el historial mira cuatro cosas del
    # esquema: si hay adjuntos (0033, que esta prueba ha quitado), si hay
    # contexto de historia (0044), si hay sesiones en el chat (0097) y si hay
    # reacciones y citas (0106). Lo que
    # esta prueba vigila no es CUANTAS se miran, sino que cada una se mire UNA
    # sola vez por proceso: el bloque de abajo es el que lo comprueba de verdad.
    # Aqui las otras tres salen a `True` porque esta base solo ha deshecho la
    # 0033.
    assert esquema_mensajes._cache == {
        "message_attachments": False,
        "message_story_context": True,
        "message_booking_context": True,
        "message_reactions": True,
    }

    # La segunda peticion ya no vuelve a preguntarle al catalogo.
    sentencias: list[str] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        sentencias.append(statement.lower())

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    try:
        assert (await http.get(f"{API}/{CHAT}/messages")).status_code == 200
    finally:
        event.remove(motor, "before_cursor_execute", _anotar)

    assert not [s for s in sentencias if "pragma" in s or "sqlite_master" in s], (
        "se esta mirando el esquema en cada peticion"
    )
