"""Notas de voz: un adjunto de tipo `audio` de verdad, no un `document` disfrazado.

LO QUE ESTE FICHERO DEFIENDE, y es lo unico que hay que leer si se vuelve aqui
dentro de un año: una nota de voz se guarda con `kind: 'audio'`. No como
`document`. Guardarla como documento habria sido el atajo —evita tocar el
`CHECK` de la tabla— y es exactamente lo que el encargo prohibio: la burbuja no
sabria que eso se reproduce, `duration_s` no significaria nada, y no habria
forma de distinguir una nota de voz de un PDF.

EL RESTO ES UN ADJUNTO NORMAL, y eso tambien se comprueba: viaja por el mismo
`POST /conversations/{id}/messages`, se guarda con la misma forma de ruta
—`<conversacion>/<quien sube>/<fichero>`, que es lo que lleva el permiso— y el
otro miembro de la conversacion lo recibe con todo lo que necesita para
reproducirlo.

LAS REGLAS PROPIAS que se prueban aqui son las tres que impiden una burbuja
rota: duracion obligatoria, duracion con sentido (ni cero ni media hora) y tipo
declarado coherente.

LOS BYTES NO EXISTEN. Aqui solo viajan rutas; nada llega a Supabase.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.messaging import audio as reglas_de_audio
from app.modules.messaging import esquema as esquema_mensajes
from app.modules.messaging.models import Conversation, ConversationMember
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

API = "/api/v1/conversations"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
CARLA = "aaaaaaaa-0000-0000-0000-000000000003"

CHAT = "cccccccc-0000-0000-0000-000000000001"
OTRO_CHAT = "cccccccc-0000-0000-0000-000000000002"


def _nota(
    *,
    conversacion: str = CHAT,
    autor: str = ANA,
    nombre: str = "nota.m4a",
    duracion: float | None = 4.5,
    mime: str | None = "audio/mp4",
) -> dict:
    """Una nota de voz tal y como la manda el telefono despues de subirla."""
    adjunto: dict = {
        "storage_path": f"{conversacion}/{autor}/{nombre}",
        "kind": "audio",
        "bytes": 38_000,
    }
    if duracion is not None:
        adjunto["duration_s"] = duracion
    if mime is not None:
        adjunto["mime_type"] = mime
    return adjunto


@pytest_asyncio.fixture
async def entorno():
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
        db.add(Profile(id=CARLA, full_name="Carla", username="carla"))
        db.add(Conversation(id=CHAT, kind="direct", created_by=ANA))
        db.add(ConversationMember(conversation_id=CHAT, user_id=ANA))
        db.add(ConversationMember(conversation_id=CHAT, user_id=BRUNO))
        db.add(Conversation(id=OTRO_CHAT, kind="direct", created_by=CARLA))
        db.add(ConversationMember(conversation_id=OTRO_CHAT, user_id=CARLA))
        db.add(ConversationMember(conversation_id=OTRO_CHAT, user_id=BRUNO))
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
# 1. Se guarda como AUDIO
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_una_nota_de_voz_crea_un_adjunto_de_tipo_audio(entorno):
    """Lo pedido, y la prueba central del fichero."""
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages", json={"body": "", "attachments": [_nota()]}
    )
    assert respuesta.status_code == 201

    adjuntos = respuesta.json()["attachments"]
    assert len(adjuntos) == 1
    assert adjuntos[0]["kind"] == "audio", (
        "la nota de voz no se ha guardado como audio; guardarla como "
        "`document` para no tocar el CHECK es justo el parche prohibido"
    )
    # La duracion es lo que deja pintar la burbuja sin descargar el fichero.
    assert adjuntos[0]["duration_s"] == 4.5


@pytest.mark.asyncio
async def test_una_nota_de_voz_no_se_guarda_nunca_como_documento(entorno):
    """La misma regla, mirada desde el otro lado y en el historial."""
    http, _, _ = entorno
    await http.post(f"{API}/{CHAT}/messages", json={"body": "", "attachments": [_nota()]})

    historial = (await http.get(f"{API}/{CHAT}/messages")).json()
    tipos = [a["kind"] for m in historial for a in m["attachments"]]
    assert tipos == ["audio"]
    assert "document" not in tipos


@pytest.mark.asyncio
async def test_una_nota_de_voz_puede_ir_sola_sin_texto(entorno):
    """Es lo normal: se manda una nota, no una nota con pie de foto."""
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages", json={"body": "", "attachments": [_nota()]}
    )
    assert respuesta.status_code == 201
    assert respuesta.json()["body"] == ""


@pytest.mark.asyncio
async def test_el_audio_de_otra_persona_llega_entero_para_reproducirlo(entorno):
    """Bruno tiene que poder escuchar lo que le mando Ana.

    Lo que necesita para reproducirlo es la RUTA —que el movil firma— y la
    duracion. Sin la ruta no hay nada que sonar; sin la duracion la barra de
    progreso no puede pintarse hasta que el fichero entero se descargue.
    """
    http, _, identidad = entorno
    await http.post(f"{API}/{CHAT}/messages", json={"body": "", "attachments": [_nota()]})

    identidad["uid"] = BRUNO
    historial = (await http.get(f"{API}/{CHAT}/messages")).json()
    adjunto = historial[0]["attachments"][0]
    assert adjunto["kind"] == "audio"
    assert adjunto["storage_path"] == f"{CHAT}/{ANA}/nota.m4a"
    assert adjunto["duration_s"] == 4.5


@pytest.mark.asyncio
async def test_quien_no_es_miembro_no_oye_nada(entorno):
    """Carla no esta en este chat: ni manda ni lee."""
    http, _, identidad = entorno
    await http.post(f"{API}/{CHAT}/messages", json={"body": "", "attachments": [_nota()]})

    identidad["uid"] = CARLA
    assert (await http.get(f"{API}/{CHAT}/messages")).status_code == 403
    enviado = await http.post(
        f"{API}/{CHAT}/messages",
        json={"body": "", "attachments": [_nota(autor=CARLA)]},
    )
    assert enviado.status_code == 403


@pytest.mark.asyncio
async def test_una_nota_de_voz_de_otra_conversacion_se_rechaza(entorno):
    """La ruta lleva el permiso, tambien para el audio.

    Sin esto, alguien podria registrar en su chat la nota de voz de otro y su
    nombre y su duracion quedarian a la vista de quien no debe.
    """
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages",
        json={"body": "", "attachments": [_nota(conversacion=OTRO_CHAT)]},
    )
    assert respuesta.status_code == 422
    assert respuesta.json()["error"]["code"] == "attachment_path_invalid"


@pytest.mark.asyncio
async def test_una_nota_de_voz_convive_con_otros_adjuntos(entorno):
    """Que exista `audio` no puede estropear los tres tipos de siempre."""
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages",
        json={
            "body": "",
            "attachments": [
                {
                    "storage_path": f"{CHAT}/{ANA}/a.jpg",
                    "kind": "image",
                    "mime_type": "image/jpeg",
                },
                _nota(nombre="b.m4a"),
            ],
        },
    )
    assert respuesta.status_code == 201
    assert [a["kind"] for a in respuesta.json()["attachments"]] == ["image", "audio"]


# --------------------------------------------------------------------------- #
# 2. Las reglas propias de una nota de voz
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_una_nota_de_voz_sin_duracion_se_rechaza(entorno):
    """Sin duracion la burbuja no puede decir cuanto dura ni pintar la barra.

    Averiguarla despues obligaria a descargar el fichero entero solo para pintar
    la lista. Quien graba la conoce en el momento: es el unico sitio donde sale
    gratis.
    """
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages",
        json={"body": "", "attachments": [_nota(duracion=None)]},
    )
    assert respuesta.status_code == 422
    assert respuesta.json()["error"]["code"] == "voice_note_without_duration"


@pytest.mark.asyncio
async def test_una_nota_de_voz_de_cero_segundos_se_rechaza(entorno):
    """Es el dedo que resbala, no una nota. Dejaria una burbuja que no suena."""
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages", json={"body": "", "attachments": [_nota(duracion=0)]}
    )
    assert respuesta.status_code == 422
    assert respuesta.json()["error"]["code"] == "voice_note_empty"


@pytest.mark.asyncio
async def test_una_nota_de_voz_demasiado_larga_se_rechaza(entorno):
    """Un chat no es el sitio de una conferencia; para eso esta adjuntar."""
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages",
        json={
            "body": "",
            "attachments": [_nota(duracion=reglas_de_audio.MAX_DURACION_S + 60)],
        },
    )
    assert respuesta.status_code == 422
    assert respuesta.json()["error"]["code"] == "voice_note_too_long"


@pytest.mark.asyncio
async def test_soltar_justo_en_el_limite_no_se_rechaza(entorno):
    """El contador de quien graba y el del codificador no coinciden al ms.

    Sin el margen, soltar el dedo justo en el tope producia un rechazo que desde
    fuera parecia un fallo de la aplicacion.
    """
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages",
        json={
            "body": "",
            "attachments": [_nota(duracion=reglas_de_audio.MAX_DURACION_S + 0.4)],
        },
    )
    assert respuesta.status_code == 201


@pytest.mark.asyncio
async def test_un_archivo_que_no_es_audio_no_pasa_por_nota_de_voz(entorno):
    """`image/png` marcado como nota de voz solo puede ser un error o un intento."""
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages",
        json={"body": "", "attachments": [_nota(mime="image/png")]},
    )
    assert respuesta.status_code == 422
    assert respuesta.json()["error"]["code"] == "voice_note_bad_type"


@pytest.mark.asyncio
async def test_un_grabador_que_no_informa_el_tipo_sigue_valiendo(entorno):
    """Se admite que FALTE el mime; lo que no se admite es que mienta.

    Hay grabadores que no lo informan y el fichero es perfectamente bueno.
    Rechazarlo dejaria sin notas de voz a quien tiene ese telefono.
    """
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages", json={"body": "", "attachments": [_nota(mime=None)]}
    )
    assert respuesta.status_code == 201
    assert respuesta.json()["attachments"][0]["kind"] == "audio"


@pytest.mark.asyncio
async def test_las_reglas_del_audio_no_alcanzan_a_los_demas_adjuntos(entorno):
    """Un documento no tiene duracion y no tiene por que tenerla.

    Si la comprobacion de la duracion se hubiera puesto en `AttachmentCreate` en
    vez de solo para `audio`, esto fallaria: es la prueba de que la regla esta
    en el sitio correcto.
    """
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages",
        json={
            "body": "",
            "attachments": [
                {
                    "storage_path": f"{CHAT}/{ANA}/c.pdf",
                    "kind": "document",
                    "mime_type": "application/pdf",
                    "file_name": "contrato.pdf",
                }
            ],
        },
    )
    assert respuesta.status_code == 201


@pytest.mark.asyncio
async def test_una_nota_de_voz_se_puede_borrar_como_cualquier_mensaje(entorno):
    """El borrado con lapida sigue funcionando con un audio dentro."""
    http, _, identidad = entorno
    enviado = await http.post(
        f"{API}/{CHAT}/messages", json={"body": "", "attachments": [_nota()]}
    )
    message_id = enviado.json()["id"]
    assert (await http.delete(f"{API}/{CHAT}/messages/{message_id}")).status_code == 204

    # Y al otro lado se ve la lapida, sin el audio.
    identidad["uid"] = BRUNO
    historial = (await http.get(f"{API}/{CHAT}/messages")).json()
    assert historial[0]["deleted_at"] is not None
    assert historial[0]["attachments"] == []


# --------------------------------------------------------------------------- #
# 3. Disponibilidad: nunca un boton muerto
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_la_aplicacion_puede_preguntar_si_hay_notas_de_voz(entorno):
    """Con la 0044 puesta, sus dos funciones se ofrecen.

    Sin este endpoint, la unica forma de saberlo seria grabar, subir y recibir
    un 503: alguien hablaria treinta segundos y lo perderia todo.
    """
    http, _, _ = entorno
    respuesta = await http.get(f"{API}/availability")
    assert respuesta.status_code == 200
    # La respuesta entera, para que una funcion nueva no se cuele sin prueba:
    # `reactions` llego con la 0106, que en esta base tambien esta puesta.
    assert respuesta.json() == {
        "voice_notes": True,
        "story_replies": True,
        "reactions": True,
        "preferences": True,
        # La confirmacion de lectura (12/10/2026): no depende de ninguna
        # migracion, asi que se anuncia siempre.
        "read_receipts": True,
        # Los temas (0108) y las comunidades (0109) de un grupo (26/10/2026),
        # que en esta base tambien estan.
        "topics": True,
        "subgroups": True,
        # El nombre de los adjuntos y si un audio es nota de voz (0113,
        # 30/10/2026), que en esta base también está.
        "attachment_titles": True,
    }


@pytest.mark.asyncio
async def test_availability_no_se_confunde_con_un_id_de_conversacion(entorno):
    """La ruta se declara antes que las demas justo para esto."""
    http, _, _ = entorno
    assert (await http.get(f"{API}/availability")).status_code == 200
