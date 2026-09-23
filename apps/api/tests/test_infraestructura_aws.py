"""Lo que tiene que seguir siendo verdad en `infra/aws/` para desplegar sin sustos.

POR QUE EXISTE. La API se muda de cuenta de AWS, a una cuenta COMPARTIDA con
otros productos de RenaserLab. Varias de las cosas que se corrigieron para
poder hacerlo fallan en silencio si alguien las deshace: un prefijo que alcanza
la configuracion de otro producto, una etiqueta `latest` que no dice que codigo
corre, una barrera de cuenta que desaparece, una bandera que regala cursos.
Ninguna rompe un despliegue: lo hacen peligroso. Por eso se vigilan aqui.

NO NECESITA AWS NI POSTGRESQL: lee ficheros. Lectura de texto a proposito: el
YAML de CloudFormation lleva etiquetas (`!Ref`, `!Sub`) que un lector generico
no entiende, y esta bateria no debe depender de uno.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parents[3]
INFRA = RAIZ / "infra" / "aws"
FUNDACION = INFRA / "01-fundacion.yaml"
PLATAFORMA = INFRA / "02-plataforma.yaml"
GUION = INFRA / "deploy-renaserlab.ps1"
FLUJO = RAIZ / ".github" / "workflows" / "desplegar-aws.yml"
PERFILES = sorted((INFRA / "parametros").glob("*.json"))

#: Los que el guion calcula en cada ejecucion y por tanto no van en un perfil.
INYECTADOS = {"ExpectedAccountId", "EtiquetaDeImagen"}

#: Los unicos que se quedan con el valor de la plantilla a proposito: el AMI es
#: un puntero publico de AWS a la ultima Amazon Linux 2023.
POR_DEFECTO_A_PROPOSITO = {"AmiDeAmazonLinux2023"}

#: El prefijo de los OTROS productos de la cuenta de RenaserLab.
PREFIJO_AJENO = "renaser"


def _parametros(plantilla: Path) -> dict[str, str]:
    """Nombre -> bloque de texto de cada parametro de la plantilla."""
    texto = plantilla.read_text(encoding="utf-8")
    seccion = re.search(r"^Parameters:\n(.*?)^\S", texto, re.S | re.M)
    assert seccion, f"{plantilla.name} no tiene seccion Parameters"
    bloques = re.split(r"^  (?=[A-Za-z0-9]+:\s*$)", seccion.group(1), flags=re.M)
    resultado: dict[str, str] = {}
    for bloque in bloques:
        cabecera = re.match(r"([A-Za-z0-9]+):\s*$", bloque, re.M)
        if cabecera:
            resultado[cabecera.group(1)] = bloque
    return resultado


def _perfil(fichero: Path) -> dict[str, str]:
    lista = json.loads(fichero.read_text(encoding="utf-8"))
    claves = [p["ParameterKey"] for p in lista]
    assert len(claves) == len(set(claves)), f"{fichero.name} repite parametros"
    return {p["ParameterKey"]: p["ParameterValue"] for p in lista}


def test_hay_dos_perfiles() -> None:
    assert [p.name for p in PERFILES] == ["alta-disponibilidad.json", "costo-controlado.json"]


@pytest.mark.parametrize("fichero", PERFILES, ids=lambda p: p.stem)
def test_cada_perfil_casa_con_la_plantilla(fichero: Path) -> None:
    """Un parametro de mas falla el despliegue; uno de menos aplica el defecto.

    Y un defecto puede ser destructivo: sin `FrenteHttpsDeEmergencia` la
    plantilla borra la distribucion de CloudFront, que es la URL de la API.
    """
    plantilla = _parametros(PLATAFORMA)
    perfil = _perfil(fichero)
    sobran = set(perfil) - set(plantilla)
    faltan = set(plantilla) - set(perfil) - INYECTADOS - POR_DEFECTO_A_PROPOSITO
    assert not sobran, f"{fichero.name} trae parametros que la plantilla no tiene: {sorted(sobran)}"
    assert not faltan, (
        f"{fichero.name} no fija {sorted(faltan)}: se aplicaria el valor por defecto "
        "sin que nadie lo haya decidido"
    )
    assert not INYECTADOS & set(perfil), (
        "la cuenta y la etiqueta las pone el guion en cada ejecucion; en un perfil "
        "versionado se quedarian viejas (y la cuenta no va en el repositorio)"
    )


@pytest.mark.parametrize("fichero", PERFILES, ids=lambda p: p.stem)
def test_ningun_perfil_enciende_dinero_ni_regala_cursos(fichero: Path) -> None:
    perfil = _perfil(fichero)
    assert perfil["PaymentsEnabled"] == "false"
    assert perfil["BetaFreeAccessEnabled"] == "false", (
        "la beta gratuita regala cursos de pago: se enciende con autorizacion, "
        "no por venir asi en el perfil"
    )


@pytest.mark.parametrize("fichero", PERFILES, ids=lambda p: p.stem)
def test_el_prefijo_es_propio_y_los_nombres_caben(fichero: Path) -> None:
    """En la cuenta compartida, `renaser` es de otros productos.

    El rol de despliegue se acota por prefijo: con `renaser` alcanzaria sus
    parametros `/renaser/prod/*`, que guardan contrasenas de base de datos. Y el
    balanceador se llama `<prefijo>-<entorno>-alb`: AWS no admite mas de 32.
    """
    perfil = _perfil(fichero)
    prefijo = perfil["PrefijoDeRecursos"]
    assert prefijo != PREFIJO_AJENO
    assert perfil["PilaDeFundacion"].startswith(prefijo + "-")
    assert perfil["NombreDelSecreto"].startswith(prefijo + "/")
    assert len(f"{prefijo}-{perfil['Entorno']}-alb") <= 32


@pytest.mark.parametrize("plantilla", [FUNDACION, PLATAFORMA], ids=lambda p: p.stem)
def test_el_prefijo_por_defecto_no_es_el_de_otros_productos(plantilla: Path) -> None:
    bloque = _parametros(plantilla)["PrefijoDeRecursos"]
    assert f"Default: {PREFIJO_AJENO}\n" not in bloque
    assert "{1,16}" in bloque, "el patron tiene que limitar el prefijo a 17 caracteres"


@pytest.mark.parametrize("plantilla", [FUNDACION, PLATAFORMA], ids=lambda p: p.stem)
def test_las_dos_pilas_se_niegan_a_otra_cuenta(plantilla: Path) -> None:
    """La barrera COMPROBADA contra la cuenta el 23/09/2026.

    Con una cuenta falsa, `create-change-set` falla en el acto por la
    dependencia sin resolver y no crea ni la pila. Una regla `Rules` contra
    AWS::AccountId no bloqueo el plan en la misma prueba: no vale sustituirla.
    """
    texto = plantilla.read_text(encoding="utf-8")
    parametro = _parametros(plantilla)["ExpectedAccountId"]
    assert "Default:" not in parametro, "sin defecto: quien despliega dice en que cuenta cree estar"
    assert "EsLaCuentaEsperada: !Equals [!Ref ExpectedAccountId, !Ref 'AWS::AccountId']" in texto
    assert re.search(
        r"BarreraExpectedAccountId:\n\s+Type: AWS::CloudFormation::WaitConditionHandle\n"
        r"\s+Condition: EsLaCuentaEsperada",
        texto,
    )
    assert "DependsOn: BarreraExpectedAccountId" in texto, "nadie depende de la barrera: no para nada"


def test_la_imagen_se_nombra_por_su_commit() -> None:
    etiqueta = _parametros(PLATAFORMA)["EtiquetaDeImagen"]
    assert "Default:" not in etiqueta
    assert "AllowedPattern: '^sha-[0-9a-f]{7,40}$'" in etiqueta
    flujo = FLUJO.read_text(encoding="utf-8")
    assert ":latest" not in flujo, "una etiqueta que se mueve no dice que codigo corre"


def test_el_rol_de_github_solo_mueve_su_puntero() -> None:
    texto = FUNDACION.read_text(encoding="utf-8")
    assert ":parameter/${PrefijoDeRecursos}/*/imagen-api'" in texto
    assert ":parameter/${PrefijoDeRecursos}/*'" not in texto, (
        "el comodin sobre todo el prefijo deja al CI reescribir cualquier "
        "parametro del producto"
    )


def test_el_flujo_de_despliegue_no_lleva_la_cuenta_escrita() -> None:
    """Mudar de cuenta es cambiar variables de GitHub, no editar el flujo."""
    flujo = FLUJO.read_text(encoding="utf-8")
    for variable in ("AWS_ROLE_ARN", "AWS_PILA_PLATAFORMA", "AWS_REPOSITORIO_ECR"):
        assert f"vars.{variable}" in flujo, f"el flujo no lee {variable} de las variables"


def test_ningun_fichero_de_despliegue_lleva_una_cuenta_de_aws() -> None:
    """Ni la anterior ni la nueva: la cuenta entra por el entorno del guion.

    La unica excepcion son las cuentas PUBLICADAS POR AWS que escriben los
    registros del balanceador, una por region.
    """
    ficheros = [FUNDACION, PLATAFORMA, GUION, FLUJO, *PERFILES]
    encontrados = []
    for fichero in ficheros:
        for numero, linea in enumerate(fichero.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(r"\{Cuenta: '\d{12}'\}", linea):
                continue
            if re.search(r"(?<![\w.-])\d{12}(?![\w-])", linea):
                encontrados.append(f"{fichero.name}:{numero}")
    assert not encontrados, f"identificadores de cuenta escritos: {encontrados}"


def test_el_guion_comprueba_la_cuenta_antes_de_hacer_nada() -> None:
    texto = GUION.read_text(encoding="utf-8")
    assert "Set-StrictMode -Version Latest" in texto
    assert "$ErrorActionPreference = 'Stop'" in texto
    assert "SupportsShouldProcess" in texto, "sin -WhatIf/-Confirm no hay separacion entre planificar y aplicar"
    principal = texto[texto.index("# Principal") :]
    assert principal.index("Assert-CuentaEsperada") < principal.index("switch ($Accion)")


def test_el_guion_solo_borra_la_pila_vacia_de_un_plan() -> None:
    """Descartar un plan de una pila nueva deja una pila vacia: solo esa se borra."""
    texto = GUION.read_text(encoding="utf-8")
    assert texto.count("'delete-stack'") == 1
    descartar = texto[texto.index("function Remove-Plan") : texto.index("function Wait-Pila")]
    assert "'delete-stack'" in descartar
    assert "REVIEW_IN_PROGRESS" in descartar and ".Count -eq 0" in descartar
    for prohibido in ("delete-repository", "delete-secret", "delete-bucket", "force-delete"):
        assert prohibido not in texto, f"el guion no borra datos: {prohibido}"
