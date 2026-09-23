# La API en AWS — arquitectura, coste, despliegue y vuelta atrás

Rama `Edson`, agosto de 2026. Plantillas en `infra/aws/`, workflow en
`.github/workflows/desplegar-aws.yml`.

> **MIGRACIÓN EN CURSO (23/09/2026).** La API se prepara para mudarse a la
> cuenta AWS de RenaserLab con el prefijo `zexcelencia` y el guion
> `infra/aws/deploy-renaserlab.ps1`. El procedimiento vigente, la auditoría y el
> plan de corte están en [`AWS_MIGRACION_RENASERLAB.md`](AWS_MIGRACION_RENASERLAB.md).
> Lo que sigue describe la **cuenta anterior**, donde corre hoy producción:
> sus nombres (`renaser-fundacion`, `renaser/produccion/api`,
> `/renaser/produccion/imagen-api`) son los de esa cuenta. Los comandos del §6
> ya no sirven tal cual: `02-plataforma.yaml` pasa de 51 200 bytes y
> CloudFormation exige subirla a S3, que es lo que hace el guion.
>
> **Estado: DESPLEGADO** (comprobado el 27 de agosto de 2026). La pila esta
> viva en `us-east-1` y sirve a la web publicada. La entrada real es la
> distribucion de CloudFront `https://d33u17ka1rcaax.cloudfront.net`
> (`/health` responde en 0,29-0,66 s medidos).
>
> Buena parte de lo que sigue se escribio ANTES de desplegar y describe cosas
> que ya ocurrieron o que se hicieron de otra forma —en particular, el paso de
> dominio propio + certificado de ACM se salto, y por eso existe CloudFront—.
> Leerlo como historia de la decision, no como estado actual. Lo medido esta en
> [`Z_AUDITORIA_RENDIMIENTO_2026-08.md`](Z_AUDITORIA_RENDIMIENTO_2026-08.md).
>
> **AVISO antes de cambiar de perfil de capacidad:** el fichero de parametros
> tiene que llevar `FrenteHttpsDeEmergencia=Si`. Sin esa clave, CloudFormation
> aplica el valor por defecto ('No') y BORRA la distribucion de CloudFront, que
> es la unica entrada HTTPS y cuyo dominio va dentro de la web y de las builds
> del movil. Una distribucion nueva nace con otro dominio.

---

## 1. Por qué se mueve la API

El dato, medido contra producción el 2026-08-20 y recogido en
[`RENDIMIENTO.md`](RENDIMIENTO.md):

| Situación | Tiempo |
| --- | ---: |
| `GET /health` con el servicio dormido (Render plan Free) | **21,77 s** |
| `GET /health` en caliente | 0,30 s |
| Timeout del móvil | 20 s |

El plan gratuito de Render **duerme** el servicio tras un rato sin tráfico. La
primera persona que abría la app cada mañana esperaba 22 segundos, más de lo que
el móvil aguanta: el primer feed del día fallaba. El problema no es potencia, es
que no había nadie escuchando.

La arquitectura de este documento mantiene siempre al menos una máquina
encendida detrás de un health check, así que **el arranque en frío deja de
existir**. No es un cambio de rendimiento: es un cambio de disponibilidad.

### Lo que NO se mueve

**Supabase se queda entero donde está** (proyecto `jbdlqzimfwyrmmatztqu`):
PostgreSQL, Auth y Storage. Solo se muda el proceso FastAPI de `apps/api`.

Mover la base de datos sería otro proyecto: migración de datos, de las políticas
RLS y de las URLs firmadas del Storage. Ninguna de esas tres cosas tiene que ver
con el arranque en frío, y las tres pueden romper la app. Un cambio a la vez.

---

## 2. Arquitectura

