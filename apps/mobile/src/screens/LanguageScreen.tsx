import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { useAppStore } from '@/store/useAppStore';
import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { ListRow } from '@/components/ListRow';
import { Text } from '@/components/Text';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function LanguageScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const setLanguageSelected = useAppStore((state) => state.setLanguageSelected);
  const [selectedLang, setSelectedLang] = useState<'es' | 'en' | 'pt'>('es');

  const proceed = () => {
    setLanguageSelected(true);
    router.replace('/');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title="Idioma" back />
      <AppScreen scroll={false} edges={['left', 'right', 'bottom']}>
        <View style={styles.container}>
          <View style={styles.content}>
            <Text variant="secondary" color={colors.textMuted} style={styles.description}>
              Elige el idioma de la aplicación
            </Text>

            <View style={styles.list}>
              <ListRow
                title="Español"
                rightComponent={selectedLang === 'es' ? <Feather name="check" size={18} color={colors.text} /> : null}
                onPress={() => setSelectedLang('es')}
                style={selectedLang === 'es' ? { borderColor: colors.text } : undefined}
              />
              <ListRow
                title="English"
                rightComponent={selectedLang === 'en' ? <Feather name="check" size={18} color={colors.text} /> : null}
                onPress={() => setSelectedLang('en')}
                style={selectedLang === 'en' ? { borderColor: colors.text } : undefined}
              />
              <ListRow
                title="Português"
                rightComponent={selectedLang === 'pt' ? <Feather name="check" size={18} color={colors.text} /> : null}
                onPress={() => setSelectedLang('pt')}
                style={selectedLang === 'pt' ? { borderColor: colors.text } : undefined}
              />
            </View>
          </View>

          <View style={styles.footer}>
            <Button label="Continuar" onPress={proceed} />
          </View>
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    justifyContent: 'space-between',
  },
  content: {
    flex: 1,
  },
  description: {
    marginTop: spacing.xs,
    marginBottom: spacing.md,
  },
  list: {
    gap: spacing.sm,
  },
  footer: {
    paddingBottom: spacing.lg,
  },
});
