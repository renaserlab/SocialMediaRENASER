import React, { useEffect, useRef, useState } from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { SaltoBreve } from '@/components/movimientoBreve';
import { Text } from '@/components/Text';
import { saltoDelGlobo } from '@/lib/movimiento';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  /** Cuántos hay sin leer. Con cero no se pinta nada. */
  cuenta: number;
  /** Diámetro. 20 en una fila de lista; 16 sobre un icono de la barra. */
  tamano?: number;
  /**
   * Sin número: solo el punto. Para donde no cabe una cifra o donde lo que
   * importa es «hay algo», no cuánto.
   */
  soloPunto?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** Más de 99 no cabe y tampoco aporta: lo que importa es «muchos». */
export function textoDelGlobo(cuenta: number): string {
  return cuenta > 99 ? '99+' : String(cuenta);
}

/**
 * El globo de «sin leer»: el de las conversaciones, el de la barra inferior y
 * el de la campana.
 *
 * Eran tres dibujos distintos del mismo dato. Aquí es uno, y AVISA cuando
 * cambia: aparece creciendo desde su centro y, si la cuenta sube estando ya en
 * pantalla, da un pequeño salto. Un número que cambia sin moverse no se ve
 * con el rabillo del ojo, que es justo como se mira una barra de navegación.
 *
 * No lleva `accessibilityLabel` propio: quien lo pinta ya anuncia la cuenta en
 * la etiqueta del botón o de la fila, y decirlo dos veces sería ruido.
 */
export function GloboDeNoLeidos({ cuenta, tamano = 20, soloPunto = false, style }: Props) {
  const { colors } = useAppTheme();
  const reducir = useReducedMotion();
  const anterior = useRef(cuenta);
  const veces = useRef(0);
  /** El salto en curso. `null` en reposo, que es casi siempre. */
  const [salto, setSalto] = useState<{ tipo: 'aparece' | 'crece'; n: number } | null>(null);

  useEffect(() => {
    const antes = anterior.current;
    anterior.current = cuenta;
    const tipo = saltoDelGlobo(antes, cuenta);
    if (!tipo || reducir) return;
    veces.current += 1;
    setSalto({ tipo, n: veces.current });
  }, [cuenta, reducir]);

  if (cuenta <= 0) return null;

  const lado = soloPunto ? Math.round(tamano / 2) : tamano;
  const estilo = [
    styles.globo,
    {
      minWidth: lado,
      height: lado,
      borderRadius: lado / 2,
      backgroundColor: colors.primary,
      paddingHorizontal: soloPunto ? 0 : 5,
    },
    style,
  ];
  const cifra = soloPunto ? null : (
    <Text
      variant="caption"
      weight="700"
      color={colors.onPrimary}
      style={{ fontSize: Math.max(9, Math.round(tamano * 0.5)), fontVariant: ['tabular-nums'] }}
    >
      {textoDelGlobo(cuenta)}
    </Text>
  );

  // EN REPOSO, UNA VISTA NORMAL: hay un globo por conversación de la bandeja.
  if (!salto) {
    return (
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={estilo}
      >
        {cifra}
      </View>
    );
  }

  const { n } = salto;
  return (
    <SaltoBreve
      key={n}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      // Lo que aparece llega desde pequeño; lo que ya estaba, da un bote.
      desde={salto.tipo === 'aparece' ? 0.4 : 1}
      pico={salto.tipo === 'aparece' ? 1.12 : 1.25}
      style={estilo}
      alTerminar={() => setSalto((actual) => (actual && actual.n === n ? null : actual))}
    >
      {cifra}
    </SaltoBreve>
  );
}

const styles = StyleSheet.create({
  globo: { alignItems: 'center', justifyContent: 'center' },
});
