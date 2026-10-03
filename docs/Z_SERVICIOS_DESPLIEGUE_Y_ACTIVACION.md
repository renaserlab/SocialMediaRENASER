# Z Servicios · despliegue y activación del piloto gratuito

**Estado al 03/10/2026, por la noche: ejecutados los pasos 1 a 3, todo
apagado.** El push, el PR #7 (CI en verde, fusionado), la API desplegada
(`sha-2f7e19a`, comprobada: la ruta interna contesta 503 y `/health` 200) y la
plataforma actualizada. **Sin ejecutar:** el margen de arranque corregido
(apartado 3), el secreto del planificador, las condiciones, las banderas y la
lista del piloto. Cada paso lo ejecuta una persona, con el plan a la vista.

**El paso 3 tiró la API cinco minutos** (18:28–18:33, hora de Lima). Está
explicado en su apartado, y hay que aplicar su arreglo antes de los pasos 5 y 7.

El detalle técnico está en `Z_SERVICIOS_ARQUITECTURA.md`, Parte X (§147–§156).
Aquí está solo **el orden y los comandos**.

## 0. Lo que tiene que ser verdad antes de empezar

| Condición | Cómo se comprueba |
|---|---|
| Quien forzó ramas el 02/10 ya no tiene permiso de escritura en el repositorio | En GitHub: *Settings › Collaborators and teams* |
| La sesión de `gh` es la de quien despliega | `gh auth status` |
| El remoto está donde se dejó | `git ls-remote origin Edson main` (no descarga nada) |
| Las variables de despliegue de GitHub apuntan a RenaserLab | `gh variable list` y comparar la cuenta de `AWS_ROLE_ARN` con la de RenaserLab |
| La sesión de AWS es la de RenaserLab | el guion lo comprueba en cada acción; sin `RENASERLAB_AWS_ACCOUNT_ID` no hace nada |
| En Supabase están aplicadas las migraciones 0086–0096 | ya verificado el 02/10/2026 (`Z_SERVICIOS_ARQUITECTURA.md`, §131). **No hay 0097** |
| Quien despliega puede crear una conexión de EventBridge | hace falta poder crear su rol vinculado y su secreto `events!connection/*`. **Sin comprobar**: si falta, el paso 7 revierte sin cambiar nada |

**La cuenta anterior (la de Ricardo) no se toca en ningún paso.** Si
`AWS_ROLE_ARN` apuntara a ella, no se fusiona nada: se corrige antes la
variable.

## 1. Subir la rama y abrir el PR

```bash
git push origin Edson
```

Sin `--force`: `origin/Edson` es un antepasado de la rama local. Si Git pide
forzar, **parar**: alguien movió el remoto.

```bash
gh pr create --repo renaserlab/SocialMediaRENASER --base main --head Edson --title "Z Servicios: cierre del piloto gratuito" --body "Procedimiento y estado: docs/Z_SERVICIOS_DESPLIEGUE_Y_ACTIVACION.md"
```

El CI corre al abrir el PR (`.github/workflows/ci.yml`): tipos y pruebas del
móvil, pruebas de la API sin PostgreSQL y la batería completa con PostgreSQL,
que falla si queda una sola prueba omitida.

**No se fusiona si:** el CI falla; hay conflictos que no se entienden; las
variables de GitHub apuntan a la cuenta anterior; o el plan del paso 3 enseña
una eliminación o un reemplazo de un recurso persistente.

## 2. Fusionar a `main` = desplegar el código, apagado

Fusionar dispara `desplegar-aws.yml`: construye la imagen, la publica y
renueva las máquinas. **No cambia la infraestructura ni las banderas**:
Servicios sigue apagado, porque la pila actual lo tiene apagado.

Lo que cambia para quien ya usa la aplicación: nada de Servicios. La baja de
cuenta y lo demás corren con el código nuevo.

## 3. Actualizar la plataforma, apagada

```powershell
$env:RENASERLAB_AWS_ACCOUNT_ID = Read-Host "Cuenta de RenaserLab"
```

```powershell
./infra/aws/deploy-renaserlab.ps1 -Accion Planificar
```

`Planificar` enseña el plan y lo descarta. Con los perfiles tal como están en
el repositorio (todo apagado, `PlanificadorDeServicios=No`), el plan es
**solo** esto (es el que salió contra la cuenta el 03/10/2026):

