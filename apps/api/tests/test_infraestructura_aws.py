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


def test_se_publica_una_imagen_y_no_un_indice() -> None:
    """Un indice OCI deja la imagen real SIN ETIQUETA dentro de ECR.

    ECR no escanea el indice, y la regla de ciclo de vida que borra lo no
    etiquetado podria llevarse la imagen y dejar `sha-<commit>` sin nada que
    descargar. Paso con la primera imagen publicada en RenaserLab.
    """
    guion = GUION.read_text(encoding="utf-8")
    assert "'--provenance=false', '--sbom=false'" in guion
    assert "imageManifestMediaType" in guion, "el guion no comprueba lo que publico"
    assert "provenance: false" in FLUJO.read_text(encoding="utf-8")


def test_el_rol_de_github_solo_mueve_su_puntero() -> None:
    texto = FUNDACION.read_text(encoding="utf-8")
    assert ":parameter/${PrefijoDeRecursos}/*/imagen-api'" in texto
    assert ":parameter/${PrefijoDeRecursos}/*'" not in texto, (
        "el comodin sobre todo el prefijo deja al CI reescribir cualquier "
        "parametro del producto"
    )


def test_las_maquinas_no_leen_parametros_de_otros_productos() -> None:
    """AmazonSSMManagedInstanceCore concede ssm:GetParameter sobre `*`.

    En la cuenta compartida eso dejaba leer /renaser/prod/* a las maquinas de
    Z. Lo encontro el simulador de IAM con la pila ya desplegada. Mientras esa
    politica gestionada siga puesta, tiene que ir acompanada del Deny.
    """
    texto = PLATAFORMA.read_text(encoding="utf-8")
    if "AmazonSSMManagedInstanceCore" not in texto:
        return
    assert re.search(
        r"Sid: NingunParametroQueNoSeaDeEsteEntorno\n\s+Effect: Deny\n"
        r"\s+Action: \[ssm:GetParameter, ssm:GetParameters, ssm:GetParametersByPath, ssm:GetParameterHistory\]\n"
        r"\s+NotResource:\n"
        r"\s+- !Sub 'arn:\$\{AWS::Partition\}:ssm:\$\{AWS::Region\}:\$\{AWS::AccountId\}:parameter/\$\{PrefijoDeRecursos\}/\$\{Entorno\}/\*'",
        texto,
    ), "las maquinas podrian leer los parametros de cualquier producto de la cuenta"


def test_las_alarmas_de_creditos_no_saltan_por_una_maquina_nueva() -> None:
    """Una t3 standard nace con cero creditos: el saldo solo no dice nada.

    Mirando solo el saldo, `creditos-de-cpu-bajos` pasaba casi una hora en rojo
    tras cada despliegue y `creditos-de-cpu-bajando` unas seis, con la CPU al
    1 %. Tienen que exigir ademas que la CPU supere su linea base.
    """
    texto = PLATAFORMA.read_text(encoding="utf-8")
    for umbral in ("20", "144"):
        assert f"IF(saldo < {umbral} AND cpu > ${{Base}}, 1, 0)" in texto, (
            f"la alarma de creditos de {umbral} vuelve a mirar solo el saldo"
        )
    assert texto.count("LineaBaseDeCpu: '20'") == 2, "cada perfil necesita su linea base"


def test_renovar_lanza_la_maquina_nueva_antes_de_terminar_la_vieja() -> None:
    """Con solo MinHealthyPercentage=100, AWS termina primero y lanza despues.

    Medido en RenaserLab: tres minutos sin ninguna maquina sana al renovar con
    una sola instancia. Hace falta MaxHealthyPercentage por encima de 100 en
    TODAS las renovaciones: la del guion y las dos del flujo (desplegar y
    volver atras).
    """
    guion = GUION.read_text(encoding="utf-8")
    flujo = FLUJO.read_text(encoding="utf-8")
    assert "MinHealthyPercentage = 100; MaxHealthyPercentage = 200" in guion
    assert flujo.count('"MinHealthyPercentage":100,"MaxHealthyPercentage":200') == 2
    assert flujo.count('"MinHealthyPercentage"') == 2, "hay una renovacion sin el maximo"


def test_el_flujo_de_despliegue_no_lleva_la_cuenta_escrita() -> None:
    """Mudar de cuenta es cambiar variables de GitHub, no editar el flujo."""
    flujo = FLUJO.read_text(encoding="utf-8")
    for variable in ("AWS_ROLE_ARN", "AWS_PILA_PLATAFORMA", "AWS_REPOSITORIO_ECR"):
        assert f"vars.{variable}" in flujo, f"el flujo no lee {variable} de las variables"


