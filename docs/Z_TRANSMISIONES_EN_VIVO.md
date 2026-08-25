# Transmisiones en vivo — estado técnico

Rama: `Edson`.

**Estado.** La **sala**, el **chat en vivo** y las **reacciones** están
implementados. El **vídeo en directo no**, y es un bloqueo externo: exige un
proveedor con cuenta, claves y coste. Es la misma situación que la pasarela de
pago, y se ha resuelto de la misma forma.

Migración `0029`: **escrita, NO aplicada.**

---

## 1. Qué había antes

Nada, y no por descuido. La auditoría encontró:

| Pieza | Estado real |
|---|---|
| Ingesta (RTMP/WHIP) | No existe |
| Servidor de reparto / SFU | No existe |
| SDK de algún proveedor en `package.json` | Ninguno |
| Entidad de emisión en la base | No existía en 28 migraciones |
| `/media/{id}/hls/...` | Sí existe — pero es vídeo **ya grabado** que el backend empaqueta. No tiene nada que ver con un directo |
| `events.event_type = 'live'` | Es una **etiqueta** de una entrada de calendario con enlace de WhatsApp, no una emisión |

Lo honesto era **solo la mitad**: la pestaña «Live» decía que no había
transmisiones, `ModoVivo` decía que no se podía emitir, `FEATURE_LIVE = false`.

Pero **la pantalla del directo falso seguía viva y era accesible**. La ruta
`app/live/[id].tsx` existía y apuntaba a un `LiveScreen` que reproducía
`SAMPLE_VIDEO_URL` —un clip de ejemplo—, pintaba un chat guardado en el store
del teléfono y anunciaba **«1.245» espectadores inventados**. El comentario de
`FEATURE_LIVE` daba por hecho que esa pantalla se había borrado; no era cierto.

Es el recordatorio de por qué esto importa: apagar la entrada y dejar la
habitación montada no es lo mismo que desmontarla, y cualquiera con la URL
llegaba igual.

---

## 2. Qué se ha construido

```
┌─────────────────────────────────────────────────────┐
│  LA SALA          live_sessions                     │
│  scheduled → live → ended        (o cancelled)      │
├─────────────────────────────────────────────────────┤
│  EL CHAT          live_messages                     │
│  Postgres + Realtime · moderación · RLS             │
├─────────────────────────────────────────────────────┤
│  LAS REACCIONES   Realtime Broadcast (efímero)      │
│  + live_reaction_totals  (solo el total)            │
├─────────────────────────────────────────────────────┤
│  EL VÍDEO         ProveedorDeDirecto  ← BLOQUEADO   │
└─────────────────────────────────────────────────────┘
```

Todo salvo la última fila funciona hoy.

---

## 3. La decisión de rendimiento

Es la razón de que esto tenga la forma que tiene, y son **dos caminos
distintos a propósito**:

### El chat se guarda

Una fila por mensaje, entregada por Supabase Realtime igual que la mensajería
privada desde la `0002`. Se guarda porque hace falta:

- Quien entra a mitad de emisión tiene que ver lo anterior — si no, entra a una
  sala que parece vacía.
- Moderar exige poder esconder **un** mensaje concreto.

A ritmo de conversación humana —unos pocos mensajes por segundo— una fila por
mensaje no es ningún problema.

### Las reacciones no

En una emisión animada se pulsan **cientos por segundo**. Una fila por pulsación
convertiría la base de datos en el cuello de botella de la fiesta.

Los corazones que flotan por la pantalla viajan por **Realtime Broadcast**:
canal efímero entre clientes, sin tocar Postgres. Lo único que se guarda es el
**total**, y lo manda el cliente acumulado cada pocos segundos.

Se pierde saber **quién** pulsó **qué** y **cuándo**. Esa pérdida es deliberada:
nadie necesita ese dato, y guardarlo costaría más que todo lo demás junto.

Y como el cliente cuenta, el cliente puede mentir — así que el servidor
**recorta** el envío a `LIMITE_POR_ENVIO`. Se recorta y no se rechaza: quien
pulsó ciento noventa y manda doscientas diez no está atacando nada.

---

## 4. Límite de ritmo

