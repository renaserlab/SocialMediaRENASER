import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GloboDeNoLeidos } from '@/components/GloboDeNoLeidos';
import { Pulsable } from '@/components/Pulsable';
import { useTranslation } from '@/i18n/useTranslation';
import { ESCALA_AL_PULSAR } from '@/lib/movimiento';
import { SECCIONES } from '@/navigation/secciones';
import type { PropsDeBarra } from '@/navigation/SwipeTabs';
import { useAppStore } from '@/store/useAppStore';
import { useContadoresStore } from '@/store/useContadoresStore';
import { getFontFamily, motion, radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Barra de pestañas flotante con acabado de vidrio (acrilico translucido).
 *
 * Sustituye a la barra pegada al borde por una capsula flotante al estilo de
 * las interfaces modernas de iPhone. El contenido pasa por debajo, y eso es lo
 * que crea el efecto: en iOS y web con desenfoque real (BlurView), y en
 * Android con una superficie casi opaca con borde y sombra que se lee igual
 * de "vidrio" SIN pagar el coste del blur — el desenfoque en Android redibuja
 * la textura en cada fotograma de scroll y eso son FPS que este proyecto ya
 * no esta dispuesto a perder (rendimiento > adorno).
 *
 * Solo pinta las cinco secciones principales; las demas rutas del grupo
 * (perfil ajeno, circulos, audio, seguidores) siguen viviendo dentro del
 * navegador pero no aparecen aqui, igual que antes.
 *
 * El orden y los iconos ya no se declaran aqui: vienen de
 * `navigation/secciones.ts`, que es tambien lo que decide la posicion de cada
 * pantalla en el carrusel. Con dos listas separadas bastaba con anadir una
 * seccion en un sitio y no en el otro para que la barra senalara una pestana y
 * el dedo llevara a otra.
 */

const BAR_HEIGHT = 62;

/**
 * Cuanto ocupa la barra flotante contando desde el borde inferior.
 *
 * Lo necesita cualquier pantalla a pantalla completa —el Inicio de video, la
 * camara— para no colocar sus controles justo debajo de la capsula. Se calcula
 * aqui, junto a la barra, para que mover la barra no obligue a acordarse de
 * corregir un numero suelto en otro archivo.
 */
export function espacioParaLaBarra(insetInferior: number): number {
  return Math.max(insetInferior, spacing.sm) + spacing.sm + BAR_HEIGHT;
}

/** Capsula animada tras el icono activo. */
function ActivePill({ focused, color }: { focused: boolean; color: string }) {
  const progreso = useRef(new Animated.Value(focused ? 1 : 0)).current;
  useEffect(() => {
    // 180 ms: dentro del rango 150-250 que se percibe como respuesta, no como
    // animacion. Native driver: no toca el hilo de JavaScript.
    Animated.timing(progreso, {
      toValue: focused ? 1 : 0,
      duration: motion.fast,
      useNativeDriver: true,
    }).start();
  }, [focused, progreso]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.pill,
        {
          backgroundColor: color,
          opacity: progreso,
          transform: [
            { scale: progreso.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) },
          ],
        },
      ]}
    />
  );
}

