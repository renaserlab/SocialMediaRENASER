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
5. LA APP SOLO RECIBE UN SÍ O UN NO para esa persona, nunca la lista. Y otro
   sí o no, aparte, para la sección de administración: va por el rol.
6. CON TOKENS DE VERDAD: uno que viene y no vale (caducado, mal firmado,
   fabricado) es un 401, no un «no participas» ni un 500; contesta igual con
   Servicios apagado, y con la apertura general la puerta ya no lo mira.

No necesita PostgreSQL: la puerta de quién entra no consulta la base.
"""

from __future__ import annotations

import base64
import json
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone

import jwt
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
#: LAS INTERNAS NO SON DE NADIE DEL PILOTO: no las pide una persona, las pide
#: el planificador, y lo que las protege es su secreto
#: (`services/procesos_router.py`), no la lista. Van aparte, con su prueba.
RUTAS_INTERNAS = [(m, p) for m, p in _TODAS if "/internal/" in p]
RUTAS_DE_SERVICIOS = [(m, p) for m, p in _TODAS if "/admin/" not in p and "/internal/" not in p]
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
    app.dependency_overrides[acceso.quien_pregunta] = _opcional
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
    # El piloto es gratuito: ninguna ficha con importe.
    assert de_fabrica["services_catalog_price_models"] == "free,on_request"


def test_hay_rutas_que_proteger() -> None:
    assert len(RUTAS_DE_SERVICIOS) > 80 and len(RUTAS_DE_ADMINISTRACION) > 30
    assert all(p.startswith(f"{API}/services") for _, p in RUTAS_DE_SERVICIOS)
    assert all(p.startswith(f"{API}/admin/services") for _, p in RUTAS_DE_ADMINISTRACION)
    # Ninguna ruta de Servicios queda sin clasificar, y la interna es una sola.
    assert len(RUTAS_DE_SERVICIOS) + len(RUTAS_DE_ADMINISTRACION) + len(RUTAS_INTERNAS) == len(_TODAS)
    assert RUTAS_INTERNAS == [("POST", f"{API}/internal/services/tasks/run")]


@pytest.mark.asyncio
async def test_la_ruta_interna_no_se_abre_por_estar_en_el_piloto_ni_por_administrar(entorno, monkeypatch) -> None:
    """Ni la lista del piloto ni el rol de administración abren la ruta del
    planificador: sin su secreto no corre nada, sea quien sea quien la pida. Y
    con Servicios apagado contesta lo mismo que todo Servicios."""
    http, quien = entorno
    metodo, ruta = RUTAS_INTERNAS[0]
    _poner(monkeypatch, services_pilot_profile_ids=PILOTO)
    for visita in (PILOTO, FUERA, None, JEFA):
        assert _resultado(await _pedir(http, quien, visita, metodo, ruta)) == APAGADO, visita
    # Con todo encendido, sin secreto configurado y con él: LO MISMO. Nadie
    # averigua por esta ruta que hay un piloto en marcha, ni quien administra.
    _poner(monkeypatch, feature_services=True, feature_service_booking=True, services_public_access=True)
    for secreto in ("", "c0ffee" * 8):
        _poner(monkeypatch, services_tasks_token=secreto)
        for visita in (PILOTO, FUERA, None, JEFA):
            assert _resultado(await _pedir(http, quien, visita, metodo, ruta)) == APAGADO, (secreto != "", visita)
    assert not esquema._cache, "nadie llegó a mirar la base"


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
        # Las de los videos en S3 son un si o un no, como la de Servicios.
        assert set(r.json()) == {
            "publicacion_flexible",
            "feature_services",
            "feature_services_admin",
            "medios_s3_subida",
            "medios_s3_lectura",
        }
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


@pytest.mark.asyncio
async def test_la_app_ensena_la_seccion_de_administracion_por_el_rol_y_no_por_la_lista(entorno, monkeypatch) -> None:
    """Una administradora que NO está en el piloto tiene que ver su bandeja: si
    no, nadie puede revisar la primera postulación. Y un participante sin rol
    no ve nada de administración."""
    http, quien = entorno
    configuracion = f"{API}/platform/config"

    async def _ve(persona: str | None) -> tuple[bool, bool]:
        cuerpo = (await _pedir(http, quien, persona, "GET", configuracion)).json()
        return cuerpo["feature_services"], cuerpo["feature_services_admin"]

    _poner(monkeypatch, feature_services=True, services_pilot_profile_ids=PILOTO)
    assert await _ve(JEFA) == (False, True)
    assert await _ve(MODERADOR) == (False, True)
    assert await _ve(PILOTO) == (True, False)
    assert await _ve(FUERA) == (False, False)
    assert await _ve(None) == (False, False)
    # Con la apertura general sigue yendo por el rol.
    _poner(monkeypatch, services_public_access=True)
    assert await _ve(JEFA) == (True, True)
    assert await _ve(FUERA) == (True, False)
    # Y con Servicios apagado, ni administración.
    _poner(monkeypatch, feature_services=False)
    assert await _ve(JEFA) == (False, False)


@pytest.mark.asyncio
async def test_la_configuracion_solo_mira_la_base_con_servicios_encendido_y_con_sesion(entorno, monkeypatch) -> None:
    http, quien = entorno
    configuracion = f"{API}/platform/config"
    miradas: list[str] = []

    async def _funcion_de(db, perfil):  # noqa: ARG001
        miradas.append(perfil)
        return None

    monkeypatch.setattr(acceso.permissions, "funcion_de", _funcion_de)
    _poner(monkeypatch, feature_services=False, services_pilot_profile_ids=JEFA)
    assert (await _pedir(http, quien, JEFA, "GET", configuracion)).status_code == 200
    _poner(monkeypatch, feature_services=True)
    assert (await _pedir(http, quien, None, "GET", configuracion)).status_code == 200
    assert miradas == []
    assert (await _pedir(http, quien, JEFA, "GET", configuracion)).status_code == 200
    assert miradas == [JEFA]

    # Y si la base falla al mirar, la app sigue recibiendo su configuración.
    async def _rota(db, perfil):  # noqa: ARG001
        raise RuntimeError("la base no contesta")

    monkeypatch.setattr(acceso.permissions, "funcion_de", _rota)
    r = await _pedir(http, quien, JEFA, "GET", configuracion)
    assert r.status_code == 200 and r.json()["feature_services_admin"] is False
    assert r.json()["feature_services"] is True


# =========================================================================== #
# 6. Con tokens de verdad
# =========================================================================== #
SECRETO = "secreto-de-prueba-del-piloto-de-servicios-0123456789"


def _token(sub: str, *, expira_en: int = 3600, secreto: str = SECRETO) -> str:
    ahora = datetime.now(timezone.utc)
    return jwt.encode(
        {"sub": sub, "aud": "authenticated", "role": "authenticated", "email": "quien@ejemplo.com",
         "iat": ahora - timedelta(hours=3), "exp": ahora + timedelta(seconds=expira_en)},
        secreto, algorithm="HS256",
    )


@pytest_asyncio.fixture()
async def con_tokens(cerrado, monkeypatch):
    """La aplicación SIN sustituir quién pide: la identidad sale del token."""
    _poner(monkeypatch, supabase_jwt_secret=SECRETO, supabase_url="", supabase_jwt_issuer="")
    app = create_app()
    motor = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with motor.begin() as conexion:
        await conexion.run_sync(Base.metadata.create_all)
    sesiones = async_sessionmaker(motor, expire_on_commit=False)

    async def _db():
        async with sesiones() as db:
            yield db

    app.dependency_overrides[get_db] = _db
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http
    app.dependency_overrides.clear()
    await motor.dispose()


async def _con(http, token: str | None, ruta: str):
    cabeceras = {"Authorization": f"Bearer {token}"} if token is not None else {}
    return _resultado(await http.get(ruta, headers=cabeceras))


@pytest.mark.asyncio
async def test_un_token_que_viene_y_no_vale_es_un_401_y_no_un_no_participas(con_tokens, monkeypatch) -> None:
    """A un participante con la sesión caducada hay que decirle que la
    renueve. Si se le contestara «Servicios no está disponible», se quedaría
    fuera sin saber por qué hasta que la app refrescase el token."""
    http = con_tokens
    catalogo, privada = f"{API}/services/catalog", f"{API}/services/provider/application"
    _poner(monkeypatch, feature_services=True, services_pilot_profile_ids=PILOTO)
    malos = {
        "caducado": (_token(PILOTO, expira_en=-3600), "token_expired"),
        "de otra firma": (_token(PILOTO, secreto="otro-secreto-que-no-es-el-del-servidor-0123456789"), "invalid_token"),
        "basura": ("esto-no-es-un-token", "invalid_token"),
    }
    for nombre, (token, codigo) in malos.items():
        for ruta in (catalogo, privada):
            assert await _con(http, token, ruta) == (401, codigo), (nombre, ruta)
    # El que vale: el participante entra, y quien no participa recibe el 503.
    assert (await _con(http, _token(PILOTO), catalogo))[0] == 200
    assert await _con(http, _token(FUERA), catalogo) == APAGADO
    # Sin token es una visita sin sesión: durante el piloto, fuera.
    assert await _con(http, None, catalogo) == APAGADO


@pytest.mark.asyncio
async def test_un_token_que_no_vale_contesta_igual_con_servicios_apagado(con_tokens, monkeypatch) -> None:
    """Por eso no delata nada: mandar un token roto no dice si hay un piloto."""
    http = con_tokens
    catalogo = f"{API}/services/catalog"
    caducado = _token(PILOTO, expira_en=-3600)
    vistos = {}
    for estado, valores in (
        ("apagado", {"feature_services": False}),
        ("piloto", {"feature_services": True, "services_pilot_profile_ids": PILOTO}),
        ("piloto sin nadie", {"feature_services": True}),
    ):
        _poner(monkeypatch, **{"services_public_access": False, "services_pilot_profile_ids": "", **valores})
        vistos[estado] = await _con(http, caducado, catalogo)
    assert set(vistos.values()) == {(401, "token_expired")}, vistos
    # Y un token que VALE, con Servicios apagado, es el 503 de siempre.
    _poner(monkeypatch, feature_services=False, services_public_access=False, services_pilot_profile_ids=PILOTO)
    assert await _con(http, _token(PILOTO), catalogo) == APAGADO
    assert not esquema._cache


@pytest.mark.asyncio
async def test_la_configuracion_de_la_app_no_falla_con_un_token_caducado(con_tokens, monkeypatch) -> None:
    """`/platform/config` la lee cualquiera: con un token que no vale contesta
    como a una visita sin sesión (no entra), no con un error."""
    http = con_tokens
    _poner(monkeypatch, feature_services=True, services_pilot_profile_ids=PILOTO)
    configuracion = f"{API}/platform/config"
    r = await http.get(configuracion, headers={"Authorization": f"Bearer {_token(PILOTO, expira_en=-3600)}"})
    assert r.status_code == 200 and r.json()["feature_services"] is False
    r = await http.get(configuracion, headers={"Authorization": f"Bearer {_token(PILOTO)}"})
    assert r.status_code == 200 and r.json()["feature_services"] is True


@pytest.mark.asyncio
async def test_con_la_apertura_general_la_puerta_no_mira_el_token(con_tokens, monkeypatch) -> None:
    """Abierto a todos, la puerta no necesita saber quién pregunta. El catálogo
    público trata un token caducado como una visita sin sesión —como antes del
    piloto—, y una ruta privada sigue exigiendo su sesión."""
    http = con_tokens
    _poner(monkeypatch, feature_services=True, services_public_access=True)
    caducado = _token(PILOTO, expira_en=-3600)
    assert (await _con(http, caducado, f"{API}/services/catalog"))[0] == 200
    assert (await _con(http, "esto-no-es-un-token", f"{API}/services/catalog"))[0] == 200
    assert await _con(http, caducado, f"{API}/services/provider/application") == (401, "token_expired")
    assert (await _con(http, None, f"{API}/services/provider/application"))[0] == 401


def _fabricado(cabecera: dict) -> str:
    def _b64(dato: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(dato).encode()).rstrip(b"=").decode()

    # La firma tiene que ser base64 bien formado: si no, PyJWT rechaza el
    # token antes de mirar la cabecera y esta prueba no probaría nada.
    return f"{_b64(cabecera)}.{_b64({'sub': PILOTO})}.c2lnbg"


@pytest.mark.asyncio
@pytest.mark.parametrize("alg", [123, None, ["HS256"], {"a": 1}])
async def test_un_token_fabricado_con_un_algoritmo_que_no_es_texto_es_un_401_y_no_un_500(
    con_tokens, monkeypatch, alg,
) -> None:
    """PyJWT no comprueba el tipo de `alg`: llegaba a `alg.startswith` y
    rompía. En el piloto, apagado, y en una ruta que cualquiera puede leer."""
    http = con_tokens
    token = _fabricado({"alg": alg, "typ": "JWT"})
    for valores in ({"feature_services": False}, {"feature_services": True, "services_pilot_profile_ids": PILOTO}):
        _poner(monkeypatch, **{"services_public_access": False, "services_pilot_profile_ids": "", **valores})
        assert await _con(http, token, f"{API}/services/catalog") == (401, "invalid_token"), valores
        assert await _con(http, token, f"{API}/services/provider/application") == (401, "invalid_token"), valores
    r = await http.get(f"{API}/platform/config", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200 and r.json()["feature_services"] is False
