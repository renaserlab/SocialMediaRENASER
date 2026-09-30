"""La migración 0090: el catálogo y la publicación de Servicios (Incremento 2).

1. ESTÁTICA: es la última, sigue a la 0089, las aplicadas no han cambiado,
   es una sola transacción que comprueba lo anterior antes de crear nada, no
   concede permisos, no borra datos y no trae nada de dinero.
2. CONTRA POSTGRESQL, sobre la cadena entera: cerrada (RLS, cero políticas,
   cero privilegios), igual a los modelos, y cada disparador haciendo su
   trabajo (saltos, lo enviado congelado, imágenes solo en borrador, nadie se
   publica a sí mismo, historial que solo se añade, borrado solo en cascada,
   coherencia al confirmar, categorías de dos niveles).
3. LA APLICACIÓN: sobre una base con la 0089 y datos no toca nada, se puede
   reejecutar, un fallo a mitad no deja nada y sin la 0089 se niega.

EL ORDEN IMPORTA: las primeras comparten una base entera; las del final la
rehacen.
"""

from __future__ import annotations

import hashlib
import os
import re
import uuid

import pytest

from tests.test_migraciones_reales import MIGRACIONES, PROLOGO, exigir_url_desechable

ARCHIVO = MIGRACIONES / "0090_servicios_catalogo_y_publicacion.sql"
TEXTO = ARCHIVO.read_text(encoding="utf-8").replace("\r\n", "\n")
URL = os.environ.get("MIGRACIONES_DATABASE_URL", "").strip()
SIN_POSTGRES = pytest.mark.skipif(
    not URL,
    reason="sin PostgreSQL desechable: define MIGRACIONES_DATABASE_URL (ver tests/test_migraciones_reales.py)",
)

TABLAS = ("service_categories", "services", "service_versions", "service_version_images", "service_events")

#: Huella git de las migraciones de Servicios y de la baja, ya APLICADAS.
APLICADAS = {
    "0086_servicios_admision.sql": "882084132e161d143ff69707ad3f92b7cd68eedb",
    "0087_servicios_retirada.sql": "359f330a9ee99d22f3c2f719cb0adf557e58d7e8",
    "0088_servicios_documentos_y_envios.sql": "dfa1616cce9cbcdb4a44cf0a1b6dc619c3cd5f38",
    "0089_baja_de_cuenta_con_historial_anonimo.sql": "dcae3160a27b01a98114b69cc79de868681008f1",
    # Aplicada en Supabase y verificada sin divergencias el 29/09/2026
    # (Z_SERVICIOS_ARQUITECTURA.md §32): desde entonces tampoco se edita.
    "0090_servicios_catalogo_y_publicacion.sql": "9abe063feab11a7f99c2e5c4cdf87989c47e1137",
}


