import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { InlineError } from '@/components/InlineError';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { confirm } from '@/lib/confirm';
import { claveDelFalloDeGrupo } from '@/lib/gruposDeChat';
import { toast } from '@/lib/toast';
import {
  type FiltroDeGrupo,
  type TipoDeContenido,
  type VistasDeChat,
} from '@/lib/vistasDeChat';
import { GroupRepository } from '@/repositories/GroupRepository';
import { MessageRepository } from '@/repositories/MessageRepository';
import { ApiError } from '@/services/api';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

export const NOMBRE_DE_TIPO: Record<TipoDeContenido, TranslationKey> = {
  text: 'groupFilters.typeText',
  image: 'chatViews.images',
  video: 'chatViews.videos',
  document: 'chatViews.documents',
  audio: 'chatViews.audios',
  link: 'chatViews.links',
};

function iconoSeguro(nombre: string): keyof typeof Feather.glyphMap {
  return nombre in Feather.glyphMap ? (nombre as keyof typeof Feather.glyphMap) : 'filter';
}

/**
 * Los filtros de un grupo, para quien lo administra: verlos, encenderlos o
 * apagarlos, editarlos, borrarlos y crear uno nuevo.
 *
 * UN FILTRO ES UNA VISTA, NO UNA CARPETA. Borrarlo quita la vista; los
 * mensajes que enseñaba siguen en el chat y en sus categorías. La pantalla lo
 * dice antes de borrar, porque «borrar» junto a una lista de mensajes asusta.
 *
 * QUIÉN PUEDE lo decide el servidor en cada cambio. Si quien entra no
 * administra el grupo, ve la lista y ningún botón.
 */
