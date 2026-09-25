"""La secuencia de migraciones, leida. Sin PostgreSQL y sin excusas.

EL AGUJERO QUE ESTO TAPA. La suite construye el esquema con
`Base.metadata.create_all`, no con el SQL. Una migracion con un error de
sintaxis, con un `references` a una tabla que todavia no existe o que contradice
a los modelos pasaria CI en verde y solo daria la cara al pegarla en el editor
de Supabase, que es donde se aplican a mano.

QUE **NO** HACE. No ejecuta nada. Para eso esta `test_migraciones_reales.py`,
que necesita un PostgreSQL desechable y se salta solo cuando no lo hay. Las dos
se complementan: esta corre siempre y caza lo estructural; la otra corre en CI y
caza lo que solo se ve al ejecutar.

Sigue el estilo de `test_migracion_0044.py`, que ya hacia esto para una
migracion concreta. La diferencia es que aqui se vigila la SECUENCIA entera y el
contrato entre el SQL y los modelos, que es donde estaban los desajustes.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

MIGRACIONES = Path(__file__).resolve().parents[3] / "supabase" / "migrations"

#: Migraciones que introdujeron las tablas cuyo contrato se vigila aqui. No es
#: todo el esquema a proposito: son las que mueven dinero y acceso.
DEL_DINERO = (
    "0035_comercio.sql",
    "0049_garantia_devoluciones_y_liquidaciones.sql",
    "0050_versiones_politicas_y_auditoria.sql",
)

#: Migraciones que NO crean tablas: corrigen algo de una anterior. El contrato
#: SQL-modelos no aplica, pero la secuencia y las reglas de proyecto si.
SOLO_CORRIGEN = (
    "0051_endurecer_la_inmutabilidad_de_versiones.sql",
    "0052_cerrar_lectura_directa_de_datos_sensibles.sql",
    "0053_cerrar_el_comercio_por_postgrest.sql",
    "0054_aceptacion_de_recompra_en_las_tiendas.sql",
    "0083_publicar_solo_por_la_api.sql",
)


def _ficheros() -> list[Path]:
    return sorted(MIGRACIONES.glob("*.sql"))


def _sin_comentarios(sql: str) -> str:
    """Quita `--` y `/* */`. Un nombre citado en un comentario no es una
    dependencia, y contarlo como tal daria falsos positivos."""
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
    return re.sub(r"--[^\n]*", " ", sql)


@pytest.fixture(scope="module")
def migraciones() -> list[tuple[int, Path, str]]:
    salida = []
    for ruta in _ficheros():
        numero = re.match(r"^(\d{4})_", ruta.name)
        assert numero, f"nombre fuera de convencion: {ruta.name}"
        salida.append((int(numero.group(1)), ruta, _sin_comentarios(ruta.read_text(encoding="utf-8"))))
    return salida


# --------------------------------------------------------------------------- #
# 1. La secuencia
# --------------------------------------------------------------------------- #


def test_la_numeracion_es_continua_y_sin_duplicados(migraciones) -> None:
    """Sin huecos ni repetidos, y el orden alfabetico igual al numerico.

    Las migraciones se aplican leyendo la carpeta por nombre. Con un `999_` o un
    prefijo de tres digitos, el orden de aplicacion dejaria de ser el de
    creacion y una migracion correria antes que aquella de la que depende.
    """
    numeros = [n for n, _, _ in migraciones]
    assert numeros == sorted(numeros), "el orden alfabetico no coincide con el numerico"
    duplicados = {n for n in numeros if numeros.count(n) > 1}
    assert not duplicados, f"numeros repetidos: {sorted(duplicados)}"
    esperados = list(range(1, len(numeros) + 1))
    assert numeros == esperados, (
        f"hay huecos en la secuencia: falta(n) {sorted(set(esperados) - set(numeros))}"
    )


def test_ninguna_migracion_depende_de_otra_posterior(migraciones) -> None:
    """Un `references` hacia el futuro aplica en verde aqui y falla en la base.

    Se construye el mapa `objeto -> primera migracion que lo crea` y se comprueba
    que nadie nombra un objeto que nace despues. Los esquemas externos —`auth`,
    `storage`, `extensions`— quedan fuera: los pone el prologo, no el proyecto.
    """
    nace_en: dict[str, int] = {}
    for numero, _, sql in migraciones:
        for objeto in re.findall(
            r"create\s+(?:or\s+replace\s+)?(?:table|view|materialized\s+view|function|type)"
            r"\s+(?:if\s+not\s+exists\s+)?public\.([a-z_0-9]+)",
            sql,
        ):
            nace_en.setdefault(objeto, numero)

    problemas: list[str] = []
    for numero, ruta, sql in migraciones:
        for objeto in set(re.findall(r"\bpublic\.([a-z_0-9]+)", sql)):
            primera = nace_en.get(objeto)
            if primera is not None and primera > numero:
                problemas.append(f"{ruta.name} usa public.{objeto}, que nace en la {primera:04d}")
    assert not problemas, "dependencias hacia el futuro:\n  " + "\n  ".join(problemas)


def test_ninguna_migracion_destruye_datos(migraciones) -> None:
    """Aditivas siempre. Un `drop table` en una migracion es irreversible.

    `drop policy`, `drop trigger`, `drop index` y `drop constraint` SI se
    permiten: son la forma idempotente de volver a declararlos, y el proyecto la
    usa en todas partes.
    """
    prohibido = re.compile(
        r"\b(drop\s+table|truncate\s+table|truncate\s+public|drop\s+column|drop\s+schema)\b"
    )
    culpables = [ruta.name for _, ruta, sql in migraciones if prohibido.search(sql)]
    assert not culpables, f"migraciones con sentencias destructivas: {culpables}"


# --------------------------------------------------------------------------- #
# 2. RLS
# --------------------------------------------------------------------------- #


def test_las_tablas_del_dinero_tienen_rls_y_ninguna_politica_de_escritura(
    migraciones,
) -> None:
    """La regla del proyecto: RLS puesta y CERO politicas de escritura.

    Con RLS activa y sin politica, la clave anonima no escribe nada; escribe solo
    la API con la clave de servicio, que es la unica que valida importes. Una
    politica `for insert` sobre una tabla de dinero seria la puerta para que el
    telefono se escriba un derecho, y no la detectaria ninguna otra prueba.
    """
    por_nombre = {ruta.name: sql for _, ruta, sql in migraciones}
    for nombre in DEL_DINERO:
        sql = por_nombre[nombre]
        con_rls = set(re.findall(r"alter\s+table\s+public\.([a-z_0-9]+)\s+enable\s+row\s+level\s+security", sql))
        assert con_rls, f"{nombre} no activa RLS en ninguna tabla"

        escrituras = re.findall(
            r"create\s+policy\s+[a-z_0-9]+\s+on\s+public\.([a-z_0-9]+)\s+for\s+(insert|update|delete|all)",
            sql,
        )
        assert not escrituras, (
            f"{nombre} declara politicas de ESCRITURA sobre {escrituras}: "
            "el dinero solo se escribe desde el backend"
        )

        # Y toda tabla creada ahi tiene que tener su RLS.
        creadas = set(re.findall(r"create\s+table\s+if\s+not\s+exists\s+public\.([a-z_0-9]+)", sql))
        sin_rls = creadas - con_rls
        assert not sin_rls, f"{nombre} crea tablas sin RLS: {sorted(sin_rls)}"


# --------------------------------------------------------------------------- #
# 3. El contrato entre el SQL y los modelos
# --------------------------------------------------------------------------- #


def _partes(cuerpo: str) -> list[str]:
    """El cuerpo de un `create table`, partido por las comas de NIVEL CERO.

    Partir por lineas no vale: una definicion se continua en la de abajo
    —`references public.x(id)` y luego `on delete restrict`— y el primer token
    de esa continuacion parece un nombre de columna. Partir por todas las comas
    tampoco: las hay dentro de `check (x in ('a','b'))` y de `numeric(10, 2)`.
    """
    partes: list[str] = []
    profundidad = 0
    actual: list[str] = []
    en_texto = False
    for caracter in cuerpo:
        if caracter == "'":
            en_texto = not en_texto
        if not en_texto:
            if caracter == "(":
                profundidad += 1
            elif caracter == ")":
                profundidad -= 1
            elif caracter == "," and profundidad == 0:
                partes.append("".join(actual))
                actual = []
                continue
        actual.append(caracter)
    partes.append("".join(actual))
    return [" ".join(p.split()) for p in partes if p.strip()]


def _tablas_del_orm() -> dict[str, object]:
    """El metadata con TODOS los modelos registrados."""
    from app.shared.database import Base

    # Importar por su efecto: cada modulo registra sus tablas en `Base.metadata`.
    from app.modules.catalog import models as _catalog  # noqa: F401
    from app.modules.commerce import models as _commerce  # noqa: F401
    from app.modules.gobernanza import models as _gobernanza  # noqa: F401
    from app.modules.learning import models as _learning  # noqa: F401
    from app.modules.profiles import models as _profiles  # noqa: F401
    from app.modules.refunds import models as _refunds  # noqa: F401

    return dict(Base.metadata.tables)


#: El bloque `create table` completo, hasta el parentesis de cierre en su propia
#: linea. Se declara aparte por legibilidad: lleva un salto de linea dentro.
#:
#: `IF NOT EXISTS` ES OPCIONAL, y no es un detalle. Exigirlo dejaba fuera las 23
#: tablas de la 0001 y las de la 0003, que se declaran `create table public.X (`
#: a secas. Entre ellas esta `purchases`, con `amount_minor`, `currency` y
#: `provider_transaction_id`: la tabla de compras mas antigua del proyecto no la
#: miraba nadie, y la lista que presume de deducirse del esquema no veia medio
#: esquema.
_CREA_TABLA = re.compile(
    r"create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z_0-9]+)\s*\((.*?)\n\);",
    re.S | re.I,
)

#: Señales de que una tabla guarda dinero. NO SE MIRA EL NOMBRE: se mira lo que
#: declara, porque el nombre lo elige quien la crea y estas columnas no.
_SENAL_DE_DINERO = re.compile(
    r"amount_minor|amount_cents|_fee_minor|_fee_bps|currency"
    r"|external_[a-z_]*id|balance_minor|payout|transfer",
    re.I,
)

#: Tablas que guardan rastro de una persona sin llevar importes, asi que la
#: deteccion de arriba no las ve. Van a mano y con motivo.
SIN_IMPORTES_PERO_IGUAL_DE_SENSIBLES = (
    "audit_events",              # quien movio cada euro, con huella de red
    "consent_records",           # quien acepto que, y cuando
    "entitlements",              # quien tiene acceso a que, o sea quien compro
    "course_enrollments",        # lo mismo con otra forma
    "course_refund_windows",     # quien uso su garantia
    "refund_request_events",     # notas internas de revision
    "refund_policy_acceptances", # quien acepto recomprar tras devolver
)

#: Politicas de una tabla DE DINERO que sigan con `is_admin()` a proposito. Cada
#: una necesita su motivo escrito aqui, como `tabla.politica`; sin entrada, la
#: prueba falla.
#:
#: NO ES UNA VALVULA DE ESCAPE. Es lo contrario: obliga a que la proxima
#: excepcion sea una decision y no un olvido, que es exactamente como se
#: quedaron once politicas con `is_admin()` hasta la 0052 y la 0053.
#:
#: ESTA VACIA, Y ASI TIENE QUE ESTAR. Hubo aqui tres entradas —`course_versions`,
#: `policy_versions` y `commerce_products`— y las tres sobraban: ninguna de esas
#: tablas guarda dinero, asi que la deteccion no las mira y la excepcion no
#: eximia de nada. Era un comentario disfrazado de regla, y de los peores: daba
#: la sensacion de que alguien habia repasado esas politicas. La decision sobre
#: `course_versions_read` y `policy_versions_read` —que siguen con `is_admin()`
#: porque ver un borrador sin publicar es parte de moderar— esta escrita donde
#: corresponde, en la cabecera de la 0052.
EXCEPCIONES_DELIBERADAS: set[str] = set()


def _tablas_con_dinero() -> set[str]:
    """Se DEDUCE del esquema, no se escribe a mano.

    ESCRIBIRLA A MANO FUE EL FALLO. La lista anterior salio del incidente que la
    motivo —las nueve tablas que arreglo la 0052— y no de que tablas guardan
    dinero. La prueba estaba en verde y lo que significaba era «moderar no llega
    a estas nueve», mientras `orders`, `payment_transactions` y
    `provider_products` seguian abiertas a quien solo modera. Deducirla es lo
    que hace que una tabla de dinero futura entre sola.
    """
    encontradas: set[str] = set(SIN_IMPORTES_PERO_IGUAL_DE_SENSIBLES)
    for ruta in _ficheros():
        sql = _sin_comentarios(ruta.read_text(encoding="utf-8"))
        for bloque in re.finditer(
            _CREA_TABLA,
            sql,
        ):
            if _SENAL_DE_DINERO.search(bloque.group(2)):
                encontradas.add(bloque.group(1))
    return encontradas


def _politicas_finales() -> dict[str, tuple[str, str]]:
    """La ULTIMA definicion de cada politica, que es la que queda en la base.

    Las migraciones se aplican en orden y cada una puede redefinir politicas de
    las anteriores con `drop policy if exists` + `create policy`. Mirar una sola
    migracion no dice como termina la base: hay que recorrerlas todas.
    """
    finales: dict[str, tuple[str, str]] = {}
    for ruta in _ficheros():
        sql = _sin_comentarios(ruta.read_text(encoding="utf-8"))
        for bloque in re.finditer(
            r"create\s+policy\s+([a-z_0-9]+)\s+on\s+public\.([a-z_0-9]+)(.*?);",
            sql,
            flags=re.S | re.I,
        ):
            # LA CLAVE LLEVA LA TABLA. Indexando solo por el nombre de la
            # politica, dos homonimas en tablas distintas se pisaban: ganaba la
            # ultima y la otra desaparecia de todas las comprobaciones.
            finales[f"{bloque.group(2)}.{bloque.group(1)}"] = (
                bloque.group(2),
                bloque.group(3),
            )
    return finales


def test_moderar_no_da_acceso_a_las_tablas_de_dinero_por_la_rls() -> None:
    """LA RLS ES EL OTRO CAMINO, y durante un tiempo dijo lo contrario que la API.

    El movil habla con PostgREST usando la clave anonima, asi que quien decide
    que filas se leen es la politica, no el esquema de salida de FastAPI. La API
    separaba moderar de mover dinero con `puede_mover_dinero`; primero nueve
    politicas y despues otras cinco seguian con `is_admin()`, que incluye a
    `moderator`. Con su propio JWT, una cuenta que solo modera llegaba al motivo
    privado que escribio cada alumno al pedir su devolucion, a los saldos de
    cada autor y al historial de compras de todo el mundo.

    Mira COMO TERMINA la base tras aplicar todas las migraciones en orden, no lo
    que dice una suelta, porque una posterior puede redefinir la politica de
    otra. Y la lista de tablas se deduce del esquema: ver `_tablas_con_dinero`.
    """
    con_dinero = _tablas_con_dinero()
    abiertas = [
        clave
        for clave, (tabla, cuerpo) in _politicas_finales().items()
        if tabla in con_dinero
        and "is_admin" in cuerpo
        and clave not in EXCEPCIONES_DELIBERADAS
    ]
    assert not abiertas, (
        "politicas de tablas de dinero que siguen decidiendo con is_admin(), "
        f"que incluye a moderator: {sorted(abiertas)}"
    )


#: La declaracion de la funcion y su CUERPO, que es lo que va entre los `$$`.
#:
#: ACOTAR AL CUERPO NO ES COSMETICA. Buscando `role …` con `.*?` a partir de la
#: cabecera, el dia que el cuerpo dejara de nombrar `role` la expresion seguiria
#: buscando por el resto del fichero y acabaria comparando `FINANCE_ROLES` con
#: los roles de OTRA funcion, sin fallar y sin que nadie lo notase.
_CUERPO_DE_FUNCION = re.compile(
    r"create\s+or\s+replace\s+function\s+public\.(is_admin|puede_mover_dinero)\s*\(\)"
    r"(?P<cabecera>[^$]*)\$\$(?P<cuerpo>.*?)\$\$",
    re.S | re.I,
)

_ROLES_EN_EL_CUERPO = re.compile(
    r"role\s+(?:in\s*\((?P<lista>[^)]*)\)|=\s*(?P<uno>'[a-z_]+'))",
    re.S | re.I,
)


def _roles_en_sql() -> dict[str, set[str]]:
    """Los roles que cada funcion SQL acepta, segun la ULTIMA definicion."""
    encontrados: dict[str, set[str]] = {}
    for ruta in _ficheros():
        sql = _sin_comentarios(ruta.read_text(encoding="utf-8"))
        for casa in _CUERPO_DE_FUNCION.finditer(sql):
            roles = _ROLES_EN_EL_CUERPO.search(casa.group("cuerpo"))
            assert roles is not None, (
                f"public.{casa.group(1)}() ya no compara `role` en su cuerpo: "
                "esta prueba dejaria de comprobar nada"
            )
            crudo = roles.group("lista") or roles.group("uno") or ""
            encontrados[casa.group(1)] = {
                t.strip().strip("'") for t in crudo.split(",") if t.strip()
            }
    return encontrados


def test_los_roles_de_la_base_y_los_del_codigo_dicen_lo_mismo() -> None:
    """Dos copias del mismo reparto, una en Python y otra en SQL.

    ES EL FALLO DE ESTE PROYECTO, girado. Primero la API separo moderar de mover
    dinero y la RLS no; el dia que se anada un rol de tesoreria a
    `FINANCE_ROLES`, la API se lo concedera y la funcion SQL —con `admin`
    escrito a mano— se lo negara. La divergencia vuelve, en la otra direccion, y
    otra vez sin que nadie se entere hasta que alguien la sufra.
    """
    from app.shared.permissions import ADMIN_ROLES, FINANCE_ROLES

    en_sql = _roles_en_sql()
    assert en_sql.get("puede_mover_dinero") == FINANCE_ROLES, (
        f"puede_mover_dinero() acepta {sorted(en_sql.get('puede_mover_dinero', []))} "
        f"y FINANCE_ROLES dice {sorted(FINANCE_ROLES)}"
    )
    assert en_sql.get("is_admin") == ADMIN_ROLES, (
        f"is_admin() acepta {sorted(en_sql.get('is_admin', []))} "
        f"y ADMIN_ROLES dice {sorted(ADMIN_ROLES)}"
    )


def test_las_excepciones_a_la_regla_siguen_existiendo() -> None:
    """Una excepcion que ya no apunta a nada deja de ser una decision.

    Si una politica de `EXCEPCIONES_DELIBERADAS` se renombra o se borra, la
    entrada se queda ahi tapando una politica futura que se llame igual. Se
    comprueba que las tres siguen siendo politicas reales.
    """
    finales = _politicas_finales()
    fantasmas = sorted(EXCEPCIONES_DELIBERADAS - set(finales))
    assert not fantasmas, f"excepciones que ya no corresponden a ninguna politica: {fantasmas}"

    # Y QUE EXCLUYAN ALGO. Una excepcion sobre una tabla que la deteccion no
    # considera de dinero no exime de nada: es un comentario disfrazado de
    # regla. `commerce_products_read` estuvo aqui con el motivo «lleva precio y
    # moneda» y esa tabla no tiene ni precio ni moneda.
    inutiles = sorted(
        c
        for c in EXCEPCIONES_DELIBERADAS
        if finales[c][0] not in _tablas_con_dinero() or "is_admin" not in finales[c][1]
    )
    assert not inutiles, (
        "excepciones que no eximen de nada: o la tabla no es de dinero, o la "
        f"politica ya no usa is_admin(): {inutiles}"
    )


#: Las tres que la 0052 cierra POR COLUMNA: se les retira el `select` de tabla y
#: se les vuelve a conceder la lista de columnas visibles, para que cada persona
#: siga viendo su propio consentimiento o su propia solicitud sin el rastro de
#: red ni los campos internos. Ese `revoke` vive dentro de un bucle `do $$` con
#: `execute format`, asi que ninguna expresion regular lo va a encontrar: se
#: declaran aqui, y lo que se les exige es que ademas pierdan `truncate`.
CERRADAS_POR_COLUMNA = frozenset(
    {"audit_events", "consent_records", "refund_requests"}
)


def tabla_de_bloque_cerrada_por_columna(objetivo: str) -> bool:
    """Si todas las tablas de este `revoke` son de las que cierra la 0052."""
    tablas = set(re.findall(r"public\.([a-z_0-9]+)", objetivo))
    return bool(tablas) and tablas <= CERRADAS_POR_COLUMNA


def test_las_tablas_de_dinero_no_se_sirven_por_postgrest() -> None:
    """SEGUNDA BARRERA, porque la RLS era la unica.

    Supabase concede por defecto todos los privilegios de cada tabla a `anon` y
    `authenticated`. En las tablas de dinero eso dejaba a la politica como unica
    cosa entre la clave anonima y los datos: una politica mal escrita manana no
    tendria nada detras. Y `truncate` ni siquiera pasa por la RLS.

    El movil no lee ninguna de estas tablas —habla con FastAPI—, asi que la
    concesion no le hace falta a nadie.
    """
    concedidas: dict[str, str] = {}
    for ruta in _ficheros():
        sql = _sin_comentarios(ruta.read_text(encoding="utf-8"))
        for bloque in re.finditer(
            r"(?<![A-Za-z_])(grant|revoke)\s+(.*?)\s+(?:on|ON)\s+(.*?)\s+(?:to|from)\s+([^;]+);",
            sql,
            flags=re.S | re.I,
        ):
            verbo = bloque.group(1).lower()
            quien = bloque.group(4).lower()
            if "anon" not in quien and "authenticated" not in quien:
                continue
            # SE MIRAN LOS PRIVILEGIOS, NO SOLO EL VERBO. Mirando solo `revoke`,
            # cambiar `revoke all` por `revoke trigger` dejaba `select` y
            # `truncate` en pie para la clave anonima, la segunda barrera que la
            # migracion anuncia no existia, y esta prueba seguia en verde.
            # Comprobado con esa mutacion exacta.
            privilegios = bloque.group(2).lower()
            # QUE SEA UN `revoke` NO BASTA: hay que mirar QUÉ revoca. Cambiar
            # `revoke all` por `revoke trigger` dejaba `select` y `truncate` en
            # pie para la clave anonima —la segunda barrera que la migracion
            # anuncia no existia— y esta prueba seguia en verde. `truncate`
            # importa aparte porque es el unico que la RLS no controla: una
            # politica no impide vaciar la tabla de auditoria.
            if verbo != "revoke":
                cierra = False
            elif "all" in privilegios:
                cierra = True
            elif "truncate" not in privilegios:
                cierra = False
            else:
                cierra = "select" in privilegios or tabla_de_bloque_cerrada_por_columna(
                    bloque.group(3)
                )
            for tabla in re.findall(r"public\.([a-z_0-9]+)", bloque.group(3)):
                concedidas[tabla] = "cerrada" if cierra else "abierta"
    sin_cerrar = sorted(
        t for t in _tablas_con_dinero() if concedidas.get(t) != "cerrada"
    )
    assert not sin_cerrar, (
        "tablas de dinero que siguen alcanzables por anon/authenticated: hace "
        "falta un `revoke all` (o al menos select y truncate), no un revoke "
        f"cualquiera: {sin_cerrar}"
    )


def test_una_migracion_correctora_no_crea_tablas_y_dice_como_deshacerse(
    migraciones,
) -> None:
    """Las dos reglas de una migracion que corrige a otra ya aplicada.

    NO CREA TABLAS. Si creara una, no seria una correccion: seria un cambio de
    modelo disfrazado, y el contrato entre el SQL y el ORM dejaria de estar
    cubierto por las pruebas de arriba, que solo miran las de `DEL_DINERO`.

    Y DICE COMO DESHACERSE. Estas migraciones se aplican a mano, de una en una,
    sobre una base donde ya hay datos. Quien las pega en el editor tiene que
    poder leer, en el mismo fichero, que hace falta para volver atras: buscarlo
    despues, con algo a medio aplicar, es justo el peor momento.
    """
    sin_comentarios = {ruta.name: sql for _, ruta, sql in migraciones}
    for nombre in SOLO_CORRIGEN:
        assert nombre in sin_comentarios, f"{nombre} ya no existe: actualiza la lista"
        assert not re.search(r"create\s+table", sin_comentarios[nombre], flags=re.I), (
            f"{nombre} crea una tabla: entonces no es solo una correccion"
        )
        # El rollback se lee del fichero ENTERO: va en comentarios, y la fixture
        # los quita para poder analizar el SQL.
        entero = (MIGRACIONES / nombre).read_text(encoding="utf-8")
        assert "rollback" in entero.lower(), f"{nombre} no explica como deshacerse"


def test_las_tablas_del_dinero_existen_en_los_modelos(migraciones) -> None:
    """Una tabla en el SQL que nadie mapea es una tabla que nadie prueba."""
    por_nombre = {ruta.name: sql for _, ruta, sql in migraciones}
    tablas = _tablas_del_orm()
    faltan: list[str] = []
    for nombre in DEL_DINERO:
        for tabla in re.findall(
            r"create\s+table\s+if\s+not\s+exists\s+public\.([a-z_0-9]+)", por_nombre[nombre]
        ):
            if tabla not in tablas:
                faltan.append(f"{tabla} ({nombre})")
    assert not faltan, f"tablas del SQL sin modelo: {faltan}"


def test_las_columnas_del_sql_existen_en_los_modelos(migraciones) -> None:
    """Cada columna declarada en el SQL tiene que estar en el modelo.

    Al reves NO se comprueba: un modelo puede declarar de mas y eso lo caza la
    prueba real al insertar. Lo que aqui importa es que el modelo no ignore una
    columna que la base exige.
    """
    por_nombre = {ruta.name: sql for _, ruta, sql in migraciones}
    tablas = _tablas_del_orm()
    problemas: list[str] = []
    for nombre in DEL_DINERO:
        sql = por_nombre[nombre]
        for bloque in re.finditer(
            r"create\s+table\s+if\s+not\s+exists\s+public\.([a-z_0-9]+)\s*\((.*?)\n\);",
            sql,
            flags=re.S,
        ):
            tabla, cuerpo = bloque.group(1), bloque.group(2)
            modelo = tablas.get(tabla)
            if modelo is None:
                continue
            columnas_del_modelo = {c.name for c in modelo.columns}
            for parte in _partes(cuerpo):
                nombre_columna = re.match(r"^([a-z_][a-z_0-9]*)\s+[a-z]", parte)
                if not nombre_columna:
                    continue
                columna = nombre_columna.group(1)
                if columna in {"constraint", "primary", "unique", "check", "foreign"}:
                    continue
                if columna not in columnas_del_modelo:
                    problemas.append(f"{tabla}.{columna} esta en {nombre} y no en el modelo")
    assert not problemas, "columnas sin mapear:\n  " + "\n  ".join(problemas)


def test_cada_check_con_nombre_del_sql_esta_en_los_modelos(migraciones) -> None:
    """Un CHECK que solo vive en el SQL deja pasar en pruebas lo que produccion
    rechaza.

    Es el desajuste mas caro de todos: la prueba escribe un estado imposible, se
    pone verde, y el mismo codigo revienta al llegar a la base de verdad.
    """
    por_nombre = {ruta.name: sql for _, ruta, sql in migraciones}
    tablas = _tablas_del_orm()
    faltan: list[str] = []
    for nombre in DEL_DINERO:
        sql = por_nombre[nombre]
        for bloque in re.finditer(
            r"create\s+table\s+if\s+not\s+exists\s+public\.([a-z_0-9]+)\s*\((.*?)\n\);",
            sql,
            flags=re.S,
        ):
            tabla, cuerpo = bloque.group(1), bloque.group(2)
            modelo = tablas.get(tabla)
            if modelo is None:
                continue
            nombres = {c.name for c in modelo.constraints if c.name}
            for check in re.findall(r"constraint\s+([a-z_0-9]+)\s+check", cuerpo):
                if check not in nombres:
                    faltan.append(f"{tabla}: CHECK «{check}» solo esta en {nombre}")
    assert not faltan, "restricciones sin replicar en los modelos:\n  " + "\n  ".join(faltan)


def test_eventos_cursos_y_directos_solo_se_escriben_por_la_api() -> None:
    """La 0083 quita a `anon` y `authenticated` la escritura de las tres tablas
    cuyo `status` decide qué se publica, y les deja la lectura.

    Sin esto, un organizador publicaba su evento con un PATCH a PostgREST y la
    clave anónima de la app, sin pasar por la admisión (verificado contra la
    base el 23/09/2026). Si alguien «simplifica» la 0083 a un `revoke all`, la
    app pierde la lectura de `courses` y los directos, el tiempo real.
    """
    sql = _sin_comentarios((MIGRACIONES / "0083_publicar_solo_por_la_api.sql").read_text(encoding="utf-8"))
    normal = " ".join(sql.lower().split())
    assert (
        "revoke insert, update, delete, truncate, references, trigger on "
        "public.events, public.courses, public.live_sessions from anon, authenticated;"
    ) in normal
    assert "revoke all" not in normal
    assert "revoke select" not in normal
