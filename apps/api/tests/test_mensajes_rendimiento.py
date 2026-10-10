"""La pantalla de Mensajes no puede pagar una consulta por conversacion.

EL FALLO QUE FIJA ESTE FICHERO, con numeros medidos sobre esta misma prueba.

`GET /conversations` construia cada fila por separado: por CADA conversacion
pedia el perfil del otro participante, el ultimo mensaje y la cuenta de no
leidos. Mas la consulta del listado, eso es `1 + 3N`. Contando las consultas
reales con un escucha de SQLAlchemy sobre veinte conversaciones salian 61
SELECT. Y no habia paginacion: se traian todas, no las que caben en pantalla.

Contra SQLite en memoria eso no se nota —son microsegundos— y por eso la suite
pasaba en verde con el problema dentro. Contra Supabase cada consulta es un
viaje por la red de 20-30 ms, asi que 61 consultas son mas de un segundo y medio
de espera solo en idas y vueltas, para pintar una lista de texto. Ese era el
motivo de que Mensajes tardara.

POR QUE SE CUENTAN CONSULTAS Y NO TIEMPO. El tiempo de una prueba depende de la
maquina y de la base; el numero de consultas es la propiedad que de verdad se
quiere fijar. Cuatro consultas son cuatro con tres conversaciones y con ochenta,
y esa es la unica forma de que una regresion —alguien vuelve a meter un `await`
dentro de un bucle— falle aqui en vez de aparecer como «la aplicacion va lenta»
tres semanas despues.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
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

#: Un instante fijo del que colgar todo. Hace falta porque el `now()` de SQLite
#: tiene resolucion de SEGUNDO: varios mensajes escritos seguidos comparten hora
#: y el orden dejaria de ser comprobable, cuando en PostgreSQL —que es donde
#: corre esto— cada insercion trae su propia marca de microsegundos.
ORIGEN = datetime(2026, 8, 25, 12, 0, 0, tzinfo=timezone.utc)


def _instante(segundos: int) -> datetime:
    return ORIGEN + timedelta(seconds=segundos)


@pytest_asyncio.fixture
async def entorno():
    cache.vaciar()
    esquema.olvidar()
    # La memoria de que existe `message_attachments` vive en el PROCESO, no en
    # la base, y cada prueba levanta la suya. Sin vaciarla, la que corre «sin la
    # 0033» heredaria el «si» de esta y comprobaria otra cosa.
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


async def _sembrar_conversaciones(
    sesiones, cuantas: int, *, mensajes_por_conversacion: int = 3, desde: int = 0
) -> list[str]:
    """Conversaciones directas de Ana con Bruno, cada una con su historial.

    `desde` desplaza los identificadores para poder sembrar dos tandas en la
    misma base sin que choquen las claves primarias.
    """
    ids: list[str] = []
    async with sesiones() as db:
        for i in range(desde, desde + cuantas):
            conv_id = f"cccccccc-0000-0000-0000-{i:012d}"
            ids.append(conv_id)
            db.add(
                Conversation(
                    id=conv_id,
                    kind="direct",
                    created_by=ANA,
                    created_at=_instante(i),
                    updated_at=_instante(i),
                )
            )
            db.add(ConversationMember(conversation_id=conv_id, user_id=ANA))
            db.add(ConversationMember(conversation_id=conv_id, user_id=BRUNO))
            for j in range(mensajes_por_conversacion):
                db.add(
                    Message(
                        id=f"dddddddd-{i:04d}-0000-0000-{j:012d}",
                        conversation_id=conv_id,
                        # Alterna quien escribe: si escribiera siempre Ana no
                        # habria nada «sin leer» que contar.
                        sender_id=BRUNO if j % 2 == 0 else ANA,
                        body=f"conversacion {i} mensaje {j}",
                        created_at=_instante(i * 100 + j),
                    )
                )
        await db.commit()
    return ids


def _escuchar(sesiones):
    """Devuelve (lista_de_consultas, quitar) para contar SQL de verdad."""
    consultas: list[tuple[str, object]] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        consultas.append((statement, args[0] if args else ()))

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    return consultas, lambda: event.remove(motor, "before_cursor_execute", _anotar)


def _selects(consultas) -> list[str]:
    return [s for s, _ in consultas if s.lstrip().lower().startswith("select")]


# --------------------------------------------------------------------------- #
# 1. El numero de consultas no crece con las conversaciones
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_numero_de_consultas_no_crece_con_las_conversaciones(entorno):
    """PROHIBIDO una consulta por conversacion.

    Se mide con DOS tamanos distintos y se exige el MISMO numero. Un tope fijo
    a secas se puede satisfacer por casualidad —basta con que el caso de prueba
    sea pequeno—; que tres conversaciones y treinta cuesten lo mismo solo puede
    pasar si de verdad no hay nada por conversacion.
    """
    http, sesiones, _ = entorno

    await _sembrar_conversaciones(sesiones, 3)
    # Un viaje en vacio primero: lo que se cachea por proceso no debe contarse.
    assert (await http.get(API, params={"limit": 100})).status_code == 200

    consultas, quitar = _escuchar(sesiones)
    try:
        pocas = await http.get(API, params={"limit": 100})
    finally:
        quitar()
    con_3 = len(_selects(consultas))
    assert pocas.status_code == 200
    assert len(pocas.json()) == 3

    # Otras veintisiete, hasta treinta en total.
    await _sembrar_conversaciones(sesiones, 27, desde=3)

    consultas, quitar = _escuchar(sesiones)
    try:
        muchas = await http.get(API, params={"limit": 100})
    finally:
        quitar()
    con_30 = len(_selects(consultas))

    assert muchas.status_code == 200
    assert len(muchas.json()) == 30
    assert con_3 == con_30, (
        f"{con_3} consultas para 3 conversaciones y {con_30} para 30: "
        "el coste sigue creciendo con la lista"
    )
    # El listado son cuatro: la pagina, los perfiles, los ultimos mensajes y los
    # no leidos. El margen deja sitio a la comprobacion de esquema sin permitir
    # que se cuele un bucle.
    assert con_30 <= 6, f"{con_30} consultas para pintar una lista"


# --------------------------------------------------------------------------- #
# 2. Lo que responde sigue siendo verdad
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_listado_dice_el_otro_participante_el_ultimo_mensaje_y_los_no_leidos(
    entorno,
):
    """Quitar el N+1 no puede cambiar la respuesta: se comprueba campo a campo."""
    http, sesiones, _ = entorno
    await _sembrar_conversaciones(sesiones, 2, mensajes_por_conversacion=5)

    filas = (await http.get(API)).json()
    assert len(filas) == 2

    # La mas reciente primero: la conversacion 1 se creo despues que la 0.
    primera = filas[0]
    assert primera["other"]["id"] == BRUNO
    assert primera["other"]["full_name"] == "Bruno"
    assert primera["last_message"] == "conversacion 1 mensaje 4"
    # Bruno escribio los mensajes pares (0, 2, 4) y Ana no ha leido ninguno.
    assert primera["unread_count"] == 3


@pytest.mark.asyncio
async def test_marcar_leido_pone_los_no_leidos_a_cero(entorno):
    """El umbral es por conversacion, y agrupar no puede confundirlos."""
    http, sesiones, _ = entorno
    ids = await _sembrar_conversaciones(sesiones, 3, mensajes_por_conversacion=4)

    assert (await http.post(f"{API}/{ids[1]}/read")).status_code == 204

    por_id = {f["id"]: f for f in (await http.get(API)).json()}
    assert por_id[ids[1]]["unread_count"] == 0, "la leida sigue contando"
    assert por_id[ids[0]]["unread_count"] == 2, "se ha marcado de mas"
    assert por_id[ids[2]]["unread_count"] == 2, "se ha marcado de mas"


@pytest.mark.asyncio
async def test_una_conversacion_sin_mensajes_no_desaparece_ni_inventa_un_ultimo(entorno):
    """Una conversacion sin mensajes es el caso NORMAL, no un caso de borde.

    Con la funcion de ventana es facil escribir un JOIN que se coma las filas
    sin mensajes; entonces una conversacion recien creada desapareceria de la
    lista, y ademas por el motivo equivocado.

    SE PRUEBA CON UN GRUPO, y antes se probaba con un chat directo. El cambio no
    es cosmetico: los chats directos SIN MENSAJES ya no salen en la bandeja a
    proposito (ver `_TIENE_ALGUN_MENSAJE` en `messaging/router.py`), porque
    pulsar «Mensaje» en un perfil creaba la conversacion aunque luego no se
    escribiera y eso llenaba Mensajes de filas «Sin mensajes aun». Un grupo si
    sale vacio —se crea a proposito y con titulo— asi que sigue habiendo un
    camino por el que una fila SIN MENSAJES llega hasta `leer_conversaciones`,
    que es lo que este fichero tiene que vigilar. Que el filtro esconda los
    directos vacios lo prueba `test_chat_directo_unico.py`; lo que se comprueba
    aqui es que quien SI tiene que salir, sale, y sin inventarse un ultimo
    mensaje.
    """
    http, sesiones, _ = entorno
    async with sesiones() as db:
        conv_id = "cccccccc-1111-0000-0000-000000000000"
        db.add(
            Conversation(id=conv_id, kind="group", title="Equipo", created_by=ANA)
        )
        db.add(ConversationMember(conversation_id=conv_id, user_id=ANA))
        db.add(ConversationMember(conversation_id=conv_id, user_id=CARLA))
        await db.commit()

    filas = (await http.get(API)).json()
    assert len(filas) == 1
    assert filas[0]["id"] == conv_id
    assert filas[0]["last_message"] is None
    assert filas[0]["last_message_at"] is None
    assert filas[0]["unread_count"] == 0


@pytest.mark.asyncio
async def test_abrir_un_chat_directo_vacio_lo_devuelve_aunque_no_salga_en_la_lista(
    entorno,
):
    """Esconder una fila de la bandeja no es borrarla.

    `POST /conversations/direct` responde con la conversacion recien creada
    —vacia— porque la pantalla de chat necesita ese id para abrirse. El filtro
    de vacios vive SOLO en la consulta del listado; si se colara en el lector
    comun (`leer_conversaciones`), pulsar «Mensaje» devolveria un 404 y el boton
    dejaria de funcionar.
    """
    http, _, _ = entorno

    respuesta = await http.post(f"{API}/direct", json={"user_id": CARLA})

    assert respuesta.status_code == 200
    cuerpo = respuesta.json()
    assert cuerpo["other"]["id"] == CARLA
    assert cuerpo["last_message"] is None
    assert cuerpo["unread_count"] == 0
    # Y sin embargo no ensucia la bandeja.
    assert cuerpo["id"] not in [f["id"] for f in (await http.get(API)).json()]


@pytest.mark.asyncio
async def test_un_mensaje_borrado_no_puede_ser_el_ultimo(entorno):
    """`deleted_at` tiene que filtrarse tambien dentro de la funcion de ventana.

    Si se numera primero y se filtra despues, la conversacion cuyo ultimo
    mensaje se borro sale SIN previsualizacion en vez de con el anterior.
    """
    http, sesiones, _ = entorno
    ids = await _sembrar_conversaciones(sesiones, 1, mensajes_por_conversacion=3)
    async with sesiones() as db:
        ultimo = await db.get(Message, "dddddddd-0000-0000-0000-000000000002")
        ultimo.deleted_at = _instante(500)
        await db.commit()

    filas = (await http.get(API)).json()
    assert filas[0]["id"] == ids[0]
    assert filas[0]["last_message"] == "conversacion 0 mensaje 1"


# --------------------------------------------------------------------------- #
# 3. Paginacion
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_listado_esta_paginado_y_no_repite_ni_se_salta_filas(entorno):
    """Sin paginacion se traian TODAS las conversaciones para ver diez."""
    http, sesiones, _ = entorno
    await _sembrar_conversaciones(sesiones, 25, mensajes_por_conversacion=1)

    primera = (await http.get(API, params={"limit": 10})).json()
    segunda = (await http.get(API, params={"limit": 10, "offset": 10})).json()
    tercera = (await http.get(API, params={"limit": 10, "offset": 20})).json()

    assert [len(primera), len(segunda), len(tercera)] == [10, 10, 5]
    vistos = [f["id"] for f in primera + segunda + tercera]
    assert len(set(vistos)) == 25, "hay filas repetidas entre paginas"


@pytest.mark.asyncio
async def test_el_historial_se_pagina_hacia_atras_por_instante(entorno):
    """`before` es lo que permite subir por el historial sin repetir mensajes.

    Con `offset` a secas, cada mensaje nuevo que entra mientras alguien lee
    desplaza la ventana un puesto y la pagina siguiente repite el ultimo que ya
    se habia visto. Con un instante fijo, lo que ya paso no se mueve.
    """
    http, sesiones, _ = entorno
    ids = await _sembrar_conversaciones(sesiones, 1, mensajes_por_conversacion=12)

    recientes = (await http.get(f"{API}/{ids[0]}/messages", params={"limit": 5})).json()
    assert [m["body"] for m in recientes] == [
        f"conversacion 0 mensaje {j}" for j in range(7, 12)
    ]

    # Ahora entra un mensaje NUEVO, como pasa mientras alguien lee.
    async with sesiones() as db:
        db.add(
            Message(
                id="dddddddd-9999-0000-0000-000000000000",
                conversation_id=ids[0],
                sender_id=BRUNO,
                body="mensaje que llega mientras lees",
                created_at=_instante(9_999),
            )
        )
        await db.commit()

    anteriores = (
        await http.get(
            f"{API}/{ids[0]}/messages",
            params={"limit": 5, "before": recientes[0]["created_at"]},
        )
    ).json()
    assert [m["body"] for m in anteriores] == [
        f"conversacion 0 mensaje {j}" for j in range(2, 7)
    ], "el mensaje recien llegado ha desplazado la ventana"


@pytest.mark.asyncio
async def test_el_historial_no_hace_una_consulta_por_mensaje(entorno):
    """Los autores se resuelven de una vez, no uno por mensaje."""
    http, sesiones, _ = entorno
    ids = await _sembrar_conversaciones(sesiones, 1, mensajes_por_conversacion=40)
    assert (await http.get(f"{API}/{ids[0]}/messages")).status_code == 200

    consultas, quitar = _escuchar(sesiones)
    try:
        respuesta = await http.get(f"{API}/{ids[0]}/messages", params={"limit": 40})
    finally:
        quitar()

    assert len(respuesta.json()) == 40
    # SIETE, Y SIEMPRE SIETE: pertenencia, mensajes con sus autores, adjuntos,
    # contexto de historia, la sesion 1:1 de la que hable cada mensaje (0097)
    # y —desde la 0106— las reacciones y las citas de la pagina. Lo que se
    # vigila es que el numero NO dependa de cuantos mensajes hay: cada cosa
    # nueva que cuelga de un mensaje es una consulta para la pagina entera,
    # nunca una por burbuja. (Si la pagina trae alguna cita son ocho: el
    # tipo de adjunto de los mensajes citados, tambien de una vez.)
    assert len(_selects(consultas)) <= 7, (
        f"{len(_selects(consultas))} consultas para 40 mensajes"
    )


# --------------------------------------------------------------------------- #
# 4. Membresia: identidad del JWT, nunca del cliente
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_quien_no_es_miembro_no_lee_ni_escribe(entorno):
    """La conversacion de Ana y Bruno no existe para Carla."""
    http, sesiones, identidad = entorno
    ids = await _sembrar_conversaciones(sesiones, 1)

    identidad["uid"] = CARLA
    assert (await http.get(f"{API}/{ids[0]}/messages")).status_code == 403
    assert (
        await http.post(f"{API}/{ids[0]}/messages", json={"body": "hola"})
    ).status_code == 403
    # Y su listado sale vacio: no es que no vea el contenido, es que no hay.
    assert (await http.get(API)).json() == []


@pytest.mark.asyncio
async def test_el_listado_solo_trae_las_conversaciones_propias(entorno):
    """Agrupar por conversacion no puede filtrar las de otra persona."""
    http, sesiones, identidad = entorno
    mias = await _sembrar_conversaciones(sesiones, 2)

    async with sesiones() as db:
        ajena = "cccccccc-2222-0000-0000-000000000000"
        db.add(Conversation(id=ajena, kind="direct", created_by=BRUNO))
        db.add(ConversationMember(conversation_id=ajena, user_id=BRUNO))
        db.add(ConversationMember(conversation_id=ajena, user_id=CARLA))
        db.add(
            Message(
                id="dddddddd-2222-0000-0000-000000000000",
                conversation_id=ajena,
                sender_id=BRUNO,
                body="esto no es de Ana",
                created_at=_instante(1),
            )
        )
        await db.commit()

    filas = (await http.get(API)).json()
    assert {f["id"] for f in filas} == set(mias)

    identidad["uid"] = CARLA
    suyas = (await http.get(API)).json()
    assert len(suyas) == 1
    assert suyas[0]["other"]["id"] == BRUNO


# --------------------------------------------------------------------------- #
# 5. Regresion: la consulta con lista vacia
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_conversaciones_no_se_pregunta_por_un_id_vacio(entorno):
    """Quien todavia no ha escrito a nadie es el caso NORMAL al registrarse.

    EL FALLO QUE FIJA ESTA PRUEBA. Resolver los perfiles con
    `Profile.id.in_([...] or [""])` manda la cadena vacia a una columna `uuid`.
    En SQLite cuela —su conversor solo quita los guiones— asi que la suite
    entera pasaria en verde. En PostgreSQL asyncpg la rechaza y el manejador de
    `DBAPIError` lo convierte en un **404**: la pantalla de Mensajes de una
    cuenta recien creada responderia «no encontrado» en vez de una lista vacia.

    Se comprueba mirando los PARAMETROS de verdad, porque el sintoma solo
    aparece contra PostgreSQL y esto corre sobre SQLite.
    """
    http, sesiones, _ = entorno

    consultas, quitar = _escuchar(sesiones)
    try:
        respuesta = await http.get(API)
    finally:
        quitar()

    assert respuesta.status_code == 200
    assert respuesta.json() == []

    culpables = [
        sentencia
        for sentencia, parametros in consultas
        if "" in (parametros.values() if isinstance(parametros, dict) else parametros)
    ]
    assert not culpables, f"consulta con un id vacio: {culpables}"
