# Hallazgos — Eventos + Escuela + Crear + servicios/productos

Modulo `eventos-escuela-crear`. Entorno: Expo Go en el emulador Android,
backend LOCAL (Supabase 127.0.0.1:54321 + API 127.0.0.1:8000), usuaria Ana
(`ana.e2e@zeta.test`). Datos: `e2e/datos/50-eventos-escuela.sql`.

Severidad: **alta** (rompe una tarea o miente al usuario), **media** (confunde o
deja un camino sin salida), **baja** (texto, estilo, deuda).

Estado: **[dispositivo]** = reproducido en el emulador con captura;
**[API]** = comprobado contra la API local; **[codigo]** = visto en el codigo, sin
reproducir todavia.

Las capturas de evidencia se copian a `e2e/hallazgos/eventos-escuela-crear/`
(540 px): `correr.sh` solo conserva las 5 ultimas ejecuciones de TODOS los
modulos y las de `e2e/salida/` desaparecen enseguida.

## Estado de los flujos (28-10-2026)

| Flujo | Estado |
|---|---|
| `eventos-agenda.yaml` | PASA (12:06). Despues se relajo una comprobacion («Ver detalles y reservar» o «Reserva confirmada»): **pendiente de verificar en dispositivo**. Sin linea base (la captura se perdio en la rotacion de `salida/`). |
| `eventos-reservar-gratis.yaml` | PASA (13:26). Despues se añadio esperar a que se vaya el aviso «Cupo reservado» antes de la captura: **pendiente de verificar en dispositivo**. |
| `eventos-con-entradas.yaml` | PASA (14:04), sin cambios. |
| `eventos-mis-entradas.yaml` | PASA (14:04), sin cambios. |
| `bug-eventos-reservas.yaml` (etiqueta `bug-conocido`) | PASA (15:08), sin cambios. Comprueba el comportamiento INCORRECTO de E0, E2, E3 y E4: fallara cuando se arreglen (pasos «ARREGLO:»). Si se quiere la suite en verde sin el, `--exclude-tags bug-conocido`. |
| `escuela-evaluacion.yaml` | PASA (15:08), sin cambios. |
| `escuela-catalogo-y-curso.yaml` | PASA solo (29-10, contra `main` eeb4751) tras cerrar la guía del temario con `_sub/cerrar-guia-del-curso.yaml`. Sigue `pendiente`: dentro de la suite corre después de `escuela-leccion-y-progreso` (Maestro no sigue el orden alfabético) y ve el curso empezado. |
| `escuela-leccion-y-progreso.yaml` | PASA (29-10, contra `main` eeb4751), con el mismo subflujo de la guía. |
| `productos-y-servicios.yaml` | PASA (29-10, contra `main` eeb4751). Al volver de la ficha se comprueba «Nuevos en Z», porque la cabecera se desplaza con la lista. |
| `crear-opciones-y-validacion.yaml` | Nunca corrido: **pendiente de verificar en dispositivo**. |
| `crear-publicar-texto.yaml` | Nunca corrido: **pendiente de verificar en dispositivo**. |
| `_sub/permiso-opcional.yaml`, `_sub/ir-al-editor-de-texto.yaml` | Subflujos de Crear, nunca corridos. |

Semilla `e2e/datos/50-eventos-escuela.sql`: verificada (aplicada a mano dos
veces seguidas y en cada `sembrar.sh` desde las 12:30, sin errores).

---

## Eventos

### E0. La ficha no reconoce la reserva propia: no se puede cancelar — ALTA [dispositivo]
- **Pasos:** Agenda → «Ver detalles y reservar» del destacado («Taller E2E de
  respiración consciente») → «Reservar mi cupo».
- **Esperado:** el boton pasa a «Cancelar mi reserva» (secundario) y cancelar
  pide confirmacion («¿Cancelar la reserva?»).
- **Actual:** el servidor registra la reserva (el aforo pasa de «0 de 30
  cupos» a «1 de 30 cupos» y la agenda muestra «Reserva confirmada»), pero la
  ficha sigue con «Reservar mi cupo». Tocarlo otra vez solo repite «Cupo
  reservado». Como el destacado no tiene boton redondo y su boton lleva a la
  ficha, **la reserva del evento destacado no se puede cancelar en ningun
  sitio de la app**. Todo el codigo de cancelacion de la ficha
  (`alternarReserva`, el dialogo «¿Cancelar la reserva?») es inalcanzable.
