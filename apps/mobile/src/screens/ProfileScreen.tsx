import React, { useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { afterSheetClose } from '@/lib/afterSheetClose';
import { confirm, notify } from '@/lib/confirm';
import { useRouter, useLocalSearchParams } from 'expo-router';

import { perfilVisto } from '@/services/senales';

import { haptics } from '@/lib/haptics';
import { Feather } from '@expo/vector-icons';

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
import { ProfileRepository } from '@/repositories/ProfileRepository';
import { PermisoDenegadoError, pickImage, takePhoto } from '@/services/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { UserProfile } from '@/types';

export function ProfileScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const { id, section } = useLocalSearchParams<{ id?: string; section?: string }>();

  const currentUser = useAppStore((state) => state.user);
  const setProfileImage = useAppStore((state) => state.setProfileImage);
  const authStatus = useAuthStore((state) => state.status);
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const signedIn = useAuthStore((state) => state.status === 'authenticated');
  // Seguir, escribir y bloquear necesitan cuenta: se pide al usarlos.
  const requireAuth = useRequireAuth();
  // 'anonymous' es distinto de 'todavia no lo se': al arrancar el estado pasa
  // por 'loading', y ahi no se debe dar por hecho que no hay cuenta.
  const anonimo = useAuthStore((state) => state.status === 'anonymous');
  const profileError = useAuthStore((state) => state.profileError);
  const refreshProfile = useAuthStore((state) => state.refreshProfile);

  // Tipos de perfil: propio (sin id), Darren (demo), o público real (uuid).
  const isDarren = id === 'darren';
  const isRealPublic = !!id && !isDarren && id !== currentUser?.id;
  const isPublic = isDarren || isRealPublic;

  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [followersCount, setFollowersCount] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const [blockBusy, setBlockBusy] = useState(false);
  const [bookingVisible, setBookingVisible] = useState(false);
  const [optionsVisible, setOptionsVisible] = useState(false);
  /**
   * Seccion activa bajo los accesos circulares. Llega por parametro desde las
   * tarjetas de Inicio (Eventos / Cursos) y tambien se cambia tocando los
   * circulos. `null` = la galeria de publicaciones.
   */
  const [activeSection, setActiveSection] = useState<ProfileSectionKind | null>(null);

  /**
   * Sincroniza la seccion con el parametro de la ruta.
   *
   * Antes se leia solo en el valor inicial de `useState`, que se calcula una
   * vez: si la pantalla ya estaba montada (por ejemplo tras visitar el
   * podcast), pulsar "Eventos" en el inicio cambiaba la URL pero seguia
   * enseñando la seccion anterior.
   */
  useEffect(() => {
    const valid: ProfileSectionKind[] = ['eventos', 'cursos', 'podcast', 'testimonios'];
    setActiveSection(
      valid.includes(section as ProfileSectionKind) ? (section as ProfileSectionKind) : null,
    );
  }, [section, id]);

  const [publicProfile, setPublicProfile] = useState<UserProfile | null>(null);
  const [publicState, setPublicState] = useState<'loading' | 'error' | 'idle'>('loading');

  // Publicaciones del perfil que se esta viendo (el propio o el de otro).
  const galleryOwnerId = isRealPublic ? id : currentUser?.id;
  const {
    gallery,
    audios,
    loading: postsLoading,
    error: postsError,
  } = useProfilePosts(isDarren ? null : galleryOwnerId);

  const loadPublic = React.useCallback(() => {
    if (!isRealPublic || !id) return;
    setPublicState('loading');
    ProfileRepository.getById(id)
      .then((p) => {
        setPublicProfile(p);
        setFollowing(p.isFollowing ?? false);
        setBlocked(p.isBlocked ?? false);
        setFollowersCount(p.followers);
        setPublicState('idle');
      })
      .catch(() => setPublicState('error'));
  }, [id, isRealPublic]);

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

    const nombre = isDarren
      ? 'Darren'
      : publicProfile?.fullName?.split(' ')[0] ?? 'esta persona';

    // Un respiro antes de preguntar. Da tiempo a que el dialogo propio de la
    // aplicacion este montado —si no, se cae al del navegador, que anuncia
    // "localhost dice" y no se puede dar estilo— y evita que la invitacion
    // aparezca encima de una pantalla a medio pintar.
    const temporizador = setTimeout(() => {
      void (async () => {
        const entrar = await confirm({
          title: `Descubre el contenido de ${nombre}`,
          message:
            'Inicia sesión o crea tu cuenta para ver sus publicaciones, cursos y ' +
            'episodios completos, y para escribirle.',
          confirmLabel: 'Crear cuenta',
          cancelLabel: 'Seguir mirando',
        });
        if (entrar) router.push('/register' as never);
      })();
    }, 700);
    return () => clearTimeout(temporizador);
  }, [isPublic, supabaseEnabled, anonimo, id, isDarren, isRealPublic, publicProfile, router]);

  const toggleFollow = async () => {
    haptics.light();
    // Seguir queda registrado a nombre de alguien: primero la cuenta.
    let autorizado = false;
    await requireAuth('para seguir a esta persona', () => {
      autorizado = true;
    });
    if (!autorizado) return;

    if (isDarren) {
      setFollowing((v) => !v);
      return;
    }
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
  const toggleBlock = async () => {
    if (!isRealPublic || !id) return;
    let autorizado = false;
    await requireAuth('para bloquear a alguien', () => {
      autorizado = true;
    });
    if (!autorizado) return;
    haptics.light();
    if (!blocked) {
      const ok = await confirm({
        title: `Bloquear a ${publicProfile?.fullName ?? 'esta persona'}`,
        message:
          'Dejaréis de seguiros y no volverás a ver sus publicaciones. ' +
          'Puedes deshacerlo cuando quieras desde Ajustes.',
        confirmLabel: 'Bloquear',
        destructive: true,
      });
      if (!ok) return;
    }
    const estaba = blocked;
    setBlockBusy(true);
    setBlocked(!estaba);
    try {
      if (estaba) await ProfileRepository.unblock(id);
      else await ProfileRepository.block(id);
      await loadPublic();
    } catch {
      setBlocked(estaba);
      notify(
        estaba ? 'No se pudo desbloquear' : 'No se pudo bloquear',
        'Inténtalo de nuevo en unos momentos.',
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

  /** Recorte cuadrado para el avatar y panorámico para la portada. */
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
      await setProfileImage(kind, picked);
    } catch (error) {
      // Si fallo antes de cerrar, la hoja sigue en pantalla: hay que cerrarla y
      // esperar, o el aviso quedaria invisible bajo ella (Modal sobre Modal).
      setEditingPhoto(null);
      await afterSheetClose();
      notify(
        error instanceof PermisoDenegadoError ? 'Falta un permiso' : 'No se pudo cambiar la foto',
        error instanceof Error
          ? error.message
          : 'Revisa los permisos e inténtalo de nuevo.',
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
        'No se pudo quitar la foto',
        error instanceof Error ? error.message : 'Inténtalo de nuevo.',
      );
    }
  };

  const openChat = async () => {
    // Escribir abre una conversacion, y una conversacion tiene dos partes.
    let autorizado = false;
    await requireAuth('para enviar un mensaje', () => {
      autorizado = true;
    });
    if (!autorizado) return;

    if (isDarren) {
      router.push('/chat/darren' as never);
      return;
    }
    if (!id) return;
    try {
      const conv = await MessageRepository.getOrCreateDirect(id);
      router.push({ pathname: '/chat/[id]', params: { id: conv.id, name: profileData.fullName } } as never);
    } catch {
      notify('No se pudo abrir el chat', 'Inténtalo de nuevo.');
    }
  };

  // Perfil propio con backend real: carga/error mientras llega el perfil.
  if (!id && supabaseEnabled && !currentUser) {
    const state = profileError ? 'error' : authStatus === 'loading' ? 'loading' : 'empty';
    // Sin sesion no falta el perfil: falta entrar. Antes ambos casos mostraban
    // el mismo aviso y sin ninguna accion, asi que quien llegaba aqui sin
    // cuenta se quedaba atascado: se le pedia iniciar sesion sin ofrecer donde.
    const anonymous = authStatus === 'anonymous';
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="MI PERFIL" rightIcon="settings" onRightPress={() => router.push('/settings')} />
        <StateView
          state={state}
          onRetry={() => void refreshProfile()}
          icon={state === 'empty' && anonymous ? 'user' : undefined}
          title={
            state === 'empty' ? (anonymous ? 'Entra a tu cuenta' : 'Perfil no disponible') : undefined
          }
          description={
            state === 'empty'
              ? anonymous
                ? 'Inicia sesión para ver tu perfil, publicar y seguir a otras personas.'
                : 'Estamos preparando tu perfil. Inténtalo de nuevo en un momento.'
              : undefined
          }
          actionLabel={state === 'empty' ? (anonymous ? 'Iniciar sesión' : 'Reintentar') : undefined}
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

  // Perfil público real: carga/error.
  if (isRealPublic && publicState !== 'idle') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title="PERFIL" onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <StateView state={publicState === 'error' ? 'error' : 'loading'} onRetry={loadPublic} />
      </View>
    );
  }

  const profileData = isDarren
    ? {
        fullName: 'Darren Hardy',
        username: '@darrenhardy',
        bio: 'Mentor de líderes. Autor de The Compound Effect. Te enseño a multiplicar tu productividad y alcanzar tu potencial.',
        followers: 1200000,
        following: 42,
        posts: 180,
        likes: 0,
        introAudioPath: null as string | null,
        introAudioDurationS: null as number | null,
        avatar: 'speaker' as const,
      }
    : isRealPublic
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
              accessibilityLabel={isPublic ? undefined : 'Cambiar foto de perfil'}
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
              label="Siguiendo"
              value={profileData.following}
              onPress={() => router.push(`/following/${id ?? 'me'}` as never)}
            />
            <Stat
              label="Seguidores"
              value={profileData.followers}
              onPress={() => router.push(`/followers/${id ?? 'me'}` as never)}
            />
            <Stat label="Me gusta" value={profileData.likes} />
          </View>

          {/*
            El audio va ANTES de la descripcion, como pedia el documento. Es lo
            que mas dice de una persona en menos tiempo, y detras del texto casi
            nadie llegaria a el.
          */}
          <AudioDePresentacion
            rutaDelAudio={profileData.introAudioPath}
            duracionS={profileData.introAudioDurationS}
            esPropio={!isPublic}
            nombre={profileData.fullName}
          />

          <View style={styles.actionRow}>
              {isPublic ? (
                blocked ? (
                  // Bloqueado: no tiene sentido ofrecer seguir ni escribir.
                  <Button
                    label="Desbloquear"
                    variant="secondary"
                    loading={blockBusy}
                    onPress={toggleBlock}
                    style={styles.actionBtn}
                  />
                ) : (
                  <React.Fragment>
                    <Button
                      label={following ? 'Siguiendo' : 'Seguir'}
                      variant={following ? 'secondary' : 'primary'}
                      loading={followBusy}
                      onPress={toggleFollow}
                      style={styles.actionBtn}
                    />
                    <Button
                      label="Mensaje"
                      variant="secondary"
                      onPress={openChat}
                      style={styles.actionBtn}
                    />
                    <Pressable
                      onPress={toggleBlock}
                      disabled={blockBusy}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel="Bloquear a esta persona"
                      style={[styles.blockBtn, { borderColor: colors.border }]}
                    >
                      <Feather name="slash" size={17} color={colors.textMuted} />
                    </Pressable>
                  </React.Fragment>
                )
              ) : (
                <Button
                  label="Editar perfil"
                  variant="secondary"
                  onPress={() => router.push('/edit-profile' as never)}
                  style={styles.actionBtn}
                />
              )}
          </View>

          {profileData.bio ? (
            <Text style={[styles.bio, { color: colors.text }]}>{profileData.bio}</Text>
          ) : null}

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

            Darren queda fuera: es un perfil de demostracion sin uuid, y pedir
            su oferta al backend seria un 404 seguro.
          */}
          {!isDarren && galleryOwnerId ? (
            <OfertaDelPerfil perfilId={galleryOwnerId} esPropio={!isPublic} />
          ) : null}

          {isDarren && (
            <Button
              label="Escuchar Audio Privado"
              icon="headphones"
              onPress={() => router.push('/audio/private')}
              style={styles.audioBtn}
            />
          )}

          {/* TODO: Reactivar el shortcut "Círculos" (icon="users") cuando el perfil alcance un umbral de seguidores */}
          <View style={styles.shortcuts}>
            <Shortcut
              icon="headphones"
              label={t('profile.podcast')}
              onPress={() => setActiveSection((v) => (v === 'podcast' ? null : 'podcast'))}
            />
            <Shortcut
              icon="book"
              label={t('profile.courses')}
              onPress={() => setActiveSection((v) => (v === 'cursos' ? null : 'cursos'))}
            />
            <Shortcut
              icon="camera"
              label={t('profile.testimonials')}
              onPress={() => setActiveSection((v) => (v === 'testimonios' ? null : 'testimonios'))}
            />
            {/*
              «Agenda» en el perfil propio abre TU agenda —lo que te piden y lo
              que has pedido—; en el de otra persona, la solicitud. Antes solo
              existia lo segundo: se podia pedir una sesion pero no habia donde
              ver las que te pedian a ti.
            */}
            <Shortcut
              icon="calendar"
              label={t('profile.bookSession')}
              onPress={() =>
                isPublic ? setBookingVisible(true) : router.push('/agenda' as never)
              }
            />
          </View>

          {activeSection ? (
            <ProfileSection
              kind={activeSection}
              profileId={galleryOwnerId}
              isOwner={!isPublic}
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
              isPublic
                ? 'Este perfil aún no ha publicado nada.'
                : 'Cuando publiques una foto o un video, aparecerá aquí.'
            }
          />
          )}
        </View>
      </AppScreen>

      <BookSessionSheet
        visible={bookingVisible}
        onClose={() => setBookingVisible(false)}
        targetUser={{
          id: galleryOwnerId ?? id ?? '',
          fullName: profileData.fullName,
        }}
      />

      <BottomSheet visible={optionsVisible} onClose={() => setOptionsVisible(false)}>
        <Text style={[styles.sheetTitle, { color: colors.text }]}>Opciones</Text>
        <ListRow
          title={t('profile.saved')}
          leftIcon="bookmark"
          onPress={() => {
            setOptionsVisible(false);
            router.push('/saved' as never);
          }}
        />
        {!isPublic ? (
          <React.Fragment>
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
          !blocked && (
            <ListRow
              title="Bloquear a esta persona"
              leftIcon="slash"
              destructive
              onPress={() => {
                setOptionsVisible(false);
                void toggleBlock();
              }}
            />
          )
        )}
      </BottomSheet>

      <BottomSheet visible={editingPhoto !== null} onClose={() => setEditingPhoto(null)}>
        <Text style={[styles.sheetTitle, { color: colors.text }]}>
          {editingPhoto === 'cover' ? 'Foto de portada' : 'Foto de perfil'}
        </Text>
        <ListRow
          title="Elegir de la galería"
          leftIcon="image"
          onPress={() => void applyPhoto('gallery')}
        />
        <ListRow title="Tomar foto" leftIcon="camera" onPress={() => void applyPhoto('camera')} />
        {hasCustomPhoto && (
          <ListRow title="Quitar foto actual" leftIcon="trash-2" destructive onPress={removePhoto} />
        )}
      </BottomSheet>
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

function Shortcut({ icon, label, onPress }: { icon: keyof typeof Feather.glyphMap; label: string; onPress: () => void }) {
  const { colors } = useAppTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.shortcutItem, { opacity: pressed ? 0.8 : 1 }]}
    >
      <View style={[styles.shortcutIcon, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
        <Feather name={icon} size={20} color={colors.text} />
      </View>
      <Text style={{ color: colors.text, fontSize: 11, fontWeight: '500' }}>{label}</Text>
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
  bio: { fontSize: 13, lineHeight: 18, marginTop: spacing.sm, marginBottom: spacing.lg },
  audioBtn: { width: '100%', marginBottom: spacing.lg },
  shortcuts: { flexDirection: 'row', marginVertical: spacing.md, gap: spacing.sm },
  shortcutItem: { alignItems: 'center', gap: 6, flex: 1 },
  shortcutIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
});
