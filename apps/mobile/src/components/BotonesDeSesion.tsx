import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import {
  accionPrincipal,
  accionesDeSesion,
  type AccionDeSesion,
  type EstadoDeLaSesion,
  type PapelEnLaSesion,
} from '@/lib/accionesDeSesion';
import { spacing } from '@/theme/tokens';

const ETIQUETA: Record<AccionDeSesion, TranslationKey> = {
  accepted: 'agenda.accept',
  rejected: 'agenda.reject',
  // «Cancelar sesión» y no «Cancelar» a secas: junto a otro botón, «Cancelar»
  // se lee como «déjalo», que es lo contrario de lo que hace.
  cancelled: 'agenda.cancelSession',
  completed: 'agenda.weDidIt',
};

type Props = {
  estado: EstadoDeLaSesion;
  papel: PapelEnLaSesion;
  /** Hay una respuesta en curso: los botones se apagan. */
  ocupada?: boolean;
  alElegir: (accion: AccionDeSesion) => void;
};

/**
 * Los botones de una sesión 1:1, SEGÚN SU ESTADO.
 *
 * Los pintan la agenda y la tarjeta del chat. Qué botones salen no lo decide
 * ninguna de las dos: lo decide `accionesDeSesion`, que es la tabla del
 * servidor. Una sesión aceptada no vuelve a ofrecer «Aceptar» en ningún sitio.
 *
 * No pinta nada si no hay nada que hacer.
 */
export function BotonesDeSesion({ estado, papel, ocupada = false, alElegir }: Props) {
  const { t } = useTranslation();
  const acciones = accionesDeSesion(estado, papel);
  if (acciones.length === 0) return null;
  const principal = accionPrincipal(estado, papel);

  return (
    <View style={styles.fila}>
      {acciones.map((accion) => (
        <Button
          key={accion}
          label={t(ETIQUETA[accion])}
          variant={accion === principal ? 'primary' : 'secondary'}
          onPress={() => alElegir(accion)}
          disabled={ocupada}
          style={styles.boton}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  fila: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  boton: { flex: 1, paddingHorizontal: spacing.sm },
});
