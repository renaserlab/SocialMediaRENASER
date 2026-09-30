import { useCallback, useState } from 'react';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';

import type { FalloDelCatalogo, ServicioPrivado } from '@/lib/serviciosCatalogo';
import { leerFalloDelCatalogo } from '@/hooks/useServicios';
import { ServiceCatalogRepository } from '@/repositories/ServiceCatalogRepository';

type ParametroDeRuta = 'serviceId' | 'versionId' | 'providerId' | 'holdId' | 'bookingId';

/**
 * El identificador de la ruta (`[serviceId]`, `[versionId]`, `[providerId]`,
 * `[holdId]`, `[bookingId]`), o vacío.
 */
export function useParametroDeRuta(nombre: ParametroDeRuta): string {
  const parametros = useLocalSearchParams<Partial<Record<ParametroDeRuta, string>>>();
  const valor: unknown = parametros[nombre];
  return typeof valor === 'string' ? valor : '';
}

/**
 * Un servicio PROPIO, leído del servidor cada vez que la pantalla gana el
 * foco: volver de editar, de las imágenes o de enviar trae lo último. Uno
 * ajeno o inexistente es el mismo 404 (`noEncontrada`).
 */
export function useServicioPropio(id: string) {
  const [servicio, setServicio] = useState<ServicioPrivado | null>(null);
  const [fallo, setFallo] = useState<FalloDelCatalogo | null>(null);

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setServicio(await ServiceCatalogRepository.servicio(id));
    } catch (error) {
      setFallo(leerFalloDelCatalogo(error));
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  return { servicio, setServicio, fallo, cargar };
}
