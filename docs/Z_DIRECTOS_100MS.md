# Transmisiones en vivo de Z con 100ms

> **Primera fase: 100ms.**
> **Arquitectura: neutral respecto al proveedor.**
> **Amazon IVS: alternativa futura, no implementada todavía.**

Cualquier documento anterior que diga que el proveedor será LiveKit está
desactualizado. No se eligió: era uno de los candidatos en una lista.

---

## 1. La regla que manda

**100ms sirve el vídeo. Z manda sobre el producto.**

Si alguna vez hay que decidir dónde vive una regla, esa frase lo resuelve.

| Decide **Z** | Decide **100ms** |
|---|---|
| Quién puede crear una emisión | La sala audiovisual |
| Quién puede iniciarla | Publicar audio y vídeo |
| De quién es | Recibir audio y vídeo |
| En qué estado está | Conectar participantes |
| Permisos y roles | Calidad adaptativa |
| Si es visible y para quién | Reconexión audiovisual |
| El chat y su moderación | Eventos técnicos de sala |
| La auditoría y las métricas | La infraestructura |
| Bloqueos entre personas | |

Un aviso de 100ms **confirma**; nunca **decide**. No puede crear una emisión, ni
cambiarle el dueño, ni marcar como viva una que nadie inició desde Z.

---

## 2. Arquitectura

```text
LiveScreen / ModoVivo
        ↓
   LiveRepository
        ↓
   API propia de Z            ← aquí se comprueban permisos, siempre
        ↓
  módulo backend live
        ↓
 ProveedorDeDirecto           ← el contrato; nadie más sabe de proveedores
        ↓
   Proveedor100ms             ← el ÚNICO fichero que sabe que existe 100ms
        ↓
    Cliente100ms              ← HTTP y firma de tokens. Cero reglas de negocio
        ↓
      API de 100ms
```

**Ninguna regla de negocio conoce a 100ms.** Los permisos, los estados, el chat,
la moderación y la navegación no lo nombran ni importan nada suyo. El router
recoge los fallos por el tipo del **contrato** (`ErrorDeProveedor`) y deja que el
propio proveedor los traduzca, así que no sabe ni cuál es ni qué códigos usa.

Dicho con precisión, porque una afirmación absoluta aquí sería falsa: el nombre
`100ms` aparece **a propósito** en cuatro sitios, y los cuatro son
irreductiblemente suyos.

| Dónde | Por qué es inevitable |
|---|---|
| `core/config.py` | Las variables de entorno tienen que llamarse de alguna forma |
| `providers.py` (el registro) | Alguien tiene que saber qué proveedores existen |
| `router.py` (la ruta del webhook, y a qué proveedor pertenece un aviso) | La URL se da de alta en el panel de 100ms |
| `webhooks.py` | Cómo se autentica un aviso lo decide el proveedor |

Todo lo demás —salas, credenciales, roles, errores, eventos— pasa por el
contrato. Es lo que permite cambiar de proveedor sin tocar permisos, estados,
endpoints públicos ni navegación.

### Ficheros

| Fichero | Para qué |
|---|---|
| `live/providers.py` | El contrato y el registro. Incluye `ProveedorNoConfigurado`. |
| `live/proveedor_100ms.py` | El adaptador. Salas, credenciales, avisos, errores. |
| `live/hms_client.py` | HTTP y firma de tokens. Sin una sola regla de negocio. |
| `live/roles.py` | La traducción de roles, en un solo sitio. |
| `live/webhooks.py` | Comprobar que un aviso es suyo. |
| `live/router.py` | Los endpoints. Solo nombra a 100ms en la ruta del webhook. |

---

## 3. Configuración

Todo en `apps/api/.env.example`, sin un solo valor real.

| Variable | Qué es |
|---|---|
| `FEATURE_LIVE` | Interruptor general del vídeo. **`false` de fábrica.** |
| `LIVE_PROVIDER` | `none` o `100ms`. |
| `HMS_APP_ACCESS_KEY` | Clave pública de la aplicación en 100ms. |
| `HMS_APP_SECRET` | **Secreto.** Firma los tokens. Solo backend. |
| `HMS_TEMPLATE_ID` | La plantilla: roles, calidad y grabación. |
| `HMS_WEBHOOK_SECRET` | Lo que se declara como cabecera al dar de alta el webhook. |
| `HMS_REGION` | Región, si la cuenta la fija. |
| `LIVE_CREDENTIAL_TTL_SECONDS` | Cuánto dura la credencial de sala. |
| `LIVE_MAX_CONCURRENT` | Techo de emisiones simultáneas. |
| `LIVE_MAX_DURATION_MINUTES` | Duración máxima. |

