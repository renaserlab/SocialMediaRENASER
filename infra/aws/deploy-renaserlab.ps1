#Requires -Version 7.2
<#
.SYNOPSIS
    Crea, actualiza, verifica y opera la API de Z Excelencia en la cuenta AWS
    de RenaserLab.

.DESCRIPTION
    CloudFormation es la fuente de verdad de la infraestructura; este guion
    solo orquesta. Cada accion empieza comprobando que la sesion es de la
    cuenta esperada y se detiene antes de cualquier cambio si no lo es.

    Nada cambia sin ensenar antes el plan: la infraestructura se aplica con
    conjuntos de cambios de CloudFormation, que se muestran y se confirman
    (o se descartan con -WhatIf). Los reemplazos de recursos persistentes se
    bloquean salvo -PermitirReemplazos.

    NO cambia el trafico de produccion, NO toca la cuenta anterior y NO
    modifica las variables de GitHub: -Accion PrepararCorte deja escrito que
    habria que cambiar, y cambiarlo es una decision de una persona.

    Acciones:
      Verificar      Prerrequisitos, cuenta, plantillas, parametros y colisiones. Solo lee.
      Planificar     Verificar + el plan de las dos pilas, que se descarta. No crea nada.
      Fundacion      Crea o actualiza la pila de fundacion (ECR, OIDC, rol de GitHub, bucket).
      Secretos       Carga el secreto de la API desde un fichero local.
      Imagen         Construye la imagen de un commit y la publica en ECR con etiqueta sha-<commit>.
      Plataforma     Crea o actualiza la pila de plataforma (red, balanceador, maquinas, CloudFront).
      Salud          Comprueba la API por su URL publica, la base, las maquinas y las alertas.
      Estado         Resume pilas, salidas, version desplegada y alertas. Solo lee.
      Renovar        Renueva las maquinas con la version actual (tras cambiar el secreto).
      VolverAtras    Devuelve la API a una imagen anterior y renueva las maquinas.
      PrepararCorte  Compara la API nueva con la de produccion y escribe el plan de corte. Solo lee.
      Todo           Verificar, Fundacion, Secretos (si hay fichero), Imagen, Plataforma y Salud.

.EXAMPLE
    $env:RENASERLAB_AWS_ACCOUNT_ID = '<doce digitos>'
    ./infra/aws/deploy-renaserlab.ps1 -Accion Planificar

.EXAMPLE
    ./infra/aws/deploy-renaserlab.ps1 -Accion Todo -ArchivoDeSecretos C:\seguro\zexcelencia.json

.EXAMPLE
    ./infra/aws/deploy-renaserlab.ps1 -Accion VolverAtras -EtiquetaDeImagen sha-c45bf93
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [ValidateSet('Verificar', 'Planificar', 'Fundacion', 'Secretos', 'Imagen', 'Plataforma',
        'Salud', 'Estado', 'Renovar', 'VolverAtras', 'PrepararCorte', 'Todo')]
    [string] $Accion = 'Verificar',

    [ValidateSet('costo-controlado', 'alta-disponibilidad')]
    [string] $Perfil = 'costo-controlado',

    # La barrera. Sin valor no se toca nada.
    [string] $ExpectedAccountId = $env:RENASERLAB_AWS_ACCOUNT_ID,

    [ValidatePattern('^[a-z]{2}-[a-z]+-\d$')]
    [string] $Region = 'us-east-1',

    # Commit que se construye. Por defecto, lo que hay en produccion hoy.
    [string] $Revision = 'origin/main',

    # Fichero JSON plano con las claves de la API. Nunca dentro del repositorio.
    [string] $ArchivoDeSecretos,

    [ValidatePattern('^(sha-[0-9a-f]{7,40})?$')]
    [string] $EtiquetaDeImagen,

    [string] $CorreoDeAlertas,

    [ValidatePattern('^[A-Za-z0-9 ._-]{1,64}$')]
    [string] $Propietario = 'RenaserLab',

    [ValidatePattern('^([A-Za-z0-9 ._-]{1,64})?$')]
    [string] $CentroDeCosto,

    # Ruta publica que consulta la base: /health solo dice que el proceso vive.
    [string] $RutaQueConsultaLaBase = '/api/v1/profiles/featured',

    [string] $DirectorioDeEvidencias = (Join-Path $PSScriptRoot 'evidencias'),

    # Deja pasar un plan que reemplaza o borra un recurso persistente.
    [switch] $PermitirReemplazos,

    # Deja cargar un secreto con una bandera de dinero encendida.
    [switch] $PermitirBanderasFinancieras,

    # Con -Accion Secretos: genera un secreto NUEVO para el planificador de Z
    # Servicios aunque ya haya uno. Despues hay que renovar las maquinas y
    # desplegar con VersionDelSecretoDelPlanificador subido en uno.
    [switch] $RotarSecretoDelPlanificador
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$ProgressPreference = 'SilentlyContinue'
$env:AWS_PAGER = ''

# =============================================================================
# Constantes
# =============================================================================

$Raiz = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
$PlantillaDeFundacion = Join-Path $PSScriptRoot '01-fundacion.yaml'
$PlantillaDePlataforma = Join-Path $PSScriptRoot '02-plataforma.yaml'
$FicheroDePerfil = Join-Path $PSScriptRoot 'parametros' "$Perfil.json"

# CloudFormation no acepta plantillas mas grandes en linea.
$LimiteEnLinea = 51200

# Lo que el guion inyecta y por tanto no esta en los ficheros de perfil.
$ParametrosInyectados = @('ExpectedAccountId', 'EtiquetaDeImagen')

# Lo unico que se queda con el valor de la plantilla a proposito: el AMI es un
# puntero publico de AWS a la ultima Amazon Linux 2023. Todo lo demas lo fija el
# perfil, porque un valor por defecto que nadie decidio puede ser destructivo
# (sin FrenteHttpsDeEmergencia, la plantilla borra la distribucion y su URL).
$ParametrosPorDefectoAProposito = @('AmiDeAmazonLinux2023')

$ClavesObligatorias = @('DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_JWT_SECRET')
$ClaveDeCabecera = 'CLOUDFRONT_ORIGIN_SECRET'

# Las fija la plantilla en /etc/renaser/api.env DESPUES del secreto. Si
# tambien vinieran en el secreto habria dos valores y ganaria uno sin que
# nadie lo decida.
$ClavesQueFijaLaPlantilla = @('APP_NAME', 'ENVIRONMENT', 'PORT', 'CORS_ORIGINS',
    'SUPABASE_JWT_ALGORITHM', 'SUPABASE_JWT_AUDIENCE', 'FEATURE_RECOMMENDATIONS_V1',
    'PAYMENTS_ENABLED', 'PAYMENTS_RETURN_URL', 'BETA_FREE_ACCESS_ENABLED',
    'FEATURE_SERVICES', 'FEATURE_SERVICE_BOOKING', 'FEATURE_SERVICE_PAYMENTS',
    'SERVICE_PAYMENTS_PROVIDER', 'SERVICES_PUBLIC_ACCESS', 'SERVICES_CATALOG_MODALITIES',
    'SERVICES_CATALOG_CURRENCIES', 'SERVICES_CATALOG_PRICE_MODELS',
    'MEDIOS_S3_BUCKET', 'MEDIOS_S3_REGION', 'CLOUDFRONT_MEDIOS_DOMINIO',
    'CLOUDFRONT_MEDIOS_DISTRIBUCION_ID', 'MEDIOS_S3_SUBIDA', 'MEDIOS_S3_LECTURA',
    'PUBLICACIONES_VISIBILIDAD')

# El piloto de Z Servicios: los perfiles autorizados. Va en el secreto y no en
# un parametro porque son identificadores de personas: un parametro acabaria en
# los perfiles del repositorio, en las evidencias y en la consola. Vacia = no
# entra nadie. Aqui solo se comprueba su FORMA; nunca se imprime su valor.
$ClaveDelPiloto = 'SERVICES_PILOT_PROFILE_IDS'
$PatronDelPiloto = '^$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(,[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})*$'

# El secreto del planificador de Z Servicios: la cabecera con la que la regla
# de EventBridge llama a los barridos. Igual que la cabecera de origen, no lo
# escribe nadie a mano: se conserva el que hay o se genera uno. Nunca se imprime.
$ClaveDelPlanificador = 'SERVICES_TASKS_TOKEN'
$PatronDelPlanificador = '^[0-9a-f]{32,128}$'

# Medios en S3: lo que NO puede ir en la plantilla. La clave privada de firma
# va en base64 de UNA linea (una PEM tiene saltos de linea y el arranque
# convierte el secreto linea a linea); la lista interna son uid de personas; el
# token es la credencial de la limpieza diaria (la API exige 32 caracteres o
# mas). Aqui solo se comprueba su FORMA; nunca se imprime su valor.
$ClaveDeLaLimpiezaDeMedios = 'MEDIOS_TAREAS_TOKEN'
$PatronDeLaLimpiezaDeMedios = '^$|^[A-Za-z0-9._~-]{32,256}$'
$ClaveDeLaFirmaDeMedios = 'CLOUDFRONT_MEDIOS_PRIVATE_KEY_B64'
$PatronDeLaFirmaDeMedios = '^$|^[A-Za-z0-9+/]+={0,2}$'
$ClaveDeLaListaDeMedios = 'MEDIOS_S3_SUBIDA_CUENTAS'

# Lo que mueve dinero nace apagado y se enciende a mano, en otra decision.
$BanderasDeDinero = @('PAYMENTS_ENABLED', 'STRIPE_PAYMENTS_ENABLED', 'STRIPE_REFUNDS_ENABLED',
    'STRIPE_CONNECT_ENABLED', 'CREATOR_TRANSFERS_ENABLED', 'FEATURE_COURSE_REFUNDS',
    'FEATURE_PRODUCT_SALES', 'FEATURE_EVENT_PAYMENTS', 'REVENUECAT_VERIFICATION_ENABLED',
    'REVENUECAT_WEBHOOK_ENABLED', 'BETA_FREE_ACCESS_ENABLED', 'FEATURE_SERVICE_PAYMENTS')

# Estados en los que una pila existe y tiene salidas que leer.
$EstadosConPila = @('CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE',
    'IMPORT_COMPLETE', 'IMPORT_ROLLBACK_COMPLETE', 'UPDATE_IN_PROGRESS',
    'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS', 'UPDATE_ROLLBACK_IN_PROGRESS',
    'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS')

# Reemplazarlos o borrarlos pierde datos, historial o la URL publica.
$TiposPersistentes = @('AWS::ECR::Repository', 'AWS::S3::Bucket', 'AWS::Logs::LogGroup',
    'AWS::CloudFront::Distribution', 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    'AWS::SSM::Parameter', 'AWS::IAM::OIDCProvider', 'AWS::EC2::VPC')

