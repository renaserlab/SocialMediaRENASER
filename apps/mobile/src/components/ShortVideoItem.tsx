import React from 'react';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import { ContadorAnimado } from '@/components/ContadorAnimado';
import { IconoQueSeEnciende } from '@/components/IconoQueSeEnciende';
import { Pulsable } from '@/components/Pulsable';
import { VideoPlayer } from '@/components/VideoPlayer';
import { ALTO_DE_LA_BARRA_DE_PROGRESO } from '@/components/VideoScrubber';
import { assets } from '@/data/assets';
import { compartirPublicacion } from '@/lib/enlaces';
import { haptics } from '@/lib/haptics';
import { ESCALA_AL_PULSAR } from '@/lib/movimiento';
import { esVertical } from '@/lib/formaDelVideo';
import { snapToPage } from '@/lib/snapToPage';
import { palette, spacing } from '@/theme/tokens';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { useAppStore } from '@/store/useAppStore';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { useTranslation } from '@/i18n/useTranslation';

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
  /**
   * Medidas del video, si se guardaron (migracion 0021).
   *
   * A pantalla completa NO sirven para deformar nada: sirven para decidir el
   * ENCUADRE. Un vertical llena la pantalla; un apaisado, si se llenara, se
   * quedaria en una franja central del propio video —se veria un tercio de la
   * escena— asi que se ensena entero con su banda arriba y abajo, que es lo que
   * hacen las aplicaciones de referencia.
   */
  width?: number;
  height?: number;
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

