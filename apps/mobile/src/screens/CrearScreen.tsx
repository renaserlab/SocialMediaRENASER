import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppHeader } from '@/components/AppHeader';
import { espacioParaLaBarra } from '@/components/FloatingGlassTabBar';
import { StateView } from '@/components/StateView';
import { ModoHistoria } from '@/components/crear/ModoHistoria';
import { ModoPublicacion } from '@/components/crear/ModoPublicacion';
import { ModoReel } from '@/components/crear/ModoReel';
import { ModoVivo } from '@/components/crear/ModoVivo';
import {
  MODOS,
  SelectorDeModo,
  posicionDeModo,
  type ModoDeCreacion,
} from '@/components/crear/SelectorDeModo';
import { useGestoDeSeccion } from '@/navigation/tabSwipe';
import { useAuthStore } from '@/store/useAuthStore';
import { palette } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const media = palette('dark');

/** Cuanto hay que arrastrar para pasar al modo de al lado. */
const UMBRAL_PX = 60;
/** Un golpe corto pero rapido tambien cuenta. */
const UMBRAL_VELOCIDAD = 450;

/**
 * Crear: publicacion, historia, reel o vivo.
 *
 * COMO SE CAMBIA DE MODO. Arrastrando en horizontal o tocando la etiqueta, que
 * es lo que pedia el documento. Lo que se mueve mientras el dedo va es la FILA
 * de nombres, no la camara: recrear cuatro pantallas —dos de ellas con una
 * sesion de captura viva— para arrastrarlas de lado seria caro, lento y en la
 * practica imposible (no se pueden tener dos camaras abiertas a la vez). Es
 * tambien como se comporta la aplicacion de referencia: el visor se queda
 * quieto y lo que corre es el selector.
 *
 * POR QUE EL GESTO NO SE ESCAPA A OTRA SECCION. Dentro de las pestanas, el
 * arrastre horizontal pertenece al carrusel de secciones. Aqui se declara un
 * gesto propio que lo BLOQUEA (`blocksExternalGesture`), asi que mientras se
 * esta en Crear el dedo cambia de modo y no de seccion. Es la misma regla que
 * ya protegia al carrusel de historias y a la barra de avance del video, solo
 * que con un gesto propio en vez del contrato generico.
 */
export function CrearScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useAppTheme();

  /*
    Si esta pantalla es la que se esta viendo. El carrusel de secciones
    mantiene montadas las vecinas para que aparezcan al instante, y una camara
    montada consume igual aunque nadie la mire.
  */
  const enfocada = useIsFocused();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const signedIn = useAuthStore((state) => state.status === 'authenticated');

  const [modo, setModo] = useState<ModoDeCreacion>('publicacion');
  /** Avance del arrastre en huecos (-1..1). Lo lee la fila de nombres. */
  const arrastre = useSharedValue(0);

  const gestoDeSeccion = useGestoDeSeccion();

  const irA = useCallback((siguiente: ModoDeCreacion) => setModo(siguiente), []);

  const cambiarPorGesto = useCallback((direccion: 1 | -1) => {
    setModo((actual) => {
      const destino = posicionDeModo(actual) + direccion;
      if (destino < 0 || destino >= MODOS.length) return actual;
      return MODOS[destino]!.id;
    });
  }, []);

  const gesto = useMemo(() => {
    let pan = Gesture.Pan()
      /*
        Margenes antes de decidir. Sin el vertical, un desplazamiento de lectura
        con la mas minima desviacion lateral cambiaria de modo.
      */
      .activeOffsetX([-20, 20])
      .failOffsetY([-18, 18])
      .onUpdate((evento) => {
        const posicion = -evento.translationX / 116;
        // Resistencia en los extremos: se nota que responde, y se entiende
        // enseguida que por ahi se acaba el camino.
        arrastre.value = Math.max(-1, Math.min(1, posicion));
      })
      .onEnd((evento) => {
        const pasa =
          Math.abs(evento.translationX) > UMBRAL_PX ||
          Math.abs(evento.velocityX) > UMBRAL_VELOCIDAD;
        if (pasa) {
          runOnJS(cambiarPorGesto)(evento.translationX < 0 ? 1 : -1);
        }
        arrastre.value = withTiming(0, { duration: 160 });
      })
      .onFinalize(() => {
        arrastre.value = withTiming(0, { duration: 160 });
      });

    /*
      Prioridad sobre el carrusel de secciones. Sin esto, arrastrar aqui se iria
      a Mensajes o a Explorar en vez de cambiar de tipo de publicacion.
    */
    if (gestoDeSeccion) pan = pan.blocksExternalGesture(gestoDeSeccion);
    return pan;
  }, [arrastre, cambiarPorGesto, gestoDeSeccion]);

  const espacioInferior = espacioParaLaBarra(insets.bottom);
  const salir = useCallback(() => router.navigate('/(tabs)/home'), [router]);

  const selector = <SelectorDeModo activo={modo} alCambiar={irA} arrastre={arrastre} />;

  /*
    Publicar es la accion que mas claramente necesita cuenta: lo que se
    comparte queda firmado. Se explica en la propia pantalla en vez de saltar
    un dialogo encima, que interrumpe sin decir donde se ha entrado.
  */
  if (supabaseEnabled && !signedIn) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="CREAR" />
        <StateView
          state="empty"
          icon="edit-3"
          title="Crea tu cuenta para publicar"
          description="Puedes seguir explorando sin cuenta. Para compartir algo, necesitamos saber quién eres."
          actionLabel="Crear cuenta"
          onAction={() => router.push('/register' as never)}
        />
      </View>
    );
  }

  return (
    <GestureDetector gesture={gesto}>
      <View
        style={[
          styles.raiz,
          // Los modos con camara son a pantalla completa y siempre oscuros; el
          // editor de texto sigue el tema de la aplicacion.
          { backgroundColor: modo === 'publicacion' ? colors.background : media.background },
        ]}
      >
        {modo === 'publicacion' ? (
          <React.Fragment>
            <AppHeader title="CREAR" />
            <ModoPublicacion pie={selector} alSalir={salir} espacioInferior={espacioInferior} />
          </React.Fragment>
        ) : modo === 'historia' ? (
          <ModoHistoria pie={selector} alSalir={salir} activo={enfocada} />
        ) : modo === 'reel' ? (
          <ModoReel pie={selector} alSalir={salir} activo={enfocada} />
        ) : (
          <ModoVivo
            pie={selector}
            espacioInferior={espacioInferior}
            alGrabarReel={() => irA('reel')}
          />
        )}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  raiz: { flex: 1 },
});
