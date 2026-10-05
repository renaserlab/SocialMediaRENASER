import React, { useRef } from 'react';
import { StyleProp, View, ViewStyle } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { EntradaBreve } from '@/components/movimientoBreve';
import {
  DESPLAZAMIENTO_DE_ENTRADA,
  DURACION,
  modoDeEntrada,
  type ModoDeEntrada,
} from '@/lib/movimiento';

type Props = {
  children: React.ReactNode;
  /** Milisegundos antes de empezar: para entrar en cascada (`retrasoEnCascada`). */
  retraso?: number;
  /** Desde cuántos puntos por debajo sube. 0 para que solo aparezca. */
  desde?: number;
  /**
   * Ya está en su sitio: no entra. Sirve para animar solo ALGUNOS elementos de
   * una lista —el mensaje que se acaba de enviar, no el historial— sin cambiar
   * de componente, que remontaría la fila al pasar de uno a otro.
   */
  inmediato?: boolean;
  /**
   * De qué elemento es esta entrada. Hace falta en las listas que RECICLAN
   * celdas (FlashList): ahí el componente no se vuelve a montar al pasar a
   * otro elemento, solo cambia de datos, y sin esto la entrada no se repetiría
   * nunca —o se quedaría a medias de la del elemento anterior—. Fuera de una
   * lista así no hace falta.
   */
  clave?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * Algo que entra: aparece y sube unos puntos hasta su sitio. Una vez por
 * elemento.
 *
 * Es la entrada de los estados vacíos, de las tarjetas que llegan y de los
 * mensajes nuevos. Solo anima opacidad y traslación, que no obligan a
 * recalcular la disposición.
 *
 * LO QUE NO ENTRA ES UNA VISTA NORMAL. Con `inmediato` —el historial de un
 * chat, que son casi todas las filas— no se monta nada animado. Antes cada
 * fila llevaba su vista animada aunque no fuera a moverse nunca.
 *
 * CON «REDUCIR MOVIMIENTO» el contenido está en su sitio desde el primer
 * fotograma: no se pierde nada, solo no se mueve.
 */
export function Aparecer({
  children,
  retraso = 0,
  desde = DESPLAZAMIENTO_DE_ENTRADA,
  inmediato = false,
  clave,
  style,
}: Props) {
  const reducir = useReducedMotion();
  /*
    Si este elemento se monta animado o no. Vive en una referencia porque no
    tiene que repintar nada: se decide al pintar, y decidir dos veces con lo
    mismo da lo mismo.
  */
  const modo = useRef<ModoDeEntrada | null>(null);
  const quieta = reducir || inmediato;
  modo.current = modoDeEntrada(modo.current, clave, quieta);

  if (!modo.current.animada) return <View style={style}>{children}</View>;

  return (
    <EntradaBreve
      clave={clave}
      quieta={quieta}
      desde={desde}
      retraso={retraso}
      duracion={DURACION.normal}
      style={style}
    >
      {children}
    </EntradaBreve>
  );
}