```text
                          Internet
                             │
                       HTTPS │ 443  (certificado de ACM)
                             ▼
              ┌──────────────────────────────┐
              │  Application Load Balancer   │   zona A + zona B
              │  /health cada 15 s           │   siempre encendido
              └──────────────┬───────────────┘
                             │ HTTP 8000
              ┌──────────────┴───────────────┐
              │      Auto Scaling Group      │
              │  ┌────────────┐ ┌──────────┐ │
              │  │ EC2 zona A │ │EC2 zona B│ │   t3.small, Amazon Linux 2023
              │  │  Docker    │ │  Docker  │ │   (la segunda solo en perfil HA)
              │  │  uvicorn   │ │  uvicorn │ │
              │  └────────────┘ └──────────┘ │
              └──────┬─────────────────┬─────┘
                     │                 │
        ┌────────────┘                 └──────────────┐
        ▼                                             ▼
  ECR (imagen)                              Supabase  ── PostgreSQL
  Secrets Manager (claves)                            ── Auth
  SSM Parameter Store (qué versión)                   ── Storage
  CloudWatch (logs, métricas, alarmas)      (SIN CAMBIOS, fuera de AWS)
```

Región **us-east-1 (Norte de Virginia)**, la misma en la que ya vive el pooler
de Supabase (`aws-0-us-east-1.pooler.supabase.com`). Poner la API en otra región
añadiría un salto de ida y vuelta a cada consulta.

### Los ficheros

| Fichero | Qué hace |
| --- | --- |
| `infra/aws/01-fundacion.yaml` | Repositorio ECR, proveedor OIDC de GitHub y rol de despliegue. Se despliega una vez. |
| `infra/aws/02-plataforma.yaml` | VPC, subredes, balanceador, autoescalado, IAM, CloudWatch, alarmas y panel. |
| `infra/aws/parametros/costo-controlado.json` | Perfil económico. |
| `infra/aws/parametros/alta-disponibilidad.json` | Perfil de alta disponibilidad. |
| `.github/workflows/desplegar-aws.yml` | Construir → publicar → repuntar → renovar → probar → volver atrás si falla. |

**Dos pilas y no una**, por tres razones: la plataforma arranca máquinas que al
nacer hacen `docker pull`, así que el repositorio tiene que existir **antes**;
el repositorio y el rol de GitHub no se deben borrar por accidente cuando se
rehace la plataforma; y el proveedor OIDC es único por cuenta de AWS.

**Un solo fichero para los dos perfiles**, no dos plantillas: la capacidad vive
en el `Mapping` `PerfilesDeCapacidad`. Cambiar de perfil es cambiar un
parámetro. Dos plantillas gemelas se desincronizan el día que alguien arregla
una y se olvida de la otra.

---

## 3. Los dos perfiles

| | Costo controlado | Alta disponibilidad |
| --- | --- | --- |
| Mínimo / deseadas / máximo | 1 / 1 / 2 | 2 / 2 / 3 |
| Zonas con máquina | 1 | 2 |
| Tipo de instancia | t3.small | t3.small |
| Métricas cada minuto | no | sí |
| Si se cae una zona de AWS | corte de unos minutos mientras nace otra máquina | no se nota |
| Coste estimado | **≈ 48 USD/mes** | **≈ 74 USD/mes** |

Los dos resuelven el arranque en frío por igual. Lo que compra el perfil caro es
**tolerancia a que se caiga una zona de disponibilidad entera**, un evento raro
pero real. La recomendación es empezar en `costo-controlado`; pasar al otro es
un parámetro y unos 5 minutos.

En ambos, **el máximo es siempre las deseadas + 1**. No es decoración: el
despliegue usa `MinHealthyPercentage=100` con `MaxHealthyPercentage=200` (sin este
segundo, AWS termina primero: medido el 23/09/2026), que levanta la máquina nueva antes de
apagar la vieja. Sin ese hueco libre, AWS tendría que apagar antes de encender y
cada despliegue sería un microcorte.

### Por qué t3.small

Se razonó sobre la carga real (37 perfiles, 26 publicaciones), no sobre un
"por si acaso":

- **La memoria es el límite, no la CPU.** Python 3.13 + FastAPI + SQLAlchemy +
  asyncpg + Pillow ronda 250–400 MB residentes, y Pillow tiene picos al derivar
  imágenes. Con el 1 GiB de un `t3.micro` el margen es de unos cientos de MB: un
  pico concurrente mata el proceso. 2 GiB dan holgura de verdad.
- **La CPU sobra.** Esta API se pasa el tiempo esperando a Supabase; gasta
  procesador en serializar JSON y poco más.
- **El arranque importa.** Es lo que decide cuánto tarda un despliegue y, sobre
  todo, un rollback. Una máquina más pequeña alargaría justo lo que hemos venido
  a arreglar.

