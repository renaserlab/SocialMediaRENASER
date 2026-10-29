# Hallazgos: Perfil + Ajustes + tema claro/oscuro

Agente 4. Flujos en `e2e/flujos/perfil-ajustes/`, datos en
`e2e/datos/40-perfil.sql`, capturas en `e2e/salida/<fecha>/capturas/`
(referencias en `e2e/referencias/perfil-ajustes/`).

Severidad: **alta** (rompe una tarea o enseña datos falsos), **media** (la
tarea sale pero mal o confunde), **baja** (detalle visual, accesibilidad o
texto).

<!-- HALLAZGOS -->

## Estado de los flujos (28/10/2026, fin de la sesión del agente 4)

| Flujo | Estado |
|---|---|
| `01-perfil-propio` | **Pasa** (pasada `20261028-123950`) |
| `02-editar-perfil` | Pendiente de verificar en dispositivo. La edición en la bandeja sí se verificó (valores comprobados y guardados); se rehízo la restauración (ahora por la API) |
| `03-editar-perfil-validaciones` | Pendiente de verificar en dispositivo. Pasó la validación del nombre vacío; se rehízo para teclear menos |
| `04-seguir-perfil-ajeno` | **Pasa** (`20261028-142352`); luego solo cambió su `onFlowComplete` (ahora por la API) |
| `05-bloquear-y-desbloquear` | **Pasa** (`20261028-165907`); luego solo cambió su `onFlowComplete` (ahora por la API) |
| `06-ajustes-secciones` | **Pasa** (`20261028-160313`) |
| `07-idioma` | Pendiente: nunca se ejecutó (sin turno de dispositivo) |
| `08-tema-claro-oscuro` | Pendiente: nunca se ejecutó (sin turno de dispositivo) |
| `bug-desbloquear-no-refresca-perfil` | Pendiente: su pasada se cortó por pérdida de sesión del entorno |

## PA-01 · La descripción y el nombre no tienen límite en el formulario; el servidor los rechaza con un mensaje genérico — media

- **Dónde:** bandeja «Editar perfil» (lápiz rosa) y `/edit-profile`
  (`CamposDePerfil.tsx`, `useFormularioDePerfil.ts`).
- **Pasos:** Perfil → lápiz → escribir una biografía de más de 600 caracteres
  (o un nombre de más de 120) → «Guardar cambios».
- **Esperado:** el campo no deja pasar del límite (`maxLength`) o enseña un
  contador, y si el servidor rechaza algo, el aviso dice qué campo y por qué.
- **Real:** el formulario acepta cualquier longitud y no avisa. La API
  (`ProfileUpdate`: `bio` ≤ 600, `full_name` ≤ 120) responde **422** y la
  bandeja enseña «No se pudo guardar. Los datos enviados no son validos.»: sin
  decir qué campo, y «validos» sin tilde (`apps/api/app/core/exceptions.py`).
  Quien escribió una biografía larga no sabe cuánto le sobra.
- **Comprobado:** contra la API local (`PATCH /api/v1/profiles/me` con 601 y 121
  caracteres → 422 `string_too_long` en `details`). No se automatiza en Maestro:
  escribir 600 caracteres en este emulador pasa de los 120 s que el servidor de
  Maestro aguanta por orden (`eraseText`/`inputText` ≈ 0,5 s por tecla).
- **Arreglo sugerido:** `maxLength={600}` / `{120}` en los `Input` y un
  contador en la biografía; y traducir `details[].loc` a un aviso por campo.

## PA-02 · Las publicaciones solo de texto no aparecen en el perfil — media

- **Dónde:** `useProfilePosts.ts` (`repartir` filtra `image`/`video`/`audio`)
  y `ProfileGallery`.
- **Pasos:** abrir el perfil de Ana (00-base le da 2 fotos y 1 publicación solo
  de texto, `…a3`) o el de Delia (40-perfil: solo 1 publicación de texto).
- **Esperado:** las publicaciones de texto se ven en algún sitio del perfil,
  o al menos el perfil no dice que no hay nada.
