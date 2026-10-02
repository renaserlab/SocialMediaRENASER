"""El piloto de Z Servicios (política P101): quién entra, y quién no.

`FEATURE_SERVICES` dice si Servicios existe en el servidor;
`services/acceso.py` dice para quién. Aquí se prueba que:

1. DE FÁBRICA ESTÁ CERRADO: la bandera apagada, la apertura general apagada y
   la lista del piloto vacía. Y los pagos, apagados.
2. LA REGLA, sin base de datos: apagado no entra nadie; encendido solo entran
   los perfiles de la lista; la lista vacía o mal escrita no deja entrar a
   nadie; y la apertura general es una decisión que se escribe.
3. POR HTTP, EN TODAS LAS RUTAS de `/services`: quien no participa recibe lo
   mismo que con Servicios apagado (503 `services_disabled`), con sesión o sin
   ella, también en el catálogo público, y SIN MIRAR LA BASE.
4. ADMINISTRACIÓN ENTRA POR SU ROL, esté o no en la lista; y estar en la lista
   no da ningún rol.
5. LA APP SOLO RECIBE UN SÍ O UN NO para esa persona, nunca la lista.

No necesita PostgreSQL: la puerta de quién entra no consulta la base.
"""

from __future__ import annotations

import logging
import re
import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.config import Settings, get_settings
from app.core.exceptions import UnauthorizedError
from app.core.security import AuthUser, get_current_user, get_optional_user
from app.main import create_app
from app.modules.profiles.models import Profile
from app.modules.services import acceso, esquema
from app.shared.database import Base, get_db
from tests.test_servicios_admision_api import _rutas

API = "/api/v1"
APAGADO = (503, "services_disabled")

PILOTO = str(uuid.uuid4())
FUERA = str(uuid.uuid4())
JEFA = str(uuid.uuid4())
MODERADOR = str(uuid.uuid4())

#: Todas las rutas de Servicios, sacadas de la aplicación y no de una lista
#: escrita a mano: una ruta nueva entra sola en estas pruebas.
_TODAS = sorted({(m, p) for m, p in _rutas(create_app()) if "/services" in p})
RUTAS_DE_SERVICIOS = [(m, p) for m, p in _TODAS if "/admin/" not in p]
RUTAS_DE_ADMINISTRACION = [(m, p) for m, p in _TODAS if "/admin/" in p]


def _concreta(ruta: str) -> str:
    return re.sub(r"\{[^}]+\}", lambda _: str(uuid.uuid4()), ruta)


def _resultado(respuesta) -> tuple[int, str | None]:
    try:
        cuerpo = respuesta.json()
    except ValueError:
        return respuesta.status_code, None
    codigo = cuerpo.get("error", {}).get("code") if isinstance(cuerpo, dict) else None
    return respuesta.status_code, codigo


def _poner(monkeypatch, **valores) -> None:
    for nombre, valor in valores.items():
        monkeypatch.setattr(get_settings(), nombre, valor)


@pytest.fixture()
def cerrado(monkeypatch):
    """Como en producción: sin la apertura general que `conftest` pone a las
    demás pruebas. Cada prueba enciende lo que necesita."""
    _poner(monkeypatch, feature_services=False, services_public_access=False, services_pilot_profile_ids="")
    acceso._participantes.cache_clear()
    esquema.olvidar()
    yield
    acceso._participantes.cache_clear()
    esquema.olvidar()


@pytest_asyncio.fixture()
async def entorno(cerrado):
    """La aplicación de verdad sobre SQLite, con cuatro personas. `quien["uid"]`
    dice quién pide; `None` es una visita sin sesión."""
    app = create_app()
    motor = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with motor.begin() as conexion:
        await conexion.run_sync(Base.metadata.create_all)
    sesiones = async_sessionmaker(motor, expire_on_commit=False)
    async with sesiones() as db:
        for ident, nombre, rol in (
            (PILOTO, "Pili", "user"), (FUERA, "Fede", "user"), (JEFA, "Jefa", "admin"), (MODERADOR, "Mode", "moderator"),
        ):
            db.add(Profile(id=ident, full_name=nombre, username=nombre.lower(), role=rol))
        await db.commit()

    quien: dict[str, str | None] = {"uid": None}

    async def _db():
        async with sesiones() as db:
            yield db

    async def _opcional() -> AuthUser | None:
        return AuthUser(id=quien["uid"], email="x@y.test", role="authenticated") if quien["uid"] else None

    async def _obligatorio() -> AuthUser:
        usuario = await _opcional()
        if usuario is None:
            raise UnauthorizedError("Falta el header Authorization Bearer.")
        return usuario

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _obligatorio
    app.dependency_overrides[get_optional_user] = _opcional
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http, quien
    app.dependency_overrides.clear()
    await motor.dispose()