`limites.py`, **en el servidor**. El chat de un directo es el sitio de Z donde
más barato sale hacer ruido: no hay que seguir a nadie, y lo que se escribe lo
ven todos a la vez. Un límite solo en el botón no es un límite.

12 mensajes por 30 segundos, en ventana **deslizante** — con bloques se pueden
mandar 12 en el segundo 29 y 12 en el 31, que es justo la ráfaga que se evita.

**Lo que esta memoria no es:** vive en el proceso. Con dos trabajadores de
uvicorn el límite efectivo es el doble. Es consciente: protege contra el ruido
accidental y el bucle tonto, que es el 99 % de los casos, y lo que **no** se
puede saltar sigue estando en la base (300 caracteres, solo salas `live`). Un
limitador compartido exige Redis, que hoy no existe en el proyecto.

---

## 5. Permisos y moderación

| Quién | Puede |
|---|---|
| Quien emite | Editar, empezar, terminar, cancelar **lo suyo**; esconder mensajes de su sala |
| Administración | Lo mismo, en cualquier sala |
| Cualquiera con sesión | Ver, escribir mientras esté `live`, reaccionar |
| Sin sesión | Ver la sala y el chat; no escribir |

- **Bloqueos simétricos**: nadie escribe en la sala de quien le bloqueó ni de
  quien bloqueó, y sus mensajes no salen en el historial del otro. Cortar un
  solo sentido dejaría que a quien te bloqueó le siga apareciendo tu chat.
- **Moderar esconde, no borra.** Borrar deja al moderador sin poder explicar
  qué hizo y a quien escribió sin saber qué pasó con su mensaje. Un mensaje
  escondido lo sigue viendo quien lo escribió.
- **Nadie edita un mensaje ya enviado.** Un mensaje que cambia después de leerse
  convierte el registro del chat en algo que no se puede citar.

---

## 6. Estados

`scheduled` → `live` → `ended`, y `cancelled` aparte.

**`cancelled` no es `ended`**, y la diferencia importa: `ended` dice «esto
ocurrió y ya pasó»; `cancelled` dice «esto no llegó a ocurrir». Meterlas en el
mismo estado haría que quien no pudo verla creyera que se la perdió. Una
emisión cancelada solo la ve quien la creó.

**Terminar no puede fallar por culpa del proveedor.** Se le pide cerrar la sala,
pero si no responde la emisión consta como terminada igual: si un error de red
de un tercero lo impidiera, la emisión se quedaría «en directo» para siempre en
la pantalla de todo el mundo.

---

## 7. El vídeo — el bloqueo, dicho claro

| Pieza | Estado |
|---|---|
| Contrato `ProveedorDeDirecto` | **HECHO** |
| Proveedor registrado | `ProveedorNoConfigurado` — falla explícito, no simula |
| Ingesta desde el teléfono | **BLOQUEADO** |
| Reparto a espectadores | **BLOQUEADO** |
| Grabación | **BLOQUEADO** |
| Emisión de credenciales | **HECHO** — el hueco está, falta quién lo rellene |

**Qué falta, y no es código:** elegir proveedor, abrir cuenta, credenciales,
coste asumido, y comprobar que su SDK funciona en **Expo** (varios exigen
`expo-dev-client` o prebuild, lo cual cambia el proceso de publicación).

Mientras tanto la respuesta trae **`playback_available: false`**, para que la
aplicación diga la verdad en vez de dejar un reproductor girando esperando una
imagen que no va a llegar.

> **La credencial se emite siempre en el servidor.** La clave secreta del
> proveedor no puede vivir en la aplicación: un `.apk` se abre con un editor de
> texto. Y el permiso de **emitir** depende de quién pregunta, cosa que solo
> sabe con certeza quien verificó el token de sesión. Deducirlo en el cliente
> sería dejar que cualquier espectador se pusiera a emitir en la sala de otra
> persona.

---

## 7.b Elegir proveedor — los datos para decidir

Precios consultados el **24/08/2026** en las páginas oficiales. Conviene
reconfirmarlos antes de firmar nada: cambian sin avisar.

Escenario del cálculo: **20 h de emisión al mes, 50 espectadores de media**
(= 1.200 min de emisión y 60.000 min-espectador), 720p, grabando todo.

