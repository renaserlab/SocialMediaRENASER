"""Z Servicios, Bloque 1A: la migración 0086 contra el código y contra PostgreSQL.

DOS MITADES:

  * ESTÁTICA (corre siempre): la 0086 es aditiva, no trae nada de reservas ni
    dinero, activa RLS y cierra privilegios en todas sus tablas, y el SQL y los
    modelos dicen lo mismo —tablas, columnas y cada CHECK con su nombre—.

    LA 0086 ES HISTÓRICA: está aplicada en Supabase (verificada el 28/09/2026)
    y no se edita. Sus propias definiciones son las del Bloque 1A, con ocho
    estados; la 0087 amplía cinco CHECK, la función de saltos y un índice para
    `withdrawn`, y la 0088 AÑADE columnas, restricciones e índices (ciclo de
    vida de la evidencia) y una tabla nueva. Los modelos reflejan la base
    EFECTIVA (0086 + las posteriores), y eso es lo que se compara aquí: lo de
    la 0086 más lo que las posteriores le añaden a SUS tablas. Lo que cada una
    cambia se prueba en su fichero.
  * POSTGRESQL (con `MIGRACIONES_DATABASE_URL`): desde cero con todas las
    anteriores, y lo que SQLite no puede probar: claves ajenas, índices
    parciales, disparadores, RLS, privilegios, el historial que solo se añade,
    que nadie se admite a sí mismo y que borrar la cuenta sigue funcionando.

Sin PostgreSQL la segunda mitad se OMITE; el CI la ejecuta con la base
desechable y exige que ninguna quede omitida.
"""

from __future__ import annotations

import os
import re
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.modules.services import states
from app.modules.services.models import (
    ServicePolicy,
    ServiceProvider,
    ServiceProviderApplication,
    ServiceProviderApplicationEvent,
    ServiceProviderCredential,
    ServiceProviderDocument,
)
from tests.test_migraciones_reales import MIGRACIONES, PROLOGO, exigir_url_desechable

ARCHIVO = MIGRACIONES / "0086_servicios_admision.sql"
URL = os.environ.get("MIGRACIONES_DATABASE_URL", "").strip()
SIN_POSTGRES = pytest.mark.skipif(
    not URL,
    reason=(
        "sin PostgreSQL desechable: define MIGRACIONES_DATABASE_URL "
        "(ver la cabecera de tests/test_migraciones_reales.py)"
    ),
)

MODELOS = {
    m.__tablename__: m
    for m in (
        ServicePolicy,
        ServiceProvider,
        ServiceProviderApplication,
        ServiceProviderDocument,
        ServiceProviderCredential,
        ServiceProviderApplicationEvent,
    )
}


