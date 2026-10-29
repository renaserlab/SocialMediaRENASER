"""La RLS de los mensajes (migración 0110): lo mismo que antes, sin preguntar fila a fila.

LO QUE DEFIENDEN ESTAS PRUEBAS. La 0110 reescribe cinco políticas de lectura
(`messages_read`, `conversation_members_read`, `conversations_read`,
`message_attachments_read` y `story_views_read`) para que PostgreSQL calcule
«de qué conversaciones soy» una vez por consulta en vez de una vez por fila, y
QUITA `messages_insert`, para que los mensajes solo los escriba la API. Una
política más rápida que deja ver una fila de más es una fuga; una que deja ver
una de menos es un chat que se queda en blanco. Por eso:

  1. LA MISMA VISIBILIDAD QUE ANTES, MEDIDA Y NO SUPUESTA. Para cada persona y
     cada tabla se leen las filas con las políticas de ANTES —las que había en
     la base al aplicar hasta la 0109, copiadas de `pg_policies`, no
     reescritas a mano— y con las de AHORA, en la misma base y con los mismos
     datos, y se exige que salga exactamente lo mismo.
  2. LO QUE VE CADA UNA, ESCRITO. La comparación sola daría por buena una
     política que estuviera mal antes y siga igual de mal; la tabla de lo que
     tiene que ver cada persona es la que dice qué significa «bien».
  3. LA INSERCIÓN (§5.8). La de la 0108 fallaba por permisos para todo el
     mundo, y si alguien concedía ese permiso dejaba de proteger los temas.
     Hoy nadie puede insertar directamente, y la 0110 deja exactamente eso,
     ahora a propósito: cada persona, en cada conversación, falla antes (por
     permisos) y falla después (por RLS), también con el permiso concedido.
     La API, que no pasa por la RLS, sigue escribiendo.
  4. QUE NINGUNA PREGUNTA FILA A FILA y que la migración se puede pegar dos
     veces, o rendirse sin dejar nada si no consigue el bloqueo.

EL REPARTO, con nombres para poder leer las expectativas:

  · `G`, un grupo de Ana, con Beto. Dani estuvo y ya no está (la API borra la
    fila al salir: no hay «miembro antiguo» con columna propia).
  · `D`, un chat de dos: Ana y Eva.
  · `TC`, el chat del tema «Anuncios» de `G` (lo creó Ana); `TB`, el de un
    tema ya borrado. Ana y Beto están en los dos.
  · `S`, una comunidad de `G` (0109) con Ana y Eva: estar en `G` no mete a
    Beto.
  · `X`, un grupo que creó Carla y del que Carla NO es miembro (la otra vía
    de `conversations_read`). `V`, uno vacío que creó Eva.
  · Historias: de Ana (una viva, una caducada), de Beto y de Eva (caducada).

`auth.uid()` del prólogo devuelve siempre nulo; aquí se sustituye por la de
Supabase, que lee el `sub` de `request.jwt.claims`, y se devuelve a su sitio al
terminar. Sin `MIGRACIONES_DATABASE_URL` la parte de PostgreSQL se omite.
"""

from __future__ import annotations

import json
import os
import re
import threading
import uuid

import pytest

from tests.test_migraciones_reales import MIGRACIONES, PROLOGO, exigir_url_desechable

ARCHIVO = MIGRACIONES / "0110_rls_de_mensajes.sql"
SQL = ARCHIVO.read_text(encoding="utf-8")
URL = os.environ.get("MIGRACIONES_DATABASE_URL", "").strip()
SIN_POSTGRES = pytest.mark.skipif(
    not URL,
    reason=(
        "sin PostgreSQL desechable: define MIGRACIONES_DATABASE_URL "
        "(ver la cabecera de tests/test_migraciones_reales.py)"
    ),
)

