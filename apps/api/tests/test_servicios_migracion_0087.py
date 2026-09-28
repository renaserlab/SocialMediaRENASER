"""Z Servicios: la migración 0087 (el estado `withdrawn`).

La 0086 está aplicada en Supabase y es histórica. La 0087 sustituye, CON LOS
MISMOS NOMBRES, solo lo que tiene que ampliarse para admitir `withdrawn` (cinco
CHECK, la función de saltos y el índice de postulación viva), en una única
transacción, y añade dos protecciones nuevas.

LO QUE DEFIENDEN ESTAS PRUEBAS:

  1. UNA ÚNICA TRANSACCIÓN que primero comprueba que la 0086 está, y que si
     algo falla no deja nada a medias.
  2. SOLO SE SUSTITUYE LO AUTORIZADO, y cada protección se AMPLÍA con
     `withdrawn` sin perder nada de lo que ya exigía.
  3. Funciona DESDE CERO (0001–0087) y SOBRE UNA BASE QUE YA TIENE LA 0086 con
     datos, sin tocar ninguna fila; y reejecutarla deja lo mismo.
  4. LA REGLA DE NEGOCIO: solo el prestador dueño se retira, solo antes de la
     decisión, es final, libera el hueco y conserva documentos, credenciales e
     historial.

Las pruebas de PostgreSQL necesitan `MIGRACIONES_DATABASE_URL`. EL ORDEN
IMPORTA: las primeras comparten una base montada entera (0001–0087); las del
final (los escenarios) la vuelven a montar a su manera, por eso van al final.
"""

from __future__ import annotations

import os
import re
import uuid

import pytest

from app.modules.services import states
from app.modules.services.models import (
    ServiceProviderApplication,
    ServiceProviderApplicationEvent,
)
from tests.test_migraciones_reales import MIGRACIONES, PROLOGO, exigir_url_desechable

ARCHIVO = MIGRACIONES / "0087_servicios_retirada.sql"
ANTERIOR = MIGRACIONES / "0086_servicios_admision.sql"
URL = os.environ.get("MIGRACIONES_DATABASE_URL", "").strip()
SIN_POSTGRES = pytest.mark.skipif(
    not URL,
    reason=(
        "sin PostgreSQL desechable: define MIGRACIONES_DATABASE_URL "
        "(ver la cabecera de tests/test_migraciones_reales.py)"
    ),
)

#: Lo que la 0087 está AUTORIZADA a sustituir, y nada más.
CHECKS_SUSTITUIDOS = {
    "service_provider_applications_estado",
    "service_provider_applications_enviada_completa",
    "service_provider_application_events_desde",
    "service_provider_application_events_hasta",
    "service_provider_application_events_salto_permitido",
}
CHECK_NUEVO = "service_provider_application_events_retira_el_prestador"
INDICE_SUSTITUIDO = "service_provider_applications_una_viva"
FUNCION_SUSTITUIDA = "service_provider_applications_salto_valido"
FUNCION_NUEVA = "service_provider_application_events_retirada_propia"
SALTOS_DE_RETIRADA = {
    ("draft", "withdrawn"),
    ("submitted", "withdrawn"),
    ("under_review", "withdrawn"),
    ("changes_requested", "withdrawn"),
    ("resubmitted", "withdrawn"),
}


def _sin_comentarios(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql).replace("\r\n", "\n")


SQL = _sin_comentarios(ARCHIVO.read_text(encoding="utf-8"))
SQL_0086 = _sin_comentarios(ANTERIOR.read_text(encoding="utf-8"))


def _pares(texto: str, desde: str, hasta: str) -> set[tuple[str, str]]:
    return set(
        re.findall(
            rf"\({desde}\s*=\s*'([a-z_]+)'\s+and\s+{hasta}\s*=\s*'([a-z_]+)'\)", texto
        )
    )


def _add_check(sql: str, nombre: str) -> str:
    """El cuerpo de `add constraint <nombre> check (...)` hasta su `;`."""
    inicio = re.search(rf"add\s+constraint\s+{nombre}\s+check", sql).end()
    return sql[inicio : sql.index(";", inicio)]


