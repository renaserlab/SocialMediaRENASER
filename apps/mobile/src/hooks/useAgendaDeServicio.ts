import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import type { FalloDelCatalogo } from '@/lib/serviciosCatalogo';
import type { AgendaPrivada } from '@/lib/serviciosAgenda';
import { leerFalloDelCatalogo } from '@/hooks/useServicios';
import { ServiceScheduleRepository } from '@/repositories/ServiceScheduleRepository';

/**
 * La agenda PROPIA de un servicio, leída del servidor cada vez que la
 * pantalla gana el foco: volver de editar la semana, las excepciones o los
 * bloqueos trae lo último. Uno ajeno o inexistente es el mismo 404.
 */
export function useAgendaPropia(servicio: string) {
  const [agenda, setAgenda] = useState<AgendaPrivada | null>(null);
  const [fallo, setFallo] = useState<FalloDelCatalogo | null>(null);

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setAgenda(await ServiceScheduleRepository.agenda(servicio));
    } catch (error) {
      setFallo(leerFalloDelCatalogo(error));
    }
  }, [servicio]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  return { agenda, setAgenda, fallo, cargar };
}