| Recurso | Cambio | Por qué |
|---|---|---|
| `PlantillaDeArranque` | Modify | ocho líneas nuevas en el entorno, las de Servicios, con los mismos valores que la API ya usa de fábrica |
| `GrupoDeAutoescalado` | Modify, «puede reemplazarse» | usa la plantilla nueva: **renueva las máquinas** |
| `BarreraLaContratacionExigeElPlanificador`, `ComprobacionDeLosProcesosDeServicios` | Add | dos marcadores sin coste; no crean nada en AWS |
| `AlarmaCreditosDeCpu`, `AlarmaCreditosDeCpuBajando`, `AlarmaMemoriaAlta`, `EscaladoPorCpu`, `EscaladoPorPeticiones`, `Panel` | Modify | no cambian: CloudFormation lista todo lo que apunta a un grupo que «puede reemplazarse» |

**Parar si aparece** cualquier `Remove`, un `Replacement: True` en un recurso
que no sea una máquina, un rol o una política con `*`, o un recurso que no
esté en esta tabla.

Este plan se generó y se aplicó el 03/10/2026 (18:22, hora de Lima) y quedó en
`UPDATE_COMPLETE`.

### Lo que pasó al aplicarlo, y lo que hay que hacer antes de repetirlo

**Cinco minutos de 502, de 18:28 a 18:33.** No fue la configuración: fue la
forma de cambiar la máquina.

| Hora (UTC) | Qué pasó |
|---|---|
| 23:22:42 | CloudFormation lanza la máquina nueva |
| 23:27:56 | la nueva avisa de que su API responde: tardó 5 min 2 s |
| 23:27:58 | CloudFormation apaga la vieja |
| 23:28:08 | el grupo retira la nueva «por fallar la comprobación de salud del balanceador» y lanza otra |
| 23:33:00 | la tercera responde; estable desde entonces |

El grupo daba 300 s a una máquina para estar lista. La nueva tardó lo mismo,
al balanceador le faltaban 30 s para darla por sana, y el grupo la mató siendo
la única. El margen pasa a **600 s** en la plantilla.

**Antes de los pasos 5 y 7**, que vuelven a renovar las máquinas por este
camino, se aplica ese margen (un plan con una sola línea, `GrupoDeAutoescalado`,
y sin `PlantillaDeArranque`: no renueva nada) y se comprueba:

```powershell
aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names zexcelencia-api-produccion --region us-east-1 --query "AutoScalingGroups[0].HealthCheckGracePeriod"
```

Tiene que decir `600`. Aun así, los pasos 5 y 7 se hacen en hora de poco
tráfico. `Secretos` y `Renovar` (pasos 4 y 7) no tienen este riesgo: no apagan
la máquina vieja hasta que la nueva está sana.

```powershell
./infra/aws/deploy-renaserlab.ps1 -Accion Plataforma
```

```powershell
./infra/aws/deploy-renaserlab.ps1 -Accion Salud
```

## 4. El secreto: el del planificador y la lista del piloto

`-Accion Secretos` **sustituye** el secreto por lo que trae el fichero local
(más las dos claves que genera el guion). Antes de ejecutarlo, el fichero
tiene que traer todo lo que la API necesita; el guion enseña los **nombres**
de las claves que añade, cambia y quita, y pide confirmación.

En este paso la lista del piloto va **vacía**:

```json
"SERVICES_PILOT_PROFILE_IDS": ""
```

```powershell
./infra/aws/deploy-renaserlab.ps1 -Accion Secretos -ArchivoDeSecretos C:\Users\Edwincito\zexcelencia-secretos.json
```

```powershell
./infra/aws/deploy-renaserlab.ps1 -Accion Renovar
```

El guion genera `SERVICES_TASKS_TOKEN` (64 caracteres hexadecimales) si no
existe y lo conserva si existe. No se escribe a mano y nunca se imprime.

## 5. Encender Servicios para nadie y publicar las condiciones

Las rutas de administración contestan 503 con `FEATURE_SERVICES` apagado, así
que **las condiciones no se pueden publicar antes de encenderlo**. Con la
lista del piloto vacía, encenderlo no deja entrar a nadie: solo abre el panel
de administración.

El guion solo lee `infra/aws/parametros/<perfil>.json`: se edita **ese
fichero, en su sitio, y no se commitea** (las pruebas exigen que el perfil
versionado siga apagado; ver el apartado 11).

```json
{ "ParameterKey": "FeatureServices", "ParameterValue": "true" }
```

```powershell
./infra/aws/deploy-renaserlab.ps1 -Accion Plataforma
```

Se espera que el plan enseñe `PlantillaDeArranque` y `GrupoDeAutoescalado`,
más las seis líneas que acompañan al grupo (tres alarmas, dos de escalado y el
panel: ver el apartado 3). **Renueva las máquinas**: con el margen de 600 s ya
aplicado, y en hora de poco tráfico.

Después, una persona con rol `admin` publica las dos condiciones. El token es
el `access_token` de **su** sesión (caduca en una hora); lo obtiene ella con
su propia cuenta, no se guarda en ningún fichero y, pidiéndolo así, tampoco
queda en el historial de la consola:

