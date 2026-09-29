import React, { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { claveDelEstado, nuevaClave, revisarMotivoDeRetirada } from '@/lib/serviciosAdmision';
import { useCerrojo, useExpedienteDeServicios, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceProviderRepository } from '@/repositories/ServiceProviderRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Retirar la postulación PROPIA, con confirmación.
 *
 * Lo que la pantalla dice ANTES, porque después ya no tiene arreglo:
 *  - es FINAL: esta postulación queda solo para consulta;
 *  - Z conserva los documentos, las credenciales y el historial;
 *  - se puede empezar otra, que NO hereda las condiciones aceptadas ni los
 *    documentos de esta;
 *  - no es un rechazo ni una suspensión.
 *
 * Solo se ofrece si el servidor dice que se puede (`can_withdraw`): antes de
 * la decisión, y nunca una aprobada que volvió a revisión.
 */
export function ServiciosRetirarScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f } = useTextosDeServicios();
  const { solicitud, cargando, fallo, ninguna, cargar } = useExpedienteDeServicios();
  const { ocupado, correr } = useCerrojo(cargar);
  const [motivo, setMotivo] = useState('');
  const [errorDeMotivo, setErrorDeMotivo] = useState<string | null>(null);
  const clave = useRef(nuevaClave());

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/servicios/prestador' as never));
  const titulo = f('servicios.retirar.titulo');

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      </AppScreen>
    );
  }
  if (cargando && solicitud === null && !ninguna) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }
  if (solicitud === null || !solicitud.can_withdraw) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView
          state="empty"
          icon="lock"
          title={f('servicios.retirar.noSePuede')}
          description={solicitud ? f(claveDelEstado(solicitud.status)) : undefined}
        />
      </AppScreen>
    );
  }

  const retirar = () => {
    const problema = revisarMotivoDeRetirada(motivo);
    setErrorDeMotivo(problema);
    if (problema) return;
    void correr(async () => {
      const si = await confirm({
        title: f('servicios.retirar.confirmarTitulo'),
        message: f('servicios.retirar.confirmarAviso'),
        confirmLabel: f('servicios.retirar.boton'),
        destructive: true,
      });
      if (!si) return;
      await ServiceProviderRepository.retirar(motivo.trim() || null, clave.current);
      toast(f('servicios.retirar.hecho'));
      router.replace('/servicios/prestador' as never);
    });
  };

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      <View style={[styles.tarjeta, { borderColor: colors.danger }]}>
        <Text weight="700">{f('servicios.retirar.queSignifica')}</Text>
        <Text variant="secondary">{`• ${f('servicios.retirar.final')}`}</Text>
        <Text variant="secondary">{`• ${f('servicios.retirar.conserva')}`}</Text>
        <Text variant="secondary">{`• ${f('servicios.retirar.nueva')}`}</Text>
        <Text variant="secondary">{`• ${f('servicios.retirar.noEsRechazo')}`}</Text>
      </View>
      <Input
        label={f('servicios.retirar.motivo')}
        value={motivo}
        onChangeText={setMotivo}
        multiline
        maxLength={500}
        error={errorDeMotivo ? f(errorDeMotivo) : undefined}
      />
      <Button
        label={f('servicios.retirar.boton')}
        icon="log-out"
        loading={ocupado}
        disabled={ocupado}
        onPress={retirar}
      />
      <Button label={f('servicios.retirar.cancelar')} variant="ghost" onPress={volver} />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
