import { useEffect, useState } from 'react';
import { Platform, type TextStyle } from 'react-native';
import * as Font from 'expo-font';

import type { LetraDeRotulo } from '@/live/destacado';
import { getTextStyle } from '@/theme/tokens';

/**
 * Las letras del rótulo del directo: «clásica» es la de la aplicación (Inter
 * 800, ya cargada al arrancar); «fuerte» (Anton) y «máquina» (Courier Prime
 * Bold) son dos ficheros propios, con licencia OFL, en `assets/fonts/`.
 *
 * SE CARGAN CUANDO HACEN FALTA, NO AL ARRANCAR. Solo las necesita quien está
 * en un directo con un rótulo que las usa, o quien abre la hoja de editarlo.
 * Cargarlas en `app/_layout.tsx` haría esperar a todo el mundo, en cada
 * arranque, por dos letras que casi nadie va a ver. El fichero viaja en el
 * paquete (Metro no carga nada que no sepa de antemano), pero no se lee hasta
 * que hace falta.
 *
 * MIENTRAS NO ESTÁ, se pinta con la clásica: el texto se ve desde el primer
 * fotograma y cambia de letra al llegar, que es mejor que un hueco.
 */

type Propia = Exclude<LetraDeRotulo, 'clasica'>;

/** El nombre con el que se registra cada fichero. Propio, para no chocar con nada. */
export const FAMILIA_DE_LA_LETRA: Record<Propia, string> = {
  fuerte: 'ZetaRotuloAnton',
  maquina: 'ZetaRotuloCourierPrimeBold',
};

const FICHERO: Record<Propia, number> = {
  fuerte: require('../../assets/fonts/Anton-Regular.ttf'),
  maquina: require('../../assets/fonts/CourierPrime-Bold.ttf'),
};

/** Una carga por letra en toda la aplicación, aunque la pidan varios a la vez. */
const cargas: Partial<Record<Propia, Promise<void>>> = {};

function estaCargada(letra: LetraDeRotulo): boolean {
  if (letra === 'clasica') return true;
  try {
    return Font.isLoaded(FAMILIA_DE_LA_LETRA[letra]);
  } catch {
    return false;
  }
}

function cargar(letra: Propia): Promise<void> {
  const enCurso = cargas[letra];
  if (enCurso) return enCurso;
  const carga = Font.loadAsync({ [FAMILIA_DE_LA_LETRA[letra]]: FICHERO[letra] }).catch(() => {
    // Sin la letra se sigue viendo con la clásica. Se podrá volver a intentar.
    delete cargas[letra];
  });
  cargas[letra] = carga;
  return carga;
}

/**
 * Carga las letras pedidas y dice cuáles están ya. Vuelve a pintar quien la
 * usa cuando llega cada una.
 */
export function useLetrasDelRotulo(letras: readonly LetraDeRotulo[]): Record<LetraDeRotulo, boolean> {
  const [, setVersion] = useState(0);
  const clave = [...new Set(letras)].sort().join('|');

  useEffect(() => {
    let vigente = true;
    for (const letra of clave.split('|') as LetraDeRotulo[]) {
      if (letra === 'clasica' || estaCargada(letra)) continue;
      void cargar(letra).then(() => {
        if (vigente) setVersion((v) => v + 1);
      });
    }
    return () => {
      vigente = false;
    };
  }, [clave]);

  return {
    clasica: true,
    fuerte: estaCargada('fuerte'),
    maquina: estaCargada('maquina'),
  };
}

/** El estilo de letra de cada opción, con la clásica de respaldo mientras carga. */
export function estiloDeLaLetra(letra: LetraDeRotulo, cargada: boolean): TextStyle {
  if (letra === 'clasica' || !cargada) return getTextStyle('800');
  // Una familia propia lleva su grosor dentro: pedirle otro en iOS haría que
  // el sistema buscara una variante que no existe y cayera a la del sistema.
  return {
    fontFamily: FAMILIA_DE_LA_LETRA[letra],
    fontWeight: Platform.OS === 'ios' ? undefined : 'normal',
  };
}

/** Anton es muy apretada: un 2 % de aire entre letras, como en la propuesta. */
export function aireEntreLetras(letra: LetraDeRotulo, tamanoDeLetra: number): number {
  return letra === 'fuerte' ? tamanoDeLetra * 0.02 : 0;
}