$Evidencia = [ordered]@{
    accion   = $Accion
    perfil   = $Perfil
    region   = $Region
    inicio   = (Get-Date).ToString('o')
    avisos   = [System.Collections.Generic.List[string]]::new()
    pasos    = [ordered]@{}
}

# =============================================================================
# Salida por consola
# =============================================================================

function Write-Paso([string] $Texto) { Write-Host "`n==> $Texto" -ForegroundColor Cyan }
function Write-Bien([string] $Texto) { Write-Host "    [ok] $Texto" -ForegroundColor Green }
function Write-Dato([string] $Texto) { Write-Host "    $Texto" }

function Write-Aviso([string] $Texto) {
    Write-Host "    [!] $Texto" -ForegroundColor Yellow
    $script:Evidencia.avisos.Add($Texto)
}

# =============================================================================
# Utilidades
# =============================================================================

function Get-Valor($Objeto, [string] $Nombre) {
    # Leer una propiedad que puede no existir sin romper el modo estricto.
    if ($null -eq $Objeto) { return $null }
    if ($Objeto -is [System.Collections.IDictionary]) {
        if ($Objeto.Contains($Nombre)) { return $Objeto[$Nombre] }
        return $null
    }
    $propiedad = $Objeto.PSObject.Properties[$Nombre]
    if ($null -eq $propiedad) { return $null }
    return $propiedad.Value
}

function Invoke-Aws {
    # Ejecuta la CLI de AWS y devuelve el JSON ya interpretado. Si falla, lanza
    # con el mensaje de AWS, salvo -PermitirFallo, que devuelve $null.
    param(
        [Parameter(Mandatory, Position = 0)] [string[]] $Argumentos,
        [switch] $PermitirFallo,
        [switch] $Texto
    )
    $salida = & aws @Argumentos --region $Region --output json 2>&1
    $codigo = $LASTEXITCODE
    $errores = @($salida | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } |
            ForEach-Object { $_.ToString() })
    $normal = (@($salida | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n").Trim()
    if ($codigo -ne 0) {
        if ($PermitirFallo) { return $null }
        throw "aws $($Argumentos[0]) $($Argumentos[1]) fallo (codigo $codigo): $($errores -join ' ')"
    }
    if ([string]::IsNullOrWhiteSpace($normal)) { return $null }
    if ($Texto) { return $normal }
    return $normal | ConvertFrom-Json -Depth 64
}

function Invoke-Nativo {
    # Para git, docker y tar: la salida va a la consola y un codigo distinto de
    # cero para el guion.
    param([Parameter(Mandatory)] [string] $Programa, [Parameter(Mandatory)] [string[]] $Argumentos)
    & $Programa @Argumentos | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "$Programa $($Argumentos[0]) fallo (codigo $LASTEXITCODE)." }
}

function Get-TextoDeGit([string[]] $Argumentos) {
    $salida = & git -C $Raiz @Argumentos 2>$null
    if ($LASTEXITCODE -ne 0) { throw "git $($Argumentos -join ' ') fallo." }
    return ($salida -join "`n").Trim()
}

function Write-FicheroTemporal([string] $Contenido) {
    $ruta = [System.IO.Path]::GetTempFileName()
    Set-Content -LiteralPath $ruta -Value $Contenido -Encoding utf8NoBOM -NoNewline -WhatIf:$false -Confirm:$false
    return $ruta
}

function Invoke-AwsConEntrada([string[]] $Operacion, $Entrada, [switch] $PermitirFallo) {
    # JSON por fichero y no por argumentos: en Windows, pasar JSON a un
    # ejecutable nativo por la linea de comandos rompe las comillas.
    $fichero = Write-FicheroTemporal (ConvertTo-Json -InputObject $Entrada -Depth 20)
    try {
        return Invoke-Aws ($Operacion + @('--cli-input-json', "file://$fichero")) -PermitirFallo:$PermitirFallo
    }
    finally {
        Remove-Item -LiteralPath $fichero -Force -ErrorAction SilentlyContinue -WhatIf:$false -Confirm:$false
    }
}

function Get-EtiquetasDeLaPila([System.Collections.IDictionary] $Configuracion) {
    $etiquetas = @(
        @{ Key = 'Proyecto'; Value = $Configuracion.Proyecto }
        @{ Key = 'Entorno'; Value = $Configuracion.Entorno }
        @{ Key = 'Propietario'; Value = $Propietario }
        @{ Key = 'Gestionado-por'; Value = 'CloudFormation' }
    )
    if ($CentroDeCosto) { $etiquetas += @{ Key = 'CentroDeCosto'; Value = $CentroDeCosto } }
    return , $etiquetas
}

# =============================================================================
# Barrera de cuenta y prerrequisitos
# =============================================================================

function Assert-CuentaEsperada {
    # Va SIEMPRE lo primero, antes de cualquier llamada que cambie algo.
    if ($ExpectedAccountId -notmatch '^\d{12}$') {
        throw ('Falta la cuenta esperada: pasa -ExpectedAccountId o define ' +
            '$env:RENASERLAB_AWS_ACCOUNT_ID con sus 12 digitos. Sin ella no se toca nada.')
    }
    $identidad = Invoke-Aws @('sts', 'get-caller-identity')
    if ($identidad.Account -ne $ExpectedAccountId) {
        throw ("ALTO: la sesion es de la cuenta $($identidad.Account) y se esperaba " +
            "$ExpectedAccountId. No se ha tocado nada.")
    }
    $script:Evidencia.cuenta = $identidad.Account
    $script:Evidencia.operador = $identidad.Arn
    Write-Bien "Cuenta $($identidad.Account) como $($identidad.Arn)"
}

function Test-Prerrequisitos([switch] $ConDocker) {
    Write-Paso 'Prerrequisitos'
    Write-Bien "PowerShell $($PSVersionTable.PSVersion)"

    $versionDeAws = (& aws --version 2>&1) -join ' '
    if ($LASTEXITCODE -ne 0 -or $versionDeAws -notmatch 'aws-cli/2\.') {
        throw "Hace falta la CLI de AWS v2 (encontrada: '$versionDeAws')."
    }
    Write-Bien $versionDeAws.Split(' ')[0]

    $null = Get-TextoDeGit @('rev-parse', '--git-dir')
    Write-Bien "git en $Raiz"

    if ($ConDocker) {
        & docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Docker no responde: arranca Docker Desktop.' }
        Write-Bien 'Docker en marcha'
    }
}

function Get-CfnLint {
    foreach ($candidato in @(
            (Join-Path $Raiz 'apps' 'api' '.venv' 'Scripts' 'cfn-lint.exe'),
            (Join-Path $Raiz 'apps' 'api' '.venv' 'bin' 'cfn-lint'))) {
        if (Test-Path -LiteralPath $candidato) { return $candidato }
    }
    $enRuta = Get-Command cfn-lint -ErrorAction SilentlyContinue
    if ($enRuta) { return $enRuta.Source }
    return $null
}

# =============================================================================
# Perfil y plantillas
# =============================================================================

function Read-Perfil {
    $lista = Get-Content -Raw -LiteralPath $FicheroDePerfil | ConvertFrom-Json
    $configuracion = [ordered]@{}
    foreach ($elemento in $lista) { $configuracion[$elemento.ParameterKey] = [string] $elemento.ParameterValue }
    foreach ($clave in 'PerfilDeCapacidad', 'Proyecto', 'PrefijoDeRecursos', 'PilaDeFundacion', 'Entorno', 'NombreDelSecreto') {
        if (-not $configuracion.Contains($clave)) { throw "El perfil $Perfil no define $clave." }
    }
    if ($configuracion.PerfilDeCapacidad -ne $Perfil) {
        throw "El fichero $Perfil.json dice PerfilDeCapacidad=$($configuracion.PerfilDeCapacidad)."
    }
    if ($configuracion.PrefijoDeRecursos -eq 'renaser') {
        throw ('El prefijo `renaser` es de otros productos de esta cuenta: el rol de despliegue ' +
            'alcanzaria sus parametros. Usa el de Z Excelencia.')
    }
    return $configuracion
}

function Get-NombreDePlataforma([System.Collections.IDictionary] $Configuracion) {
    # Tiene que empezar por el prefijo: el rol de GitHub solo lee pilas asi.
    return "$($Configuracion.PrefijoDeRecursos)-plataforma-$($Configuracion.Entorno)"
}

function Get-ParametrosDePlantilla([string] $Ruta) {
    # Nombre -> si tiene valor por defecto. Lectura de texto: el YAML de
    # CloudFormation lleva etiquetas (!Ref) que un lector generico no entiende.
    $resultado = [ordered]@{}
    $dentro = $false
    $actual = $null
    foreach ($linea in Get-Content -LiteralPath $Ruta) {
        if ($linea -match '^Parameters:\s*$') { $dentro = $true; continue }
        if (-not $dentro) { continue }
        if ($linea -match '^[A-Za-z]') { break }
        if ($linea -match '^  ([A-Za-z0-9]+):\s*$') { $actual = $Matches[1]; $resultado[$actual] = $false; continue }
        if ($actual -and $linea -match '^    Default:') { $resultado[$actual] = $true }
    }
    return $resultado
}

function Test-ParidadDelPerfil([System.Collections.IDictionary] $Configuracion) {
    $plantilla = Get-ParametrosDePlantilla $PlantillaDePlataforma
    $sobran = @($Configuracion.Keys | Where-Object { -not $plantilla.Contains($_) })
    $faltan = @($plantilla.Keys | Where-Object {
            -not $Configuracion.Contains($_) -and $_ -notin $ParametrosInyectados -and $_ -notin $ParametrosPorDefectoAProposito })
    if ($sobran) { throw "El perfil trae parametros que la plantilla no tiene: $($sobran -join ', ')" }
    if ($faltan) { throw "El perfil no fija estos parametros (se aplicaria su valor por defecto): $($faltan -join ', ')" }
    foreach ($bandera in 'PaymentsEnabled', 'BetaFreeAccessEnabled', 'FeatureServices',
        'FeatureServiceBooking', 'ServicesPublicAccess') {
        if ($Configuracion[$bandera] -ne 'false') {
            Write-Aviso "$bandera vale '$($Configuracion[$bandera])' en el perfil: se desplegaria encendido."
        }
    }
    Write-Bien "Perfil $Perfil coherente con la plantilla ($($Configuracion.Count) parametros)"
}

function Get-Pila([string] $Nombre) {
    $respuesta = Invoke-Aws @('cloudformation', 'describe-stacks', '--stack-name', $Nombre) -PermitirFallo
    if ($null -eq $respuesta) { return $null }
    return $respuesta.Stacks[0]
}