#: Las cinco lecturas: la tabla y cómo se identifica una fila.
LECTURAS = {
    "messages_read": ("messages", "id::text"),
    "conversation_members_read": (
        "conversation_members",
        "conversation_id::text || ':' || user_id::text",
    ),
    "conversations_read": ("conversations", "id::text"),
    "message_attachments_read": ("message_attachments", "id::text"),
    "story_views_read": ("story_views", "story_id::text || ':' || viewer_id::text"),
}
#: Las seis que había antes de la 0110 y que la 0110 toca: cinco se
#: reescriben y `messages_insert` se quita.
TOCADAS = (*LECTURAS, "messages_insert")
PERSONAS = ("ana", "beto", "carla", "dani", "eva", "admin", "anon")

AUTH_UID_DE_SUPABASE = """
create or replace function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$
"""
AUTH_UID_DEL_PROLOGO = """
create or replace function auth.uid() returns uuid
language sql stable as $$ select null::uuid $$
"""


def _sin_comentarios(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


# =========================================================================== #
# 1. Estática: lo que se pega en el editor
# =========================================================================== #
def test_va_justo_despues_de_la_0109() -> None:
    nombres = sorted(p.name for p in MIGRACIONES.glob("*.sql"))
    assert nombres[nombres.index(ARCHIVO.name) - 1].startswith("0109_")


def test_cada_politica_se_borra_antes_de_crearse() -> None:
    """El editor corre el script en una transacción: pegarlo dos veces no
    puede fallar en el segundo `create policy`."""
    codigo = _sin_comentarios(SQL)
    creadas = re.findall(r"create\s+policy\s+(\w+)\s+on\s+public\.(\w+)", codigo)
    assert sorted(nombre for nombre, _ in creadas) == sorted(LECTURAS)
    for nombre, tabla in creadas:
        borrar = codigo.find(f"drop policy if exists {nombre} on public.{tabla};")
        crear = codigo.find(f"create policy {nombre} on public.{tabla}")
        assert -1 < borrar < crear, f"{nombre} no se borra antes de crearse"


def test_quita_la_insercion_directa_y_no_la_sustituye() -> None:
    """Como la 0103 con las conversaciones y sus miembros: sin política de
    INSERT, la clave del cliente no inserta. Ni otra política ni una función
    que la reabra."""
    codigo = _sin_comentarios(SQL)
    assert "drop policy if exists messages_insert on public.messages;" in codigo
    assert not re.search(r"create\s+policy\s+\w+\s+on\s+public\.messages\s+for\s+(insert|all)", codigo)
    assert not re.search(r"create\s+policy\s+\w+\s+on\s+public\.messages\s+(using|with)", codigo)
    assert "puede_escribir_en_la_conversacion" not in codigo


def test_solo_crea_una_funcion_y_no_toca_datos_ni_is_conversation_member() -> None:
    codigo = _sin_comentarios(SQL)
    assert re.findall(r"create\s+or\s+replace\s+function\s+public\.(\w+)", codigo) == [
        "mis_conversaciones",
    ]
    assert not re.search(r"create\s+function", codigo)
    assert not re.search(r"\b(create\s+table|insert\s+into|update\s+public|delete\s+from|truncate)\b", codigo)
    assert not re.search(r"\b(grant|revoke)\b", codigo)
    # La siguen usando otras políticas (adjuntos, etiquetas, Storage): no se
    # redefine.
    assert not re.search(r"function\s+public\.is_conversation_member", codigo)
    # Y ninguna de las cinco la llama, ni lee los temas desde la política.
    for politica in re.findall(r"create\s+policy\s.*?;", codigo, flags=re.S):
        assert "is_conversation_member" not in politica, politica
        assert "conversation_topics" not in politica, politica


def test_la_funcion_es_security_definer_stable_y_con_search_path() -> None:
    """El mismo contexto que `is_conversation_member`: si no, la lista no
    diría lo mismo que ella."""
    codigo = _sin_comentarios(SQL)
    for funcion in ("mis_conversaciones",):
        cabecera = codigo.split(f"function public.{funcion}(")[1].split("$$")[0]
        assert "security definer" in cabecera, funcion
        assert re.search(r"\bstable\b", cabecera), funcion
        assert "set search_path = public, pg_temp" in cabecera, funcion


def test_se_rinde_si_no_consigue_el_bloqueo_y_termina_como_las_demas() -> None:
    codigo = _sin_comentarios(SQL)
    assert codigo.lstrip().startswith("set local lock_timeout")
    assert "notify pgrst, 'reload schema';" in codigo
    # Lo último que se ejecuta es la comprobación que se ve en el editor.
    assert codigo.rstrip().rsplit(";", 2)[-2].lstrip().startswith("select")
    assert "rollback" in SQL.lower(), "tiene que decir cómo deshacerse"


# =========================================================================== #
# 2. PostgreSQL: el reparto
# =========================================================================== #
def _hacer(pg, sql: str, *args) -> None:
    with pg.cursor() as cur:
        cur.execute(sql, args or None)


def _todas(pg, sql: str, *args) -> list[tuple]:
    with pg.cursor() as cur:
        cur.execute(sql, args or None)
        return [tuple(f) for f in cur.fetchall()]


def _uno(pg, sql: str, *args):
    filas = _todas(pg, sql, *args)
    return filas[0][0] if filas else None


def _politicas(pg) -> dict[str, tuple[str, str, str | None, str | None]]:
    """Las que toca la 0110 tal como están en la base: tabla, comando, using,
    with check. Antes de la 0110 son seis; después, las cinco lecturas."""
    return {
        nombre: (tabla, comando, qual, with_check)
        for tabla, nombre, comando, qual, with_check in _todas(
            pg,
            "select tablename, policyname, cmd, qual, with_check from pg_policies "
            "where schemaname = 'public' and policyname = any(%s)",
            list(TOCADAS),
        )
    }


def _poner_politicas(pg, politicas: dict) -> None:
    """Vuelve a crear las políticas dadas, copiadas de `pg_policies`."""
    for nombre, (tabla, comando, qual, with_check) in politicas.items():
        _hacer(pg, f"drop policy if exists {nombre} on public.{tabla}")
        condicion = f"using ({qual})" if qual else f"with check ({with_check})"
        _hacer(pg, f"create policy {nombre} on public.{tabla} for {comando.lower()} {condicion}")


def _montar(pg, *, hasta: str) -> None:
    with pg.cursor() as cur:
        cur.execute("drop schema if exists public cascade")
        cur.execute("drop schema if exists auth cascade")
        cur.execute("drop schema if exists storage cascade")
        cur.execute("create schema public")
        cur.execute(PROLOGO.read_text(encoding="utf-8"))
    for ruta in sorted(MIGRACIONES.glob("*.sql")):
        if ruta.name[:4] > hasta:
            break
        with pg.cursor() as cur:
            cur.execute(ruta.read_text(encoding="utf-8"))


def _aplicar_desde(pg, desde: str) -> None:
    for ruta in sorted(MIGRACIONES.glob("*.sql")):
        if ruta.name[:4] >= desde:
            with pg.cursor() as cur:
                cur.execute(ruta.read_text(encoding="utf-8"))


def _persona(pg, nombre: str, rol: str = "user") -> str:
    ident = str(uuid.uuid4())
    _hacer(
        pg,
        "insert into auth.users (id, email, raw_user_meta_data) values "
        "(%s, %s, jsonb_build_object('full_name', cast(%s as text), 'username', cast(%s as text)))",
        ident, f"{nombre}-{ident[:8]}@x.test", nombre, f"{nombre}{ident[:8]}",
    )
    if rol != "user":
        _hacer(pg, "update public.profiles set role = %s where id = %s", rol, ident)
    return ident


def _conversacion(pg, kind: str, creada_por: str, miembros: list[str]) -> str:
    ident = _uno(
        pg,
        "insert into public.conversations (kind, created_by) values (%s, %s) returning id::text",
        kind, creada_por,
    )
    for miembro in miembros:
        _hacer(
            pg,
            "insert into public.conversation_members (conversation_id, user_id) values (%s, %s)",
            ident, miembro,
        )
    return ident


def _mensaje(pg, conversacion: str, remitente: str, *, borrado: bool = False) -> str:
    return _uno(
        pg,
        "insert into public.messages (conversation_id, sender_id, body, deleted_at) "
        "values (%s, %s, 'hola', case when %s then now() end) returning id::text",
        conversacion, remitente, borrado,
    )


def _adjunto(pg, mensaje: str, conversacion: str) -> str:
    return _uno(
        pg,
        "insert into public.message_attachments (message_id, conversation_id, storage_path, kind) "
        "values (%s, %s, %s, 'image') returning id::text",
        mensaje, conversacion, f"{conversacion}/x/{uuid.uuid4()}.jpg",
    )


def _historia(pg, autor: str, *, caducada: bool = False) -> str:
    return _uno(
        pg,
        "insert into public.stories (author_id, storage_path, media_type, expires_at) "
        "values (%s, 'h.jpg', 'image', now() + case when %s then interval '-1 hour' "
        "else interval '10 hours' end) returning id::text",
        autor, caducada,
    )


def _sembrar(pg) -> dict:
    p = {nombre: _persona(pg, nombre) for nombre in ("ana", "beto", "carla", "dani", "eva")}
    p["admin"] = _persona(pg, "admin", "admin")
    ana, beto, carla, dani, eva = (p[n] for n in ("ana", "beto", "carla", "dani", "eva"))

    c = {
        "G": _conversacion(pg, "group", ana, [ana, beto, dani]),
        "D": _conversacion(pg, "direct", ana, [ana, eva]),
        "TC": _conversacion(pg, "group", ana, [ana, beto]),
        "TB": _conversacion(pg, "group", ana, [ana, beto]),
        "S": _conversacion(pg, "group", ana, [ana, eva]),
        "X": _conversacion(pg, "group", carla, [ana, beto]),
        "V": _conversacion(pg, "group", eva, []),
    }
    # Dani se fue del grupo: la API borra su fila.
    _hacer(
        pg,
        "delete from public.conversation_members where conversation_id = %s and user_id = %s",
        c["G"], dani,
    )
    # Los dos temas de G; el segundo, borrado (la 0108 no mira `deleted_at`).
    for chat, nombre, borrado in (("TC", "Anuncios", False), ("TB", "Viejo", True)):
        _hacer(
            pg,
            "insert into public.conversation_topics "
            "(conversation_id, chat_id, nombre, nombre_normalizado, created_by, deleted_at) "
            "values (%s, %s, %s, lower(cast(%s as text)), %s, case when %s then now() end)",
            c["G"], c[chat], nombre, nombre, ana, borrado,
        )
    # S es una comunidad de G.
    _hacer(
        pg,
        "insert into public.group_subgroups (conversation_id, parent_id) values (%s, %s)",
        c["S"], c["G"],
    )

    m: dict[str, list[str]] = {
        "G": [_mensaje(pg, c["G"], ana), _mensaje(pg, c["G"], beto), _mensaje(pg, c["G"], beto, borrado=True)],
        "D": [_mensaje(pg, c["D"], ana), _mensaje(pg, c["D"], eva)],
        "TC": [_mensaje(pg, c["TC"], ana)],
        "TB": [_mensaje(pg, c["TB"], ana)],
        "S": [_mensaje(pg, c["S"], eva)],
        "X": [_mensaje(pg, c["X"], beto)],
    }
    a = {
        "G": [_adjunto(pg, m["G"][1], c["G"])],
        "D": [_adjunto(pg, m["D"][1], c["D"])],
        "S": [_adjunto(pg, m["S"][0], c["S"])],
        # INCOHERENTE A PROPÓSITO: el mensaje es de D, la fila dice G. La
        # política mira la conversación DEL ADJUNTO (0033), y la nueva tiene
        # que seguir mirando esa y no otra.
        "G*": [_adjunto(pg, m["D"][0], c["G"])],
    }

    h = {
        "ana": _historia(pg, ana),
        "ana_caducada": _historia(pg, ana, caducada=True),
        "beto": _historia(pg, beto),
        "eva_caducada": _historia(pg, eva, caducada=True),
    }
    vistas = [
        ("ana", "beto"), ("ana", "carla"),
        ("beto", "ana"), ("beto", "carla"), ("beto", "admin"),
        ("ana_caducada", "eva"),
        ("eva_caducada", "beto"),
    ]
    for historia, quien in vistas:
        _hacer(
            pg,
            "insert into public.story_views (story_id, viewer_id) values (%s, %s)",
            h[historia], p[quien],
        )
    return {"p": p, "c": c, "m": m, "a": a, "h": h, "vistas": vistas}


@pytest.fixture(scope="module")
def pg():
    psycopg = pytest.importorskip("psycopg")
    if not URL:
        pytest.skip("sin PostgreSQL desechable")
    exigir_url_desechable(URL, os.environ.get("DATABASE_URL", ""))
    with psycopg.connect(URL, autocommit=True) as conexion:
        yield conexion


@pytest.fixture(scope="module")
def mundo(pg):
    """Hasta la 0109 con datos, las políticas de antes copiadas, y la 0110."""
    _montar(pg, hasta="0109")
    viejas = _politicas(pg)
    assert set(viejas) == set(TOCADAS), f"faltan políticas antes de la 0110: {viejas.keys()}"
    datos = _sembrar(pg)
    _aplicar_desde(pg, "0110")
    # Lo que Supabase trae y el prólogo no: entrar en `public` y un
    # `auth.uid()` que lee la sesión.
    _hacer(pg, "grant usage on schema public to anon, authenticated")
    _hacer(pg, AUTH_UID_DE_SUPABASE)
    yield {**datos, "viejas": viejas}
    _hacer(pg, AUTH_UID_DEL_PROLOGO)
    _hacer(pg, "revoke usage on schema public from anon, authenticated")


def _ser(pg, mundo: dict, quien: str) -> None:
    """Dentro de una transacción: pasar a ser esa persona, como PostgREST."""
    if quien == "anon":
        _hacer(pg, "set local role anon")
        return
    _hacer(
        pg,
        "select set_config('request.jwt.claims', %s, true)",
        json.dumps({"sub": mundo["p"][quien], "role": "authenticated"}),
    )
    _hacer(pg, "set local role authenticated")


def _visibles(pg, mundo: dict, quien: str, politica: str, *, antes: bool = False) -> set[str]:
    tabla, clave = LECTURAS[politica]
    with pg.transaction(force_rollback=True):
        if antes:
            _poner_politicas(pg, mundo["viejas"])
        _ser(pg, mundo, quien)
        return {fila[0] for fila in _todas(pg, f"select {clave} from public.{tabla}")}


# =========================================================================== #
# 3. Leer: lo mismo que antes, persona por persona
# =========================================================================== #
@SIN_POSTGRES
@pytest.mark.parametrize("quien", PERSONAS)
@pytest.mark.parametrize("politica", list(LECTURAS))
def test_cada_persona_ve_exactamente_lo_mismo_que_antes(mundo, pg, politica, quien) -> None:
    assert _visibles(pg, mundo, quien, politica) == _visibles(pg, mundo, quien, politica, antes=True)


#: Las conversaciones de las que es miembro cada persona.
MIEMBRO_DE = {
    "ana": {"G", "D", "TC", "TB", "S", "X"},
    "beto": {"G", "TC", "TB", "X"},
    "carla": set(),
    "dani": set(),
    "eva": {"D", "S"},
    "admin": set(),
    "anon": set(),
}


def _esperado(mundo: dict, politica: str, quien: str) -> set[str]:
    c, p = mundo["c"], mundo["p"]
    miembro = MIEMBRO_DE[quien]
    if politica == "messages_read":
        return {i for nombre in miembro for i in mundo["m"].get(nombre, [])}
    if politica == "message_attachments_read":
        # `G*` cuenta como G: es la conversación que dice la fila.
        return {
            i for nombre, ids in mundo["a"].items() if nombre.rstrip("*") in miembro for i in ids
        }
    if politica == "conversations_read":
        creadas = {"carla": {"X"}, "eva": {"V"}, "ana": {"G", "D", "TC", "TB", "S"}}.get(quien, set())
        return {c[nombre] for nombre in miembro | creadas}
    if politica == "conversation_members_read":
        return {
            f"{c[nombre]}:{p[persona]}"
            for nombre in miembro
            for persona, de in MIEMBRO_DE.items()
            if nombre in de
        }
    # story_views_read: mis vistas, las de mis historias, o todas si administro.
    autor = {"ana": "ana", "ana_caducada": "ana", "beto": "beto", "eva_caducada": "eva"}
    return {
        f"{mundo['h'][historia]}:{p[viendo]}"
        for historia, viendo in mundo["vistas"]
        if quien == "admin" or viendo == quien or autor[historia] == quien
    }


@SIN_POSTGRES
@pytest.mark.parametrize("quien", PERSONAS)
@pytest.mark.parametrize("politica", list(LECTURAS))
def test_lo_que_ve_cada_persona(mundo, pg, politica, quien) -> None:
    """La tabla de verdad, escrita: miembro sí, quien se fue no, la comunidad
    solo quien entró, el creador que no es miembro solo ve la conversación,
    la administración no lee chats ajenos pero sí todas las vistas."""
    assert _visibles(pg, mundo, quien, politica) == _esperado(mundo, politica, quien)


@SIN_POSTGRES
def test_las_conversaciones_propias_por_rpc_no_ensenan_nada_nuevo(mundo, pg) -> None:
    """`mis_conversaciones()` se puede llamar por PostgREST: da lo que ya se
    lee en `conversation_members`, y a `anon` nada."""
    for quien in PERSONAS:
        with pg.transaction(force_rollback=True):
            _ser(pg, mundo, quien)
            lista = _uno(pg, "select public.mis_conversaciones()::text[]")
        assert set(lista) == {mundo["c"][n] for n in MIEMBRO_DE[quien]}, quien


# =========================================================================== #
# 4. Insertar (§5.8): nadie, ni antes ni ahora; solo la API
# =========================================================================== #
def _insertar(pg, mundo: dict, quien: str, conversacion: str, *, antes: bool = False) -> str:
    """`ok`, `rls` (la RLS dice que no) o el error de permisos tal cual.

    Cada persona escribe a su nombre; `anon`, que no tiene nombre, lo intenta
    a nombre de Beto. Con `antes`, con la `messages_insert` de la 0108.
    """
    import psycopg

    remitente = mundo["p"]["beto" if quien == "anon" else quien]
    try:
        with pg.transaction(force_rollback=True):
            if antes:
                _poner_politicas(pg, {"messages_insert": mundo["viejas"]["messages_insert"]})
            _ser(pg, mundo, quien)
            _hacer(
                pg,
                "insert into public.messages (conversation_id, sender_id, body) values (%s, %s, 'directo')",
                mundo["c"][conversacion],
                remitente,
            )
    except psycopg.errors.InsufficientPrivilege as error:
        return "rls" if "row-level security" in str(error) else str(error)
    return "ok"


CONVERSACIONES = ("G", "D", "TC", "TB", "S", "X", "V")
PERMISO_DE_LOS_TEMAS = "permission denied for table conversation_topics"


@SIN_POSTGRES
@pytest.mark.parametrize("conversacion", CONVERSACIONES)
@pytest.mark.parametrize("quien", PERSONAS)
def test_nadie_inserta_directamente_ni_antes_ni_ahora(mundo, pg, quien, conversacion) -> None:
    """LA REGLA: nadie puede hacer ni más ni menos que hoy. Miembro o no, en un
    grupo, un chat de dos, un tema o una comunidad, quien lo creó, la
    administración y `anon`: antes fallaba por el permiso que le faltaba a la
    0108 y ahora falla porque no hay política de inserción."""
    assert _insertar(pg, mundo, quien, conversacion, antes=True).startswith(PERMISO_DE_LOS_TEMAS)
    assert _insertar(pg, mundo, quien, conversacion) == "rls"


@SIN_POSTGRES
def test_ni_a_nombre_de_otra_persona(mundo, pg) -> None:
    import psycopg

    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="row-level security"):
        with pg.transaction(force_rollback=True):
            _ser(pg, mundo, "beto")
            _hacer(
                pg,
                "insert into public.messages (conversation_id, sender_id, body) values (%s, %s, 'x')",
                mundo["c"]["G"], mundo["p"]["ana"],
            )


