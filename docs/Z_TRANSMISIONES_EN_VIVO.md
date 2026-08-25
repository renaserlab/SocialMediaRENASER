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

Lo que sí había era honesto: una pestaña «Live» que decía que no había
transmisiones, un `ModoVivo` que decía que no se podía emitir, `FEATURE_LIVE =
false` y un contrato de datos escrito. Alguien ya había **borrado** una pantalla
anterior que reproducía un vídeo de ejemplo con un chat guardado en memoria y lo
enseñaba como si fuera una emisión.

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
