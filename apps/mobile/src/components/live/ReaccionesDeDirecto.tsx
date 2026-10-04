import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { sobreMedio } from '@/components/CapaDeContraste';
import { Pulsable } from '@/components/Pulsable';
import { Text } from '@/components/Text';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { haptics } from '@/lib/haptics';
import {
  CARRILES,
  crearPistaDeBurbujas,
  type Burbuja,
  type PistaDeBurbujas,
} from '@/live/burbujas';
import { conciliarConElServidor, sumarReacciones } from '@/live/reaccionesEnVivo';
import {
  REACCIONES,
  type ConteoDeReacciones,
  type TipoDeReaccion,
} from '@/repositories/LiveRepository';
import { canalDeReacciones, type CanalDeReacciones } from '@/services/directoEnVivo';
import { radius, spacing } from '@/theme/tokens';

/**
 * Las reacciones de una emision: los cinco botones, sus contadores y las
 * burbujas que suben.
 *
 * VIVE EN SU PROPIO COMPONENTE. Antes las burbujas y los totales eran estado
 * de la pantalla del directo, y cada corazon —propio o ajeno— volvia a pintar
 * la pantalla entera: el video, el chat, los controles. Ahora lo que pasa aqui
 * se queda aqui.
 *
 * LAS REGLAS NO ESTAN EN ESTE FICHERO:
 *
 *   - que viaja, por que topico y cuando (`live/reaccionesEnVivo.ts`);
 *   - cuantas burbujas se pintan y cada cuanto (`live/burbujas.ts`).
 *
 * Aqui solo se conectan las dos cosas con React.
 */

/**
 * El simbolo de cada reaccion.
 *
 * Son emoji y no iconos de Feather porque el juego de iconos no tiene aplauso,
 * ni fuego, ni risa: habria que representarlos con otra cosa que no significa
 * lo mismo, y una reaccion que no se reconoce de un vistazo no sirve de nada.
 * Cada clave es exactamente uno de los valores que acepta el servidor.
 */
const SIMBOLO_DE_REACCION: Record<TipoDeReaccion, string> = {
  corazon: '❤️',
  aplauso: '👏',
  fuego: '🔥',
  asombro: '😮',
  risa: '😂',
};

/** Como se lee cada reaccion en voz alta. Claves, no textos. */
const NOMBRE_DE_REACCION: Record<TipoDeReaccion, TranslationKey> = {
  corazon: 'live.reactionHeart',
  aplauso: 'live.reactionClap',
  fuego: 'live.reactionFire',
  asombro: 'live.reactionWow',
  risa: 'live.reactionLaugh',
};

/** Lo que tarda una burbuja en subir y desaparecer. */
const DURACION_DE_BURBUJA_MS = 1_400;

/** Cuanto sube, en puntos. */
const ALTURA_DE_BURBUJA = 220;

/** El ancho de la franja por la que suben, repartido en carriles. */
const ANCHO_DE_LA_PISTA = 150;

/* ------------------------------------------------------------- Burbuja ---- */

/**
 * Una reaccion que sube y se apaga.
 *
 * Se monta y se borra sola: la pista solo la mete en la lista. El aviso de que
 * ya termino va por `setTimeout` y no por la animacion, porque lo unico que
 * hace falta es saber CUANDO quitarla del arbol, y para eso el reloj de
 * JavaScript basta y no arrastra ninguna sutileza de hilos.
 *
 * MEMORIZADA: la lista cambia cada vez que entra o sale una burbuja, y las que
 * ya estan volando no tienen nada nuevo que pintar.
 */
const BurbujaDeReaccion = React.memo(function BurbujaDeReaccion({
  clave,
  tipo,
  carril,
  reduceMotion,
  alTerminar,
}: {
  clave: number;
  tipo: TipoDeReaccion;
  carril: number;
  reduceMotion: boolean;
  alTerminar: (clave: number) => void;
}) {
  const avance = useSharedValue(0);
  const duracion = reduceMotion ? 500 : DURACION_DE_BURBUJA_MS;
  // Con "reducir movimiento" activo la reaccion aparece y se apaga sin viajar:
  // sigue confirmando el toque, que es para lo que esta.
  const subida = reduceMotion ? 0 : ALTURA_DE_BURBUJA;

  useEffect(() => {
    avance.value = withTiming(1, { duration: duracion });
    const corte = setTimeout(() => alTerminar(clave), duracion);
    return () => clearTimeout(corte);
    // Solo al montar: cada burbuja vive una vez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const estilo = useAnimatedStyle(() => ({
    opacity: 1 - avance.value,
    transform: [
      { translateY: -avance.value * subida },
      { scale: 0.85 + avance.value * 0.35 },
    ],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[estilos.burbuja, { left: (carril / CARRILES) * ANCHO_DE_LA_PISTA }, estilo]}
    >
      <Text style={estilos.simboloGrande}>{SIMBOLO_DE_REACCION[tipo]}</Text>
    </Animated.View>
  );
});

/* ---------------------------------------------------------- Componente ---- */

type Props = {
  emisionId: string;
  /** La emision esta en directo. Fuera de directo no hay canal ni botones. */
  abierto: boolean;
  /**
   * Los totales de la ficha del servidor. CADA VEZ QUE CAMBIA EL OBJETO —es
   * decir, cada vez que se recarga la emision— sustituye al contador entero:
   * lo persistido es la fuente de verdad.
   */
  totalesDelServidor: ConteoDeReacciones;
  reduceMotion: boolean;
};