```powershell
$env:Z_ADMIN_TOKEN = Read-Host "Token de la sesion de administracion"
```

```powershell
python apps/api/scripts/publicar_condiciones.py --tipo prestador --api https://<url publica de la API>
```

```powershell
python apps/api/scripts/publicar_condiciones.py --tipo contratacion --api https://<url publica de la API>
```

Sin `--publicar` el guion deja el borrador, comprueba que su huella es la del
texto local y **no publica**. Si las dos huellas coinciden con las de
`Z_SERVICIOS_CONDICIONES_PRESTADOR_V1.md` y `Z_SERVICIOS_CONDICIONES_PILOTO_V1.md`,
se repite cada orden añadiendo `--publicar`, y al terminar:

```powershell
Remove-Item Env:Z_ADMIN_TOKEN
```

- **Publicar no tiene vuelta atrás por la API**: una condición publicada no se
  edita ni se retira; se sustituye publicando otra versión.
- Repetir el guion es seguro: si ya está publicada con esa huella, lo dice y
  no toca nada.
- Si el guion dice «NO SE SABE SI SE PUBLICÓ» (la orden salió y la respuesta
  no llegó), repetir la misma orden lo aclara.
- Un borrador que hubiera de antes se corrige entero, **también sus
  parámetros**: las condiciones del piloto van sin ninguno.

**Sin el guion**, con la aplicación: Panel de administración → Servicios →
Condiciones. No hace falta ningún token, pero hay que pegar el texto y
comparar la huella abreviada con la del documento antes de publicar.

Dejar constancia en los dos documentos de condiciones: versión, huella, fecha
y quién publicó.

## 6. Las categorías y la aplicación

Dos cosas sin las que el piloto encendido no sirve:

- **Las categorías.** Ninguna migración las crea. Sin al menos una, un
  prestador aprobado no puede crear su servicio. Las crea administración en
  el panel (Servicios → Catálogo → Categorías). **Cuáles son es una decisión
  de la empresa**; no deben ser de las que el piloto excluye (médicas,
  legales, financieras, de emergencia).
- **La actualización de la aplicación.** Todo Servicios y las vistas de este
  bloque son JavaScript que la build instalada no trae: llegan con una
  actualización, sin build nueva (`app.json` y las dependencias no cambian).
  Se publica como dice `PUBLICAR_EN_GOOGLE_PLAY.md`, paso 5, **siempre con
  `--environment`** (el `.env` local apunta a `localhost`). Primero al canal
  `preview`, sobre el APK interno. Sin esto, las comprobaciones «de la
  aplicación» del paso 8 no se pueden hacer.

## 7. La lista del piloto y la contratación

1. Poner en el fichero local de secretos los perfiles del piloto (UUID
   separados por comas, sin espacios) y repetir el paso 4 (`Secretos` y
   `Renovar`).
2. En el perfil (`infra/aws/parametros/<perfil>.json`, sin commitear):

```json
{ "ParameterKey": "FeatureServiceBooking", "ParameterValue": "true" },
{ "ParameterKey": "PlanificadorDeServicios", "ParameterValue": "Si" }
```

```powershell
./infra/aws/deploy-renaserlab.ps1 -Accion Planificar
```

Se espera que el plan enseñe, además de `PlantillaDeArranque`,
`GrupoDeAutoescalado` y las seis líneas que acompañan al grupo (apartado 3),
**cinco recursos nuevos y ninguno más**. También renueva las máquinas: mismo
cuidado que en el apartado 5.

| Recurso | Tipo |
|---|---|
| `ConexionDelPlanificadorDeServicios` | `AWS::Events::Connection` |
| `DestinoDelPlanificadorDeServicios` | `AWS::Events::ApiDestination` |
| `RolDelPlanificadorDeServicios` | `AWS::IAM::Role` (solo `events:InvokeApiDestination` sobre ese destino) |
| `ReglaDelPlanificadorDeServicios` | `AWS::Events::Rule` (cada 5 minutos) |
| `AlarmaProcesosDeServicios` | `AWS::CloudWatch::Alarm` |

**Las dos cosas van juntas.** Con `FeatureServiceBooking=true` y
`PlanificadorDeServicios=No`, CloudFormation rechaza el plan («Unresolved
resource dependencies [BarreraLaContratacionExigeElPlanificador]»): las
condiciones prometen que una atención terminada se cierra sola a las 24 horas,
y sin planificador no se cierra.

```powershell
./infra/aws/deploy-renaserlab.ps1 -Accion Plataforma
```

```powershell
./infra/aws/deploy-renaserlab.ps1 -Accion Salud
```

