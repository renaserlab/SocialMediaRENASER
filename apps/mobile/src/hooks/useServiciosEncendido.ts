import { useEffect, useState } from 'react';

import { serviciosEncendido } from '@/services/plataforma';

/**
 * Si el servidor tiene Z Servicios encendido (`FEATURE_SERVICES`).
 *
 * `false` mientras se pregunta y ante cualquier fallo: una entrada que no
 * aparece no rompe nada, y una que aparece con Servicios apagado llevaría a
 * una pantalla que solo sabe decir «no disponible». Ver `services/plataforma.ts`.
 */
export function useServiciosEncendido(): boolean {
  const [encendido, setEncendido] = useState(false);
  useEffect(() => {
    let vigente = true;
    void serviciosEncendido().then((valor) => {
      if (vigente) setEncendido(valor);
    });
    return () => {
      vigente = false;
    };
  }, []);
  return encendido;
}