def _check_de_0086(nombre: str) -> str:
    inicio = re.search(rf"constraint\s+{nombre}\s+check", SQL_0086).end()
    # Hasta la coma o el cierre de la tabla que sigue al paréntesis equilibrado.
    nivel, i = 0, inicio
    while True:
        c = SQL_0086[i]
        if c == "(":
            nivel += 1
        elif c == ")":
            nivel -= 1
            if nivel == 0:
                return SQL_0086[inicio : i + 1]
        i += 1


def _estados(texto: str) -> set[str]:
    return set(re.findall(r"'([a-z_]+)'", re.search(r"in\s*\(([^)]*)\)", texto).group(1)))


def _funcion(sql: str, nombre: str) -> str:
    inicio = sql.index(f"function public.{nombre}()")
    return sql[inicio : sql.index("$$;", inicio)]


def _n(texto: str) -> str:
    return re.sub(r"\s+", " ", texto).strip()


# =========================================================================== #
# 1. Estática
# =========================================================================== #
def test_es_la_ultima_y_sigue_a_la_0086() -> None:
    nombres = sorted(p.name for p in MIGRACIONES.glob("*.sql"))
    assert nombres[-1] == ARCHIVO.name
    assert nombres[-2] == ANTERIOR.name


def test_es_una_unica_transaccion() -> None:
    sentencias = [s.strip() for s in SQL.split(";") if s.strip()]
    assert sentencias[0] == "begin"
    assert sentencias[-1] == "commit"
    assert len(re.findall(r"^\s*begin\s*;", SQL, flags=re.M)) == 1
    assert len(re.findall(r"^\s*commit\s*;", SQL, flags=re.M)) == 1
    assert not re.search(r"\brollback\b|\bsavepoint\b", SQL, flags=re.I)


def test_comprueba_la_0086_antes_de_tocar_nada() -> None:
    primera_comprobacion = SQL.index("La 0087 requiere la 0086")
    primer_cambio = min(
        SQL.index(m) for m in ("alter table", "drop index", "create or replace", "create unique index")
    )
    assert primera_comprobacion < primer_cambio
    for nombre in (*CHECKS_SUSTITUIDOS, INDICE_SUSTITUIDO, FUNCION_SUSTITUIDA,
                   "service_provider_applications_saltos"):
        assert nombre in SQL[:primer_cambio], nombre


def test_solo_sustituye_lo_autorizado() -> None:
    quitados = set(re.findall(r"drop\s+constraint\s+if\s+exists\s+([a-z_0-9]+)", SQL))
    anadidos = set(re.findall(r"add\s+constraint\s+([a-z_0-9]+)\s+check", SQL))
    assert quitados == CHECKS_SUSTITUIDOS | {CHECK_NUEVO}
    # Todo lo que se quita vuelve con el MISMO nombre.
    assert anadidos == quitados
    assert set(re.findall(r"drop\s+index\s+if\s+exists\s+public\.([a-z_0-9]+)", SQL)) == {
        INDICE_SUSTITUIDO
    }
    assert set(re.findall(r"create\s+unique\s+index\s+([a-z_0-9]+)", SQL)) == {INDICE_SUSTITUIDO}
    assert set(re.findall(r"create\s+or\s+replace\s+function\s+public\.([a-z_0-9]+)", SQL)) == {
        FUNCION_SUSTITUIDA,
        FUNCION_NUEVA,
    }
    # Solo se quita el disparador NUEVO (para poder reejecutarla); los de la
    # 0086 no se tocan.
    assert set(re.findall(r"drop\s+trigger\s+if\s+exists\s+([a-z_0-9]+)", SQL)) == {FUNCION_NUEVA}
    assert set(re.findall(r"alter\s+table\s+public\.([a-z_0-9]+)", SQL)) == {
        "service_provider_applications",
        "service_provider_application_events",
    }


