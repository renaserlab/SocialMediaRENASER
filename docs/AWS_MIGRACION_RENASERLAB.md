# Migración de la API a la cuenta AWS de RenaserLab

Rama `Edson`, 23 de septiembre de 2026. Plantillas en `infra/aws/`, guion en
`infra/aws/deploy-renaserlab.ps1`.

> **Estado (23/09/2026, 19:27): RENASERLAB ES PRODUCCIÓN. LA CUENTA ANTERIOR
> SE DIO DE BAJA.** La cuenta de Ricardo se cerró al agotarse sus créditos, que
> es el motivo de esta migración. El PR #2 está fusionado y `main` despliega en
> RenaserLab: las variables de GitHub apuntan allí y el primer despliegue
> (`sha-c85a1d3`) salió sin corte. La web de Vercel ya usa la API nueva. **Las
> apps móviles repartidas siguen apuntando a la API vieja** y solo se arreglan
> con una build nueva. Las vías B y la vuelta atrás a la cuenta anterior de §7 y
> §8 ya no existen. Ver §13.

---

## 1. Qué se mueve y qué no

Solo se muda el **proceso de la API** (FastAPI en `apps/api`) y la
infraestructura que lo sirve. Los datos no están en AWS:

| Dónde vive | Qué | ¿Se migra? |
| --- | --- | --- |
| Supabase (`jbdlqzimfwyrmmatztqu`) | PostgreSQL, Auth, Storage (fotos, vídeos, avatares) | **No.** Las dos APIs, la vieja y la nueva, hablan con la misma base. |
| ECR de la cuenta anterior | Imágenes de la API | No se copian: se **reconstruyen** desde el commit, con la misma etiqueta `sha-<commit>`. |
| Secrets Manager de la cuenta anterior | Claves de Supabase | No se copian (no hay acceso a esa cuenta): se **cargan** desde un fichero local. |
| SSM de la cuenta anterior | El puntero a la versión desplegada | Se recrea con la pila. |
| CloudWatch y S3 de la cuenta anterior | Registros y logs de acceso del balanceador | No. Son historial de la cuenta anterior y caducan solos (30 días). |

**No hay datos persistentes dentro de AWS.** La API no escribe en S3, las
máquinas no guardan nada (el contenedor es de solo lectura y `/tmp` es
memoria) y no hay tareas de fondo que arranquen solas: comprobado en el código
que corre en producción (`c45bf93`), el trabajo en segundo plano solo nace de
una petición. Por eso **dos APIs en paralelo contra la misma base no se pisan**
mientras la nueva no reciba tráfico.

> **Cuidado durante la fase en paralelo:** la API nueva escribe en la base
> **de producción**. Las pruebas contra la URL temporal tienen que ser de
> lectura (lo son las del guion) o con una cuenta de prueba acordada.

---

## 2. Lo que se encontró en la cuenta de RenaserLab

Leído el 23/09/2026, sin crear nada:

- **La cuenta es compartida.** Viven en ella otros productos de RenaserLab:
  tres instancias EC2 (`renaser-backend`, `renaser-crm`, `renaser-ai-engine`),
  parámetros de SSM `/renaser/prod/*` y `/renaser/pruebas/*` —varios
  `SecureString` con contraseñas de base de datos y claves de API—, roles
  `renaser-*`, un tema SNS `renaser-alertas`, una distribución de CloudFront y
  el bucket `renaser90dias-prod`. **Ninguna pila de CloudFormation.**
- **El proveedor OIDC de GitHub ya existe** (lo creó otro producto). La
  fundación lo reutiliza; no crea otro ni lo toca.
- **No hay dominio, ni certificados de ACM, ni zonas de Route 53.**
- Solo la VPC por defecto; el rango `10.20.0.0/16` de la plantilla no choca.
- Cuota de vCPU bajo demanda: 16 (hacen falta 4 como mucho).
- La lista de prefijos de CloudFront en `us-east-1` es la misma que en la
  cuenta anterior; el guion la lee de la cuenta en cada despliegue.

### La consecuencia más importante: el prefijo

Las plantillas usaban el prefijo `renaser`, y el rol de despliegue de GitHub se
acotaba **por prefijo**: `ssm:PutParameter` y `ssm:GetParameter` sobre
`parameter/renaser/*`. En esta cuenta eso incluía `/renaser/prod/DB_PASSWORD`
y el resto de la configuración de otros productos. Un workflow de este
repositorio habría podido leerla y sobrescribirla.