- **Causa:** `CatalogRepository.getEvent()` pide la ficha con
  `{ auth: false }` («NO PIDE SESION»), y la API calcula `reserved_by_me` con el
  usuario opcional: sin token es siempre `false`. Basta con mandar el token
  cuando lo haya (la API ya acepta peticiones sin el).
- **Donde:** `apps/mobile/src/repositories/CatalogRepository.ts` (`getEvent`),
  `apps/mobile/src/screens/EventoScreen.tsx` (`cargar`, `alternarReserva`).
- **Captura:** `e2e/hallazgos/eventos-escuela-crear/E0-ficha-1-de-30-y-sigue-reservar.png`
  (flujo `bug-eventos-reservas.yaml`, paso E0).

### E1. La ficha de un evento con entradas ofrece una compra que el servidor tiene apagada — media [dispositivo]
- **Pasos:** Agenda → «Concierto E2E de cuencos tibetanos» → «Elegir entradas».
- **Esperado:** si la venta no esta activa, la ficha no promete precio ni boton
  de compra (o explica que todavia no se vende).
- **Actual:** la ficha muestra «Desde S/ 35.00 PEN» y «Elegir entradas»
  (`GET /catalog/events/{id}` solo mira si existe el esquema, `hay_entradas`),
  pero la pantalla siguiente responde «La venta de entradas aún no está
  disponible» porque `/events/{id}/ticket-types` exige
  `FEATURE_EVENT_TICKETING` (apagada en local). Ademas la reserva gratuita esta
  bloqueada («Este evento se gestiona con entradas»), asi que **nadie puede
  apuntarse** a ese evento de ninguna forma.
- **Donde:** `apps/api/app/modules/catalog/router.py` (`get_event`, bloque
  `hay_entradas`) frente a `ticketing.exigir_entradas_disponibles`.
- **Capturas:** `e2e/hallazgos/eventos-escuela-crear/E1-ficha-promete-entradas.png`
  y `E1-entradas-no-disponible.png` (flujo `eventos-con-entradas.yaml`).
- **Ademas (baja):** el texto «La función está construida pero todavía no se ha
  activado.» es jerga de desarrollo enseñada a quien usa la app.

### E2. El boton redondo «Reservar» de la agenda aparece en eventos con entradas y siempre falla — media [dispositivo]
- **Pasos:** Agenda → fila «Concierto E2E de cuencos tibetanos» → boton «+».
- **Esperado:** en un evento con entradas la fila lleva a la ficha (como hace
  con los «en vivo»), o no ofrece reservar.
- **Actual:** llama a `POST /catalog/events/{id}/reserve`, el servidor responde
  409 «Este evento se gestiona con entradas: elige las tuyas.» y la app enseña
  un generico «No se pudo actualizar la reserva / Inténtalo de nuevo.», que
  invita a reintentar algo que nunca va a funcionar.
- **Donde:** `src/screens/EventsScreen.tsx`, `fila()` → `toggle(event.id)`; el
  listado no trae `access_mode` (solo la ficha lo pide).
- **Captura:** `e2e/hallazgos/eventos-escuela-crear/E2-E7-fila-con-entradas-error-generico.png`
  (dialogo «No se pudo actualizar la reserva / Inténtalo de nuevo.» con
  «Entendido»).

### E3. Un evento SIN FECHA se puede reservar desde la agenda, pero su ficha dice que no — media [dispositivo]
- **Pasos:** Agenda → bloque «Fecha por confirmar» → «Retiro E2E con fecha por
  confirmar» → boton «+» → abrir la ficha.
- **Esperado:** la misma regla en las dos pantallas.
- **Actual:** la fila pinta el boton de reservar (solo lo quita a los
  `past`), el servidor acepta la reserva (`motivo_para_no_reservar` solo
  rechaza lo pasado), y la ficha dice «Todavía no hay fecha: aún no se puede
  reservar.» (`sePuedeReservar` exige `upcoming`). Quien reservo desde la lista
  no ve su reserva en la ficha ni puede cancelarla desde ahi.
