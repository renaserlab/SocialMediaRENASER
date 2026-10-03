import React, { useRef, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { ListRow } from '@/components/ListRow';
import { DELETE_ACCOUNT_URL } from '@/config/legal';
import { LANGUAGE_NAMES } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { confirm, notify } from '@/lib/confirm';
import { ApiError } from '@/services/api';
import { notifyLocally, requestNotificationPermission } from '@/services/notifications';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Códigos con los que la API dice que la cuenta no se cierra sola: reintentar
 * no cambia nada, hay que escribir a soporte. El segundo (F21) llega cuando
 * la cuenta es parte de una reserva, pasada o por venir.
 */
const BAJA_BLOQUEADA = ['account_deletion_blocked', 'service_history_requires_support'];

/** Códigos con los que la API garantiza que la cuenta NO se borró. */
const BAJA_NO_HECHA = ['account_deletion_storage_failed', 'account_deletion_unavailable'];

function sinSaberComoTermino(error: ApiError): boolean {
  if (error.status === 0) return true; // se cortó la espera o no hubo conexión
  return error.status >= 500 && !BAJA_NO_HECHA.includes(error.code);
}

export function SettingsScreen() {
  const { colors, mode } = useAppTheme();
  const { t, language } = useTranslation();
  // Claves todavia fuera del diccionario (ver `hooks/useGarantia.ts`).
  const router = useRouter();
  const insets = useSafeAreaInsets();

  /** Abre un documento legal en el navegador del sistema. */
  const openLegal = (url: string): void => {
    Linking.openURL(url).catch(() => {
      notify(t('settings.linkFailed'), t('settings.linkFailedBody'));
    });
  };

  const toggleTheme = useAppStore((state) => state.toggleTheme);
  const resetDemo = useAppStore((state) => state.resetDemo);
  const user = useAppStore((state) => state.user);
  const signOut = useAuthStore((state) => state.signOut);
  const deleteAccount = useAuthStore((state) => state.deleteAccount);
  const authStatus = useAuthStore((state) => state.status);

  const isLoggedIn = authStatus === 'authenticated';

  /*
    LA BAJA EN CURSO. Tras las dos confirmaciones el borrado puede tardar hasta
    un minuto, y mientras tanto la fila seguia igual y se podia volver a pulsar.
    El `ref` es el cerrojo (no espera a que React repinte) y el estado es lo que
    se ve: un indicador en la propia fila.
  */
  const bajaEnCurso = useRef(false);
  const [borrando, setBorrando] = useState(false);

  const handleSignOut = async () => {
    const ok = await confirm({
      title: t('settings.signOut'),
      message: t('settings.signOutConfirm'),
      confirmLabel: t('settings.signOut'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await signOut();
    } catch (error) {
      // Sin esto el fallo se perdia y la fila parecia no hacer nada.
      console.warn('[ajustes] no se pudo cerrar la sesion', error);
      notify(t('state.errorTitle'), t('settings.linkFailedBody'));
      return;
    }
    router.replace('/');
  };

  const handleDeleteAccount = async () => {
    if (bajaEnCurso.current) return;
    // Doble confirmacion: es irreversible y se lleva todo el contenido. La
    // primera explica lo que pasa; la segunda es la ultima red antes de borrar.
    const ok = await confirm({
      title: t('settings.deleteAccount'),
      message: t('settings.deleteAccountConfirm'),
      confirmLabel: t('settings.deleteAccount'),
      destructive: true,
    });
    if (!ok) return;
    const reallySure = await confirm({
      title: t('settings.deleteAccountConfirm2Title'),
      message: t('settings.deleteAccountConfirm2'),
      confirmLabel: t('settings.deleteAccountYes'),
      destructive: true,
    });
    if (!reallySure) return;
    bajaEnCurso.current = true;
    setBorrando(true);
    try {
      await deleteAccount();
      router.replace('/');
    } catch (error) {
      // BLOQUEADA NO ES «INTÉNTALO DE NUEVO». La cuenta tiene ventas, pedidos,
      // reclamos o reservas que hay que conservar: repetir no cambia nada, hay
      // que escribir a soporte. Cualquier otro fallo sí se arregla
      // reintentando.
      if (error instanceof ApiError && BAJA_BLOQUEADA.includes(error.code)) {
        // Con reservas no se promete cerrarla: se pide escribir a soporte.
        const cuerpo =
          error.code === 'account_deletion_blocked'
            ? t('settings.deleteAccountBlockedBody')
            : t('settings.deleteAccountHistoryBody');
        notify(t('settings.deleteAccountBlocked'), cuerpo);
        return;
      }
      // SIN RESPUESTA DEL SERVIDOR NO SE SABE. La baja pudo terminar aunque
      // aquí se cortara la espera, o aunque el CDN contestara 502/504 porque
      // tardó más de 60 s: decir «tu cuenta sigue activa» podría ser falso.
      // Solo los dos 503 que la API conoce garantizan que la cuenta sigue.
      // Repetir es seguro (si ya se borró, responde bien y se sale).
      if (error instanceof ApiError && sinSaberComoTermino(error)) {
        notify(t('settings.deleteAccountUnknown'), t('settings.deleteAccountUnknownBody'));
        return;
      }
      notify(t('settings.deleteAccountFailed'), t('settings.deleteAccountFailedBody'));
    } finally {
      bajaEnCurso.current = false;
      setBorrando(false);
    }
  };

  /**
   * Lanza un aviso de prueba en este mismo telefono.
   *
   * Es una notificacion LOCAL, asi que suena y se ve igual que la de verdad
   * pero no necesita servidor. Sirve para dos cosas: comprobar que el permiso
   * esta concedido, y oir el sonido en Expo Go, donde el push remoto no llega.
   */
  const testNotification = async () => {
    const granted = await requestNotificationPermission();
    if (!granted) {
      notify(t('settings.notificationsOff'), t('settings.notificationsOffBody'));
      return;
    }
    await notifyLocally(t('settings.notificationSample'), t('settings.notificationSampleBody'));
  };

  const handleReset = async () => {
    const ok = await confirm({
      title: 'Reiniciar aplicación',
      message:
        'Se restaurarán los datos de demo y se cerrará tu sesión. Esta acción no se puede deshacer.',
      confirmLabel: 'Reiniciar',
      destructive: true,
    });
    if (!ok) return;
    await signOut();
    resetDemo();
    router.replace('/');
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title={t('settings.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      {/*
        El ultimo elemento de la lista —«Cerrar sesion»— tiene que quedar
        ALCANZABLE en cualquier telefono. Sin este relleno, en los que tienen
        gesto de inicio el ultimo renglon quedaba debajo de la barra del sistema
        y no se podia pulsar. Sale del inset real del aparato, no de un numero.
      */}
      <ScrollView
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + spacing.xl }]}
      >
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('settings.display')}</Text>
        <ListRow
          title={t('settings.darkMode')}
          subtitle={t('settings.currently', { value: mode === 'dark' ? t('settings.dark') : t('settings.light') })}
          leftIcon="moon"
          rightIcon="refresh-cw"
          onPress={toggleTheme}
        />
        <ListRow
          title={t('settings.language')}
          subtitle={LANGUAGE_NAMES[language]}
          leftIcon="globe"
          rightIcon="chevron-right"
          onPress={() => router.push('/language')}
        />

        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('settings.account')}</Text>
        {isLoggedIn && user && (
          <ListRow
            title={user.fullName || user.username}
            subtitle={user.email || user.username}
            leftIcon="user"
          />
        )}
        {isLoggedIn ? (
          /*
            El cuestionario se pregunta UNA vez, pero lo que alguien busca
            cambia. Sin esta puerta, cambiar de intereses obligaria a borrar la
            cuenta: es la unica forma de volver a verlo.
          */
          <ListRow
            title={t('settings.interests')}
            subtitle={t('settings.interestsBody')}
            leftIcon="compass"
            rightIcon="chevron-right"
            onPress={() => router.push('/onboarding?modo=editar' as never)}
          />
        ) : null}
        {isLoggedIn ? (
          /*
            COMPRAS Y DEVOLUCIONES. Es el expediente comercial de la cuenta, y
            tiene que estar donde se busca: en Ajustes, con lo demas de la
            cuenta. Sigue ahi aunque el acceso a un curso se haya retirado —una
            compra devuelta sigue siendo una compra— y aunque se reinstale la
            aplicacion, porque todo sale del servidor.
          */
          <ListRow
            title={t('settings.purchases')}
            subtitle={t('settings.purchasesBody')}
            leftIcon="shopping-bag"
            rightIcon="chevron-right"
            onPress={() => router.push('/compras' as never)}
          />
        ) : null}
        {/*
          «Verificación de cuenta» lleva a una pantalla cuyo boton de solicitar
          todavia no envia nada. Hasta que lo haga se esconde igual que
          «Reiniciar aplicacion», con `__DEV__`: en produccion no se ofrece una
          puerta que promete un plazo y no hace la solicitud.
        */}
        {__DEV__ ? (
          <ListRow
            title={t('settings.verification')}
            subtitle={t('settings.verificationBody')}
            leftIcon="check-circle"
            rightIcon="chevron-right"
            onPress={() => router.push('/verification')}
          />
        ) : null}
        {isLoggedIn ? (
          <ListRow
            title={t('settings.blocked')}
            subtitle={t('settings.blockedBody')}
            leftIcon="slash"
            rightIcon="chevron-right"
            onPress={() => router.push('/blocked' as never)}
          />
        ) : null}
        {isLoggedIn ? (
          /*
            Eliminar cuenta se queda AQUI, con lo demas de la cuenta. Lo que
            baja al final es «Cerrar sesion»: son dos cosas distintas y hasta
            ahora se leian como una sola, con la irreversible justo debajo de la
            que se pulsa a diario.
          */
          <ListRow
            title={t('settings.deleteAccount')}
            subtitle={t('settings.deleteAccountBody')}
            leftIcon="trash-2"
            destructive
            // Mientras dura la baja se ve que algo esta pasando.
            rightComponent={borrando ? <ActivityIndicator color={colors.danger} /> : undefined}
            onPress={handleDeleteAccount}
          />
        ) : (
          <ListRow
            title={t('settings.signIn')}
            subtitle={t('settings.signInBody')}
            leftIcon="log-in"
            rightIcon="chevron-right"
            onPress={() => router.push('/login')}
          />
        )}

        {/*
          Legal. Apple exige que la politica de privacidad y el acuerdo de
          licencia sean accesibles DENTRO de la app, no solo en la ficha de la
          tienda. Son rutas propias, asi que no dependen de configurar ninguna
          URL —siempre funcionan, incluso sin conexion— y ademas quedan
          publicadas en la web de Vercel como /privacy y /terms, que es la
          direccion publica que pide la ficha de la tienda.
        */}
        {/*
          Ayuda. Va ANTES de lo legal porque es lo que se busca cuando algo no
          funciona, y porque la misma ruta es la URL de soporte publica que
          exigen tanto la ficha de App Store como la de Google Play.
        */}
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('settings.help')}</Text>
        <ListRow
          title={t('settings.support')}
          subtitle={t('settings.supportBody')}
          leftIcon="life-buoy"
          rightIcon="chevron-right"
          onPress={() => router.push('/support' as never)}
        />

        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>{t('settings.legal')}</Text>
        <ListRow
          title={t('settings.privacy')}
          subtitle={t('settings.privacyBody')}
          leftIcon="shield"
          rightIcon="chevron-right"
          onPress={() => router.push('/privacy' as never)}
        />
        <ListRow
          title={t('settings.terms')}
          subtitle={t('settings.termsBody')}
          leftIcon="file-text"
          rightIcon="chevron-right"
          onPress={() => router.push('/terms' as never)}
        />
        {/*
          Pagina externa de borrado de cuenta: Google Play la quiere accesible
          SIN instalar la app, asi que no puede ser una ruta interna. Solo
          aparece cuando este publicada (ver `config/legal.ts`); enlazar a algo
          inexistente seria peor que no ofrecerlo.
        */}
        {DELETE_ACCOUNT_URL ? (
          <ListRow
            title={t('settings.deleteAccountHow')}
            subtitle={t('settings.deleteAccountHowBody')}
            leftIcon="help-circle"
            rightIcon="external-link"
            onPress={() => openLegal(DELETE_ACCOUNT_URL)}
          />
        ) : null}

        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>
          {t('settings.notifications')}
        </Text>
        <ListRow
          title={t('settings.testNotification')}
          subtitle={t('settings.testNotificationBody')}
          leftIcon="bell"
          rightIcon="chevron-right"
          onPress={() => void testNotification()}
        />

        {/*
          «Reiniciar aplicacion» restauraba los datos de DEMO y cerraba la
          sesion. Es una herramienta de desarrollo, no un ajuste: a un usuario
          real solo le puede pasar algo malo con ella. Se esconde igual que la
          galeria de pantallas de `/dev`, con `__DEV__`, que en las builds de
          produccion vale `false` y ademas permite al empaquetador quitar el
          bloque entero.
        */}
        {__DEV__ ? (
          <>
            <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>
              {t('settings.system')}
            </Text>
            <ListRow
              title={t('settings.reset')}
              subtitle={t('settings.resetBody')}
              leftIcon="trash-2"
              onPress={handleReset}
            />
          </>
        ) : null}

        {/*
          CERRAR SESION, AL FINAL DEL TODO.

          Estaba en mitad de la pantalla, con «Eliminar cuenta» pegada debajo y
          cuatro secciones mas despues. Lo que se hace al terminar va al final:
          asi se llega desplazando hasta abajo y no se roza la accion
          irreversible por el camino. Va con el flujo del contenido —nada de
          `position: absolute`—, asi que se comporta igual en cualquier alto de
          pantalla.
        */}
        {isLoggedIn ? (
          <>
            <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>
              {t('settings.session')}
            </Text>
            <ListRow
              title={t('settings.signOut')}
              subtitle={t('settings.signOutBody')}
              leftIcon="log-out"
              destructive
              onPress={handleSignOut}
            />
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  // El relleno inferior lo pone el componente: depende de la zona segura.
  list: {},
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
    letterSpacing: 0.5,
  },
});