function Test-PilaUtilizable($Pila) {
    # Existe de verdad y tiene salidas. Una pila vacia de un plan
    # (REVIEW_IN_PROGRESS), una que se esta borrando o una que fallo al crearse
    # no cuentan: tratarlas como existentes llevaba a pedirles salidas que no
    # tienen.
    return $null -ne $Pila -and $Pila.StackStatus -in $EstadosConPila
}

function Get-Salidas($Pila) {
    $salidas = @{}
    foreach ($salida in @(Get-Valor $Pila 'Outputs')) {
        if ($null -ne $salida) { $salidas[$salida.OutputKey] = $salida.OutputValue }
    }
    return $salidas
}

function Get-OrigenDePlantilla([string] $Ruta, [string] $Bucket, [string] $Nombre) {
    # Las pequenas van en linea; las grandes se suben al bucket de plantillas.
    $tamano = (Get-Item -LiteralPath $Ruta).Length
    if ($tamano -le $LimiteEnLinea) {
        return @{ TemplateBody = (Get-Content -Raw -LiteralPath $Ruta) }
    }
    if (-not $Bucket) {
        throw ("$Nombre pesa $tamano bytes y CloudFormation solo acepta $LimiteEnLinea en linea. " +
            'Hace falta el bucket de plantillas de la pila de fundacion: despliegala primero.')
    }
    $huella = (Get-FileHash -LiteralPath $Ruta -Algorithm SHA256).Hash.ToLowerInvariant().Substring(0, 16)
    $clave = "plantillas/$Nombre/$huella.yaml"
    Invoke-Aws @('s3', 'cp', $Ruta, "s3://$Bucket/$clave", '--only-show-errors') | Out-Null
    return @{ TemplateURL = "https://$Bucket.s3.$Region.amazonaws.com/$clave" }
}

function Test-Plantilla([hashtable] $Origen, [string] $Nombre) {
    if ($Origen.ContainsKey('TemplateURL')) {
        Invoke-Aws @('cloudformation', 'validate-template', '--template-url', $Origen.TemplateURL) | Out-Null
    }
    else {
        $fichero = Write-FicheroTemporal $Origen.TemplateBody
        try {
            Invoke-Aws @('cloudformation', 'validate-template', '--template-body', "file://$fichero") | Out-Null
        }
        finally { Remove-Item -LiteralPath $fichero -Force -ErrorAction SilentlyContinue -WhatIf:$false -Confirm:$false }
    }
    Write-Bien "$Nombre valida para CloudFormation"
}

# =============================================================================
# Conjuntos de cambios: planificar, ensenar, aplicar o descartar
# =============================================================================

function New-ConjuntoDeCambios {
    param(
        [string] $Pila, [hashtable] $Origen, [object[]] $Parametros,
        [string[]] $Capacidades, [object[]] $Etiquetas
    )
    $existente = Get-Pila $Pila
    if ($existente -and $existente.StackStatus -eq 'ROLLBACK_COMPLETE') {
        throw ("La pila $Pila quedo en ROLLBACK_COMPLETE (fallo al crearse) y no se puede actualizar. " +
            'Revisa sus eventos y borrala a mano antes de volver a intentarlo.')
    }
    if ($existente -and $existente.StackStatus -match '_IN_PROGRESS$' -and $existente.StackStatus -ne 'REVIEW_IN_PROGRESS') {
        throw "La pila $Pila esta en $($existente.StackStatus): espera a que termine."
    }
    $tipo = if (Test-PilaUtilizable $existente) { 'UPDATE' } else { 'CREATE' }
    $nombre = 'plan-' + (Get-Date -Format 'yyyyMMdd-HHmmss')

    $entrada = [ordered]@{
        StackName     = $Pila
        ChangeSetName = $nombre
        ChangeSetType = $tipo
        Parameters    = $Parametros
        Capabilities  = $Capacidades
        Tags          = $Etiquetas
        Description   = "deploy-renaserlab.ps1 $Accion"
    }
    foreach ($clave in $Origen.Keys) { $entrada[$clave] = $Origen[$clave] }
    Invoke-AwsConEntrada @('cloudformation', 'create-change-set') $entrada | Out-Null

    $limite = (Get-Date).AddMinutes(10)
    do {
        Start-Sleep -Seconds 5
        $conjunto = Invoke-Aws @('cloudformation', 'describe-change-set', '--stack-name', $Pila, '--change-set-name', $nombre)
    } while ($conjunto.Status -in 'CREATE_PENDING', 'CREATE_IN_PROGRESS' -and (Get-Date) -lt $limite)

    $sinCambios = $conjunto.Status -eq 'FAILED' -and
        [string](Get-Valor $conjunto 'StatusReason') -match "didn't contain changes|No updates are to be performed"
    if ($conjunto.Status -ne 'CREATE_COMPLETE' -and -not $sinCambios) {
        throw "El plan de $Pila fallo: $(Get-Valor $conjunto 'StatusReason')"
    }
    return [pscustomobject]@{
        Pila       = $Pila
        Nombre     = $nombre
        Tipo       = $tipo
        SinCambios = $sinCambios
        Cambios    = @(Get-Valor $conjunto 'Changes' | Where-Object { $null -ne $_ } | ForEach-Object { $_.ResourceChange })
    }
}

function Show-ConjuntoDeCambios($Conjunto) {
    # Ensena el plan y devuelve los cambios que ponen en riesgo algo persistente.
    Write-Paso "Plan de $($Conjunto.Pila) ($($Conjunto.Tipo))"
    if ($Conjunto.SinCambios) {
        Write-Bien 'Sin cambios: la pila ya coincide con la plantilla y los parametros.'
        return @()
    }
    $peligrosos = [System.Collections.Generic.List[string]]::new()
    foreach ($cambio in $Conjunto.Cambios) {
        $reemplazo = [string](Get-Valor $cambio 'Replacement')
        $marca = ''
        if ($cambio.Action -eq 'Remove' -or $reemplazo -eq 'True') { $marca = '  <- DESTRUCTIVO' }
        elseif ($reemplazo -eq 'Conditional') { $marca = '  <- puede reemplazarse' }
        if ($cambio.ResourceType -eq 'AWS::EC2::SecurityGroup' -and $cambio.Action -ne 'Add') { $marca += '  <- revisa el grupo de seguridad' }
        $linea = '{0,-7} {1,-38} {2,-44} {3}{4}' -f $cambio.Action, $cambio.LogicalResourceId, $cambio.ResourceType, $reemplazo, $marca
        if ($marca -match 'DESTRUCTIVO') { Write-Host "    $linea" -ForegroundColor Red } else { Write-Dato $linea }

        $pierdeAlgo = $cambio.Action -eq 'Remove' -or $reemplazo -eq 'True'
        if ($pierdeAlgo -and $cambio.ResourceType -in $TiposPersistentes) {
            $peligrosos.Add("$($cambio.Action) $($cambio.LogicalResourceId) ($($cambio.ResourceType), reemplazo=$reemplazo)")
        }
    }
    $script:Evidencia.pasos["plan-$($Conjunto.Pila)"] = [ordered]@{
        tipo    = $Conjunto.Tipo
        cambios = @($Conjunto.Cambios | ForEach-Object {
                "$($_.Action) $($_.LogicalResourceId) $($_.ResourceType) $(Get-Valor $_ 'Replacement')" })
    }
    return , $peligrosos.ToArray()
}

function Remove-Plan($Conjunto) {
    # Descarta el plan. Si era de una pila nueva, CloudFormation dejo una pila
    # vacia en REVIEW_IN_PROGRESS: se borra solo si de verdad esta vacia.
    Invoke-Aws @('cloudformation', 'delete-change-set', '--stack-name', $Conjunto.Pila,
        '--change-set-name', $Conjunto.Nombre) -PermitirFallo | Out-Null
    $pila = Get-Pila $Conjunto.Pila
    if ($pila -and $pila.StackStatus -eq 'REVIEW_IN_PROGRESS') {
        $recursos = Invoke-Aws @('cloudformation', 'list-stack-resources', '--stack-name', $Conjunto.Pila)
        if (@($recursos.StackResourceSummaries).Count -eq 0) {
            Invoke-Aws @('cloudformation', 'delete-stack', '--stack-name', $Conjunto.Pila) | Out-Null
        }
    }
    Write-Dato 'Plan descartado: no se ha cambiado nada.'
}

function Wait-Pila([string] $Pila, [datetime] $Desde) {
    $vistos = [System.Collections.Generic.HashSet[string]]::new()
    $limite = (Get-Date).AddMinutes(75)
    while ((Get-Date) -lt $limite) {
        Start-Sleep -Seconds 15
        $eventos = Invoke-Aws @('cloudformation', 'describe-stack-events', '--stack-name', $Pila, '--max-items', '40')
        foreach ($evento in @($eventos.StackEvents | Sort-Object Timestamp)) {
            $momento = ([datetime] $evento.Timestamp).ToUniversalTime()
            if ($momento -lt $Desde -or -not $vistos.Add($evento.EventId)) { continue }
            $motivo = [string](Get-Valor $evento 'ResourceStatusReason')
            $color = if ($evento.ResourceStatus -match 'FAILED') { 'Red' } else { 'Gray' }
            Write-Host ('    {0:HH:mm:ss} {1,-28} {2,-36} {3}' -f $momento.ToLocalTime(),
                $evento.ResourceStatus, $evento.LogicalResourceId, $motivo) -ForegroundColor $color
        }
        $estado = (Get-Pila $Pila).StackStatus
        if ($estado -in 'CREATE_COMPLETE', 'UPDATE_COMPLETE') { return $estado }
        if ($estado -match '(FAILED|ROLLBACK_COMPLETE)$') { throw "La pila $Pila termino en $estado." }
    }
    throw "La pila $Pila no termino en 75 minutos."
}

