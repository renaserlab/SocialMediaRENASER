"""La bandeja rediseñada: buscar, filtrar y etiquetar SIN pagar por conversacion.

QUE VIGILA ESTE FICHERO, y por que cada cosa esta aqui.

1. **EL COSTE SIGUE SIENDO CONSTANTE.** Es la garantia que costo ganarla:
   `GET /conversations` hacia `1 + 3N` consultas —61 con veinte conversaciones—
   y se dejo en cuatro, cuatro con tres y cuatro con ochenta. Al añadir busqueda,
   filtros y etiquetas era facilisimo perderla: basta con resolver las etiquetas
   de cada fila por separado (24 consultas con 20 filas) o con comprobar el
   filtro en un bucle. Aqui se cuentan las consultas REALES con un escucha de
   SQLAlchemy y se exige el MISMO numero con 3 conversaciones y con 80.

   Un tope fijo a secas no valdria: se puede cumplir por casualidad si el caso de
   prueba es pequeño. Que dos tamaños muy distintos cuesten lo mismo solo puede
   pasar si de verdad no hay nada por conversacion.

2. **BUSCAR ENCUENTRA LO QUE NO ESTA EN LA PRIMERA PAGINA.** Es el fallo que
   motivo el trabajo: la pantalla filtraba `nombre.includes(texto)` sobre las
   veinte filas ya descargadas, asi que buscar a la persona de la conversacion
   numero treinta NO la encontraba. La prueba busca a alguien deliberadamente
   colocado en la conversacion mas antigua —la ultima de la lista— con una pagina
   de veinte y treinta conversaciones sembradas.

3. **LOS FILTROS SON ESTADOS DERIVADOS Y VIVEN EN LA CONSULTA.** «No leidos» y
   «No respondidos» se comprueban contra escenarios donde la respuesta correcta
   no es la trivial: hay conversaciones leidas, sin leer, respondidas y sin
   responder a la vez.

4. **LAS ETIQUETAS SON PRIVADAS.** La prueba mas importante del CRM: se busca el
   TEXTO de la etiqueta de Ana en la respuesta CRUDA de Bruno. Si algun dia
   alguien quita el filtro por dueño pensando que las asignaciones ya son
   privadas, esto se pone rojo. Esconderlo en la pantalla no sirve: lo que sale
   del servidor acaba viendose en otro cliente o en un registro.

5. **SIN LA 0044 NO HAY BOTON MUERTO.** El filtro «Respuestas a historias» no se
   ofrece —`/availability` lo dice— y si llega igual por una URL vieja responde
   una lista vacia, nunca un 500 (que ademas saldria sin cabeceras CORS y en el
   navegador parece un fallo de red).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user
from app.main import app
from app.modules.messaging import esquema as esquema_mensajes
from app.modules.messaging.etiquetas import (
    ConversationLabel,
    ConversationLabelAssignment,
    normalizar,
)
from app.modules.messaging.models import (
    Conversation,
    ConversationMember,
    Message,
    MessageStoryContext,
)
from app.modules.profiles.models import Profile
from app.modules.recommendations import cache, esquema
from app.shared.database import Base, get_db

API = "/api/v1/conversations"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"

#: La etiqueta de Ana. El texto es raro a proposito: la prueba de privacidad
#: busca ESTA cadena en la respuesta cruda de Bruno, asi que tiene que ser algo
#: que no pueda aparecer por casualidad en un nombre o en un mensaje.
ETIQUETA = "11111111-0000-0000-0000-000000000001"
ETIQUETA_TEXTO = "Alumno VIP Qwerty"

#: Un instante fijo del que colgar todo. Hace falta porque el `now()` de SQLite
#: tiene resolucion de SEGUNDO: varios mensajes escritos seguidos comparten hora
#: y el orden dejaria de ser comprobable, cuando en PostgreSQL —que es donde
#: corre esto— cada insercion trae su propia marca de microsegundos.
ORIGEN = datetime(2026, 8, 31, 12, 0, 0, tzinfo=timezone.utc)


def _instante(segundos: int) -> datetime:
    return ORIGEN + timedelta(seconds=segundos)


def _contacto(i: int) -> str:
    return f"bbbbbbbb-0000-0000-0000-{i:012d}"


def _chat(i: int) -> str:
    return f"cccccccc-0000-0000-0000-{i:012d}"


#: Quien esta en la conversacion 0, que es la MAS ANTIGUA y por tanto la ULTIMA
#: de la bandeja. Buscarla con una pagina de veinte y treinta conversaciones
#: sembradas es la prueba de que la busqueda es del servidor y no del telefono.
LEJANA_NOMBRE = "Zulema Martinez"
LEJANA_USUARIO = "zulemam"


async def _crear_esquema(engine, *, con_0044: bool = True) -> None:
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
        if not con_0044:
            # Deshacer la 0044 deja la base como esta hoy en produccion.
            await conn.execute(text("drop table message_story_context"))


def _montar(sesiones, identidad: dict):
    async def _db_override():
        async with sesiones() as session:
            yield session

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override


@pytest_asyncio.fixture
async def bandeja():
    """El esquema completo, con la 0044 y la 0045, y Ana como quien mira."""
    cache.vaciar()
    esquema.olvidar()
    # La memoria de que existen las tablas vive en el PROCESO, no en la base, y
    # cada prueba levanta la suya. Sin vaciarla, la que corre «sin la 0044»
    # heredaria el «si» de esta y comprobaria otra cosa.
    esquema_mensajes.olvidar()

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    await _crear_esquema(engine)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana Lopez", username="ana"))
        db.add(
            ConversationLabel(
                id=ETIQUETA,
                owner_id=ANA,
                nombre=ETIQUETA_TEXTO,
                nombre_normalizado=normalizar(ETIQUETA_TEXTO),
            )
        )
        await db.commit()

    identidad = {"uid": ANA}
    _montar(sesiones, identidad)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http, sesiones, identidad

    app.dependency_overrides.clear()
    await engine.dispose()


@pytest_asyncio.fixture
async def bandeja_sin_0044():
    """El esquema tal y como esta HOY en produccion: sin `message_story_context`."""
    cache.vaciar()
    esquema.olvidar()
    esquema_mensajes.olvidar()

    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    await _crear_esquema(engine, con_0044=False)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        db.add(Profile(id=ANA, full_name="Ana Lopez", username="ana"))
        await db.commit()

    identidad = {"uid": ANA}
    _montar(sesiones, identidad)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http, sesiones, identidad

    app.dependency_overrides.clear()
    await engine.dispose()


async def _sembrar(
    sesiones,
    cuantas: int,
    *,
    desde: int = 0,
    ultimo_de_ana: bool = False,
    con_etiqueta: bool = False,
    con_respuesta_a_historia: bool = False,
) -> list[str]:
    """Conversaciones directas de Ana con `cuantas` personas distintas.

    La conversacion `i` se actualiza en el instante `i`, asi que la 0 es la MAS
    ANTIGUA y sale la ULTIMA de la bandeja. Es lo que permite comprobar que la
    busqueda encuentra a alguien que no cabe en la primera pagina.

    `desde` desplaza los identificadores para sembrar dos tandas en la misma base
    sin que choquen las claves primarias.
    """
    ids: list[str] = []
    async with sesiones() as db:
        for i in range(desde, desde + cuantas):
            contacto = _contacto(i)
            db.add(
                Profile(
                    id=contacto,
                    full_name=LEJANA_NOMBRE if i == 0 else f"Persona {i}",
                    username=LEJANA_USUARIO if i == 0 else f"persona{i}",
                )
            )
            conv = _chat(i)
            ids.append(conv)
            db.add(
                Conversation(
                    id=conv,
                    kind="direct",
                    created_by=ANA,
                    created_at=_instante(i),
                    updated_at=_instante(i),
                )
            )
            db.add(ConversationMember(conversation_id=conv, user_id=ANA))
            db.add(ConversationMember(conversation_id=conv, user_id=contacto))

            # Dos mensajes: el contacto escribe y despues, si se pide, Ana
            # responde. Lo que decide «No respondidos» es quien escribio EL
            # ULTIMO, asi que ese orden es todo el escenario.
            db.add(
                Message(
                    id=f"dddddddd-{i:04d}-0000-0000-{0:012d}",
                    conversation_id=conv,
                    sender_id=contacto,
                    body=f"hola desde la conversacion {i}",
                    created_at=_instante(i * 100),
                )
            )
            if ultimo_de_ana:
                db.add(
                    Message(
                        id=f"dddddddd-{i:04d}-0000-0000-{1:012d}",
                        conversation_id=conv,
                        sender_id=ANA,
                        body=f"respondido {i}",
                        created_at=_instante(i * 100 + 1),
                    )
                )
            if con_etiqueta:
                db.add(
                    ConversationLabelAssignment(label_id=ETIQUETA, conversation_id=conv)
                )
            if con_respuesta_a_historia:
                db.add(
                    MessageStoryContext(
                        message_id=f"dddddddd-{i:04d}-0000-0000-{0:012d}",
                        # A nulo a proposito: una historia dura un dia y el
                        # mensaje que la responde dura para siempre, asi que el
                        # contexto degradado es el caso NORMAL, no el raro.
                        story_id=None,
                        story_owner_id=contacto,
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


async def _consultas_de(http, sesiones, params: dict) -> tuple[int, list]:
    """Cuantos SELECT cuesta una peticion, y lo que devolvio."""
    consultas, quitar = _escuchar(sesiones)
    try:
        respuesta = await http.get(API, params=params)
    finally:
        quitar()
    assert respuesta.status_code == 200, respuesta.text
    selects = [s for s, _ in consultas if s.lstrip().lower().startswith("select")]
    return len(selects), respuesta.json()


# --------------------------------------------------------------------------- #
# 1. EL COSTE NO CRECE CON LA LISTA — con etiquetas, busqueda y filtros dentro
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_coste_es_constante_con_etiquetas_busqueda_y_filtros(bandeja):
    """PROHIBIDO una consulta por conversacion, tambien con lo nuevo.

    Es la prueba central del trabajo. Se mide la peticion mas cara que la
    pantalla puede lanzar —texto de busqueda, filtro derivado y etiqueta del CRM
    a la vez— con 3 conversaciones y con 80, y se exige el MISMO numero.
    """
    http, sesiones, _ = bandeja
    dificil = {
        "q": "Persona",
        "filtro": "unread",
        "label_id": ETIQUETA,
        "limit": 100,
    }

    # La conversacion 0 lleva a Zulema, que no se llama «Persona»: se siembra
    # desde 1 para que TODAS las filas casen con la busqueda y las dos medidas
    # comparen listas no vacias. Una lista vacia sale antes y costaria menos.
    await _sembrar(sesiones, 3, desde=1, con_etiqueta=True)
    # Un viaje en vacio primero: lo que se cachea por proceso no debe contarse.
    assert (await http.get(API, params=dificil)).status_code == 200

    con_3, filas_3 = await _consultas_de(http, sesiones, dificil)
    assert len(filas_3) == 3, "el escenario tiene que devolver filas en los dos casos"

    await _sembrar(sesiones, 77, desde=4, con_etiqueta=True)

    con_80, filas_80 = await _consultas_de(http, sesiones, dificil)
    assert len(filas_80) == 80

    assert con_3 == con_80, (
        f"{con_3} consultas para 3 conversaciones y {con_80} para 80: "
        "el coste ha vuelto a crecer con la lista"
    )
    # Seis: la comprobacion de que la etiqueta es mia, la pagina, los perfiles,
    # los ultimos mensajes, los no leidos y las etiquetas de la pagina. El margen
    # deja sitio a una comprobacion de esquema sin permitir que se cuele un bucle.
    assert con_80 <= 7, f"{con_80} consultas para pintar una lista"


@pytest.mark.asyncio
async def test_las_etiquetas_cuestan_una_consulta_y_no_una_por_fila(bandeja):
    """La bandeja de siempre eran 4 consultas; con etiquetas son 5, no 4 + N."""
    http, sesiones, _ = bandeja
    await _sembrar(sesiones, 3, con_etiqueta=True)
    assert (await http.get(API, params={"limit": 100})).status_code == 200

    con_3, _ = await _consultas_de(http, sesiones, {"limit": 100})
    await _sembrar(sesiones, 77, desde=3, con_etiqueta=True)
    con_80, filas = await _consultas_de(http, sesiones, {"limit": 100})

    assert len(filas) == 80
    assert con_3 == con_80, f"{con_3} con 3 filas y {con_80} con 80"
    assert con_80 <= 6, (
        f"{con_80} consultas: el listado son cuatro mas UNA de etiquetas"
    )


@pytest.mark.asyncio
async def test_buscar_y_filtrar_no_anaden_consultas(bandeja):
    """`q`, `unread` y `unanswered` entran en la consulta que YA se hacia."""
    http, sesiones, _ = bandeja
    await _sembrar(sesiones, 10, desde=1)
    assert (await http.get(API)).status_code == 200

    liso, _ = await _consultas_de(http, sesiones, {"limit": 100})
    buscando, _ = await _consultas_de(http, sesiones, {"limit": 100, "q": "Persona"})
    sin_leer, _ = await _consultas_de(http, sesiones, {"limit": 100, "filtro": "unread"})
    sin_responder, _ = await _consultas_de(
        http, sesiones, {"limit": 100, "filtro": "unanswered"}
    )

    assert buscando == liso, "buscar no puede costar una consulta mas"
    assert sin_leer == liso, "«no leidos» ya sabia el umbral: es +0 consultas"
    assert sin_responder == liso, "«no respondidos» sale del ultimo mensaje"


@pytest.mark.asyncio
async def test_el_tamano_de_pagina_no_cambia_el_coste(bandeja):
    """Bajar `limit` no compra nada en el servidor, asi que no se baja."""
    http, sesiones, _ = bandeja
    await _sembrar(sesiones, 80, desde=1, con_etiqueta=True)
    assert (await http.get(API)).status_code == 200

    con_10, filas_10 = await _consultas_de(http, sesiones, {"limit": 10})
    con_80, filas_80 = await _consultas_de(http, sesiones, {"limit": 80})

    assert len(filas_10) == 10 and len(filas_80) == 80
    assert con_10 == con_80, f"{con_10} con limit=10 y {con_80} con limit=80"


# --------------------------------------------------------------------------- #
# 2. BUSCAR DE VERDAD: en el servidor, con paginacion
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_buscar_encuentra_a_alguien_que_no_esta_en_la_primera_pagina(bandeja):
    """EL FALLO QUE MOTIVO EL TRABAJO.

    Zulema esta en la conversacion mas antigua, o sea la ULTIMA de treinta. Con
    una pagina de veinte, filtrar en el telefono sobre lo ya descargado no la
    encontraria jamas: no esta en memoria. Se comprueba las dos cosas —que no
    aparece en la primera pagina y que buscarla si la trae— para que la prueba
    siga significando algo si alguien cambia el orden.
    """
    http, sesiones, _ = bandeja
    await _sembrar(sesiones, 30)

    primera = (await http.get(API, params={"limit": 20})).json()
    assert len(primera) == 20
    assert all(fila["other"]["username"] != LEJANA_USUARIO for fila in primera), (
        "el escenario ya no prueba nada: Zulema cabe en la primera pagina"
    )

    encontrada = (await http.get(API, params={"q": "Zulema", "limit": 20})).json()
    assert [fila["other"]["username"] for fila in encontrada] == [LEJANA_USUARIO]


@pytest.mark.asyncio
async def test_buscar_tambien_por_usuario_y_sin_distinguir_mayusculas(bandeja):
    """Se busca por nombre Y por usuario: quien escribe «@zulemam» la espera."""
    http, sesiones, _ = bandeja
    await _sembrar(sesiones, 30)

    por_usuario = (await http.get(API, params={"q": "zulemam"})).json()
    assert [f["other"]["username"] for f in por_usuario] == [LEJANA_USUARIO]

    en_mayusculas = (await http.get(API, params={"q": "ZULEMA"})).json()
    assert [f["other"]["username"] for f in en_mayusculas] == [LEJANA_USUARIO]


@pytest.mark.asyncio
async def test_buscar_sigue_paginando(bandeja):
    """La busqueda NO desactiva la paginacion, que es lo que hacia la pantalla.

    Antes `onEndReached` se apagaba mientras hubiera texto, porque filtrando en
    memoria pedir mas paginas daba la sensacion de que la lista se completaba
    sola. Con la busqueda en el servidor eso deja de tener sentido: hay que poder
    bajar por los resultados.
    """
    http, sesiones, _ = bandeja
    await _sembrar(sesiones, 30, desde=1)

    pagina1 = (await http.get(API, params={"q": "Persona", "limit": 10})).json()
    pagina2 = (
        await http.get(API, params={"q": "Persona", "limit": 10, "offset": 10})
    ).json()

    assert len(pagina1) == 10 and len(pagina2) == 10
    assert not ({f["id"] for f in pagina1} & {f["id"] for f in pagina2}), (
        "las dos paginas repiten filas: el offset no esta contando resultados"
    )


@pytest.mark.asyncio
async def test_los_comodines_de_sql_no_son_comodines_para_quien_busca(bandeja):
    """Buscar «%» no puede devolver la bandeja entera.

    `%` y `_` son comodines de `LIKE`. Sin escaparlos, quien los escribe —o los
    pega sin darse cuenta— recibe una lista que no corresponde con lo que ha
    pedido, y no hay forma de que lo entienda.
    """
    http, sesiones, _ = bandeja
    await _sembrar(sesiones, 5, desde=1)

    assert (await http.get(API, params={"q": "%"})).json() == []
    assert (await http.get(API, params={"q": "Persona_"})).json() == []


@pytest.mark.asyncio
async def test_un_espacio_suelto_no_es_una_busqueda(bandeja):
    """Tocar la barra y borrar no puede vaciar la bandeja."""
    http, sesiones, _ = bandeja
    await _sembrar(sesiones, 5, desde=1)
    assert len((await http.get(API, params={"q": "   "})).json()) == 5


# --------------------------------------------------------------------------- #
# 3. LOS FILTROS DERIVADOS
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_filtro_no_leidos(bandeja):
    """Solo las que tienen mensajes posteriores a MI `last_read_at`.

    El escenario no es trivial a proposito: se marca una como leida y se exige
    que las otras dos sigan saliendo y esa no. Con todas sin leer, un filtro que
    no hiciera nada tambien pasaria.
    """
    http, sesiones, _ = bandeja
    ids = await _sembrar(sesiones, 3, desde=1)

    assert (await http.post(f"{API}/{ids[1]}/read")).status_code == 204

    sin_leer = (await http.get(API, params={"filtro": "unread"})).json()
    devueltas = {f["id"] for f in sin_leer}
    assert ids[1] not in devueltas, "la marcada como leida sigue saliendo"
    assert devueltas == {ids[0], ids[2]}
    # Y el filtro dice lo mismo que el globo de la fila: si discreparan, alguien
    # veria una conversacion en «No leidos» con el contador a cero.
    assert all(f["unread_count"] > 0 for f in sin_leer)


@pytest.mark.asyncio
async def test_filtro_no_respondidos(bandeja):
    """El ultimo mensaje vigente lo mando la otra persona y yo no escribi despues.

    Se siembran dos tandas: una donde responde Ana y otra donde no. Si el filtro
    mirara «hay algun mensaje del otro» en vez de «el ULTIMO es del otro»,
    saldrian las dos y esto se pondria rojo.
    """
    http, sesiones, _ = bandeja
    sin_responder = await _sembrar(sesiones, 2, desde=1)
    respondidas = await _sembrar(sesiones, 2, desde=10, ultimo_de_ana=True)

    filas = (await http.get(API, params={"filtro": "unanswered"})).json()
    devueltas = {f["id"] for f in filas}
    assert devueltas == set(sin_responder)
    assert not (devueltas & set(respondidas)), "sale una que Ana ya respondio"


@pytest.mark.asyncio
async def test_no_respondidos_ignora_lo_borrado(bandeja):
    """Si Ana borra su respuesta, la conversacion vuelve a estar sin responder.

    El criterio es el MISMO que usa la fila para decir cual fue el ultimo mensaje
    (`ultimos_mensajes` en `lectura.py`, que tambien ignora lo borrado). Si aqui
    se contara lo borrado, la fila enseñaria el mensaje del contacto y el filtro
    diria que esa conversacion ya esta respondida.
    """
    http, sesiones, _ = bandeja
    ids = await _sembrar(sesiones, 1, desde=1, ultimo_de_ana=True)

    assert (await http.get(API, params={"filtro": "unanswered"})).json() == []

    borrado = f"dddddddd-{1:04d}-0000-0000-{1:012d}"
    assert (
        await http.delete(f"{API}/{ids[0]}/messages/{borrado}")
    ).status_code in (200, 204)

    filas = (await http.get(API, params={"filtro": "unanswered"})).json()
    assert [f["id"] for f in filas] == ids


@pytest.mark.asyncio
async def test_filtro_respuestas_a_historias(bandeja):
    """Solo las conversaciones con algun mensaje que responda a una historia."""
    http, sesiones, _ = bandeja
    con_historia = await _sembrar(sesiones, 2, desde=1, con_respuesta_a_historia=True)
    normales = await _sembrar(sesiones, 2, desde=10)

    filas = (await http.get(API, params={"filtro": "story_replies"})).json()
    devueltas = {f["id"] for f in filas}
    assert devueltas == set(con_historia)
    assert not (devueltas & set(normales))


@pytest.mark.asyncio
async def test_los_filtros_paginan(bandeja):
    """Un filtro que no pagina miente igual que la busqueda que no paginaba."""
    http, sesiones, _ = bandeja
    await _sembrar(sesiones, 25, desde=1)

    pagina1 = (await http.get(API, params={"filtro": "unread", "limit": 10})).json()
    pagina2 = (
        await http.get(API, params={"filtro": "unread", "limit": 10, "offset": 10})
    ).json()
    assert len(pagina1) == 10 and len(pagina2) == 10
    assert not ({f["id"] for f in pagina1} & {f["id"] for f in pagina2})


@pytest.mark.asyncio
async def test_un_filtro_inventado_se_rechaza_y_no_devuelve_la_bandeja_entera(bandeja):
    """Son EXACTAMENTE tres. Un cuarto no puede colarse como «sin filtro»."""
    http, sesiones, _ = bandeja
    await _sembrar(sesiones, 3, desde=1)
    respuesta = await http.get(API, params={"filtro": "verificados"})
    assert respuesta.status_code == 422


# --------------------------------------------------------------------------- #
# 4. EL CRM: filtrar por etiqueta, y que la etiqueta sea PRIVADA
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_filtrar_por_etiqueta_ocurre_en_el_servidor_y_pagina(bandeja):
    """La etiqueta recorta la consulta, no la lista ya descargada."""
    http, sesiones, _ = bandeja
    etiquetadas = await _sembrar(sesiones, 3, desde=1, con_etiqueta=True)
    await _sembrar(sesiones, 20, desde=10)

    filas = (await http.get(API, params={"label_id": ETIQUETA})).json()
    assert {f["id"] for f in filas} == set(etiquetadas)

    # Y con paginacion sobre el subconjunto, no sobre la bandeja entera.
    una = (await http.get(API, params={"label_id": ETIQUETA, "limit": 1})).json()
    assert len(una) == 1


@pytest.mark.asyncio
async def test_filtro_y_etiqueta_se_combinan_sin_mezclarse(bandeja):
    """Dos EJES distintos: «no respondidos ENTRE los que marque como alumnos».

    Que se puedan combinar es justo lo que hace que no haga falta guardar «no
    leido» como una etiqueta manual.
    """
    http, sesiones, _ = bandeja
    sin_responder = await _sembrar(sesiones, 2, desde=1, con_etiqueta=True)
    await _sembrar(sesiones, 2, desde=10, con_etiqueta=True, ultimo_de_ana=True)
    await _sembrar(sesiones, 2, desde=20)  # sin responder pero sin etiqueta

    filas = (
        await http.get(API, params={"label_id": ETIQUETA, "filtro": "unanswered"})
    ).json()
    assert {f["id"] for f in filas} == set(sin_responder)


@pytest.mark.asyncio
async def test_la_bandeja_trae_las_etiquetas_de_cada_fila(bandeja):
    """Los chips de la fila salen del listado, no de una peticion por fila."""
    http, sesiones, _ = bandeja
    etiquetadas = await _sembrar(sesiones, 1, desde=1, con_etiqueta=True)
    await _sembrar(sesiones, 1, desde=10)

    por_id = {f["id"]: f for f in (await http.get(API)).json()}
    assert [e["nombre"] for e in por_id[etiquetadas[0]]["labels"]] == [ETIQUETA_TEXTO]
    assert por_id[_chat(10)]["labels"] == []


@pytest.mark.asyncio
async def test_el_otro_participante_no_ve_tus_etiquetas(bandeja):
    """LA PRUEBA QUE NO PUEDE PONERSE ROJA.

    Se busca el TEXTO de la etiqueta en la respuesta CRUDA de Bruno, no en el
    campo `labels`: si algun dia la etiqueta se colara por otro sitio —dentro del
    titulo, en un resumen, en un campo nuevo— comprobar solo `labels` no lo
    veria. Lo que sale del servidor acaba viendose; esconderlo en la pantalla no
    lo hace privado.
    """
    http, sesiones, identidad = bandeja
    ids = await _sembrar(sesiones, 1, desde=1, con_etiqueta=True)

    mia = (await http.get(API)).json()
    assert [e["nombre"] for e in mia[0]["labels"]] == [ETIQUETA_TEXTO]

    # Ahora mira el otro lado de la MISMA conversacion.
    identidad["uid"] = _contacto(1)
    respuesta = await http.get(API)
    assert respuesta.status_code == 200
    filas = respuesta.json()
    assert [f["id"] for f in filas] == ids, "Bruno tiene que ver su conversacion"
    assert filas[0]["labels"] == []
    assert ETIQUETA_TEXTO not in respuesta.text, (
        "la etiqueta de Ana ha viajado hasta Bruno"
    )
    assert ETIQUETA not in respuesta.text, (
        "el identificador de la etiqueta de Ana ha viajado hasta Bruno"
    )


@pytest.mark.asyncio
async def test_filtrar_por_una_etiqueta_ajena_no_devuelve_nada_ni_la_confirma(bandeja):
    """Probar identificadores no puede servir para averiguar que etiquetas hay.

    La etiqueta de Ana existe, pero para Bruno la respuesta tiene que ser la
    misma que para una inventada: ninguna conversacion. Si una respondiera 403 y
    la otra 200, la diferencia YA seria la informacion.
    """
    http, sesiones, identidad = bandeja
    await _sembrar(sesiones, 1, desde=1, con_etiqueta=True)

    identidad["uid"] = _contacto(1)
    ajena = await http.get(API, params={"label_id": ETIQUETA})
    inventada = await http.get(
        API, params={"label_id": "99999999-9999-9999-9999-999999999999"}
    )
    assert ajena.status_code == inventada.status_code == 200
    assert ajena.json() == inventada.json() == []


@pytest.mark.asyncio
async def test_un_label_id_que_no_es_un_uuid_no_revienta(bandeja):
    """Llegaria hasta el driver y asyncpg lo convertiria en un 500."""
    http, sesiones, _ = bandeja
    await _sembrar(sesiones, 2, desde=1, con_etiqueta=True)
    respuesta = await http.get(API, params={"label_id": "no-soy-un-uuid"})
    assert respuesta.status_code == 200
    assert respuesta.json() == []


# --------------------------------------------------------------------------- #
# 5. SIN LA 0044: el filtro no se ofrece y nada revienta
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_la_0044_la_bandeja_no_ofrece_el_filtro_de_historias(
    bandeja_sin_0044,
):
    """La interfaz lo pregunta ANTES de pintar el boton. Nunca un boton muerto."""
    http, _, _ = bandeja_sin_0044
    disponibilidad = (await http.get(f"{API}/availability")).json()
    assert disponibilidad["story_replies"] is False


@pytest.mark.asyncio
async def test_sin_la_0044_pedir_el_filtro_igual_no_revienta(bandeja_sin_0044):
    """Un cliente viejo con el filtro guardado no puede tumbar la bandeja.

    Lista vacia —que ademas es la verdad: sin la tabla no hay ninguna respuesta a
    una historia— y nunca un 500, que saldria sin cabeceras CORS y en el
    navegador parece un fallo de red.
    """
    http, sesiones, _ = bandeja_sin_0044
    await _sembrar(sesiones, 3, desde=1)

    respuesta = await http.get(API, params={"filtro": "story_replies"})
    assert respuesta.status_code == 200
    assert respuesta.json() == []


@pytest.mark.asyncio
async def test_sin_la_0044_todo_lo_demas_de_la_bandeja_funciona_igual(
    bandeja_sin_0044,
):
    """Una funcion que todavia no esta no puede degradar lo que ya habia."""
    http, sesiones, _ = bandeja_sin_0044
    ids = await _sembrar(sesiones, 3, desde=1)

    assert len((await http.get(API)).json()) == 3
    assert len((await http.get(API, params={"q": "Persona"})).json()) == 3
    assert len((await http.get(API, params={"filtro": "unread"})).json()) == 3
    assert [f["id"] for f in (await http.get(API, params={"limit": 1})).json()] == [
        ids[-1]
    ]
