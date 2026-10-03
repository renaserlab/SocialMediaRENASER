"""LOS PROCESOS AUTOMÁTICOS DE Z SERVICIOS — la puerta del planificador.

`POST /internal/services/tasks/run` es la única ruta de Servicios sin sesión de
persona. Aquí se vigila que sea ESTRECHA: que sin secreto no haga nada, que el
secreto se compare bien, que las banderas manden antes y que no se asome a la
base hasta que quien llama esté reconocido.

Lo que HACE con la base (vencer, recordar, cerrar) está en
`test_servicios_procesos_automaticos_postgres.py`, que necesita PostgreSQL.
"""

from __future__ import annotations

import inspect
import re
from pathlib import Path

import pytest

from app.core.config import Settings, get_settings
from app.main import create_app
from app.modules.services import esquema
from app.modules.services import procesos_router as procesos
from tests.test_servicios_admision_api import API, _codigo, _rutas, entorno  # noqa: F401 - montaje compartido

RUTA = f"{API}/internal/services/tasks/run"
SECRETO = "a3f1" * 16  # 64 caracteres: como el que genera el guion de despliegue.
RAIZ = Path(__file__).resolve().parents[3]


@pytest.fixture()
def contratacion(monkeypatch):
    """Servicios y la contratación encendidos, sin secreto todavía."""
    monkeypatch.setattr(get_settings(), "feature_services", True)
    monkeypatch.setattr(get_settings(), "feature_service_booking", True)
    esquema.olvidar()
    yield
    esquema.olvidar()


def _con(secreto: str | None) -> dict[str, str]:
    return {} if secreto is None else {procesos.CABECERA: secreto}


def test_el_secreto_nace_vacio_y_vacio_es_sin_configurar() -> None:
    assert Settings.model_fields["services_tasks_token"].default == ""
    assert procesos.LARGO_MINIMO_DEL_SECRETO == 32


def test_es_la_unica_ruta_interna_y_no_se_anuncia() -> None:
    app = create_app()
    internas = [(m, r) for m, r in _rutas(app) if "/internal/" in r]
    assert internas == [("POST", RUTA)]
    assert "/internal/" not in "".join(app.openapi()["paths"])


def test_no_recibe_nada_de_quien_llama() -> None:
    """Ni cuerpo, ni parámetros, ni identificadores: solo puede hacer lo que
    hacen los dos barridos con sus valores de fábrica."""
    firma = inspect.signature(procesos.correr)
    assert set(firma.parameters) == {"_preparado", "db"}
    fuente = inspect.getsource(procesos)
    assert "Query(" not in fuente and "Body(" not in fuente and "Request" not in fuente
    assert re.search(r"reserva\.vencer_retenciones\(db\)", fuente)
    assert re.search(r"atencion\.tareas\(db\)", fuente)


def test_el_secreto_se_compara_en_tiempo_constante_y_en_bytes() -> None:
    fuente = inspect.getsource(procesos.exigir_planificador)
    assert "hmac.compare_digest(candidato, esperado.encode(\"utf-8\"))" in fuente
    assert "==" not in fuente.replace("!=", "").split('"""', 2)[2], "nada de comparar el secreto con =="


def test_ni_el_secreto_ni_la_cabecera_se_escriben_en_los_logs() -> None:
    fuente = inspect.getsource(procesos.correr)
    linea = re.search(r"logger\.info\((.*?)\n    \)", fuente, re.S).group(1)
    assert "token" not in linea.lower() and "recibido" not in linea and "esperado" not in linea


APAGADO = (503, "services_disabled")

