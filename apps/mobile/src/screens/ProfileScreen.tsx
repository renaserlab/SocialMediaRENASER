import React, { useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { afterSheetClose } from '@/lib/afterSheetClose';
import { confirm, notify } from '@/lib/confirm';
import { useRouter, useLocalSearchParams } from 'expo-router';

import { perfilVisto } from '@/services/senales';

import { haptics } from '@/lib/haptics';
import { Feather, MaterialCommunityIcons } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AudioDePresentacion } from '@/components/AudioDePresentacion';
import { AppScreen } from '@/components/AppScreen';
import { BottomSheet } from '@/components/BottomSheet';
import { BookSessionSheet } from '@/components/BookSessionSheet';
import { Button } from '@/components/Button';
import { Avatar } from '@/components/Avatar';
import { ListRow } from '@/components/ListRow';
import { OfertaDelPerfil } from '@/components/OfertaDelPerfil';
import { ProfileGallery } from '@/components/ProfileGallery';
import { ProfileSection, type ProfileSectionKind } from '@/components/ProfileSection';
import { StateView } from '@/components/StateView';
import { useProfilePosts } from '@/hooks/useProfilePosts';
import { useRequireAuth } from '@/hooks/useRequireAuth';
import { assets } from '@/data/assets';
import { MessageRepository } from '@/repositories/MessageRepository';
import { ProductSellerRepository } from '@/repositories/ProductSellerRepository';
import { ProfileRepository } from '@/repositories/ProfileRepository';
import {
  esProveedorActivo,
  rutaDelProveedor,
  type EstadoDelProveedor,
} from '@/lib/proveedorDeProductos';
import { guardarPerfil, pedirPerfil, perfilEnCache } from '@/services/cachePerfil';
import { ConfirmarRecorte } from '@/components/ConfirmarRecorte';
import {
  PermisoDenegadoError,
  pickImage,
  takePhoto,
  type PickedMedia,
} from '@/services/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { GRID_COLUMNS, GRID_GAP, gridItemSize } from '@/lib/gridLayout';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { UserProfile } from '@/types';

/**
 * Hasta cuántas líneas se centra la descripción del perfil.
 *
 * Tres caben centradas sin esfuerzo y es lo que mide una presentación normal.
 * A partir de ahí el ojo pierde el punto donde empieza cada línea, así que se
 * alinea a la izquierda —el ancho sigue limitado y el bloque sigue centrado, lo
 * único que cambia es dónde arrancan las líneas—.
 */
const LINEAS_CENTRADAS = 3;

/**
 * El icono de un acceso circular del perfil, con la familia a la que pertenece.
 *
 * POR QUÉ HAY DOS FAMILIAS Y NO UNA. Los cuatro accesos eran de Feather, que es
 * lo que usa el resto de la aplicación, y lo natural sería no salir de ahí. El
 * problema es que Feather NO tiene un icono de comillas: ni `quote`, ni
 * `format-quote`, ni nada equivalente. Lo más cerca que se llegaba era la
 * estrella —que es lo que había— y una estrella no dice «reseñas», dice
 * «puntuación», «favorito» o «destacado» según a quién se le pregunte.
 *
 * `MaterialCommunityIcons` VIENE EN EL MISMO PAQUETE que Feather
 * (`@expo/vector-icons`, ya instalado): no se añade ninguna dependencia, no
 * entra ningún PNG y el icono sigue siendo vectorial, así que escala igual y se
 * tiñe con los tokens del tema como los demás.
 */
type IconoDeAcceso =
  | { familia: 'feather'; nombre: keyof typeof Feather.glyphMap }
  | { familia: 'material'; nombre: keyof typeof MaterialCommunityIcons.glyphMap };

