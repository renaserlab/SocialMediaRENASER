import { useEffect } from 'react';
import { BackHandler, Platform } from 'react-native';
import { useNavigationContainerRef } from 'expo-router';

import { useTranslation } from '@/i18n/useTranslation';
import { toast } from '@/lib/toast';

/**
 * Cuanto tiempo cuenta la primera pulsacion.
 *
 * Dos segundos es lo que usan las aplicaciones grandes: suficiente para leer el
 * aviso y volver a pulsar, y corto como para que una pulsacion olvidada de hace
 * un rato no cierre la aplicacion por sorpresa.
 */
const MARGEN_MS = 2000;

/**
 * El boton fisico Atras deja de cerrar la aplicacion de golpe.
 *
 * Problema que resuelve: en Android, pulsar Atras cerraba la aplicacion aunque
 * la persona acabara de recorrer media aplicacion. Ahora Atras hace lo unico
 * razonable —volver a donde estabas— y solo cuando de verdad no queda nada
 * detras avisa antes de cerrar.
 *
 * QUIEN DECIDE QUE HAY DETRAS: la propia navegacion, no una lista paralela.
 *
 * `canGoBack()` del contenedor pregunta a la pantalla que tiene el foco y sube
 * por sus padres: si hay una pantalla apilada encima (un ajuste, una
 * publicacion, un perfil ajeno) o queda historial de pestañas, responde que si.
 * Es EXACTAMENTE lo mismo que consulta React Navigation en su propio manejador
 * del boton Atras, asi que las dos respuestas no pueden discrepar. Por eso aqui
 * no hay ningun `historial = [...]` propio que mantener al dia: seria una
 * segunda verdad, y se desincronizaria a la primera navegacion inesperada.
 *
 * COMO CONVIVEN LOS DOS MANEJADORES: Android los llama del ultimo registrado al
 * primero, y el primero que devuelve `true` se queda el evento. Este se registra
 * despues que el de React Navigation, asi que se le pregunta antes; devolver
 * `false` es decir "yo no me lo quedo", y entonces corre el de React Navigation
 * y retrocede con normalidad. Solo devolvemos `true` en el unico caso en que
 * queremos cortar: la primera pulsacion en la raiz.
 *
 * Solo Android: en iOS no hay boton Atras y en el navegador el retroceso lo
 * lleva el propio historial del navegador, que no debe tocarse.
 */
export function useSalidaConDoblePulsacion(): void {
  const navegacion = useNavigationContainerRef();
  const { t } = useTranslation();

  useEffect(() => {
    if (Platform.OS !== 'android') return;

    let esperandoConfirmacion = false;
    let temporizador: ReturnType<typeof setTimeout> | undefined;

    const suscripcion = BackHandler.addEventListener('hardwareBackPress', () => {
      // Todavia arrancando: mejor no interferir con el comportamiento normal.
      if (!navegacion.isReady()) return false;

      // Queda a donde volver: que lo resuelva la navegacion, como siempre.
      if (navegacion.canGoBack()) return false;

      // Segunda pulsacion dentro del margen: se deja salir.
      if (esperandoConfirmacion) return false;

      esperandoConfirmacion = true;
      toast(t('app.pressAgainToExit'), 'log-out');
      temporizador = setTimeout(() => {
        esperandoConfirmacion = false;
      }, MARGEN_MS);
      return true;
    });

    return () => {
      suscripcion.remove();
      if (temporizador) clearTimeout(temporizador);
    };
  }, [navegacion, t]);
}
