/**
 * Shim de expo-router/_ctx para iOS y Android en monorepo.
 *
 * El problema: _ctx.ios.js usa
 *   require.context(process.env.EXPO_ROUTER_APP_ROOT, ...)
 * pero Metro no propaga EXPO_ROUTER_APP_ROOT a los workers de Babel en tiempo
 * de bundle. require.context necesita un string literal estático → crash.
 *
 * Solución: path '../app' hardcodeado como string literal.
 * metro.config.js redirige 'expo-router/_ctx' en platform ios/android a este shim.
 *
 * El regex es el del _ctx.ios.js original — excluye +api, +html y +middleware,
 * y también excluye extensiones .android y .web (que son específicas de plataforma).
 */
export const ctx = require.context(
  '../app',
  true,
  /^(?:\.\/)(?!(?:(?:(?:.*\+api)|(?:\+html)|(?:\+middleware)))\.[tj]sx?$).*(?:\.android|\.web)?\.[tj]sx?$/
);
