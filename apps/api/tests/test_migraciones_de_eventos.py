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
def test_ninguna_de_las_cinco_tiene_politica(conexion, aplicadas) -> None:
    """Una politica `for select` entrega LA FILA ENTERA, no las columnas que
    uno tenia en mente.

    La de la evaluacion nunca existio: esa fila es la deliberacion de
    curaduria. Las otras dos —decisiones y ciclo— se quitaron: la primera lleva
    `total` y `decided_by`, que es justo lo que la API omite al devolver una
    observacion; la segunda lleva `approved_capacity`, las fechas internas y
    `origin`, que dice que eventos publicados nunca pasaron por admision.

    Hoy los `revoke` las hacen inalcanzables. Pero una politica escrita es una
    decision escrita, y el dia que alguien conceda un `grant select` «para leer
    solo el sello» se lleva el resto sin enterarse.
    """
    con_politica = [
        t
        for t in TABLAS
        if _lista(
            conexion,
            "select policyname from pg_policies where schemaname = 'public' "
            "and tablename = %s",
            t,
        )
    ]
    assert not con_politica, con_politica


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


# --------------------------------------------------------------------------- #
# Entradas e inventario (0061)
# --------------------------------------------------------------------------- #

TABLAS_DE_ENTRADAS = (
    "event_ticketing_settings",
    "event_ticket_types",
    "event_ticket_holds",
    "event_ticket_hold_items",
)


@pytest.fixture()
def con_entradas(conexion, evento):
    """El evento de arriba, configurado para vender, con un tipo a la venta."""
    _ejecutar(
        conexion,
        "insert into public.event_ticketing_settings "
        "(event_id, access_mode, currency) values (%s, 'TICKETED', 'PEN')",
        evento["evento"],
    )
    tipo = _nuevo()
    _ejecutar(
        conexion,
        "insert into public.event_ticket_types "
        "(id, event_id, name, price_minor, currency, quota, status) "
        "values (%s, %s, 'General', 4900, 'PEN', 10, 'on_sale')",
        tipo,
        evento["evento"],
    )
    return {**evento, "tipo": tipo}


def _hold(
    conexion,
    datos,
    subtotal=4900,
    estado="ACTIVE",
    clave=None,
    minutos=10,
    con_linea=True,
):
    """Una reserva ENTERA: cabecera y su linea.

    Antes creaba la cabecera sola, y eso ya no es una reserva valida: el
    disparador de la 0061 exige al menos una linea. Quien monte sus propias
    lineas dentro de su propia transaccion pasa `con_linea=False`.
    """
    ident = _nuevo()

    def _cabecera():
        _ejecutar(
            conexion,
            "insert into public.event_ticket_holds "
            "(id, event_id, user_id, idempotency_key, request_fingerprint, status, "
            " currency, subtotal_minor, expires_at) "
            "values (%s, %s, %s, %s, 'huella', %s, 'PEN', %s, "
            f"       now() + interval '{int(minutos)} minutes')",
            ident,
            datos["evento"],
            datos["organizador"],
            clave or ident,
            estado,
            subtotal,
        )

    if not con_linea:
        _cabecera()
        return ident

    # LAS DOS EN LA MISMA TRANSACCION. Con `autocommit`, la cabecera sola se
    # confirmaria antes de que existiera la linea y el disparador diferido —que
    # se comprueba justo al confirmar— la rechazaria con razon.
    with conexion.transaction():
        _cabecera()
        _linea(conexion, datos, ident, cantidad=1, precio=subtotal)
    return ident


def _linea(conexion, datos, hold, cantidad=1, precio=4900, tipo=None):
    _ejecutar(
        conexion,
        "insert into public.event_ticket_hold_items "
        "(id, hold_id, event_id, ticket_type_id, quantity, unit_price_minor, "
        " subtotal_minor, ticket_type_name_snapshot) "
        "values (%s, %s, %s, %s, %s, %s, %s, 'General')",
        _nuevo(),
        hold,
        datos["evento"],
        tipo or datos["tipo"],
        cantidad,
        precio,
        cantidad * precio,
    )


