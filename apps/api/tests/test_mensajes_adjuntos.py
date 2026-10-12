"""Adjuntos privados de chat, de extremo a extremo sobre una base de verdad.

QUE SE COMPRUEBA AQUI Y NO CABE EN UNA FUNCION PURA. Casi todo lo de los
adjuntos es una regla que cruza quien pregunta, a que conversacion pertenece y
donde vive el archivo: que un mensaje pueda ser solo texto, solo archivo o las
dos cosas; que la RUTA del archivo tenga que corresponder a ESTA conversacion y
a la carpeta de quien lo manda; que nadie de fuera lea nada; y que el historial
no pague una consulta por mensaje para traer sus archivos.

LO QUE NO SE PRUEBA AQUI, y a proposito: EJECUTAR las politicas RLS del bucket
`message-media`. Viven en PostgreSQL y en Supabase Storage, y esto corre sobre
SQLite; comprobarlas de verdad exigiria un proyecto real. Lo que si se prueba es
la otra mitad de esa defensa, la que si es del backend: que la ruta que se
GUARDA no pueda apuntar a otra conversacion ni a la carpeta de otra persona. Las
dos comprueban lo mismo desde los dos lados a proposito, porque si una falla la
otra sigue en pie.

Y al final del fichero hay una tercera cosa, mas barata: LEER la migracion 0033
y comprobar que el bucket sigue declarado privado y con las politicas que lo
hacen privado. No ejecuta nada, asi que no sustituye a un proyecto real; lo que
impide es que un cambio futuro abra el bucket sin que nadie se entere, que es la
unica forma realista de que estas fotos dejen de ser privadas.

Los archivos de estos escenarios NO existen: aqui solo viajan rutas. Nada llega
a Supabase y nada se sube a ningun sitio.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.messaging import esquema as esquema_mensajes
from app.modules.messaging.models import Conversation, ConversationMember, Message
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

API = "/api/v1/conversations"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
CARLA = "aaaaaaaa-0000-0000-0000-000000000003"

CHAT = "cccccccc-0000-0000-0000-000000000001"
OTRO_CHAT = "cccccccc-0000-0000-0000-000000000002"


#: Un instante fijo del que colgar los mensajes cuyo ORDEN importa.
#:
#: Hace falta porque el `now()` de SQLite tiene resolucion de SEGUNDO: dos
#: mensajes enviados seguidos por HTTP comparten marca de tiempo y cual es «el
#: ultimo» pasa a decidirlo el desempate por id, que es aleatorio. En PostgreSQL
#: —que es donde corre esto de verdad— cada insercion cae en su propia
#: transaccion y trae microsegundos, asi que el caso no se da. Es un artefacto
#: del motor de pruebas, no del codigo.
ORIGEN = datetime(2026, 8, 25, 12, 0, 0, tzinfo=timezone.utc)


async def _fechar(sesiones, message_id: str, segundos: int) -> None:
    """Le pone al mensaje una hora exacta, para poder comprobar el orden."""
    async with sesiones() as db:
        await db.execute(
            update(Message)
            .where(Message.id == message_id)
            .values(created_at=ORIGEN + timedelta(seconds=segundos))
        )
        await db.commit()


def _foto(conversacion: str = CHAT, autor: str = ANA, nombre: str = "1.jpg") -> dict:
    return {
        "storage_path": f"{conversacion}/{autor}/{nombre}",
        "kind": "image",
        "mime_type": "image/jpeg",
        "width": 1200,
        "height": 900,
        "bytes": 240_000,
    }


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

        await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        db.add(Profile(id=CARLA, full_name="Carla", username="carla"))
        # Ana y Bruno hablan; Carla tiene su propio chat con Bruno.
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
# 1. Las tres formas de un mensaje
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_mensaje_puede_ser_solo_texto(entorno):
    """Lo de siempre tiene que seguir funcionando exactamente igual."""
    http, _, _ = entorno
    respuesta = await http.post(f"{API}/{CHAT}/messages", json={"body": "hola"})
    assert respuesta.status_code == 201
    assert respuesta.json()["body"] == "hola"
    assert respuesta.json()["attachments"] == []


@pytest.mark.asyncio
async def test_un_mensaje_puede_ser_solo_un_archivo(entorno):
    """Mandar una foto sin escribir nada es lo NORMAL en un chat.

    Antes era imposible: `body` exigia al menos un caracter, tanto en el esquema
    de la peticion como en la restriccion de la tabla.
    """
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages", json={"body": "", "attachments": [_foto()]}
    )
    assert respuesta.status_code == 201
    cuerpo = respuesta.json()
    assert cuerpo["body"] == ""
    assert len(cuerpo["attachments"]) == 1
    assert cuerpo["attachments"][0]["kind"] == "image"
    assert cuerpo["attachments"][0]["width"] == 1200


@pytest.mark.asyncio
async def test_un_mensaje_puede_llevar_texto_y_archivo(entorno):
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages",
        json={"body": "mira esto", "attachments": [_foto()]},
    )
    assert respuesta.status_code == 201
    assert respuesta.json()["body"] == "mira esto"
    assert len(respuesta.json()["attachments"]) == 1


@pytest.mark.asyncio
async def test_un_mensaje_sin_texto_y_sin_archivo_se_rechaza(entorno):
    """Una burbuja vacia no es un mensaje: solo confunde a quien la recibe."""
    http, _, _ = entorno
    assert (
        await http.post(f"{API}/{CHAT}/messages", json={"body": "   "})
    ).status_code == 422
    assert (
        await http.post(f"{API}/{CHAT}/messages", json={"body": ""})
    ).status_code == 422


@pytest.mark.asyncio
async def test_los_tres_tipos_de_adjunto_y_ninguno_mas(entorno):
    """Foto, video y documento: los que trajo la 0033.

    LA 0044 AÑADIO UN CUARTO, `audio`, para las notas de voz. No se prueba aqui
    porque tiene reglas propias —duracion obligatoria, tope de minutos, tipo
    MIME— y sobre todo porque no se puede escribir mientras esa migracion no
    este aplicada: eso vive en `test_notas_de_voz.py` y en
    `test_mensajes_sin_migracion_0044.py`. Lo que sigue valiendo aqui es que un
    tipo INVENTADO no entra.
    """
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages",
        json={
            "body": "",
            "attachments": [
                _foto(nombre="a.jpg"),
                {
                    "storage_path": f"{CHAT}/{ANA}/b.mp4",
                    "kind": "video",
                    "mime_type": "video/mp4",
                    "duration_s": 12.5,
                },
                {
                    "storage_path": f"{CHAT}/{ANA}/c.pdf",
                    "kind": "document",
                    "mime_type": "application/pdf",
                    "file_name": "contrato firmado.pdf",
                    "bytes": 90_000,
                },
            ],
        },
    )
    assert respuesta.status_code == 201
    adjuntos = respuesta.json()["attachments"]
    assert [a["kind"] for a in adjuntos] == ["image", "video", "document"]
    # El nombre original es lo UNICO que identifica a un documento: la ruta
    # lleva un nombre aleatorio para que dos personas no se pisen.
    assert adjuntos[2]["file_name"] == "contrato firmado.pdf"

    # Un cuarto tipo no entra: seria una fila que ninguna pantalla sabe mostrar.
    malo = await http.post(
        f"{API}/{CHAT}/messages",
        json={
            "body": "",
            "attachments": [{"storage_path": f"{CHAT}/{ANA}/x", "kind": "ejecutable"}],
        },
    )
    assert malo.status_code == 422


@pytest.mark.asyncio
async def test_el_orden_de_los_adjuntos_se_respeta(entorno):
    """Quien manda tres fotos las manda en un orden, y ese es el que vale."""
    http, _, _ = entorno
    await http.post(
        f"{API}/{CHAT}/messages",
        json={
            "body": "",
            "attachments": [_foto(nombre=f"{i}.jpg") for i in range(3)],
        },
    )
    historial = (await http.get(f"{API}/{CHAT}/messages")).json()
    rutas = [a["storage_path"] for a in historial[0]["attachments"]]
    assert rutas == [f"{CHAT}/{ANA}/{i}.jpg" for i in range(3)]


# --------------------------------------------------------------------------- #
# 2. La ruta es la mitad de la privacidad
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_no_se_puede_colgar_un_archivo_de_otra_conversacion(entorno):
    """EL ATAQUE QUE ESTO IMPIDE.

    Bruno esta en las dos conversaciones. Si pudiera registrar en el chat con
    Ana la ruta de un archivo del chat con Carla, ese archivo pasaria a estar en
    la carpeta de una conversacion de la que Ana SI es miembro: la politica del
    bucket le daria los bytes, y ademas el listado le ensenaria el nombre del
    fichero y su tamano. Una fuga entre chats sin tocar Storage.
    """
    http, _, identidad = entorno
    identidad["uid"] = BRUNO
    respuesta = await http.post(
        f"{API}/{CHAT}/messages",
        json={"body": "", "attachments": [_foto(conversacion=OTRO_CHAT, autor=BRUNO)]},
    )
    assert respuesta.status_code == 422
    assert respuesta.json()["error"]["code"] == "attachment_path_invalid"


@pytest.mark.asyncio
async def test_no_se_puede_colgar_un_archivo_de_la_carpeta_de_otra_persona(entorno):
    """La segunda carpeta es de quien sube, y sale del JWT.

    Sin esto, Ana podria registrar como suya la ruta de un archivo que subio
    Bruno y hacerlo pasar por un envio propio.
    """
    http, _, _ = entorno
    respuesta = await http.post(
        f"{API}/{CHAT}/messages",
        json={"body": "", "attachments": [_foto(autor=BRUNO)]},
    )
    assert respuesta.status_code == 422
    assert respuesta.json()["error"]["code"] == "attachment_path_invalid"


@pytest.mark.asyncio
async def test_una_ruta_que_intenta_escaparse_de_su_carpeta_se_rechaza(entorno):
    """`..` y las barras de mas: la ruta guardada tiene que ser exactamente la
    que la politica del bucket sabe comprobar."""
    http, _, _ = entorno
    for ruta in (
        f"{CHAT}/{ANA}/../../{OTRO_CHAT}/x.jpg",
        f"{CHAT}/{ANA}/sub/x.jpg",
        f"{CHAT}/{ANA}/",
        f"{ANA}/x.jpg",
        "x.jpg",
    ):
        respuesta = await http.post(
            f"{API}/{CHAT}/messages",
            json={
                "body": "",
                "attachments": [{"storage_path": ruta, "kind": "image"}],
            },
        )
        assert respuesta.status_code == 422, f"se ha admitido la ruta {ruta}"
        assert respuesta.json()["error"]["code"] == "attachment_path_invalid"


@pytest.mark.asyncio
async def test_quien_no_es_miembro_no_manda_ni_lee_adjuntos(entorno):
    """Carla no esta en el chat de Ana y Bruno: para ella no existe."""
    http, _, identidad = entorno
    await http.post(f"{API}/{CHAT}/messages", json={"body": "", "attachments": [_foto()]})

    identidad["uid"] = CARLA
    assert (await http.get(f"{API}/{CHAT}/messages")).status_code == 403
    assert (
        await http.post(
            f"{API}/{CHAT}/messages",
            json={"body": "", "attachments": [_foto(autor=CARLA)]},
        )
    ).status_code == 403


@pytest.mark.asyncio
async def test_el_otro_miembro_si_ve_el_adjunto(entorno):
    """Lo contrario del anterior: privado no puede querer decir invisible."""
    http, _, identidad = entorno
    await http.post(
        f"{API}/{CHAT}/messages", json={"body": "toma", "attachments": [_foto()]}
    )
    identidad["uid"] = BRUNO
    historial = (await http.get(f"{API}/{CHAT}/messages")).json()
    assert len(historial) == 1
    assert historial[0]["attachments"][0]["storage_path"] == f"{CHAT}/{ANA}/1.jpg"


# --------------------------------------------------------------------------- #
# 3. Rendimiento: los adjuntos no pueden reintroducir el N+1
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_historial_con_adjuntos_no_hace_una_consulta_por_mensaje(entorno):
    """Traer los archivos de treinta mensajes tiene que costar UNA consulta.

    Es exactamente el fallo que se acaba de quitar del listado de
    conversaciones, y la forma mas facil de volver a meterlo es resolver los
    adjuntos dentro del bucle que arma la respuesta.
    """
    http, sesiones, _ = entorno
    for i in range(30):
        await http.post(
            f"{API}/{CHAT}/messages",
            json={"body": "", "attachments": [_foto(nombre=f"{i}.jpg")]},
        )
    assert (await http.get(f"{API}/{CHAT}/messages", params={"limit": 30})).status_code == 200

    consultas: list[str] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        consultas.append(statement)

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    try:
        respuesta = await http.get(f"{API}/{CHAT}/messages", params={"limit": 30})
    finally:
        event.remove(motor, "before_cursor_execute", _anotar)

    cuerpo = respuesta.json()
    assert len(cuerpo) == 30
    assert all(len(m["attachments"]) == 1 for m in cuerpo)
    selects = [c for c in consultas if c.lstrip().lower().startswith("select")]
    # Ocho: siete desde la 0106 (reacciones y citas de la pagina, una consulta
    # cada una) y una mas desde la 0107 (desde cuando quiere ver el chat quien
    # pregunta). Sigue sin depender de cuantos mensajes hay, que es lo que se
    # vigila.
    assert len(selects) <= 8, f"{len(selects)} consultas para 30 mensajes con adjunto"


@pytest.mark.asyncio
async def test_un_historial_sin_adjuntos_no_pregunta_por_un_id_vacio(entorno):
    """Trampa numero uno del repo: `in_([])` «arreglado» con `or [""]`.

    En SQLite la cadena vacia cuela; en PostgreSQL asyncpg la rechaza y el
    manejador de `DBAPIError` la convierte en un 404 mudo. Un chat sin mensajes
    es el caso NORMAL al abrir una conversacion nueva.
    """
    http, sesiones, _ = entorno

    vistas: list[tuple[str, object]] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        vistas.append((statement, args[0] if args else ()))

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    try:
        respuesta = await http.get(f"{API}/{CHAT}/messages")
    finally:
        event.remove(motor, "before_cursor_execute", _anotar)

    assert respuesta.status_code == 200
    assert respuesta.json() == []
    culpables = [
        sentencia
        for sentencia, parametros in vistas
        if "" in (parametros.values() if isinstance(parametros, dict) else parametros)
    ]
    assert not culpables, f"consulta con un id vacio: {culpables}"


# --------------------------------------------------------------------------- #
# 4. La lista de conversaciones tiene que decir la verdad
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_una_foto_sin_texto_no_deja_la_lista_diciendo_sin_mensajes(entorno):
    """El resumen de la fila lo lee quien decide si abrir el chat.

    Sin esto, mandar una foto dejaba la conversacion diciendo «Sin mensajes
    aun»: quien la recibe no sabe que le ha llegado nada.
    """
    http, sesiones, identidad = entorno
    foto = (
        await http.post(
            f"{API}/{CHAT}/messages", json={"body": "", "attachments": [_foto()]}
        )
    ).json()
    await _fechar(sesiones, foto["id"], 0)

    identidad["uid"] = BRUNO
    fila = next(f for f in (await http.get(API)).json() if f["id"] == CHAT)
    assert fila["last_message"] == "Foto"
    assert fila["unread_count"] == 1

    documento = (
        await http.post(
            f"{API}/{CHAT}/messages",
            json={
                "body": "",
                "attachments": [
                    {
                        "storage_path": f"{CHAT}/{BRUNO}/x.pdf",
                        "kind": "document",
                        "file_name": "informe.pdf",
                    }
                ],
            },
        )
    ).json()
    await _fechar(sesiones, documento["id"], 10)

    fila = next(f for f in (await http.get(API)).json() if f["id"] == CHAT)
    assert fila["last_message"] == "Archivo"


@pytest.mark.asyncio
async def test_el_listado_no_consulta_los_adjuntos_si_no_hace_falta(entorno):
    """Solo se pregunta por los mensajes que de verdad no llevan texto.

    En una lista normal —todo texto— esa consulta ni se lanza, asi que los
    adjuntos no le cuestan nada a quien no los usa.
    """
    http, sesiones, _ = entorno
    await http.post(f"{API}/{CHAT}/messages", json={"body": "hola"})
    assert (await http.get(API)).status_code == 200

    consultas: list[str] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        consultas.append(statement)

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    try:
        await http.get(API)
    finally:
        event.remove(motor, "before_cursor_execute", _anotar)

    assert not [c for c in consultas if "message_attachments" in c.lower()]


# --------------------------------------------------------------------------- #
# 5. Novedades: `after` es lo que completa lo que Realtime no sabe
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_after_trae_solo_lo_nuevo_con_sus_adjuntos(entorno):
    """Realtime entrega la fila cruda de `messages`, que no sabe de archivos.

    La burbuja de texto sale al instante y despues se completa preguntando por
    lo ocurrido DESPUES del ultimo mensaje conocido: una peticion por rafaga, no
    una por mensaje. De paso repara lo que Realtime se pierda cuando el telefono
    estuvo en segundo plano.
    """
    http, sesiones, identidad = entorno
    primero = (await http.post(f"{API}/{CHAT}/messages", json={"body": "uno"})).json()
    await _fechar(sesiones, primero["id"], 0)

    identidad["uid"] = BRUNO
    segundo = (
        await http.post(
            f"{API}/{CHAT}/messages",
            json={"body": "", "attachments": [_foto(autor=BRUNO, nombre="b.jpg")]},
        )
    ).json()
    await _fechar(sesiones, segundo["id"], 10)

    identidad["uid"] = ANA
    nuevos = (
        await http.get(
            f"{API}/{CHAT}/messages", params={"after": ORIGEN.isoformat()}
        )
    ).json()
    assert len(nuevos) == 1
    assert nuevos[0]["sender"]["id"] == BRUNO
    assert nuevos[0]["attachments"][0]["storage_path"] == f"{CHAT}/{BRUNO}/b.jpg"


# --------------------------------------------------------------------------- #
# 7. El bucket sigue siendo PRIVADO
#
# Esto lee la migracion, no ejecuta la politica: no hay PostgreSQL aqui. Aun
# asi es lo unico que puede fallar en silencio. Una foto mandada por privado se
# vuelve legible por toda la aplicacion con un `public = true` en una migracion
# futura, o quitando la comprobacion de pertenencia de la politica de lectura, y
# nada de eso rompe ninguna prueba ni da ningun error: simplemente, un dia, los
# adjuntos de los chats de otros se pueden abrir.
#
# Se recorren TODAS las migraciones y no solo la 0033, porque el riesgo no es
# que la 0033 este mal —esta bien— sino que otra posterior la deshaga.
# --------------------------------------------------------------------------- #
MIGRACIONES = Path(__file__).resolve().parents[3] / "supabase" / "migrations"


@pytest.fixture(scope="module")
def sql_0033() -> str:
    ruta = MIGRACIONES / "0033_adjuntos_de_chat.sql"
    assert ruta.exists(), f"No se encuentra la migracion en {ruta}"
    return ruta.read_text(encoding="utf-8")


def test_el_bucket_de_los_adjuntos_nace_privado(sql_0033):
    """`public = false`. Con `true`, cualquiera con la URL abre el fichero."""
    assert re.search(
        r"insert\s+into\s+storage\.buckets.*?values\s*\(\s*'message-media'\s*,"
        r"\s*'message-media'\s*,\s*false\s*\)",
        sql_0033,
        re.IGNORECASE | re.DOTALL,
    ), "El bucket message-media ya no se crea privado."


def test_leer_un_adjunto_exige_ser_miembro_de_la_conversacion(sql_0033):
    """La politica de lectura pregunta por la PERTENENCIA, no por tener cuenta.

    Es justo lo contrario que `post-media`, donde basta con estar registrado
    (y desde la 0018, ni eso). Si esta politica se relajara a `authenticated` a
    secas, toda la aplicacion podria leer los chats de todos.
    """
    politica = re.search(
        r"create\s+policy\s+message_media_member_read.*?;",
        sql_0033,
        re.IGNORECASE | re.DOTALL,
    )
    assert politica, "Ya no existe la politica de lectura del bucket."
    cuerpo = politica.group(0)
    assert "to authenticated" in cuerpo.lower(), (
        "La lectura del bucket dejo de exigir sesion."
    )
    assert "es_miembro_de_la_ruta" in cuerpo, (
        "La lectura del bucket ya no comprueba que quien pregunta sea miembro "
        "de la conversacion que nombra la ruta."
    )


def test_escribir_exige_miembro_y_carpeta_propia(sql_0033):
    """La ruta lleva el permiso: <conversacion>/<quien sube>/<fichero>.

    Es la MISMA forma que valida `_validar_rutas` en el backend. Si una de las
    dos mitades se cae, la otra sigue en pie; si se cae esta, alguien podria
    subir haciendose pasar por otro.
    """
    politica = re.search(
        r"create\s+policy\s+message_media_member_write.*?;",
        sql_0033,
        re.IGNORECASE | re.DOTALL,
    )
    assert politica, "Ya no existe la politica de escritura del bucket."
    cuerpo = politica.group(0)
    assert "es_miembro_de_la_ruta" in cuerpo
    assert "auth.uid()" in cuerpo, (
        "La escritura dejo de exigir que la segunda carpeta sea la de quien sube."
    )


def test_la_comprobacion_de_la_ruta_no_revienta_con_una_carpeta_que_no_es_uuid():
    """`es_miembro_de_la_ruta` devuelve false, no lanza.

    Una politica que LANZA no deniega el acceso: revienta la consulta entera.
    Bastaria con que alguien subiera `basura/x.jpg` para tumbar el listado del
    bucket. Por eso la funcion comprueba la forma antes de convertir a uuid.
    """
    sql = (MIGRACIONES / "0033_adjuntos_de_chat.sql").read_text(encoding="utf-8")
    funcion = re.search(
        r"create\s+or\s+replace\s+function\s+public\.es_miembro_de_la_ruta.*?\$\$;",
        sql,
        re.IGNORECASE | re.DOTALL,
    )
    assert funcion, "Ya no existe es_miembro_de_la_ruta."
    cuerpo = funcion.group(0)
    assert "return false" in cuerpo.lower(), (
        "La funcion ya no devuelve false ante una carpeta con forma invalida."
    )


def test_ninguna_migracion_posterior_abre_el_bucket():
    """Nadie vuelve `message-media` publico mas adelante."""
    for ruta in sorted(MIGRACIONES.glob("*.sql")):
        texto = ruta.read_text(encoding="utf-8")
        if "message-media" not in texto:
            continue
        for linea in re.findall(
            r"update\s+storage\.buckets.*?where\s+id\s*=\s*'message-media'",
            texto,
            re.IGNORECASE | re.DOTALL,
        ):
            assert not re.search(r"public\s*=\s*true", linea, re.IGNORECASE), (
                f"{ruta.name} vuelve publico el bucket de los adjuntos de chat."
            )
        assert not re.search(
            r"values\s*\(\s*'message-media'\s*,\s*'message-media'\s*,\s*true\s*\)",
            texto,
            re.IGNORECASE,
        ), f"{ruta.name} crea publico el bucket de los adjuntos de chat."