- **Real:** en Ana solo salen las 2 fotos; la de texto no está en ninguna
  pestaña. En Delia el perfil dice «Este perfil aún no ha publicado nada.»
  aunque tiene una publicación pública: es un dato falso a la vista.
- **Captura:** `perfil-ajustes-perfil-propio.png` (2 fotos, falta la de texto)
  y `perfil-ajustes-perfil-ajeno-seguir.png`, de los flujos 01 y 04 (las de
  sus pasadas ya rotaron de `e2e/salida/`; las vuelven a dejar al correrlos).

## PA-03 · El botón ⋮ del perfil se anuncia como «Acción derecha» — baja

- **Dónde:** `ProfileScreen.tsx` pasa `rightIcon="more-vertical"` a
  `AppHeader` sin `rightLabel`, y `AppHeader` cae a `t('common.rightAction')`.
- **Real:** TalkBack lee «Acción derecha» en vez de «Opciones». Los flujos
  tienen que seleccionarlo por ese texto genérico.
- **Arreglo sugerido:** `rightLabel={t('profile.opciones')}`.

## PA-04 · Etiquetas accesibles escritas a mano en español — baja

- **Dónde:**
  - `ProfileScreen.tsx` › `Stat`: `accessibilityLabel={\`Ver ${label}\`}` → en
    inglés se anuncia «Ver Followers», en portugués «Ver Seguidores».
  - `BottomSheet.tsx`: el fondo que cierra la hoja es «Cerrar panel» en los
    tres idiomas.
  - `ProfileGallery.tsx`: «Abrir publicación: …».
- **Esperado:** pasar por `t()` como el resto de textos.

## PA-05 · Privacidad y Términos no se traducen — baja

- **Dónde:** `PrivacyScreen.tsx` / `TermsScreen.tsx` (título, fecha, intro y
  secciones escritos en español en el propio componente).
- **Real:** con la app en English o Português, las filas de Ajustes dicen
  «Privacy Policy» / «Política de Privacidade», pero al abrirlas todo el
  documento (y la cabecera) sale en español. Es coherente con que el texto sea
  un borrador legal, pero conviene decidirlo: o se traduce, o se avisa en el
  propio documento de que solo existe en español.
- **Comprobado:** en el código. `07-idioma.yaml` deja la captura
  `perfil-ajustes-privacidad-en.png` (pendiente de ejecutar en dispositivo).

## PA-06 · Desbloquear desde Ajustes no refresca el perfil: sigue saliendo bloqueado — media

- **Dónde:** `BlockedUsersScreen.tsx` (`unblock`) y `services/cachePerfil.ts`.
- **Pasos:** perfil de Delia → ⊘ «Bloquear a esta persona» → «Bloquear» →
  Ajustes › Cuentas bloqueadas → «Desbloquear» → confirmar → volver a abrir el
  perfil de Delia en menos de 2 minutos (sin cerrar la app).
- **Esperado:** el perfil normal: «Seguir», «Mensaje», descripción.
- **Real:** sigue «Bloqueaste a esta persona» con el botón «Desbloquear»
  (esperado 15 s, no cambia), aunque en la base ya no hay bloqueo
  (`user_blocks` vacío). `unblock` llama a `ProfileRepository.unblock` pero no
  toca `cachePerfil`; el perfil guardado tras bloquear (`isBlocked: true`)
  sigue «vigente» `VIGENCIA_MS` = 2 min y `pedirPerfil` lo devuelve sin
  preguntar al servidor. Quien desbloquea cree que no ha funcionado. Pulsar
  «Desbloquear» otra vez en el perfil lo arregla (repite y refresca).
  Lo mismo pasa con el perfil que ya estaba montado debajo en la pila.
- **Captura:** `perfil-ajustes-bug-perfil-sigue-bloqueado.png`
  (y la de depuración de la primera pasada de `05-bloquear-y-desbloquear`).
- **Flujo:** `bug-desbloquear-no-refresca-perfil.yaml` (etiqueta
  `bug-conocido`: comprueba el comportamiento actual; al arreglarlo, invertir
  el paso «ARREGLO:»). **Pendiente de verificar en dispositivo:** su única
  pasada se cortó antes del paso clave por una pérdida de sesión del entorno
  (ver notas de infraestructura). El fallo en sí quedó reproducido en la
  primera pasada de `05-bloquear-y-desbloquear` (salida `20261028-160313`).
