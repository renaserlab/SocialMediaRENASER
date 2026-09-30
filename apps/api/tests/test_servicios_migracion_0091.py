"""La migración 0091: los servicios guardados (Incremento 3).

1. ESTÁTICA: sigue a la 0090 (y la sigue la 0092), es una sola transacción que
   comprueba lo anterior antes de crear nada, no concede permisos ni toca otra
   tabla, y no trae nada de dinero, reservas ni popularidad.
2. CONTRA POSTGRESQL: cerrada (RLS, cero políticas, cero privilegios), igual
   al modelo, sin duplicados y en cascada con la cuenta y con el servicio.
3. LA APLICACIÓN: sobre una base con la 0090 y datos no toca nada, se puede
   reejecutar, un fallo a mitad no deja nada y sin la 0090 se niega.
"""

from __future__ import annotations

import re

import pytest

from tests.test_migraciones_reales import MIGRACIONES
from tests.test_servicios_migracion_0090 import (
    SIN_POSTGRES,
    _foto,
    _hacer,
    _montar,
    _persona,
    _publicada,
    _todas,
    _uno,
    pg,  # noqa: F401 - el montaje de la base, compartido
)

ARCHIVO = MIGRACIONES / "0091_servicios_guardados.sql"
TEXTO = ARCHIVO.read_text(encoding="utf-8").replace("\r\n", "\n")
SQL = re.sub(r"--[^\n]*", "", TEXTO)


# =========================================================================== #
# 1. Estática
# =========================================================================== #
def test_sigue_a_la_0090_y_la_sigue_la_0092() -> None:
    nombres = sorted(p.name for p in MIGRACIONES.glob("*.sql"))
    posicion = nombres.index(ARCHIVO.name)
    assert nombres[posicion - 1].startswith("0090_")
    assert nombres[posicion + 1].startswith("0092_")


def test_es_una_unica_transaccion_que_comprueba_antes_de_crear() -> None:
    sentencias = [s.strip() for s in SQL.split(";") if s.strip()]
    assert sentencias[0] == "begin" and sentencias[-1] == "commit"
    assert len(re.findall(r"^\s*begin\s*;", SQL, flags=re.M)) == 1
    assert SQL.index("La 0091 requiere la 0086") < SQL.index("create table")


def test_no_concede_ni_toca_otra_tabla() -> None:
    codigo = SQL.lower()
    for prohibido in (
        r"\bgrant\b", r"drop\s+table", r"drop\s+column", r"delete\s+from", r"\bupdate\s+public\.",
        r"\btruncate\b", r"disable\s+row\s+level\s+security", r"security\s+definer", r"create\s+policy",
        r"create\s+extension",
    ):
        assert not re.search(prohibido, codigo), prohibido
    assert set(re.findall(r"alter\s+table\s+public\.([a-z_]+)", codigo)) == {"saved_services"}
    assert re.findall(r"create\s+table\s+if\s+not\s+exists\s+public\.([a-z_]+)", codigo) == ["saved_services"]


def test_no_trae_dinero_reservas_ni_popularidad() -> None:
    # Las comprobaciones del final cuentan filas del catálogo (`count(...)`):
    # eso no es un contador. Lo que no puede haber es una COLUMNA que lo sea.
    codigo = re.sub(r"count\([^)]*\)", "", SQL.lower())
    for palabra in ("stripe", "payment", "booking", "slot", "rating", "count", "popular", "score"):
        assert palabra not in codigo, palabra


# =========================================================================== #
# 2. Contra PostgreSQL
# =========================================================================== #
@SIN_POSTGRES
def test_desde_cero_queda_cerrada_e_igual_al_modelo(pg) -> None:  # noqa: F811
    _montar(pg)
    assert _uno(pg, "select relrowsecurity from pg_class where oid = 'public.saved_services'::regclass")
    assert _uno(pg, "select count(*) from pg_policies where tablename = 'saved_services'") == 0
    for rol in ("anon", "authenticated"):
        for privilegio in ("select", "insert", "update", "delete", "truncate", "references", "trigger"):
            assert not _uno(pg, "select has_table_privilege(%s, 'public.saved_services', %s)", rol, privilegio)
    # La clave es (perfil, servicio), y las dos ajenas van en cascada.
    assert _todas(
        pg,
        "select a.attname::text from pg_index i join pg_attribute a on a.attrelid = i.indrelid "
        "and a.attnum = any (i.indkey) where i.indexrelid = 'public.saved_services_pkey'::regclass "
        "and i.indisprimary order by a.attnum",
    ) == [("profile_id",), ("service_id",)]
    assert sorted(_todas(
        pg,
        "select confrelid::regclass::text, confdeltype::text from pg_constraint "
        "where conrelid = 'public.saved_services'::regclass and contype = 'f'",
    )) == [("profiles", "c"), ("services", "c")]

    from app.modules.services.descubrimiento_models import SavedService

    tabla = SavedService.__table__
    columnas = dict(_todas(
        pg,
        "select column_name, is_nullable from information_schema.columns "
        "where table_schema = 'public' and table_name = 'saved_services'",
    ))
    assert set(columnas) == {c.name for c in tabla.columns}
    assert all(v == "NO" for v in columnas.values())
    indices = {f[0] for f in _todas(
        pg, "select indexname from pg_indexes where tablename = 'saved_services' and indexname <> 'saved_services_pkey'"
    )}
    assert indices == {i.name for i in tabla.indexes}


