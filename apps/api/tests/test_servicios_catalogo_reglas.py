"""El catálogo de Servicios sin base: el mapa de estados y la completitud.

1. EL MAPA ES EL APROBADO, salto a salto, y ES EL MISMO que imponen los
   disparadores de la 0090 (se leen del `.sql`).
2. QUÉ FALTA PARA ENVIAR lo decide `catalogo_requisitos.faltantes`: gratis no
   es «sin configurar», un importe va con moneda configurada, la zona es
   obligatoria fuera de lo virtual, y sin portada no se envía.
"""

from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.core.config import get_settings
from app.modules.services import catalogo_estados as estados
from app.modules.services.catalogo_requisitos import CODIGOS, Reglas, faltantes
from app.modules.services.states import ADMINISTRACION, PRESTADOR, REVISOR, SISTEMA

MIGRACION = Path(__file__).resolve().parents[3] / "supabase" / "migrations" / "0090_servicios_catalogo_y_publicacion.sql"


# --------------------------------------------------------------------------- #
# 1. El mapa
# --------------------------------------------------------------------------- #
def test_el_mapa_de_la_version_es_el_aprobado() -> None:
    assert estados.TRANSICIONES_DE_LA_VERSION == {
        ("draft", "submitted"): {PRESTADOR},
        ("submitted", "under_review"): {REVISOR, ADMINISTRACION},
        ("under_review", "changes_requested"): {REVISOR, ADMINISTRACION},
        ("under_review", "approved"): {ADMINISTRACION},
        ("approved", "published"): {ADMINISTRACION},
        ("published", "superseded"): {SISTEMA},
        ("draft", "withdrawn"): {PRESTADOR, SISTEMA},
        ("submitted", "withdrawn"): {PRESTADOR, SISTEMA},
        ("under_review", "withdrawn"): {PRESTADOR, SISTEMA},
        ("approved", "withdrawn"): {PRESTADOR, SISTEMA},
    }


def test_el_mapa_del_servicio_es_el_aprobado() -> None:
    assert estados.TRANSICIONES_DEL_SERVICIO == {
        ("draft", "published"): {ADMINISTRACION},
        ("published", "suspended"): {ADMINISTRACION},
        ("suspended", "published"): {ADMINISTRACION},
        ("draft", "retired"): {ADMINISTRACION},
        ("published", "retired"): {ADMINISTRACION},
        ("suspended", "retired"): {ADMINISTRACION},
    }


def _saltos_del_disparador(funcion: str) -> set[tuple[str, str]]:
    sql = MIGRACION.read_text(encoding="utf-8")
    cuerpo = sql.split(f"create or replace function public.{funcion}()", 1)[1].split("$$;", 1)[0]
    return set(re.findall(r"\(old\.status = '(\w+)' and new\.status = '(\w+)'\)", cuerpo))


def test_la_base_impone_el_mismo_mapa_de_la_version() -> None:
    assert _saltos_del_disparador("service_versions_salto_valido") == set(estados.TRANSICIONES_DE_LA_VERSION)


def test_la_base_impone_el_mismo_mapa_del_servicio() -> None:
    assert _saltos_del_disparador("services_salto_valido") == set(estados.TRANSICIONES_DEL_SERVICIO)


def test_los_estados_son_los_del_check_de_la_base() -> None:
    sql = MIGRACION.read_text(encoding="utf-8")
    del_servicio = re.search(r"services_estado\s+check \(status in \(([^)]*)\)\)", sql).group(1)
    de_la_version = re.search(r"service_versions_estado\s+check \(status in \(([^)]*)\)\)", sql).group(1)
    assert set(re.findall(r"'(\w+)'", del_servicio)) == set(estados.ESTADOS_DEL_SERVICIO)
    assert set(re.findall(r"'(\w+)'", de_la_version)) == set(estados.ESTADOS_DE_LA_VERSION)


@pytest.mark.parametrize(
    ("desde", "hasta", "actor"),
    [
        ("draft", "published", PRESTADOR),  # nunca queda público un borrador
        ("submitted", "approved", ADMINISTRACION),  # aprobar sin revisión
        ("under_review", "approved", REVISOR),  # curaduría no aprueba
        ("approved", "published", REVISOR),  # ni publica
        ("approved", "published", PRESTADOR),  # ni se publica a sí mismo
        ("published", "draft", PRESTADOR),  # lo publicado no se edita
        ("changes_requested", "submitted", PRESTADOR),  # se corrige en otra versión
        ("withdrawn", "draft", PRESTADOR),
    ],
)
def test_saltos_que_no_existen_o_no_son_de_quien_los_pide(desde, hasta, actor) -> None:
    with pytest.raises((estados.SaltoInexistente, estados.SaltoNoPermitido)):
        estados.exigir_version(desde, hasta, actor)


def test_la_suspension_no_se_levanta_sin_administracion() -> None:
    with pytest.raises(estados.SaltoNoPermitido):
        estados.exigir_servicio("suspended", "published", REVISOR)
    with pytest.raises(estados.SaltoInexistente):
        estados.exigir_servicio("retired", "published", ADMINISTRACION)


