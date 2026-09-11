import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { claveDelEstado } from '@/lib/admisionDeEvento';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { claveDelCampoDelEvento } from '@/lib/posventaAdmin';
import {
  EventOrganizerRepository,
  type EventoDelOrganizador,
  type VersionDeEvento,
} from '@/repositories/EventOrganizerRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/** La fecha y la hora. Vacía si el servidor mandó algo raro. */
function momentoLegible(iso: string | null): string {
  if (!iso) return '';
  const momento = new Date(iso);
  if (Number.isNaN(momento.getTime())) return '';
  return `${momento.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })} · ${momento.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

/**
 * La posventa de un evento, vista por quien lo organiza.
 *
 * ES UN SUBCONJUNTO, Y SE QUEDA CORTA A PROPÓSITO. Aquí no hay ni un botón que
 * mueva dinero, ni que apruebe, ni que rechace: quien organiza no decide sobre
 * el dinero de quien compró. Tampoco se enseña ninguna nota interna, ni la
 * pasarela, ni el entorno, ni la política aplicada; esos campos ni siquiera
 * llegan a esta pantalla, porque el repositorio que usa —el del organizador—
 * no los tiene.
 *
 * LO QUE NO EXISTE NO SE INVENTA. El servidor no publica hoy ninguna ruta de
 * posventa para quien organiza: `/events/aftersale-cases/...` se las entrega
 * solo a quien compró y `/admin/events/...` exige administrar el dinero. Así
 * que los expedientes de sus compradores y las entradas afectadas NO se piden
 * —llamar a una ruta ajena para enseñar un 403 disfrazado sería peor— y la
 * pantalla lo dice con todas las letras.
 *
 * LO QUE SÍ HAY es lo que el organizador ya puede leer de su propio evento:
 * qué versiones se han registrado y qué campos cambió cada una. Eso es
 * exactamente lo que después administración clasifica, y verlo aquí le permite
 * entender por qué puede aparecer una solicitud. QUÉ CUENTA COMO ESENCIAL NO
 * SE ENSEÑA: es una decisión de la empresa, se toma en otra pantalla y
 * adelantarla aquí sería ponerle palabras a algo que nadie ha decidido.
 */
export function PosventaDelEventoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [evento, setEvento] = useState<EventoDelOrganizador | null>(null);
  const [versiones, setVersiones] = useState<VersionDeEvento[]>([]);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noEncontrado' | 'noDisponible' | null
  >(null);

  const cargar = useCallback(async () => {
    if (!id) return;
    setCargando(true);
    setFallo(null);
    try {
      const ficha = await EventOrganizerRepository.leer(id);
      setEvento(ficha);
      // La lista de versiones no tumba la pantalla: el evento ya se leyó.
      setVersiones(await EventOrganizerRepository.versiones(id).catch(() => []));
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === 'events_workflow_not_available'
      ) {
        setFallo('noDisponible');
      } else if (
        error instanceof ApiError &&
        (error.status === 404 || error.status === 403)
      ) {
        // 403 TAMBIÉN AQUÍ: el servidor contesta 404 al evento ajeno, y si algún
        // día contestara 403 tampoco hay que confirmar que ese evento existe.
        setFallo('noEncontrado');
      } else if (error instanceof ApiError && esFalloDeRed(error.code)) {
        setFallo('sinConexion');
      } else {
        setFallo('red');
      }
    } finally {
      setCargando(false);
    }
  }, [id]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/mis-eventos' as never);

  if (cargando) {
    return (
      <AppScreen>
        <AppHeader title={t('posventaAdmin.tituloOrganizador')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || evento === null) {
    return (
      <AppScreen>
        <AppHeader title={t('posventaAdmin.tituloOrganizador')} onBack={volver} />
        {fallo === 'noEncontrado' || fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon={fallo === 'noDisponible' ? 'clock' : 'inbox'}
            title={
              fallo === 'noDisponible'
                ? t('misEventos.noDisponible')
                : t('posventaAdmin.eventoNoEncontrado')
            }
            description={
              fallo === 'noDisponible'
                ? t('misEventos.noDisponibleCuerpo')
                : t('posventaAdmin.eventoNoEncontradoCuerpo')
            }
          />
        ) : (
          <StateView
            state={fallo === 'sinConexion' ? 'offline' : 'error'}
            description={fallo === 'sinConexion' ? undefined : t('common.loadFailed')}
            onRetry={() => void cargar()}
          />
        )}
      </AppScreen>
    );
  }

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('posventaAdmin.tituloOrganizador')} onBack={volver} />

      <Text variant="title">{evento.title}</Text>
      <Text variant="caption" color={colors.textMuted}>
        {t(claveDelEstado(evento.workflow_status) as TranslationKey)}
      </Text>

      <View style={[styles.recuadro, { borderColor: colors.border }]}>
        <Text variant="secondary">{t('posventaAdmin.organizadorIntro')}</Text>
      </View>

      {/* LO QUE NO TIENE RUTA PROPIA SE DICE, NO SE FINGE. */}
      <Text variant="caption" color={colors.textMuted}>
        {t('posventaAdmin.casosTitulo')}
      </Text>
      <Text variant="secondary" color={colors.textMuted}>
        {t('posventaAdmin.organizadorSinCasos')}
      </Text>

      <Text variant="caption" color={colors.textMuted}>
        {t('posventaAdmin.versionesTitulo')}
      </Text>
      <Text variant="caption" color={colors.textMuted}>
        {t('posventaAdmin.clasificacionNoVisible')}
      </Text>
      {versiones.length === 0 ? (
        <Text variant="secondary" color={colors.textMuted}>
          {t('posventaAdmin.versionesVacio')}
        </Text>
      ) : (
        versiones.map((version) => (
          <View
            key={`${version.version}-${version.created_at}`}
            style={[styles.paso, { borderColor: colors.border }]}
          >
            <Text variant="secondary" weight="700">
              {t('posventaAdmin.versionNumero', { n: version.version })}
            </Text>
            {momentoLegible(version.created_at) !== '' ? (
              <Text variant="caption" color={colors.textMuted}>
                {momentoLegible(version.created_at)}
              </Text>
            ) : null}
            <Text variant="caption" color={colors.textMuted}>
              {version.changed_fields.length === 0
                ? t('posventaAdmin.versionSinCampos')
                : t('posventaAdmin.versionCampos', {
                    campos: version.changed_fields
                      .map((campo) => t(claveDelCampoDelEvento(campo) as TranslationKey))
                      .join(', '),
                  })}
            </Text>
            {version.reason.trim() !== '' ? (
              <Text variant="secondary">{version.reason}</Text>
            ) : null}
          </View>
        ))
      )}

      <Button
        label={t('posventaAdmin.volverAlEvento')}
        variant="secondary"
        onPress={() => router.replace(`/editar-evento/${evento.id}` as never)}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  recuadro: {
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  paso: {
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
});
