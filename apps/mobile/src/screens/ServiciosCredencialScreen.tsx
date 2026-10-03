import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { DateField } from '@/components/DateField';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { toast } from '@/lib/toast';
import {
  TIPOS_DE_CREDENCIAL,
  claveDelTipoDeCredencial,
  claveDelTipoDeDocumento,
  credencialDesde,
  credencialVacia,
  nuevaClave,
  peticionDeCredencial,
  type Fallo,
  type FormularioDeCredencial,
} from '@/lib/serviciosAdmision';
import { useCerrojo, useExpedienteDeServicios, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceProviderRepository } from '@/repositories/ServiceProviderRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Declarar o corregir UNA credencial.
 *
 * - LA EVIDENCIA es uno de los documentos ya subidos a esta postulación: el
 *   servidor no acepta uno ajeno.
 * - EL NÚMERO no se rellena al editar: el teléfono solo lo conoce enmascarado.
 *   Escribir uno nuevo lo cambia; dejarlo vacío lo deja como estaba.
 * - AL CREAR, una clave de idempotencia por intento: dos toques, una credencial.
 */
export function ServiciosCredencialScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { f } = useTextosDeServicios();
  const { solicitud, cargando, fallo, cargar } = useExpedienteDeServicios();
  const { ocupado, correr } = useCerrojo(cargar);
  const [formulario, setFormulario] = useState<FormularioDeCredencial | null>(null);
  const [fallos, setFallos] = useState<Fallo[]>([]);
  const clave = useRef(nuevaClave());

  const anterior = id ? (solicitud?.credentials.find((c) => c.id === id) ?? null) : null;

  useEffect(() => {
    if (solicitud === null || formulario !== null) return;
    setFormulario(anterior ? credencialDesde(anterior) : credencialVacia());
  }, [solicitud, formulario, anterior]);

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/servicios/prestador/credenciales' as never);
  const titulo = f(id ? 'servicios.credencial.editarTitulo' : 'servicios.credencial.nuevaTitulo');

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
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
  if (!solicitud.editable || (id && (anterior === null || !anterior.can_edit))) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="empty" icon="lock" title={f('servicios.error.credencialBloqueada')} />
      </AppScreen>
    );
  }

  const error = (campo: string) => {
    const hallado = fallos.find((x) => x.campo === campo);
    return hallado ? f(hallado.clave) : undefined;
  };
  const poner = (campo: keyof FormularioDeCredencial) => (valor: string) =>
    setFormulario((actual) => (actual ? { ...actual, [campo]: valor } : actual));

  const guardar = () => {
    const { peticion, fallos: encontrados } = peticionDeCredencial(formulario, anterior);
    setFallos(encontrados);
    if (peticion === null) return;
    void correr(async () => {
      if (anterior) {
        await ServiceProviderRepository.editarCredencial(anterior.id, peticion);
      } else {
        await ServiceProviderRepository.registrarCredencial(peticion, clave.current);
      }
      toast(f('servicios.credencial.guardada'));
      router.replace('/servicios/prestador/credenciales' as never);
    });
  };

  return (
    <AppScreen teclado contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      {anterior === null ? (
        <>
          <Text weight="600">{f('servicios.credencial.tipo')}</Text>
          <View style={styles.fila} accessibilityRole="radiogroup">
            {TIPOS_DE_CREDENCIAL.map((tipo) => (
              <Chip
                key={tipo}
                rol="radio"
                label={f(claveDelTipoDeCredencial(tipo))}
                selected={formulario.tipo === tipo}
                onPress={() => setFormulario({ ...formulario, tipo })}
              />
            ))}
          </View>
          {error('tipo') ? (
            <Text variant="caption" color={colors.danger}>
              {error('tipo')}
            </Text>
          ) : null}
        </>
      ) : (
        <Text variant="secondary">{f(claveDelTipoDeCredencial(anterior.kind))}</Text>
      )}
      <Input label={f('servicios.credencial.titulo')} value={formulario.titulo} onChangeText={poner('titulo')} maxLength={200} error={error('titulo')} />
      <Input label={f('servicios.credencial.emisor')} value={formulario.emisor} onChangeText={poner('emisor')} maxLength={200} error={error('emisor')} />
      <Input
        label={f('servicios.credencial.jurisdiccion')}
        value={formulario.jurisdiccion}
        onChangeText={poner('jurisdiccion')}
        maxLength={120}
        error={error('jurisdiccion')}
      />
      <Input
        label={f('servicios.credencial.numero')}
        value={formulario.numero}
        onChangeText={poner('numero')}
        maxLength={64}
        autoCapitalize="characters"
        error={error('numero')}
        placeholder={
          anterior?.number_masked
            ? f('servicios.credencial.numeroActual', { numero: anterior.number_masked })
            : undefined
        }
      />
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.credencial.numeroPrivado')}
      </Text>
      <Input
        label={f('servicios.credencial.especialidad')}
        value={formulario.especialidad}
        onChangeText={poner('especialidad')}
        maxLength={200}
        error={error('especialidad')}
      />
      <DateField label={f('servicios.credencial.emitida')} value={formulario.emitida} onChange={poner('emitida')} />
      {error('emitida') ? (
        <Text variant="caption" color={colors.danger}>
          {error('emitida')}
        </Text>
      ) : null}
      <DateField label={f('servicios.credencial.vence')} value={formulario.vence} onChange={poner('vence')} />
      {error('vence') ? (
        <Text variant="caption" color={colors.danger}>
          {error('vence')}
        </Text>
      ) : null}

      <Text weight="600">{f('servicios.credencial.evidencia')}</Text>
      {solicitud.documents.length === 0 ? (
        <Text variant="secondary">{f('servicios.credencial.sinDocumentos')}</Text>
      ) : (
        <View style={styles.fila} accessibilityRole="radiogroup">
          <Chip
            rol="radio"
            label={f('servicios.credencial.sinEvidencia')}
            selected={formulario.evidencia === null}
            onPress={() => setFormulario({ ...formulario, evidencia: null })}
          />
          {solicitud.documents.map((d) => (
            <Chip
              key={d.id}
              rol="radio"
              label={f(claveDelTipoDeDocumento(d.kind))}
              selected={formulario.evidencia === d.id}
              onPress={() => setFormulario({ ...formulario, evidencia: d.id })}
            />
          ))}
        </View>
      )}
      <Button
        label={f('servicios.credencial.subirEvidencia')}
        variant="ghost"
        icon="upload"
        onPress={() => router.push('/servicios/prestador/documentos' as never)}
      />
      <Button
        label={f('servicios.credencial.guardar')}
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