function Invoke-Plan {
    # Planifica, ensena y, si no es solo plan, aplica tras confirmar.
    param(
        [string] $Pila, [hashtable] $Origen, [object[]] $Parametros,
        [string[]] $Capacidades, [object[]] $Etiquetas, [switch] $SoloPlan
    )
    $conjunto = New-ConjuntoDeCambios -Pila $Pila -Origen $Origen -Parametros $Parametros `
        -Capacidades $Capacidades -Etiquetas $Etiquetas
    $peligrosos = Show-ConjuntoDeCambios $conjunto
    if ($conjunto.SinCambios) { Remove-Plan $conjunto; return 'SIN_CAMBIOS' }

    if ($peligrosos.Count -gt 0) {
        Write-Aviso "El plan reemplaza o borra recursos persistentes: $($peligrosos -join '; ')"
        if (-not $PermitirReemplazos -and -not $SoloPlan) {
            Remove-Plan $conjunto
            throw 'Plan bloqueado. Si de verdad es lo que quieres, repite con -PermitirReemplazos.'
        }
    }
    if ($SoloPlan) { Remove-Plan $conjunto; return 'PLANIFICADO' }

    if (-not $PSCmdlet.ShouldProcess($Pila, "Aplicar el plan $($conjunto.Nombre) ($($conjunto.Tipo))")) {
        Remove-Plan $conjunto
        return 'NO_APLICADO'
    }
    $desde = (Get-Date).ToUniversalTime().AddSeconds(-5)
    Invoke-Aws @('cloudformation', 'execute-change-set', '--stack-name', $Pila,
        '--change-set-name', $conjunto.Nombre) | Out-Null
    $estado = Wait-Pila $Pila $desde
    Write-Bien "$Pila -> $estado"
    return $estado
}

function Set-ProteccionDeLaPila([string] $Pila, [bool] $Activar) {
    # OJO: PowerShell no distingue mayusculas en los nombres de variable. Un
    # `$pila = Get-Pila $Pila` reescribia el parametro [string] con el objeto
    # convertido a texto.
    $leida = Get-Pila $Pila
    if (-not (Test-PilaUtilizable $leida)) { return }
    if ([bool] (Get-Valor $leida 'EnableTerminationProtection') -eq $Activar) { return }
    $opcion = if ($Activar) { '--enable-termination-protection' } else { '--no-enable-termination-protection' }
    Invoke-Aws @('cloudformation', 'update-termination-protection', '--stack-name', $Pila, $opcion) | Out-Null
    Write-Bien "Proteccion contra borrado de $Pila = $Activar"
}

# =============================================================================
# Pila de fundacion
# =============================================================================

function Get-ProveedorOidcExistente {
    $proveedores = Invoke-Aws @('iam', 'list-open-id-connect-providers')
    return @($proveedores.OpenIDConnectProviderList | ForEach-Object { $_.Arn } |
            Where-Object { $_ -like '*:oidc-provider/token.actions.githubusercontent.com' }) | Select-Object -First 1
}

function Get-ParametrosDeFundacion([System.Collections.IDictionary] $Configuracion) {
    $parametros = @(
        @{ ParameterKey = 'ExpectedAccountId'; ParameterValue = $ExpectedAccountId }
        @{ ParameterKey = 'Proyecto'; ParameterValue = $Configuracion.Proyecto }
        @{ ParameterKey = 'PrefijoDeRecursos'; ParameterValue = $Configuracion.PrefijoDeRecursos }
        @{ ParameterKey = 'NombreDelRepositorio'; ParameterValue = "$($Configuracion.PrefijoDeRecursos)/api" }
    )
    # EL PROVEEDOR OIDC ES UNO POR CUENTA. Si la pila ya existe se respeta lo
    # que decidio al crearse: cambiar a 'No' una pila que lo creo lo BORRARIA
    # y romperia el despliegue de otros productos de la cuenta.
    $pila = Get-Pila $Configuracion.PilaDeFundacion
    if (Test-PilaUtilizable $pila) {
        $parametros += @{ ParameterKey = 'CrearProveedorOidc'; UsePreviousValue = $true }
        $parametros += @{ ParameterKey = 'ArnDelProveedorOidcExistente'; UsePreviousValue = $true }
    }
    else {
        $existente = Get-ProveedorOidcExistente
        if ($existente) {
            Write-Dato "La cuenta ya tiene el proveedor OIDC de GitHub: se reutiliza, no se crea otro."
            $parametros += @{ ParameterKey = 'CrearProveedorOidc'; ParameterValue = 'No' }
            $parametros += @{ ParameterKey = 'ArnDelProveedorOidcExistente'; ParameterValue = $existente }
        }
        else {
            $parametros += @{ ParameterKey = 'CrearProveedorOidc'; ParameterValue = 'Si' }
        }
    }
    return , $parametros
}

function Deploy-Fundacion([System.Collections.IDictionary] $Configuracion, [switch] $SoloPlan) {
    $pila = $Configuracion.PilaDeFundacion
    $origen = Get-OrigenDePlantilla $PlantillaDeFundacion $null 'fundacion'
    Test-Plantilla $origen '01-fundacion.yaml'
    $resultado = Invoke-Plan -Pila $pila -Origen $origen -Parametros (Get-ParametrosDeFundacion $Configuracion) `
        -Capacidades @('CAPABILITY_NAMED_IAM') -Etiquetas (Get-EtiquetasDeLaPila $Configuracion) -SoloPlan:$SoloPlan
    if ($resultado -in 'CREATE_COMPLETE', 'UPDATE_COMPLETE', 'SIN_CAMBIOS') {
        # Sin ECR ni rol de GitHub no hay despliegue ni vuelta atras.
        Set-ProteccionDeLaPila $pila $true
    }
    $script:Evidencia.pasos.fundacion = $resultado
    return $resultado
}

function Get-SalidasDeFundacion([System.Collections.IDictionary] $Configuracion) {
    $pila = Get-Pila $Configuracion.PilaDeFundacion
    if (-not (Test-PilaUtilizable $pila)) {
        throw "No existe la pila $($Configuracion.PilaDeFundacion): ejecuta antes -Accion Fundacion."
    }
    $salidas = Get-Salidas $pila
    foreach ($clave in 'UriDelRepositorio', 'RegistroDeEcr', 'BucketDePlantillas', 'ArnDelRolDeDespliegue') {
        if (-not $salidas.ContainsKey($clave)) {
            throw "La pila de fundacion no tiene la salida ${clave}: actualizala con -Accion Fundacion."
        }
    }
    return $salidas
}

# =============================================================================
# Secretos
# =============================================================================

function Test-FicheroFueraDelRepositorio([string] $Ruta) {
    $completa = (Resolve-Path -LiteralPath $Ruta).Path
    if (-not $completa.StartsWith($Raiz, [System.StringComparison]::OrdinalIgnoreCase)) { return }
    & git -C $Raiz ls-files --error-unmatch -- $completa *> $null
    if ($LASTEXITCODE -eq 0) { throw "El fichero de secretos esta versionado en git: $completa. No se usa." }
    & git -C $Raiz check-ignore -q -- $completa
    if ($LASTEXITCODE -ne 0) {
        throw "El fichero de secretos esta dentro del repositorio y git no lo ignora: $completa. Muevelo fuera."
    }
}

function Read-FicheroDeSecretos([string] $Ruta) {
    if (-not $Ruta) { throw 'Falta -ArchivoDeSecretos (JSON plano con las claves de la API).' }
    if (-not (Test-Path -LiteralPath $Ruta -PathType Leaf)) { throw "No existe $Ruta." }
    Test-FicheroFueraDelRepositorio $Ruta
    $secreto = Get-Content -Raw -LiteralPath $Ruta | ConvertFrom-Json -AsHashtable
    if ($secreto -isnot [System.Collections.IDictionary]) { throw 'El fichero de secretos tiene que ser un objeto JSON.' }

    $problemas = [System.Collections.Generic.List[string]]::new()
    foreach ($clave in @($secreto.Keys)) {
        $valor = $secreto[$clave]
        if ($clave -notmatch '^[A-Z][A-Z0-9_]*$') { $problemas.Add("$clave no es un nombre de variable valido") }
        if ($valor -isnot [string]) { $problemas.Add("$clave no es texto"); continue }
        # El arranque convierte cada pareja en una linea de un fichero de
        # entorno: un salto de linea partiria la variable en dos.
        if ($valor -match "[`r`n]") { $problemas.Add("$clave tiene saltos de linea") }
        if ($valor -match '^<.*>$') { $problemas.Add("$clave sigue siendo un valor de ejemplo") }
        if ($clave -in $ClavesQueFijaLaPlantilla) { $problemas.Add("$clave la fija la plantilla; quitala del secreto") }
        if ($clave -in $BanderasDeDinero -and $valor -match '^(?i:true|1|yes|on)$' -and -not $PermitirBanderasFinancieras) {
            $problemas.Add("$clave encendida: lo que mueve dinero no se enciende al migrar")
        }
    }
    foreach ($clave in $ClavesObligatorias) {
        if (-not $secreto.Contains($clave) -or [string]::IsNullOrWhiteSpace([string] $secreto[$clave])) {
            $problemas.Add("falta $clave")
        }
    }
    # La API crea el motor con la URL tal cual: sin el controlador asincrono
    # arrancaria y fallaria en la primera consulta.
    if ($secreto.Contains('DATABASE_URL') -and [string] $secreto['DATABASE_URL'] -notmatch '^postgresql\+asyncpg://') {
        $problemas.Add('DATABASE_URL tiene que empezar por postgresql+asyncpg://')
    }
    # `sslmode` es de psycopg: SQLAlchemy se lo pasaria a asyncpg como un
    # argumento que no conoce y la primera consulta fallaria. En asyncpg es `ssl`.
    if ($secreto.Contains('DATABASE_URL') -and [string] $secreto['DATABASE_URL'] -match '[?&]sslmode=') {
        $problemas.Add('DATABASE_URL usa sslmode=, que asyncpg no entiende: usa ssl=require')
    }
    if ($secreto.Contains('SUPABASE_URL') -and [string] $secreto['SUPABASE_URL'] -notmatch '^https://') {
        $problemas.Add('SUPABASE_URL tiene que ser https://')
    }
    # La API cierra el piloto entero si UNA entrada no es un UUID. Mejor
    # saberlo aqui que con Servicios encendido y nadie pudiendo entrar. Solo
    # se dice que esta mal: el valor no se imprime.
    if ($secreto.Contains($ClaveDelPiloto) -and [string] $secreto[$ClaveDelPiloto] -notmatch $PatronDelPiloto) {
        $problemas.Add("$ClaveDelPiloto tiene que ser una lista de UUID separados por comas, sin espacios (o vacia)")
    }
    if ($secreto.Contains($ClaveDeLaListaDeMedios) -and [string] $secreto[$ClaveDeLaListaDeMedios] -notmatch $PatronDelPiloto) {
        $problemas.Add("$ClaveDeLaListaDeMedios tiene que ser una lista de UUID separados por comas, sin espacios (o vacia)")
    }
    if ($secreto.Contains($ClaveDeLaFirmaDeMedios) -and [string] $secreto[$ClaveDeLaFirmaDeMedios] -cnotmatch $PatronDeLaFirmaDeMedios) {
        $problemas.Add("$ClaveDeLaFirmaDeMedios tiene que ser la PEM en base64 de una sola linea (base64 -w0)")
    }
    if ($secreto.Contains($ClaveDeLaLimpiezaDeMedios) -and [string] $secreto[$ClaveDeLaLimpiezaDeMedios] -cnotmatch $PatronDeLaLimpiezaDeMedios) {
        $problemas.Add("$ClaveDeLaLimpiezaDeMedios tiene que tener 32 caracteres o mas, sin espacios (o ir vacia)")
    }
    if ($problemas.Count -gt 0) { throw "El fichero de secretos no vale: $($problemas -join '; ')." }
    return $secreto
}

