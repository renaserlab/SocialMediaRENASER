import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppScreen } from '@/components/AppScreen';
import { AppHeader } from '@/components/AppHeader';
import { ListRow } from '@/components/ListRow';
import { SignedOutNotice } from '@/components/SignedOutNotice';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import type { NotificationItem } from '@/mappers/notificationMapper';
import { NotificationRepository } from '@/repositories/NotificationRepository';
import { DARREN_NOTICE_ID } from '@/lib/guides';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { rutaDelAviso } from '@/lib/avisosAlCreador';
import { pedirDestacados } from '@/services/cachePerfil';

export function NotificationsScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  /*
    Los avisos de la demo (sin servidor) se arman al pintar y no en una
    constante del módulo: una constante se congelaría con el idioma que hubiera
    al cargar el fichero, que es antes de que nadie haya elegido ninguno.
  */
  const demoNotifications: NotificationItem[] = [
    { id: '1', title: t('notif.demo1Title'), subtitle: t('notif.demo1Body'), icon: 'bell', time: t('notif.demo1Time'), read: false },
    { id: '2', title: t('notif.demo2Title'), subtitle: t('notif.demo2Body'), icon: 'message-square', time: t('notif.demo2Time'), read: false },
    { id: '3', title: t('notif.demo3Title'), subtitle: t('notif.demo3Body'), icon: 'award', time: t('notif.demo3Time'), read: true },
  ];
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const signedIn = useAuthStore((state) => state.status === 'authenticated');

  const [items, setItems] = useState<NotificationItem[]>([]);
  const [status, setStatus] = useState<'loading' | 'idle' | 'error'>('loading');
  /** La lista ya se pinto una vez: refrescarla no vuelve a taparla. */
  const hayListaEnPantalla = useRef(false);

  /**
   * Aviso de contenido gratuito de Darren. No es una notificacion del backend:
   * es un aviso de la propia app, fijo arriba, hasta que el usuario entra o lo
   * descarta. Se resuelve el id REAL del administrador (nunca uno fijo) igual
   * que hace el inicio con las tarjetas de eventos y cursos.
   */
  const noticeDismissed = useAppStore((state) => state.dismissedGuides.includes(DARREN_NOTICE_ID));
  const dismissGuide = useAppStore((state) => state.dismissGuide);
  const [adminId, setAdminId] = useState<string | null>(null);
  useEffect(() => {
    if (!supabaseEnabled || noticeDismissed) return;
    pedirDestacados()
      .then((list) => setAdminId(list.find((member) => member.isAdmin)?.id ?? null))
      .catch((error) => {
        console.warn('[avisos] no se pudo resolver el administrador', error);
        setAdminId(null);
      });
  }, [supabaseEnabled, noticeDismissed]);

  // `listFeatured` excluye a quien mira: si el propio Darren abre la pantalla no
  // hay administrador que recomendar y el aviso no se muestra. Es lo correcto.
  const showNotice = !noticeDismissed && !!adminId;

  const openDarren = () => {
    if (!adminId) return;
    dismissGuide(DARREN_NOTICE_ID);
    irAlPerfil(router, adminId);
  };

  const load = useCallback(() => {
    // Igual que en Mensajes: sin sesion no hay actividad que consultar.
    if (!supabaseEnabled || !signedIn) {
      // Lo que hubiera era de otra sesion: la siguiente carga parte de cero.
      hayListaEnPantalla.current = false;
      setItems(demoNotifications);
      setStatus('idle');
      return;
    }
    // «Cargando…» solo cuando no hay lista que enseñar. Esto corre cada vez
    // que la pantalla recupera el foco, y antes cambiaba la lista ya pintada
    // por el texto de carga al volver de cualquier aviso.
    if (!hayListaEnPantalla.current) setStatus('loading');
    NotificationRepository.list()
      .then((data) => {
        hayListaEnPantalla.current = true;
        setItems(data);
        setStatus('idle');
        // Al abrir, marcamos todas como leídas (limpia el badge). VA DESPUES
        // del listado a proposito, aunque no dependa de el: lanzadas a la vez
        // se corren, y si «marcar» llegara primero el listado volveria con
        // todo en leido y la pantalla no resaltaria nada. Un viaje de mas a
        // cambio de que se vea lo que estaba sin leer.
        NotificationRepository.markAllRead().catch(() => {});
      })
      .catch(() => {
        // Sin lista en pantalla, el reintento vuelve a enseñar la carga.
        hayListaEnPantalla.current = false;
        setStatus('error');
      });
  }, [supabaseEnabled, signedIn]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const uiState = supabaseEnabled && status === 'loading'
    ? 'loading'
    : supabaseEnabled && status === 'error'
    ? 'error'
    // Con el aviso visible la pantalla NO esta vacia: sin esta condicion el
    // estado vacio lo tapaba justo cuando mas falta hace, en una cuenta recien
    // creada que todavia no tiene notificaciones.
    : items.length === 0 && !showNotice
    ? 'empty'
    : 'content';

  return (
    <AppScreen scroll={false}>
      <AppHeader
        title={t('settings.notifications')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
      {supabaseEnabled && !signedIn ? (
        <SignedOutNotice
          icon="bell"
          title={t('notif.signedOutTitle')}
          description={t('notif.signedOutBody')}
        />
      ) : (
      <StateView
        state={uiState}
        onRetry={load}
        icon="bell"
        title={uiState === 'empty' ? t('notif.emptyTitle') : undefined}
        description={uiState === 'empty' ? t('notif.emptyBody') : undefined}
      >
        <FlashList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            showNotice ? (
              <View style={[styles.notice, { backgroundColor: colors.primary }]}>
                {/*
                  La zona pulsable va DETRAS del contenido: en web cada Pressable
                  es un <button> y el de descartar quedaria anidado dentro del
                  otro (HTML invalido).
                */}
                <Pressable
                  onPress={openDarren}
                  style={StyleSheet.absoluteFill}
                  accessibilityRole="button"
                  accessibilityLabel={t('notif.freeContentA11y')}
                />
                <View style={styles.noticeRow} pointerEvents="none">
                  <Feather name="gift" size={20} color={colors.onPrimary} />
                  <View style={styles.noticeCopy}>
                    <Text variant="body" weight="800" color={colors.onPrimary}>
                      {t('notif.freeContentTitle')}
                    </Text>
                    <Text variant="secondary" color={colors.onPrimary} style={styles.noticeBody}>
                      {t('notif.freeContentBody')}
                    </Text>
                  </View>
                </View>
                <Pressable
                  onPress={() => dismissGuide(DARREN_NOTICE_ID)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={t('notif.dismissNotice')}
                  style={styles.noticeClose}
                >
                  <Feather name="x" size={15} color={colors.onPrimary} />
                </Pressable>
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <ListRow
              title={item.title}
              subtitle={`${item.subtitle} • ${item.time}`}
              leftIcon={item.icon}
              /*
                Cada aviso lleva a donde esta lo que anuncia. Antes TODOS
                llevaban al perfil de quien lo provoco, asi que tocar «Sesión
                confirmada» abria un perfil en vez de la agenda donde esta la
                sesion.
              */
              onPress={() =>
                /*
                  Un aviso al creador (su evento, curso, postulación o
                  producto) lleva a donde se ve o se corrige lo decidido.
                */
                rutaDelAviso(item.type ?? '', item.entityId) !== null
                  ? router.push(rutaDelAviso(item.type ?? '', item.entityId) as never)
                  : item.entityType === 'booking'
                  ? router.push('/agenda' as never)
                  : /*
                      Si el aviso se refiere a una PUBLICACION, se abre la
                      publicacion. Hace falta para «te etiquetaron» —la etiqueta
                      esta en la publicacion, y el perfil es justo donde no
                      esta— y de paso arregla los «me gusta» y los comentarios,
                      que tambien llevaban al perfil de quien reacciono.
                    */
                  item.entityType === 'post' && item.entityId
                  ? router.push(`/post/${item.entityId}` as never)
                  : /*
                      Un corazon a un comentario: `entityId` es el COMENTARIO,
                      asi que la publicacion viene en el payload. Sin esto el
                      aviso llevaba al perfil de quien reacciono.
                    */
                  item.entityType === 'comment' && item.postId
                  ? router.push(`/post/${item.postId}` as never)
                  : item.actorId
                  ? irAlPerfil(router, item.actorId)
                  : undefined
              }
            />
          )}
        />
      </StateView>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  list: {
    paddingHorizontal: spacing.md,
  },
  notice: {
    borderRadius: radius.lg,
    paddingVertical: spacing.lg,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xxl,
    marginTop: spacing.md,
    marginBottom: spacing.lg,
  },
  noticeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  noticeCopy: { flex: 1, gap: 3 },
  noticeBody: { lineHeight: 18, opacity: 0.9 },
  noticeClose: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