async def _pedir(http, quien, uid: str | None, metodo: str, ruta: str):
    quien["uid"] = uid
    return await http.request(metodo, _concreta(ruta), json={}, headers={"Idempotency-Key": f"k-{uuid.uuid4().hex}"})


# =========================================================================== #
# 1. De fábrica
# =========================================================================== #
def test_de_fabrica_servicios_esta_cerrado_y_no_cobra() -> None:
    """Los valores con los que arranca un servidor al que nadie le dijo nada."""
    de_fabrica = {nombre: campo.default for nombre, campo in Settings.model_fields.items()}
    assert de_fabrica["feature_services"] is False
    assert de_fabrica["services_public_access"] is False
    assert de_fabrica["services_pilot_profile_ids"] == ""
    assert de_fabrica["feature_service_booking"] is False
    assert de_fabrica["feature_service_payments"] is False
    assert de_fabrica["service_payments_provider"] == "none"
    # La primera versión (P5 y P2): sin «a domicilio» y solo en soles.
    assert de_fabrica["services_catalog_modalities"] == "virtual,in_person"
    assert de_fabrica["services_catalog_currencies"] == "PEN"


def test_hay_rutas_que_proteger() -> None:
    assert len(RUTAS_DE_SERVICIOS) > 80 and len(RUTAS_DE_ADMINISTRACION) > 30
    assert all(p.startswith(f"{API}/services") for _, p in RUTAS_DE_SERVICIOS)
    assert all(p.startswith(f"{API}/admin/services") for _, p in RUTAS_DE_ADMINISTRACION)


# =========================================================================== #
# 2. La regla
# =========================================================================== #
def test_apagado_no_entra_nadie_aunque_este_en_la_lista(cerrado, monkeypatch) -> None:
    _poner(monkeypatch, services_pilot_profile_ids=PILOTO, services_public_access=True)
    assert acceso.abierto_para(PILOTO) is False
    assert acceso.abierto_para(None) is False


def test_encendido_solo_entran_los_perfiles_de_la_lista(cerrado, monkeypatch) -> None:
    _poner(monkeypatch, feature_services=True, services_pilot_profile_ids=f"{PILOTO},{JEFA}")
    assert acceso.abierto_para(PILOTO) is True and acceso.abierto_para(JEFA) is True
    assert acceso.abierto_para(FUERA) is False
    # Sin sesión no hay perfil que buscar en la lista.
    assert acceso.abierto_para(None) is False and acceso.abierto_para("") is False
    # Un identificador que no es un UUID no entra ni rompe nada.
    assert acceso.abierto_para("no-es-un-uuid") is False


def test_la_lista_vacia_no_deja_entrar_a_nadie(cerrado, monkeypatch) -> None:
    """Desplegar con la bandera encendida y sin lista no abre Servicios."""
    for vacia in ("", "   ", ",", " , ,"):
        _poner(monkeypatch, feature_services=True, services_pilot_profile_ids=vacia)
        assert acceso.abierto_para(PILOTO) is False, repr(vacia)
        assert acceso.abierto_para(None) is False, repr(vacia)


def test_la_lista_se_normaliza(cerrado, monkeypatch) -> None:
    """Mayúsculas, espacios, llaves o sin guiones: es el mismo perfil."""
    escritas = f"  {PILOTO.upper()} ,{{{JEFA}}}, {FUERA.replace('-', '')}  ,"
    _poner(monkeypatch, feature_services=True, services_pilot_profile_ids=escritas)
    for perfil in (PILOTO, JEFA, FUERA):
        assert acceso.abierto_para(perfil) is True
        assert acceso.abierto_para(perfil.upper()) is True
    assert acceso.abierto_para(MODERADOR) is False


