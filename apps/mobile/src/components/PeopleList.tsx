import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';

import { Button } from '@/components/Button';
import { useEspacioInferior } from '@/components/espacioInferior';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Persona tal y como la pinta esta lista.
 *
 * Es a proposito independiente del tipo `Person` del demo (que apunta a una
 * clave de `data/assets`): aqui la foto es una URL real y el estado de
 * seguimiento lo decide el backend, no un `useState` local.
 */
export type PersonRow = {
  id: string;
  fullName: string;
  username: string;
  avatarUrl?: string;
  isFollowing?: boolean;
};

type Props = {
  people: PersonRow[];
  emptyTitle: string;
  emptyDescription: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /**
   * Esta lista la sirve el backend solo a quien tiene sesion.
   *
   * NO es un error, y pintarlo como tal era el fallo: salia un cuadro rojo con
   * el mensaje tecnico del servidor y un boton de reintentar que no podia
   * funcionar nunca. Quien no tiene cuenta necesita saber que le hace falta
   * una, y como conseguirla.
   */
  necesitaCuenta?: boolean;
  /** Para que. Se lee «Necesitas una cuenta {motivo}». */
  motivoDeCuenta?: string;
  /** Sin este callback no se pinta el boton: seguir seria un adorno. */
  onToggleFollow?: (person: PersonRow) => void;
  /** Usuario actual, para no ofrecerle seguirse a si mismo. */
  currentUserId?: string | null;
  /**
   * Quien decide que pasa al tocar a una persona.
   *
   * Sin esto la lista navegaba sola, y dentro de una hoja eso dejaba el Modal
   * montado encima del perfil al que acababa de llevar: ni se iba al tocar
   * fuera ni habia forma de cerrarlo. Quien monta la hoja necesita cerrarla
   * ANTES de navegar, y solo el sabe como.
   *
   * Sin callback se conserva el comportamiento de siempre (pantalla completa).
   */
  onPersonPress?: (person: PersonRow) => void;
};

/** Lista social reutilizable (seguidores, siguiendo, resultados). */
export function PeopleList({
  people,
  emptyTitle,
  emptyDescription,
  loading = false,
  error = null,
  onRetry,
  necesitaCuenta = false,
  motivoDeCuenta,
  onToggleFollow,
  currentUserId,
  onPersonPress,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  /* En Seguidores y Seguidos la capsula flotante tapaba la ultima fila; en
     Reacciones, fuera de las pestañas, basta con el margen. */
  const espacioInferior = useEspacioInferior();

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.textMuted} />
      </View>
    );
  }

  /*
    ANTES QUE `error`: si falta la cuenta, no hay nada que reintentar. El orden
    importa porque una sesion caducada llega por los dos caminos a la vez.
  */
  if (necesitaCuenta) {
    return (
      <StateView
        state="empty"
        icon="user-plus"
        title={t('auth.signUpTitle')}
        description={t('auth.needAccount', {
          motivo: motivoDeCuenta ?? t('auth.reasonSeePeople'),
        })}
        actionLabel={t('auth.signUp')}
        onAction={() => router.push('/register' as never)}
      />
    );
  }

  if (error) {
    return <StateView state="error" description={error} onRetry={onRetry} />;
  }

  if (people.length === 0) {
    return <StateView state="empty" icon="users" title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <FlashList
      data={people}
      keyExtractor={(item: PersonRow) => item.id}
      contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: espacioInferior + spacing.lg }}
      renderItem={({ item }: { item: PersonRow }) => (
        <View style={[styles.row, { borderBottomColor: colors.border }]}>
          <Pressable
            style={styles.info}
            onPress={() => (onPersonPress ? onPersonPress(item) : irAlPerfil(router, item.id))}
            accessibilityRole="button"
            accessibilityLabel={`Ver perfil de ${item.fullName}`}
          >
            <ExpoImage
              source={item.avatarUrl ? { uri: item.avatarUrl } : assets.avatar}
              style={styles.avatar}
              contentFit="cover"
              cachePolicy="memory-disk"
            />
            <View style={{ flex: 1 }}>
              <Text variant="body" weight="700">{item.fullName}</Text>
              <Text variant="secondary" color={colors.textMuted}>{item.username}</Text>
            </View>
          </Pressable>
          {onToggleFollow && item.id !== currentUserId ? (
            <Button
              label={item.isFollowing ? t('profile.unfollow') : t('profile.follow')}
              variant={item.isFollowing ? 'secondary' : 'primary'}
              onPress={() => onToggleFollow(item)}
              style={styles.followBtn}
            />
          ) : null}
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md, borderBottomWidth: 1 },
  info: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1 },
  avatar: { width: 48, height: 48, borderRadius: 24 },
  followBtn: { minWidth: 104, minHeight: 38, height: 38 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
