import { useEffect } from 'react';
import { setAudioModeAsync } from 'expo-audio';

/**
 * Modo de audio de la aplicacion, necesario para que el sonido no se corte al
 * salir de la app o bloquear el movil.
 *
 * Por defecto el sistema pausa el audio en cuanto la app deja de estar en
 * primer plano. Hay tres piezas y hacen falta las tres:
 *
 *  1. `shouldPlayInBackground` (aqui), que pide la sesion de audio de fondo.
 *  2. `UIBackgroundModes: ['audio']` en iOS y el servicio en primer plano de
 *     Android, declarados en `app.json`.
 *  3. Una compilacion nativa nueva: al vivir en la configuracion, esto NO entra
 *     por actualizacion OTA.
 *
 * `playsInSilentMode` ademas evita el fallo mas confuso de iOS: con el
 * interruptor de silencio activado el audio se reproduce sin oirse.
 *
 * La llamada se hace una sola vez por arranque; el modo es global al proceso,
 * no de cada reproductor. La promesa compartida evita repetirla cuando hay
 * varios reproductores montados.
 */
let configured: Promise<void> | null = null;

function configureAudioMode(): Promise<void> {
  configured ??= setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    // `doNotMix`: al sonar un episodio se pausa lo que hubiera de fondo, en vez
    // de solaparse con ello. Es lo esperable en contenido hablado.
    interruptionMode: 'doNotMix',
    shouldRouteThroughEarpiece: false,
  }).catch(() => {
    // En web no hay sesion de audio que configurar y falla; que no tumbe la
    // vista. Se deja marcado como hecho para no reintentarlo en bucle.
  });
  return configured;
}

/** Prepara la sesion de audio. Seguro de llamar desde varios reproductores. */
export function useBackgroundAudio(): void {
  useEffect(() => {
    void configureAudioMode();
  }, []);
}
