"""La RLS del comercio y las reglas del acceso, leidas del SQL que se aplicara.

POR QUE SE LEE EL FICHERO EN VEZ DE PROBAR CONTRA UNA BASE. Porque estas reglas
NO se pueden ejercitar en las pruebas: la RLS de PostgreSQL no existe en SQLite,
y las migraciones no se ejecutan contra Supabase desde aqui. Lo unico que se
puede hacer —y hay que hacerlo— es impedir que el SQL cambie en la direccion
equivocada sin que nadie se entere.

LA REGLA QUE PROTEGE ESTE FICHERO, Y ES LA MAS CARA DE ROMPER:

    NINGUNA de las siete tablas del comercio puede tener una politica de
    INSERT, UPDATE o DELETE. Ni de `authenticated`, ni de nadie.

La clave `anon` de Supabase viaja dentro de la aplicacion movil y se puede leer
descompilandola. Cualquiera puede abrir un cliente con su propia sesion y hacer
un `insert` contra PostgREST. Con una sola politica de escritura en
`entitlements`, regalarse el catalogo entero es una linea, y ademas queda
registrado como una concesion legitima. Conceder pasa SIEMPRE por el backend,
que se conecta con identidad de servicio y no pasa por la RLS.

Ojo con el detalle que hace de esto un parser y no un `assert "insert" not in
sql`: en PostgreSQL, `create policy x on t using (...)` SIN `for` vale para
TODOS los comandos. Buscar la palabra «insert» no encontraria esa, que es
justamente la forma en que se cuela por descuido.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

MIGRACIONES = Path(__file__).resolve().parents[3] / "supabase" / "migrations"
COMERCIO = MIGRACIONES / "0035_comercio.sql"
ACCESO = MIGRACIONES / "0036_acceso_v2.sql"

#: Las siete del contrato. Si alguna se renombra, esta lista falla antes que
#: nada y obliga a decirlo en vez de a renombrar por libre.
TABLAS = (
    "commerce_products",
    "provider_products",
    "orders",
    "payment_transactions",
    "payment_events",
    "entitlements",
    "course_enrollments",
)


def _sin_comentarios(sql: str) -> str:
    """El SQL sin la prosa.

    Estos ficheros explican en texto por que NO hay politicas de insercion, asi
    que buscar palabras sobre el texto crudo da positivos por los comentarios en
    vez de por la logica. Es el mismo cuidado que ya se tuvo en
    `test_muro_de_pago.py`.
    """
    return "\n".join(linea.split("--")[0] for linea in sql.splitlines())


def _politicas(sql: str) -> list[tuple[str, str, str]]:
    """`(nombre, tabla, comando)` de cada `create policy` del fichero.

    El comando por defecto en PostgreSQL cuando no se escribe `for` es ALL, y
    asi se devuelve: es la forma silenciosa de abrir la escritura.
    """
    limpio = _sin_comentarios(sql)
    encontradas: list[tuple[str, str, str]] = []
    for coincidencia in re.finditer(
        r"create\s+policy\s+([\w\"]+)\s+on\s+([\w.\"]+)", limpio, re.IGNORECASE
    ):
        nombre, tabla = coincidencia.group(1), coincidencia.group(2)
        fin = limpio.find(";", coincidencia.end())
        cuerpo = limpio[coincidencia.end() : fin if fin != -1 else len(limpio)]
        comando = re.search(
            r"\bfor\s+(all|select|insert|update|delete)\b", cuerpo, re.IGNORECASE
        )
        encontradas.append(
            (nombre, tabla.split(".")[-1], (comando.group(1) if comando else "all").lower())
        )
    return encontradas


@pytest.fixture(scope="module")
def comercio() -> str:
    assert COMERCIO.exists(), f"No se encuentra la migracion en {COMERCIO}"
    return COMERCIO.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def acceso() -> str:
    assert ACCESO.exists(), f"No se encuentra la migracion en {ACCESO}"
    return ACCESO.read_text(encoding="utf-8")


# --------------------------------------------------------------------------- #
# LO QUE NO SE NEGOCIA: nadie escribe en el comercio desde una sesion de usuario
# --------------------------------------------------------------------------- #
def test_ninguna_politica_de_escritura_en_las_siete_tablas(comercio, acceso):
    """LA prueba de este fichero.

    Un usuario que pueda insertarse un entitlement desde Supabase se regala el
    catalogo. Se revisan LAS DOS migraciones porque la puerta se puede abrir
    desde cualquiera de ellas.
    """
    culpables = [
        (fichero, nombre, tabla, comando)
        for fichero, sql in (("0035", comercio), ("0036", acceso))
        for nombre, tabla, comando in _politicas(sql)
        if tabla in TABLAS and comando != "select"
    ]
    assert culpables == [], (
        "Politica de ESCRITURA sobre el comercio: "
        f"{culpables}. Conceder y revocar pasa por el backend, nunca por la RLS."
    )


def test_payment_events_no_lo_toca_ningun_usuario(comercio, acceso):
    """Ni lectura. Su payload trae datos del cobro y a veces del comprador.

    Con RLS activa y CERO politicas, PostgreSQL deniega todo a `authenticated`.
    La ausencia es la proteccion, asi que hay que vigilarla como se vigila una
    linea escrita.
    """
    politicas = [
        (nombre, tabla)
        for sql in (comercio, acceso)
        for nombre, tabla, _ in _politicas(sql)
        if tabla == "payment_events"
    ]
    assert politicas == [], f"`payment_events` no lleva politicas: {politicas}"


def test_la_rls_esta_activa_en_las_siete(comercio):
    """Sin `enable row level security`, la tabla queda ABIERTA de par en par.

    Y es el fallo mas facil de cometer aqui: como no hay politicas de escritura,
    olvidarse de activar la RLS no da ningun sintoma —todo sigue funcionando—
    hasta que alguien prueba a escribir desde el cliente y puede.
    """
    limpio = _sin_comentarios(comercio)
    for tabla in TABLAS:
        assert re.search(
            rf"alter\s+table\s+public\.{tabla}\s+enable\s+row\s+level\s+security",
            limpio,
            re.IGNORECASE,
        ), f"Falta activar RLS en {tabla}"


@pytest.mark.parametrize("tabla", ["orders", "entitlements", "course_enrollments"])
def test_la_lectura_es_solo_de_lo_propio(comercio, tabla):
    """Cada quien ve lo suyo, y la administracion todo.

    Se mira DENTRO de la politica de esa tabla, no en el fichero entero: con un
    `in` sobre todo el SQL, la condicion de otra tabla daria el visto bueno a
    una politica que en realidad no filtra nada.
    """
    limpio = _sin_comentarios(comercio)
    politica = re.search(
        rf"create\s+policy\s+\w+\s+on\s+public\.{tabla}\b.*?;",
        limpio,
        re.IGNORECASE | re.DOTALL,
    )
    assert politica is not None, f"{tabla} se quedo sin politica de lectura"
    assert "user_id = auth.uid()" in politica.group(0), (
        f"La lectura de {tabla} no esta limitada a lo propio"
    )


def test_los_identificadores_de_las_tiendas_son_solo_de_administracion(comercio):
    """`provider_products` revela como esta montada la venta y no le sirve de
    nada a la aplicacion, que pregunta por curso a nuestro backend."""
    limpio = _sin_comentarios(comercio)
    politica = re.search(
        r"create\s+policy\s+\w+\s+on\s+public\.provider_products.*?;",
        limpio,
        re.IGNORECASE | re.DOTALL,
    )
    assert politica is not None, "provider_products necesita su politica de lectura"
    assert "is_admin()" in politica.group(0)
    assert "auth.uid()" not in politica.group(0)


# --------------------------------------------------------------------------- #
# Las siete tablas y las restricciones del contrato
# --------------------------------------------------------------------------- #
def test_estan_las_siete_tablas(comercio):
    for tabla in TABLAS:
        assert re.search(
            rf"create\s+table\s+if\s+not\s+exists\s+public\.{tabla}\b",
            comercio,
            re.IGNORECASE,
        ), f"Falta la tabla {tabla}"


@pytest.mark.parametrize(
    "que,patron",
    [
        # La idempotencia del ACCESO: un solo derecho activo por persona y
        # producto, y PARCIAL para no perder el historial de los revocados.
        (
            "entitlement activo unico",
            r"create\s+unique\s+index\s+if\s+not\s+exists\s+entitlements_activo_unico"
            r".*?where\s+status\s*=\s*'active'",
        ),
        # La idempotencia del DINERO: el mismo cobro dos veces es un cobro.
        (
            "transaccion externa unica",
            r"unique\s*\(\s*provider\s*,\s*environment\s*,\s*external_transaction_id\s*\)",
        ),
        # El ANTI-REPLAY: reenviar un aviso capturado no ejecuta nada.
        ("aviso unico", r"unique\s*\(\s*provider\s*,\s*external_event_id\s*\)"),
        # Un curso, un producto de acceso permanente.
        (
            "producto de curso unico",
            r"create\s+unique\s+index\s+if\s+not\s+exists\s+commerce_products_curso_unico"
            r".*?where\s+kind\s*=\s*'course_lifetime'",
        ),
        # Un identificador de tienda apunta a UN producto nuestro.
        (
            "producto de tienda unico",
            r"unique\s*\(\s*provider\s*,\s*environment\s*,\s*external_product_id\s*\)",
        ),
    ],
)
def test_los_unique_que_sostienen_la_idempotencia(comercio, que, patron):
    """Sin estos indices la idempotencia se cae, y no se puede sustituir por una
    comprobacion en Python: dos avisos simultaneos la pasan los dos."""
    assert re.search(patron, _sin_comentarios(comercio), re.IGNORECASE | re.DOTALL), (
        f"Se perdio: {que}"
    )


@pytest.mark.parametrize(
    "columna,valores",
    [
        ("kind", "'course_lifetime'"),
        ("channel", "'ios', 'android', 'web'"),
        ("environment", "'sandbox', 'production'"),
    ],
)
def test_los_check_del_contrato(comercio, columna, valores):
    limpio = _sin_comentarios(comercio)
    assert f"{columna} in ({valores})" in limpio, (
        f"El CHECK de `{columna}` no coincide con el contrato"
    )


def test_los_estados_de_orden_y_derecho(comercio):
    limpio = _sin_comentarios(comercio)
    assert "'pending', 'paid', 'failed', 'cancelled', 'refunded'" in limpio
    assert "'active', 'revoked', 'expired'" in limpio
    assert "'free', 'entitlement', 'author', 'admin', 'legacy'" in limpio
    assert "'purchase', 'refund'" in limpio


def test_el_dinero_es_entero_y_en_unidad_menor(comercio):
    """`amount_minor`, nunca un decimal. Con coma flotante, 0.1 + 0.2 no es 0.3
    y el dinero acaba descuadrando."""
    limpio = _sin_comentarios(comercio)
    assert "amount_minor integer" in limpio
    assert not re.search(r"amount\w*\s+(numeric|real|double|float)", limpio, re.I), (
        "Un importe en coma flotante o decimal: el dinero va en enteros."
    )


def test_expires_at_existe_aunque_hoy_no_haya_suscripcion(comercio):
    """La columna se crea desde el principio a proposito: anadirla a una tabla
    con derechos ya concedidos obliga a decidir que significan los antiguos."""
    assert "expires_at" in _sin_comentarios(comercio)


def test_la_migracion_se_puede_repetir(comercio):
    """El editor de Supabase corre el script como una transaccion: si un
    statement falla, revierte todo. Repetible se puede reintentar por partes."""
    assert "create table if not exists" in comercio
    assert "drop policy if exists" in comercio
    assert "create index if not exists" in comercio


def test_recarga_el_cache_de_postgrest(comercio, acceso):
    """Sin esto, la API de Supabase sigue sirviendo el esquema viejo (PGRST205)."""
    assert "notify pgrst" in comercio
    assert "notify pgrst" in acceso


# --------------------------------------------------------------------------- #
# 0036 — las cinco vias de acceso, y que ninguna se pierda
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "via,patron",
    [
        ("gratuito", r"price_minor\s*=\s*0"),
        ("autor del curso", r"author_id\s*=\s*auth\.uid\(\)"),
        ("administracion", r"public\.is_admin\(\)"),
        ("entitlement activo", r"e\.status\s*=\s*'active'"),
        ("compra heredada", r"p\.status\s*=\s*'paid'"),
    ],
)
def test_las_cinco_vias_siguen_declaradas(acceso, via, patron):
    """La mas facil de perder es GRATUITO: sin ella, estrenar el muro deja sin
    acceso a todo el mundo de golpe."""
    assert re.search(patron, _sin_comentarios(acceso)), f"Se perdio la via: {via}"


def test_una_compra_a_medias_no_da_acceso(acceso):
    """Solo 'paid'. Un cobro iniciado y no completado no da derecho a nada."""
    estados = set(re.findall(r"p\.status\s*=\s*'(\w+)'", _sin_comentarios(acceso)))
    assert estados == {"paid"}, f"has_course_access acepta {estados}; solo vale 'paid'."


def test_el_respaldo_a_purchases_no_se_retira(acceso):
    """Es LA regla del trasvase: quien tenia acceso antes lo conserva despues.

    Quitar esta via el mismo dia que se estrena el dominio nuevo significa que
    un fallo en el trasvase deja sin su curso a gente que pago.
    """
    assert "public.purchases" in _sin_comentarios(acceso)


def test_el_trasvase_no_destruye_nada(acceso):
    """Ni borra, ni vacia, ni reescribe `purchases`. Solo lee de ahi."""
    limpio = _sin_comentarios(acceso).lower()
    for prohibido in (
        "delete from public.purchases",
        "truncate public.purchases",
        "truncate table public.purchases",
        "drop table public.purchases",
        "update public.purchases",
        "alter table public.purchases",
        "drop policy if exists purchases",
    ):
        assert prohibido not in limpio, f"El trasvase destruye datos: {prohibido}"


def test_el_trasvase_se_puede_repetir(acceso):
    """`on conflict do nothing` en cada insercion: correrlo diez veces deja lo
    mismo que correrlo una. Si no, un reintento duplica derechos."""
    limpio = _sin_comentarios(acceso).lower()
    inserciones = limpio.count("insert into public.")
    sin_duplicar = limpio.count("do nothing")
    assert inserciones >= 4, "Faltan pasos del trasvase"
    assert sin_duplicar >= inserciones, (
        f"{inserciones} inserciones y solo {sin_duplicar} protegidas contra repetir"
    )


def test_las_dos_funciones_de_acceso_existen(acceso):
    limpio = _sin_comentarios(acceso)
    assert "has_course_access" in limpio
    assert "has_lesson_access" in limpio


def test_la_muestra_es_lo_que_abre_una_leccion(acceso):
    """`is_preview` o el acceso al curso. Sin la primera, o se compra el curso
    entero o no se ve nada, y no hay forma de enseñar de que va."""
    limpio = _sin_comentarios(acceso)
    assert "is_preview" in limpio
    assert "has_course_access" in limpio.split("has_lesson_access")[1]


def test_las_funciones_no_las_recorta_la_propia_rls(acceso):
    """`security definer` con `search_path` fijado, en las dos.

    Sin el, la RLS de `entitlements` y `purchases` recortaria la consulta que
    hace la propia funcion: acceso denegado a quien pago. Y sin `search_path`,
    quien pueda crear objetos en otro esquema podria colar su propia tabla.
    """
    limpio = _sin_comentarios(acceso)
    for funcion in ("has_course_access", "has_lesson_access"):
        trozos = limpio.split(f"function public.{funcion}")
        assert len(trozos) > 1, f"No se declara {funcion}"
        cuerpo = trozos[1][:800]
        assert "security definer" in cuerpo, f"{funcion} sin security definer"
        assert "search_path" in cuerpo, f"{funcion} sin search_path fijado"


# --------------------------------------------------------------------------- #
# Donde se aplica de verdad: el almacenamiento
# --------------------------------------------------------------------------- #
def test_la_puerta_esta_en_el_almacenamiento_y_pregunta_por_leccion(acceso):
    """Una URL firmada solo se emite si la politica deja leer el objeto, asi
    que ya no importa lo que decida la aplicacion. Era el agujero de la 0016 y
    no se reabre: lo unico que cambia es que ahora pregunta por leccion, para
    que una muestra se reproduzca de verdad sin comprar."""
    limpio = _sin_comentarios(acceso)
    politica = re.search(
        r"create\s+policy\s+course_media_read\s+on\s+storage\.objects.*?;",
        limpio,
        re.IGNORECASE | re.DOTALL,
    )
    assert politica is not None, "Falta la politica del bucket course-media"
    assert "has_lesson_access" in politica.group(0)
    assert "for select" in politica.group(0).lower()


def test_los_documentos_de_la_leccion_van_por_el_mismo_rasero(acceso):
    """Si el video de una muestra se ve y su PDF no, la pantalla promete algo
    que el almacenamiento niega. Esa incoherencia es el fallo de siempre."""
    limpio = _sin_comentarios(acceso)
    politica = re.search(
        r"create\s+policy\s+course_lesson_resources_read.*?;",
        limpio,
        re.IGNORECASE | re.DOTALL,
    )
    assert politica is not None
    assert "has_lesson_access" in politica.group(0)


def test_el_bucket_sigue_privado(acceso):
    """Abrirlo haria inutil todo lo demas: los videos se servirian sin pasar por
    ninguna politica."""
    limpio = _sin_comentarios(acceso).lower()
    assert "set public = true" not in limpio
    assert "public = true" not in limpio
    assert not re.search(r"insert\s+into\s+storage\.buckets", limpio)


def test_la_0036_avisa_de_que_depende_de_la_0035(acceso):
    """Aplicarla sin las tablas del comercio dejaria la funcion a medias. Se
    corta antes de tocar nada, con un mensaje que dice que falta."""
    limpio = _sin_comentarios(acceso)
    assert "raise exception" in limpio.lower()
    assert "0035" in limpio
