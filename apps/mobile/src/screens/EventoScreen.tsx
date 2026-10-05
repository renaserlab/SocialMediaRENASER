import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { assets } from '@/data/assets';
import { confirm, notify } from '@/lib/confirm';
import { importeConMoneda } from '@/lib/dinero';
import { vendeEntradas } from '@/lib/entradasDeEvento';
import { irAlPerfil } from '@/lib/irAlPerfil';
import { toast } from '@/lib/toast';
import {
  aforoDelEvento,
  fechaLargaDelEvento,
  iconoDeLaModalidad,
  modalidadDelEvento,
  sePuedeReservar,
} from '@/lib/eventoEnDetalle';
import { CatalogRepository } from '@/repositories/CatalogRepository';
import { radius, spacing } from '@/theme/tokens';
import type { EventItem } from '@/types';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';

/**
 * La ficha de un evento (blueprint §7.2).
 *
 * NO EXISTÍA. Tocar un evento —desde Explorar, desde la búsqueda, desde el
 * listado— abría la LISTA entera, donde ese evento era una fila más.
 *
 * EL SELLO «SELECCIONADO POR Z» SÍ SE PINTA, y solo cuando el servidor lo
 * confirma en `seleccionado_por_z`. Sale de `selection_status = 'approved'`,
 * que únicamente escribe una decisión de admisión real; un evento heredado no
 * lo lleva por llevar tiempo publicado.
 *
 * LO QUE NO SE PINTA, y cada omisión es una decisión, no un olvido:
 *
 *   - «A 2 km de ti»: `events` no tiene coordenadas. La distancia es la
 *     afirmación más comprobable de la captura y no hay con qué hacerla.
 *   - El precio y «Elegir entradas»: los eventos no tienen precio ni entradas.
 *   - «Por qué está en Z»: no hay verificaciones guardadas en ninguna parte.
 *   - La zona horaria del evento: `starts_at` guarda el instante, no la zona.
 *     Se muestra en la del dispositivo, que es lo único que de verdad se sabe.
 *
 * El detalle está en `docs/Z_EVENTOS_ESPECIFICACION.md`.
 */
