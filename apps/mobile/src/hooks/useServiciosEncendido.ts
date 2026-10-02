import { useEffect, useState } from 'react';

import { serviciosEncendido } from '@/services/plataforma';
import { useAppStore } from '@/store/useAppStore';

/**
 * Si QUIEN USA LA APP puede usar Z Servicios: `FEATURE_SERVICES` encendida en
 * el servidor y, durante el piloto, su perfil entre los autorizados.
 *
 * `false` mientras se pregunta y ante cualquier fallo: una entrada que no
 * aparece no rompe nada, y una que aparece sin acceso llevaría a una pantalla
 * que solo sabe decir «no disponible». Al cambiar de cuenta se apaga y se
 * vuelve a preguntar: lo de la cuenta anterior no se hereda. Ver
 * `services/plataforma.ts`.
 */
export function useServiciosEncendido(): boolean {
  const quien = useAppStore((state) => state.user?.id ?? null);
  const [encendido, setEncendido] = useState(false);
  useEffect(() => {
    let vigente = true;
    setEncendido(false);
    void serviciosEncendido(quien).then((valor) => {
      if (vigente) setEncendido(valor);
    });
    return () => {
      vigente = false;
    };
  }, [quien]);
  return encendido;
}