- **Visto en el emulador:** tras el «+» la fila pasa a «Reserva confirmada» y la
  ficha dice a la vez «1 de 20 cupos» y «Todavía no hay fecha: aún no se puede
  reservar.».
- **Captura:** `e2e/hallazgos/eventos-escuela-crear/E3-ficha-sin-fecha-1-de-20-y-no-se-puede-reservar.png`
  (flujo `bug-eventos-reservas.yaml`).
- **Donde:** `EventsScreen.tsx` (`grupos.sinFecha.map((e) => fila(e, false))`),
  `src/lib/eventoEnDetalle.ts` (`sePuedeReservar`),
  `apps/api/app/modules/events/states.py` (`motivo_para_no_reservar`).

### E4. El boton redondo cancela una reserva sin preguntar — media [dispositivo]
- **Pasos:** Agenda → fila de un evento ya reservado (icono ✓) → tocarlo.
- **Esperado:** la misma confirmacion que en la ficha («¿Cancelar la reserva?»).
- **Actual:** cancela al instante. El comentario del destacado dice
  precisamente que eso se corrigio («con la reserva hecha, el mismo toque la
  cancelaba sin preguntar»), pero solo en el destacado, no en las filas.
- **Visto en el emulador:** flujo `bug-eventos-reservas.yaml` (paso E4): sin
  dialogo, la fila vuelve a «Reservar».
- **Donde:** `EventsScreen.tsx`, `toggle()`.

### E5. «Mis entradas»: el acceso siempre dice «Cuando compres entradas…» y la reserva gratuita no aparece — baja [dispositivo]
- **Actual:** el subtitulo del acceso en la agenda es `miEntrada.ningunaCuerpo`
  («Cuando compres entradas para un evento aparecerán aquí.») tenga o no
  entradas. Y una reserva gratuita confirmada no emite entrada, asi que tras
  «Reservar mi cupo» la pantalla «Mis entradas» sigue vacia (o, con la venta
  apagada, dice «La venta de entradas aún no está disponible»): no hay ningun
  sitio donde ver las reservas gratuitas propias.
- **Captura:** `e2e/referencias/eventos-escuela-crear/eventos-escuela-crear-mis-entradas.png`
  (con la venta apagada, «Mis entradas» dice «La venta de entradas aún no
  está disponible» aunque se tenga una reserva confirmada).

### E6. Colores en crudo en la tarjeta destacada — baja [codigo]
- `EventsScreen.tsx` `styles.mainCard.borderColor: '#333'`, y `tag`,
  `mainTitle`, `mainDescription`, `mainMeta` con `#DADADA`, `#FFFFFF`,
  `#E7E7E7`. Va contra la regla 4 de `CLAUDE.md` (tokens de tema). Ademas
  `mainMeta` no tiene `numberOfLines`: en una tarjeta de alto fijo (460) con
  `overflow: hidden` y contenido pegado abajo, un lugar largo empuja hacia
  arriba y recorta la etiqueta de modalidad y el titulo.

### E7. Todo evento sin portada enseña el cartel de OTRO evento («ALQUIMIA»), y recortado — media [dispositivo]
- **Pasos:** Agenda con eventos sin `cover_path` (los cuatro sembrados).
- **Esperado:** un marcador neutro (icono o fondo liso), sin texto.
- **Actual:** el respaldo `assets/event.jpg` es un cartel con marca: «ALQUIMIA —
  Experiencia de transformación». Cada evento sin portada parece llamarse
  «Alquimia». En las miniaturas de la lista (70×86, `cover`) el texto sale
  cortado por la izquierda («LQUIMIA…»); en el destacado se ve solo la parte de
  arriba (lineas y circulo). Lo mismo en la ficha y en Explorar.
- **Donde:** `src/data/assets.ts` (`event`), usado en `EventsScreen`,
  `EventoScreen` y `ExploreScreen`.
- **Captura:** `e2e/hallazgos/eventos-escuela-crear/E3-E7-agenda-sin-fecha-con-reservar-y-cartel-alquimia.png`
  (flujo `eventos-agenda.yaml`).

## Escuela

### S7. Ficha del curso: la portada de respaldo ocupa mas que la pantalla — ALTA [dispositivo]
**Corregido en `main` con #31** (tanda 2): la portada pasa a `expo-image` con
`contentFit="cover"` y respeta el 16:9. Comprobado en el emulador el 29-10.
- **Pasos:** abrir «Curso E2E: Respiración consciente» (sin portada) desde
  Escuela o por enlace (`/course/<id>`).
