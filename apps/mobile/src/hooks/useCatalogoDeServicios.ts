import { useCallback, useState } from 'react';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';

import type { FalloDelCatalogo, ServicioPrivado } from '@/lib/serviciosCatalogo';
import { leerFalloDelCatalogo } from '@/hooks/useServicios';
import { ServiceCatalogRepository } from '@/repositories/ServiceCatalogRepository';

/** El identificador de la ruta (`[serviceId]`, `[versionId]`, `[providerId]`), o vacío. */
export function useParametroDeRuta(nombre: 'serviceId' | 'versionId' | 'providerId'): string {
  const parametros = useLocalSearchParams<{ serviceId?: string; versionId?: string; providerId?: string }>();
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
