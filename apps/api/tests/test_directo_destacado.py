"""Lo destacado de un directo: el mensaje fijado y el rótulo de quien emite.

Pedido el 07/10/2026. Lo que se protege aquí es lo que intentaría alguien con
malas intenciones —poner su texto sobre el directo de otra persona, dejar en lo
alto de la pantalla un mensaje que la moderación ya escondió— y lo que rompería
a alguien con buenas: quedarse sin directo porque la migración 0099 no está.

El proveedor de vídeo es el mismo doble que usan las pruebas de invitados.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import app
from app.modules.live import destacado, limites, providers
from app.modules.live.models import LiveMessage, LiveSession, LiveSpotlight
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from app.modules.social_graph.models import UserBlock
from app.shared.database import Base, get_db
from tests.test_directo_invitados import ANA, BRUNO, CARLA, LIVE, NADIE, _Doble, _recoger


async def _levantar(sin_la_0099: bool = False):
    limites.vaciar()
    esquema.olvidar()

    doble = _Doble()
    anteriores = dict(providers.PROVEEDORES)
    providers.PROVEEDORES["100ms"] = doble

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

        if sin_la_0099:
            tablas = [t for t in Base.metadata.sorted_tables if t.name != "live_spotlights"]
            await conn.run_sync(lambda sync: Base.metadata.create_all(sync, tables=tablas))
        else:
            await conn.run_sync(Base.metadata.create_all)

    sesiones = async_sessionmaker(engine, expire_on_commit=False)
    async with sesiones() as db:
        for uid, nombre in ((ANA, "Ana"), (BRUNO, "Bruno"), (CARLA, "Carla")):
            db.add(Profile(id=uid, full_name=nombre, username=nombre.lower()))
        await db.commit()

    async def _db_override():
        async with sesiones() as session:
            yield session

    identidad = {"uid": ANA}

    async def _usuario() -> AuthUser:
        return AuthUser(id=identidad["uid"], email="x@y.z", role="authenticated")

    app.dependency_overrides[get_db] = _db_override
    app.dependency_overrides[get_current_user] = _usuario
    app.dependency_overrides[get_optional_user] = _usuario
    return engine, sesiones, identidad, anteriores


@pytest_asyncio.fixture
async def entorno():
    engine, sesiones, identidad, anteriores = await _levantar()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad
    await _recoger(engine, anteriores)


@pytest_asyncio.fixture
async def sin_migracion():
    engine, sesiones, identidad, anteriores = await _levantar(sin_la_0099=True)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad
    await _recoger(engine, anteriores)


async def _emision(http, *, en_vivo: bool = True) -> str:
    cuerpo = {"title": "Charla"}
    if not en_vivo:
        cuerpo["scheduled_for"] = "2099-01-01T10:00:00Z"
    respuesta = await http.post(f"{LIVE}/sessions", json=cuerpo)
    assert respuesta.status_code in (200, 201), respuesta.text
    return respuesta.json()["id"]


async def _escribir(http, identidad, sesion_id: str, quien: str, texto: str) -> str:
    """Un mensaje de `quien` en el chat. Deja la identidad como estaba."""
    antes = identidad["uid"]
    identidad["uid"] = quien
    respuesta = await http.post(f"{LIVE}/sessions/{sesion_id}/messages", json={"body": texto})
    identidad["uid"] = antes
    assert respuesta.status_code == 201, respuesta.text
    return respuesta.json()["id"]


def _ruta(sesion_id: str, cola: str = "") -> str:
    return f"{LIVE}/sessions/{sesion_id}/spotlight{cola}"


async def _fijar(http, sesion_id: str, message_id: str):
    return await http.put(_ruta(sesion_id, "/pin"), json={"message_id": message_id})


async def _rotulo(http, sesion_id: str, texto: str, estilo: str | None = None):
    cuerpo: dict = {"text": texto}
    if estilo is not None:
        cuerpo["style"] = estilo
    return await http.put(_ruta(sesion_id, "/banner"), json=cuerpo)


async def _ver(http, sesion_id: str) -> dict:
    respuesta = await http.get(_ruta(sesion_id))
    assert respuesta.status_code == 200, respuesta.text
    return respuesta.json()


# --------------------------------------------------------------------------- #
# 1. Sin la migración 0099 no se rompe nada de lo que ya había
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_sin_la_0099_el_directo_y_su_chat_funcionan_como_siempre(sin_migracion):
    http, _sesiones, identidad = sin_migracion
    sesion_id = await _emision(http)

    # Se lee la emisión, se escribe y se modera: nada de eso mira la tabla nueva.
    assert (await http.get(f"{LIVE}/sessions/{sesion_id}")).status_code == 200
    mensaje_id = await _escribir(http, identidad, sesion_id, BRUNO, "hola")
    escondido = await http.post(f"{LIVE}/messages/{mensaje_id}/hide")
    assert escondido.status_code == 200, escondido.text
    assert escondido.json()["hidden"] is True
    assert (await http.post(f"{LIVE}/sessions/{sesion_id}/end")).status_code == 200


@pytest.mark.asyncio
async def test_sin_la_0099_lo_de_destacar_dice_que_no_esta_disponible(sin_migracion):
    http, _sesiones, identidad = sin_migracion
    sesion_id = await _emision(http)
    mensaje_id = await _escribir(http, identidad, sesion_id, BRUNO, "hola")

    for metodo, cola, cuerpo in (
        ("GET", "", None),
        ("PUT", "/pin", {"message_id": mensaje_id}),
        ("DELETE", "/pin", None),
        ("PUT", "/banner", {"text": "Hola"}),
        ("DELETE", "/banner", None),
    ):
        respuesta = await http.request(metodo, _ruta(sesion_id, cola), json=cuerpo)
        assert respuesta.status_code == 503, (metodo, cola, respuesta.text)
        assert respuesta.json()["error"]["code"] == "live_spotlight_not_available"


# --------------------------------------------------------------------------- #
# 2. Fijar un mensaje
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_sin_nada_destacado_llega_todo_a_nulo_y_no_ausente(entorno):
    http, _sesiones, identidad = entorno
    sesion_id = await _emision(http)

    assert await _ver(http, sesion_id) == {
        "pinned": None, "banner": None, "can_manage": True, "banner_layout": False
    }
    identidad["uid"] = CARLA
    assert await _ver(http, sesion_id) == {
        "pinned": None, "banner": None, "can_manage": False, "banner_layout": False
    }


@pytest.mark.asyncio
async def test_quien_emite_fija_un_mensaje_y_lo_ve_quien_mira(entorno):
    http, sesiones, identidad = entorno
    sesion_id = await _emision(http)
    mensaje_id = await _escribir(http, identidad, sesion_id, BRUNO, "¿A qué hora es el taller?")

    respuesta = await _fijar(http, sesion_id, mensaje_id)
    assert respuesta.status_code == 200, respuesta.text
    assert respuesta.json()["can_manage"] is True

    identidad["uid"] = CARLA
    visto = await _ver(http, sesion_id)
    assert visto["can_manage"] is False
    assert visto["pinned"]["id"] == mensaje_id
    assert visto["pinned"]["body"] == "¿A qué hora es el taller?"
    assert visto["pinned"]["user_id"] == BRUNO
    assert visto["pinned"]["user_name"] == "Bruno"
    assert visto["pinned"]["hidden"] is False

    async with sesiones() as db:
        fila = await db.get(LiveSpotlight, sesion_id)
    assert (fila.pinned_message_id, fila.pinned_by) == (mensaje_id, ANA)
    assert fila.pinned_at is not None


@pytest.mark.asyncio
async def test_fijar_otro_sustituye_al_anterior_y_no_crea_otra_fila(entorno):
    http, sesiones, identidad = entorno
    sesion_id = await _emision(http)
    primero = await _escribir(http, identidad, sesion_id, BRUNO, "uno")
    segundo = await _escribir(http, identidad, sesion_id, CARLA, "dos")

    assert (await _fijar(http, sesion_id, primero)).status_code == 200
    assert (await _fijar(http, sesion_id, segundo)).json()["pinned"]["id"] == segundo

    async with sesiones() as db:
        filas = list(await db.scalars(select(LiveSpotlight)))
    assert [f.pinned_message_id for f in filas] == [segundo]


@pytest.mark.asyncio
async def test_quien_emite_puede_fijar_su_propio_mensaje(entorno):
    http, _sesiones, identidad = entorno
    sesion_id = await _emision(http)
    suyo = await _escribir(http, identidad, sesion_id, ANA, "Empezamos en cinco minutos")
    assert (await _fijar(http, sesion_id, suyo)).json()["pinned"]["user_id"] == ANA


@pytest.mark.asyncio
async def test_quien_mira_no_puede_fijar_soltar_ni_poner_rotulo(entorno):
    http, sesiones, identidad = entorno
    sesion_id = await _emision(http)
    mensaje_id = await _escribir(http, identidad, sesion_id, BRUNO, "hola")
    assert (await _fijar(http, sesion_id, mensaje_id)).status_code == 200
    assert (await _rotulo(http, sesion_id, "Bienvenidos")).status_code == 200

    identidad["uid"] = BRUNO  # ni siquiera quien escribió el mensaje fijado
    otro = await _escribir(http, identidad, sesion_id, BRUNO, "fíjame a mí")
    assert (await _fijar(http, sesion_id, otro)).status_code == 403
    assert (await http.delete(_ruta(sesion_id, "/pin"))).status_code == 403
    assert (await _rotulo(http, sesion_id, "Mi texto")).status_code == 403
    assert (await http.delete(_ruta(sesion_id, "/banner"))).status_code == 403

    async with sesiones() as db:
        fila = await db.get(LiveSpotlight, sesion_id)
    assert (fila.pinned_message_id, fila.banner_text) == (mensaje_id, "Bienvenidos")


@pytest.mark.asyncio
async def test_no_se_fija_un_mensaje_de_otra_sala_ni_uno_que_no_existe(entorno):
    http, sesiones, identidad = entorno
    aqui = await _emision(http)
    identidad["uid"] = BRUNO
    alli = await _emision(http)  # la emisión de Bruno
    ajeno = await _escribir(http, identidad, alli, CARLA, "en la otra sala")
    identidad["uid"] = ANA

    for message_id in (ajeno, NADIE, "no-es-un-id"):
        respuesta = await _fijar(http, aqui, message_id)
        assert respuesta.status_code == 404, (message_id, respuesta.text)

    async with sesiones() as db:
        assert await db.get(LiveSpotlight, aqui) is None


@pytest.mark.asyncio
async def test_un_mensaje_escondido_no_se_puede_fijar(entorno):
    http, _sesiones, identidad = entorno
    sesion_id = await _emision(http)
    mensaje_id = await _escribir(http, identidad, sesion_id, BRUNO, "spam")
    assert (await http.post(f"{LIVE}/messages/{mensaje_id}/hide")).status_code == 200

    respuesta = await _fijar(http, sesion_id, mensaje_id)
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "live_message_hidden"


@pytest.mark.asyncio
async def test_esconder_el_mensaje_fijado_lo_suelta_y_conserva_el_rotulo(entorno):
    http, sesiones, identidad = entorno
    sesion_id = await _emision(http)
    mensaje_id = await _escribir(http, identidad, sesion_id, BRUNO, "algo feo")
    assert (await _fijar(http, sesion_id, mensaje_id)).status_code == 200
    assert (await _rotulo(http, sesion_id, "Seguimos")).status_code == 200

    assert (await http.post(f"{LIVE}/messages/{mensaje_id}/hide")).status_code == 200

    # Ni a quien modera se le enseña fijado un mensaje escondido.
    visto = await _ver(http, sesion_id)
    assert visto["pinned"] is None
    assert visto["banner"]["text"] == "Seguimos"
    async with sesiones() as db:
        fila = await db.get(LiveSpotlight, sesion_id)
    assert (fila.pinned_message_id, fila.pinned_by, fila.pinned_at) == (None, None, None)


@pytest.mark.asyncio
async def test_esconder_un_mensaje_que_no_estaba_fijado_no_suelta_el_fijado(entorno):
    http, _sesiones, identidad = entorno
    sesion_id = await _emision(http)
    fijado = await _escribir(http, identidad, sesion_id, BRUNO, "bueno")
    otro = await _escribir(http, identidad, sesion_id, CARLA, "malo")
    assert (await _fijar(http, sesion_id, fijado)).status_code == 200

    assert (await http.post(f"{LIVE}/messages/{otro}/hide")).status_code == 200
    assert (await _ver(http, sesion_id))["pinned"]["id"] == fijado


@pytest.mark.asyncio
@pytest.mark.parametrize("quien_bloquea", ["quien mira", "quien escribió"])
async def test_un_bloqueo_esconde_el_fijado_solo_a_esas_dos_personas(entorno, quien_bloquea):
    http, sesiones, identidad = entorno
    sesion_id = await _emision(http)
    mensaje_id = await _escribir(http, identidad, sesion_id, BRUNO, "hola a todos")
    assert (await _fijar(http, sesion_id, mensaje_id)).status_code == 200
    async with sesiones() as db:
        db.add(
            UserBlock(blocker_id=CARLA, blocked_id=BRUNO)
            if quien_bloquea == "quien mira"
            else UserBlock(blocker_id=BRUNO, blocked_id=CARLA)
        )
        await db.commit()

    # Igual que en el chat: a Carla no le llega nada de Bruno, tampoco fijado.
    identidad["uid"] = CARLA
    assert (await _ver(http, sesion_id))["pinned"] is None
    # A quien emite sí: el bloqueo es entre ellos dos.
    identidad["uid"] = ANA
    assert (await _ver(http, sesion_id))["pinned"]["id"] == mensaje_id


@pytest.mark.asyncio
async def test_soltar_quita_el_fijado_y_hacerlo_dos_veces_no_falla(entorno):
    http, _sesiones, identidad = entorno
    sesion_id = await _emision(http)
    mensaje_id = await _escribir(http, identidad, sesion_id, BRUNO, "hola")
    assert (await _fijar(http, sesion_id, mensaje_id)).status_code == 200

    for _ in range(2):
        respuesta = await http.delete(_ruta(sesion_id, "/pin"))
        assert respuesta.status_code == 200, respuesta.text
        assert respuesta.json()["pinned"] is None
    # Y sin haber destacado nunca nada, tampoco.
    otra = await _emision_de(http, identidad, CARLA)
    identidad["uid"] = CARLA
    assert (await http.delete(_ruta(otra, "/pin"))).status_code == 200
    assert (await http.delete(_ruta(otra, "/banner"))).status_code == 200


async def _emision_de(http, identidad, quien: str) -> str:
    antes = identidad["uid"]
    identidad["uid"] = quien
    sesion_id = await _emision(http)
    identidad["uid"] = antes
    return sesion_id


# --------------------------------------------------------------------------- #
# 3. El rótulo de quien emite
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_quien_emite_pone_un_rotulo_y_lo_ve_quien_mira(entorno):
    http, sesiones, identidad = entorno
    sesion_id = await _emision(http)

    respuesta = await _rotulo(http, sesion_id, "Sorteo a las 8", "pulse")
    assert respuesta.status_code == 200, respuesta.text

    identidad["uid"] = CARLA
    visto = await _ver(http, sesion_id)
    assert visto["banner"]["text"] == "Sorteo a las 8"
    assert visto["banner"]["style"] == "pulse"
    assert visto["banner"]["set_at"] is not None
    assert visto["pinned"] is None

    async with sesiones() as db:
        fila = await db.get(LiveSpotlight, sesion_id)
    assert (fila.banner_text, fila.banner_style, fila.banner_by) == ("Sorteo a las 8", "pulse", ANA)


@pytest.mark.asyncio
async def test_sin_estilo_el_rotulo_entra_deslizandose(entorno):
    http, _sesiones, _identidad = entorno
    sesion_id = await _emision(http)
    assert (await _rotulo(http, sesion_id, "Hola")).json()["banner"]["style"] == "slide"
    assert destacado.ESTILO_POR_OMISION == "slide"


@pytest.mark.asyncio
async def test_el_rotulo_se_guarda_en_una_sola_linea_y_sin_invisibles(entorno):
    http, _sesiones, _identidad = entorno
    sesion_id = await _emision(http)

    sucio = "  Hoy:\n\n  taller\tde   pan ‮​ "
    assert (await _rotulo(http, sesion_id, sucio)).json()["banner"]["text"] == "Hoy: taller de pan"

    # Un emoji compuesto no se rompe: su unidor de ancho cero se conserva.
    familia = "\U0001f468‍\U0001f469‍\U0001f467"
    guardado = (await _rotulo(http, sesion_id, f"Para toda la familia {familia}")).json()
    assert guardado["banner"]["text"] == f"Para toda la familia {familia}"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "texto",
    ["", "   ", "\n\n\t", "​​", "‍‍‍", "́́"],
)
async def test_un_rotulo_que_no_dice_nada_no_se_admite(entorno, texto):
    http, sesiones, _identidad = entorno
    sesion_id = await _emision(http)
    assert (await _rotulo(http, sesion_id, texto)).status_code == 422
    async with sesiones() as db:
        assert await db.get(LiveSpotlight, sesion_id) is None


@pytest.mark.asyncio
async def test_el_tope_del_rotulo_se_mide_despues_de_limpiarlo(entorno):
    http, _sesiones, _identidad = entorno
    sesion_id = await _emision(http)

    justo = "a" * destacado.MAXIMO_DE_ROTULO
    assert (await _rotulo(http, sesion_id, justo)).status_code == 200
    assert (await _rotulo(http, sesion_id, justo + "a")).status_code == 422
    # Cabe: los espacios de sobra no cuentan, porque no se guardan.
    con_relleno = "   " + " ".join(["hola"] * 16) + "   \n\n"
    assert len(con_relleno) > destacado.MAXIMO_DE_ROTULO
    assert (await _rotulo(http, sesion_id, con_relleno)).status_code == 200


@pytest.mark.asyncio
async def test_un_estilo_que_no_existe_es_un_error_y_no_un_valor_por_omision(entorno):
    http, _sesiones, _identidad = entorno
    sesion_id = await _emision(http)
    assert (await _rotulo(http, sesion_id, "Hola", "explosion")).status_code == 422
    assert (await _ver(http, sesion_id))["banner"] is None


@pytest.mark.asyncio
async def test_cambiar_el_rotulo_cambia_su_fecha_y_quitarlo_lo_deja_a_nulo(entorno):
    http, sesiones, identidad = entorno
    sesion_id = await _emision(http)
    mensaje_id = await _escribir(http, identidad, sesion_id, BRUNO, "hola")
    assert (await _fijar(http, sesion_id, mensaje_id)).status_code == 200

    primero = (await _rotulo(http, sesion_id, "Uno")).json()["banner"]
    segundo = (await _rotulo(http, sesion_id, "Dos", "ticker")).json()["banner"]
    assert (segundo["text"], segundo["style"]) == ("Dos", "ticker")
    assert segundo["set_at"] >= primero["set_at"]

    quitado = await http.delete(_ruta(sesion_id, "/banner"))
    assert quitado.status_code == 200
    # Quitar el rótulo no se lleva el mensaje fijado: son dos cosas.
    assert quitado.json()["banner"] is None
    assert quitado.json()["pinned"]["id"] == mensaje_id
    async with sesiones() as db:
        fila = await db.get(LiveSpotlight, sesion_id)
    assert (fila.banner_text, fila.banner_by, fila.banner_at) == (None, None, None)


# --------------------------------------------------------------------------- #
# 4. Solo en directo, y con medida
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_en_una_emision_programada_no_se_destaca_nada(entorno):
    http, sesiones, _identidad = entorno
    sesion_id = await _emision(http, en_vivo=False)

    respuesta = await _rotulo(http, sesion_id, "Pronto")
    assert respuesta.status_code == 409
    assert respuesta.json()["error"]["code"] == "live_spotlight_closed"
    async with sesiones() as db:
        assert await db.get(LiveSpotlight, sesion_id) is None


@pytest.mark.asyncio
async def test_al_terminar_no_queda_nada_destacado_a_la_vista_y_se_puede_retirar(entorno):
    http, _sesiones, identidad = entorno
    sesion_id = await _emision(http)
    mensaje_id = await _escribir(http, identidad, sesion_id, BRUNO, "hola")
    assert (await _fijar(http, sesion_id, mensaje_id)).status_code == 200
    assert (await _rotulo(http, sesion_id, "Gracias por venir")).status_code == 200
    assert (await http.post(f"{LIVE}/sessions/{sesion_id}/end")).status_code == 200

    # Lo destacado no es un cartel que se quede colgado en la ficha.
    assert await _ver(http, sesion_id) == {
        "pinned": None, "banner": None, "can_manage": False, "banner_layout": False
    }
    # Ya no se puede destacar nada nuevo...
    cerrado = await _fijar(http, sesion_id, mensaje_id)
    assert cerrado.status_code == 409
    assert cerrado.json()["error"]["code"] == "live_spotlight_closed"
    assert (await _rotulo(http, sesion_id, "Otra cosa")).status_code == 409
    # ...pero retirar sigue pudiéndose.
    assert (await http.delete(_ruta(sesion_id, "/pin"))).status_code == 200
    assert (await http.delete(_ruta(sesion_id, "/banner"))).status_code == 200


@pytest.mark.asyncio
async def test_una_emision_que_no_existe_es_404_tambien_aqui(entorno):
    http, _sesiones, _identidad = entorno
    assert (await http.get(_ruta(NADIE))).status_code == 404
    assert (await _rotulo(http, NADIE, "Hola")).status_code == 404
    assert (await http.get(_ruta("no-es-un-id"))).status_code == 404


@pytest.mark.asyncio
async def test_cambiar_lo_destacado_sin_parar_se_corta_y_quitar_no(entorno):
    http, _sesiones, _identidad = entorno
    sesion_id = await _emision(http)

    for n in range(limites.DESTACADOS_POR_VENTANA):
        assert (await _rotulo(http, sesion_id, f"Texto {n}")).status_code == 200, n
    cortado = await _rotulo(http, sesion_id, "Uno más")
    assert cortado.status_code == 409
    assert cortado.json()["error"]["code"] == "live_spotlight_rate_limited"

    # Retirar tiene que poder hacerse siempre.
    assert (await http.delete(_ruta(sesion_id, "/banner"))).status_code == 200
    # Y el tope es por emisión: otra sala no lo hereda.
    otra = await _emision(http)
    assert (await _rotulo(http, otra, "Hola")).status_code == 200


@pytest.mark.asyncio
async def test_borrar_la_emision_se_lleva_lo_destacado(entorno):
    http, sesiones, identidad = entorno
    sesion_id = await _emision(http)
    mensaje_id = await _escribir(http, identidad, sesion_id, BRUNO, "hola")
    assert (await _fijar(http, sesion_id, mensaje_id)).status_code == 200

    tabla = LiveSpotlight.__table__
    assert {fk.column.table.name: fk.ondelete for fk in tabla.c.session_id.foreign_keys} == {
        "live_sessions": "CASCADE"
    }
    assert {fk.column.table.name: fk.ondelete for fk in tabla.c.pinned_message_id.foreign_keys} == {
        "live_messages": "SET NULL"
    }
    async with sesiones() as db:
        assert await db.get(LiveMessage, mensaje_id) is not None
        assert await db.get(LiveSession, sesion_id) is not None


# --------------------------------------------------------------------------- #
# 5. La limpieza del texto, sin pasar por la red
# --------------------------------------------------------------------------- #


def test_limpiar_el_rotulo_no_toca_lo_que_ya_estaba_limpio():
    for texto in ("Hola", "¡Sorteo a las 8!", "Ñandú 100 %", "日本語のテキスト", "مرحبا"):
        assert destacado.limpiar_rotulo(texto) == texto
        assert destacado.dice_algo(texto)


def test_limpiar_el_rotulo_quita_las_marcas_que_dan_la_vuelta_al_texto():
    # U+202E hace que lo que sigue se lea de derecha a izquierda: «Sorteo» se
    # vería «oetroS». No es un carácter que nadie teclee a propósito.
    assert destacado.limpiar_rotulo("‮Sorteo") == "Sorteo"
    assert destacado.limpiar_rotulo("a b c") == "a b c"
    assert destacado.limpiar_rotulo("a  b") == "a b"


# --------------------------------------------------------------------------- #
# 6. La migración 0099, leída
# --------------------------------------------------------------------------- #
#
# Aquí se comprueba, sobre su texto, que hace lo que su cabecera promete y nada
# más. Que PostgreSQL la acepte, y que se pueda volver a pegar, lo ejecuta
# GitHub (`test_migraciones_reales.py`), que es donde hay un PostgreSQL
# desechable.


def _sql_de_la_0099() -> str:
    texto = (
        Path(__file__).resolve().parents[3]
        / "supabase" / "migrations" / "0099_destacado_del_directo.sql"
    ).read_text(encoding="utf-8").replace("\r\n", "\n")
    return re.sub(r"--[^\n]*", "", texto)


def test_la_0099_crea_una_sola_tabla_y_no_toca_ninguna_que_ya_existiera():
    sql = _sql_de_la_0099().lower()
    assert re.findall(r"create table (?:if not exists )?([a-z_.]+)", sql) == ["public.live_spotlights"]
    assert set(re.findall(r"alter table ([a-z_.]+)", sql)) == {"public.live_spotlights"}
    for prohibido in (
        "drop table", "truncate", "delete from", "insert into", "update public.",
        "alter publication", "grant ", "revoke ", "create trigger", "create function",
    ):
        assert prohibido not in sql, prohibido


def test_la_0099_se_puede_pegar_dos_veces():
    sql = _sql_de_la_0099().lower()
    assert "create table if not exists public.live_spotlights" in sql
    assert sql.count("create index if not exists") == sql.count("create index") == 1
    for restriccion in ("live_spotlights_banner_text_check", "live_spotlights_banner_style_check"):
        quita = sql.index(f"drop constraint if exists {restriccion}")
        pone = sql.index(f"add constraint {restriccion}")
        assert quita < pone, restriccion


def test_la_0099_deja_la_tabla_cerrada_al_cliente():
    """RLS activada y NINGUNA política. Con una sola política de escritura,
    cualquiera pondría su texto sobre el directo de otra persona."""
    sql = _sql_de_la_0099().lower()
    assert "alter table public.live_spotlights enable row level security" in sql
    assert "create policy" not in sql
    assert "raise exception" in sql and "pg_policies" in sql and "relrowsecurity" in sql


def test_las_columnas_de_la_0099_y_las_del_modelo_son_las_mismas():
    """En los dos sentidos: ni el modelo se inventa una, ni ignora ninguna."""
    sql = _sql_de_la_0099().lower()
    cuerpo = sql[sql.index("create table if not exists public.live_spotlights (") :]
    cuerpo = cuerpo[cuerpo.index("(") + 1 : cuerpo.index(");")]
    del_sql = {
        linea.split()[0]
        for linea in (trozo.strip() for trozo in re.split(r",\s*\n", cuerpo))
        if linea
    }
    del_modelo = {columna.name for columna in LiveSpotlight.__table__.columns}
    assert del_sql == del_modelo == {
        "session_id", "pinned_message_id", "pinned_by", "pinned_at",
        "banner_text", "banner_style", "banner_by", "banner_at", "updated_at",
    }


def test_los_estilos_y_el_tope_del_codigo_son_los_de_la_base():
    sql = re.sub(r"\s+", " ", _sql_de_la_0099().lower())
    estilos = re.search(r"check \(banner_style in \(([^)]*)\)\)", sql)
    assert estilos is not None
    assert tuple(e.strip().strip("'") for e in estilos.group(1).split(",")) == destacado.ESTILOS
    assert f"char_length(banner_text) between 1 and {destacado.MAXIMO_DE_ROTULO}" in sql
    assert f"banner_style text not null default '{destacado.ESTILO_POR_OMISION}'" in sql


def test_la_0099_borra_en_cascada_con_la_emision_y_suelta_si_se_va_el_mensaje():
    sql = re.sub(r"\s+", " ", _sql_de_la_0099().lower())
    assert "session_id uuid primary key references public.live_sessions(id) on delete cascade" in sql
    assert "pinned_message_id uuid references public.live_messages(id) on delete set null" in sql
    assert "pinned_by uuid references public.profiles(id) on delete set null" in sql
    assert "banner_by uuid references public.profiles(id) on delete set null" in sql