export function FloatingGlassTabBar({ state, descriptors, navigation }: PropsDeBarra) {
  const insets = useSafeAreaInsets();
  const { colors, mode } = useAppTheme();

  /*
    Mensajes sin leer para el globo de la pestaña. Se leen del estado global
    con un selector primitivo: la barra solo se redibuja si el NUMERO cambia.
  */
  /*
    EL GLOBO DE MENSAJES ESTABA MUERTO. Sumaba las conversaciones del almacen,
    que con servidor nace vacio y nadie rellenaba: llegaba un mensaje y aqui no
    se movia nada. Ahora lee el contador comun (`useContadoresStore`), que se
    actualiza con el mensaje que llega en vivo, con el push y al abrir la
    bandeja. Las conversaciones del almacen siguen contando en la demo sin
    servidor, que es donde unicamente tienen algo.
  */
  const { t } = useTranslation();
  const enVivo = useContadoresStore((s) => s.mensajes);
  const deLaDemo = useAppStore((s) =>
    s.conversations.reduce((total, c) => total + (c.unread ?? 0), 0),
  );
  const unread = Math.max(enVivo, deLaDemo);

  /*
    Los botones salen de la lista de secciones, no del orden en que el navegador
    tenga las rutas: asi la barra y el carrusel no pueden discrepar nunca.
  */
  const botones = useMemo(() => {
    const lista: Array<{
      ruta: (typeof state.routes)[number];
      icono: keyof typeof Feather.glyphMap;
    }> = [];
    for (const seccion of SECCIONES) {
      const ruta = state.routes.find((r) => r.name === seccion.nombre);
      if (ruta) lista.push({ ruta, icono: seccion.icono });
    }
    return lista;
  }, [state.routes]);

  /*
    El desenfoque real solo donde no cuesta rendimiento. En Android el respaldo
    es una superficie translucida fuerte: mismo lenguaje visual, cero coste.
  */
  const conBlur = Platform.OS !== 'android';

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.host,
        {
          // Respeta el gesto/home indicator: la capsula flota POR ENCIMA de la
          // zona segura, nunca debajo de ella.
          bottom: Math.max(insets.bottom, spacing.sm) + spacing.sm,
        },
      ]}
    >
      {/* La sombra vive en el envoltorio: iOS ignora sombras cuando el mismo
          nodo recorta con overflow hidden (que el blur necesita). */}
      <View
        style={[
          styles.shadowWrap,
          {
            shadowColor: colors.glassShadow,
            ...(Platform.OS === 'android' ? { elevation: 10 } : null),
          },
        ]}
      >
        <View
          style={[
            styles.bar,
            {
              borderColor: colors.glassBorder,
              backgroundColor: conBlur ? colors.glassSurface : colors.glassSurfaceStrong,
            },
          ]}
        >
          {conBlur ? (
            <BlurView
              intensity={28}
              tint={mode === 'dark' ? 'dark' : 'light'}
              style={StyleSheet.absoluteFill}
            />
          ) : null}

          {botones.map(({ ruta: route, icono }) => {
            const focused = state.routes[state.index]?.key === route.key;
            const opciones = descriptors[route.key]?.options;
            const etiqueta =
              typeof opciones?.title === 'string' ? opciones.title : route.name;
            const color = focused ? colors.primary : colors.textMuted;
            const globo = route.name === 'messages' && unread > 0;

            const onPress = () => {
              const evento = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!focused && !evento.defaultPrevented) {
                navigation.navigate(route.name, route.params);
              }
            };

            return (
              <Pulsable
                key={route.key}
                onPress={onPress}
                // Se hunde bajo el dedo y da un toque en la mano: cambiar de
                // sección es de lo poco que merece vibrar. La cápsula, el
                // orden y las etiquetas no cambian.
                escala={ESCALA_AL_PULSAR.chip}
                atenuar={0.8}
                haptica="ligera"
                style={styles.item}
                accessibilityRole="tab"
                accessibilityState={{ selected: focused }}
                accessibilityLabel={
                  globo ? `${etiqueta}. ${t('notif.unreadTab', { cuenta: unread })}` : etiqueta
                }
              >
                <ActivePill focused={focused} color={colors.glassActive} />
                <View>
                  <Feather name={icono} size={22} color={color} />
                  {/*
                    El mismo globo que en la lista de conversaciones: aparece
                    creciendo y salta cuando llega otro mensaje.
                  */}
                  {route.name === 'messages' ? (
                    <GloboDeNoLeidos cuenta={unread} tamano={16} style={styles.badge} />
                  ) : null}
                </View>
                <Text numberOfLines={1} style={[styles.label, { color }]}>
                  {etiqueta}
                </Text>
              </Pulsable>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    /*
      Margen a los lados: la capsula NO llega a los bordes de la pantalla. Ese
      aire es lo que la hace parecer flotante en vez de una barra pegada.
    */
    paddingHorizontal: spacing.lg,
  },
  shadowWrap: {
    /*
      La barra se estira a lo ancho disponible y reparte los botones a lo
      largo, en lugar de apretarlos en el centro. El tope evita que en tablet
      o en el navegador se convierta en una regla de lado a lado: pasado ese
      ancho deja de crecer y se queda centrada.
    */
    width: '100%',
    maxWidth: 460,
    borderRadius: radius.pill,
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    // Reparte el espacio sobrante entre los botones, no alrededor del grupo.
    justifyContent: 'space-between',
    height: BAR_HEIGHT,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.sm,
    overflow: 'hidden',
  },
  item: {
    // Cada boton toma la misma porcion del ancho: quedan repartidos de forma
    // pareja sea cual sea el tamano de la pantalla.
    flex: 1,
    height: BAR_HEIGHT - spacing.sm * 2,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    borderRadius: radius.pill,
  },
  pill: {
    // Con los botones ya repartidos a lo ancho, la capsula se cine al
    // contenido en vez de ocupar toda la celda: marca el activo sin
    // convertirse en una franja.
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: spacing.sm,
    right: spacing.sm,
    borderRadius: radius.pill,
  },
  label: {
    fontSize: 10,
    fontFamily: getFontFamily('700'),
    fontWeight: Platform.OS === 'ios' ? '700' : undefined,
  },
  // El tamaño y el color los pone `GloboDeNoLeidos`; aquí solo dónde va.
  badge: { position: 'absolute', top: -5, right: -9 },
});