Si el tráfico crece, **el salto no es a una máquina más grande**: es subir el
máximo y dejar que el grupo ponga más máquinas iguales. Eso escala y además
tolera fallos; una máquina el doble de grande no hace ni lo uno ni lo otro.

Las t3 corren en modo **`standard`**, no `unlimited`. Con `unlimited`, un bucle
infinito o un ataque generan CPU extra que se factura sin techo. En `standard`
la máquina se frena al agotar los créditos: un problema visible (hay alarma) en
lugar de una factura sorpresa. Hay una alarma vigilando el saldo de créditos.

---

## 4. La decisión del NAT Gateway

**Por defecto no hay NAT Gateway, y es una decisión, no un olvido.**

Las máquinas solo necesitan salir a Internet para tres cosas: bajar la imagen de
ECR, hablar con CloudWatch y Secrets Manager, y llamar a Supabase. Las opciones:

| Opción | Coste/mes | Valoración |
| --- | ---: | --- |
| **Subred pública con IP pública** (elegida) | **3,65 USD por máquina** | Salida por el Internet Gateway, que es gratis. |
| 1 NAT Gateway | 32,85 USD + 0,045 USD/GB | Además, si cae esa zona, las dos se quedan sin salida. |
| 2 NAT Gateway (uno por zona) | 65,70 USD + tráfico | Correcto pero cuesta **más que todas las máquinas juntas**. |
| Endpoints de VPC de tipo interfaz | ~7,30 USD por endpoint y zona | Harían falta 6 (ECR api, ECR dkr, logs, y 3 de SSM) × 2 zonas ≈ **87 USD/mes**. Peor que el NAT. |

Para esta aplicación, un NAT Gateway costaría más que el cómputo que protege.

### El compromiso de seguridad, dicho claro

Con la opción elegida, **cada máquina tiene una IP pública y es enrutable desde
Internet**. Lo que la protege no es la topología de red: es el grupo de
seguridad.

- La única regla de entrada permite el puerto 8000 **desde el grupo de seguridad
  del balanceador**, no desde un rango de IPs. Nada más entra.
- **No hay puerto 22.** No hay clave SSH que perder, rotar ni compartir. Para
  entrar a depurar se usa **SSM Session Manager**, que no necesita puerto
  abierto y deja la sesión registrada en CloudTrail.
- La salida también está acotada: 443, los dos puertos del pooler de Supabase
  (5432 y 6543) y DNS. Nada más.
- Se añade un **endpoint de S3 de tipo Gateway** (gratis) para que las capas de
  las imágenes de ECR, que viven en S3, no salgan a Internet.

**Dónde está el riesgo real:** en que alguien añada una regla de entrada
demasiado abierta. En una red privada, una regla mal puesta no llega a
exponerse; aquí sí. Es un riesgo de *proceso*, y se mitiga revisando los cambios
del grupo de seguridad en el changeset de CloudFormation.

**Cuándo cambiar de opinión:** si la app empieza a manejar datos que obliguen a
cumplir una norma que exija red privada, o si el presupuesto deja de ser el
factor. Entonces se pone `NumeroDeNatGateways` a `1` o `2` y las máquinas se van
a las subredes privadas, **que ya están creadas** y esperando en la plantilla.
Es un parámetro, no una reescritura.

---

## 5. Coste mensual estimado

