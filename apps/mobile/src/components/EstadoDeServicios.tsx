import React from 'react';

import { StateView } from '@/components/StateView';
import { seReintenta, type FalloDeCarga } from '@/lib/serviciosAdmision';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Lo que enseña una pantalla de Z Servicios cuando NO pudo cargar.
 *
 * Cada fallo dice lo suyo, y solo se ofrece reintentar cuando reintentar
 * arregla algo (sin conexión, o un error del servidor). Servicios apagado,
 * sin sesión o sin permiso no se arreglan pulsando otra vez.
 */
export function EstadoDeServicios({
  fallo,
  onRetry,
}: {
  fallo: FalloDeCarga;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (fallo === 'sinConexion') return <StateView state="offline" onRetry={onRetry} />;
  if (seReintenta(fallo)) {
    return <StateView state="error" description={t('common.loadFailed')} onRetry={onRetry} />;
  }
  const textos = {
    apagado: ['servicios.error.noDisponible', 'servicios.error.noDisponibleCuerpo', 'clock'],
    sinSesion: ['servicios.error.sinSesion', 'servicios.error.sinSesionCuerpo', 'lock'],
    sinPermiso: ['servicios.error.sinPermiso', 'servicios.error.sinPermisoCuerpo', 'lock'],
    noEncontrada: ['servicios.error.noEncontrada', 'servicios.error.noEncontradaCuerpo', 'search'],
  } as const;
  const [titulo, cuerpo, icono] = textos[fallo as keyof typeof textos];
  return <StateView state="empty" icon={icono} title={t(titulo)} description={t(cuerpo)} />;
}
