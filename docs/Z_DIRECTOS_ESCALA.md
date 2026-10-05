# Directos de Z: hasta dónde llega lo que hay, y qué haría falta para más

Escrito el 04/10/2026. Acompaña a [`Z_DIRECTOS_100MS.md`](Z_DIRECTOS_100MS.md).

> **Esto es un diseño, no una capacidad.** Lo que está construido y probado es
> la ruta interactiva (§2). La ruta de gran audiencia (§5 en adelante) está
> **pensada y sin construir**: no hay código, ni banderas, ni infraestructura.
> Z **no soporta hoy audiencias masivas**, y este documento existe para que
> nadie lo dé por hecho.

## 1. Las tres cosas que se confunden

Un directo son tres sistemas distintos, y cada uno se rompe a un tamaño
distinto:

| Qué | Por dónde va hoy | Qué lo limita |
|---|---|---|
| **Vídeo y audio** | 100ms, sala WebRTC | El tamaño de la sala y el plan de 100ms |
| **Chat** | PostgreSQL + `postgres_changes` de Supabase Realtime | Una comprobación de permisos por mensaje **y por suscriptor** |
| **Reacciones** | Broadcast de Supabase Realtime, entre clientes | El reparto: cada envío se entrega a todos los demás |

Que el vídeo aguante una audiencia no dice nada del chat ni de las
reacciones. «HLS reproduce el vídeo para un millón» es cierto y no resuelve
ninguna de las otras dos.

## 2. La ruta interactiva: lo que hay

- **Vídeo:** anfitrión, moderación e invitados publican por WebRTC; quien mira
  se une a la misma sala con el rol `viewer`, que no publica.
- **Chat:** cada mensaje se guarda (`live_messages`) y Realtime lo reparte. En
  el teléfono vive una ventana de 150 mensajes; al entrar se cargan los últimos
  50. Moderar es un cambio en la base que **solo le llega a quien modera y a
  quien escribió**; al resto se le avisa por Broadcast para que vuelva a leer.
- **Canales por espectador:** cuatro. Chat y estado de la sala
  (`postgres_changes`), reacciones y avisos del chat (Broadcast). Todos sobre
  una sola conexión.
- **Reacciones:** cada teléfono manda por Broadcast, como mucho, un mensaje
  cada 300 ms con tipo y cantidad; cada 5 s manda al backend el resumen, que es
  lo único que se guarda.
- **Audiencia:** no se cuenta. El servidor guarda un pico (`viewer_peak`) que
  hoy nadie alimenta: un teléfono solo sabe de sí mismo.

### Lo que protege al teléfono, sea cual sea la audiencia

Está en el código y tiene pruebas (`apps/mobile/src/live/*.test.mts`):

| Límite | Valor | Dónde |
|---|---|---|
| Mensajes de reacciones por teléfono | ≤ 1 cada 300 ms | `reaccionesEnVivo.ts` |
| Reacciones por mensaje, al enviar y al recibir | ≤ 12 por tipo | `reaccionesEnVivo.ts` |
| Reacciones propias esperando a salir | ≤ 60, y caducan a los 10 s | `reaccionesEnVivo.ts` |
| Burbujas en pantalla | ≤ 24 | `burbujas.ts` |
| Burbujas ajenas esperando turno | ≤ 36 | `burbujas.ts` |
| Entrada de reacciones ajenas | por tandas de 90 ms: una suma y hasta 3 burbujas por tanda, lleguen las que lleguen | `burbujas.ts` |
| Mensajes de chat en memoria | ≤ 150 | `ventanaDeChat.ts` |
| Lecturas del chat al servidor | nunca dos a la vez, contando la inicial | `ventanaDeChat.ts` |
| Lecturas por avisos de moderación | ≤ 1 cada 5 s, lleguen los que lleguen | `ventanaDeChat.ts` |
| Preguntar por alguien a quien el servidor no devuelve | ≤ 1 vez por minuto | `ventanaDeChat.ts` |
| Reacciones por resumen | ≤ 200 (lo que admite el backend) | `reaccionesEnVivo.ts`, `limites.py` |