Corregido de dos formas, y las dos hacen falta:

1. Z Excelencia usa su propio prefijo, **`zexcelencia`** (pilas
   `zexcelencia-fundacion` y `zexcelencia-plataforma-produccion`, secreto
   `zexcelencia/produccion/api`, repositorio `zexcelencia/api`).
2. El rol de GitHub ya no tiene el comodín sobre el prefijo: solo puede mover
   `/<prefijo>/*/imagen-api`, que es lo único que necesita.

---

## 3. Auditoría de lo que había

| Recurso | Plantilla | Finalidad | Coste | Tolerancia a fallos | Riesgo encontrado | Acción |
| --- | --- | --- | --- | --- | --- | --- |
| ECR | 01 | Imágenes y alcance del rollback | variable, céntimos | regional | Etiquetas mutables y `latest` movible | **Corregido**: inmutable, sin `latest` |
| Proveedor OIDC | 01 | GitHub sin claves | gratis | global | Ya existe en la cuenta | **Parametrizado**: se reutiliza |
| Rol de GitHub | 01 | Publicar y renovar | gratis | global | Comodín sobre todo el prefijo | **Corregido**: solo su puntero |
| Bucket de plantillas | 01 (nuevo) | Plantillas de más de 51 200 bytes | céntimos | regional | `02-plataforma.yaml` pesa 80 KB: el `deploy` documentado **no funcionaba** | **Añadido** |
| VPC, subredes, IGW, rutas | 02 | Red en 2 zonas | gratis | 2 AZ | — | Conservar |
| NAT Gateway (0/1/2) | 02 | Salida desde red privada | fijo, 33 USD cada uno | 1 o 2 AZ | — | Conservar en 0 (ver §5) |
| Endpoint de S3 | 02 | Capas de ECR sin salir | gratis | regional | — | Conservar |
| Flow Logs | 02 | Investigar incidentes de red | variable | — | — | Conservar: solo en alta disponibilidad |
| Balanceador | 02 | Entrada y salud | **fijo**, ~24 USD | 2 AZ | Cualquier distribución de CloudFront, **también la de un tercero**, podía usarlo como origen | **Corregido**: cabecera secreta (§4) |
| Grupo de destino | 02 | `/health` cada 15 s | — | — | — | Conservar |
| Autoescalado y plantilla de arranque | 02 | Máquinas con Docker | fijo por máquina | 1 o 2 AZ | — | Conservar |
| Secrets Manager | fuera | Claves de Supabase | fijo, 0,40 USD | regional | Se creaba a mano con `bash` | **Guion**, con validación |
| Puntero de SSM | 02 | Versión desplegada | gratis | regional | Nacía en `latest` | **Corregido**: nace en `sha-<commit>` |
| CloudWatch (logs, alarmas, panel) | 02 | Observabilidad | variable, ~1 USD | regional | Umbrales fijos | **Parametrizados** los dos clave |
| SNS | 02 | Avisos por correo | gratis | regional | Nadie comprobaba si se confirmó | **Guion**: detecta `PendingConfirmation` |
| Bucket de logs del ALB | 02 | Reconstruir incidentes | céntimos | regional | — | Conservar |
| CloudFront | 02 | HTTPS sin dominio | ~0 (capa gratuita) | global | Su nombre cambia con la cuenta: mudarse obliga a recompilar | **Parametrizado** el dominio propio |
| Barrera de cuenta | 01 y 02 (nueva) | No desplegar en otra cuenta | gratis | — | No existía | **Añadida y probada** |

### Referencias a la cuenta anterior

