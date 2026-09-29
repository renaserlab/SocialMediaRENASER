import React from 'react';
import { useRouter } from 'expo-router';

import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { StateView } from '@/components/StateView';
import type { FalloDelCatalogo } from '@/lib/serviciosCatalogo';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Lo que enseña una pantalla del catálogo de Servicios cuando NO pudo cargar.
 *
 * Es `EstadoDeServicios` con dos diferencias que el catálogo necesita:
 *
 *  - «AÚN NO ERES PRESTADOR ACTIVO» no es «sin permiso»: tiene arreglo, y se
 *    ofrece ir a la postulación, que es donde se arregla.
 *  - LO QUE NO SE ENCUENTRA ES UN SERVICIO, no una postulación, y se dice así.
 *
 * Todo lo demás (apagado, sin conexión, sin sesión, error) dice lo mismo que
 * en la admisión, y solo se ofrece reintentar cuando reintentar arregla algo.
 */
export function EstadoDelCatalogo({
  fallo,
  onRetry,
}: {
  fallo: FalloDelCatalogo;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  if (fallo === 'prestadorInactivo') {
    return (
      <StateView
        state="empty"
        icon="user-check"
        title={t('servicios.catalogo.prestadorInactivo')}
        description={t('servicios.catalogo.prestadorInactivoCuerpo')}
        actionLabel={t('servicios.catalogo.verPostulacion')}
        onAction={() => router.push('/servicios/prestador' as never)}
      />
    );
  }
  if (fallo === 'noEncontrada') {
    return (
      <StateView
        state="empty"
        icon="search"
        title={t('servicios.catalogo.noEncontrado')}
        description={t('servicios.catalogo.noEncontradoCuerpo')}
      />
    );
  }
  return <EstadoDeServicios fallo={fallo} onRetry={onRetry} />;
}
