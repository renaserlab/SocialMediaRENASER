# Hallazgos: Inicio + Explorar + publicaciones

Agente 2. Flujos en `e2e/flujos/inicio-explorar/`, datos en
`e2e/datos/20-inicio-explorar.sql`, capturas en `e2e/salida/` (referencias en
`e2e/referencias/inicio-explorar/`).

Severidad: **alta** (rompe una tarea o enseña datos falsos), **media** (la
tarea sale pero mal o confunde), **baja** (detalle visual, accesibilidad o
texto).

## H-01 · Me gusta en una publicación abierta por enlace: el contador no se mueve y el corazón ignora lo que dice el servidor — media

**Estado:** confirmado leyendo el código; el flujo de regresión
(`publicacion-enlace-directo.yaml`) está escrito pero **pendiente de verificar
en dispositivo** (no llegó a correr: el emulador quedó reservado).

- **Dónde:** `PostDetailScreen.tsx` + `PostCard.tsx` + `useAppStore.toggleLikePost`.
- **Cómo pasa:** al abrir `/post/<id>` en frío (enlace compartido, aviso push),
  la raíz no monta las pestañas debajo (no hay `unstable_settings`), así que el
  muro no se ha cargado y `state.posts` no tiene la publicación. El detalle la
  pide a la API y la guarda en un `useState` local (`pedida`).
  - `PostCard` pinta el contador con `post.likes` de esa copia local, pero
    `toggleLikePost` solo actualiza `likeCounts` y `state.posts`: **el número
    se queda en 0** aunque el corazón se ponga rosa, y el botón «Ver quién
    reaccionó» no aparece.
  - El corazón lee `likedPostIds` del almacén; el `liked_by_me` que manda la
    API (`Post.likedByMe`) solo lo usa el feed de video. Si se reaccionó en
    otro dispositivo (o tras reinstalar), **el corazón sale vacío** y el toque
    intenta dar un segundo me gusta. Lo mismo con `saved_by_me`.
  - Igual con los comentarios: `sumarAlContadorDelMuro` solo toca
    `state.posts`, así que tras comentar el contador del detalle no sube.
- **Pasos:** sesión de Ana → abrir `exp://127.0.0.1:8081/--/post/e2e20000-0000-4000-8000-000000000004`
  con Expo Go parado → «Me gusta».
- **Esperado:** corazón rosa y contador 0 → 1 (y «Ver quién reaccionó»).
- **Real (por código):** corazón rosa, contador en 0.
- **Arreglo sugerido:** que `PostCard` lea `likeCounts[post.id] ?? post.likes`
  (como ya hace con `saveCounts`) y que el detalle siembre
  `likedPostIds`/`savedPostIds` con `likedByMe`/`savedByMe` al recibir la
  publicación.

## H-02 · El botón «Me gusta» no dice si está dado (accesibilidad) — baja

- **Dónde:** `src/components/PostCard.tsx` → `AccionDePublicacion` del corazón.
- **Pasos:** detalle de una publicación → «Me gusta» → leer el árbol de
  accesibilidad (o TalkBack).
- **Esperado:** como «Guardar» y «Repostear», un interruptor con estado
  (`accessibilityRole="switch"` + `accessibilityState.checked`) o una etiqueta
  que cambie («Quitar me gusta»).
- **Real:** antes y después del toque el nodo es el mismo: `Button`,
  `content-desc="Me gusta"`, `checked=false`. TalkBack no tiene forma de saber
  si ya se ha reaccionado; solo cambia el color/forma del icono. Lo confirman
  los volcados del árbol de `publicacion-me-gusta-y-guardar.yaml`.
- **Además:** es también lo que obliga a los flujos a deducir el estado por el
  botón del contador («Ver quién reaccionó»).

## H-03 · El corazón cambia de tamaño al darle (salto de 2–3 dp) — baja

- **Dónde:** `AccionDePublicacion`: sin me gusta pinta `Feather heart` a 20;
  con me gusta, `MaterialCommunityIcons heart` a 21.
- **Real:** el botón pasa de `[130,632][183,688]` a `[123,631][179,689]`
  (1080 px de ancho): el icono y el número se desplazan ~7 px a la izquierda
  cada vez que se da o se quita. Capturas:
  `e2e/hallazgos/inicio-explorar/inicio-explorar-corazon-sin-me-gusta.png`
  (540×570) y `…-corazon-con-me-gusta.png` (540×560): mismo recorte, distinto
  tamaño.
- **Esperado:** el mismo tamaño de caja en los dos estados (p. ej. 20 en los
  dos o un contenedor de ancho fijo).

