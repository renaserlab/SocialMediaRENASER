import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { SegmentedControl } from '@/components/SegmentedControl';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { describeError } from '@/lib/describeError';
import { toast } from '@/lib/toast';
import {
  BookingRepository,
  type EstadoDeSesion,
  type Sesion,
} from '@/repositories/BookingRepository';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { traduceEnElIdiomaActual, type TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';

// Claves, no textos: el estado se lee en el idioma elegido.
const NOMBRE_DE_ESTADO: Record<EstadoDeSesion, TranslationKey> = {
  pending: 'agenda.statePending',
  accepted: 'agenda.stateAccepted',
  rejected: 'agenda.stateRejected',
  cancelled: 'agenda.stateCancelled',
  reschedule_requested: 'agenda.stateRescheduled',
  completed: 'agenda.stateCompleted',
  expired: 'agenda.stateExpired',
};

/** Estados que siguen vivos: se ensenan arriba, separados del historial. */
const VIVOS: EstadoDeSesion[] = ['pending', 'accepted', 'reschedule_requested'];

function fechaLegible(iso: string | null): string {
  const sinFecha = () => traduceEnElIdiomaActual('agenda.dateTbd');
  if (!iso) return sinFecha();
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return sinFecha();
  return fecha.toLocaleString(undefined, {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Agenda: las sesiones 1:1, en sus dos lecturas.
 *
 * SOLICITUDES es la bandeja: lo que otras personas te piden y sigue esperando
 * respuesta. Se parece a las solicitudes de amistad a proposito —aceptar o
 * rechazar, ahi mismo— porque es el gesto que la gente ya conoce.
 *
 * SESIONES es tu calendario: lo que has pedido tu y lo ya confirmado, con el
 * historial debajo. Son dos lecturas distintas de la misma tabla, y mezclarlas
 * obliga a averiguar en cada fila de que lado estas.
 */
export function AgendaScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const signedIn = useAuthStore((state) => state.status === 'authenticated');
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);

  const [pestana, setPestana] = useState(0);
  const [sesiones, setSesiones] = useState<Sesion[]>([]);
  const [estado, setEstado] = useState<'cargando' | 'listo' | 'error'>('cargando');
  const [error, setError] = useState<string | null>(null);
  const [refrescando, setRefrescando] = useState(false);
  /** Sesion sobre la que hay una accion en curso: apaga sus botones. */
  const [ocupada, setOcupada] = useState<string | null>(null);
  /*
    El cerrojo de verdad va en una referencia. Con estado, dos toques en el
    mismo instante leen el valor viejo y salen los dos: el segundo falla con
    «esa acción ya no es posible», que se lee como un error cuando en realidad
    ya se hizo. Es el mismo motivo por el que `usePublicacion` usa `ocupadoRef`.
  */
  const ocupadaRef = useRef<string | null>(null);

  const cargar = useCallback(async () => {
    if (supabaseEnabled && !signedIn) {
      setEstado('listo');
      setSesiones([]);
      return;
    }
    try {
      setError(null);
      setSesiones(await BookingRepository.list('all'));
      setEstado('listo');
    } catch (e) {
      console.warn('[agenda] no se pudo cargar', e);
      setError(describeError(e, t('agenda.loadFailedBody')));
      setEstado('error');
    }
  }, [signedIn, supabaseEnabled]);

  /*
    Se recarga al VOLVER a la pantalla, no solo al montarla: si se acepta una
    sesion desde el aviso y se vuelve aqui, la lista tiene que reflejarlo.
  */
  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );

  const refrescar = useCallback(async () => {
    setRefrescando(true);
    try {
      await cargar();
    } finally {
      setRefrescando(false);
    }
  }, [cargar]);

  const responder = useCallback(
    async (sesion: Sesion, nuevo: Exclude<EstadoDeSesion, 'pending' | 'expired'>) => {
      if (ocupadaRef.current) return;
      ocupadaRef.current = sesion.id;
      setOcupada(sesion.id);
      try {
        const actualizada = await BookingRepository.update(sesion.id, nuevo);
        setSesiones((previas) =>
          previas.map((s) => (s.id === actualizada.id ? actualizada : s)),
        );
        toast(
          nuevo === 'accepted'
            ? t('notif.sessionAcceptedTitle')
            : nuevo === 'rejected'
            ? t('notif.sessionRejectedTitle')
            : nuevo === 'completed'
            ? t('agenda.markedDone')
            : t('notif.sessionCancelledTitle'),
        );
      } catch (e) {
        toast(describeError(e, t('agenda.updateFailed')));
      } finally {
        ocupadaRef.current = null;
        setOcupada(null);
      }
    },
    [],
  );

  const solicitudes = useMemo(
    () => sesiones.filter((s) => s.miRol === 'provider' && VIVOS.includes(s.estado)),
    [sesiones],
  );
  const mias = useMemo(
    () =>
      sesiones.filter(
        (s) => s.miRol === 'requester' || (s.miRol === 'provider' && !VIVOS.includes(s.estado)),
      ),
    [sesiones],
  );

  const proximas = useMemo(() => mias.filter((s) => VIVOS.includes(s.estado)), [mias]);
  const historial = useMemo(() => mias.filter((s) => !VIVOS.includes(s.estado)), [mias]);

  if (supabaseEnabled && !signedIn) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <AppHeader title={t('agenda.headerTitle')} onBack={() => router.back()} />
        <StateView
          state="empty"
          icon="calendar"
          title={t('agenda.signInTitle')}
          description={t('agenda.signInBody')}
          actionLabel={t('auth.signIn')}
          onAction={() => router.push('/login' as never)}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader title={t('agenda.headerTitle')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/profile'))} />

      <AppScreen
        contentStyle={{ paddingBottom: 140 }}
        scrollProps={{
          refreshControl: (
            <RefreshControl
              refreshing={refrescando}
              onRefresh={refrescar}
              tintColor={colors.text}
              colors={[colors.text]}
            />
          ),
        }}
      >
        <View style={styles.contenedor}>
          <SegmentedControl
            options={[
              solicitudes.length > 0
                ? t('agenda.requestsWithCount', { count: solicitudes.length })
                : t('agenda.requests'),
              t('agenda.sessions'),
            ]}
            selectedIndex={pestana}
            onChange={setPestana}
            style={styles.pestanas}
          />

          {estado === 'cargando' ? (
            <StateView state="loading" />
          ) : estado === 'error' ? (
            <StateView
              state="error"
              icon="wifi-off"
              title={t('agenda.loadFailed')}
              description={error ?? t('common.checkConnection')}
              onRetry={() => void cargar()}
            />
          ) : pestana === 0 ? (
            solicitudes.length === 0 ? (
              <StateView
                state="empty"
                icon="inbox"
                title={t('agenda.noRequests')}
                description={t('agenda.noRequestsBody')}
              />
            ) : (
              <View style={styles.lista}>
                {solicitudes.map((s) => (
                  <Tarjeta
                    key={s.id}
                    sesion={s}
                    persona={s.quienPide}
                    encabezado={t('agenda.wantsToBook', { nombre: s.quienPide.nombre })}
                    ocupada={ocupada === s.id}
                    acciones={
                      <View style={styles.acciones}>
                        <Button
                          label={t('agenda.accept')}
                          onPress={() => void responder(s, 'accepted')}
                          disabled={ocupada === s.id}
                          style={styles.accion}
                        />
                        <Button
                          label={t('agenda.reject')}
                          variant="secondary"
                          onPress={() => void responder(s, 'rejected')}
                          disabled={ocupada === s.id}
                          style={styles.accion}
                        />
                      </View>
                    }
                    alAbrirChat={
                      s.conversacionId
                        ? () =>
                            router.push({
                              pathname: '/chat/[id]',
                              params: { id: s.conversacionId!, name: s.quienPide.nombre },
                            } as never)
                        : undefined
                    }
                  />
                ))}
              </View>
            )
          ) : proximas.length === 0 && historial.length === 0 ? (
            <StateView
              state="empty"
              icon="calendar"
              title={t('agenda.emptyTitle')}
              description={t('agenda.emptyBody')}
              actionLabel={t('home.discoverPeople')}
              onAction={() => router.navigate('/(tabs)/explore')}
            />
          ) : (
            <View style={styles.lista}>
              {proximas.length > 0 ? (
                <Text variant="caption" weight="800" color={colors.textMuted} style={styles.titulo}>
                  {t('agenda.upcoming')}
                </Text>
              ) : null}
              {proximas.map((s) => {
                const otra = s.miRol === 'requester' ? s.quienDa : s.quienPide;
                return (
                  <Tarjeta
                    key={s.id}
                    sesion={s}
                    persona={otra}
                    encabezado={
                      s.miRol === 'requester'
                        ? t('agenda.youAsked', { nombre: otra.nombre })
                        : t('agenda.sessionWith', { nombre: otra.nombre })
                    }
                    ocupada={ocupada === s.id}
                    acciones={
                      <View style={styles.acciones}>
                        {s.estado === 'accepted' ? (
                          <Button
                            label={t('agenda.weDidIt')}
                            onPress={() => void responder(s, 'completed')}
                            disabled={ocupada === s.id}
                            style={styles.accion}
                          />
                        ) : null}
                        <Button
                          label={t('common.cancel')}
                          variant="secondary"
                          onPress={() => void responder(s, 'cancelled')}
                          disabled={ocupada === s.id}
                          style={styles.accion}
                        />
                      </View>
                    }
                    alAbrirChat={
                      s.conversacionId
                        ? () =>
                            router.push({
                              pathname: '/chat/[id]',
                              params: { id: s.conversacionId!, name: otra.nombre },
                            } as never)
                        : undefined
                    }
                  />
                );
              })}

              {historial.length > 0 ? (
                <Text variant="caption" weight="800" color={colors.textMuted} style={styles.titulo}>
                  {t('agenda.history')}
                </Text>
              ) : null}
              {historial.map((s) => {
                const otra = s.miRol === 'requester' ? s.quienDa : s.quienPide;
                return (
                  <Tarjeta
                    key={s.id}
                    sesion={s}
                    persona={otra}
                    encabezado={t('agenda.sessionWith', { nombre: otra.nombre })}
                    ocupada={false}
                  />
                );
              })}
            </View>
          )}
        </View>
      </AppScreen>
    </View>
  );
}

function Tarjeta({
  sesion,
  persona,
  encabezado,
  acciones,
  alAbrirChat,
  ocupada,
}: {
  sesion: Sesion;
  persona: { nombre: string; avatarUrl?: string };
  encabezado: string;
  acciones?: React.ReactNode;
  alAbrirChat?: () => void;
  ocupada: boolean;
}) {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const vivo = VIVOS.includes(sesion.estado);

  return (
    <View style={[styles.tarjeta, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <View style={styles.cabecera}>
        <Avatar size={40} image={persona.avatarUrl ?? null} name={persona.nombre} />
        <View style={{ flex: 1 }}>
          <Text variant="secondary" weight="700" color={colors.text}>
            {encabezado}
          </Text>
          {/*
            El estado se dice con palabras, no solo con un color: sobre un
            fondo claro dos tonos parecidos no distinguen «confirmada» de
            «cancelada», y quien no distingue colores no ve ninguna diferencia.
          */}
          <Text
            variant="caption"
            weight="700"
            color={vivo ? colors.primary : colors.textMuted}
          >
            {t(NOMBRE_DE_ESTADO[sesion.estado])}
          </Text>
        </View>
        {alAbrirChat ? (
          <Pressable
            onPress={alAbrirChat}
            hitSlop={8}
            style={styles.chat}
            accessibilityRole="button"
            accessibilityLabel={t('agenda.openChat')}
          >
            <Feather name="message-square" size={18} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.detalle}>
        <Fila icono="bookmark" texto={sesion.tema} />
        <Fila icono="calendar" texto={fechaLegible(sesion.cuandoIso)} />
        {sesion.nota ? <Fila icono="message-circle" texto={sesion.nota} /> : null}
      </View>

      {ocupada ? (
        <Text variant="caption" color={colors.textMuted}>
          Guardando…
        </Text>
      ) : (
        acciones
      )}
    </View>
  );
}

function Fila({ icono, texto }: { icono: keyof typeof Feather.glyphMap; texto: string }) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.fila}>
      <Feather name={icono} size={14} color={colors.textMuted} />
      <Text variant="caption" color={colors.text} style={{ flex: 1 }}>
        {texto}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  contenedor: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  pestanas: { marginBottom: spacing.lg },
  lista: { gap: spacing.md },
  titulo: { textTransform: 'uppercase', letterSpacing: 1, marginTop: spacing.sm },
  tarjeta: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  chat: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  detalle: { gap: 4 },
  fila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  acciones: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  accion: { flex: 1 },
});