@SIN_POSTGRES
def test_una_sola_moneda_por_evento(conexion, con_entradas) -> None:
    """La clave ajena COMPUESTA `(event_id, currency)`.

    Un tipo en dolares dentro de un evento en soles no entra: para meterlo
    habria que cambiar la moneda del evento entero, que es justo la decision que
    se quiere que sea explicita.
    """
    import psycopg

    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        _ejecutar(
            conexion,
            "insert into public.event_ticket_types "
            "(id, event_id, name, price_minor, currency, quota) "
            "values (%s, %s, 'En dolares', 100, 'USD', 5)",
            _nuevo(),
            con_entradas["evento"],
        )


@SIN_POSTGRES
def test_un_tipo_de_otro_evento_no_entra_en_una_reserva(conexion, con_entradas) -> None:
    """La otra clave ajena compuesta: la linea, su reserva y su tipo hablan del
    mismo evento. Es la misma forma que usa `quiz_answers` en la 0058."""
    import psycopg

    otro = _nuevo()
    _ejecutar(
        conexion,
        "insert into auth.users (id, email, raw_user_meta_data) values "
        "(%s, %s, jsonb_build_object('full_name', 'B', 'username', %s::text))",
        otro,
        f"b{otro[:8]}@x.test",
        f"b{otro[:8]}",
    )
    evento2 = _nuevo()
    _ejecutar(
        conexion,
        "insert into public.events (id, organizer_id, title, description, status) "
        "values (%s, %s, 'Otro', 'x', 'draft')",
        evento2,
        otro,
    )
    _ejecutar(
        conexion,
        "insert into public.event_ticketing_settings (event_id, access_mode, currency) "
        "values (%s, 'TICKETED', 'PEN')",
        evento2,
    )
    tipo_ajeno = _nuevo()
    _ejecutar(
        conexion,
        "insert into public.event_ticket_types "
        "(id, event_id, name, price_minor, currency, quota, status) "
        "values (%s, %s, 'Ajeno', 100, 'PEN', 5, 'on_sale')",
        tipo_ajeno,
        evento2,
    )

    hold = _hold(conexion, con_entradas)
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        _linea(conexion, con_entradas, hold, tipo=tipo_ajeno)


@SIN_POSTGRES
def test_una_cantidad_que_no_es_positiva_la_rechaza_la_base(conexion, con_entradas) -> None:
    import psycopg

    hold = _hold(conexion, con_entradas)
    for cantidad in (0, -3):
        with pytest.raises(psycopg.errors.CheckViolation):
            _linea(conexion, con_entradas, hold, cantidad=cantidad)


@SIN_POSTGRES
def test_un_subtotal_de_linea_que_no_cuadra_no_cabe(conexion, con_entradas) -> None:
    """`subtotal = cantidad x precio`, en cada linea."""
    import psycopg

    hold = _hold(conexion, con_entradas)
    with pytest.raises(psycopg.errors.CheckViolation):
        _ejecutar(
            conexion,
            "insert into public.event_ticket_hold_items "
            "(id, hold_id, event_id, ticket_type_id, quantity, unit_price_minor, "
            " subtotal_minor, ticket_type_name_snapshot) "
            "values (%s, %s, %s, %s, 2, 4900, 1, 'General')",
            _nuevo(),
            hold,
            con_entradas["evento"],
            con_entradas["tipo"],
        )


@SIN_POSTGRES
def test_la_suma_de_las_lineas_cuadra_con_la_cabecera(conexion, con_entradas) -> None:
    """El disparador DIFERIDO, ejercido.

    Es una restriccion ENTRE FILAS, asi que no cabe en un CHECK: se comprueba al
    CONFIRMAR, cuando la cabecera y todas sus lineas ya estan escritas.
    """
    import psycopg

    conexion.autocommit = False
    try:
        hold = _hold(conexion, con_entradas, subtotal=9800, con_linea=False)
        _linea(conexion, con_entradas, hold, cantidad=1)  # 4900, no 9800
        with pytest.raises(psycopg.errors.CheckViolation):
            conexion.commit()
        conexion.rollback()
    finally:
        conexion.autocommit = True


@SIN_POSTGRES
def test_una_reserva_que_cuadra_si_se_confirma(conexion, con_entradas) -> None:
    conexion.autocommit = False
    try:
        hold = _hold(conexion, con_entradas, subtotal=9800, con_linea=False)
        _linea(conexion, con_entradas, hold, cantidad=2)
        conexion.commit()
    finally:
        conexion.autocommit = True
    assert _lista(
        conexion,
        "select id::text from public.event_ticket_holds where id = %s",
        hold,
    )


