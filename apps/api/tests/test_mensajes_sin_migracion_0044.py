"""La aplicacion tiene que funcionar SIN la migracion 0044.

LA MISMA LECCION QUE LA 0027, LA 0028, LA 0029, LA 0033 Y LA 0045, y la razon
por la que este fichero existe antes de que la migracion se aplique: se escribio
codigo contra un esquema que todavia no estaba puesto y la rama entera dejo de
funcionar contra la base real. Cada peticion que tocaba la tabla nueva reventaba
con un 500, y el navegador lo enseñaba como un error de CORS —Starlette no anade
cabeceras CORS a una excepcion sin capturar—, o sea horas buscando en el sitio
equivocado.

La 0044 espera aprobacion humana. HOY, contra produccion, esto es lo que tiene
que pasar:

- MANDAR UNA NOTA DE VOZ responde 503 `voice_notes_not_available`. NO un 500,
  que es lo que saldria si la insercion llegara a la base: el `CHECK` de
  `message_attachments.kind` todavia dice ('image','video','document') y
  escribir 'audio' seria una violacion de restriccion. Este es el fallo concreto
  que el encargo pedia evitar, y esta prueba es la que lo vigila.

- Y NO SE GUARDA COMO `document` PARA DISIMULAR. Se comprueba explicitamente:
  despues del 503 no queda ningun adjunto en la conversacion. Un audio
  convertido en documento seria una fila que miente.

- LA INTERFAZ NO OFRECE GRABAR, porque `GET /conversations/availability`
  responde `voice_notes: false` y la pantalla lo consulta antes de pintar el
  microfono. Nunca un boton muerto.

- RESPONDER UNA HISTORIA SIGUE MANDANDO EL MENSAJE, sin su contexto. Se degrada
  el adorno, nunca el contenido: perder el texto de alguien porque una tabla no
  esta seria mucho peor que perder la miniatura de la historia.

- Y TODO LO DEMAS FUNCIONA EXACTAMENTE IGUAL: texto, fotos, historial, borrado y
  bandeja. Una funcion que todavia no esta no puede degradar lo que ya habia.

COMO SE COMPRUEBA. Se crea el esquema entero y despues se QUITA la tabla que
anade la 0044, dejando la base como esta hoy produccion.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.messaging import esquema as esquema_mensajes
from app.modules.messaging.models import (
    Conversation,
    ConversationMember,
    MessageAttachment,
)
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.modules.stories.models import Story
from app.shared.database import Base, get_db

from datetime import datetime, timedelta, timezone

API = "/api/v1/conversations"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
CHAT = "cccccccc-0000-0000-0000-000000000001"
HISTORIA = "55555555-0000-0000-0000-000000000001"

AHORA = datetime(2026, 8, 31, 12, 0, 0, tzinfo=timezone.utc)


def _nota() -> dict:
    return {
        "storage_path": f"{CHAT}/{ANA}/nota.m4a",
        "kind": "audio",
        "mime_type": "audio/mp4",
        "duration_s": 3.2,
    }


@pytest_asyncio.fixture
async def base_sin_0044():
    """El esquema tal y como esta HOY en produccion: sin `message_story_context`."""
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

        # Y ahora se DESHACE la 0044, que es lo que se quiere probar.
        #
        # SOLO SE QUITA LA TABLA, no el `CHECK` de `message_attachments.kind`,
        # porque en SQLite ese `CHECK` no existe: el modelo declara `kind` como
        # un `String(20)` sin restriccion, asi que aqui un 'audio' entraria sin
        # protestar. Precisamente por eso la barrera tiene que estar en el
        # CODIGO y no confiarse a la base — que es lo que estas pruebas
        # comprueban—: en PostgreSQL, donde el `CHECK` si existe, llegar hasta
        # la insercion seria un 500.
        await conn.execute(text("drop table message_story_context"))

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
                caption="hola",
                expires_at=AHORA + timedelta(hours=20),
            )
        )
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


# --------------------------------------------------------------------------- #
# 1. LAS NOTAS DE VOZ: 503, nunca un 500, y nunca un `document` disfrazado
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_mandar_una_nota_de_voz_responde_503_y_no_revienta(base_sin_0044):
    """El fallo concreto que el encargo pedia evitar.

    Sin esta barrera, la insercion llegaria a la base, el `CHECK` de `kind`
    rechazaria 'audio', y eso saldria como un 500 sin cabeceras CORS: en el
    navegador, un fallo de red que manda a mirar al sitio equivocado.
    """
    http, _ = base_sin_0044
    respuesta = await http.post(
        f"{API}/{CHAT}/messages", json={"body": "", "attachments": [_nota()]}
    )
    assert respuesta.status_code == 503
    assert respuesta.json()["error"]["code"] == "voice_notes_not_available"


@pytest.mark.asyncio
async def test_el_audio_rechazado_no_se_cuela_como_documento(base_sin_0044):
    """El parche prohibido, comprobado: no queda NADA guardado."""
    http, sesiones = base_sin_0044
    await http.post(f"{API}/{CHAT}/messages", json={"body": "", "attachments": [_nota()]})

    async with sesiones() as db:
        adjuntos = (await db.execute(select(MessageAttachment))).scalars().all()
    assert adjuntos == [], (
        "se ha guardado un adjunto pese al 503; guardar el audio como "
        "`document` para disimular es exactamente el parche prohibido"
    )


@pytest.mark.asyncio
async def test_la_interfaz_sabe_que_no_debe_ofrecer_grabar(base_sin_0044):
    """Nunca un boton muerto: la pantalla lo pregunta antes de pintar el micro."""
    http, _ = base_sin_0044
    respuesta = await http.get(f"{API}/availability")
    assert respuesta.status_code == 200
    # Cada funcion responde por SU migracion. Aqui falta la 0044 y se mira lo
    # que depende de ella; las reacciones (0106) tienen sus propias pruebas.
    cuerpo = respuesta.json()
    assert cuerpo["voice_notes"] is False
    assert cuerpo["story_replies"] is False


@pytest.mark.asyncio
async def test_un_mensaje_con_foto_sigue_funcionando(base_sin_0044):
    """Que falte el audio no puede estropear los adjuntos que ya habia.

    La comprobacion solo mira si HAY algun audio: un mensaje con fotos no puede
    dejar de funcionar por una migracion que no le afecta.
    """
    http, _ = base_sin_0044
    respuesta = await http.post(
        f"{API}/{CHAT}/messages",
        json={
            "body": "mira",
            "attachments": [
                {
                    "storage_path": f"{CHAT}/{ANA}/a.jpg",
                    "kind": "image",
                    "mime_type": "image/jpeg",
                }
            ],
        },
    )
    assert respuesta.status_code == 201
    assert respuesta.json()["attachments"][0]["kind"] == "image"


# --------------------------------------------------------------------------- #
# 2. RESPONDER UNA HISTORIA: el mensaje se manda igual, sin contexto
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_responder_una_historia_manda_el_mensaje_sin_contexto(base_sin_0044):
    """Se degrada el adorno, NUNCA el contenido.

    Quitarle el mensaje a quien lo escribio porque una tabla todavia no esta
    seria mucho peor que perder la miniatura de la historia.
    """
    http, _ = base_sin_0044
    respuesta = await http.post(
        f"{API}/{CHAT}/messages", json={"body": "¡qué bueno!", "story_id": HISTORIA}
    )
    assert respuesta.status_code == 201
    assert respuesta.json()["body"] == "¡qué bueno!"
    assert respuesta.json()["story_context"] is None


@pytest.mark.asyncio
async def test_el_historial_responde_sin_contexto_y_sin_romperse(base_sin_0044):
    """`story_context: null` en todos: no hay contexto guardado, y eso es la verdad."""
    http, _ = base_sin_0044
    await http.post(f"{API}/{CHAT}/messages", json={"body": "uno", "story_id": HISTORIA})
    await http.post(f"{API}/{CHAT}/messages", json={"body": "dos"})

    respuesta = await http.get(f"{API}/{CHAT}/messages")
    assert respuesta.status_code == 200
    cuerpo = respuesta.json()
    assert len(cuerpo) == 2
    assert all(m["story_context"] is None for m in cuerpo)


# --------------------------------------------------------------------------- #
# 3. Lo que ya habia no se degrada
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_mensaje_de_texto_funciona_igual_que_siempre(base_sin_0044):
    http, _ = base_sin_0044
    respuesta = await http.post(f"{API}/{CHAT}/messages", json={"body": "hola"})
    assert respuesta.status_code == 201
    assert respuesta.json()["body"] == "hola"


@pytest.mark.asyncio
async def test_el_borrado_con_lapida_sigue_funcionando(base_sin_0044):
    http, _ = base_sin_0044
    enviado = await http.post(f"{API}/{CHAT}/messages", json={"body": "ups"})
    borrado = await http.delete(f"{API}/{CHAT}/messages/{enviado.json()['id']}")
    assert borrado.status_code == 204

    historial = (await http.get(f"{API}/{CHAT}/messages")).json()
    assert historial[0]["deleted_at"] is not None
    assert historial[0]["body"] == ""


@pytest.mark.asyncio
async def test_la_bandeja_no_toca_la_tabla_que_no_existe(base_sin_0044):
    http, _ = base_sin_0044
    await http.post(f"{API}/{CHAT}/messages", json={"body": "hola"})

    respuesta = await http.get(API)
    assert respuesta.status_code == 200
    fila = respuesta.json()[0]
    assert fila["id"] == CHAT
    assert fila["last_message"] == "hola"
    assert fila["other"]["id"] == BRUNO


@pytest.mark.asyncio
async def test_el_chat_directo_sigue_siendo_unico(base_sin_0044):
    """La 0039 no depende de la 0044: abrir dos veces devuelve la misma."""
    http, _ = base_sin_0044
    primera = await http.post(f"{API}/direct", json={"user_id": BRUNO})
    segunda = await http.post(f"{API}/direct", json={"user_id": BRUNO})
    assert primera.json()["id"] == segunda.json()["id"] == CHAT


@pytest.mark.asyncio
async def test_la_comprobacion_de_esquema_se_hace_una_vez_por_proceso(base_sin_0044):
    """Preguntarlo en cada peticion costaria un viaje de mas por mensaje."""
    http, _ = base_sin_0044
    assert esquema_mensajes._cache == {}

    await http.post(f"{API}/{CHAT}/messages", json={"body": "hola", "story_id": HISTORIA})
    assert esquema_mensajes._cache["message_story_context"] is False

    # Y la segunda peticion ya no vuelve a mirarlo: sigue valiendo la respuesta.
    await http.post(f"{API}/{CHAT}/messages", json={"body": "otra"})
    assert esquema_mensajes._cache["message_story_context"] is False
