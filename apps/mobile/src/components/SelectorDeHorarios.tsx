import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { zonaDelDispositivo } from '@/lib/eventoDelOrganizador';
import type { FalloDelCatalogo } from '@/lib/serviciosCatalogo';
import {
  claveDelDia,
  diaDeLaSemana,
  diasDelRango,
  etiquetaDelHorario,
  fechaVisible,
  juntarHorarios,
  sumarDias,
  zonaDistinta,
  type Calendario,
  type Horario,
  type PaginaDeHorarios,
} from '@/lib/serviciosAgenda';
import { leerFalloDelCatalogo, useTextosDeServicios } from '@/hooks/useServicios';
import { ApiError } from '@/services/api';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Elegir fecha y ver sus horarios. Lo usan la ficha pública (horarios de un
 * servicio) y la vista previa del prestador: los dos piden al servidor, que
 * es quien calcula qué horarios hay.
 *
 * LAS HORAS SON LAS DE LA AGENDA y se dice cuál es su zona. Si el teléfono
 * está en otra, se avisa: nunca se convierte aquí.
 *
 * ESTADOS VACÍOS DE VERDAD: sin agenda, en pausa, sin horarios en estas
 * fechas, sin horarios ese día y fuera de lo consultable. Nada inventado.
 *
 * ELEGIR NO APARTA: `alElegir` recibe el horario y quien pinta decide qué
 * hace (la ficha lo guarda en la ruta). No hay botón de reservar.
 */
