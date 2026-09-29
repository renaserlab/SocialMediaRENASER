import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { toast } from '@/lib/toast';
import { fechaCorta, huellaCorta, type FalloDeCarga, type SolicitudPrivada, type Terminos } from '@/lib/serviciosAdmision';
import { leerFallo, useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceProviderRepository } from '@/repositories/ServiceProviderRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { ApiError } from '@/services/api';

type SinCondiciones = 'sinPais' | 'sinPublicar';

/**
 * Paso 3: las condiciones del prestador VIGENTES para su país.
 *
 * SE ACEPTAN EXPRESAMENTE, con la versión y la huella del texto que se enseñó:
 * si la empresa publicó otra mientras tanto, el servidor no acepta nada a
 * ciegas (`provider_terms_changed`) y la pantalla vuelve a leer.
 *
 * SIN CONDICIONES PUBLICADAS NO SE ENVÍA, y la pantalla lo dice así en vez de
 * inventar un texto o dejar pasar: es una decisión de la empresa.
 */
export function ServiciosCondicionesScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f } = useTextosDeServicios();
  const [terminos, setTerminos] = useState<Terminos | null>(null);
  const [solicitud, setSolicitud] = useState<SolicitudPrivada | null>(null);
  const [sin, setSin] = useState<SinCondiciones | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);
  const [leido, setLeido] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    setSin(null);
    try {
      const propia = await ServiceProviderRepository.postulacion();
      setSolicitud(propia);
      try {
        setTerminos(await ServiceProviderRepository.condiciones());
      } catch (error) {
        if (error instanceof ApiError && error.code === 'service_application_country_required') {
          setSin('sinPais');
        } else if (error instanceof ApiError && error.code === 'provider_terms_not_published') {
          setSin('sinPublicar');
        } else {
          throw error;
        }
        setTerminos(null);
      }
    } catch (error) {
      setFallo(leerFallo(error));
    } finally {
      setCargando(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );
  const { ocupado, correr } = useCerrojo(cargar);

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/servicios/prestador' as never));
  const titulo = f('servicios.paso.condiciones');

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }
  if (fallo !== null || solicitud === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <EstadoDeServicios fallo={fallo ?? 'error'} onRetry={() => void cargar()} />
      </AppScreen>
    );
  }
  if (sin !== null || terminos === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        {sin === 'sinPais' ? (
          <StateView
            state="empty"
            icon="map-pin"
            title={f('servicios.condiciones.sinPais')}
            description={f('servicios.condiciones.sinPaisCuerpo')}
            actionLabel={f('servicios.paso.datos')}
            onAction={() => router.replace('/servicios/prestador/datos' as never)}
          />
        ) : (
          <StateView
            state="empty"
            icon="clock"
            title={f('servicios.condiciones.sinPublicar')}
            description={f('servicios.condiciones.sinPublicarCuerpo')}
          />
        )}
      </AppScreen>
    );
  }

  const aceptadaEsta =
    solicitud.terms?.policy_id === terminos.policy_id &&
    !solicitud.missing.some((c) => c.startsWith('provider_terms'));

  const aceptar = () =>
    void correr(async () => {
      const nueva = await ServiceProviderRepository.aceptarCondiciones(terminos);
      setSolicitud(nueva);
      toast(f('servicios.condiciones.aceptadas'));
      router.replace('/servicios/prestador/documentos' as never);
    });

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      <Text variant="titleMedium">{terminos.title}</Text>
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.condiciones.version', {
          version: terminos.version,
          pais: terminos.country_code,
          fecha: fechaCorta(terminos.effective_at),
        })}
      </Text>
      <View style={[styles.texto, { borderColor: colors.border }]}>
        <Text selectable>{terminos.body}</Text>
      </View>
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.condiciones.huella', { huella: huellaCorta(terminos.sha256) })}
      </Text>
      {aceptadaEsta ? (
        <StateView
          state="empty"
          icon="check-circle"
          title={f('servicios.condiciones.yaAceptadas')}
          description={f('servicios.condiciones.aceptadasEl', {
            fecha: fechaCorta(solicitud.terms?.accepted_at),
          })}
          actionLabel={f('servicios.paso.documentos')}
          onAction={() => router.replace('/servicios/prestador/documentos' as never)}
        />
      ) : solicitud.editable ? (
        <>
          {solicitud.terms !== null ? (
            <Text variant="secondary" color={colors.danger}>
              {f('servicios.falta.condicionesCambiaron')}
            </Text>
          ) : null}
          <Chip
            rol="checkbox"
            label={f('servicios.condiciones.heLeido')}
            selected={leido}
            onPress={() => setLeido(!leido)}
          />
          <Button
            label={f('servicios.condiciones.aceptar')}
            icon="check"
            loading={ocupado}
            disabled={!leido || ocupado}
            onPress={aceptar}
          />
        </>
      ) : (
        <StateView state="empty" icon="lock" title={f('servicios.error.noEditable')} />
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  texto: { borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