def _sin_comentarios(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


SQL = _sin_comentarios(ARCHIVO.read_text(encoding="utf-8")).replace("\r\n", "\n")


def _bloques() -> dict[str, str]:
    """`tabla -> cuerpo del create table`."""
    return {
        m.group(1): m.group(2)
        for m in re.finditer(
            r"create\s+table\s+if\s+not\s+exists\s+public\.([a-z_0-9]+)\s*\((.*?)\n\);",
            SQL,
            flags=re.S,
        )
    }


def _partes(cuerpo: str) -> list[str]:
    """Separa por comas de primer nivel (las de dentro de un paréntesis no)."""
    partes, nivel, actual = [], 0, []
    for caracter in cuerpo:
        if caracter == "(":
            nivel += 1
        elif caracter == ")":
            nivel -= 1
        if caracter == "," and nivel == 0:
            partes.append("".join(actual).strip())
            actual = []
        else:
            actual.append(caracter)
    if "".join(actual).strip():
        partes.append("".join(actual).strip())
    return partes


def _pares(texto: str, desde: str, hasta: str) -> set[tuple[str, str]]:
    return set(
        re.findall(
            rf"\({desde}\s*=\s*'([a-z_]+)'\s+and\s+{hasta}\s*=\s*'([a-z_]+)'\)", texto
        )
    )


# =========================================================================== #
# 1. Estática: aditiva, cerrada y alineada con los modelos
# =========================================================================== #
def test_esta_entre_la_0085_y_la_0087() -> None:
    nombres = sorted(p.name for p in MIGRACIONES.glob("*.sql"))
    posicion = nombres.index("0086_servicios_admision.sql")
    assert nombres[posicion - 1].startswith("0085_")
    assert nombres[posicion + 1].startswith("0087_")


def test_la_0086_no_ha_cambiado_desde_que_se_aplico() -> None:
    """Aplicada en Supabase y verificada sin divergencias el 28/09/2026. Si
    esta huella cambia, alguien editó una migración histórica: lo que haga
    falta va en una migración nueva."""
    import hashlib

    contenido = ARCHIVO.read_bytes().replace(b"\r\n", b"\n")
    cabecera = f"blob {len(contenido)}\0".encode()
    assert hashlib.sha1(cabecera + contenido).hexdigest() == (
        "882084132e161d143ff69707ad3f92b7cd68eedb"
    )


def test_es_aditiva_y_no_toca_nada_existente() -> None:
    assert not re.search(
        r"\b(drop\s+table|drop\s+column|truncate|drop\s+schema|drop\s+index|rename)\b",
        SQL,
        flags=re.I,
    )
    # Solo altera tablas que ella misma crea, y solo para activar RLS.
    alteradas = set(re.findall(r"alter\s+table\s+public\.([a-z_0-9]+)", SQL))
    assert alteradas == set(MODELOS)
    assert not re.search(r"alter\s+table\s+public\.[a-z_0-9]+\s+(add|drop|alter)\b", SQL)
    # Ni una sola escritura sobre filas existentes.
    assert not re.search(r"\b(insert\s+into|update\s+public|delete\s+from)\b", SQL, flags=re.I)


def test_solo_trae_la_base_de_admision() -> None:
    creadas = set(_bloques())
    assert creadas == set(MODELOS)
    prohibidas = (
        "booking", "slot", "hold", "availability", "schedule", "capacity",
        "payment", "refund", "payout", "transfer", "balance", "review",
        "incident", "attendance", "catalog", "variant",
    )
    for tabla in creadas:
        assert not any(p in tabla for p in prohibidas), tabla


def test_todas_sus_tablas_tienen_rls_sin_politicas_ni_privilegios() -> None:
    for tabla in MODELOS:
        assert re.search(
            rf"alter\s+table\s+public\.{tabla}\s+enable\s+row\s+level\s+security", SQL
        ), tabla
        assert re.search(
            rf"revoke\s+all\s+on\s+public\.{tabla}\s+from\s+anon,\s*authenticated", SQL
        ), tabla
    assert not re.search(r"\bcreate\s+policy\b", SQL, flags=re.I)
    assert not re.search(r"\bgrant\b", SQL, flags=re.I)


def test_los_modelos_tienen_las_mismas_columnas_que_el_sql() -> None:
    for tabla, cuerpo in _bloques().items():
        del_sql = set()
        for parte in _partes(cuerpo):
            nombre = re.match(r"^([a-z_][a-z_0-9]*)\s+[a-z]", parte)
            if nombre and nombre.group(1) not in {"constraint", "primary", "unique", "check", "foreign"}:
                del_sql.add(nombre.group(1))
        del_sql |= _columnas_anadidas_despues(tabla)
        del_modelo = {c.name for c in MODELOS[tabla].__table__.columns}
        assert del_sql == del_modelo, (tabla, del_sql ^ del_modelo)


def _posteriores() -> str:
    """El SQL, sin comentarios, de las migraciones POSTERIORES a la 0086."""
    return "\n".join(
        _sin_comentarios(ruta.read_text(encoding="utf-8")).replace("\r\n", "\n")
        for ruta in sorted(MIGRACIONES.glob("*.sql"))
        if ruta.name > ARCHIVO.name
    )


def _anadidos_despues(tabla: str, clase: str = r"check") -> set[str]:
    """Las restricciones que las migraciones POSTERIORES añaden o sustituyen en
    esa tabla (`alter table ... add constraint X check|unique|foreign key`)."""
    return set(
        re.findall(
            rf"alter\s+table\s+public\.{tabla}\s+add\s+constraint\s+([a-z_0-9]+)\s+(?:{clase})",
            _posteriores(),
        )
    )


def _columnas_anadidas_despues(tabla: str) -> set[str]:
    """`alter table public.X add column if not exists Y` de las posteriores."""
    return set(
        re.findall(
            rf"alter\s+table\s+public\.{tabla}\s+add\s+column\s+if\s+not\s+exists\s+([a-z_0-9]+)\s",
            _posteriores(),
        )
    )


def _indices_anadidos_despues() -> set[str]:
    """Los índices que las posteriores crean sobre las tablas de la 0086."""
    return {
        nombre
        for nombre, tabla in re.findall(
            r"create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?([a-z_0-9]+)\s+on\s+public\.([a-z_0-9]+)",
            _posteriores(),
        )
        if tabla in MODELOS
    }


def test_las_posteriores_solo_anaden_a_las_tablas_de_la_0086() -> None:
    """Ninguna migración posterior borra una columna, una tabla o un índice de
    la 0086: si lo hiciera, la comparación de abajo lo escondería."""
    posteriores = _posteriores()
    for tabla in MODELOS:
        assert not re.search(
            rf"alter\s+table\s+public\.{tabla}\s+(?:drop\s+column|rename|alter\s+column)",
            posteriores,
        ), tabla
        assert not re.search(rf"drop\s+table\s+(?:if\s+exists\s+)?public\.{tabla}\b", posteriores)
    assert _columnas_anadidas_despues("service_provider_documents") == {
        "lifecycle", "lifecycle_changed_at", "replaced_by",
    }


def test_cada_check_con_nombre_esta_en_los_dos_sitios() -> None:
    for tabla, cuerpo in _bloques().items():
        del_sql = set(re.findall(r"constraint\s+([a-z_0-9]+)\s+check", cuerpo))
        del_sql |= _anadidos_despues(tabla)
        del_modelo = {
            c.name
            for c in MODELOS[tabla].__table__.constraints
            if type(c).__name__ == "CheckConstraint"
        }
        assert del_sql == del_modelo, (tabla, del_sql ^ del_modelo)


def test_las_restricciones_unicas_y_ajenas_con_nombre_estan_en_los_dos_sitios() -> None:
    for tabla, cuerpo in _bloques().items():
        del_sql = set(re.findall(r"constraint\s+([a-z_0-9]+)\s+(?:unique|foreign\s+key)", cuerpo))
        del_sql |= _anadidos_despues(tabla, r"unique|foreign\s+key")
        del_modelo = {
            c.name
            for c in MODELOS[tabla].__table__.constraints
            if type(c).__name__ in ("UniqueConstraint", "ForeignKeyConstraint") and c.name
        }
        assert del_sql == del_modelo, (tabla, del_sql ^ del_modelo)


def test_los_indices_con_nombre_estan_en_los_dos_sitios() -> None:
    del_sql = set(re.findall(r"create\s+(?:unique\s+)?index\s+if\s+not\s+exists\s+([a-z_0-9]+)", SQL))
    del_sql |= _indices_anadidos_despues()
    del_modelo = {i.name for m in MODELOS.values() for i in m.__table__.indexes}
    assert del_sql == del_modelo, del_sql ^ del_modelo


def test_el_mapa_de_la_0086_es_el_del_bloque_1a() -> None:
    """Los nueve saltos de entonces: el mapa de hoy sin los de la retirada."""
    esperado = {k for k in states.TRANSICIONES if k[1] != states.RETIRADA}
    assert len(esperado) == 9
    historial = _bloques()["service_provider_application_events"]
    assert _pares(historial, "from_status", "to_status") == esperado
    disparador = SQL[SQL.index("service_provider_applications_salto_valido()") :]
    disparador = disparador[: disparador.index("$$;")]
    assert _pares(disparador, "old.status", "new.status") == esperado


def test_los_ocho_estados_de_la_0086() -> None:
    cuerpo = _bloques()["service_provider_applications"]
    estados = re.search(r"status\s+in\s*\(([^)]*)\)", cuerpo).group(1)
    assert set(re.findall(r"'([a-z_]+)'", estados)) == set(states.ESTADOS) - {
        states.RETIRADA
    }


def test_no_siembra_ninguna_politica_ni_crea_depositos() -> None:
    assert "service_policies" in SQL
    assert not re.search(r"insert\s+into", SQL, flags=re.I)
    assert "storage.buckets" not in SQL


# =========================================================================== #
# 2. PostgreSQL real
# =========================================================================== #
@pytest.fixture(scope="module")
def pg():
    psycopg = pytest.importorskip("psycopg")
    if not URL:
        pytest.skip("sin PostgreSQL desechable")
    exigir_url_desechable(URL, os.environ.get("DATABASE_URL", ""))
    with psycopg.connect(URL, autocommit=True) as conexion:
        with conexion.cursor() as cur:
            cur.execute("drop schema if exists public cascade")
            cur.execute("drop schema if exists auth cascade")
            cur.execute("drop schema if exists storage cascade")
            cur.execute("create schema public")
            cur.execute(PROLOGO.read_text(encoding="utf-8"))
        for ruta in sorted(MIGRACIONES.glob("*.sql")):
            with conexion.cursor() as cur:
                cur.execute(ruta.read_text(encoding="utf-8"))
        yield conexion


def _uno(pg, sql: str, *args):
    with pg.cursor() as cur:
        cur.execute(sql, args or None)
        fila = cur.fetchone()
    return fila[0] if fila else None


def _todos(pg, sql: str, *args) -> list:
    with pg.cursor() as cur:
        cur.execute(sql, args or None)
        return cur.fetchall()


def _falla(pg, sql: str, *args) -> str:
    import psycopg

    with pytest.raises(psycopg.Error) as error:
        with pg.cursor() as cur:
            cur.execute(sql, args or None)
    return str(error.value)


def _persona(pg, rol: str = "user") -> str:
    ident = str(uuid.uuid4())
    with pg.cursor() as cur:
        cur.execute(
            "insert into auth.users (id, email, raw_user_meta_data) values "
            "(%s, %s, jsonb_build_object('full_name','P','username',cast(%s as text)))",
            (ident, f"s-{ident[:8]}@x.test", f"s{ident[:8]}"),
        )
        cur.execute("update public.profiles set role = %s where id = %s", (rol, ident))
    return ident


def _prestador(pg, perfil: str) -> str:
    return _uno(
        pg,
        "insert into service_providers (profile_id, provider_type, display_name) "
        "values (%s, 'individual', 'Prestador de prueba') returning id",
        perfil,
    )


#: Un país distinto por política: dos publicadas del mismo país chocarían con
#: `service_policies_una_publicada`. Los que empiezan por Z los usan las
#: pruebas que eligen el suyo.
_PAISES = (a + b for a in "ABCDEFGHIJKLMNOPQRSTUVWXY" for b in "ABCDEFGHIJKLMNOPQRSTUVWXYZ")


def _politica(pg, admin: str, pais: str | None = None) -> tuple[str, str]:
    import hashlib

    texto = "Condiciones del prestador de Z Servicios para pruebas. " * 2
    huella = hashlib.sha256(texto.encode()).hexdigest()
    pais = pais or next(_PAISES)
    ident = _uno(
        pg,
        "insert into service_policies (kind, country_code, version, status, title, "
        "body, body_sha256, effective_at, published_at, published_by) values "
        "('provider_terms', %s, 1, 'published', 'Condiciones', %s, %s, now(), now(), %s) "
        "returning id",
        pais,
        texto,
        huella,
        admin,
    )
    return ident, huella


def _enviar(pg, solicitud: str, politica: tuple[str, str]) -> None:
    with pg.cursor() as cur:
        cur.execute(
            "update service_provider_applications set status = 'submitted', "
            "summary = %s, terms_policy_id = %s, terms_sha256 = %s, "
            "terms_accepted_at = now(), truthfulness_declared_at = now(), "
            "submitted_at = now(), last_submitted_at = now() where id = %s",
            ("Resumen suficientemente largo del servicio.", politica[0], politica[1], solicitud),
        )


@SIN_POSTGRES
def test_aplica_desde_cero_con_todas_las_anteriores_y_se_reejecuta(pg) -> None:
    tablas = {f[0] for f in _todos(
        pg,
        "select table_name from information_schema.tables where table_schema = 'public' "
        "and table_name like 'service\\_%%'",
    )}
    # Las seis de la 0086 y la de los envíos congelados (0088).
    assert tablas == set(MODELOS) | {"service_provider_application_submissions"}
    # Reejecutar la 0086 sobre una base que ya tiene la 0087 le devuelve su
    # función de saltos de ocho estados: por eso la 0087 dice que, si pasa,
    # hay que volver a ejecutarla (y la 0088 después). Se comprueba el
    # procedimiento entero.
    with pg.cursor() as cur:
        cur.execute(ARCHIVO.read_text(encoding="utf-8"))
        cur.execute(ARCHIVO.read_text(encoding="utf-8"))
        cur.execute((MIGRACIONES / "0087_servicios_retirada.sql").read_text(encoding="utf-8"))
        cur.execute(
            (MIGRACIONES / "0088_servicios_documentos_y_envios.sql").read_text(encoding="utf-8")
        )
    assert "withdrawn" in _uno(
        pg,
        "select pg_get_functiondef('public.service_provider_applications_salto_valido()'::regprocedure)",
    )


@SIN_POSTGRES
def test_columnas_de_la_base_y_de_los_modelos_coinciden(pg) -> None:
    for tabla, modelo in MODELOS.items():
        reales = {f[0] for f in _todos(
            pg,
            "select column_name from information_schema.columns "
            "where table_schema = 'public' and table_name = %s",
            tabla,
        )}
        assert reales == {c.name for c in modelo.__table__.columns}, tabla


@SIN_POSTGRES
def test_fechas_en_utc_y_claves_uuid(pg) -> None:
    for tabla in MODELOS:
        for columna, tipo in _todos(
            pg,
            "select column_name, data_type from information_schema.columns "
            "where table_schema = 'public' and table_name = %s",
            tabla,
        ):
            if columna.endswith("_at"):
                assert tipo == "timestamp with time zone", (tabla, columna)
            # `tax_id` es el RUC: texto, no un identificador interno.
            if columna != "tax_id" and (
                columna == "id" or columna.endswith("_id") or columna.endswith("_by")
            ):
                assert tipo == "uuid", (tabla, columna)


@SIN_POSTGRES
def test_claves_ajenas_y_su_comportamiento_al_borrar(pg) -> None:
    filas = _todos(
        pg,
        """
        select c.conrelid::regclass::text, c.confrelid::regclass::text, c.confdeltype
          from pg_constraint c
         where c.contype = 'f'
           and c.conrelid::regclass::text like 'service\\_%%'
        """,
    )
    ajenas = {(de, a, borrar) for de, a, borrar in filas}
    # a = no action, r = restrict, c = cascade
    esperadas = {
        ("service_providers", "profiles", "c"),
        ("service_provider_applications", "service_providers", "c"),
        ("service_provider_applications", "service_policies", "r"),
        ("service_provider_documents", "service_providers", "c"),
        ("service_provider_documents", "service_provider_applications", "c"),
        ("service_provider_credentials", "service_providers", "c"),
        ("service_provider_credentials", "service_provider_applications", "c"),
        ("service_provider_credentials", "service_provider_documents", "c"),
        ("service_provider_application_events", "service_provider_applications", "c"),
        # 0088: el reemplazo es un documento de la misma persona, y el envío
        # congelado cuelga de su postulación y apunta a la versión aceptada.
        ("service_provider_documents", "service_provider_documents", "c"),
        ("service_provider_application_submissions", "service_provider_applications", "c"),
        ("service_provider_application_submissions", "service_policies", "r"),
    }
    assert ajenas == esperadas
    # Quién actuó NO tiene clave ajena: un `set null` sería reescribir historia.
    for tabla, columna in (
        ("service_provider_application_events", "actor_id"),
        ("service_provider_applications", "decided_by"),
        ("service_provider_documents", "reviewed_by"),
        ("service_provider_credentials", "verified_by"),
        ("service_policies", "published_by"),
    ):
        assert not _todos(
            pg,
            """
            select 1 from pg_constraint c
              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
             where c.contype = 'f' and c.conrelid = %s::regclass and a.attname = %s
            """,
            tabla,
            columna,
        ), (tabla, columna)


@SIN_POSTGRES
def test_los_checks_y_los_indices_parciales_existen(pg) -> None:
    for tabla, modelo in MODELOS.items():
        checks = {f[0] for f in _todos(
            pg,
            "select conname from pg_constraint where contype = 'c' and conrelid = %s::regclass",
            tabla,
        )}
        del_modelo = {
            c.name for c in modelo.__table__.constraints if type(c).__name__ == "CheckConstraint"
        }
        assert del_modelo <= checks, (tabla, del_modelo - checks)
    parciales = dict(_todos(
        pg,
        "select indexname, indexdef from pg_indexes where schemaname = 'public' "
        "and indexname in ('service_provider_applications_una_viva', "
        "'service_policies_una_publicada', 'service_provider_credentials_una_por_clave', "
        "'service_provider_application_events_una_por_clave')",
    ))
    assert len(parciales) == 4
    assert all("UNIQUE" in d and "WHERE" in d for d in parciales.values())


@SIN_POSTGRES
def test_rls_activa_cero_politicas_y_cero_privilegios(pg) -> None:
    for tabla in MODELOS:
        assert _uno(pg, "select relrowsecurity from pg_class where oid = %s::regclass", tabla)
        assert not _uno(pg, "select count(*) from pg_policies where tablename = %s", tabla)
        for rol in ("anon", "authenticated"):
            for privilegio in ("select", "insert", "update", "delete"):
                assert not _uno(
                    pg, "select has_table_privilege(%s, %s, %s)", rol, f"public.{tabla}", privilegio
                ), (rol, tabla, privilegio)


@SIN_POSTGRES
def test_estados_validos_y_nacimiento_en_borrador(pg) -> None:
    prestador = _prestador(pg, _persona(pg))
    # Un estado inventado no entra: lo para el disparador de nacimiento, y
    # detrás está el CHECK de la columna (defensa en profundidad).
    _falla(
        pg,
        "insert into service_provider_applications (provider_id, status) values (%s, 'aprobada')",
        prestador,
    )
    solicitud = _uno(
        pg, "insert into service_provider_applications (provider_id) values (%s) returning id",
        prestador,
    )
    assert "service_provider_application_events_hasta" in _falla(
        pg,
        "insert into service_provider_application_events (application_id, from_status, "
        "to_status, actor_role) values (%s, 'draft', 'aprobada', 'admin')",
        solicitud,
    )
    # La postulación de arriba ya ocupa el hueco vivo: otro prestador.
    prestador = _prestador(pg, _persona(pg))
    assert "nace en borrador" in _falla(
        pg,
        "insert into service_provider_applications (provider_id, status) values (%s, 'approved')",
        prestador,
    )
    assert _uno(
        pg, "insert into service_provider_applications (provider_id) values (%s) returning status",
        prestador,
    ) == "draft"


@SIN_POSTGRES
def test_la_base_solo_admite_los_saltos_del_mapa(pg) -> None:
    admin = _persona(pg, "admin")
    solicitud = _uno(
        pg, "insert into service_provider_applications (provider_id) values (%s) returning id",
        _prestador(pg, _persona(pg)),
    )
    politica = _politica(pg, admin)
    # Enviar sin lo obligatorio: lo para el CHECK de «enviada completa».
    assert "enviada_completa" in _falla(
        pg, "update service_provider_applications set status = 'submitted' where id = %s", solicitud
    )
    # Un atajo: lo para el disparador aunque la fila esté completa.
    assert "no puede pasar a" in _falla(
        pg,
        "update service_provider_applications set status = 'approved', summary = %s, "
        "terms_policy_id = %s, terms_sha256 = %s, terms_accepted_at = now(), "
        "truthfulness_declared_at = now(), submitted_at = now(), last_submitted_at = now(), "
        "decided_at = now(), decided_by = %s where id = %s",
        "Resumen suficientemente largo del servicio.", politica[0], politica[1], admin, solicitud,
    )
    _enviar(pg, solicitud, politica)
    with pg.cursor() as cur:
        cur.execute(
            "update service_provider_applications set status = 'under_review', "
            "review_started_at = now() where id = %s",
            (solicitud,),
        )
    # Rechazar sin motivo no existe.
    assert "con_motivo" in _falla(
        pg,
        "update service_provider_applications set status = 'rejected', decided_at = now(), "
        "decided_by = %s where id = %s",
        admin, solicitud,
    )
    # Y el historial solo acepta saltos del mapa.
    assert "salto_permitido" in _falla(
        pg,
        "insert into service_provider_application_events (application_id, from_status, "
        "to_status, actor_role) values (%s, 'draft', 'approved', 'admin')",
        solicitud,
    )


@SIN_POSTGRES
def test_una_sola_postulacion_viva_por_prestador(pg) -> None:
    admin = _persona(pg, "admin")
    prestador = _prestador(pg, _persona(pg))
    primera = _uno(
        pg, "insert into service_provider_applications (provider_id) values (%s) returning id",
        prestador,
    )
    assert "una_viva" in _falla(
        pg, "insert into service_provider_applications (provider_id) values (%s)", prestador
    )
    _enviar(pg, primera, _politica(pg, admin))
    with pg.cursor() as cur:
        cur.execute(
            "update service_provider_applications set status = 'under_review', "
            "review_started_at = now() where id = %s",
            (primera,),
        )
        cur.execute(
            "update service_provider_applications set status = 'rejected', decided_at = now(), "
            "decided_by = %s, applicant_message = 'No se pudo comprobar la identidad.' "
            "where id = %s",
            (admin, primera),
        )
    # Rechazada, el hueco queda libre.
    assert _uno(
        pg, "insert into service_provider_applications (provider_id) values (%s) returning status",
        prestador,
    ) == "draft"


@SIN_POSTGRES
def test_nadie_se_admite_a_si_mismo_ni_siendo_administrador(pg) -> None:
    admin = _persona(pg, "admin")
    prestador = _prestador(pg, admin)
    solicitud = _uno(
        pg, "insert into service_provider_applications (provider_id) values (%s) returning id",
        prestador,
    )
    _enviar(pg, solicitud, _politica(pg, admin))
    with pg.cursor() as cur:
        cur.execute(
            "update service_provider_applications set status = 'under_review', "
            "review_started_at = now() where id = %s",
            (solicitud,),
        )
    assert "su propia admisión" in _falla(
        pg,
        "update service_provider_applications set status = 'approved', decided_at = now(), "
        "decided_by = %s where id = %s",
        admin, solicitud,
    )
    assert "su propia admisión" in _falla(
        pg,
        "insert into service_provider_application_events (application_id, from_status, "
        "to_status, actor_id, actor_role) values (%s, 'submitted', 'under_review', %s, 'reviewer')",
        solicitud, admin,
    )
    documento = _uno(
        pg,
        "insert into service_provider_documents (provider_id, application_id, kind, "
        "storage_path, content_type, byte_size) values (%s, %s, 'identity', %s, "
        "'application/pdf', 100) returning id",
        prestador, solicitud, f"{admin}/{solicitud}/dni.pdf",
    )
    assert "su propia admisión" in _falla(
        pg,
        "update service_provider_documents set review_status = 'accepted', reviewed_at = now(), "
        "reviewed_by = %s where id = %s",
        admin, documento,
    )
    credencial = _uno(
        pg,
        "insert into service_provider_credentials (provider_id, kind, title, issuer, "
        "evidence_document_id) values (%s, 'professional_license', 'Colegiatura', 'Colegio', %s) "
        "returning id",
        prestador, documento,
    )
    assert "su propia admisión" in _falla(
        pg,
        "update service_provider_credentials set status = 'verified', verified_at = now(), "
        "verified_by = %s where id = %s",
        admin, credencial,
    )
    # Quien postula sí puede firmar su propio paso como prestador.
    with pg.cursor() as cur:
        cur.execute(
            "insert into service_provider_application_events (application_id, from_status, "
            "to_status, actor_id, actor_role) values (%s, 'draft', 'submitted', %s, 'provider')",
            (solicitud, admin),
        )


@SIN_POSTGRES
def test_una_credencial_no_se_respalda_con_un_documento_ajeno(pg) -> None:
    uno = _prestador(pg, _persona(pg))
    otro = _prestador(pg, _persona(pg))
    solicitud_otro = _uno(
        pg, "insert into service_provider_applications (provider_id) values (%s) returning id", otro
    )
    ajeno = _uno(
        pg,
        "insert into service_provider_documents (provider_id, application_id, kind, "
        "storage_path, content_type, byte_size) values (%s, %s, 'identity', %s, "
        "'application/pdf', 100) returning id",
        otro, solicitud_otro, f"x/{uuid.uuid4()}.pdf",
    )
    assert "evidencia_propia" in _falla(
        pg,
        "insert into service_provider_credentials (provider_id, kind, title, issuer, "
        "evidence_document_id) values (%s, 'certification', 'Curso', 'Instituto', %s)",
        uno, ajeno,
    )
    # Ni un documento en la postulación de otro.
    assert "de_su_postulacion" in _falla(
        pg,
        "insert into service_provider_documents (provider_id, application_id, kind, "
        "storage_path, content_type, byte_size) values (%s, %s, 'identity', %s, "
        "'application/pdf', 100)",
        uno, solicitud_otro, f"y/{uuid.uuid4()}.pdf",
    )


@SIN_POSTGRES
def test_documentos_privados_con_formato_y_peso_cerrados(pg) -> None:
    prestador = _prestador(pg, _persona(pg))
    solicitud = _uno(
        pg, "insert into service_provider_applications (provider_id) values (%s) returning id",
        prestador,
    )
    base = (
        "insert into service_provider_documents (provider_id, application_id, kind, "
        "storage_path, content_type, byte_size) values (%s, %s, 'identity', %s, %s, %s)"
    )
    assert "formato" in _falla(pg, base, prestador, solicitud, "a/b.svg", "image/svg+xml", 10)
    assert "peso" in _falla(pg, base, prestador, solicitud, "a/c.pdf", "application/pdf", 20 * 1024 * 1024)
    assert "ruta" in _falla(pg, base, prestador, solicitud, "/abs.pdf", "application/pdf", 10)
    assert "ruta" in _falla(pg, base, prestador, solicitud, "a/../b.pdf", "application/pdf", 10)
    with pg.cursor() as cur:
        cur.execute(base, (prestador, solicitud, "a/d.pdf", "application/pdf", 10))
    assert "ruta_unica" in _falla(pg, base, prestador, solicitud, "a/d.pdf", "application/pdf", 10)


@SIN_POSTGRES
def test_el_historial_solo_se_anade_y_la_evidencia_no_se_borra_suelta(pg) -> None:
    perfil = _persona(pg)
    prestador = _prestador(pg, perfil)
    solicitud = _uno(
        pg, "insert into service_provider_applications (provider_id) values (%s) returning id",
        prestador,
    )
    with pg.cursor() as cur:
        cur.execute(
            "insert into service_provider_application_events (application_id, to_status, "
            "actor_id, actor_role) values (%s, 'draft', %s, 'provider')",
            (solicitud, perfil),
        )
    documento = _uno(
        pg,
        "insert into service_provider_documents (provider_id, application_id, kind, "
        "storage_path, content_type, byte_size) values (%s, %s, 'identity', %s, "
        "'application/pdf', 100) returning id",
        prestador, solicitud, f"{perfil}/{solicitud}/dni.pdf",
    )
    assert "solo se añade" in _falla(
        pg, "update service_provider_application_events set visible_note = 'otra' "
        "where application_id = %s", solicitud,
    )
    for sql, arg in (
        ("delete from service_provider_application_events where application_id = %s", solicitud),
        ("delete from service_provider_applications where id = %s", solicitud),
        ("delete from service_provider_documents where id = %s", documento),
        ("delete from service_providers where id = %s", prestador),
    ):
        assert "no se borra" in _falla(pg, sql, arg), sql


@SIN_POSTGRES
def test_borrar_la_cuenta_sigue_funcionando_y_se_lleva_todo(pg) -> None:
    """`DELETE /me` borra el perfil; la cascada no puede chocar con el historial."""
    admin = _persona(pg, "admin")
    perfil = _persona(pg)
    prestador = _prestador(pg, perfil)
    solicitud = _uno(
        pg, "insert into service_provider_applications (provider_id) values (%s) returning id",
        prestador,
    )
    with pg.cursor() as cur:
        cur.execute(
            "insert into service_provider_application_events (application_id, to_status, "
            "actor_id, actor_role) values (%s, 'draft', %s, 'provider')",
            (solicitud, perfil),
        )
    documento = _uno(
        pg,
        "insert into service_provider_documents (provider_id, application_id, kind, "
        "storage_path, content_type, byte_size) values (%s, %s, 'identity', %s, "
        "'application/pdf', 100) returning id",
        prestador, solicitud, f"{perfil}/{solicitud}/dni.pdf",
    )
    with pg.cursor() as cur:
        cur.execute(
            "insert into service_provider_credentials (provider_id, application_id, kind, title, "
            "issuer, evidence_document_id) values (%s, %s, 'professional_license', 'Colegiatura', "
            "'Colegio', %s)",
            (prestador, solicitud, documento),
        )
    _enviar(pg, solicitud, _politica(pg, admin))

    with pg.cursor() as cur:
        cur.execute("delete from public.profiles where id = %s", (perfil,))
    for tabla, columna, valor in (
        ("service_providers", "id", prestador),
        ("service_provider_applications", "id", solicitud),
        ("service_provider_documents", "id", documento),
        ("service_provider_credentials", "provider_id", prestador),
        ("service_provider_application_events", "application_id", solicitud),
    ):
        assert not _uno(pg, f"select count(*) from {tabla} where {columna} = %s", valor), tabla

    # Y borrar la cuenta de quien DECIDIÓ no reescribe ningún expediente.
    otro = _persona(pg)
    ajena = _uno(
        pg, "insert into service_provider_applications (provider_id) values (%s) returning id",
        _prestador(pg, otro),
    )
    _enviar(pg, ajena, _politica(pg, admin))
    with pg.cursor() as cur:
        cur.execute(
            "insert into service_provider_application_events (application_id, from_status, "
            "to_status, actor_id, actor_role) values (%s, 'submitted', 'under_review', %s, 'admin')",
            (ajena, admin),
        )
        cur.execute("delete from public.profiles where id = %s", (admin,))
    assert _uno(
        pg, "select actor_id::text from service_provider_application_events "
        "where application_id = %s and actor_role = 'admin'", ajena,
    ) == admin


@SIN_POSTGRES
def test_una_politica_publicada_no_se_edita_ni_se_borra(pg) -> None:
    admin = _persona(pg, "admin")
    politica, _ = _politica(pg, admin, pais="ZZ")
    assert "no se modifica" in _falla(
        pg, "update service_policies set body = body || ' cambio' where id = %s", politica
    )
    assert "no se borra" in _falla(pg, "delete from service_policies where id = %s", politica)
    with pg.cursor() as cur:
        cur.execute("update service_policies set status = 'superseded' where id = %s", (politica,))
    assert "no se modifica" in _falla(
        pg, "update service_policies set status = 'published' where id = %s", politica
    )
    # Dos publicadas a la vez para el mismo país: no.
    _politica(pg, admin, pais="ZY")
    assert "una_publicada" in _falla(
        pg,
        "insert into service_policies (kind, country_code, version, status, title, body, "
        "body_sha256, effective_at, published_at, published_by) select kind, country_code, 2, "
        "'published', title, body, body_sha256, now(), now(), published_by "
        "from service_policies where country_code = 'ZY'",
    )
    # Un borrador sí se borra.
    borrador = _uno(
        pg,
        "insert into service_policies (kind, country_code, version, title, body, body_sha256) "
        "select kind, 'ZX', 1, title, body, body_sha256 from service_policies "
        "where id = %s returning id",
        politica,
    )
    with pg.cursor() as cur:
        cur.execute("delete from service_policies where id = %s", (borrador,))


@SIN_POSTGRES
def test_una_politica_rige_desde_su_fecha(pg) -> None:
    """La lectura de `politicas.vigente` sobre PostgreSQL de verdad."""
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.modules.services import politicas

    admin = _persona(pg, "admin")
    politica, _ = _politica(pg, admin, pais="ZW")
    with pg.cursor() as cur:
        cur.execute(
            "update service_policies set status = 'superseded' where country_code = 'ZW'"
        )
        cur.execute(
            "insert into service_policies (kind, country_code, version, status, title, body, "
            "body_sha256, effective_at, published_at, published_by) select kind, 'ZW', 2, "
            "'published', title, body, body_sha256, %s, now(), published_by "
            "from service_policies where id = %s",
            (datetime.now(timezone.utc) + timedelta(days=3), politica),
        )

    async def leer():
        motor = create_async_engine(URL.replace("postgresql://", "postgresql+asyncpg://", 1))
        try:
            async with async_sessionmaker(motor)() as db:
                hoy = await politicas.vigente(db, tipo="provider_terms", pais="ZW")
                luego = await politicas.vigente(
                    db, tipo="provider_terms", pais="ZW",
                    ahora=datetime.now(timezone.utc) + timedelta(days=4),
                )
                return hoy, luego
        finally:
            await motor.dispose()

    hoy, luego = asyncio.run(leer())
    assert hoy is None  # la versión 1 está superada y la 2 aún no rige
    assert luego is not None and luego.version == 2
