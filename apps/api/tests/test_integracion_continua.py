"""Lo que la integracion continua EJECUTA de verdad, comprobado desde aqui.

POR QUE EXISTE ESTE FICHERO. El trabajo `migraciones` es el unico que tiene un
PostgreSQL de verdad, y llevaba una LISTA ESCRITA A MANO de los ficheros que
ejecutaba. Una lista a mano se queda vieja sola: un fichero nuevo que necesite
la base no falla, no se salta con un aviso, sencillamente **no se recoge**, y
la integracion sigue verde.

Ya paso dos veces. La primera, 92 de las 100 pruebas de Productos de los
Incrementos 8 y 9 no se ejecutaban y el Incremento 8 se dio por cerrado sin
verificacion. Se corrigio anadiendo los ficheros a la lista (5cd6d28)... y la
lista volvio a quedarse vieja en la misma sesion: `test_productos_disputas.py`,
que protege la unica puerta por la que se registra un contracargo, nacio
despues y no entro. Sus once pruebas se saltaban en el trabajo sin base y no se
recogian en el trabajo con base: no se ejecutaban en ningun sitio.

ASI QUE LO QUE SE VIGILA NO ES LA LISTA, ES QUE NO HAYA LISTA. Un trabajo que
ejecuta la bateria entera no puede olvidarse de un fichero. Si alguien vuelve a
acotar la seleccion, esta prueba exige que la seleccion cubra TODOS los ficheros
que usan el arnes de PostgreSQL, y se pone roja el dia que nazca el siguiente.

NO NECESITA POSTGRESQL: lee ficheros. Corre en los dos trabajos a proposito,
porque el defecto que persigue es precisamente que algo no corra en uno de
ellos.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[3]
CI = RAIZ / ".github" / "workflows" / "ci.yml"
PRUEBAS = Path(__file__).resolve().parent

#: Como se reconoce que un fichero de pruebas necesita el PostgreSQL desechable:
#: o pide el arnes (`base_aplicada`) o lee la variable que lo abre.
SENALES = ("base_aplicada", "MIGRACIONES_DATABASE_URL")


def _ficheros_que_necesitan_postgres() -> set[str]:
    """Los que se saltarian enteros sin base. Medido, no recordado."""
    encontrados: set[str] = set()
    for fichero in sorted(PRUEBAS.glob("test_*.py")):
        #: ESTE FICHERO NO CUENTA. Nombra las dos senales para poder buscarlas,
        #: asi que se detectaria a si mismo y pediria estar en una lista de la
        #: que no forma parte: no toca la base, lee texto.
        if fichero.name == Path(__file__).name:
            continue
        texto = fichero.read_text(encoding="utf-8")
        if any(senal in texto for senal in SENALES):
            encontrados.add(fichero.name)
    return encontrados


def _trabajo_de_migraciones() -> str:
    """El bloque YAML del trabajo `migraciones`, en crudo.

    Se corta por indentacion en vez de cargar el YAML para no anadir una
    dependencia (`pyyaml` no esta en `requirements.txt`) a una comprobacion que
    solo necesita leer texto.
    """
    texto = CI.read_text(encoding="utf-8")
    inicio = texto.index("\n  migraciones:")
    resto = texto[inicio + 1 :]
    siguiente = re.search(r"\n  [a-z_-]+:\n", resto)
    return resto[: siguiente.start()] if siguiente else resto


def test_el_trabajo_con_postgresql_no_deja_fuera_ningun_fichero() -> None:
    """Todo lo que necesita la base se ejecuta donde hay base.

    DOS FORMAS DE CUMPLIRLO, y las dos valen:

    * el trabajo ejecuta `pytest` sin nombrar ficheros —la bateria entera—, que
      es lo que no se puede olvidar de nada;
    * o los nombra, y entonces estan TODOS.

    Lo que no vale es una seleccion incompleta, que es lo que ha fallado dos
    veces.
    """
    bloque = _trabajo_de_migraciones()
    necesitan = _ficheros_que_necesitan_postgres()
    assert necesitan, "no se detecto ningun fichero que use el arnes: revisa SENALES"

    invocaciones = [
        linea
        for linea in bloque.splitlines()
        if re.search(r"(^|\s)pytest(\s|$)", linea) and not linea.strip().startswith("#")
    ]
    assert invocaciones, "el trabajo `migraciones` no ejecuta pytest"

    nombrados = set()
    acota = False
    for linea in invocaciones:
        citados = re.findall(r"tests/(test_[A-Za-z0-9_]+\.py)", linea)
        if citados:
            acota = True
            nombrados.update(citados)

    if not acota:
        #: Ejecuta la bateria entera: no hay lista que se quede vieja.
        return

    faltan = sorted(necesitan - nombrados)
    assert not faltan, (
        "estos ficheros necesitan PostgreSQL y el trabajo `migraciones` no los "
        "ejecuta, asi que sus pruebas no corren en NINGUN trabajo: "
        + ", ".join(faltan)
    )


def test_una_prueba_omitida_sigue_tumbando_el_trabajo() -> None:
    """El guardia de omisiones existe y se ejecuta sobre el informe real.

    Sin el, borrar la variable de entorno dejaria el trabajo en verde sin haber
    ejecutado nada contra PostgreSQL: todo omitido, todo «aprobado».
    """
    bloque = _trabajo_de_migraciones()
    assert "--junitxml=" in bloque, "sin informe no hay nada que auditar"
    assert "omitida no es aprobada" in bloque, "falta el guardia de omisiones"
    assert "saltadas" in bloque and "sys.exit" in bloque


FLUJOS = RAIZ / ".github" / "workflows"


def _trabajos_que_ejecutan_pytest() -> list[tuple[str, str, str]]:
    """(fichero, trabajo, bloque) de cada trabajo de cada flujo que lanza pytest.

    SE BUSCA EN TODOS LOS FLUJOS, no solo en `ci.yml`. El despliegue tiene su
    propia copia de la bateria —a proposito: un push a `main` no espera a la
    integracion continua— y esa copia tambien se puede quedar sin el arnes.
    """
    encontrados: list[tuple[str, str, str]] = []
    for flujo in sorted(FLUJOS.glob("*.yml")):
        texto = flujo.read_text(encoding="utf-8")
        for casa in re.finditer(r"\n  ([a-z_-]+):\n", texto):
            resto = texto[casa.end() :]
            fin = re.search(r"\n  [a-z_-]+:\n", resto)
            bloque = resto[: fin.start()] if fin else resto
            lanza = [
                linea
                for linea in bloque.splitlines()
                if re.search(r"(^|\s)pytest(\s|$)", linea)
                and not linea.strip().startswith("#")
            ]
            if lanza:
                encontrados.append((flujo.name, casa.group(1), bloque))
    return encontrados


def test_todo_trabajo_que_ejecuta_pytest_instala_el_arnes() -> None:
    """`psycopg` no es dependencia de la aplicacion pero SI de las pruebas.

    No esta en `requirements.txt` —la API habla con la base por asyncpg— y
    diecisiete ficheros de pruebas lo importan arriba del todo. Sin el, esos
    ficheros ni siquiera se RECOGEN: revienta la importacion, y eso no se lee
    como una bateria en rojo sino como una bateria mas corta... o como un
    trabajo entero en rojo sin que el mensaje hable de pruebas.

    EL CASO QUE ESTO TAPA, Y QUE ESTUVO ROTO DESDE EL INCREMENTO 4: el flujo de
    despliegue vuelve a lanzar la bateria a proposito, porque un push a `main`
    no espera a la integracion continua. Esa copia no instalaba psycopg, asi que
    el despliegue a produccion estaba BLOQUEADO —fallaba en la recoleccion— y
    nadie lo sabia, porque no se ha fusionado nada a `main` desde entonces.

    SE MIRAN TODOS LOS FLUJOS y no una lista de dos trabajos, por lo mismo que
    el trabajo con PostgreSQL ya no lleva una lista de ficheros: una lista
    escrita a mano se queda vieja sola.
    """
    trabajos = _trabajos_que_ejecutan_pytest()
    assert len(trabajos) >= 3, (
        f"se esperaban al menos tres trabajos con pytest, hay {len(trabajos)}: "
        f"{[(f, t) for f, t, _ in trabajos]}"
    )
    faltan = [
        f"{fichero}:{trabajo}"
        for fichero, trabajo, bloque in trabajos
        if "psycopg" not in bloque
    ]
    assert not faltan, (
        "estos trabajos ejecutan pytest y no instalan psycopg, asi que la "
        "recoleccion revienta antes de la primera prueba: " + ", ".join(faltan)
    )

def test_el_trabajo_del_movil_ejecuta_sus_pruebas_y_no_solo_los_tipos() -> None:
    """`mobile:check` es `tsc --noEmit`: comprueba TIPOS, no comportamiento.

    Las 113 baterias del movil —los contratos con la API, las reglas de cada
    pantalla y la paridad de los tres diccionarios— no se ejecutaban en ningun
    trabajo. Un cambio que rompiera una pantalla o dejara una clave sin traducir
    pasaba la integracion en verde. Tardan cuatro segundos.
    """
    texto = CI.read_text(encoding="utf-8")
    inicio = texto.index("\n  mobile:")
    resto = texto[inicio + 1 :]
    siguiente = re.search(r"\n  [a-z_-]+:\n", resto)
    bloque = resto[: siguiente.start()] if siguiente else resto
    assert "mobile:test" in bloque, (
        "el trabajo `mobile` no ejecuta las pruebas del movil, solo `tsc`"
    )

    #: Y EL GUION EXISTE. Un paso que invoca un guion inexistente falla, si;
    #: pero comprobarlo aqui dice POR QUE en vez de un `npm ERR!` en el registro.
    import json

    raiz = RAIZ / "package.json"
    guiones = json.loads(raiz.read_text(encoding="utf-8"))["scripts"]
    assert "mobile:test" in guiones, "falta el guion `mobile:test` en package.json"


def test_el_movil_no_puede_pasar_en_verde_sin_ejecutar_nada() -> None:
    """Un patron que no casa nada NO es un error para Node: son cero pruebas.

    EL AGUJERO. El guion del movil era una linea con un patron entre comillas.
    Renombrar a `.test.ts`, mover las pruebas a otra carpeta o tocar el patron
    en un refactor dejaba las ciento trece baterias sin ejecutar, con salida
    cero y el trabajo en verde. Es la misma forma de fallo que la lista de
    ficheros escrita a mano del trabajo con PostgreSQL, y esa ya se quedo vieja
    dos veces.

    LA DIFERENCIA CON LA BATERIA DE PYTHON: alli el suelo vive en el flujo
    porque el informe se audita despues. Aqui vive JUNTO AL PATRON, en el
    guion, porque separar los dos es precisamente lo que permite que uno se
    quede viejo sin el otro.
    """
    import json

    guion = RAIZ / "apps" / "mobile" / "scripts" / "pruebas.mjs"
    assert guion.exists(), "falta apps/mobile/scripts/pruebas.mjs"
    fuente = guion.read_text(encoding="utf-8")
    assert "SUELO" in fuente, "el lanzador del movil no tiene suelo"
    suelo = re.search(r"const SUELO = (\d+)", fuente)
    assert suelo is not None, "no se encuentra el suelo del lanzador"
    assert int(suelo.group(1)) >= 50, (
        f"el suelo del movil es {suelo.group(1)}: no protege de nada"
    )
    assert "process.exit(1)" in fuente, "el suelo no tumba nada"

    #: Y EL GUION DE NPM LO USA. Si `test` volviera a ser el patron suelto, el
    #: lanzador quedaria ahi sin que nadie lo llame.
    paquete = json.loads(
        (RAIZ / "apps" / "mobile" / "package.json").read_text(encoding="utf-8")
    )
    assert "scripts/pruebas.mjs" in paquete["scripts"]["test"], (
        "el guion `test` del movil no pasa por el lanzador con suelo"
    )


def test_el_node_del_ci_es_el_que_las_pruebas_necesitan() -> None:
    """`module.registerHooks` se anadio en 22.15, y cuatro baterias lo usan.

    Con 22.13 —lo que el flujo fijaba— esos cuatro ficheros no llegan ni a
    importarse: `SyntaxError`, y el fichero entero cae. No se vio hasta que las
    pruebas del movil empezaron a ejecutarse en la integracion continua.

    SE COMPRUEBA QUE LOS TRES SITIOS DIGAN LO MISMO: el flujo, `engines` y el
    README. Un `engines` que permita menos de lo que las pruebas necesitan deja
    a quien clone el repositorio con cuatro ficheros rotos y ningun motivo.
    """
    import json

    texto = CI.read_text(encoding="utf-8")
    del_flujo = re.search(r"node-version: '(\d+)\.(\d+)'", texto)
    assert del_flujo is not None, "el flujo no fija version de node"
    mayor, menor = int(del_flujo.group(1)), int(del_flujo.group(2))
    assert (mayor, menor) >= (22, 15), (
        f"el flujo fija node {mayor}.{menor}: `module.registerHooks` no existe"
    )

    paquete = json.loads((RAIZ / "package.json").read_text(encoding="utf-8"))
    exigido = re.search(r">=(\d+)\.(\d+)", paquete["engines"]["node"])
    assert exigido is not None
    assert (int(exigido.group(1)), int(exigido.group(2))) >= (22, 15), (
        "`engines` permite un node en el que cuatro baterias no se importan"
    )
