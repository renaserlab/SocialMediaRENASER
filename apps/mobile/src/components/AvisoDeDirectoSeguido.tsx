import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, AppState, Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { Text } from '@/components/Text';
import { FEATURE_LIVE } from '@/config/features';
import { useTranslation } from '@/i18n/useTranslation';
import { LiveRepository, type Emision } from '@/repositories/LiveRepository';
import { useAuthStore } from '@/store/useAuthStore';
import { palette, radius, spacing } from '@/theme/tokens';

/** Cuanto se queda el aviso en pantalla si nadie lo toca. */
const DURACION_MS = 8000;

/**
 * Los directos ya anunciados en este arranque de la aplicacion.
 *
 * En el MODULO y no en el estado: el aviso se consulta al abrir y cada vez que
 * la aplicacion vuelve del segundo plano, y volver a enseñar el mismo directo
 * en cada vuelta seria perseguir a la persona con algo que ya decidio no ver.
 */
const yaAvisados = new Set<string>();

/**
 * Da por anunciado un directo sin enseñarlo: quien entra tocando el push de
 * ese directo ya esta yendo a verlo.
 */
export function marcarDirectoComoAvisado(emisionId: string): void {
  yaAvisados.add(emisionId);
}

// Superficie oscura siempre, como los avisos de TikTok: se lee igual sobre el
// muro claro que sobre un video.
const media = palette('dark');

/**
 * «Juan está transmitiendo en vivo», al entrar en la aplicacion.
 *
 * Lo pedido el 25/09/2026, como en TikTok: si alguien a quien sigues esta
 * emitiendo cuando abres Z, te sale arriba con su foto y un «Ver». Es la
 * tercera pieza del aviso de directos; las otras dos —el push y la fila en la
 * bandeja de notificaciones— las pone el servidor (`live/avisos.py`).
 *
 * SE PREGUNTA AL ENTRAR Y AL VOLVER, no se escucha en vivo: al abrir la
 * aplicacion, al iniciar sesion y cada vez que vuelve del segundo plano. Con la
 * aplicacion ya abierta, un directo que empieza llega como push, y el sistema
 * lo enseña arriba igual (`shouldShowBanner` en `services/notifications.ts`).
 *
 * NO SE PINTA si esta build no emite directos (`FEATURE_LIVE`, por ejemplo la
 * web): invitar a ver algo que aqui no se puede ver seria prometer una cosa y
 * entregar otra. Tampoco sin sesion: el servidor necesita saber a quien sigues.
 *
 * Un fallo al preguntar no se enseña: el aviso es un extra, y un error rojo al
 * abrir la aplicacion por algo que nadie pidio seria peor que no avisar.
 */
export function AvisoDeDirectoSeguido() {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const conSesion = useAuthStore((state) => state.status === 'authenticated');
  const [emision, setEmision] = useState<Emision | null>(null);
  const entrada = useRef(new Animated.Value(0)).current;

  const consultar = useCallback(async () => {
    if (!FEATURE_LIVE || !conSesion) return;
    try {
      const vivas = await LiveRepository.enVivoDeQuienSigo();
      const nueva = vivas.find((e) => !yaAvisados.has(e.id));
      if (!nueva) return;
      yaAvisados.add(nueva.id);
      setEmision(nueva);
    } catch {
      // Ver el docstring: el aviso es un extra y su fallo no se enseña.
    }
  }, [conSesion]);

  // Al entrar (y al iniciar sesion, que cambia `consultar`).
  useEffect(() => {
    void consultar();
  }, [consultar]);

  // Al volver del segundo plano.
  useEffect(() => {
    const suscripcion = AppState.addEventListener('change', (estado) => {
      if (estado === 'active') void consultar();
    });
    return () => suscripcion.remove();
  }, [consultar]);

  // Entra deslizando desde arriba y se va solo pasado un rato.
  useEffect(() => {
    if (!emision) return;
    entrada.setValue(0);
    Animated.timing(entrada, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    const temporizador = setTimeout(() => setEmision(null), DURACION_MS);
    return () => clearTimeout(temporizador);
  }, [emision, entrada]);

  if (!emision) return null;

  const cerrar = () => setEmision(null);
  const ver = () => {
    const id = emision.id;
    setEmision(null);
    router.push(`/live/${id}` as never);
  };
  const texto = t('notif.liveBody', { actor: emision.anfitrionNombre });

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.capa,
        {
          top: insets.top + spacing.sm,
          opacity: entrada,
          transform: [
            { translateY: entrada.interpolate({ inputRange: [0, 1], outputRange: [-24, 0] }) },
          ],
        },
      ]}
    >
      {/*
        LA TARJETA NO ES UN BOTÓN: lleva DOS, uno al lado del otro. Antes el
        de cerrar iba DENTRO del que abre el directo, y en web un botón dentro
        de otro es HTML inválido (React lo avisa como error de hidratación) y
        cerrar podía acabar abriendo el directo.
      */}
      <View style={[styles.tarjeta, { backgroundColor: media.surface, borderColor: media.border }]}>
      <Pressable
        onPress={ver}
        accessibilityRole="button"
        accessibilityLabel={t('live.noticeA11y', { actor: emision.anfitrionNombre })}
        style={({ pressed }) => [styles.cuerpo, { opacity: pressed ? 0.9 : 1 }]}
      >
        <View style={[styles.aro, { borderColor: media.danger }]}>
          <Avatar size={40} image={emision.anfitrionAvatarUrl} name={emision.anfitrionNombre} />
          <View style={[styles.etiqueta, { backgroundColor: media.danger }]}>
            <Text variant="caption" weight="800" color={media.onPrimary} style={styles.etiquetaTexto}>
              {t('live.badgeLive')}
            </Text>
          </View>
        </View>

        <View style={styles.textos}>
          <Text variant="secondary" weight="700" color={media.text} numberOfLines={2}>
            {texto}
          </Text>
          {emision.titulo ? (
            <Text variant="caption" color={media.textMuted} numberOfLines={1}>
              {emision.titulo}
            </Text>
          ) : null}
        </View>

        <View style={[styles.ver, { backgroundColor: media.text }]}>
          <Text variant="caption" weight="800" color={media.background}>
            {t('live.watchNow')}
          </Text>
        </View>
      </Pressable>

      <Pressable
        onPress={cerrar}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={t('common.close')}
        style={styles.cerrar}
      >
        <Feather name="x" size={16} color={media.textMuted} />
      </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  capa: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    // Por encima de las pestañas y de su capsula; por debajo de los dialogos y
    // del toast, que se montan despues.
    zIndex: 50,
    elevation: 12,
  },
  // Lo que abre el directo: ocupa todo menos el botón de cerrar.
  cuerpo: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  tarjeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingVertical: spacing.sm,
    paddingLeft: spacing.sm,
    paddingRight: spacing.xs,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  aro: {
    borderWidth: 2,
    borderRadius: 26,
    padding: 2,
    alignItems: 'center',
  },
  etiqueta: {
    position: 'absolute',
    bottom: -7,
    borderRadius: radius.sm,
    paddingHorizontal: 4,
  },
  etiquetaTexto: { fontSize: 8, letterSpacing: 0.5 },
  textos: { flex: 1, gap: 2 },
  ver: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    minHeight: 30,
    justifyContent: 'center',
  },
  cerrar: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
});