def test_una_lista_mal_escrita_cierra_el_piloto_entero_y_no_registra_los_perfiles(
    cerrado, monkeypatch, caplog
) -> None:
    """TODO O NADA: con una entrada que no es un UUID no entra nadie, tampoco
    los que sí están bien escritos. Se registra cuántas fallan, nunca cuáles."""
    mala = "no-es-un-uuid"
    _poner(monkeypatch, feature_services=True, services_pilot_profile_ids=f"{PILOTO},{mala},{JEFA},otra-mala")
    with caplog.at_level(logging.ERROR, logger="renaser.services"):
        assert acceso.abierto_para(PILOTO) is False
        assert acceso.abierto_para(JEFA) is False
        assert acceso.abierto_para(None) is False
    avisos = [r for r in caplog.records if "SERVICES_PILOT_PROFILE_IDS" in r.getMessage()]
    # Una vez por valor, no en cada petición.
    assert len(avisos) == 1 and avisos[0].levelno == logging.ERROR
    texto = avisos[0].getMessage()
    assert "2 entrada(s)" in texto
    for secreto in (PILOTO, JEFA, PILOTO[:8], mala, "otra-mala"):
        assert secreto not in texto, secreto
    # Corregida, vuelve a abrir.
    _poner(monkeypatch, services_pilot_profile_ids=PILOTO)
    assert acceso.abierto_para(PILOTO) is True


def test_la_apertura_general_es_explicita(cerrado, monkeypatch) -> None:
    _poner(monkeypatch, feature_services=True, services_public_access=True)
    assert acceso.abierto_para(FUERA) is True and acceso.abierto_para(None) is True
    # Y no se deduce de nada: sin escribirla, la lista vacía sigue cerrada.
    _poner(monkeypatch, services_public_access=False)
    assert acceso.abierto_para(FUERA) is False


# =========================================================================== #
# 3. Por HTTP, en todas las rutas
# =========================================================================== #
@pytest.mark.asyncio
async def test_con_la_bandera_apagada_ni_el_piloto_entra_y_no_se_mira_la_base(entorno, monkeypatch) -> None:
    http, quien = entorno
    _poner(monkeypatch, services_pilot_profile_ids=PILOTO)
    for metodo, ruta in RUTAS_DE_SERVICIOS:
        assert _resultado(await _pedir(http, quien, PILOTO, metodo, ruta)) == APAGADO, (metodo, ruta)
    assert not esquema._cache


@pytest.mark.asyncio
async def test_en_el_piloto_quien_no_participa_recibe_lo_mismo_que_apagado(entorno, monkeypatch) -> None:
    """TODAS las rutas de `/services`, también el catálogo público, la ficha,
    los horarios y el perfil de un prestador: con sesión y sin ella."""
    http, quien = entorno
    _poner(monkeypatch, feature_services=True, feature_service_booking=True, services_pilot_profile_ids=PILOTO)
    for metodo, ruta in RUTAS_DE_SERVICIOS:
        for visita in (FUERA, None, JEFA):
            assert _resultado(await _pedir(http, quien, visita, metodo, ruta)) == APAGADO, (visita, metodo, ruta)
    # NADIE MIRÓ LA BASE: a quien no entra no se le pregunta por el esquema.
    assert not esquema._cache


@pytest.mark.asyncio
async def test_en_el_piloto_quien_participa_pasa_la_puerta_en_todas_las_rutas(entorno, monkeypatch) -> None:
    http, quien = entorno
    _poner(monkeypatch, feature_services=True, feature_service_booking=True, services_pilot_profile_ids=PILOTO)
    for metodo, ruta in RUTAS_DE_SERVICIOS:
        estado, codigo = _resultado(await _pedir(http, quien, PILOTO, metodo, ruta))
        assert codigo != "services_disabled" and estado != 500, (metodo, ruta, estado, codigo)
    # El catálogo, que no pide nada más, contesta.
    assert (await _pedir(http, quien, PILOTO, "GET", f"{API}/services/catalog")).status_code == 200


@pytest.mark.asyncio
async def test_la_lista_vacia_o_mal_escrita_cierra_tambien_por_http(entorno, monkeypatch) -> None:
    http, quien = entorno
    for lista in ("", f"{PILOTO},no-es-un-uuid"):
        _poner(monkeypatch, feature_services=True, services_pilot_profile_ids=lista)
        for metodo, ruta in RUTAS_DE_SERVICIOS[::7]:
            assert _resultado(await _pedir(http, quien, PILOTO, metodo, ruta)) == APAGADO, (lista, metodo, ruta)