def test_no_elimina_tablas_columnas_ni_datos_ni_concede_nada() -> None:
    prohibido = (
        r"drop\s+table", r"drop\s+column", r"truncate", r"drop\s+schema", r"drop\s+function",
        r"create\s+table", r"add\s+column", r"insert\s+into", r"delete\s+from",
        r"update\s+public", r"\bgrant\b", r"create\s+policy", r"disable\s+row\s+level",
    )
    for patron in prohibido:
        assert not re.search(patron, SQL, flags=re.I), patron


def test_los_estados_se_amplian_solo_con_withdrawn() -> None:
    antes = _estados(_check_de_0086("service_provider_applications_estado"))
    despues = _estados(_add_check(SQL, "service_provider_applications_estado"))
    assert despues == antes | {"withdrawn"}
    assert despues == set(states.ESTADOS)
    for nombre in ("service_provider_application_events_desde", "service_provider_application_events_hasta"):
        assert _estados(_add_check(SQL, nombre)) == _estados(_check_de_0086(nombre)) | {"withdrawn"}


def test_los_saltos_se_amplian_solo_con_los_de_retirada() -> None:
    antes = _pares(_check_de_0086("service_provider_application_events_salto_permitido"), "from_status", "to_status")
    despues = _pares(_add_check(SQL, "service_provider_application_events_salto_permitido"), "from_status", "to_status")
    assert despues == antes | SALTOS_DE_RETIRADA
    assert "(from_status is null and to_status = 'draft')" in _n(
        _add_check(SQL, "service_provider_application_events_salto_permitido")
    )
    funcion_antes = _funcion(SQL_0086, FUNCION_SUSTITUIDA)
    funcion_despues = _funcion(SQL, FUNCION_SUSTITUIDA)
    assert _pares(funcion_despues, "old.status", "new.status") == (
        _pares(funcion_antes, "old.status", "new.status") | SALTOS_DE_RETIRADA
    )
    # Y conserva lo demás de la función: nacer en borrador y no cambiar de dueño.
    for fragmento in ("nace en borrador", "no cambia de prestador", "if tg_op = 'INSERT'"):
        assert fragmento in funcion_despues


def test_enviada_completa_solo_exceptua_la_retirada() -> None:
    antes = _n(_check_de_0086("service_provider_applications_enviada_completa"))
    despues = _n(_add_check(SQL, "service_provider_applications_enviada_completa"))
    assert despues.replace("status in ('draft', 'withdrawn')", "status = 'draft'") == antes


def test_el_indice_sigue_siendo_unico_y_libera_tambien_la_retirada() -> None:
    definicion = _n(SQL[SQL.index("create unique index service_provider_applications_una_viva") :].split(";")[0])
    assert "on public.service_provider_applications (provider_id)" in definicion
    assert definicion.endswith("where status not in ('rejected', 'withdrawn')")


def test_la_retirada_la_firma_el_prestador() -> None:
    assert _n(_add_check(SQL, CHECK_NUEVO)) == "(to_status <> 'withdrawn' or actor_role = 'provider')"
    cuerpo = _funcion(SQL, FUNCION_NUEVA)
    assert "new.actor_id <> dueno" in cuerpo and "new.actor_id is null" in cuerpo


def test_la_base_efectiva_es_la_del_codigo() -> None:
    """Lo que queda tras la 0087 es exactamente `states` y los modelos."""
    esperado = set(states.TRANSICIONES)
    assert _pares(_add_check(SQL, "service_provider_application_events_salto_permitido"), "from_status", "to_status") == esperado
    assert _pares(_funcion(SQL, FUNCION_SUSTITUIDA), "old.status", "new.status") == esperado
    del_modelo = {c.name: c for c in ServiceProviderApplicationEvent.__table__.constraints if c.name}
    assert _pares(del_modelo["service_provider_application_events_salto_permitido"].sqltext.text,
                  "from_status", "to_status") == esperado
    assert _n(del_modelo[CHECK_NUEVO].sqltext.text) == "to_status <> 'withdrawn' or actor_role = 'provider'"
    solicitud = {c.name: c for c in ServiceProviderApplication.__table__.constraints if c.name}
    assert "status in ('draft', 'withdrawn')" in solicitud[
        "service_provider_applications_enviada_completa"
    ].sqltext.text
    viva = next(i for i in ServiceProviderApplication.__table__.indexes if i.name == INDICE_SUSTITUIDO)
    assert str(viva.dialect_options["postgresql"]["where"]) == "status not in ('rejected', 'withdrawn')"


