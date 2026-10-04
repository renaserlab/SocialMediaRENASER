import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppScreen } from '@/components/AppScreen';
import { AppHeader } from '@/components/AppHeader';
import { Aparecer } from '@/components/Aparecer';
import { GloboDeNoLeidos } from '@/components/GloboDeNoLeidos';
import { Pulsable } from '@/components/Pulsable';
import { SignedOutNotice } from '@/components/SignedOutNotice';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import type { NotificationItem } from '@/mappers/notificationMapper';
import { AVISOS_POR_PAGINA, NotificationRepository } from '@/repositories/NotificationRepository';
import { notificacionesLeidas } from '@/services/contadores';
import { DARREN_NOTICE_ID } from '@/lib/guides';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { rutaDelAviso } from '@/lib/avisosAlCreador';
import { destinoDelAviso } from '@/lib/avisosNuevos';
import { retrasoEnCascada } from '@/lib/movimiento';
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
  const [hayMas, setHayMas] = useState(false);
  const [cargandoMas, setCargandoMas] = useState(false);
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
        // Lo que se pinta es la lista tal como llego: lo que estaba sin leer
        // sale resaltado, que es lo que permite ver de un vistazo que es nuevo.
        setItems(data);
        setHayMas(data.length >= AVISOS_POR_PAGINA);
        setStatus('idle');
        // Al abrir, marcamos todas como leídas (limpia el badge). VA DESPUES
        // del listado a proposito, aunque no dependa de el: lanzadas a la vez
        // se corren, y si «marcar» llegara primero el listado volveria con
        // todo en leido y la pantalla no resaltaria nada. Un viaje de mas a
        // cambio de que se vea lo que estaba sin leer.
        NotificationRepository.markAllRead()
          // La campana y el icono de la aplicacion se apagan a la vez.
          .then(notificacionesLeidas)
          .catch(() => {});
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

  /*
    Cada aviso lleva a donde está lo que anuncia: la publicación, la agenda,
    lo decidido sobre su evento o su curso. La decisión vive en
    `destinoDelAviso`, que es la MISMA que usa el aviso flotante.

    UNA SOLA FUNCIÓN PARA TODAS LAS FILAS, y estable: una flecha nueva por fila
    en cada render anulaba el `React.memo` de `FilaDeAviso` y la lista entera
    se repintaba al cargar una página más.

    Si lo anunciado ya no existe —la publicación se borró—, quien lo dice es
    la pantalla de destino, con su estado de «no encontrado».
  */
  const abrirAviso = useCallback(
    (aviso: NotificationItem) => {
      const destino = destinoDelAviso(aviso, rutaDelAviso);
      if (destino) router.push(destino as never);
    },
    [router],
  );

  const cargarMas = useCallback(() => {
    if (!supabaseEnabled || !signedIn || !hayMas || cargandoMas || status !== 'idle') return;
    setCargandoMas(true);
    NotificationRepository.list(items.length)
      .then((data) => {
        // Por id: si entró un aviso nuevo entre página y página, la siguiente
        // empieza una fila antes y trae uno repetido.
        setItems((previos) => {
          const vistos = new Set(previos.map((aviso) => aviso.id));
          return [...previos, ...data.filter((aviso) => !vistos.has(aviso.id))];
        });
        setHayMas(data.length >= AVISOS_POR_PAGINA);
      })
      // Un fallo al pedir más no borra lo que ya hay: se puede volver a bajar.
      .catch(() => {})
      .finally(() => setCargandoMas(false));
  }, [supabaseEnabled, signedIn, hayMas, cargandoMas, status, items.length]);

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
          // Al llegar al final se pide la página siguiente: la bandeja ya no se
          // queda en los primeros cincuenta para siempre.
          onEndReached={cargarMas}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            cargandoMas ? (
              <ActivityIndicator style={styles.masAbajo} color={colors.textMuted} />
            ) : null
          }
          renderItem={({ item, index }) => (
            <FilaDeAviso
              aviso={item}
              indice={index}
              /*
                Cada aviso lleva a donde está lo que anuncia: la publicación,
                la agenda, lo decidido sobre su evento o su curso. La decisión
                vive en `destinoDelAviso`, que es la MISMA que usa el aviso
                flotante: una fila y un aviso del mismo hecho no pueden llevar
                a sitios distintos.

                Si lo anunciado ya no existe —la publicación se borró—, quien
                lo dice es la pantalla de destino, con su estado de «no
                encontrado»; aquí no hay nada que comprobar por adelantado.
              */
              alAbrir={abrirAviso}
            />
          )}
        />
      </StateView>
      )}
    </AppScreen>
  );
}

/**
 * Una fila de la bandeja.
 *
 * LO NO LEÍDO SE VE, Y NO SOLO POR EL COLOR: el icono va en un círculo relleno
 * en vez de uno hueco, el título pasa a negrita y a la derecha hay un punto.
 * Tres señales de forma, porque el sistema es en blanco y negro. Y al lector
 * de pantalla se le dice con palabras: «Sin leer».
 *
 * Dice QUÉ pasó (el título) y con quién o sobre qué (el texto), nunca un
 * genérico «tienes una notificación».
 */
const FilaDeAviso = React.memo(function FilaDeAviso({
  aviso,
  indice,
  alAbrir,
}: {
  aviso: NotificationItem;
  indice: number;
  alAbrir: (aviso: NotificationItem) => void;
}) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const nuevo = !aviso.read;

  return (
    // Las primeras entran en cascada; el resto, al desplazar, ya está en su
    // sitio. `clave` porque la lista recicla celdas.
    <Aparecer retraso={indice < 6 ? retrasoEnCascada(indice) : 0} inmediato={indice >= 6} clave={aviso.id}>
      <Pulsable
        onPress={() => alAbrir(aviso)}
        escala={0.985}
        atenuar={0.7}
        accessibilityRole="button"
        accessibilityLabel={`${nuevo ? `${t('notif.unreadA11y')}. ` : ''}${aviso.title}. ${aviso.subtitle}. ${aviso.time}`}
        style={[styles.fila, { borderBottomColor: colors.border }]}
      >
        <View
          style={[
            styles.icono,
            nuevo
              ? { backgroundColor: colors.primary, borderColor: colors.primary }
              : { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
          ]}
        >
          <Feather name={aviso.icon} size={18} color={nuevo ? colors.onPrimary : colors.text} />
        </View>
        <View style={styles.textos}>
          <Text numberOfLines={1} weight={nuevo ? '800' : '600'} style={styles.titulo}>
            {aviso.title}
          </Text>
          <Text numberOfLines={2} color={colors.textMuted} style={styles.cuerpo}>
            {aviso.subtitle}
          </Text>
          <Text color={colors.textMuted} style={styles.hora}>
            {aviso.time}
          </Text>
        </View>
        <GloboDeNoLeidos cuenta={nuevo ? 1 : 0} soloPunto />
      </Pulsable>
    </Aparecer>
  );
});

const styles = StyleSheet.create({
  masAbajo: { paddingVertical: spacing.lg },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xs,
    minHeight: 64,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  icono: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textos: { flex: 1, gap: 2 },
  titulo: { fontSize: 14 },
  cuerpo: { fontSize: 13, lineHeight: 18 },
  hora: { fontSize: 11, marginTop: 1 },
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
