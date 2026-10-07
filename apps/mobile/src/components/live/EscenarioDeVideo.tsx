import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

import { Avatar } from '@/components/Avatar';
import { sobreMedio } from '@/components/CapaDeContraste';
import { Text } from '@/components/Text';
import { repartirEnColumnas, type PistaDeEscenario } from '@/live/escenario';
import type { SalaDeVideo } from '@/live/salaDeVideo';
import { radius, spacing } from '@/theme/tokens';

/**
 * Cuánto ocupa la rejilla cuando hay varias personas: la parte de arriba.
 *
 * Con una sola imagen el vídeo va a pantalla completa y el chat se escribe
 * encima. Con varias, lo de abajo de la pantalla lo tapan el chat, el título y
 * las reacciones: a quien le tocara ese sitio no se le vería la cara. Se deja
 * la rejilla arriba y lo demás debajo, sobre fondo oscuro.
 */
export const ALTO_COMPARTIDO = '56%';

type Props = {
  /** Las que hay que pintar, ya elegidas y ordenadas (`elegirPistasDeEscenario`). */
  pistas: readonly PistaDeEscenario[];
  VistaDePista: NonNullable<SalaDeVideo['VistaDePista']>;
  /** La cámara propia es la frontal: su imagen se pinta en espejo. */
  camaraFrontal: boolean;
  /** Con UNA imagen, si la calidad la elige el proveedor o la persona. */
  capaAutomatica: boolean;
};

/**
 * Las imágenes del directo: una a pantalla completa, o varias repartidas.
 *
 * NO DECIDE NADA. Qué imágenes y en qué orden lo dice `live/escenario.ts`;
 * aquí solo se colocan. Con una sola pinta exactamente lo que se pintaba antes
 * de que existieran los invitados.
 *
 * NO SE QUEDA LOS TOQUES: por encima van los botones, el chat y el campo de
 * escribir.
 */
export function EscenarioDeVideo({ pistas, VistaDePista, camaraFrontal, capaAutomatica }: Props) {
  const varias = pistas.length > 1;

  return (
    <View style={varias ? styles.compartido : styles.completo} pointerEvents="none">
      {repartirEnColumnas(pistas).map((columna, posicion) => (
        // La columna se identifica por su sitio y no por quién la ocupa: quien
        // emite está siempre en la primera, y así su imagen no se vuelve a
        // montar —no parpadea— cuando sube o baja alguien.
        <View key={posicion} style={styles.columna}>
          {columna.map((pista) => (
            <View key={pista.id} style={styles.recuadro}>
              {pista.silenciada ? (
                <View style={styles.sinCamara}>
                  <Avatar size={56} name={pista.nombre || '·'} />
                  <Feather name="video-off" size={16} color={sobreMedio.textMuted} />
                </View>
              ) : (
                <VistaDePista
                  pistaId={pista.id}
                  // Espejo solo en la cámara frontal PROPIA: a los demás se les
                  // ve como son, y la trasera no se refleja.
                  espejo={pista.local && camaraFrontal}
                  estilo={StyleSheet.absoluteFill}
                  // Con varias, la calidad de cada recuadro la elige el
                  // proveedor según su tamaño: pedir la más alta para cuatro
                  // imágenes pequeñas sería gastar datos en lo que no se ve.
                  capaAutomatica={varias || capaAutomatica}
                />
              )}
              {varias && pista.nombre ? (
                <View style={styles.etiqueta}>
                  <Text variant="caption" weight="700" color={sobreMedio.text} numberOfLines={1}>
                    {pista.nombre}
                  </Text>
                </View>
              ) : null}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  completo: { ...StyleSheet.absoluteFillObject, flexDirection: 'row' },
  compartido: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: ALTO_COMPARTIDO,
    flexDirection: 'row',
    // La línea entre recuadros es el fondo asomando.
    gap: 2,
    backgroundColor: sobreMedio.background,
  },
  columna: { flex: 1, gap: 2 },
  recuadro: { flex: 1, overflow: 'hidden', backgroundColor: sobreMedio.surface },
  sinCamara: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  etiqueta: {
    position: 'absolute',
    left: spacing.sm,
    bottom: spacing.sm,
    maxWidth: '86%',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    backgroundColor: sobreMedio.overlay,
  },
});
