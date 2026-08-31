import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Text } from '@/components/Text';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/** Un apartado del documento: titulo y uno o varios parrafos. */
export type LegalSection = {
  heading: string;
  paragraphs: string[];
};

type LegalDocumentProps = {
  title: string;
  /** Fecha de ultima actualizacion, ya formateada. */
  updatedAt: string;
  intro: string;
  sections: LegalSection[];
};

/**
 * Lienzo comun de los documentos legales.
 *
 * Son pantallas de la app y a la vez paginas publicas de la web: expo-router
 * exporta `/privacy` y `/terms` en el build de Vercel, que es exactamente la
 * URL publica que Apple exige poder revisar sin instalar nada.
 */
export function LegalDocument({ title, updatedAt, intro, sections }: LegalDocumentProps) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={title}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
      <AppScreen contentStyle={styles.content}>
        <Text variant="display" style={styles.title}>
          {title}
        </Text>
        <Text variant="secondary" color={colors.textMuted} style={styles.updated}>
          {t('legal.updatedAt', { fecha: updatedAt })}
        </Text>

        {/*
          Aviso de borrador. Se deja VISIBLE a proposito: publicar un texto
          legal sin revision profesional y sin decirlo es peor que no tenerlo.
        */}
        <View style={[styles.draft, { borderColor: colors.border, backgroundColor: colors.backgroundAlt }]}>
          <Text variant="secondary" color={colors.textMuted} style={styles.draftText}>
            {t('legal.draftNotice')}
          </Text>
        </View>

        <Text variant="body" color={colors.textMuted} style={styles.intro}>
          {intro}
        </Text>

        {sections.map((section) => (
          <View key={section.heading} style={styles.section}>
            <Text variant="body" weight="800" style={styles.heading}>
              {section.heading}
            </Text>
            {section.paragraphs.map((paragraph, index) => (
              <Text
                key={index}
                variant="body"
                color={colors.textMuted}
                style={styles.paragraph}
              >
                {paragraph}
              </Text>
            ))}
          </View>
        ))}
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  // Ancho maximo para que en un monitor el texto no cruce la pantalla entera:
  // una linea muy larga es incomoda de leer.
  content: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxxl, maxWidth: 760, width: '100%', alignSelf: 'center' },
  title: { marginTop: spacing.lg },
  updated: { marginTop: spacing.sm },
  draft: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  draftText: { lineHeight: 18 },
  intro: { lineHeight: 22, marginTop: spacing.lg },
  section: { marginTop: spacing.xl },
  heading: { marginBottom: spacing.sm },
  paragraph: { lineHeight: 22, marginBottom: spacing.sm },
});