- **Esperado:** portada 16:9 (`styles.hero: { width: '100%', aspectRatio: 16 / 9 }`)
  y debajo titulo, precio, autor y temario.
- **Actual:** la imagen local `assets/course.jpg` (1000×1000) se pinta con su
  tamaño intrinseco (≈1000 dp de alto, mas que la pantalla entera del
  emulador): al entrar solo se ve un fondo negro con rayas ampliado; el titulo,
  «Gratis», el autor y el boton «Empezar curso» quedan fuera, debajo. Parece que
  nada cargo. Con `require()` en Android (Expo Go, SDK 54) el `aspectRatio` no
  manda sobre el tamaño del recurso; darle `height` explicita (o envolverla en
  un `View` con el `aspectRatio`) lo resolveria.
- **Donde:** `src/screens/CourseScreen.tsx` (`<Image … style={styles.hero}>`).
- **Capturas:** `e2e/hallazgos/eventos-escuela-crear/S7-curso-al-abrir.png` (lo que
  se ve al entrar: solo la imagen ampliada) y `S7-curso-portada-ocupa-toda-la-pantalla.png`.
  Reproducido en dos ejecuciones. Efecto colateral en las pruebas: hay que
  desplazarse ~2 pantallas para llegar al contenido, y con el emulador cargado
  cada intento de `scrollUntilVisible` tarda 5–8 s.

### S8. Con el filtro «Avanzado», «Cursos para ti» sigue ofreciendo un curso de principiante — baja [dispositivo]
- El filtro de nivel solo afecta a «Todo el catálogo» (que queda vacio, con su
  aviso al pie, fuera de la vista); arriba sigue la recomendacion de un curso
  «Principiante». Quien filtra cree que el filtro no funciono.
- **Capturas:** `e2e/hallazgos/eventos-escuela-crear/S8-S9-avanzado-muestra-curso-principiante-y-cartel-lider.png`
  y `S8-avanzado-sin-resultados-al-pie.png`.

### S9. Los cursos sin portada usan el cartel de otro programa («LÍDER DE TU VIDA») — media [dispositivo]
- Igual que E7 con eventos: `assets/course.jpg` es un cartel con marca
  («LÍDER DE TU VIDA — Programa online»), y en la tarjeta la linea «Programa
  online» sale cortada por abajo.

### S1. Plurales sin singular: «1 módulos», «1 lecciones» — baja [codigo]
- Ficha del curso y subtitulo de la biblioteca. Las claves en singular
  (`course.moduleOne`, `lessonOne`) existen pero solo las usa `CursosParaTi`.

### S2. «Te faltan 1 por responder.» — baja [codigo]
- `evaluacion.faltan` no tiene forma singular («Te falta 1 por responder.»).

### S3. La ficha del curso no se refresca al volver de una leccion — media [codigo]
- `useCourse` carga solo al montar: tras completar una leccion y volver, el
  «X% completado», el «0 / 3 lecciones» y el boton «Empezar curso» siguen como
  antes hasta salir y volver a entrar.

### S4. Abrir una leccion desde el temario no inscribe — media [codigo]
- Solo «Empezar curso» llama a `enroll`. Si se entra por la fila del temario o
  por la burbuja de guia, el progreso se guarda pero el curso nunca aparece en
  «Mi Biblioteca» ni en «Continúa aprendiendo».

### S5. Formato del porcentaje distinto en dos pantallas — baja [codigo]
- «33 % completado» (`cursos.progreso`, Escuela) frente a «33% completado»
  (`biblioteca.completado`, Mi Biblioteca).

### S6. El estado «completada» de una leccion en el temario solo se ve por el icono — baja [codigo]
- La etiqueta accesible de la fila no cambia al completarla
  («<titulo>, Sin video · 5:00»): un lector de pantalla no lo sabe y Maestro
  no lo puede comprobar. Ademas una leccion de TEXTO dice «Sin video».

## Crear