> **Precios**: tarifa bajo demanda de **us-east-1**, tomados de las páginas
> públicas de precios de AWS (EC2, EBS, ELB, ECR, CloudWatch, Secrets Manager,
> VPC). **Última verificación: mayo de 2026.** Cálculo hecho el **2026-08-25**
> sobre 730 h/mes.
>
> **Verifica los números con la [Calculadora de Precios de AWS](https://calculator.aws)
> antes de comprometer presupuesto.** AWS cambia tarifas y los precios de aquí
> son una estimación de orden de magnitud, no un presupuesto cerrado.

### Perfil costo controlado — 1 máquina

| Servicio | Detalle | USD/mes |
| --- | --- | ---: |
| EC2 | 1 × t3.small bajo demanda (0,0208 USD/h) | 15,18 |
| EBS | 20 GiB gp3 (0,08 USD/GB) | 1,60 |
| IPv4 pública | 1 IP en la instancia (0,005 USD/h) | 3,65 |
| ALB — horas | 0,0225 USD/h | 16,43 |
| ALB — IPv4 | 2 IPs, una por zona | 7,30 |
| ALB — LCU | tráfico bajo, parte variable | ~1,50 |
| ECR | ~4 GB de imágenes (0,10 USD/GB) | 0,40 |
| CloudWatch Logs | ~1 GB de ingesta + retención 30 días | 0,53 |
| CloudWatch métricas | memoria y disco del agente (2 × 0,30) | 0,60 |
| CloudWatch alarmas | 6 alarmas — las 10 primeras son gratis | 0,00 |
| CloudWatch panel | 1 panel — los 3 primeros son gratis | 0,00 |
| Secrets Manager | 1 secreto | 0,40 |
| S3 | logs de acceso del ALB, caducan a 30 días | 0,03 |
| SSM Parameter Store | nivel estándar | 0,00 |
| VPC, subredes, SG, IGW, endpoint S3 | | 0,00 |
| ACM | certificado público | 0,00 |
| Salida de datos | primeros 100 GB/mes gratis | 0,00 |
| **Total** | | **≈ 47,62** |

### Perfil alta disponibilidad — 2 máquinas

| Servicio | Detalle | USD/mes |
| --- | --- | ---: |
| EC2 | 2 × t3.small | 30,36 |
| EBS | 2 × 20 GiB gp3 | 3,20 |
| IPv4 pública | 2 IPs en instancias | 7,30 |
| EC2 monitorización detallada | 2 × ~2,10 (métricas cada minuto) | 4,20 |
| ALB — horas | | 16,43 |
| ALB — IPv4 | | 7,30 |
| ALB — LCU | | ~2,00 |
| ECR | | 0,40 |
| CloudWatch Logs | 2 máquinas | 0,75 |
| CloudWatch métricas | agente en 2 máquinas | ~1,20 |
| CloudWatch alarmas y panel | dentro de la capa gratuita | 0,00 |
| VPC Flow Logs | activados en este perfil, solo tráfico rechazado | 0,30 |
| Secrets Manager | | 0,40 |
| S3 | | 0,05 |
| **Total** | | **≈ 73,89** |

### Cómo bajarlo

| Palanca | Ahorro | Contrapartida |
| --- | ---: | --- |
| Savings Plan de cómputo, 1 año sin pago inicial | ~28 % del EC2 (4–9 USD/mes) | Compromiso de 12 meses. |
| Pasar a Graviton (`t4g.small`) | ~20 % del EC2 (~3 USD/mes por máquina) | Hay que construir la imagen para ARM64. Las ruedas de Pillow y asyncpg existen para ARM; el `Dockerfile` no cambia, pero sí el workflow. |
| Apagar los logs de acceso del ALB | 0,03 USD/mes | No merece la pena: se pierde la única forma de reconstruir un incidente. |
| Apagar la monitorización detallada en HA | 4,20 USD/mes | El autoescalado reacciona en 5 minutos en vez de en 1. |

### La comparación honesta con Render

Hay que decirlo con todas las letras: **si el único problema fuera el arranque
en frío, el plan de pago más barato de Render lo resuelve por del orden de
7 USD/mes** (verificar en `render.com/pricing`), sin tocar nada de lo que hay
aquí. Serían unos 40 USD/mes menos.

Lo que se compra por esos ~48 USD y no se puede comprar en el plan barato de
Render:

- Dos zonas de disponibilidad y autoescalado real.
- Infraestructura como código: la plataforma entera se puede borrar y rehacer
  desde este repositorio.
- Red propia y control del grupo de seguridad.
- Observabilidad nativa: logs, métricas de memoria, alarmas por correo y panel.
- Rollback de 3 minutos a cualquiera de las 10 versiones anteriores.
- Nada de dormirse nunca, por decisión de nadie más.

**Es una decisión de negocio, no técnica.** Se documenta para que se tome con el
número delante, no para empujar en una dirección.

---

## 6. Pasos manuales que necesita una persona

Estos pasos **no los puede hacer una plantilla**. Van en orden.

### 1 · Cuenta y cuotas

Cuenta de AWS con permisos de administrador para quien despliega, y región
**us-east-1**. Comprobar la cuota de vCPU bajo demanda (`Running On-Demand
Standard instances`): hacen falta al menos 8, y las cuentas nuevas a veces
vienen con menos. Si está baja, se pide aumento en Service Quotas y **tarda**;
mejor descubrirlo ahora que en mitad del despliegue.

### 2 · Pila de fundación

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name renaser-fundacion \
  --template-file infra/aws/01-fundacion.yaml \
  --capabilities CAPABILITY_NAMED_IAM
```

Si falla con `EntityAlreadyExists` sobre el proveedor OIDC, es que la cuenta ya
lo tiene. Se comprueba con `aws iam list-open-id-connect-providers` y se repite
añadiendo `--parameter-overrides CrearProveedorOidc=No
ArnDelProveedorOidcExistente=<el ARN que salga>`.

### 3 · Dominio y certificado

1. Decidir el subdominio de la API (por ejemplo `api.renaser.com`).
2. Pedir el certificado **en us-east-1** (ACM > Request > Public), validación por
   DNS.
3. Crear en el proveedor de DNS el registro CNAME que pide ACM y esperar a que
   el certificado pase a `Issued`.
4. Guardar el ARN: es el parámetro `CertificadoAcmArn`.

Sin certificado la plataforma se despliega igual, pero **solo escucha en HTTP**,
y por HTTP los tokens de Supabase viajan en claro. Eso vale para la prueba de
humo del primer día y para nada más.

### 4 · El secreto

**No lo crea la plantilla, a propósito**: si lo creara, cada actualización de la
pila correría el riesgo de pisar las claves de producción con un valor de
relleno. Se crea una vez, a mano.

```bash
# El fichero se escribe, se usa y se BORRA. Pasar las claves por la linea de
# comandos las deja en el historial del shell.
cat > /tmp/secreto.json <<'FIN'
{
  "DATABASE_URL": "postgresql+asyncpg://postgres.jbdlqzimfwyrmmatztqu:...@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
  "SUPABASE_URL": "https://jbdlqzimfwyrmmatztqu.supabase.co",
  "SUPABASE_ANON_KEY": "...",
  "SUPABASE_SERVICE_ROLE_KEY": "...",
  "SUPABASE_JWT_SECRET": "..."
}
FIN

aws secretsmanager create-secret \
  --region us-east-1 \
  --name renaser/produccion/api \
  --description "Claves de Supabase para la API de RENASER" \
  --secret-string file:///tmp/secreto.json

shred -u /tmp/secreto.json 2>/dev/null || rm -f /tmp/secreto.json
```

Los valores son los mismos que hoy están en el panel de Render (Environment).
Las claves **no se copian a ningún fichero del repositorio**; las máquinas las
leen de Secrets Manager al arrancar y las dejan en `/etc/renaser/api.env` con
permisos 600, que solo puede leer root.

Rotación: Secrets Manager sabe rotar solo, pero la rotación automática exige que
algo actualice también Supabase. Mientras eso no exista, se rota a mano
(`put-secret-value` + renovar instancias) y se anota la fecha.

### 5 · La primera imagen

El grupo de autoescalado no puede arrancar contra un repositorio vacío. La
primera imagen se sube a mano; a partir de ahí lo hace el workflow.

```bash
CUENTA=$(aws sts get-caller-identity --query Account --output text)
REGISTRO="$CUENTA.dkr.ecr.us-east-1.amazonaws.com"

aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin "$REGISTRO"

docker build -t "$REGISTRO/renaser/api:latest" apps/api
docker push "$REGISTRO/renaser/api:latest"
```

### 6 · La plataforma

Primero, **rellenar en el fichero de parámetros** los dos valores que salen
vacíos: `CertificadoAcmArn` (paso 3) y `CorreoDeAlertas` (a quién avisan las
alarmas). Van en el fichero y no en la línea de comandos para que quede escrito
con qué configuración se desplegó.

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name renaser-plataforma-produccion \
  --template-file infra/aws/02-plataforma.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides file://infra/aws/parametros/costo-controlado.json
```

> `--parameter-overrides file://` con el formato `ParameterKey`/`ParameterValue`
> lo entiende la **AWS CLI v2**. Si la versión instalada se queja, la
> alternativa que funciona en cualquier versión es pasar la lista suelta:
>
> ```bash
> --parameter-overrides $(jq -r '.[] | "\(.ParameterKey)=\(.ParameterValue)"' \
>     infra/aws/parametros/costo-controlado.json | tr '\n' ' ')
> ```
>
> (Ojo: esa forma se traga los valores vacíos; para los parámetros que se dejen
> en blanco, quitarlos de la lista y dejar que se aplique el valor por defecto.)

El nombre de la pila **tiene que empezar por `renaser-`**: el rol de despliegue
de GitHub solo puede leer las salidas de pilas con ese prefijo.

Tarda entre 5 y 10 minutos. La pila **espera a que una máquina diga "mi API
responde"** antes de darse por buena; si no lo dice en 15 minutos, revierte
sola.

Si algo falla y hace falta ver por qué, `--disable-rollback` deja los recursos en
pie para poder entrar por Session Manager y leer
`/var/log/renaser-arranque.log`, que dice la línea exacta que se rompió.

### 7 · GitHub

En **Settings > Secrets and variables > Actions > Variables**, crear la variable
de repositorio `AWS_ROLE_ARN` con la salida `ArnDelRolDeDespliegue` de la pila de
fundación. Es una variable y no un secreto porque un ARN no abre nada sin un
token OIDC del repositorio autorizado.

### 8 · Confirmar el correo de alertas

AWS envía un correo de confirmación de la suscripción SNS. **Mientras no se
acepte, las alarmas no avisan a nadie.**

### 9 · Apuntar el DNS

Crear en el proveedor de DNS un CNAME del subdominio de la API al valor de la
salida `DnsDelBalanceador`. Si el dominio está en Route 53, mejor un registro
ALIAS usando también `ZonaHostedDelBalanceador`.

### 10 · Cambiar el cliente

Apuntar la app móvil y la web a la URL nueva, y revisar que `CorsOrigins`
incluya los dominios reales de la web. Con `ENVIRONMENT=production` la API
**rechaza el comodín `*`** (ver `config.py`): si la lista está mal, la web deja
de cargar con un error de CORS. La app móvil no se ve afectada, porque CORS solo
lo aplican los navegadores.

### 11 · Render

**No apagar Render el mismo día.** Dejarlo unos días como red de seguridad: es
el plan de vuelta atrás más rápido que hay (nivel 3 del apartado siguiente).
Cuando la API en AWS lleve una semana tranquila, se apaga.

---

## 7. Vuelta atrás

Tres niveles, del más rápido al más drástico.

### Nivel 1 — la versión de la aplicación (≈ 3 minutos)

Es el caso normal: se desplegó código malo y hay que volver al anterior.

**Por el workflow:** Actions > "Desplegar API en AWS" > *Run workflow* >
`etiqueta_para_volver_atras` = la etiqueta anterior (por ejemplo `sha-a1b2c3d`).
No construye nada: comprueba que la imagen existe, repunta el parámetro y
renueva las máquinas.

**A mano**, si GitHub no está disponible:

```bash
# Ver el historial de versiones: cada valor es una imagen que sigue en ECR.
aws ssm get-parameter-history --region us-east-1 \
  --name /renaser/produccion/imagen-api \
  --query 'Parameters[*].[LastModifiedDate,Value]' --output table

aws ssm put-parameter --region us-east-1 \
  --name /renaser/produccion/imagen-api \
  --type String --value sha-a1b2c3d --overwrite

aws autoscaling start-instance-refresh --region us-east-1 \
  --auto-scaling-group-name renaser-api-produccion \
  --preferences '{"MinHealthyPercentage":100,"MaxHealthyPercentage":200,"InstanceWarmup":300}'
```

Esto funciona así porque **la versión desplegada vive en un parámetro de SSM, no
en la plantilla**. Volver atrás no toca infraestructura: se cambia una cadena de
texto y se renuevan las máquinas.

El alcance del rollback son las **10 últimas imágenes etiquetadas** (regla de
ciclo de vida de ECR). Diez despliegues de margen.

**El workflow ya hace esto solo** cuando un despliegue falla o cuando la prueba
de humo no pasa. Y durante todo el proceso la versión anterior sigue sirviendo,
porque la máquina nueva solo sustituye a la vieja después de pasar el health
check.

### Nivel 2 — la infraestructura (5–15 minutos)

Se cambió la plantilla y salió mal.

- **Si el `deploy` falla**, CloudFormation revierte solo a la versión anterior de
  la pila. No hay que hacer nada.
- **Si el `deploy` "funcionó" pero rompió algo**, se vuelve a desplegar la
  plantilla del commit anterior:

  ```bash
  git checkout <commit-bueno> -- infra/aws/02-plataforma.yaml
  aws cloudformation deploy --region us-east-1 \
    --stack-name renaser-plataforma-produccion \
    --template-file infra/aws/02-plataforma.yaml \
    --capabilities CAPABILITY_IAM \
    --parameter-overrides file://infra/aws/parametros/costo-controlado.json
  ```

- **Si la pila se queda atascada** en `UPDATE_ROLLBACK_FAILED`:
  `aws cloudformation continue-update-rollback --stack-name ...`, y si insiste,
  el mismo comando con `--resources-to-skip <recurso>`.

Antes de cualquier cambio de infraestructura, mirar el changeset:

```bash
aws cloudformation deploy ... --no-execute-changeset
```

Presta especial atención a los cambios que digan **Replacement: True** y a
cualquier modificación del grupo de seguridad.

### Nivel 3 — volver a Render (minutos)

El plan de emergencia de verdad. El servicio de Render **sigue existiendo** y
`render.yaml` sigue en el repositorio: se vuelve apuntando el DNS (o la URL del
cliente) otra vez a Render. Vuelve el arranque en frío de 22 s, pero la app
funciona.

Por eso el paso manual 11 dice que no se apague Render el primer día.

---

## 8. Los cinco pilares del Well-Architected

**Excelencia operativa.** Toda la infraestructura es código versionado en este
repositorio. Los despliegues son automáticos, reproducibles y con vuelta atrás
automática. Cada máquina deja su arranque en `/var/log/renaser-arranque.log` y
los logs del contenedor van a CloudWatch. Hay un panel con las cuatro cosas que
importan y alarmas que avisan por correo. El acceso de emergencia es Session
Manager, con la sesión registrada.

**Seguridad.** OIDC en lugar de claves permanentes. IAM de privilegio mínimo en
las tres identidades (máquinas, CI, flow logs), acotado por ARN concreto siempre
que la API de AWS lo permite, y con condiciones (`kms:ViaService`,
`cloudwatch:namespace`) donde no lo permite. Las máquinas solo pueden **leer** de
ECR: no pueden publicar una imagen. Secretos en Secrets Manager, nunca en el
repositorio, con permisos 600 en disco. IMDSv2 obligatorio y **límite de un
salto**, así que el contenedor no puede leer credenciales de AWS ni aunque
comprometan la app. Sin puerto 22 y sin clave SSH. Discos cifrados. TLS 1.2+.
Contenedor en solo lectura y sin escalada de privilegios. Salida de red acotada
a lo necesario. Escaneo de vulnerabilidades en cada imagen.

**Fiabilidad.** Dos zonas de disponibilidad. Health checks reales (`/health`, no
"¿responde el hardware?"). Reemplazo automático de máquinas enfermas. Despliegue
sin corte y rollback en 3 minutos. Alarma de "no queda ninguna máquina sana" que
salta también cuando dejan de llegar datos, que es justo cuando peor sería
callarse. La base de datos sigue en Supabase, con sus propias copias de
seguridad.

**Eficiencia del rendimiento.** El objetivo era matar 21,77 s de arranque en
frío y se mata teniendo siempre algo encendido. Dos políticas de escalado, y no
una: esta API se pasa el tiempo **esperando** a Supabase, así que puede quedarse
sin capacidad de atender con la CPU al 20 %; una política que solo mirase el
procesador no escalaría nunca. Se mide también el percentil 95, no la media,
porque la media la tapa el tráfico bueno. Endpoint de S3 para que las descargas
de ECR no den la vuelta por Internet. Misma región que el pooler de Supabase.

**Optimización de costes.** Sin NAT Gateway, con el razonamiento y las
alternativas medidas en el apartado 4. Tamaño de instancia elegido sobre la
carga real. Créditos de CPU en modo `standard` para que no haya facturas
sorpresa. Retención de logs a 30 días, porque sin retención se guardan para
siempre. Ciclo de vida en ECR y caducidad en los logs de acceso. Métricas
detalladas solo en el perfil que las aprovecha. Endpoint de S3 gratis en lugar
de tráfico de pago. Alarmas y panel dentro de la capa gratuita permanente. Y,
sobre todo, la comparación honesta con Render en el apartado 5.

---

## 9. Lo que esto NO incluye

Dicho para que nadie lo dé por hecho:

- **WAF.** Unos 5–8 USD/mes más reglas. Vale la pena el día que haya abuso real
  o formularios públicos sin autenticar.
- **CloudFront como caché.** No aporta: la media pesada la sirve el CDN de
  Supabase, no esta API. (CloudFront SÍ está, pero como frente HTTPS sin caché:
  ver el aviso del principio y `FrenteHttpsDeEmergencia`.)
- **Route 53.** El DNS se queda donde esté hoy. Que dos sistemas se peleen por
  un registro DNS es una caída garantizada.
- **Copias de seguridad de la base de datos.** Son de Supabase y siguen siendo
  de Supabase.
- **Multi-región.** Sería otro orden de magnitud de coste y complejidad.
- **ffmpeg en el contenedor.** Sigue fuera a propósito, por lo que explica el
  comentario del `Dockerfile`: el póster ya lo genera el teléfono al subir y
  `scripts/procesar_media.py` para el contenido antiguo. Con máquinas de verdad
  ya se *podría* reponer, pero es otra decisión y otro cambio.
- **Entorno de staging.** La plantilla lo soporta (`Entorno=staging`) pero no se
  ha desplegado. Duplicaría el coste.

---

## 10. Borrarlo todo

```bash
# 1. Quitar la proteccion contra borrado del balanceador (si no, el borrado
#    falla). Se cambia ProteccionContraBorrado a "No" en el fichero de
#    parametros y se vuelve a desplegar.
aws cloudformation deploy --region us-east-1 \
  --stack-name renaser-plataforma-produccion \
  --template-file infra/aws/02-plataforma.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides file://infra/aws/parametros/costo-controlado.json

# 2. Borrar la plataforma.
aws cloudformation delete-stack --region us-east-1 \
  --stack-name renaser-plataforma-produccion

# 3. La fundacion, solo si de verdad se abandona AWS.
aws cloudformation delete-stack --region us-east-1 --stack-name renaser-fundacion
```

Sobreviven a propósito, con `DeletionPolicy: Retain`: el **repositorio ECR** (las
imágenes son el plan B de un rollback), el **bucket de logs de acceso** (la única
prueba de lo que pasó), y el **grupo de logs de la API**. Se borran a mano cuando
alguien decida que ya no hacen falta.

El **secreto** de Secrets Manager tampoco se borra, porque nunca lo creó la
plantilla. `aws secretsmanager delete-secret --force-delete-without-recovery` si
se quiere ir del todo.

---

## 11. Validación hecha

Sin credenciales de AWS y sin crear ni un recurso:

| Comprobación | Resultado |
| --- | --- |
| `cfn-lint 1.55.1` sobre `01-fundacion.yaml` | 0 errores, 0 avisos |
| `cfn-lint 1.55.1` sobre `02-plataforma.yaml` | 0 errores, 0 avisos |
| Ídem con `--include-experimental --include-checks I` | 0 hallazgos |
| Ídem con cada uno de los dos ficheros de parámetros | 0 hallazgos |
| `actionlint 1.7.12` sobre `desplegar-aws.yml` | 0 hallazgos |
| Claves de los ficheros de parámetros contra los `Parameters` de la plantilla | coinciden, sin sobrantes |
| Invariantes de los perfiles (min ≤ deseadas ≤ máximo, hueco para el despliegue) | correctos en los dos |

Lo que **no** se puede validar sin desplegar, y por tanto hay que mirar el
primer día: que el `UserData` arranque limpio de principio a fin en una máquina
real, que Supabase acepte las conexiones desde la IP de salida nueva, y el
consumo real de LCU del balanceador.

---

## 12. Referencias

- [`RENDIMIENTO.md`](RENDIMIENTO.md) — de dónde salen los 21,77 s.
- [`ARQUITECTURA.md`](ARQUITECTURA.md) — la arquitectura general del producto.
- `render.yaml` — lo que hay hoy, y a lo que se vuelve en el nivel 3.
- `infra/aws/*.yaml` — las plantillas, comentadas línea a línea con el porqué de
  cada decisión.
