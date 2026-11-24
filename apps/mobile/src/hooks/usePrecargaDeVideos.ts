import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

import { reelNecesitaUrls } from '@/feed/urlsDeMedios';
import { registrarMuestraDeRed } from '@/lib/medidorDeRed';
import type { CoordinadorDePrecarga } from '@/lib/precargaDeVideos';
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
 *
 * `coordinador`: el del muro. Con el, nada se pide hasta que el video que se
 * ve arranca con colchon (`precargaLiberada`), y al deslizar se cancela lo que
 * estuviera bajando: la precarga nunca compite con el arranque del activo. Se
 * escucha FUERA de React, igual que los reproductores: liberar la precarga no
 * redibuja el muro. Sin coordinador, se pide al instante, como antes (en la
 * web no hay modulo nativo y el hook no hace nada de todos modos).
 */
export function usePrecargaDeVideos(
  items: readonly VideoDelFeed[],
  indiceActivo: number,
  activo: boolean,
  conReproductor: number,
  coordinador?: CoordinadorDePrecarga,
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
    const urls = urlsAPrecargar(items, indiceActivo, { conReproductor, necesitaUrls: reelNecesitaUrls });
    const aplicar = () => {
      const enEspera = coordinador ? !coordinador.estado().precargaLiberada : false;
      cola.actualizar(urls, { enEspera });
    };
    aplicar();
    if (!coordinador) return;
    // Cualquier cambio del muro avisa; `actualizar` es idempotente, asi que
    // repetirlo con lo mismo no pide nada dos veces.
    let liberada = coordinador.estado().precargaLiberada;
    return coordinador.suscribir((estado) => {
      if (estado.precargaLiberada === liberada) return;
      liberada = estado.precargaLiberada;
      aplicar();
    });
  }, [items, indiceActivo, activo, conReproductor, coordinador]);

  useEffect(() => () => precargador.current?.detener(), []);
}