### C1. Una publicacion de solo texto depende del permiso de fotos — media [codigo]
- «Escribir sin foto» solo aparece en la galeria con permiso concedido. No esta
  en la camara (donde abre Crear) ni en el estado «Sin acceso a tus fotos»: sin
  ese permiso no hay forma de publicar solo texto.

### C2. Deslizar en el editor cambia de modo y pierde el texto escrito — media [codigo]
- El gesto horizontal de `CrearScreen` sigue vivo con el selector oculto;
  desmonta `ModoPublicacion` sin confirmar.

### C3. «Agregar a tu historia» como titulo de la galeria en Publicación y Reel — baja [codigo]
- `StoryGalleryScreen.tsx` usa el mismo titulo en los tres modos.

### C4. Una publicacion de texto no se ve ni en Inicio ni en el perfil — media [codigo]
- Inicio es un muro de video y la cuadricula del perfil solo pinta
  fotos/videos: tras «Publicado», lo publicado solo aparece en Explorar. Parece
  que no se publico.

### C5. La galeria de Crear pide permiso de AUDIO y, si falla, se queda cargando para siempre — media [dispositivo, Expo Go]
- **Visto (Expo Go, 28-10, revision de la suite):** al tocar «Elegir de la
  galería», la pantalla se queda en negro con el icono de recarga. La consola
  muestra: `Uncaught (in promise) Error: Call to function
  'ExpoMediaLibrary.requestPermissionsAsync' has been rejected. → Caused by:
  You have requested the AUDIO permission, but it is not declared in
  AndroidManifest.`
- **Causa:** `StoryGalleryScreen.tsx:122` llama a
  `MediaLibrary.requestPermissionsAsync(false)` sin `granularPermissions`. En
  Android 13+ eso pide fotos, videos Y audio, aunque la galeria solo lista
  fotos y videos. Ademas `ask()` no tiene `try/catch`: si la llamada lanza, no
  llega a `setLoading(false)` y el spinner no termina.
- **En el APK:** el plugin de `expo-media-library` declara `READ_MEDIA_AUDIO`
  por defecto, asi que no deberia romperse. Lo que si pasa es que pide un
  permiso de «música y audio» que la galeria no usa. Falta comprobarlo en el APK.
- **Esperado:** `requestPermissionsAsync(false, ['photo', 'video'])` y capturar
  el error con el estado «Sin acceso a tus fotos».
- **Efecto en la suite:** `crear-opciones-y-validacion` y `crear-publicar-texto`
  no pueden pasar en Expo Go hasta que se corrija. Llevan la etiqueta
  `bloqueado-expo-go`.

## Productos y servicios

### P1. Las valoraciones de un producto nunca se muestran en su ficha — media [codigo]
- `bloqueConDatos('valoracion')` (`src/lib/productos.ts`) exige
  `ficha.rating !== null` y la API siempre manda `rating = null`: el bloque real
  de reseñas es inalcanzable y sale siempre «Todavía no hay valoraciones…».

### P2. El sello «Aprobado por Z» es constante — media [codigo]
- Cualquier producto publicado lleva «Evaluado y aprobado por nuestro
  estándar», tenga o no evaluacion (la taza sembrada no tiene).

### P3. «Agregar a la bolsa» justo debajo de «En Z todavía no se compran productos» — baja [codigo]
- El boton no mira `purchasable` y escribe una fila de carrito aunque la venta
  este apagada.

### P4. Servicios apagado en local — informativo [API]
- `GET /platform/config` → `feature_services: false`. La vertical dice
  «Servicios. Todavía no disponible» y no navega; por enlace directo, «Servicios
  aún no está disponible». No se siembran servicios: serian invisibles.

---

## Donde un testID haria robustos los selectores
- Botones redondos de reservar de cada fila de la agenda (todos «Reservar»).
- Boton de guardar de cada tarjeta del catalogo de cursos y botones de cada
  fila de la biblioteca (etiquetas identicas).
- Estado completado de cada fila del temario y las barras de progreso (sin
  etiqueta; `accessibilityValue` no lo lee Maestro).
- Tarjeta de curso en «Cursos para ti» frente a «Todo el catálogo» (mismo texto).
- «Más opciones» de cada tarjeta del muro (todas iguales).
- Titulo/encabezado de cada pantalla (`AppHeader`): hoy coincide con botones
  («Elegir entradas», «Evaluación», «Descripción»).
