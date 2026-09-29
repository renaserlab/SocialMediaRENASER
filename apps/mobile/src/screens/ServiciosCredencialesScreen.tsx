import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import {
  claveDelEstadoDeCredencial,
  claveDelTipoDeCredencial,
  fechaCorta,
  requisito,
  type CredencialPrivada,
} from '@/lib/serviciosAdmision';
import { useCerrojo, useExpedienteDeServicios, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceProviderRepository } from '@/repositories/ServiceProviderRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Paso 5: las credenciales profesionales (títulos, colegiaturas, licencias).
 *
 * SOLO LAS VERIFICA Z. Aquí se declaran con su evidencia; el número se guarda
 * y se enseña SOLO ENMASCARADO. Qué credenciales hacen falta lo dicen las
 * condiciones vigentes; si no piden ninguna, este paso es opcional y la
 * pantalla lo dice.
 */
export function ServiciosCredencialesScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f } = useTextosDeServicios();
  const { solicitud, setSolicitud, cargando, fallo, ninguna, cargar } = useExpedienteDeServicios();
  const { ocupado, correr } = useCerrojo(cargar);

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/servicios/prestador' as never));
  const titulo = f('servicios.paso.credenciales');

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      </AppScreen>
    );
  }
  if (ninguna) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="empty" icon="file-plus" title={f('servicios.prestador.sinPostulacion')} />
      </AppScreen>
    );
  }
  if (cargando && solicitud === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }
  if (solicitud === null) return null;

  const retirar = (credencial: CredencialPrivada) =>
    void correr(async () => {
      const si = await confirm({
        title: f('servicios.credenciales.retirarTitulo'),
        message: f('servicios.credenciales.retirarAviso'),
        confirmLabel: f('servicios.credenciales.retirar'),
        destructive: true,
      });
      if (!si) return;
      setSolicitud(await ServiceProviderRepository.retirarCredencial(credencial.id));
      toast(f('servicios.credenciales.retirada'));
    });

  const pedidas = solicitud.missing.filter((c) => c.startsWith('credential'));

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      <Text variant="secondary">{f('servicios.credenciales.intro')}</Text>
      {pedidas.length > 0 ? (
        <View style={[styles.tarjeta, { borderColor: colors.primary }]}>
          {pedidas.map((codigo) => {
            const r = requisito(codigo);
            return (
              <Text key={codigo} variant="secondary">
                {`• ${f(r.clave, r.nombre ? { nombre: f(r.nombre) } : undefined)}`}
              </Text>
            );
          })}
        </View>
      ) : solicitud.editable ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('servicios.credenciales.opcional')}
        </Text>
      ) : null}

      {solicitud.credentials.length === 0 ? (
        <StateView state="empty" icon="award" title={f('servicios.credenciales.ninguna')} />
      ) : (
        solicitud.credentials.map((c) => (
          <View key={c.id} style={[styles.tarjeta, { borderColor: colors.border }]}>
            <Text weight="600">{c.title}</Text>
            <Text variant="caption" color={colors.textMuted}>
              {`${f(claveDelTipoDeCredencial(c.kind))} · ${c.issuer}${c.number_masked ? ` · ${c.number_masked}` : ''}`}
            </Text>
            <Text
              variant="caption"
              color={c.display_status === 'rejected' || c.display_status === 'expired' ? colors.danger : colors.textMuted}
            >
              {f(claveDelEstadoDeCredencial(c.display_status))}
              {c.expires_on ? ` · ${f('servicios.credenciales.vence', { fecha: fechaCorta(c.expires_on) })}` : ''}
            </Text>
            {c.review_note ? (
              <Text variant="secondary">{f('servicios.documentos.nota', { nota: c.review_note })}</Text>
            ) : null}
            {!c.evidence_document_id ? (
              <Text variant="caption" color={colors.danger}>
                {f('servicios.falta.evidencia')}
              </Text>
            ) : null}
            <View style={styles.acciones}>
              {c.can_edit ? (
                <Button
                  label={f('servicios.credenciales.editar')}
                  variant="ghost"
                  icon="edit-3"
                  disabled={ocupado}
                  onPress={() =>
                    router.push({ pathname: '/servicios/prestador/credencial', params: { id: c.id } } as never)
                  }
                />
              ) : null}
              {c.can_remove ? (
                <Button
                  label={f('servicios.credenciales.retirar')}
                  variant="ghost"
                  icon="trash-2"
                  disabled={ocupado}
                  onPress={() => retirar(c)}
                />
              ) : null}
            </View>
          </View>
        ))
      )}

      {solicitud.editable ? (
        <Button
          label={f('servicios.credenciales.agregar')}
          variant="secondary"
          icon="plus"
          disabled={ocupado}
          onPress={() => router.push('/servicios/prestador/credencial' as never)}
        />
      ) : null}
      <Button
        label={f('servicios.paso.resumen')}
        icon="arrow-right"
        onPress={() => router.replace('/servicios/prestador/resumen' as never)}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: { gap: spacing.sm, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
  acciones: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
});
