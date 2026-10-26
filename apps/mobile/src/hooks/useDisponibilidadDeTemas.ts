import { useEffect, useState } from 'react';

import {
  SIN_DISPONIBILIDAD,
  TemasRepository,
  type DisponibilidadDeTemas,
} from '@/repositories/TemasRepository';

/**
 * Lo último que dijo el servidor, para toda la sesión. Describe la
 * instalación, no a la persona, así que no depende de quién mira.
 */
let sabida: DisponibilidadDeTemas | null = null;

/**
 * Si el servidor sabe de temas (0108) y de comunidades (0109).
 *
 * NUNCA UN BOTÓN MUERTO. Mientras no se sabe, se da por hecho que no: el chat
 * no ofrece «Agregar a un tema» hasta que el servidor confirma que existe. Se
 * vuelve a preguntar al montar —el servidor puede haberse actualizado—, pero lo
 * ya sabido se enseña sin esperar a la red. Mismo criterio que
 * `useFuncionesDelChat`.
 */
export function useDisponibilidadDeTemas(activo: boolean): DisponibilidadDeTemas {
  const [disponibilidad, setDisponibilidad] = useState<DisponibilidadDeTemas>(
    sabida ?? SIN_DISPONIBILIDAD,
  );

  useEffect(() => {
    if (!activo) return;
    let montado = true;
    void TemasRepository.disponibilidad().then((leida) => {
      sabida = leida;
      if (montado) setDisponibilidad(leida);
    });
    return () => {
      montado = false;
    };
  }, [activo]);

  return disponibilidad;
}
