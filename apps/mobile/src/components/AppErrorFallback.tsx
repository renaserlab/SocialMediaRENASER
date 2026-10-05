import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { detalleDelFallo } from '@/lib/dondeFallo';
import { palette, radius, spacing } from '@/theme/tokens';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * Pantalla que se muestra cuando algo falla sin remedio.
 *
 * Sin esto, un fallo al dibujar cualquier pantalla dejaba la aplicacion EN
 * BLANCO, sin explicacion y sin salida: la unica forma de continuar era
 * cerrarla y volver a abrirla. Quien esta probando la aplicacion no tiene por
 * que saber eso, y una pantalla en blanco se reporta —con razon— como que la
 * aplicacion se ha roto.
 *
 * Se ofrece una salida en el mismo sitio donde ocurre el problema, y se
 * conserva el detalle tecnico para quien tenga que arreglarlo. Va en el idioma
 * del producto: es una pantalla que puede ver cualquiera, no un volcado para
 * el equipo.
 *
 * Los colores se toman de la paleta clara directamente, sin el tema: si lo que
 * ha fallado es justamente la carga del tema, leerlo aqui volveria a fallar y
 * no habria forma de mostrar nada.
 */
const colores = palette('light');

export function AppErrorFallback({
  error,
  retry,
  detalle,
}: {
  error: Error;
  retry: () => void;
  /**
   * Dónde ocurrió, si quien pinta esta pantalla lo sabe (`LimiteDeErrores`).
   * Sin ello se saca lo que se pueda del propio error.
   */
  detalle?: string;
}) {
  const { t } = useTranslation();
  const donde = detalle || detalleDelFallo({ pila: error?.stack });
  return (
    <View style={[styles.root, { backgroundColor: colores.background }]}>
      <Feather name="alert-triangle" size={44} color={colores.text} />

      <Text style={[styles.titulo, { color: colores.text }]}>{t('crash.title')}</Text>
      <Text style={[styles.cuerpo, { color: colores.textMuted }]}>{t('crash.body')}</Text>

      <Pressable
        onPress={retry}
        style={[styles.boton, { backgroundColor: colores.primary }]}
        accessibilityRole="button"
        accessibilityLabel={t('crash.retry')}
      >
        <Text style={[styles.botonTexto, { color: colores.onPrimary }]}>{t('crash.retry')}</Text>
      </Pressable>

      {/*
        El detalle tecnico se muestra al final y en pequeno: no es para quien
        usa la aplicacion, pero permite que un aviso de alguien que la esta
        probando llegue con la informacion util en vez de «se rompio».
      */}
      <ScrollView style={styles.detalle} contentContainerStyle={{ paddingBottom: spacing.md }}>
        <Text style={[styles.detalleTexto, { color: colores.textMuted }]} selectable>
          {error?.message ?? t('crash.noDetail')}
        </Text>
        {/*
          DÓNDE. El mensaje solo no basta: «Maximum update depth exceeded» es
          el mismo falle lo que falle. Con el componente y la pantalla, una
          captura de esta pantalla es suficiente para encontrarlo.
        */}
        {donde ? (
          <Text style={[styles.detalleTexto, styles.donde, { color: colores.textMuted }]} selectable>
            {donde}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  titulo: { fontSize: 20, fontWeight: '800', textAlign: 'center' },
  cuerpo: { fontSize: 14, lineHeight: 20, textAlign: 'center', maxWidth: 340 },
  boton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    minHeight: 44,
    justifyContent: 'center',
  },
  botonTexto: { fontSize: 15, fontWeight: '700' },
  // Alto de sobra para las tres líneas de «dónde»: tienen que caber en una captura.
  detalle: { maxHeight: 340, alignSelf: 'stretch', marginTop: spacing.md },
  detalleTexto: { fontSize: 11, lineHeight: 16, textAlign: 'center' },
  donde: { marginTop: spacing.sm },
});