**Durante este despliegue las primeras pasadas fallan, y es lo esperado**: la
regla empieza a llamar mientras las máquinas se renuevan, y las que aún
tienen la contratación apagada contestan 503. La alarma necesita media hora
seguida de fallos para avisar; si avisa y a la media hora siguiente no se ha
callado sola, entonces sí hay que mirar.

Coste nuevo: unas 8 640 llamadas al mes por el destino de EventBridge y una
alarma de CloudWatch. Céntimos.

## 8. Comprobar que funciona

**En el servidor:**

| Qué | Cómo | Qué se espera |
|---|---|---|
| La puerta está cerrada y no delata nada | `curl.exe -s -X POST https://<url>/api/v1/internal/services/tasks/run` | 503 `services_disabled`: lo mismo que con todo apagado |
| El planificador llama | CloudWatch › Métricas › `AWS/Events` › `Invocations` de la regla | un punto cada 5 minutos |
| La API lo recibe | Logs de la API, buscar `servicios.procesos expired=` | una línea por pasada, con cinco cuentas |
| No hay rechazos | Logs de la API, buscar `servicios.procesos: llamada rechazada` | ninguna tras el despliegue. Si las hay, dicen si falta el secreto en la API o si no coincide |
| Nadie avisa de un fallo | la alarma `…-procesos-de-servicios` | en `OK` |

**En la aplicación** (con la actualización del paso 6 instalada):

| Qué | Cómo | Qué se espera |
|---|---|---|
| Entra quien debe | una cuenta de la lista abre Servicios | ve el catálogo |
| No entra quien no | una cuenta fuera de la lista | no ve ninguna entrada a Servicios |
| No hay dinero | el formulario del servicio | solo «Gratis» y «A consultar» |

La alarma avisa al tema de alertas de la pila, que hoy envía a la dirección de
`CorreoDeAlertas` del perfil. Quién lee ese correo es quien vigila los
procesos; no hay otro responsable definido.

## 9. Rotar el secreto del planificador

CloudFormation solo vuelve a leer un secreto cuando cambia el recurso que lo
usa. Por eso hay un contador:

```powershell
./infra/aws/deploy-renaserlab.ps1 -Accion Secretos -ArchivoDeSecretos C:\Users\Edwincito\zexcelencia-secretos.json -RotarSecretoDelPlanificador
```

```powershell
./infra/aws/deploy-renaserlab.ps1 -Accion Renovar
```

Y, con `VersionDelSecretoDelPlanificador` subido en uno en el perfil:

```powershell
./infra/aws/deploy-renaserlab.ps1 -Accion Plataforma
```

Entre el segundo paso y el tercero las pasadas se rechazan (unos minutos).
**Sin subir el contador, el tercer paso no cambia nada** y el planificador se
queda llamando con el secreto viejo.

## 10. Volver atrás

| Qué | Cómo | Qué pasa con los datos |
|---|---|---|
| Cerrar la contratación | perfil con `FeatureServiceBooking=false` y `PlanificadorDeServicios=No`, `-Accion Plataforma` | nada se borra; las reservas quedan como están y dejan de cerrarse solas |
| Cerrar Servicios | perfil con `FeatureServices=false`, `-Accion Plataforma` | nada se borra; las rutas contestan 503 |
| Sacar a alguien del piloto | quitar su UUID del secreto, `Secretos` y `Renovar` | conserva su historia |
| Código anterior | `-Accion VolverAtras -EtiquetaDeImagen sha-<commit>` | la base no cambia: no hubo migración. Con el planificador encendido, una imagen sin la ruta contesta 404 y la alarma avisa: apagar antes el planificador |
| Unas condiciones mal publicadas | publicar otra versión | la anterior queda como `superseded`; quien ya aceptó sigue ligado a la suya |

## 11. Lo que este procedimiento deja sin resolver

- **El perfil versionado sigue apagado** (lo exige
  `test_ningun_perfil_enciende_servicios`). Mientras el piloto esté
  encendido, un `-Accion Plataforma` con el perfil del repositorio lo
  apagaría; el plan lo enseña antes (`FeatureServices: true → false`). Cuando
  el piloto sea estable hay que decidir si el perfil versionado pasa a
  encendido, y cambiar esa prueba con él.
- **Una pasada tiene 5 segundos.** EventBridge corta la llamada a los 5
  segundos. Con el volumen de un piloto cabe; tras un atraso largo puede
  cortarse, se reintenta y la siguiente sigue donde quedó.
- **Entre CloudFront y el balanceador el tráfico va por HTTP**, también el
  secreto del planificador y las sesiones de las personas. Es anterior a este
  bloque y se va cuando el balanceador tenga certificado.
- **El QA físico** en teléfonos reales (`Z_QA_FISICO_PENDIENTE.md`).
- **La revisión legal** de las dos condiciones. No impide el piloto cerrado:
  los textos dicen que son una versión provisional.