**En la app** (desde el 23/09/2026) hay dos llaves, y hacen falta las dos:

| Dónde | Qué |
|---|---|
| `EXPO_PUBLIC_FEATURE_LIVE=on` en cada perfil de `eas.json` | La BUILD sabe hacer directos: lleva el SDK y los permisos nativos (versión 1.1.0 en adelante). La web no la lleva. |
| `GET /api/v1/live/availability` → `{video, provider}` | El SERVIDOR tiene 100ms configurado. «Vivo» lo pregunta antes de ofrecer emitir. |

Encender o apagar los directos es, por tanto, cambiar la configuración del
**servidor** (§16) y renovar las máquinas; la app no necesita otra versión.

**Reglas que no se negocian:**

- `HMS_APP_SECRET` **jamás** en la aplicación. Un `.apk` se abre con un editor de
  texto, y quien tenga ese secreto puede firmarse un token de anfitrión de la
  sala de cualquiera.
- **Nunca** en una variable `EXPO_PUBLIC_*`: esas van al paquete.
- No se registran tokens completos, ni cuerpos de respuesta, ni el nombre de la
  plantilla.
- **La configuración se comprueba entera.** Con la clave puesta y la plantilla
  sin poner, crear una sala falla a mitad de camino y deja una emisión sin sala;
  es preferible no empezar. Ver `Settings.live_configurado`.

---

## 4. Roles

Traducción centralizada en `live/roles.py`. Los nombres del lado derecho tienen
que existir **en la plantilla de 100ms**; si allí se llaman de otra forma, se
cambia ahí y en ningún otro sitio.

| Rol de Z | En el proveedor | Publica | Modera |
|---|---|:--:|:--:|
| Propietario | `host` | ✅ | ✅ |
| Moderador | `moderator` | ✅ | ✅ |
| Invitado | `guest` | ✅ | ❌ |
| Espectador | `viewer` | ❌ | ❌ |

**El rol lo decide el servidor y viaja firmado dentro del token.** El cliente
pide una credencial; no pide un rol. Aunque alguien mande `role: "host"` en el
cuerpo, el endpoint ni lo lee.

Detalles que importan:

- **Ser propietario manda sobre ser administración.** Quien emite es el anfitrión
  de lo suyo, no un moderador de su propia sala.
- **Administración entra como moderadora en CUALQUIER sala**, y por tanto puede
  publicar en ella. Es coherente con el resto del módulo —`_puede_gestionar` ya
  le deja esconder mensajes y cerrar cualquier emisión— pero conviene decirlo
  claro: **hoy no existe un permiso de moderación de directos separado del rol
  general de administración**. El día que lo haya, se cambia el argumento en el
  router y `roles.resolver` no se entera.
- **`invitado` está implementado y hoy no lo usa nadie.** `resolver` acepta una
  lista de invitados, pero el router no se la pasa: no hay pantalla para
  designarlos. Se deja porque el contrato lo pide y falla hacia `espectador`,
  que es el lado seguro.
- Un rol desconocido cae a **espectador**, nunca al revés. Equivocarse hacia
  «espectador» cuesta que alguien no hable; hacia «anfitrión», que cualquiera
  publique en la sala de otro.

---

## 5. Estados

El modelo tiene cuatro y **no se han cambiado**: renombrarlos exigiría tocar el
CHECK de la 0029, o sea una migración, y no hace falta.

```text
scheduled ──▶ live ──▶ ended
    │           │
    └──▶ cancelled
```

| Concepto del encargo | En Z |
|---|---|
| `scheduled` | `scheduled` |
| `ready` (sala preparada) | **no existe.** La sala se abre al empezar, no al programar: preparar salas para emisiones que quizá no ocurran es pagar por nada |
| `live` | `live` |
| `ended` | `ended` |
| `cancelled` | `cancelled` |
| `failed` | *no existe*: un fallo del proveedor **no** cierra la emisión |