@SIN_POSTGRES
def test_una_sola_reserva_activa_por_persona_y_evento(conexion, con_entradas) -> None:
    """El indice PARCIAL. Sin el, dos claves distintas evaden cualquier tope."""
    import psycopg

    _hold(conexion, con_entradas)
    with pytest.raises(psycopg.errors.UniqueViolation):
        _hold(conexion, con_entradas)


@SIN_POSTGRES
def test_las_vencidas_y_liberadas_no_estorban(conexion, con_entradas) -> None:
    """Y por eso el indice es parcial: el historial cabe entero."""
    _hold(conexion, con_entradas, estado="EXPIRED")
    _hold(conexion, con_entradas, estado="RELEASED")
    _hold(conexion, con_entradas, estado="ACTIVE")
    assert (
        len(
            _lista(
                conexion,
                "select id::text from public.event_ticket_holds where event_id = %s",
                con_entradas["evento"],
            )
        )
        == 3
    )


@SIN_POSTGRES
def test_una_clave_de_idempotencia_no_se_repite(conexion, con_entradas) -> None:
    import psycopg

    _hold(conexion, con_entradas, estado="RELEASED", clave="repetida")
    with pytest.raises(psycopg.errors.UniqueViolation):
        _hold(conexion, con_entradas, estado="RELEASED", clave="repetida")


@SIN_POSTGRES
def test_una_linea_por_tipo_dentro_de_una_reserva(conexion, con_entradas) -> None:
    """Dos lineas del mismo tipo son dos formas de decir lo mismo, y la segunda
    se olvida al sumar."""
    import psycopg

    conexion.autocommit = False
    try:
        hold = _hold(conexion, con_entradas, subtotal=9800, con_linea=False)
        _linea(conexion, con_entradas, hold, cantidad=1)
        with pytest.raises(psycopg.errors.UniqueViolation):
            _linea(conexion, con_entradas, hold, cantidad=1)
        conexion.rollback()
    finally:
        conexion.autocommit = True


@SIN_POSTGRES
def test_un_modo_de_acceso_inventado_no_cabe(conexion, evento) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _ejecutar(
            conexion,
            "insert into public.event_ticketing_settings (event_id, access_mode) "
            "values (%s, 'GRATIS_PARA_AMIGOS')",
            evento["evento"],
        )


@SIN_POSTGRES
def test_un_precio_negativo_no_cabe(conexion, con_entradas) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _ejecutar(
            conexion,
            "insert into public.event_ticket_types "
            "(id, event_id, name, price_minor, currency, quota) "
            "values (%s, %s, 'Al reves', -100, 'PEN', 5)",
            _nuevo(),
            con_entradas["evento"],
        )


@SIN_POSTGRES
def test_un_cupo_de_cero_no_cabe(conexion, con_entradas) -> None:
    """Cero no es un cupo: es un tipo que no existe. Para eso esta `retired`."""
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _ejecutar(
            conexion,
            "insert into public.event_ticket_types "
            "(id, event_id, name, price_minor, currency, quota) "
            "values (%s, %s, 'Vacio', 100, 'PEN', 0)",
            _nuevo(),
            con_entradas["evento"],
        )


@SIN_POSTGRES
def test_un_maximo_menor_que_el_minimo_no_cabe(conexion, con_entradas) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _ejecutar(
            conexion,
            "insert into public.event_ticket_types "
            "(id, event_id, name, price_minor, currency, quota, min_per_order, "
            " max_per_order) values (%s, %s, 'Raro', 100, 'PEN', 5, 4, 2)",
            _nuevo(),
            con_entradas["evento"],
        )


@SIN_POSTGRES
def test_una_ventana_de_venta_al_reves_no_cabe(conexion, evento) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _ejecutar(
            conexion,
            "insert into public.event_ticketing_settings "
            "(event_id, access_mode, sales_open_at, sales_close_at) values "
            "(%s, 'TICKETED', now() + interval '2 days', now())",
            evento["evento"],
        )


