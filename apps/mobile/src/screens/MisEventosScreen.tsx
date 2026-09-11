import React, { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { claveDelEstado } from '@/lib/admisionDeEvento';
import { estaEnRevision, estaPublicado } from '@/lib/eventoDelOrganizador';
import { notify } from '@/lib/confirm';
import {
  EventOrganizerRepository,
  type EventoDelOrganizador,
} from '@/repositories/EventOrganizerRepository';
import { ApiError } from '@/services/api';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * «Mis eventos»: la consola mínima de quien organiza.
 *
 * NO ES UN PANEL. Es la lista de lo suyo con el estado real de cada uno y la
 * puerta para seguir trabajando en el que toque. Lo que hace falta que quede
 * claro en una ojeada es que ENVIAR NO ES PUBLICAR: un evento en revisión no
 * se ve en el catálogo, y la fila lo dice con esas palabras.
 *
 * El sello «Seleccionado por Z» se pinta solo si el servidor lo confirma en
 * `seleccionado_por_z`. Ni se deduce del estado ni de la puntuación, que aquí
 * ni siquiera llega.
 */
export function MisEventosScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  const [eventos, setEventos] = useState<EventoDelOrganizador[]>([]);
  const [estado, setEstado] = useState<'loading' | 'content' | 'error' | 'empty'>(
    'loading',
  );
  const [noDisponible, setNoDisponible] = useState(false);
  const [hayMas, setHayMas] = useState(false);
  const [trayendoMas, setTrayendoMas] = useState(false);
  const [creando, setCreando] = useState(false);
  /** Cerrojo síncrono: dos toques no crean dos borradores. */
  const creandoRef = useRef(false);

  const cargar = useCallback(async () => {
    setEstado('loading');
    try {
      const { items, hayMas: mas } = await EventOrganizerRepository.listarMios();
      setEventos(items);
      setHayMas(mas);
      setEstado(items.length === 0 ? 'empty' : 'content');
      setNoDisponible(false);
    } catch (error) {
      /*
        POR EL CÓDIGO, NO POR EL MENSAJE. Se miraba `error.message`, que lleva
        la frase para leer; el código va en `error.code`. La condición no se
        cumplía nunca, así que con la 0060 sin aplicar —que es como se
        entrega— quien pulsaba «Mis eventos» veía un error genérico con un
        botón de reintentar que iba a fallar siempre, y todo el estado
        «todavía no está disponible», traducido a tres idiomas, era código
        muerto.
      */
      if (
        error instanceof ApiError &&
        error.code === 'events_workflow_not_available'
      ) {
        setNoDisponible(true);
        setEstado('empty');
        return;
      }
      setEstado('error');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  /**
   * La página siguiente, pedida al SERVIDOR.
   *
   * Antes se pedían 50 y ahí se acababa la lista: a partir del evento 51 el
   * contenido era inalcanzable y nada decía que estuviera recortado. El orden
   * del servidor es estable —`updated_at` y, para desempatar, el id—, así que
   * paginar no repite ni pierde filas.
   */
  const traerMas = async () => {
    if (trayendoMas || !hayMas) return;
    setTrayendoMas(true);
    try {
      const { items, hayMas: mas } = await EventOrganizerRepository.listarMios(
        eventos.length,
      );
      setEventos((previos) => [...previos, ...items]);
      setHayMas(mas);
    } catch {
      // Se deja la lista como está: lo ya traído sigue siendo válido.
      setHayMas(false);
    } finally {
      setTrayendoMas(false);
    }
  };

  const crear = async () => {
    // Sin esto, dos toques dejaban dos «Evento sin título» y solo se navegaba
    // al segundo: el primero se quedaba en la lista sin que nadie lo pidiera.
    if (creandoRef.current) return;
    creandoRef.current = true;
    setCreando(true);
    try {
      const creado = await EventOrganizerRepository.crear({
        title: t('misEventos.tituloPorDefecto'),
        description: '',
      });
      router.push(`/editar-evento/${creado.id}` as never);
    } catch (error) {
      notify(
        t('common.saveFailed'),
        error instanceof Error && error.message.trim() !== ''
          ? error.message
          : t('common.tryAgain'),
      );
    } finally {
      creandoRef.current = false;
      setCreando(false);
    }
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('misEventos.titulo')} onBack={volver} />

      {estado === 'loading' ? <StateView state="loading" /> : null}

      {estado === 'error' ? (
        <StateView
          state="error"
          description={t('common.loadFailed')}
          onRetry={() => void cargar()}
        />
      ) : null}

      {estado === 'empty' ? (
        <StateView
          state="empty"
          title={noDisponible ? t('misEventos.noDisponible') : t('misEventos.vacio')}
          description={
            noDisponible
              ? t('misEventos.noDisponibleCuerpo')
              : t('misEventos.vacioCuerpo')
          }
          actionLabel={noDisponible ? undefined : t('misEventos.crear')}
          onAction={noDisponible ? undefined : () => void crear()}
        />
      ) : null}

      {estado === 'content'
        ? eventos.map((evento) => (
            <Pressable
              key={evento.id}
              onPress={() => router.push(`/editar-evento/${evento.id}` as never)}
              style={[styles.fila, { borderColor: colors.border }]}
              accessibilityRole="button"
              accessibilityLabel={evento.title}
            >
              <View style={styles.crece}>
                <Text variant="secondary" weight="700">
                  {evento.title}
                </Text>
                <View style={styles.estado}>
                  <View
                    style={[
                      styles.punto,
                      {
                        backgroundColor: estaPublicado(evento.workflow_status)
                          ? colors.success
                          : estaEnRevision(evento.workflow_status)
                            ? colors.primary
                            : colors.textMuted,
                      },
                    ]}
                  />
                  <Text variant="caption" color={colors.textMuted}>
                    {t(claveDelEstado(evento.workflow_status) as TranslationKey)}
                  </Text>
                  {evento.seleccionado_por_z ? (
                    <Text variant="caption" color={colors.primary} weight="700">
                      {t('evento.selloZ')}
                    </Text>
                  ) : null}
                </View>
                {estaEnRevision(evento.workflow_status) ? (
                  <Text variant="caption" color={colors.textMuted}>
                    {t('misEventos.enRevisionNoSePublica')}
                  </Text>
                ) : null}
                {evento.ultima_observacion &&
                evento.ultima_observacion.decision !== 'approved' ? (
                  <Text variant="caption" color={colors.danger}>
                    {evento.ultima_observacion.reason}
                  </Text>
                ) : null}
              </View>
              <Feather name="chevron-right" size={18} color={colors.textMuted} />
            </Pressable>
          ))
        : null}

      {estado === 'content' && hayMas ? (
        <Button
          label={t('common.loadMore')}
          variant="secondary"
          onPress={() => void traerMas()}
          loading={trayendoMas}
          disabled={trayendoMas}
        />
      ) : null}

      {estado === 'content' ? (
        <Button
          label={t('misEventos.crear')}
          onPress={() => void crear()}
          loading={creando}
          disabled={creando}
        />
      ) : null}

      {/*
        LA COLA DE REVISION. Se ofrece a todo el mundo y el servidor decide:
        quien no sea curaduria recibe un 403 y la pantalla lo dice. Esconderla
        seria comodidad, no permiso, y ademas dejaria sin puerta a quien SI
        puede revisar.
      */}
      <Pressable
        onPress={() => router.push('/admin/eventos' as never)}
        style={styles.cola}
        accessibilityRole="button"
        accessibilityLabel={t('admisionEvento.cola')}
      >
        <Feather name="inbox" size={16} color={colors.textMuted} />
        <Text variant="caption" color={colors.textMuted}>
          {t('admisionEvento.cola')}
        </Text>
      </Pressable>

      {/* Las otras dos bandejas de plataforma, con la misma regla: se ofrecen y
          el servidor contesta. La de posventa la puede abrir quien gestiona
          casos; la financiera, solo quien puede mover dinero. */}
      <Pressable
        onPress={() => router.push('/admin/posventa' as never)}
        style={styles.cola}
        accessibilityRole="button"
        accessibilityLabel={t('posventaAdmin.tituloBandeja')}
      >
        <Feather name="life-buoy" size={16} color={colors.textMuted} />
        <Text variant="caption" color={colors.textMuted}>
          {t('posventaAdmin.tituloBandeja')}
        </Text>
      </Pressable>

      <Pressable
        onPress={() => router.push('/admin/finanzas' as never)}
        style={styles.cola}
        accessibilityRole="button"
        accessibilityLabel={t('finanzasEvento.tituloPanel')}
      >
        <Feather name="dollar-sign" size={16} color={colors.textMuted} />
        <Text variant="caption" color={colors.textMuted}>
          {t('finanzasEvento.tituloPanel')}
        </Text>
      </Pressable>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    minHeight: 44,
  },
  crece: { flex: 1, gap: 4 },
  estado: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  punto: { width: 8, height: 8, borderRadius: 4 },
  cola: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 44,
  },
});
