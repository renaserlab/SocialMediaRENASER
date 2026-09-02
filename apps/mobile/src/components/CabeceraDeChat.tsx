import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { Avatar } from '@/components/Avatar';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { irAlPerfil } from '@/lib/irAlPerfil';
import type { MessageDto } from '@/mappers/messageMapper';
import { MENSAJES_POR_PAGINA } from '@/repositories/MessageRepository';
import { API_V1, apiRequest } from '@/services/api';
import { profileImageUrl } from '@/services/storage';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * La cabecera de una conversación: atrás, y con quién se está hablando.
 *
 * -----------------------------------------------------------------------------
 * LO QUE YA NO ESTÁ: LA CÁMARA DE VÍDEO
 * -----------------------------------------------------------------------------
 * Había un icono de videollamada arriba a la derecha (`rightIcon="video"` sin
 * `onRightPress`). No abría nada — no hay videollamadas en esta aplicación — y
 * un botón que no responde es peor que la ausencia del botón: quien lo pulsa no
 * concluye «esto no existe» sino «esto está roto». Se ha quitado.
 *
 * NO SE TOCA la cámara del selector de ADJUNTOS: ésa sí funciona (hace una foto
 * y la manda) y vive en la hoja del botón «+» de `ChatScreen`.
 *
 * -----------------------------------------------------------------------------
 * EL PARTICIPANTE SE RESUELVE CONTRA EL SERVIDOR, NO CONTRA LA NAVEGACIÓN
 * -----------------------------------------------------------------------------
 * `/chat/[id]` recibe un `name` como parámetro, y eso es lo único que había
 * antes en la cabecera. Un parámetro de navegación no vale para decidir a qué
 * perfil se abre:
 *
 *  - lo escribe quien navega, así que un enlace directo o un `router.push` de
 *    otra pantalla puede traer un nombre viejo, vacío o de otra persona;
 *  - no trae identificador, así que con él no se puede abrir ningún perfil;
 *  - y si alguien cambia su nombre, la cabecera seguiría enseñando el anterior.
 *
 * Así que el nombre y la foto del parámetro son SOLO el primer fotograma —lo
 * que evita que la cabecera parpadee vacía— y encima se pinta lo que dice el
 * servidor: el autor del primer mensaje de la conversación que no sea el
 * propio. Eso viene de `messages`, con su identificador de verdad, y es lo que
 * permite abrir `/profile/{id}`.
 *
 * SIN IDENTIFICADOR NO SE OFRECE ABRIR NADA. Si la conversación todavía no
 * tiene ningún mensaje de la otra persona —o la petición falla—, la cabecera
 * enseña el nombre de respaldo sin ser pulsable. Nunca un botón muerto, y nunca
 * navegar «a ver si acierta».
 */

/** Con quién se está hablando, ya resuelto. */
export type ParticipanteDelChat = {
  id: string;
  nombre: string;
  avatarUrl?: string;
};

/**
 * Lo ya resuelto en esta sesión, por conversación.
 *
 * Volver a entrar en un chat es de lo más frecuente —se sale a mirar el perfil
 * y se vuelve— y sin esto cada entrada repetiría la consulta y la cabecera
 * volvería a empezar por el nombre del parámetro. Vive en memoria y no en
 * disco: es una copia de datos de otra persona, y al cerrar la aplicación se va.
 */
const RESUELTOS = new Map<string, ParticipanteDelChat>();

/** Se vacía al cerrar sesión, igual que las firmas de los adjuntos. */
export function olvidarParticipantesDeChat(): void {
  RESUELTOS.clear();
}

async function pedirParticipante(
  conversationId: string,
  currentUserId: string | null | undefined,
): Promise<ParticipanteDelChat | null> {
  const dtos = await apiRequest<MessageDto[]>(
    `${API_V1}/conversations/${conversationId}/messages?limit=${MENSAJES_POR_PAGINA}`,
  );
  const autor = dtos
    .map((dto) => dto.sender)
    .find((remitente) => !!remitente?.id && remitente.id !== currentUserId);
  if (!autor) return null;
  return {
    id: autor.id,
    nombre: autor.full_name,
    avatarUrl: profileImageUrl(autor.avatar_path) ?? undefined,
  };
}

type Props = {
  conversationId?: string;
  /** Quién mira, para saber cuál de los dos remitentes es «el otro». */
  currentUserId?: string | null;
  /** El nombre del parámetro de navegación o del chat local. Solo respaldo. */
  nombreDeRespaldo: string;
  /** La foto que ya se conociera (bandeja, modo demostración). Solo respaldo. */
  avatarDeRespaldo?: string;
  /** El identificador que ya se conociera sin preguntar (modo demostración). */
  idDeRespaldo?: string;
  /** `false` sin Supabase: no hay servidor al que preguntar. */
  resolverEnElServidor: boolean;
  onBack: () => void;
};

export function CabeceraDeChat({
  conversationId,
  currentUserId,
  nombreDeRespaldo,
  avatarDeRespaldo,
  idDeRespaldo,
  resolverEnElServidor,
  onBack,
}: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();

  const [participante, setParticipante] = useState<ParticipanteDelChat | null>(() =>
    conversationId ? RESUELTOS.get(conversationId) ?? null : null,
  );

  useEffect(() => {
    if (!resolverEnElServidor || !conversationId) return;
    const recordado = RESUELTOS.get(conversationId);
    if (recordado) {
      setParticipante(recordado);
      return;
    }
    let montado = true;
    pedirParticipante(conversationId, currentUserId)
      .then((resuelto) => {
        if (!resuelto) return;
        RESUELTOS.set(conversationId, resuelto);
        if (montado) setParticipante(resuelto);
      })
      .catch(() => {
        // La cabecera se queda con el nombre de respaldo y sin enlace al
        // perfil. Un fallo al resolver quién es no puede dejar sin chat.
      });
    return () => {
      montado = false;
    };
  }, [resolverEnElServidor, conversationId, currentUserId]);

  const idDelPerfil = participante?.id ?? idDeRespaldo;
  const nombre = participante?.nombre || nombreDeRespaldo;
  const avatar = participante?.avatarUrl ?? avatarDeRespaldo;

  return (
    <AppHeader
      onBack={onBack}
      center={
        <Pressable
          onPress={() => irAlPerfil(router, idDelPerfil)}
          disabled={!idDelPerfil}
          accessibilityRole={idDelPerfil ? 'button' : undefined}
          accessibilityLabel={
            idDelPerfil ? t('chat.openProfile', { nombre }) : nombre
          }
          hitSlop={8}
          style={styles.persona}
        >
          <Avatar size={30} image={avatar ?? null} name={nombre} />
          <Text
            numberOfLines={1}
            weight="700"
            color={colors.text}
            style={styles.nombre}
          >
            {nombre}
          </Text>
        </Pressable>
      }
    />
  );
}

const styles = StyleSheet.create({
  persona: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    // `minWidth: 0` para que un nombre largo se recorte en vez de empujar al
    // botón de atrás fuera de la pantalla.
    minWidth: 0,
    flexShrink: 1,
  },
  nombre: { fontSize: 15, flexShrink: 1 },
});
