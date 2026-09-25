import { useEffect, useState } from 'react';

import { publicacionFlexible } from '@/services/plataforma';

/**
 * Si el servidor está en MODO FLEXIBLE: enviar publica al momento.
 *
 * `false` mientras se pregunta, que es el modo estricto (ver
 * `services/plataforma.ts`). Solo cambia palabras y mínimos de texto; lo que
 * pasa de verdad lo decide el servidor en cada envío.
 */
export function usePublicacionFlexible(): boolean {
  const [flexible, setFlexible] = useState(false);
  useEffect(() => {
    let vigente = true;
    void publicacionFlexible().then((valor) => {
      if (vigente) setFlexible(valor);
    });
    return () => {
      vigente = false;
    };
  }, []);
  return flexible;
}
