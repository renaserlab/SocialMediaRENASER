"""La 0089: borrar una cuenta sin borrar la historia.

La 0050, la 0086, la 0087 y la 0088 están aplicadas en Supabase y son
históricas: la 0089 NO LAS TOCA. Sustituye el CUERPO de doce funciones de
disparador para que admitan UNA cosa —anular a la persona cuando se borra su
perfil— y hace anonimizable `consent_records.subject_id`.

LO QUE DEFIENDEN ESTAS PRUEBAS:

  1. LA HISTORIA SIGUE SIN PODER REESCRIBIRSE. Ni una columna de una fila de
     auditoría, ni borrarla, ni cambiar un actor por otro, ni anularlo a mano,
     ni anularlo y tocar algo más a la vez, ni devolver un actor anonimizado.
     La excepción exige A LA VEZ estar dentro de la cascada, que el perfil ya
     no exista y que nada más cambie, y cada condición tiene su prueba.
  2. LA MIGRACIÓN: desde cero (0001–0089), sobre una base con la 0088 y datos
     (sin reescribir ni una fila), reejecutada, con un fallo a mitad (no queda
     nada), y negándose a aplicarse si falta algo o si una función fue cambiada
     a mano en la base.
  3. CERRADA: la RLS, las políticas, los privilegios y los índices de las doce
     tablas quedan exactamente como estaban, y la excepción no la puede
     ejecutar `anon` ni `authenticated`.

Sin `MIGRACIONES_DATABASE_URL` la parte de PostgreSQL se omite. EL ORDEN
IMPORTA: las primeras comparten una base entera; las del final la rehacen.
"""

from __future__ import annotations

import hashlib
import os
import re
import uuid

import pytest

from tests.test_migraciones_reales import MIGRACIONES, PROLOGO, exigir_url_desechable

ARCHIVO = MIGRACIONES / "0089_baja_de_cuenta_con_historial_anonimo.sql"
SQL = ARCHIVO.read_text(encoding="utf-8")
URL = os.environ.get("MIGRACIONES_DATABASE_URL", "").strip()
SIN_POSTGRES = pytest.mark.skipif(
    not URL,
    reason=(
        "sin PostgreSQL desechable: define MIGRACIONES_DATABASE_URL "
        "(ver la cabecera de tests/test_migraciones_reales.py)"
    ),
)

#: Las columnas de persona que la 0089 deja anular, por tabla.
ACTORES = {
    "audit_events": ("actor_id",),
    "consent_records": ("subject_id",),
    "course_versions": ("published_by",),
    "event_versions": ("created_by",),
    "event_policies": ("created_by", "published_by"),
    "event_review_moderation": ("actor_id",),
    "product_review_moderation": ("actor_id",),
    "product_refund_events": ("actor_id",),
    "product_dispute_events": ("actor_id",),
    "event_dispute_events": ("actor_id",),
    "event_aftersale_case_events": ("actor_id",),
    "event_order_policy_acceptances": ("accepted_by",),
}
TABLAS = sorted(ACTORES)
SUSTITUIDAS = (
    "sellar_consumo_una_vez",
    "impedir_reescritura_de_version",
    "impedir_reescritura_de_version_de_evento",
    "event_policies_publicada_es_inmutable",
    "event_policies_publicada_no_se_borra",
    "event_review_moderation_solo_anadir",
    "product_review_moderation_solo_anadir",
    "product_finanzas_solo_se_anaden",
    "event_dispute_events_solo_anadir",
    "event_aftersale_case_events_solo_anadir",
    "event_order_policy_acceptances_solo_anadir",
)
NUEVAS = (
    "es_anonimizacion_por_baja",
    "auditoria_solo_anadir",
    "event_orders_con_dinero_no_se_borran",
    "orders_con_dinero_no_se_borran",
)

#: Huella git (`blob`) de las migraciones aplicadas que la 0089 toca por
#: `create or replace` o que exige. Si una cambia, ya no es la que se aplicó.
APLICADAS = {
    "0050_versiones_politicas_y_auditoria.sql": "49aa6e4466267fba933c8c63b47d7e5158710ed5",
    "0051_endurecer_la_inmutabilidad_de_versiones.sql": "09a70e28baa1ce07b605d0cbc9bbf4b75ef5f9c9",
    "0060_admision_de_eventos.sql": "f9cb86e796fb0456edb86f793f4d0bb27bfaf069",
    "0064_posventa_de_eventos.sql": "0fd8c7f9d0fb500fb21ef72f1de3bb84f21d9ac9",
    "0067_resenas_verificadas_de_eventos.sql": "9bdc74c05dd28c6a5e04130cc63eefe03b1ba5d7",
    "0068_finanzas_de_eventos.sql": "e3bd1d8c4de7829bc3901b48414c27a845e2b4ed",
    "0069_politicas_del_organizador.sql": "c49f4baa7da9b0158f02e24ec7b7a786e7261090",
    "0081_productos_resenas.sql": "75f21b7550be589f484708b7def7244d71800f76",
    "0082_productos_finanzas.sql": "376df8ee372ea17997e8d3f532dd492294988f5e",
    "0086_servicios_admision.sql": "882084132e161d143ff69707ad3f92b7cd68eedb",
    "0087_servicios_retirada.sql": "359f330a9ee99d22f3c2f719cb0adf557e58d7e8",
    "0088_servicios_documentos_y_envios.sql": "dfa1616cce9cbcdb4a44cf0a1b6dc619c3cd5f38",
}


