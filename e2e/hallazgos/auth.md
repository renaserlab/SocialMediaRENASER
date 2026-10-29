# Hallazgos: módulo `auth`

Encontrados por la suite E2E (`e2e/flujos/auth/`) el 28-10-2026, en Expo Go 54
sobre `Pixel_6_API_36` contra el backend local.

| Id | Gravedad | Resumen | Flujo |
|---|---|---|---|
| AUTH-02 | **Media** | El registro acepta correos sin dominio («ana@gmail») que luego la recuperación rechaza | `bug-registro-correo-sin-dominio.yaml` (reproduce el fallo; falla cuando se arregle) |
| AUTH-01 | Baja | La flecha «Volver» de la pantalla de idioma del primer arranque no lleva a ningún sitio | `01-idioma-primer-arranque.yaml` (pasa: documenta el comportamiento) |
| AUTH-03 | Baja | Un error de correo del servidor en el registro sale en un diálogo, y el de correo repetido junto al campo | `06-registro-correo-usado.yaml` (pasa) |
| AUTH-04 | Baja (accesibilidad) | La pantalla de idioma no expone cuál está elegido | — (visto en la jerarquía de vistas) |

---

## AUTH-02 · El registro acepta «nombre@dominio» y la recuperación no

**Gravedad: media.** Quien se registre con una errata en el dominio (por ejemplo,
`ana@gmail` en vez de `ana@gmail.com`) se queda con una cuenta cuyo correo no
recibe nada, y además no puede ni pedir el enlace de recuperación: esa pantalla
rechaza el mismo correo.

**Pasos**

1. Sin sesión, abrir *Crear cuenta* (`/register`).
2. Nombre `Sin Dominio`, correo `sin-dominio-<n>@e2e`, contraseña válida.
3. Pulsar **Crear cuenta**.
4. Aparte: en *¿Olvidaste tu contraseña?* escribir `nadie@sin-dominio` y pulsar
   **Enviar enlace**.

**Esperado:** en el paso 3, el formulario rechaza el correo igual que la
recuperación («Introduce un correo electrónico válido») y no crea nada.

**Real:** la cuenta se crea y la app entra directamente en el cuestionario de
intereses («1 de 5»). En el paso 4 la recuperación sí lo rechaza: «Escribe un
correo válido.».

**Causa:** las validaciones de cliente no coinciden.
- `RegisterScreen.tsx` y `LoginScreen.tsx`: `if (!email.includes('@'))`.
- `ForgotPasswordScreen.tsx`: `/^\S+@\S+\.\S+$/`.
- Supabase Auth acepta `x@dominio` (un `POST /auth/v1/signup` con ese correo
  devuelve 200). `ana@`, en cambio, lo rechaza («invalid format»).

**Arreglo propuesto:** una sola función de validación de correo (la de la
recuperación, o una algo más estricta) compartida por las tres pantallas.

**Captura:** `hallazgos/auth/AUTH-02-registro-acepta-vs-olvido-rechaza.png` (a la izquierda, el
cuestionario tras registrar `sin-dominio-…@e2e`; a la derecha, la recuperación
rechazando `nadie@sin-dominio`).

## AUTH-01 · «Volver» en la pantalla de idioma del primer arranque no hace nada

**Gravedad: baja (UX).**

**Pasos:** borrar los datos de la app (en Expo Go, `clearState`) → abrir Z →
sale *Idioma* → pulsar la flecha de volver de la cabecera.

**Esperado:** en el primer arranque no hay a dónde volver, así que la flecha no
debería mostrarse (o debería hacer algo visible).

**Real:** la pantalla se queda igual. `LanguageScreen` pinta
`<AppHeader back />`; sin historial, `AppHeader` hace `router.replace('/')`, y
la raíz (`rutaDeArranque`) vuelve a mandar a `/language` porque aún no se ha
elegido idioma. El botón parece roto.

**Captura:** `auth-idioma` (`e2e/referencias/auth/auth-idioma.png`, la flecha
arriba a la izquierda).

## AUTH-03 · Errores de correo del servidor, unos en diálogo y otros en el campo