**Por qué no hay `failed`.** Un fallo del proveedor puede ser pasajero y el
anfitrión puede estar reconectando; marcar la emisión como fallida le quitaría la
sala debajo. Se deja constancia en el registro y lo resuelve el propio anfitrión
al terminar, o **la caducidad por duración** (abajo). Añadir el estado exigiría
una migración y todavía no hay ningún caso que lo pida.

### Cómo se cierra una emisión abandonada

El móvil del anfitrión se queda sin batería. El proveedor manda `session.failure`,
que a propósito no cierra nada, y nadie pulsa «terminar». Sin más, la emisión se
quedaría `live` para siempre y la sala del proveedor abierta y facturando.

Lo cierra `LIVE_MAX_DURATION_MINUTES`, y **se comprueba al mirarla**, no con una
tarea programada: cualquiera que pida credencial —o cualquiera que intente
empezar otra emisión— cierra de paso las que se pasaron de tiempo. El proyecto no
tiene planificador, y montar uno por esto sería pagar una infraestructura entera
por un problema que se resuelve así. Lo que cuesta dinero es la sala, y la sala
se cierra en cuanto alguien pasa por ahí.

### Concurrencia

Todo cambio de estado por aviso va con **UPDATE condicional**, así que:

Los tres cambios de estado que dispara el cliente —empezar, terminar, cancelar—
van con `UPDATE ... WHERE status = <el que leímos>` y se comprueba `rowcount`.
Quien llega tarde recibe `live_state_changed` y no pisa nada.

| Caso | Qué pasa |
|---|---|
| Dos inicios a la vez | Uno gana; el otro afecta a cero filas |
| Empezar y cancelar a la vez | Uno gana. Antes se pisaban y la fila quedaba `cancelled` **con la sala abierta** |
| Aviso repetido | Cero filas la segunda vez |
| Aviso tardío sobre una emisión ya terminada | No la reabre |
| Cierre sobre una emisión programada | **No** la termina |
| Terminar desde el cliente y por aviso | Idempotente |

---

## 6. Endpoints

Prefijo `/api/v1/live`. Los que ya existían no han cambiado de forma.

| Método | Ruta | Novedad |
|---|---|---|
| `POST` | `/sessions/{id}/credential` | Ahora devuelve `provider`, `role` y `room_id` |
| `POST` | `/webhook/100ms` | **Nuevo** |

### La credencial

```json
{
  "provider": "100ms",
  "token": "<jwt corto>",
  "url": "",
  "expires_in": 3600,
  "can_publish": true,
  "role": "host",
  "room_id": "<id público de sala>"
}
```

`url` va vacía: en 100ms la sala viaja dentro del token. El campo se conserva
porque el contrato es común a todos los proveedores y otros sí la usan.

**Lo que NO devuelve nunca**: el secreto de la aplicación, la clave de acceso, la
plantilla, credenciales de administración, la configuración de la cuenta ni
información de otros participantes.

Errores posibles:

| Código | Cuándo |
|---|---|
| `live_not_available` | La 0029 no está aplicada |
| `live_credential_rate_limited` | Demasiadas peticiones seguidas |
| `live_not_joinable` | La emisión está `ended` o `cancelled` |
| `live_provider_not_configured` | Bandera apagada o configuración incompleta |
| `live_provider_missing` | La emisión apunta a un proveedor retirado |
| `live_provider_unavailable` | El proveedor no responde o contesta algo ilegible |
| `live_room_missing` | La sala ya no existe |
| `live_provider_busy` | El proveedor devolvió 429 |
| `live_provider_error` | Cualquier otro fallo del proveedor |
| `live_not_live` | Se intentó terminar algo que no estaba emitiendo |
| `live_state_changed` | Otro cambió el estado entre que se leyó y se escribió |
| `live_too_many_concurrent` | Se alcanzó el techo de emisiones simultáneas |

---

## 7. Idempotencia

### La sala

**Una por emisión, pase lo que pase.** El nombre de la sala en 100ms *es* el
identificador de la emisión, así que la idempotencia la garantiza el proveedor y
no una comprobación nuestra que dos procesos pasarían a la vez:

1. Se consulta por nombre.
2. Si no está, se crea.
3. Si entre las dos cosas otro la creó, 100ms rechaza el nombre repetido; se
   recoge el choque y se recupera la suya.

Doble pulsación, reintento tras un tiempo de espera agotado y dos procesos
simultáneos acaban con **la misma sala**.

### Los avisos

Dos capas, y la segunda es la que de verdad protege:

1. Una lista de avisos ya vistos, **en memoria**. Con dos trabajadores cada uno
   lleva la suya, así que solo evita trabajo repetido y ruido en el registro.
2. **El efecto es idempotente**: el UPDATE es condicional, así que aplicarlo dos
   veces no cambia nada la segunda.

> Un deduplicado persistente exigiría una tabla nueva, o sea una migración.
> **Está pendiente de autorización** y hoy no hace falta, porque la protección
> real es la segunda capa.

---

## 8. Webhooks

`POST /api/v1/live/webhook/100ms`

### Cómo se comprueba que el aviso es suyo

**100ms no firma el cuerpo** como hace Stripe. Lo que ofrece es una cabecera de
autorización que se declara al dar de alta el webhook en su panel y que llega
igual en cada aviso. Lo que se compara es ese secreto, con `compare_digest` y no
con `==`.

**Esto es más débil que una firma HMAC, y conviene decirlo.** Un secreto
compartido demuestra que quien llama lo conoce; una firma demuestra además que el
cuerpo no se tocó por el camino.

La mitigación es de diseño: **el aviso no crea nada**. Lo único que puede hacer es
cerrar una emisión que ya existía y que ya estaba viva. La función `verificar`
está aislada a propósito: el día que la cuenta tenga firma, se cambia esa función
y no se toca nada más.

**Falla en cerrado**: sin `HMS_WEBHOOK_SECRET` no se acepta ningún aviso.

### Qué se hace con cada uno

| Evento de 100ms | Efecto |
|---|---|
| `session.close.success`, `room.end.success` | Cierra la emisión **solo si estaba `live`** |
| `session.failure` | Se registra. **No** cierra: el anfitrión puede estar reconectando |
| `session.open.success` | Se registra. Quien decide que está viva es quien pulsó «empezar» |
| `peer.join.success`, `peer.leave.success` | Se registran |
| Cualquier otro | Se ignora sin fallar |

Se responde `204` casi siempre, a propósito: un error hace que el proveedor
reintente en bucle, y hay avisos que nunca van a cuadrar. Lo único que se rechaza
con error es una autorización que no cuadra.

---

## 9. Errores y degradación

**Falla de forma clara y segura, y nunca al revés.**

Al cliente **no** le llega: traza de pila, respuesta cruda del proveedor, nombre
de un secreto, identificadores internos ni detalles de infraestructura.

| Situación | Recuperable | Qué ve la persona |
|---|:--:|---|
| Bandera apagada | ❌ | «El vídeo no está disponible» |
| Configuración incompleta | ❌ | Lo mismo |
| Emisión terminada | ❌ | «Esta transmisión ya terminó» |
| Sin permiso | ❌ | «No puedes ver esta transmisión» |
| Cámara o micrófono denegados | ❌ hasta que se conceda | Cómo activarlo en Ajustes |
| Proveedor sin responder | ✅ | «Inténtalo en un momento» |
| Sala no encontrada | ❌ | «Esta transmisión ya no tiene sala» |
| 429 del proveedor | ✅ | «Demasiadas peticiones» |
| Red intermitente | ✅ | Reconectando |

Un **tiempo de espera agotado no es un fallo**: no dice si la sala se creó. Por
eso el adaptador consulta antes de reintentar, en vez de crear otra.

---

## 10. Costos y límites

| Palanca | Variable |
|---|---|
| Emisiones simultáneas | `LIVE_MAX_CONCURRENT` — se comprueba al empezar |
| Duración máxima | `LIVE_MAX_DURATION_MINUTES` — cierra al mirarla (§5) |
| Duración de la credencial | `LIVE_CREDENTIAL_TTL_SECONDS` |
| Quién publica | La plantilla + `roles.py` |
| Calidad inicial | La plantilla de 100ms |
| Grabación | **Desactivada.** Se activa en la plantilla, no en el código |

Además: no se emiten credenciales para una emisión que no es visible, ni para una
terminada, y cerrar la emisión deshabilita la sala para que no queden salas
huérfanas consumiendo.

**Los precios de 100ms no están en el código ni lo estarán.** Cambian, y
pertenecen a la documentación operativa y al contrato con el proveedor.

---

## 11. Pruebas

