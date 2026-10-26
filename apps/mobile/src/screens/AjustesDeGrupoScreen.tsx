import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { PuertasDelGrupo } from '@/components/chat/PuertasDelGrupo';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { ListRow } from '@/components/ListRow';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { useInfoDeConversacion } from '@/hooks/useInfoDeConversacion';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import {
  MAX_TITULO_DE_GRUPO,
  claveDelFalloDeGrupo,
  juzgarTitulo,
  limpiarTitulo,
} from '@/lib/gruposDeChat';
import { toast } from '@/lib/toast';
import { GroupRepository } from '@/repositories/GroupRepository';
import { ApiError } from '@/services/api';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Lo que solo decide quien administra un grupo: su nombre, cómo se entra a él
 * —el enlace, su perfil, las solicitudes que esperan— y sus filtros.
 *
 * ES UNA PANTALLA APARTE DE LA FICHA, a propósito. La ficha es de todos los
 * miembros y enseña lo mismo a todos; lo de administrar se abre desde su
 * lápiz y no estorba a quien solo quiere ver quién está o qué se compartió.
 *
 * SOLO PARA QUIEN ADMINISTRA. Quien llegue sin serlo —un enlace viejo, o le
 * quitaron el grupo— ve que no puede, no un formulario que respondería 403.
 * El permiso es del servidor: cada cambio se vuelve a comprobar allí.
 */
export function AjustesDeGrupoScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const conversationId = typeof params.id === 'string' ? params.id : '';
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const currentUserId = useAppStore((state) => state.user?.id ?? null);

  const { info, refrescar } = useInfoDeConversacion(
    conversationId,
    currentUserId,
    supabaseEnabled && !!conversationId,
  );

  const [titulo, setTitulo] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);

  // El nombre del formulario sigue al del grupo mientras no se esté editando.
  const tituloDelGrupo = info?.titulo ?? '';
  useEffect(() => {
    setTitulo(tituloDelGrupo);
  }, [tituloDelGrupo]);

  // Al volver de los filtros, lo que se enseña está al día.
  const yaTuvoElFoco = React.useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (yaTuvoElFoco.current) refrescar();
      yaTuvoElFoco.current = true;
    }, [refrescar]),
  );

  const guardarTitulo = useCallback(async () => {
    const limpio = limpiarTitulo(titulo);
    if (guardando || juzgarTitulo(titulo) !== 'vale' || limpio === tituloDelGrupo) return;
    setGuardando(true);
    setFallo(null);
    try {
      await GroupRepository.renombrar(conversationId, limpio);
      toast(t('groups.renamed'));
      refrescar();
    } catch (error) {
      const codigo = error instanceof ApiError ? error.code : null;
      setFallo(t(claveDelFalloDeGrupo(codigo) as TranslationKey));
    } finally {
      setGuardando(false);
    }
  }, [titulo, guardando, tituloDelGrupo, conversationId, t, refrescar]);

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  if (info === undefined) {
    return (
      <AppScreen scroll={false}>
        <AppHeader title={t('groups.editTitle')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }
  if (info === null || !info.esGrupo) {
    return (
      <AppScreen scroll={false}>
        <AppHeader title={t('groups.editTitle')} onBack={volver} />
        <StateView state="error" title={t('groups.loadError')} onRetry={refrescar} />
      </AppScreen>
    );
  }
  if (!info.puedoAdministrar) {
    return (
      <AppScreen scroll={false}>
        <AppHeader title={t('groups.editTitle')} onBack={volver} />
        <StateView state="empty" title={t('groups.errorAdminRequired')} />
      </AppScreen>
    );
  }

  const cambioDeTitulo =
    juzgarTitulo(titulo) === 'vale' && limpiarTitulo(titulo) !== tituloDelGrupo;

  return (
    <AppScreen>
      <AppHeader title={t('groups.editTitle')} onBack={volver} />
      <View style={styles.cuerpo}>
        {fallo ? <InlineError message={fallo} /> : null}

        <View style={styles.seccion}>
          <Input
            label={t('groups.titleLabel')}
            value={titulo}
            onChangeText={setTitulo}
            maxLength={MAX_TITULO_DE_GRUPO}
            returnKeyType="done"
            onSubmitEditing={() => void guardarTitulo()}
          />
          {cambioDeTitulo ? (
            <Button
              label={t('groups.saveTitle')}
              variant="secondary"
              onPress={() => void guardarTitulo()}
              loading={guardando}
              disabled={guardando}
            />
          ) : null}
        </View>

        {/*
          CÓMO SE ENTRA AL GRUPO: las solicitudes que esperan, si se enseña en
          el perfil y el enlace. Solo si el servidor conoce estas funciones; si
          no, no pinta nada.
        */}
        <PuertasDelGrupo info={info} alCambiar={refrescar} />

        {/* Los filtros son del grupo de primer nivel: en una comunidad el
            servidor responde 409, así que no se ofrecen. */}
        {info.padre ? null : (
          <View style={[styles.tarjeta, { borderColor: colors.border }]}>
            <ListRow
              title={t('groupFilters.title')}
              subtitle={t('groupFilters.hint')}
              leftIcon="sliders"
              rightIcon="chevron-right"
              onPress={() =>
                router.push({
                  pathname: '/chat/filtros/[id]' as never,
                  params: { id: conversationId },
                })
              }
            />
          </View>
        )}

        <Text color={colors.textMuted} style={styles.detalle}>
          {t('groups.adminCannotLeave')}
        </Text>
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  cuerpo: { padding: spacing.md, gap: spacing.lg },
  seccion: { gap: spacing.sm },
  tarjeta: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' },
  detalle: { fontSize: 13 },
});