@SIN_POSTGRES
@pytest.mark.parametrize("conversacion", ["G", "D"])
def test_con_la_politica_de_la_0108_fallaba_por_permisos_en_todas(mundo, pg, conversacion) -> None:
    """El §5.8, reproducido: un miembro en su propio grupo o en su chat de dos
    recibía «permission denied for table conversation_topics»."""
    quien = "beto" if conversacion == "G" else "eva"
    import psycopg

    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="conversation_topics"):
        with pg.transaction(force_rollback=True):
            _poner_politicas(pg, {"messages_insert": mundo["viejas"]["messages_insert"]})
            _ser(pg, mundo, quien)
            _hacer(
                pg,
                "insert into public.messages (conversation_id, sender_id, body) values (%s, %s, 'x')",
                mundo["c"][conversacion], mundo["p"][quien],
            )


@SIN_POSTGRES
def test_conceder_los_temas_ya_no_abre_nada(mundo, pg) -> None:
    """EL CANDADO QUE CERRABA POR ACCIDENTE. Con la política de la 0108, basta
    con conceder SELECT sobre `conversation_topics` para que cualquier miembro
    escriba en «Anuncios»: la subconsulta ve cero filas (RLS sin políticas).
    Con la 0110, con ese permiso concedido, no escribe nadie: ni Beto, ni Ana,
    que creó el tema, ni nadie más."""
    import psycopg

    concedido = "grant select on public.conversation_topics to authenticated, anon"

    with pg.transaction(force_rollback=True):
        _hacer(pg, concedido)
        _poner_politicas(pg, {"messages_insert": mundo["viejas"]["messages_insert"]})
        _ser(pg, mundo, "beto")
        _hacer(
            pg,
            "insert into public.messages (conversation_id, sender_id, body) values (%s, %s, 'x')",
            mundo["c"]["TC"], mundo["p"]["beto"],
        )  # pasa: es el agujero

    for quien in PERSONAS:
        for conversacion in ("TC", "G"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege, match="row-level security"):
                with pg.transaction(force_rollback=True):
                    _hacer(pg, concedido)
                    _ser(pg, mundo, quien)
                    _hacer(
                        pg,
                        "insert into public.messages (conversation_id, sender_id, body) "
                        "values (%s, %s, 'x')",
                        mundo["c"][conversacion],
                        mundo["p"]["beto" if quien == "anon" else quien],
                    )


