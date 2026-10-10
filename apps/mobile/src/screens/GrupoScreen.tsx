import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { FotoDelGrupo } from '@/components/chat/FotoDelGrupo';
import { PuertasDelGrupo } from '@/components/chat/PuertasDelGrupo';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { ListRow } from '@/components/ListRow';
import { SelectorDePersonas } from '@/components/SelectorDePersonas';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { useInfoDeConversacion } from '@/hooks/useInfoDeConversacion';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { confirm } from '@/lib/confirm';
import {
  MAX_PERSONAS_POR_TANDA,
  MAX_TITULO_DE_GRUPO,
  claveDelFalloDeGrupo,
  juzgarTitulo,
  limpiarTitulo,
  type MiembroDeGrupo,
} from '@/lib/gruposDeChat';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { toast } from '@/lib/toast';
import { GroupRepository } from '@/repositories/GroupRepository';
import { ApiError } from '@/services/api';
import { profileImageUrl } from '@/services/storage';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { PersonaEtiquetada } from '@/types';

/**
 * Un grupo por dentro: su nombre, quién está y lo que se puede hacer con él.
 *
 * LO QUE SE ENSEÑA DEPENDE DE QUIÉN MIRA, PERO EL PERMISO ES DEL SERVIDOR.
 * Quien administra ve cambiar el nombre, añadir y sacar gente, y los filtros;
 * los demás ven la lista y «Salir del grupo». Esconder un botón es comodidad:
 * cada cambio se vuelve a comprobar al llegar a la API.
 */
