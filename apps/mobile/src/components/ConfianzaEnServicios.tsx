import React from 'react';
import { StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { Text } from '@/components/Text';
import { useTextosDeServicios } from '@/hooks/useServicios';
import { resenasLegibles, senalesDeConfianza, type Confianza, type Resenas } from '@/lib/serviciosDescubrimiento';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * LO QUE Z COMPROBÓ, y nada más. Cada línea nombra exactamente la
 * comprobación (admisión, identidad, credencial vigente) y se pinta SOLO si es
 * verdad. Debajo, siempre, el alcance: comprobar no es garantizar el
 * resultado de un servicio.
 */
export function SenalesDeConfianza({ confianza }: { confianza: Confianza }) {
  const { colors } = useAppTheme();
  const { f } = useTextosDeServicios('descubrimiento');
  const senales = senalesDeConfianza(confianza);
  return (
    <View style={[styles.caja, { borderColor: colors.border }]} accessibilityRole="summary">
      <Text weight="700">{f('servicios.descubrir.confianza.titulo')}</Text>
      {senales.map((s) => (
        <View key={s.clave} style={styles.linea}>
          <Feather name="check-circle" size={16} color={colors.text} />
          <Text variant="secondary" style={styles.flexible}>
            {f(s.clave, s.params)}
          </Text>
        </View>
      ))}
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.descubrir.confianza.alcance')}
      </Text>
    </View>
  );
}

/**
 * Las reseñas del SERVICIO. Sin reseñas verificadas —hoy, siempre— se dice
 * así: ni estrellas vacías, ni «0.0», ni las reseñas de otra parte de Z.
 */
export function ResenasDelServicio({ resenas, delPrestador = false }: { resenas: Resenas; delPrestador?: boolean }) {
  const { colors } = useAppTheme();
  const { f } = useTextosDeServicios('descubrimiento');
  const frase = resenasLegibles(resenas);
  return (
    <View style={styles.bloque}>
      <Text weight="700">{f('servicios.descubrir.resenas.titulo')}</Text>
      <Text variant="secondary">{f(frase.clave, frase.params)}</Text>
      {frase.clave === 'servicios.descubrir.resenas.ninguna' ? (
        <Text variant="caption" color={colors.textMuted}>
          {f(delPrestador ? 'servicios.descubrir.resenas.comoLlegaranPrestador' : 'servicios.descubrir.resenas.comoLlegaran')}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  caja: { gap: spacing.sm, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
  linea: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  flexible: { flex: 1 },
  bloque: { gap: spacing.xs },
});