export function FiltrosDeGrupoScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const conversationId = typeof params.id === 'string' ? params.id : '';

  const [vistas, setVistas] = useState<VistasDeChat | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [fallo, setFallo] = useState<string | null>(null);

  const leer = useCallback(() => {
    if (!conversationId) return;
    void MessageRepository.vistas(conversationId).then(setVistas);
  }, [conversationId]);

  // Al entrar y al volver de crear o editar uno.
  useFocusEffect(leer);

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
        leer();
      }
    },
    [ocupado, t, leer],
  );

  const alternar = useCallback(
    (filtro: FiltroDeGrupo) =>
      hacer(`encender:${filtro.id}`, () =>
        GroupRepository.encenderFiltro(conversationId, filtro.id, !filtro.activo),
      ),
    [hacer, conversationId],
  );

  const borrar = useCallback(
    async (filtro: FiltroDeGrupo) => {
      const seguro = await confirm({
        title: t('groupFilters.deleteTitle', { nombre: filtro.nombre }),
        message: t('groupFilters.deleteBody'),
        confirmLabel: t('common.delete'),
        destructive: true,
      });
      if (!seguro) return;
      if (await hacer(`borrar:${filtro.id}`, () => GroupRepository.borrarFiltro(conversationId, filtro.id))) {
        toast(t('groupFilters.deleted'));
      }
    },
    [hacer, conversationId, t],
  );

  const editar = useCallback(
    (filtroId?: string) =>
      router.push({
        pathname: '/chat/filtro/[id]' as never,
        params: filtroId ? { id: conversationId, filtro: filtroId } : { id: conversationId },
      }),
    [router, conversationId],
  );

  /** Lo que pide un filtro, dicho en una línea. */
  const resumen = (filtro: FiltroDeGrupo): string => {
    const partes: string[] = [];
    const { tipos, palabras, modo, autores } = filtro.criterios;
    if (tipos.length > 0) partes.push(tipos.map((tipo) => t(NOMBRE_DE_TIPO[tipo])).join(', '));
    if (palabras.length > 0) {
      partes.push(
        palabras.map((p) => `«${p}»`).join(modo === 'all' ? ' + ' : ` ${t('groupFilters.or')} `),
      );
    }
    if (autores.length > 0) partes.push(t('groupFilters.authorsCount', { n: autores.length }));
    return partes.join(' · ');
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  if (vistas === null) {
    return (
      <AppScreen scroll={false}>
        <AppHeader title={t('groupFilters.title')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }
  if (!vistas.hayFiltros) {
    return (
      <AppScreen scroll={false}>
        <AppHeader title={t('groupFilters.title')} onBack={volver} />
        <StateView
          state="empty"
          title={t('groupFilters.unavailableTitle')}
          description={t('groupFilters.errorNotAvailable')}
          onRetry={leer}
        />
      </AppScreen>
    );
  }

  const lleno = vistas.maximoDeFiltros > 0 && vistas.filtros.length >= vistas.maximoDeFiltros;

  return (
    <AppScreen>
      <AppHeader title={t('groupFilters.title')} onBack={volver} />
      <View style={styles.cuerpo}>
        <Text color={colors.textMuted} style={styles.ayuda}>
          {t('groupFilters.explain')}
        </Text>

        {fallo ? <InlineError message={fallo} /> : null}

        {vistas.filtros.length === 0 ? (
          <StateView
            state="empty"
            title={t('groupFilters.emptyTitle')}
            description={t('groupFilters.emptyBody')}
          />
        ) : (
          vistas.filtros.map((filtro) => (
            <View
              key={filtro.id}
              style={[
                styles.tarjeta,
                { borderColor: colors.border, opacity: filtro.activo ? 1 : 0.6 },
              ]}
            >
              <View style={styles.fila}>
                <Feather name={iconoSeguro(filtro.icono)} size={20} color={colors.text} />
                <View style={styles.textos}>
                  <Text weight="700" numberOfLines={1}>
                    {filtro.nombre}
                  </Text>
                  {filtro.descripcion ? (
                    <Text color={colors.textMuted} style={styles.ayuda} numberOfLines={2}>
                      {filtro.descripcion}
                    </Text>
                  ) : null}
                  <Text color={colors.textMuted} style={styles.detalle} numberOfLines={2}>
                    {resumen(filtro)}
                  </Text>
                </View>
              </View>
              {vistas.puedoAdministrar ? (
                <View style={styles.acciones}>
                  <Chip
                    rol="checkbox"
                    selected={filtro.activo}
                    icon={filtro.activo ? 'eye' : 'eye-off'}
                    label={filtro.activo ? t('groupFilters.on') : t('groupFilters.off')}
                    disabled={!!ocupado}
                    onPress={() => void alternar(filtro)}
                  />
                  <View style={styles.aLaDerecha}>
                    <Pressable
                      onPress={() => editar(filtro.id)}
                      disabled={!!ocupado}
                      accessibilityRole="button"
                      accessibilityLabel={t('groupFilters.editNamed', { nombre: filtro.nombre })}
                      hitSlop={8}
                      style={styles.boton}
                    >
                      <Feather name="edit-2" size={18} color={colors.text} />
                    </Pressable>
                    <Pressable
                      onPress={() => void borrar(filtro)}
                      disabled={!!ocupado}
                      accessibilityRole="button"
                      accessibilityLabel={t('groupFilters.deleteTitle', { nombre: filtro.nombre })}
                      hitSlop={8}
                      style={styles.boton}
                    >
                      <Feather name="trash-2" size={18} color={colors.danger} />
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>
          ))
        )}

        {vistas.puedoAdministrar ? (
          <>
            <Button
              label={t('groupFilters.new')}
              icon="plus"
              onPress={() => editar()}
              disabled={lleno || !!ocupado}
            />
            {lleno ? (
              <Text color={colors.textMuted} style={styles.detalle}>
                {t('groupFilters.errorLimit')}
              </Text>
            ) : null}
          </>
        ) : null}
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  cuerpo: { padding: spacing.md, gap: spacing.md },
  ayuda: { fontSize: 13, lineHeight: 18 },
  detalle: { fontSize: 12 },
  tarjeta: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  fila: { flexDirection: 'row', gap: spacing.sm },
  textos: { flex: 1, minWidth: 0, gap: 2 },
  acciones: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  aLaDerecha: { flexDirection: 'row', gap: spacing.sm },
  boton: { padding: spacing.xs },
});
