import React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { PestanasDeContenido } from '@/components/chat/PestanasDeContenido';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Lo que se ha compartido en un chat, por pestañas: «Media», «Enlaces»,
 * «Archivos» y «Audios».
 *
 * ES LA PANTALLA DE UN CHAT DE DOS. En un grupo, las mismas pestañas viven en
 * su ficha, al lado de «Miembros» (`GrupoScreen`): las dos pintan el contenido
 * con el mismo componente, y lo que cambie en una cambia en la otra.
 *
 * ES UNA PANTALLA APARTE Y NO PESTAÑAS DENTRO DEL CHAT, a propósito. El chat
 * tiene su propia lógica de desplazamiento, envío y tiempo real; meterle
 * vistas filtradas por dentro la pondría en riesgo. Aquí se abre encima y, al
 * volver, la conversación está exactamente donde se dejó.
 *
 * Para encontrar un mensaje por su texto está «Buscar» (`BuscarEnChatScreen`).
 */
export function ContenidoDeChatScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; name?: string }>();
  const conversationId = typeof params.id === 'string' ? params.id : '';
  const nombre = typeof params.name === 'string' && params.name ? params.name : undefined;

  return (
    <AppScreen scroll={false}>
      <AppHeader
        title={nombre ? t('chatViews.titleOf', { nombre }) : t('chatViews.title')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
      <PestanasDeContenido conversationId={conversationId} nombreDelChat={nombre} />
    </AppScreen>
  );
}
