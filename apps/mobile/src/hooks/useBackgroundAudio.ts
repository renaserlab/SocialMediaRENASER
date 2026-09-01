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

/**
 * Enciende y apaga el modo de GRABACION de la sesion de audio.
 *
 * POR QUE ESTA AQUI Y NO EN LA GRABADORA. Porque `setAudioModeAsync` cambia el
 * audio de TODO el proceso, y este fichero es el unico sitio donde eso puede
 * vivir: `components/audioDelReproductor.test.mts` lo comprueba y falla si
 * aparece en cualquier otro. La razon es la de siempre —tocar la sesion global
 * para arreglar una pantalla apaga tambien el podcast, el audio de presentacion
 * de un perfil y la leccion de un curso—, y no deja de valer porque ahora lo
 * que se quiera sea grabar.
 *
 * POR QUE SE ENCIENDE Y SE APAGA EN VEZ DE DEJARLO PUESTO. En iOS,
 * `allowsRecording: true` cambia la categoria de la sesion a «reproducir y
 * grabar», y con esa categoria el sistema BAJA el volumen de la reproduccion y
 * puede sacarla por el auricular en vez de por el altavoz. Dejarlo encendido
 * para siempre significa que, despues de mandar una sola nota de voz, todos los
 * audios de la aplicacion suenan mas bajo hasta que se cierra. Se pide justo
 * para grabar y se devuelve al soltar.
 *
 * En Android y en la web no hace falta —la grabacion no depende de esto— pero
 * llamarlo no molesta, y una sola ruta para las dos plataformas es una rama
 * menos donde equivocarse.
 */
export async function permitirGrabar(activo: boolean): Promise<void> {
  // La sesion base primero: sin ella, `allowsRecording` se aplicaria sobre una
  // configuracion a medias y en iOS se perderia `playsInSilentMode`, o sea que
  // las notas de voz no se oirian con el interruptor de silencio puesto.
  await configureAudioMode();
  await setAudioModeAsync({
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    interruptionMode: 'doNotMix',
    shouldRouteThroughEarpiece: false,
    allowsRecording: activo,
  }).catch(() => {
    // En web no hay sesion que configurar. Que no impida grabar: el navegador
    // gestiona el microfono por su cuenta con su propio permiso.
  });
}