def test_los_valores_por_defecto_del_flujo_no_son_los_de_la_cuenta_dada_de_baja() -> None:
    """Sin variables, el flujo va a RenaserLab y con el prefijo de Z.

    La cuenta de Ricardo se dio de baja en septiembre de 2026. Sus nombres
    (`renaser-plataforma-produccion`, `renaser/api`) ya no existen, y en
    RenaserLab `renaser-*` es el prefijo de otros productos de la cuenta.
    """
    flujo = FLUJO.read_text(encoding="utf-8")
    assert "vars.AWS_PILA_PLATAFORMA || 'zexcelencia-plataforma-produccion'" in flujo
    assert "vars.AWS_REPOSITORIO_ECR || 'zexcelencia/api'" in flujo
    for viejo in ("|| 'renaser-plataforma-produccion'", "|| 'renaser/api'"):
        assert viejo not in flujo, f"el flujo sigue cayendo en {viejo}"


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


# --------------------------------------------------------------------------- #
# Z Servicios: se despliega apagado, sin «a domicilio», en soles y sin cobrar
# --------------------------------------------------------------------------- #
#: Lo que la plantilla escribe en el entorno de la API para Servicios.
DE_SERVICIOS = {
    "FEATURE_SERVICES": "FeatureServices",
    "FEATURE_SERVICE_BOOKING": "FeatureServiceBooking",
    "SERVICES_PUBLIC_ACCESS": "ServicesPublicAccess",
    "SERVICES_CATALOG_MODALITIES": "ServicesCatalogModalities",
    "SERVICES_CATALOG_CURRENCIES": "ServicesCatalogCurrencies",
}
#: Lo que va FIJO: cobrar un servicio no se enciende desde la infraestructura.
FIJAS_DE_SERVICIOS = {"FEATURE_SERVICE_PAYMENTS": "false", "SERVICE_PAYMENTS_PROVIDER": "none"}
CLAVE_DEL_PILOTO = "SERVICES_PILOT_PROFILE_IDS"


def _entorno_que_escribe_la_plantilla() -> dict[str, str]:
    """`VARIABLE -> valor` de cada línea que la plantilla añade a `api.env`."""
    texto = PLATAFORMA.read_text(encoding="utf-8")
    bloque = re.search(r'echo "APP_NAME=.*?\} >> /etc/renaser/api\.env', texto, re.S)
    assert bloque, "no encuentro el bloque que escribe /etc/renaser/api.env"
    return dict(re.findall(r'echo "([A-Z][A-Z0-9_]*)=(.*)"', bloque.group(0)))


@pytest.mark.parametrize("fichero", PERFILES, ids=lambda p: p.stem)
def test_ningun_perfil_enciende_servicios(fichero: Path) -> None:
    """El primer despliegue lleva Servicios apagado, y el piloto se enciende
    después y a mano. La primera versión es virtual y presencial, en soles."""
    perfil = _perfil(fichero)
    assert perfil["FeatureServices"] == "false"
    assert perfil["FeatureServiceBooking"] == "false"
    assert perfil["ServicesPublicAccess"] == "false", (
        "la apertura general de Servicios se decide aparte: no viene encendida en un perfil"
    )
    assert perfil["ServicesCatalogModalities"] == "virtual,in_person"
    assert perfil["ServicesCatalogCurrencies"] == "PEN"


def test_la_plantilla_trae_servicios_apagado_de_fabrica() -> None:
    parametros = _parametros(PLATAFORMA)
    for nombre in ("FeatureServices", "FeatureServiceBooking", "ServicesPublicAccess"):
        assert re.search(r"^    Default: 'false'$", parametros[nombre], re.M), nombre
        assert "AllowedValues: ['true', 'false']" in parametros[nombre], nombre
    assert re.search(r"^    Default: 'virtual,in_person'$", parametros["ServicesCatalogModalities"], re.M)
    assert re.search(r"^    Default: 'PEN'$", parametros["ServicesCatalogCurrencies"], re.M)


