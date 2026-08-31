import React from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { ListRow } from '@/components/ListRow';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';

/** Buzon unico de soporte. Es el mismo que atiende los asuntos legales. */
export const SUPPORT_EMAIL = 'renaserlab@gmail.com';

/**
 * Asunto ya rellenado.
 *
 * Ahorra una decision a quien escribe y, sobre todo, permite filtrar el buzon:
 * sin asunto fijo, las peticiones de ayuda se mezclan con el resto del correo.
 * El asunto lo lee el equipo de soporte, no quien escribe: por eso se queda
 * fijo y no se traduce.
 */
const MAILTO = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Ayuda con la app Z')}`;

type Faq = {
  question: TranslationKey;
  /** Cada párrafo, en su propia clave: partirlos por comas no se traduce. */
  answer: TranslationKey[];
};

/**
 * Preguntas frecuentes.
 *
 * Cada una describe el comportamiento REAL de la aplicacion, no el deseado. Una
 * pagina de soporte que explica funciones que no existen es peor que no
 * tenerla: genera el ticket que pretendia evitar, y ante Apple es motivo de
 * rechazo por informacion enganosa.
 */
const FAQS: Faq[] = [
  { question: 'support.q1', answer: ['support.q1a1', 'support.q1a2'] },
  { question: 'support.q2', answer: ['support.q2a1', 'support.q2a2'] },
  { question: 'support.q3', answer: ['support.q3a1', 'support.q3a2'] },
  { question: 'support.q4', answer: ['support.q4a1', 'support.q4a2', 'support.q4a3'] },
  { question: 'support.q5', answer: ['support.q5a1', 'support.q5a2', 'support.q5a3'] },
  { question: 'support.q6', answer: ['support.q6a1', 'support.q6a2'] },
  { question: 'support.q7', answer: ['support.q7a1', 'support.q7a2'] },
];

/** Datos que evitan el intercambio de correos de ida y vuelta. */
const WHAT_TO_INCLUDE: TranslationKey[] = [
  'support.include1',
  'support.include2',
  'support.include3',
  'support.include4',
];

/**
 * Centro de ayuda.
 *
 * Es una pantalla de la app y, a la vez, la pagina publica `/support` que
 * exporta el build de la web: Apple exige una URL de soporte accesible SIN
 * instalar nada, y Google Play pide lo mismo para la ficha. Al ser una ruta
 * propia no depende de configurar ningun dominio externo ni de que un tercero
 * siga en pie.
 */
export function SupportScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  const escribir = () => {
    Linking.openURL(MAILTO).catch(() => {
      // Un escritorio sin cliente de correo configurado no abre `mailto:`. Sin
      // esta salida, el boton de una pagina de AYUDA seria justo lo que no
      // funciona: se muestra la direccion para copiarla a mano.
      notify(t('support.writeToUsAt'), SUPPORT_EMAIL);
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={t('support.headerTitle')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
      <AppScreen contentStyle={styles.content}>
        <Text variant="display" style={styles.title}>
          {t('support.title')}
        </Text>
        <Text variant="body" color={colors.textMuted} style={styles.intro}>
          {t('support.intro')}
        </Text>

        {/* Contacto arriba del todo: quien entra buscando ayuda no debería
            tener que leer un documento entero para encontrar la dirección. */}
        <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.backgroundAlt }]}>
          <View style={styles.cardHead}>
            <Feather name="mail" size={18} color={colors.text} />
            <Text variant="body" weight="800">
              {t('support.directContact')}
            </Text>
          </View>
          <Text variant="body" style={styles.email} selectable>
            {SUPPORT_EMAIL}
          </Text>
          <Text variant="secondary" color={colors.textMuted} style={styles.cardBody}>
            {t('support.responseTime', { plazo: t('support.responseWindow') })}
          </Text>
          <Button
            label={t('support.writeToSupport')}
            icon="send"
            onPress={escribir}
            style={styles.cta}
          />
        </View>

        <Text variant="titleMedium" style={styles.sectionTitle}>
          {t('support.beforeWriting')}
        </Text>
        <Text variant="secondary" color={colors.textMuted} style={styles.sectionIntro}>
          {t('support.beforeWritingIntro')}
        </Text>
        {WHAT_TO_INCLUDE.map((item) => (
          <View key={item} style={styles.bullet}>
            {/* El icono acompaña al texto en vez de sustituirlo: la lista se
                sigue entendiendo si no se distinguen los colores. */}
            <Feather name="check" size={15} color={colors.textMuted} style={styles.bulletIcon} />
            <Text variant="body" color={colors.textMuted} style={styles.bulletText}>
              {t(item)}
            </Text>
          </View>
        ))}

        <Text variant="titleMedium" style={styles.sectionTitle}>
          {t('support.faq')}
        </Text>
        {FAQS.map((faq) => (
          <View key={faq.question} style={[styles.faq, { borderColor: colors.border }]}>
            <Text variant="body" weight="800" style={styles.question}>
              {t(faq.question)}
            </Text>
            {faq.answer.map((paragraph, index) => (
              <Text
                key={index}
                variant="body"
                color={colors.textMuted}
                style={styles.answer}
              >
                {t(paragraph)}
              </Text>
            ))}
          </View>
        ))}

        <Text variant="titleMedium" style={styles.sectionTitle}>
          {t('support.documents')}
        </Text>
        <ListRow
          title={t('settings.privacy')}
          subtitle={t('settings.privacyBody')}
          leftIcon="shield"
          rightIcon="chevron-right"
          onPress={() => router.push('/privacy' as never)}
        />
        <ListRow
          title={t('settings.terms')}
          subtitle={t('settings.termsBody')}
          leftIcon="file-text"
          rightIcon="chevron-right"
          onPress={() => router.push('/terms' as never)}
        />
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  // Mismo ancho maximo que los documentos legales: en un monitor, una linea que
  // cruza la pantalla entera es incomoda de leer.
  content: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxxl,
    maxWidth: 760,
    width: '100%',
    alignSelf: 'center',
  },
  title: { marginTop: spacing.lg },
  intro: { lineHeight: 22, marginTop: spacing.sm },
  card: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginTop: spacing.xl,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  email: { marginTop: spacing.md },
  cardBody: { lineHeight: 20, marginTop: spacing.sm },
  cta: { marginTop: spacing.lg },
  sectionTitle: { marginTop: spacing.xxl },
  sectionIntro: { lineHeight: 20, marginTop: spacing.sm },
  bullet: { flexDirection: 'row', alignItems: 'flex-start', marginTop: spacing.md },
  // Empuja el icono hasta la altura de la primera linea del texto.
  bulletIcon: { marginTop: 3, marginRight: spacing.sm },
  bulletText: { flex: 1, lineHeight: 22 },
  faq: {
    borderTopWidth: 1,
    paddingTop: spacing.lg,
    marginTop: spacing.lg,
  },
  question: { marginBottom: spacing.sm },
  answer: { lineHeight: 22, marginBottom: spacing.sm },
});