Cada burbuja que termina de subir es además un repintado de la capa de
burbujas (no de la pantalla): con la pista llena, unos 25 por segundo. Acotado,
pero no es «uno cada 90 ms».

Estos límites hacen que un teléfono **no se cuelgue** en una sala grande. No
hacen que la sala grande **funcione**: eso depende de los límites del
proveedor, que son los de abajo.

## 3. Los límites oficiales

Consultados el 04/10/2026. Cambian con el plan y con el tiempo: hay que
volver a mirarlos antes de decidir.

### Supabase Realtime

Fuente: <https://supabase.com/docs/guides/realtime/limits>

| | Free | Pro | Pro sin tope de gasto / Team | Enterprise |
|---|---|---|---|---|
| Conexiones simultáneas | 200 | 500 | 10 000 | a medida |
| Mensajes por segundo | 100 | 500 | 2 500 | a medida |
| Altas de canal por segundo | 100 | 500 | 2 500 | a medida |
| Canales por conexión | 100 | 100 | 100 | a medida |

- **Son del proyecto entero, no de una emisión.** La mensajería privada de Z
  usa las mismas conexiones.
- **No sé qué plan tiene el proyecto.** Ahora mismo no hay acceso al panel de
  Supabase. Hasta que alguien lo mire, el techo real es desconocido.
- **Cómo se cuenta un Broadcast para la factura**
  (<https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages>):
  un envío a 4 oyentes son **5 mensajes** (1 enviado y 4 recibidos). Un cambio
  en la base cuenta **uno por cliente que lo escucha**. Incluidos: 2 millones
  al mes (Free), 5 millones (Pro y Team); el exceso, 2,50 USD por millón.
- **Lo que la documentación no dice:** si el límite de «mensajes por segundo»
  cuenta solo los envíos o también las entregas. Por eso las tablas de §4 dan
  las dos lecturas. **Hay que medirlo** (§8).
