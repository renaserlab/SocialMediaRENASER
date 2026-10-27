import { StyleSheet, View } from 'react-native';

import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { estilo, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type SectionTitleProps = {
  title: string;
  action?: string;
  onActionPress?: () => void;
};

export function SectionTitle({ title, action, onActionPress }: SectionTitleProps) {
  const { colors } = useAppTheme();
  // `titulosDeSeccion: "conAcento"`: una marca corta de color delante del
  // título y la acción («Ver todo») en el acento y en negrita.
  const conAcento = estilo.titulosDeSeccion === 'conAcento';
  const tituloPintado = <Text variant="titleMedium">{title}</Text>;
  const colorDeAccion = conAcento ? colors.acento : colors.textMuted;
  const pesoDeAccion = conAcento ? '700' : undefined;

  return (
    <View style={styles.row}>
      {conAcento ? (
        <View style={styles.conMarca}>
          <View style={[styles.marca, { backgroundColor: colors.acento }]} />
          {tituloPintado}
        </View>
      ) : (
        tituloPintado
      )}
      {action && onActionPress ? (
        <Pulsable
          onPress={onActionPress}
          accessibilityLabel={action}
          accessibilityRole="button"
          style={styles.actionPressable}
        >
          <Text variant="secondary" color={colorDeAccion} weight={pesoDeAccion}>{action}</Text>
        </Pulsable>
      ) : action ? (
        <Text variant="secondary" color={colorDeAccion} weight={pesoDeAccion}>{action}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
    marginTop: spacing.lg,
  },
  conMarca: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  marca: { width: 4, height: 18, borderRadius: 2 },
  actionPressable: {
    minHeight: 44,
    justifyContent: 'center',
  },
});
