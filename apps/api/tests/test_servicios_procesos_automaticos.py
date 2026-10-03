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


@pytest.mark.asyncio
async def test_con_servicios_apagado_contesta_lo_mismo_que_todo_servicios(entorno, monkeypatch) -> None:
    """Las banderas mandan ANTES que el secreto y sin mirar la base: quien
    llega sin nada no aprende ni siquiera si hay un secreto configurado."""
    http, _, _, _ = entorno
    monkeypatch.setattr(get_settings(), "services_tasks_token", SECRETO)
    assert get_settings().feature_services is False
    for cabeceras in (_con(None), _con("otro"), _con(SECRETO)):
        r = await http.post(RUTA, headers=cabeceras)
        assert (r.status_code, _codigo(r)) == (503, "services_disabled"), r.text
    monkeypatch.setattr(get_settings(), "feature_services", True)
    esquema.olvidar()
    r = await http.post(RUTA, headers=_con(SECRETO))
    assert (r.status_code, _codigo(r)) == (503, "service_booking_disabled"), r.text
    assert not esquema._cache, "no se miró la base"
    esquema.olvidar()


@pytest.mark.asyncio
@pytest.mark.parametrize("configurado", ["", "   ", "corto", "x" * 31])
async def test_sin_secreto_o_con_uno_corto_falla_cerrada(entorno, contratacion, monkeypatch, configurado) -> None:
    """Sin configurar NO ACEPTA NADA: tampoco la cabecera vacía ni la que
    coincide con lo (poco) que haya escrito."""
    http, _, _, _ = entorno
    monkeypatch.setattr(get_settings(), "services_tasks_token", configurado)
    for cabeceras in (_con(None), _con(""), _con(configurado), _con(SECRETO)):
        r = await http.post(RUTA, headers=cabeceras)
        assert (r.status_code, _codigo(r)) == (503, "services_tasks_not_configured"), (configurado, cabeceras, r.text)
    assert not esquema._cache, "no se miró la base"


@pytest.mark.asyncio
async def test_sin_la_cabecera_buena_es_401_y_no_se_mira_la_base(entorno, contratacion, monkeypatch) -> None:
    http, _, _, _ = entorno
    monkeypatch.setattr(get_settings(), "services_tasks_token", SECRETO)
    malas = (
        _con(None),
        _con(""),
        _con("   "),
        _con(SECRETO[:-1]),
        _con(SECRETO + "0"),
        _con(SECRETO.upper()),
        _con(f"Bearer {SECRETO}"),
        # Una sesión de persona NO sirve: ni la de administración.
        {"Authorization": f"Bearer {SECRETO}"},
    )
    for cabeceras in malas:
        r = await http.post(RUTA, headers=cabeceras)
        assert (r.status_code, _codigo(r)) == (401, "services_tasks_unauthorized"), (cabeceras, r.text)
        assert SECRETO not in r.text
    # Un carácter no ASCII no puede ser un 500 (`compare_digest` con texto
    # lanzaría `TypeError`). Se manda en bytes, como llegaría por la red.
    r = await http.post(RUTA, headers=[(procesos.CABECERA.encode(), "contraseña".encode("latin-1"))])
    assert r.status_code == 401, r.text
    assert not esquema._cache, "no se miró la base"


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
