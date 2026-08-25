"""Las transmisiones en vivo de extremo a extremo, sobre una base de verdad.

SQLite en memoria, mismo patron que el resto de la suite. Las personas, las
emisiones y los mensajes de estos escenarios viven los milisegundos que dura
cada prueba: NUNCA llegan a Supabase, y ningun «directo» de aqui emite nada.

QUE SE COMPRUEBA AQUI Y NO CABE EN UNA FUNCION PURA. Casi todo lo de este
modulo es una regla que cruza el estado de la sala, quien pregunta y que dice la
base: que una emision terminada no se reinicie, que el chat solo este abierto
mientras se emite, que un bloqueo corte en LOS DOS SENTIDOS, que el contador de
reacciones no se pueda inflar y que el listado no haga una consulta por emision.

LO QUE NO SE PRUEBA, y a proposito: nada del proveedor de video real, porque no
hay ninguno elegido todavia. Lo que si se fija es como se comporta el modulo SIN
el, que es como esta hoy en produccion.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.live import limites, providers
from app.modules.live.models import LiveMessage, LiveSession
from app.modules.live.schemas import REACCIONES
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.social_graph.models import UserBlock
from app.shared.database import Base, get_db

API = "/api/v1/live"

ANA = "aaaaaaaa-0000-0000-0000-000000000001"    # emite
BRUNO = "aaaaaaaa-0000-0000-0000-000000000002"  # mira y escribe
CARLA = "aaaaaaaa-0000-0000-0000-000000000003"  # tambien emite
DIEGO = "aaaaaaaa-0000-0000-0000-000000000004"  # administra

#: Un instante fijo para poder sembrar mensajes con horas DISTINTAS entre si.
#: Hace falta porque el `now()` de SQLite tiene resolucion de segundo: varios
#: mensajes escritos seguidos comparten hora y el orden dejaria de ser
#: comprobable, cuando en PostgreSQL —que es donde corre esto— cada insercion
#: cae en su propia transaccion y lleva su propia marca de microsegundos.
ORIGEN = datetime(2026, 8, 24, 12, 0, 0, tzinfo=timezone.utc)


def _instante(segundos: int) -> datetime:
    return ORIGEN + timedelta(seconds=segundos)


@pytest_asyncio.fixture
async def entorno():
    # El limitador de ritmo vive en el PROCESO, no en la base: sin vaciarlo, la
    # prueba que agota su cupo dejaria mudas a las siguientes.
    limites.vaciar()
    esquema.olvidar()

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
        db.add(Profile(id=DIEGO, full_name="Diego", username="diego", role="admin"))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

    async def _usuario_override() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    async def _usuario_opcional_override() -> AuthUser | None:
        # `uid` a None es «nadie ha iniciado sesion»: hace falta para comprobar
        # lo que ve quien entra a mirar sin cuenta.
        if identidad["uid"] is None:
            return None
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario_override
    app.dependency_overrides[get_optional_user] = _usuario_opcional_override
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as http:
        yield http, sesiones, identidad
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)
    limites.vaciar()
    esquema.olvidar()
    await engine.dispose()


# --------------------------------------------------------------------------- #
# Ayudas
# --------------------------------------------------------------------------- #
async def crear_emision(http, *, titulo: str = "Directo", programada: bool = False) -> dict:
    """Una emision, ya emitiendo o solo anunciada. Devuelve el cuerpo."""
    cuerpo: dict = {"title": titulo}
    if programada:
        cuerpo["scheduled_for"] = (
            datetime.now(timezone.utc) + timedelta(hours=2)
        ).isoformat()
    respuesta = await http.post(f"{API}/sessions", json=cuerpo)
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()


async def escribir(http, session_id: str, texto: str):
    return await http.post(
        f"{API}/sessions/{session_id}/messages", json={"body": texto}
    )


async def historial(http, session_id: str) -> list[dict]:
    respuesta = await http.get(f"{API}/sessions/{session_id}/messages")
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


async def sembrar_mensaje(sesiones, session_id: str, autor: str, texto: str, cuando: int):
    """Un mensaje escrito directamente en la base, con SU hora.

    Se salta el endpoint a proposito: asi se puede fijar `created_at` y
    comprobar el orden y el recorte del historial sin depender de la resolucion
    de segundo del reloj de SQLite ni del limite de ritmo.
    """
    async with sesiones() as db:
        db.add(
            LiveMessage(
                session_id=session_id,
                user_id=autor,
                body=texto,
                created_at=_instante(cuando),
            )
        )
        await db.commit()


async def bloquear(sesiones, quien: str, a_quien: str) -> None:
    async with sesiones() as db:
        db.add(UserBlock(blocker_id=quien, blocked_id=a_quien))
        await db.commit()


def codigo(respuesta) -> str:
    return respuesta.json()["error"]["code"]


# --------------------------------------------------------------------------- #
# 1. El ciclo de vida de una emision
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_una_emision_sin_fecha_nace_emitiendo(entorno):
    """Es el camino frecuente: alguien pulsa «emitir» y emite."""
    http, _, _ = entorno
    emision = await crear_emision(http)
    assert emision["status"] == "live"
    assert emision["started_at"] is not None
    assert emision["scheduled_for"] is None
    assert emision["host_id"] == ANA
    assert emision["host_name"] == "Ana"


@pytest.mark.asyncio
async def test_una_emision_con_fecha_nace_anunciada(entorno):
    http, _, _ = entorno
    emision = await crear_emision(http, programada=True)
    assert emision["status"] == "scheduled"
    # Anunciada no es empezada: sin esto, la pestana la ensenaria como si
    # hubiera algo que ver ahora mismo.
    assert emision["started_at"] is None
    assert emision["scheduled_for"] is not None


@pytest.mark.asyncio
async def test_empezar_pasa_de_anunciada_a_emitiendo(entorno):
    http, _, _ = entorno
    emision = await crear_emision(http, programada=True)
    respuesta = await http.post(f"{API}/sessions/{emision['id']}/start")
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["status"] == "live"
    assert respuesta.json()["started_at"] is not None


@pytest.mark.asyncio
async def test_empezar_dos_veces_no_es_un_error(entorno):
    """Pulsar «emitir» dos veces por nervios no puede dar error, ni mover la
    hora de inicio: el chat y la grabacion cuentan desde la primera."""
    http, _, _ = entorno
    emision = await crear_emision(http, programada=True)
    primera = await http.post(f"{API}/sessions/{emision['id']}/start")
    segunda = await http.post(f"{API}/sessions/{emision['id']}/start")
    assert primera.status_code == 200
    assert segunda.status_code == 200
    assert segunda.json()["started_at"] == primera.json()["started_at"]


@pytest.mark.asyncio
async def test_una_emision_terminada_no_se_puede_reiniciar(entorno):
    """Reutilizar la sala mezclaria dos conversaciones de dos dias distintos."""
    http, _, _ = entorno
    emision = await crear_emision(http)
    assert (await http.post(f"{API}/sessions/{emision['id']}/end")).status_code == 200

    respuesta = await http.post(f"{API}/sessions/{emision['id']}/start")
    assert respuesta.status_code == 409
    assert codigo(respuesta) == "live_already_finished"


@pytest.mark.asyncio
async def test_terminar_dos_veces_no_es_un_error(entorno):
    """La red se cae a mitad de peticion mas a menudo de lo que parece; que el
    segundo intento diera error dejaria la emision «en directo» para siempre."""
    http, _, _ = entorno
    emision = await crear_emision(http)
    primera = await http.post(f"{API}/sessions/{emision['id']}/end")
    segunda = await http.post(f"{API}/sessions/{emision['id']}/end")
    assert primera.status_code == 200
    assert segunda.status_code == 200
    assert segunda.json()["status"] == "ended"
    assert segunda.json()["ended_at"] == primera.json()["ended_at"]


@pytest.mark.asyncio
async def test_cancelar_solo_vale_para_lo_que_no_ha_empezado(entorno):
    http, _, _ = entorno
    emision = await crear_emision(http)  # nace ya emitiendo
    respuesta = await http.post(f"{API}/sessions/{emision['id']}/cancel")
    assert respuesta.status_code == 409
    assert codigo(respuesta) == "live_not_cancellable"


@pytest.mark.asyncio
async def test_cancelada_no_es_lo_mismo_que_terminada(entorno):
    """`ended` dice «esto ocurrio y ya paso»; `cancelled`, «no llego a ocurrir».
    Meterlas en el mismo estado haria creer que alguien se perdio algo."""
    http, _, _ = entorno
    emision = await crear_emision(http, programada=True)
    respuesta = await http.post(f"{API}/sessions/{emision['id']}/cancel")
    assert respuesta.status_code == 200
    assert respuesta.json()["status"] == "cancelled"
    assert respuesta.json()["ended_at"] is None


@pytest.mark.asyncio
async def test_una_emision_cancelada_solo_la_ve_quien_la_creo(entorno):
    """Para el resto esa emision nunca existio, y ensenarla haria pensar que se
    perdieron algo que en realidad no ocurrio."""
    http, _, identidad = entorno
    emision = await crear_emision(http, programada=True)
    await http.post(f"{API}/sessions/{emision['id']}/cancel")

    assert (await http.get(f"{API}/sessions/{emision['id']}")).status_code == 200

    identidad["uid"] = BRUNO
    assert (await http.get(f"{API}/sessions/{emision['id']}")).status_code == 404

    identidad["uid"] = None  # ni quien pasa por ahi sin cuenta
    assert (await http.get(f"{API}/sessions/{emision['id']}")).status_code == 404


@pytest.mark.asyncio
async def test_una_emision_cancelada_tampoco_sale_en_el_listado(entorno):
    http, _, _ = entorno
    emision = await crear_emision(http, programada=True)
    await http.post(f"{API}/sessions/{emision['id']}/cancel")
    listado = (await http.get(f"{API}/sessions")).json()
    assert [e["id"] for e in listado] == []


# --------------------------------------------------------------------------- #
# 2. Quien manda en una emision
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_un_extrano_no_puede_editar_la_emision_de_otro(entorno):
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = BRUNO
    respuesta = await http.patch(
        f"{API}/sessions/{emision['id']}", json={"title": "Mi directo ahora"}
    )
    assert respuesta.status_code == 403


@pytest.mark.asyncio
async def test_un_extrano_no_puede_empezar_terminar_ni_cancelar(entorno):
    """Cortar la emision de otra persona delante de su publico es el peor de
    los tres, pero los tres tienen que estar cerrados."""
    http, _, identidad = entorno
    emitiendo = await crear_emision(http)
    anunciada = await crear_emision(http, programada=True)

    identidad["uid"] = BRUNO
    assert (
        await http.post(f"{API}/sessions/{anunciada['id']}/start")
    ).status_code == 403
    assert (
        await http.post(f"{API}/sessions/{emitiendo['id']}/end")
    ).status_code == 403
    assert (
        await http.post(f"{API}/sessions/{anunciada['id']}/cancel")
    ).status_code == 403


@pytest.mark.asyncio
async def test_quien_emite_si_puede_editar_lo_suyo(entorno):
    http, _, _ = entorno
    emision = await crear_emision(http)
    respuesta = await http.patch(
        f"{API}/sessions/{emision['id']}", json={"title": "Otro titulo"}
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["title"] == "Otro titulo"


@pytest.mark.asyncio
async def test_la_administracion_puede_cortar_una_emision_ajena(entorno):
    """Moderar un directo significa poder cortarlo: cuando algo se esta viendo
    en vivo, esperar a que termine es no haber moderado nada."""
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = DIEGO
    respuesta = await http.post(f"{API}/sessions/{emision['id']}/end")
    assert respuesta.status_code == 200
    assert respuesta.json()["status"] == "ended"


@pytest.mark.asyncio
async def test_la_administracion_tambien_puede_editar_y_cancelar(entorno):
    http, _, identidad = entorno
    anunciada = await crear_emision(http, programada=True)
    identidad["uid"] = DIEGO
    assert (
        await http.patch(f"{API}/sessions/{anunciada['id']}", json={"title": "Revisado"})
    ).status_code == 200
    assert (
        await http.post(f"{API}/sessions/{anunciada['id']}/cancel")
    ).status_code == 200


@pytest.mark.asyncio
async def test_can_manage_lo_dice_el_servidor(entorno):
    """La app solo lo usa para no ensenar botones que van a dar 403; el permiso
    se vuelve a comprobar en cada escritura."""
    http, _, identidad = entorno
    emision = await crear_emision(http)
    assert emision["can_manage"] is True  # quien emite

    identidad["uid"] = BRUNO
    ajeno = (await http.get(f"{API}/sessions/{emision['id']}")).json()
    assert ajeno["can_manage"] is False

    identidad["uid"] = DIEGO
    de_admin = (await http.get(f"{API}/sessions/{emision['id']}")).json()
    assert de_admin["can_manage"] is True

    identidad["uid"] = None
    anonimo = (await http.get(f"{API}/sessions/{emision['id']}")).json()
    assert anonimo["can_manage"] is False


# --------------------------------------------------------------------------- #
# 3. El chat
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_no_se_escribe_en_una_emision_anunciada(entorno):
    """Llenar de mensajes una sala que aun no ha empezado deja a quien entre el
    dia de la emision leyendo una conversacion de otro dia."""
    http, _, identidad = entorno
    emision = await crear_emision(http, programada=True)
    identidad["uid"] = BRUNO
    respuesta = await escribir(http, emision["id"], "¿ya empezó?")
    assert respuesta.status_code == 409
    assert codigo(respuesta) == "live_chat_closed"


@pytest.mark.asyncio
async def test_ni_en_una_terminada(entorno):
    http, _, identidad = entorno
    emision = await crear_emision(http)
    await http.post(f"{API}/sessions/{emision['id']}/end")
    identidad["uid"] = BRUNO
    respuesta = await escribir(http, emision["id"], "llego tarde")
    assert respuesta.status_code == 409
    assert codigo(respuesta) == "live_chat_closed"


@pytest.mark.asyncio
async def test_se_escribe_con_la_emision_en_directo(entorno):
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = BRUNO
    respuesta = await escribir(http, emision["id"], "¡hola!")
    assert respuesta.status_code == 201, respuesta.text
    cuerpo = respuesta.json()
    assert cuerpo["body"] == "¡hola!"
    assert cuerpo["user_id"] == BRUNO
    assert cuerpo["user_name"] == "Bruno"
    assert cuerpo["hidden"] is False


@pytest.mark.asyncio
async def test_el_historial_llega_en_el_orden_en_que_se_dijo(entorno):
    """Se siembran a destiempo justamente para comprobar que ordena por la hora
    del mensaje y no por el orden en que se guardaron."""
    http, sesiones, _ = entorno
    emision = await crear_emision(http)
    await sembrar_mensaje(sesiones, emision["id"], BRUNO, "tercero", 20)
    await sembrar_mensaje(sesiones, emision["id"], ANA, "primero", 0)
    await sembrar_mensaje(sesiones, emision["id"], BRUNO, "segundo", 10)

    assert [m["body"] for m in await historial(http, emision["id"])] == [
        "primero",
        "segundo",
        "tercero",
    ]


@pytest.mark.asyncio
async def test_el_historial_entrega_los_ULTIMOS_y_no_la_emision_entera(entorno):
    """Los suficientes para entender de que se habla, no diez minutos de
    conversacion ajena antes de poder participar."""
    http, sesiones, _ = entorno
    emision = await crear_emision(http)
    for i in range(60):
        await sembrar_mensaje(sesiones, emision["id"], BRUNO, f"mensaje {i}", i)

    filas = await historial(http, emision["id"])
    assert len(filas) == 50
    assert filas[0]["body"] == "mensaje 10"
    assert filas[-1]["body"] == "mensaje 59"


@pytest.mark.asyncio
async def test_un_mensaje_vacio_se_rechaza(entorno):
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = BRUNO
    assert (await escribir(http, emision["id"], "")).status_code == 422


@pytest.mark.asyncio
async def test_un_mensaje_de_solo_espacios_tambien(entorno):
    """No es un mensaje: es una linea en blanco empujando fuera de pantalla lo
    que los demas estaban leyendo."""
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = BRUNO
    assert (await escribir(http, emision["id"], "     ")).status_code == 422


@pytest.mark.asyncio
async def test_un_mensaje_de_mas_de_300_caracteres_se_rechaza(entorno):
    """Un chat en directo se lee de reojo; un parrafo ahi no lo lee nadie."""
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = BRUNO
    assert (await escribir(http, emision["id"], "a" * 301)).status_code == 422
    # Y justo en el limite si entra: el corte tiene que estar donde dice.
    assert (await escribir(http, emision["id"], "a" * 300)).status_code == 201


# --------------------------------------------------------------------------- #
# 4. Moderar el chat
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_esconder_un_mensaje_lo_puede_hacer_quien_emite(entorno):
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = BRUNO
    mensaje = (await escribir(http, emision["id"], "algo feo")).json()

    identidad["uid"] = ANA  # es su sala
    respuesta = await http.post(f"{API}/messages/{mensaje['id']}/hide")
    assert respuesta.status_code == 200
    assert respuesta.json()["hidden"] is True
    # Se esconde, NO se borra: sin el texto el moderador no puede explicar por
    # que lo hizo.
    assert respuesta.json()["body"] == "algo feo"


@pytest.mark.asyncio
async def test_y_tambien_la_administracion(entorno):
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = BRUNO
    mensaje = (await escribir(http, emision["id"], "algo feo")).json()

    identidad["uid"] = DIEGO
    assert (
        await http.post(f"{API}/messages/{mensaje['id']}/hide")
    ).status_code == 200


@pytest.mark.asyncio
async def test_un_espectador_cualquiera_no_puede_esconder_nada(entorno):
    """Si pudiera, cualquiera callaria a cualquiera en la sala de otra persona."""
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = BRUNO
    mensaje = (await escribir(http, emision["id"], "una opinión")).json()

    identidad["uid"] = CARLA
    assert (
        await http.post(f"{API}/messages/{mensaje['id']}/hide")
    ).status_code == 403


@pytest.mark.asyncio
async def test_un_mensaje_escondido_no_lo_ve_un_tercero(entorno):
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = BRUNO
    mensaje = (await escribir(http, emision["id"], "algo feo")).json()
    identidad["uid"] = ANA
    await http.post(f"{API}/messages/{mensaje['id']}/hide")

    identidad["uid"] = CARLA
    assert [m["id"] for m in await historial(http, emision["id"])] == []

    identidad["uid"] = None  # ni quien entra sin cuenta
    assert [m["id"] for m in await historial(http, emision["id"])] == []


@pytest.mark.asyncio
async def test_pero_SI_lo_ve_quien_lo_escribio(entorno):
    """Que le desaparezca sin explicacion le haria escribirlo otra vez, y otra."""
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = BRUNO
    mensaje = (await escribir(http, emision["id"], "algo feo")).json()
    identidad["uid"] = ANA
    await http.post(f"{API}/messages/{mensaje['id']}/hide")

    identidad["uid"] = BRUNO
    suyo = await historial(http, emision["id"])
    assert [m["id"] for m in suyo] == [mensaje["id"]]
    # Y le llega marcado, para poder decirle que esta escondido.
    assert suyo[0]["hidden"] is True


@pytest.mark.asyncio
async def test_y_tambien_quien_modera(entorno):
    """Sin verlo, el moderador no puede revisar lo que escondio ni explicarlo."""
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = BRUNO
    mensaje = (await escribir(http, emision["id"], "algo feo")).json()
    identidad["uid"] = ANA
    await http.post(f"{API}/messages/{mensaje['id']}/hide")

    del_anfitrion = await historial(http, emision["id"])
    assert [m["id"] for m in del_anfitrion] == [mensaje["id"]]
    assert del_anfitrion[0]["hidden"] is True

    identidad["uid"] = DIEGO
    de_admin = await historial(http, emision["id"])
    assert [m["id"] for m in de_admin] == [mensaje["id"]]


# --------------------------------------------------------------------------- #
# 5. Bloqueos: el corte es SIMETRICO
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_quien_fue_bloqueado_por_el_anfitrion_no_puede_escribir(entorno):
    http, sesiones, identidad = entorno
    emision = await crear_emision(http)
    await bloquear(sesiones, ANA, BRUNO)

    identidad["uid"] = BRUNO
    assert (await escribir(http, emision["id"], "hola")).status_code == 403


@pytest.mark.asyncio
async def test_ni_quien_bloqueo_al_anfitrion(entorno):
    """El otro sentido del mismo corte: bloquear a alguien y luego meterse en su
    chat seria usar el bloqueo como escudo para molestar."""
    http, sesiones, identidad = entorno
    emision = await crear_emision(http)
    await bloquear(sesiones, BRUNO, ANA)

    identidad["uid"] = BRUNO
    assert (await escribir(http, emision["id"], "hola")).status_code == 403


@pytest.mark.asyncio
async def test_los_mensajes_de_alguien_bloqueado_no_salen_en_el_historial(entorno):
    http, sesiones, identidad = entorno
    identidad["uid"] = CARLA
    emision = await crear_emision(http)  # la sala es de Carla

    await sembrar_mensaje(sesiones, emision["id"], BRUNO, "de bruno", 0)
    await sembrar_mensaje(sesiones, emision["id"], ANA, "de ana", 10)
    await bloquear(sesiones, ANA, BRUNO)

    identidad["uid"] = ANA
    assert [m["body"] for m in await historial(http, emision["id"])] == ["de ana"]


@pytest.mark.asyncio
async def test_tampoco_si_es_el_otro_quien_bloqueo(entorno):
    http, sesiones, identidad = entorno
    identidad["uid"] = CARLA
    emision = await crear_emision(http)

    await sembrar_mensaje(sesiones, emision["id"], BRUNO, "de bruno", 0)
    await sembrar_mensaje(sesiones, emision["id"], ANA, "de ana", 10)
    await bloquear(sesiones, BRUNO, ANA)

    identidad["uid"] = ANA
    assert [m["body"] for m in await historial(http, emision["id"])] == ["de ana"]


@pytest.mark.asyncio
async def test_la_emision_de_alguien_bloqueado_no_sale_en_el_listado(entorno):
    http, sesiones, identidad = entorno
    identidad["uid"] = CARLA
    de_carla = await crear_emision(http)
    identidad["uid"] = ANA
    de_ana = await crear_emision(http)

    await bloquear(sesiones, ANA, CARLA)
    listado = (await http.get(f"{API}/sessions")).json()
    assert [e["id"] for e in listado] == [de_ana["id"]]
    assert de_carla["id"] not in [e["id"] for e in listado]


@pytest.mark.asyncio
async def test_ni_aunque_el_bloqueo_venga_del_otro_lado(entorno):
    http, sesiones, identidad = entorno
    identidad["uid"] = CARLA
    de_carla = await crear_emision(http)
    identidad["uid"] = ANA
    de_ana = await crear_emision(http)

    await bloquear(sesiones, CARLA, ANA)
    listado = (await http.get(f"{API}/sessions")).json()
    assert [e["id"] for e in listado] == [de_ana["id"]]
    assert de_carla["id"] not in [e["id"] for e in listado]


# --------------------------------------------------------------------------- #
# 6. Limite de ritmo
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_al_pasarse_del_cupo_de_mensajes_se_responde_409(entorno):
    """Sin esto, una persona con un bucle de tres lineas llena la pantalla de
    cien espectadores y la emision se acaba."""
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = BRUNO

    for i in range(limites.MENSAJES_POR_VENTANA):
        assert (await escribir(http, emision["id"], f"m{i}")).status_code == 201

    respuesta = await escribir(http, emision["id"], "una mas")
    assert respuesta.status_code == 409
    assert codigo(respuesta) == "live_chat_rate_limited"


@pytest.mark.asyncio
async def test_la_ventana_es_POR_PERSONA(entorno):
    """Que uno agote su cupo no puede callar a los demas: seria una forma
    trivial de cerrar el chat de una emision ajena."""
    http, _, identidad = entorno
    emision = await crear_emision(http)

    identidad["uid"] = BRUNO
    for i in range(limites.MENSAJES_POR_VENTANA):
        await escribir(http, emision["id"], f"m{i}")
    assert (await escribir(http, emision["id"], "otra")).status_code == 409

    identidad["uid"] = CARLA
    assert (await escribir(http, emision["id"], "yo si puedo")).status_code == 201


@pytest.mark.asyncio
async def test_y_POR_SALA(entorno):
    """Agotar el cupo en un directo no puede dejar a nadie mudo en otro."""
    http, _, identidad = entorno
    una = await crear_emision(http, titulo="Una")
    identidad["uid"] = CARLA
    otra = await crear_emision(http, titulo="Otra")

    identidad["uid"] = BRUNO
    for i in range(limites.MENSAJES_POR_VENTANA):
        await escribir(http, una["id"], f"m{i}")
    assert (await escribir(http, una["id"], "otra mas")).status_code == 409

    assert (await escribir(http, otra["id"], "aquí sí")).status_code == 201


# --------------------------------------------------------------------------- #
# 7. Reacciones
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_las_reacciones_suman_al_total(entorno):
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = BRUNO
    respuesta = await http.post(
        f"{API}/sessions/{emision['id']}/reactions",
        json={"counts": {"corazon": 7, "fuego": 2}},
    )
    assert respuesta.status_code == 200, respuesta.text
    totales = respuesta.json()["totals"]
    assert totales["corazon"] == 7
    assert totales["fuego"] == 2


@pytest.mark.asyncio
async def test_los_tipos_que_nadie_pulso_salen_a_CERO_y_no_ausentes(entorno):
    """Un hueco se lee como «esto no se mide», que es otra cosa muy distinta de
    «nadie lo pulso»."""
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = BRUNO
    totales = (
        await http.post(
            f"{API}/sessions/{emision['id']}/reactions",
            json={"counts": {"corazon": 1}},
        )
    ).json()["totals"]
    assert set(totales) == set(REACCIONES)
    assert totales["risa"] == 0

    # Y lo mismo en la tarjeta de la emision, que es donde se ve el contador.
    detalle = (await http.get(f"{API}/sessions/{emision['id']}")).json()
    assert set(detalle["reactions"]) == set(REACCIONES)
    assert detalle["reactions"]["aplauso"] == 0


@pytest.mark.asyncio
async def test_un_tipo_de_reaccion_inventado_se_rechaza(entorno):
    """El catalogo corto es lo que hace que la fila se lea de un vistazo; si el
    cliente pudiera inventar tipos, dejaria de ser corto."""
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = BRUNO
    respuesta = await http.post(
        f"{API}/sessions/{emision['id']}/reactions",
        json={"counts": {"cohete": 3}},
    )
    assert respuesta.status_code == 422


@pytest.mark.asyncio
async def test_un_envio_por_encima_del_limite_se_RECORTA_y_no_se_rechaza(entorno):
    """Quien pulso ciento noventa y manda doscientas diez no esta atacando
    nada: perderle las doscientas seria castigar el entusiasmo."""
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = BRUNO
    respuesta = await http.post(
        f"{API}/sessions/{emision['id']}/reactions",
        json={"counts": {"corazon": 9_000_000}},
    )
    assert respuesta.status_code == 200
    assert respuesta.json()["totals"]["corazon"] == limites.LIMITE_POR_ENVIO


@pytest.mark.asyncio
async def test_dos_envios_seguidos_acumulan(entorno):
    """El cliente manda el resumen cada pocos segundos; si cada envio pisara al
    anterior, el contador contaria solo los ultimos segundos de la emision."""
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = BRUNO
    for _ in range(2):
        respuesta = await http.post(
            f"{API}/sessions/{emision['id']}/reactions",
            json={"counts": {"corazon": 5}},
        )
    assert respuesta.json()["totals"]["corazon"] == 10


@pytest.mark.asyncio
async def test_solo_se_reacciona_mientras_se_emite(entorno):
    http, _, identidad = entorno
    anunciada = await crear_emision(http, programada=True)
    terminada = await crear_emision(http)
    await http.post(f"{API}/sessions/{terminada['id']}/end")

    identidad["uid"] = BRUNO
    for emision in (anunciada, terminada):
        respuesta = await http.post(
            f"{API}/sessions/{emision['id']}/reactions",
            json={"counts": {"corazon": 1}},
        )
        assert respuesta.status_code == 409
        assert codigo(respuesta) == "live_reactions_closed"


# --------------------------------------------------------------------------- #
# 8. `acotar_envio`, como funcion pura
# --------------------------------------------------------------------------- #
def test_acotar_envio_recorta_lo_que_pasa_del_tope():
    assert limites.acotar_envio({"corazon": 9_000_000}) == {
        "corazon": limites.LIMITE_POR_ENVIO
    }


def test_acotar_envio_reparte_el_tope_entre_los_tipos():
    """El tope es del ENVIO, no de cada tipo: si fuera por tipo, mandar cinco
    tipos multiplicaria por cinco lo que se puede inflar el contador."""
    recortado = limites.acotar_envio({"corazon": 150, "fuego": 100})
    assert recortado == {"corazon": 150, "fuego": 50}
    assert sum(recortado.values()) == limites.LIMITE_POR_ENVIO


def test_acotar_envio_deja_fuera_lo_que_ya_no_cabe():
    recortado = limites.acotar_envio({"corazon": limites.LIMITE_POR_ENVIO, "risa": 5})
    assert "risa" not in recortado


def test_acotar_envio_ignora_lo_que_no_suma_nada():
    """Un cero no es una reaccion: escribir la fila para sumar nada seria un
    viaje a la base por peticion vacia."""
    assert limites.acotar_envio({"corazon": 0}) == {}


def test_acotar_envio_no_toca_un_envio_normal():
    assert limites.acotar_envio({"corazon": 12, "risa": 3}) == {"corazon": 12, "risa": 3}


# --------------------------------------------------------------------------- #
# 9. Audiencia
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_pico_de_espectadores_guarda_el_MAXIMO(entorno):
    """El instantaneo deja de significar nada en cuanto la emision termina: si
    se guardara el ultimo, una emision con cien espectadores que se vacia al
    final quedaria registrada como una emision de diez."""
    http, _, _ = entorno
    emision = await crear_emision(http)
    cien = await http.post(f"{API}/sessions/{emision['id']}/viewers", params={"count": 100})
    assert cien.status_code == 200
    assert cien.json()["viewer_peak"] == 100

    diez = await http.post(f"{API}/sessions/{emision['id']}/viewers", params={"count": 10})
    assert diez.status_code == 200
    assert diez.json()["viewer_peak"] == 100


@pytest.mark.asyncio
async def test_solo_quien_emite_informa_de_su_audiencia(entorno):
    """Es el unico que lo sabe —se lo dice el proveedor—; dejarlo abierto
    convertiria el numero en lo que quisiera escribir el ultimo."""
    http, _, identidad = entorno
    emision = await crear_emision(http)
    identidad["uid"] = BRUNO
    respuesta = await http.post(
        f"{API}/sessions/{emision['id']}/viewers", params={"count": 5000}
    )
    assert respuesta.status_code == 403

    identidad["uid"] = ANA
    detalle = (await http.get(f"{API}/sessions/{emision['id']}")).json()
    assert detalle["viewer_peak"] == 0


# --------------------------------------------------------------------------- #
# 10. El proveedor de video, que todavia no existe
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_sin_proveedor_no_hay_imagen_y_se_dice(entorno):
    """Sin esto la aplicacion dejaria un reproductor girando para siempre
    esperando una imagen que no va a llegar."""
    http, _, _ = entorno
    emision = await crear_emision(http)
    assert emision["playback_available"] is False
    assert emision["provider"] == "none"
    # Y la sala existe igual: el chat funciona, que es la parte que no se compra.
    assert emision["status"] == "live"


@pytest.mark.asyncio
async def test_pedir_credencial_responde_503_y_no_500(entorno):
    """503 y no 404: un 404 hace pensar que la ruta esta mal escrita, cuando lo
    que falta es la configuracion del servicio."""
    http, _, _ = entorno
    emision = await crear_emision(http)
    respuesta = await http.post(f"{API}/sessions/{emision['id']}/credential")
    assert respuesta.status_code == 503
    assert codigo(respuesta) == "live_provider_not_configured"


def test_hoy_no_hay_ningun_proveedor_real():
    assert providers.hay_proveedor_real() is False
    assert isinstance(
        providers.obtener_proveedor("none"), providers.ProveedorNoConfigurado
    )


@pytest.mark.asyncio
async def test_cerrar_una_sala_inexistente_NO_puede_lanzar():
    """Terminar una emision no puede fallar por culpa del proveedor: si cerrar
    lanzara, la emision se quedaria «en directo» para siempre."""
    proveedor = providers.ProveedorNoConfigurado()
    assert await proveedor.cerrar_sala(room_id="lo-que-sea") is None


@pytest.mark.asyncio
async def test_abrir_sala_y_pedir_credencial_SI_lanzan():
    """Falla de forma explicita en vez de simular una emision, que es
    exactamente el error que llevo a borrar la pantalla de directo anterior."""
    proveedor = providers.ProveedorNoConfigurado()
    with pytest.raises(NotImplementedError):
        await proveedor.abrir_sala(session_id="x", titulo="y")
    with pytest.raises(NotImplementedError):
        await proveedor.credencial(room_id="x", user_id="y", puede_emitir=True)


# --------------------------------------------------------------------------- #
# 11. Rendimiento
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_numero_de_consultas_no_crece_con_las_emisiones(entorno):
    """PROHIBIDO una consulta por emision. La pestana Live se abre entera de
    golpe: con quince emisiones serian cuarenta y cinco viajes a la base para
    pintar una lista que cabe en una pantalla."""
    http, sesiones, _ = entorno
    anfitriones = [ANA, BRUNO, CARLA]
    async with sesiones() as db:
        for i in range(15):
            db.add(
                LiveSession(
                    id=f"55555555-0000-0000-0000-{i:012d}",
                    host_id=anfitriones[i % len(anfitriones)],
                    title=f"Directo {i}",
                    status="live",
                    started_at=_instante(i),
                )
            )
        await db.commit()

    # Un viaje en vacio primero: la deteccion del esquema se hace UNA vez por
    # proceso y contarla aqui mediria otra cosa.
    assert (await http.get(f"{API}/sessions", params={"limit": 15})).status_code == 200

    consultas: list[str] = []

    def _contar(conn, cursor, statement, *args):  # noqa: ANN001
        consultas.append(statement)

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _contar)
    try:
        respuesta = await http.get(f"{API}/sessions", params={"limit": 15})
    finally:
        event.remove(motor, "before_cursor_execute", _contar)

    assert respuesta.status_code == 200
    assert len(respuesta.json()) == 15
    selects = [c for c in consultas if c.lstrip().lower().startswith("select")]
    assert len(selects) <= 8, f"{len(selects)} consultas para 15 emisiones"


@pytest.mark.asyncio
async def test_el_historial_no_hace_una_consulta_por_mensaje(entorno):
    """Los autores se resuelven de una vez; si no, entrar a una emision con
    cincuenta mensajes costaria cincuenta viajes solo para poner los nombres."""
    http, sesiones, _ = entorno
    emision = await crear_emision(http)
    for i in range(30):
        autor = (BRUNO, CARLA, ANA)[i % 3]
        await sembrar_mensaje(sesiones, emision["id"], autor, f"m{i}", i)

    assert (await http.get(f"{API}/sessions/{emision['id']}/messages")).status_code == 200

    consultas: list[str] = []

    def _contar(conn, cursor, statement, *args):  # noqa: ANN001
        consultas.append(statement)

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _contar)
    try:
        respuesta = await http.get(f"{API}/sessions/{emision['id']}/messages")
    finally:
        event.remove(motor, "before_cursor_execute", _contar)

    assert len(respuesta.json()) == 30
    selects = [c for c in consultas if c.lstrip().lower().startswith("select")]
    assert len(selects) <= 6, f"{len(selects)} consultas para 30 mensajes"


# --------------------------------------------------------------------------- #
# 12. Regresion: la consulta con lista vacia
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_el_historial_vacio_no_pregunta_por_un_perfil_con_id_vacio(entorno):
    """Una emision recien empezada tiene el chat vacio: es el caso NORMAL.

    EL FALLO QUE FIJA ESTA PRUEBA. El codigo resolvia los autores con
    `Profile.id.in_([...] or [""])`, y con el chat vacio eso mandaba la cadena
    vacia a una columna `uuid`. En SQLite colaba —su conversor solo quita los
    guiones— asi que la suite entera pasaba en verde. En PostgreSQL asyncpg la
    rechaza, y el manejador de errores lo convertia en un **404**: el historial
    de toda emision recien empezada habria respondido «no encontrado» en vez de
    una lista vacia.

    Tambien se llega aqui cuando todo lo escrito queda filtrado por bloqueos o
    por moderacion, asi que no era un caso de borde: era el arranque de
    cualquier emision.

    Se comprueba mirando los PARAMETROS de verdad y no solo el codigo de
    respuesta, porque el sintoma solo aparece contra PostgreSQL y esta prueba
    corre sobre SQLite. Sin mirar los parametros, esto pasaria roto para
    siempre.
    """
    http, sesiones, _ = entorno
    emision = await crear_emision(http)

    vistas: list[tuple[str, object]] = []

    def _anotar(conn, cursor, statement, *args):  # noqa: ANN001
        vistas.append((statement, args[0] if args else ()))

    motor = sesiones.kw["bind"].sync_engine
    event.listen(motor, "before_cursor_execute", _anotar)
    try:
        respuesta = await http.get(f"{API}/sessions/{emision['id']}/messages")
    finally:
        event.remove(motor, "before_cursor_execute", _anotar)

    assert respuesta.status_code == 200
    assert respuesta.json() == []

    culpables = [
        sentencia
        for sentencia, parametros in vistas
        if "profiles" in sentencia.lower()
        and "" in (parametros.values() if isinstance(parametros, dict) else parametros)
    ]
    assert not culpables, (
        "se pregunta por un perfil con id vacío: en PostgreSQL eso revienta"
    )