- **Arreglo sugerido:** tras desbloquear, `guardarPerfil({...perfil, isBlocked:
  false})` o un `olvidarPerfil(id)`; y que `ProfileScreen` refresque al
  enfocarse. Probablemente lo mismo vale para seguir/dejar de seguir desde las
  listas de Seguidores/Siguiendo (no comprobado).

## PA-07 · En el perfil bloqueado, «Desbloquear» queda solo y a la izquierda — baja

- **Dónde:** `ProfileScreen.tsx`, `styles.actionRow` con un único botón.
- **Real:** todo el perfil va centrado (foto, nombre, cifras, aviso
  «Bloqueaste a esta persona»), pero el único botón, «Desbloquear», se pega al
  margen izquierdo. Se ve descolocado.
- **Captura:** `perfil-ajustes-perfil-bloqueado.png` (también en
  `e2e/referencias/perfil-ajustes/`).

## PA-08 · Escribir en la bandeja «Editar perfil» es ~30 veces más lento que en /edit-profile — media (rendimiento)

- **Dónde:** `ProfileScreen.tsx`: el borrador (`useFormularioDePerfil`) vive
  en la pantalla del perfil a propósito (para sobrevivir a `ConfirmarRecorte`),
  así que cada tecla repinta TODO el perfil (cabecera, cifras, grupos, oferta,
  accesos, galería) por debajo de la bandeja.
- **Medido (mismo emulador, mismo `Input`, misma orden de Maestro):**
  - en la bandeja, « Editada» (8 caracteres) tardó 84 s y 83 s (≈10 s por carácter);
  - en `/edit-profile`, la descripción entera (41 caracteres) tardó 14 s (≈0,3 s por carácter).
  
  Cada toque en el perfil tarda además 4–14 s en «asentarse» (la pantalla no
  para de cambiar).
- **Esperado:** escribir en la bandeja va igual de fluido que en la pantalla.
- **Por qué importa:** en un Android de gama baja es retraso visible al
  teclear. Es un emulador con render por software, así que la cifra absoluta
  exagera; la proporción (×30 con el mismo campo) es lo que cuenta.
- **Arreglo sugerido:** que el borrador viva en la bandeja (o en un store) y
  el perfil no se suscriba a él; o memorizar (`React.memo`) los bloques del
  perfil que no dependen del formulario.

## Selectores que pedirían un testID

La app no tiene testIDs. Donde el selector por texto es frágil en este módulo:

| Elemento | Hoy se selecciona por | Problema | testID propuesto |
|---|---|---|---|
| Botón ⋮ de la cabecera del perfil | `"Acción derecha"` | Etiqueta genérica (PA-03); cualquier cabecera con botón derecho dice lo mismo | `perfil-opciones` |
| Lápiz rosa de editar perfil | `"Editar perfil"` | Coincide con la fila «Editar perfil» del menú Opciones y con el título de la bandeja | `perfil-editar` |
| Cifras Siguiendo / Seguidores / Me gusta | `"Ver Seguidores"` + `containsChild: "1"`; «Me gusta» con `above:` | La etiqueta lleva «Ver» en español fijo (PA-04) y «Me gusta» no es botón: su número solo se alcanza por posición | `perfil-cifra-seguidores`, `perfil-cifra-siguiendo`, `perfil-cifra-me-gusta` |
| Botón Seguir / Siguiendo | `"Seguir"` / `text: "Siguiendo", below: "Me gusta"` | «Siguiendo» es a la vez el rótulo de la cifra y el del botón | `perfil-seguir` (con `accessibilityState.selected`) |
| Campos de la bandeja «Editar perfil» | `text: "Nombre completo", index: 1` | El rótulo (`Text`) y el campo (etiqueta accesible) dicen lo mismo; se depende del orden | `editar-perfil-nombre`, `-usuario`, `-bio` |
| Botón «Desbloquear» del diálogo | `text: "Desbloquear", below: "Volverás a ver…"` | La fila de Cuentas bloqueadas también dice «Desbloquear» | `dialogo-confirmar` |
| Fila «Modo Oscuro» | `"Modo Oscuro"` + subtítulo `"Actualmente: …"` | Es un botón que alterna, no un interruptor: no hay `accessibilityState.checked` que leer | `ajustes-tema` (y `accessibilityRole="switch"`) |
| Documentos legales | título en español fijo | Con la app en inglés/portugués el título no cambia (PA-05) | `legal-privacidad`, `legal-terminos` |