function Get-SecretoActual([string] $Nombre) {
    $leido = Invoke-Aws @('secretsmanager', 'get-secret-value', '--secret-id', $Nombre) -PermitirFallo
    if ($null -eq $leido) { return $null }
    return $leido.SecretString | ConvertFrom-Json -AsHashtable
}

function Set-Secretos([System.Collections.IDictionary] $Configuracion) {
    Write-Paso "Secreto $($Configuracion.NombreDelSecreto)"
    $nuevo = Read-FicheroDeSecretos $ArchivoDeSecretos
    $actual = Get-SecretoActual $Configuracion.NombreDelSecreto

    # La cabecera de origen no la escribe nadie a mano: se conserva la que hay
    # (cambiarla sin mas dejaria a CloudFront fuera) o se genera una nueva.
    if (-not $nuevo.Contains($ClaveDeCabecera)) {
        if ($actual -and $actual.Contains($ClaveDeCabecera)) {
            $nuevo[$ClaveDeCabecera] = $actual[$ClaveDeCabecera]
        }
        else {
            $bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
            $nuevo[$ClaveDeCabecera] = [System.Convert]::ToHexString($bytes).ToLowerInvariant()
            Write-Dato "Generada $ClaveDeCabecera (64 caracteres hexadecimales)."
        }
    }
    elseif ([string] $nuevo[$ClaveDeCabecera] -notmatch '^[0-9a-f]{32,128}$') {
        throw "$ClaveDeCabecera tiene que ser hexadecimal en minusculas: el balanceador trata * y ? como comodines."
    }

    # El secreto del planificador de Z Servicios, lo mismo: se conserva o se
    # genera. La API no acepta uno de menos de 32 caracteres.
    if (-not $nuevo.Contains($ClaveDelPlanificador)) {
        if ($actual -and $actual.Contains($ClaveDelPlanificador) -and -not $RotarSecretoDelPlanificador) {
            $nuevo[$ClaveDelPlanificador] = $actual[$ClaveDelPlanificador]
        }
        else {
            $bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
            $nuevo[$ClaveDelPlanificador] = [System.Convert]::ToHexString($bytes).ToLowerInvariant()
            Write-Dato "Generada $ClaveDelPlanificador (64 caracteres hexadecimales)."
        }
    }
    elseif ([string] $nuevo[$ClaveDelPlanificador] -notmatch $PatronDelPlanificador) {
        throw "$ClaveDelPlanificador tiene que ser hexadecimal en minusculas, de 32 a 128 caracteres."
    }

    # Solo NOMBRES en consola y en la evidencia, nunca valores.
    $anadidas = @($nuevo.Keys | Where-Object { -not $actual -or -not $actual.Contains($_) })
    $cambiadas = @($nuevo.Keys | Where-Object { $actual -and $actual.Contains($_) -and $actual[$_] -ne $nuevo[$_] })
    $quitadas = @(if ($actual) { $actual.Keys | Where-Object { -not $nuevo.Contains($_) } })
    if ($actual -and -not ($anadidas -or $cambiadas -or $quitadas)) {
        Write-Bien 'El secreto ya tiene exactamente esos valores: no se crea una version nueva.'
        $script:Evidencia.pasos.secretos = 'SIN_CAMBIOS'
        return
    }
    if ($anadidas) { Write-Dato "Claves nuevas: $($anadidas -join ', ')" }
    if ($cambiadas) { Write-Dato "Claves que cambian: $($cambiadas -join ', ')" }
    if ($quitadas) { Write-Aviso "Claves que desaparecen: $($quitadas -join ', ')" }
    if ($cambiadas -contains $ClaveDeCabecera) {
        Write-Aviso "Cambia ${ClaveDeCabecera}: hay que redesplegar la plataforma (ver la rotacion en docs/AWS_MIGRACION_RENASERLAB.md)."
    }
    if ($cambiadas -contains $ClaveDelPlanificador) {
        Write-Aviso "Cambia ${ClaveDelPlanificador}: (1) -Accion Renovar; (2) sube VersionDelSecretoDelPlanificador en el perfil y -Accion Plataforma. Sin subir ese numero la conexion de EventBridge se queda con el secreto anterior."
    }
    if ($cambiadas -contains $ClaveDeLaLimpiezaDeMedios) {
        Write-Aviso "Cambia ${ClaveDeLaLimpiezaDeMedios}: (1) -Accion Renovar; (2) sube VersionDelSecretoDelPlanificador en el perfil y -Accion Plataforma. Sin subir ese numero la conexion de la limpieza de medios se queda con el secreto anterior."
    }

    $accionDelSecreto = if ($actual) { 'Crear una version nueva' } else { 'Crear el secreto' }
    if (-not $PSCmdlet.ShouldProcess($Configuracion.NombreDelSecreto, $accionDelSecreto)) { return }

    $fichero = Write-FicheroTemporal (ConvertTo-Json -InputObject $nuevo -Compress)
    try {
        if ($actual) {
            Invoke-Aws @('secretsmanager', 'put-secret-value', '--secret-id', $Configuracion.NombreDelSecreto,
                '--secret-string', "file://$fichero") | Out-Null
        }
        else {
            $lista = Get-EtiquetasDeLaPila $Configuracion
            $etiquetas = @($lista | ForEach-Object { "Key=$($_.Key),Value=$($_.Value)" })
            Invoke-Aws (@('secretsmanager', 'create-secret', '--name', $Configuracion.NombreDelSecreto,
                    '--description', 'Configuracion de la API de Z Excelencia (Supabase y cabecera de origen)',
                    '--secret-string', "file://$fichero", '--tags') + $etiquetas) | Out-Null
        }
    }
    finally {
        Remove-Item -LiteralPath $fichero -Force -ErrorAction SilentlyContinue -WhatIf:$false -Confirm:$false
    }
    Write-Bien 'Secreto guardado.'
    $script:Evidencia.pasos.secretos = [ordered]@{ anadidas = $anadidas; cambiadas = $cambiadas; quitadas = $quitadas }

    $plataforma = Get-Pila (Get-NombreDePlataforma $Configuracion)
    if (Test-PilaUtilizable $plataforma) {
        Write-Aviso 'Las maquinas leen el secreto AL ARRANCAR: ejecuta -Accion Renovar para aplicarlo.'
    }
}

function Assert-SecretoCompleto([System.Collections.IDictionary] $Configuracion) {
    $actual = Get-SecretoActual $Configuracion.NombreDelSecreto
    if ($null -eq $actual) {
        throw "No existe el secreto $($Configuracion.NombreDelSecreto): cargalo con -Accion Secretos."
    }
    $necesarias = @($ClavesObligatorias)
    if ($Configuracion.VerificarCabeceraDeOrigen -eq 'Si') { $necesarias += $ClaveDeCabecera }
    # Sin esta clave la referencia dinamica de la conexion no resuelve y la
    # pila falla a medio actualizar: mejor saberlo antes.
    if ($Configuracion.PlanificadorDeServicios -eq 'Si') { $necesarias += $ClaveDelPlanificador }
    if ($Configuracion.PlanificadorDeMedios -eq 'Si') { $necesarias += $ClaveDeLaLimpiezaDeMedios }
    $faltan = @($necesarias | Where-Object { -not $actual.Contains($_) })
    # El ejemplo la trae vacia: vacia es como si faltara, porque la conexion
    # de EventBridge se crearia con un token vacio que la API rechaza.
    if ($Configuracion.PlanificadorDeMedios -eq 'Si' -and $actual.Contains($ClaveDeLaLimpiezaDeMedios) -and
        [string]::IsNullOrWhiteSpace([string] $actual[$ClaveDeLaLimpiezaDeMedios])) {
        $faltan += $ClaveDeLaLimpiezaDeMedios
    }
    if ($faltan) { throw "Al secreto le faltan: $($faltan -join ', '). Cargalo con -Accion Secretos." }
    Write-Bien "Secreto completo ($($actual.Count) claves)"
}

# =============================================================================
# Imagen
# =============================================================================

function Get-CommitDeLaRevision {
    if ($Revision -like 'origin/*') {
        # Solo actualiza las referencias remotas; no toca ramas ni ficheros.
        Invoke-Nativo git @('-C', $Raiz, 'fetch', '--quiet', 'origin')
    }
    return Get-TextoDeGit @('rev-parse', '--verify', "$Revision^{commit}")
}

function Get-EtiquetaDeLaRevision {
    if ($EtiquetaDeImagen) { return $EtiquetaDeImagen }
    # La misma forma que el flujo de GitHub: sha- y los 7 primeros caracteres.
    return 'sha-' + (Get-CommitDeLaRevision).Substring(0, 7)
}

function Get-ImagenPublicada([System.Collections.IDictionary] $Configuracion, [string] $Etiqueta) {
    $respuesta = Invoke-Aws @('ecr', 'describe-images', '--repository-name', "$($Configuracion.PrefijoDeRecursos)/api",
        '--image-ids', "imageTag=$Etiqueta") -PermitirFallo
    if ($null -eq $respuesta) { return $null }
    return $respuesta.imageDetails[0]
}