# =========================================================================== #
# 2. PostgreSQL
# =========================================================================== #
_PAISES = (a + b for a in "ABCDEFGHIJKLMNOPQRSTUVWXY" for b in "ABCDEFGHIJKLMNOPQRSTUVWXYZ")


def _montar(pg, *, hasta: str | None = None) -> None:
    """Base en blanco, prólogo y las migraciones hasta `hasta` (incluida)."""
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


def _hacer(pg, sql: str, *args) -> None:
    with pg.cursor() as cur:
        cur.execute(sql, args or None)


def _falla(pg, sql: str, *args) -> str:
    import psycopg

    with pytest.raises(psycopg.Error) as error:
        with pg.cursor() as cur:
            cur.execute(sql, args or None)
    return str(error.value)


def _persona(pg, rol: str = "user") -> str:
    ident = str(uuid.uuid4())
    _hacer(
        pg,
        "insert into auth.users (id, email, raw_user_meta_data) values "
        "(%s, %s, jsonb_build_object('full_name','P','username',cast(%s as text)))",
        ident, f"r-{ident[:8]}@x.test", f"r{ident[:8]}",
    )
    _hacer(pg, "update public.profiles set role = %s where id = %s", rol, ident)
    return ident


def _politica(pg, admin: str) -> tuple[str, str]:
    import hashlib

    texto = "Condiciones del prestador de Z Servicios para pruebas. " * 2
    huella = hashlib.sha256(texto.encode()).hexdigest()
    ident = _uno(
        pg,
        "insert into service_policies (kind, country_code, version, status, title, body, "
        "body_sha256, effective_at, published_at, published_by) values ('provider_terms', %s, 1, "
        "'published', 'Condiciones', %s, %s, now(), now(), %s) returning id",
        next(_PAISES), texto, huella, admin,
    )
    return ident, huella


def _postulacion(pg) -> tuple[str, str, str]:
    """(perfil, prestador, postulación en borrador)."""
    perfil = _persona(pg)
    prestador = _uno(
        pg,
        "insert into service_providers (profile_id, provider_type, display_name) "
        "values (%s, 'individual', 'Prestador de prueba') returning id",
        perfil,
    )
    solicitud = _uno(
        pg, "insert into service_provider_applications (provider_id) values (%s) returning id",
        prestador,
    )
    _hacer(
        pg,
        "insert into service_provider_application_events (application_id, to_status, actor_id, "
        "actor_role) values (%s, 'draft', %s, 'provider')",
        solicitud, perfil,
    )
    return perfil, prestador, solicitud


#: Cómo se llega a cada estado por saltos válidos.
CAMINOS = {
    "draft": [],
    "submitted": ["submitted"],
    "under_review": ["submitted", "under_review"],
    "changes_requested": ["submitted", "under_review", "changes_requested"],
    "resubmitted": ["submitted", "under_review", "changes_requested", "resubmitted"],
    "approved": ["submitted", "under_review", "approved"],
    "rejected": ["submitted", "under_review", "rejected"],
    "suspended": ["submitted", "under_review", "approved", "suspended"],
}


