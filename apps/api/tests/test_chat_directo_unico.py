"""Un chat directo por pareja, y la bandeja limpia de intenciones.

EL FALLO QUE ESTAS PRUEBAS FIJAN, tal y como lo conto quien lo sufrio: abrir el
perfil de alguien, pulsar «Mensaje», entrar al chat, NO escribir, volver atras y
repetir. La bandeja acababa ensenando a la misma persona varias veces, todas con
«Sin mensajes aun».

Eran DOS fallos encima del mismo gesto, y por eso hay dos bloques:

1. `POST /conversations/direct` hacia «buscar y, si no hay, crear». Eso no es
   atomico: dos peticiones simultaneas —un doble toque, o un toque mas el
   reintento de una red lenta— hacen las dos el SELECT, las dos no encuentran
   nada, y las dos insertan. Lo que lo impide de verdad es la clave primaria de
   `direct_conversation_pairs` (migracion 0039); lo que se prueba aqui es que
   quien PIERDE esa carrera recibe la conversacion de quien gano, y no un error.

2. Aunque no hubiera duplicados, abrir un chat y no escribir dejaba una fila
   vacia en la bandeja. Una conversacion sin mensajes no es una conversacion,
   es una intencion; el listado ya no la ensena.

POR QUE LA CARRERA SE PROVOCA Y NO SE ESPERA. Estas pruebas corren sobre SQLite
en memoria, donde la escritura esta serializada: lanzar dos peticiones con
`asyncio.gather` no reproduce el entrelazado, lo esconde, y la prueba pasaria
sin haber ejecutado la linea que arregla el fallo. Aqui se fuerza exactamente el
entrelazado del doble toque —la segunda peticion lee ANTES de que la primera
confirme— y se comprueba el camino de recuperacion de verdad. Ver
`test_dos_peticiones_a_la_vez_dejan_una_sola_conversacion`.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.modules.messaging.router as router_mensajes
from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.messaging import esquema as esquema_mensajes
from app.modules.messaging.models import (
    Conversation,
    ConversationMember,
    DirectConversationPair,
    Message,
)
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

API = "/api/v1/conversations"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"
GRUPO = "cccccccc-0000-0000-0000-00000000000a"

#: Un instante fijo del que colgar los mensajes cuyo ORDEN se comprueba.
#:
#: El `now()` de SQLite tiene resolucion de SEGUNDO: dos mensajes enviados
#: seguidos por HTTP comparten marca y cual va primero pasa a decidirlo el
#: desempate por id, que es aleatorio. En PostgreSQL —que es donde corre esto de
#: verdad— cada insercion trae microsegundos. Es un artefacto del motor de
#: pruebas, no del codigo, y se neutraliza fechando a mano.
ORIGEN = datetime(2026, 8, 27, 12, 0, 0, tzinfo=timezone.utc)


async def _crear_esquema(conn, con_0039: bool) -> None:
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
    if not con_0039:
        # Se DESHACE la 0039, para dejar la base como esta hoy produccion.
        await conn.execute(text("drop table direct_conversation_pairs"))


async def _montar(con_0039: bool):
    """El entorno de estas pruebas. `con_0039` decide si la tabla existe.

    `esquema_mensajes.olvidar()` al entrar Y al salir. La memoria de que tablas
    existen vive en el PROCESO, no en la base, y aqui conviven a proposito dos
    esquemas distintos: sin limpiarla, la prueba «sin la 0039» heredaria el «si»
    de la anterior —o se lo dejaria a la siguiente— y el fallo apareceria en un
    fichero que no tiene nada que ver.
    """
    cache.vaciar()
    esquema.olvidar()
    esquema_mensajes.olvidar()

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await _crear_esquema(conn, con_0039)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana", username="ana"))
        db.add(Profile(id=BRUNO, full_name="Bruno", username="bruno"))
        # Un grupo del que Ana ya es miembro y donde nadie ha hablado: sirve
        # para comprobar que el filtro de vacios NO se lleva por delante los
        # grupos, que se crean a proposito y con nombre.
        db.add(Conversation(id=GRUPO, kind="group", title="Equipo", created_by=ANA))
        db.add(ConversationMember(conversation_id=GRUPO, user_id=ANA))
        db.add(ConversationMember(conversation_id=GRUPO, user_id=BRUNO))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    return engine, sesiones, identidad


async def _desmontar(engine) -> None:
    app.dependency_overrides.clear()
    await engine.dispose()
    esquema_mensajes.olvidar()


@pytest_asyncio.fixture
async def entorno():
    """La base CON la 0039 aplicada: lo que habra cuando se apruebe."""
    engine, sesiones, identidad = await _montar(con_0039=True)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http, sesiones, identidad
    await _desmontar(engine)


@pytest_asyncio.fixture
async def entorno_sin_0039():
    """La base tal y como esta HOY en produccion: sin la tabla de parejas."""
    engine, sesiones, identidad = await _montar(con_0039=False)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http, sesiones, identidad
    await _desmontar(engine)


async def _fechar(sesiones, message_id: str, segundos: int) -> None:
    """Le pone al mensaje una hora exacta, para poder comprobar el orden."""
    async with sesiones() as db:
        await db.execute(
            update(Message)
            .where(Message.id == message_id)
            .values(created_at=ORIGEN + timedelta(seconds=segundos))
        )
        await db.commit()


async def _cuantas_directas(sesiones) -> int:
    async with sesiones() as db:
        return (
            await db.execute(
                select(func.count())
                .select_from(Conversation)
                .where(Conversation.kind == "direct")
            )
        ).scalar_one()


# --------------------------------------------------------------------------- #
# 1. Una sola conversacion por pareja
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_abrir_el_chat_tres_veces_deja_una_sola_conversacion(entorno):
    """El gesto exacto que reporto el usuario: entrar, salir, entrar, salir."""
    http, sesiones, _ = entorno

    respuestas = [
        await http.post(f"{API}/direct", json={"user_id": BRUNO}) for _ in range(3)
    ]

    assert [r.status_code for r in respuestas] == [200, 200, 200]
    ids = {r.json()["id"] for r in respuestas}
    assert len(ids) == 1, "abrir el mismo chat devolvio conversaciones distintas"
    assert await _cuantas_directas(sesiones) == 1


@pytest.mark.asyncio
async def test_dos_peticiones_a_la_vez_dejan_una_sola_conversacion(
    entorno, monkeypatch
):
    """La carrera del doble toque, provocada a proposito.

    Se deja que la primera peticion cree la conversacion y se hace que la
    SEGUNDA lea como si su SELECT hubiera llegado antes de ese commit: no ve
    nada y va a crear tambien. Es exactamente el entrelazado que producia los
    duplicados, y es el unico camino por el que pasa la recuperacion.

    Lo que tiene que ocurrir: la clave primaria de `direct_conversation_pairs`
    rechaza la segunda insercion, el endpoint deshace lo suyo, vuelve a buscar
    —y ahora si esta, porque el conflicto solo salta cuando la ganadora ya
    confirmo— y responde con LA MISMA conversacion. Quien pulso dos veces ve un
    chat, no un error y no dos filas.
    """
    http, sesiones, _ = entorno

    primera = await http.post(f"{API}/direct", json={"user_id": BRUNO})
    assert primera.status_code == 200

    real = router_mensajes._buscar_directa
    llamadas = {"n": 0}

    async def _lectura_rancia(db, uid, otro_id):
        llamadas["n"] += 1
        # Solo la PRIMERA lectura de la segunda peticion esta rancia. La de
        # despues de la colision tiene que ser la de verdad: es la que
        # encuentra a la ganadora.
        if llamadas["n"] == 1:
            return None
        return await real(db, uid, otro_id)

    monkeypatch.setattr(router_mensajes, "_buscar_directa", _lectura_rancia)

    segunda = await http.post(f"{API}/direct", json={"user_id": BRUNO})

    assert segunda.status_code == 200
    assert segunda.json()["id"] == primera.json()["id"]
    assert await _cuantas_directas(sesiones) == 1
    assert llamadas["n"] == 2, "no se llego a reintentar la busqueda"


@pytest.mark.asyncio
async def test_la_pareja_se_guarda_ordenada_y_da_igual_quien_pulse(entorno):
    """Sin ordenar los dos ids, (Ana, Bruno) y (Bruno, Ana) serian dos claves.

    Y entonces la restriccion no impediria nada: bastaria con que cada uno
    abriera el chat desde su lado para tener dos conversaciones.
    """
    http, sesiones, identidad = entorno

    desde_ana = await http.post(f"{API}/direct", json={"user_id": BRUNO})
    identidad["uid"] = BRUNO
    desde_bruno = await http.post(f"{API}/direct", json={"user_id": ANA})

    assert desde_bruno.json()["id"] == desde_ana.json()["id"]
    assert await _cuantas_directas(sesiones) == 1

    async with sesiones() as db:
        parejas = (
            await db.execute(
                select(
                    DirectConversationPair.user_low,
                    DirectConversationPair.user_high,
                    DirectConversationPair.conversation_id,
                )
            )
        ).all()
    assert len(parejas) == 1
    bajo, alto, conversacion = parejas[0]
    assert bajo < alto
    assert {bajo, alto} == {ANA, BRUNO}
    assert conversacion == desde_ana.json()["id"]


@pytest.mark.asyncio
async def test_dos_mensajes_no_crean_dos_conversaciones(entorno):
    """Escribir no vuelve a crear nada: el chat ya existe y se reutiliza."""
    http, sesiones, _ = entorno

    primera = (await http.post(f"{API}/direct", json={"user_id": BRUNO})).json()
    assert (
        await http.post(f"{API}/{primera['id']}/messages", json={"body": "hola"})
    ).status_code == 201

    segunda = (await http.post(f"{API}/direct", json={"user_id": BRUNO})).json()
    assert segunda["id"] == primera["id"]
    assert (
        await http.post(f"{API}/{segunda['id']}/messages", json={"body": "otra"})
    ).status_code == 201

    assert await _cuantas_directas(sesiones) == 1
    listado = (await http.get(API)).json()
    assert [c["id"] for c in listado if c["kind"] == "direct"] == [primera["id"]]


# --------------------------------------------------------------------------- #
# 2. La bandeja no ensena intenciones
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_una_conversacion_vacia_no_sale_en_la_bandeja(entorno):
    """Curiosear perfiles no puede ensuciar Mensajes.

    La conversacion SI se crea —la pantalla de chat necesita un id al que ir— y
    abrirla sigue funcionando. Lo que no ocurre es que aparezca en la lista.
    """
    http, _, _ = entorno

    creada = (await http.post(f"{API}/direct", json={"user_id": BRUNO})).json()

    listado = (await http.get(API)).json()
    assert creada["id"] not in [c["id"] for c in listado]
    # Y el chat existe y se puede abrir: esconderlo de la lista no es borrarlo.
    assert (await http.get(f"{API}/{creada['id']}/messages")).status_code == 200


@pytest.mark.asyncio
async def test_en_cuanto_alguien_escribe_la_conversacion_aparece(entorno):
    """La otra mitad del filtro: si hay algo que leer, tiene que verse."""
    http, _, _ = entorno

    creada = (await http.post(f"{API}/direct", json={"user_id": BRUNO})).json()
    assert (await http.get(API)).json() == [] or all(
        c["id"] != creada["id"] for c in (await http.get(API)).json()
    )

    await http.post(f"{API}/{creada['id']}/messages", json={"body": "hola"})

    listado = (await http.get(API)).json()
    fila = next(c for c in listado if c["id"] == creada["id"])
    assert fila["last_message"] == "hola"
    assert fila["other"]["id"] == BRUNO


@pytest.mark.asyncio
async def test_un_grupo_vacio_si_sale(entorno):
    """El filtro es solo para los chats directos, y no por descuido.

    Un grupo se crea a proposito y con un titulo: existe aunque nadie haya
    hablado todavia. Un chat directo vacio solo dice que alguien miro un perfil.
    """
    http, _, _ = entorno
    listado = (await http.get(API)).json()
    assert [c["id"] for c in listado] == [GRUPO]
    assert listado[0]["last_message"] is None


@pytest.mark.asyncio
async def test_si_se_borran_todos_los_mensajes_la_fila_no_miente(entorno):
    """Coherencia con el contador de no leidos, que es el motivo del `deleted_at`.

    `ultimos_mensajes` y `no_leidos` ignoran lo borrado. Si el filtro del listado
    NO lo ignorara, un chat con todos sus mensajes borrados volveria a la bandeja
    diciendo «Sin mensajes aun» y con el contador a cero: exactamente la fila que
    este trabajo quita.
    """
    http, sesiones, identidad = entorno

    creada = (await http.post(f"{API}/direct", json={"user_id": BRUNO})).json()
    identidad["uid"] = BRUNO
    await http.post(f"{API}/{creada['id']}/messages", json={"body": "hola"})
    identidad["uid"] = ANA

    # Con el mensaje vivo: sale, y con un no leido.
    fila = next(c for c in (await http.get(API)).json() if c["id"] == creada["id"])
    assert fila["unread_count"] == 1

    async with sesiones() as db:
        await db.execute(
            update(Message)
            .where(Message.conversation_id == creada["id"])
            .values(deleted_at=datetime(2026, 8, 27, tzinfo=timezone.utc))
        )
        await db.commit()

    listado = (await http.get(API)).json()
    assert creada["id"] not in [c["id"] for c in listado]


# --------------------------------------------------------------------------- #
# 3. Todo lo anterior tiene que funcionar SIN la migracion 0039
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_la_0039_abrir_un_chat_funciona_igual(entorno_sin_0039):
    """Desplegar esto no puede exigir que la migracion ya este puesta.

    Es la misma leccion cara que cuentan la 0027, la 0028, la 0029 y la 0033: se
    escribio codigo contra un esquema que no estaba aplicado y cada peticion que
    tocaba la tabla nueva reventaba con un 500 que el navegador ademas reportaba
    como error de CORS.

    Sin la 0039 no hay garantia de unicidad —esa la pone la base— pero el
    endpoint responde, es idempotente en el caso normal (que es el 99%: sin
    carrera, el SELECT encuentra la conversacion) y nada se degrada.
    """
    http, sesiones, _ = entorno_sin_0039

    respuestas = [
        await http.post(f"{API}/direct", json={"user_id": BRUNO}) for _ in range(3)
    ]
    assert [r.status_code for r in respuestas] == [200, 200, 200]
    assert len({r.json()["id"] for r in respuestas}) == 1
    assert await _cuantas_directas(sesiones) == 1

    # Y se ha averiguado que la tabla no esta, una sola vez y sin romperse.
    assert esquema_mensajes._cache["direct_conversation_pairs"] is False


@pytest.mark.asyncio
async def test_sin_la_0039_la_bandeja_sigue_escondiendo_las_vacias(entorno_sin_0039):
    """El segundo fallo se arregla HOY, sin esperar a ninguna aprobacion.

    El filtro vive en la consulta del listado y no depende de ninguna tabla
    nueva, asi que los duplicados vacios que ya existan en produccion dejan de
    verse en cuanto se despliegue esto.
    """
    http, _, _ = entorno_sin_0039

    creada = (await http.post(f"{API}/direct", json={"user_id": BRUNO})).json()
    assert creada["id"] not in [c["id"] for c in (await http.get(API)).json()]

    await http.post(f"{API}/{creada['id']}/messages", json={"body": "hola"})
    assert creada["id"] in [c["id"] for c in (await http.get(API)).json()]


# --------------------------------------------------------------------------- #
# 4. Los duplicados historicos: se esconden los vacios, no se toca nada mas
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_los_duplicados_historicos_vacios_desaparecen_de_la_vista(entorno):
    """Lo que ya dejo el fallo en produccion, sin borrar una sola fila.

    Se fabrican tres conversaciones directas para la misma pareja, como las que
    produjo el doble toque: dos vacias y una con historial. La bandeja tiene que
    ensenar UNA, la que tiene mensajes. Las otras dos siguen en la base —esto no
    borra nada— pero dejan de verse.

    Y abrir el chat con esa persona tiene que devolver SIEMPRE la misma, no una
    distinta en cada intento: por eso la busqueda esta ordenada.
    """
    http, sesiones, _ = entorno

    viejas = [
        "dddddddd-0000-0000-0000-000000000001",
        "dddddddd-0000-0000-0000-000000000002",
        "dddddddd-0000-0000-0000-000000000003",
    ]
    async with sesiones() as db:
        for indice, conv_id in enumerate(viejas):
            db.add(
                Conversation(
                    id=conv_id,
                    kind="direct",
                    created_by=ANA,
                    created_at=datetime(2026, 8, 20 + indice, tzinfo=timezone.utc),
                )
            )
            db.add(ConversationMember(conversation_id=conv_id, user_id=ANA))
            db.add(ConversationMember(conversation_id=conv_id, user_id=BRUNO))
        await db.commit()
    # Solo la del medio llego a tener conversacion de verdad.
    await http.post(f"{API}/{viejas[1]}/messages", json={"body": "esto si se dijo"})

    directas = [c for c in (await http.get(API)).json() if c["kind"] == "direct"]
    assert [c["id"] for c in directas] == [viejas[1]]

    # Nada se ha borrado: las tres siguen ahi.
    assert await _cuantas_directas(sesiones) == 3

    # Y el boton «Mensaje» siempre lleva al mismo sitio: la mas antigua.
    abiertas = {
        (await http.post(f"{API}/direct", json={"user_id": BRUNO})).json()["id"]
        for _ in range(3)
    }
    assert abiertas == {viejas[0]}
    assert await _cuantas_directas(sesiones) == 3


# --------------------------------------------------------------------------- #
# 5. La conversacion sirve para lo que es: los dos lados
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_ana_escribe_y_bruno_la_ve_y_puede_responder(entorno):
    """De extremo a extremo, que es lo que la persona va a hacer esta tarde."""
    http, sesiones, identidad = entorno

    creada = (await http.post(f"{API}/direct", json={"user_id": BRUNO})).json()
    primero = await http.post(
        f"{API}/{creada['id']}/messages", json={"body": "¿nos vemos?"}
    )
    assert primero.status_code == 201
    await _fechar(sesiones, primero.json()["id"], 0)

    identidad["uid"] = BRUNO
    bandeja = (await http.get(API)).json()
    fila = next(c for c in bandeja if c["id"] == creada["id"])
    assert fila["other"]["id"] == ANA
    assert fila["last_message"] == "¿nos vemos?"
    assert fila["unread_count"] == 1

    respuesta = await http.post(
        f"{API}/{creada['id']}/messages", json={"body": "claro"}
    )
    assert respuesta.status_code == 201
    await _fechar(sesiones, respuesta.json()["id"], 1)

    # Bruno abriendo el chat desde el perfil de Ana cae en la MISMA conversacion,
    # no en una nueva con el historial perdido.
    assert (await http.post(f"{API}/direct", json={"user_id": ANA})).json()[
        "id"
    ] == creada["id"]
    assert await _cuantas_directas(sesiones) == 1

    identidad["uid"] = ANA
    historial = (await http.get(f"{API}/{creada['id']}/messages")).json()
    assert [m["body"] for m in historial] == ["¿nos vemos?", "claro"]
