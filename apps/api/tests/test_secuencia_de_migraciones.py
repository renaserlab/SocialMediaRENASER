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
