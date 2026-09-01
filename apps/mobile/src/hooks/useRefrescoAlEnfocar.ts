import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useIsFocused } from '@react-navigation/native';

import {
  suscribir,
  versionDe,
  type DominioSincronizado,
} from '@/lib/sincronizacion';

/**
 * La parte de React de `lib/sincronizacion`.
 *
 * POR QUE SEPARADO. El núcleo —las versiones y el aviso— no necesita React
 * para nada, y teniéndolo aparte se puede EJECUTAR en las pruebas tal cual, sin
 * renderizador ni navegador simulados. Aquí queda solo lo que sí depende de
 * React y de la navegación.
 */

/** La versión de un dominio, dentro de React. */
export function useVersionDe(dominio: DominioSincronizado): number {
  return useSyncExternalStore(
    suscribir,
    () => versionDe(dominio),
    () => versionDe(dominio),
  );
}

/**
 * REFRESCAR CUANDO HAGA FALTA Y SOLO CUANDO SE ESTA VIENDO.
 *
 * Es lo único que necesita una superficie con lista propia:
 *
 *     useRefrescoAlEnfocar('publicaciones', refrescar);
 *
 * Y con eso:
 *
 *   - Si nada cambió, NO pide nada. Cambiar de pestaña veinte veces son cero
 *     peticiones. Esto es lo que lo separa de un `useFocusEffect(refrescar)`,
 *     que vuelve a pedirlo todo cada vez que se mira la pestaña.
 *   - Si algo cambió mientras la superficie no se veía, se refresca al volver.
 *   - Si algo cambia mientras SÍ se está viendo, se refresca en el momento.
 *   - Si llega otro cambio durante el refresco no se pierde: la versión que se
 *     apunta es la que había al empezar, así que al terminar se ve que hay una
 *     más nueva y se vuelve a pedir.
 *
 * Sirve también de red cuando un evento no llegó —el teléfono estaba sin
 * cobertura, la suscripción se cayó—: al volver a la superficie se comprueba la
 * versión y, si cambió, se pide. Sin sondeo.
 */
export function useRefrescoAlEnfocar(
  dominio: DominioSincronizado,
  refrescar: () => void | Promise<void>,
): void {
  const version = useVersionDe(dominio);
  const enfocada = useIsFocused();

  /*
    La última versión que esta superficie ya sirvió. Empieza en la actual: al
    montarse acaba de pedir sus datos, así que no hay nada viejo que arreglar.
    Sin esto, cada montaje dispararía una petición de más.
  */
  const servida = useRef(version);
  const enVuelo = useRef(false);

  // En una ref para no rehacer el efecto cada render por una función nueva.
  const refrescarRef = useRef(refrescar);
  refrescarRef.current = refrescar;

  const ejecutar = useCallback(async (objetivo: number) => {
    if (enVuelo.current) return;
    enVuelo.current = true;
    try {
      await refrescarRef.current();
      servida.current = objetivo;
    } catch {
      /*
        No se apunta la versión: si falló, los datos siguen viejos y hay que
        volver a intentarlo la próxima vez que se enfoque. Fallar en silencio
        aquí es correcto — la superficie ya tiene contenido, solo que anterior,
        y un error a pantalla completa por un refresco de fondo sería peor.
      */
    } finally {
      enVuelo.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enfocada) return;
    if (servida.current === version) return;
    void ejecutar(version);
  }, [enfocada, version, ejecutar]);
}
