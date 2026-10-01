import React, { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
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
import type { FalloDeCarga } from '@/lib/serviciosAdmision';
import {
  ESTADOS_DEL_CASO,
  claveDelEfectoEconomico,
  claveDelEstadoDelCaso,
  claveDelEstadoDelEfecto,
  claveDelMotivoDelCaso,
  momentoLegible,
  rutaDelCasoParaAdministrar,
  type CasoAdmin,
} from '@/lib/serviciosAtencion';
import { leerFallo, useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceCareRepository } from '@/repositories/ServiceCareRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * LA BANDEJA DE CASOS de Servicios: lo que hay que resolver, por estado.
 *
 * «CON EFECTO ECONÓMICO SOLICITADO» es la vista de lo que alguien pidió
 * devolver al resolver un caso. ES DE LECTURA: aquí no se ejecuta, no se
 * reintenta y no se da por pagado nada; cada línea dice lo solicitado y en
 * qué quedó.
 *
 * Y LOS BARRIDOS (recordar las reservas que empiezan pronto y cerrar las
 * atenciones terminadas cuyo plazo pasó): idempotentes, y tampoco mueven
 * dinero. Hasta que exista un planificador, se lanzan desde aquí.
 */
export function AdminCasosDeServiciosScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f } = useTextosDeServicios('reserva');
  const [estado, setEstado] = useState<string | null>('open');
  const [conEfecto, setConEfecto] = useState(false);
  const [casos, setCasos] = useState<CasoAdmin[] | null>(null);
  const [siguiente, setSiguiente] = useState<string | null>(null);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);
  const vigente = useRef(0);

  const cargar = useCallback(async () => {
    const esta = ++vigente.current;
    setFallo(null);
    setCasos(null);
    try {
      const p = await ServiceCareRepository.casos(conEfecto ? null : estado, conEfecto, null);
      if (esta !== vigente.current) return;
      setCasos(p.items);
      setSiguiente(p.next_cursor);
    } catch (error) {
      if (esta === vigente.current) setFallo(leerFallo(error));
    }
  }, [conEfecto, estado]);
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
      const p = await ServiceCareRepository.casos(conEfecto ? null : estado, conEfecto, siguiente);
      if (esta !== vigente.current) return;
      setCasos((ya) => [...(ya ?? []), ...p.items.filter((x) => !(ya ?? []).some((y) => y.id === x.id))]);
      setSiguiente(p.next_cursor);
    });

  const correrTareas = () =>
    void correr(async () => {
      const si = await confirm({
        title: f('servicios.atencion.admin.tareasTitulo'),
        message: f('servicios.atencion.admin.tareasAviso'),
        confirmLabel: f('servicios.atencion.admin.tareas'),
      });
      if (!si) return;
      const hecho = await ServiceCareRepository.correrTareas();
      toast(
        f('servicios.atencion.admin.tareasHechas', {
          recordadas: hecho.reminded,
          cerradas: hecho.closed,
          sinVerificar: hecho.unverified,
        }),
      );
      await cargar();
    });

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/admin/servicios' as never));

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('servicios.atencion.admin.casos')} onBack={volver} />
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.atencion.admin.casosIntro')}
      </Text>
      <View style={styles.fila} accessibilityRole="radiogroup">
        {ESTADOS_DEL_CASO.map((e) => (
          <Chip
            key={e}
            rol="radio"
            label={f(claveDelEstadoDelCaso(e))}
            selected={!conEfecto && estado === e}
            onPress={() => {
              setConEfecto(false);
              setEstado(e);
            }}
          />
        ))}
        <Chip
          rol="radio"
          label={f('servicios.atencion.admin.conEfecto')}
          selected={conEfecto}
          onPress={() => setConEfecto(true)}
        />
      </View>
      {conEfecto ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('servicios.atencion.admin.conEfectoIntro')}
        </Text>
      ) : null}
      <Button
        label={f('servicios.atencion.admin.tareas')}
        variant="secondary"
        icon="refresh-cw"
        loading={ocupado}
        disabled={ocupado}
        onPress={correrTareas}
      />

      {fallo !== null ? (
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      ) : casos === null ? (
        <StateView state="loading" />
      ) : casos.length === 0 ? (
        <StateView state="empty" icon="inbox" title={f('servicios.atencion.admin.sinCasos')} />
      ) : (
        <>
          {casos.map((c) => (
            <Pressable
              key={c.id}
              accessibilityRole="button"
              accessibilityLabel={f('servicios.atencion.admin.abrirCaso', { codigo: c.booking_code })}
              onPress={() => router.push(rutaDelCasoParaAdministrar(c.id) as never)}
              style={[styles.tarjeta, { borderColor: colors.border }]}
            >
              <Text weight="600">{`${c.booking_code} · ${c.title}`}</Text>
              <Text variant="secondary">{`${f(claveDelMotivoDelCaso(c.reason))} · ${f(claveDelEstadoDelCaso(c.status))}`}</Text>
              <Text variant="caption" color={colors.textMuted}>
                {`${c.provider_name} · ${momentoLegible(c.created_at)}`}
              </Text>
              {c.financial_effect !== null ? (
                <Text variant="caption" color={colors.textMuted}>
                  {f('servicios.atencion.dinero.solicitado', {
                    efecto: f(claveDelEfectoEconomico(c.financial_effect)),
                    estado: f(claveDelEstadoDelEfecto(c.financial_effect_status)),
                  })}
                </Text>
              ) : null}
            </Pressable>
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