def _llevar(pg, solicitud: str, estado: str, *, admin: str, politica: tuple[str, str]) -> None:
    for paso in CAMINOS[estado]:
        if paso == "submitted":
            _hacer(
                pg,
                "update service_provider_applications set status = 'submitted', summary = %s, "
                "terms_policy_id = %s, terms_sha256 = %s, terms_accepted_at = now(), "
                "truthfulness_declared_at = now(), submitted_at = now(), last_submitted_at = now() "
                "where id = %s",
                "Resumen suficientemente largo del servicio.", politica[0], politica[1], solicitud,
            )
        elif paso == "under_review":
            _hacer(pg, "update service_provider_applications set status = 'under_review', "
                       "review_started_at = now() where id = %s", solicitud)
        elif paso == "changes_requested":
            _hacer(pg, "update service_provider_applications set status = 'changes_requested', "
                       "applicant_message = 'Falta el documento de identidad.' where id = %s", solicitud)
        elif paso == "resubmitted":
            _hacer(pg, "update service_provider_applications set status = 'resubmitted', "
                       "last_submitted_at = now() where id = %s", solicitud)
        elif paso == "approved":
            _hacer(pg, "update service_provider_applications set status = 'approved', "
                       "decided_at = now(), decided_by = %s where id = %s", admin, solicitud)
        elif paso == "rejected":
            _hacer(pg, "update service_provider_applications set status = 'rejected', decided_at = now(), "
                       "decided_by = %s, applicant_message = 'No se pudo verificar.' where id = %s",
                   admin, solicitud)
        elif paso == "suspended":
            _hacer(pg, "update service_provider_applications set status = 'suspended', suspended_at = now(), "
                       "applicant_message = 'Suspensión preventiva.' where id = %s", solicitud)


def _retirar(pg, solicitud: str, perfil: str, desde: str) -> None:
    _hacer(pg, "update service_provider_applications set status = 'withdrawn' where id = %s", solicitud)
    _hacer(
        pg,
        "insert into service_provider_application_events (application_id, from_status, to_status, "
        "actor_id, actor_role, visible_note) values (%s, %s, 'withdrawn', %s, 'provider', %s)",
        solicitud, desde, perfil, "Me retiro por ahora.",
    )


def _foto(pg) -> dict:
    """Las definiciones que la 0087 toca, para comparar antes y después."""
    return {
        "restricciones": sorted(
            (n, d) for n, d in _todas(
                pg,
                "select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid in "
                "('public.service_provider_applications'::regclass, "
                "'public.service_provider_application_events'::regclass)",
            )
        ),
        "indice": _uno(pg, "select indexdef from pg_indexes where indexname = %s", INDICE_SUSTITUIDO),
        "funciones": sorted(_todas(
            pg,
            "select proname, md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace "
            "and proname like 'servic%%'",
        )),
        "disparadores": sorted(_todas(
            pg,
            "select tgname, pg_get_triggerdef(oid) from pg_trigger where not tgisinternal and "
            "tgrelid::regclass::text like 'service\\_%%'",
        )),
    }


def _todas(pg, sql: str, *args) -> list:
    with pg.cursor() as cur:
        cur.execute(sql, args or None)
        return [tuple(f) for f in cur.fetchall()]


# --- 2.1 Sobre la base entera (0001–0087) ---------------------------------- #
@SIN_POSTGRES
def test_desde_cero_queda_la_base_efectiva(completa) -> None:
    pg = completa
    for nombre, tabla in (
        ("service_provider_applications_estado", "service_provider_applications"),
        ("service_provider_application_events_salto_permitido", "service_provider_application_events"),
        (CHECK_NUEVO, "service_provider_application_events"),
    ):
        definicion = _uno(
            pg, "select pg_get_constraintdef(oid) from pg_constraint where conrelid = %s::regclass "
                "and conname = %s", tabla, nombre,
        )
        assert definicion and "withdrawn" in definicion, nombre
    assert "withdrawn" in _uno(pg, "select indexdef from pg_indexes where indexname = %s", INDICE_SUSTITUIDO)
    assert _uno(pg, "select count(*) from pg_trigger where tgname = %s and not tgisinternal", FUNCION_NUEVA) == 1
    for tabla in ("service_provider_applications", "service_provider_application_events"):
        assert _uno(pg, "select relrowsecurity from pg_class where oid = %s::regclass", tabla)
        for rol in ("anon", "authenticated"):
            assert not _uno(pg, "select has_table_privilege(%s, %s, 'select')", rol, f"public.{tabla}")


