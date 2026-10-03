import React, { useEffect, useState } from 'react';
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
import { toast } from '@/lib/toast';
import {
  TIPOS_DE_PRESTADOR,
  cambiosDelBorrador,
  claveDelTipoDePrestador,
  formularioDesde,
  type Fallo,
  type FormularioDeDatos,
} from '@/lib/serviciosAdmision';
import { useCerrojo, useExpedienteDeServicios, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceProviderRepository } from '@/repositories/ServiceProviderRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Paso 2: la información básica del prestador.
 *
 * SOLO VIAJA LO QUE CAMBIÓ, y nunca el estado. Guardar no exige nada: lo que
 * hace falta para ENVIAR lo dice el servidor en el resumen. Los campos que Z
 * pidió corregir se señalan.
 */
export function ServiciosDatosScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f } = useTextosDeServicios();
  const { solicitud, setSolicitud, cargando, fallo, ninguna, cargar } = useExpedienteDeServicios();
  const { ocupado, correr } = useCerrojo(cargar);
  const [formulario, setFormulario] = useState<FormularioDeDatos | null>(null);
  const [fallos, setFallos] = useState<Fallo[]>([]);

  // El formulario nace UNA vez de lo que dice el servidor; recargar al volver
  // de otra pantalla no pisa lo que se está escribiendo.
  useEffect(() => {
    if (solicitud !== null && formulario === null) setFormulario(formularioDesde(solicitud));
  }, [solicitud, formulario]);

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/servicios/prestador' as never));
  const titulo = f('servicios.paso.datos');

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
        <StateView
          state="empty"
          icon="file-plus"
          title={f('servicios.prestador.sinPostulacion')}
          actionLabel={f('servicios.intro.empezar')}
          onAction={() => router.replace('/servicios/prestador/inicio' as never)}
        />
      </AppScreen>
    );
  }
  if (cargando || solicitud === null || formulario === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }
  if (!solicitud.editable) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="empty" icon="lock" title={f('servicios.error.noEditable')} />
      </AppScreen>
    );
  }

  const observado = (campo: string) => solicitud.observed_fields.includes(campo);
  const error = (campo: string) => {
    const hallado = fallos.find((x) => x.campo === campo);
    return hallado ? f(hallado.clave) : undefined;
  };
  const etiqueta = (campo: string, clave: string) =>
    observado(campo) ? `${f(clave)} · ${f('servicios.datos.corregir')}` : f(clave);
  const cambiar = (campo: keyof FormularioDeDatos) => (valor: string) =>
    setFormulario((actual) => (actual ? { ...actual, [campo]: valor } : actual));

  const guardar = () => {
    const { cambios, fallos: encontrados } = cambiosDelBorrador(formulario, solicitud);
    setFallos(encontrados);
    if (encontrados.length > 0) return;
    if (Object.keys(cambios).length === 0) {
      router.replace('/servicios/prestador/condiciones' as never);
      return;
    }
    void correr(async () => {
      const nueva = await ServiceProviderRepository.actualizar(cambios);
      setSolicitud(nueva);
      setFormulario(formularioDesde(nueva));
      toast(f('servicios.datos.guardados'));
      router.replace('/servicios/prestador/condiciones' as never);
    });
  };

  const empresa = formulario.tipo === 'company';

  return (
    <AppScreen teclado contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      <Text variant="secondary">{f('servicios.datos.intro')}</Text>
      <Text weight="600">{etiqueta('provider_type', 'servicios.campo.provider_type')}</Text>
      <View style={styles.fila} accessibilityRole="radiogroup">
        {TIPOS_DE_PRESTADOR.map((opcion) => (
          <Chip
            key={opcion}
            rol="radio"
            label={f(claveDelTipoDePrestador(opcion))}
            selected={formulario.tipo === opcion}
            onPress={() => setFormulario({ ...formulario, tipo: opcion })}
          />
        ))}
      </View>
      <Input
        label={etiqueta('display_name', 'servicios.campo.display_name')}
        value={formulario.nombre}
        onChangeText={cambiar('nombre')}
        maxLength={120}
        error={error('nombre')}
      />
      <Input
        label={etiqueta('legal_name', empresa ? 'servicios.campo.legal_name_company' : 'servicios.campo.legal_name')}
        value={formulario.nombreLegal}
        onChangeText={cambiar('nombreLegal')}
        maxLength={200}
        error={error('nombreLegal')}
      />
      <Input
        label={etiqueta('country_code', 'servicios.campo.country_code')}
        value={formulario.pais}
        onChangeText={(v) => cambiar('pais')(v.toUpperCase())}
        autoCapitalize="characters"
        maxLength={2}
        placeholder={f('servicios.datos.paisEjemplo')}
        error={error('pais')}
      />
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.datos.paisAyuda')}
      </Text>
      {empresa ? (
        <>
          <Input
            label={etiqueta('tax_id', 'servicios.campo.tax_id')}
            value={formulario.ruc}
            onChangeText={cambiar('ruc')}
            maxLength={20}
            error={error('ruc')}
          />
          <Input
            label={etiqueta('representative_name', 'servicios.campo.representative_name')}
            value={formulario.representante}
            onChangeText={cambiar('representante')}
            maxLength={200}
            error={error('representante')}
          />
        </>
      ) : null}
      <Input
        label={etiqueta('summary', 'servicios.campo.summary')}
        value={formulario.resumen}
        onChangeText={cambiar('resumen')}
        multiline
        maxLength={4000}
        error={error('resumen')}
        placeholder={f('servicios.datos.resumenAyuda')}
      />
      <Input
        label={etiqueta('requested_category', 'servicios.campo.requested_category')}
        value={formulario.categoria}
        onChangeText={cambiar('categoria')}
        maxLength={80}
        error={error('categoria')}
      />
      <Button
        label={f('servicios.datos.guardar')}
        icon="save"
        loading={ocupado}
        disabled={ocupado}
        onPress={guardar}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  fila: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