| Coincidencia | Dónde | Clasificación | Qué se hizo |
| --- | --- | --- | --- |
| Rol `arn:aws:iam::<cuenta anterior>:role/renaser-despliegue-github` | Variable `AWS_ROLE_ARN` de GitHub | **Operativa, cambia en el corte** | No se toca hasta autorizarlo (§7) |
| `renaser-plataforma-produccion`, `renaser/api` | `desplegar-aws.yml` | **Operativa, cambia en el corte** | Ahora son variables de GitHub con esos valores por defecto |
| `https://d33u17ka1rcaax.cloudfront.net` | `apps/mobile/eas.json` (3 perfiles) y variables de Vercel | **Operativa, cambia en el corte** | No se toca hasta autorizarlo (§7) |
| Mismo dominio | `docs/AWS_DESPLIEGUE.md`, `docs/Z_AUDITORIA_RENDIMIENTO_2026-08.md` | Documentación histórica | Se conserva |
| Nombre DNS del balanceador anterior | Comentario de `02-plataforma.yaml` | Documentación histórica | Sustituido por un marcador |
| `renaser-fundacion`, `renaser/produccion/api`, `/renaser/produccion/imagen-api` | `docs/AWS_DESPLIEGUE.md` | Documentación histórica (cuenta anterior) | Se conserva, con aviso al principio |
| `renaser-fundacion`, `renaser/produccion/api` | Perfiles `parametros/*.json` | **Operativa** | Cambiado a `zexcelencia` |
| `pl-3b927c52` | Perfiles | Identificador **público de AWS** para `us-east-1`, igual en las dos cuentas | Se conserva; el guion lo lee de la cuenta |
| `127311923021` y otros | Mapping `CuentaDeLogsDeElb` | Cuentas **publicadas por AWS** para escribir logs del ALB | Se conserva |
| `jbdlqzimfwyrmmatztqu` | Varios | Supabase, **no es de AWS** | No cambia |

En el backend y en el código del móvil no hay ningún identificador de AWS
escrito: la URL entra por `EXPO_PUBLIC_API_URL` en el momento de compilar.

---

## 4. Seguridad: lo que cambió y el riesgo que queda

**Barrera de cuenta, en dos capas.**

1. El guion ejecuta `aws sts get-caller-identity` antes de cualquier otra
   llamada y se detiene si la cuenta no es `ExpectedAccountId` (o
   `$env:RENASERLAB_AWS_ACCOUNT_ID`). Probado: con una cuenta falsa sale con
   código 1 y no escribe nada.
2. Las dos plantillas tienen el parámetro `ExpectedAccountId`, sin valor por
   defecto, y un recurso `BarreraExpectedAccountId` que solo existe si coincide
   con `AWS::AccountId`. Del que depende todo lo demás. **Probado contra la
   cuenta:** con una cuenta falsa, `create-change-set` falla en el acto y no
   crea ni la pila; con la buena, el plan pasa.

   Se probó antes la forma «de manual», una regla en `Rules`, y **dejó crear el
   plan con la cuenta falsa**. No se usa. `test_infraestructura_aws.py` impide
   sustituir la barrera por una que no se haya comprobado.

**La cabecera de origen.** Con `SoloDesdeCloudFront`, el balanceador acepta las
IPs de CloudFront, y CloudFront es de todos: cualquiera puede crear una
distribución con nuestro balanceador como origen. No expone tokens en claro,
porque esa distribución también obliga a HTTPS, pero se salta lo que un día se
ponga delante (límites, WAF, registros).

Ahora CloudFront añade `X-Origen-Verificado` con un valor aleatorio de 256 bits
que vive en el secreto (`CLOUDFRONT_ORIGIN_SECRET`), y el balanceador responde
403 a lo que llega sin ella.

**El riesgo que queda:** es un secreto estático y compartido. Quien pueda leer
la configuración de la distribución o del balanceador en esta cuenta lo ve, y
no caduca solo. La solución sin secreto es un *origen de VPC* de CloudFront con
el balanceador interno. Se deja para cuando haya dominio, porque cambia el
esquema del balanceador y eso lo reemplaza.

**Rotar la cabecera** (solo si se sospecha una fuga, en horas tranquilas):

1. Poner un valor nuevo en `CLOUDFRONT_ORIGIN_SECRET` con `-Accion Secretos`.
2. `-Accion Plataforma` con `VerificarCabeceraDeOrigen=No` en el perfil.
   CloudFormation solo vuelve a leer un secreto cuando cambia el recurso que lo
   usa, y así lo cambia.
3. `-Accion Plataforma` con `Si` otra vez.

Entre los pasos 2 y 3 sigue la protección de la lista de prefijos. En el paso 3
puede haber unos minutos de 403 en algunos puntos de CloudFront mientras la
distribución propaga el valor nuevo.

**Lo demás que ya estaba bien y se conserva:**

