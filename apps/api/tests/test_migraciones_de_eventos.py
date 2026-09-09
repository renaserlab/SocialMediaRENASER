"""Lo que la 0060 sostiene y SQLite no reproduce.

Aquí no se prueba el código: se prueba LA BASE. Cada una de estas reglas la
puede romper una ruta futura, un script de mantenimiento o alguien con el
editor de Supabase abierto, y ninguna de ellas la impide un `if` de Python.

SQLite no tiene índices parciales con esta semántica, ni RLS, ni disparadores
escritos en PL/pgSQL, ni `smallint`. Sin PostgreSQL delante estas pruebas se
OMITEN, y omitida no es aprobada: la línea de CI las ejecuta.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[3]
MIGRACIONES = RAIZ / "supabase" / "migrations"
PROLOGO = RAIZ / "supabase" / "tests" / "prologo_local.sql"

URL = os.environ.get("MIGRACIONES_DATABASE_URL", "").strip()

SIN_POSTGRES = pytest.mark.skipif(
    not URL,
    reason=(
        "sin PostgreSQL desechable: define MIGRACIONES_DATABASE_URL "
        "(ver la cabecera de tests/test_migraciones_reales.py)"
    ),
)

TABLAS = (
    "event_operations",
    "event_versions",
    "event_admission_reviews",
    "event_admission_decisions",
    "event_documents",
)


@pytest.fixture(scope="module")
def conexion():
    psycopg = pytest.importorskip("psycopg")
    from tests.test_migraciones_reales import exigir_url_desechable

    exigir_url_desechable(URL, os.environ.get("DATABASE_URL", ""))
    with psycopg.connect(URL, autocommit=True) as cn:
        with cn.cursor() as cur:
            cur.execute("drop schema if exists public cascade")
            cur.execute("drop schema if exists auth cascade")
            cur.execute("drop schema if exists storage cascade")
            cur.execute("create schema public")
        yield cn


@pytest.fixture(scope="module")
def aplicadas(conexion):
    with conexion.cursor() as cur:
        cur.execute(PROLOGO.read_text(encoding="utf-8"))
    for ruta in sorted(MIGRACIONES.glob("*.sql")):
        with conexion.cursor() as cur:
            cur.execute(ruta.read_text(encoding="utf-8"))
    return True


def _ejecutar(conexion, sql: str, *args):
    with conexion.cursor() as cur:
        cur.execute(sql, args or None)


def _lista(conexion, sql: str, *args) -> list:
    with conexion.cursor() as cur:
        cur.execute(sql, args or None)
        return [f[0] for f in cur.fetchall()]


def _nuevo() -> str:
    return str(uuid.uuid4())


@pytest.fixture()
def evento(conexion, aplicadas):
    """Un organizador y un evento suyo, ya en el ciclo operativo."""
    organizador, ident = _nuevo(), _nuevo()
    _ejecutar(
        conexion,
        "insert into auth.users (id, email, raw_user_meta_data) values "
        "(%s, %s, jsonb_build_object('full_name', 'Org', 'username', %s::text))",
        organizador,
        f"org{organizador[:8]}@x.test",
        f"org{organizador[:8]}",
    )
    _ejecutar(
        conexion,
        "insert into public.events (id, organizer_id, title, description, status) "
        "values (%s, %s, 'Evento', 'x', 'draft')",
        ident,
        organizador,
    )
    _ejecutar(
        conexion,
        "insert into public.event_operations (event_id, workflow_status) "
        "values (%s, 'SUBMITTED')",
        ident,
    )
    return {"evento": ident, "organizador": organizador}


# --------------------------------------------------------------------------- #
# El ciclo
# --------------------------------------------------------------------------- #


@SIN_POSTGRES
def test_los_estados_derivados_no_caben_en_la_columna(conexion, evento) -> None:
    """`SOLD_OUT` se DERIVA del aforo. Guardado, miente en cuanto alguien cancela.

    Lo mismo con `IN_PROGRESS`, `COMPLETED_PENDING`, `MODIFIED` y `SETTLED`:
    escribir `SETTLED` seria afirmar que se transfirio un dinero que nadie movio.
    """
    import psycopg

    for derivado in ("SOLD_OUT", "IN_PROGRESS", "COMPLETED_PENDING", "MODIFIED", "SETTLED"):
        with pytest.raises(psycopg.errors.CheckViolation):
            _ejecutar(
                conexion,
                "update public.event_operations set workflow_status = %s where event_id = %s",
                derivado,
                evento["evento"],
            )


@SIN_POSTGRES
def test_los_siete_estados_guardables_si_caben(conexion, evento) -> None:
    for guardable in (
        "DRAFT", "SUBMITTED", "CONDITIONAL", "APPROVED",
        "PUBLISHED", "SUSPENDED", "CANCELLED",
    ):
        _ejecutar(
            conexion,
            "update public.event_operations set workflow_status = %s where event_id = %s",
            guardable,
            evento["evento"],
        )


@SIN_POSTGRES
def test_un_sello_inventado_no_cabe(conexion, evento) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _ejecutar(
            conexion,
            "update public.event_operations set selection_status = 'destacado' "
            "where event_id = %s",
            evento["evento"],
        )


@SIN_POSTGRES
def test_un_aforo_aprobado_negativo_tampoco(conexion, evento) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _ejecutar(
            conexion,
            "update public.event_operations set approved_capacity = -1 where event_id = %s",
            evento["evento"],
        )


# --------------------------------------------------------------------------- #
# Versiones
# --------------------------------------------------------------------------- #


def _version(conexion, evento: dict, numero: int, estado: str = "submitted") -> str:
    ident = _nuevo()
    _ejecutar(
        conexion,
        "insert into public.event_versions (id, event_id, version, status, snapshot) "
        "values (%s, %s, %s, %s, '{\"title\": \"Uno\"}'::jsonb)",
        ident,
        evento["evento"],
        numero,
        estado,
    )
    return ident


@SIN_POSTGRES
def test_solo_una_version_vigente_por_evento(conexion, evento) -> None:
    """El indice PARCIAL. Sin el, un evento tendria dos versiones «actuales» y
    nadie sabria cual se reviso."""
    import psycopg

    _version(conexion, evento, 1)
    with pytest.raises(psycopg.errors.UniqueViolation):
        _version(conexion, evento, 2)


@SIN_POSTGRES
def test_las_superadas_no_estorban(conexion, evento) -> None:
    """Y por eso el indice es parcial: el historial cabe entero."""
    _version(conexion, evento, 1, "superseded")
    _version(conexion, evento, 2, "superseded")
    _version(conexion, evento, 3, "submitted")
    assert (
        len(
            _lista(
                conexion,
                "select id from public.event_versions where event_id = %s",
                evento["evento"],
            )
        )
        == 3
    )


@SIN_POSTGRES
def test_dos_versiones_no_comparten_numero(conexion, evento) -> None:
    import psycopg

    _version(conexion, evento, 1, "superseded")
    with pytest.raises(psycopg.errors.UniqueViolation):
        _version(conexion, evento, 1, "superseded")


@SIN_POSTGRES
def test_una_version_no_se_reescribe(conexion, evento) -> None:
    """El disparador, EJERCIDO. Comprobar que existe no basta."""
    import psycopg

    ident = _version(conexion, evento, 1)
    with pytest.raises(psycopg.errors.RestrictViolation):
        _ejecutar(
            conexion,
            "update public.event_versions set snapshot = '{\"title\": \"Otro\"}'::jsonb "
            "where id = %s",
            ident,
        )
    with pytest.raises(psycopg.errors.RestrictViolation):
        _ejecutar(
            conexion,
            "update public.event_versions set version = 9 where id = %s",
            ident,
        )


@SIN_POSTGRES
def test_una_version_no_se_borra(conexion, evento) -> None:
    import psycopg

    ident = _version(conexion, evento, 1)
    with pytest.raises(psycopg.errors.RestrictViolation):
        _ejecutar(conexion, "delete from public.event_versions where id = %s", ident)


@SIN_POSTGRES
def test_una_version_si_puede_quedar_superada(conexion, evento) -> None:
    """Lo unico que puede cambiar: como una version deja paso a la siguiente."""
    ident = _version(conexion, evento, 1)
    _ejecutar(
        conexion,
        "update public.event_versions set status = 'superseded' where id = %s",
        ident,
    )


# --------------------------------------------------------------------------- #
# La evaluación
# --------------------------------------------------------------------------- #

#: 90 sobre 100, dentro de los ocho topes.
BUENOS = (18, 14, 14, 13, 13, 9, 5, 4)


def _evaluar(conexion, evento: dict, puntajes=BUENOS, total=None, **extra):
    _ejecutar(
        conexion,
        "insert into public.event_admission_reviews "
        "(id, event_id, version, propuesta, trayectoria, programa, recinto, "
        " seguridad, precio, accesibilidad, afinidad, total, evidence, "
        " critical_failure, critical_reason) "
        "values (%s, %s, 1, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        _nuevo(),
        evento["evento"],
        *puntajes,
        total if total is not None else sum(puntajes),
        extra.get("evidence", "Programa y recinto confirmados."),
        extra.get("critical_failure", False),
        extra.get("critical_reason", ""),
    )


@SIN_POSTGRES
def test_cada_criterio_tiene_su_tope(conexion, evento) -> None:
    """20, 15, 15, 15, 15, 10, 5 y 5. La base no admite un 30 sobre 20."""
    import psycopg

    topes = (20, 15, 15, 15, 15, 10, 5, 5)
    for i, tope in enumerate(topes):
        malos = list(BUENOS)
        malos[i] = tope + 1
        with pytest.raises(psycopg.errors.CheckViolation):
            _evaluar(conexion, evento, tuple(malos))


@SIN_POSTGRES
def test_un_puntaje_negativo_tampoco(conexion, evento) -> None:
    import psycopg

    malos = list(BUENOS)
    malos[0] = -1
    with pytest.raises(psycopg.errors.CheckViolation):
        _evaluar(conexion, evento, tuple(malos))


@SIN_POSTGRES
def test_el_total_tiene_que_cuadrar_con_sus_ocho_sumandos(conexion, evento) -> None:
    """Un total que no cuadra es la forma silenciosa de subir una nota."""
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _evaluar(conexion, evento, BUENOS, total=95)


@SIN_POSTGRES
def test_una_evaluacion_sin_evidencia_no_cabe(conexion, evento) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _evaluar(conexion, evento, evidence="   ")


@SIN_POSTGRES
def test_una_falla_critica_sin_motivo_no_cabe(conexion, evento) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _evaluar(conexion, evento, critical_failure=True)


@SIN_POSTGRES
def test_una_sola_evaluacion_por_evento_y_version(conexion, evento) -> None:
    import psycopg

    _evaluar(conexion, evento)
    with pytest.raises(psycopg.errors.UniqueViolation):
        _evaluar(conexion, evento)


# --------------------------------------------------------------------------- #
# La decisión
# --------------------------------------------------------------------------- #


def _decidir(conexion, evento: dict, decision: str, total, critica=False, motivo="Porque si"):
    _ejecutar(
        conexion,
        "insert into public.event_admission_decisions "
        "(id, event_id, version, decision, reason, total, critical_failure) "
        "values (%s, %s, 1, %s, %s, %s, %s)",
        _nuevo(),
        evento["evento"],
        decision,
        motivo,
        total,
        critica,
    )


@SIN_POSTGRES
def test_aprobar_por_debajo_de_85_no_cabe_en_la_base(conexion, evento) -> None:
    """La regla del blueprint, sostenida por la base y no por una ruta."""
    import psycopg

    for total in (0, 79, 80, 84):
        with pytest.raises(psycopg.errors.CheckViolation):
            _decidir(conexion, evento, "approved", total)


@SIN_POSTGRES
def test_aprobar_con_falla_critica_tampoco(conexion, evento) -> None:
    """98 puntos y sin plan de emergencias sigue siendo no."""
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _decidir(conexion, evento, "approved", 98, critica=True)


@SIN_POSTGRES
def test_aprobar_sin_puntaje_tampoco(conexion, evento) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _decidir(conexion, evento, "approved", None)


@SIN_POSTGRES
def test_condicional_solo_de_80_a_84(conexion, evento) -> None:
    import psycopg

    for fuera in (79, 85, 100):
        with pytest.raises(psycopg.errors.CheckViolation):
            _decidir(conexion, evento, "conditional", fuera)
    for dentro in (80, 82, 84):
        _decidir(conexion, evento, "conditional", dentro)


@SIN_POSTGRES
def test_aprobar_con_85_o_mas_si_cabe(conexion, evento) -> None:
    for total in (85, 90, 100):
        _decidir(conexion, evento, "approved", total)


@SIN_POSTGRES
def test_rechazar_no_depende_del_puntaje(conexion, evento) -> None:
    """Se puede rechazar un evento de 92: la decision es de quien administra."""
    _decidir(conexion, evento, "rejected", 92)
    _decidir(conexion, evento, "changes_requested", None)


@SIN_POSTGRES
def test_toda_decision_lleva_motivo(conexion, evento) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _decidir(conexion, evento, "rejected", None, motivo="   ")


@SIN_POSTGRES
def test_una_decision_inventada_no_cabe(conexion, evento) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _decidir(conexion, evento, "casi_aprobado", 90)


# --------------------------------------------------------------------------- #
# Documentos
# --------------------------------------------------------------------------- #


@SIN_POSTGRES
def test_un_requisito_por_tipo_y_evento(conexion, evento) -> None:
    import psycopg

    for _ in range(1):
        _ejecutar(
            conexion,
            "insert into public.event_documents (id, event_id, kind) values (%s, %s, 'seguro')",
            _nuevo(),
            evento["evento"],
        )
    with pytest.raises(psycopg.errors.UniqueViolation):
        _ejecutar(
            conexion,
            "insert into public.event_documents (id, event_id, kind) values (%s, %s, 'seguro')",
            _nuevo(),
            evento["evento"],
        )


@SIN_POSTGRES
def test_un_estado_de_documento_inventado_no_cabe(conexion, evento) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _ejecutar(
            conexion,
            "insert into public.event_documents (id, event_id, kind, status) "
            "values (%s, %s, 'permiso', 'casi')",
            _nuevo(),
            evento["evento"],
        )


# --------------------------------------------------------------------------- #
# RLS, concesiones y backfill
# --------------------------------------------------------------------------- #


@SIN_POSTGRES
def test_las_cinco_tablas_tienen_rls(conexion, aplicadas) -> None:
    sin_rls = [
        t
        for t in TABLAS
        if not _lista(
            conexion,
            "select c.relrowsecurity from pg_class c join pg_namespace n "
            "on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = %s",
            t,
        )[0]
    ]
    assert not sin_rls, sin_rls


@SIN_POSTGRES
def test_ninguna_se_sirve_por_postgrest(conexion, aplicadas) -> None:
    """Nacen cerradas: escribe la API, con identidad comprobada."""
    concedidas = _lista(
        conexion,
        "select table_name || ':' || grantee || ':' || privilege_type "
        "from information_schema.role_table_grants "
        "where table_schema = 'public' and grantee in ('anon', 'authenticated') "
        "  and table_name = any(%s)",
        list(TABLAS),
    )
    assert not concedidas, concedidas


@SIN_POSTGRES
def test_ninguna_politica_permite_escribir(conexion, aplicadas) -> None:
    escrituras = _lista(
        conexion,
        "select tablename || ':' || policyname || ':' || cmd from pg_policies "
        "where schemaname = 'public' and tablename = any(%s) and cmd <> 'SELECT'",
        list(TABLAS),
    )
    assert not escrituras, escrituras


@SIN_POSTGRES
def test_la_evaluacion_interna_no_tiene_ninguna_politica(conexion, aplicadas) -> None:
    """Una politica `for select` entrega la FILA ENTERA, y esa fila es la
    deliberacion de curaduria: los ocho puntajes y la evidencia. La ficha de
    revision la sirve la API, que elige que sale y para quien."""
    for cerrada in ("event_admission_reviews", "event_documents"):
        assert not _lista(
            conexion,
            "select policyname from pg_policies where schemaname = 'public' "
            "and tablename = %s",
            cerrada,
        ), cerrada


@SIN_POSTGRES
def test_el_ciclo_de_lo_publicado_si_se_puede_leer(conexion, aplicadas) -> None:
    """El sello Z se enseña: el ciclo de un evento publicado es publico."""
    assert _lista(
        conexion,
        "select policyname from pg_policies where schemaname = 'public' "
        "and tablename = 'event_operations'",
    )


@SIN_POSTGRES
def test_el_backfill_no_deja_ningun_evento_sin_ciclo(conexion, aplicadas) -> None:
    huerfanos = _lista(
        conexion,
        "select e.id::text from public.events e "
        "left join public.event_operations o on o.event_id = e.id "
        "where o.event_id is null",
    )
    assert not huerfanos, huerfanos


@SIN_POSTGRES
def test_ningun_evento_heredado_lleva_sello(conexion, aplicadas) -> None:
    """El backfill NO regala «Seleccionado por Z». Nadie aprobo nada."""
    con_sello = _lista(
        conexion,
        "select event_id::text from public.event_operations "
        "where origin = 'legacy' and selection_status <> 'none'",
    )
    assert not con_sello, con_sello


@SIN_POSTGRES
def test_borrar_un_evento_se_lleva_su_expediente(conexion, evento) -> None:
    """`on delete cascade` en las cinco: nada queda apuntando a un evento que
    ya no existe."""
    _version(conexion, evento, 1)
    _evaluar(conexion, evento)
    _decidir(conexion, evento, "approved", 90)
    _ejecutar(conexion, "delete from public.events where id = %s", evento["evento"])
    for tabla in TABLAS:
        assert not _lista(
            conexion,
            f"select event_id::text from public.{tabla} where event_id = %s",
            evento["evento"],
        ), tabla