/*
  Zona de toque del corazon y de su numero, que son dos botones apilados.

  Se amplian hacia FUERA, nunca hacia el otro: el corazon hacia arriba y los
  lados, el numero hacia abajo y los lados. Si se solaparan, un toque entre los
  dos podria dar «me gusta» queriendo ver la lista, o al reves.
*/
const AREA_DEL_CORAZON = { top: 8, left: 10, right: 10, bottom: 0 } as const;
const AREA_DEL_NUMERO = { top: 0, left: 16, right: 16, bottom: 12 } as const;

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
  /**
   * Abrir los comentarios en una HOJA, sin salir del video. Antes se iba a la
   * pantalla `/comments/{id}` y se perdia el video de vista, que es lo que se
   * reporto: tiene que subir la misma bandeja que en Explorar.
   *
   * La hoja la monta el feed y no la celda: una sola para toda la lista, y
   * ningun `useState` en una celda que FlashList recicla para otro video.
   * `total` es el numero que se esta ensenando, para que la hoja diga lo mismo.
   */
  alAbrirComentarios: (postId: string, total: number) => void;
  /** Quien reacciono, en la misma hoja que en Explorar. Tambien la monta el feed. */
  alVerReacciones: (postId: string) => void;
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
  alAbrirComentarios,
  alVerReacciones,
}: Props) {
  const { t } = useTranslation();
  const router = useRouter();

  /*
    Como se encuadra ESTE video en la pantalla.

    Estaba fijo en `cover` para todos. Con un video vertical eso es lo correcto
    —llena la pantalla, que es de lo que va el formato—, pero con uno apaisado
    recorta los lados hasta dejar una franja central: se pierde la mitad de la
    escena y no hay forma de recuperarla. Sabiendo la forma del video, cada uno
    se encuadra como le corresponde, y sin medidas guardadas se mantiene el
    `cover` de siempre.
  */
  const encuadre =
    short.width && short.height && !esVertical(short.width, short.height)
      ? ('contain' as const)
      : ('cover' as const);

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
  /*
    LA REACCION SALE DEL ESTADO COMPARTIDO, no de un `useState` de la celda.

    Antes esto era `useState(false)` y `useState(short.likes)`, y el boton solo
    tocaba esas dos variables: no llamaba al servidor NI al store. O sea que
    dar me gusta en Inicio no guardaba nada. Se veia de dos formas:

      - Reaccionabas en Explorar y el mismo video salia con el corazon vacio en
        Inicio, porque el `useState` nacia en `false` pasara lo que pasara.
      - Reaccionabas en Inicio y al desplazar se perdia: FlashList recicla las
        celdas y el estado local no vuelve a nacer.

    Leyendolo del store, las dos pantallas cuentan lo mismo porque miran lo
    mismo. El contador sale de `likeCounts` —que mantiene el propio store— y
    cae a `short.likes` mientras no haya llegado nada del servidor.
  */
  const liked = useAppStore((state) => state.likedPostIds.includes(short.id));
  const likes = useAppStore((state) => state.likeCounts[short.id] ?? short.likes);
  const toggleLikePost = useAppStore((state) => state.toggleLikePost);
  /*
    LOS COMENTARIOS, TAMBIEN DEL ESTADO COMPARTIDO. Es la misma publicacion que
    en Explorar: si se comenta alli, aqui tiene que subir el numero, y al reves.
    `short.comments` es lo que dijo el servidor al cargar este feed; lo anotado
    es lo ultimo que se comento desde este telefono. Vale el mayor, como el
    total de la hoja (`lib/comentarios`): si alguien mas comento despues, lo
    trae el feed al recargar; si se comento aqui, lo trae lo anotado.
  */
  const comentariosAnotados = useAppStore((state) => state.commentCounts[short.id]);
  const comentarios = Math.max(comentariosAnotados ?? 0, short.comments);
  // Reaccionar queda asociado a una cuenta. Mismo gesto que en el muro
  // (`PostCard`): se pide al usarlo, no al entrar en la aplicacion.
  const requireAuth = useRequireAuth();

  const toggleLike = () => {
    void requireAuth('auth.reasonReact', () => {
      haptics.light();
      toggleLikePost(short.id);
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

  /*
    Compartir con enlace. El `id` del reel ES el id de la publicacion de video,
    asi que la ruta canonica `/post/{id}` sirve igual que para el muro y no hace
    falta una pantalla aparte para los reels.
  */
  const onShare = () => {
    const { message } = compartirPublicacion({
      postId: short.id,
      autor: short.author,
      clase: 'video',
      traducir: t,
    });
    Share.share({ message }).catch(() => {});
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
          contentFit={encuadre}
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
              contentFit={encuadre}
              cachePolicy="disk"
              recyclingKey={short.posterPath ?? short.posterUrl}
            />
          ) : null}
        </View>
      )}
      <LinearGradient colors={['transparent', media.overlay]} style={styles.bottomScrim} pointerEvents="none" />

      <View style={[styles.sidebar, { bottom: alturaDeAcciones }]}>
        {/*
          TODA LA COLUMNA RESPONDE AL DEDO. Cada boton se hunde al tocarlo
          (`Pulsable`), y el corazon ademas salta al encenderse. Sobre un video
          en movimiento un cambio de color a secas no se ve; un gesto si. Son
          animaciones de un instante, en el hilo de la interfaz: no compiten
          con el video ni le quitan fotogramas.
        */}
        <Pulsable
          onPress={openProfile}
          disabled={!short.authorId}
          escala={ESCALA_AL_PULSAR.icono}
          style={styles.sidebarItem}
          accessibilityRole="button"
          accessibilityLabel={t('post.viewProfileOf', { nombre: short.author })}
        >
          <ExpoImage source={short.avatarUrl ? { uri: short.avatarUrl } : assets.avatar} style={styles.avatar} contentFit="cover" />
        </Pulsable>

        {/*
          DOS DESTINOS, como en la tarjeta de Explorar (`AccionDePublicacion`):
          el corazon reacciona y el NUMERO abre quien reacciono. Antes eran un
          solo boton y en Inicio no habia forma de ver esa lista.

          El aspecto no cambia —corazon y numero debajo—: lo que cambia es que
          son dos pulsables. El area de cada uno la amplia `hitSlop`, sin mover
          nada de sitio. Sin reacciones no hay lista y el numero deja de ser
          pulsable, igual que en Explorar.
        */}
        <View style={styles.sidebarItem}>
          <Pulsable
            onPress={toggleLike}
            hitSlop={AREA_DEL_CORAZON}
            escala={ESCALA_AL_PULSAR.icono}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: liked }}
            accessibilityLabel={t('post.actionLike')}
          >
            <IconoQueSeEnciende activo={liked} clave={short.id}>
              {/*
                Relleno al reaccionar: cambia la FORMA, no solo el color. Un
                contorno rojo sobre un video rojizo no se distingue del blanco.
              */}
              {liked ? (
                <MaterialCommunityIcons name="heart" size={30} color={media.meGusta} />
              ) : (
                <Feather name="heart" size={28} color={media.text} />
              )}
            </IconoQueSeEnciende>
          </Pulsable>
          {likes > 0 ? (
            <Pressable
              onPress={() => alVerReacciones(short.id)}
              hitSlop={AREA_DEL_NUMERO}
              accessibilityRole="button"
              accessibilityLabel={t('post.whoReacted')}
            >
              <ContadorAnimado valor={likes} clave={short.id} color={media.text} style={styles.sidebarLabel} />
            </Pressable>
          ) : (
            <ContadorAnimado valor={likes} clave={short.id} color={media.text} style={styles.sidebarLabel} />
          )}
        </View>

        <Pulsable
          onPress={() => alAbrirComentarios(short.id, comentarios)}
          escala={ESCALA_AL_PULSAR.icono}
          style={styles.sidebarItem}
          accessibilityRole="button"
          accessibilityLabel={t('post.comments')}
        >
          <Feather name="message-square" size={28} color={media.text} />
          <ContadorAnimado valor={comentarios} clave={short.id} color={media.text} style={styles.sidebarLabel} />
        </Pulsable>

        <Pulsable
          onPress={onShare}
          escala={ESCALA_AL_PULSAR.icono}
          style={styles.sidebarItem}
          accessibilityRole="button"
          accessibilityLabel={t('post.share')}
        >
          <Feather name="share-2" size={28} color={media.text} />
        </Pulsable>

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
          <Pulsable
            onPress={() => alDescartar(short.id)}
            escala={ESCALA_AL_PULSAR.icono}
            style={styles.sidebarItem}
            accessibilityRole="button"
            accessibilityLabel={t('feed.notInterested')}
            accessibilityHint={t('feed.notInterestedHint')}
          >
            <Feather name="slash" size={22} color={media.textMuted} />
          </Pulsable>
        ) : null}

        {/*
          El sonido va al final y aparte del resto. Arriba tapaba la foto de
          quien publica, y ademas no es una accion sobre el video como el resto
          de la columna, sino un ajuste de como se reproduce: el circulo y la
          separacion lo distinguen de un vistazo.

          El estado lo lleva el icono, no un color: tachado es silencio, ondas
          es audio.
        */}
        <Pulsable
          onPress={onToggleMuted}
          escala={ESCALA_AL_PULSAR.icono}
          style={[styles.sidebarItem, styles.soundButton, { backgroundColor: media.overlay, borderColor: media.border }]}
          accessibilityRole="switch"
          accessibilityState={{ checked: !muted }}
          accessibilityLabel={muted ? t('video.unmute') : t('video.mute')}
        >
          {/* El icono salta al cambiar: silenciar tambien tiene su respuesta. */}
          <IconoQueSeEnciende activo={!muted}>
            <Feather name={muted ? 'volume-x' : 'volume-2'} size={22} color={media.text} />
          </IconoQueSeEnciende>
        </Pulsable>
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
          accessibilityLabel={t('post.viewProfileOf', { nombre: short.author })}
        >
          <Text style={[styles.author, { color: media.text }]} numberOfLines={1}>
            {short.author}
          </Text>
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
