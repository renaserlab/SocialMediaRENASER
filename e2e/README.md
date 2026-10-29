# Pruebas E2E de Z (Maestro)

Suite de regresión de punta a punta de la app móvil (`apps/mobile`), corriendo
en **Expo Go** sobre un emulador Android contra el **backend local** (Supabase
en Docker + API FastAPI). Nada de lo que hace toca la base gestionada.

```
e2e/
├── config.yaml          espacio de trabajo de Maestro, para `maestro test` a mano sobre todo e2e/flujos
├── scripts/
│   ├── emulador.sh      arranca/comprueba emulador, puertos, barra fija, backend y Metro
│   ├── sembrar.sh       usuarios de prueba + imágenes en Storage + datos/*.sql
│   ├── correr.sh        cerrojo + emulador + siembra + Maestro + comparación visual
│   └── comparar.sh      capturas de una ejecución contra referencias/ (SSIM)
├── flujos/
│   ├── _comun/          subflujos compartidos (no son pruebas)
│   └── <modulo>/        un .yaml por prueba; subflujos propios en <modulo>/_sub/
├── datos/
│   ├── 00-base.sql      Ana y Beto, follows, publicaciones con imagen
│   ├── NN-<modulo>.sql  lo que necesita cada módulo (idempotente)
│   └── medios/          imágenes de prueba (se suben a Storage local)
├── referencias/<modulo>/  líneas base visuales (SE VERSIONAN)
├── hallazgos/<modulo>.md  fallos de la app encontrados por la suite
└── salida/              resultados de cada ejecución (ignorado por git)
```

## Requisitos

- **Maestro 2.11** en `~/.maestro/bin/maestro` (no hace falta en el PATH) y Java.
- **Android SDK** en `~/Android/Sdk` (o `ANDROID_HOME`) con el AVD
  `Pixel_6_API_36` y **Expo Go 54** (`host.exp.exponent`) instalado en él.
- **Supabase local** `zeta-local` levantado (`scripts/supabase_local.sh` desde el
  checkout principal; contenedores `supabase_*_zeta-local`, API en
  `127.0.0.1:54321`, Postgres en `127.0.0.1:54322`) y la CLI `supabase`.
- **API FastAPI** local en `127.0.0.1:8000` (`~/.cache/zeta-emulador/api.sh`,
  que lee las claves al vuelo de `supabase status`).
- **Metro** en `127.0.0.1:8081` lanzado desde el checkout principal
  (`apps/mobile`) con un `.env.local` que apunte al backend local.
- `ffmpeg`, `curl`, `docker`, `flock` (util-linux).

## Levantar el entorno

Todo lo hace `e2e/scripts/emulador.sh`, idempotente (unos 3 s si ya está todo):

1. Si no hay dispositivo, arranca el emulador **con límites** (scope de systemd
   con `CPUQuota=300%` y `MemoryMax=4500M`, render por software, 2 núcleos,
   2 GB). Sin esos límites el PC llegó a congelarse.
2. Espera a `sys.boot_completed` y hace `adb reverse` de 8081, 54321 y 8000
   (dentro del emulador `127.0.0.1` es el PC).
3. Deja la pantalla determinista: modo demo (reloj 12:00, batería llena, wifi,
   sin notificaciones), animaciones del sistema a 0, tema claro y pantalla
   siempre encendida.
4. Comprueba Supabase (no lo levanta: si falta, aborta), la API (si falta la
   arranca con `api.sh`) y Metro (si falta lo arranca desde el checkout
   principal con `npx expo start --port 8081`).

Datos de prueba: `e2e/scripts/sembrar.sh` (lo llama `correr.sh` antes de cada
ejecución). Crea o repone a los usuarios con la API de admin de Auth, sube las
imágenes de `datos/medios/` a Storage y aplica `datos/*.sql` por orden. La clave
`service_role` se lee de `supabase status` en el momento y no se guarda.

| Usuario | Correo | Nombre | UUID fijo |
|---|---|---|---|
| Ana | `ana.e2e@zeta.test` | Ana Prueba (`@ana_e2e`) | `e2e0a0a0-0000-4000-8000-000000000001` |
| Beto | `beto.e2e@zeta.test` | Beto Prueba (`@beto_e2e`) | `e2e0b0b0-0000-4000-8000-000000000002` |

La contraseña de los dos es `Zeta-e2e-2026`. Los flujos la reciben por `env`:
`E2E_EMAIL`, `E2E_PASSWORD` y `E2E_EMAIL_B`.

## Correr

