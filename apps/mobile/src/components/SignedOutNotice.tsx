import React from 'react';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { StateView } from '@/components/StateView';

/**
 * Invitación a crear cuenta en las pantallas que necesitan una.
 *
 * Mensajes, notificaciones o guardados no son algo que exista «en general»:
 * son de alguien. Sin sesión no hay nada que enseñar, y pedir los datos igual
 * devolvía un error de autorización que la pantalla mostraba como «Ha ocurrido
 * un error» con un botón de reintentar, algo que no llevaba a ninguna parte por
 * mucho que se pulsara.
 *
 * Se explica lo que pasa y se ofrece la salida, en vez de dar un fallo técnico.
 */
export function SignedOutNotice({
  icon,
  title,
  description,
}: {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  description: string;
}) {
  const router = useRouter();

  return (
    <StateView
      state="empty"
      icon={icon}
      title={title}
      description={description}
      actionLabel="Crear cuenta"
      onAction={() => router.push('/register' as never)}
    />
  );
}