- OIDC sin claves en GitHub.
- IMDSv2 obligatorio con un salto, así que el contenedor no llega a las
  credenciales.
- EBS cifrado.
- S3 cifrado, sin acceso público y solo por TLS.
- Sin puerto 22: la entrada de emergencia es Session Manager.
- Contenedor de solo lectura y sin escalada de privilegios.
- Salida de red acotada.
- Secretos leídos al arrancar, en un fichero `600`.
- Escaneo de la imagen al subirla. El guion enseña el resultado y avisa si hay
  CRÍTICAS.

**Lo que el guion protege además:**

- No carga un fichero de secretos que esté versionado o que git no ignore.
- Rechaza valores de ejemplo, saltos de línea y claves que fija la plantilla.
- Rechaza cualquier bandera de dinero encendida.
- Nunca imprime un valor: en la consola y en la evidencia solo salen nombres de
  claves.

---

## 5. Perfiles y coste

| | Costo controlado | Alta disponibilidad |
| --- | --- | --- |
| Máquinas (mín / deseadas / máx) | 1 / 1 / 2 | 2 / 2 / 3 |
| Zonas con máquina | 1 (la sustituta puede nacer en cualquiera de las 2) | 2 |
| Si muere la máquina | Corte de 3 a 5 minutos hasta que el grupo pone otra | No se nota |
| Si cae una zona entera | Corte de 3 a 5 minutos | Queda la mitad de la capacidad |
| Despliegue | Sin corte: nace la nueva antes de apagar la vieja (máx = deseadas + 1) | Igual |
| Protección del balanceador y de la pila | No (se puede apagar) | Sí |
| Métricas cada minuto y Flow Logs | No | Sí |
| **Coste estimado** | **≈ 48 USD/mes** | **≈ 74 USD/mes** |

«Alta disponibilidad» lo es **para la API**. El punto único que queda es
Supabase, que está fuera de este alcance.

**Fijo y variable** (tarifas públicas de `us-east-1` verificadas en mayo de
2026, ver `AWS_DESPLIEGUE.md` §5):

- **Fijo:** balanceador ≈ 23,7 USD (horas + 2 IPv4); por máquina ≈ 20,4 USD
  (t3.small + 20 GiB gp3 + IPv4); secreto 0,40 USD.
- **Variable:** LCU del balanceador (1-2 USD); logs y métricas (≈ 1 USD);
  ECR (0,10 USD/GB); logs del ALB en S3 (céntimos). CloudFront entra en su
  capa gratuita permanente (1 TB y 10 millones de peticiones al mes). La salida
  de datos, en los 100 GB gratuitos.
- **Alarmas:** 7 propias + 4 del seguimiento de objetivo = 11, una por encima
  de las 10 gratuitas (0,10 USD).

**Sin NAT Gateway, a propósito.** Las máquinas van en subred pública con IP
pública y un grupo de seguridad que solo admite al balanceador. Salen por el
Internet Gateway, que es gratis, hacia ECR, SSM, Secrets Manager, CloudWatch y
Supabase. Las alternativas:

| Opción | Coste |
| --- | --- |
| 1 NAT | 33 USD/mes |
| 2 NAT | 66 USD/mes |
| Endpoints de interfaz | Unos 87 USD/mes (6 endpoints × 2 zonas) |

Cualquiera de ellas cuesta más que el cómputo que protege.

**Durante la fase en paralelo se pagan las dos cuentas.** Son unos 48 USD más
al mes con el perfil económico. Por eso el corte y el retiro de la cuenta
anterior deberían tener fecha.

---

## 6. Procedimiento desde PowerShell

PowerShell 7, CLI de AWS v2, git y Docker Desktop (este último solo para
`Imagen` y `Todo`). Todo se ejecuta desde la raíz del repositorio.

