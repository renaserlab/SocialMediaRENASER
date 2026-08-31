import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';

import { Text } from '@/components/Text';
import { etiquetaDePrecio } from '@/lib/dinero';
import {
  duracionLegible,
  duracionTotal,
  totalDeLecciones,
  type BorradorDeCurso,
  type ResumenDeModulo,
} from '@/lib/asistenteDeCurso';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';

const NIVELES: Record<string, string> = {
  beginner: 'Inicial',
  intermediate: 'Intermedio',
  advanced: 'Avanzado',
};

// El nombre del idioma se pinta en el idioma de la aplicación, no en el suyo:
// es una etiqueta de la ficha, no un selector de idioma.
const IDIOMAS: Record<string, TranslationKey> = {
  es: 'lang.spanish',
  en: 'lang.english',
  pt: 'lang.portuguese',
};

type Props = {
  borrador: BorradorDeCurso;
  modulos: ResumenDeModulo[];
  /** URL firmada de la portada, si ya la hay. */
  coverUrl?: string;
  currency: string;
  precioEnCentavos: number;
};

/**
 * La ficha del curso tal y como la verá quien no lo ha comprado.
 *
 * ES LA FICHA DE VERDAD, no un resumen del formulario. Un asistente que en el
 * último paso enseña «Título: X / Nivel: Y» te confirma que rellenaste campos;
 * lo que hace falta saber antes de enviar algo a revisión es cómo queda, y eso
 * solo se ve pintándolo como se va a ver.
 *
 * Los datos salen del borrador que se está editando y del temario real, así que
 * refleja lo que hay ahora mismo, incluido lo que todavía falta: un hueco aquí
 * es exactamente el hueco que vería un alumno.
 */
export function VistaPreviaDeCurso({
  borrador,
  modulos,
  coverUrl,
  currency,
  precioEnCentavos,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const segundos = duracionTotal(modulos);
  const lecciones = totalDeLecciones(modulos);

  return (
    <View style={[styles.raiz, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <View style={[styles.portada, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}>
        {coverUrl ? (
          <ExpoImage source={{ uri: coverUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={styles.sinPortada}>
            <Feather name="image" size={20} color={colors.textMuted} />
            <Text variant="caption" color={colors.textMuted}>
              {t('preview.noCover')}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.cuerpo}>
        <Text variant="titleMedium" weight="900">
          {borrador.title.trim() || t('preview.noTitle')}
        </Text>
        {borrador.subtitle.trim() ? (
          <Text variant="secondary" color={colors.textMuted}>
            {borrador.subtitle.trim()}
          </Text>
        ) : null}

        <View style={styles.etiquetas}>
          <Dato icono="tag" texto={etiquetaDePrecio(precioEnCentavos, currency)} />
          <Dato icono="clock" texto={duracionLegible(segundos)} />
          <Dato icono="play-circle" texto={t('course.lessons', { count: lecciones })} />
          <Dato icono="book" texto={t('course.modules', { count: modulos.length })} />
          {borrador.level ? (
            <Dato icono="bar-chart-2" texto={NIVELES[borrador.level] ?? borrador.level} />
          ) : null}
          <Dato
            icono="globe"
            texto={
              IDIOMAS[borrador.language]
                ? t(IDIOMAS[borrador.language]!)
                : borrador.language.toUpperCase()
            }
          />
        </View>

        {borrador.description.trim() ? (
          <Text variant="secondary" color={colors.textMuted} style={styles.parrafo}>
            {borrador.description.trim()}
          </Text>
        ) : (
          <Text variant="secondary" color={colors.textMuted} style={styles.parrafo}>
            {t('preview.noDescription')}
          </Text>
        )}

        <Lista titulo={t('preview.whatYouLearn')} icono="check" valores={borrador.highlights} />
        <Lista titulo={t('preview.whoFor')} icono="user" valores={borrador.targetAudience} />
        <Lista
          titulo={t('preview.prerequisites')}
          icono="corner-down-right"
          valores={borrador.prerequisites}
        />
      </View>
    </View>
  );
}

function Dato({ icono, texto }: { icono: keyof typeof Feather.glyphMap; texto: string }) {
  const { colors } = useAppTheme();
  return (
    <View style={[styles.dato, { borderColor: colors.border }]}>
      <Feather name={icono} size={12} color={colors.text} />
      <Text variant="caption" weight="700">
        {texto}
      </Text>
    </View>
  );
}

function Lista({
  titulo,
  icono,
  valores,
}: {
  titulo: string;
  icono: keyof typeof Feather.glyphMap;
  valores: string[];
}) {
  const { colors } = useAppTheme();
  // Una sección vacía NO se pinta: enseñar un encabezado sin nada debajo hace
  // pensar que la ficha está rota, no que falta rellenarla.
  const limpias = valores.map((v) => v.trim()).filter(Boolean);
  if (limpias.length === 0) return null;
  return (
    <View style={styles.lista}>
      <Text variant="caption" weight="800" color={colors.textMuted} style={styles.tituloDeLista}>
        {titulo.toUpperCase()}
      </Text>
      {limpias.map((frase, indice) => (
        <View key={`${frase}-${indice}`} style={styles.punto}>
          <Feather name={icono} size={14} color={colors.text} />
          <Text variant="secondary" style={styles.textoDePunto}>
            {frase}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  raiz: { borderWidth: 1, borderRadius: radius.lg, overflow: 'hidden' },
  portada: { width: '100%', aspectRatio: 16 / 9, borderBottomWidth: 1 },
  sinPortada: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
  cuerpo: { padding: spacing.lg, gap: spacing.sm },
  etiquetas: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  dato: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  parrafo: { marginTop: spacing.sm },
  lista: { gap: spacing.xs, marginTop: spacing.md },
  tituloDeLista: { letterSpacing: 1 },
  punto: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  textoDePunto: { flex: 1 },
});