| Proveedor | Coste/mes | SDK en Expo | Latencia |
|---|---|---|---|
| **LiveKit Cloud** (Ship) | ≈ $113 | **Plugin de Expo oficial** | **< 1 s** (WebRTC) |
| **Mux Video Live** | ≈ $33 | **No hay SDK de RN** | ~5 s (LL-HLS) |
| **Amazon IVS** (Adv-SD) | ≈ $53 | Player oficial, **broadcast solo comunitario** | < 5 s |
| **Cloudflare Stream** | ≈ $66 | **No hay SDK de RN** | ~3 s (LL-HLS beta) |
| **Agora** | ≈ $124 | Sin config plugin oficial | < 1 s |

### El dato que decide, y no es el precio

**Si el vídeo va por HLS estándar (25–30 s) y el chat va por Supabase Realtime
(sub-segundo), el chat corre veinticinco segundos por delante del vídeo.** La
gente responde a algo que quien emite todavía no ha dicho. Eso no es un
inconveniente de calidad: rompe la interacción entera, que es justamente lo que
esta funcionalidad existe para dar.

De ahí salen las dos únicas opciones coherentes:

- **WebRTC (< 1 s)** — chat y vídeo sincronizados. LiveKit o IVS Real-Time.
- **LL-HLS (~3–5 s)** — desfase tolerable. Mux o Cloudflare. **Ojo**: LL-HLS
  funciona bien en iOS (AVPlayer) y de forma irregular en Android
  (ExoPlayer/Media3). En Perú, Android domina.

### La recomendación, con su motivo

**LiveKit Cloud** no es el más barato — es el único que se puede poner en
producción esta semana. Es el único con **plugin de Expo oficial y mantenido**
que cubre emisión *y* reproducción; todos los demás obligan a pegar librerías
nativas de terceros o de la comunidad. Para un equipo pequeño esa diferencia
vale más que la diferencia de precio. Tiene región en **São Paulo**, razonable
desde Lima. A la escala real de hoy (~15–20 espectadores) sale **≈ $64/mes**.

**Mux** es 3× más barato y **escala mejor** —100.000 min de entrega gratis cada
mes, permanentes— pero no tiene SDK de React Native ni soporta WHIP: habría que
emitir por RTMP con una librería de terceros y escribir el config plugin de
Expo. Semanas de fontanería nativa.

**Se descartan**: Agora (el más caro y sin plugin oficial), IVS (su SDK de
*broadcast* en RN es comunitario — apoyar la función principal en eso es un
riesgo innecesario) y Cloudflare por WHIP (en su beta WebRTC **no hay
grabación**, lo que mata «ver después»).

### El estado real de los SDK en Expo (24/08/2026)

Antes que el precio, esto: **ninguna opción de emisión funciona en Expo Go.**
Todas exigen `expo-dev-client` + `prebuild`. No es un obstáculo —ya se publica
con EAS— pero conviene saberlo antes de prometer fechas. La *reproducción* sí
funciona en Expo Go con `expo-video` para HLS básico.

| Proveedor | SDK de emisión en RN | Plugin de Expo | ¿`expo-video` reproduce? |
|---|---|---|---|
| **LiveKit** | Oficial, activo (push diario) | **Oficial** `@livekit/react-native-expo-plugin` | Solo vía Egress a HLS |
| **Mux** | **No existe** | vía `react-native-nitro-rtmp-publisher` (trae el suyo) | **Sí, directo** — Mux lo documenta así |
| **Cloudflare** | **No existe** (usa `react-native-whip-whep`) | Sí, pero **falta en el paquete npm 0.7.1** | **No si publicas por WHIP** |
| **Amazon IVS** | **No existe** — solo el *player* es oficial | Ninguno | Sí en low-latency |
| **Agora** | Oficial | Ninguno (hay ejemplo oficial de Expo) | Solo vía Media Push a CDN |
| **api.video** | Oficial, pero **19 meses sin un commit** | Ninguno | Sí, directo |

### Tres cosas concretas que evitan perder días