```powershell
$env:RENASERLAB_AWS_ACCOUNT_ID = '<doce digitos>'   # la barrera; no va en el repositorio

# 0. Comprobar sin tocar nada
./infra/aws/deploy-renaserlab.ps1 -Accion Verificar
./infra/aws/deploy-renaserlab.ps1 -Accion Planificar

# 1. Fundacion: ECR, rol de GitHub y bucket de plantillas (reutiliza el OIDC)
./infra/aws/deploy-renaserlab.ps1 -Accion Fundacion

# 2. Secreto: fichero JSON FUERA del repositorio (ver infra/aws/secretos.ejemplo.json)
./infra/aws/deploy-renaserlab.ps1 -Accion Secretos -ArchivoDeSecretos C:\seguro\zexcelencia.json

# 3. Imagen del commit que corre hoy en produccion (origin/main por defecto)
./infra/aws/deploy-renaserlab.ps1 -Accion Imagen

# 4. Plataforma: red, balanceador, maquinas, CloudFront, alarmas
./infra/aws/deploy-renaserlab.ps1 -Accion Plataforma

# 5. Salud, estado y plan de corte (solo leen)
./infra/aws/deploy-renaserlab.ps1 -Accion Salud
./infra/aws/deploy-renaserlab.ps1 -Accion PrepararCorte
```

`-Accion Todo` encadena los pasos 0 a 5 y se detiene en el primero que falle.

**Planificar y aplicar están separados.** Cada paso que cambia algo crea un
conjunto de cambios de CloudFormation, lo enseña recurso por recurso y
**pregunta** antes de aplicarlo:

- `-WhatIf` enseña el plan y lo descarta.
- `-Confirm:$false` aplica sin preguntar, para automatizar.
- Si el plan reemplaza o borra un recurso persistente (ECR, un bucket, el grupo
  de logs, la distribución de CloudFront, el balanceador, el puntero de
  versión, la VPC), se **bloquea** salvo `-PermitirReemplazos`.

**Actualizaciones.** El mismo guion actualiza. En una actualización **no** pasa
`EtiquetaDeImagen`: la versión viva la mueve el CI en SSM, y pasar otra la
pisaría.

**Evidencia.** Cada ejecución deja en `infra/aws/evidencias/` un JSON con:

- cuenta y operador;
- el plan aplicado;
- la imagen, con su digest y el resultado del escaneo;
- las comprobaciones de salud;
- el estado de las alertas;
- los avisos.

La carpeta está en `.gitignore`: lleva la cuenta. No hay ningún secreto en
ella.

### Qué comprueba `Salud`

- Que las máquinas estén sanas, en cuántas zonas, y que el balanceador tenga
  destinos sanos.
- `/health` por la URL pública, comprobando el contenido y no solo el 200.
- `/api/v1/profiles/featured`, que **consulta la base**: `/health` no la toca.
  Solo se guarda el código, porque el cuerpo son datos de personas.
- Que el balanceador **no** responda directamente desde Internet.
- La versión desplegada.
- Si la suscripción de alertas está confirmada o en `PendingConfirmation`.
  Mientras esté pendiente, **las alarmas no avisan a nadie**, y el guion lo dice
  así.
- Las alarmas que estén en `ALARM`.
- La misma consulta contra la API de producción actual, en paralelo, para
  comparar códigos y latencia.

---

## 7. El corte de tráfico

> **Superado (23/09/2026).** La cuenta anterior se dio de baja: la vía B es
> imposible y el CI ya despliega en RenaserLab. Queda la vía A (builds nuevas
> con la URL nueva, hecha en `eas.json`) y la C (dominio propio) como paso
> siguiente. Lo que sigue se conserva como registro. Ver §13.

**No se ha hecho nada de esto.** `-Accion PrepararCorte` escribe el plan con
los valores reales, pero cada paso necesita autorización expresa.

No hay dominio propio, así que la URL de la API es el nombre que Amazon da a la
distribución. **Ese nombre cambia con la cuenta.** Las vías:

| Vía | Cómo | A favor | En contra |
| --- | --- | --- | --- |
| **A. Recompilar** | `EXPO_PUBLIC_API_URL` nueva en `eas.json` y en Vercel; publicar web y builds | No toca la cuenta anterior | Las apps instaladas siguen llamando a la URL vieja hasta actualizarse: la cuenta anterior tiene que vivir semanas |
| **B. Redirigir la distribución actual** | En la cuenta **anterior**, cambiar el origen de su CloudFront a la distribución nueva (HTTPS) | Todos los clientes cambian a la vez, sin recompilar; vuelta atrás = devolver el origen | Necesita a quien administra la cuenta anterior; la distribución vieja vive hasta que no quede ninguna build antigua |
| **C. Dominio propio** | Certificado de ACM en `us-east-1` y parámetros `NombreDeDominio` y `CertificadoDeCloudFrontArn`; CNAME a la distribución | Definitiva: la próxima mudanza es un cambio de DNS | Requiere que la empresa decida el dominio |