@SIN_POSTGRES
@pytest.mark.parametrize("desde", sorted(d for d, _ in SALTOS_DE_RETIRADA))
def test_se_retira_desde_cada_estado_permitido_y_libera_el_hueco(completa, desde) -> None:
    pg = completa
    admin = _persona(pg, "admin")
    perfil, prestador, solicitud = _postulacion(pg)
    _llevar(pg, solicitud, desde, admin=admin, politica=_politica(pg, admin))
    documento = _uno(
        pg,
        "insert into service_provider_documents (provider_id, application_id, kind, storage_path, "
        "content_type, byte_size) values (%s, %s, 'identity', %s, 'application/pdf', 100) returning id",
        prestador, solicitud, f"{perfil}/{solicitud}/dni.pdf",
    )
    _hacer(
        pg,
        "insert into service_provider_credentials (provider_id, application_id, kind, title, issuer, "
        "evidence_document_id) values (%s, %s, 'certification', 'Curso', 'Instituto', %s)",
        prestador, solicitud, documento,
    )
    eventos_antes = _uno(
        pg, "select count(*) from service_provider_application_events where application_id = %s", solicitud
    )

    _retirar(pg, solicitud, perfil, desde)

    assert _uno(pg, "select status from service_provider_applications where id = %s", solicitud) == "withdrawn"
    # Conserva documentos, credenciales e historial (y añade su propio evento).
    assert _uno(pg, "select count(*) from service_provider_documents where application_id = %s", solicitud) == 1
    assert _uno(pg, "select count(*) from service_provider_credentials where application_id = %s", solicitud) == 1
    assert _uno(
        pg, "select count(*) from service_provider_application_events where application_id = %s", solicitud
    ) == eventos_antes + 1
    # Libera el hueco: nace otra, VACÍA (sin la política de la anterior).
    nueva = _uno(
        pg, "insert into service_provider_applications (provider_id) values (%s) returning id", prestador
    )
    assert _uno(
        pg, "select terms_policy_id is null and summary is null from service_provider_applications "
            "where id = %s", nueva,
    )
    # Pero sigue habiendo UNA sola viva.
    assert "una_viva" in _falla(
        pg, "insert into service_provider_applications (provider_id) values (%s)", prestador
    )


@SIN_POSTGRES
@pytest.mark.parametrize("desde", ["approved", "rejected", "suspended"])
def test_no_se_retira_despues_de_la_decision(completa, desde) -> None:
    pg = completa
    admin = _persona(pg, "admin")
    perfil, _, solicitud = _postulacion(pg)
    _llevar(pg, solicitud, desde, admin=admin, politica=_politica(pg, admin))
    assert "no puede pasar a" in _falla(
        pg, "update service_provider_applications set status = 'withdrawn' where id = %s", solicitud
    )
    assert "salto_permitido" in _falla(
        pg,
        "insert into service_provider_application_events (application_id, from_status, to_status, "
        "actor_id, actor_role) values (%s, %s, 'withdrawn', %s, 'provider')",
        solicitud, desde, perfil,
    )


@SIN_POSTGRES
def test_retirada_es_final(completa) -> None:
    pg = completa
    perfil, _, solicitud = _postulacion(pg)
    _retirar(pg, solicitud, perfil, "draft")
    for hacia in ("draft", "submitted", "under_review", "withdrawn_otra_vez"):
        _falla(pg, "update service_provider_applications set status = %s where id = %s", hacia, solicitud)
    assert "salto_permitido" in _falla(
        pg,
        "insert into service_provider_application_events (application_id, from_status, to_status, "
        "actor_id, actor_role) values (%s, 'withdrawn', 'submitted', %s, 'provider')",
        solicitud, perfil,
    )