export function ProfileScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const { id, section } = useLocalSearchParams<{ id?: string; section?: string }>();

  const currentUser = useAppStore((state) => state.user);
  const setProfileImage = useAppStore((state) => state.setProfileImage);
  const authStatus = useAuthStore((state) => state.status);
  const esAdministracion = useAppStore((state) => state.user?.isAdmin === true);
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const signedIn = useAuthStore((state) => state.status === 'authenticated');
  // Seguir, escribir y bloquear necesitan cuenta: se pide al usarlos.
  const requireAuth = useRequireAuth();
  // 'anonymous' es distinto de 'todavia no lo se': al arrancar el estado pasa
  // por 'loading', y ahi no se debe dar por hecho que no hay cuenta.
  const anonimo = useAuthStore((state) => state.status === 'anonymous');
  const profileError = useAuthStore((state) => state.profileError);
  const refreshProfile = useAuthStore((state) => state.refreshProfile);

  // Tipos de perfil: propio (sin id) o publico real (uuid).
  //
  // HUBO UN TERCERO Y SE BORRO: `id === 'darren'` pintaba a un mentor inventado
  // —«Darren Hardy», 1,2 M de seguidores, una biografia escrita a mano— y
  // `/profile/darren` era una URL alcanzable en produccion. Ni el fichero de
  // ruta ni esta rama comprobaban `__DEV__`. Es la misma familia que la ruta
  // `/short/[id]` y el chat de demostracion, borrados por el mismo motivo: un
  // perfil que parece de alguien y no lo es.
  const isRealPublic = !!id && id !== currentUser?.id;
  const isPublic = isRealPublic;

  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [followersCount, setFollowersCount] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  /**
   * Se esta abriendo la conversacion.
   *
   * Abrir un chat es la UNICA accion de este perfil que no puede navegar en el
   * acto: la pantalla `/chat/[id]` necesita el id de la conversacion, y ese id
   * lo devuelve el servidor al crearla (`POST /conversations/direct`). No hay
   * nada que precargar como en `irAlPerfil`, porque todavia no se sabe adonde
   * se va.
   *
   * Lo que si se puede es no dejar el boton muerto en la mano mientras tanto, y
   * sobre todo no dejar que se pulse dos veces: sin este cerrojo, dos toques
   * seguidos mandaban dos peticiones de creacion a la vez.
   */
  const [chatBusy, setChatBusy] = useState(false);
  const [bookingVisible, setBookingVisible] = useState(false);
  const [optionsVisible, setOptionsVisible] = useState(false);
  /**
   * Seccion activa bajo los accesos circulares. Llega por parametro desde las
   * tarjetas de Inicio (Eventos / Cursos) y tambien se cambia tocando los
   * circulos. `null` = la galeria de publicaciones.
   */
  const [activeSection, setActiveSection] = useState<ProfileSectionKind | null>(null);
  /**
   * Si la descripción ocupó más líneas de las que se pueden centrar sin que
   * cueste leerlas. Se responde midiendo el texto ya pintado (`onTextLayout`),
   * no contando caracteres: el mismo texto ocupa distinto en cada pantalla.
   *
   * Arranca en `false` —centrada— porque es lo que vale para la inmensa mayoría
   * de las descripciones, y así el caso normal no parpadea.
   */
  const [bioLarga, setBioLarga] = useState(false);
  /**
   * Si esta persona ya es responsable comercial de productos en Z.
   *
   * Hace falta para saber A DÓNDE lleva el acceso: quien ya lo es va a sus
   * productos y quien no, a postular. `null` es «todavía no lo sé», y mientras
   * lo sea no se pinta la entrada: una fila que aparece y cambia de destino un
   * segundo después es peor que una que tarda en aparecer.
   */
  const [estadoDeProveedor, setEstadoDeProveedor] = useState<EstadoDelProveedor | null>(
    null,
  );

  /*
    SOLO EN EL PROPIO PERFIL Y CON SESION. En el de otra persona no se pregunta
    nada: si es proveedora o no es asunto suyo, y esta lectura es de quien
    pregunta. Un fallo se ignora a proposito —la entrada no aparece— porque
    Productos puede no estar desplegado en este servidor, y eso no es motivo
    para enseñar un error en el perfil.
  */
  useEffect(() => {
    if (isPublic || !signedIn) return undefined;
    let vivo = true;
    ProductSellerRepository.estado()
      .then((leido) => {
        if (vivo) setEstadoDeProveedor(leido);
      })
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [isPublic, signedIn]);

  /**
   * Sincroniza la seccion con el parametro de la ruta.
   *
   * Antes se leia solo en el valor inicial de `useState`, que se calcula una
   * vez: si la pantalla ya estaba montada (por ejemplo tras visitar el
   * podcast), pulsar "Eventos" en el inicio cambiaba la URL pero seguia
   * enseñando la seccion anterior.
   */
  useEffect(() => {
    const valid: ProfileSectionKind[] = [
      'eventos',
      'cursos',
      'podcast',
      'testimonios',
      // La galería NO está en los accesos circulares: se llega desde el menú
      // del perfil. Vivía empotrada dentro de «Reseñas», que es donde no
      // pertenece — ver la nota de `ProfileSection`.
      'galeria',
    ];
    setActiveSection(
      valid.includes(section as ProfileSectionKind) ? (section as ProfileSectionKind) : null,
    );
  }, [section, id]);

  /*
    LO QUE YA SE SABE, DESDE EL PRIMER FOTOGRAMA.

    Este par de estados arrancaba siempre en (null, 'loading'), y mas abajo eso
    tapaba la pantalla ENTERA con un indicador de carga hasta que respondiera
    `/profiles/{id}`. Con la latencia real de la base son cerca de dos segundos
    en los que la persona ya ha tocado, ya ha visto entrar la pantalla... y no
    hay nada dentro. Si el perfil se visito antes —o si la precarga que se
    dispara AL TOCAR ya llego— se pinta entero de salida y se refresca detras.
  */
  const [publicProfile, setPublicProfile] = useState<UserProfile | null>(() =>
    isRealPublic ? perfilEnCache(id) : null,
  );
  const [publicState, setPublicState] = useState<'loading' | 'error' | 'idle'>(() =>
    isRealPublic && perfilEnCache(id) ? 'idle' : 'loading',
  );

  // Publicaciones del perfil que se esta viendo (el propio o el de otro).
  const galleryOwnerId = isRealPublic ? id : currentUser?.id;
  const {
    gallery,
    audios,
    loading: postsLoading,
    error: postsError,
  } = useProfilePosts(galleryOwnerId);

  const aplicarPerfil = React.useCallback((p: UserProfile) => {
    setPublicProfile(p);
    setFollowing(p.isFollowing ?? false);
    setBlocked(p.isBlocked ?? false);
    setFollowersCount(p.followers);
    setPublicState('idle');
  }, []);

  /**
   * Trae el perfil ajeno. `refrescar` salta lo guardado y va al servidor: se
   * usa al reintentar y despues de bloquear, que cambia contadores.
   *
   * El error solo se enseña si NO habia nada que enseñar. Tapar un perfil ya
   * pintado con un «no se pudo cargar» porque fallo el REFRESCO seria cambiar
   * algo correcto por nada.
   */
  const loadPublic = React.useCallback(
    (refrescar = false) => {
      if (!isRealPublic || !id) return;
      const guardado = perfilEnCache(id);
      if (guardado) aplicarPerfil(guardado);
      else setPublicState('loading');
      pedirPerfil(id, { refrescar })
        .then(aplicarPerfil)
        .catch(() => {
          if (!guardado) setPublicState('error');
        });
    },
    [id, isRealPublic, aplicarPerfil],
  );

  useEffect(() => {
    loadPublic();
  }, [loadPublic]);

  /*
    Abrir un perfil ajeno es una senal, y de las buenas: dice mas que ver pasar
    un video y menos que seguir a alguien.

    Lo que NO hace: avisar a nadie. Que alguien mire tu perfil no se le cuenta
    al duenno —eso convertiria mirar en una accion publica sin que nadie lo
    haya decidido—, se usa solo para ordenar lo que se te recomienda a TI. Y se
    manda una vez por perfil y sesion, no en cada repintado (ver `senales`).
  */
  useEffect(() => {
    if (!isRealPublic || !id || !signedIn) return;
    perfilVisto(id);
  }, [id, isRealPublic, signedIn]);

  /**
   * Invitacion a crear cuenta al asomarse al perfil de otra persona.
   *
   * Sin sesion se puede mirar, pero conviene decir que hay mas detras: quien
   * llega aqui ya ha mostrado interes por alguien concreto, y ese es el momento
   * de explicar para que sirve registrarse. Antes no se decia nada y la
   * pantalla se quedaba a medias sin motivo aparente.
   *
   * Se enseña UNA vez por perfil visitado (`avisadoRef`), no en cada
   * repintado ni al volver atras: repetir el mismo aviso cansa y acaba
   * cerrandose sin leer.
   */
  const avisadoRef = React.useRef<string | null>(null);
  useEffect(() => {
    // Se espera a saber con certeza que no hay sesion (`anonimo`), no basta
    // con que aun no la haya: durante el arranque el estado es 'loading' y
    // avisar ahi saldria tambien a quien si tiene cuenta.
    if (!isPublic || !supabaseEnabled || !anonimo) return;
    // En un perfil real se espera a tener su nombre: la invitacion dice a quien
    // se esta visitando, y lanzarla antes la dejaba en un generico «esta
    // persona» que no convence a nadie.
    if (isRealPublic && !publicProfile) return;
    const clave = id ?? 'perfil';
    if (avisadoRef.current === clave) return;
    avisadoRef.current = clave;

    const nombre = publicProfile?.fullName?.split(' ')[0] ?? 'esta persona';

    // Un respiro antes de preguntar. Da tiempo a que el dialogo propio de la
    // aplicacion este montado —si no, se cae al del navegador, que anuncia
    // "localhost dice" y no se puede dar estilo— y evita que la invitacion
    // aparezca encima de una pantalla a medio pintar.
    const temporizador = setTimeout(() => {
      void (async () => {
        const entrar = await confirm({
          title: t('profile.discoverNamed', { nombre }),
          message: t('profile.discoverBody'),
          confirmLabel: t('auth.signUp'),
          cancelLabel: t('profile.keepLooking'),
        });
        if (entrar) router.push('/register' as never);
      })();
    }, 700);
    return () => clearTimeout(temporizador);
  }, [isPublic, supabaseEnabled, anonimo, id, isRealPublic, publicProfile, router]);

  const toggleFollow = async () => {
    haptics.light();
    // Seguir queda registrado a nombre de alguien: primero la cuenta.
    let autorizado = false;
    await requireAuth('auth.reasonFollow', () => {
      autorizado = true;
    });
    if (!autorizado) return;

    if (!isRealPublic || !id) return;
    const wasFollowing = following;
    setFollowBusy(true);
    setFollowing(!wasFollowing);
    setFollowersCount((c) => Math.max(0, c + (wasFollowing ? -1 : 1)));
    try {
      const count = wasFollowing
        ? await ProfileRepository.unfollow(id)
        : await ProfileRepository.follow(id);
      setFollowersCount(count);
      // Lo guardado tiene que quedar igual que la pantalla: si no, volver a
      // este perfil enseñaria «Seguir» durante un instante a quien acaba de
      // darle, y eso se lee como que no funciono.
      if (publicProfile) {
        guardarPerfil({ ...publicProfile, isFollowing: !wasFollowing, followers: count });
      }
    } catch {
      setFollowing(wasFollowing);
      setFollowersCount((c) => Math.max(0, c + (wasFollowing ? 1 : -1)));
    } finally {
      setFollowBusy(false);
    }
  };

  /**
   * Bloquear y desbloquear.
   *
   * Bloquear pide confirmación porque el backend deshace además el seguimiento
   * en ambos sentidos: no es un cambio que convenga disparar por un roce con el
   * dedo. Al terminar se recarga el perfil, cuyos contadores han cambiado.
   */
  const toggleBlock = async (desdeLaHoja = false) => {
    if (!isRealPublic || !id) return;
    let autorizado = false;
    await requireAuth('auth.reasonBlock', () => {
      autorizado = true;
    });
    if (!autorizado) return;
    haptics.light();
    if (!blocked) {
      /*
        LA PREGUNTA NO PUEDE SALIR ENCIMA DE LA HOJA.

        Los `BottomSheet` son `Modal`, y en iOS no se presenta nada encima de un
        Modal que sigue en pantalla: el diálogo no aparece Y `confirm()` no
        resuelve nunca, así que la pantalla se queda congelada esperando una
        respuesta que nadie puede dar. Cerrar la hoja no basta, porque tiene
        animación de salida: hay que esperar a que termine.

        Es la trampa que ya dejó muertos los botones de subir historia y cambiar
        la foto de perfil, y este camino —menú «Opciones» → Bloquear— caía
        exactamente en ella. Desde el botón de la ficha no hay hoja abierta, así
        que no se espera nada.
      */
      if (desdeLaHoja) await afterSheetClose();
      const ok = await confirm({
        title: t('post.blockNamed', {
          nombre: publicProfile?.fullName ?? t('profile.thisPerson'),
        }),
        message: t('profile.blockBody'),
        confirmLabel: t('post.block'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      });
      // Cancelar NO deja nada a medias: se sale antes de tocar el estado y
      // antes de llamar al servidor.
      if (!ok) return;
    }
    const estaba = blocked;
    setBlockBusy(true);
    setBlocked(!estaba);
    try {
      if (estaba) await ProfileRepository.unblock(id);
      else await ProfileRepository.block(id);
      // Refresco de verdad: bloquear deshace seguimientos en ambos sentidos,
      // asi que los contadores guardados ya no valen.
      loadPublic(true);
    } catch {
      setBlocked(estaba);
      notify(
        estaba ? t('blocked.unblockFailed') : t('post.blockFailed'),
        t('common.tryAgainSoon'),
      );
    } finally {
      setBlockBusy(false);
    }
  };

  /**
   * Foto en edición: al tocar el avatar o la portada se abre la hoja de
   * opciones (galería / cámara / quitar), en vez de saltar directo al selector.
   */
  const [editingPhoto, setEditingPhoto] = useState<'avatar' | 'cover' | null>(null);

  const openPhotoSheet = (kind: 'avatar' | 'cover') => {
    haptics.light();
    setEditingPhoto(kind);
  };

  /*
    LO ELEGIDO ESPERA CONFIRMACION ANTES DE SUBIRSE. El recorte lo hace el
    editor NATIVO del sistema —`ImagePicker` con `allowsEditing`, no tematizable
    desde aqui—; esto es solo la confirmacion propia del paso siguiente.
  */
  const [porConfirmar, setPorConfirmar] = useState<
    { kind: 'avatar' | 'cover'; media: PickedMedia } | null
  >(null);
  const [subiendoFoto, setSubiendoFoto] = useState(false);
  const subiendoRef = React.useRef(false);

  const confirmarFoto = async () => {
    // Cerrojo sincrono: `subiendoFoto` no esta puesto hasta el siguiente
    // render, y dos toques rapidos caben de sobra en ese hueco.
    if (subiendoRef.current || !porConfirmar) return;
    subiendoRef.current = true;
    setSubiendoFoto(true);
    try {
      await setProfileImage(porConfirmar.kind, porConfirmar.media);
      setPorConfirmar(null);
    } catch (error) {
      setPorConfirmar(null);
      await afterSheetClose();
      notify(
        t('profile.photoChangeFailed'),
        error instanceof Error ? error.message : t('profile.checkPermissions'),
      );
    } finally {
      subiendoRef.current = false;
      setSubiendoFoto(false);
    }
  };

  const applyPhoto = async (source: 'gallery' | 'camera') => {
    const kind = editingPhoto;
    if (!kind) return;
    const aspect: [number, number] = kind === 'avatar' ? [1, 1] : [16, 9];
    try {
      /*
        La hoja se queda ABIERTA mientras se elige la foto, y se cierra despues.

        Cerrarla antes parecia lo natural, pero rompia el selector: iOS no deja
        presentar una pantalla nativa mientras otra se esta cerrando, y tras el
        primer intento el sistema quedaba en un estado del que no se recuperaba
        —funcionaba una vez y despues ya no abria nada, sin ningun error—.

        Abrir el selector ENCIMA de la hoja abierta es lo que ya hacian
        `CreateCatalogSheet` y `CreateTestimonialSheet`, que nunca dieron
        problemas.
      */
      const picked = source === 'gallery' ? await pickImage({ aspect }) : await takePhoto({ aspect });
      setEditingPhoto(null);
      if (!picked) return;
      // Se espera a que la hoja termine de cerrarse: presentar la confirmacion
      // sobre un Modal que se esta cerrando es el mismo problema que ya
      // documenta el bloque de arriba.
      await afterSheetClose();
      setPorConfirmar({ kind, media: picked });
    } catch (error) {
      // Si fallo antes de cerrar, la hoja sigue en pantalla: hay que cerrarla y
      // esperar, o el aviso quedaria invisible bajo ella (Modal sobre Modal).
      setEditingPhoto(null);
      await afterSheetClose();
      notify(
        error instanceof PermisoDenegadoError
          ? t('profile.permissionMissing')
          : t('profile.photoChangeFailed'),
        error instanceof Error ? error.message : t('profile.checkPermissions'),
      );
    }
  };

  const removePhoto = async () => {
    if (!editingPhoto) return;
    const kind = editingPhoto;
    setEditingPhoto(null);
    try {
      await setProfileImage(kind, null);
    } catch (error) {
      notify(
        t('profile.photoRemoveFailed'),
        error instanceof Error ? error.message : t('common.tryAgain'),
      );
    }
  };

  const openChat = async () => {
    // Escribir abre una conversacion, y una conversacion tiene dos partes.
    let autorizado = false;
    await requireAuth('auth.reasonMessage', () => {
      autorizado = true;
    });
    if (!autorizado) return;

    if (!id) return;
    // Dos toques seguidos creaban dos conversaciones: el cerrojo se mira ANTES
    // de pedir nada.
    if (chatBusy) return;
    setChatBusy(true);
    try {
      const conv = await MessageRepository.getOrCreateDirect(id);
      router.push({ pathname: '/chat/[id]', params: { id: conv.id, name: profileData.fullName } } as never);
    } catch {
      notify(t('profile.chatFailed'), t('common.tryAgain'));
    } finally {
      setChatBusy(false);
    }
  };

  /*
    CONFIRMAR LA FOTO ES UNA PANTALLA EXCLUSIVA.

    Devolucion temprana, no una capa encima: montada como hermana dentro del
    perfil, cualquier vista pintada DESPUES podia quedar por delante y quedarse
    los toques. Va aqui, despues de TODOS los hooks, para no alterar su orden.
  */
  if (porConfirmar) {
    return (
      <ConfirmarRecorte
        uri={porConfirmar.media.uri}
        forma={porConfirmar.kind === 'avatar' ? 'avatar' : 'portada'}
        ocupado={subiendoFoto}
        alConfirmar={() => void confirmarFoto()}
        alCancelar={() => {
          if (subiendoFoto) return;
          setPorConfirmar(null);
          // Vuelve al selector de foto, que es de donde se venia.
          setEditingPhoto(porConfirmar.kind);
        }}
      />
    );
  }

  // Perfil propio con backend real: carga/error mientras llega el perfil.
  if (!id && supabaseEnabled && !currentUser) {
    const state = profileError ? 'error' : authStatus === 'loading' ? 'loading' : 'empty';
    // Sin sesion no falta el perfil: falta entrar. Antes ambos casos mostraban
    // el mismo aviso y sin ninguna accion, asi que quien llegaba aqui sin
    // cuenta se quedaba atascado: se le pedia iniciar sesion sin ofrecer donde.
    const anonymous = authStatus === 'anonymous';
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader
          title={t('profile.title')}
          rightIcon="settings"
          onRightPress={() => router.push('/settings')}
        />
        <StateView
          state={state}
          onRetry={() => void refreshProfile()}
          icon={state === 'empty' && anonymous ? 'user' : undefined}
          title={
            state === 'empty'
              ? anonymous
                ? t('profile.signInTitle')
                : t('profile.unavailable')
              : undefined
          }
          description={
            state === 'empty'
              ? anonymous
                ? t('profile.signInBody')
                : t('profile.preparing')
              : undefined
          }
          actionLabel={
            state === 'empty' ? (anonymous ? t('auth.signIn') : t('common.retry')) : undefined
          }
          onAction={
            state === 'empty'
              ? anonymous
                ? () => router.push('/login' as never)
                : () => void refreshProfile()
              : undefined
          }
        />
      </View>
    );
  }

  /*
    Perfil público real que aún no ha llegado.

    Fallo: se enseña el aviso con su boton de reintentar, porque ahi no hay nada
    mejor que ofrecer.

    Espera: se enseña el ESQUELETO del perfil, no un indicador de carga suelto.
    La diferencia no es estetica. Un giro en mitad de una pantalla vacia no dice
    nada; unas formas donde van a ir la foto, el nombre y las miniaturas dicen
    «esto es un perfil y esta llegando», y cuando llega no hay salto porque las
    piezas ya estaban en su sitio. Ademas, la cuadricula real casi siempre esta
    lista antes que la ficha —son dos peticiones a la vez—, asi que este
    esqueleto dura lo que tarda la mas lenta, no la suma de las dos.
  */
  if (isRealPublic && publicState !== 'idle') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader
          title={t('profile.titlePublic')}
          onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        />
        {publicState === 'error' ? (
          <StateView state="error" onRetry={() => loadPublic(true)} />
        ) : (
          <EsqueletoDePerfil />
        )}
      </View>
    );
  }

  const profileData = isRealPublic
    ? {
        fullName: publicProfile?.fullName ?? '',
        username: publicProfile?.username ?? '',
        bio: publicProfile?.bio ?? '',
        followers: followersCount,
        following: publicProfile?.following ?? 0,
        posts: publicProfile?.posts ?? 0,
        likes: publicProfile?.likes ?? 0,
        introAudioPath: publicProfile?.introAudioPath ?? null,
        introAudioDurationS: publicProfile?.introAudioDurationS ?? null,
        avatar: 'avatar' as const,
      }
    : {
        // Sin datos reales no se inventa una identidad: antes caia a la
        // "Katherine Bejar" del demo y el usuario veia un perfil ajeno.
        fullName: currentUser?.fullName ?? '',
        username: currentUser?.username ?? '',
        bio: currentUser?.bio ?? '',
        followers: currentUser?.followers ?? 0,
        following: currentUser?.following ?? 0,
        posts: currentUser?.posts ?? 0,
        likes: currentUser?.likes ?? 0,
        introAudioPath: currentUser?.introAudioPath ?? null,
        introAudioDurationS: currentUser?.introAudioDurationS ?? null,
        avatar: 'avatar' as const,
      };

  /**
   * Perfil bloqueado por quien mira.
   *
   * NO ES «perfil inaccesible». La ficha sigue estando —foto, nombre, cifras—
   * y con ella el botón «Desbloquear»: si el perfil dejara de ser alcanzable,
   * quien se arrepiente de un bloqueo no tendría desde dónde deshacerlo, y la
   * única salida sería la lista de Ajustes, que casi nadie encuentra.
   *
   * Lo que sí desaparece es el CONTENIDO: descripción, audio, lo que ofrece,
   * las secciones y sus publicaciones. Es la mitad que faltaba: se ocultaban
   * los botones de seguir y escribir, pero debajo seguía todo lo demás.
   *
   * Solo en perfil ajeno: `blocked` no significa nada en el propio.
   */
  const perfilBloqueado = isPublic && blocked;

  // Foto a mostrar: en tu perfil, la tuya (local o backend); en uno ajeno, la
  // del perfil cargado. Sin foto, el placeholder de siempre.
  const coverUri = isPublic ? publicProfile?.coverUrl : currentUser?.coverUrl;
  const avatarUri = isPublic ? publicProfile?.avatarUrl : currentUser?.avatarUrl;
  const coverSource = coverUri ? { uri: coverUri } : assets.hero;
  const avatarSource = avatarUri ? { uri: avatarUri } : profileData.avatar;
  // "Quitar foto" solo tiene sentido si hay una elegida por el usuario.
  const hasCustomPhoto =
    editingPhoto === 'cover' ? !!currentUser?.coverUrl : !!currentUser?.avatarUrl;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        title={isPublic ? t('profile.titlePublic') : t('profile.title')}
        rightIcon="more-vertical"
        onRightPress={() => setOptionsVisible(true)}
        /*
          Atras SIEMPRE que se llegue por /profile/[id], aunque sea el perfil
          propio: esa ruta vive fuera de las pestañas, asi que sin este boton no
          hay barra inferior ni forma de salir. Solo la pestaña Perfil (sin id)
          se queda sin flecha, porque alli si esta la barra.
        */
        onBack={
          id ? () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/home')) : undefined
        }
      />
      <AppScreen contentStyle={{ paddingBottom: 120 }}>
        {/*
          Sin foto de portada. Ocupaba el primer tercio de la pantalla con una
          imagen que casi nadie cambiaba, y empujaba hacia abajo lo que de
          verdad identifica a la persona: su foto, sus cifras y su descripcion.
        */}
        <View style={[styles.profileBlock, { backgroundColor: colors.background }]}>
          {/*
            LA PERSONA PRIMERO.

            La foto va centrada y el nombre justo debajo, no una fila con la
            foto a un lado y tres cifras al otro. El perfil de Z tiene que
            leerse como la presentacion de alguien, no como una ficha
            administrativa: quien llega aqui viene a decidir si quiere hablar
            con esta persona, y para eso lo primero que necesita es verla.
          */}
          <View style={styles.identidad}>
            <Pressable
              onPress={isPublic ? undefined : () => openPhotoSheet('avatar')}
              disabled={isPublic}
              accessibilityRole={isPublic ? undefined : 'button'}
              accessibilityLabel={isPublic ? undefined : t('profile.changeAvatar')}
              style={({ pressed }) => ({ opacity: pressed && !isPublic ? 0.85 : 1 })}
            >
              <Avatar size={104} image={avatarSource} />
              {!isPublic && (
                <View
                  style={[
                    styles.avatarEditBtn,
                    { backgroundColor: colors.text, borderColor: colors.background },
                  ]}
                >
                  <Feather name="camera" size={13} color={colors.background} />
                </View>
              )}
            </Pressable>

            <Text style={[styles.name, styles.centrado, { color: colors.text }]}>
              {profileData.fullName}
            </Text>
            <Text style={[styles.username, styles.centrado, { color: colors.textMuted }]}>
              {profileData.username}
            </Text>
          </View>

          {/*
            SIGUIENDO · SEGUIDORES · ME GUSTA.

            «Me gusta» son los RECIBIDOS en sus publicaciones, no los que ha
            dado: cuantos ha repartido no dice nada de alguien para quien lo
            visita. Lo calcula el backend (`likes_count`), no el movil sumando
            lo que tenga cargado, que solo veria las publicaciones de la
            primera pagina.

            «Publicaciones» sale de aqui porque ya se cuenta sola: la galeria
            esta justo debajo.
          */}
          <View style={styles.metricas}>
            <Stat
              label={t('profile.following')}
              value={profileData.following}
              onPress={() => router.push(`/following/${id ?? 'me'}` as never)}
            />
            <Stat
              label={t('profile.followers')}
              value={profileData.followers}
              onPress={() => router.push(`/followers/${id ?? 'me'}` as never)}
            />
            <Stat label={t('profile.likes')} value={profileData.likes} />
          </View>

          {/*
            LOS BOTONES, JUSTO DEBAJO DE LAS CIFRAS.

            No están en la lista del orden pedido —que va de la foto al
            contenido— porque no son presentación: son la acción. Seguir y
            escribir se deciden en cuanto se sabe a quién se está mirando, así
            que quedan al alcance sin desplazar, y la presentación (descripción,
            audio, lo que aporta) sigue entera y sin cortes justo debajo.
          */}
          <View style={styles.actionRow}>
              {isPublic ? (
                blocked ? (
                  // Bloqueado: no tiene sentido ofrecer seguir ni escribir.
                  <Button
                    label={t('blocked.unblock')}
                    variant="secondary"
                    loading={blockBusy}
                    onPress={() => void toggleBlock()}
                    style={styles.actionBtn}
                  />
                ) : (
                  <React.Fragment>
                    <Button
                      label={following ? t('profile.unfollow') : t('profile.follow')}
                      variant={following ? 'secondary' : 'primary'}
                      loading={followBusy}
                      onPress={toggleFollow}
                      style={styles.actionBtn}
                    />
                    <Button
                      label={t('profile.message')}
                      variant="secondary"
                      loading={chatBusy}
                      onPress={openChat}
                      style={styles.actionBtn}
                    />
                    <Pressable
                      onPress={() => void toggleBlock()}
                      disabled={blockBusy}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={t('profile.blockPerson')}
                      style={[styles.blockBtn, { borderColor: colors.border }]}
                    >
                      <Feather name="slash" size={17} color={colors.textMuted} />
                    </Pressable>
                  </React.Fragment>
                )
              ) : (
                <Button
                  label={t('profile.editProfile')}
                  variant="secondary"
                  onPress={() => router.push('/edit-profile' as never)}
                  style={styles.actionBtn}
                />
              )}
          </View>

          {/*
            PERFIL BLOQUEADO: LO MINIMO PARA PODER DESHACERLO, Y NADA MAS.

            La ficha (foto, nombre, cifras) y el botón «Desbloquear» siguen ahí
            —si el perfil dejara de ser alcanzable no habría desde dónde
            desbloquear, y quien se arrepiente de un bloqueo se quedaría sin
            salida—, pero lo que el bloqueo esconde sigue escondido: su
            descripción, su audio, lo que ofrece, sus secciones y sus
            publicaciones.

            Enseñarlo aquí no sería solo incoherente con la pantalla: el
            servidor ya corta ese contenido en los dos sentidos, así que las
            secciones volverían vacías y el perfil parecería el de alguien que
            nunca ha publicado nada. Es mejor decir por qué no hay nada.
          */}
          {perfilBloqueado ? (
            <View style={styles.bloqueado}>
              <Feather name="slash" size={26} color={colors.textMuted} />
              <Text style={[styles.bloqueadoTitulo, { color: colors.text }]}>
                {t('profile.blockedTitle')}
              </Text>
              <Text style={[styles.bloqueadoTexto, { color: colors.textMuted }]}>
                {t('profile.blockedBody')}
              </Text>
            </View>
          ) : (
            <React.Fragment>
          {/*
            LA DESCRIPCIÓN, CENTRADA Y DEBAJO DE LAS CIFRAS.

            ESTE ORDEN SUSTITUYE AL ANTERIOR. Aquí había un comentario diciendo
            que «el audio va ANTES de la descripción, como pedía el documento»:
            ese requisito cambió y el comentario ya no era verdad. Ahora manda
            el texto —es lo primero que se lee sin decidir nada, sin sonido y
            sin esperar a que cargue— y el audio va justo después, que es donde
            se busca cuando el texto ha despertado interés.

            El ancho está limitado a propósito: un texto centrado que llega de
            borde a borde obliga a buscar dónde empieza cada línea. Y si la
            descripción se pasa de larga se alinea a la izquierda —ver
            `alineacionDeLaBio`—, porque a partir de unas pocas líneas centrar
            deja de ser elegante y pasa a ser incómodo de leer.
          */}
          {profileData.bio ? (
            <Text
              style={[
                styles.bio,
                { color: colors.text, textAlign: bioLarga ? 'left' : 'center' },
              ]}
              onTextLayout={(evento) => {
                // Se mide lo que de verdad se pintó, no se adivina por el
                // número de caracteres: la misma frase ocupa distinto en un
                // teléfono estrecho, en una tableta o con la letra del sistema
                // agrandada.
                const lineas = evento.nativeEvent.lines.length;
                setBioLarga((previo) => {
                  const siguiente = lineas > LINEAS_CENTRADAS;
                  return previo === siguiente ? previo : siguiente;
                });
              }}
            >
              {profileData.bio}
            </Text>
          ) : null}

          {/*
            EL AUDIO DE PRESENTACIÓN, DESPUÉS DE LA DESCRIPCIÓN.

            Va dentro de este bloque y no fuera porque es contenido de la
            persona: en un perfil bloqueado desaparece con todo lo demás, en vez
            de repetir aquí la comprobación del bloqueo.
          */}
          <AudioDePresentacion
            rutaDelAudio={profileData.introAudioPath}
            duracionS={profileData.introAudioDurationS}
            esPropio={!isPublic}
            nombre={profileData.fullName}
          />

          {/*
            LO QUE ESTA PERSONA PUEDE APORTAR.

            Va detras de la presentacion —audio y descripcion— y delante de los
            accesos a Podcast, Cursos, Reseñas y Agenda. Ese orden no es
            casual: quien llega a un perfil viene decidiendo si quiere hablar
            con alguien, y los temas que declara aportar son la ultima pieza de
            esa respuesta; los accesos de abajo ya son el «donde» —su podcast,
            sus cursos, su agenda—, y tienen mas sentido cuando ya se sabe de
            que sabe. Justo encima de «Agenda» tambien es donde mas ayuda:
            pedir una sesion se decide por el tema.
          */}
          {galleryOwnerId ? (
            <OfertaDelPerfil perfilId={galleryOwnerId} esPropio={!isPublic} />
          ) : null}

          {/* TODO: Reactivar el shortcut "Círculos" (icon="users") cuando el perfil alcance un umbral de seguidores */}
          <View style={styles.shortcuts}>
            <Shortcut
              icono={{ familia: 'feather', nombre: 'headphones' }}
              label={t('profile.podcast')}
              active={activeSection === 'podcast'}
              onPress={() => setActiveSection((v) => (v === 'podcast' ? null : 'podcast'))}
            />
            <Shortcut
              icono={{ familia: 'feather', nombre: 'book' }}
              label={t('profile.courses')}
              active={activeSection === 'cursos'}
              onPress={() => setActiveSection((v) => (v === 'cursos' ? null : 'cursos'))}
            />
            {/*
              UNAS COMILLAS, NO UNA ESTRELLA.

              Antes fue una cámara —que decía «fotos», por la galería que vivía
              empotrada aquí dentro— y después una estrella. La estrella se
              cambia porque no significa esto: una estrella es una PUNTUACIÓN
              (cuántas de cinco), o un favorito, o algo destacado. Lo que hay en
              esta sección son opiniones escritas por otras personas, y el signo
              universal de «alguien dijo esto» son las comillas.

              `format-quote-close` es literalmente el glifo ”, y viene de
              MaterialCommunityIcons, que ya está dentro de `@expo/vector-icons`
              —el mismo paquete que Feather—: no se instala nada. Sigue siendo
              vectorial, así que entra en el mismo círculo que Podcast, Cursos y
              Agenda y se tiñe con los mismos tokens.
            */}
            <Shortcut
              icono={{ familia: 'material', nombre: 'format-quote-close' }}
              label={t('profile.testimonials')}
              active={activeSection === 'testimonios'}
              onPress={() => setActiveSection((v) => (v === 'testimonios' ? null : 'testimonios'))}
            />
            {/*
              «Agenda» en el perfil propio abre TU agenda —lo que te piden y lo
              que has pedido—; en el de otra persona, la solicitud. Antes solo
              existia lo segundo: se podia pedir una sesion pero no habia donde
              ver las que te pedian a ti.

              NUNCA SE OFRECE AGENDAR EN EL PROPIO PERFIL: una sesión son dos
              personas. El servidor lo rechaza además (`booking_self_not_allowed`);
              esto solo evita ofrecer algo que iba a fallar.

              «Activa» mientras la hoja de solicitud está abierta: es el único
              estado que este acceso tiene: en el perfil propio navega fuera, y
              de una pantalla a la que se va no se vuelve con un círculo marcado.
            */}
            <Shortcut
              icono={{ familia: 'feather', nombre: 'calendar' }}
              label={t('profile.bookSession')}
              active={isPublic && bookingVisible}
              onPress={() =>
                isPublic ? setBookingVisible(true) : router.push('/agenda' as never)
              }
            />
          </View>

          {activeSection ? (
            <ProfileSection
              kind={activeSection}
              /*
                EL DUEÑO DEL PERFIL, con su nombre dicho. Todo lo de dentro se
                pide sobre él: sus cursos, sus episodios y —sobre todo— las
                reseñas que ha recibido.
              */
              profileOwnerId={galleryOwnerId}
              /*
                IDENTIDAD, no permiso. `isOwnProfile` decide los textos en
                primera persona y quién puede escribir una reseña; el permiso de
                moderar lo resuelve `ProfileSection` por su cuenta. Usar uno por
                el otro es lo que hacía que en el perfil de otra persona se
                leyera «Aún no tienes reseñas».
              */
              isOwnProfile={!isPublic}
              /* Para poder decir sobre quién se está escribiendo la reseña. */
              profileOwnerName={profileData.fullName}
              ownerIsAdmin={
                isRealPublic ? publicProfile?.isAdmin === true : currentUser?.isAdmin === true
              }
            />
          ) : (
          /* Publicaciones reales del perfil: fotos/videos. */
          <ProfileGallery
            gallery={gallery}
            audios={audios}
            loading={postsLoading}
            error={postsError}
            emptyHint={
              isPublic ? t('profile.emptyGalleryOther') : t('profile.emptyGalleryOwn')
            }
          />
          )}
            </React.Fragment>
          )}
        </View>
      </AppScreen>

      {/*
        NUNCA CONSIGO MISMO. `bookingVisible` solo se enciende desde el acceso
        de un perfil ajeno, pero la condición se escribe aquí también: esta hoja
        se monta siempre y su `targetUser` cae en la persona conectada cuando el
        perfil es el propio. Sin este `isPublic`, cualquier camino futuro que
        encendiera el estado abriría una solicitud de sesión de alguien consigo
        mismo — que el servidor rechaza (`booking_self_not_allowed`), pero
        después de haber rellenado el formulario entero.
      */}
      <BookSessionSheet
        visible={bookingVisible && isPublic}
        onClose={() => setBookingVisible(false)}
        targetUser={{
          id: galleryOwnerId ?? id ?? '',
          fullName: profileData.fullName,
        }}
      />

      <BottomSheet visible={optionsVisible} onClose={() => setOptionsVisible(false)}>
        <Text style={[styles.sheetTitle, { color: colors.text }]}>{t('profile.opciones')}</Text>
        <ListRow
          title={t('profile.saved')}
          leftIcon="bookmark"
          onPress={() => {
            setOptionsVisible(false);
            router.push('/saved' as never);
          }}
        />
        {/*
          LA GALERIA, EN SU SITIO.

          Estaba empotrada dentro de «Reseñas» —«Su galería», «Añadir a la
          galería» y un Todos / Fotos / Vídeos debajo de las opiniones de otras
          personas—, que es lo que hacía creer que publicar ahí era opinar sobre
          alguien. Es contenido real y con filas de gente real, así que no se
          borra: se saca de donde no pertenecía y se le da su propia entrada.

          Aquí y no en un quinto círculo: los accesos circulares son las cuatro
          secciones del perfil (Podcast, Cursos, Reseñas, Agenda) y añadir una
          quinta apretaría la fila para algo que no es de ese rango.
        */}
        {perfilBloqueado ? null : (
          <ListRow
            title={isPublic ? t('profile.galleryOther') : t('profile.galleryOwn')}
            leftIcon="image"
            onPress={() => {
              setOptionsVisible(false);
              setActiveSection('galeria');
            }}
          />
        )}
        {!isPublic ? (
          <React.Fragment>
            {/*
              PRODUCTOS Z, DESDE EL PERFIL.

              Aquí y no en los accesos circulares —que son las cuatro secciones
              del perfil— por el mismo motivo que la galería: no es de ese
              rango, y añadir un quinto círculo apretaría la fila.

              A DÓNDE LLEVA LO DICE EL CONTRATO, no un rol adivinado. Quien ya
              es responsable comercial va a sus productos; quien no, a postular.
              `pending` y `suspended` NO son «casi activo»: el servidor los
              rechaza, así que mandarlos a crear un producto sería mandarlos a
              un 403. Mientras no se sepa, la fila no se pinta.
            */}
            {estadoDeProveedor !== null ? (
              <ListRow
                title={
                  esProveedorActivo(estadoDeProveedor)
                    ? t('proveedorProductos.productos.titulo')
                    : t('proveedorProductos.marca.postula')
                }
                leftIcon="package"
                onPress={() => {
                  setOptionsVisible(false);
                  router.push(rutaDelProveedor(estadoDeProveedor) as never);
                }}
              />
            ) : null}
            {/*
              MIS EVENTOS. Se había quedado sin ningún enlace desde que salió
              el acceso «Eventos» de la fila circular: el alta, las entradas,
              las ventas y la cola de revisión solo se abrían escribiendo la
              ruta. Vuelve aquí y como «Organiza un evento» en Eventos.
            */}
            <ListRow
              title={t('misEventos.titulo')}
              leftIcon="calendar"
              onPress={() => {
                setOptionsVisible(false);
                router.push('/mis-eventos' as never);
              }}
            />
            {/*
              ADMINISTRACIÓN, en un solo sitio. Las colas estaban colgadas unas
              de otras (Perfil › Mis eventos › Eventos por revisar › Productos…)
              y la de cursos ni existía. Se pinta con `isAdmin` para no poner
              una puerta inútil a todo el mundo; el permiso lo sigue decidiendo
              el servidor en cada cola.
            */}
            {esAdministracion ? (
              <ListRow
                title={t('panelAdmin.titulo')}
                leftIcon="shield"
                onPress={() => {
                  setOptionsVisible(false);
                  router.push('/admin' as never);
                }}
              />
            ) : null}
            <ListRow
              title={t('profile.editProfile')}
              leftIcon="edit-3"
              onPress={() => {
                setOptionsVisible(false);
                router.push('/edit-profile' as never);
              }}
            />
            <ListRow
              title={t('settings.title')}
              leftIcon="settings"
              onPress={() => {
                setOptionsVisible(false);
                router.push('/settings');
              }}
            />
          </React.Fragment>
        ) : (
          /*
            Bloquear o DESBLOQUEAR, según cómo esté.

            Antes, estando bloqueado, este menú no ofrecía nada: la única salida
            era el botón de arriba, y si algún día deja de estar ahí no queda
            ninguna. Deshacer algo tiene que estar donde se hizo.

            Desbloquear NO es destructivo y no pregunta: devuelve las cosas a
            como estaban y se puede volver a bloquear en un toque. Bloquear sí
            pregunta (ver `toggleBlock`), porque además deshace el seguimiento
            en los dos sentidos y eso no se recupera solo.
          */
          <ListRow
            title={blocked ? t('profile.unblockPerson') : t('profile.blockPerson')}
            leftIcon={blocked ? 'user-check' : 'slash'}
            destructive={!blocked}
            onPress={() => {
              setOptionsVisible(false);
              // `true`: viene de una hoja, así que la pregunta tiene que esperar
              // a que se cierre. Ver `toggleBlock`.
              void toggleBlock(true);
            }}
          />
        )}
      </BottomSheet>

      <BottomSheet visible={editingPhoto !== null} onClose={() => setEditingPhoto(null)}>
        <Text style={[styles.sheetTitle, { color: colors.text }]}>
          {editingPhoto === 'cover' ? t('profile.coverPhoto') : t('profile.avatarPhoto')}
        </Text>
        <ListRow
          title={t('profile.pickFromGallery')}
          leftIcon="image"
          onPress={() => void applyPhoto('gallery')}
        />
        <ListRow
          title={t('profile.takePhoto')}
          leftIcon="camera"
          onPress={() => void applyPhoto('camera')}
        />
        {hasCustomPhoto && (
          <ListRow
            title={t('profile.removePhoto')}
            leftIcon="trash-2"
            destructive
            onPress={removePhoto}
          />
        )}
      </BottomSheet>
    </View>
  );
}

