"""Las reglas del descubrimiento de Servicios que no necesitan base de datos.

Qué filtro vale y cuál es un 422 con su campo; que sin moneda no hay rango ni
orden por precio; que gratis no es «sin precio»; el cursor opaco con su orden
dentro; y que las respuestas públicas no tienen sitio para nada privado ni
para una nota inventada.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.modules.services import descubrimiento as d
from app.modules.services.descubrimiento_schemas import (
    FichaPublicaRead,
    PerfilDePrestadorRead,
    ResenasRead,
    TarjetaDeServicioRead,
)
from app.modules.services.service import CursorInvalido


def test_sin_filtros_es_lo_mas_reciente() -> None:
    f = d.filtros()
    assert f.orden == "recent" and f.terminos == () and f.precio is None


def test_la_consulta_se_normaliza_y_ordena_por_relevancia() -> None:
    f = d.filtros(q="  Necesito   ORDENAR mis Impuestos ")
    assert f.q == "Necesito ORDENAR mis Impuestos"
    assert f.terminos == ("ordenar", "impuestos") and f.orden == "relevance"
    # Sin consulta, «relevancia» no mide nada: recientes.
    assert d.filtros(orden="relevance").orden == "recent"


@pytest.mark.parametrize("consulta", ["a", "  ", "y o", "!!"])
def test_una_consulta_sin_palabras_utiles_es_un_error_claro(consulta) -> None:
    if not consulta.strip():
        assert d.filtros(q=consulta).terminos == ()
        return
    with pytest.raises(d.ConsultaMuyCorta):
        d.filtros(q=consulta)


@pytest.mark.parametrize(
    ("kwargs", "error", "campo"),
    [
        ({"categoria": "no-es-un-id"}, d.FiltroInvalido, "category_id"),
        ({"modalidad": "hybrid"}, d.FiltroInvalido, "modality"),
        ({"precio": "cheap"}, d.FiltroInvalido, "price"),
        ({"moneda": "SOLES"}, d.FiltroInvalido, "currency"),
        ({"moneda": "S/1"}, d.FiltroInvalido, "currency"),
        ({"moneda": "PEN", "minimo": -1}, d.FiltroInvalido, "min_price"),
        ({"moneda": "PEN", "minimo": 500, "maximo": 100}, d.FiltroInvalido, "min_price"),
        ({"precio": "free", "moneda": "PEN"}, d.FiltroInvalido, "price"),
        ({"precio": "on_request", "maximo": 100, "moneda": "PEN"}, d.FiltroInvalido, "price"),
        ({"zona": "x" * 81}, d.FiltroInvalido, "area"),
        ({"orden": "popular"}, d.FiltroInvalido, "sort"),
        ({"orden": "best_rated"}, d.FiltroInvalido, "sort"),
    ],
)
def test_un_filtro_invalido_es_un_422_con_su_campo(kwargs, error, campo) -> None:
    with pytest.raises(error) as fallo:
        d.filtros(**kwargs)
    assert fallo.value.details == {"field": campo}


@pytest.mark.parametrize("kwargs", [{"minimo": 100}, {"maximo": 100}, {"orden": "price_asc"}, {"orden": "price_desc"}])
def test_sin_moneda_no_hay_rango_ni_orden_por_precio(kwargs) -> None:
    with pytest.raises(d.MonedaRequerida):
        d.filtros(**kwargs)


def test_la_moneda_implica_importe_y_no_se_convierte() -> None:
    f = d.filtros(moneda="pen", minimo=0, maximo=12000)
    assert f.moneda == "PEN" and f.precio == "priced" and (f.minimo, f.maximo) == (0, 12000)
    assert d.filtros(moneda="PEN", orden="price_desc").precio == "priced"
    # Una moneda que Z no admite (P2) no es un filtro sin resultados: no es un filtro.
    for ajena in ("USD", "eur"):
        with pytest.raises(d.FiltroInvalido) as error:
            d.filtros(moneda=ajena)
        assert error.value.details == {"field": "currency"}
    # Igual que una modalidad que no se ofrece (P5).
    with pytest.raises(d.FiltroInvalido) as error:
        d.filtros(modalidad="at_home")
    assert error.value.details == {"field": "modality"}
    assert d.filtros(modalidad="in_person").modalidad == "in_person"
    # Gratis y a consultar son precios distintos de «con importe».
    assert d.filtros(precio="free").precio == "free"
    assert d.filtros(precio="on_request").precio == "on_request"


def test_el_cursor_lleva_su_orden_y_se_valida() -> None:
    momento = datetime(2026, 9, 1, 10, tzinfo=timezone.utc)
    ident = "5b7e2f7a-8d1c-4a55-9d61-0c3f1e2a4b6c"
    for orden, claves in (
        ("recent", [momento.isoformat(), ident]),
        ("relevance", [12, momento.isoformat(), ident]),
        ("price_asc", [12000, ident]),
        ("price_desc", [0, ident]),
    ):
        leido = d.leer_cursor(d.cursor_de(orden, claves), orden)
        assert leido[-1] == ident
    # Con OTRO orden, o manipulado, no vale.
    reciente = d.cursor_de("recent", [momento.isoformat(), ident])
    for malo, orden in (
        (reciente, "price_asc"),
        ("basura", "recent"),
        (d.cursor_de("recent", [momento.isoformat(), "no-es-un-id"]), "recent"),
        (d.cursor_de("price_asc", ["12000", ident]), "price_asc"),
        (d.cursor_de("price_asc", [True, ident]), "price_asc"),
        (d.cursor_de("relevance", [1.5, momento.isoformat(), ident]), "relevance"),
    ):
        with pytest.raises(CursorInvalido):
            d.leer_cursor(malo, orden)


def test_un_cursor_con_numeros_enormes_es_invalido_y_no_un_404() -> None:
    ident = "5b7e2f7a-8d1c-4a55-9d61-0c3f1e2a4b6c"
    momento = "2026-09-01T10:00:00+00:00"
    for orden, claves in (
        ("price_asc", [10**30, ident]),
        ("price_desc", [-1, ident]),
        ("relevance", [2**40, momento, ident]),
        ("relevance", [-5, momento, ident]),
    ):
        with pytest.raises(CursorInvalido):
            d.leer_cursor(d.cursor_de(orden, claves), orden)
    assert d.leer_cursor(d.cursor_de("price_asc", [d.IMPORTE_MAXIMO, ident]), "price_asc")[0] == d.IMPORTE_MAXIMO


def test_el_guion_bajo_separa_y_las_tildes_se_pliegan_del_todo() -> None:
    assert d.filtros(q="contabilidad__pymes").terminos == ("contabilidad", "pymes")
    assert d.filtros(q="Diseño GRÁFICO").terminos == ("diseno", "grafico")
    assert d.filtros(q="Café Perú").terminos == ("cafe", "peru")
    for consulta in ("____", "a_b", "_ _"):
        with pytest.raises(d.ConsultaMuyCorta):
            d.filtros(q=consulta)
    with pytest.raises(d.FiltroInvalido):
        d.filtros(zona="__")


def test_los_pesos_son_dominantes() -> None:
    """Cada nivel pesa más que TODO el de abajo junto: título > categoría y
    resumen > descripción, prestador, zona y modalidad."""
    inferiores = d.PESO_DESCRIPCION + d.PESO_PRESTADOR + d.PESO_ZONA + d.PESO_MODALIDAD
    assert min(d.PESO_CATEGORIA, d.PESO_RESUMEN) > inferiores
    assert d.PESO_TITULO > d.PESO_CATEGORIA + d.PESO_RESUMEN + inferiores


def test_las_respuestas_publicas_no_tienen_sitio_para_lo_privado() -> None:
    prohibidas = {
        "storage_path", "internal_note", "visible_note", "legal_name", "tax_id", "profile_id", "status",
        "number_masked", "evidence_document_id", "review_note", "decided_by", "reviewed_by", "published_by",
        "created_by", "rating", "stars", "popularity", "saves_count", "bookings",
    }

    def campos(modelo) -> set[str]:
        salida = set(modelo.model_fields)
        for campo in modelo.model_fields.values():
            anotacion = campo.annotation
            for candidato in getattr(anotacion, "__args__", ()) + (anotacion,):
                if isinstance(candidato, type) and hasattr(candidato, "model_fields"):
                    salida |= campos(candidato)
        return salida

    for modelo in (TarjetaDeServicioRead, FichaPublicaRead, PerfilDePrestadorRead):
        assert not campos(modelo) & prohibidas, (modelo.__name__, campos(modelo) & prohibidas)


def test_sin_resenas_la_media_es_nula_y_no_cero() -> None:
    assert ResenasRead().model_dump() == {"count": 0, "average": None}


def test_los_motivos_son_codigos_estables() -> None:
    assert d.MOTIVOS == (
        "matches_search", "similar_to_saved", "recently_published", "same_provider", "same_category",
    )
