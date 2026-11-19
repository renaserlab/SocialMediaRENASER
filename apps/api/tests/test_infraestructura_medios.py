"""Lo que tiene que seguir siendo verdad en la infraestructura de medios en S3.

POR QUE EXISTE. Los videos nuevos pasan a un bucket privado servido por una
CloudFront propia con URLs firmadas (spec «Zeta · videos en S3 + CloudFront»,
`infra/aws/03-medios.yaml`), y la pila 02 gana permisos, variables y un
planificador para eso. Casi todo lo que se vigila aqui falla EN SILENCIO si
alguien lo deshace: un bucket que se abre, un Origin Shield que se factura, un
hop limit que sube sin que nadie lo decida, un rol que gana S3 sin bucket.

Igual que `test_infraestructura_aws.py`: lee ficheros, sin AWS ni PostgreSQL,
y por texto (el YAML de CloudFormation lleva etiquetas que un lector generico
no entiende).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from tests.test_infraestructura_aws import (
    GUION,
    INFRA,
    PERFILES,
    PLATAFORMA,
    PREFIJO_AJENO,
    _entorno_que_escribe_la_plantilla,
    _parametros,
    _perfil,
    _recurso,
)

MEDIOS = INFRA / "03-medios.yaml"

#: Los parametros nuevos de la pila 02 y el valor que NO cambia nada.
PARAMETROS_DE_MEDIOS = {
    "BucketDeMedios": "",
    "DistribucionDeMedios": "",
    "DominioDeMedios": "",
    "MediosS3Subida": "nadie",
    "MediosS3Lectura": "false",
    "PublicacionesVisibilidad": "abierta",
    "PlanificadorDeMedios": "No",
    "SaltosDeMetadatosDelContenedor": "1",
}

#: Lo que la plantilla escribe en api.env para medios.
ENTORNO_DE_MEDIOS = {
    "MEDIOS_S3_BUCKET": "${BucketDeMedios}",
    "MEDIOS_S3_REGION": "${AWS::Region}",
    "CLOUDFRONT_MEDIOS_DOMINIO": "${DominioDeMedios}",
    "CLOUDFRONT_MEDIOS_DISTRIBUCION_ID": "${DistribucionDeMedios}",
    "MEDIOS_S3_SUBIDA": "${MediosS3Subida}",
    "MEDIOS_S3_LECTURA": "${MediosS3Lectura}",
    "PUBLICACIONES_VISIBILIDAD": "${PublicacionesVisibilidad}",
}

#: Lo que va en el SECRETO y nunca en la plantilla.
DEL_SECRETO = (
    "CLOUDFRONT_MEDIOS_KEY_PAIR_ID",
    "CLOUDFRONT_MEDIOS_PRIVATE_KEY_B64",
    "MEDIOS_S3_SUBIDA_CUENTAS",
    "MEDIOS_TAREAS_TOKEN",
)

RECURSOS_DEL_PLANIFICADOR_DE_MEDIOS = {
    "ConexionDelPlanificadorDeMedios": "AWS::Events::Connection",
    "DestinoDelPlanificadorDeMedios": "AWS::Events::ApiDestination",
    "RolDelPlanificadorDeMedios": "AWS::IAM::Role",
    "ReglaDelPlanificadorDeMedios": "AWS::Events::Rule",
    "AlarmaLimpiezaDeMedios": "AWS::CloudWatch::Alarm",
}

RUTA_DE_LA_LIMPIEZA = "/api/v1/tareas/medios/limpieza"
CABECERA_DE_LA_LIMPIEZA = "X-Medios-Tareas-Token"


def _texto(plantilla: Path) -> str:
    return plantilla.read_text(encoding="utf-8").replace("\r\n", "\n")


def _recurso_de_medios(nombre: str) -> str:
    """El bloque de texto de UN recurso de la pila 03."""
    hallado = re.search(
        rf"^  {nombre}:\n(.*?)(?=^  [A-Za-z0-9]+:\n|^Outputs:)", _texto(MEDIOS), re.S | re.M
    )
    assert hallado, f"03-medios.yaml no tiene el recurso {nombre}"
    return hallado.group(1)


def _sin_comentarios(texto: str) -> str:
    return "\n".join(linea.split(" #", 1)[0] for linea in texto.splitlines() if not linea.lstrip().startswith("#"))


# --------------------------------------------------------------------------- #
# Pila 02: todo apagado de fabrica
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("fichero", PERFILES, ids=lambda p: p.stem)
def test_ningun_perfil_enciende_medios_en_s3(fichero: Path) -> None:
    """Subir a S3, leer de S3 o crear la limpieza es una decision escrita en un
    Change Set, no un valor que viaja en un perfil versionado."""
    perfil = _perfil(fichero)
    for nombre, valor in PARAMETROS_DE_MEDIOS.items():
        assert perfil[nombre] == valor, f"{fichero.name}: {nombre}={perfil[nombre]!r}"


def test_los_parametros_de_medios_nacen_sin_cambiar_nada() -> None:
    parametros = _parametros(PLATAFORMA)
    for nombre, valor in PARAMETROS_DE_MEDIOS.items():
        bloque = parametros[nombre]
        if nombre == "SaltosDeMetadatosDelContenedor":
            assert "Type: Number\n" in bloque and "Default: 1\n" in bloque
            assert "AllowedValues: [1, 2]" in bloque, "un tercer salto ya no es para el contenedor"
        else:
            assert re.search(rf"^    Default: '?{re.escape(valor)}'?$", bloque, re.M), nombre
    assert "AllowedValues: [nadie, lista, todos]" in parametros["MediosS3Subida"]
    assert "AllowedValues: ['true', 'false']" in parametros["MediosS3Lectura"]
    assert "AllowedValues: [abierta, estricta]" in parametros["PublicacionesVisibilidad"]
    assert "AllowedValues: ['Si', 'No']" in parametros["PlanificadorDeMedios"]
    grupo = re.search(r"Label: \{default: Medios en S3 \(apagado de fabrica\)\}\n\s+Parameters: \[(.*?)\]", _texto(PLATAFORMA))
    assert grupo and set(grupo.group(1).split(", ")) == set(PARAMETROS_DE_MEDIOS)


def test_el_salto_de_metadatos_lo_decide_un_parametro_y_sigue_en_1() -> None:
    """Subirlo a 2 deja al contenedor pedir las credenciales del rol entero
    (secreto, SSM, ECR, SignalResource): es una decision pendiente del dueno."""
    texto = _texto(PLATAFORMA)
    assert re.findall(r"HttpPutResponseHopLimit: (.+)", texto) == ["!Ref SaltosDeMetadatosDelContenedor"]
    assert "HttpTokens: required" in texto, "IMDSv2 obligatorio no se negocia"
    for fichero in PERFILES:
        assert _perfil(fichero)["SaltosDeMetadatosDelContenedor"] == "1", fichero.name


def test_la_politica_de_medios_solo_existe_con_bucket() -> None:
    """Sin bucket la lista de politicas del rol queda identica a la de antes."""
    texto = _texto(PLATAFORMA)
    assert "  HayMedios: !Not [!Equals [!Ref BucketDeMedios, '']]\n" in texto
    rol = _recurso("RolDeLasMaquinas")
    politica = re.search(r"- !If\n\s+- HayMedios\n\s+- PolicyName: medios-en-s3\n(.*)", rol, re.S)
    assert politica, "la politica de medios no esta condicionada a HayMedios"
    cuerpo = politica.group(1)
    assert re.search(r"- !Ref 'AWS::NoValue'\n\n?\s+Tags:", cuerpo), "sin bucket tiene que desaparecer (AWS::NoValue)"
    for accion in ("s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"):
        assert f"- {accion}\n" in cuerpo, accion
    assert "Resource: !Sub 'arn:${AWS::Partition}:s3:::${BucketDeMedios}/*'" in cuerpo
    assert "s3:prefix: [videos/, videos/*, borrados/, borrados/*, pendientes/, pendientes/*]" in cuerpo
    assert re.search(
        r"- !If\n\s+- HayDistribucionDeMedios\n\s+- Sid: InvalidarSoloLaDistribucionDeMedios\n"
        r"\s+Effect: Allow\n\s+Action: cloudfront:CreateInvalidation\n"
        r"\s+Resource: !Sub 'arn:\$\{AWS::Partition\}:cloudfront::\$\{AWS::AccountId\}:distribution/\$\{DistribucionDeMedios\}'",
        cuerpo,
    ), "invalidar solo la distribucion de medios, y solo si se dio"
    assert "s3:*" not in _sin_comentarios(cuerpo) and "cloudfront:*" not in cuerpo
    assert "Resource: '*'" not in cuerpo


def test_el_entorno_de_la_api_recibe_la_configuracion_de_medios() -> None:
    entorno = _entorno_que_escribe_la_plantilla()
    for variable, valor in ENTORNO_DE_MEDIOS.items():
        assert entorno.get(variable) == valor, variable
    for variable in DEL_SECRETO:
        assert variable not in entorno, f"{variable} va en el secreto, no en la plantilla"


def test_lo_secreto_de_medios_va_en_el_secreto_y_el_guion_lo_conoce() -> None:
    ejemplo = json.loads((INFRA / "secretos.ejemplo.json").read_text(encoding="utf-8"))
    for clave in DEL_SECRETO:
        assert ejemplo.get(clave) == "", f"el ejemplo trae {clave} vacia"
    guion = GUION.read_text(encoding="utf-8")
    lista = re.search(r"\$ClavesQueFijaLaPlantilla = @\((.*?)\)", guion, re.S).group(1)
    for clave in DEL_SECRETO:
        assert clave not in lista, clave
    for variable in ENTORNO_DE_MEDIOS:
        assert f"'{variable}'" in lista, variable
    # Con la limpieza encendida, el token tiene que estar en el secreto antes
    # de tocar la pila (si no, la referencia dinamica no resuelve).
    assert "if ($Configuracion.PlanificadorDeMedios -eq 'Si') { $necesarias += $ClaveDeLaLimpiezaDeMedios }" in guion
    for nombre in PERFILES:
        assert "TOKEN" not in nombre.read_text(encoding="utf-8").upper()


def test_el_guion_rechaza_una_clave_privada_partida_o_un_token_corto() -> None:
    guion = GUION.read_text(encoding="utf-8")
    firma = re.compile(re.search(r"\$PatronDeLaFirmaDeMedios = '(.+)'", guion).group(1))
    for buena in ("", "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t", "QUJD+/9="):
        assert firma.fullmatch(buena), buena
    for mala in ("-----BEGIN PRIVATE KEY-----", "QUJD\nREVG", "QUJD REVG"):
        assert not firma.fullmatch(mala), mala
    token = re.compile(re.search(r"\$PatronDeLaLimpiezaDeMedios = '(.+)'", guion).group(1))
    assert token.fullmatch("") and token.fullmatch("a" * 32) and not token.fullmatch("a" * 31)
    assert not token.fullmatch("a" * 16 + " " + "a" * 16)


# --------------------------------------------------------------------------- #
# Pila 02: la limpieza diaria
# --------------------------------------------------------------------------- #
def test_la_limpieza_nace_apagada_y_solo_con_frente_https() -> None:
    texto = _texto(PLATAFORMA)
    assert re.search(
        r"HayPlanificadorDeMedios: !And\n    - !Equals \[!Ref PlanificadorDeMedios, 'Si'\]\n"
        r"    - !Condition HayFrenteHttps\n",
        texto,
    )
    for nombre, tipo in RECURSOS_DEL_PLANIFICADOR_DE_MEDIOS.items():
        bloque = _recurso(nombre)
        assert f"Type: {tipo}\n" in bloque, nombre
        assert "Condition: HayPlanificadorDeMedios\n" in bloque, f"{nombre} se crearia siempre"


def test_la_limpieza_llama_a_su_ruta_con_su_cabecera() -> None:
    destino = _recurso("DestinoDelPlanificadorDeMedios")
    assert "HttpMethod: POST\n" in destino
    assert re.findall(r"!Sub 'https://\$\{(?:NombreDeDominio|FrenteHttps\.DomainName)\}(\S+)'", destino) == [
        RUTA_DE_LA_LIMPIEZA, RUTA_DE_LA_LIMPIEZA,
    ]
    assert "http://" not in destino
    conexion = _recurso("ConexionDelPlanificadorDeMedios")
    assert "AuthorizationType: API_KEY\n" in conexion
    assert f"ApiKeyName: {CABECERA_DE_LA_LIMPIEZA}\n" in conexion
    assert (
        "ApiKeyValue: !Sub '{{resolve:secretsmanager:${NombreDelSecreto}:SecretString:MEDIOS_TAREAS_TOKEN}}'\n"
    ) in conexion
    # Rotar el secreto llega a la conexion por el mismo contador que Servicios.
    assert re.search(r"Description: !Sub '.*\$\{VersionDelSecretoDelPlanificador\}.*'\n", conexion)


def test_la_limpieza_corre_una_vez_al_dia_y_reintenta_poco() -> None:
    regla = _recurso("ReglaDelPlanificadorDeMedios")
    assert "ScheduleExpression: cron(0 8 * * ? *)\n" in regla, "03:00 en Lima"
    assert "State: !If [HayMedios, ENABLED, DISABLED]\n" in regla
    assert "Input: '{}'\n" in regla
    assert "RoleArn: !GetAtt RolDelPlanificadorDeMedios.Arn\n" in regla
    intentos = int(re.search(r"MaximumRetryAttempts: (\d+)", regla).group(1))
    assert 1 <= intentos <= 3
    rol = _recurso("RolDelPlanificadorDeMedios")
    assert "aws:SourceAccount: !Ref 'AWS::AccountId'" in rol
    assert re.findall(r"Action: (.+)", rol) == ["sts:AssumeRole", "events:InvokeApiDestination"]
    assert re.findall(r"Resource: (.+)", rol) == ["!GetAtt DestinoDelPlanificadorDeMedios.Arn"]
    assert "*" not in rol and "ManagedPolicyArns" not in rol
    alarma = _recurso("AlarmaLimpiezaDeMedios")
    assert "MetricName: FailedInvocations\n" in alarma
    assert "{Name: RuleName, Value: !Ref ReglaDelPlanificadorDeMedios}" in alarma
    assert "AlarmActions: [!Ref TemaDeAlertas]\n" in alarma
    assert "TreatMissingData: notBreaching\n" in alarma


def test_la_plataforma_no_depende_de_la_pila_de_medios() -> None:
    """La 03 puede no existir (o ser la de prueba): la 02 la recibe por
    parametro, y una exportacion consumida impediria borrar la 03."""
    texto = _texto(PLATAFORMA)
    assert "medios" not in " ".join(re.findall(r"ImportValue[^\n]*\n[^\n]*", texto)).lower()
    assert "Export:" not in _sin_comentarios(_texto(MEDIOS))


# --------------------------------------------------------------------------- #
# Pila 03: el bucket
# --------------------------------------------------------------------------- #
def test_la_pila_de_medios_se_niega_a_otra_cuenta() -> None:
    texto = _texto(MEDIOS)
    assert "Default:" not in _parametros(MEDIOS)["ExpectedAccountId"]
    assert "EsLaCuentaEsperada: !Equals [!Ref ExpectedAccountId, !Ref 'AWS::AccountId']" in texto
    assert re.search(
        r"BarreraExpectedAccountId:\n\s+Type: AWS::CloudFormation::WaitConditionHandle\n"
        r"\s+Condition: EsLaCuentaEsperada",
        texto,
    )
    for raiz in ("BucketDeMedios", "BucketDeRegistros", "ControlDeAccesoAlOrigen"):
        assert "DependsOn: BarreraExpectedAccountId\n" in _recurso_de_medios(raiz), raiz


def test_la_pila_de_medios_no_lleva_la_cuenta_ni_el_prefijo_ajeno() -> None:
    texto = _texto(MEDIOS)
    assert not re.search(r"(?<![\w.-])\d{12}(?![\w-])", texto), "la cuenta sale de AWS::AccountId"
    prefijo = _parametros(MEDIOS)["PrefijoDeRecursos"]
    assert f"Default: {PREFIJO_AJENO}\n" not in prefijo and "{1,16}" in prefijo
    assert "Default:" not in _parametros(MEDIOS)["Variante"], "produccion o prueba se dice, no se supone"
    bucket = _recurso_de_medios("BucketDeMedios")
    assert "BucketName: !Sub '${PrefijoDeRecursos}-medios-${Variante}-${AWS::AccountId}'" in bucket


def test_el_bucket_de_medios_es_privado_y_sin_acl() -> None:
    bucket = _recurso_de_medios("BucketDeMedios")
    for bloqueo in ("BlockPublicAcls", "BlockPublicPolicy", "IgnorePublicAcls", "RestrictPublicBuckets"):
        assert f"{bloqueo}: true\n" in bucket, bloqueo
    assert "ObjectOwnership: BucketOwnerEnforced" in bucket
    assert "SSEAlgorithm: AES256" in bucket
    assert "VersioningConfiguration" not in bucket, "el borrado tiene que ser real"
    assert "DeletionPolicy: Retain\n" in bucket


def test_el_bucket_solo_deja_subir_desde_la_web_y_localhost_solo_en_prueba() -> None:
    bucket = _recurso_de_medios("BucketDeMedios")
    assert "AllowedMethods: [PUT, POST]\n" in bucket
    assert "AllowedHeaders: [Content-Type, Content-MD5, 'x-amz-*']\n" in bucket
    assert "ExposedHeaders: [ETag]\n" in bucket
    assert re.search(
        r"AllowedOrigins: !If\n\s+- EsPrueba\n(?:\s+#.*\n)*\s+- \[!Ref OrigenDeLaWeb, 'http://localhost:8081'\]\n"
        r"\s+- \[!Ref OrigenDeLaWeb\]\n",
        bucket,
    ), "localhost solo en la variante de prueba"
    assert "Default: https://social-media-renaser.vercel.app\n" in _parametros(MEDIOS)["OrigenDeLaWeb"]


def test_el_ciclo_de_vida_respeta_las_denuncias() -> None:
    bucket = _sin_comentarios(_recurso_de_medios("BucketDeMedios"))
    assert re.search(r"Prefix: pendientes/\n\s+ExpirationInDays: 1\n", bucket)
    assert "AbortIncompleteMultipartUpload: {DaysAfterInitiation: 1}" in bucket
    assert bucket.count("ExpirationInDays") == 1, "videos/ y borrados/ no caducan solos (borrados/ lo borra la API)"
    assert "borrados" not in bucket and "videos/" not in bucket


def test_solo_cloudfront_de_medios_lee_y_solo_videos() -> None:
    politica = _recurso_de_medios("PoliticaDelBucketDeMedios")
    lectura = re.search(r"Sid: SoloCloudFrontDeMediosLeeVideos\n(.*?)\n\s+- Sid:", politica, re.S).group(1)
    assert "Principal: {Service: cloudfront.amazonaws.com}" in lectura
    assert "Action: s3:GetObject\n" in lectura
    assert "Resource: !Sub '${BucketDeMedios.Arn}/videos/*'" in lectura
    assert (
        "AWS:SourceArn: !Sub 'arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${DistribucionDeMedios}'"
        in lectura
    )
    assert re.search(r"Sid: NadaSinTls\n\s+Effect: Deny\n", politica)
    assert "Bool: {'aws:SecureTransport': 'false'}" in politica
    assert politica.count("Effect: Allow") == 1, "nadie mas que CloudFront tiene un Allow en el bucket"


# --------------------------------------------------------------------------- #
# Pila 03: la distribucion
# --------------------------------------------------------------------------- #
def test_la_distribucion_lee_con_oac_y_sin_origin_shield() -> None:
    oac = _recurso_de_medios("ControlDeAccesoAlOrigen")
    assert "Type: AWS::CloudFront::OriginAccessControl\n" in oac
    assert "OriginAccessControlOriginType: s3\n" in oac
    assert "SigningBehavior: always\n" in oac and "SigningProtocol: sigv4\n" in oac
    dist = _sin_comentarios(_recurso_de_medios("DistribucionDeMedios"))
    assert "OriginAccessControlId: !GetAtt ControlDeAccesoAlOrigen.Id" in dist
    assert "DomainName: !GetAtt BucketDeMedios.RegionalDomainName" in dist
    assert "OriginAccessIdentity: ''" in dist, "sin OAI heredado"
    assert re.search(r"OriginShield:\n\s+Enabled: false\n", dist), "Origin Shield apagado"
    assert "Enabled: true" not in dist.split("OriginShield:", 1)[1].split("CacheBehaviors:", 1)[0]
    assert "PriceClass: PriceClass_All\n" in dist, "la unica clase con nodos en Sudamerica"
    assert "HttpVersion: http2and3\n" in dist


def test_videos_solo_con_firma_y_con_las_politicas_administradas() -> None:
    dist = _sin_comentarios(_recurso_de_medios("DistribucionDeMedios"))
    videos = re.search(r"- PathPattern: videos/\*\n(.*?)\n\s+DefaultCacheBehavior:", dist, re.S).group(1)
    assert "ViewerProtocolPolicy: https-only" in videos
    assert "AllowedMethods: [GET, HEAD]" in videos
    assert "TrustedKeyGroups: [!Ref GrupoDeClaves]" in videos
    assert "CachePolicyId: 658327ea-f89d-4fab-a63d-7e88639e58f6" in videos, "CachingOptimized"
    assert "ResponseHeadersPolicyId: 60669652-455b-4ae9-85a4-c4c02393f86c" in videos, "SimpleCORS"
    defecto = dist.split("DefaultCacheBehavior:", 1)[1]
    assert "TrustedKeyGroups: [!Ref GrupoDeClaves]" in defecto, "la raiz y lo demas responden 403"
    assert "ViewerProtocolPolicy: https-only" in defecto


def test_el_grupo_de_claves_solo_lleva_claves_publicas() -> None:
    texto = _texto(MEDIOS)
    grupo = _recurso_de_medios("GrupoDeClaves")
    assert "Type: AWS::CloudFront::KeyGroup\n" in grupo
    assert "- !If [HayClaveA, !Ref ClavePublicaDeFirmaA, !Ref 'AWS::NoValue']" in grupo
    assert "- !If [HayClaveB, !Ref ClavePublicaDeFirmaB, !Ref 'AWS::NoValue']" in grupo
    assert "DependsOn: BarreraAlMenosUnaClave\n" in grupo
    for hueco in ("A", "B"):
        clave = _recurso_de_medios(f"ClavePublicaDeFirma{hueco}")
        assert "Type: AWS::CloudFront::PublicKey\n" in clave
        assert f"Condition: HayClave{hueco}\n" in clave
        assert f"EncodedKey: !Ref ClavePublica{hueco}\n" in clave
        assert "BEGIN PUBLIC KEY" in _parametros(MEDIOS)[f"ClavePublica{hueco}"]
    assert "PRIVATE KEY" not in texto, "la clave privada nunca pasa por CloudFormation"
    assert not [n for n in _parametros(MEDIOS) if "Privada" in n]


def test_los_registros_v2_van_a_un_bucket_propio_por_30_dias() -> None:
    fuente = _recurso_de_medios("FuenteDeRegistros")
    assert "Type: AWS::Logs::DeliverySource\n" in fuente and "LogType: ACCESS_LOGS\n" in fuente
    assert "distribution/${DistribucionDeMedios}'" in fuente
    destino = _recurso_de_medios("DestinoDeRegistros")
    assert "Type: AWS::Logs::DeliveryDestination\n" in destino
    assert "DestinationResourceArn: !GetAtt BucketDeRegistros.Arn\n" in destino
    entrega = _recurso_de_medios("EntregaDeRegistros")
    assert "Type: AWS::Logs::Delivery\n" in entrega
    assert "DeliverySourceName: !Ref FuenteDeRegistros" in entrega
    assert "DeliveryDestinationArn: !GetAtt DestinoDeRegistros.Arn" in entrega
    bucket = _recurso_de_medios("BucketDeRegistros")
    assert "'${PrefijoDeRecursos}-medios-logs-${AWS::AccountId}'" in bucket
    assert "'${PrefijoDeRecursos}-medios-logs-prueba-${AWS::AccountId}'" in bucket
    for bloqueo in ("BlockPublicAcls", "BlockPublicPolicy", "IgnorePublicAcls", "RestrictPublicBuckets"):
        assert f"{bloqueo}: true\n" in bucket, bloqueo
    assert "ObjectOwnership: BucketOwnerEnforced" in bucket and "SSEAlgorithm: AES256" in bucket
    assert "ExpirationInDays: 30\n" in bucket
    politica = _recurso_de_medios("PoliticaDelBucketDeRegistros")
    assert "Principal: {Service: delivery.logs.amazonaws.com}" in politica
    assert "aws:SourceAccount: !Ref 'AWS::AccountId'" in politica
    assert ":delivery-source:${PrefijoDeRecursos}-medios-${Variante}'" in politica
    assert politica.count("Effect: Allow") == 1, "los registros llevan URLs firmadas: nadie mas los lee"
    assert re.search(r"Action: s3:PutObject\n", politica) and "s3:GetObject" not in politica


def test_las_salidas_dan_lo_que_la_pila_02_y_la_api_necesitan() -> None:
    salidas = _texto(MEDIOS).split("\nOutputs:\n", 1)[1]
    for nombre in (
        "NombreDelBucket", "ArnDelBucket", "IdDeLaDistribucion", "DominioDeLaDistribucion",
        "ArnDeLaDistribucion", "IdDelGrupoDeClaves", "IdDeLaClavePublicaA", "IdDeLaClavePublicaB",
    ):
        assert re.search(rf"^  {nombre}:\n", salidas, re.M), nombre