**Recomendación:** B para cambiar sin recompilar y con vuelta atrás inmediata,
A en paralelo para que las builds nuevas ya nazcan apuntando a la cuenta nueva,
y C en cuanto exista dominio.

**CI.** Para que `main` despliegue en RenaserLab hay que cambiar tres
variables del repositorio. El guion imprime los valores exactos:

```text
AWS_ROLE_ARN          -> salida ArnDelRolDeDespliegue de zexcelencia-fundacion
AWS_PILA_PLATAFORMA   -> zexcelencia-plataforma-produccion
AWS_REPOSITORIO_ECR   -> zexcelencia/api
```

Mientras no se cambien, **`main` sigue desplegando en la cuenta anterior**. Se
cambian en el mismo momento que el tráfico; si no, cada fusión dejaría las dos
APIs en versiones distintas.

**Orden recomendado del día del corte:**

1. `Salud` en verde y las alertas confirmadas.
2. Variables de GitHub.
3. Vía B (o A).
4. Una hora de observación con el panel de CloudWatch.
5. Una ventana de estabilización de una o dos semanas.
6. Solo entonces, planificar el retiro de la cuenta anterior con quien la
   administra.

---

## 8. Vuelta atrás

| Qué salió mal | Cómo se vuelve | Tiempo |
| --- | --- | --- |
| Una versión de la API | `-Accion VolverAtras` (a la anterior del historial) o `-EtiquetaDeImagen sha-xxxxxxx` | ~5 min |
| Un cambio de infraestructura | Si el plan falla, CloudFormation revierte solo. Si «funcionó» pero rompió algo: `git checkout <commit-bueno> -- infra/aws/` y `-Accion Plataforma` | 5-15 min |
| El secreto | `-Accion Secretos` con el fichero anterior y `-Accion Renovar` | ~5 min |
| El corte (vía B) | Devolver el origen de la distribución anterior a su balanceador | minutos más la propagación |
| El corte (vía A) | Volver a publicar la web con la URL anterior; las builds nuevas necesitan otra build | horas |
| El CI | Volver a poner las tres variables anteriores | inmediato |

La cuenta anterior no se toca durante toda esta fase: **es el plan de vuelta
atrás.**

> **Superado (23/09/2026).** Con la cuenta anterior dada de baja, las filas «el
> corte (vía B)» y «el CI» ya no tienen a dónde volver. La vuelta atrás de una
> versión sigue siendo `-Accion VolverAtras` o el flujo con `etiqueta`, ahora
> siempre dentro de RenaserLab.

---

## 9. Decisiones que son de una persona

1. **Autorizar la creación de la infraestructura** en RenaserLab: unos 48 USD
   al mes más mientras convivan las dos cuentas.
2. **Entregar los valores del secreto** (claves de Supabase) en un fichero
   fuera del repositorio.
3. **Confirmar el correo de alertas** que AWS enviará a la dirección del perfil.
4. **La beta gratuita.** El perfil con el que se desplegó la cuenta anterior la
   lleva **encendida** (no se ha podido comprobar en su pila, por no tener
   acceso a esa cuenta). El perfil nuevo la trae **apagada**, como pide la
   política de migración. Si se corta sin decidir nada, dejan de
   concederse cursos gratis, aunque los ya concedidos se conservan. Hay que
   decidir antes del corte.
5. **La vía de corte** (A, B o C) y, para B, coordinarla con quien administra
   la cuenta anterior.
6. **El dominio propio**: es la misma decisión pendiente que tiene aparcado el
   backend de Talento.
7. **La fecha de retiro** de la cuenta anterior.
8. **El orden con el PR de `main`.** Fusionar hoy despliega en la cuenta
   **anterior**, porque las variables no han cambiado. Si se prefiere que lo
   siguiente que salga a producción salga ya en RenaserLab, primero el corte y
   después la fusión.

---

## 10. Validación hecha

