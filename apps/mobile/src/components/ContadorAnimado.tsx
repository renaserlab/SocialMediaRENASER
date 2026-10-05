import React, { useLayoutEffect, useRef, useState } from 'react';
import { StyleProp, TextStyle, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { EntradaBreve } from '@/components/movimientoBreve';
import { Text } from '@/components/Text';
import { DURACION, sentidoDelCambio } from '@/lib/movimiento';

type Props = {
  valor: number;
  /** De qué elemento es el número, en las listas que reciclan celdas. */
  clave?: string;
  style?: StyleProp<TextStyle>;
  color?: string;
  variant?: React.ComponentProps<typeof Text>['variant'];
  weight?: React.ComponentProps<typeof Text>['weight'];
};

/** Cuánto recorre el número al cambiar. Poco: es un contador, no un marcador. */
const RECORRIDO = 6;

/**
 * Un número que cambia sin saltar.
 *
 * Cuando sube, el nuevo valor entra desde abajo; cuando baja, desde arriba. El
 * sentido del movimiento dice si se ha sumado o restado antes de leer la cifra.
 *
 * Las cifras son de ancho fijo (`tabular-nums`): pasar de 9 a 10 o de 1 a 2 no
 * mueve de sitio lo que hay al lado.
 *
 * NO ANIMA AL MONTARSE, ni con «reducir movimiento»: el número cambia y ya.
 */
export function ContadorAnimado({ valor, clave, style, color, variant, weight }: Props) {
  const reducir = useReducedMotion();
  const anterior = useRef({ valor, clave });
  const veces = useRef(0);
  /** La cifra que está entrando. `null` en reposo, que es casi siempre. */
  const [entrada, setEntrada] = useState<{ sentido: 1 | -1; n: number } | null>(null);

  /*
    ANTES DE PINTAR, no después: decidido en un efecto normal, el cambio se
    veía un fotograma ya en su sitio y luego daba el salto desde atrás.
  */
  useLayoutEffect(() => {
    const antes = anterior.current;
    anterior.current = { valor, clave };
    const sentido = sentidoDelCambio(antes, { valor, clave });
    if (sentido === 0) {
      // La celda pasó a otro elemento: una entrada a medias era del anterior.
      if (antes.clave !== clave) setEntrada(null);
      return;
    }
    if (reducir) return;
    veces.current += 1;
    setEntrada({ sentido, n: veces.current });
  }, [valor, clave, reducir]);

  const cifra = (
    <Text
      variant={variant}
      weight={weight}
      color={color}
      style={[{ fontVariant: ['tabular-nums'] }, style]}
    >
      {valor}
    </Text>
  );

  // EN REPOSO, UNA VISTA NORMAL: hay un contador por acción de cada publicación.
  if (!entrada) return <View>{cifra}</View>;

  const { n } = entrada;
  return (
    <EntradaBreve
      key={n}
      desde={entrada.sentido * RECORRIDO}
      duracion={DURACION.breve}
      alTerminar={() => setEntrada((actual) => (actual && actual.n === n ? null : actual))}
    >
      {cifra}
    </EntradaBreve>
  );
}
