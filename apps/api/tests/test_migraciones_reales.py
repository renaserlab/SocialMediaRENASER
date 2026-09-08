"""Las migraciones, EJECUTADAS de verdad sobre una base vacia y desechable.

QUE APORTA SOBRE `test_secuencia_de_migraciones.py`. Aquella lee el SQL; esta lo
CORRE. Solo ejecutandolo se ve una sintaxis invalida, una funcion que no existe,
un `check` que se contradice, un indice PARCIAL que PostgreSQL rechaza o una
politica RLS mal escrita. SQLite no sirve para nada de eso: no tiene RLS, ni
indices parciales con la misma semantica, ni `jsonb`, ni el esquema `auth`.

COMO SE EJECUTA. Hace falta un PostgreSQL desechable y una variable que apunte a
el. **Sin la variable, la prueba SE SALTA**; nunca falla por ausencia, porque en
la maquina de desarrollo no siempre hay un demonio de contenedores y romper la
suite por eso solo consigue que la gente deje de ejecutarla.

    docker run --rm -d --name renaser-mig \\
      -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres \\
      -e POSTGRES_DB=renaser_mig -p 55432:5432 postgres:16-alpine

    export MIGRACIONES_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/renaser_mig
    python -m pytest tests/test_migraciones_reales.py

    docker rm -f renaser-mig

POR QUE UNA VARIABLE PROPIA Y NO `DATABASE_URL`. Porque `DATABASE_URL` apunta al
POOLER DE SUPABASE DE PRODUCCION en cuanto existe `apps/api/.env`, y esta prueba
BORRA Y RECREA EL ESQUEMA `public`. Usar la de siempre por comodidad seria
destruir la base de verdad la primera vez que alguien ejecute la suite con el
entorno cargado. Ademas se comprueba abajo, a mano, que la URL no es esa: una
variable distinta protege del descuido, la comprobacion protege del copia y pega.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

RAIZ = Path(__file__).resolve().parents[3]
MIGRACIONES = RAIZ / "supabase" / "migrations"
PROLOGO = RAIZ / "supabase" / "tests" / "prologo_local.sql"

URL = os.environ.get("MIGRACIONES_DATABASE_URL", "").strip()

SIN_POSTGRES = pytest.mark.skipif(
    not URL,
    reason=(
        "sin PostgreSQL desechable: define MIGRACIONES_DATABASE_URL "
        "(ver la cabecera del fichero para el comando docker)"
    ),
)


class BaseNoDesechable(RuntimeError):
    """La URL apunta a algo que no se puede borrar y recrear."""


def exigir_url_desechable(url: str, configurada: str) -> None:
    """Se niega a tocar nada que huela a base de verdad.

    Cuatro puertas, y ninguna sobra: el nombre de la variable ya deberia bastar,
    pero quien copia un comando de otro sitio no lee nombres de variable. Esta
    funcion se prueba APARTE y sin PostgreSQL —abajo, en
    `test_el_guardia_...`— porque es lo unico de este fichero que no se puede
    permitir el lujo de saltarse cuando no hay contenedor: es justo entonces
    cuando alguien apunta la variable a donde no debe.
    """
    # El anfitrion se SACA DEL URL, no se busca con una expresion en la cadena
    # entera: la contrasena podria contener «localhost» y colar cualquier base.
    anfitrion = (urlsplit(url).hostname or "").lower()
    # Y para los mensajes se usa una version sin credenciales: un fallo de esta
    # comprobacion acaba en la consola de alguien y a veces en un informe.
    limpia = f"{urlsplit(url).scheme}://{anfitrion}/{urlsplit(url).path.lstrip('/')}"

    # LOS PARAMETROS DE CONEXION EN LA QUERY MANDAN SOBRE EL ANFITRION DEL URI.
    # libpq acepta `?host=…`, `?hostaddr=…` y `?service=…`, y tienen precedencia:
    # `postgresql://…@localhost/db?host=db.abc.supabase.co` pasaria todas las
    # comprobaciones de anfitrion y conectaria con Supabase. Se rechazan de raiz.
    consulta = parse_qs(urlsplit(url).query)
    peligrosos = {"host", "hostaddr", "service"} & set(consulta)
    if peligrosos:
        raise BaseNoDesechable(
            f"la URL trae parametros de conexion que mandan sobre el anfitrion: "
            f"{sorted(peligrosos)}"
        )
    if url.strip() == (configurada or "").strip():
        raise BaseNoDesechable("MIGRACIONES_DATABASE_URL es la misma que DATABASE_URL")
    for prohibido in ("supabase", "pooler", "amazonaws", "rds."):
        if prohibido in anfitrion:
            raise BaseNoDesechable(f"apunta a una base gestionada ({prohibido}): {limpia}")
    if anfitrion not in {"localhost", "127.0.0.1", "::1", "postgres", "db"}:
        raise BaseNoDesechable(f"solo se permite una base local o de CI: {limpia}")


def _exigir_url_desechable(url: str) -> None:
    from app.core.config import get_settings

    exigir_url_desechable(url, get_settings().database_url or "")


# --------------------------------------------------------------------------- #
# El guardia. Corre SIEMPRE, con o sin PostgreSQL.
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
        "postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres",
        "postgresql://u:p@midb.cluster-x.us-east-1.rds.amazonaws.com:5432/prod",
        "postgresql://u:p@10.0.0.7:5432/loquesea",
        # Y el rodeo: anfitrion inofensivo en el URI, el de verdad en la query.
        "postgresql://postgres:x@localhost:5432/db?host=db.abc.supabase.co",
        "postgresql://postgres:x@localhost:5432/db?service=produccion",
    ],
)
def test_el_guardia_rechaza_las_bases_que_no_son_desechables(url: str) -> None:
    """Esta prueba existe porque el fallo seria irreversible.

    La prueba de migraciones BORRA Y RECREA el esquema `public`. Apuntarla por
    descuido a Supabase —copiando la URL del `.env`, que es lo que hace
    cualquiera— destruiria la base de verdad. Ninguna otra comprobacion de este
    fichero corre sin contenedor; esta si, porque es justo cuando no hay
    contenedor cuando alguien improvisa la URL.
    """
    with pytest.raises(BaseNoDesechable):
        exigir_url_desechable(url, "sqlite+aiosqlite:///:memory:")


def test_el_guardia_acepta_una_base_local() -> None:
    exigir_url_desechable(
        "postgresql://postgres:postgres@localhost:55432/renaser_mig",
        "sqlite+aiosqlite:///:memory:",
    )
    # Y la de un servicio de CI, que se llama `postgres` por el nombre del
    # servicio en la red del runner.
    exigir_url_desechable(
        "postgresql://postgres:postgres@postgres:5432/renaser_mig",
        "sqlite+aiosqlite:///:memory:",
    )


def test_el_guardia_rechaza_reutilizar_la_configurada() -> None:
    """Aunque la configurada fuera inofensiva: si son la misma, no es desechable."""
    with pytest.raises(BaseNoDesechable):
        exigir_url_desechable(
            "postgresql://postgres:postgres@localhost:5432/renaser",
            "postgresql://postgres:postgres@localhost:5432/renaser",
        )


@pytest.fixture(scope="module")
def conexion():
    psycopg = pytest.importorskip("psycopg", reason="hace falta psycopg para hablar con PostgreSQL")
    _exigir_url_desechable(URL)

    with psycopg.connect(URL, autocommit=True) as cn:
        # Esquema en blanco: la prueba tiene que valer lo mismo la primera vez y
        # la decima, y una base sucia da un verde que no significa nada.
        with cn.cursor() as cur:
            cur.execute("drop schema if exists public cascade")
            cur.execute("drop schema if exists auth cascade")
            cur.execute("drop schema if exists storage cascade")
            cur.execute("create schema public")
        yield cn


@pytest.fixture(scope="module")
def aplicadas(conexion):
    """Aplica el prologo y las 49 migraciones, cada una en su transaccion."""
    assert PROLOGO.exists(), f"falta el prologo en {PROLOGO}"
    with conexion.cursor() as cur:
        cur.execute(PROLOGO.read_text(encoding="utf-8"))

    ficheros = sorted(MIGRACIONES.glob("*.sql"))
    assert ficheros, "no se encontro ninguna migracion"
    for ruta in ficheros:
        try:
            with conexion.cursor() as cur:
                cur.execute(ruta.read_text(encoding="utf-8"))
        except Exception as error:  # noqa: BLE001
            pytest.fail(f"la migracion {ruta.name} no aplica:\n{error}")
    return [r.name for r in ficheros]


def _uno(conexion, sql: str, *args):
    with conexion.cursor() as cur:
        cur.execute(sql, args)
        fila = cur.fetchone()
    return fila[0] if fila else None


def _lista(conexion, sql: str, *args) -> list:
    with conexion.cursor() as cur:
        cur.execute(sql, args)
        return [f[0] for f in cur.fetchall()]


# --------------------------------------------------------------------------- #


@SIN_POSTGRES
def test_todas_las_migraciones_aplican_en_orden(aplicadas) -> None:
    """Lo mas simple y lo mas valioso: que el SQL corra de la 0001 a la ultima."""
    assert len(aplicadas) >= 49
    assert aplicadas[0].startswith("0001_")


@SIN_POSTGRES
def test_la_ultima_migracion_es_la_que_dice_la_documentacion(aplicadas) -> None:
    """Si alguien anade una 0050, esta prueba se entera y obliga a actualizar
    la documentacion y los modelos en el mismo cambio."""
    # La ULTIMA concreta, no «una de estas dos». Aceptar varias hacia que la
    # prueba no se enterase de una migracion nueva, que es justo cuando hay que
    # actualizar los modelos y la documentacion en el mismo cambio.
    #
    # ESTA LINEA SE ACTUALIZA CON CADA MIGRACION. Se quedo en 0051 mientras el
    # cambio ya traia la 0052: en verde aqui, porque el modulo entero se salta
    # sin PostgreSQL, y en rojo la primera vez que CI tuviera uno, que es
    # exactamente cuando se ejercitan por primera vez la 0051 y la 0052.
    assert aplicadas[-1].startswith("0054_"), (
        f"la ultima migracion es {aplicadas[-1]}: actualiza los modelos, "
        "la documentacion y esta prueba en el mismo cambio"
    )


@SIN_POSTGRES
def test_estan_las_siete_tablas_del_dinero(conexion, aplicadas) -> None:
    esperadas = {
        "course_refund_windows",
        "refund_requests",
        "refund_request_events",
        "refund_policy_acceptances",
        "owner_payout_accounts",
        "owner_sale_balances",
        "owner_transfers",
        # Las de la 0050.
        "course_versions",
        "policy_versions",
        "consent_records",
        "audit_events",
    }
    hay = set(
        _lista(
            conexion,
            "select table_name from information_schema.tables where table_schema = 'public'",
        )
    )
    assert esperadas <= hay, f"faltan tablas: {sorted(esperadas - hay)}"


@SIN_POSTGRES
def test_los_indices_parciales_existen_de_verdad(conexion, aplicadas) -> None:
    """Los parciales son la mitad de las invariantes del dinero y SQLite no los
    reproduce: aqui es donde se comprueba que existen y que su `WHERE` es el
    esperado."""
    definiciones = {
        nombre: definicion
        for nombre, definicion in zip(
            _lista(conexion, "select indexname from pg_indexes where schemaname = 'public'"),
            _lista(conexion, "select indexdef from pg_indexes where schemaname = 'public'"),
        )
    }
    # `course_refund_windows_vencimiento_idx` solo indexa las garantías vivas.
    assert "course_refund_windows_vencimiento_idx" in definiciones
    assert "where" in definiciones["course_refund_windows_vencimiento_idx"].lower()
    # Y `owner_sale_balances_liberables_idx`, solo los saldos pendientes.
    assert "owner_sale_balances_liberables_idx" in definiciones
    assert "pending" in definiciones["owner_sale_balances_liberables_idx"]


@SIN_POSTGRES
def test_una_sola_solicitud_viva_por_orden(conexion, aplicadas) -> None:
    """El índice parcial que impide dos expedientes abiertos sobre el mismo
    dinero. Es la invariante nº 1 de las devoluciones."""
    definicion = _uno(
        conexion,
        "select indexdef from pg_indexes where schemaname='public' and indexname=%s",
        "refund_requests_viva_por_orden",
    )
    assert definicion is not None, "no existe refund_requests_viva_por_orden"
    assert "unique" in definicion.lower()
    assert "where" in definicion.lower()


@SIN_POSTGRES
def test_la_rls_esta_activa_en_las_tablas_del_dinero(conexion, aplicadas) -> None:
    sin_rls = _lista(
        conexion,
        """
        select c.relname from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and c.relname in ('course_refund_windows','refund_requests',
                            'refund_request_events','refund_policy_acceptances',
                            'owner_payout_accounts','owner_sale_balances','owner_transfers',
                            'course_versions','policy_versions','consent_records',
                            'audit_events')
          and c.relrowsecurity = false
        """,
    )
    assert not sin_rls, f"tablas de dinero sin RLS: {sin_rls}"


@SIN_POSTGRES
def test_ninguna_politica_permite_escribir_dinero(conexion, aplicadas) -> None:
    """La comprobación que ninguna prueba podía hacer antes.

    Con RLS activa y sin política de escritura, la clave anónima no puede
    insertar ni actualizar; escribe solo la API, que es la única que valida
    importes. Una política `for insert` sobre estas tablas sería la puerta para
    que el teléfono se escriba un saldo.
    """
    escrituras = _lista(
        conexion,
        """
        select tablename || ':' || policyname || ':' || cmd from pg_policies
        where schemaname = 'public'
          and tablename like any (array['refund%','owner%','orders','entitlements',
                                        'payment_%','commerce_%','provider_%',
                                        'course_versions','policy_versions',
                                        'consent_records','audit_events'])
          and cmd <> 'SELECT'
        """,
    )
    assert not escrituras, f"politicas de escritura sobre dinero: {escrituras}"


@SIN_POSTGRES
def test_los_modelos_no_declaran_columnas_que_la_base_no_tiene(conexion, aplicadas) -> None:
    """El contrato al revés que la prueba estática: allí se comprueba que el
    modelo no ignore una columna del SQL; aquí, que no se invente ninguna."""
    from app.shared.database import Base
    from app.modules.catalog import models as _catalog  # noqa: F401
    from app.modules.commerce import models as _commerce  # noqa: F401
    from app.modules.gobernanza import models as _gobernanza  # noqa: F401
    from app.modules.refunds import models as _refunds  # noqa: F401

    reales: dict[str, set[str]] = {}
    with conexion.cursor() as cur:
        cur.execute(
            "select table_name, column_name from information_schema.columns "
            "where table_schema = 'public'"
        )
        for tabla, columna in cur.fetchall():
            reales.setdefault(tabla, set()).add(columna)

    inventadas: list[str] = []
    for nombre in (
        "course_refund_windows",
        "refund_requests",
        "refund_request_events",
        "refund_policy_acceptances",
        "owner_payout_accounts",
        "owner_sale_balances",
        "owner_transfers",
        "course_versions",
        "policy_versions",
        "consent_records",
        "audit_events",
        "orders",
        "entitlements",
    ):
        modelo = Base.metadata.tables.get(nombre)
        if modelo is None or nombre not in reales:
            continue
        for columna in modelo.columns:
            if columna.name not in reales[nombre]:
                inventadas.append(f"{nombre}.{columna.name}")
    assert not inventadas, f"columnas del modelo que no existen en la base: {inventadas}"


@SIN_POSTGRES
def test_aplicar_dos_veces_no_rompe_nada(conexion, aplicadas) -> None:
    """Idempotencia. Todas las migraciones usan `if not exists` y
    `drop policy if exists`; volver a pasarlas tiene que ser inofensivo, que es
    lo que ocurre cuando alguien vuelve a pegar una por si acaso.
    """
    for nombre in aplicadas:
        ruta = MIGRACIONES / nombre
        try:
            with conexion.cursor() as cur:
                cur.execute(ruta.read_text(encoding="utf-8"))
        except Exception as error:  # noqa: BLE001
            pytest.fail(f"la migracion {nombre} no es idempotente:\n{error}")


@SIN_POSTGRES
def test_los_indices_que_sostienen_la_0050_existen(conexion, aplicadas) -> None:
    """Las invariantes de la 0050 son indices PARCIALES, y SQLite no las prueba.

    Cada uno impide una cosa concreta que un `if` en Python no impide: dos
    versiones vigentes del mismo curso, dos politicas vigentes del mismo tipo,
    dos aceptaciones consumidas por la misma orden y dos aceptaciones pendientes
    creadas por un doble toque.
    """
    definiciones = dict(
        zip(
            _lista(conexion, "select indexname from pg_indexes where schemaname='public'"),
            _lista(conexion, "select indexdef from pg_indexes where schemaname='public'"),
        )
    )
    for nombre in (
        "course_versions_vigente_unica",
        "policy_versions_vigente_unica",
        "consent_records_consumo_unico",
        "consent_records_pendiente_unico",
    ):
        assert nombre in definiciones, f"falta el indice {nombre}"
        definicion = definiciones[nombre].lower()
        assert "unique" in definicion, f"{nombre} no es unico"
        assert "where" in definicion, f"{nombre} no es parcial"


@SIN_POSTGRES
def test_los_disparadores_de_inmutabilidad_existen(conexion, aplicadas) -> None:
    """Lo que impide reescribir una prueba legal, y que SQLite no ejecuta.

    La RLS no basta: la API entra con la clave de servicio y se la salta. Sin
    estos disparadores, un `UPDATE` desde el backend reescribiria el texto que
    alguien firmo o el rastro de quien movio el dinero.
    """
    puestos = set(
        _lista(conexion, "select tgname from pg_trigger where not tgisinternal")
    )
    for nombre in (
        "audit_events_solo_anadir",
        "consent_records_inmutable",
        "consent_records_no_se_borra",
        "policy_versions_inmutable",
        "policy_versions_no_se_borra",
        "course_versions_inmutable",
    ):
        assert nombre in puestos, f"falta el disparador {nombre}"


@SIN_POSTGRES
def test_una_version_publicada_no_se_puede_reescribir(conexion, aplicadas) -> None:
    """El disparador, EJERCIDO.

    Comprobar que existe no basta: lo que importa es que rechace las tres cosas
    que dice rechazar. La tercera —disfrazar un backfill de publicacion real— es
    la menos evidente y la que convertiria una reconstruccion en una prueba
    falsa de lo que se vendio.
    """
    import psycopg

    with conexion.cursor() as cur:
        cur.execute(
            "insert into public.profiles (id, username, full_name) "
            "values (gen_random_uuid(), 'p_0050', 'Prueba') returning id"
        )
        autor = cur.fetchone()[0]
        cur.execute(
            "insert into public.courses (author_id, title, description) "
            "values (%s, 'Curso', 'x') returning id",
            (autor,),
        )
        curso = cur.fetchone()[0]
        cur.execute(
            "insert into public.course_versions "
            "(course_id, version, status, content_hash, snapshot) "
            "values (%s, 1, 'published', 'h', '{}'::jsonb) returning id",
            (curso,),
        )
        version = cur.fetchone()[0]

    prohibidas = [
        ("reescribir el contenido", "update public.course_versions set snapshot = %s::jsonb where id = %s", ('{"a":1}', version)),
        ("borrarla", "delete from public.course_versions where id = %s", (version,)),
        ("disfrazarla de backfill", "update public.course_versions set origin = 'backfill' where id = %s", (version,)),
    ]
    for que, sentencia, argumentos in prohibidas:
        with pytest.raises(psycopg.errors.RaiseException), conexion.cursor() as cur:
            cur.execute(sentencia, argumentos)