```bash
e2e/scripts/correr.sh                          # todo, módulo a módulo (resiembra y revisa el emulador entre uno y otro)
e2e/scripts/correr.sh auth                     # un módulo (carpeta de e2e/flujos)
e2e/scripts/correr.sh e2e/flujos/auth/04-login-errores.yaml   # un flujo
e2e/scripts/correr.sh auth mensajes --sin-sembrar             # varios, sin resembrar
e2e/scripts/correr.sh --excluir=bug-conocido                  # todo menos los fallos conocidos
```

Opciones: `--sin-sembrar` (no repone los datos; más rápido al iterar),
`--etiquetas=a,b` (solo esas etiquetas), `--excluir=a,b` (sin esas etiquetas),
`--actualizar-referencias` (todas las capturas pasan a ser la referencia) y
`--referencias-nuevas` (solo crea las que falten; para estrenar un flujo sin
pisar las demás).

`correr.sh` toma el cerrojo del dispositivo (`~/.cache/zeta-e2e/dispositivo.lock`),
llama a `emulador.sh` y a `sembrar.sh` y lanza Maestro con JUnit. Deja en
`e2e/salida/<fecha>/`:

- `junit.xml`: el resultado por flujo;
- `capturas/`: las de `takeScreenshot`, reducidas a 540 px;
- `informe-visual.txt` y `diferencias/`: lo que cambia frente a las referencias;
- `maestro/` y, solo si algo falla, `depuracion/`: pasos, capturas de cada
  paso, jerarquía de vistas y logcat.

Se conservan las 10 últimas ejecuciones. Código de salida: el de Maestro; `3`
si Maestro pasa pero alguna pantalla cambia.

**Un solo dispositivo:** cualquier ejecución de Maestro a mano también va con
el cerrojo:

```bash
flock ~/.cache/zeta-e2e/dispositivo.lock ~/.maestro/bin/maestro test e2e/flujos/auth/03-login-correcto.yaml \
  -e E2E_EMAIL=ana.e2e@zeta.test -e E2E_PASSWORD=Zeta-e2e-2026 -e E2E_EMAIL_B=beto.e2e@zeta.test
```

## Comparación visual

Cada `takeScreenshot: <modulo>-<pantalla>` se compara con
`referencias/<modulo>/<modulo>-<pantalla>.png` (el módulo es la carpeta de
`flujos/` cuyo nombre es el prefijo más largo de la captura). Se recorta la
barra de estado, se pasa a grises y se calcula el SSIM con ffmpeg; por debajo
de `0.97` (`UMBRAL_SSIM` o `--umbral=`) cuenta como cambio y deja la imagen de
diferencias en `salida/<fecha>/diferencias/`.

```bash
e2e/scripts/comparar.sh                        # contra la última ejecución
e2e/scripts/correr.sh auth --actualizar-referencias   # correr y promover las capturas a referencias
e2e/scripts/comparar.sh e2e/salida/<fecha> --actualizar-referencias
```

Actualizar referencias es una decisión: revisa antes las diferencias y
versiona las nuevas imágenes en el mismo commit que el cambio de interfaz.

## Subflujos comunes (`flujos/_comun/`)

| Subflujo | Parámetros (`env`) | Qué hace |
|---|---|---|
| `abrir-app.yaml` | `RUTA`, `ESPERAR`, `REINICIAR` | Para Expo Go, lo abre y carga `exp://127.0.0.1:8081/--/<RUTA>`; espera a `ESPERAR` y quita el ruido. Con `REINICIAR: "no"` no para la app (hay que dar `RUTA`; para el muro, `home`). |
| `iniciar-sesion.yaml` | `E2E_EMAIL`, `E2E_PASSWORD` | Comprueba en Ajustes quién está dentro; si no es esa cuenta, sale y entra con ella. Termina en el muro. |
| `cerrar-sesion.yaml` | `REINICIAR` | Ajustes → Cerrar Sesión → confirmar. Si sale la pantalla de idioma, elige Castellano. Sin sesión no hace nada. |
| `ir-a-pestana.yaml` | `PESTANA` | `Inicio`, `Explorar`, `Crear`, `Mensajes` o `Perfil`. |
| `elegir-idioma.yaml` | `IDIOMA` | Contesta la pantalla de idioma (`Castellano` por omisión, `English`, `Português`) si está a la vista. |
| `quitar-ruido.yaml` | — | Cierra el aviso rojo de LogBox, el diálogo «isn't responding» y la presentación del menú de desarrollo de Expo Go. |

## Añadir flujos

- Un `.yaml` por prueba en `flujos/<modulo>/`, con `appId: host.exp.exponent`,
  `name: <modulo>/<prueba>` y `tags: [<modulo>]`. Cada flujo debe poder correr
  solo y en cualquier orden: empieza con `abrir-app` o `iniciar-sesion`.
