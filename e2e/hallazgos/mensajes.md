# Hallazgos — Mensajes y Notificaciones (agente 3)

Entorno: emulador Pixel 6 API 36 (idioma del sistema **en-US**), Expo Go, Metro
desde `main` 2df306f, Supabase y API locales. Datos: `e2e/datos/30-mensajes.sql`.
Evidencia en `e2e/hallazgos/mensajes/` (recortes a 360 px de ancho).
«Jerarquia» = volcado de `maestro hierarchy`, que es lo mismo que recorre un
lector de pantalla (TalkBack).

Severidad: **Alta** (bloquea o pierde datos) · **Media** (funciona mal o deja
fuera a alguien) · **Baja** (detalle visible o deuda).

| # | Hallazgo | Severidad |
|---|---|---|
| M11 | ~~Buscar en la bandeja descarta la respuesta del servidor: sin resultados se queda en «Cargando…» para siempre~~ **Corregido** en #27 | Alta |
| M12 | A veces el chat se abre a mitad del historial y sin el boton «Ir al último mensaje» (intermitente) | Media |
| M1 | Cada burbuja del chat se anuncia como «Mantén presionado para ver las acciones del mensaje» | Media |
| M2 | «Leído» solo se distingue por el color de las dos marcas | Media |
| M3 | El numero de no leidos de las filas no lo oye el lector de pantalla | Media |
| M4 | La bandeja enseña solo la hora aunque el ultimo mensaje sea de otro dia | Media |
| M5 | Horas y fechas del chat en el idioma del telefono, no en el de la app | Baja |
| M6 | En negrita (no leido) los puntos suspensivos del resumen salen recortados | Baja |
| M7 | La campana de Explorar se anuncia como «Acción derecha» | Baja |
| M8 | Los grupos sin foto llevan la silueta de PERSONA en la bandeja | Baja |
| M9 | «Nuevo me gusta» lleva una medalla; en el resto de la app un me gusta es un corazon | Baja |
| M10 | Textos sin traducir en el mapeo de conversaciones | Baja |

---

## M11 · Buscar en la bandeja descarta la respuesta del servidor — Alta (funcional)

**Corregido** en `main` con #27 (82caf52): el 29-10 la busqueda sin
resultados ya muestra «Nada por aquí». El flujo que lo reproducía pasó a
vigilar que no vuelva: `flujos/mensajes/busqueda-sin-resultados.yaml`. Solo
comprueba el caso sin resultados; que se encuentre una conversacion que no
estaba cargada sigue sin flujo propio.

**Pasos:** Mensajes → tocar «Buscar por nombre o usuario» → escribir «zqx»
(nada lo contiene).

**Esperado:** en uno o dos segundos, «Nada por aquí · Prueba con otro nombre o
quita los filtros».

**Actual:** «Cargando…» indefinidamente (esperado 15 s; la API respondio en
milisegundos) y el indicador del campo girando. Reproducido 2 de 2 veces
(`salida/20261028-140947` y `salida/20261028-151610`).

**Por que (log de la API + codigo).** Cada termino dispara DOS peticiones, la
busqueda y una «pagina 2» con el offset de la lista ANTERIOR:

```
GET /api/v1/conversations?limit=20&offset=0&q=zqx&grouped=true   200
GET /api/v1/conversations?limit=20&offset=3&q=zqx&grouped=true   200
GET …offset=0&q=Carp…  /  GET …offset=3&q=Carp…   (igual con cada letra)
```

En `MessagesScreen.tsx`, cambiar la consulta hace `setHayMas(true)` y
`load(true)` en el mismo efecto; en el render siguiente FlashList (lista vacia
o corta mientras se espera) llama a `onEndReached` → `cargarMas`, que pasa sus
guardas porque `conversacionesRef.current` es la lista VIEJA (no la que se ve,
que ya esta vacia) y hace `++sello.current`. Al volver, la respuesta de la
busqueda ya no es «vigente» y se tira: `servido` nunca alcanza a lo tecleado,
asi que `pendiente` queda en `true` para siempre. `cargarMas` ademas pide
`offset = 3` (el largo de la lista anterior) sobre la consulta NUEVA, saltandose
sus primeros resultados, y los mezcla con la lista vieja (`fusionarPaginas`).