| Fichero | Qué cubre |
|---|---|
| `test_directo_100ms.py` | Contrato, configuración incompleta, roles, tokens, idempotencia de sala, errores traducidos, interpretación de avisos |
| `test_directo_credencial_y_webhook.py` | El endpoint de credencial y el de avisos, de punta a punta |
| `test_directos.py`, `test_chat_directo_unico.py` | Lo que ya había: sesiones, chat, reacciones, moderación |

**Ninguna prueba llama a 100ms.** El cliente HTTP se inyecta: comprueban lo que
hace Z con lo que contesta el proveedor, no que el proveedor conteste. Una prueba
que salga a la red de un tercero falla los lunes por motivos que no son nuestros.

---

## 12. Activación progresiva

**Preparada, no ejecutada.** Hoy (23/09/2026) está entre el 2 y el 3: el código
completo está en `Edson` y falta conectar la cuenta (§16).

1. **Bandera apagada.**
2. Desarrollo contra los dobles. ← hecho, incluido pintar el vídeo
3. Cuenta de 100ms y plantilla creada. ← siguiente (§16)
4. Prueba interna, solo administración.
5. Un creador autorizado.
6. Un grupo pequeño de espectadores.
7. Vigilar errores y coste.
8. Ampliación gradual.
9. **Rollback: apagar `FEATURE_LIVE`.**

### Rollback

Apagar la bandera es suficiente y es inmediato. El módulo vuelve a su estado de
fábrica: sala, chat, reacciones y moderación siguen funcionando; lo único que
falta es la imagen.

**Apagar 100ms no afecta a cursos, mensajes, publicaciones, pagos ni
devoluciones.** No comparten ni código ni configuración.

---

## 13. Monitoreo

Todo va a `renaser.live`, con identificadores de correlación y **nunca** tokens ni
secretos.

| Se registra | Nivel |
|---|---|
| Credencial emitida (sesión, usuario, rol) | `info` |
| Aviso aceptado / rechazado | `info` / `warning` |
| Emisión cerrada por aviso | `info` |
| Fallo informado por el proveedor | `error` |
| Sala que no se pudo cerrar | `warning` |

Métricas conceptuales, con sus puntos de instrumentación ya en el código:
intentos de inicio, inicios con éxito, fallos de conexión, reconexiones,
espectadores concurrentes, duración, errores por tipo y avisos repetidos.

> **No se ha integrado ninguna plataforma de métricas nueva.** El proyecto no
> tiene una, y meterla por esto sería pagar una infraestructura entera por un
> problema que todavía no se tiene.

---

## 14. Cambiar de proveedor en el futuro

Lo que tendría que cumplir otro (por ejemplo Amazon IVS):

- `abrir_sala` idempotente por identificador de emisión.
- `cerrar_sala` que se pueda llamar dos veces sin fallar.
- `credencial` por persona y rol, de corta duración, firmada en el servidor.
- `estado_de_sala` para poder conciliar.
- `interpretar_evento` para sus avisos.

**Neutral, no habría que tocarlo:** estados del dominio, permisos, endpoints
públicos de Z, modelos de pantalla, chat, reacciones, moderación, navegación y
reglas de visibilidad.

**Habría que adaptar:** el nombre de los roles en la plantilla, la forma de
autenticar los avisos, y si el proveedor necesita URL además de token.

**Específico de 100ms hoy:** la sala viaja dentro del token (por eso `url` va
vacía), el nombre de sala único por cuenta es lo que da la idempotencia, y la
autenticidad de los avisos es por cabecera y no por firma.

---

## 15. Lo que falta

### Hecho el 23/09/2026 (rama `Edson`)

- **El vídeo se ve.** El adaptador conectaba pero nunca contaba qué pistas había,
  así que la pantalla no dibujaba nada y quien miraba se quedaba en «esperando
  al anfitrión». Ahora escucha `ON_TRACK_UPDATE` / `ON_PEER_UPDATE`, publica las
  pistas y `LiveScreen` las dibuja con `sdk.HmsView` (`salaDeVideo100ms.ts`).
  Quien emite ve su cámara; quien mira, la del anfitrión.
- **Quien mira pasa a «en directo»** cuando llega imagen o sonido ajeno
  (`laSalaCambioDePistasAjenas`), no solo cuando publica él mismo.
- **El nombre de cada persona** viaja al entrar (antes era el id de la sala).
- **Terminar echa al público** (`end-room` con `lock`) antes de deshabilitar.
- **El techo de emisiones** se aplica también al nacer en directo.
- **Una emisión en directo sin sala se repara** al pedir credencial.
- **Permisos nativos** que pide 100ms (Bluetooth, estado de red; red local en
  iOS) → la app sube a **1.1.0**: los directos necesitan esa build nueva.
