import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { notify } from '@/lib/confirm';
import { useFocusEffect, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { SectionTitle } from '@/components/SectionTitle';
import { StateView } from '@/components/StateView';
import { SinCambioDeSeccion } from '@/navigation/tabSwipe';
import { assets } from '@/data/assets';
import { events as mockEvents } from '@/data/mockData';
import { useTranslation } from '@/i18n/useTranslation';
import { CatalogRepository } from '@/repositories/CatalogRepository';
import type { ModalidadDeEvento } from '@/repositories/CatalogRepository';
import { useAppStore } from '@/store/useAppStore';
import { useAuthStore } from '@/store/useAuthStore';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { EventItem } from '@/types';

/** Las modalidades que el servidor acepta, y «todas». Ni una más. */
const MODALIDADES: Array<{
  clave: 'eventos.todasLasModalidades' | 'evento.modalidad.presencial' | 'evento.modalidad.online' | 'evento.modalidad.live';
  valor: ModalidadDeEvento | null;
}> = [
  { clave: 'eventos.todasLasModalidades', valor: null },
  { clave: 'evento.modalidad.presencial', valor: 'presential' },
  { clave: 'evento.modalidad.online', valor: 'online' },
  { clave: 'evento.modalidad.live', valor: 'live' },
];

/**
 * La agenda de eventos, con lo vigente separado de lo que ya pasó.
 *
 * QUÉ ESTABA MAL. Esta pantalla se titulaba «Próximos eventos» y pintaba, en
 * una sola lista, todo lo que devolvía el catálogo: un evento del 19 de agosto
 * salía delante de otro de octubre, con el mismo botón «Reservar» y sin nada
 * que dijera que ya había ocurrido. El primero de la lista además se llevaba la
 * tarjeta grande, así que lo más destacado de la pantalla podía ser justo lo
 * único a lo que ya no se puede ir.
 *
 * QUIÉN CLASIFICA. El servidor, con `starts_at` y `ends_at` (ver
 * `catalog/eventos.py`), y lo manda en `timeState`. Aquí NO se compara ninguna
 * fecha, y mucho menos el texto `date`, que es la cadena ya formateada para
 * leerse.
 *
 * LO ANTERIOR NO SE ESCONDE. Sigue en la pantalla, en su propio bloque y al
 * final: saber qué se hizo antes es parte de conocer un proyecto. Lo que no
 * hace es competir con lo que todavía se puede reservar.
 */
export function EventsScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const router = useRouter();
  const supabaseEnabled = useAuthStore((state) => state.supabaseEnabled);
  const demoReserved = useAppStore((state) => state.reservedEventIds);
  const demoToggle = useAppStore((state) => state.toggleReservation);

  const [remoteEvents, setRemoteEvents] = useState<EventItem[]>([]);
  const [remoteReserved, setRemoteReserved] = useState<string[]>([]);
  const [status, setStatus] = useState<'loading' | 'idle' | 'error'>('loading');
  /*
    BUSCAR Y FILTRAR LOS RESUELVE EL SERVIDOR. Hacerlo sobre lo ya descargado
    deja fuera todo lo que no cupo en la página, y entonces el resultado depende
    de cuánto se haya bajado en vez de de lo que hay.
  */
  const [texto, setTexto] = useState('');
  const [modalidad, setModalidad] = useState<ModalidadDeEvento | null>(null);
  /** Lo que de verdad se pidió: el texto se manda al dejar de escribir. */
  const [buscado, setBuscado] = useState('');

  const load = useCallback(() => {
    if (!supabaseEnabled) {
      setStatus('idle');
      return;
    }
    setStatus('loading');
    // `all`: aquí se quieren los tres grupos y el servidor ya los devuelve
    // ordenados —vigentes, sin fecha, anteriores—, así que una sola petición
    // basta y la paginación sigue teniendo sentido.
    CatalogRepository.listEvents('all', 50, { texto: buscado, modalidad })
      .then(({ items, reservedIds }) => {
        setRemoteEvents(items);
        setRemoteReserved(reservedIds);
        setStatus('idle');
      })
      .catch(() => setStatus('error'));
  }, [supabaseEnabled, buscado, modalidad]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  /*
    Una petición por búsqueda, no una por letra. Medio segundo después de la
    última tecla: escribir «respiración» son once pulsaciones y once listados
    que se pisan entre sí, y el que gana no es necesariamente el último.
  */
  useEffect(() => {
    const t = setTimeout(() => setBuscado(texto), 500);
    return () => clearTimeout(t);
  }, [texto]);

  const events = supabaseEnabled ? remoteEvents : mockEvents;
  const reservedIds = supabaseEnabled ? remoteReserved : demoReserved;

  /*
    Los tres grupos, tal y como los etiquetó el servidor.

    Esto NO es filtrar en el cliente lo que se descargó: la clasificación ya
    viene resuelta y aquí solo se reparte en secciones para poder ponerles
    título. Sin backend (`supabaseEnabled` falso) el catálogo es el de
    demostración, que no tiene fechas reales sino cadenas ya escritas: ahí no
    se agrupa nada, porque clasificar por el texto de la fecha es exactamente
    lo que no se puede hacer.
  */
  const grupos = useMemo(() => {
    const proximos: EventItem[] = [];
    const sinFecha: EventItem[] = [];
    const anteriores: EventItem[] = [];
    for (const evento of events) {
      if (evento.timeState === 'past') anteriores.push(evento);
      else if (evento.timeState === 'undated') sinFecha.push(evento);
      else proximos.push(evento);
    }
    return { proximos, sinFecha, anteriores };
  }, [events]);

  const toggle = async (id: string) => {
    if (!supabaseEnabled) {
      demoToggle(id);
      return;
    }
    const was = remoteReserved.includes(id);
    setRemoteReserved((prev) => (was ? prev.filter((x) => x !== id) : [...prev, id]));
    try {
      if (was) await CatalogRepository.cancelReservation(id);
      else await CatalogRepository.reserve(id);
    } catch {
      setRemoteReserved((prev) => (was ? [...prev, id] : prev.filter((x) => x !== id)));
      notify(t('event.reservationFailed'), t('common.tryAgain'));
    }
  };

  const uiState = supabaseEnabled && status === 'loading'
    ? 'loading'
    : supabaseEnabled && status === 'error'
    ? 'error'
    : events.length === 0
    ? 'empty'
    : 'content';

  /** Una fila de evento. `finalizado` quita la reserva y lo dice. */
  const fila = (event: EventItem, finalizado: boolean) => {
    const isReserved = reservedIds.includes(event.id);
    return (
      <View
        key={event.id}
        style={[
          styles.rowCard,
          { backgroundColor: colors.surface, borderColor: colors.border },
          // Un evento terminado se lee, pero no compite con lo vigente.
          finalizado ? styles.terminado : null,
        ]}
      >
        {/* La portada REAL del evento; el asset local solo si no tiene. */}
        <Image
          source={event.coverUrl ? { uri: event.coverUrl } : assets.event}
          style={[styles.thumb, { borderColor: colors.border }]}
        />
        <Pressable
          style={{ flex: 1 }}
          onPress={() => router.push(`/eventos/${event.id}` as never)}
          accessibilityRole="button"
          accessibilityLabel={event.title}
        >
          <Text style={[styles.title, { color: colors.text }]}>{event.title}</Text>
          <Text style={[styles.description, { color: colors.textMuted }]}>
            {event.description}
          </Text>
          <Text style={[styles.meta, { color: colors.textMuted }]}>
            {event.date} · {event.location}
          </Text>
        </Pressable>
        {/*
          NUNCA UN BOTÓN MUERTO. Un evento que ya terminó no se reserva, así
          que no se ofrece un botón que iba a no servir de nada: se dice que
          está finalizado, que es la información que falta.
        */}
        {finalizado ? (
          <View style={[styles.finalizado, { borderColor: colors.border }]}>
            <Feather name="check" size={13} color={colors.textMuted} />
            <Text style={[styles.finalizadoTexto, { color: colors.textMuted }]}>
              {t('event.finished')}
            </Text>
          </View>
        ) : (
          <Pressable
            onPress={() => (event.type === 'live' ? router.push('/live/main') : toggle(event.id))}
            style={[styles.reserve, { backgroundColor: colors.primary }]}
            accessibilityLabel={
              isReserved
                ? t('event.reserved')
                : event.type === 'live'
                  ? t('event.watchBroadcast')
                  : t('event.reserve')
            }
            accessibilityRole="button"
          >
            <Feather
              name={isReserved ? 'check' : event.type === 'live' ? 'video' : 'plus'}
              size={18}
              color={colors.onPrimary}
            />
          </Pressable>
        )}
      </View>
    );
  };

  /** El primero de lo vigente, en grande: es lo siguiente que va a ocurrir. */
  const destacado = (event: EventItem) => {
    const isReserved = reservedIds.includes(event.id);
    return (
      <View key={event.id} style={styles.mainCard}>
        <Image
          source={event.coverUrl ? { uri: event.coverUrl } : assets.event}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
        />
        <View style={[styles.overlay, { backgroundColor: colors.overlay }]} />
        <View style={styles.mainContent}>
          <Text style={styles.tag}>{event.type.toUpperCase()}</Text>
          <Text style={styles.mainTitle}>{event.title}</Text>
          <Text style={styles.mainDescription}>{event.description}</Text>
          <Text style={styles.mainMeta}>{event.date}{`\n`}{event.location}</Text>
          <Button
            label={isReserved ? t('event.reserved') : t('event.viewAndReserve')}
            variant={isReserved ? 'secondary' : 'primary'}
            onPress={() => toggle(event.id)}
            style={{ marginTop: spacing.lg }}
          />
        </View>
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <AppHeader
        /*
          El título ya no es «Próximos eventos»: la pantalla enseña también los
          anteriores. Un encabezado que solo describe una parte de lo que hay
          debajo es la misma incoherencia de antes, escrita más arriba.
        */
        title={t('events.title')}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
      <AppScreen contentStyle={{ paddingBottom: spacing.xl }}>
        <View style={styles.container}>
          {/*
            BUSCADOR Y MODALIDAD, resueltos EN EL SERVIDOR. Sin backend no se
            ofrecen: el catálogo de demostración no se puede consultar.
          */}
          {supabaseEnabled ? (
            <React.Fragment>
              <View style={[styles.buscador, { borderColor: colors.border }]}>
                <Feather name="search" size={16} color={colors.textMuted} />
                <TextInput
                  value={texto}
                  onChangeText={setTexto}
                  placeholder={t('eventos.buscar')}
                  placeholderTextColor={colors.textMuted}
                  accessibilityLabel={t('eventos.buscar')}
                  style={[styles.entrada, { color: colors.text }]}
                  returnKeyType="search"
                />
                {texto !== '' ? (
                  <Pressable
                    onPress={() => setTexto('')}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.close')}
                  >
                    <Feather name="x" size={16} color={colors.textMuted} />
                  </Pressable>
                ) : null}
              </View>
              <SinCambioDeSeccion>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.modalidades}
                >
                  {MODALIDADES.map((opcion) => {
                    const elegida = modalidad === opcion.valor;
                    return (
                      <Pressable
                        key={opcion.clave}
                        onPress={() => setModalidad(opcion.valor)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: elegida }}
                        accessibilityLabel={t(opcion.clave)}
                        style={[
                          styles.modalidad,
                          {
                            borderColor: elegida ? colors.text : colors.border,
                            backgroundColor: elegida ? colors.surfaceAlt : 'transparent',
                          },
                        ]}
                      >
                        <Text style={{ color: colors.text, fontSize: 13 }}>
                          {t(opcion.clave)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </SinCambioDeSeccion>
            </React.Fragment>
          ) : null}

          <StateView
            state={uiState}
            onRetry={load}
            title={uiState === 'empty' ? t('events.emptyTitle') : undefined}
            description={
              uiState !== 'empty'
                ? undefined
                : // «No hay eventos» y «no hay resultados» son dos cosas
                  // distintas: la segunda tiene arreglo cambiando la búsqueda.
                  buscado !== '' || modalidad !== null
                  ? t('eventos.sinResultados')
                  : t('events.emptyBody')
            }
          >
            {!supabaseEnabled ? (
              // Catálogo de demostración: sin fechas reales no hay nada que
              // clasificar, así que se pinta la lista tal cual.
              events.map((event, index) =>
                index === 0 ? destacado(event) : fila(event, false),
              )
            ) : (
              <React.Fragment>
                {grupos.proximos.length > 0 ? (
                  <React.Fragment>
                    <SectionTitle title={t('events.upcoming')} />
                    {grupos.proximos.map((event, index) =>
                      index === 0 ? destacado(event) : fila(event, false),
                    )}
                  </React.Fragment>
                ) : null}

                {grupos.sinFecha.length > 0 ? (
                  <React.Fragment>
                    {/*
                      Ni futuros ni pasados: anunciados sin fecha. Tienen su
                      propio bloque porque colocarlos en cualquiera de los
                      otros dos sería inventarles una fecha que nadie dio.
                    */}
                    <SectionTitle title={t('events.undated')} />
                    {grupos.sinFecha.map((event) => fila(event, false))}
                  </React.Fragment>
                ) : null}

                {grupos.anteriores.length > 0 ? (
                  <React.Fragment>
                    <SectionTitle title={t('events.past')} />
                    {grupos.anteriores.map((event) => fila(event, true))}
                  </React.Fragment>
                ) : null}
              </React.Fragment>
            )}
          </StateView>
        </View>
      </AppScreen>
    </View>
  );
}

const styles = StyleSheet.create({
  buscador: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    minHeight: 44,
    marginBottom: spacing.md,
  },
  entrada: { flex: 1, paddingVertical: spacing.sm, fontSize: 14 },
  modalidades: { gap: spacing.sm, paddingBottom: spacing.md },
  modalidad: {
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
    minHeight: 40,
  },
  container: { paddingHorizontal: spacing.lg },
  mainCard: { height: 460, borderRadius: radius.xl, overflow: 'hidden', justifyContent: 'flex-end', marginBottom: spacing.lg, borderWidth: 1, borderColor: '#333' },
  overlay: { ...StyleSheet.absoluteFillObject },
  mainContent: { padding: spacing.xl },
  tag: { color: '#DADADA', fontSize: 10, letterSpacing: 1.5, fontWeight: '800' },
  mainTitle: { color: '#FFFFFF', fontSize: 32, fontWeight: '900', marginTop: spacing.sm },
  mainDescription: { color: '#E7E7E7', fontSize: 13, lineHeight: 18, marginTop: spacing.sm },
  mainMeta: { color: '#FFFFFF', fontSize: 12, lineHeight: 18, fontWeight: '800', marginTop: spacing.lg },
  rowCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  // Lo finalizado se atenúa, pero se sigue leyendo: la distinción NO puede
  // depender solo de eso, y por eso lleva además la etiqueta «Finalizado».
  terminado: { opacity: 0.72 },
  thumb: { width: 70, height: 86, borderRadius: radius.md, borderWidth: 1 },
  title: { fontSize: 14, fontWeight: '800' },
  description: { fontSize: 11, lineHeight: 16, marginTop: 4 },
  meta: { fontSize: 10, marginTop: spacing.sm },
  reserve: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  finalizado: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
  },
  finalizadoTexto: { fontSize: 10, fontWeight: '800' },
});
