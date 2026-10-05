import React, { useLayoutEffect, useRef, useState } from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { SaltoBreve } from '@/components/movimientoBreve';
import { ESCALA_AL_ENCENDER, daElSalto } from '@/lib/movimiento';

type Props = {
  /** El estado: gustado, guardado, republicado. */
  activo: boolean;
  /**
   * El servidor todavía no ha confirmado. El icono YA muestra lo que se pidió,
   * un poco atenuado; al confirmarse recupera toda su tinta. Así se ve que el
   * toque se ha recibido y también cuándo ha quedado hecho.
   */
  pendiente?: boolean;
  /**
   * De qué elemento es este icono, en las listas que reciclan celdas. Al
   * cambiar de elemento el estado nuevo se pinta SIN saltar: que la celda pase
   * a una publicación ya gustada no es que alguien acabe de reaccionar.
   */
  clave?: string;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

/**
 * Un icono de estado que SALTA al encenderse.
 *
 * Al pasar a encendido sube un poco y vuelve con un muelle; al apagarse se
 * encoge un instante. Es la respuesta al toque en el corazón, el marcador y
 * las flechas de republicar: el dibujo cambia de forma (relleno o contorno) y
 * este salto es lo que hace que ese cambio se note.
 *
 * NO ANIMA AL MONTARSE. Una lista de publicaciones ya gustadas no puede
 * aparecer con veinte corazones saltando.
 *
 * CON «REDUCIR MOVIMIENTO» no salta: el cambio de dibujo sigue diciéndolo.
 */
export function IconoQueSeEnciende({ activo, pendiente = false, clave, children, style }: Props) {
  /*
    EN REPOSO ES UNA VISTA NORMAL. La vista animada se monta solo mientras dura
    el salto: hay cinco de estos en cada publicación, y tenerlos siempre
    animados era parte de lo que frenaba las listas (`lib/movimiento.ts`).
  */
  const reducir = useReducedMotion();
  const anterior = useRef({ activo, clave });
  const veces = useRef(0);
  /** El salto en curso. `null` en reposo, que es casi siempre. */
  const [salto, setSalto] = useState<{ pico: number; n: number } | null>(null);

  /*
    ANTES DE PINTAR, no después: decidido en un efecto normal, el cambio se
    veía un fotograma ya en su sitio y luego daba el salto desde atrás.
  */
  useLayoutEffect(() => {
    const antes = anterior.current;
    anterior.current = { activo, clave };
    if (!daElSalto(antes, { activo, clave })) {
      // La celda pasó a otro elemento: un salto a medias era del anterior.
      if (antes.clave !== clave) setSalto(null);
      return;
    }
    if (reducir) return;
    veces.current += 1;
    setSalto({ pico: activo ? ESCALA_AL_ENCENDER : 0.86, n: veces.current });
  }, [activo, clave, reducir]);

  const estilo = pendiente ? [style, styles.pendiente] : style;
  if (!salto) return <View style={estilo}>{children}</View>;

  const { n } = salto;
  return (
    <SaltoBreve
      key={n}
      pico={salto.pico}
      style={estilo}
      // Solo lo apaga su propio salto: uno nuevo ya empezó con otra cuenta.
      alTerminar={() => setSalto((actual) => (actual && actual.n === n ? null : actual))}
    >
      {children}
    </SaltoBreve>
  );
}

const styles = StyleSheet.create({
  // Mientras el servidor no confirma, el icono va a media tinta.
  pendiente: { opacity: 0.55 },
});