#: Todo lo que NO es el secreto bueno, llegue como llegue.
def _las_malas(configurado: str) -> list:
    return [
        _con(None),
        _con(""),
        _con("   "),
        _con("otro"),
        _con(SECRETO[:-1]),
        _con(SECRETO + "0"),
        _con(SECRETO.upper()),
        _con(f"Bearer {SECRETO}"),
        # Una sesión de persona NO sirve: ni la de administración.
        {"Authorization": f"Bearer {SECRETO}"},
        # Lo (poco) que haya escrito en la API tampoco, si no llega a ser un secreto.
        *([_con(configurado)] if configurado != SECRETO else []),
        # Un carácter no ASCII no puede ser un 500 (`compare_digest` con texto
        # lanzaría `TypeError`). En bytes, como llegaría por la red.
        [(procesos.CABECERA.encode(), "contraseña".encode("latin-1"))],
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("servicios", [False, True])
@pytest.mark.parametrize("reservar", [False, True])
@pytest.mark.parametrize("configurado", ["", "   ", "corto", "x" * 31, SECRETO])
async def test_a_quien_no_se_reconoce_se_le_contesta_como_apagado_pase_lo_que_pase(
    entorno, monkeypatch, servicios, reservar, configurado
) -> None:
    """LA REGLA DEL PILOTO (P101): nadie averigua desde fuera qué está
    encendido. Sin el secreto bueno, la respuesta es LA MISMA con Servicios
    apagado, con un piloto en marcha, con la contratación abierta, con secreto
    configurado y sin él. Y no se mira la base."""
    http, _, _, _ = entorno
    monkeypatch.setattr(get_settings(), "feature_services", servicios)
    monkeypatch.setattr(get_settings(), "feature_service_booking", reservar)
    monkeypatch.setattr(get_settings(), "services_tasks_token", configurado)
    esquema.olvidar()
    cuerpos = set()
    for cabeceras in _las_malas(configurado):
        r = await http.post(RUTA, headers=cabeceras)
        assert (r.status_code, _codigo(r)) == APAGADO, (servicios, reservar, configurado, cabeceras, r.text)
        assert SECRETO not in r.text
        cuerpos.add(r.json()["error"]["message"])
    assert len(cuerpos) == 1, "ni el mensaje distingue un caso de otro"
    assert not esquema._cache, "no se miró la base"
    esquema.olvidar()


@pytest.mark.asyncio
async def test_reconocido_el_planificador_las_banderas_le_dicen_lo_suyo(entorno, monkeypatch) -> None:
    """Con el secreto bueno sí se le dice qué pasa: apagado, o la contratación
    apagada. Sin mirar la base, y sin correr nada."""
    http, _, _, _ = entorno
    monkeypatch.setattr(get_settings(), "services_tasks_token", SECRETO)
    assert get_settings().feature_services is False
    r = await http.post(RUTA, headers=_con(SECRETO))
    assert (r.status_code, _codigo(r)) == APAGADO, r.text
    monkeypatch.setattr(get_settings(), "feature_services", True)
    esquema.olvidar()
    r = await http.post(RUTA, headers=_con(SECRETO))
    assert (r.status_code, _codigo(r)) == (503, "service_booking_disabled"), r.text
    assert not esquema._cache, "no se miró la base"
    esquema.olvidar()


@pytest.mark.asyncio
async def test_el_porque_de_un_rechazo_va_al_registro_y_sin_lo_que_llego(entorno, contratacion, monkeypatch, caplog) -> None:
    """Quien opera tiene que poder distinguir un planificador mal configurado
    de uno apagado: lo dice el registro, no la respuesta. Y el registro no
    guarda ni la cabecera que llegó ni el secreto."""
    http, _, _, _ = entorno
    intento = "valor-que-no-debe-salir-en-ningun-registro"
    with caplog.at_level("WARNING", logger="renaser.services"):
        monkeypatch.setattr(get_settings(), "services_tasks_token", "")
        await http.post(RUTA, headers=_con(intento))
        monkeypatch.setattr(get_settings(), "services_tasks_token", SECRETO)
        await http.post(RUTA, headers=_con(intento))
        # Sin cabecera no se anota nada: un escáner cualquiera no llena el registro.
        await http.post(RUTA)
    avisos = [r.getMessage() for r in caplog.records if "servicios.procesos" in r.getMessage()]
    assert len(avisos) == 2, avisos
    assert "sin secreto configurado" in avisos[0] and "no es el secreto" in avisos[1]
    for aviso in avisos:
        assert intento not in aviso and SECRETO not in aviso


@pytest.mark.asyncio
async def test_solo_post(entorno, contratacion, monkeypatch) -> None:
    http, _, _, _ = entorno
    monkeypatch.setattr(get_settings(), "services_tasks_token", SECRETO)
    for metodo in ("GET", "PUT", "PATCH", "DELETE"):
        r = await http.request(metodo, RUTA, headers=_con(SECRETO))
        assert r.status_code == 405, (metodo, r.text)


@pytest.mark.asyncio
async def test_con_el_secreto_bueno_corren_los_barridos_y_recien_ahi_se_mira_la_base(entorno, contratacion, monkeypatch) -> None:
    """Reconocido el planificador, pasa la puerta de esquema (que SÍ mira la
    base) y corren los dos barridos. Sin nada pendiente, todo en cero; y
    repetirlo no cambia nada. Con cuerpo o sin él: lo que llegue se ignora."""
    http, _, _, _ = entorno
    monkeypatch.setattr(get_settings(), "services_tasks_token", SECRETO)
    nada = {"expired": 0, "reminded": 0, "closed": 0, "unverified": 0, "skipped": 0}
    r = await http.post(RUTA, headers=_con(f"  {SECRETO}  "))
    assert r.status_code == 200 and r.json() == nada, r.text
    assert esquema._cache, "ahora sí se miró la base"
    # EventBridge manda `{}`; un cuerpo cualquiera tampoco cambia nada.
    for cuerpo in ({}, {"batch": 9999, "booking_id": "x"}):
        r = await http.post(RUTA, headers=_con(SECRETO), json=cuerpo)
        assert r.status_code == 200 and r.json() == nada, r.text
    r = await http.post(f"{RUTA}?batch=9999", headers=_con(SECRETO))
    assert r.status_code == 200 and r.json() == nada, r.text
    assert SECRETO not in r.text


def test_el_ejemplo_de_entorno_lo_documenta_vacio() -> None:
    ejemplo = (RAIZ / "apps" / "api" / ".env.example").read_text(encoding="utf-8")
    assert re.search(r"^SERVICES_TASKS_TOKEN=$", ejemplo, re.M), "vacío: copiar el ejemplo no abre la puerta"
    # Y el piloto gratuito, tal cual lo trae el código.
    modelos = re.search(r"^SERVICES_CATALOG_PRICE_MODELS=(.*)$", ejemplo, re.M).group(1)
    assert modelos == Settings.model_fields["services_catalog_price_models"].default == "free,on_request"
