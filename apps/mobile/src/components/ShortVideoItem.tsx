import React, { useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { VideoPlayer } from '@/components/VideoPlayer';
import { assets } from '@/data/assets';
import { haptics } from '@/lib/haptics';
import { snapToPage } from '@/lib/snapToPage';
import { palette, spacing } from '@/theme/tokens';

/**
 * Reel normalizado. Antes el componente consumia el tipo `Short` del demo, con
 * claves de `data/assets` para avatar y poster; ahora recibe URLs reales.
 */
export type ReelItem = {
  id: string;
  author: string;
  authorId?: string;
  avatarUrl?: string;
  caption: string;
  uri: string;
  likes: number;
  comments: number;
};

// Superficie full-bleed sobre video → contexto de media (siempre oscuro).
const media = palette('dark');

type Props = {
  short: ReelItem;
  /** Solo el item visible reproduce (autoplay por viewport). */
  active: boolean;
  height: number;
  /**
   * El sonido se decide una vez para todo el feed, no video a video: si cada
   * uno recordase el suyo, bajar la lista seria un sobresalto continuo.
   */
  muted: boolean;
  onToggleMuted: () => void;
  /** El navegador obligo a silenciar para poder arrancar. */
  onForcedMute: () => void;
};

function ShortVideoItemBase({ short, active, height, muted, onToggleMuted, onForcedMute }: Props) {
  const router = useRouter();
  const [liked, setLiked] = useState(false);
  const [likes, setLikes] = useState(short.likes);

  const toggleLike = () => {
    haptics.light();
    setLiked((prev) => {
      setLikes((c) => c + (prev ? -1 : 1));
      return !prev;
    });
  };

  /*
    Ir al perfil de quien publica. Lo comparten la foto y el nombre: son la
    misma intencion y separarlas en dos sitios acaba con uno de los dos sin
    hacer nada, que es justo lo que pasaba con el nombre.
  */
  const openProfile = () => {
    if (short.authorId) router.push(`/profile/${short.authorId}` as never);
  };

  const onShare = () => {
    Share.share({ message: `Mira este short de ${short.author} en Z.` }).catch(() => {});
  };

  return (
    <View style={[styles.container, snapToPage, { height }]}>
      <VideoPlayer
        uri={short.uri}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        loop
        muted={muted}
        nativeControls={false}
        active={active}
        // Controles propios: un toque pausa o reanuda y abajo hay una barra
        // arrastrable. Los del sistema taparian el video con su botonera.
        shortsControls
        onMutedChange={onForcedMute}
      />
      <LinearGradient colors={['transparent', media.overlay]} style={styles.bottomScrim} pointerEvents="none" />

      <View style={styles.sidebar}>
        <Pressable
          onPress={openProfile}
          disabled={!short.authorId}
          style={styles.sidebarItem}
          accessibilityRole="button"
          accessibilityLabel={`Ver perfil de ${short.author}`}
        >
          <ExpoImage source={short.avatarUrl ? { uri: short.avatarUrl } : assets.avatar} style={styles.avatar} contentFit="cover" />
        </Pressable>

        <Pressable
          onPress={toggleLike}
          style={styles.sidebarItem}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: liked }}
          accessibilityLabel="Dar me gusta"
        >
          <Feather name="heart" size={28} color={liked ? media.danger : media.text} />
          <Text style={[styles.sidebarLabel, { color: media.text }]}>{likes}</Text>
        </Pressable>

        <Pressable
          onPress={() => router.push(`/comments/${short.id}` as never)}
          style={styles.sidebarItem}
          accessibilityRole="button"
          accessibilityLabel="Comentarios"
        >
          <Feather name="message-square" size={28} color={media.text} />
          <Text style={[styles.sidebarLabel, { color: media.text }]}>{short.comments}</Text>
        </Pressable>

        <Pressable onPress={onShare} style={styles.sidebarItem} accessibilityRole="button" accessibilityLabel="Compartir">
          <Feather name="share-2" size={28} color={media.text} />
        </Pressable>

        {/*
          El sonido va al final y aparte del resto. Arriba tapaba la foto de
          quien publica, y ademas no es una accion sobre el video como el resto
          de la columna, sino un ajuste de como se reproduce: el circulo y la
          separacion lo distinguen de un vistazo.

          El estado lo lleva el icono, no un color: tachado es silencio, ondas
          es audio.
        */}
        <Pressable
          onPress={onToggleMuted}
          style={[styles.sidebarItem, styles.soundButton, { backgroundColor: media.overlay, borderColor: media.border }]}
          accessibilityRole="switch"
          accessibilityState={{ checked: !muted }}
          accessibilityLabel={muted ? 'Activar el sonido' : 'Silenciar'}
        >
          <Feather name={muted ? 'volume-x' : 'volume-2'} size={22} color={media.text} />
        </Pressable>
      </View>

      <View style={styles.bottomInfo}>
        {/*
          El nombre lleva al perfil, igual que la foto: es lo que se espera al
          leerlo y era el gesto natural que no respondia.

          `alignSelf` lo cine al ancho del texto para que el hueco vacio de al
          lado no navegue tambien, y el `hitSlop` compensa que una linea de
          texto es mas fina que el dedo de nadie.
        */}
        <Pressable
          onPress={openProfile}
          disabled={!short.authorId}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={styles.authorButton}
          accessibilityRole="button"
          accessibilityLabel={`Ver perfil de ${short.author}`}
        >
          <Text style={[styles.author, { color: media.text }]}>{short.author}</Text>
        </Pressable>
        <Text style={[styles.caption, { color: media.text }]} numberOfLines={2}>
          {short.caption}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: '100%', backgroundColor: media.background },
  bottomScrim: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '40%' },
  sidebar: { position: 'absolute', right: spacing.md, bottom: 140, alignItems: 'center', gap: spacing.xl, zIndex: 10 },
  sidebarItem: { alignItems: 'center', justifyContent: 'center', minWidth: 44, minHeight: 44 },
  avatar: { width: 44, height: 44, borderRadius: 22, borderWidth: 2, borderColor: media.text },
  // Circulo de 40 con borde: se lee como un ajuste, no como una accion mas.
  soundButton: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, marginTop: spacing.sm },
  sidebarLabel: { fontSize: 12, fontWeight: '600', marginTop: spacing.xs },
  bottomInfo: { position: 'absolute', left: spacing.lg, right: 80, bottom: 60, zIndex: 10, gap: spacing.xs },
  authorButton: { alignSelf: 'flex-start' },
  author: { fontSize: 16, fontWeight: '700' },
  caption: { fontSize: 13, lineHeight: 18 },
});

/**
 * Solo se vuelve a dibujar el video cuyo estado ha cambiado.
 *
 * Al pasar de uno a otro cambia el indice activo, y sin esto se redibujaban
 * TODOS los videos montados —cada uno con su reproductor— justo mientras el
 * dedo esta desplazando la lista. Ese trabajo de mas en mitad del gesto es lo
 * que se nota como un desplazamiento acartonado.
 */
export const ShortVideoItem = React.memo(ShortVideoItemBase);
