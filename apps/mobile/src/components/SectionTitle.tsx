import { StyleSheet, Text, View } from 'react-native';

import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function SectionTitle({ title, action }: { title: string; action?: string }) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      {action ? <Text style={[styles.action, { color: colors.textMuted }]}>{action}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  title: { fontSize: 20, fontWeight: '800' },
  action: { fontSize: 13, fontWeight: '600' },
});