- **`postgres_changes` no escala con suscriptores**
  (<https://supabase.com/docs/guides/realtime/postgres-changes>): cada cambio
  se autoriza contra cada suscriptor —«un cambio con 100 suscritos son 100
  comprobaciones»—, en un solo hilo, y a partir de unos 3 000 suscriptores a
  los mismos cambios la propia Supabase recomienda pasar a Broadcast.

### 100ms

Fuentes: <https://100ms.live/docs/server-side/v2/introduction/faq> y
<https://www.100ms.live/docs/server-side/v2/how-to-guides/create-large-rooms>

| | |
|---|---|
| Sala estándar | hasta 2 500 participantes |
| Sala grande (`large_room: true`) | hasta 20 000, con 200 publicando como mucho |
| Regla de flujos WebRTC | flujos subidos + flujos bajados ≤ 10 000 |
| Con una sola imagen en pantalla (1×1) | hasta 1 500 participantes |
| HLS con su chat | hasta 5 000 espectadores |
| HLS sin chat | de 50 000 a 100 000 |
| Retraso de HLS | de 10 a 12 segundos |

**Ni siquiera la documentación de 100ms habla de un millón.** Su cifra más
alta para HLS es 100 000. Más que eso se negocia con ellos y con una red de
distribución; no es algo que se active.

## 4. Tres tamaños

**Supuestos**, que son eso y hay que sustituir por medidas: en un momento de
entusiasmo reacciona el 10 % de la sala, a 2 mensajes por segundo cada uno (el
máximo que permite la aplicación es 3,3); escribe en el chat el 2 %, un
mensaje cada 10 s. «Entregas» es lo que recibe la gente: cada envío se entrega
a todos los demás.

### 100 espectadores

| | |
|---|---|
| Conexiones de Realtime | 100 |
| Reacciones: envíos por segundo | 20 |
| Reacciones: entregas por segundo | ~2 000 |
| Chat: mensajes escritos por segundo | 0,2 |
| Chat: entregas (y comprobaciones de permisos) por segundo | 20 |
| Vídeo | Sala WebRTC estándar, muy por debajo de sus límites |
| Coste relativo de Realtime | Bajo. Una hora con ráfagas el 10 % del tiempo son ~0,7 millones de mensajes |
| Cuello de botella | El límite de mensajes por segundo del plan, **si cuenta las entregas**: 2 000/s roza los 2 500 del plan alto y supera los 500 del Pro |
| Arquitectura | **La actual.** Es el tamaño del piloto |

### 10 000 espectadores

| | |
|---|---|
| Conexiones de Realtime | 10 000: el tope de cualquier plan que no sea a medida |
| Reacciones: envíos por segundo | 2 000 |
| Reacciones: entregas por segundo | ~20 millones. Cada teléfono recibiría 2 000 mensajes por segundo |
| Chat: mensajes escritos por segundo | 20 |
| Chat: entregas y comprobaciones por segundo | 200 000, en un solo hilo de la base |
| Vídeo | Fuera de una sala estándar (2 500) y en el borde de la regla de flujos. Sala grande, o HLS |
| Coste relativo de Realtime | Inasumible con reparto por toque. Con resúmenes a 1 por segundo: 36 millones de mensajes por hora, unos 90 USD por hora de emisión solo en reacciones |
| Cuello de botella | **Todos a la vez:** conexiones, reparto de reacciones, y el chat por `postgres_changes` |
| Arquitectura | Vídeo por **HLS** para quien mira. Reacciones **agregadas** (§6). Chat fuera de `postgres_changes` |

### 1 000 000 de espectadores

| | |
|---|---|
| Conexiones de Realtime | 1 000 000: cien veces el tope de los planes publicados |
| Reacciones | Solo agregadas. Aun así, un resumen por segundo son un millón de entregas por segundo: 3 600 millones por hora, unos 9 000 USD por hora a precio de lista |
| Chat | No hay chat «de todos con todos» a ese tamaño en ningún producto. Muestra, modo lento, o destacados elegidos por moderación |
| Vídeo | HLS con red de distribución, **por encima de lo que 100ms documenta** (100 000) |
| Coste relativo | Lo domina el vídeo (minutos de HLS por espectador) y obliga a contrato a medida |
| Cuello de botella | El transporte de chat y reacciones: un WebSocket por espectador no es el modelo |
| Arquitectura | HLS + distribución contratada. Chat y reacciones por un canal que **no** sea un socket por persona: el resumen dentro del propio flujo (metadatos temporizados de HLS, que el SDK ya expone) o un fichero pequeño servido por la red de distribución y consultado cada pocos segundos |

## 5. La ruta de gran audiencia

```
   Anfitrión, moderación, invitados          Espectadores
   ──────────────────────────────           ─────────────
        sala WebRTC de 100ms    ──HLS──►   reproductor HLS
        (decenas de personas)              (retraso 10–12 s)
                 │                                  ▲
                 │                                  │
                 └────── chat y reacciones ─────────┘
                    por un canal aparte, agregado
```

- **El escenario sigue siendo WebRTC:** quien emite, modera o es invitado está
  en la sala de siempre, con el retraso de siempre (menos de medio segundo).
- **Quien mira recibe HLS:** un reproductor, no una sala. 100ms lo genera
  desde la misma sala; hay que activarlo en la plantilla y arrancarlo al
  empezar la emisión.
- **El retraso cambia el producto.** Quien mira ve lo que pasó hace 10 o 12
  segundos. Una pregunta del chat llega al anfitrión antes de que el
  espectador le haya visto terminar la frase anterior. Las reacciones se
  desincronizan de lo que provocan. No es un detalle técnico: es otra
  experiencia, y hay que decidir si se quiere.
- **Chat y reacciones dejan de depender del vídeo**, que es lo que ya pasa
  hoy: viajan por Supabase, no por 100ms. Eso se conserva.

### Lo que habría que construir (nada de esto existe)

1. En la plantilla de 100ms: HLS activado y un rol para quien mira por HLS.
2. En el backend: arrancar y parar HLS con la emisión; entregar la dirección
   de reproducción en vez de una credencial de sala a quien solo mira.
3. En la aplicación: un segundo modo del adaptador de vídeo que pinte un
   reproductor HLS. El contrato `SalaDeVideo` ya separa «entrar» de «pintar»,
   así que es otro adaptador, no otra pantalla.
4. Decidir **quién** ve por WebRTC y quién por HLS, y cuándo se cambia (§7).

## 6. Reacciones agregadas: el contrato

Hoy cada teléfono reparte lo suyo a todos. Eso es lo que no escala: el número
de entregas crece con el **cuadrado** de la sala. En el modelo agregado solo
publica el servidor, y publica **resúmenes**.

**Del teléfono al servidor** (ya existe, no cambia):

```
POST /api/v1/live/sessions/{id}/reactions
{ "counts": { "corazon": 7, "fuego": 2 } }
```

Con una ventana más corta que los 5 s de hoy (1 o 2 s) para que el resumen sea
reciente.

**Del servidor a todos**, una vez por ventana y por emisión:

```json
{
  "v": 2,
  "ventana_ms": 2000,
  "conteos": { "corazon": 1432, "fuego": 310, "aplauso": 95 },
  "muestra": ["corazon", "corazon", "fuego", "corazon", "aplauso"],
  "totales": { "corazon": 88214, "fuego": 19022, "aplauso": 7431, "asombro": 902, "risa": 3310 }
}
```

- `conteos`: lo que se pulsó en la ventana. Es lo que sube el contador.
- `muestra`: hasta una docena de tipos, en proporción a los conteos. Es lo
  único que se anima. La pista de burbujas de hoy (`burbujas.ts`) ya sabe
  recibir un lote y pintarlo por turnos: no cambia.
- `totales`: el número persistido. Sustituye al contador, no se le suma.

**Lo que cambia de fondo:**

- Los teléfonos **dejan de publicar** en el canal. Solo escuchan. El canal
  pasa a ser privado y de solo lectura, con lo que desaparece también el
  problema de abuso de §9.
- El servidor necesita **un sitio común donde sumar** entre sus instancias.
  Hoy los límites de ritmo del directo viven en la memoria de cada proceso
  (`limites.py`), que con varias instancias ya es una aproximación. Sumar
  ventanas de reacciones así no sirve: hace falta un almacén compartido. Cuál
  —una tabla, Redis— es una decisión que **no se ha tomado** y que este bloque
  no toma.
- La entrega sigue siendo una por espectador y por ventana. Reduce el
  problema de cuadrático a lineal; no lo elimina. Para un millón hace falta
  además otro transporte (§4).

## 7. Cuándo cambiar

Umbrales **propuestos**. Los dos primeros salen de límites documentados; los
otros dependen de una medida que aún no existe (§8).

| Señal | Umbral | Qué hacer |
|---|---|---|
| Espectadores simultáneos en una emisión | **> 100** | Dejar de considerarlo piloto. Medir antes de anunciar nada mayor |
| Mensajes por segundo del proyecto en Realtime | **> 50 % del límite del plan**, sostenido | Pasar las reacciones al modelo agregado (§6) |
| Errores `tenant_events` o `too_many_connections` | **cualquiera** | Lo mismo, y subir de plan mientras tanto |
| Suscriptores al chat de una emisión | **> 1 000** (Supabase avisa a los ~3 000) | Sacar el chat de `postgres_changes`: Broadcast desde el servidor, con modo lento |
| Espectadores simultáneos en una emisión | **> 1 500** (límite de 100ms con una imagen) | HLS para quien mira |
| Conexiones simultáneas del proyecto | **> 70 % del tope del plan** | Chat y reacciones necesitan infraestructura propia |
| Coste de Realtime por hora de emisión | el que fije la empresa | Revisar el modelo antes de crecer |

### Qué métricas mirar

- **Supabase** (panel, informe de Realtime): conexiones simultáneas, mensajes
  por segundo, errores por límite. Uso de CPU de la base durante un directo:
  es donde se nota `postgres_changes`.
- **100ms** (panel): participantes por sala, minutos, eventos de degradación.
- **En el teléfono**, sin enviar nada a ningún sitio: `diagnostico()` del
  canal de reacciones y de la pista de burbujas dan envíos, recepciones,
  descartes, reconexiones y el tamaño máximo de las colas. Son números, sin
  usuarios ni contenido. Sirven en una sesión de pruebas con el teléfono
  conectado; **no hay telemetría** que los recoja.

## 8. Lo que hay que medir antes de fiarse de este documento

Nada de §4 está medido. Antes de una emisión con público real:

1. **Qué plan de Supabase tiene el proyecto** y sus límites efectivos.
2. **Si el límite de mensajes por segundo cuenta las entregas.** Prueba: una
   emisión de ensayo con 20–30 teléfonos reaccionando a la vez, mirando el
   informe de Realtime y si aparece `tenant_events`.
3. **Cuántos teléfonos aguanta la sala** con la plantilla actual sin que 100ms
   degrade la imagen.
4. **Qué le pasa a un teléfono de gama media** con el chat y las reacciones a
   pleno ritmo: fotogramas, temperatura, batería.
   ([`Z_QA_FISICO_PENDIENTE.md`](Z_QA_FISICO_PENDIENTE.md))
5. **Cuánto cuesta una hora** de emisión con N espectadores, sumando minutos
   de 100ms y mensajes de Realtime.

Hasta entonces, lo único que se puede afirmar es: **la lógica entre varios
clientes es correcta** (probada con dobles en memoria) y **los teléfonos están
acotados**. La capacidad de la sala es una pregunta abierta.

## 9. Lo que no resuelve el tamaño

| Tema | Cómo está hoy | Qué haría falta |
|---|---|---|
| **Abuso de los canales de Broadcast** | Son públicos: cualquiera con la clave pública de la aplicación y el identificador de una emisión puede publicar en ellos. La aplicación valida lo que llega (cinco tipos, 12 por mensaje como mucho) y acota lo que pinta, así que no rompe ni cuelga una pantalla. **Sí** puede inflar el contador que se ve —sin tope de ritmo: cincuenta mensajes por segundo son decenas de miles por minuto— hasta que se recarga la emisión; lo que se guarda no lo toca. Un aviso de moderación falso no esconde nada: solo provoca una lectura cada 5 s | Canal privado con políticas sobre `realtime.messages` (<https://supabase.com/docs/guides/realtime/authorization>), donde solo publique el servidor. Es una migración y un ajuste del panel de Supabase |
| **Moderación** | Esconder un mensaje es un cambio en la base que solo recibe quien modera y quien lo escribió; al resto le llega un aviso por Broadcast, mandado **por el teléfono de quien modera**. Si ese aviso se pierde, el mensaje sigue en las pantallas hasta la siguiente lectura de cada una. Los límites de ritmo del chat viven en la memoria de cada instancia de la API | Que el aviso lo mande el servidor al esconder. Con varias instancias, un almacén compartido. A gran escala, modo lento y moderación previa |
| **Conteo de audiencia** | No se cuenta | Presencia de Realtime en el piloto; a gran escala, los datos del proveedor de vídeo, que son aproximados |
| **Costes** | Sin presupuesto por emisión | Un coste por hora y por espectador, y un tope |
| **Observabilidad** | Contadores locales, sin telemetría | Decidir a dónde van, y qué se registra, antes de crecer |

## 10. Resumen

- **Hoy:** emisiones pequeñas, interactivas, con chat y reacciones en tiempo
  real. Probado con dobles; sin probar en teléfonos ni medido con público.
- **Para miles:** HLS para quien mira, reacciones agregadas, chat fuera de
  `postgres_changes`. Diseñado aquí; sin construir.
- **Para un millón:** además, otro transporte para chat y reacciones y un
  contrato a medida con el proveedor de vídeo. Fuera del alcance de cualquier
  ajuste de lo que hay.
