/**
 * Shim de expo-router/_ctx para web en monorepo.
 *
 * El problema original: expo-router/_ctx.web.js usa
 *   require.context(process.env.EXPO_ROUTER_APP_ROOT, ...)
 * pero Metro/web no puede sustituir variables de entorno como string literal
 * en tiempo de parseo, así que require.context recibe `undefined` y lanza:
 *   "First argument of require.context should be a string"
 *
 * Solución: este shim hardcodea el path de app/ como string literal.
 * metro.config.js redirige 'expo-router/_ctx' en platform=web a este archivo.
 *
 * IMPORTANTE: este path es relativo a la ubicación de ESTE archivo (web-shims/).
 * El directorio app/ está un nivel arriba → '../app'
 */
export const ctx = require.context(
  '../app',
  true,
  /^(?:\.\/)(?!(?:(?:(?:.*\+api)|(?:\+middleware)|(?:\+(html|native-intent))))\.[tj]sx?$).*(?:\.android|\.ios|\.native)?\.[tj]sx?$/
);
