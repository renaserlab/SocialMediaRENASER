import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';

import { LANGUAGE_NAMES, type Language } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { idiomaEfectivo } from '@/lib/idioma';
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
  const elegirIdioma = useAppStore((state) => state.elegirIdioma);
  const current = useAppStore((state) => idiomaEfectivo(state.idiomaElegido));
  const { t } = useTranslation();
  // Arranca en el idioma con el que se esta pintando ahora: si ya hay eleccion,
  // en ella; si no, en el de por defecto.
  const [selectedLang, setSelectedLang] = useState<Language>(current);

  const proceed = () => {
    /*
      Una sola escritura y persistida: `elegirIdioma` guarda LA ELECCION, que es
      lo unico que decide si esta pantalla vuelve a salir sola. Antes hacian
      falta dos (`setLanguage` + `setLanguageSelected`) y bastaba con perder la
      segunda para que la pantalla reapareciera en cada arranque.
    */
    elegirIdioma(selectedLang);
    /*
      A donde se vuelve depende de POR QUE se llego:

      - Entrando a mano desde Ajustes hay historial, y lo correcto es devolver a
        Ajustes. Antes se hacia `replace('/')` siempre y se expulsaba al inicio
        a quien solo venia a cambiar el idioma.
      - En el arranque no hay historial: se vuelve a la raiz, que ya sabe a
        donde tocaba ir (ver `rutaDeArranque`).
    */
    if (router.canGoBack()) router.back();
    else router.replace('/');
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