function Publish-Imagen([System.Collections.IDictionary] $Configuracion) {
    Write-Paso "Imagen de $Revision"
    $salidas = Get-SalidasDeFundacion $Configuracion
    $commit = Get-CommitDeLaRevision
    $etiqueta = 'sha-' + $commit.Substring(0, 7)
    $repositorio = "$($Configuracion.PrefijoDeRecursos)/api"
    $uri = "$($salidas.UriDelRepositorio):$etiqueta"
    Write-Dato "Commit $commit -> $uri"

    $publicada = Get-ImagenPublicada $Configuracion $etiqueta
    if ($publicada) {
        # Etiquetas inmutables: misma etiqueta, mismo commit, misma imagen.
        Write-Bien "Ya estaba publicada ($($publicada.imageDigest)): no se reconstruye."
    }
    else {
        if (-not $PSCmdlet.ShouldProcess($uri, 'Construir y publicar la imagen')) { return $null }
        $temporal = Join-Path ([System.IO.Path]::GetTempPath()) "zexcelencia-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
        New-Item -ItemType Directory -Path $temporal -WhatIf:$false -Confirm:$false | Out-Null
        try {
            # Se construye desde el COMMIT y no desde la carpeta de trabajo:
            # un cambio sin guardar no puede colarse en una imagen que dice
            # llamarse como ese commit.
            $paquete = Join-Path $temporal 'api.zip'
            Invoke-Nativo git @('-C', $Raiz, 'archive', '--format=zip', '-o', $paquete, $commit, 'apps/api')
            # .NET y no Expand-Archive: el cmdlet intenta preguntar y, sin
            # consola interactiva, falla con un error que no dice por que.
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [System.IO.Compression.ZipFile]::ExtractToDirectory($paquete, $temporal)
            # UNA imagen, no un indice. Sin estas dos opciones, Docker Desktop
            # publica un indice OCI con la imagen y una atestacion como hijos SIN
            # ETIQUETA: ECR no escanea el indice, y la regla de ciclo de vida que
            # borra lo no etiquetado a los 7 dias podria llevarse la imagen y
            # dejar la etiqueta sin nada que descargar. Paso con la primera
            # imagen de RenaserLab. El flujo de GitHub ya lleva provenance: false.
            Invoke-Nativo docker @('build', '--pull', '--platform', 'linux/amd64', '--provenance=false', '--sbom=false',
                '--label', "org.opencontainers.image.revision=$commit", '-t', $uri, (Join-Path $temporal 'apps' 'api'))
        }
        finally {
            Remove-Item -LiteralPath $temporal -Recurse -Force -ErrorAction SilentlyContinue -WhatIf:$false -Confirm:$false
        }
        & aws ecr get-login-password --region $Region | docker login --username AWS --password-stdin $salidas.RegistroDeEcr | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo entrar en ECR.' }
        Invoke-Nativo docker @('push', $uri)
        $publicada = Get-ImagenPublicada $Configuracion $etiqueta
        if (-not $publicada) { throw "La imagen no aparece en ECR tras subirla: $uri" }
        if ([string] (Get-Valor $publicada 'imageManifestMediaType') -match 'index|manifest\.list') {
            throw "Se publico un indice y no una imagen ($($publicada.imageManifestMediaType)): no se usa."
        }
        Write-Bien "Publicada $uri ($($publicada.imageDigest))"
    }

    # Escaneo basico de ECR: avisa, no decide. Un CVE critico en la imagen base
    # es una decision de una persona, no del guion.
    Invoke-Aws @('ecr', 'wait', 'image-scan-complete', '--repository-name', $repositorio,
        '--image-id', "imageTag=$etiqueta") -PermitirFallo | Out-Null
    $hallazgos = Invoke-Aws @('ecr', 'describe-image-scan-findings', '--repository-name', $repositorio,
        '--image-id', "imageTag=$etiqueta") -PermitirFallo
    $conteo = Get-Valor (Get-Valor $hallazgos 'imageScanFindings') 'findingSeverityCounts'
    if ($conteo) {
        $resumen = ($conteo.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ', '
        Write-Dato "Escaneo de vulnerabilidades: $resumen"
        if ((Get-Valor $conteo 'CRITICAL') -gt 0) { Write-Aviso 'La imagen tiene vulnerabilidades CRITICAS: revisalas antes de publicar.' }
    }
    $script:Evidencia.pasos.imagen = [ordered]@{
        commit = $commit; etiqueta = $etiqueta; digest = $publicada.imageDigest; escaneo = $conteo
    }
    return $etiqueta
}

# =============================================================================
# Pila de plataforma
# =============================================================================

function Get-ListaDePrefijosDeCloudFront {
    $listas = Invoke-Aws @('ec2', 'describe-managed-prefix-lists', '--filters',
        'Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing')
    $primera = @($listas.PrefixLists) | Select-Object -First 1
    if ($null -eq $primera) { return $null }
    return $primera.PrefixListId
}

function Get-ParametrosDePlataforma([System.Collections.IDictionary] $Configuracion, [bool] $EsCreacion, [string] $Etiqueta) {
    $valores = [ordered]@{}
    foreach ($clave in $Configuracion.Keys) { $valores[$clave] = $Configuracion[$clave] }
    $valores.ExpectedAccountId = $ExpectedAccountId
    if ($CorreoDeAlertas) { $valores.CorreoDeAlertas = $CorreoDeAlertas }

    # El identificador de la lista de CloudFront depende de la region: se lee
    # de la cuenta en vez de fiarse del fichero.
    $lista = Get-ListaDePrefijosDeCloudFront
    if ($lista -and $lista -ne $valores.ListaDePrefijosDeCloudFront) {
        Write-Aviso "La lista de prefijos de CloudFront en $Region es $lista, no $($valores.ListaDePrefijosDeCloudFront): se usa $lista."
        $valores.ListaDePrefijosDeCloudFront = $lista
    }

    $parametros = @($valores.Keys | ForEach-Object { @{ ParameterKey = $_; ParameterValue = [string] $valores[$_] } })
    # Ver el comentario de EtiquetaDeImagen en la plantilla: al actualizar se
    # conserva, porque pasar otra pisaria la version que movio el CI.
    if ($EsCreacion) { $parametros += @{ ParameterKey = 'EtiquetaDeImagen'; ParameterValue = $Etiqueta } }
    else { $parametros += @{ ParameterKey = 'EtiquetaDeImagen'; UsePreviousValue = $true } }
    return , $parametros
}

function Deploy-Plataforma([System.Collections.IDictionary] $Configuracion, [switch] $SoloPlan) {
    $pila = Get-NombreDePlataforma $Configuracion
    $salidas = Get-SalidasDeFundacion $Configuracion
    $existente = Get-Pila $pila
    $esCreacion = -not (Test-PilaUtilizable $existente)

    $etiqueta = $null
    if ($esCreacion) {
        $etiqueta = Get-EtiquetaDeLaRevision
        if (-not (Get-ImagenPublicada $Configuracion $etiqueta)) {
            if (-not $SoloPlan) { throw "La imagen $etiqueta no esta en ECR: publicala con -Accion Imagen." }
            Write-Aviso "La imagen $etiqueta aun no esta en ECR: el plan vale, el despliegue no."
        }
        Write-Dato "La pila nace con la imagen $etiqueta."
    }
    if ($SoloPlan) {
        if (-not (Get-SecretoActual $Configuracion.NombreDelSecreto)) {
            Write-Aviso 'Aun no existe el secreto: el despliegue lo necesitara.'
        }
    }
    else { Assert-SecretoCompleto $Configuracion }

    $origen = Get-OrigenDePlantilla $PlantillaDePlataforma $salidas.BucketDePlantillas 'plataforma'
    Test-Plantilla $origen '02-plataforma.yaml'
    $resultado = Invoke-Plan -Pila $pila -Origen $origen `
        -Parametros (Get-ParametrosDePlataforma $Configuracion $esCreacion $etiqueta) `
        -Capacidades @('CAPABILITY_IAM') -Etiquetas (Get-EtiquetasDeLaPila $Configuracion) -SoloPlan:$SoloPlan
    if ($resultado -in 'CREATE_COMPLETE', 'UPDATE_COMPLETE', 'SIN_CAMBIOS') {
        Set-ProteccionDeLaPila $pila ($Configuracion.ProteccionContraBorrado -eq 'Si')
    }
    $script:Evidencia.pasos.plataforma = $resultado
    return $resultado
}

# =============================================================================
# Salud y estado
# =============================================================================

function Invoke-Http([string] $Url, [int] $Segundos = 10) {
    $reloj = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $respuesta = Invoke-WebRequest -Uri $Url -TimeoutSec $Segundos -SkipHttpErrorCheck -MaximumRedirection 0
        return [ordered]@{
            url = $Url; codigo = [int] $respuesta.StatusCode
            segundos = [math]::Round($reloj.Elapsed.TotalSeconds, 3); cuerpo = [string] $respuesta.Content
        }
    }
    catch {
        return [ordered]@{
            url = $Url; codigo = 0; segundos = [math]::Round($reloj.Elapsed.TotalSeconds, 3)
            cuerpo = ''; error = $_.Exception.Message
        }
    }
}

function Get-EstadoDeLasAlertas([string] $Tema) {
    $suscripciones = @((Invoke-Aws @('sns', 'list-subscriptions-by-topic', '--topic-arn', $Tema)).Subscriptions)
    if ($suscripciones.Count -eq 0) {
        Write-Aviso 'Las alarmas no tienen a quien avisar: no hay ninguna suscripcion.'
        return 'SIN_SUSCRIPCION'
    }
    $pendientes = @($suscripciones | Where-Object { $_.SubscriptionArn -eq 'PendingConfirmation' })
    if ($pendientes.Count -gt 0) {
        # Mientras nadie pulse el enlace del correo, las alarmas saltan en
        # silencio. No se puede dar por operativo.
        Write-Aviso "Alertas PENDIENTES de confirmar ($($pendientes.Count)): hasta que alguien acepte el correo de AWS, nadie recibe avisos."
        return 'PENDIENTE_DE_CONFIRMAR'
    }
    Write-Bien "Alertas confirmadas ($($suscripciones.Count) suscripcion/es)"
    return 'CONFIRMADAS'
}

function Get-UrlDeProduccionActual {
    # La que llevan las builds del movil hoy. Se lee del repositorio para no
    # escribirla dos veces.
    $eas = Get-Content -Raw -LiteralPath (Join-Path $Raiz 'apps' 'mobile' 'eas.json') | ConvertFrom-Json
    return Get-Valor (Get-Valor (Get-Valor (Get-Valor $eas 'build') 'production') 'env') 'EXPO_PUBLIC_API_URL'
}