## Notas de la infraestructura de pruebas (no son fallos de la app)

- **`eraseText` se cuelga en el perfil.** En la bandeja «Editar perfil» y en
  `/edit-profile`, `eraseText` (aunque sean 14 caracteres) no termina y a los
  120 s Maestro da el servidor del dispositivo por muerto. En otras pantallas
  (olvido de contraseña) borra 30 caracteres en 10 s. Va por UiAutomator, que
  espera a que la app esté quieta entre tecla y tecla; los toques en el perfil
  también tardan 4–12 s en «asentarse», así que algo se repinta sin parar en
  esa pantalla. Solución en los flujos: `_sub/borrar.yaml` (Retroceso con
  `pressKey`, que va por `adb shell input keyevent`, ~1,5 s por tecla).
- **El cursor en la biografía (campo de varias líneas).** Tocar el centro del
  campo deja el cursor a esa altura de la ÚLTIMA línea, no al final del texto
  (con la biografía de partida, en mitad de la frase). `pressKey: Remote Dpad
  Down` en la última línea lo lleva al final; pero si el cursor YA estaba al
  final, la tecla no la recoge el campo, el foco salta a otro elemento y lo que
  se teclea después va a otra parte (así acabó una restauración por pantalla
  sacando la app del formulario). Por eso las restauraciones van por la API
  (`_sub/api.js`) y los flujos solo escriben en la biografía en el estado
  conocido de partida. Con el teclado abierto la bandeja se desplaza: se toca
  la biografía primero.
- **Tras «Guardar cambios» la bandeja queda desplazada abajo** y el rótulo
  «Nombre completo» sale por arriba: `index: 1` deja de existir. Se vuelve a
  subir con `_sub/subir-a-los-campos.yaml`.
- **El aviso «Perfil actualizado» no se alcanza a ver**: dura menos que los
  ~14 s que tarda Maestro en dar por terminado el toque en el perfil.
- **Un Modal abierto sobrevive a `openLink`.** Si un flujo se corta con la
  bandeja abierta y luego se navega por enlace (`REINICIAR: "no"`), la bandeja
  sigue encima de la pantalla nueva. Los `onFlowComplete` que restauran abren
  la app reiniciándola.
- **`sembrar.sh` puede dejar al emulador sin sesión a mitad de una pasada.**
  Repone la contraseña de Ana y Beto con la API de admin (`user_modified` en
  `auth.audit_log_entries`), lo que invalida el refresh token que guarda la
  app. El token de acceso sigue valiendo hasta que caduca, y entonces la app
  pierde la sesión: «Cuentas bloqueadas» enseñó «Ocurrió un error» y, al
  reiniciar Expo Go, el perfil salía como sin cuenta («Descubre el contenido
  de Delia»). Pasó en la pasada `20261028-165907`, tras una siembra de otro
  módulo a las 16:48. `iniciar-sesion.yaml` solo mira si el correo sale en
  Ajustes, así que no lo detecta. Si no es eso, habría que mirar cómo la app
  trata un refresh rechazado (enseña un error genérico en vez de pedir entrar).
- **UiAutomator no ve nunca la app «quieta».** El logcat de una pasada de 7
  minutos tiene 7779 avisos `QueryController: Could not detect idle state`. Es
  lo que hace lentos los toques y lo que cuelga `eraseText` (ver arriba).
- **Escribir 600 caracteres no cabe** en el límite de 120 s por orden de
  Maestro (≈0,4 s por carácter). Por eso PA-01 se comprobó contra la API.
