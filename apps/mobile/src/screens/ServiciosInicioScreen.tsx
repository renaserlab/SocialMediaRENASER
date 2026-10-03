import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import {
  TIPOS_DE_PRESTADOR,
  claveDelTipoDePrestador,
  esFinal,
  peticionDeAlta,
  type Fallo,
  type TipoDePrestador,
} from '@/lib/serviciosAdmision';
import { useCerrojo, useExpedienteDeServicios, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceProviderRepository } from '@/repositories/ServiceProviderRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Paso 1: ¿persona o empresa?, y con qué nombre se presenta.
 *
 * EMPEZAR ES IDEMPOTENTE en el servidor: si ya hay una postulación viva, el
 * servidor devuelve esa y no crea otra. Por eso, al terminar, se REEMPLAZA
 * esta pantalla por la de datos: volver atrás no vuelve a «empezar». Y antes
 * de enseñar el formulario se pregunta: con una viva, se lleva a ella.
 */
export function ServiciosInicioScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f } = useTextosDeServicios();
  const { solicitud, cargando, fallo, cargar } = useExpedienteDeServicios();
  const { ocupado, correr } = useCerrojo(cargar);
  const [tipo, setTipo] = useState<TipoDePrestador | null>(null);
  const [nombre, setNombre] = useState('');
  const [fallos, setFallos] = useState<Fallo[]>([]);

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/servicios/prestador' as never));
  const error = (campo: string) => {
    const hallado = fallos.find((x) => x.campo === campo);
    return hallado ? f(hallado.clave) : undefined;
  };

  const empezar = () => {
    const { peticion, fallos: encontrados } = peticionDeAlta(tipo, nombre);
    setFallos(encontrados);
    if (peticion === null) return;
    void correr(async () => {
      await ServiceProviderRepository.iniciar(peticion);
      router.replace('/servicios/prestador/datos' as never);
    });
  };

  const titulo = f('servicios.paso.inicio');
  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
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
  if (solicitud !== null && !esFinal(solicitud.status)) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView
          state="empty"
          icon="file-text"
          title={f('servicios.inicio.yaTienes')}
          actionLabel={f('servicios.prestador.titulo')}
          onAction={() => router.replace('/servicios/prestador' as never)}
        />
      </AppScreen>
    );
  }

  return (
    <AppScreen teclado contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      <Text variant="secondary">{f('servicios.inicio.pregunta')}</Text>
      <View style={styles.fila} accessibilityRole="radiogroup">
        {TIPOS_DE_PRESTADOR.map((opcion) => (
          <Chip
            key={opcion}
            rol="radio"
            label={f(claveDelTipoDePrestador(opcion))}
            selected={tipo === opcion}
            onPress={() => setTipo(opcion)}
          />
        ))}
      </View>
      {error('tipo') ? (
        <Text variant="caption" color={colors.danger}>
          {error('tipo')}
        </Text>
      ) : null}
      {tipo ? (
        <Text variant="caption" color={colors.textMuted}>
          {f(`servicios.inicio.ayuda.${tipo}`)}
        </Text>
      ) : null}
      <Input
        label={f('servicios.campo.display_name')}
        value={nombre}
        onChangeText={setNombre}
        maxLength={120}
        error={error('nombre')}
        placeholder={f('servicios.inicio.nombreEjemplo')}
      />
      <Button
        label={f('servicios.inicio.continuar')}
        icon="arrow-right"
        loading={ocupado}
        disabled={ocupado}
        onPress={empezar}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  fila: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
