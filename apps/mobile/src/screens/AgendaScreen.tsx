import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Avatar } from '@/components/Avatar';
import { BotonesDeSesion } from '@/components/BotonesDeSesion';
import { SegmentedControl } from '@/components/SegmentedControl';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { useResponderSesion } from '@/hooks/useResponderSesion';
import { seccionDeLaSesion, sigueViva } from '@/lib/accionesDeSesion';
import { describeError } from '@/lib/describeError';
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
 * TU respuesta. Se parece a las solicitudes de amistad a proposito —aceptar o
 * rechazar, ahi mismo— porque es el gesto que la gente ya conoce.
 *
 * SESIONES es tu calendario: lo que has pedido tu y lo ya confirmado —lo
 * pidiera quien lo pidiera—, con el historial debajo.
 *
 * EN QUE SECCION VA CADA UNA Y QUE BOTONES LLEVA lo decide
 * `lib/accionesDeSesion.ts`, no esta pantalla. Antes lo decidia la pestana: una
 * sesion que te habian pedido se quedaba en «Solicitudes» despues de aceptarla,
 * con «Aceptar» y «Rechazar» todavia puestos, y no llegaba nunca al calendario.
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

  /*
    Responder es lo mismo aqui y en la tarjeta del chat (`useResponderSesion`):
    un toque, una peticion; cancelar se confirma; y un «eso ya no se puede» del
    servidor no es un error, es que la sesion cambio por otro lado: se vuelve a
    leer la agenda.
  */
  const { ocupada, responder } = useResponderSesion({
    alCambiar: (actualizada) =>
      setSesiones((previas) => previas.map((s) => (s.id === actualizada.id ? actualizada : s))),
    alDesfasar: () => void cargar(),
  });

  const { solicitudes, proximas, historial } = useMemo(() => {
    const salida = {
      solicitudes: [] as Sesion[],
      proximas: [] as Sesion[],
      historial: [] as Sesion[],
    };
    for (const sesion of sesiones) {
      salida[seccionDeLaSesion(sesion.estado, sesion.miRol)].push(sesion);
    }
    return salida;
  }, [sesiones]);

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
          {/* Cuándo se me puede pedir una sesión (prototipo, 09/10/2026). */}
          <Pressable
            onPress={() => router.push('/disponibilidad' as never)}
            accessibilityRole="button"
            style={[styles.disponibilidad, { borderColor: colors.border }]}
          >
            <Feather name="clock" size={16} color={colors.text} />
            <Text variant="body" weight="700" style={styles.disponibilidadTexto}>
              {t('agenda.myAvailability')}
            </Text>
            <Feather name="chevron-right" size={18} color={colors.textMuted} />
          </Pressable>
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
                      <BotonesDeSesion
                        estado={s.estado}
                        papel={s.miRol}
                        alElegir={(accion) => void responder(s.id, accion)}
                      />
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
                      <BotonesDeSesion
                        estado={s.estado}
                        papel={s.miRol}
                        alElegir={(accion) => void responder(s.id, accion)}
                      />
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
  const vivo = sigueViva(sesion.estado);

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
          {t('agenda.saving')}
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
  disponibilidad: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  disponibilidadTexto: { flex: 1 },
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
});