1. **Cloudflare: WHIP y HLS son excluyentes.** Cita textual de sus docs: *no se
   puede publicar por WHIP y reproducir por HLS*. Publicar por WHIP obliga a
   que **toda** la audiencia vea por WHEP, y en su beta WebRTC **no hay
   grabación**. Eso mata «ver después».
2. **`react-native-whip-whep@0.7.1` tiene un fallo de empaquetado**: su
   `app.plugin.js` no viaja en el paquete de npm, así que la forma documentada
   de declarar el plugin falla. Hay que apuntar a la ruta completa.
3. **La elección de *publisher* y la de *proveedor* son independientes** si se
   va por RTMP. `react-native-nitro-rtmp-publisher` y el de api.video aceptan
   cualquier URL RTMP, así que se puede probar el mismo código contra Mux, IVS
   low-latency y LiveKit Ingress, y decidir el proveedor después. Es la forma
   más barata de no casarse con nadie el primer día.

**Aviso sobre `react-native-nitro-rtmp-publisher`**: es lo mejor que existe hoy
para RTMP en Expo —trae plugin propio, es MIT y se apoya en RootEncoder y
HaishinKit, que son bases probadas— pero tiene **tres estrellas y un único
mantenedor**, y tres meses de vida. Técnicamente correcto, apuesta arriesgada.

### Letra pequeña que muerde

- **Mux**: los 100.000 min gratis son recurrentes incluso con tarjeta añadida.
  Es el dato que sostiene toda su ventaja — **confírmalo por escrito** antes de
  decidir.
- **LiveKit**: los 600 min de egress del plan Ship son un bote compartido entre
  grabación, transcodificación y exportación. 20 h de emisión se los comen.
  El ancho de banda es la variable que muerde: bajar a 480p reduce el coste a
  la mitad. Pon una alerta al pasar de ~400 GB/mes.
- **Agora**: los 10.000 min gratis **desaparecen** al contratar cualquier plan.
- **AWS**: desde el 1/12/2024 cobra **18 % de IGV** a clientes B2C en Perú.
  Registrar el RUC en *Tax Settings* el primer día lo evita.
- Ninguno de los recomendados tiene mínimo contractual.

### Lo que hay que decidir antes, y no puedo decidirlo yo

1. **¿Cuántos espectadores a la vez, de verdad?** Es el 80 % del coste. Por
   debajo de ~30, LiveKit casi no cobra; por encima de ~150, Mux gana claro.
2. **¿Cuánto desfase entre vídeo y chat se tolera?** Si valen 3–8 s, se abren
   las opciones baratas.
3. **¿Emisión de uno a muchos, o con invitados en directo?** Con invitados,
   HLS queda descartado.
4. **¿Cuánto se guardan las grabaciones?** El almacenamiento es acumulativo y
   es el coste que se cuela sin avisar.
5. **¿480p, 720p o 1080p?** Multiplica el coste entre 2× y 4×.
6. **¿Cuántas horas de ingeniería se pueden gastar?** Es la pregunta que separa
   LiveKit (caro, días) de Mux (barato, semanas).

---

## 8. Sin la migración `0029`

Misma regla que la `0027` y la `0028`: desplegar código no puede exigir que una
migración ya esté puesta.

| Endpoint | Sin la 0029 |
|---|---|
| `GET /live/sessions` | `200` con lista vacía — que es la verdad |
| `GET /live/sessions/{id}/messages` | `200` con lista vacía |
| Crear, escribir, reaccionar | `503 live_not_available` |

Nada devuelve 500. `tests/test_sin_migracion_0029.py` lo fija creando el
esquema y **deshaciendo** la migración.

> **Al aplicar la 0029 hay que reiniciar la API.** La comprobación se cachea por
> proceso.

---

## 9. Lo que NO está hecho

- **Vídeo en directo.** Bloqueo de negocio.
- **Recomendar emisiones.** Las salas no tienen temas todavía; cuando las
  tengan, encajan en el mismo Recommendation Profile que personas, cursos y
  contenido.
- **Notificar «alguien que sigues está emitiendo».** Necesita decidir antes la
  política de notificaciones para no convertirse en spam.
- **Limitador compartido entre procesos.** Ver §4.
- **QA en dispositivo.** No se ha probado en un teléfono real.