def _sin_comentarios(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


# =========================================================================== #
# 1. Estática
# =========================================================================== #
def test_sigue_a_la_0088_y_es_la_ultima() -> None:
    nombres = sorted(p.name for p in MIGRACIONES.glob("*.sql"))
    assert nombres[-1] == ARCHIVO.name
    assert nombres[-2].startswith("0088_")


@pytest.mark.parametrize("nombre", sorted(APLICADAS))
def test_las_aplicadas_no_han_cambiado(nombre) -> None:
    contenido = (MIGRACIONES / nombre).read_bytes().replace(b"\r\n", b"\n")
    cabecera = f"blob {len(contenido)}\0".encode()
    assert hashlib.sha1(cabecera + contenido).hexdigest() == APLICADAS[nombre]


def test_es_una_unica_transaccion() -> None:
    sentencias = [s.strip() for s in _sin_comentarios(SQL).split(";") if s.strip()]
    assert sentencias[0] == "begin"
    assert sentencias[-1] == "commit"
    assert len(re.findall(r"^\s*begin\s*;", SQL, flags=re.M)) == 1
    assert len(re.findall(r"^\s*commit\s*;", SQL, flags=re.M)) == 1
    assert not re.search(r"\brollback\b|\bsavepoint\b", _sin_comentarios(SQL), flags=re.I)


def test_comprueba_todo_antes_de_sustituir_nada() -> None:
    codigo = _sin_comentarios(SQL)
    comprobacion = codigo.index("La 0089 requiere la 0088 aplicada")
    primera_sustitucion = codigo.index("create or replace function")
    assert comprobacion < primera_sustitucion
    for funcion in SUSTITUIDAS:
        assert re.search(rf"\('{funcion}', '[0-9a-f]{{32}}', '[0-9a-f]{{32}}'\)", codigo), funcion
    assert "@@" not in codigo


def test_no_concede_ni_borra_nada() -> None:
    codigo = _sin_comentarios(SQL).lower()
    for prohibido in (
        r"\bgrant\b", r"drop\s+table", r"drop\s+column", r"delete\s+from", r"\bupdate\s+public\.",
        r"\btruncate\b", r"disable\s+row\s+level\s+security", r"security\s+definer",
        r"disable\s+trigger", r"session_replication_role",
    ):
        assert not re.search(prohibido, codigo), prohibido


def test_toca_solo_las_funciones_y_la_tabla_que_dice() -> None:
    codigo = _sin_comentarios(SQL)
    funciones = set(re.findall(r"create\s+or\s+replace\s+function\s+public\.([a-z_]+)\(", codigo))
    assert funciones == set(SUSTITUIDAS) | set(NUEVAS)
    assert set(re.findall(r"alter\s+table\s+public\.([a-z_]+)", codigo)) == {"consent_records"}
    assert re.findall(r"create\s+or\s+replace\s+trigger\s+([a-z_]+)", codigo) == [
        "audit_events_solo_anadir", "event_orders_con_dinero_no_se_borran", "orders_con_dinero_no_se_borran",
    ]


# =========================================================================== #
# 2. PostgreSQL
# =========================================================================== #
def _montar(pg, *, hasta: str | None = None) -> None:
    with pg.cursor() as cur:
        cur.execute("drop schema if exists public cascade")
        cur.execute("drop schema if exists auth cascade")
        cur.execute("drop schema if exists storage cascade")
        cur.execute("create schema public")
        cur.execute(PROLOGO.read_text(encoding="utf-8"))
    for ruta in sorted(MIGRACIONES.glob("*.sql")):
        if hasta is not None and ruta.name[:4] > hasta:
            break
        with pg.cursor() as cur:
            cur.execute(ruta.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def pg():
    psycopg = pytest.importorskip("psycopg")
    if not URL:
        pytest.skip("sin PostgreSQL desechable")
    exigir_url_desechable(URL, os.environ.get("DATABASE_URL", ""))
    with psycopg.connect(URL, autocommit=True) as conexion:
        yield conexion


@pytest.fixture(scope="module")
def completa(pg):
    _montar(pg)
    return pg


def _uno(pg, sql: str, *args):
    with pg.cursor() as cur:
        cur.execute(sql, args or None)
        fila = cur.fetchone()
    return fila[0] if fila else None


def _todas(pg, sql: str, *args) -> list:
    with pg.cursor() as cur:
        cur.execute(sql, args or None)
        return [tuple(f) for f in cur.fetchall()]


def _hacer(pg, sql: str, *args) -> None:
    with pg.cursor() as cur:
        cur.execute(sql, args or None)


def _rechaza(pg, sql: str, *args, sqlstate: str = "23001") -> str:
    import psycopg

    with pytest.raises(psycopg.Error) as error:
        with pg.cursor() as cur:
            cur.execute(sql, args or None)
    assert error.value.diag.sqlstate == sqlstate, error.value
    return str(error.value)


def _aplicar_0089(pg, sql: str = SQL) -> None:
    """La migración tal cual se pega en Supabase. Si falla, la transacción
    abierta por su `begin` se deshace aquí, como haría el editor."""
    import psycopg

    try:
        with pg.cursor() as cur:
            cur.execute(sql)
    except psycopg.Error:
        with pg.cursor() as cur:
            cur.execute("rollback")
        raise


def _persona(pg, rol: str = "user") -> str:
    ident = str(uuid.uuid4())
    _hacer(
        pg,
        "insert into auth.users (id, email, raw_user_meta_data) values "
        "(%s, %s, jsonb_build_object('full_name','P','username',cast(%s as text)))",
        ident, f"m-{ident[:8]}@x.test", f"m{ident[:8]}",
    )
    _hacer(pg, "update public.profiles set role = %s where id = %s", rol, ident)
    return ident


def _auditoria(pg, actor: str | None) -> str:
    return str(_uno(
        pg,
        "insert into public.audit_events (actor_id, actor_role, action, entity_type, entity_id, reason, payload) "
        "values (%s, 'admin', 'service_application.approved', 'service_application', gen_random_uuid(), "
        "'Cumple', '{\"event_id\": \"e-1\"}') returning id",
        actor,
    ))


def _foto(pg) -> dict:
    """Lo que la 0089 cambia, y lo que no debe cambiar."""
    return {
        "cuerpos": _todas(
            pg,
            "select proname, md5(regexp_replace(replace(prosrc, E'\\r', ''), '\\s+', ' ', 'g')), prosecdef, "
            "coalesce(array_to_string(proconfig, ','), '') from pg_proc "
            "where pronamespace = 'public'::regnamespace and proname = any(%s) order by 1",
            list(SUSTITUIDAS + NUEVAS + ("impedir_reescritura",)),
        ),
        "disparadores": _todas(
            pg,
            "select t.tgrelid::regclass::text, t.tgname, p.proname, t.tgenabled, pg_get_triggerdef(t.oid) "
            "from pg_trigger t join pg_proc p on p.oid = t.tgfoid "
            "where not t.tgisinternal and t.tgrelid = any(%s::regclass[]) order by 1, 2",
            [f"public.{t}" for t in TABLAS],
        ),
        "claves": _todas(
            pg,
            "select conrelid::regclass::text, conname, pg_get_constraintdef(oid) from pg_constraint "
            "where conrelid = any(%s::regclass[]) order by 1, 2",
            [f"public.{t}" for t in TABLAS],
        ),
        "nulabilidad": _todas(
            pg,
            "select table_name, column_name, is_nullable from information_schema.columns "
            "where table_schema = 'public' and table_name = any(%s) order by 1, 2",
            TABLAS,
        ),
        "seguridad": _seguridad(pg),
    }


def _seguridad(pg) -> dict:
    return {
        "rls": _todas(
            pg,
            "select relname, relrowsecurity, relforcerowsecurity from pg_class "
            "where relnamespace = 'public'::regnamespace and relname = any(%s) order by 1",
            TABLAS,
        ),
        "politicas": _todas(
            pg,
            "select tablename, policyname, cmd, roles::text, coalesce(qual, ''), coalesce(with_check, '') "
            "from pg_policies where schemaname = 'public' and tablename = any(%s) order by 1, 2",
            TABLAS,
        ),
        "privilegios": _todas(
            pg,
            "select table_name, grantee, privilege_type from information_schema.table_privileges "
            "where table_schema = 'public' and table_name = any(%s) and grantee in ('anon', 'authenticated', 'PUBLIC') "
            "order by 1, 2, 3",
            TABLAS,
        ),
        "indices": _todas(
            pg,
            "select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' "
            "and tablename = any(%s) order by 1, 2",
            TABLAS,
        ),
    }


# --- 2.1 Desde cero (0001–0089) ------------------------------------------- #
@SIN_POSTGRES
def test_desde_cero_deja_lo_que_promete(completa) -> None:
    pg = completa
    assert _todas(
        pg,
        "select p.proname from pg_trigger t join pg_proc p on p.oid = t.tgfoid "
        "where t.tgrelid = 'public.audit_events'::regclass and t.tgname = 'audit_events_solo_anadir'",
    ) == [("auditoria_solo_anadir",)]
    # `impedir_reescritura` sigue ahí para lo que NO se borra nunca.
    assert {f[0] for f in _todas(
        pg,
        "select t.tgname from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname = 'impedir_reescritura'",
    )} == {"consent_records_no_se_borra", "policy_versions_no_se_borra"}
    assert _todas(
        pg,
        "select confdeltype, (select attnotnull from pg_attribute where attrelid = conrelid and attname = 'subject_id') "
        "from pg_constraint where conname = 'consent_records_subject_id_fkey'",
    ) == [("n", False)]
    # Cada columna de persona, `on delete set null`, hacia `profiles`.
    for tabla, columnas in ACTORES.items():
        for columna in columnas:
            assert _uno(
                pg,
                "select c.confdeltype from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid "
                "and a.attnum = c.conkey[1] where c.contype = 'f' and c.conrelid = %s::regclass "
                "and c.confrelid = 'public.profiles'::regclass and a.attname = %s",
                f"public.{tabla}", columna,
            ) == "n", f"{tabla}.{columna}"
    excepcion = _todas(
        pg,
        "select prosecdef, provolatile, proconfig::text from pg_proc "
        "where oid = 'public.es_anonimizacion_por_baja(jsonb, jsonb, text[])'::regprocedure",
    )
    assert excepcion == [(False, "v", '{"search_path=\\"\\""}')]
    for rol in ("anon", "authenticated"):
        for firma in ("public.es_anonimizacion_por_baja(jsonb, jsonb, text[])", "public.auditoria_solo_anadir()"):
            assert not _uno(pg, "select has_function_privilege(%s, %s, 'execute')", rol, firma), (rol, firma)
    assert all(rls for _, rls, _ in _seguridad(pg)["rls"])


# --- 2.2 Lo que sigue prohibido -------------------------------------------- #
@SIN_POSTGRES
@pytest.mark.parametrize(
    "cambio",
    [
        "action = 'otra.cosa'", "entity_type = 'otra'", "entity_id = gen_random_uuid()",
        "occurred_at = now() - interval '1 day'", "outcome = 'denied'", "reason = 'reescrito'",
        "payload = '{}'::jsonb", "previous_state = 'x'", "new_state = 'y'", "actor_role = 'system'",
        "ip_hash = repeat('f', 64)", "created_at = now()",
    ],
)
def test_una_fila_de_auditoria_no_se_edita(completa, cambio) -> None:
    pg = completa
    fila = _auditoria(pg, _persona(pg, "admin"))
    _rechaza(pg, f"update public.audit_events set {cambio} where id = %s", fila)


@SIN_POSTGRES
def test_una_fila_de_auditoria_no_se_borra_ni_con_su_actor_borrado(completa) -> None:
    pg = completa
    actor = _persona(pg, "admin")
    fila = _auditoria(pg, actor)
    _rechaza(pg, "delete from public.audit_events where id = %s", fila)
    _hacer(pg, "delete from public.profiles where id = %s", actor)
    _rechaza(pg, "delete from public.audit_events where id = %s", fila)
    assert _uno(pg, "select count(*) from public.audit_events where id = %s and actor_id is null", fila) == 1


@SIN_POSTGRES
def test_no_se_cambia_un_actor_por_otro(completa) -> None:
    pg = completa
    fila = _auditoria(pg, _persona(pg, "admin"))
    _rechaza(pg, "update public.audit_events set actor_id = %s where id = %s", _persona(pg, "admin"), fila)


@SIN_POSTGRES
def test_no_se_anula_un_actor_a_mano(completa) -> None:
    """Un UPDATE escrito a mano llega con profundidad 1 y el perfil sigue ahí:
    le faltan las dos cosas."""
    pg = completa
    fila = _auditoria(pg, _persona(pg, "admin"))
    _rechaza(pg, "update public.audit_events set actor_id = null where id = %s", fila)


@SIN_POSTGRES
def test_ni_desde_un_disparador_si_el_perfil_sigue_vivo(completa) -> None:
    """LA COMPROBACIÓN DEL PERFIL, SOLA. Un disparador cualquiera da la
    profundidad 2 que da la cascada; lo que lo frena es que el perfil existe."""
    pg = completa
    fila = _auditoria(pg, _persona(pg, "admin"))
    with pg.transaction(force_rollback=True):
        _hacer(pg, "create temp table z_disparo (fila uuid)")
        _hacer(
            pg,
            "create function pg_temp.z_anular() returns trigger language plpgsql as $$ begin "
            "update public.audit_events set actor_id = null where id = new.fila; return new; end $$",
        )
        _hacer(pg, "create trigger z_anular after insert on z_disparo for each row execute function pg_temp.z_anular()")
        _rechaza(pg, "insert into z_disparo values (%s)", fila)


@SIN_POSTGRES
def test_ni_con_el_perfil_ausente_si_no_viene_de_la_cascada(completa) -> None:
    """LA PROFUNDIDAD, SOLA. Con `session_replication_role = replica` (solo
    superusuario) se borra el perfil SIN su cascada: queda un actor colgando.
    Anularlo a mano, con profundidad 1, sigue prohibido."""
    pg = completa
    actor = _persona(pg, "admin")
    fila = _auditoria(pg, actor)
    with pg.transaction(force_rollback=True):
        _hacer(pg, "set local session_replication_role = replica")
        _hacer(pg, "delete from public.profiles where id = %s", actor)
        _hacer(pg, "set local session_replication_role = origin")
        assert _uno(pg, "select count(*) from public.profiles where id = %s", actor) == 0
        _rechaza(pg, "update public.audit_events set actor_id = null where id = %s", fila)


def _disparador_en_la_baja(pg, cuerpo: str) -> None:
    """Un disparador sobre `profiles` que corre ANTES que la cascada de las
    claves ajenas (se ejecutan por orden de nombre y `A` va antes que `RI_`):
    reproduce lo que haría alguien que quisiera colarse por la excepción."""
    _hacer(
        pg,
        "create function pg_temp.z_colarse() returns trigger language plpgsql as $$ begin "
        + cuerpo + "; return old; end $$",
    )
    _hacer(pg, 'create trigger "A_colarse" after delete on public.profiles for each row execute function pg_temp.z_colarse()')


@SIN_POSTGRES
def test_en_la_cascada_se_anula_y_nada_mas(completa) -> None:
    pg = completa
    actor = _persona(pg, "admin")
    fila = _auditoria(pg, actor)
    with pg.transaction(force_rollback=True):
        _disparador_en_la_baja(pg, "update public.audit_events set actor_id = null, reason = 'otra' where actor_id = old.id")
        _rechaza(pg, "delete from public.profiles where id = %s", actor)
    assert _uno(pg, "select actor_id::text from public.audit_events where id = %s", fila) == actor


@SIN_POSTGRES
def test_en_la_cascada_no_se_reasigna_a_otra_persona(completa) -> None:
    pg = completa
    actor, otra = _persona(pg, "admin"), _persona(pg, "admin")
    _auditoria(pg, actor)
    with pg.transaction(force_rollback=True):
        _disparador_en_la_baja(
            pg, f"update public.audit_events set actor_id = '{otra}' where actor_id = old.id"
        )
        _rechaza(pg, "delete from public.profiles where id = %s", actor)


@SIN_POSTGRES
def test_no_se_devuelve_un_actor_a_una_fila_anonima(completa) -> None:
    pg = completa
    actor, otra, testigo = _persona(pg, "admin"), _persona(pg, "admin"), _persona(pg)
    fila = _auditoria(pg, actor)
    _hacer(pg, "delete from public.profiles where id = %s", actor)
    assert _uno(pg, "select actor_id from public.audit_events where id = %s", fila) is None
    _rechaza(pg, "update public.audit_events set actor_id = %s where id = %s", otra, fila)
    # Ni desde dentro de la cascada de otra baja.
    with pg.transaction(force_rollback=True):
        _disparador_en_la_baja(pg, f"update public.audit_events set actor_id = '{otra}' where id = '{fila}'")
        _rechaza(pg, "delete from public.profiles where id = %s", testigo)


@SIN_POSTGRES
def test_la_excepcion_no_la_usa_nadie_desde_fuera(completa) -> None:
    pg = completa
    viejo = '{"actor_id": "%s", "action": "a"}' % uuid.uuid4()
    assert _uno(
        pg, "select public.es_anonimizacion_por_baja(%s::jsonb, '{\"actor_id\": null, \"action\": \"a\"}'::jsonb, "
        "array['actor_id'])", viejo,
    ) is False
    for rol in ("authenticated", "anon"):
        with pg.transaction(force_rollback=True):
            _hacer(pg, f"set local role {rol}")
            _rechaza(
                pg, "select public.es_anonimizacion_por_baja('{}'::jsonb, '{}'::jsonb, array['actor_id'])",
                sqlstate="42501",
            )


@SIN_POSTGRES
def test_el_consentimiento_sigue_siendo_una_prueba(completa) -> None:
    pg = completa
    sujeto, otra = _persona(pg), _persona(pg)
    politica = _uno(
        pg,
        "insert into public.policy_versions (policy_type, version, body, body_sha256) "
        "values ('terms', %s, 'Texto', repeat('b', 64)) returning id",
        str(uuid.uuid4())[:8],
    )
    fila = _uno(
        pg,
        "insert into public.consent_records (subject_id, policy_version_id, policy_type, policy_version, policy_hash) "
        "values (%s, %s, 'terms', 'v1', repeat('c', 64)) returning id",
        sujeto, politica,
    )
    _rechaza(pg, "update public.consent_records set subject_id = %s where id = %s", otra, fila)
    _rechaza(pg, "update public.consent_records set policy_hash = repeat('d', 64) where id = %s", fila)
    _rechaza(pg, "update public.consent_records set subject_id = null where id = %s", fila)
    _rechaza(pg, "delete from public.consent_records where id = %s", fila)
    _hacer(pg, "delete from public.profiles where id = %s", sujeto)
    assert _uno(pg, "select subject_id from public.consent_records where id = %s", fila) is None
    _rechaza(pg, "update public.consent_records set subject_id = %s where id = %s", otra, fila)
    _rechaza(pg, "delete from public.consent_records where id = %s", fila)


@SIN_POSTGRES
def test_lo_suelto_sigue_sin_borrarse(completa) -> None:
    """La salida de cascada exige que la MADRE ya no esté. Con la madre viva,
    una versión, una política publicada, una moderación o una aceptación no se
    borran."""
    pg = completa
    autor = _persona(pg)
    curso = _uno(pg, "insert into public.courses (author_id, title) values (%s, 'C') returning id", autor)
    version = _uno(
        pg,
        "insert into public.course_versions (course_id, version, status, content_hash, snapshot) "
        "values (%s, 1, 'published', 'h', '{}') returning id",
        curso,
    )
    _rechaza(pg, "delete from public.course_versions where id = %s", version)
    evento = _uno(pg, "insert into public.events (organizer_id, title) values (%s, 'E') returning id", autor)
    politica = _uno(
        pg,
        "insert into public.event_policies (policy_type, scope, event_id, version, params_sha256, status, published_at) "
        "values ('review_window', 'event', %s, 'v1', repeat('a', 64), 'published', now()) returning id",
        evento,
    )
    _rechaza(pg, "delete from public.event_policies where id = %s", politica)
    # Madres sembradas sin sus propias madres (sus circuitos son de pago): lo
    # que se prueba es que, con la madre presente, la hija no se va.
    with pg.transaction():
        _hacer(pg, "set local session_replication_role = replica")
        resena, orden = str(uuid.uuid4()), str(uuid.uuid4())
        _hacer(
            pg,
            "insert into public.event_reviews (id, event_id, author_id, checkin_id, ticket_id, overall) "
            "values (%s, %s, %s, gen_random_uuid(), gen_random_uuid(), 5)",
            resena, evento, autor,
        )
        _hacer(
            pg,
            "insert into public.event_orders (id, event_id, buyer_id, hold_id, currency, subtotal_minor, total_minor, "
            "idempotency_key) values (%s, %s, %s, gen_random_uuid(), 'PEN', 0, 0, 'k')",
            orden, evento, autor,
        )
        moderacion = _uno(
            pg,
            "insert into public.event_review_moderation (review_id, to_status) values (%s, 'hidden') returning id",
            resena,
        )
        aceptacion = _uno(
            pg,
            "insert into public.event_order_policy_acceptances (order_id, policy_id, policy_type, policy_version, "
            "params_sha256) values (%s, %s, 'review_window', 'v1', repeat('a', 64)) returning id",
            orden, politica,
        )
    _rechaza(pg, "delete from public.event_review_moderation where id = %s", moderacion)
    _rechaza(pg, "delete from public.event_order_policy_acceptances where id = %s", aceptacion)


@SIN_POSTGRES
def test_el_historial_de_servicios_sigue_inmutable(completa) -> None:
    from tests.test_servicios_migracion_0088 import _en_revision, _envio, _politica

    pg = completa
    admin = _persona(pg, "admin")
    perfil, prestador, solicitud = _en_revision(pg, admin)
    envio = _envio(pg, solicitud, _politica(pg, admin))
    evento = _uno(
        pg,
        "insert into public.service_provider_application_events (application_id, to_status, actor_id, actor_role) "
        "values (%s, 'draft', %s, 'provider') returning id",
        solicitud, perfil,
    )
    _rechaza(pg, "update public.service_provider_application_events set visible_note = 'x' where id = %s", evento)
    _rechaza(pg, "delete from public.service_provider_application_events where id = %s", evento)
    _rechaza(pg, "update public.service_provider_application_submissions set snapshot = '{}' where id = %s", envio)
    _rechaza(pg, "delete from public.service_provider_application_submissions where id = %s", envio)


# --- 2.3 La migración sobre bases ya en uso -------------------------------- #
def _filas_de(pg) -> dict:
    return {
        tabla: _todas(pg, f"select to_jsonb(t)::text from public.{tabla} t order by 1")
        for tabla in TABLAS
    }


@SIN_POSTGRES
def test_sobre_una_base_con_la_0088_y_datos_no_reescribe_nada(pg) -> None:
    _montar(pg, hasta="0088")
    actor, sujeto = _persona(pg, "admin"), _persona(pg)
    fila = _auditoria(pg, actor)
    politica = _uno(
        pg,
        "insert into public.policy_versions (policy_type, version, body, body_sha256) "
        "values ('terms', 'v9', 'Texto', repeat('b', 64)) returning id",
    )
    consentimiento = _uno(
        pg,
        "insert into public.consent_records (subject_id, policy_version_id, policy_type, policy_version, policy_hash) "
        "values (%s, %s, 'terms', 'v9', repeat('c', 64)) returning id",
        sujeto, politica,
    )
    curso = _uno(pg, "insert into public.courses (author_id, title) values (%s, 'C') returning id", sujeto)
    _hacer(
        pg,
        "insert into public.course_versions (course_id, version, status, content_hash, snapshot, published_by) "
        "values (%s, 1, 'published', 'h', '{}', %s)",
        curso, actor,
    )
    antes = _filas_de(pg)
    assert sum(len(v) for v in antes.values()) >= 3, "sin filas la prueba pasaría por vacío"
    seguridad = _seguridad(pg)

    _aplicar_0089(pg)

    assert _filas_de(pg) == antes
    assert _seguridad(pg) == seguridad
    # Y con los datos que ya había, la baja funciona.
    _hacer(pg, "delete from public.profiles where id = %s", actor)
    _hacer(pg, "delete from public.profiles where id = %s", sujeto)
    assert _uno(pg, "select actor_id from public.audit_events where id = %s", fila) is None
    assert _uno(pg, "select subject_id from public.consent_records where id = %s", consentimiento) is None


@SIN_POSTGRES
def test_reejecutarla_deja_exactamente_lo_mismo(pg) -> None:
    _montar(pg)
    antes = _foto(pg)
    _aplicar_0089(pg)
    _aplicar_0089(pg)
    assert _foto(pg) == antes


@SIN_POSTGRES
def test_un_fallo_a_mitad_no_deja_nada(pg) -> None:
    import psycopg

    _montar(pg, hasta="0088")
    antes = _foto(pg)
    corte = SQL.index("-- 9. Verificación")
    rota = SQL[:corte] + "do $$ begin raise exception 'fallo provocado a mitad'; end $$;\n" + SQL[corte:]
    with pytest.raises(psycopg.Error, match="fallo provocado a mitad"):
        _aplicar_0089(pg, rota)
    assert _foto(pg) == antes
    assert _uno(pg, "select to_regprocedure('public.auditoria_solo_anadir()')") is None


@SIN_POSTGRES
def test_sin_la_0088_se_niega_y_no_toca_nada(pg) -> None:
    import psycopg

    _montar(pg, hasta="0087")
    antes = _foto(pg)
    with pytest.raises(psycopg.Error, match="requiere la 0088"):
        _aplicar_0089(pg)
    assert _foto(pg) == antes


@SIN_POSTGRES
def test_con_una_funcion_cambiada_a_mano_se_niega(pg) -> None:
    """`create or replace` pisaría sin avisar un arreglo hecho a mano en la
    base. Por eso compara cada cuerpo con su huella antes de sustituir."""
    import psycopg

    _montar(pg, hasta="0088")
    _hacer(
        pg,
        "create or replace function public.product_finanzas_solo_se_anaden() returns trigger "
        "language plpgsql security invoker set search_path = public, pg_temp as $$ begin return new; end $$",
    )
    antes = _foto(pg)
    with pytest.raises(psycopg.Error, match="product_finanzas_solo_se_anaden"):
        _aplicar_0089(pg)
    assert _foto(pg) == antes


@SIN_POSTGRES
def test_sin_su_disparador_se_niega(pg) -> None:
    import psycopg

    _montar(pg, hasta="0088")
    _hacer(pg, "drop trigger audit_events_solo_anadir on public.audit_events")
    antes = _foto(pg)
    with pytest.raises(psycopg.Error, match="audit_events.audit_events_solo_anadir"):
        _aplicar_0089(pg)
    assert _foto(pg) == antes


@SIN_POSTGRES
def test_con_una_clave_ajena_distinta_se_niega(pg) -> None:
    import psycopg

    _montar(pg, hasta="0088")
    nombre = _uno(
        pg,
        "select conname from pg_constraint where conrelid = 'public.event_versions'::regclass "
        "and contype = 'f' and confrelid = 'public.profiles'::regclass",
    )
    _hacer(pg, f"alter table public.event_versions drop constraint {nombre}")
    _hacer(
        pg,
        f"alter table public.event_versions add constraint {nombre} foreign key (created_by) "
        "references public.profiles(id) on delete cascade",
    )
    antes = _foto(pg)
    with pytest.raises(psycopg.Error, match="event_versions.created_by"):
        _aplicar_0089(pg)
    assert _foto(pg) == antes


# --- 2.4 Los modelos dicen lo mismo que la base ---------------------------- #
@SIN_POSTGRES
def test_los_modelos_coinciden(pg) -> None:
    from app.modules.gobernanza.models import AuditEvent, ConsentRecord

    _montar(pg)
    for modelo, columna in ((ConsentRecord, "subject_id"), (AuditEvent, "actor_id")):
        tabla = modelo.__tablename__
        col = modelo.__table__.c[columna]
        [clave] = col.foreign_keys
        base = _todas(
            pg,
            "select is_nullable from information_schema.columns where table_schema = 'public' "
            "and table_name = %s and column_name = %s",
            tabla, columna,
        )
        assert base == [("YES" if col.nullable else "NO",)], tabla
        accion = _uno(
            pg,
            "select c.confdeltype from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid "
            "and a.attnum = c.conkey[1] where c.contype = 'f' and c.conrelid = %s::regclass and a.attname = %s",
            f"public.{tabla}", columna,
        )
        assert (clave.ondelete or "").upper() == {"n": "SET NULL", "r": "RESTRICT", "c": "CASCADE"}[accion], tabla


# --- 2.5 Hallazgos de la revisión independiente (29/09/2026) --------------- #
def _orden_de_evento(
    pg, comprador: str, *, pagada: bool, stripe: bool, entorno: str = "production",
    estado: str | None = None, hace: str = "0 hours",
) -> str:
    """Una orden de evento con sus madres sembradas (el circuito de pago está
    apagado); lo que se prueba es su borrado."""
    orden = str(uuid.uuid4())
    with pg.transaction():
        _hacer(pg, "set local session_replication_role = replica")
        _hacer(
            pg,
            "insert into public.event_orders (id, event_id, buyer_id, hold_id, status, currency, subtotal_minor, "
            "total_minor, provider, environment, external_payment_id, idempotency_key, paid_at, updated_at) "
            "values (%s, gen_random_uuid(), %s, gen_random_uuid(), %s, 'PEN', 100, 100, %s, %s, %s, 'k', %s, "
            "now() - cast(%s as interval))",
            orden, comprador, estado or ("PAID" if pagada else "PENDING_PAYMENT"), "stripe" if stripe else "none",
            entorno, f"pi_{orden[:8]}" if (stripe and pagada) else None, "2026-09-29" if pagada else None, hace,
        )
    return orden


@SIN_POSTGRES
def test_R1_una_orden_con_dinero_no_se_borra_y_sin_dinero_si(pg) -> None:
    _montar(pg)
    comprador = _persona(pg)
    pagada = _orden_de_evento(pg, comprador, pagada=True, stripe=True)
    cobrando = _orden_de_evento(pg, comprador, pagada=False, stripe=True, estado="PAYMENT_PROCESSING", hace="2 hours")
    gratis = _orden_de_evento(pg, comprador, pagada=True, stripe=False)
    pendiente = _orden_de_evento(pg, comprador, pagada=False, stripe=False)
    de_pruebas = _orden_de_evento(pg, comprador, pagada=True, stripe=True, entorno="sandbox")
    abandonada = _orden_de_evento(pg, comprador, pagada=False, stripe=True, estado="PAYMENT_PROCESSING", hace="2 days")
    for orden in (pagada, cobrando):
        assert "movió dinero" in _rechaza(pg, "delete from public.event_orders where id = %s", orden)
    # Sin dinero de verdad sí se va: gratuita, pendiente, de pruebas o un
    # checkout abandonado que ya no puede cobrarse (la sesión caduca a las 24 h).
    for orden in (gratis, pendiente, de_pruebas, abandonada):
        with pg.transaction(force_rollback=True):
            _hacer(pg, "set local session_replication_role = origin")
            _hacer(pg, "delete from public.event_orders where id = %s", orden)
    # Y la de un curso, pagada o devuelta.
    with pg.transaction():
        _hacer(pg, "set local session_replication_role = replica")
        curso, de_pruebas = str(uuid.uuid4()), str(uuid.uuid4())
        for ident, entorno in ((curso, "production"), (de_pruebas, "sandbox")):
            _hacer(
                pg,
                "insert into public.orders (id, user_id, commerce_product_id, provider, channel, environment, status, "
                "amount_minor, currency) values (%s, %s, gen_random_uuid(), 'stripe', 'web', %s, 'refunded', 4900, 'PEN')",
                ident, comprador, entorno,
            )
    _rechaza(pg, "delete from public.orders where id = %s", curso)
    with pg.transaction(force_rollback=True):
        _hacer(pg, "delete from public.orders where id = %s", de_pruebas)


@SIN_POSTGRES
def test_R10_un_disparador_cambiado_de_forma_se_niega(pg) -> None:
    """Mismo nombre y misma función, pero solo `before delete`: el UPDATE se
    quedaría sin vigilar. La 0089 mira también la forma (`tgtype`)."""
    import psycopg

    _montar(pg, hasta="0088")
    _hacer(pg, "drop trigger audit_events_solo_anadir on public.audit_events")
    _hacer(
        pg,
        "create trigger audit_events_solo_anadir before delete on public.audit_events "
        "for each row execute function public.impedir_reescritura()",
    )
    antes = _foto(pg)
    with pytest.raises(psycopg.Error, match="audit_events.audit_events_solo_anadir"):
        _aplicar_0089(pg)
    assert _foto(pg) == antes


@SIN_POSTGRES
def test_R10_una_segunda_clave_sobre_el_sujeto_del_consentimiento_se_niega(pg) -> None:
    import psycopg

    _montar(pg, hasta="0088")
    _hacer(
        pg,
        "alter table public.consent_records add constraint z_segunda foreign key (subject_id) "
        "references public.profiles(id) on delete restrict",
    )
    antes = _foto(pg)
    with pytest.raises(psycopg.Error, match="una sola clave ajena"):
        _aplicar_0089(pg)
    assert _foto(pg) == antes
