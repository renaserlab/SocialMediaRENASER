import React from 'react';
import { Stack, useRouter } from 'expo-router';

import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Cualquier ruta que no existe.
 *
 * POR QUE HACIA FALTA. Sin esto, una ruta desconocida caia en la pantalla que
 * trae expo-router de serie: en ingles, con jerga de desarrollo y sin salida.
 * El caso concreto que lo destapo es el peor posible: el checkout mandaba a
 * `/pago`, que no existia, asi que quien acababa de pagar aterrizaba ahi sin
 * saber si se le habia cobrado.
 *
 * Las rutas de pago ya existen; esto es la red por debajo, para el enlace viejo
 * que alguien tenga guardado y para el que venga.
 */
export default function NoEncontrada() {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <>
      <Stack.Screen options={{ title: t('notFound.title') }} />
      <AppScreen>
        <StateView
          state="empty"
          icon="compass"
          title={t('notFound.title')}
          description={t('notFound.body')}
        />
        <Button label={t('notFound.goHome')} onPress={() => router.replace('/')} />
      </AppScreen>
    </>
  );
}