# --------------------------------------------------------------------------- #
# 2. La completitud
# --------------------------------------------------------------------------- #
def _completa(**cambios):
    base = dict(
        title="Asesoría contable", summary="Revisamos tus cuentas del mes.",
        description="Una sesión para ordenar ingresos, gastos e impuestos del mes.",
        modality="virtual", duration_minutes=60, capacity=None, price_model="fixed",
        price_minor=12000, currency="PEN", scope="Personas naturales con negocio.",
        includes=["Revisión de facturas"], excludes=["Declaraciones anuales"],
        requirements="Traer tus facturas del mes.", conditions=None, location_area=None,
    )
    base.update(cambios)
    return SimpleNamespace(**base)


def _faltan(version=None, *, prestador="active", categoria="active", imagenes=None, reglas=None):
    return faltantes(
        servicio=SimpleNamespace(),
        version=version or _completa(),
        categoria=SimpleNamespace(status=categoria),
        prestador=SimpleNamespace(status=prestador),
        imagenes=[SimpleNamespace(is_cover=True)] if imagenes is None else imagenes,
        reglas=reglas,
    )


def test_una_version_completa_no_tiene_nada_pendiente() -> None:
    assert _faltan() == []


def test_sin_precio_configurado_no_es_gratis() -> None:
    assert "price_model" in _faltan(_completa(price_model=None, price_minor=None, currency=None))
    assert _faltan(_completa(price_model="free", price_minor=None, currency=None)) == []


def test_un_importe_va_con_su_moneda_y_la_moneda_configurada() -> None:
    assert "currency" in _faltan(_completa(currency=None))
    assert "price" in _faltan(_completa(price_minor=None))
    assert "currency_not_allowed" in _faltan(_completa(currency="USD"))


def test_el_precio_desde_y_el_no_publicado() -> None:
    assert _faltan(_completa(price_model="from")) == []
    assert _faltan(_completa(price_model="on_request", price_minor=None, currency=None)) == []


def test_fuera_de_lo_virtual_hace_falta_la_zona() -> None:
    assert "location_area" in _faltan(_completa(modality="in_person"))
    assert "location_area" in _faltan(_completa(modality="at_home"))
    assert _faltan(_completa(modality="in_person", location_area="Miraflores, Lima")) == []


def test_sin_portada_no_se_envia() -> None:
    assert "cover_image" in _faltan(imagenes=[])
    assert "cover_image" in _faltan(imagenes=[SimpleNamespace(is_cover=False)])


def test_prestador_y_categoria_activos() -> None:
    assert "provider_not_active" in _faltan(prestador="suspended")
    assert "category_inactive" in _faltan(categoria="inactive")


def test_incluidos_y_excluidos_obligatorios() -> None:
    falta = _faltan(_completa(includes=[], excludes=["  "]))
    assert "includes" in falta and "excludes" in falta


def test_la_configuracion_de_la_empresa_se_aplica(monkeypatch) -> None:
    ajustes = get_settings()
    monkeypatch.setattr(ajustes, "services_catalog_price_models", "free,fixed")
    monkeypatch.setattr(ajustes, "services_catalog_modalities", "virtual")
    monkeypatch.setattr(ajustes, "services_catalog_min_duration_minutes", 30)
    monkeypatch.setattr(ajustes, "services_catalog_max_duration_minutes", 120)
    reglas = Reglas.de()
    assert "price_model_not_allowed" in _faltan(_completa(price_model="from"), reglas=reglas)
    assert "modality_not_allowed" in _faltan(_completa(modality="at_home", location_area="X"), reglas=reglas)
    assert "duration_out_of_range" in _faltan(_completa(duration_minutes=15), reglas=reglas)
    assert "duration_out_of_range" in _faltan(_completa(duration_minutes=180), reglas=reglas)


def test_demasiadas_imagenes(monkeypatch) -> None:
    monkeypatch.setattr(get_settings(), "services_catalog_max_images", 2)
    imagenes = [SimpleNamespace(is_cover=True)] + [SimpleNamespace(is_cover=False)] * 2
    assert "too_many_images" in _faltan(imagenes=imagenes, reglas=Reglas.de())


def test_cada_codigo_que_sale_esta_en_la_lista_estable() -> None:
    todo_mal = _completa(
        title=" ", summary=None, description=None, modality=None, duration_minutes=None,
        price_model=None, price_minor=None, currency=None, scope=None, includes=[], excludes=[],
        requirements=None,
    )
    salida = _faltan(todo_mal, prestador="pending", categoria="inactive", imagenes=[])
    assert set(salida) <= set(CODIGOS)


# --------------------------------------------------------------------------- #
# 3. Ninguna entrada cambia un estado
# --------------------------------------------------------------------------- #
def test_ninguna_entrada_del_catalogo_admite_un_estado() -> None:
    from pydantic import ValidationError

    from app.modules.services import catalogo_schemas as esquemas

    for entrada in (esquemas.BorradorEditar, esquemas.CategoriaEditar, esquemas.ServicioCrear):
        assert "status" not in entrada.model_fields
        with pytest.raises(ValidationError):
            entrada.model_validate({"status": "published", "title": "Algo que cambiar"})
