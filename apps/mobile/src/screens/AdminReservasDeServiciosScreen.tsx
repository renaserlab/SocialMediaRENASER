import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { fechaCorta, type FalloDeCarga } from '@/lib/serviciosAdmision';
import { claveDeLaModalidad } from '@/lib/serviciosCatalogo';
import {
  AMBITOS_DE_RESERVAS,
  ESTADOS_DE_LA_RETENCION,
  claveDelEstadoDeLaRetencion,
  type AmbitoDeReservas,
  type ReservaAdmin,
  type RetencionAdmin,
} from '@/lib/serviciosReserva';
import { leerFallo, useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceBookingRepository } from '@/repositories/ServiceBookingRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Vista = 'bookings' | 'holds';
type Fila = { id: string; titulo: string; detalle: string };

/** La hora de un instante del servidor, en la del teléfono: «dd/mm/aaaa hh:mm». */
function momento(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${fechaCorta(iso)} ${dos(d.getHours())}:${dos(d.getMinutes())}`;
}

/**
 * SUPERVISIÓN DE RESERVAS (blueprint A04): lo OPERATIVO, sin nada privado.
 * Reservas confirmadas y retenciones por estado, con sus identificadores; ni
 * notas, ni direcciones, ni nombres. Y el BARRIDO de las vencidas, que es
 * idempotente y no decide nada: una retención vencida ya no ocupa aunque
 * nadie la barra.
 */
export function AdminReservasDeServiciosScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f } = useTextosDeServicios('reserva');
  const [vista, setVista] = useState<Vista>('bookings');
  const [ambito, setAmbito] = useState<AmbitoDeReservas>('upcoming');
  const [estado, setEstado] = useState<string | null>('active');
  const [filas, setFilas] = useState<Fila[] | null>(null);
  const [siguiente, setSiguiente] = useState<string | null>(null);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);
  const vigente = useRef(0);

  const deReserva = useCallback(
    (b: ReservaAdmin): Fila => ({
      id: b.id,
      titulo: `${b.code} · ${b.title}`,
      detalle: `${momento(b.starts_at)} · ${f(claveDeLaModalidad(b.modality))} · ${f(
        'servicios.reserva.admin.confirmadaEl',
        { fecha: momento(b.confirmed_at) },
      )}`,
    }),
    [f],
  );
  const deRetencion = useCallback(
    (h: RetencionAdmin): Fila => ({
      id: h.id,
      titulo: `${f(claveDelEstadoDeLaRetencion(h.status))} · ${momento(h.starts_at)}`,
      detalle: f('servicios.reserva.admin.vence', { fecha: momento(h.expires_at) }),
    }),
    [f],
  );

  const pagina = useCallback(
    async (cursor: string | null): Promise<{ items: Fila[]; next_cursor: string | null }> => {
      if (vista === 'bookings') {
        const p = await ServiceBookingRepository.reservasParaAdministrar(ambito, cursor);
        return { items: p.items.map(deReserva), next_cursor: p.next_cursor };
      }
      const p = await ServiceBookingRepository.retencionesParaAdministrar(estado, cursor);
      return { items: p.items.map(deRetencion), next_cursor: p.next_cursor };
    },
    [ambito, deReserva, deRetencion, estado, vista],
  );

  const cargar = useCallback(async () => {
    const esta = ++vigente.current;
    setFallo(null);
    setFilas(null);
    try {
      const p = await pagina(null);
      if (esta !== vigente.current) return;
      setFilas(p.items);
      setSiguiente(p.next_cursor);
    } catch (error) {
      if (esta === vigente.current) setFallo(leerFallo(error));
    }
  }, [pagina]);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );
  const { ocupado, correr } = useCerrojo(cargar, 'reserva');

  const mas = () =>
    void correr(async () => {
      if (!siguiente) return;
      const esta = vigente.current;
      const p = await pagina(siguiente);
      if (esta !== vigente.current) return;
      setFilas((ya) => [...(ya ?? []), ...p.items.filter((x) => !(ya ?? []).some((y) => y.id === x.id))]);
      setSiguiente(p.next_cursor);
    });

  const barrer = () =>
    void correr(async () => {
      const si = await confirm({
        title: f('servicios.reserva.admin.barrerTitulo'),
        message: f('servicios.reserva.admin.barrerAviso'),
        confirmLabel: f('servicios.reserva.admin.barrer'),
      });
      if (!si) return;
      const { expired } = await ServiceBookingRepository.barrer();
      toast(f('servicios.reserva.admin.barridas', { n: expired }));
      await cargar();
    });

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/admin/servicios' as never));

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('servicios.reserva.admin.titulo')} onBack={volver} />
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.reserva.admin.intro')}
      </Text>
      <View style={styles.fila} accessibilityRole="tablist">
        {(['bookings', 'holds'] as const).map((v) => (
          <Chip
            key={v}
            rol="radio"
            label={f(`servicios.reserva.admin.vista.${v}`)}
            selected={vista === v}
            onPress={() => setVista(v)}
          />
        ))}
      </View>
      <View style={styles.fila}>
        {vista === 'bookings'
          ? AMBITOS_DE_RESERVAS.map((a) => (
              <Chip
                key={a}
                rol="radio"
                label={f(`servicios.reserva.ambito.${a}`)}
                selected={ambito === a}
                onPress={() => setAmbito(a)}
              />
            ))
          : ESTADOS_DE_LA_RETENCION.map((e) => (
              <Chip
                key={e}
                rol="radio"
                label={f(claveDelEstadoDeLaRetencion(e))}
                selected={estado === e}
                onPress={() => setEstado(e)}
              />
            ))}
      </View>
      {vista === 'holds' ? (
        <Button
          label={f('servicios.reserva.admin.barrer')}
          variant="secondary"
          icon="refresh-cw"
          loading={ocupado}
          disabled={ocupado}
          onPress={barrer}
        />
      ) : null}

      {fallo !== null ? (
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      ) : filas === null ? (
        <StateView state="loading" />
      ) : filas.length === 0 ? (
        <StateView state="empty" icon="inbox" title={f('servicios.reserva.admin.vacia')} />
      ) : (
        <>
          {filas.map((x) => (
            <View key={x.id} style={[styles.tarjeta, { borderColor: colors.border }]}>
              <Text weight="600">{x.titulo}</Text>
              <Text variant="caption" color={colors.textMuted}>
                {x.detalle}
              </Text>
            </View>
          ))}
          {siguiente ? (
            <Button label={f('servicios.reserva.verMas')} variant="ghost" loading={ocupado} onPress={mas} />
          ) : null}
        </>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  fila: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.md },
});
