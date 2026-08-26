import React, { useState } from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { VideoPlayer } from '@/components/VideoPlayer';
import { ALTO_DE_LA_BARRA_DE_PROGRESO } from '@/components/VideoScrubber';
import { assets } from '@/data/assets';
import { haptics } from '@/lib/haptics';
import { snapToPage } from '@/lib/snapToPage';
import { palette, spacing } from '@/theme/tokens';
import { irAlPerfil } from '@/lib/irAlPerfil';

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
  /** true si `uri` es una playlist HLS (sin cache de disco del reproductor). */
  isStream?: boolean;
  /** Poster del video: se pinta al instante mientras el reproductor prepara. */
  posterUrl?: string;
  /** Ruta del poster en Storage: clave de cache estable frente a refirmas. */
  posterPath?: string;
  /** Fecha ISO del post: alimenta el cursor de paginacion. */
  createdAtIso?: string;
  likes: number;
  comments: number;
};

// Superficie full-bleed sobre video → contexto de media (siempre oscuro).
const media = palette('dark');

/**
 * Alto que ocupa la barra de progreso, contando su zona de toque.
 *
 * Viene de quien la dibuja, no de una estimacion: con un numero puesto aqui a
 * ojo, el nombre de quien publica caia DENTRO de la zona de arrastre de la
 * barra y pulsarlo movia el video en vez de abrir su perfil.
 */
const ALTURA_DEL_PROGRESO = ALTO_DE_LA_BARRA_DE_PROGRESO;

/** Aire entre el texto y la barra de progreso. */
const AIRE = 10;

/**
 * Alto reservado para el nombre de quien publica y su descripcion.
 *
 * Dos lineas de descripcion (`numberOfLines={2}`) mas el nombre. Es un alto
 * FIJO a proposito: si la columna de acciones se colocara segun lo que mida el
 * texto de cada video, saltaria de sitio al pasar de uno a otro, que es
 * exactamente lo que hace que un feed se sienta inestable.
 */
const ALTURA_DE_LA_INFORMACION = 62;

type Props = {
  short: ReelItem;
  /** Solo el item visible reproduce (autoplay por viewport). */
  active: boolean;
  /**
   * El reproductor existe solo para el video visible y sus vecinos inmediatos
   * (N-1, N, N+1): asi el siguiente arranca al instante sin que haya nunca mas
   * de tres reproductores vivos. Los demas muestran su poster, que es una
   * imagen ligera. Es la misma estrategia de ventana que usan las apps de
   * video vertical.
   */
  preload: boolean;
  height: number;
  /**
   * El sonido se decide una vez para todo el feed, no video a video: si cada
   * uno recordase el suyo, bajar la lista seria un sobresalto continuo.
   */
  muted: boolean;
  onToggleMuted: () => void;
  /** El navegador obligo a silenciar para poder arrancar. */
  onForcedMute: () => void;
  /**
   * Hueco reservado abajo.
   *
   * En el nuevo Inicio la barra de secciones flota SIEMPRE encima del video
   * (es lo que pedia el documento: nunca desaparece). Sin este hueco, la
   * columna de acciones y el pie de texto quedaban justo debajo de ella y
   * dejaban de poder tocarse. Vale 0 donde no hay barra.
   */
  espacioInferior?: number;
  /**
   * «No me interesa»: quien mira pide no volver a ver ESTA publicacion.
   *
   * Lo resuelve el feed (quitarla de la lista y avisar al recomendador), no
   * este componente, porque la lista no es suya. Sin callback no se pinta el
   * boton: en un reproductor suelto, fuera de un feed, no habria de donde
   * quitar nada.
   */
  alDescartar?: (postId: string) => void;
};

