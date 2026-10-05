import { useEffect, useState } from 'react';
import { useNavigationContainerRef } from 'expo-router';

import {
  ESPERA_ENTRE_MIRADAS_MS,
  MIRADAS_MAXIMAS,
  navegadorDeLaAppMontado,
  type EstadoDeNavegacion,
} from '@/lib/navegadorMontado';

/**
 * `true` cuando ya se puede navegar desde el layout raíz.
 *
 * Es la ÚNICA señal que usan los ganchos de la raíz que navegan por su cuenta
 * (abrir desde un push, el enlace de recuperar la contraseña). Antes cada uno
 * miraba `useRootNavigationState()?.key`, que es cierto desde el primer
 * instante; por qué eso rompía el arranque está en `lib/navegadorMontado.ts`.
 *
 * @param pintado El layout raíz ya devuelve su `<Stack>` (ha hidratado). Antes
 *   de eso no hay nada que mirar.
 *
 * Se mira el estado real del contenedor, no se supone: justo después de pintar
 * y, si aún no está, cada pocos milisegundos durante un tiempo acotado.
 */
export function useNavegadorMontado(pintado: boolean): boolean {
  const contenedor = useNavigationContainerRef();
  const [montado, setMontado] = useState(false);

  useEffect(() => {
    if (!pintado || montado) return undefined;
    let reloj: ReturnType<typeof setTimeout> | null = null;
    let miradas = 0;

    const mirar = () => {
      reloj = null;
      let raiz: EstadoDeNavegacion | null = null;
      try {
        raiz = contenedor.isReady() ? (contenedor.getRootState() as EstadoDeNavegacion) : null;
      } catch {
        // El contenedor todavía no existe: se vuelve a mirar.
        raiz = null;
      }
      if (navegadorDeLaAppMontado(raiz)) {
        setMontado(true);
        return;
      }
      miradas += 1;
      if (miradas < MIRADAS_MAXIMAS) reloj = setTimeout(mirar, ESPERA_ENTRE_MIRADAS_MS);
    };

    // En la vuelta siguiente, no en esta: el `<Stack>` registra su estado en
    // sus propios efectos, y así ya han corrido.
    reloj = setTimeout(mirar, 0);
    return () => {
      if (reloj !== null) clearTimeout(reloj);
    };
  }, [pintado, montado, contenedor]);

  return montado;
}
