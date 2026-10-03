import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { pesoLegible } from '@/lib/serviciosAdmision';
import {
  claveDeQuienEscribe,
  claveDelEfectoEconomico,
  claveDelEfectoEnLaAtencion,
  claveDelEstadoDelCaso,
  claveDelEstadoDelEfecto,
  claveDelMotivoDelCaso,
  claveDelResultado,
  claveDelTipoDeEntrada,
  momentoLegible,
  type Entrada,
  type Expediente,
} from '@/lib/serviciosAtencion';
import { useTextosDeServicios } from '@/hooks/useServicios';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Props = {
  caso: Expediente;
  ocupado: boolean;
  /** Pedir el enlace (que caduca) para mirar una evidencia. */
  alVer: (entrada: Entrada) => void;
};

/**
 * EL EXPEDIENTE de un caso, tal como lo manda el servidor: en qué está, por
 * qué se abrió, lo resuelto y cada entrada en su orden.
 *
 * LO RESUELTO SE DICE EN TRES LÍNEAS SEPARADAS: qué se decidió, su efecto en
 * la atención y LO ECONÓMICO (lo solicitado y en qué quedó). «A favor» no
 * significa «devuelto», y ningún estado lo dice.
 *
 * Una evidencia no trae su archivo: se pide un enlace que caduca. Las notas
 * internas solo llegan a administración (a las partes el servidor no se las
 * manda), y se marcan como tales.
 */
export function ExpedienteDelCaso({ caso, ocupado, alVer }: Props) {
  const { colors } = useAppTheme();
  const { f } = useTextosDeServicios('reserva');
  const tarjeta = [styles.tarjeta, { borderColor: colors.border }];
  return (
    <>
      <View style={tarjeta} accessibilityRole="summary" accessibilityLiveRegion="polite">
        <Text weight="700">{f(claveDelEstadoDelCaso(caso.status))}</Text>
        <Text variant="secondary">{f(claveDelMotivoDelCaso(caso.reason))}</Text>
        <Text variant="secondary">{caso.description}</Text>
        <Text variant="caption" color={colors.textMuted}>
          {f(caso.opened_by_me ? 'servicios.atencion.caso.abiertoPorTi' : 'servicios.atencion.caso.abiertoPorOtro', {
            fecha: momentoLegible(caso.created_at),
          })}
        </Text>
      </View>

      {caso.outcome !== null ? (
        <View style={[styles.tarjeta, { borderColor: colors.primary }]}>
          <Text weight="700">{f('servicios.atencion.caso.resuelto', { fecha: momentoLegible(caso.resolved_at) })}</Text>
          <Text>{f(claveDelResultado(caso.outcome))}</Text>
          <Text variant="secondary">
            {f('servicios.atencion.caso.efectoEnLaAtencion', { efecto: f(claveDelEfectoEnLaAtencion(caso.attention_effect)) })}
          </Text>
          <Text variant="secondary">
            {f('servicios.atencion.dinero.solicitado', {
              efecto: f(claveDelEfectoEconomico(caso.financial_effect)),
              estado: f(claveDelEstadoDelEfecto(caso.financial_effect_status)),
            })}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.atencion.dinero.noSeMovio')}
          </Text>
          {caso.appealed_at ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('servicios.atencion.caso.apeladoEl', { fecha: momentoLegible(caso.appealed_at) })}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={tarjeta}>
        <Text weight="700">{f('servicios.atencion.caso.expediente')}</Text>
        {caso.entries.length === 0 ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.atencion.caso.sinEntradas')}
          </Text>
        ) : (
          caso.entries.map((e) => (
            <View key={e.id} style={[styles.entrada, { borderColor: colors.border }]}>
              <Text variant="caption" color={colors.textMuted}>
                {`${f(claveDeQuienEscribe(e.author_role, e.mine))} · ${f(claveDelTipoDeEntrada(e.kind))} · ${momentoLegible(e.created_at)}`}
              </Text>
              {e.body ? <Text variant="secondary">{e.body}</Text> : null}
              {e.byte_size !== null ? (
                <Button
                  label={f('servicios.atencion.caso.verEvidencia', { peso: pesoLegible(e.byte_size) })}
                  variant="ghost"
                  icon="external-link"
                  disabled={ocupado}
                  onPress={() => alVer(e)}
                />
              ) : null}
            </View>
          ))
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
  entrada: { gap: spacing.xs, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: spacing.sm },
});