| Comprobación | Resultado |
| --- | --- |
| `cfn-lint 1.55.1` sobre las dos plantillas, con reglas experimentales e informativas | 0 hallazgos |
| `cfn-lint` de la plataforma con cada perfil como fichero de parámetros | 0 hallazgos |
| `validate-template` de la fundación contra la cuenta | válida |
| Barrera con `Rules` contra una cuenta falsa | **dejó crear el plan: descartada** |
| Barrera con dependencia condicional contra una cuenta falsa | rechazada en el acto, sin pila |
| La misma con la cuenta buena | plan creado; descartado y pila vacía borrada |
| Guion: sintaxis de PowerShell | 0 errores |
| Guion con cuenta falsa y sin cuenta | se detiene con código 1, sin evidencia ni llamadas de escritura |
| `-Accion Verificar` contra la cuenta | verde |
| `-Accion Planificar` contra la cuenta | plan de 5 recursos enseñado y descartado; la cuenta queda como estaba |
| `-Accion Secretos` con un fichero lleno de errores y con uno versionado | rechazados antes de escribir; ningún secreto creado |
| `test_infraestructura_aws.py` | 17 pruebas en verde |
| Mutaciones: 13 defectos reintroducidos a mano | las 13 ponen la batería en rojo |

**Lo que no se puede validar sin crear la infraestructura**, y habrá que mirar
el primer día:

- `validate-template` de la plataforma, que necesita el bucket de la fundación.
- Que CloudFormation resuelva el secreto en la regla del balanceador y en la
  distribución.
- Que la primera máquina arranque entera.
- Que Supabase acepte la IP de salida nueva: no hay restricciones de red
  conocidas, pero no está comprobado.
- El consumo real de LCU.

---

## 11. Hallazgos que quedan anotados, sin corregir

- **El tramo de CloudFront al balanceador va en HTTP**, dentro de AWS. Se
  cierra con dominio propio y certificado en el balanceador, o con un origen de
  VPC.
- **`TRUST_PROXY_HEADERS` está apagado.** La huella de IP de los
  consentimientos anota la IP del balanceador, no la de la persona. Encenderlo
  sin más dejaría que quien llama eligiera su IP: `X-Forwarded-For` trae
  primero lo que manda el cliente. Arreglarlo es cambio de código (tomar el
  salto que añade el balanceador) y queda fuera de una migración.
- **`/health` no consulta la base**, a propósito. Si lo hiciera, un corte de
  Supabase sacaría del balanceador a todas las máquinas a la vez. La
  comprobación con base la hace el guion con otra ruta.
- **El AMI se resuelve en cada actualización de la pila.** Si AWS publicó uno
  nuevo, la actualización renueva las máquinas. El plan lo enseña (plantilla de
  arranque y grupo) antes de aplicarlo.
- **Certificado en el balanceador y CloudFront a la vez no combinan hoy**:
  CloudFront habla con el origen por HTTP y el balanceador, con certificado,
  redirigiría a HTTPS. No es una configuración en uso; habría que pasar el
  origen a `https-only` con un nombre que case con el certificado.
- **No hay alarma de «despliegue fallido».** Se ve en rojo en el flujo de
  GitHub o en el guion, y si llega a afectar al servicio salta
  `sin-instancias-sanas`. Una regla de EventBridge para las renovaciones
  fallidas es barata si un día se quiere aviso aunque nadie esté mirando.

---

## 12. El despliegue del 23/09/2026

Lo que salió al crear la infraestructura de verdad. Todo está corregido en el
repositorio salvo lo que se dice.

- **Las máquinas podían leer los parámetros de otros productos.** La política
  gestionada `AmazonSSMManagedInstanceCore`, que da Session Manager, concede
  `ssm:GetParameter` sobre `*`. En esta cuenta eso incluía `/renaser/prod/*`.
  Lo encontró el simulador de IAM con la pila ya creada. Corregido con un
  `Deny` explícito (`e534def`) y **demostrado**: `explicitDeny` sobre
  `/renaser/prod/*`, `/renaser/pruebas/*` y otros entornos de Z; Session
  Manager, el puntero de versión y su secreto siguen abiertos.
- **Docker Desktop publicaba un índice OCI**, con la imagen real como hijo sin
  etiqueta: ECR no lo escaneaba y la regla de ciclo de vida podía borrarla.
  Ahora se construye con `--provenance=false --sbom=false` y el guion rechaza
  un índice. La imagen `sha-0e39bcc` es aquel índice y sigue en ECR sin usar.