export function ReaccionesDeDirecto({ emisionId, abierto, totalesDelServidor, reduceMotion }: Props) {
  const { t } = useTranslation();
  const [totales, setTotales] = useState<ConteoDeReacciones>(totalesDelServidor);
  const [burbujas, setBurbujas] = useState<readonly Burbuja<TipoDeReaccion>[]>([]);

  const canal = useRef<CanalDeReacciones | null>(null);
  const pista = useRef<PistaDeBurbujas<TipoDeReaccion> | null>(null);

  // Recargar la emision manda sobre lo que se llevaba contado en pantalla.
  useEffect(() => {
    setTotales(totalesDelServidor);
  }, [totalesDelServidor]);

  /* ---- La pista de burbujas: una por pantalla, y se destruye al salir. ---- */
  useEffect(() => {
    const nueva = crearPistaDeBurbujas<TipoDeReaccion>({
      programar: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      },
      alCambiar: setBurbujas,
      // Lo ajeno llega ya agrupado: UN cambio de estado por tic, no uno por
      // reaccion.
      alSumar: (conteos) => setTotales((previos) => sumarReacciones(previos, conteos)),
    });
    pista.current = nueva;
    return () => {
      nueva.destruir();
      pista.current = null;
      setBurbujas([]);
    };
  }, [emisionId]);

  /* ---- El canal: uno por emision, solo en directo. ---- */
  useEffect(() => {
    // Fuera de directo el servidor cierra las reacciones (409
    // `live_reactions_closed`): no se abre un canal para que nadie lo use.
    if (!emisionId || !abierto) return;

    const abiertoAhora = canalDeReacciones(emisionId, (delServidor) => {
      // Lo que dice el servidor tras un resumen ya incluye lo que se conto
      // aqui: se toma el mayor, nunca se suma.
      setTotales((previos) => conciliarConElServidor(previos, delServidor));
    });
    canal.current = abiertoAhora;
    const dejarDeEscuchar = abiertoAhora.alRecibir((conteos) => {
      pista.current?.recibir(conteos);
    });

    return () => {
      dejarDeEscuchar();
      // Idempotente: cerrar dos veces no hace nada la segunda.
      abiertoAhora.cerrar();
      if (canal.current === abiertoAhora) canal.current = null;
    };
  }, [emisionId, abierto]);

  const reaccionar = useCallback((tipo: TipoDeReaccion) => {
    /*
      LA ANIMACION NO ESPERA AL SERVIDOR. Va primero, en el mismo gesto: es lo
      que hace que el boton se sienta conectado. Lo que viaja despues —el
      Broadcast a quien mira, el resumen al backend— puede tardar o fallar sin
      que se note aqui. Y como el canal no devuelve lo propio (`self: false`),
      esta es la UNICA vez que esta reaccion se pinta y se cuenta aqui.
    */
    pista.current?.soltarPropia(tipo);
    haptics.light();
    setTotales((previos) => sumarReacciones(previos, { [tipo]: 1 }));
    canal.current?.enviar(tipo);
  }, []);

  const quitar = useCallback((clave: number) => {
    pista.current?.quitar(clave);
  }, []);

  if (!abierto) return null;

  return (
    <View style={estilos.bloque}>
      {/* Las burbujas vuelan por encima, sin robarle el dedo a nada. */}
      <View
        pointerEvents="none"
        style={estilos.pista}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {burbujas.map((burbuja) => (
          <BurbujaDeReaccion
            key={burbuja.clave}
            clave={burbuja.clave}
            tipo={burbuja.tipo}
            carril={burbuja.carril}
            reduceMotion={reduceMotion}
            alTerminar={quitar}
          />
        ))}
      </View>

      <View style={estilos.fila}>
        {REACCIONES.map((tipo) => (
          <Pulsable
            key={tipo}
            onPress={() => reaccionar(tipo)}
            accessibilityRole="button"
            accessibilityLabel={t('live.reactWith', { reaccion: t(NOMBRE_DE_REACCION[tipo]) })}
            accessibilityValue={{ text: String(totales[tipo]) }}
            style={[estilos.boton, { borderColor: sobreMedio.border }]}
          >
            <Text style={estilos.simbolo}>{SIMBOLO_DE_REACCION[tipo]}</Text>
            {totales[tipo] > 0 ? (
              <Text variant="caption" weight="700" color={sobreMedio.text}>
                {totales[tipo]}
              </Text>
            ) : null}
          </Pulsable>
        ))}
      </View>
    </View>
  );
}

const estilos = StyleSheet.create({
  bloque: { marginTop: spacing.xs },
  pista: {
    position: 'absolute',
    right: 0,
    bottom: '100%',
    width: ANCHO_DE_LA_PISTA,
    height: ALTURA_DE_BURBUJA + 60,
  },
  burbuja: { position: 'absolute', bottom: 0 },
  simbolo: { fontSize: 20 },
  simboloGrande: { fontSize: 30 },
  fila: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.xs,
    paddingBottom: spacing.sm,
  },
  boton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minHeight: 44,
    // Velo Y borde: sobre la imagen manda el velo; sin imagen, el borde.
    borderWidth: 1,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
});