export function SelectorDeHorarios({
  cargarCalendario,
  cargarDia,
  elegido = null,
  fechaInicial = null,
  alElegir,
}: {
  cargarCalendario: (desde: string | null, hasta: string | null) => Promise<Calendario>;
  cargarDia: (fecha: string, cursor: string | null) => Promise<PaginaDeHorarios>;
  /** `starts_at` del horario elegido, si lo hay. */
  elegido?: string | null;
  fechaInicial?: string | null;
  alElegir?: (horario: Horario, fecha: string, modalidad: string | null) => void;
}) {
  const { colors } = useAppTheme();
  const { f } = useTextosDeServicios('agenda');
  const [calendario, setCalendario] = useState<Calendario | null>(null);
  const [fallo, setFallo] = useState<FalloDelCatalogo | null>(null);
  const [fueraDeRango, setFueraDeRango] = useState(false);
  const [fecha, setFecha] = useState<string | null>(fechaInicial);
  const [horarios, setHorarios] = useState<Horario[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cargandoDia, setCargandoDia] = useState(false);

  const pedirCalendario = useCallback(
    async (desde: string | null, hasta: string | null) => {
      setFallo(null);
      setFueraDeRango(false);
      try {
        const c = await cargarCalendario(desde, hasta);
        setCalendario(c);
        return c;
      } catch (error) {
        if (error instanceof ApiError && error.code === 'service_availability_out_of_horizon') {
          setFueraDeRango(true);
        } else {
          setFallo(leerFalloDelCatalogo(error));
        }
        return null;
      }
    },
    [cargarCalendario],
  );

  const pedirDia = useCallback(
    async (dia: string, desde: string | null) => {
      setCargandoDia(true);
      try {
        const p = await cargarDia(dia, desde);
        setHorarios((ya) => (desde && ya ? juntarHorarios(ya, p.items) : p.items));
        setCursor(p.next_cursor);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'service_availability_out_of_horizon') {
          setFueraDeRango(true);
          setHorarios([]);
        } else {
          setFallo(leerFalloDelCatalogo(error));
        }
      } finally {
        setCargandoDia(false);
      }
    },
    [cargarDia],
  );

  useEffect(() => {
    void (async () => {
      const c = await pedirCalendario(null, null);
      // La primera fecha: la que llegó en la ruta o la del próximo horario.
      const primera = fechaInicial ?? c?.next?.date ?? null;
      if (primera) {
        setFecha(primera);
        void pedirDia(primera, null);
      }
    })();
  }, [pedirCalendario, pedirDia, fechaInicial]);

  const elegirFecha = (dia: string) => {
    setFecha(dia);
    setHorarios(null);
    setCursor(null);
    void pedirDia(dia, null);
  };

  if (fallo === 'noEncontrada') {
    // Dejó de ser público (suspendido, retirado…) o no existe: no hay horarios.
    return (
      <StateView
        state="empty"
        icon="slash"
        title={f('servicios.agenda.vacio.noDisponible')}
        description={f('servicios.agenda.vacio.noDisponibleCuerpo')}
      />
    );
  }
  if (fallo !== null) {
    return <EstadoDelCatalogo fallo={fallo} onRetry={() => void pedirCalendario(null, null)} />;
  }
  if (calendario === null) {
    return fueraDeRango ? (
      <StateView state="empty" icon="calendar" title={f('servicios.agenda.vacio.horizonte')} />
    ) : (
      <StateView state="loading" />
    );
  }
  if (calendario.status === 'not_configured') {
    return (
      <StateView
        state="empty"
        icon="calendar"
        title={f('servicios.agenda.vacio.sinAgenda')}
        description={f('servicios.agenda.vacio.sinAgendaCuerpo')}
      />
    );
  }
  if (calendario.status === 'paused') {
    return (
      <StateView
        state="empty"
        icon="pause-circle"
        title={f('servicios.agenda.vacio.enPausa')}
        description={f('servicios.agenda.vacio.enPausaCuerpo')}
      />
    );
  }

  const dias = diasDelRango(calendario);
  const dispositivo = zonaDelDispositivo();
  const anterior = calendario.from_date && calendario.today && calendario.from_date > calendario.today;
  const siguiente = calendario.to_date && calendario.last_date && calendario.to_date < calendario.last_date;
  const irA = (desde: string) => {
    const hasta = calendario.last_date && sumarDias(desde, 30) > calendario.last_date ? calendario.last_date : sumarDias(desde, 30);
    void pedirCalendario(desde, hasta);
  };

  return (
    <View style={styles.bloque}>
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.agenda.horasEn', { zona: calendario.timezone ?? '' })}
      </Text>
      {zonaDistinta(calendario.timezone, dispositivo) ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('servicios.agenda.zonaDelTelefono', { zona: dispositivo })}
        </Text>
      ) : null}

      {calendario.days.length === 0 ? (
        <Text variant="secondary">
          {f(calendario.next ? 'servicios.agenda.vacio.sinHorariosEnRango' : 'servicios.agenda.vacio.sinHorarios')}
        </Text>
      ) : null}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fechas}>
        {dias.map((d) => {
          const actual = d.date === fecha;
          const con = d.count > 0;
          return (
            <Pressable
              key={d.date}
              disabled={!con}
              onPress={() => elegirFecha(d.date)}
              style={[
                styles.fecha,
                {
                  borderColor: actual ? colors.primary : colors.border,
                  backgroundColor: actual ? colors.primary : 'transparent',
                  opacity: con ? 1 : 0.4,
                },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: actual, disabled: !con }}
              accessibilityLabel={f(con ? 'servicios.agenda.fechaConHorarios' : 'servicios.agenda.fechaSinHorarios', {
                dia: f(claveDelDia(diaDeLaSemana(d.date))),
                fecha: fechaVisible(d.date),
                n: d.count,
              })}
            >
              <Text variant="caption" color={actual ? colors.onPrimary : colors.textMuted}>
                {f(`${claveDelDia(diaDeLaSemana(d.date))}.corto`)}
              </Text>
              <Text weight="700" color={actual ? colors.onPrimary : colors.text}>
                {d.date.slice(8, 10)}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <View style={styles.fila}>
        {anterior ? (
          <Button
            label={f('servicios.agenda.anteriores')}
            variant="ghost"
            icon="chevron-left"
            onPress={() => irA(calendario.today ?? calendario.from_date ?? '')}
          />
        ) : null}
        {siguiente ? (
          <Button
            label={f('servicios.agenda.siguientes')}
            variant="ghost"
            icon="chevron-right"
            onPress={() => irA(sumarDias(calendario.to_date ?? '', 1))}
          />
        ) : null}
      </View>

      {fueraDeRango ? <Text variant="secondary">{f('servicios.agenda.vacio.horizonte')}</Text> : null}
      {fecha ? (
        <View style={styles.bloque}>
          <Text weight="700" accessibilityRole="header">
            {f('servicios.agenda.horariosDelDia', {
              dia: f(claveDelDia(diaDeLaSemana(fecha))),
              fecha: fechaVisible(fecha),
            })}
          </Text>
          {horarios === null ? (
            <StateView state="loading" />
          ) : horarios.length === 0 ? (
            <Text variant="secondary">{f('servicios.agenda.vacio.sinHorariosEseDia')}</Text>
          ) : (
            <View style={styles.horarios}>
              {horarios.map((h) => {
                const actual = h.starts_at === elegido;
                return (
                  <Pressable
                    key={h.starts_at}
                    onPress={alElegir ? () => alElegir(h, fecha, calendario.modality) : undefined}
                    disabled={!alElegir}
                    style={[
                      styles.horario,
                      {
                        borderColor: actual ? colors.primary : colors.border,
                        backgroundColor: actual ? colors.primary : 'transparent',
                      },
                    ]}
                    accessibilityRole={alElegir ? 'button' : 'text'}
                    accessibilityState={{ selected: actual }}
                    accessibilityLabel={f('servicios.agenda.horarioAccesible', {
                      inicio: etiquetaDelHorario(h, horarios),
                      fin: h.end_time,
                    })}
                  >
                    <Text weight="700" color={actual ? colors.onPrimary : colors.text}>
                      {etiquetaDelHorario(h, horarios)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
          {cursor ? (
            <Button
              label={f('servicios.agenda.verMas')}
              variant="secondary"
              loading={cargandoDia}
              disabled={cargandoDia}
              onPress={() => void pedirDia(fecha, cursor)}
            />
          ) : null}
        </View>
      ) : null}
      {calendario.duration_minutes ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('servicios.agenda.duracion', { n: calendario.duration_minutes })}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bloque: { gap: spacing.sm },
  fila: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  fechas: { gap: spacing.xs, paddingVertical: spacing.xs },
  fecha: {
    minWidth: 48,
    minHeight: 56,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  horarios: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  horario: {
    minWidth: 72,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
});