@SIN_POSTGRES
def test_guardar_dos_veces_es_imposible_y_todo_cae_en_cascada(pg) -> None:  # noqa: F811
    import psycopg

    _montar(pg)
    admin = _persona(pg, "admin")
    perfil, prestador, servicio, _ = _publicada(pg, admin)
    quien = _persona(pg)
    _hacer(pg, "insert into public.saved_services (profile_id, service_id, title_at_save) values (%s, %s, 'Asesoría')", quien, servicio)
    with pytest.raises(psycopg.errors.UniqueViolation):
        _hacer(pg, "insert into public.saved_services (profile_id, service_id, title_at_save) values (%s, %s, 'Asesoría')", quien, servicio)
    # El título al guardar es lo único que enseña un guardado no disponible:
    # nunca falta, nunca es solo espacios y nunca pasa de 300.
    for titulo, error in (
        (None, psycopg.errors.NotNullViolation),
        ("   ", psycopg.errors.CheckViolation),
        ("x" * 301, psycopg.errors.CheckViolation),
    ):
        with pytest.raises(error):
            _hacer(pg, "insert into public.saved_services (profile_id, service_id, title_at_save) values (%s, %s, %s)",
                   _persona(pg), servicio, titulo)
    # La cuenta de quien guarda se va y su lista con ella.
    _hacer(pg, "delete from auth.users where id = %s", quien)
    assert _uno(pg, "select count(*) from public.saved_services where service_id = %s", servicio) == 0
    # La del prestador se lleva sus servicios y, con ellos, lo que los nombra.
    otra = _persona(pg)
    _hacer(pg, "insert into public.saved_services (profile_id, service_id, title_at_save) values (%s, %s, 'Asesoría')", otra, servicio)
    _hacer(pg, "delete from auth.users where id = %s", perfil)
    assert _uno(pg, "select count(*) from public.saved_services where profile_id = %s", otra) == 0


# =========================================================================== #
# 3. La aplicación
# =========================================================================== #
@SIN_POSTGRES
def test_sobre_la_0090_con_datos_no_toca_nada(pg) -> None:  # noqa: F811
    _montar(pg, hasta="0090")
    admin = _persona(pg, "admin")
    _publicada(pg, admin)
    tablas = ("profiles", "service_providers", "services", "service_versions", "service_events", "service_categories")
    antes = {
        t: _uno(pg, f"select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.{t} t")
        for t in tablas
    }
    _hacer(pg, TEXTO)
    assert antes == {
        t: _uno(pg, f"select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.{t} t")
        for t in tablas
    }
    assert _uno(pg, "select count(*) from public.saved_services") == 0


@SIN_POSTGRES
def test_reejecutarla_deja_exactamente_lo_mismo(pg) -> None:  # noqa: F811
    _montar(pg)
    antes = _foto(pg)
    _hacer(pg, TEXTO)
    assert _foto(pg) == antes


@SIN_POSTGRES
def test_un_fallo_a_mitad_no_deja_nada(pg) -> None:  # noqa: F811
    import psycopg

    _montar(pg, hasta="0090")
    corte = TEXTO.index("-- 3. Lo que tiene que quedar, o nada.")
    with pytest.raises(psycopg.Error):
        _hacer(pg, TEXTO[:corte] + "\nselect 1 / 0;\ncommit;\n")
    _hacer(pg, "rollback")
    assert _uno(pg, "select to_regclass('public.saved_services')") is None


@SIN_POSTGRES
def test_se_niega_a_terminar_sin_la_clave_o_sin_rls(pg) -> None:  # noqa: F811
    import psycopg

    for viciada, mensaje in (
        (TEXTO.replace("constraint saved_services_pkey primary key (profile_id, service_id)",
                       "constraint saved_services_pkey unique (profile_id, service_id)"), "la clave"),
        (TEXTO.replace("alter table public.saved_services enable row level security;", ""), "sin RLS"),
        (TEXTO.replace("references public.services(id) on delete cascade",
                       "references public.services(id) on delete restrict"), "cascada"),
    ):
        _montar(pg, hasta="0090")
        with pytest.raises(psycopg.Error) as error:
            _hacer(pg, viciada)
        assert mensaje in str(error.value)
        _hacer(pg, "rollback")
        assert _uno(pg, "select to_regclass('public.saved_services')") is None


@SIN_POSTGRES
def test_sin_la_0090_se_niega_y_no_crea_nada(pg) -> None:  # noqa: F811
    import psycopg

    _montar(pg, hasta="0089")
    with pytest.raises(psycopg.Error) as error:
        _hacer(pg, TEXTO)
    assert "requiere" in str(error.value)
    _hacer(pg, "rollback")
    assert _uno(pg, "select to_regclass('public.saved_services')") is None
