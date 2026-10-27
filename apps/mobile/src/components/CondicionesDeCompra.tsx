import React from 'react';
import { StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Lo que hay que saber antes de pagar.
 *
 * Todo sale del servidor: el precio del curso, la versión de la oferta y las
 * horas de garantía. No hay impuestos porque no se calculan en ninguna parte, y
 * ponerlos a cero sería afirmar que no los hay.
 */
export function CondicionesDeCompra({
  visible,
  onClose,
  onConfirmar,
  titulo,
  precio,
  version,
  horasDeGarantia,
  confirmando,
}: {
  visible: boolean;
  onClose: () => void;
  onConfirmar: () => void;
  titulo: string;
  /**
   * El precio YA FORMATEADO, tal como se va a cobrar.
   *
   * En movil lo pone la TIENDA —localizado, con su moneda y sus impuestos—
   * y no `price_minor` del catalogo, que es otra cifra. Esta es la ultima
   * pantalla antes de pagar: ensenar aqui el numero del catalogo seria
   * ensenar uno distinto del que se cobra.
   */
  precio: string;
  /** Versión publicada de la oferta, o `null` si el servidor no la da. */
  version: number | null;
  /** Las que diga el servidor. Sin dato, no se promete plazo. */
  horasDeGarantia: number | null;
  confirmando: boolean;
}) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();

  const dias = horasDeGarantia ? Math.round(horasDeGarantia / 24) : null;

  const puntos = [
    dias !== null
      ? t('condiciones.garantia').replace('{dias}', String(dias))
      : null,
    t('condiciones.unaSolaDevolucion'),
    t('condiciones.accesoPermanente'),
  ].filter((p): p is string => p !== null);

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <Text style={[styles.titulo, { color: colors.text }]}>{t('condiciones.titulo')}</Text>
      <View style={styles.cuerpo}>
        <View style={styles.linea}>
          <Text style={[styles.concepto, { color: colors.text }]}>{titulo}</Text>
          <Text style={[styles.importe, { color: colors.text }]}>
            {precio}
          </Text>
        </View>

        {version !== null ? (
          <Text style={[styles.version, { color: colors.textMuted }]}>
            {t('condiciones.version').replace('{version}', String(version))}
          </Text>
        ) : null}

        <View style={styles.puntos}>
          {puntos.map((punto) => (
            <View key={punto} style={styles.punto}>
              <Feather name="shield" size={15} color={colors.textMuted} />
              <Text style={[styles.textoDePunto, { color: colors.textMuted }]}>
                {punto}
              </Text>
            </View>
          ))}
        </View>

        <Button
          label={t('condiciones.continuar')}
          onPress={onConfirmar}
          loading={confirmando}
          disabled={confirmando}
        />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  cuerpo: { gap: spacing.md, paddingBottom: spacing.md },
  titulo: { fontSize: 17, fontWeight: '700', marginBottom: spacing.sm },
  linea: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  concepto: { flex: 1, fontSize: 16, fontWeight: '600' },
  importe: { fontSize: 18, fontWeight: '700' },
  version: { fontSize: 12 },
  puntos: { gap: spacing.sm },
  punto: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  textoDePunto: { flex: 1, fontSize: 14, lineHeight: 20 },
});