def _sin_comentarios(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


SQL = _sin_comentarios(TEXTO)


# =========================================================================== #
# 1. Estática
# =========================================================================== #
def test_es_la_ultima_y_sigue_a_la_0089() -> None:
    nombres = sorted(p.name for p in MIGRACIONES.glob("*.sql"))
    assert nombres[-1] == ARCHIVO.name
    assert nombres[-2].startswith("0089_")


@pytest.mark.parametrize("nombre", sorted(APLICADAS))
def test_las_aplicadas_no_han_cambiado(nombre) -> None:
    contenido = (MIGRACIONES / nombre).read_bytes().replace(b"\r\n", b"\n")
    assert hashlib.sha1(f"blob {len(contenido)}\0".encode() + contenido).hexdigest() == APLICADAS[nombre]


def test_es_una_unica_transaccion() -> None:
    sentencias = [s.strip() for s in SQL.split(";") if s.strip()]
    assert sentencias[0] == "begin" and sentencias[-1] == "commit"
    assert len(re.findall(r"^\s*begin\s*;", SQL, flags=re.M)) == 1
    assert len(re.findall(r"^\s*commit\s*;", SQL, flags=re.M)) == 1


def test_comprueba_lo_anterior_antes_de_crear_nada() -> None:
    assert SQL.index("La 0090 requiere la 0086") < SQL.index("create table")


def test_no_concede_ni_borra_ni_toca_lo_anterior() -> None:
    codigo = SQL.lower()
    for prohibido in (
        r"\bgrant\b", r"drop\s+table", r"drop\s+column", r"delete\s+from", r"\bupdate\s+public\.",
        r"\btruncate\b", r"disable\s+row\s+level\s+security", r"security\s+definer",
        r"disable\s+trigger", r"session_replication_role", r"create\s+policy",
    ):
        assert not re.search(prohibido, codigo), prohibido
    # Las tablas que altera son SOLO las suyas.
    alteradas = set(re.findall(r"alter\s+table\s+public\.([a-z_]+)", codigo))
    assert alteradas <= set(TABLAS)
    creadas = re.findall(r"create\s+table\s+if\s+not\s+exists\s+public\.([a-z_]+)", codigo)
    assert creadas == list(TABLAS)


def test_no_trae_nada_de_dinero_ni_de_reservas() -> None:
    codigo = SQL.lower()
    for palabra in ("stripe", "payment", "commission", "fee", "balance", "payout", "booking", "slot", "hold"):
        assert palabra not in codigo, palabra


def test_el_deposito_es_el_que_usa_la_api() -> None:
    from app.modules.services import catalogo_imagenes
    from app.modules.services.catalogo_models import PESO_MAXIMO_DE_LA_IMAGEN, TIPOS_DE_IMAGEN
    from app.shared import storage

    assert f"'{catalogo_imagenes.DEPOSITO}'" in SQL
    assert "5::bigint * 1024 * 1024" in SQL and PESO_MAXIMO_DE_LA_IMAGEN == 5 * 1024 * 1024
    tipos = re.search(r"allowed_mime_types = array\[([^\]]*)\]", SQL).group(1)
    assert set(re.findall(r"'([^']+)'", tipos)) == set(TIPOS_DE_IMAGEN)
    # Borrar la cuenta lo barre: la ruta empieza por el perfil.
    assert catalogo_imagenes.DEPOSITO in storage.USER_BUCKETS


# =========================================================================== #
# 2. Contra PostgreSQL
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
        with pg.transaction():
            _hacer(pg, sql, *args)
    return str(error.value)


def _falla_al_confirmar(pg, *sentencias: tuple) -> str:
    import psycopg

    with pytest.raises(psycopg.Error) as error:
        with pg.transaction():
            for sql, *args in sentencias:
                _hacer(pg, sql, *args)
    return str(error.value)


def _persona(pg, rol: str = "user") -> str:
    ident = str(uuid.uuid4())
    _hacer(
        pg,
        "insert into auth.users (id, email, raw_user_meta_data) values (%s, %s, "
        "jsonb_build_object('full_name', 'P', 'username', %s::text))",
        ident, f"p-{ident[:8]}@x.test", f"p{ident[:8]}",
    )
    _hacer(pg, "update public.profiles set role = %s where id = %s", rol, ident)
    return ident


def _prestador(pg, estado: str = "active") -> tuple[str, str]:
    """`(perfil, prestador)`. Sembrado sin la admisión (su coherencia es de la
    0088 y se prueba allí): lo que aquí importa es el catálogo."""
    perfil = _persona(pg)
    with pg.transaction():
        _hacer(pg, "set local session_replication_role = replica")
        prestador = _uno(
            pg,
            "insert into public.service_providers (profile_id, provider_type, display_name, country_code, "
            "status, activated_at, suspended_at) values (%s, 'individual', 'Ana', 'PE', %s, "
            "case when %s = 'active' then now() end, case when %s = 'suspended' then now() end) returning id",
            perfil, estado, estado, estado,
        )
    return perfil, str(prestador)


def _categoria(pg, estado: str = "active", madre: str | None = None) -> str:
    slug = f"c-{uuid.uuid4().hex[:10]}"
    categoria = _uno(
        pg,
        "insert into public.service_categories (slug, name, parent_id) values (%s, 'Asesoría', %s) returning id",
        slug, madre,
    )
    if estado != "active":
        _hacer(pg, "update public.service_categories set status = %s where id = %s", estado, categoria)
    return str(categoria)


def _servicio(pg) -> tuple[str, str, str, str]:
    """`(perfil, prestador, servicio, versión borrador)`."""
    perfil, prestador = _prestador(pg)
    servicio = str(_uno(
        pg, "insert into public.services (provider_id, category_id) values (%s, %s) returning id",
        prestador, _categoria(pg),
    ))
    version = str(_uno(
        pg, "insert into public.service_versions (service_id, version) values (%s, 1) returning id", servicio
    ))
    return perfil, prestador, servicio, version


COMPLETAR = (
    "update public.service_versions set title = 'Asesoría contable', summary = 'Ordenamos tus cuentas.', "
    "description = 'Una sesión para ordenar ingresos y gastos del mes.', modality = 'virtual', "
    "duration_minutes = 60, price_model = 'fixed', price_minor = 12000, currency = 'PEN', "
    "scope = 'Personas con negocio propio.', includes = '[\"Revisión\"]', excludes = '[\"Declaración anual\"]', "
    "requirements = 'Traer facturas.' where id = %s"
)


def _imagen(pg, perfil: str, servicio: str, version: str, *, portada: bool = True) -> str:
    return str(_uno(
        pg,
        "insert into public.service_version_images (version_id, service_id, storage_path, alt_text, is_cover, "
        "content_type, byte_size, width, height, checksum_sha256) values (%s, %s, %s, 'Una foto', %s, "
        "'image/png', 10, 4, 4, repeat('a', 64)) returning id",
        version, servicio, f"{perfil}/{servicio}/{version}/{uuid.uuid4()}.png", portada,
    ))


def _enviada(pg) -> tuple[str, str, str, str]:
    perfil, prestador, servicio, version = _servicio(pg)
    _hacer(pg, COMPLETAR, version)
    _imagen(pg, perfil, servicio, version)
    _hacer(pg, "update public.service_versions set status = 'submitted', submitted_at = now() where id = %s", version)
    return perfil, prestador, servicio, version


def _publicada(pg, admin: str) -> tuple[str, str, str, str]:
    perfil, prestador, servicio, version = _enviada(pg)
    with pg.transaction():
        _hacer(pg, "update public.service_versions set status = 'under_review', review_started_at = now(), "
                   "reviewed_by = %s where id = %s", admin, version)
        _hacer(pg, "update public.service_versions set status = 'approved', decided_at = now(), "
                   "decided_by = %s where id = %s", admin, version)
        _hacer(pg, "update public.service_versions set status = 'published', published_at = now(), "
                   "published_by = %s where id = %s", admin, version)
        _hacer(pg, "update public.services set status = 'published', published_at = now(), "
                   "first_published_at = now() where id = %s", servicio)
    return perfil, prestador, servicio, version


@SIN_POSTGRES
def test_desde_cero_queda_cerrada(completa) -> None:
    pg = completa
    for tabla in TABLAS:
        assert _uno(pg, "select relrowsecurity from pg_class where oid = %s::regclass", f"public.{tabla}"), tabla
        assert _uno(pg, "select count(*) from pg_policies where schemaname = 'public' and tablename = %s", tabla) == 0
        for rol in ("anon", "authenticated"):
            for privilegio in ("select", "insert", "update", "delete"):
                assert not _uno(pg, "select has_table_privilege(%s, %s, %s)", rol, f"public.{tabla}", privilegio)
    for funcion in re.findall(r"create or replace function public\.([a-z_]+)\(\)", TEXTO):
        for rol in ("anon", "authenticated"):
            assert not _uno(pg, "select has_function_privilege(%s, %s, 'execute')", rol, f"public.{funcion}()"), funcion
    assert _todas(pg, "select public, file_size_limit from storage.buckets where id = 'service-media'") == [
        (False, 5242880)
    ]


@SIN_POSTGRES
def test_la_base_es_la_de_los_modelos(completa) -> None:
    pg = completa
    from app.modules.services.catalogo_models import (
        Service,
        ServiceCategory,
        ServiceEvent,
        ServiceVersion,
        ServiceVersionImage,
    )

    for modelo in (ServiceCategory, Service, ServiceVersion, ServiceVersionImage, ServiceEvent):
        tabla = modelo.__tablename__
        columnas = {
            n: nula == "YES"
            for n, nula in _todas(
                pg,
                "select column_name, is_nullable from information_schema.columns "
                "where table_schema = 'public' and table_name = %s",
                tabla,
            )
        }
        assert set(columnas) == {c.name for c in modelo.__table__.columns}, tabla
        for c in modelo.__table__.columns:
            if not c.primary_key and c.server_default is None:
                assert columnas[c.name] == bool(c.nullable), f"{tabla}.{c.name}"
        checks = {f[0] for f in _todas(
            pg, "select conname from pg_constraint where contype = 'c' and conrelid = %s::regclass", tabla
        )}
        del_modelo = {c.name for c in modelo.__table__.constraints if type(c).__name__ == "CheckConstraint"}
        assert {c for c in checks if not c.endswith("_not_null")} == del_modelo, tabla
        unicas = {f[0] for f in _todas(
            pg, "select conname from pg_constraint where contype in ('u', 'p') and conrelid = %s::regclass", tabla
        )}
        indices = {f[0] for f in _todas(
            pg, "select indexname from pg_indexes where schemaname = 'public' and tablename = %s", tabla
        )} - unicas
        assert indices == {i.name for i in modelo.__table__.indexes}, tabla
        claves = {f[0] for f in _todas(
            pg, "select conname from pg_constraint where contype = 'f' and conrelid = %s::regclass", tabla
        )}
        del_modelo = {
            c.name for c in modelo.__table__.constraints
            if type(c).__name__ == "ForeignKeyConstraint" and c.name
        }
        assert del_modelo <= claves, tabla


# --- Los disparadores ------------------------------------------------------ #
@SIN_POSTGRES
def test_un_servicio_nace_de_un_prestador_activo_en_una_categoria_activa(completa) -> None:
    pg = completa
    _, pendiente = _prestador(pg, "pending")
    _, activo = _prestador(pg)
    assert "prestador aprobado" in _falla(
        pg, "insert into public.services (provider_id, category_id) values (%s, %s)", pendiente, _categoria(pg)
    )
    assert "inactiva" in _falla(
        pg, "insert into public.services (provider_id, category_id) values (%s, %s)", activo, _categoria(pg, "inactive")
    )
    assert "nace en borrador" in _falla(
        pg, "insert into public.services (provider_id, category_id, status, published_at, first_published_at) "
            "values (%s, %s, 'published', now(), now())", activo, _categoria(pg)
    )


@SIN_POSTGRES
def test_la_version_solo_da_los_saltos_del_mapa(completa) -> None:
    pg = completa
    _, _, _, version = _enviada(pg)
    # Aprobar sin revisión, publicar sin aprobar: no existen.
    assert "no puede pasar" in _falla(
        pg, "update public.service_versions set status = 'approved', decided_at = now(), decided_by = %s "
            "where id = %s", str(uuid.uuid4()), version
    )
    assert "no puede pasar" in _falla(
        pg, "update public.service_versions set status = 'published', published_at = now(), published_by = %s "
            "where id = %s", str(uuid.uuid4()), version
    )
    # Volver a borrador lo enviado, tampoco.
    assert "no puede pasar" in _falla(pg, "update public.service_versions set status = 'draft' where id = %s", version)
    _, _, _, borrador = _servicio(pg)
    assert "nace en borrador" in _falla(
        pg, "insert into public.service_versions (service_id, version, status, submitted_at) "
            "select service_id, 2, 'submitted', now() from public.service_versions where id = %s", borrador
    )


@SIN_POSTGRES
def test_lo_enviado_no_se_reescribe(completa) -> None:
    pg = completa
    _, _, _, version = _enviada(pg)
    assert "congelado" in _falla(
        pg, "update public.service_versions set title = 'Otro título' where id = %s", version
    )
    assert "congelado" in _falla(
        pg, "update public.service_versions set price_minor = 1 where id = %s", version
    )
    # Cambiar el estado (lo que hace la revisión) sí.
    _hacer(pg, "update public.service_versions set status = 'under_review', review_started_at = now(), "
               "reviewed_by = %s where id = %s", str(uuid.uuid4()), version)
    # Tampoco lo aprobado ni lo PUBLICADO: lo que ve el público es exactamente
    # lo que se revisó.
    _hacer(pg, "update public.service_versions set status = 'approved', decided_at = now(), "
               "decided_by = %s where id = %s", str(uuid.uuid4()), version)
    assert "congelado" in _falla(
        pg, "update public.service_versions set summary = 'Otra promesa distinta.' where id = %s", version
    )
    _, _, _, publicada = _publicada(pg, str(uuid.uuid4()))
    for cambio in ("title = 'Otro título'", "price_minor = 1", "includes = '[\"Otra cosa\"]'",
                   "location_area = 'Otra zona'"):
        assert "congelado" in _falla(pg, f"update public.service_versions set {cambio} where id = %s", publicada), cambio


@SIN_POSTGRES
def test_enviar_exige_portada_e_incluidos(completa) -> None:
    pg = completa
    perfil, _, servicio, version = _servicio(pg)
    _hacer(pg, COMPLETAR, version)
    assert "portada" in _falla(
        pg, "update public.service_versions set status = 'submitted', submitted_at = now() where id = %s", version
    )
    _imagen(pg, perfil, servicio, version, portada=False)
    assert "portada" in _falla(
        pg, "update public.service_versions set status = 'submitted', submitted_at = now() where id = %s", version
    )
    _imagen(pg, perfil, servicio, version)
    _hacer(pg, "update public.service_versions set includes = '[]' where id = %s", version)
    assert "incluye" in _falla(
        pg, "update public.service_versions set status = 'submitted', submitted_at = now() where id = %s", version
    )
    # Y el suelo de lo completo: sin título no hay envío.
    _hacer(pg, COMPLETAR, version)
    _hacer(pg, "update public.service_versions set title = null where id = %s", version)
    assert "completa_al_enviar" in _falla(
        pg, "update public.service_versions set status = 'submitted', submitted_at = now() where id = %s", version
    )


@SIN_POSTGRES
def test_las_imagenes_solo_cambian_en_un_borrador_y_con_su_ruta(completa) -> None:
    pg = completa
    perfil, _, servicio, version = _enviada(pg)
    assert "solo cambian en un borrador" in _falla(
        pg,
        "insert into public.service_version_images (version_id, service_id, storage_path, alt_text, content_type, "
        "byte_size, width, height, checksum_sha256) values (%s, %s, %s, 'Otra', 'image/png', 1, 1, 1, repeat('b', 64))",
        version, servicio, f"{perfil}/{servicio}/{version}/otra.png",
    )
    imagen = _uno(pg, "select id from public.service_version_images where version_id = %s", version)
    assert "no se quita" in _falla(pg, "delete from public.service_version_images where id = %s", imagen)
    # En un borrador, la ruta es del prestador y de su servicio.
    ajeno, _, _, _ = _servicio(pg)
    perfil2, _, servicio2, borrador = _servicio(pg)
    assert "ruta" in _falla(
        pg,
        "insert into public.service_version_images (version_id, service_id, storage_path, alt_text, content_type, "
        "byte_size, width, height, checksum_sha256) values (%s, %s, %s, 'Ajena', 'image/png', 1, 1, 1, repeat('c', 64))",
        borrador, servicio2, f"{ajeno}/{servicio2}/{borrador}/x.png",
    )
    # Y de ese servicio: no de otro del mismo prestador (la clave compuesta).
    prestador2 = _uno(pg, "select provider_id from public.services where id = %s", servicio2)
    otro = str(_uno(
        pg, "insert into public.services (provider_id, category_id) values (%s, %s) returning id",
        prestador2, _categoria(pg),
    ))
    assert "service_version_images_de_su_version" in _falla(
        pg,
        "insert into public.service_version_images (version_id, service_id, storage_path, alt_text, content_type, "
        "byte_size, width, height, checksum_sha256) values (%s, %s, %s, 'Cruzada', 'image/png', 1, 1, 1, repeat('d', 64))",
        borrador, otro, f"{perfil2}/{otro}/{borrador}/x.png",
    )


@SIN_POSTGRES
def test_nadie_revisa_ni_publica_lo_suyo(completa) -> None:
    pg = completa
    perfil, _, servicio, version = _enviada(pg)
    assert "propio servicio" in _falla(
        pg, "update public.service_versions set status = 'under_review', review_started_at = now(), "
            "reviewed_by = %s where id = %s", perfil, version
    )
    assert "propio servicio" in _falla(
        pg, "insert into public.service_events (service_id, version_id, action, to_status, actor_id, actor_role) "
            "values (%s, %s, 'review_started', 'under_review', %s, 'admin')", servicio, version, perfil
    )


@SIN_POSTGRES
def test_el_historial_solo_se_anade_y_nada_se_borra_suelto(completa) -> None:
    pg = completa
    perfil, _, servicio, version = _servicio(pg)
    evento = _uno(
        pg, "insert into public.service_events (service_id, version_id, action, to_status, actor_id, actor_role) "
            "values (%s, %s, 'created', 'draft', %s, 'provider') returning id", servicio, version, perfil
    )
    assert "solo se añade" in _falla(pg, "update public.service_events set to_status = 'x' where id = %s", evento)
    assert "no se borra" in _falla(pg, "delete from public.service_events where id = %s", evento)
    assert "no se borra" in _falla(pg, "delete from public.service_versions where id = %s", version)
    assert "no se borra" in _falla(pg, "delete from public.services where id = %s", servicio)
    # Pedir cambios sin motivo visible: no.
    assert "service_events_con_motivo" in _falla(
        pg, "insert into public.service_events (service_id, version_id, action, to_status, actor_id, actor_role) "
            "values (%s, %s, 'changes_requested', 'changes_requested', %s, 'reviewer')",
        servicio, version, str(uuid.uuid4()),
    )


@SIN_POSTGRES
def test_una_abierta_y_una_publicada_y_coherencia_al_confirmar(completa) -> None:
    pg = completa
    admin = _persona(pg, "admin")
    _, _, servicio, version = _servicio(pg)
    assert "service_versions_una_abierta" in _falla(
        pg, "insert into public.service_versions (service_id, version) values (%s, 2)", servicio
    )
    # Un servicio publicado sin versión publicada no se confirma.
    assert "exactamente una versión publicada" in _falla_al_confirmar(
        pg, ("update public.services set status = 'published', published_at = now(), first_published_at = now() "
             "where id = %s", servicio)
    )
    _, _, _, v1 = _publicada(pg, admin)
    # Una segunda publicada del mismo servicio, copia exacta de la primera y
    # saltándose los disparadores: el índice sigue impidiéndolo.
    import psycopg

    with pytest.raises(psycopg.Error) as error:
        with pg.transaction():
            _hacer(pg, "set local session_replication_role = replica")
            _hacer(
                pg,
                "insert into public.service_versions (service_id, version, status, title, summary, description, "
                "modality, duration_minutes, price_model, price_minor, currency, scope, includes, excludes, "
                "requirements, submitted_at, review_started_at, decided_at, decided_by, published_at, published_by) "
                "select service_id, 2, 'published', title, summary, description, modality, duration_minutes, "
                "price_model, price_minor, currency, scope, includes, excludes, requirements, submitted_at, "
                "review_started_at, decided_at, decided_by, published_at, published_by "
                "from public.service_versions where id = %s",
                v1,
            )
    assert "service_versions_una_publicada" in str(error.value)
    del version


@SIN_POSTGRES
def test_categorias_de_dos_niveles_que_no_se_borran(completa) -> None:
    pg = completa
    madre = _categoria(pg)
    hija = _categoria(pg, madre=madre)
    assert "Una subcategoría no puede tener subcategorías" in _falla(
        pg, "insert into public.service_categories (slug, name, parent_id) values ('nieta-x', 'Nieta', %s)", hija
    )
    assert "no se borra" in _falla(pg, "delete from public.service_categories where id = %s", hija)
    assert "service_categories_slug" in _falla(
        pg, "insert into public.service_categories (slug, name) values ('Con Mayúsculas', 'Nombre válido')"
    )


@SIN_POSTGRES
def test_la_cuenta_se_borra_con_sus_servicios(completa) -> None:
    """La cascada de la baja pasa por todos los disparadores: servicio
    publicado, versiones, imágenes e historial se van con el perfil."""
    pg = completa
    admin = _persona(pg, "admin")
    perfil, prestador, servicio, version = _publicada(pg, admin)
    _hacer(
        pg, "insert into public.service_events (service_id, version_id, action, to_status, actor_id, actor_role) "
            "values (%s, %s, 'published', 'published', %s, 'admin')", servicio, version, admin,
    )
    with pg.transaction():
        _hacer(pg, "delete from public.profiles where id = %s", perfil)
    for tabla, columna in (("services", "id"), ("service_versions", "service_id"),
                           ("service_version_images", "service_id"), ("service_events", "service_id")):
        assert _uno(pg, f"select count(*) from public.{tabla} where {columna} = %s", servicio) == 0, tabla
    del prestador


# =========================================================================== #
# 3. La aplicación
# =========================================================================== #
def _foto(pg) -> dict:
    return {
        "tablas": _todas(pg, "select table_name from information_schema.tables where table_schema = 'public' order by 1"),
        "restricciones": _todas(
            pg, "select conrelid::regclass::text, conname, pg_get_constraintdef(oid) from pg_constraint "
                "where connamespace = 'public'::regnamespace order by 1, 2"
        ),
        "disparadores": _todas(
            pg, "select tgrelid::regclass::text, tgname, tgtype, tgenabled from pg_trigger "
                "where not tgisinternal order by 1, 2"
        ),
        "indices": _todas(pg, "select indexname, indexdef from pg_indexes where schemaname = 'public' order by 1"),
        "funciones": _todas(
            pg, "select proname, md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace order by 1, 2"
        ),
    }


@SIN_POSTGRES
def test_sobre_la_0089_con_datos_no_toca_nada(pg) -> None:
    _montar(pg, hasta="0089")
    _prestador(pg)
    _persona(pg, "admin")
    antes = {
        t: _uno(pg, f"select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.{t} t")
        for t in ("profiles", "service_providers", "service_provider_applications", "audit_events")
    }
    _hacer(pg, TEXTO)
    despues = {
        t: _uno(pg, f"select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.{t} t")
        for t in antes
    }
    assert despues == antes
    for tabla in TABLAS:
        assert _uno(pg, f"select count(*) from public.{tabla}") == 0


@SIN_POSTGRES
def test_reejecutarla_deja_exactamente_lo_mismo(pg) -> None:
    _montar(pg)
    antes = _foto(pg)
    _hacer(pg, TEXTO)
    assert _foto(pg) == antes


@SIN_POSTGRES
def test_un_fallo_a_mitad_no_deja_nada(pg) -> None:
    _montar(pg, hasta="0089")
    corte = TEXTO.index("-- 10. Verificación")
    import psycopg

    with pytest.raises(psycopg.Error):
        _hacer(pg, TEXTO[:corte] + "\nselect 1 / 0;\ncommit;\n")
    _hacer(pg, "rollback")
    for tabla in TABLAS:
        assert _uno(pg, "select to_regclass(%s)", f"public.{tabla}") is None, tabla
    assert _uno(pg, "select count(*) from storage.buckets where id = 'service-media'") == 0


@SIN_POSTGRES
def test_se_niega_a_terminar_con_un_indice_que_no_es_unico(pg) -> None:
    """La verificación final no se conforma con el NOMBRE del índice: uno que
    no sea único permitiría dos publicadas, y la 0090 no se da por buena."""
    _montar(pg, hasta="0089")
    viciada = TEXTO.replace(
        "create unique index if not exists service_versions_una_publicada",
        "create index if not exists service_versions_una_publicada",
    )
    assert viciada != TEXTO
    import psycopg

    with pytest.raises(psycopg.Error) as error:
        _hacer(pg, viciada)
    assert "índices únicos" in str(error.value) and "service_versions_una_publicada" in str(error.value)
    _hacer(pg, "rollback")
    assert _uno(pg, "select to_regclass('public.services')") is None


@SIN_POSTGRES
def test_sin_la_0089_se_niega_y_no_crea_nada(pg) -> None:
    _montar(pg, hasta="0088")
    import psycopg

    with pytest.raises(psycopg.Error) as error:
        _hacer(pg, TEXTO)
    assert "requiere" in str(error.value)
    _hacer(pg, "rollback")
    assert _uno(pg, "select to_regclass('public.services')") is None


@SIN_POSTGRES
def test_quien_actuo_no_tiene_clave_ajena(pg) -> None:
    """Como en la 0086 (S10): el historial y las decisiones sobreviven a la
    cuenta del personal, y un `set null` sería reescribir historia."""
    _montar(pg)
    for tabla, columna in (
        ("service_events", "actor_id"),
        ("service_versions", "reviewed_by"),
        ("service_versions", "decided_by"),
        ("service_versions", "published_by"),
        ("service_versions", "created_by"),
        ("service_categories", "created_by"),
    ):
        assert not _todas(
            pg,
            "select 1 from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid "
            "and a.attnum = any (c.conkey) where c.contype = 'f' and c.conrelid = %s::regclass "
            "and a.attname = %s",
            f"public.{tabla}", columna,
        ), f"{tabla}.{columna}"