export function EventoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [evento, setEvento] = useState<EventItem | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState(false);
  const [reservando, setReservando] = useState(false);
  /** Cerrojo síncrono: dos toques no mandan dos reservas. */
  const reservandoRef = useRef(false);
  const generacionRef = useRef(0);

  const cargar = useCallback(async () => {
    if (!id) return;
    generacionRef.current += 1;
    const generacion = generacionRef.current;
    setCargando(true);
    setFallo(false);
    try {
      const datos = await CatalogRepository.getEvent(id);
      if (generacionRef.current !== generacion) return;
      setEvento(datos);
    } catch {
      if (generacionRef.current !== generacion) return;
      setFallo(true);
    } finally {
      if (generacionRef.current === generacion) setCargando(false);
    }
  }, [id]);

  useEffect(() => {
    void cargar();
    return () => {
      generacionRef.current += 1;
    };
  }, [cargar]);

  const alternarReserva = async () => {
    if (reservandoRef.current || !evento) return;
    // Echado ANTES del primer `await`, que aquí puede ser el propio diálogo.
    reservandoRef.current = true;
    try {
      if (evento.reservedByMe) {
        const aceptado = await confirm({
          title: t('evento.cancelarTitulo'),
          message: t('evento.cancelarCuerpo'),
          confirmLabel: t('evento.cancelarConfirmar'),
          destructive: true,
        });
        if (!aceptado) return;
      }
      setReservando(true);
      if (evento.reservedByMe) {
        await CatalogRepository.cancelReservation(evento.id);
        toast(t('evento.reservaCancelada'));
      } else {
        await CatalogRepository.reserve(evento.id);
        toast(t('evento.reservada'));
      }
      // Se vuelve a pedir: el conteo de inscritos y el aforo los lleva el
      // servidor, y recalcularlos aquí sería inventarlos.
      await cargar();
    } catch (error) {
      notify(
        t('common.saveFailed'),
        error instanceof Error && error.message.trim() !== ''
          ? error.message
          : t('common.tryAgain'),
      );
    } finally {
      reservandoRef.current = false;
      setReservando(false);
    }
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/events');

  // A pantalla completa SOLO la primera vez. Tras reservar o cancelar se vuelve
  // a pedir el evento, y sustituir la ficha entera por «Cargando…» la hacía
  // parpadear y perder la posición.
  if (cargando && !evento) {
    return (
      <AppScreen>
        <AppHeader title={t('evento.titulo')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo || !evento) {
    return (
      <AppScreen>
        <AppHeader title={t('evento.titulo')} onBack={volver} />
        <StateView
          state="error"
          description={t('common.loadFailed')}
          onRetry={() => void cargar()}
        />
      </AppScreen>
    );
  }

  const fecha = fechaLargaDelEvento(evento);
  const aforo = aforoDelEvento(evento);
  const puedeReservar = sePuedeReservar(evento);

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={t('evento.titulo')} onBack={volver} />

      <Image
        source={evento.coverUrl ? { uri: evento.coverUrl } : assets.event}
        style={styles.portada}
        resizeMode="cover"
        accessibilityIgnoresInvertColors
      />

      {/*
        EL SELLO, y solo si el servidor lo confirma. `seleccionadoPorZ` viene de
        `selection_status = 'approved'`, que solo escribe una decision de
        admision real: un evento heredado —publicado antes de que existiera la
        curaduria— no lo lleva por llevar tiempo publicado.
      */}
      {evento.seleccionadoPorZ ? (
        <View style={[styles.sello, { borderColor: colors.primary }]}>
          <Feather name="award" size={14} color={colors.primary} />
          <Text variant="caption" color={colors.primary} weight="700">
            {t('evento.selloZ')}
          </Text>
        </View>
      ) : null}

      <Text variant="title">{evento.title}</Text>

      {/* Fecha, modalidad y lugar. Cada uno SOLO si consta. */}
      {fecha ? (
        <Dato icono="calendar" texto={fecha} />
      ) : (
        <Dato icono="calendar" texto={t('evento.sinFecha')} />
      )}
      <Dato icono={iconoDeLaModalidad(evento)} texto={t(modalidadDelEvento(evento))} />
      {evento.location ? <Dato icono="map-pin" texto={evento.location} /> : null}
      {aforo !== null ? (
        <Dato
          icono="users"
          texto={t('evento.inscritosDeAforo', {
            inscritos: evento.registrationsCount ?? 0,
            aforo,
          })}
        />
      ) : (
        <Dato
          icono="users"
          texto={t('evento.inscritos', { inscritos: evento.registrationsCount ?? 0 })}
        />
      )}

      {/* El organizador, con acceso a su perfil real. */}
      {evento.organizerId ? (
        <Pressable
          onPress={() => irAlPerfil(router, evento.organizerId as string)}
          style={[styles.organizador, { borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel={t('evento.verOrganizador')}
        >
          <Feather name="user" size={16} color={colors.textMuted} />
          <View style={styles.crece}>
            <Text variant="caption" color={colors.textMuted}>
              {t('evento.organiza')}
            </Text>
            {/* El servidor manda '' cuando no encuentra el perfil: sin nombre y
                sin usuario no se escribe ninguno. */}
            <Text variant="secondary" weight="700">
              {evento.organizerName?.trim() ||
                (evento.organizerUsername?.trim()
                  ? `@${evento.organizerUsername.trim()}`
                  : t('evento.organizadorSinNombre'))}
            </Text>
          </View>
          <Feather name="chevron-right" size={18} color={colors.textMuted} />
        </Pressable>
      ) : null}

      {evento.description ? (
        <Text variant="body" style={styles.descripcion}>
          {evento.description}
        </Text>
      ) : null}

      {/* El grupo donde se dan los detalles, si el organizador lo puso. */}
      {evento.whatsappUrl ? (
        <Button
          label={t('evento.grupo')}
          variant="secondary"
          onPress={() => void Linking.openURL(evento.whatsappUrl as string)}
        />
      ) : null}

      {/*
        LA ACCIÓN PRINCIPAL. Reservar es lo único que hoy tiene respaldo: no hay
        precio, ni entradas, ni pago de eventos. Ofrecer «Comprar» sería
        prometer un flujo que no existe.
      */}
      {/*
        LOS DOS FLUJOS NO CONVIVEN. Un evento gratuito ofrece «Reservar»; uno con
        entradas, «Elegir entradas». Enseñar los dos dejaría a alguien apuntado
        gratis a un evento que vende entradas.

        `accessMode` a `null` significa «no se preguntó», y entonces se ofrece lo
        de siempre: es el comportamiento heredado y el único que no inventa nada.
      */}
      {puedeReservar && vendeEntradas(evento.accessMode) ? (
        <>
          {evento.precioDesde !== null &&
          evento.precioDesde !== undefined &&
          typeof evento.monedaDelPrecio === 'string' ? (
            <Text variant="secondary" weight="700">
              {t('evento.desde', {
                // LA MONEDA LA DICE EL SERVIDOR. Sin ella no se escribe el
                // precio: mejor callar que afirmar «S/» sobre dolares.
                importe: importeConMoneda(
                  evento.precioDesde,
                  evento.monedaDelPrecio as string,
                ),
              })}
            </Text>
          ) : null}
          <Button
            label={t('evento.elegirEntradas')}
            onPress={() => router.push(`/entradas/${evento.id}` as never)}
          />
        </>
      ) : puedeReservar ? (
        <Button
          label={evento.reservedByMe ? t('evento.cancelar') : t('evento.reservar')}
          variant={evento.reservedByMe ? 'secondary' : 'primary'}
          onPress={() => void alternarReserva()}
          loading={reservando}
          disabled={reservando}
        />
      ) : (
        <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
          <Feather name="clock" size={16} color={colors.textMuted} />
          <Text variant="secondary" color={colors.textMuted} style={styles.crece}>
            {evento.timeState === 'past'
              ? t('evento.finalizado')
              : t('evento.sinFechaNoSeReserva')}
          </Text>
        </View>
      )}

      {/* LAS RESEÑAS, para todo el mundo. Quién puede escribir una lo decide el
          servidor ahí dentro; esconder el enlace dejaría sin puerta a quien
          asistió, y la lista es pública. */}
      <Button
        label={t('resenas.verTodas')}
        variant="secondary"
        onPress={() => router.push(`/resenas/${evento.id}` as never)}
      />
    </AppScreen>
  );
}

function Dato({
  icono,
  texto,
}: {
  icono: keyof typeof Feather.glyphMap;
  texto: string;
}) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.dato}>
      <Feather name={icono} size={15} color={colors.textMuted} />
      <Text variant="secondary" color={colors.textMuted} style={styles.crece}>
        {texto}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  portada: { width: '100%', height: 190, borderRadius: radius.lg },
  dato: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  crece: { flex: 1 },
  organizador: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    // 44 pt es el mínimo pulsable.
    minHeight: 44,
  },
  descripcion: { marginTop: spacing.sm },
  sello: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  aviso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
});