/**
 * El perfil antes de que llegue el perfil.
 *
 * Solo formas: el circulo de la foto, dos lineas de identidad, las tres cifras
 * y tres filas de cuadricula. Ni texto inventado ni cifras a cero, que se leen
 * como datos reales y equivocados.
 *
 * El lado de las celdas se mide igual que en la galeria de verdad
 * (`gridItemSize`), asi que al llegar las publicaciones ocupan exactamente
 * estos huecos y nada se mueve.
 */
function EsqueletoDePerfil() {
  const { colors } = useAppTheme();
  const [ancho, setAncho] = useState(0);
  const lado = gridItemSize(ancho);
  const hueco = { backgroundColor: colors.surfaceAlt };

  return (
    <View style={styles.profileBlock} pointerEvents="none" accessibilityElementsHidden>
      <View style={styles.identidad}>
        <View style={[styles.esqAvatar, hueco]} />
        <View style={[styles.esqLinea, { width: 160, height: 18, marginTop: spacing.sm }, hueco]} />
        <View style={[styles.esqLinea, { width: 100, height: 12, marginTop: 6 }, hueco]} />
      </View>

      <View style={styles.metricas}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={styles.statBox}>
            <View style={[styles.esqLinea, { width: 40, height: 14 }, hueco]} />
            <View style={[styles.esqLinea, { width: 56, height: 10, marginTop: 6 }, hueco]} />
          </View>
        ))}
      </View>

      <View style={styles.actionRow}>
        <View style={[styles.esqBoton, hueco]} />
        <View style={[styles.esqBoton, hueco]} />
      </View>

      <View
        style={[styles.esqGrid, { gap: GRID_GAP }]}
        onLayout={(event) => setAncho(event.nativeEvent.layout.width)}
      >
        {lado === 0
          ? null
          : Array.from({ length: GRID_COLUMNS * 3 }, (_, i) => (
              <View key={i} style={[{ width: lado, height: lado }, hueco]} />
            ))}
      </View>
    </View>
  );
}

