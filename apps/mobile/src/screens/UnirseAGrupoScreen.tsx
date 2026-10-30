import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { TarjetaDeGrupoVista } from '@/components/chat/TarjetaDeGrupoVista';
import { SignedOutNotice } from '@/components/SignedOutNotice';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { useTranslation } from '@/i18n/useTranslation';
import { esCodigoDeGrupo, type TarjetaDeGrupo } from '@/lib/gruposDeChat';
import { GroupRepository } from '@/repositories/GroupRepository';
import { useAuthStore } from '@/store/useAuthStore';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * A donde lleva el enlace de un grupo (en pantalla, una comunidad): su
 * tarjeta, y el botón de entrar o de pedir entrar.
 *
 * EL ENLACE SIGUE CÓMO SE ENTRA. Si la comunidad es abierta, «Unirme» mete y
 * la abre. Si es con solicitud, el enlace no mete a nadie: enseña de qué
 * comunidad se trata y deja pedir la entrada; quien la administra recibe el
 * aviso y decide.
 *
 * UN ENLACE QUE NO VALE NO DICE POR QUÉ. Desactivado, cambiado, mal copiado o
 * de un grupo cuyo administrador tiene un bloqueo con quien mira: el servidor
 * responde lo mismo en los cuatro casos, y aquí se pinta lo mismo.
 */
export function UnirseAGrupoScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ codigo: string }>();
  const codigo = typeof params.codigo === 'string' ? params.codigo : '';
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const signedIn = useAuthStore((state) => state.status === 'authenticated');

  const [tarjeta, setTarjeta] = useState<TarjetaDeGrupo | null>(null);
  const [estado, setEstado] = useState<'cargando' | 'listo' | 'no_vale'>('cargando');
  const [vuelta, setVuelta] = useState(0);

  useEffect(() => {
    // Lo que no tiene forma de código ni se pregunta: no puede ser un enlace.
    if (!supabaseEnabled || !signedIn || !esCodigoDeGrupo(codigo)) {
      setEstado(esCodigoDeGrupo(codigo) ? 'cargando' : 'no_vale');
      return;
    }
    let montado = true;
    GroupRepository.tarjetaDelEnlace(codigo)
      .then((leida) => {
        if (!montado) return;
        setTarjeta(leida);
        setEstado(leida ? 'listo' : 'no_vale');
      })
      .catch(() => {
        if (montado) setEstado('no_vale');
      });
    return () => {
      montado = false;
    };
  }, [supabaseEnabled, signedIn, codigo, vuelta]);

  const releer = useCallback(() => setVuelta((n) => n + 1), []);
  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <AppScreen>
      <AppHeader title={t('groupJoin.title')} onBack={volver} />
      {supabaseEnabled && !signedIn ? (
        <SignedOutNotice
          icon="users"
          title={t('groupJoin.signedOutTitle')}
          description={t('groupJoin.signedOutBody')}
        />
      ) : estado === 'cargando' ? (
        <StateView state="loading" />
      ) : estado === 'no_vale' || !tarjeta ? (
        <StateView
          state="empty"
          title={t('groupJoin.invalidTitle')}
          description={t('groupJoin.invalidBody')}
        />
      ) : (
        <View style={styles.cuerpo}>
          <Text color={colors.textMuted} style={styles.ayuda}>
            {t(tarjeta.entrada === 'open' ? 'groupJoin.explainOpen' : 'groupJoin.explain')}
          </Text>
          <TarjetaDeGrupoVista tarjeta={tarjeta} codigo={codigo} alCambiar={releer} />
        </View>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  cuerpo: { padding: spacing.md, gap: spacing.md },
  ayuda: { fontSize: 13, lineHeight: 18 },
});