- **El escaneo automático de ECR está desactivado para toda la cuenta** (reglas
  vacías a nivel de registro). No se ha cambiado, porque afecta a los otros
  productos: la imagen se escaneó a mano. Resultado: 0 críticas y 14 altas, en
  paquetes de Debian que arrastra ffmpeg.
- **Las alarmas de créditos de CPU saltaban tras cada despliegue.** Una `t3`
  en modo `standard` nace con 0 créditos y acumula 24 por hora. Así,
  `creditos-de-cpu-bajos` (umbral 20) quedaba en `ALARM` casi una hora y
  `creditos-de-cpu-bajando` (umbral 144) unas seis, con la CPU al 1 %.
  Corregido (`4deab1d`): las dos exigen además que la CPU supere su línea base
  (20 % en una t3.small, en el Mapping junto al tipo de instancia). Sin gasto
  la máquina no puede frenarse; con gasto y saldo bajo avisan igual que antes.
  Aplicado como dos modificaciones sin reemplazo.
- `sin-instancias-sanas` pasa por `ALARM` al crear la pila, antes de que la
  primera máquina esté sana, y vuelve a `OK`. Se comprobó que la métrica llega
  cada minuto aunque no haya tráfico: no es una alarma que se quede en rojo.
- **La renovación de máquinas cortaba el servicio.** Con solo
  `MinHealthyPercentage=100`, AWS termina la instancia vieja antes de lanzar la
  nueva: al renovar en RenaserLab hubo tres minutos sin ninguna máquina sana, y
  `sin-instancias-sanas` saltó como debía. El mismo defecto estaba en el flujo
  de GitHub, así que **cada despliegue a producción con una sola máquina
  cortaba el servicio unos minutos**. Corregido (`1de7f6c`) con
  `MaxHealthyPercentage=200` en las tres renovaciones: la del guion y las de
  desplegar y volver atrás del flujo.
- **Restablecer la contraseña de Supabase rompe la producción anterior.** El
  pooler tardó más de una hora en aceptar la contraseña nueva: la primera no
  entró nunca y hubo que generar otra. En cuanto la aceptó, la producción de la
  cuenta anterior dejó de poder abrir conexiones (500 desde ~14:40). La próxima
  rotación tiene que hacerse a la vez en todos los entornos que comparten la
  base.

---

## 13. La cuenta anterior se dio de baja

La cuenta de Ricardo (la que tenía producción y el entorno aparcado de
Talento) se dio de baja al agotarse sus créditos. Eso cierra las vías que
dependían de ella y deja esto:

| Qué | Estado |
| --- | --- |
| API | En RenaserLab, desplegada desde `main` por GitHub. `sha-c85a1d3` el 23/09 a las 19:27, sin corte. |
| Web (Vercel) | Construida desde `main` con `EXPO_PUBLIC_API_URL` de la API nueva. |
| Datos | **Nada se pierde.** Base y archivos están en Supabase: 372 objetos en Storage, 0 URLs de AWS en la base y la API no usa S3. |
| Apps móviles ya repartidas | **Sin servicio.** Llevan grabada `d33u17ka1rcaax.cloudfront.net`, que pertenece a la cuenta dada de baja y nadie puede redirigir. Solo se arreglan instalando una build nueva. |
| Builds nuevas | `eas.json` apunta a la API nueva en los tres perfiles, con prueba que lo vigila, y llevan `expo-updates` para que el próximo cambio de dirección no dependa de la tienda. |
| Talento | Su entorno aparcado en esa cuenta se pierde. Talento sigue en Render; se recrea en RenaserLab cuando exista el dominio. |
| Flujo de GitHub | Sus valores por defecto pasan a los de RenaserLab. Volver a poner el rol de la cuenta anterior ya no es una vuelta atrás. |

**Lo que evita que esto se repita es la vía C.** Con un dominio propio
(`api.<dominio>`), las apps llaman a un nombre que controla la empresa y la
siguiente mudanza es cambiar un registro DNS. Con `expo-updates` ya dentro, las
apps pasarán a ese dominio con una actualización, sin volver a la tienda.

Pendiente de quien administraba la cuenta anterior: la API vieja seguía
respondiendo `/health` el 23/09. Que confirme que esas máquinas no generan
cobros.
