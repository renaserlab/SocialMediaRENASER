import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

import { reelNecesitaUrls } from '@/feed/urlsDeMedios';
import { registrarMuestraDeRed } from '@/lib/medidorDeRed';
import {
  crearPrecargador,
  esModuloDePrecarga,
  urlsAPrecargar,
  type ModuloNativoDePrecarga,
  type Precargador,
  type VideoDelFeed,
} from '@/services/precargaDeVideos';

/**
 * El modulo `ExpoVideo` con la precarga del parche, o `null`.
 *
 * `null` en web, en Expo Go y en cualquier binario compilado antes del parche
 * (que puede recibir esta version por OTA): ahi la precarga no existe y el
 * feed se comporta como siempre.
 */
function moduloDePrecarga(): ModuloNativoDePrecarga | null {
  if (Platform.OS === 'web') return null;
  try {
    const modulo = requireOptionalNativeModule('ExpoVideo');
    return esModuloDePrecarga(modulo) ? modulo : null;
  } catch {
    return null;
  }
}

/**
 * Mantiene precargado el primer MB de los 5 videos siguientes al que se ve.
 *
 * La logica (que pedir, que cancelar) vive en `services/precargaDeVideos.ts`;
 * aqui solo se engancha al ciclo de vida del feed y al medidor de red. Con el feed inactivo
 * (otra pestana, otra seccion) se cancela todo lo suyo.
 *
 * `conReproductor`: cuantos de los siguientes ya tienen reproductor montado y
 * se bufferizan solos (ver `preload` en el feed).
 */
export function usePrecargaDeVideos(
  items: readonly VideoDelFeed[],
  indiceActivo: number,
  activo: boolean,
  conReproductor: number,
): void {
  const precargador = useRef<Precargador | null>(null);
  if (precargador.current === null) {
    // Cada primer MB que baja de la red es tambien una medicion de cuanto da
    // la red: en nativo es la UNICA (la web tiene `navigator.connection`), y
    // con ella se elige la calidad de los videos (`lib/elegirVariante.ts`).
    precargador.current = crearPrecargador(moduloDePrecarga(), undefined, {
      alMedir: registrarMuestraDeRed,
    });
  }

  useEffect(() => {
    const cola = precargador.current;
    if (!cola) return;
    if (!activo) {
      cola.detener();
      return;
    }
    cola.actualizar(
      urlsAPrecargar(items, indiceActivo, { conReproductor, necesitaUrls: reelNecesitaUrls }),
    );
  }, [items, indiceActivo, activo, conReproductor]);

  useEffect(() => () => precargador.current?.detener(), []);
}
