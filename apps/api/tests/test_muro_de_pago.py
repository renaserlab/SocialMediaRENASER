"""Quien puede ver el contenido de un curso.

El acceso se decide en DOS sitios que tienen que decir lo mismo:

- `public.has_course_access()` en la base de datos (migracion 0016), que es la
  que manda: protege los archivos aunque alguien llame al almacenamiento
  saltandose la aplicacion.
- El endpoint `/payments/courses/{id}/access`, que solo sirve para que la
  interfaz sepa que mostrar.

Si los dos se separan, la app ensena "no tienes acceso" sobre contenido que si
se puede ver, o al reves: promete acceso y luego el video no carga. Estas
pruebas fijan las reglas para que un cambio en uno obligue a revisar el otro.
"""

import re
from pathlib import Path

import pytest

MIGRACION = (
    Path(__file__).resolve().parents[3]
    / "supabase"
    / "migrations"
    / "0016_course_paywall.sql"
)


@pytest.fixture(scope="module")
def sql() -> str:
    assert MIGRACION.exists(), f"No se encuentra la migracion en {MIGRACION}"
    return MIGRACION.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Las cuatro vias de acceso, y que ninguna se pierda
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "motivo,patron",
    [
        ("gratuito", r"price_minor\s*=\s*0"),
        ("autor del curso", r"author_id\s*=\s*auth\.uid\(\)"),
        ("administracion", r"public\.is_admin\(\)"),
        ("compra pagada", r"status\s*=\s*'paid'"),
    ],
)
def test_las_vias_de_acceso_siguen_declaradas(sql, motivo, patron):
    """Quitar una dejaria fuera a gente que si debe entrar.

    La mas facil de perder es la de GRATUITO: sin ella, aplicar el muro dejaria
    sin acceso a todo el mundo de golpe, porque hoy no hay ninguna fila en
    `purchases`.
    """
    assert re.search(patron, sql), f"Se perdio la via de acceso: {motivo}"


def test_pending_no_concede_acceso(sql):
    """Solo 'paid'. Un cobro a medias no da derecho al contenido.

    Se mira el SQL SIN comentarios: el propio fichero explica en prosa por que
    'pending' no basta, y buscar la palabra en el texto crudo daba positivo por
    el comentario en vez de por la logica.
    """
    sin_comentarios = "\n".join(
        linea.split("--")[0] for linea in sql.splitlines()
    )
    estados = set(re.findall(r"p\.status\s*=\s*'(\w+)'", sin_comentarios))
    assert estados == {"paid"}, (
        f"has_course_access compara con {estados}; solo debe aceptar 'paid'."
    )


# ---------------------------------------------------------------------------
# Donde se aplica: la puerta de verdad esta en el almacenamiento
# ---------------------------------------------------------------------------


def test_los_archivos_estan_protegidos_no_solo_las_tablas(sql):
    """La politica sobre `storage.objects` es la que cierra el agujero.

    Cerrar solo las tablas dejaria pedir una URL firmada del video y verlo sin
    haber comprado: era exactamente el fallo que corrigio esta migracion.
    """
    assert "storage.objects" in sql, "Falta proteger el bucket course-media"
    assert "course_media_read" in sql


def test_tambien_se_protegen_los_documentos(sql):
    """No solo los videos: el material descargable tambien se paga."""
    assert "course_lesson_resources" in sql


def test_la_funcion_no_la_recorta_la_propia_rls(sql):
    """`security definer` para poder consultar `purchases`.

    Sin el, la RLS de `purchases` recortaria la consulta que hace la propia
    funcion y una compra legitima no se veria: acceso denegado a quien pago.
    """
    bloque = sql.split("create or replace function public.has_course_access")[1][:600]
    assert "security definer" in bloque
    assert "search_path" in bloque, "Fijar search_path es obligatorio en security definer"


def test_la_migracion_se_puede_repetir(sql):
    """El editor de Supabase corre el script como una transaccion.

    Si un statement falla, revierte todo. Una migracion repetible se puede
    reintentar por partes sin dejar el esquema a medias.
    """
    assert "create or replace function" in sql
    assert "drop policy if exists" in sql
    assert "create index if not exists" in sql


def test_recarga_el_cache_de_postgrest(sql):
    """Sin esto, la API sigue sirviendo el esquema viejo y da PGRST205."""
    assert "notify pgrst" in sql


# ---------------------------------------------------------------------------
# El endpoint que consulta la interfaz
# ---------------------------------------------------------------------------


def test_el_endpoint_explica_el_motivo():
    """Devuelve POR QUE hay o no acceso, no un si/no seco.

    La interfaz necesita distinguir "es gratuito" de "lo compraste" de "no
    tienes acceso" para decir algo util en vez de un no sin explicacion.
    """
    from app.modules.payments.schemas import CourseAccessRead

    campos = set(CourseAccessRead.model_fields)
    assert {"course_id", "has_access", "reason"} <= campos


def test_los_motivos_del_endpoint_cubren_las_vias_de_la_base_de_datos():
    """Los motivos que responde la API son los mismos que aplica la RLS.

    Si aparece una via nueva en la migracion y no aqui, la interfaz enseñaria
    "sin acceso" sobre contenido que la base de datos si deja ver.
    """
    from app.modules.payments import router

    codigo = Path(router.__file__).read_text(encoding="utf-8")
    for motivo in ("gratuito", "autor", "administracion", "comprado", "sin_acceso"):
        assert f'"{motivo}"' in codigo or f"'{motivo}'" in codigo, (
            f"El endpoint de acceso no contempla el caso '{motivo}'"
        )