export function GrupoScreen() {
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
  const [nuevas, setNuevas] = useState<PersonaEtiquetada[]>([]);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);

  // El nombre del formulario sigue al del grupo mientras no se esté editando.
  const tituloDelGrupo = info?.titulo ?? '';
  useEffect(() => {
    setTitulo(tituloDelGrupo);
  }, [tituloDelGrupo]);

  // Al volver de añadir filtros o de otra pantalla, la lista está al día.
  const yaTuvoElFoco = React.useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (yaTuvoElFoco.current) refrescar();
      yaTuvoElFoco.current = true;
    }, [refrescar]),
  );

  /** Hace una cosa a la vez, y cuenta el rechazo con el texto que le toca. */
  const hacer = useCallback(
    async (clave: string, tarea: () => Promise<unknown>): Promise<boolean> => {
      if (ocupado) return false;
      setOcupado(clave);
      setFallo(null);
      try {
        await tarea();
        return true;
      } catch (error) {
        const codigo = error instanceof ApiError ? error.code : null;
        setFallo(t(claveDelFalloDeGrupo(codigo) as TranslationKey));
        return false;
      } finally {
        setOcupado(null);
      }
    },
    [ocupado, t],
  );

  const guardarTitulo = useCallback(async () => {
    const limpio = limpiarTitulo(titulo);
    if (juzgarTitulo(titulo) !== 'vale' || limpio === tituloDelGrupo) return;
    if (await hacer('titulo', () => GroupRepository.renombrar(conversationId, limpio))) {
      toast(t('groups.renamed'));
      refrescar();
    }
  }, [titulo, tituloDelGrupo, hacer, conversationId, t, refrescar]);

  const anadir = useCallback(async () => {
    if (nuevas.length === 0) return;
    const ids = nuevas.map((persona) => persona.id);
    if (await hacer('anadir', () => GroupRepository.anadir(conversationId, ids))) {
      setNuevas([]);
      toast(t('groups.added'));
      refrescar();
    }
  }, [nuevas, hacer, conversationId, t, refrescar]);

  const sacar = useCallback(
    async (miembro: MiembroDeGrupo) => {
      const seguro = await confirm({
        title: t('groups.removeTitle', { nombre: miembro.nombre }),
        message: t('groups.removeBody'),
        confirmLabel: t('groups.remove'),
        destructive: true,
      });
      if (!seguro) return;
      if (await hacer(`sacar:${miembro.id}`, () => GroupRepository.quitar(conversationId, miembro.id))) {
        refrescar();
      }
    },
    [hacer, conversationId, t, refrescar],
  );

  const salir = useCallback(async () => {
    if (!currentUserId) return;
    const seguro = await confirm({
      title: t('groups.leaveTitle'),
      message: t('groups.leaveBody'),
      confirmLabel: t('groups.leave'),
      destructive: true,
    });
    if (!seguro) return;
    if (await hacer('salir', () => GroupRepository.quitar(conversationId, currentUserId))) {
      // Ya no se pertenece: ni al chat ni a esta pantalla se puede volver.
      router.replace('/messages' as never);
    }
  }, [currentUserId, hacer, conversationId, router, t]);

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  if (info === undefined) {
    return (
      <AppScreen scroll={false}>
        <AppHeader title={t('groups.infoTitle')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }
  if (info === null || !info.esGrupo) {
    return (
      <AppScreen scroll={false}>
        <AppHeader title={t('groups.infoTitle')} onBack={volver} />
        <StateView
          state="error"
          title={t('groups.loadError')}
          onRetry={refrescar}
        />
      </AppScreen>
    );
  }

  const cambioDeTitulo =
    juzgarTitulo(titulo) === 'vale' && limpiarTitulo(titulo) !== tituloDelGrupo;
  const cabenMas = info.miembros.length < info.maximoDeMiembros;

  return (
    <AppScreen>
      <AppHeader title={t('groups.infoTitle')} onBack={volver} />
      <View style={styles.cuerpo}>
        <View style={styles.cabecera}>
          {/* Para quien administra, la foto es también el botón de cambiarla. */}
          <FotoDelGrupo info={info} alCambiar={refrescar} alFallar={setFallo} />
          <Text weight="800" style={styles.titulo} numberOfLines={2}>
            {info.titulo}
          </Text>
          <Text color={colors.textMuted}>
            {t('groups.membersCount', { n: info.miembros.length })}
          </Text>
        </View>

        {fallo ? <InlineError message={fallo} /> : null}

        {info.puedoAdministrar ? (
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
                loading={ocupado === 'titulo'}
                disabled={!!ocupado}
              />
            ) : null}
          </View>
        ) : null}

        <View style={[styles.tarjeta, { borderColor: colors.border }]}>
          <ListRow
            title={t('groups.content')}
            subtitle={t('groups.contentHint')}
            leftIcon="grid"
            rightIcon="chevron-right"
            onPress={() =>
              router.push({
                pathname: '/chat/contenido/[id]' as never,
                params: { id: conversationId, name: info.titulo },
              })
            }
          />
          {info.puedoAdministrar ? (
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
          ) : null}
        </View>

        {/*
          CÓMO SE ENTRA AL GRUPO: las solicitudes que esperan, si se enseña
          en el perfil y el enlace. Solo para quien administra, y solo
          si el servidor conoce estas funciones; si no, no pinta nada.
        */}
        <PuertasDelGrupo info={info} alCambiar={refrescar} />

        <View style={styles.seccion}>
          <Text weight="700">{t('groups.members')}</Text>
          {info.miembros.map((miembro) => {
            const soyYo = miembro.id === currentUserId;
            return (
              <View key={miembro.id} style={styles.miembro}>
                <Pressable
                  onPress={() => irAlPerfil(router, miembro.id)}
                  accessibilityRole="button"
                  accessibilityLabel={t('chat.openProfile', { nombre: miembro.nombre })}
                  style={styles.persona}
                >
                  <Avatar
                    size={40}
                    image={profileImageUrl(miembro.avatarPath) ?? null}
                    name={miembro.nombre}
                  />
                  <View style={styles.textos}>
                    <Text numberOfLines={1} weight="600">
                      {soyYo ? t('groups.youNamed', { nombre: miembro.nombre }) : miembro.nombre}
                    </Text>
                    {miembro.administra ? (
                      <Text color={colors.textMuted} style={styles.detalle}>
                        {t('groups.admin')}
                      </Text>
                    ) : miembro.usuario ? (
                      <Text color={colors.textMuted} style={styles.detalle} numberOfLines={1}>
                        @{miembro.usuario}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
                {info.puedoAdministrar && !miembro.administra ? (
                  <Pressable
                    onPress={() => void sacar(miembro)}
                    disabled={!!ocupado}
                    accessibilityRole="button"
                    accessibilityLabel={t('groups.removeTitle', { nombre: miembro.nombre })}
                    hitSlop={8}
                    style={styles.sacar}
                  >
                    <Feather name="user-minus" size={18} color={colors.danger} />
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </View>

        {info.puedoAdministrar ? (
          <View style={styles.seccion}>
            {cabenMas ? (
              <>
                <SelectorDePersonas
                  seleccionadas={nuevas}
                  alCambiar={setNuevas}
                  maximo={Math.min(
                    MAX_PERSONAS_POR_TANDA,
                    info.maximoDeMiembros - info.miembros.length,
                  )}
                  titulo={t('groups.addPeople')}
                  ayuda={t('groups.peopleHint')}
                />
                {nuevas.length > 0 ? (
                  <Button
                    label={t('groups.addSelected', { n: nuevas.length })}
                    icon="user-plus"
                    onPress={() => void anadir()}
                    loading={ocupado === 'anadir'}
                    disabled={!!ocupado}
                  />
                ) : null}
              </>
            ) : (
              <>
                <Text weight="700">{t('groups.addPeople')}</Text>
                <Text color={colors.textMuted} style={styles.detalle}>
                  {t('groups.errorFull')}
                </Text>
              </>
            )}
          </View>
        ) : (
          <Button
            label={t('groups.leave')}
            variant="secondary"
            icon="log-out"
            onPress={() => void salir()}
            loading={ocupado === 'salir'}
            disabled={!!ocupado}
          />
        )}

        {info.puedoAdministrar ? (
          <Text color={colors.textMuted} style={styles.detalle}>
            {t('groups.adminCannotLeave')}
          </Text>
        ) : null}
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  cuerpo: { padding: spacing.md, gap: spacing.lg },
  cabecera: { alignItems: 'center', gap: spacing.xs },
  titulo: { fontSize: 20, textAlign: 'center' },
  seccion: { gap: spacing.sm },
  tarjeta: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: 'hidden' },
  miembro: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  persona: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minWidth: 0 },
  textos: { flex: 1, minWidth: 0 },
  detalle: { fontSize: 13 },
  sacar: { padding: spacing.xs },
});