**Consecuencia (deducida del codigo, no probada con >20 conversaciones):**
buscar a alguien cuya conversacion no esta entre las ya cargadas no lo
encuentra nunca: lo local no coincide, la lista queda vacia y la respuesta del
servidor se descarta. Es justo el caso que la busqueda en el servidor queria
resolver. Con coincidencias locales («Carp») se ve bien porque se pinta lo
estrechado en el telefono, pero el indicador sigue girando.

Probable relacion: teclear en este campo va ~10× mas lento en Maestro que en
otros (el indicador que no para impide que la pantalla «se asiente»).

Evidencia: `hallazgos/mensajes/mensajes-busqueda-sin-resultados-cargando.png`.

---

## M12 · A veces el chat se abre a mitad del historial, sin «Ir al último mensaje» — Media (intermitente)

**Pasos:** Mensajes → «Beto Prueba» (21 mensajes; 16 de ayer).

**Esperado:** se abre por el ultimo mensaje («¿Llevas las tazas?»); y si no,
al menos el boton de bajar.

**Actual:** 1 de ~10 aperturas del chat en tres ejecuciones (`salida/20261028-140947`, flujo
`chat-enlace-y-final`): se quedo 20 s mostrando los mensajes 7–14 de AYER,
sin el boton «Ir al último mensaje» (la app cree estar abajo:
`lejosDelFinal` solo se calcula al desplazar). Es el sintoma 1 de
`chatAlUltimoMensaje.test.mts` («al abrir una conversación, a veces había que
deslizar hasta el final»), que se daba por resuelto con
`startRenderingFromBottom`. Puede pesar el emulador lento, pero el usuario no
tiene pista de que hay mas abajo.

Los flujos lo dejan como advertencia (`optional`, etiqueta «M12…») y bajan a
mano, para no tumbar el resto de comprobaciones.

Evidencia: `hallazgos/mensajes/mensajes-chat-abre-a-mitad.png`.

---

## M1 · Cada burbuja del chat se anuncia como «Mantén presionado para ver las acciones del mensaje» — Media (accesibilidad)

**Pasos:** Mensajes → «Beto Prueba» → mirar la jerarquia (o activar TalkBack y
recorrer los mensajes).

**Esperado:** el lector lee el mensaje («¿Llevas las tazas?, 12:11») y, como
pista, que manteniendo pulsado hay acciones.

**Actual:** TODAS las burbujas de texto, propias y ajenas, tienen como nombre
accesible «Mantén presionado para ver las acciones del mensaje». Con TalkBack el
chat entero suena igual y no se oye ningun mensaje. Jerarquia:

```
accessibilityText=Mantén presionado para ver las acciones del mensaje   (una por burbuja)
  text=¿Llevas las tazas?
  text=12:11 PM
```

**Causa:** `src/screens/ChatScreen.tsx` (~l. 2706) pone el texto de ayuda en el
`accessibilityLabel` del `Pressable` que envuelve texto y hora. Deberia ir en
`accessibilityHint`, y el `accessibilityLabel` ser mensaje + hora + estado
(ver M2).

---

## M2 · «Leído» solo se distingue por el color de las dos marcas — Media (accesibilidad / regla de diseño)

**Pasos:** Mensajes → «Beto Prueba». «Lo vi, ¡qué buena! Vamos juntos.» esta
leido por Beto (sembrado); el que se envia en `chat-enviar.yaml` no.

**Esperado:** leido y enviado se distinguen sin depender del color (regla 4 de
`CLAUDE.md`: «el color nunca puede ser el unico portador de informacion»).

**Actual:** las dos marcas tienen la misma forma; solo cambian de gris a
celeste. En la jerarquia la franja solo tiene la hora («11:36 AM»): ningun texto
ni etiqueta dice «Leído»/«Enviado». El comentario de `MarcaDeEntrega.tsx` dice
«la franja donde va ya dice con palabras si el mensaje se envió o se leyó», y no
es asi. Con daltonismo o con lector de pantalla solo se sabe por «Info. del
mensaje» (pulsacion larga).

Evidencia: `hallazgos/mensajes/mensajes-chat-leido-y-enviado.png` (marcas
celestes en las burbujas leidas; grises en «Prueba E2E numero…», abajo).

---

## M3 · El numero de no leidos de las filas no lo oye el lector de pantalla — Media (accesibilidad)

**Pasos:** Mensajes con algo sin leer → jerarquia de la fila de Beto.

