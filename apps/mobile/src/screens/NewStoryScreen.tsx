import React, { useCallback } from 'react';
import { useRouter } from 'expo-router';

import { ModoHistoria } from '@/components/crear/ModoHistoria';

/**
 * Ruta `/stories/nueva`: crear una historia desde el anillo de la fila de
 * historias, sin pasar por la pantalla de Crear.
 *
 * El flujo NO se escribe aqui: es el mismo `ModoHistoria` que usa Crear. Con
 * dos copias, cada arreglo del limite de duracion, de los permisos o del
 * reintento habria que hacerlo dos veces, y una de las dos se quedaria atras.
 */
export function NewStoryScreen() {
  const router = useRouter();
  const salir = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/home' as never);
  }, [router]);

  return <ModoHistoria alSalir={salir} />;
}