@SIN_POSTGRES
def test_solo_el_prestador_dueno_firma_su_retirada(completa) -> None:
    pg = completa
    admin = _persona(pg, "admin")
    otro = _persona(pg)
    perfil, _, solicitud = _postulacion(pg)
    base = (
        "insert into service_provider_application_events (application_id, from_status, to_status, "
        "actor_id, actor_role) values (%s, 'draft', 'withdrawn', %s, %s)"
    )
    # Administración no retira en nombre del prestador: ni ajeno ni como dueño.
    # (Los disparadores se ejecutan antes que los CHECK; cualquiera de las dos
    # barreras vale, y el CHECK se demuestra solo más abajo.)
    barreras = (CHECK_NUEVO, "Solo quien postula", "su propia admisión")
    for actor, rol in ((admin, "admin"), (admin, "reviewer"), (None, "system"), (perfil, "admin")):
        assert any(b in _falla(pg, base, solicitud, actor, rol) for b in barreras), rol
    # Firmar como prestador no basta: tiene que ser EL DUEÑO.
    assert "Solo quien postula" in _falla(pg, base, solicitud, otro, "provider")
    assert "Solo quien postula" in _falla(pg, base, solicitud, admin, "provider")
    assert "Solo quien postula" in _falla(pg, base, solicitud, None, "provider")
    _hacer(pg, base, solicitud, perfil, "provider")


@SIN_POSTGRES
def test_el_check_de_retirada_funciona_por_si_solo(completa) -> None:
    """Sin los disparadores (dentro de una transacción que se deshace), el
    CHECK sigue impidiendo que Z firme una retirada."""
    pg = completa
    perfil, _, solicitud = _postulacion(pg)
    _hacer(pg, "begin")
    try:
        _hacer(pg, "alter table public.service_provider_application_events disable trigger user")
        mensaje = _falla(
            pg,
            "insert into service_provider_application_events (application_id, from_status, "
            "to_status, actor_id, actor_role) values (%s, 'draft', 'withdrawn', %s, 'admin')",
            solicitud, perfil,
        )
        assert CHECK_NUEVO in mensaje
    finally:
        _hacer(pg, "rollback")
    assert _uno(
        pg, "select count(*) from pg_trigger where tgrelid = "
            "'public.service_provider_application_events'::regclass and not tgisinternal "
            "and tgenabled = 'D'",
    ) == 0


@SIN_POSTGRES
def test_las_protecciones_de_la_0086_siguen_en_pie(completa) -> None:
    pg = completa
    admin = _persona(pg, "admin")
    perfil, prestador, solicitud = _postulacion(pg)
    # Atajos y estados incompletos.
    assert "no puede pasar a" in _falla(
        pg, "update service_provider_applications set status = 'under_review', "
            "review_started_at = now() where id = %s", solicitud,
    )
    assert "enviada_completa" in _falla(
        pg, "update service_provider_applications set status = 'submitted' where id = %s", solicitud
    )
    # Dos vivas.
    assert "una_viva" in _falla(
        pg, "insert into service_provider_applications (provider_id) values (%s)", prestador
    )
    # Rechazar sin motivo y decidir lo propio.
    politica = _politica(pg, admin)
    _llevar(pg, solicitud, "under_review", admin=admin, politica=politica)
    assert "con_motivo" in _falla(
        pg, "update service_provider_applications set status = 'rejected', decided_at = now(), "
            "decided_by = %s where id = %s", admin, solicitud,
    )
    assert "su propia admisión" in _falla(
        pg, "update service_provider_applications set status = 'approved', decided_at = now(), "
            "decided_by = %s where id = %s", perfil, solicitud,
    )
    # El historial sigue sin reescribirse.
    assert "solo se añade" in _falla(
        pg, "update service_provider_application_events set visible_note = 'x y z' "
            "where application_id = %s", solicitud,
    )


