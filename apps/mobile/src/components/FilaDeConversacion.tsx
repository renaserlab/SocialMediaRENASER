import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Feather } from '@expo/vector-icons';

import { GloboDeNoLeidos } from '@/components/GloboDeNoLeidos';
import { Pulsable } from '@/components/Pulsable';
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
 * CÓMO SE VE (04/10/2026)
 * -----------------------------------------------------------------------------
 * Reportado: «la vista de mensajes sigue igual… debe ser como la bandeja de
 * Instagram». Era una tabla: foto con marco, nombre a un lado y la hora al
 * otro, el resumen debajo en letra de 13 y una raya entre fila y fila.
 *
 * Ahora es una fila de bandeja: la foto grande y sin marco, el nombre, y debajo
 * el último mensaje SEGUIDO de la hora («Que fue bro · 12:47»), que es como se
 * lee de un vistazo. Sin rayas: las filas las separa el aire. Lo no leído se
 * marca con el peso de la letra —nombre y resumen— y con el globo a la derecha;
 * nunca solo con color.
 *
 * -----------------------------------------------------------------------------
 * `React.memo` NO ES UN ADORNO AQUÍ
 * -----------------------------------------------------------------------------
 * Medido en `docs/Z_MEDICION_MENSAJES_EXPLORE.md` §2.4: en una pantalla de
 * 812 px caben 7-8 filas visibles. Con el `renderItem` en línea y sin memoria,
 * cada pulsación en el buscador repintaba esas ocho, y escribir un nombre de
 * ocho letras eran unos 64 renders de fila. Con `memo` aquí, `useCallback` en
 * el `renderItem` y `useMemo` en la lista, una fila solo se vuelve a pintar
 * cuando de verdad cambia su contenido. Es también lo que permite que buscar
 * estreche la lista en cada tecla sin que se note.
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
  const hora = conversacion.time ?? conversacion.messages.at(-1)?.createdAt;

  return (
    <Pulsable
      onPress={abrir}
      onLongPress={alEtiquetar ? etiquetar : undefined}
      delayLongPress={350}
      // Una fila ocupa todo el ancho: encoge apenas, lo justo para que se
      // note bajo el dedo antes de que se abra la conversación.
      escala={0.985}
      atenuar={0.72}
      accessibilityRole="button"
      accessibilityLabel={t('messages.chatWith', {
        nombre: conversacion.name,
        detalle: conversacion.subtitle,
      })}
      style={styles.fila}
    >
      {/*
        La foto real de la otra persona. Antes se elegia una imagen de muestra
        segun la POSICION de la fila (la primera una, la segunda otra...), asi
        que no correspondia con nadie: quien tenia foto salia con la de otro.

        Sin marco. El fondo es el de superficie: mientras la foto carga se ve
        un círculo, no un hueco.
      */}
      <ExpoImage
        source={conversacion.avatarUrl ? { uri: conversacion.avatarUrl } : assets.avatar}
        style={[styles.avatar, { backgroundColor: colors.surfaceAlt }]}
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
            weight={sinLeer ? '800' : '600'}
          >
            {conversacion.name}
          </Text>
          {/* Silenciado: no avisa porque así se pidió, no porque falle. */}
          {conversacion.silenciada ? (
            <Feather
              name="bell-off"
              size={13}
              color={colors.textMuted}
              accessibilityLabel={t('chatMenu.mutedBadge')}
            />
          ) : null}
        </View>

        {/*
          El último mensaje y, pegada a él, la hora. El resumen es el que se
          recorta si no cabe; la hora no encoge, porque siempre es corta y es
          lo que dice de cuándo es lo que se está leyendo.
        */}
        <View style={styles.lineaDeResumen}>
          <Text
            numberOfLines={1}
            style={styles.resumen}
            color={sinLeer ? colors.text : colors.textMuted}
            weight={sinLeer ? '700' : '400'}
          >
            {conversacion.subtitle}
          </Text>
          {hora ? (
            <Text style={styles.hora} color={colors.textMuted} numberOfLines={1}>
              {` · ${hora}`}
            </Text>
          ) : null}
        </View>

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
                style={[styles.etiqueta, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}
              >
                <Text variant="caption" style={styles.etiquetaTexto} color={colors.textMuted}>
                  {etiqueta.nombre}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>

      {/*
        El globo aparece creciendo y salta cuando llega otro mensaje: es el
        mismo de la barra inferior (`GloboDeNoLeidos`).
      */}
      <GloboDeNoLeidos cuenta={conversacion.unread} />
    </Pulsable>
  );
});

const styles = StyleSheet.create({
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    // Sin raya entre filas: las separa este aire.
    paddingVertical: 10,
  },
  avatar: { width: 56, height: 56, borderRadius: 28 },
  // `minWidth: 0` para que un nombre o un resumen largos se recorten en vez de
  // empujar el globo fuera de la pantalla.
  centro: { flex: 1, minWidth: 0, gap: 2 },
  lineaDeNombre: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  nombre: { fontSize: 15, lineHeight: 20, flexShrink: 1 },
  lineaDeResumen: { flexDirection: 'row', alignItems: 'center' },
  // `flexShrink` en el resumen y no en la hora: se recorta el mensaje.
  resumen: { fontSize: 14, lineHeight: 19, flexShrink: 1 },
  hora: { fontSize: 14, lineHeight: 19 },
  etiquetas: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  etiqueta: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
  etiquetaTexto: { fontSize: 11 },
});