@SIN_POSTGRES
def test_no_queda_ninguna_puerta_de_escritura_en_messages(mundo, pg) -> None:
    """Sin política de INSERT (ni de ALL) y con la RLS puesta: sin ella, no
    tener política dejaría la tabla abierta en vez de cerrada. Y sin funciones
    de escritura sueltas que se puedan llamar por PostgREST."""
    assert _uno(pg, "select relrowsecurity from pg_class where oid = 'public.messages'::regclass") is True
    assert _todas(
        pg,
        "select policyname, cmd from pg_policies where schemaname = 'public' "
        "and tablename = 'messages' order by 1",
    ) == [("messages_delete", "UPDATE"), ("messages_read", "SELECT")]
    assert _uno(pg, "select to_regprocedure('public.puede_escribir_en_la_conversacion(uuid)')") is None


@SIN_POSTGRES
def test_la_api_sigue_escribiendo(mundo, pg) -> None:
    """La API se conecta con el rol del servidor, al que la RLS no se le
    aplica: quitar la política no le cambia nada."""
    with pg.transaction(force_rollback=True):
        nuevo = _uno(
            pg,
            "insert into public.messages (conversation_id, sender_id, body) values (%s, %s, 'por la API') "
            "returning id::text",
            mundo["c"]["TC"], mundo["p"]["ana"],
        )
        assert nuevo is not None
        # Y lo que escribe la API lo leen los miembros por la RLS nueva.
        _ser(pg, mundo, "beto")
        assert _uno(pg, "select count(*) from public.messages where id = %s", nuevo) == 1