**Esperado:** «Chat con Beto Prueba. ¿Llevas las tazas? 2 sin leer».

**Actual:** `accessibilityText=Chat con Beto Prueba. ¿Llevas las tazas?`. El
globo (`GloboDeNoLeidos`) se oculta a proposito
(`importantForAccessibility="no-hide-descendants"`) porque «quien lo pinta ya
anuncia la cuenta en la etiqueta», pero `FilaDeConversacion` no la incluye.
Igual en la lista de un grupo: «General» y las comunidades no dicen su cuenta
(los temas si: «Sin ver: 1»). La pestaña Mensajes si: «Mensajes. Mensajes sin
leer: 4».

---

## M4 · La bandeja enseña solo la hora aunque el ultimo mensaje sea de otro dia — Media (UX)

**Pasos:** Mensajes → fila «Carpinteria E2E» (su ultimo mensaje es de AYER).

**Esperado:** «Ayer» o la fecha, como en cualquier bandeja.

**Actual:** «Grupo para compartir planos … · 9:58 AM»: parece de hoy. Pasa
igual en la lista de un grupo (General y temas). `toConversation`
(`mappers/messageMapper.ts`) usa `formatTime(last_message_at)`, que solo da la
hora; `ListaDelGrupoScreen` usa la misma funcion.

Evidencia: `hallazgos/mensajes/mensajes-bandeja-horas.png` (tercera fila).

---

## M5 · Horas y fechas del chat en el idioma del TELEFONO, no en el de la app — Baja (i18n)

**Pasos:** telefono en ingles, app en Castellano → Mensajes → «Beto Prueba».

**Esperado:** «12:11», «27 de octubre» (o «Hoy»/«Ayer»).

**Actual:** «12:11 PM» en burbujas y bandeja, y el separador de dia en ingles:
«OCTOBER 27», «OCTOBER 28» (y sin «Hoy»/«Ayer»). `formatTime` usa
`toLocaleTimeString([])` y el separador `toLocaleDateString(undefined, …)`
(`ChatScreen.tsx` ~l. 2391): toman la configuracion regional del sistema, no el
idioma elegido. Tambien las notificaciones de mas de 7 dias
(`formatRelativeTime` → `toLocaleDateString()`).

Evidencia: `hallazgos/mensajes/mensajes-separador-de-dia.png`,
`hallazgos/mensajes/mensajes-bandeja-horas.png`.

---

## M6 · En negrita (no leido) los puntos suspensivos del resumen salen recortados — Baja (visual, texto cortado)

**Pasos:** Mensajes con un ultimo mensaje largo y SIN LEER (en
`no-leidos.yaml`: «Te escribo desde la prueba de no leidos»).

**Esperado:** «…prueba de no le…» con sus tres puntos, como cuando ya esta leido.

**Actual:** «…prueba de ..»: el tercer punto (y parte del texto) se corta. En
peso normal se ve bien. Es el resumen de `FilaDeConversacion` con
`weight={sinLeer ? '700' : '400'}` y `numberOfLines={1}`: parece que se mide
con un peso y se pinta con otro.

Evidencia: `hallazgos/mensajes/mensajes-elipsis-en-negrita.png` (arriba sin
leer, abajo leido).

---

## M7 · La campana de Explorar se anuncia como «Acción derecha» — Baja (accesibilidad)

**Pasos:** Explorar → jerarquia de la cabecera.

**Esperado:** «Notificaciones» y, con el punto encendido, «hay avisos sin leer».

**Actual:** `accessibilityText=Acción derecha`: `ExploreScreen` no pasa
`rightLabel` a `AppHeader`, que cae al generico `common.rightAction`. El punto
no tiene texto (lo dice el propio comentario de `AppHeader`, pero el icono solo
no dice «hay algo nuevo»). `notificaciones.yaml` tiene que pulsar «Acción
derecha» por eso.

Evidencia: `hallazgos/mensajes/mensajes-campana.png` (con y sin punto).

---

## M8 · Los grupos sin foto llevan la silueta de PERSONA en la bandeja — Baja (visual)

**Pasos:** Mensajes → «Taller E2E» / «Carpinteria E2E».

**Esperado:** el icono de grupo (ya existen `IconoDeGrupos` / `FotoDelGrupo`, y
la lista del grupo pinta sus iniciales «TE»).

