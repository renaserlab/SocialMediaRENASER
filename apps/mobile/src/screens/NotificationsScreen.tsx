import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';

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
import { useAuthStore } from '@/store/useAuthStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { aspectoDeCirculoSuelto, categoriaDeIcono } from '@/theme/aspecto';
import { rutaDelAviso } from '@/lib/avisosAlCreador';
import { destinoDelAviso } from '@/lib/avisosNuevos';
import { retrasoEnCascada } from '@/lib/movimiento';

export function NotificationsScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const signedIn = useAuthStore((state) => state.status === 'authenticated');

  const [items, setItems] = useState<NotificationItem[]>([]);
  const [status, setStatus] = useState<'loading' | 'idle' | 'error'>('loading');
  const [hayMas, setHayMas] = useState(false);
  const [cargandoMas, setCargandoMas] = useState(false);
  /** La lista ya se pinto una vez: refrescarla no vuelve a taparla. */
  const hayListaEnPantalla = useRef(false);

  const load = useCallback(() => {
    /*
      Igual que en Mensajes: sin sesion no hay actividad que consultar.

      Y SIN SERVIDOR TAMPOCO SE INVENTA: aqui se rellenaba la bandeja con tres
      avisos de ejemplo («Nueva publicación de Darren Hardy»…). Revision de
      Apple los toma por contenido falso (directrices 2.1 y 2.3), y un fallo de
      configuracion que dejara la app en modo demo los enseñaria a gente real.
      Lista vacia: se ve la invitacion a entrar o el «Sin notificaciones».
    */
    if (!supabaseEnabled || !signedIn) {
      // Lo que hubiera era de otra sesion: la siguiente carga parte de cero.
      hayListaEnPantalla.current = false;
      setItems([]);
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
    : items.length === 0
    ? 'empty'
    : 'content';

  return (
    <AppScreen scroll={false}>
      <AppHeader
        title={t('settings.notifications')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
      {!signedIn ? (
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
  // Con una variante de categoría, el icono toma el color de su tipo; lo nuevo
  // sigue relleno (y en negrita, y con su punto), como hasta ahora.
  const aspecto = aspectoDeCirculoSuelto(colors, categoriaDeIcono(aviso.icon), { activo: nuevo });

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
            aspecto.circulo,
          ]}
        >
          <Feather
            name={aviso.icon}
            size={18}
            color={aspecto.icono ?? (nuevo ? colors.onPrimary : colors.text)}
          />
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
});