- Subflujos propios en `flujos/<modulo>/_sub/` (lo que empieza por `_` no entra
  en `config.yaml`) y con `tags: [comun]`.
- **La app no tiene testIDs:** se selecciona por texto visible (cadenas en
  `apps/mobile/src/i18n/es.ts`) o por `accessibilityLabel`. Los textos son
  expresiones regulares: escapa `?`, `(`, `.`... (`"¿Olvidaste tu contraseña\\?"`).
- Capturas con `takeScreenshot: <modulo>-<pantalla>`, en tema claro.
- Datos que necesite el módulo en `datos/NN-<modulo>.sql`, idempotente
  (`on conflict`, borrar y reponer). `00-base.sql` BORRA todos los posts y
  follows de Ana y Beto antes de reponerlos.
- Fallos de la app en `hallazgos/<modulo>.md` (pasos, esperado, real, captura,
  gravedad). Un fallo que se quiera vigilar va en su propio flujo `bug-*.yaml`
  con la etiqueta `bug-conocido` y el id del hallazgo en su cabecera. Ese flujo
  comprueba el comportamiento ACTUAL (el incorrecto), asi que la suite sale en
  verde mientras el fallo siga ahi. Cuando alguien lo arregle, el flujo falla en
  el paso marcado `# ARREGLO:`: se invierte esa comprobacion y el flujo pasa a
  vigilar que no vuelva. Se apartan con `--excluir=bug-conocido`.
- Un flujo que todavia no pasa entero en el emulador lleva la etiqueta
  `pendiente`, y uno que Expo Go no deja correr, `bloqueado-expo-go`. Al correr
  todo o una carpeta se apartan solos; se lanzan nombrando el archivo o con
  `--etiquetas=pendiente`. La lista y el motivo estan en
  `hallazgos/RESUMEN.md`. Cuando uno pase, se le quita la etiqueta.

## Limitaciones conocidas

- **Expo Go, no un build propio.** No hay notificaciones push (el aviso rojo
  `expo-notifications` sale en cada arranque y lo quita `quitar-ruido`), el
  acceso a la galería es limitado (Expo Go ya no puede dar acceso completo a la
  biblioteca de medios en Android) y `react-native-compressor` no viaja, así que
  las subidas van sin comprimir. Las compras van en modo navegador.
- **Sin transformador de imágenes en el Supabase local.** Las fotos de perfil
  se piden por `/render/image/...`, que responde 404: por eso Ana y Beto no
  tienen foto (se ven las iniciales).
- **El emulador crece en memoria.** Arranca con ~3,7 GB y sube unos 4,5 GB por
  hora de pruebas (el 29-10 el OOM lo mató a la 1 h 50 min de suite seguida;
  por eso `correr.sh` sin argumentos va módulo a módulo). La RAM se queda en el tope del scope (4,5 GB) y el resto se
  va a swap (hasta 8 GB, `MemorySwapMax`): el 28-10 llegó a 10 GB de swap, el
  sistema se quedó sin swap y los toques se volvieron lentísimos. Si además
  llega al tope de swap, el OOM del cgroup lo mata a mitad de una prueba (todos
  los flujos siguientes fallan en milisegundos y `adb devices` sale vacío).
  `correr.sh` llama a `emulador.sh` con `ZETA_REINICIO_PREVENTIVO=1`, que lo
  reinicia antes de cada ejecución si RAM + swap pasa de 6000 MB
  (`ZETA_LIMITE_MB`), y `emulador.sh` lo vuelve a levantar si no hay
  dispositivo.
- **Capturas que dependen del día.** Los datos de prueba usan fechas relativas
  a «ahora» (`now() + interval …`), así que las capturas con fechas u horas
  (agenda, bandeja, historial del chat) cambian de un día para otro y la
  comparación las marca como CAMBIA aunque la app esté bien. Míralas a ojo
  antes de renovarlas con `--actualizar-referencias`.
- **Lentitud.** El emulador va con render por software y CPU limitada: un flujo
  típico tarda 1–3 minutos. Cada condición `when` que no se cumple espera hasta
  7 s (el «optional lookup» de Maestro): agrúpalas.
- **Arranque en frío de Expo Go.** Un `openLink` con Expo Go parado a veces solo
  abre y cierra su lanzador; `abrir-app` abre antes Expo Go y reintenta.
- **Límites de Auth local:** 30 accesos o registros cada 5 minutos y 2 correos
  por hora. `iniciar-sesion` no reentra si la cuenta ya está dentro, y la prueba
  de «olvidé mi contraseña» usa un correo sin cuenta (no envía nada).
- `01-idioma-primer-arranque` hace `clearState` de Expo Go: borra idioma,
  sesión y caché del bundle (la siguiente carga es más lenta).