@SIN_POSTGRES
def test_no_se_borra_un_tipo_con_reservas_encima(conexion, con_entradas) -> None:
    """`on delete restrict`: el resumen de una reserva tiene que seguir
    contando lo mismo."""
    import psycopg

    conexion.autocommit = False
    try:
        hold = _hold(conexion, con_entradas, con_linea=False)
        _linea(conexion, con_entradas, hold, cantidad=1)
        conexion.commit()
    finally:
        conexion.autocommit = True

    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        _ejecutar(
            conexion,
            "delete from public.event_ticket_types where id = %s",
            con_entradas["tipo"],
        )


@SIN_POSTGRES
def test_una_cabecera_sin_lineas_no_es_una_reserva(conexion, con_entradas) -> None:
    """Una fila que dice «he apartado 500 soles» y no tiene debajo ni una
    entrada no aparta nada, y hasta ahora entraba y se quedaba.

    El disparador colgaba solo de las lineas, asi que una cabecera sola no lo
    disparaba jamas. Ahora cuelga tambien de la cabecera.
    """
    import psycopg

    conexion.autocommit = False
    try:
        _hold(conexion, con_entradas, subtotal=50000, con_linea=False)
        with pytest.raises(psycopg.errors.CheckViolation):
            conexion.commit()
        conexion.rollback()
    finally:
        conexion.autocommit = True


@SIN_POSTGRES
def test_reescribir_el_subtotal_sin_tocar_las_lineas_no_cuela(
    conexion, con_entradas
) -> None:
    """La otra forma de descuadrar sin que nadie mirase."""
    import psycopg

    hold = _hold(conexion, con_entradas, subtotal=4900)

    conexion.autocommit = False
    try:
        _ejecutar(
            conexion,
            "update public.event_ticket_holds set subtotal_minor = 1 where id = %s",
            hold,
        )
        with pytest.raises(psycopg.errors.CheckViolation):
            conexion.commit()
        conexion.rollback()
    finally:
        conexion.autocommit = True


@SIN_POSTGRES
def test_quitar_todas_las_lineas_deja_una_reserva_que_no_cuadra(
    conexion, con_entradas
) -> None:
    """La rama DELETE del disparador, ejercida."""
    import psycopg

    hold = _hold(conexion, con_entradas, subtotal=4900)

    conexion.autocommit = False
    try:
        _ejecutar(
            conexion,
            "delete from public.event_ticket_hold_items where hold_id = %s",
            hold,
        )
        with pytest.raises(psycopg.errors.CheckViolation):
            conexion.commit()
        conexion.rollback()
    finally:
        conexion.autocommit = True


@SIN_POSTGRES
def test_borrar_la_reserva_entera_si_se_puede(conexion, con_entradas) -> None:
    """Y la cascada sigue pasando: no se rechaza lo que si es legitimo."""
    hold = _hold(conexion, con_entradas, subtotal=4900)
    _ejecutar(conexion, "delete from public.event_ticket_holds where id = %s", hold)
    assert not _lista(
        conexion,
        "select id::text from public.event_ticket_holds where id = %s",
        hold,
    )


# --------------------------------------------------------------------------- #
# El ORM y el esquema real dicen lo mismo
# --------------------------------------------------------------------------- #
#: Las nueve tablas de Eventos: cinco de la 0060 y cuatro de la 0061.
TABLAS_DE_EVENTOS = TABLAS + TABLAS_DE_ENTRADAS


@SIN_POSTGRES
def test_el_orm_declara_las_mismas_columnas_que_la_base(conexion, aplicadas) -> None:
    """Una columna que el ORM no conoce no se lee; una que no existe, revienta."""
    from app.modules.events import models as modelos

    por_tabla = {m.__tablename__: m for m in _modelos_de_eventos(modelos)}
    problemas = []
    for tabla in TABLAS_DE_EVENTOS:
        modelo = por_tabla.get(tabla)
        assert modelo is not None, f"sin modelo ORM para {tabla}"
        reales = set(
            _lista(
                conexion,
                "select column_name from information_schema.columns "
                "where table_schema = 'public' and table_name = %s",
                tabla,
            )
        )
        del_orm = {c.name for c in modelo.__table__.columns}
        if del_orm - reales:
            problemas.append(f"{tabla}: el ORM nombra {sorted(del_orm - reales)}")
        if reales - del_orm:
            problemas.append(f"{tabla}: la base tiene {sorted(reales - del_orm)}")
    assert problemas == [], "; ".join(problemas)