function Stat({ label, value, onPress }: { label: string; value: number; onPress?: () => void }) {
  const { colors } = useAppTheme();
  const display = value >= 1000000 ? `${(value / 1000000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value);
  const content = (
    <React.Fragment>
      <Text style={{ color: colors.text, fontWeight: '800', fontSize: 16 }}>{display}</Text>
      <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>{label}</Text>
    </React.Fragment>
  );

  if (!onPress) {
    return <View style={styles.statBox}>{content}</View>;
  }

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.statBox, { opacity: pressed ? 0.7 : 1 }]}
      accessibilityRole="button"
      accessibilityLabel={`Ver ${label}`}
    >
      {content}
    </Pressable>
  );
}

/**
 * Uno de los accesos circulares del perfil (Podcast · Cursos · Reseñas · Agenda).
 *
 * QUE FALTABA: NO SE VEIA CUAL ESTABA ABIERTO. Los cuatro se pintaban iguales
 * pasara lo que pasara, así que al tocar «Cursos» el contenido de abajo cambiaba
 * y arriba no cambiaba nada: había que deducir en qué sección se estaba leyendo
 * lo que había debajo. Y como tocar el mismo círculo lo CIERRA —vuelve a la
 * galería de publicaciones—, tampoco se veía si el siguiente toque iba a abrir
 * o a cerrar.
 *
 * COMO SE DICE, y no es solo color:
 *
 *   - el círculo se invierte (relleno `primary`, icono `onPrimary`),
 *   - la etiqueta pasa a negrita,
 *   - y `accessibilityState.selected` lo anuncia a los lectores de pantalla.
 *
 * Las tres a la vez porque la regla del sistema visual es que el color nunca
 * puede ser el único portador de información: aquí además el sistema es blanco
 * y negro estricto, así que «lo activo» tiene que leerse igual en escala de
 * grises. Los tokens del tema hacen el resto: en claro el activo es negro sobre
 * blanco y en oscuro blanco sobre negro, sin una sola condición escrita aquí y
 * sin un hex suelto.
 */
function Shortcut({
  icono,
  label,
  onPress,
  active = false,
}: {
  icono: IconoDeAcceso;
  label: string;
  onPress: () => void;
  active?: boolean;
}) {
  const { colors } = useAppTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [styles.shortcutItem, { opacity: pressed ? 0.8 : 1 }]}
    >
      <View
        style={[
          styles.shortcutIcon,
          {
            backgroundColor: active ? colors.primary : colors.surfaceAlt,
            borderColor: active ? colors.primary : colors.border,
          },
        ]}
      >
        {icono.familia === 'feather' ? (
          <Feather
            name={icono.nombre}
            size={20}
            color={active ? colors.onPrimary : colors.text}
          />
        ) : (
          <MaterialCommunityIcons
            name={icono.nombre}
            /*
              Un punto más grande que los de Feather a propósito: el glifo de las
              comillas ocupa menos alto que un icono de trazo, y al mismo tamaño
              nominal se veía más pequeño que sus tres vecinos dentro del mismo
              círculo.
            */
            size={22}
            color={active ? colors.onPrimary : colors.text}
          />
        )}
      </View>
      <Text style={{ color: colors.text, fontSize: 11, fontWeight: active ? '800' : '500' }}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Badge sólido con borde del color del fondo: se lee sobre cualquier foto.
  avatarEditBtn: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetTitle: {
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  profileBlock: { padding: spacing.lg },
  identidad: { alignItems: 'center', gap: spacing.xs },
  centrado: { textAlign: 'center' },
  /*
    Las tres cifras, SIN reglas ni separadores.

    Antes iban encerradas entre dos lineas horizontales y partidas por dos
    verticales. Dibujaban una tabla en medio del perfil: cuatro trazos para
    separar tres numeros que ya se separan solos por el espacio, y que ademas
    competian visualmente con la unica linea que si significa algo (la que abre
    la galeria). La separacion la hace el reparto en tres partes iguales.
  */
  metricas: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.lg,
    paddingVertical: spacing.md,
  },
  actionRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  blockBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtn: { minWidth: 100, minHeight: 40, height: 40 },
  // `stats` se conserva: lo usa la ficha de otros perfiles.
  name: { fontSize: 21, fontWeight: '900', marginTop: spacing.sm },
  username: { fontSize: 13, marginTop: 2 },
  statBox: { alignItems: 'center', flex: 1 },
  /*
    El ancho tope y el centrado del BLOQUE van aquí; la alineación del TEXTO
    dentro se decide al pintarlo, según cuántas líneas ocupe.

    420 no es un número al azar: es lo ancho que puede ser una columna de texto
    de 13 puntos sin que la vista tenga que saltar buscando el principio de la
    línea siguiente. En un teléfono no llega a aplicarse —la pantalla es más
    estrecha— y en tableta o en web impide que la descripción se estire de borde
    a borde.
  */
  bio: {
    fontSize: 13,
    lineHeight: 19,
    marginTop: spacing.md,
    marginBottom: spacing.lg,
    maxWidth: 420,
    alignSelf: 'center',
  },
  // Lo que se lee en lugar del contenido de un perfil bloqueado. Con ICONO y
  // TEXTO, no con un hueco: una pantalla vacia se lee como «esta persona no ha
  // publicado nada», que es justo lo que no ha pasado.
  bloqueado: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.md,
  },
  bloqueadoTitulo: { fontSize: 15, fontWeight: '800', textAlign: 'center' },
  bloqueadoTexto: { fontSize: 13, lineHeight: 18, textAlign: 'center' },
  audioBtn: { width: '100%', marginBottom: spacing.lg },
  shortcuts: { flexDirection: 'row', marginVertical: spacing.md, gap: spacing.sm },
  shortcutItem: { alignItems: 'center', gap: 6, flex: 1 },
  shortcutIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  // Formas de la espera. Mismas medidas que las piezas que sustituyen.
  esqAvatar: { width: 104, height: 104, borderRadius: 52 },
  esqLinea: { borderRadius: radius.sm },
  esqBoton: { flex: 1, height: 40, borderRadius: radius.md },
  esqGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: spacing.xxl },
});