**Actual:** la misma silueta de persona que un chat de dos (`assets.avatar` en
`FilaDeConversacion`). Solo el icono de capas, si hay temas, los distingue.

Evidencia: `hallazgos/mensajes/mensajes-bandeja-horas.png`.

---

## M9 · «Nuevo me gusta» lleva una medalla — Baja (visual, coherencia)

En Notificaciones el aviso de me gusta usa el icono `award` (medalla); en el
muro el me gusta es un corazon (`PostCard`, `DoubleTapLike`). De un vistazo no
se asocia. `mappers/notificationMapper.ts` (`like`, `comment_like`,
`course_purchase` comparten la medalla).

---

## M10 · Textos sin traducir en el mapeo de conversaciones — Baja (i18n, codigo)

`mappers/messageMapper.ts` → `toConversation`: `'Sin mensajes aún'` y
`'Conversación'` van escritos a mano en castellano, fuera de `t()`. En ingles
o portugues una conversacion vacia sale en castellano.

---

## Fragil / pendiente de confirmar

- **Teclear en el buscador de la bandeja va muy lento con Maestro:** «Carpin»
  tardo 64 s (otros campos: 5–8 s por texto entero) y un `eraseText` despues
  no termino en 4 min (`salida/20261028-130741`, flujo `bandeja`). El logcat
  solo dice «Timed out waiting for animations to complete»; lo mas probable es
  el indicador de busqueda que no para (M11). El flujo lo esquiva con textos
  cortos y la «x» del campo.
- **El dispositivo compartido no es FIFO:** `flock` no respeta el orden de
  llegada; una ejecucion de este modulo espero 41 min mientras entraban otras.
- **Horas relativas en las capturas:** los datos se siembran relativos a
  `now()` (asi «ayer», «hoy» y los no leidos son ciertos el dia que se corre),
  de modo que las horas de la bandeja, del chat y los «23m» de
  Notificaciones cambian entre ejecuciones. Son zonas pequeñas; si el umbral
  SSIM de `comparar.sh` las marcara, habria que tapar esas franjas.

## Notas (no son fallos)

- **«Enviar» apagado en el chat:** con las notas de voz activas (`voice_notes`
  en `/conversations/availability`, asi en local) el boton de la derecha con el
  campo vacio es el MICROFONO, no un «Enviar» gris; al escribir pasa a «Enviar
  mensaje». El «Enviar» apagado si existe en el compositor de un TEMA (quien
  administra), y eso comprueba `grupo-temas.yaml`.
- **Abrir Notificaciones marca todo como leido** al instante (por diseño): no
  hay «marcar como leida» por aviso. La prueba comprueba que la API pasa a 0 y
  que al volver ya no hay «Sin leer» ni punto en la campana.
- **Tiempos relativos abreviados** («15m», «1h», «2d») tambien en la etiqueta
  accesible: TalkBack en castellano puede leer «15 m» como «15 metros».
- **Crear tema:** solo quien administra el grupo (lo exige la API,
  `temas._exigir_administrar`). Un miembro normal no ve «Nuevo tema» ni
  «Crear comunidad», y en el tema solo tiene la barra «Aquí solo escribe la
  administración».

## testID que harian robustos los selectores

Hoy todo se selecciona por texto en castellano (cambiar un literal rompe la
prueba). Donde mas ayudaria un `testID`:

| Donde | Propuesta |
|---|---|
| Fila de la bandeja (`FilaDeConversacion`) | `fila-conversacion-<id>` |
| Globo de no leidos (`GloboDeNoLeidos`) | `globo-no-leidos` |
| Campana de Explorar (`AppHeader` derecha) | `boton-notificaciones` |
| Campo y botones del compositor del chat | `chat-campo`, `chat-enviar`, `chat-microfono` |
| Burbuja y su franja de hora/estado | `burbuja-<id>`, `estado-<enviado\|leido>` |
| «Ir al último mensaje» | `chat-ir-al-final` |
| Separador de dia | `separador-dia` |
| Filas de la lista del grupo | `fila-general`, `fila-tema-<id>`, `fila-comunidad-<id>` |
| «Nuevo tema» / «Crear comunidad» / «Unirme» | `crear-tema`, `crear-comunidad`, `unirse-<id>` |
| Fila de notificacion | `aviso-<id>` |