@SIN_POSTGRES
def test_el_orm_y_la_base_coinciden_en_nulabilidad(conexion, aplicadas) -> None:
    """Que la base sea MAS estricta que el ORM tambien es una divergencia.

    `event_ticket_types.inclusions` se declaraba anulable en el ORM y la 0061 la
    creo `not null default '{}'`. Por la API no se podia colar un nulo, pero el
    esquema que las pruebas de SQLite construyen a partir del ORM SI lo admitia:
    la suite era mas permisiva que produccion justo en las dos columnas donde no
    lo parecia, y cualquier camino nuevo que escribiera `None` habria dado un
    500 solo contra PostgreSQL.
    """
    from app.modules.events import models as modelos

    por_tabla = {m.__tablename__: m for m in _modelos_de_eventos(modelos)}
    problemas = []
    for tabla in TABLAS_DE_EVENTOS:
        modelo = por_tabla[tabla]
        reales = dict(
            _pares(
                conexion,
                "select column_name, is_nullable from information_schema.columns "
                "where table_schema = 'public' and table_name = %s",
                tabla,
            )
        )
        for col in modelo.__table__.columns:
            if col.name not in reales:
                continue
            base_admite_nulo = reales[col.name] == "YES"
            orm_admite_nulo = bool(col.nullable) and not col.primary_key
            if base_admite_nulo != orm_admite_nulo:
                problemas.append(
                    f"{tabla}.{col.name}: orm={orm_admite_nulo}, base={base_admite_nulo}"
                )
    assert problemas == [], "; ".join(problemas)


def _modelos_de_eventos(modelos):
    from app.shared.database import Base

    return [
        m
        for m in Base.registry._class_registry.values()
        if hasattr(m, "__tablename__") and m.__module__ == modelos.__name__
    ]


def _pares(conexion, sql: str, *args) -> list:
    with conexion.cursor() as cur:
        cur.execute(sql, args or None)
        return list(cur.fetchall())


@SIN_POSTGRES
def test_las_cuatro_tablas_de_entradas_tienen_rls(conexion, aplicadas) -> None:
    sin_rls = [
        t
        for t in TABLAS_DE_ENTRADAS
        if not _lista(
            conexion,
            "select c.relrowsecurity from pg_class c join pg_namespace n "
            "on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = %s",
            t,
        )[0]
    ]
    assert not sin_rls, sin_rls


@SIN_POSTGRES
def test_las_entradas_no_se_sirven_por_postgrest(conexion, aplicadas) -> None:
    """Ni lectura. `event_ticket_types` parece publica —el precio se ensena—
    pero la fila lleva el cupo, el estado y los topes, que son inventario."""
    concedidas = _lista(
        conexion,
        "select table_name || ':' || grantee || ':' || privilege_type "
        "from information_schema.role_table_grants "
        "where table_schema = 'public' and grantee in ('anon', 'authenticated') "
        "  and table_name = any(%s)",
        list(TABLAS_DE_ENTRADAS),
    )
    assert not concedidas, concedidas
    politicas = _lista(
        conexion,
        "select tablename || ':' || policyname from pg_policies "
        "where schemaname = 'public' and tablename = any(%s)",
        list(TABLAS_DE_ENTRADAS),
    )
    assert not politicas, politicas


def test_la_0061_no_hace_backfill() -> None:
    """SIN FILA SIGNIFICA `FREE_RSVP`.

    Escribir una configuracion por evento diria lo que ya se sabe por su
    ausencia, y ademas haria creer que alguien decidio algo sobre esos eventos.

    SE MIRA EL SQL Y NO LA BASE a proposito: las pruebas de este modulo
    comparten conexion y escriben configuraciones a monton, asi que contar filas
    aqui mediria a las hermanas y no a la migracion. La migracion ademas se
    comprueba a si misma: su bloque final falla si la tabla tiene alguna fila al
    aplicarse.
    """
    sql = (MIGRACIONES / "0061_entradas_e_inventario_de_eventos.sql").read_text(
        encoding="utf-8"
    )
    minuscula = sql.lower()
    assert "insert into public.event_ticketing_settings" not in minuscula
    assert "insert into public.event_ticket_types" not in minuscula
    # Y la migracion se lo exige a si misma.
    assert "backfill_que_no_deberia_existir" in minuscula
