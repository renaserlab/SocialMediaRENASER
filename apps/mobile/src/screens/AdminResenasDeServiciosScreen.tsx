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
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { nuevaClave, type FalloDeCarga } from '@/lib/serviciosAdmision';
import {
  ESTADOS_DE_LA_RESENA,
  MOTIVOS_DE_MODERACION,
  claveDelEstadoDeLaResena,
  claveDelMotivoDeModeracion,
  estrellas,
  llavero,
  momentoLegible,
  peticionDeModeracion,
  type ResenaAdmin,
} from '@/lib/serviciosAtencion';
import { leerFallo, useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceCareRepository } from '@/repositories/ServiceCareRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * LA MODERACIÓN de las reseñas de Servicios.
 *
 * Una reseña se PUBLICA o se ESCONDE; no se borra ni se reescribe, y queda en
 * el historial quién lo hizo. Esconderla exige un motivo de una lista cerrada
 * (datos personales, amenazas, odio, extorsión, fuera de tema): «es negativa»
 * NO es un motivo. Una reseña escondida deja de verse y de contar.
 */
export function AdminResenasDeServiciosScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f } = useTextosDeServicios('reserva');
  const [estado, setEstado] = useState<string>('pending');
  const [resenas, setResenas] = useState<ResenaAdmin[] | null>(null);
  const [siguiente, setSiguiente] = useState<string | null>(null);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);
  // La reseña que se está escondiendo, y por qué.
  const [escondiendo, setEscondiendo] = useState<string | null>(null);
  const [motivo, setMotivo] = useState<string | null>(null);
  const vigente = useRef(0);
  const llaves = useRef(llavero(nuevaClave)).current;

  const cargar = useCallback(async () => {
    const esta = ++vigente.current;
    setFallo(null);
    setResenas(null);
    try {
      const p = await ServiceCareRepository.resenasParaModerar(estado, null);
      if (esta !== vigente.current) return;
      setResenas(p.items);
      setSiguiente(p.next_cursor);
    } catch (error) {
      if (esta === vigente.current) setFallo(leerFallo(error));
    }
  }, [estado]);
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
      const p = await ServiceCareRepository.resenasParaModerar(estado, siguiente);
      if (esta !== vigente.current) return;
      setResenas((ya) => [...(ya ?? []), ...p.items.filter((x) => !(ya ?? []).some((y) => y.id === x.id))]);
      setSiguiente(p.next_cursor);
    });

  const moderar = (resena: ResenaAdmin, accion: 'publish' | 'hide') =>
    void correr(async () => {
      const { peticion, fallo: falta } = peticionDeModeracion(accion, motivo);
      if (peticion === null) {
        notify(f('servicios.noSePudo'), f(falta ?? 'servicios.atencion.error.motivo'));
        return;
      }
      const si = await confirm({
        title: f(accion === 'publish' ? 'servicios.atencion.moderar.publicarTitulo' : 'servicios.atencion.moderar.esconderTitulo'),
        message: f(accion === 'publish' ? 'servicios.atencion.moderar.publicarAviso' : 'servicios.atencion.moderar.esconderAviso'),
        confirmLabel: f(accion === 'publish' ? 'servicios.atencion.moderar.publicar' : 'servicios.atencion.moderar.esconder'),
        destructive: accion === 'hide',
      });
      if (!si) return;
      await ServiceCareRepository.moderarResena(resena.id, peticion, llaves.de(`${resena.id}:${accion}`, peticion));
      llaves.hecho(`${resena.id}:${accion}`);
      setEscondiendo(null);
      setMotivo(null);
      toast(f(accion === 'publish' ? 'servicios.atencion.moderar.publicada' : 'servicios.atencion.moderar.escondida'));
      await cargar();
    });

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/admin/servicios' as never));

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('servicios.atencion.admin.resenas')} onBack={volver} />
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.atencion.admin.resenasIntro')}
      </Text>
      <View style={styles.fila} accessibilityRole="radiogroup">
        {ESTADOS_DE_LA_RESENA.map((e) => (
          <Chip
            key={e}
            rol="radio"
            label={f(claveDelEstadoDeLaResena(e))}
            selected={estado === e}
            onPress={() => setEstado(e)}
          />
        ))}
      </View>

      {fallo !== null ? (
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      ) : resenas === null ? (
        <StateView state="loading" />
      ) : resenas.length === 0 ? (
        <StateView state="empty" icon="star" title={f('servicios.atencion.admin.sinResenas')} />
      ) : (
        <>
          {resenas.map((r) => (
            <View key={r.id} style={[styles.tarjeta, { borderColor: colors.border }]}>
              <Text accessibilityLabel={f('servicios.atencion.resena.notaLeida', { n: r.rating })}>
                {estrellas(r.rating)}
              </Text>
              <Text variant="secondary">{r.comment}</Text>
              {r.reply ? (
                <Text variant="secondary">{f('servicios.atencion.resena.respuesta', { texto: r.reply })}</Text>
              ) : null}
              <Text variant="caption" color={colors.textMuted}>
                {`${f(claveDelEstadoDeLaResena(r.status))} · ${momentoLegible(r.created_at)}`}
              </Text>
              {r.status !== 'published' ? (
                <Button
                  label={f('servicios.atencion.moderar.publicar')}
                  variant="secondary"
                  icon="eye"
                  loading={ocupado}
                  disabled={ocupado}
                  onPress={() => moderar(r, 'publish')}
                />
              ) : null}
              {r.status !== 'hidden' ? (
                escondiendo === r.id ? (
                  <>
                    <Text weight="600">{f('servicios.atencion.moderar.porQue')}</Text>
                    <View style={styles.fila} accessibilityRole="radiogroup">
                      {MOTIVOS_DE_MODERACION.map((m) => (
                        <Chip
                          key={m}
                          rol="radio"
                          label={f(claveDelMotivoDeModeracion(m))}
                          selected={motivo === m}
                          onPress={() => setMotivo(m)}
                        />
                      ))}
                    </View>
                    <Button
                      label={f('servicios.atencion.moderar.esconder')}
                      icon="eye-off"
                      loading={ocupado}
                      disabled={ocupado || motivo === null}
                      onPress={() => moderar(r, 'hide')}
                    />
                  </>
                ) : (
                  <Button
                    label={f('servicios.atencion.moderar.esconder')}
                    variant="ghost"
                    icon="eye-off"
                    disabled={ocupado}
                    onPress={() => {
                      setEscondiendo(r.id);
                      setMotivo(null);
                    }}
                  />
                )
              ) : null}
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
