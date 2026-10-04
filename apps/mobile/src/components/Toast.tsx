import React, { useCallback, useEffect, useRef } from 'react';
import { AccessibilityInfo, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { Avatar } from '@/components/Avatar';
import { Text } from '@/components/Text';
import type { TipoDeAviso } from '@/lib/colaDeAvisos';
import { haptics } from '@/lib/haptics';
import { DURACION, MUELLE_DE_PANEL, duracionDeSalida } from '@/lib/movimiento';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type ToastProps = {
  message: string;
  /** Una línea en negrita encima del mensaje. */
  titulo?: string;
  tipo?: TipoDeAviso;
  /** Lo que tarda en irse solo. Lo decide la cola según el tipo. */
  duration: number;
  onHide: () => void;
  icon?: keyof typeof Feather.glyphMap;
  avatarUrl?: string | null;
  /** Salida opcional: «Ver lista», «Deshacer». Sin ella el aviso es el de siempre. */
  accion?: {
    etiqueta: string;
    alPulsar: () => void;
  };
  /** Tocar el aviso entero: abrir aquello de lo que habla. */
  alTocar?: () => void;
};

/**
 * El icono de cada tipo. El tipo se distingue por la FORMA del icono, no por
 * un color: la aplicación es en blanco y negro y un rojo sobre negro no lo ve
 * quien no separa bien los colores.
 */
const ICONO_DEL_TIPO: Record<TipoDeAviso, keyof typeof Feather.glyphMap> = {
  exito: 'check',
  info: 'info',
  advertencia: 'alert-triangle',
  error: 'alert-circle',
  reversible: 'rotate-ccw',
  notificacion: 'bell',
};

/** Desde dónde entra, en puntos por encima de su sitio. */
const ENTRADA = -28;
/** Cuánto hay que arrastrarlo hacia arriba para que se vaya. */
const UMBRAL_DE_CIERRE = 28;

/**
 * El aviso transitorio: una pastilla que baja desde arriba, se queda lo justo
 * y se va.
 *
 * Es UNO para toda la aplicación —confirmaciones, errores de red, el aviso de
 * una notificación que llega con la aplicación abierta—, y solo se ve uno a la
 * vez: lo ordena `ToastHost` con `colaDeAvisos`.
 *
 * SE PUEDE QUITAR CON EL DEDO: arrastrarlo hacia arriba lo despide. Quien está
 * leyendo debajo no tiene por qué esperar a que se vaya solo.
 *
 * CON «REDUCIR MOVIMIENTO» aparece y desaparece en su sitio, sin recorrido.
 */
export function Toast({
  message,
  titulo,
  tipo = 'exito',
  duration,
  onHide,
  icon,
  avatarUrl,
  accion,
  alTocar,
}: ToastProps) {
  const { colors } = useAppTheme();
  const reducir = useReducedMotion();
  // Debajo de la barra de estado o de la muesca, esté donde esté.
  const arriba = useSafeAreaInsets().top + spacing.sm;

  const desplazamiento = useSharedValue(reducir ? 0 : ENTRADA);
  const opacidad = useSharedValue(0);
  const escala = useSharedValue(reducir ? 1 : 0.96);
  const arrastre = useSharedValue(0);
  const despedido = useRef(false);

  const icono = icon ?? ICONO_DEL_TIPO[tipo];

  /** Se va. Una sola vez: el reloj, el dedo y la acción pueden coincidir. */
  const despedir = useCallback(() => {
    if (despedido.current) return;
    despedido.current = true;
    const salida = reducir ? 0 : duracionDeSalida(DURACION.normal);
    desplazamiento.value = withTiming(reducir ? 0 : ENTRADA, { duration: salida });
    // SIEMPRE avisa de que se ha ido, termine la animacion o la corten: si no
    // avisara, este aviso —ya invisible— se quedaria en la cabeza de la cola y
    // no saldria ninguno mas.
    opacidad.value = withTiming(0, { duration: salida }, () => {
      runOnJS(onHide)();
    });
  }, [desplazamiento, opacidad, onHide, reducir]);

  useEffect(() => {
    // Quien no ve la pantalla también se entera, y una confirmación se nota
    // en la mano. Un error no vibra como un éxito.
    AccessibilityInfo.announceForAccessibility(titulo ? `${titulo}. ${message}` : message);
    if (tipo === 'exito' || tipo === 'reversible') haptics.success();
    else if (tipo === 'notificacion') haptics.light();

    opacidad.value = withTiming(1, { duration: reducir ? 0 : DURACION.breve });
    if (!reducir) {
      desplazamiento.value = withSpring(0, MUELLE_DE_PANEL);
      escala.value = withSpring(1, MUELLE_DE_PANEL);
    }

    const reloj = setTimeout(despedir, duration);
    return () => clearTimeout(reloj);
    // Solo al montar: cada aviso nuevo llega con otra `key` y es otro componente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const animado = useAnimatedStyle(() => ({
    opacity: opacidad.value,
    transform: [
      { translateY: desplazamiento.value + arrastre.value },
      { scale: escala.value },
    ],
  }));

  // Solo hacia arriba. Hacia abajo se resiste: no hay nada debajo a donde ir.
  const gesto = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .onUpdate((evento) => {
      arrastre.value = evento.translationY < 0 ? evento.translationY : evento.translationY * 0.15;
    })
    .onEnd((evento) => {
      if (evento.translationY < -UMBRAL_DE_CIERRE || evento.velocityY < -600) {
        runOnJS(despedir)();
      } else {
        arrastre.value = withSpring(0, MUELLE_DE_PANEL);
      }
    });

  const tocar = alTocar
    ? () => {
        alTocar();
        despedir();
      }
    : undefined;

  const cuerpo = (
    <>
      {avatarUrl ? (
        <Avatar size={34} image={avatarUrl} name={titulo} />
      ) : (
        <View style={[styles.circulo, { backgroundColor: colors.onPrimary }]}>
          <Feather name={icono} size={16} color={colors.primary} />
        </View>
      )}
      <View style={styles.textos}>
        {titulo ? (
          <Text numberOfLines={1} style={[styles.titulo, { color: colors.onPrimary }]}>
            {titulo}
          </Text>
        ) : null}
        <Text numberOfLines={titulo ? 2 : 3} style={[styles.message, { color: colors.onPrimary }]}>
          {message}
        </Text>
      </View>
    </>
  );

  return (
    <GestureDetector gesture={gesto}>
      <Animated.View
        accessibilityRole="alert"
        // El aviso ya se anuncia en voz alta al aparecer (ver el efecto). Con
        // una region viva ademas, Android lo leia dos veces.
        accessibilityLiveRegion="none"
        style={[
          styles.container,
          { top: arriba, backgroundColor: colors.primary, shadowColor: colors.glassShadow },
          animado,
        ]}
      >
        {tocar ? (
          <Pressable
            onPress={tocar}
            accessibilityRole="button"
            accessibilityLabel={titulo ? `${titulo}. ${message}` : message}
            style={styles.content}
          >
            {cuerpo}
          </Pressable>
        ) : (
          <View style={styles.content}>{cuerpo}</View>
        )}
        {/*
          La accion, cuando la hay. Al pulsarla se hace lo suyo y el aviso se
          va: dejarlo puesto despues de haber navegado lo convierte en un
          cartel encima de la pantalla nueva.

          Es una pastilla con su borde, no un texto subrayado: sobre el color
          primario se tiene que leer como algo que se pulsa.
        */}
        {accion ? (
          <Pressable
            onPress={() => {
              accion.alPulsar();
              despedir();
            }}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel={accion.etiqueta}
            style={({ pressed }: { pressed: boolean }) => [
              styles.accion,
              { borderColor: colors.onPrimary, opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <Text style={[styles.etiquetaDeAccion, { color: colors.onPrimary }]}>
              {accion.etiqueta}
            </Text>
          </Pressable>
        ) : null}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    zIndex: 9999,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.lg,
    paddingVertical: spacing.sm + 2,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    elevation: 8,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 14,
    // En navegador no puede salirse del ancho de un teléfono.
    ...(Platform.OS === 'web' ? { maxWidth: 520, alignSelf: 'center' as const } : null),
  },
  content: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 36,
  },
  circulo: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textos: {
    flex: 1,
  },
  titulo: {
    fontSize: 13,
    fontWeight: '800',
    marginBottom: 1,
  },
  message: {
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
  accion: {
    marginLeft: spacing.sm,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  etiquetaDeAccion: {
    fontSize: 12,
    fontWeight: '800',
  },
});
