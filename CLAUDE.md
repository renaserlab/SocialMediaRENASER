# RENASER Social Media — contexto de trabajo

App React Native / Expo Router (SDK 54) en `apps/mobile`, dentro de un monorepo
npm. Backend en Supabase (PostgREST + RLS + Storage privado) y una API FastAPI
en `apps/api`.

## Ramas

- `andy` — rama de trabajo de Andy.
- `Edson` — rama del compañero.
- `main` — **produccion**: Vercel despliega la web desde aqui en cada push.

Flujo habitual: trabajar en `andy` → merge a `main` → Vercel redespliega solo en
la misma URL (`social-media-renaser.vercel.app`).

## Restricciones que NO se rompen

1. **No tocar la navegacion ni las rutas.** Todo lo de `apps/mobile/app/` se
   auto-registra en expo-router; renombrar o mover un archivo cambia una URL.
2. **`main` de `package.json` es `expo-router/entry`.** No cambiarlo nunca.
3. **Una sola version de React.** El monorepo hace hoisting; duplicar React
   provoca "Invalid hook call". `metro.config.js` fuerza la resolucion a una
   unica copia — no deshacer eso.
4. **Tokens de tema, nunca hex crudo.** Consumir `@/theme/tokens` y
   `useAppTheme()`. El sistema visual es blanco y negro estricto, iconos Feather.
   El color nunca puede ser el unico portador de informacion: acompanar con
   icono, texto o borde.
5. **`.env` esta en `.gitignore` y contiene claves. No commitearlo jamas.**
   Sin el, la app arranca en modo demo con datos inventados y parece que
   funciona. Los valores de desarrollo estan en `apps/mobile/eas.json`
   (perfil `preview`), asi que un `.env` local se reconstruye desde ahi.

## Validar antes de dar algo por bueno

```bash
cd apps/mobile
npx tsc --noEmit                 # 0 errores
npx expo export --platform web   # lo que compila Vercel
```

Para cambios que afecten a movil, tambien `--platform ios`. La prueba real es
el navegador (`localhost:8081`) o el iPhone con Expo Go.

## Trampas ya pagadas (no volver a caer)

- **iOS: un `Modal` no se abre encima de otro `Modal`.** Los `BottomSheet` son
  Modales, asi que un `confirm()` o `notify()` lanzado desde dentro de uno es
  invisible, y `confirm()` no resuelve nunca (pantalla congelada). Patron
  correcto: cerrar la hoja, esperar ~300 ms y despues preguntar. Para errores
  con la hoja abierta, usar `<InlineError />`. Los mensajes de exito van
  DESPUES de cerrar.
- **Lo mismo aplica al SELECTOR DE FOTOS y a la camara**, que tambien son
  pantallas nativas. `setSheetOpen(false)` seguido de `await pickImage()` no
  abre nada: el Modal sigue en su animacion de salida. Y falla en silencio, sin
  error ni pista. Fue la causa de que los botones de subir historia y de
  cambiar la foto de perfil no hicieran nada. Usar `afterSheetClose()` de
  `src/lib/afterSheetClose.ts` entre cerrar y abrir. Ojo: solo hace falta si se
  CIERRA la hoja antes; dejarla abierta y abrir el selector encima funciona
  (es lo que hacen `CreateCatalogSheet` y `CreateTestimonialSheet`).
- **Web: cada `Pressable` es un `<button>`.** Anidar uno dentro de otro genera
  HTML invalido y rompe la hidratacion. La zona pulsable grande va DETRAS del
  contenido (`StyleSheet.absoluteFill`) con `pointerEvents="none"` en lo de
  encima, nunca envolviendolo.
- **React Native: `fetch(uri).blob()` informa bien `size` pero viaja VACIO**
  cuando supabase-js lo sube. Por eso las fotos se guardaban con 0 bytes. En
  nativo hay que leer los bytes con `expo-file-system` (`File.arrayBuffer()`);
  ver `readLocalFile` en `src/services/storage.ts`. Solo afectaba a archivos
  bajo 6 MB: los grandes van por TUS, que si transmite.
- **`expo-video` libera el reproductor nativo antes de las limpiezas de React.**
  Llamar a `player.pause()` al desmontar lanzaba `NativeSharedObjectNotFound`
  y pantalla roja. Ver el helper `safely()` en `src/components/VideoPlayer.tsx`.
- **Solo variables que empiezan literalmente por `EXPO_PUBLIC_` se incrustan.**
  Un typo en el nombre no da error: la app simplemente cae a modo demo.
- **Migraciones SQL:** el editor de Supabase corre el script como una
  transaccion, asi que un statement que falla revierte todo. Escribirlas
  idempotentes (`if not exists`, `drop policy if exists`), terminar con
  `notify pgrst, 'reload schema'` y un `select` de comprobacion.
- **La RLS es la seguridad de verdad.** Ocultar un boton por `isAdmin` es
  comodidad, no permiso.
- **`react-native-compressor` es el unico modulo nativo que no viaja en Expo
  Go.** `services/mediaCompressor.ts` lo carga de forma protegida y degrada a
  subir sin comprimir. No importarlo a nivel de modulo sin esa proteccion.

## App Store — decisiones tomadas

- **v1 se envia como app de MIEMBROS.** `FEATURE_PURCHASES` en
  `src/config/features.ts` esta en `false`: sin precios ni compras. El cobro de
  `CheckoutScreen` es simulado y Apple rechaza los flujos de compra que no
  completan una transaccion. Encenderlo obliga a usar las compras integradas de
  Apple, con su comision: es una decision de negocio, no un detalle tecnico.
- **El login con Google/Apple sigue oculto a proposito** en `LoginScreen`.
  No descomentarlo sin las credenciales: un boton que falla es rechazo por
  «app incompleta» (2.1), y ofrecer un login social activa la directriz 4.8,
  que obliga a ofrecer tambien Sign in with Apple. Mientras no se muestre
  ninguno, la app se sube solo con correo y contrasena. Encenderlos, cuando
  toque, va junto: nunca uno solo.
- `supportsTablet` esta en `false` para no tener que mantener ni justificar la
  version de iPad.
- `/privacy` y `/terms` son rutas propias: se publican en la web de Vercel (la
  URL publica que Apple exige) y se enlazan desde Ajustes. El texto esta
  marcado como borrador pendiente de revision legal.

## Estado y pendientes

- **Muro de pagos: pendiente a proposito.** Hoy cualquier usuario autenticado
  ve los videos de lecciones y descarga documentos sin comprar.
- Deuda menor: 18 usos de `Image` sin migrar a `expo-image`; 3 botones muertos
  (adjuntar en Chat, corazon en Live, barra de progreso en Audio); el modulo
  `stories` de la API FastAPI sin usar.

Detalle por escrito en `docs/`: `ARQUITECTURA.md`, `ESTADO_DEL_PROYECTO.md`,
`VALIDACION.md` y `IOS_EN_DISPOSITIVO.md` (probar en iPhone y publicar).

## Idioma

El producto y los comentarios del codigo estan en espanol. Escribir los
mensajes de commit y los comentarios en espanol, explicando el *porque* del
cambio, no el *que*.
