import { StyleSheet, View } from 'react-native';

import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type SectionTitleProps = {
  title: string;
  action?: string;
  onActionPress?: () => void;
};

export function SectionTitle({ title, action, onActionPress }: SectionTitleProps) {
  const { colors } = useAppTheme();

  return (
    <View style={styles.row}>
      <Text variant="titleMedium">{title}</Text>
      {action && onActionPress ? (
        <Pulsable
          onPress={onActionPress}
          accessibilityLabel={action}
          accessibilityRole="button"
          style={styles.actionPressable}
        >
          <Text variant="secondary" color={colors.textMuted}>{action}</Text>
        </Pulsable>
      ) : action ? (
        <Text variant="secondary" color={colors.textMuted}>{action}</Text>
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
  actionPressable: {
    minHeight: 44,
    justifyContent: 'center',
  },
});