function Test-Salud([System.Collections.IDictionary] $Configuracion, [switch] $SinComparar) {
    $pila = Get-NombreDePlataforma $Configuracion
    Write-Paso "Salud de $pila"
    $plataforma = Get-Pila $pila
    if (-not (Test-PilaUtilizable $plataforma)) { throw "No existe la pila $pila." }
    $salidas = Get-Salidas $plataforma
    $url = $salidas.UrlPublicaDeLaApi
    $fallos = [System.Collections.Generic.List[string]]::new()
    $resultado = [ordered]@{ url = $url }

    # Maquinas y zonas
    $grupo = (Invoke-Aws @('autoscaling', 'describe-auto-scaling-groups', '--auto-scaling-group-names',
            $salidas.NombreDelGrupoDeAutoescalado)).AutoScalingGroups[0]
    $sanas = @($grupo.Instances | Where-Object { $_.LifecycleState -eq 'InService' -and $_.HealthStatus -eq 'Healthy' })
    $zonas = @($sanas | ForEach-Object { $_.AvailabilityZone } | Sort-Object -Unique)
    $resultado.maquinas = [ordered]@{ sanas = $sanas.Count; minimo = $grupo.MinSize; deseadas = $grupo.DesiredCapacity; zonas = $zonas }
    if ($sanas.Count -lt $grupo.MinSize) { $fallos.Add("solo $($sanas.Count) maquinas sanas de $($grupo.MinSize)") }
    else { Write-Bien "$($sanas.Count) maquina(s) sana(s) en $($zonas -join ', ')" }

    # El balanceador ve sanas a las maquinas
    $destino = (Invoke-Aws @('elbv2', 'describe-target-groups', '--names',
            "$($Configuracion.PrefijoDeRecursos)-$($Configuracion.Entorno)-api")).TargetGroups[0]
    $estados = @((Invoke-Aws @('elbv2', 'describe-target-health', '--target-group-arn', $destino.TargetGroupArn)).TargetHealthDescriptions)
    $enServicio = @($estados | Where-Object { $_.TargetHealth.State -eq 'healthy' }).Count
    $resultado.destinosSanos = $enServicio
    if ($enServicio -lt 1) { $fallos.Add('el balanceador no tiene ningun destino sano') }
    else { Write-Bien "$enServicio destino(s) sano(s) en el balanceador" }

    # La API por su URL publica
    $salud = Invoke-Http "$url/health"
    $resultado.health = [ordered]@{ codigo = $salud.codigo; segundos = $salud.segundos; cuerpo = $salud.cuerpo }
    if ($salud.codigo -ne 200 -or $salud.cuerpo -notmatch '"status"\s*:\s*"ok"') {
        $fallos.Add("/health devolvio $($salud.codigo)")
    }
    else { Write-Bien "/health 200 en $($salud.segundos) s" }

    # /health no toca la base; esta ruta si. Solo se guarda el codigo: el
    # cuerpo son datos de personas.
    $base = Invoke-Http "$url$RutaQueConsultaLaBase" 20
    $resultado.base = [ordered]@{ ruta = $RutaQueConsultaLaBase; codigo = $base.codigo; segundos = $base.segundos }
    if ($base.codigo -ne 200) { $fallos.Add("$RutaQueConsultaLaBase devolvio $($base.codigo): revisa DATABASE_URL y Supabase") }
    else { Write-Bien "$RutaQueConsultaLaBase 200 en $($base.segundos) s (la base responde)" }

    # El balanceador NO debe contestar directamente desde fuera.
    $directo = Invoke-Http "http://$($salidas.DnsDelBalanceador)/health" 5
    $resultado.accesoDirecto = $directo.codigo
    if ($directo.codigo -eq 200) { Write-Aviso 'El balanceador responde directamente desde Internet: revisa SoloDesdeCloudFront.' }
    else { Write-Bien "Acceso directo al balanceador cerrado (codigo $($directo.codigo))" }

    # Version y alertas
    $resultado.version = (Invoke-Aws @('ssm', 'get-parameter', '--name', $salidas.ParametroDeLaVersion)).Parameter.Value
    Write-Dato "Version desplegada: $($resultado.version)"
    $resultado.alertas = Get-EstadoDeLasAlertas $salidas.TemaDeAlertasArn
    $enAlarma = @((Invoke-Aws @('cloudwatch', 'describe-alarms', '--alarm-name-prefix',
                "$($Configuracion.PrefijoDeRecursos)-$($Configuracion.Entorno)-")).MetricAlarms |
            Where-Object { $_.StateValue -eq 'ALARM' } | ForEach-Object { $_.AlarmName })
    $resultado.alarmasActivas = $enAlarma
    if ($enAlarma) { Write-Aviso "Alarmas en ALARM: $($enAlarma -join ', ')" }

    if (-not $SinComparar) {
        $actual = Get-UrlDeProduccionActual
        if ($actual -and $actual -ne $url) {
            # Solo lectura: dos GET publicos contra la API que usan hoy las apps.
            $saludActual = Invoke-Http "$actual/health"
            $baseActual = Invoke-Http "$actual$RutaQueConsultaLaBase" 20
            $resultado.comparacion = [ordered]@{
                actual = [ordered]@{ url = $actual; health = $saludActual.codigo; base = $baseActual.codigo; segundos = $baseActual.segundos }
                nueva  = [ordered]@{ url = $url; health = $salud.codigo; base = $base.codigo; segundos = $base.segundos }
            }
            Write-Dato ('Produccion actual {0}: /health {1}, base {2} en {3} s' -f $actual, $saludActual.codigo, $baseActual.codigo, $baseActual.segundos)
            Write-Dato ('API nueva         {0}: /health {1}, base {2} en {3} s' -f $url, $salud.codigo, $base.codigo, $base.segundos)
        }
    }

    $script:Evidencia.pasos.salud = $resultado
    if ($fallos.Count -gt 0) { throw "La API no esta sana: $($fallos -join '; ')." }
    Write-Bien "API sana en $url"
    return $resultado
}

function Show-Estado([System.Collections.IDictionary] $Configuracion) {
    foreach ($nombre in $Configuracion.PilaDeFundacion, (Get-NombreDePlataforma $Configuracion)) {
        Write-Paso "Pila $nombre"
        $pila = Get-Pila $nombre
        if (-not $pila) { Write-Dato 'No existe.'; continue }
        Write-Dato "Estado: $($pila.StackStatus)   Proteccion contra borrado: $(Get-Valor $pila 'EnableTerminationProtection')"
        $salidas = Get-Salidas $pila
        foreach ($clave in ($salidas.Keys | Sort-Object)) { Write-Dato ('{0,-30} {1}' -f $clave, $salidas[$clave]) }
        $script:Evidencia.pasos[$nombre] = [ordered]@{ estado = $pila.StackStatus; salidas = $salidas }
        if ($salidas.ContainsKey('TemaDeAlertasArn')) { $null = Get-EstadoDeLasAlertas $salidas.TemaDeAlertasArn }
        if ($salidas.ContainsKey('ParametroDeLaVersion')) {
            $version = (Invoke-Aws @('ssm', 'get-parameter', '--name', $salidas.ParametroDeLaVersion)).Parameter.Value
            Write-Dato "Version desplegada: $version"
        }
    }
}

# =============================================================================
# Renovar y volver atras
# =============================================================================

function Start-Renovacion([string] $Grupo) {
    $enCurso = @((Invoke-Aws @('autoscaling', 'describe-instance-refreshes', '--auto-scaling-group-name', $Grupo)).InstanceRefreshes |
            Where-Object { $_.Status -in 'Pending', 'InProgress', 'Cancelling', 'RollbackInProgress' })
    if ($enCurso) { throw "Ya hay una renovacion en curso en $Grupo ($($enCurso[0].InstanceRefreshId)): espera a que termine." }

    # Primero nace la maquina nueva y solo cuando esta sana se apaga la vieja:
    # con una imagen rota, la version anterior sigue sirviendo.
    #
    # HACEN FALTA LOS DOS PORCENTAJES. Con solo MinHealthyPercentage=100, AWS
    # TERMINA primero y lanza despues: medido en RenaserLab el 23/09/2026, tres
    # minutos sin ninguna maquina sana con una sola instancia. Es
    # MaxHealthyPercentage por encima de 100 lo que le permite lanzar antes de
    # terminar; el hueco lo da el maximo del grupo (deseadas + 1).
    $entrada = [ordered]@{
        AutoScalingGroupName = $Grupo
        Preferences          = [ordered]@{
            MinHealthyPercentage = 100; MaxHealthyPercentage = 200; InstanceWarmup = 300; AutoRollback = $false
            ScaleInProtectedInstances = 'Ignore'; StandbyInstances = 'Ignore'
        }
    }
    $id = (Invoke-AwsConEntrada @('autoscaling', 'start-instance-refresh') $entrada).InstanceRefreshId
    Write-Dato "Renovacion $id en marcha"
    $limite = (Get-Date).AddMinutes(30)
    while ((Get-Date) -lt $limite) {
        Start-Sleep -Seconds 20
        $renovacion = (Invoke-Aws @('autoscaling', 'describe-instance-refreshes', '--auto-scaling-group-name', $Grupo,
                '--instance-refresh-ids', $id)).InstanceRefreshes[0]
        Write-Dato "  $($renovacion.Status) ($(Get-Valor $renovacion 'PercentageComplete')%)"
        if ($renovacion.Status -eq 'Successful') { return }
        if ($renovacion.Status -in 'Failed', 'Cancelled', 'RollbackSuccessful', 'RollbackFailed') {
            throw "La renovacion termino en $($renovacion.Status): $(Get-Valor $renovacion 'StatusReason')"
        }
    }
    throw "La renovacion $id no termino en 30 minutos."
}

function Invoke-Renovar([System.Collections.IDictionary] $Configuracion) {
    $salidas = Get-Salidas (Get-Pila (Get-NombreDePlataforma $Configuracion))
    Write-Paso "Renovar las maquinas de $($salidas.NombreDelGrupoDeAutoescalado)"
    if (-not $PSCmdlet.ShouldProcess($salidas.NombreDelGrupoDeAutoescalado, 'Renovar las maquinas')) { return }
    Start-Renovacion $salidas.NombreDelGrupoDeAutoescalado
    $null = Test-Salud $Configuracion -SinComparar
}

function Invoke-VolverAtras([System.Collections.IDictionary] $Configuracion) {
    $salidas = Get-Salidas (Get-Pila (Get-NombreDePlataforma $Configuracion))
    $parametro = $salidas.ParametroDeLaVersion
    $actual = (Invoke-Aws @('ssm', 'get-parameter', '--name', $parametro)).Parameter.Value
    $destino = $EtiquetaDeImagen
    if (-not $destino) {
        # La ultima version distinta de la actual en el historial del puntero.
        $historial = @((Invoke-Aws @('ssm', 'get-parameter-history', '--name', $parametro)).Parameters |
                Sort-Object LastModifiedDate -Descending | ForEach-Object { $_.Value })
        $destino = $historial | Where-Object { $_ -ne $actual } | Select-Object -First 1
        if (-not $destino) { throw 'No hay ninguna version anterior en el historial: indica -EtiquetaDeImagen.' }
    }
    Write-Paso "Volver atras: $actual -> $destino"
    if (-not (Get-ImagenPublicada $Configuracion $destino)) { throw "La imagen $destino no esta en ECR (se conservan las 10 ultimas)." }
    if (-not $PSCmdlet.ShouldProcess($parametro, "Apuntar a $destino y renovar las maquinas")) { return }

    Invoke-Aws @('ssm', 'put-parameter', '--name', $parametro, '--type', 'String', '--value', $destino, '--overwrite') | Out-Null
    $script:Evidencia.pasos.volverAtras = [ordered]@{ desde = $actual; hacia = $destino }
    try { Start-Renovacion $salidas.NombreDelGrupoDeAutoescalado }
    catch {
        Write-Aviso "El puntero ya apunta a $destino. Si hay que deshacerlo: -Accion VolverAtras -EtiquetaDeImagen $actual"
        throw
    }
    $null = Test-Salud $Configuracion -SinComparar
}

# =============================================================================
# Verificar y preparar el corte
# =============================================================================