function ShortVideoItemBase({
  short,
  active,
  preload,
  height,
  muted,
  onToggleMuted,
  onForcedMute,
  espacioInferior = 0,
  alDescartar,
}: Props) {
  const router = useRouter();

  /*
    DE ABAJO A ARRIBA, cada cosa apoyada en la anterior. Antes eran dos numeros
    escritos a mano —`bottom: 140 + espacioInferior` y `bottom: 60 + ...`— que
    no median nada: dejaban 82 px muertos entre el nombre de quien publica y la
    barra de secciones, y 140 px entre el boton de sonido y la barra. Casi un
    quinto de la pantalla desperdiciado, justo lo que el documento señala.

    El orden, que es el de las aplicaciones de referencia:

        video
        acciones (columna derecha)
        autor + descripcion
        progreso
        ────────────────────────
        barra de secciones

    Todo se calcula desde `espacioInferior`, que ya sabe cuanto ocupa la barra
    flotante y la zona segura del aparato. Cambiar la altura de la barra mueve
    esto solo.
  */
  const alturaDeInformacion = espacioInferior + ALTURA_DEL_PROGRESO;
  const alturaDeAcciones = alturaDeInformacion + ALTURA_DE_LA_INFORMACION + AIRE;
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
    irAlPerfil(router, short.authorId);
  };

  const onShare = () => {
    Share.share({ message: `Mira este short de ${short.author} en Z.` }).catch(() => {});
  };

  return (
    <View style={[styles.container, snapToPage, { height }]}>
      {active || preload ? (
        <VideoPlayer
          uri={short.uri}
          poster={short.posterUrl ? { uri: short.posterUrl } : undefined}
          posterCacheKey={short.posterPath}
          cacheToDisk={!short.isStream}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          loop
          muted={muted}
          nativeControls={false}
          active={active}
          // Controles propios: un toque pausa o reanuda y abajo hay una barra
          // arrastrable. Los del sistema taparian el video con su botonera.
          shortsControls
          /*
            La barra de progreso se aparta de la barra de secciones.

            Sin esto se quedaba en `bottom: 0`, es decir, DEBAJO de la barra de
            navegacion: medido, la barra ocupaba 734-796 y el progreso caia en
            768-812. Se veia por debajo, cortado, y arrastrarlo era imposible.
            Ahora se apoya en la misma medida que usa la barra flotante para
            saber cuanto ocupa, asi que se coloca justo ENCIMA de ella —como en
            las aplicaciones de referencia— en cualquier pantalla y con
            cualquier zona segura, sin numeros puestos a ojo.
          */
          controlsBottomInset={espacioInferior}
          onMutedChange={onForcedMute}
        />
      ) : (
        /*
          Fuera de la ventana de precarga no hay reproductor: solo el poster.
          Cero memoria nativa y cero red por los videos que quedan lejos; al
          acercarse, esta celda se convierte en reproductor con el poster ya
          en cache, asi que el cambio no se nota.
        */
        <View style={StyleSheet.absoluteFill}>
          {short.posterUrl ? (
            <ExpoImage
              source={{ uri: short.posterUrl, cacheKey: short.posterPath }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              cachePolicy="disk"
              recyclingKey={short.posterPath ?? short.posterUrl}
            />
          ) : null}
        </View>
      )}
      <LinearGradient colors={['transparent', media.overlay]} style={styles.bottomScrim} pointerEvents="none" />

      <View style={[styles.sidebar, { bottom: alturaDeAcciones }]}>
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
          «No me interesa». Va en la columna porque es una accion sobre el
          video, pero mas pequena y en gris: es la unica de aqui que hace
          DESAPARECER algo y no se puede deshacer, asi que darle el mismo peso
          que a «me gusta» invitaria a tocarla sin querer.

          RECHAZAR EL VIDEO NO ES RECHAZAR A SU AUTOR. Esto no deja de seguir a
          nadie, no bloquea a nadie y no esconde el resto de lo que publique esa
          persona: pedir menos de UNA publicacion y pedir menos de ALGUIEN son
          dos decisiones distintas, y la segunda se toma en el perfil.
        */}
        {alDescartar ? (
          <Pressable
            onPress={() => alDescartar(short.id)}
            style={styles.sidebarItem}
            accessibilityRole="button"
            accessibilityLabel="No me interesa este video"
            accessibilityHint="Deja de mostrarte esta publicación. No afecta a quien la publicó."
          >
            <Feather name="slash" size={22} color={media.textMuted} />
          </Pressable>
        ) : null}

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

      <View style={[styles.bottomInfo, { bottom: alturaDeInformacion }]}>
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
  // `bottom` lo pone el componente: depende de si hay barra flotante encima.
  sidebar: { position: 'absolute', right: spacing.md, alignItems: 'center', gap: spacing.xl, zIndex: 10 },
  sidebarItem: { alignItems: 'center', justifyContent: 'center', minWidth: 44, minHeight: 44 },
  avatar: { width: 44, height: 44, borderRadius: 22, borderWidth: 2, borderColor: media.text },
  // Circulo de 40 con borde: se lee como un ajuste, no como una accion mas.
  soundButton: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, marginTop: spacing.sm },
  sidebarLabel: { fontSize: 12, fontWeight: '600', marginTop: spacing.xs },
  bottomInfo: { position: 'absolute', left: spacing.lg, right: 80, zIndex: 10, gap: spacing.xs },
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
