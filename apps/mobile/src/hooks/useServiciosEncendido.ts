import { useEffect, useState } from 'react';

import { quienPregunta, serviciosDeAdministracion, serviciosEncendido } from '@/services/plataforma';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';

/**
 * Lo que el servidor contesta sobre Z Servicios A QUIEN USA LA APP.
 *
 * `false` mientras se pregunta y ante cualquier fallo: una entrada que no
 * aparece no rompe nada, y una que aparece sin acceso llevaría a una pantalla
 * que solo sabe decir «no disponible». Al cambiar de cuenta se apaga y se
 * vuelve a preguntar: lo de la cuenta anterior no se hereda. Ver
 * `services/plataforma.ts`.
 */
function useRespuesta(pregunta: (quien: string | null) => Promise<boolean>): boolean {
  const perfil = useAppStore((state) => state.user?.id ?? null);
  const conSesion = useAuthStore((state) => state.status === 'authenticated');
  const quien = quienPregunta(perfil, conSesion);
  const [encendido, setEncendido] = useState(false);
  useEffect(() => {
    let vigente = true;
    setEncendido(false);
    void pregunta(quien).then((valor) => {
      if (vigente) setEncendido(valor);
    });
    return () => {
      vigente = false;
    };
  }, [pregunta, quien]);
  return encendido;
}

/**
 * Si QUIEN USA LA APP puede usar Z Servicios: `FEATURE_SERVICES` encendida en
 * el servidor y, durante el piloto, su perfil entre los autorizados.
 */
export function useServiciosEncendido(): boolean {
  return useRespuesta(serviciosEncendido);
}

/**
 * Si a quien usa la app le toca ADMINISTRAR Z Servicios. Va por su rol y no
 * por la lista del piloto: quien revisa una postulación no tiene por qué ser
 * participante.
 */
export function useServiciosDeAdministracion(): boolean {
  return useRespuesta(serviciosDeAdministracion);
}