# =========================================================================== #
# 5. Una vez por consulta, no una vez por fila
# =========================================================================== #
@SIN_POSTGRES
def test_ninguna_politica_reescrita_pregunta_fila_a_fila(mundo, pg) -> None:
    """Ni `is_conversation_member` ni `auth.uid()` / `is_admin()` sueltos: todo
    dentro de un `(select …)`, que PostgreSQL calcula una sola vez."""
    politicas = _politicas(pg)
    assert set(politicas) == set(LECTURAS)
    for nombre, (_, _, qual, with_check) in politicas.items():
        definicion = qual or with_check
        assert "is_conversation_member" not in definicion, nombre
        assert "conversation_topics" not in definicion, nombre
        suelta = definicion.replace("( SELECT auth.uid() AS uid)", "")
        suelta = suelta.replace("( SELECT is_admin() AS is_admin)", "")
        assert "auth.uid()" not in suelta, f"{nombre}: auth.uid() fila a fila"
        assert "is_admin()" not in suelta, f"{nombre}: is_admin() fila a fila"


@SIN_POSTGRES
def test_el_plan_calcula_la_lista_una_vez(mundo, pg) -> None:
    with pg.transaction(force_rollback=True):
        _ser(pg, mundo, "beto")
        plan = "\n".join(
            f[0]
            for f in _todas(
                pg,
                "explain select count(*) from public.messages where conversation_id = %s",
                mundo["c"]["G"],
            )
        )
    assert "InitPlan" in plan, plan
    assert "is_conversation_member" not in plan, plan
    assert "ANY" in plan, plan


