"""Z Servicios: la migración 0088 (cierre del Incremento 1).

La 0086 y la 0087 están aplicadas en Supabase y son históricas: la 0088 NO LAS
TOCA. Añade el depósito privado, el ciclo de vida de documentos y credenciales,
lo que se pidió corregir en el historial, los envíos congelados y la regla que
ata el estado del prestador al de su postulación.

LO QUE DEFIENDEN ESTAS PRUEBAS:

  1. UNA ÚNICA TRANSACCIÓN que primero comprueba la 0086, la 0087 y que los
     datos que ya hubiera cumplen la regla nueva; si algo falla, nada queda.
  2. ADITIVA: ni una tabla, columna, restricción, índice o función de la 0086
     o la 0087 se borra o se sustituye; ninguna fila existente se reescribe.
  3. DESDE CERO (0001–0088), SOBRE UNA BASE CON LA 0087 Y DATOS, y
     reejecutable dejando exactamente lo mismo.
  4. LO QUE LA BASE IMPONE AHORA: el prestador coincide con su postulación al
     confirmar; un envío congelado no se toca; el ciclo de vida es coherente;
     una credencial observada es una declarada con motivo; y borrar la cuenta
     se sigue llevando todo.
  5. CERRADA: RLS sin políticas ni privilegios, y un depósito privado sin
     políticas, de 10 MB y con la lista cerrada de formatos.

Sin `MIGRACIONES_DATABASE_URL` la mitad de PostgreSQL se omite. EL ORDEN
IMPORTA: las primeras comparten una base entera; los escenarios del final la
rehacen a su manera.
"""

from __future__ import annotations

import hashlib
import os
import re
import uuid

import pytest

from app.modules.services import documentos
from app.modules.services.models import (
    CICLO_DE_CREDENCIAL,
    CICLO_DE_DOCUMENTO,
    ENVIO_INICIAL,
    FORMATOS_DE_DOCUMENTO,
    PESO_MAXIMO_DE_DOCUMENTO,
    REENVIO,
    ServiceProviderApplicationSubmission,
)
from app.shared import storage
from tests.test_migraciones_reales import MIGRACIONES, PROLOGO, exigir_url_desechable

ARCHIVO = MIGRACIONES / "0088_servicios_documentos_y_envios.sql"
ANTERIORES = (
    MIGRACIONES / "0086_servicios_admision.sql",
    MIGRACIONES / "0087_servicios_retirada.sql",
)
URL = os.environ.get("MIGRACIONES_DATABASE_URL", "").strip()
SIN_POSTGRES = pytest.mark.skipif(
    not URL,
    reason=(
        "sin PostgreSQL desechable: define MIGRACIONES_DATABASE_URL "
        "(ver la cabecera de tests/test_migraciones_reales.py)"
    ),
)

TABLA_NUEVA = "service_provider_application_submissions"
DISPARADORES = {
    "service_provider_application_submissions_inmutables",
    "service_provider_application_submissions_solo_en_cascada",
    "service_provider_applications_prestador_coherente",
    "service_providers_coherente_con_su_postulacion",
}
FUNCION_NUEVA = "servicios_prestador_coherente"


