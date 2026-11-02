"""El rótulo del directo se mueve, se gira y se viste (migración 0114).

Aprobado el 02/11/2026. Lo que se protege aquí:

  · que quien emite —o la administración— pueda guardar dónde está el texto,
    cuánto mide, cuánto gira y cómo se ve, y que quien mira NO pueda;
  · que los valores fuera de la paleta o del rango no lleguen a la base;
  · que moverlo no lo vuelva a presentar (su fecha es la de su TEXTO);
  · y, sobre todo, que SIN la 0114 nada de lo de antes deje de funcionar: la
    API y la migración no se despliegan en el mismo instante.

SQLite no tiene las columnas nuevas en el modelo (a propósito: ver
`destacado._presentaciones`), así que «con la 0114» se monta añadiéndolas a
mano, como haría la migración. Lo que solo PostgreSQL puede comprobar —los
CHECK, pegarla dos veces, la vuelta atrás— está en
`test_rotulo_editable_postgres.py`.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text, update

from app.main import app
from app.modules.live import destacado, limites
from app.modules.live.models import LiveSpotlight
from app.modules.profiles.models import Profile
from app.modules.recommendations import esquema
from tests.test_directo_destacado import _emision, _levantar, _rotulo, _ruta, _ver
from tests.test_directo_invitados import ANA, BRUNO, CARLA, LIVE, _recoger

#: Las columnas de la 0114, en SQLite. Mismos nombres y valores por omisión.
_COLUMNAS_0114 = (
    "banner_x REAL",
    "banner_y REAL",
    "banner_scale SMALLINT NOT NULL DEFAULT 100",
    "banner_rotation SMALLINT NOT NULL DEFAULT 0",
    "banner_color TEXT NOT NULL DEFAULT 'blanco'",
    "banner_background TEXT NOT NULL DEFAULT 'velo'",
    "banner_font TEXT NOT NULL DEFAULT 'clasica'",
)


async def _aplicar_0114(sesiones) -> None:
    async with sesiones() as db:
        for columna in _COLUMNAS_0114:
            await db.execute(text(f"ALTER TABLE live_spotlights ADD COLUMN {columna}"))
        await db.commit()
    esquema.olvidar()


@pytest_asyncio.fixture
async def con_0114():
    engine, sesiones, identidad, anteriores = await _levantar()
    await _aplicar_0114(sesiones)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad
    await _recoger(engine, anteriores)


@pytest_asyncio.fixture
async def sin_0114():
    engine, sesiones, identidad, anteriores = await _levantar()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, sesiones, identidad
    await _recoger(engine, anteriores)


def _layout(sesion_id: str) -> str:
    return _ruta(sesion_id, "/banner/layout")


async def _mover(http, sesion_id: str, **cuerpo):
    datos = {"x": 0.5, "y": 0.4, "scale": 100, "rotation": 0}
    datos.update(cuerpo)
    return await http.patch(_layout(sesion_id), json=datos)


async def _vestir(http, sesion_id: str, texto: str = "Hola", **cuerpo):
    return await http.put(_ruta(sesion_id, "/banner"), json={"text": texto, **cuerpo})


async def _admin(sesiones, uid: str) -> None:
    async with sesiones() as db:
        await db.execute(update(Profile).where(Profile.id == uid).values(role="admin"))
        await db.commit()


# --------------------------------------------------------------------------- #
# 1. Sin la 0114: todo como hasta hoy
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_sin_la_0114_el_rotulo_se_pone_y_se_pinta_como_siempre(sin_0114):
    http, _sesiones, identidad = sin_0114
    sesion_id = await _emision(http)

    # Una aplicación nueva manda la presentación; un servidor sin la 0114 la
    # ignora y pone el texto igual. Lo que no puede pasar es quedarse sin él.
    respuesta = await _vestir(
        http, sesion_id, "Sorteo", x=0.2, y=0.7, scale=180, rotation=30,
        color="oro", background="solido", font="fuerte",
    )
    assert respuesta.status_code == 200, respuesta.text

    identidad["uid"] = CARLA
    visto = await _ver(http, sesion_id)
    assert visto["banner_layout"] is False
    assert visto["banner"] == {
        "text": "Sorteo", "style": "slide", "set_at": visto["banner"]["set_at"],
        "x": None, "y": None, "scale": 100, "rotation": 0,
        "color": "blanco", "background": "velo", "font": "clasica",
    }


@pytest.mark.asyncio
async def test_sin_la_0114_moverlo_dice_que_no_esta_disponible(sin_0114):
    http, _sesiones, _identidad = sin_0114
    sesion_id = await _emision(http)
    assert (await _rotulo(http, sesion_id, "Hola")).status_code == 200

    respuesta = await _mover(http, sesion_id)
    assert respuesta.status_code == 503
    assert respuesta.json()["error"]["code"] == "live_spotlight_layout_not_available"
    # Quitarlo sigue funcionando, y no intenta tocar columnas que no existen.
    assert (await http.delete(_ruta(sesion_id, "/banner"))).status_code == 200
    assert (await _ver(http, sesion_id))["banner"] is None


@pytest.mark.asyncio
async def test_sin_la_0114_un_503_no_gasta_turnos_del_tope(sin_0114):
    http, _sesiones, _identidad = sin_0114
    sesion_id = await _emision(http)
    assert (await _rotulo(http, sesion_id, "Hola")).status_code == 200
    for _ in range(limites.DESTACADOS_POR_VENTANA + 5):
        assert (await _mover(http, sesion_id)).status_code == 503
    assert (await _rotulo(http, sesion_id, "Sigue")).status_code == 200


# --------------------------------------------------------------------------- #
# 2. Con la 0114: se guarda y se lee
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_un_rotulo_nuevo_sale_en_su_sitio_de_siempre(con_0114):
    http, _sesiones, _identidad = con_0114
    sesion_id = await _emision(http)
    assert (await _ver(http, sesion_id))["banner_layout"] is True

    visto = (await _rotulo(http, sesion_id, "Hola")).json()
    assert visto["banner_layout"] is True
    rotulo = visto["banner"]
    assert (rotulo["x"], rotulo["y"], rotulo["scale"], rotulo["rotation"]) == (None, None, 100, 0)
    assert (rotulo["color"], rotulo["background"], rotulo["font"]) == ("blanco", "velo", "clasica")


@pytest.mark.asyncio
async def test_quien_emite_lo_viste_y_quien_mira_lo_ve_igual(con_0114):
    http, _sesiones, identidad = con_0114
    sesion_id = await _emision(http)

    respuesta = await _vestir(
        http, sesion_id, "Sorteo a las 8", style="pulse",
        x=0.25, y=0.6, scale=150, rotation=-12,
        color="esmeralda", background="solido", font="maquina",
    )
    assert respuesta.status_code == 200, respuesta.text

    identidad["uid"] = CARLA
    visto = (await _ver(http, sesion_id))["banner"]
    assert visto["text"] == "Sorteo a las 8" and visto["style"] == "pulse"
    assert (visto["x"], visto["y"], visto["scale"], visto["rotation"]) == (0.25, 0.6, 150, -12)
    assert (visto["color"], visto["background"], visto["font"]) == ("esmeralda", "solido", "maquina")


@pytest.mark.asyncio
async def test_lo_que_no_viene_en_el_put_se_queda_como_estaba(con_0114):
    http, _sesiones, _identidad = con_0114
    sesion_id = await _emision(http)
    assert (await _vestir(http, sesion_id, "Uno", color="oro", x=0.3, y=0.4, scale=120)).status_code == 200

    # La aplicación de antes manda solo texto y estilo: no borra lo demás.
    visto = (await _rotulo(http, sesion_id, "Dos", "ticker")).json()["banner"]
    assert (visto["text"], visto["style"]) == ("Dos", "ticker")
    assert (visto["color"], visto["x"], visto["y"], visto["scale"]) == ("oro", 0.3, 0.4, 120)

    # Un nulo explícito vuelve a lo de por omisión; en la posición, al sitio de siempre.
    visto = (await _vestir(http, sesion_id, "Dos", style="ticker", color=None, x=None, y=None)).json()["banner"]
    assert (visto["color"], visto["x"], visto["y"], visto["scale"]) == ("blanco", None, None, 120)


@pytest.mark.asyncio
async def test_soltarlo_guarda_donde_quedo_y_no_lo_vuelve_a_presentar(con_0114):
    http, _sesiones, identidad = con_0114
    sesion_id = await _emision(http)
    puesto = (await _vestir(http, sesion_id, "Hola", color="rojo")).json()["banner"]

    movido = await _mover(http, sesion_id, x=0.123456, y=0.987654, scale=235, rotation=179)
    assert movido.status_code == 200, movido.text
    rotulo = movido.json()["banner"]
    # Cuatro decimales: más no se ve, y `real` devolvería ruido.
    assert (rotulo["x"], rotulo["y"], rotulo["scale"], rotulo["rotation"]) == (0.1235, 0.9877, 235, 179)
    # Moverlo no toca ni el texto, ni su aspecto, ni su FECHA: la sala no lo
    # ve entrar otra vez, lo ve deslizarse a su sitio.
    assert (rotulo["text"], rotulo["color"], rotulo["set_at"]) == ("Hola", "rojo", puesto["set_at"])

    identidad["uid"] = CARLA
    assert (await _ver(http, sesion_id))["banner"] == rotulo


@pytest.mark.asyncio
async def test_cambiar_el_color_no_lo_vuelve_a_presentar_y_otro_texto_si(con_0114):
    http, _sesiones, _identidad = con_0114
    sesion_id = await _emision(http)
    primero = (await _vestir(http, sesion_id, "Hola")).json()["banner"]
    mismo = (await _vestir(http, sesion_id, "Hola", color="azul", font="fuerte")).json()["banner"]
    assert mismo["set_at"] == primero["set_at"]
    assert (mismo["color"], mismo["font"]) == ("azul", "fuerte")

    otro_movimiento = (await _vestir(http, sesion_id, "Hola", style="pulse")).json()["banner"]
    assert otro_movimiento["set_at"] > primero["set_at"]
    otro_texto = (await _vestir(http, sesion_id, "Adiós", style="pulse")).json()["banner"]
    assert otro_texto["set_at"] > otro_movimiento["set_at"]


@pytest.mark.asyncio
async def test_quitarlo_devuelve_la_presentacion_a_la_de_siempre(con_0114):
    http, sesiones, _identidad = con_0114
    sesion_id = await _emision(http)
    await _vestir(http, sesion_id, "Hola", x=0.1, y=0.2, scale=200, rotation=45, color="rosa",
                  background="ninguno", font="maquina")
    assert (await http.delete(_ruta(sesion_id, "/banner"))).status_code == 200

    async with sesiones() as db:
        assert await destacado.leer_presentacion(db, sesion_id) == destacado.PRESENTACION_POR_OMISION
    # El siguiente texto empieza donde empezaron siempre.
    nuevo = (await _rotulo(http, sesion_id, "Otro")).json()["banner"]
    assert (nuevo["x"], nuevo["scale"], nuevo["rotation"], nuevo["color"]) == (None, 100, 0, "blanco")


@pytest.mark.asyncio
async def test_deshacer_es_volver_a_mandarlo_entero(con_0114):
    """«Texto quitado · Deshacer» no tiene ruta propia: la aplicación vuelve a
    poner lo que había, con su sitio y su aspecto."""
    http, _sesiones, _identidad = con_0114
    sesion_id = await _emision(http)
    antes = {"x": 0.4, "y": 0.3, "scale": 130, "rotation": 8, "color": "oro",
             "background": "solido", "font": "fuerte"}
    await _vestir(http, sesion_id, "Hola", style="pulse", **antes)
    assert (await http.delete(_ruta(sesion_id, "/banner"))).status_code == 200

    vuelto = (await _vestir(http, sesion_id, "Hola", style="pulse", **antes)).json()["banner"]
    assert {campo: vuelto[campo] for campo in antes} == antes


# --------------------------------------------------------------------------- #
# 3. Quién puede
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_quien_mira_no_puede_moverlo_ni_vestirlo(con_0114):
    http, sesiones, identidad = con_0114
    sesion_id = await _emision(http)
    await _vestir(http, sesion_id, "Hola", color="oro")

    identidad["uid"] = CARLA
    assert (await _mover(http, sesion_id, x=0.9, y=0.9)).status_code == 403
    assert (await _vestir(http, sesion_id, "Mío", color="rojo")).status_code == 403
    assert (await _ver(http, sesion_id))["can_manage"] is False

    async with sesiones() as db:
        assert (await destacado.leer_presentacion(db, sesion_id)).color == "oro"
        assert (await destacado.leer_presentacion(db, sesion_id)).x is None


@pytest.mark.asyncio
async def test_la_administracion_si_puede_moverlo(con_0114):
    http, sesiones, identidad = con_0114
    sesion_id = await _emision(http)
    await _rotulo(http, sesion_id, "Hola")
    await _admin(sesiones, BRUNO)

    identidad["uid"] = BRUNO
    assert (await _ver(http, sesion_id))["can_manage"] is True
    movido = await _mover(http, sesion_id, x=0.7, y=0.2, scale=90, rotation=-90)
    assert movido.status_code == 200, movido.text
    assert movido.json()["banner"]["x"] == 0.7
    assert (await _vestir(http, sesion_id, "Hola", color="negro")).json()["banner"]["color"] == "negro"


@pytest.mark.asyncio
async def test_sin_cuenta_se_ve_pero_no_se_toca(con_0114):
    http, _sesiones, identidad = con_0114
    sesion_id = await _emision(http)
    await _vestir(http, sesion_id, "Hola", x=0.5, y=0.5)

    from app.core.security import get_current_user, get_optional_user

    async def _nadie():
        return None

    async def _sin_sesion():
        from app.core.exceptions import UnauthorizedError

        raise UnauthorizedError("Sin sesión.")

    app.dependency_overrides[get_optional_user] = _nadie
    app.dependency_overrides[get_current_user] = _sin_sesion
    try:
        visto = await _ver(http, sesion_id)
        assert visto["banner"]["x"] == 0.5 and visto["can_manage"] is False
        assert (await _mover(http, sesion_id)).status_code == 401
    finally:
        identidad["uid"] = ANA


# --------------------------------------------------------------------------- #
# 4. Lo que no se admite
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "malo",
    [
        {"x": -0.01},
        {"x": 1.01},
        {"y": 2},
        {"scale": 65},
        {"scale": 245},
        {"scale": 101},
        {"rotation": 181},
        {"rotation": -181},
        {"rotation": 12.5},
        {"x": "mitad"},
    ],
)
async def test_soltar_fuera_de_rango_es_422_y_no_cambia_nada(con_0114, malo):
    http, sesiones, _identidad = con_0114
    sesion_id = await _emision(http)
    await _rotulo(http, sesion_id, "Hola")
    assert (await _mover(http, sesion_id, **malo)).status_code == 422
    async with sesiones() as db:
        assert await destacado.leer_presentacion(db, sesion_id) == destacado.PRESENTACION_POR_OMISION


@pytest.mark.asyncio
async def test_soltar_sin_alguno_de_los_cuatro_es_422(con_0114):
    http, _sesiones, _identidad = con_0114
    sesion_id = await _emision(http)
    await _rotulo(http, sesion_id, "Hola")
    for falta in ("x", "y", "scale", "rotation"):
        cuerpo = {"x": 0.5, "y": 0.5, "scale": 100, "rotation": 0}
        del cuerpo[falta]
        assert (await http.patch(_layout(sesion_id), json=cuerpo)).status_code == 422, falta
    assert (
        await http.patch(_layout(sesion_id), json={"x": None, "y": None, "scale": 100, "rotation": 0})
    ).status_code == 422


@pytest.mark.asyncio
async def test_nan_e_infinito_no_pasan_por_numeros():
    from pydantic import ValidationError

    from app.modules.live.schemas import LiveBannerLayout, LiveBannerWrite

    for valor in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(ValidationError):
            LiveBannerLayout(x=valor, y=0.5, scale=100, rotation=0)
        with pytest.raises(ValidationError):
            LiveBannerWrite(text="Hola", x=0.5, y=valor)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "malo",
    [
        {"color": "violeta"},
        {"color": "#FF0000"},
        {"background": "degradado"},
        {"font": "Comic Sans"},
        {"x": 0.5},
        {"y": 0.5},
        {"x": 0.5, "y": None},
        {"scale": 300},
        {"rotation": 200},
    ],
)
async def test_vestirlo_con_algo_que_no_existe_es_422_y_no_pone_nada(con_0114, malo):
    http, sesiones, _identidad = con_0114
    sesion_id = await _emision(http)
    assert (await _vestir(http, sesion_id, "Hola", **malo)).status_code == 422
    async with sesiones() as db:
        assert await db.get(LiveSpotlight, sesion_id) is None


@pytest.mark.asyncio
async def test_no_se_mueve_un_rotulo_que_no_hay(con_0114):
    http, _sesiones, _identidad = con_0114
    sesion_id = await _emision(http)
    sin_fila = await _mover(http, sesion_id)
    assert sin_fila.status_code == 409
    assert sin_fila.json()["error"]["code"] == "live_spotlight_no_banner"

    await _rotulo(http, sesion_id, "Hola")
    await http.delete(_ruta(sesion_id, "/banner"))
    quitado = await _mover(http, sesion_id)
    assert quitado.status_code == 409
    assert quitado.json()["error"]["code"] == "live_spotlight_no_banner"


@pytest.mark.asyncio
async def test_fuera_del_directo_no_se_mueve(con_0114):
    http, _sesiones, _identidad = con_0114
    sesion_id = await _emision(http)
    await _rotulo(http, sesion_id, "Hola")
    assert (await http.post(f"{LIVE}/sessions/{sesion_id}/end")).status_code == 200
    cerrado = await _mover(http, sesion_id)
    assert cerrado.status_code == 409
    assert cerrado.json()["error"]["code"] == "live_spotlight_closed"
    # Y la ficha de una emisión terminada no enseña nada, como siempre.
    visto = await _ver(http, sesion_id)
    assert visto["banner"] is None and visto["banner_layout"] is True


@pytest.mark.asyncio
async def test_soltar_sin_parar_cuenta_para_el_mismo_tope(con_0114):
    http, _sesiones, _identidad = con_0114
    sesion_id = await _emision(http)
    assert (await _rotulo(http, sesion_id, "Hola")).status_code == 200
    for n in range(limites.DESTACADOS_POR_VENTANA - 1):
        assert (await _mover(http, sesion_id, x=0.5, y=0.3 + n / 100)).status_code == 200, n
    cortado = await _mover(http, sesion_id)
    assert cortado.status_code == 409
    assert cortado.json()["error"]["code"] == "live_spotlight_rate_limited"
    # Quitar no se limita nunca.
    assert (await http.delete(_ruta(sesion_id, "/banner"))).status_code == 200


# --------------------------------------------------------------------------- #
# 5. La migración 0114, leída
# --------------------------------------------------------------------------- #


def _sql_de_la_0114() -> str:
    texto = (
        Path(__file__).resolve().parents[3]
        / "supabase" / "migrations" / "0114_rotulo_editable.sql"
    ).read_text(encoding="utf-8").replace("\r\n", "\n")
    return re.sub(r"--[^\n]*", "", texto)


def test_la_0114_solo_anade_columnas_a_live_spotlights():
    sql = _sql_de_la_0114().lower()
    assert set(re.findall(r"alter table ([a-z_.]+)", sql)) == {"public.live_spotlights"}
    for prohibido in (
        "create table", "drop table", "drop column", "truncate", "delete from",
        "insert into", "update public.", "create policy", "alter publication",
        "grant ", "revoke ", "create trigger", "create function",
    ):
        assert prohibido not in sql, prohibido


def test_la_0114_se_puede_pegar_dos_veces():
    sql = _sql_de_la_0114().lower()
    anadidas = re.findall(r"add column (if not exists )?(\w+)", sql)
    assert anadidas and all(guarda for guarda, _ in anadidas)
    assert sorted(c for _, c in anadidas) == sorted(esquema.COLUMNAS_DEL_ROTULO_EDITABLE)
    for restriccion in re.findall(r"add constraint (\w+)", sql):
        quita = sql.index(f"drop constraint if exists {restriccion}")
        assert quita < sql.index(f"add constraint {restriccion}"), restriccion


def test_la_paleta_los_fondos_las_letras_y_los_rangos_son_los_del_codigo():
    sql = re.sub(r"\s+", " ", _sql_de_la_0114().lower())

    def lista(columna: str) -> tuple[str, ...]:
        casa = re.search(rf"check \({columna} in \(([^)]*)\)\)", sql)
        assert casa, columna
        return tuple(e.strip().strip("'") for e in casa.group(1).split(","))

    assert lista("banner_color") == destacado.COLORES
    assert lista("banner_background") == destacado.FONDOS
    assert lista("banner_font") == destacado.LETRAS
    assert (
        f"banner_scale between {destacado.TAMANO_MINIMO} and {destacado.TAMANO_MAXIMO} "
        f"and banner_scale % {destacado.PASO_DE_TAMANO} = 0"
    ) in sql
    assert f"banner_rotation between -{destacado.GIRO_MAXIMO} and {destacado.GIRO_MAXIMO}" in sql
    omision = destacado.PRESENTACION_POR_OMISION
    assert f"banner_scale smallint not null default {omision.scale}" in sql
    assert f"banner_rotation smallint not null default {omision.rotation}" in sql
    assert f"banner_color text not null default '{omision.color}'" in sql
    assert f"banner_background text not null default '{omision.background}'" in sql
    assert f"banner_font text not null default '{omision.font}'" in sql
    assert "banner_x real," in sql and "banner_y real," in sql
    assert "check ((banner_x is null) = (banner_y is null))" in sql


def test_el_modelo_de_la_tabla_sigue_sin_las_columnas_nuevas():
    """Si alguien las añade a `LiveSpotlight`, leer lo destacado pediría
    columnas que una base sin la 0114 no tiene, y se caería todo."""
    del_modelo = {columna.name for columna in LiveSpotlight.__table__.columns}
    assert not del_modelo & set(esquema.COLUMNAS_DEL_ROTULO_EDITABLE)
    aparte = {columna.name for columna in destacado._presentaciones.columns}
    assert aparte == {"session_id", *esquema.COLUMNAS_DEL_ROTULO_EDITABLE}
    assert set(destacado.COLUMNA_DE.values()) == set(esquema.COLUMNAS_DEL_ROTULO_EDITABLE)
