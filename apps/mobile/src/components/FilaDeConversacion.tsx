import React, { useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';

import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { haptics } from '@/lib/haptics';
import { useTranslation } from '@/i18n/useTranslation';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { Conversation } from '@/types';

type Props = {
  conversacion: Conversation;
  alAbrir: (conversacion: Conversation) => void;
  /**
   * Mantener pulsado abre las etiquetas DE ESA conversación.
   *
   * Es el gesto que evita una pantalla intermedia: uno se da cuenta de que hay
   * que marcar a alguien como «Interesado» mirando su fila, no tres pantallas
   * más adentro.
   */
  alEtiquetar?: (conversacion: Conversation) => void;
};

/**
 * Una fila de la bandeja.
 *
 * -----------------------------------------------------------------------------
 * `React.memo` NO ES UN ADORNO AQUÍ
 * -----------------------------------------------------------------------------
 * Medido en `docs/Z_MEDICION_MENSAJES_EXPLORE.md` §2.4: la fila mide 81 px, así
 * que en una pantalla de 812 px caben 7-8 filas visibles. Con el `renderItem`
 * en línea y sin memoria, cada pulsación en el buscador repintaba esas ocho, y
 * escribir un nombre de ocho letras eran unos 64 renders de fila. Con `memo`
 * aquí, `useCallback` en el `renderItem` y `useMemo` en la lista, una fila solo
 * se vuelve a pintar cuando de verdad cambia su contenido.
 *
 * Para que la memoria sirva, las dos funciones tienen que ser ESTABLES entre
 * renders (la pantalla las envuelve en `useCallback`) y por eso reciben la
 * conversación como argumento en vez de estar cerradas sobre ella: una flecha
 * nueva por fila y por render dejaría a `memo` sin nada que comparar.
 *
 * -----------------------------------------------------------------------------
 * `expo-image` CON `recyclingKey`
 * -----------------------------------------------------------------------------
 * El resto de la aplicación ya usa `expo-image`; esta pantalla se había quedado
 * con el `Image` de react-native. `recyclingKey` es lo que impide que una celda
 * reciclada por `FlashList` enseñe un instante el avatar de la fila anterior al
 * desplazarse: es un efecto visual que se lee como lentitud aunque no lo sea.
 */
export const FilaDeConversacion = React.memo(function FilaDeConversacion({
  conversacion,
  alAbrir,
  alEtiquetar,
}: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  const abrir = useCallback(() => alAbrir(conversacion), [alAbrir, conversacion]);
  const etiquetar = useCallback(() => {
    if (!alEtiquetar) return;
    // Vibración corta: mantener pulsado no tiene señal visual antes de que se
    // abra la hoja, así que sin esto parece que no ha pasado nada.
    haptics.light();
    alEtiquetar(conversacion);
  }, [alEtiquetar, conversacion]);

  const etiquetas = conversacion.labels ?? [];
  const sinLeer = conversacion.unread > 0;

  return (
    <Pressable
      onPress={abrir}
      onLongPress={alEtiquetar ? etiquetar : undefined}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={t('messages.chatWith', {
        nombre: conversacion.name,
        detalle: conversacion.subtitle,
      })}
      style={({ pressed }) => [
        styles.fila,
        { borderBottomColor: colors.border, opacity: pressed ? 0.78 : 1 },
      ]}
    >
      {/*
        La foto real de la otra persona. Antes se elegia una imagen de muestra
        segun la POSICION de la fila (la primera una, la segunda otra...), asi
        que no correspondia con nadie: quien tenia foto salia con la de otro.
      */}
      <ExpoImage
        source={conversacion.avatarUrl ? { uri: conversacion.avatarUrl } : assets.avatar}
        style={[styles.avatar, { borderColor: colors.border }]}
        contentFit="cover"
        cachePolicy="memory-disk"
        // La clave del reciclado: sin ella la celda reutilizada enseña la foto
        // de quien ocupaba ese hueco antes.
        recyclingKey={conversacion.id}
      />

      <View style={styles.centro}>
        <View style={styles.lineaDeNombre}>
          <Text
            numberOfLines={1}
            style={styles.nombre}
            color={colors.text}
            // Lo no leído en negrita, como en cualquier bandeja: el globo del
            // número es pequeño y se pierde al ojear la lista de arriba abajo.
            weight={sinLeer ? '800' : '700'}
          >
            {conversacion.name}
          </Text>
          <Text variant="caption" style={styles.hora} color={colors.textMuted}>
            {conversacion.time ?? conversacion.messages.at(-1)?.createdAt}
          </Text>
        </View>

        <Text
          numberOfLines={1}
          variant="caption"
          style={styles.resumen}
          color={sinLeer ? colors.text : colors.textMuted}
          weight={sinLeer ? '600' : '400'}
        >
          {conversacion.subtitle}
        </Text>

        {/*
          Las etiquetas del CRM, si las hay. SON PRIVADAS: el servidor solo manda
          las de quien mira, así que aquí no hay nada que esconder. No se
          desplazan en horizontal a propósito — un carrusel dentro de una fila de
          lista se pelea con el gesto de desplazar la lista y con el de cambiar
          de sección. Se envuelven y punto.
        */}
        {etiquetas.length > 0 ? (
          <View style={styles.etiquetas}>
            {etiquetas.map((etiqueta) => (
              <View
                key={etiqueta.id}
                style={[styles.etiqueta, { borderColor: colors.border }]}
              >
                <Text variant="caption" style={styles.etiquetaTexto} color={colors.textMuted}>
                  {etiqueta.nombre}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {sinLeer ? (
        <View style={[styles.globo, { backgroundColor: colors.primary }]}>
          <Text variant="caption" weight="700" color={colors.onPrimary} style={styles.globoTexto}>
            {/* Más de 99 no cabe y tampoco aporta: lo que importa es «muchos». */}
            {conversacion.unread > 99 ? '99+' : conversacion.unread}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: { width: 52, height: 52, borderRadius: 26, borderWidth: 1 },
  centro: { flex: 1, gap: 3 },
  lineaDeNombre: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  // `flexShrink` para que un nombre largo se recorte y no empuje la hora fuera
  // de la pantalla; la hora no encoge porque siempre es corta.
  nombre: { fontSize: 14, flexShrink: 1 },
  hora: { fontSize: 11 },
  resumen: { fontSize: 12 },
  etiquetas: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  etiqueta: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
  etiquetaTexto: { fontSize: 10 },
  globo: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  globoTexto: { fontSize: 10 },
});