# =========================================================================== #
# 6. Pegarla en el editor: dos veces, o rendirse sin dejar nada
# =========================================================================== #
def _foto(pg) -> list[tuple]:
    return _todas(
        pg,
        "select tablename, policyname, cmd, roles::text, coalesce(qual, ''), coalesce(with_check, '') "
        "from pg_policies where schemaname = 'public' order by 1, 2",
    ) + _todas(
        pg,
        "select proname, prosrc, prosecdef, provolatile, array_to_string(proconfig, ',') "
        "from pg_proc where pronamespace = 'public'::regnamespace "
        "and proname in ('mis_conversaciones', 'is_conversation_member') "
        "order by 1",
    )


@SIN_POSTGRES
def test_pegarla_dos_veces_deja_lo_mismo(mundo, pg) -> None:
    antes = _foto(pg)
    _hacer(pg, SQL)
    _hacer(pg, SQL)
    assert _foto(pg) == antes


@SIN_POSTGRES
def test_si_no_consigue_el_bloqueo_se_rinde_y_no_deja_nada(mundo, pg) -> None:
    """Una lectura larga de `messages` en otra sesión: la migración no se queda
    esperando (y con ella todo el chat), se rinde a los 5 s y no cambia nada."""
    import psycopg

    # La base como estaba antes de la 0110: las seis políticas viejas y sin
    # la función (las políticas nuevas dependen de ella, así que primero se
    # cambian las políticas).
    _poner_politicas(pg, mundo["viejas"])
    _hacer(pg, "drop function public.mis_conversaciones()")
    try:
        antes = _foto(pg)
        listo = threading.Event()
        soltar = threading.Event()

        def lector() -> None:
            with psycopg.connect(URL) as otra:
                otra.execute("lock table public.messages in access share mode")
                listo.set()
                soltar.wait(30)
                otra.rollback()

        hilo = threading.Thread(target=lector)
        hilo.start()
        try:
            assert listo.wait(10)
            with pytest.raises(psycopg.errors.LockNotAvailable):
                _hacer(pg, SQL)
        finally:
            soltar.set()
            hilo.join()
        assert _foto(pg) == antes
        assert _uno(pg, "select to_regprocedure('public.mis_conversaciones()')") is None
    finally:
        # Lo deja como lo encontró: con la 0110 puesta.
        _hacer(pg, SQL)