@pytest.mark.asyncio
async def test_con_la_apertura_general_entra_cualquiera_tambien_sin_sesion(entorno, monkeypatch) -> None:
    http, quien = entorno
    _poner(monkeypatch, feature_services=True, services_public_access=True)
    for visita in (FUERA, None):
        assert (await _pedir(http, quien, visita, "GET", f"{API}/services/catalog")).status_code == 200
    # Lo privado sigue pidiendo sesión: 401, no un 503.
    assert (await _pedir(http, quien, None, "GET", f"{API}/services/provider/application")).status_code == 401


@pytest.mark.asyncio
async def test_la_contratacion_exige_estar_en_el_piloto_y_su_propia_bandera(entorno, monkeypatch) -> None:
    http, quien = entorno
    reservas = f"{API}/services/me/bookings"
    _poner(monkeypatch, feature_services=True, feature_service_booking=True, services_pilot_profile_ids=PILOTO)
    assert _resultado(await _pedir(http, quien, FUERA, "GET", reservas)) == APAGADO
    assert _resultado(await _pedir(http, quien, PILOTO, "GET", reservas))[1] != "services_disabled"
    # Con la contratación apagada, el participante tampoco reserva.
    _poner(monkeypatch, feature_service_booking=False)
    esquema.olvidar()
    assert _resultado(await _pedir(http, quien, PILOTO, "GET", reservas)) == (503, "service_booking_disabled")
    assert _resultado(await _pedir(http, quien, FUERA, "GET", reservas)) == APAGADO


# =========================================================================== #
# 4. Administración
# =========================================================================== #
@pytest.mark.asyncio
async def test_administracion_entra_por_su_rol_aunque_no_este_en_el_piloto(entorno, monkeypatch) -> None:
    http, quien = entorno
    _poner(monkeypatch, feature_services=True, feature_service_booking=True, services_pilot_profile_ids=PILOTO)
    for metodo, ruta in RUTAS_DE_ADMINISTRACION:
        estado, codigo = _resultado(await _pedir(http, quien, JEFA, metodo, ruta))
        assert codigo != "services_disabled" and estado not in (403, 500), (metodo, ruta, estado, codigo)
    assert (await _pedir(http, quien, JEFA, "GET", f"{API}/admin/services/applications")).status_code == 200
    # Pero fuera de administración es una persona más: no está en la lista.
    assert _resultado(await _pedir(http, quien, JEFA, "GET", f"{API}/services/catalog")) == APAGADO


@pytest.mark.asyncio
async def test_estar_en_el_piloto_no_da_ningun_rol(entorno, monkeypatch) -> None:
    """Ni a quien participa ni a quien no: las rutas de administración siguen
    contestando 403 a quien no tiene el rol."""
    http, quien = entorno
    _poner(monkeypatch, feature_services=True, feature_service_booking=True, services_pilot_profile_ids=PILOTO)
    for metodo, ruta in RUTAS_DE_ADMINISTRACION:
        for persona in (PILOTO, FUERA):
            assert (await _pedir(http, quien, persona, metodo, ruta)).status_code == 403, (persona, metodo, ruta)


# =========================================================================== #
# 5. Lo que sabe la app
# =========================================================================== #
@pytest.mark.asyncio
async def test_la_app_recibe_un_si_o_un_no_para_esa_persona_y_nunca_la_lista(entorno, monkeypatch) -> None:
    http, quien = entorno
    configuracion = f"{API}/platform/config"
    _poner(monkeypatch, feature_services=True, services_pilot_profile_ids=f"{PILOTO},{MODERADOR}")
    vistos = {}
    for nombre, persona in (("piloto", PILOTO), ("fuera", FUERA), ("anonima", None), ("jefa", JEFA)):
        r = await _pedir(http, quien, persona, "GET", configuracion)
        assert r.status_code == 200
        assert set(r.json()) == {"publicacion_flexible", "feature_services"}
        for perfil in (PILOTO, MODERADOR):
            assert perfil not in r.text
        vistos[nombre] = r.json()["feature_services"]
    assert vistos == {"piloto": True, "fuera": False, "anonima": False, "jefa": False}
    # Con Servicios apagado, tampoco el piloto.
    _poner(monkeypatch, feature_services=False)
    assert (await _pedir(http, quien, PILOTO, "GET", configuracion)).json()["feature_services"] is False
    # Y con la apertura general, cualquiera.
    _poner(monkeypatch, feature_services=True, services_public_access=True)
    assert (await _pedir(http, quien, None, "GET", configuracion)).json()["feature_services"] is True