## H-04 · Textos en español escritos a mano, fuera de i18n — baja

- **Dónde:**
  - `TextoDePublicacion.tsx:70`: el «Con» visible delante de las personas
    etiquetadas (en inglés/portugués seguirá diciendo «Con @beto_e2e»), y las
    etiquetas accesibles «Ver publicaciones de #…» y «Ver el perfil de …».
  - `StoriesRow.tsx:273`: «Ver historia de {nombre}».
  - `StoriesScreen.tsx:328-329`: «Tramo anterior» / «Siguiente tramo».
- **Esperado:** claves en `es.ts`/`en.ts`/`pt.ts` como el resto.
- **Nota:** en Android las etiquetas accesibles de los `<Text>` anidados
  (la #etiqueta y la @mención) ni siquiera se usan: el nodo virtual del enlace
  lleva como descripción el texto del tramo.

## H-05 · El anillo de historia visto / sin ver solo se distingue por el color — baja

- **Dónde:** `StoriesRow.tsx` (`Ring`).
- **Real:** sin ver = degradado rosa; vista = borde gris. Nada más cambia (ni
  icono, ni grosor, ni etiqueta accesible: `content-desc` es «Ver historia de
  Beto Prueba» en los dos casos).
- **Esperado:** la regla 4 de `CLAUDE.md`: «el color nunca puede ser el único
  portador de información». P. ej. `accessibilityHint`/`accessibilityValue`
  («sin ver») y/o un grosor distinto.

## H-06 · Una publicación solo de texto no se puede abrir desde el muro — baja

- **Dónde:** `PostCard.tsx`: lo único que lleva a `/post/<id>` desde el muro es
  un toque en la FOTO (`DoubleTapLike.onSingleTap`).
- **Real:** en las publicaciones sin foto (P1, P2, P4, a3, b3 de la siembra) no
  hay forma de llegar al detalle desde Explorar; solo por el buscador o un
  enlace. Y la foto tampoco es accesible: `PostImage`/`DoubleTapLike` no tienen
  `accessibilityRole` ni etiqueta, así que con TalkBack no se llega nunca al
  detalle (el flujo de comentarios tiene que tocarla por coordenadas).
- **Esperado:** el texto (o la fecha, como en otras redes) abre el detalle, y
  la foto lleva rol y etiqueta.

## H-07 · Todos los círculos enseñan la misma foto, con el texto «LÍDERES RENASER» — media

- **Dónde:** `src/screens/CircleScreen.tsx:108`:
  `<Image source={assets.circle} …/>`. La portada del círculo
  (`circles.cover_path`, que la API devuelve) no se usa nunca.
- **Pasos:** Explorar → tarjeta «Tu círculo» (círculo sembrado «Circulo E2E de
  oficios», sin portada).
- **Esperado:** la portada del círculo o, sin ella, un marcador neutro (icono).
- **Real:** la imagen empaquetada `assets/circle.jpg`, que lleva escrito
  «LÍDERES RENASER»: cualquier círculo aparenta ser ese. Es contenido falso en
  la cabecera, no un simple marcador.
- **Captura:** `e2e/hallazgos/inicio-explorar/inicio-explorar-circulo.png`.

## H-08 · «Podcast» y «Ver más» de Explorar parecen activos pero no hacen nada sin un perfil destacado — baja

- **Dónde:** `ExploreScreen.tsx`: `disabled={!catalogProfileId}` en la tarjeta
  «Podcast» y en «Ver más»; `catalogProfileId` sale del administrador o del
  primer perfil de `/profiles/featured`.
- **Real (entorno local):** no hay administrador ni perfiles destacados
  (`/profiles/featured` devuelve `[]`), así que las dos zonas están
  desactivadas, pero se pintan exactamente igual que cuando funcionan: tocar no
  hace nada y no se dice por qué. En producción existe el administrador y no
  pasa, pero cualquier instalación nueva (o un fallo de esa petición) deja dos
  botones muertos.
- **Esperado:** atenuarlos o esconderlos cuando no hay a dónde ir.
- **Captura:** `e2e/hallazgos/inicio-explorar/inicio-explorar-explorar-portada.png`.

## H-09 · La campana de Explorar se anuncia como «Acción derecha» — baja

- **Dónde:** `ExploreScreen.tsx:757` (`AppHeader rightIcon="bell"` sin
  `rightLabel`) → `AppHeader` cae a `t('common.rightAction')`.
- **Real:** en el árbol, el botón de avisos es `content-desc="Acción
  derecha"`. TalkBack no dice que son las notificaciones (y el punto de «sin
  leer» tampoco se anuncia). Lo mismo pasa con el «…» de la cabecera del
  círculo (`CircleScreen.tsx`).
- **Alcance:** no es solo Explorar: de ~77 `AppHeader` con `rightIcon` en
  `src/screens`, solo ~12 pasan `rightLabel`.
- **Esperado:** `rightLabel={t('settings.notifications')}` (o una clave
  propia que incluya «sin leer» cuando hay punto).

## H-10 · El campo «Responder a …» de una historia casi no se ve sobre fotos claras — baja

- **Dónde:** `StoriesScreen.tsx` (`replyRow`/`replyInput`): borde
  `media.border` = `#242424` y texto de ayuda `media.textMuted` = `#A1A1A1`,
  sin fondo ni degradado detrás.
- **Pasos:** Explorar → historia de Beto (foto clara, `foto-3.jpg`) → mirar el
  campo de respuesta.
- **Esperado:** legible sobre cualquier foto (fondo translúcido oscuro como el
  `overlay` de la paleta, o un degradado inferior).
- **Real:** el borde casi negro y el gris claro sobre el amarillo/verde de la
  foto apenas contrastan (~1,3:1 el texto de ayuda): el campo parece vacío o
  inexistente.
- **Captura:** `e2e/hallazgos/inicio-explorar/inicio-explorar-historia-abierta.png`
  (tomada con el teclado abierto, que es como se pausa la historia en el flujo).

## H-11 · Inicio › Siguiendo anuncia «Sugerencias» encima de una pantalla vacía — baja

**Estado:** por código; **pendiente de verificar en dispositivo**
(`inicio-pestanas.yaml` no llegó a correr).

- **Dónde:** `InicioScreen.tsx`: `conSugerencias = siguiendoVacio && sigueAAlguien`.
- **Caso:** Ana sigue a Beto y nadie tiene videos (la siembra E2E no sube
  ninguno). «Siguiendo» cae a «Para ti» para enseñar sugerencias y pinta el
  aviso «Sugerencias: quien sigues no ha publicado nada nuevo», pero «Para ti»
  también está vacío: debajo sale «Nada nuevo por ahora».
- **Esperado:** el aviso solo cuando hay sugerencias que enseñar
  (`conSugerencias && feedParaTi.items.length > 0`).

## H-13 · El aviso de «Publicación guardada» tapa el botón «Volver» — baja

**Estado:** visto en el emulador el 29-10, con `main` a8d5cb1.

- **Pasos:** abre una publicación, toca «Guardar» (o «Quitar de guardados») y,
  enseguida, la flecha de volver.
- **Esperado:** se vuelve atrás.
- **Real:** el aviso «Publicación guardada · Ver lista» sale arriba, encima de
  la cabecera, y durante unos 5 s tapa la flecha y el título. El toque cae en
  el aviso y no pasa nada. Se ve en `referencias/inicio-explorar/inicio-explorar-guardada.png`
  de la corrida del 29-10 (`salida/20261029-173813`).
- **Por qué no salía antes:** con H-12, Maestro tardaba 12–17 s por toque y el
  aviso ya se había ido.
- **Propuesta:** sacar los avisos abajo (encima de la barra de pestañas) o
  dejar libre la zona de la cabecera.
- El flujo `publicacion-me-gusta-y-guardar` espera a que el aviso se vaya antes
  de volver.

## H-12 · Explorar no deja de pintar aunque nada se mueva — media (rendimiento)

**Estado:** causa **confirmada** el 29-10 (sesion de rendimiento): es el bucle
de `CoachMark`. **Corregido en `main` con #31** (tanda 2, a8d5cb1): en la
suite del 29-10, «Explorar: muro y busqueda» bajo de ~13 a ~7 min. Una guia
VISIBLE sigue latiendo a proposito; las cerradas u ocultas ya no.

- **Confirmacion** (29-10, 11:10–11:17, emulador, Ana en Explorar, 3 tandas de
  5 s sin tocar):

  | | Antes (`perf/tanda-2-pr` e8d0631) | Despues (+ b67be91) |
  |---|---|---|
  | Fotogramas en 5 s, arriba | 62 / 63 / 65 | **0 / 0 / 0** |
  | Fotogramas en 5 s, desplazada | 68 / 71 / 66 | **0 / 0 / 0** |
  | `uiautomator dump` | «could not get idle state» a los 14–19 s | correcto en 2–3 s |

  El arreglo hace que el latido de la guia solo corra con `visible &&
  !dismissed && !reducirMovimiento`. Pasan las 5137 pruebas del movil y `tsc`.
- **Efecto en la suite** (29-10): con la guia del curso a la vista, Maestro no
  llegaba a «Empezar curso» en 45 s (`escuela-leccion-y-progreso`). Los flujos
  la cierran ahora con `_sub/cerrar-guia-del-curso.yaml`; con el arreglo en
  `main` ese subflujo dejaria de ser imprescindible.

- **Medida** (`dumpsys gfxinfo`, 5 s sin tocar nada, la misma sesion de Ana):

  | Pantalla | Fotogramas en 5 s |
  |---|---|
  | Inicio, Perfil, Mensajes, cuestionario | **0** |
  | Explorar (arriba y desplazada) | **53–67** |

  Las capturas seguidas de Explorar son identicas pixel a pixel: pinta sin que
  cambie nada visible.
- **Consecuencias:**
  - `uiautomator dump` no consigue la jerarquia en Explorar («could not get
    idle state») y cada toque de Maestro tarda 12–17 s en volver.
  - Por eso la suite es tan lenta y algunos toasts se van antes de que Maestro
    los vea.
  - En un telefono real son ~60 fps constantes mientras Explorar esta abierto,
    o sea bateria y CPU gastadas.
- **Causa:** `src/components/CoachMark.tsx`. El `useEffect`
  arranca un `Animated.loop` infinito ANTES del
  `if (!visible || dismissed) return null`.
  - Explorar monta dos guias (`primera-publicacion`, `explorar-programa`) aunque
    no se vean, y la ficha del curso una (`curso-temario`).
  - Es ademas el unico bucle de animacion que no respeta «reducir movimiento».
    `Skeleton`, `PuntosDeEscritura`, `RotuloDeDirecto` y `BotonDeNotaDeVoz` si
    usan `useReduceMotion()`.
  - El comentario dice «latido corto… sin animar nada permanente», pero
    `Animated.loop` sin `iterations` es infinito.

## Lo que no se pudo comprobar

- **Avisos (toasts) de guardar / quitar de guardados.** El guardado funciona
  (el interruptor pasa a «Quitar de guardados», `checked`, contador 1), pero
  en este emulador cada toque de Maestro tarda ~12 s en volver (espera a que
  el árbol de accesibilidad cambie) y el aviso dura 5 s. Se comprueban como
  opcionales (salen como aviso en el informe, no como fallo).
- **Reel con contenido en Inicio.** La siembra no sube videos (no hay ninguno
  en `e2e/datos/medios/` y `sembrar.sh` solo sube JPG), así que solo se prueba
  el estado vacío. `inicio-pestanas.yaml` tiene la rama del reel preparada.

## Selectores que pedirían un testID

La app no tiene testIDs. Donde el selector por texto es frágil:

| Elemento | Hoy se selecciona por | Problema | testID propuesto |
|---|---|---|---|
| Botón «Me gusta» de `AccionDePublicacion` | `text: "Me gusta", index: 0` | El rótulo de debajo también dice «Me gusta»; se depende del orden del árbol | `publicacion-me-gusta` |
| Botón «Guardar» | `text: "Guardar", index: 0` | Igual: el rótulo visible dice «Guardar» también cuando ya está guardada | `publicacion-guardar` |
| Contador de me gusta | `childOf: "Ver quién reaccionó"` | Con 0 no es botón y no tiene etiqueta: no hay forma de leer «0» | `publicacion-contador-me-gusta` |
| Foto de una publicación (abre el detalle) | relativo al texto de encima | `PostImage`/`DoubleTapLike` no tienen etiqueta ni rol | `publicacion-foto` (y `accessibilityRole="imagebutton"`) |
| Burbuja de historia | `"Ver historia de <nombre>"` | Etiqueta escrita a mano en español (ver hallazgo de i18n) | `historia-<authorId>` |
| Anillo de historia vista / sin ver | captura recortada | Solo color: no hay nada en el árbol que distinga visto de sin ver | `accessibilityState` o `accessibilityHint` |
| Pestañas de Inicio / Explorar «Para ti» y «Siguiendo» | `text` + `selected` | El mismo texto existe en Inicio y en el control de Explorar, que el carrusel deja montado | `inicio-pestana-para-ti`, `explorar-pestana-para-ti`… |
| Tarjeta «Tu círculo» | `text: "Tu círculo", index: 0` | El texto de la etiqueta y el del título coinciden | `explorar-tarjeta-circulo` |