def test_la_plantilla_solo_admite_modalidades_y_monedas_bien_escritas() -> None:
    """Un valor con espacios o con una modalidad inventada llegaria a la API
    como una lista que no reconoce: lo para CloudFormation antes."""
    parametros = _parametros(PLATAFORMA)

    def patron(nombre: str) -> re.Pattern[str]:
        return re.compile(re.search(r"AllowedPattern: '(.+)'", parametros[nombre]).group(1))

    modalidades = patron("ServicesCatalogModalities")
    for buena in ("virtual", "virtual,in_person", "virtual,in_person,at_home"):
        assert modalidades.fullmatch(buena), buena
    for mala in ("", "virtual, in_person", "virtual,", "a_domicilio", "VIRTUAL", "virtual;in_person"):
        assert not modalidades.fullmatch(mala), mala
    monedas = patron("ServicesCatalogCurrencies")
    for buena in ("PEN", "PEN,USD"):
        assert monedas.fullmatch(buena), buena
    for mala in ("", "pen", "PEN, USD", "SOLES", "PEN,"):
        assert not monedas.fullmatch(mala), mala


def test_el_entorno_de_la_api_recibe_la_configuracion_de_servicios() -> None:
    entorno = _entorno_que_escribe_la_plantilla()
    for variable, parametro in DE_SERVICIOS.items():
        assert entorno.get(variable) == "${" + parametro + "}", variable
    # EL COBRO, FIJO: sin parametro, y por tanto sin forma de encenderlo en un despliegue.
    for variable, valor in FIJAS_DE_SERVICIOS.items():
        assert entorno.get(variable) == valor, variable
    parametros = _parametros(PLATAFORMA)
    for prohibido in ("FeatureServicePayments", "ServicePaymentsProvider"):
        assert prohibido not in parametros, prohibido


def test_lo_que_fija_la_plantilla_no_puede_venir_tambien_del_secreto() -> None:
    """El secreto se escribe antes y la plantilla después, en el mismo fichero:
    una variable en los dos sitios tendria dos valores. El guion lo rechaza."""
    guion = GUION.read_text(encoding="utf-8")
    lista = re.search(r"\$ClavesQueFijaLaPlantilla = @\((.*?)\)", guion, re.S).group(1)
    en_el_guion = set(re.findall(r"'([A-Z][A-Z0-9_]*)'", lista))
    assert set(_entorno_que_escribe_la_plantilla()) == en_el_guion
    assert "FEATURE_SERVICE_PAYMENTS" in re.search(r"\$BanderasDeDinero = @\((.*?)\)", guion, re.S).group(1)


def test_la_lista_del_piloto_va_en_el_secreto_y_no_en_el_repositorio() -> None:
    """Son identificadores de personas: en un parametro acabarian en los
    perfiles versionados, en las evidencias y en la consola de CloudFormation."""
    assert "ServicesPilot" not in "".join(_parametros(PLATAFORMA))
    assert CLAVE_DEL_PILOTO not in _entorno_que_escribe_la_plantilla()
    for fichero in PERFILES:
        assert "Pilot" not in fichero.read_text(encoding="utf-8"), fichero.name
    ejemplo = json.loads((INFRA / "secretos.ejemplo.json").read_text(encoding="utf-8"))
    assert ejemplo[CLAVE_DEL_PILOTO] == "", "el ejemplo no trae perfiles de nadie: vacia es «no entra nadie»"
    guion = GUION.read_text(encoding="utf-8")
    assert f"$ClaveDelPiloto = '{CLAVE_DEL_PILOTO}'" in guion
    lista = re.search(r"\$ClavesQueFijaLaPlantilla = @\((.*?)\)", guion, re.S).group(1)
    assert CLAVE_DEL_PILOTO not in lista


def test_el_guion_rechaza_una_lista_del_piloto_mal_escrita() -> None:
    """La API cierra el piloto entero si una entrada no es un UUID
    (`services/acceso.py`). El guion lo avisa antes de escribir el secreto."""
    guion = GUION.read_text(encoding="utf-8")
    patron = re.compile(re.search(r"\$PatronDelPiloto = '(.+)'", guion).group(1))
    uno, otro = "0b1f0d9e-6c0a-4a57-9a39-0f6a4c1b2d3e", "9F3C2A10-1B2C-4D5E-8F90-A1B2C3D4E5F6"
    for buena in ("", uno, f"{uno},{otro}"):
        assert patron.search(buena) and patron.fullmatch(buena), buena
    for mala in (" ", f"{uno}, {otro}", f"{uno},", "todos", uno.replace("-", ""), f"{uno};{otro}", f"{uno},no-es-un-uuid"):
        assert not patron.fullmatch(mala), mala
    assert "-notmatch $PatronDelPiloto" in guion
    # Y nunca imprime el valor: el problema solo nombra la clave.
    problema = re.search(r"\$problemas\.Add\(\"\$ClaveDelPiloto[^\n]*", guion).group(0)
    assert "$secreto[" not in problema