# --- 2.2 Escenarios: rehacen la base (van al final) ------------------------- #
@SIN_POSTGRES
def test_sobre_una_base_con_la_0086_y_datos_no_toca_ninguna_fila(pg) -> None:
    _montar(pg, hasta="0086")
    admin = _persona(pg, "admin")
    politica = _politica(pg, admin)
    creadas = {}
    for estado in CAMINOS:
        _, _, solicitud = _postulacion(pg)
        _llevar(pg, solicitud, estado, admin=admin, politica=politica)
        creadas[str(solicitud)] = estado
    antes = dict(_todas(pg, "select id::text, status from service_provider_applications"))
    filas_antes = {
        t: _uno(pg, f"select count(*) from {t}")
        for t in ("service_providers", "service_provider_applications", "service_provider_application_events")
    }
    assert "withdrawn" not in _uno(pg, "select indexdef from pg_indexes where indexname = %s", INDICE_SUSTITUIDO)

    _hacer(pg, ARCHIVO.read_text(encoding="utf-8"))

    assert dict(_todas(pg, "select id::text, status from service_provider_applications")) == antes
    assert antes == creadas
    for tabla, n in filas_antes.items():
        assert _uno(pg, f"select count(*) from {tabla}") == n, tabla
    # Las restricciones sustituidas quedan VALIDADAS contra los datos que ya había.
    assert not _todas(
        pg,
        "select conname from pg_constraint where conname = any(%s) and not convalidated",
        list(CHECKS_SUSTITUIDOS | {CHECK_NUEVO}),
    )
    # Y la retirada ya funciona sobre esos datos.
    en_revision = next(s for s, e in creadas.items() if e == "under_review")
    perfil = _uno(
        pg, "select p.profile_id::text from service_provider_applications a join service_providers p "
            "on p.id = a.provider_id where a.id = %s", en_revision,
    )
    _retirar(pg, en_revision, perfil, "under_review")


@SIN_POSTGRES
def test_reejecutarla_deja_exactamente_lo_mismo(pg) -> None:
    _montar(pg)
    antes = _foto(pg)
    _hacer(pg, ARCHIVO.read_text(encoding="utf-8"))
    _hacer(pg, ARCHIVO.read_text(encoding="utf-8"))
    assert _foto(pg) == antes


@SIN_POSTGRES
def test_es_todo_o_nada(pg) -> None:
    """Un fallo a mitad no deja nada sustituido: la base sigue como con la 0086."""
    _montar(pg, hasta="0086")
    antes = _foto(pg)
    texto = ARCHIVO.read_text(encoding="utf-8").replace("\r\n", "\n")
    cuerpo, _, cola = texto.rpartition("\ncommit;")
    assert cola.strip() == ""
    con_fallo = cuerpo + "\nselect 1 / 0;\ncommit;\n"
    _falla(pg, con_fallo)
    _hacer(pg, "rollback")
    assert _foto(pg) == antes
    assert not _uno(pg, "select count(*) from pg_proc where proname = %s", FUNCION_NUEVA)


@SIN_POSTGRES
def test_sin_la_0086_se_detiene_sin_tocar_nada(pg) -> None:
    _montar(pg, hasta="0085")
    assert "La 0087 requiere la 0086" in _falla(pg, ARCHIVO.read_text(encoding="utf-8"))
    _hacer(pg, "rollback")
    assert not _uno(pg, "select count(*) from pg_proc where proname = %s", FUNCION_NUEVA)
    assert not _uno(
        pg, "select count(*) from information_schema.tables where table_name like 'service\\_%%'"
    )


@SIN_POSTGRES
@pytest.mark.parametrize(
    ("quitar", "nombre"),
    [
        (
            "alter table public.service_provider_applications "
            "drop constraint service_provider_applications_enviada_completa",
            "service_provider_applications_enviada_completa",
        ),
        (
            "drop index public.service_provider_applications_una_viva",
            "service_provider_applications_una_viva",
        ),
    ],
)
def test_si_falta_un_objeto_esperado_se_detiene_y_lo_nombra(pg, quitar, nombre) -> None:
    """Una 0086 incompleta no se «completa» por accidente: la 0087 se para,
    dice qué falta y no sustituye nada."""
    _montar(pg, hasta="0086")
    _hacer(pg, quitar)
    antes = _foto(pg)
    mensaje = _falla(pg, ARCHIVO.read_text(encoding="utf-8"))
    _hacer(pg, "rollback")
    assert "La 0087 requiere la 0086" in mensaje and nombre in mensaje
    assert _foto(pg) == antes