- `FEATURE_LIVE` de la app deja de ser `false` a fuego (ver §3).

### Depende de la cuenta de 100ms → §16

### Depende de una decisión

- **Deduplicado persistente de avisos**, que exigiría una migración.

### No probado

**Nada de esto se ha probado contra una cuenta real de 100ms ni en un
dispositivo.** Las pruebas automáticas usan dobles, que es lo correcto, pero no
sustituyen a dos teléfonos y una sala de verdad. Riesgo concreto: el SDK usa un
componente de vista antiguo y el proyecto tiene la Nueva Arquitectura activada;
funciona por la capa de interoperabilidad de React Native, pero solo un
teléfono real confirma que la imagen se pinta. Lista de QA en
`docs/Z_QA_FISICO_PENDIENTE.md` §5.

---

## 16. Conectar la cuenta de 100ms, paso a paso

### A. En el panel de 100ms (dashboard.100ms.live)

1. **Plantilla nueva** (*Templates › Create template*), de vídeo en tiempo real.
   Los roles tienen que llamarse **exactamente** así:

   | Rol | Publica | Se suscribe a | Para qué |
   |---|---|---|---|
   | `host` | audio y vídeo | `host`, `moderator`, `guest` | quien emite |
   | `moderator` | audio y vídeo | `host`, `moderator`, `guest` | administración |
   | `guest` | audio y vídeo | `host`, `moderator`, `guest` | invitados (hoy no se usa) |
   | `viewer` | **nada** | `host`, `moderator`, `guest` | el público |

   `viewer` tiene que ser un rol **en tiempo real (WebRTC)**, no un espectador
   HLS: la app entra siempre con `sdk.join`.
2. En la plantilla: **grabación desactivada**, **HLS y RTMP desactivados** (no
   hay código que los use) y calidad de vídeo de `host` a 720p o menos.
3. Copiar el **Template ID** (*Template › Settings*).
4. *Developer*: copiar el **App Access Key** y el **App Secret**. El secreto no
   se pega en ningún chat ni documento.
5. *Developer › Webhooks*:
   - URL: `https://dzqncwhehxai0.cloudfront.net/api/v1/live/webhook/100ms`
     (o el dominio propio de la API, cuando exista);
   - una cabecera `Authorization` con un valor largo inventado: es el
     `HMS_WEBHOOK_SECRET` de abajo. Para generarlo en PowerShell:
     `-join ((1..48) | % { '{0:x}' -f (Get-Random -Max 16) })`;
   - eventos: sesión abierta y cerrada, entrada y salida de participantes, y
     fallo de sesión.

### B. En el fichero de secretos (fuera del repositorio)

Añadir a `C:\Users\Edwincito\zexcelencia-secretos.json`:

```json
"FEATURE_LIVE": "true",
"LIVE_PROVIDER": "100ms",
"HMS_APP_ACCESS_KEY": "...",
"HMS_APP_SECRET": "...",
"HMS_TEMPLATE_ID": "...",
"HMS_WEBHOOK_SECRET": "..."
```

Opcionales: `LIVE_MAX_CONCURRENT` (3), `LIVE_MAX_DURATION_MINUTES` (180),
`LIVE_CREDENTIAL_TTL_SECONDS` (3600).

### C. En AWS (quien opera, con autorización)

```powershell
$env:RENASERLAB_AWS_ACCOUNT_ID = '302277511407'
.\infra\aws\deploy-renaserlab.ps1 -Accion Secretos -ArchivoDeSecretos C:\Users\Edwincito\zexcelencia-secretos.json
.\infra\aws\deploy-renaserlab.ps1 -Accion Renovar
```

Las máquinas leen el secreto solo al arrancar: sin `Renovar` no cambia nada.
Comprobar `GET /api/v1/live/availability` → `{"video": true, "provider": "100ms"}`
y, en el registro de la API, «Proveedor de directo: 100ms».

### D. En los teléfonos

Build **1.1.0** (APK `preview` para probar; AAB `production` para la tienda).
Las builds 1.0.0 no ofrecen «Vivo»: no llevan los permisos. Prueba con dos
teléfonos: uno emite desde *Crear › Vivo*, el otro entra desde la pestaña Live.
