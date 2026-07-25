import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { LANGUAGE_NAMES, type Language } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { useAppStore } from '@/store/useAppStore';
import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { ListRow } from '@/components/ListRow';
import { Text } from '@/components/Text';
import { ZLogo } from '@/components/ZLogo';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export function LanguageScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const setLanguageSelected = useAppStore((state) => state.setLanguageSelected);
  const setLanguage = useAppStore((state) => state.setLanguage);
  const current = useAppStore((state) => state.language);
  const { t } = useTranslation();
  // Arranca en el idioma guardado, no siempre en español.
  const [selectedLang, setSelectedLang] = useState<Language>(current);

  const proceed = () => {
    // Antes el idioma elegido solo vivia en este useState y se perdia al salir,
    // por eso la app seguia en español.
    setLanguage(selectedLang);
    setLanguageSelected(true);
    router.replace('/');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title={t('language.title')} back />
      <AppScreen scroll={false} edges={['left', 'right', 'bottom']}>
        <View style={styles.container}>
          <View style={styles.content}>
            {/* La marca preside la primera pantalla que se ve al entrar. */}
            <View style={styles.brand}>
              <ZLogo size={72} />
            </View>

            <Text variant="secondary" color={colors.textMuted} style={styles.description}>
              {t('language.description')}
            </Text>

            <View style={styles.list}>
              <ListRow
                title={LANGUAGE_NAMES.es}
                rightComponent={selectedLang === 'es' ? <Feather name="check" size={18} color={colors.text} /> : null}
                onPress={() => setSelectedLang('es')}
                style={selectedLang === 'es' ? { borderColor: colors.text } : undefined}
              />
              <ListRow
                title={LANGUAGE_NAMES.en}
                rightComponent={selectedLang === 'en' ? <Feather name="check" size={18} color={colors.text} /> : null}
                onPress={() => setSelectedLang('en')}
                style={selectedLang === 'en' ? { borderColor: colors.text } : undefined}
              />
              <ListRow
                title={LANGUAGE_NAMES.pt}
                rightComponent={selectedLang === 'pt' ? <Feather name="check" size={18} color={colors.text} /> : null}
                onPress={() => setSelectedLang('pt')}
                style={selectedLang === 'pt' ? { borderColor: colors.text } : undefined}
              />
            </View>
          </View>

          <View style={styles.footer}>
            <Button label={t('language.continue')} onPress={proceed} />
          </View>
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  brand: { alignItems: 'center', marginBottom: spacing.xl },
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
