"""Se LEE la migracion 0044 y se comprueba que dice lo que tiene que decir.

POR QUE ESTO EXISTE Y QUE NO SUSTITUYE. No ejecuta nada: aqui no hay PostgreSQL,
asi que no se prueba que la migracion CORRA, solo que este ESCRITA como debe.
Es el mismo enfoque que ya usa `test_mensajes_adjuntos.py` con la 0033 para
vigilar que nadie abra el bucket privado sin enterarse, y sirve para lo mismo:
que un cambio futuro no deshaga en silencio una decision que costo razonar.

LAS DOS COSAS QUE VIGILA, y las dos son fallos que no darian la cara al aplicar
la migracion sino semanas despues, en produccion:

1. EL NOMBRE DEL `CHECK` DE `kind`. Un `drop constraint if exists` con el nombre
   equivocado NO FALLA —el `if exists` se lo traga— y deja la restriccion vieja
   puesta, rechazando cada nota de voz en silencio. El nombre correcto es
   `message_attachments_kind_check`, que es el que PostgreSQL le pone a un
   `check` declarado en la columna: `<tabla>_<columna>_check`. La 0033 lo
   declaro asi, y la propia 0033 ya aplico esta misma deduccion con
   `messages_body_check`, igual que la 0042 con `stories_duration_ms_check`.

2. EL `ON DELETE SET NULL` DE `story_id`. Es lo unico que hace que un mensaje
   sobreviva a la historia que respondia. Con `cascade` —el descuido facil, y lo
   que se escribe por inercia— borrar una historia se llevaria por delante el
   contexto de todos los mensajes que la respondian.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

MIGRACIONES = Path(__file__).resolve().parents[3] / "supabase" / "migrations"


@pytest.fixture(scope="module")
def sql() -> str:
    ruta = MIGRACIONES / "0044_respuestas_a_historias_y_notas_de_voz.sql"
    assert ruta.exists(), f"no se encuentra la migracion 0044 en {MIGRACIONES}"
    return ruta.read_text(encoding="utf-8")


def _sin_comentarios(sql: str) -> str:
    """Solo lo que la base va a EJECUTAR.

    Esta migracion lleva mucha explicacion, y varias de las cadenas que se
    buscan abajo aparecen tambien en los comentarios y en el bloque de
    comprobaciones manuales del final. Sin quitarlos, una prueba pasaria porque
    algo esta *explicado*, no porque este *hecho*.
    """
    return "\n".join(
        linea for linea in sql.splitlines() if not linea.lstrip().startswith("--")
    )


# --------------------------------------------------------------------------- #
# 1. El `CHECK` de `kind`
# --------------------------------------------------------------------------- #
def test_el_nombre_del_check_es_el_que_le_puso_postgres(sql: str):
    """`<tabla>_<columna>_check`, deducido de como lo declaro la 0033."""
    ejecutable = _sin_comentarios(sql)
    assert re.search(
        r"drop\s+constraint\s+if\s+exists\s+message_attachments_kind_check",
        ejecutable,
        re.IGNORECASE,
    ), (
        "la 0044 no quita `message_attachments_kind_check`. Con otro nombre, el "
        "`drop` no falla —lleva `if exists`— y la restriccion vieja se queda "
        "rechazando los audios en silencio."
    )


def test_el_check_declarado_en_la_0033_sigue_siendo_una_restriccion_de_columna():
    """De aqui sale el nombre. Si la 0033 cambiara, la 0044 dejaria de valer.

    Es la prueba que ata las dos migraciones: el nombre no esta escrito en
    ningun sitio de PostgreSQL que se pueda consultar desde aqui, se DEDUCE de
    la forma en que la 0033 declaro la columna. Si alguien reescribiera esa
    declaracion con un `constraint ... check` con nombre propio, el nombre
    deducido dejaria de ser el correcto y esto avisa.
    """
    sql_0033 = (MIGRACIONES / "0033_adjuntos_de_chat.sql").read_text(encoding="utf-8")
    assert re.search(
        r"kind\s+text\s+not\s+null\s+check\s*\(\s*kind\s+in\s*\(", sql_0033
    ), (
        "la 0033 ya no declara `kind` con un check de COLUMNA sin nombre. El "
        "nombre `message_attachments_kind_check` que usa la 0044 se deduce de "
        "ahi: revisa cual es el real antes de tocar nada."
    )


def test_la_lista_nueva_admite_audio_y_conserva_los_tres_de_siempre(sql: str):
    """Solo AÑADE. Si quitara uno, la revalidacion fallaria contra filas reales."""
    ejecutable = _sin_comentarios(sql)
    add = re.search(
        r"add\s+constraint\s+message_attachments_kind_check\s+check\s*\((.*?)\)\s*;",
        ejecutable,
        re.IGNORECASE | re.DOTALL,
    )
    assert add, "la 0044 no repone el check de `kind` despues de quitarlo"
    cuerpo = add.group(1)
    for valor in ("image", "video", "document", "audio"):
        assert f"'{valor}'" in cuerpo, (
            f"falta '{valor}' en el check nuevo. Quitar un valor que ya existe "
            "en la tabla haria fallar la revalidacion contra datos reales."
        )


def test_la_migracion_comprueba_el_check_contra_pg_constraint(sql: str):
    """La comprobacion ACTIVA que impide el fallo silencioso del nombre.

    No basta con dejarlo escrito en un comentario: si el nombre fuera el
    equivocado, la migracion terminaria «bien» y el problema apareceria semanas
    despues al enviar la primera nota de voz. Tiene que ABORTAR.
    """
    ejecutable = _sin_comentarios(sql)
    assert "pg_constraint" in ejecutable, (
        "la 0044 no verifica el resultado contra pg_constraint"
    )
    assert re.search(r"raise\s+exception", ejecutable, re.IGNORECASE), (
        "la comprobacion no aborta. Una comprobacion que no falla no es una "
        "comprobacion: la migracion tiene que negarse a terminar si el `CHECK` "
        "no ha quedado como debe."
    )
    # Y busca las DOS cosas: que alguna admita audio, y que no quede ninguna
    # que no lo admita —que es la forma exacta del fallo del nombre—.
    assert re.search(r"not\s+like\s+'%audio%'", ejecutable, re.IGNORECASE), (
        "no se busca la restriccion SOBRANTE que no admite audio, que es "
        "justo como se manifestaria un `drop` con el nombre equivocado."
    )


# --------------------------------------------------------------------------- #
# 2. El contexto de historia
# --------------------------------------------------------------------------- #
def test_story_id_es_anulable_y_se_pone_a_nulo_al_borrar_la_historia(sql: str):
    """LA decision que sostiene toda la funcion.

    Con `cascade` —lo que se escribe por inercia— borrar una historia se
    llevaria el contexto de todos los mensajes que la respondian, y el chat
    perderia el hilo de la conversacion al dia siguiente de tenerla.
    """
    ejecutable = _sin_comentarios(sql)
    declaracion = re.search(
        r"story_id\s+uuid\s+references\s+public\.stories\s*\(\s*id\s*\)\s*"
        r"on\s+delete\s+set\s+null",
        ejecutable,
        re.IGNORECASE,
    )
    assert declaracion, (
        "`story_id` no es anulable con `on delete set null`. Sin eso, el "
        "mensaje no sobrevive a la caducidad de la historia, que es el caso "
        "NORMAL: una historia dura un dia y el mensaje dura para siempre."
    )
    assert not re.search(
        r"story_id\s+uuid\s+not\s+null", ejecutable, re.IGNORECASE
    ), "`story_id` no puede ser `not null`: la historia desaparece y el mensaje no"


def test_el_duenno_de_la_historia_se_conserva(sql: str):
    """Es lo unico que sigue diciendo de quien era cuando ya no existe."""
    ejecutable = _sin_comentarios(sql)
    assert re.search(
        r"story_owner_id\s+uuid\s+not\s+null\s+references\s+public\.profiles",
        ejecutable,
        re.IGNORECASE,
    ), (
        "`story_owner_id` tiene que ser `not null`: sin el, una vez caducada la "
        "historia el mensaje no podria ni decir de quien era."
    )


def test_el_contexto_cuelga_del_mensaje_y_se_va_con_el(sql: str):
    ejecutable = _sin_comentarios(sql)
    assert re.search(
        r"message_id\s+uuid\s+primary\s+key\s+references\s+public\.messages"
        r"\s*\(\s*id\s*\)\s*on\s+delete\s+cascade",
        ejecutable,
        re.IGNORECASE,
    ), "el contexto tiene que colgar del mensaje por clave primaria y con cascade"


def test_la_rls_esta_activada_en_la_tabla_nueva(sql: str):
    """Sin esto la tabla es legible por cualquier cuenta autenticada."""
    ejecutable = _sin_comentarios(sql)
    assert re.search(
        r"alter\s+table\s+public\.message_story_context\s+enable\s+row\s+level\s+security",
        ejecutable,
        re.IGNORECASE,
    )
    for politica in ("_read", "_insert", "_delete"):
        assert f"message_story_context{politica}" in ejecutable, (
            f"falta la politica message_story_context{politica}"
        )
    # No hay UPDATE, y es deliberado: a que historia respondia un mensaje es un
    # hecho del pasado, no algo que se reescriba.
    assert not re.search(
        r"create\s+policy\s+\S*message_story_context\S*\s+on[^;]*for\s+update",
        ejecutable,
        re.IGNORECASE,
    ), "no debe haber politica de UPDATE sobre el contexto"


# --------------------------------------------------------------------------- #
# 3. Nada destructivo
# --------------------------------------------------------------------------- #
def test_la_0044_no_borra_nada(sql: str):
    """Aditiva de principio a fin. Es una regla del proyecto, no una preferencia."""
    ejecutable = _sin_comentarios(sql).lower()
    for prohibido in ("drop table", "truncate", "delete from", "drop column"):
        assert prohibido not in ejecutable, (
            f"la 0044 contiene `{prohibido}`: las migraciones de este proyecto "
            "son aditivas y no tocan ninguna fila existente."
        )


def test_la_0044_no_anade_columnas_a_messages(sql: str):
    """Ninguna columna nueva en `messages`, `conversations` ni `profiles`.

    Un `select(Entidad)` de SQLAlchemy pide TODAS las columnas mapeadas: una
    columna nueva en una tabla tan consultada rompe produccion en cuanto el
    modelo se adelanta a la migracion. El contexto va en su tabla, por
    `message_id`.
    """
    ejecutable = _sin_comentarios(sql).lower()
    assert not re.search(r"alter\s+table\s+public\.messages\s+add\s+column", ejecutable)
    assert not re.search(
        r"alter\s+table\s+public\.conversations\s+add\s+column", ejecutable
    )
    assert not re.search(r"alter\s+table\s+public\.profiles\s+add\s+column", ejecutable)


def test_la_0044_no_toca_el_bucket_privado(sql: str):
    """`message-media` ya admitia audio desde la 0033. No hay nada que cambiar.

    Y no cambiarlo es lo correcto: cada politica de Storage que se reescribe es
    una oportunidad de abrir un bucket privado sin que nadie se entere.
    """
    ejecutable = _sin_comentarios(sql).lower()
    assert "storage.buckets" not in ejecutable
    assert "storage.objects" not in ejecutable


def test_avisa_de_reiniciar_la_api(sql: str):
    """La memoria de `esquema.py` vive en el PROCESO y no se entera sola."""
    assert "reinicia la api" in sql.lower()