function Test-Colisiones([System.Collections.IDictionary] $Configuracion) {
    # Recursos con nombre fijo que ya existan FUERA de las pilas harian fallar
    # la creacion a mitad de camino. Mejor saberlo antes.
    $prefijo = $Configuracion.PrefijoDeRecursos
    $entorno = $Configuracion.Entorno
    if (-not (Test-PilaUtilizable (Get-Pila $Configuracion.PilaDeFundacion))) {
        if (Invoke-Aws @('ecr', 'describe-repositories', '--repository-names', "$prefijo/api") -PermitirFallo) {
            Write-Aviso "Ya existe el repositorio ECR $prefijo/api fuera de la pila: la fundacion fallaria."
        }
        if (Invoke-Aws @('iam', 'get-role', '--role-name', "$prefijo-despliegue-github") -PermitirFallo) {
            Write-Aviso "Ya existe el rol $prefijo-despliegue-github fuera de la pila: la fundacion fallaria."
        }
    }
    if (-not (Test-PilaUtilizable (Get-Pila (Get-NombreDePlataforma $Configuracion)))) {
        $grupos = Invoke-Aws @('logs', 'describe-log-groups', '--log-group-name-prefix', "/$prefijo/$entorno/api")
        if (@($grupos.logGroups).Count -gt 0) {
            Write-Aviso "Ya existe el grupo de logs /$prefijo/$entorno/api (se conserva al borrar una pila): la plataforma fallaria."
        }
        if (Invoke-Aws @('ssm', 'get-parameter', '--name', "/$prefijo/$entorno/imagen-api") -PermitirFallo) {
            Write-Aviso "Ya existe el parametro /$prefijo/$entorno/imagen-api fuera de la pila: la plataforma fallaria."
        }
    }
    Write-Bien 'Comprobadas las colisiones de nombres'
}

function Invoke-Verificar([System.Collections.IDictionary] $Configuracion) {
    Test-ParidadDelPerfil $Configuracion

    $lint = Get-CfnLint
    if ($lint) {
        & $lint $PlantillaDeFundacion $PlantillaDePlataforma | Out-Host
        if ($LASTEXITCODE -ne 0) { throw 'cfn-lint encontro problemas en las plantillas.' }
        Write-Bien 'cfn-lint sin hallazgos'
    }
    else { Write-Aviso 'cfn-lint no esta instalado: se valida solo con CloudFormation.' }

    Test-Plantilla (Get-OrigenDePlantilla $PlantillaDeFundacion $null 'fundacion') '01-fundacion.yaml'
    $fundacion = Get-Pila $Configuracion.PilaDeFundacion
    $salidas = Get-Salidas $fundacion
    if ((Test-PilaUtilizable $fundacion) -and $salidas.ContainsKey('BucketDePlantillas')) {
        Test-Plantilla (Get-OrigenDePlantilla $PlantillaDePlataforma $salidas.BucketDePlantillas 'plataforma') '02-plataforma.yaml'
    }
    else { Write-Dato '02-plataforma.yaml se validara con CloudFormation cuando exista el bucket de la fundacion.' }

    $oidc = Get-ProveedorOidcExistente
    Write-Dato ("Proveedor OIDC de GitHub: " + $(if ($oidc) { 'ya existe, se reutiliza' } else { 'no existe, lo crea la fundacion' }))
    $cuota = Invoke-Aws @('service-quotas', 'get-service-quota', '--service-code', 'ec2', '--quota-code', 'L-1216C47A') -PermitirFallo
    if ($cuota) {
        $vcpu = [int] $cuota.Quota.Value
        if ($vcpu -lt 8) { Write-Aviso "Cuota de vCPU bajo demanda: $vcpu (hacen falta al menos 8 para desplegar con holgura)." }
        else { Write-Bien "Cuota de vCPU bajo demanda: $vcpu" }
    }
    Test-Colisiones $Configuracion
}

function Invoke-PrepararCorte([System.Collections.IDictionary] $Configuracion) {
    $fundacion = Get-SalidasDeFundacion $Configuracion
    $salud = Test-Salud $Configuracion
    $nueva = $salud.url
    $actual = Get-UrlDeProduccionActual
    $plataforma = Get-Salidas (Get-Pila (Get-NombreDePlataforma $Configuracion))

    $plan = @"
# Plan de corte a RenaserLab — $((Get-Date).ToString('yyyy-MM-dd HH:mm'))

NADA DE ESTO SE HA EJECUTADO. Cada paso necesita autorizacion expresa.

- API actual (la que llevan las apps): $actual
- API nueva en RenaserLab:             $nueva
- Version desplegada en la nueva:      $($salud.version)
- Distribucion nueva:                  $($plataforma['IdDeLaDistribucion'])
- Alertas:                             $($salud.alertas)

## 1. Integracion continua (que main despliegue en RenaserLab)

    gh variable set AWS_ROLE_ARN --body "$($fundacion.ArnDelRolDeDespliegue)"
    gh variable set AWS_PILA_PLATAFORMA --body "$(Get-NombreDePlataforma $Configuracion)"
    gh variable set AWS_REPOSITORIO_ECR --body "$($Configuracion.PrefijoDeRecursos)/api"

Vuelta atras: volver a poner los tres valores anteriores (o borrar las dos
ultimas variables: el flujo vuelve a sus valores por defecto).

## 2. Clientes (elegir una via)

A. Recompilar: EXPO_PUBLIC_API_URL=$nueva en apps/mobile/eas.json (tres perfiles)
   y en las variables de entorno de Vercel; redeplegar la web y publicar
   builds nuevas. Las builds instaladas siguen llamando a $actual hasta que se
   actualicen: la cuenta anterior tiene que seguir viva mientras tanto.

B. Redirigir la distribucion actual: en la cuenta ANTERIOR, cambiar el origen
   de la distribucion de $actual para que apunte a $($plataforma['DominioDeLaDistribucion'])
   (HTTPS). Todos los clientes cambian a la vez, sin recompilar; volver atras
   es devolver el origen. Requiere a quien administra la cuenta anterior.

C. Dominio propio (definitivo): certificado de ACM en us-east-1, parametros
   NombreDeDominio y CertificadoDeCloudFrontArn, y CNAME a
   $($plataforma['DominioDeLaDistribucion']). La proxima mudanza sera un cambio de DNS.

## 3. Antes de cambiar nada

- Confirmar la suscripcion de alertas (estado actual: $($salud.alertas)).
- Decidir BETA_FREE_ACCESS_ENABLED: produccion hoy la tiene encendida; el perfil nuevo la trae apagada.
- Ventana de observacion tras el corte y fecha de retiro de la cuenta anterior.
"@
    $script:Evidencia.pasos.planDeCorte = [ordered]@{ actual = $actual; nueva = $nueva }
    New-Item -ItemType Directory -Force -Path $DirectorioDeEvidencias -WhatIf:$false -Confirm:$false | Out-Null
    $fichero = Join-Path $DirectorioDeEvidencias ("{0}-plan-de-corte.md" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Set-Content -LiteralPath $fichero -Value $plan -Encoding utf8NoBOM -WhatIf:$false -Confirm:$false
    Write-Paso 'Plan de corte'
    Write-Host $plan
    Write-Bien "Escrito en $fichero"
}

# =============================================================================
# Evidencia
# =============================================================================

function Save-Evidencia([string] $Resultado) {
    $script:Evidencia.resultado = $Resultado
    $script:Evidencia.fin = (Get-Date).ToString('o')
    try { $script:Evidencia.commitDelGuion = Get-TextoDeGit @('rev-parse', 'HEAD') } catch { $null = $_ }
    New-Item -ItemType Directory -Force -Path $DirectorioDeEvidencias -WhatIf:$false -Confirm:$false | Out-Null
    $fichero = Join-Path $DirectorioDeEvidencias ("{0}-{1}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $Accion.ToLowerInvariant())
    ConvertTo-Json -InputObject $script:Evidencia -Depth 20 |
        Set-Content -LiteralPath $fichero -Encoding utf8NoBOM -WhatIf:$false -Confirm:$false
    Write-Host "`nEvidencia: $fichero" -ForegroundColor DarkGray
}

# =============================================================================
# Principal
# =============================================================================

$resultadoFinal = 'ERROR'
$fallo = $null
try {
    Test-Prerrequisitos -ConDocker:($Accion -in 'Imagen', 'Todo')
    Write-Paso "Cuenta de destino ($Region)"
    Assert-CuentaEsperada
    $configuracion = Read-Perfil
    $Evidencia.prefijo = $configuracion.PrefijoDeRecursos

    switch ($Accion) {
        'Verificar' { Invoke-Verificar $configuracion }
        'Planificar' {
            Invoke-Verificar $configuracion
            $null = Deploy-Fundacion $configuracion -SoloPlan
            if (Test-PilaUtilizable (Get-Pila $configuracion.PilaDeFundacion)) {
                $null = Deploy-Plataforma $configuracion -SoloPlan
            }
            else { Write-Dato 'La plataforma se planifica cuando exista la fundacion (necesita su bucket e imagenes).' }
        }
        'Fundacion' { $null = Deploy-Fundacion $configuracion }
        'Secretos' { Set-Secretos $configuracion }
        'Imagen' { $null = Publish-Imagen $configuracion }
        'Plataforma' {
            $resultado = Deploy-Plataforma $configuracion
            if ($resultado -in 'CREATE_COMPLETE', 'UPDATE_COMPLETE') { $null = Test-Salud $configuracion }
        }
        'Salud' { $null = Test-Salud $configuracion }
        'Estado' { Show-Estado $configuracion }
        'Renovar' { Invoke-Renovar $configuracion }
        'VolverAtras' { Invoke-VolverAtras $configuracion }
        'PrepararCorte' { Invoke-PrepararCorte $configuracion }
        'Todo' {
            Invoke-Verificar $configuracion
            $fundacion = Deploy-Fundacion $configuracion
            if ($fundacion -notin 'CREATE_COMPLETE', 'UPDATE_COMPLETE', 'SIN_CAMBIOS') { throw 'La fundacion no se aplico: se detiene aqui.' }
            if ($ArchivoDeSecretos) { Set-Secretos $configuracion }
            $etiqueta = Publish-Imagen $configuracion
            if (-not $etiqueta) { throw 'La imagen no se publico: se detiene aqui.' }
            $plataforma = Deploy-Plataforma $configuracion
            if ($plataforma -notin 'CREATE_COMPLETE', 'UPDATE_COMPLETE', 'SIN_CAMBIOS') { throw 'La plataforma no se aplico: se detiene aqui.' }
            $null = Test-Salud $configuracion
        }
    }
    $resultadoFinal = 'OK'
}
catch {
    $fallo = $_
    Write-Host "`nERROR: $($_.Exception.Message)" -ForegroundColor Red
    $Evidencia.error = $_.Exception.Message
}
finally {
    # Solo hay evidencia si se paso la barrera: sin cuenta confirmada no hay
    # nada que contar y no se escribe nada.
    if ($Evidencia.Contains('cuenta')) { Save-Evidencia $resultadoFinal }
}
if ($fallo) { exit 1 }