def _sin_comentarios(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


TEXTO = ARCHIVO.read_text(encoding="utf-8").replace("\r\n", "\n")
SQL = _sin_comentarios(TEXTO)


def _nombres_de(sql: str) -> set[str]:
    """Restricciones, índices, disparadores y funciones que un SQL define."""
    sql = _sin_comentarios(sql)
    return (
        set(re.findall(r"constraint\s+(?!if\b|trigger\b)([a-z_0-9]+)", sql))
        | set(re.findall(r"create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?([a-z_0-9]+)", sql))
        | set(re.findall(r"create\s+(?:constraint\s+)?trigger\s+([a-z_0-9]+)", sql))
        | set(re.findall(r"create\s+(?:or\s+replace\s+)?function\s+public\.([a-z_0-9]+)", sql))
    )


# =========================================================================== #
# 1. Estática
# =========================================================================== #
def test_sigue_a_la_0087_y_la_0089_va_despues() -> None:
    """Era la última cuando se aplicó (29/09/2026); ahora la sigue la 0089,
    que la exige."""
    nombres = sorted(p.name for p in MIGRACIONES.glob("*.sql"))
    posicion = nombres.index(ARCHIVO.name)
    assert nombres[posicion - 1] == ANTERIORES[1].name
    assert nombres[posicion + 1].startswith("0089_")


def test_la_0087_no_ha_cambiado_desde_que_se_aplico() -> None:
    """Aplicada en Supabase y verificada. La 0086 la vigila su propio fichero."""
    contenido = ANTERIORES[1].read_bytes().replace(b"\r\n", b"\n")
    cabecera = f"blob {len(contenido)}\0".encode()
    assert hashlib.sha1(cabecera + contenido).hexdigest() == (
        "359f330a9ee99d22f3c2f719cb0adf557e58d7e8"
    )


def test_es_una_unica_transaccion() -> None:
    sentencias = [s.strip() for s in SQL.split(";") if s.strip()]
    assert sentencias[0] == "begin"
    assert sentencias[-1] == "commit"
    assert len(re.findall(r"^\s*begin\s*;", SQL, flags=re.M)) == 1
    assert len(re.findall(r"^\s*commit\s*;", SQL, flags=re.M)) == 1
    assert not re.search(r"\brollback\b|\bsavepoint\b", SQL, flags=re.I)


def test_comprueba_lo_anterior_antes_de_tocar_nada() -> None:
    primera = SQL[SQL.index("begin;") : SQL.index("$$;") + 3]
    for tabla in (
        "service_policies", "service_providers", "service_provider_applications",
        "service_provider_documents", "service_provider_credentials",
        "service_provider_application_events",
    ):
        assert f"'{tabla}'" in primera, tabla
    assert "service_provider_application_events_retirada_propia()" in primera
    assert "servicios_historial_inmutable()" in primera
    assert "servicios_borrado_solo_en_cascada()" in primera
    # Y que lo que ya hay cumple la regla nueva, antes de crearla.
    assert "incoherentes" in primera and "raise exception" in primera
    # Nada se crea ni se altera antes de esa comprobación.
    assert not re.search(r"\b(alter|create|insert|update|drop)\b", SQL[: SQL.index("do $$")])


def test_es_aditiva_y_no_toca_la_0086_ni_la_0087() -> None:
    assert not re.search(
        r"\b(drop\s+table|drop\s+column|truncate|drop\s+schema|drop\s+index|rename|alter\s+column)\b",
        SQL,
        flags=re.I,
    )
    # Lo único que borra son SUS PROPIOS nombres, para poder reejecutarse.
    borrados = set(re.findall(r"drop\s+(?:constraint|trigger)\s+if\s+exists\s+([a-z_0-9]+)", SQL))
    propios = _nombres_de(TEXTO)
    assert borrados <= propios
    de_antes = set().union(*(_nombres_de(a.read_text(encoding="utf-8")) for a in ANTERIORES))
    assert not borrados & de_antes
    assert not propios & de_antes, propios & de_antes
    # Solo escribe filas en el catálogo de depósitos, y nunca borra ninguna.
    assert set(re.findall(r"insert\s+into\s+([a-z_.]+)", SQL)) == {"storage.buckets"}
    assert set(re.findall(r"\bupdate\s+([a-z_.]+)\s+set", SQL)) == {"storage.buckets"}
    assert not re.search(r"\bdelete\s+from\b", SQL, flags=re.I)


def test_las_columnas_nuevas_no_reescriben_filas() -> None:
    """`not null` solo con valor por defecto: añadir no toca lo que ya hay."""
    for tabla, columna, resto in re.findall(
        r"alter\s+table\s+public\.([a-z_0-9]+)\s+add\s+column\s+if\s+not\s+exists\s+([a-z_0-9]+)\s+([^;]*);",
        SQL,
    ):
        if "not null" in resto:
            assert "default" in resto, (tabla, columna)


def test_la_tabla_nueva_esta_cerrada() -> None:
    assert re.search(rf"alter\s+table\s+public\.{TABLA_NUEVA}\s+enable\s+row\s+level\s+security", SQL)
    assert re.search(rf"revoke\s+all\s+on\s+public\.{TABLA_NUEVA}\s+from\s+anon,\s*authenticated", SQL)
    assert not re.search(r"\bcreate\s+policy\b|\bgrant\b", SQL, flags=re.I)


def test_el_deposito_es_el_que_usa_la_api() -> None:
    assert documentos.DEPOSITO == "service-provider-documents"
    assert f"'{documentos.DEPOSITO}'" in SQL
    assert documentos.DEPOSITO in storage.USER_BUCKETS
    assert re.search(r"public\s*=\s*false", SQL)
    assert "10::bigint * 1024 * 1024" in SQL and PESO_MAXIMO_DE_DOCUMENTO == 10 * 1024 * 1024
    formatos = re.search(r"allowed_mime_types\s*=\s*array\[([^\]]*)\]", SQL).group(1)
    assert tuple(re.findall(r"'([^']+)'", formatos)) == FORMATOS_DE_DOCUMENTO
    # Sin políticas en `storage.objects`: solo las quita por si acaso.
    assert re.findall(r"\bpolicy\b[^;]*", SQL) == [
        "policy if exists service_provider_documents_read on storage.objects",
        "policy if exists service_provider_documents_write on storage.objects",
    ]


def test_los_ciclos_del_sql_son_los_del_modelo() -> None:
    def valores(nombre: str) -> tuple[str, ...]:
        cuerpo = re.search(rf"constraint\s+{nombre}\s+check\s*\((.*?)\)\s*[,;]", SQL, flags=re.S).group(1)
        return tuple(re.findall(r"'([a-z_]+)'", cuerpo))

    assert valores("service_provider_documents_ciclo") == CICLO_DE_DOCUMENTO
    assert valores("service_provider_credentials_ciclo") == CICLO_DE_CREDENCIAL
    assert set(valores(f"{TABLA_NUEVA}_tipo")) == {ENVIO_INICIAL, REENVIO}


def test_el_modelo_de_los_envios_es_el_sql() -> None:
    cuerpo = re.search(
        rf"create\s+table\s+if\s+not\s+exists\s+public\.{TABLA_NUEVA}\s*\((.*?)\n\);", SQL, flags=re.S
    ).group(1)
    columnas = {
        m.group(1)
        for linea in cuerpo.split("\n")
        if (m := re.match(r"^\s{2}([a-z_0-9]+)\s+(?:uuid|integer|text|jsonb|timestamptz)\b", linea))
    }
    tabla = ServiceProviderApplicationSubmission.__table__
    assert columnas == {c.name for c in tabla.columns}
    checks = set(re.findall(r"constraint\s+([a-z_0-9]+)\s+check", cuerpo))
    assert checks == {c.name for c in tabla.constraints if type(c).__name__ == "CheckConstraint"}
    unicas = set(re.findall(r"constraint\s+([a-z_0-9]+)\s+unique", cuerpo))
    assert unicas == {c.name for c in tabla.constraints if type(c).__name__ == "UniqueConstraint"}
    assert {i.name for i in tabla.indexes} == {f"{TABLA_NUEVA}_de_la_postulacion"}
    # Quién envió NO tiene clave ajena: sobrevive a la cuenta, como el historial.
    assert "submitted_by uuid," in cuerpo and not tabla.c.submitted_by.foreign_keys


def test_los_cuatro_disparadores_y_la_regla_de_coherencia() -> None:
    assert set(re.findall(r"create\s+(?:constraint\s+)?trigger\s+([a-z_0-9]+)", SQL)) == DISPARADORES
    for nombre in ("service_provider_applications_prestador_coherente", "service_providers_coherente_con_su_postulacion"):
        definicion = SQL[SQL.index(f"create constraint trigger {nombre}") :]
        definicion = definicion[: definicion.index(";")]
        assert "deferrable initially deferred" in definicion
        assert "after insert or update" in definicion and "delete" not in definicion
    funcion = SQL[SQL.index(f"function public.{FUNCION_NUEVA}()") :]
    funcion = funcion[: funcion.index("$$;")]
    assert "security invoker" in funcion and "set search_path = public, pg_temp" in funcion
    assert "check_violation" in funcion


def test_no_trae_nada_de_reservas_ni_dinero() -> None:
    for prohibida in (
        "booking", "slot", "availability", "schedule", "payment", "refund",
        "payout", "transfer", "balance", "stripe", "price", "amount",
    ):
        assert prohibida not in SQL.lower(), prohibida


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


def _falla(pg, sql: str, *args) -> str:
    import psycopg

    with pytest.raises(psycopg.Error) as error:
        with pg.cursor() as cur:
            cur.execute(sql, args or None)
    return str(error.value)


def _falla_al_confirmar(pg, *sentencias: tuple) -> str:
    """Varias sentencias en UNA transacción; el error llega en el `commit`."""
    import psycopg

    with pytest.raises(psycopg.Error) as error:
        with pg.transaction():
            for sql, *args in sentencias:
                _hacer(pg, sql, *args)
    return str(error.value)


def _en_una(pg, *sentencias: tuple) -> None:
    with pg.transaction():
        for sql, *args in sentencias:
            _hacer(pg, sql, *args)


_PAISES = (a + b for a in "ABCDEFGHIJKLMNOPQRSTUVWXY" for b in "ABCDEFGHIJKLMNOPQRSTUVWXYZ")


def _persona(pg, rol: str = "user") -> str:
    ident = str(uuid.uuid4())
    _hacer(
        pg,
        "insert into auth.users (id, email, raw_user_meta_data) values "
        "(%s, %s, jsonb_build_object('full_name','P','username',cast(%s as text)))",
        ident, f"o-{ident[:8]}@x.test", f"o{ident[:8]}",
    )
    _hacer(pg, "update public.profiles set role = %s where id = %s", rol, ident)
    return ident


def _politica(pg, admin: str) -> tuple[str, str]:
    texto = "Condiciones del prestador de Z Servicios para pruebas. " * 2
    huella = hashlib.sha256(texto.encode()).hexdigest()
    ident = _uno(
        pg,
        "insert into service_policies (kind, country_code, version, status, title, body, "
        "body_sha256, effective_at, published_at, published_by) values ('provider_terms', %s, 1, "
        "'published', 'Condiciones', %s, %s, now(), now(), %s) returning id",
        next(_PAISES), texto, huella, admin,
    )
    return str(ident), huella


def _postulacion(pg) -> tuple[str, str, str]:
    """(perfil, prestador, postulación en borrador)."""
    perfil = _persona(pg)
    prestador = str(_uno(
        pg,
        "insert into service_providers (profile_id, provider_type, display_name) "
        "values (%s, 'individual', 'Prestador de prueba') returning id",
        perfil,
    ))
    solicitud = str(_uno(
        pg, "insert into service_provider_applications (provider_id) values (%s) returning id",
        prestador,
    ))
    return perfil, prestador, solicitud


def _documento(pg, prestador: str, solicitud: str, perfil: str, kind: str = "identity") -> str:
    return str(_uno(
        pg,
        "insert into service_provider_documents (provider_id, application_id, kind, "
        "storage_path, content_type, byte_size) values (%s, %s, %s, %s, 'application/pdf', 100) "
        "returning id",
        prestador, solicitud, kind, f"{perfil}/{solicitud}/{uuid.uuid4()}.pdf",
    ))


ENVIAR = (
    "update service_provider_applications set status = 'submitted', summary = %s, "
    "terms_policy_id = %s, terms_sha256 = %s, terms_accepted_at = now(), "
    "truthfulness_declared_at = now(), submitted_at = now(), last_submitted_at = now() "
    "where id = %s"
)
REVISAR = "update service_provider_applications set status = 'under_review', review_started_at = now() where id = %s"
APROBAR = (
    "update service_provider_applications set status = 'approved', decided_at = now(), "
    "decided_by = %s where id = %s"
)
SUSPENDER = (
    "update service_provider_applications set status = 'suspended', suspended_at = now(), "
    "applicant_message = 'Suspensión preventiva.' where id = %s"
)
RECHAZAR = (
    "update service_provider_applications set status = 'rejected', decided_at = now(), "
    "decided_by = %s, applicant_message = 'No se pudo verificar.' where id = %s"
)
PRESTADOR = (
    "with v(estado) as (select cast(%s as text)) "
    "update service_providers set status = v.estado, "
    "activated_at = case when v.estado = 'active' then coalesce(activated_at, now()) else activated_at end, "
    "suspended_at = case when v.estado = 'suspended' then now() else suspended_at end "
    "from v where id = %s"
)


def _en_revision(pg, admin: str) -> tuple[str, str, str]:
    perfil, prestador, solicitud = _postulacion(pg)
    politica = _politica(pg, admin)
    _hacer(pg, ENVIAR, "Resumen suficientemente largo del servicio.", politica[0], politica[1], solicitud)
    _hacer(pg, REVISAR, solicitud)
    return perfil, prestador, solicitud


def _envio(pg, solicitud: str, politica: tuple[str, str], secuencia: int = 1, kind: str = "submitted"):
    return _uno(
        pg,
        "insert into service_provider_application_submissions (application_id, sequence, kind, "
        "terms_policy_id, terms_version, terms_sha256, snapshot, snapshot_sha256, submitted_by) "
        "values (%s, %s, %s, %s, 1, %s, '{\"fields\": {}}'::jsonb, %s, null) returning id",
        solicitud, secuencia, kind, politica[0], politica[1], "a" * 64,
    )


# --- 2.1 Sobre la base entera (0001–0088) ---------------------------------- #
@SIN_POSTGRES
def test_desde_cero_deja_todo_lo_que_promete(completa) -> None:
    pg = completa
    assert _uno(pg, "select to_regclass(%s)::text", f"public.{TABLA_NUEVA}") == TABLA_NUEVA
    assert {f[0] for f in _todas(
        pg, "select tgname from pg_trigger where not tgisinternal and tgname = any(%s)", list(DISPARADORES)
    )} == DISPARADORES
    diferidos = _todas(
        pg,
        "select tgname, tgdeferrable, tginitdeferred from pg_trigger where tgname = any(%s)",
        ["service_provider_applications_prestador_coherente", "service_providers_coherente_con_su_postulacion"],
    )
    assert sorted(d[1:] for d in diferidos) == [(True, True), (True, True)]
    assert _todas(
        pg,
        "select public, file_size_limit, allowed_mime_types from storage.buckets where id = %s",
        documentos.DEPOSITO,
    ) == [(False, PESO_MAXIMO_DE_DOCUMENTO, list(FORMATOS_DE_DOCUMENTO))]
    assert not _uno(
        pg, "select count(*) from pg_policies where schemaname = 'storage' and policyname like 'service%%'"
    )


@SIN_POSTGRES
def test_la_tabla_nueva_rls_cero_politicas_y_cero_privilegios(completa) -> None:
    pg = completa
    assert _uno(pg, "select relrowsecurity from pg_class where oid = %s::regclass", f"public.{TABLA_NUEVA}")
    assert not _uno(pg, "select count(*) from pg_policies where tablename = %s", TABLA_NUEVA)
    assert not _uno(
        pg,
        "select count(*) from information_schema.table_privileges where table_name = %s "
        "and grantee in ('anon', 'authenticated')",
        TABLA_NUEVA,
    )


@SIN_POSTGRES
def test_columnas_y_restricciones_de_la_base_son_las_de_los_modelos(completa) -> None:
    pg = completa
    from app.modules.services.models import (
        ServiceProviderApplicationEvent,
        ServiceProviderCredential,
        ServiceProviderDocument,
    )

    for modelo in (
        ServiceProviderDocument,
        ServiceProviderCredential,
        ServiceProviderApplicationEvent,
        ServiceProviderApplicationSubmission,
    ):
        tabla = modelo.__tablename__
        reales = {f[0] for f in _todas(
            pg,
            "select column_name from information_schema.columns where table_schema = 'public' "
            "and table_name = %s",
            tabla,
        )}
        assert reales == {c.name for c in modelo.__table__.columns}, tabla
        checks = {f[0] for f in _todas(
            pg, "select conname from pg_constraint where contype = 'c' and conrelid = %s::regclass", tabla
        )}
        del_modelo = {
            c.name for c in modelo.__table__.constraints if type(c).__name__ == "CheckConstraint"
        }
        # Los NOT NULL que PostgreSQL 17+ guarda como restricción no cuentan.
        assert {c for c in checks if not c.endswith("_not_null")} == del_modelo, tabla


@SIN_POSTGRES
def test_el_prestador_coincide_con_su_postulacion_al_confirmar(completa) -> None:
    pg = completa
    admin = _persona(pg, "admin")
    _, prestador, solicitud = _en_revision(pg, admin)

    # Aprobar sin activar al prestador: la base lo rechaza al confirmar.
    assert "no coinciden" in _falla_al_confirmar(pg, (APROBAR, admin, solicitud))
    # Activar al prestador sin aprobar: tampoco.
    assert "no coinciden" in _falla_al_confirmar(pg, (PRESTADOR, "active", prestador))
    assert _uno(pg, "select status from service_provider_applications where id = %s", solicitud) == "under_review"
    # Las dos cosas juntas, sí.
    _en_una(pg, (APROBAR, admin, solicitud), (PRESTADOR, "active", prestador))

    # Suspender la postulación exige suspender al prestador.
    assert "no coinciden" in _falla_al_confirmar(pg, (SUSPENDER, solicitud))
    _en_una(pg, (SUSPENDER, solicitud), (PRESTADOR, "suspended", prestador))
    # Y un prestador suspendido no se reactiva por su cuenta.
    assert "no coinciden" in _falla_al_confirmar(pg, (PRESTADOR, "active", prestador))
    # Devuelta a revisión: sigue suspendido (no está aprobada ni activo).
    _hacer(pg, REVISAR, solicitud)
    # Y ya decidida: la retirada que la 0087 permite desde revisión, aquí no.
    assert "retirada_antes_de_decidir" in _falla(
        pg, "update service_provider_applications set status = 'withdrawn' where id = %s", solicitud
    )
    # Rechazada tras investigar: suspendido, nunca activo.
    _hacer(pg, RECHAZAR, admin, solicitud)
    assert "no coinciden" in _falla_al_confirmar(pg, (PRESTADOR, "active", prestador))
    # Una postulación nueva tras el rechazo es la actual; el prestador sigue sin activarse.
    nueva = _uno(pg, "insert into service_provider_applications (provider_id) values (%s) returning id", prestador)
    assert nueva
    assert "no coinciden" in _falla_al_confirmar(pg, (PRESTADOR, "active", prestador))


@SIN_POSTGRES
def test_retirada_y_borrador_dejan_al_prestador_sin_activar(completa) -> None:
    pg = completa
    admin = _persona(pg, "admin")
    perfil, prestador, solicitud = _en_revision(pg, admin)
    _hacer(pg, "update service_provider_applications set status = 'withdrawn' where id = %s", solicitud)
    _hacer(
        pg,
        "insert into service_provider_application_events (application_id, from_status, to_status, "
        "actor_id, actor_role) values (%s, 'under_review', 'withdrawn', %s, 'provider')",
        solicitud, perfil,
    )
    assert "no coinciden" in _falla_al_confirmar(pg, (PRESTADOR, "active", prestador))
    # Un prestador sin ninguna postulación tampoco puede estar activo.
    suelto = _uno(
        pg,
        "insert into service_providers (profile_id, provider_type, display_name) "
        "values (%s, 'individual', 'Sin postular') returning id",
        _persona(pg),
    )
    assert "no coinciden" in _falla_al_confirmar(pg, (PRESTADOR, "active", suelto))
    assert "ninguna" in _falla_al_confirmar(pg, (PRESTADOR, "active", suelto))


@SIN_POSTGRES
def test_una_aprobada_que_vuelve_a_revision_no_se_retira(completa) -> None:
    pg = completa
    admin = _persona(pg, "admin")
    perfil, prestador, solicitud = _en_revision(pg, admin)
    _en_una(pg, (APROBAR, admin, solicitud), (PRESTADOR, "active", prestador))
    _en_una(pg, (SUSPENDER, solicitud), (PRESTADOR, "suspended", prestador))
    _hacer(pg, REVISAR, solicitud)
    assert "retirada_antes_de_decidir" in _falla(
        pg, "update service_provider_applications set status = 'withdrawn' where id = %s", solicitud
    )
    # Antes de decidir, sí (lo que la 0087 permite sigue permitido).
    _, _, otra = _en_revision(pg, admin)
    _hacer(pg, "update service_provider_applications set status = 'withdrawn' where id = %s", otra)


@SIN_POSTGRES
def test_un_envio_congelado_no_se_toca(completa) -> None:
    pg = completa
    admin = _persona(pg, "admin")
    _, _, solicitud = _en_revision(pg, admin)
    politica = _politica(pg, admin)
    envio = _envio(pg, solicitud, politica)
    assert "solo se añade" in _falla(
        pg, f"update {TABLA_NUEVA} set snapshot = '{{}}'::jsonb where id = %s", envio
    )
    assert "no se borra" in _falla(pg, f"delete from {TABLA_NUEVA} where id = %s", envio)
    assert "una_por_secuencia" in _falla(
        pg,
        f"insert into {TABLA_NUEVA} (application_id, sequence, kind, terms_policy_id, terms_version, "
        "terms_sha256, snapshot, snapshot_sha256) values (%s, 1, 'resubmitted', %s, 1, %s, '{}', %s)",
        solicitud, politica[0], politica[1], "b" * 64,
    )
    for columna, valor, nombre in (
        ("sequence", "0", "secuencia"),
        ("kind", "'draft'", "tipo"),
        ("terms_version", "0", "version"),
        ("terms_sha256", "'ABC'", "huella_de_terminos"),
        ("snapshot_sha256", f"'{'G' * 64}'", "huella_del_envio"),
    ):
        valores = {
            "sequence": "7", "kind": "'resubmitted'", "terms_version": "1",
            "terms_sha256": f"'{politica[1]}'", "snapshot_sha256": f"'{'c' * 64}'",
        } | {columna: valor}
        assert f"{TABLA_NUEVA}_{nombre}" in _falla(
            pg,
            f"insert into {TABLA_NUEVA} (application_id, terms_policy_id, snapshot, "
            f"{', '.join(valores)}) values (%s, %s, '{{}}', {', '.join(valores.values())})",
            solicitud, politica[0],
        ), columna
    # Un segundo envío es OTRA fila.
    assert _envio(pg, solicitud, politica, secuencia=2, kind="resubmitted")
    # Y la versión aceptada no se borra mientras un envío la cite. La guarda de
    # la 0086 lo impide antes; se apaga DENTRO de una transacción que se
    # deshace entera, para ver que la clave ajena también lo impide.
    assert "foreign key" in _falla_al_confirmar(
        pg,
        ("alter table service_policies disable trigger user",),
        ("delete from service_policies where id = %s", politica[0]),
    )
    assert _uno(
        pg, "select count(*) from pg_trigger where tgrelid = 'public.service_policies'::regclass "
        "and not tgisinternal and tgenabled = 'D'"
    ) == 0


@SIN_POSTGRES
def test_el_ciclo_de_vida_de_un_documento(completa) -> None:
    pg = completa
    perfil, prestador, solicitud = _postulacion(pg)
    viejo = _documento(pg, prestador, solicitud, perfil)
    nuevo = _documento(pg, prestador, solicitud, perfil)
    assert _uno(pg, "select lifecycle from service_provider_documents where id = %s", viejo) == "active"
    for sql, nombre in (
        ("update service_provider_documents set lifecycle = 'deleted', lifecycle_changed_at = now() where id = %s", "_ciclo"),
        ("update service_provider_documents set lifecycle = 'removed' where id = %s", "_ciclo_con_fecha"),
        ("update service_provider_documents set lifecycle_changed_at = now() where id = %s", "_ciclo_con_fecha"),
        ("update service_provider_documents set lifecycle = 'replaced', lifecycle_changed_at = now() where id = %s", "_reemplazo_coherente"),
        ("update service_provider_documents set lifecycle = 'replaced', lifecycle_changed_at = now(), replaced_by = id where id = %s", "_reemplazo_coherente"),
    ):
        assert f"service_provider_documents{nombre}" in _falla(pg, sql, viejo), sql
    # Por un documento de OTRA persona, no.
    otro_perfil, otro_prestador, otra = _postulacion(pg)
    ajeno = _documento(pg, otro_prestador, otra, otro_perfil)
    assert "reemplazado_por" in _falla(
        pg,
        "update service_provider_documents set lifecycle = 'replaced', lifecycle_changed_at = now(), "
        "replaced_by = %s where id = %s",
        ajeno, viejo,
    )
    _hacer(
        pg,
        "update service_provider_documents set lifecycle = 'replaced', lifecycle_changed_at = now(), "
        "replaced_by = %s where id = %s",
        nuevo, viejo,
    )
    _hacer(
        pg,
        "update service_provider_documents set lifecycle = 'removed', lifecycle_changed_at = now() where id = %s",
        nuevo,
    )
    # Retirar no es borrar: la fila sigue y borrarla suelta sigue prohibido.
    assert "no se borra" in _falla(pg, "delete from service_provider_documents where id = %s", nuevo)
    assert _uno(pg, "select count(*) from service_provider_documents where application_id = %s", solicitud) == 2
    assert "service_provider_documents_activos" in {
        f[0] for f in _todas(pg, "select indexname from pg_indexes where tablename = 'service_provider_documents'")
    }


@SIN_POSTGRES
def test_una_credencial_observada_es_una_declarada_con_motivo(completa) -> None:
    pg = completa
    perfil, prestador, solicitud = _postulacion(pg)
    credencial = _uno(
        pg,
        "insert into service_provider_credentials (provider_id, application_id, kind, title, issuer) "
        "values (%s, %s, 'certification', 'Curso', 'Instituto') returning id",
        prestador, solicitud,
    )
    assert "observada_coherente" in _falla(
        pg, "update service_provider_credentials set observed_at = now() where id = %s", credencial
    )
    _hacer(
        pg,
        "update service_provider_credentials set observed_at = now(), review_note = 'Falta la fecha.' "
        "where id = %s",
        credencial,
    )
    assert "observada_coherente" in _falla(
        pg, "update service_provider_credentials set status = 'rejected' where id = %s", credencial
    )
    for sql, nombre in (
        ("update service_provider_credentials set lifecycle = 'replaced', lifecycle_changed_at = now() where id = %s", "_ciclo"),
        ("update service_provider_credentials set lifecycle = 'removed' where id = %s", "_ciclo_con_fecha"),
    ):
        assert f"service_provider_credentials{nombre}" in _falla(pg, sql, credencial), sql
    _hacer(
        pg,
        "update service_provider_credentials set lifecycle = 'removed', lifecycle_changed_at = now() where id = %s",
        credencial,
    )
    assert "no se borra" in _falla(pg, "delete from service_provider_credentials where id = %s", credencial)


@SIN_POSTGRES
def test_el_historial_guarda_lo_pedido_y_sigue_sin_reescribirse(completa) -> None:
    pg = completa
    admin = _persona(pg, "admin")
    _, _, solicitud = _en_revision(pg, admin)
    _hacer(
        pg,
        "update service_provider_applications set status = 'changes_requested', "
        "applicant_message = 'Corrige el nombre legal.' where id = %s",
        solicitud,
    )
    evento = _uno(
        pg,
        "insert into service_provider_application_events (application_id, from_status, to_status, "
        "actor_id, actor_role, visible_note, details) values (%s, 'under_review', 'changes_requested', "
        "%s, 'reviewer', 'Corrige el nombre legal.', '{\"fields\": [\"legal_name\"]}'::jsonb) returning id",
        solicitud, admin,
    )
    assert _uno(pg, "select details->'fields'->>0 from service_provider_application_events where id = %s", evento) == "legal_name"
    sin_detalle = _uno(
        pg,
        "insert into service_provider_application_events (application_id, from_status, to_status, "
        "actor_id, actor_role) values (%s, 'changes_requested', 'resubmitted', %s, 'provider') returning id",
        solicitud, _uno(pg, "select p.profile_id from service_providers p join service_provider_applications a "
                            "on a.provider_id = p.id where a.id = %s", solicitud),
    )
    assert _uno(pg, "select details from service_provider_application_events where id = %s", sin_detalle) == {}
    assert "solo se añade" in _falla(
        pg, "update service_provider_application_events set details = '{}'::jsonb where id = %s", evento
    )


@SIN_POSTGRES
def test_borrar_la_cuenta_se_lleva_todo_lo_nuevo(completa) -> None:
    """`DELETE /me`: reemplazos, envíos congelados y un prestador aprobado caen
    en cascada sin que ninguna regla nueva lo impida."""
    pg = completa
    admin = _persona(pg, "admin")
    perfil, prestador, solicitud = _en_revision(pg, admin)
    viejo = _documento(pg, prestador, solicitud, perfil)
    nuevo = _documento(pg, prestador, solicitud, perfil)
    _hacer(
        pg,
        "update service_provider_documents set lifecycle = 'replaced', lifecycle_changed_at = now(), "
        "replaced_by = %s where id = %s",
        nuevo, viejo,
    )
    _hacer(
        pg,
        "insert into service_provider_credentials (provider_id, application_id, kind, title, issuer, "
        "evidence_document_id) values (%s, %s, 'certification', 'Curso', 'Instituto', %s)",
        prestador, solicitud, viejo,
    )
    _envio(pg, solicitud, _politica(pg, admin))
    _en_una(pg, (APROBAR, admin, solicitud), (PRESTADOR, "active", prestador))

    _hacer(pg, "delete from public.profiles where id = %s", perfil)
    for tabla, columna, valor in (
        ("service_providers", "id", prestador),
        ("service_provider_applications", "id", solicitud),
        ("service_provider_documents", "provider_id", prestador),
        ("service_provider_credentials", "provider_id", prestador),
        ("service_provider_application_events", "application_id", solicitud),
        (TABLA_NUEVA, "application_id", solicitud),
    ):
        assert not _uno(pg, f"select count(*) from {tabla} where {columna} = %s", valor), tabla


# --- 2.2 Escenarios: rehacen la base (van al final) ------------------------- #
def _foto(pg) -> dict:
    """Todo lo que la 0088 crea o toca, para comparar antes y después."""
    return {
        "restricciones": sorted(_todas(
            pg,
            "select conrelid::regclass::text, conname, pg_get_constraintdef(oid) from pg_constraint "
            "where conrelid::regclass::text like 'service\\_%%'",
        )),
        "columnas": sorted(_todas(
            pg,
            "select table_name, column_name, data_type, column_default, is_nullable "
            "from information_schema.columns where table_schema = 'public' and table_name like 'service\\_%%'",
        )),
        "indices": sorted(_todas(
            pg, "select indexname, indexdef from pg_indexes where tablename like 'service\\_%%'"
        )),
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
        "depositos": _todas(
            pg, "select id, public, file_size_limit, allowed_mime_types from storage.buckets order by id"
        ),
        "politicas": sorted(_todas(pg, "select schemaname, tablename, policyname from pg_policies")),
        "privilegios": sorted(_todas(
            pg,
            "select table_name, grantee, privilege_type from information_schema.table_privileges "
            "where table_name like 'service\\_%%'",
        )),
    }


@SIN_POSTGRES
def test_reejecutarla_deja_exactamente_lo_mismo(pg) -> None:
    _montar(pg)
    antes = _foto(pg)
    _hacer(pg, TEXTO)
    _hacer(pg, TEXTO)
    assert _foto(pg) == antes


def _columnas(pg, tabla: str) -> list[str]:
    return [f[0] for f in _todas(
        pg,
        "select column_name from information_schema.columns where table_schema = 'public' "
        "and table_name = %s order by ordinal_position",
        tabla,
    )]


def _filas(pg, tabla: str, columnas: list[str]) -> dict:
    lista = ", ".join(columnas)
    return dict(_todas(pg, f"select id::text, md5(row({lista})::text) from {tabla}"))


@SIN_POSTGRES
def test_sobre_una_base_con_la_0087_y_datos_no_reescribe_ninguna_fila(pg) -> None:
    _montar(pg, hasta="0087")
    admin = _persona(pg, "admin")
    politica = _politica(pg, admin)
    # Datos en varios estados, coherentes (como los deja la API).
    for paso in ("draft", "submitted", "under_review", "approved", "withdrawn"):
        perfil, prestador, solicitud = _postulacion(pg)
        documento = _documento(pg, prestador, solicitud, perfil)
        _hacer(
            pg,
            "insert into service_provider_credentials (provider_id, application_id, kind, title, "
            "issuer, evidence_document_id) values (%s, %s, 'certification', 'Curso', 'Instituto', %s)",
            prestador, solicitud, documento,
        )
        _hacer(
            pg,
            "insert into service_provider_application_events (application_id, to_status, actor_id, "
            "actor_role) values (%s, 'draft', %s, 'provider')",
            solicitud, perfil,
        )
        if paso in ("submitted", "under_review", "approved"):
            _hacer(pg, ENVIAR, "Resumen suficientemente largo del servicio.", politica[0], politica[1], solicitud)
        if paso in ("under_review", "approved"):
            _hacer(pg, REVISAR, solicitud)
        if paso == "approved":
            _hacer(pg, APROBAR, admin, solicitud)
            _hacer(pg, PRESTADOR, "active", prestador)
        if paso == "withdrawn":
            _hacer(pg, "update service_provider_applications set status = 'withdrawn' where id = %s", solicitud)

    tablas = (
        "service_policies", "service_providers", "service_provider_applications",
        "service_provider_documents", "service_provider_credentials",
        "service_provider_application_events",
    )
    columnas = {t: _columnas(pg, t) for t in tablas}
    antes = {t: _filas(pg, t, columnas[t]) for t in tablas}
    assert all(antes[t] for t in tablas)

    _hacer(pg, TEXTO)

    for tabla in tablas:
        assert _filas(pg, tabla, columnas[tabla]) == antes[tabla], tabla
    assert _todas(pg, "select distinct lifecycle, lifecycle_changed_at from service_provider_documents") == [("active", None)]
    assert _todas(pg, "select distinct lifecycle, observed_at from service_provider_credentials") == [("active", None)]
    assert _todas(pg, "select distinct details from service_provider_application_events") == [({},)]
    # Todas las restricciones nuevas quedan VALIDADAS contra lo que ya había.
    assert not _todas(
        pg, "select conname from pg_constraint where conrelid::regclass::text like 'service\\_%%' and not convalidated"
    )


@SIN_POSTGRES
def test_si_lo_que_ya_hay_no_cumple_la_regla_se_detiene_sin_tocar_nada(pg) -> None:
    """Una aprobada con el prestador pendiente (lo que la 0086 permitía): la
    0088 no la «arregla» ni la deja bloqueada en silencio. Se para y la cuenta."""
    _montar(pg, hasta="0087")
    admin = _persona(pg, "admin")
    _, _, solicitud = _en_revision(pg, admin)
    _hacer(pg, APROBAR, admin, solicitud)
    antes = _foto(pg)
    mensaje = _falla(pg, TEXTO)
    _hacer(pg, "rollback")
    assert "La 0088 encontró 1 prestadores" in mensaje
    assert _foto(pg) == antes
    assert not _uno(pg, "select to_regclass(%s)", f"public.{TABLA_NUEVA}")


@SIN_POSTGRES
def test_es_todo_o_nada(pg) -> None:
    _montar(pg, hasta="0087")
    antes = _foto(pg)
    cuerpo, _, cola = TEXTO.rpartition("\ncommit;")
    assert cola.strip() == ""
    _falla(pg, cuerpo + "\nselect 1 / 0;\ncommit;\n")
    _hacer(pg, "rollback")
    assert _foto(pg) == antes
    assert not _uno(pg, "select count(*) from pg_proc where proname = %s", FUNCION_NUEVA)
    assert not _uno(pg, "select count(*) from storage.buckets where id = %s", documentos.DEPOSITO)


@SIN_POSTGRES
@pytest.mark.parametrize(
    ("hasta", "quitar", "mensaje"),
    [
        ("0085", None, "La 0088 requiere la 0086"),
        ("0086", None, "La 0088 requiere la 0087"),
        (
            "0087",
            "drop function public.servicios_borrado_solo_en_cascada() cascade",
            "faltan sus funciones de historial",
        ),
    ],
)
def test_sin_lo_anterior_se_detiene_sin_tocar_nada(pg, hasta, quitar, mensaje) -> None:
    _montar(pg, hasta=hasta)
    if quitar:
        _hacer(pg, quitar)
    antes = _foto(pg)
    assert mensaje in _falla(pg, TEXTO)
    _hacer(pg, "rollback")
    assert _foto(pg) == antes
    assert not _uno(pg, "select count(*) from storage.buckets where id = %s", documentos.DEPOSITO)
