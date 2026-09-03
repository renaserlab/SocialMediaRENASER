import { useEffect, useRef } from 'react';
import { BackHandler, Platform } from 'react-native';
import { useNavigationContainerRef } from 'expo-router';

import { useTranslation } from '@/i18n/useTranslation';
import { toast } from '@/lib/toast';
import { instalarAtras } from '@/navigation/atras';
import { cerrarCapaSuperior, hayCapaAbierta } from '@/navigation/capasAbiertas';

/**
 * Conecta el boton fisico Atras de Android con la aplicacion.
 *
 * AQUI NO HAY NINGUNA REGLA, y esa es la gracia. Que hacer con cada pulsacion
 * lo decide `decidirAtras`, y la maquina que lleva la cuenta de la doble
 * pulsacion es `instalarAtras`; las dos viven en `navigation/atras.ts` y son
 * funciones puras que las pruebas ejecutan de verdad sin telefono. Este fichero solo
 * traduce: `BackHandler` por «suscribir», `Date.now` por «ahora», la
 * navegacion por «¿puedo volver?».
 *
 * QUE FALLABA. La version anterior tenia la logica metida en este `useEffect`,
 * de modo que la unica forma de comprobarla era pulsar Atras en un telefono.
 * Con eso encima se colaron dos cosas:
 *
 *  1. Durante el arranque —el layout raiz devuelve `null` hasta que hidrata—
 *     no hay navegacion montada, `canGoBack()` es falso y el manejador
 *     devolvia `false`: una pulsacion despistada mientras cargaba CERRABA la
 *     aplicacion, sin aviso y sin haber navegado a ningun sitio. Ahora ese
 *     caso cae en «avisar», igual que la raiz: sigue pudiendose salir con dos
 *     pulsaciones, pero nunca con una.
 *  2. El comentario decia que este oyente se registra despues que el de
 *     expo-router y que por eso podia devolver `false` para delegar el
 *     retroceso. Es al reves (esta explicado en `navigation/atras.ts`). Ya no
 *     depende del orden: cuando toca volver, se vuelve.
 *
 * Solo Android: en iOS no hay boton Atras, y en el navegador el retroceso lo
 * lleva el historial del propio navegador, que no debe tocarse.
 */
export function useSalidaConDoblePulsacion(): void {
  const navegacion = useNavigationContainerRef();
  const { t } = useTranslation();

  /*
    El texto se lee EN EL MOMENTO de la pulsacion, no al instalar.

    Antes `t` estaba en las dependencias del efecto, asi que cambiar de idioma
    desinstalaba y reinstalaba el oyente. Reinstalar mueve el oyente al final
    de la lista de Android —cambiando en silencio quien se queda el evento— y
    tira por el camino cualquier confirmacion a medias. Con la referencia, el
    idioma cambia y la instalacion sigue siendo la misma.
  */
  const traducir = useRef(t);
  traducir.current = t;

  useEffect(() => {
    if (Platform.OS !== 'android') return;

    return instalarAtras({
      suscribir: (manejador) => {
        const suscripcion = BackHandler.addEventListener('hardwareBackPress', manejador);
        return () => suscripcion.remove();
      },
      ahora: () => Date.now(),
      programar: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      hayCapaAbierta,
      cerrarCapa: () => {
        cerrarCapaSuperior();
      },
      /*
        QUIEN SABE SI HAY DONDE VOLVER: la propia navegacion, nunca una lista
        nuestra. `canGoBack()` del contenedor pregunta a la pantalla enfocada y
        sube por sus padres, asi que cubre igual el historial entre pestanas
        (`backBehavior="history"`) que la pila de detalles de encima. Es la
        misma pregunta que se hace expo-router en su propio manejador, de modo
        que las dos respuestas no pueden discrepar.

        `isReady()` primero: antes de que el contenedor exista, `canGoBack()`
        no solo responde `false` sino que ademas avisa por consola.
      */
      puedeVolver: () => navegacion.isReady() && navegacion.canGoBack(),
      volver: () => navegacion.goBack(),
      avisar: () => toast(traducir.current('app.pressAgainToExit'), 'log-out'),
    });
  }, [navegacion]);
}