**Gravedad: baja (UX).**

**Pasos:** en *Crear cuenta*, correo `ana@` (pasa la validación local porque
tiene «@») → **Crear cuenta**. Después, con `ana.e2e@zeta.test` (ya existe).

**Esperado:** los dos problemas son del correo; los dos deberían salir bajo el
campo *Correo electrónico*, como los errores de validación.

**Real:** `ana@` abre un diálogo «No se pudo crear la cuenta · Ese correo no
parece válido…» con «Entendido»; el correo repetido sí sale bajo el campo («Ese
correo ya tiene una cuenta»). `RegisterScreen.submit` solo lleva al campo el
caso `authError.emailTaken`.

**Capturas:** `auth-registro-correo-invalido`, `auth-registro-correo-usado`
(en `e2e/referencias/auth/`).

## AUTH-04 · El idioma elegido no es accesible

**Gravedad: baja (accesibilidad).** En `LanguageScreen` las filas no llevan
`accessibilityState={{ selected }}` ni rol de opción: el elegido solo se marca
con el icono de check y el borde. Un lector de pantalla no sabe cuál está
seleccionado, y una prueba tampoco puede comprobarlo (en la jerarquía de vistas
la fila de «Castellano», elegida, sale con `selected=false` como las demás). La
barra de pestañas sí lo declara (`accessibilityState={{ selected }}` en
`FloatingGlassTabBar`).

---

## Lo que ayudaría a probar (testIDs y accesibilidad)

La app no tiene `testID`. Hoy los flujos se apoyan en textos que cambian con el
idioma o se repiten:

- **Campos de acceso, registro y recuperación:** se localizan por el texto de
  ayuda (`ejemplo@correo.com`, `Tu contraseña`, `Crea una contraseña`,
  `Juan Pérez`). Propuesta: `testID` `acceso-correo`, `acceso-contrasena`,
  `registro-nombre`, `registro-correo`, `registro-contrasena`, `olvido-correo`.
- **Botones principales:** `Iniciar sesión` / `Crear cuenta` aparecen como
  primario en una pantalla y secundario en la otra. Propuesta: `acceso-entrar`,
  `registro-crear`, `olvido-enviar`.
- **Diálogo de confirmación (`DialogHost`):** título y botón dicen lo mismo
  («Cerrar Sesión»); hay que tocar «el que está debajo de la pregunta».
  Propuesta: `dialogo-confirmar` y `dialogo-cancelar`.
- **Pestañas:** la etiqueta accesible cambia con los no leídos («Mensajes. 3 sin
  leer»). Propuesta: `pestana-home`, `pestana-messages`… (el nombre de la ruta).
- **Fila «Cerrar Sesión» de Ajustes:** se toca por su subtítulo para no
  confundirla con la sección «Sesión». Propuesta: `ajustes-cerrar-sesion`.
- **Enlaces «Términos» y «Política de Privacidad» del registro:** son `Text`
  anidados dentro de otro `Text`; en Android solo existen como nodos virtuales
  de accesibilidad y no admiten `testID`. Funcionan, pero conviene sacarlos a
  `Pulsable` propios si se quiere seleccionarlos de forma estable.

## Observaciones del entorno (no son fallos de la app)

- **Foto de perfil vacía en local.** `profileImageUrl` pide el avatar por el
  transformador de imágenes de Storage (`/render/image/...`), que el Supabase
  local no tiene (404). `Avatar` no tiene `onError`, así que en vez de las
  iniciales sale un círculo vacío. En producción el transformador existe; si
  algún día falla, pasaría lo mismo. Por eso `00-base.sql` deja a Ana y Beto sin
  foto.
- **Aviso rojo de `expo-notifications`** en cada arranque (Expo Go no trae push
  en Android). Tapa la parte de abajo de la pantalla, incluido el botón
  «Continuar» del idioma; lo quita `quitar-ruido.yaml`.
- **«System UI isn't responding»** de vez en cuando por la lentitud del
  emulador; lo quita `quitar-ruido.yaml`.
