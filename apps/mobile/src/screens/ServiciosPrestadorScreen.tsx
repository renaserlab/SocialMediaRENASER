import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { ListRow } from '@/components/ListRow';
import { SectionTitle } from '@/components/SectionTitle';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { toast } from '@/lib/toast';
import {
  PASOS,
  claveDelCampo,
  claveDelCuerpoDelEstado,
  claveDelEstado,
  esFinal,
  fechaCorta,
  pasosPendientes,
  requisito,
  type Paso,
} from '@/lib/serviciosAdmision';
import { useCerrojo, useExpedienteDeServicios, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceProviderRepository } from '@/repositories/ServiceProviderRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

const RUTA_DEL_PASO: Record<Paso, string> = {
  datos: '/servicios/prestador/datos',
  condiciones: '/servicios/prestador/condiciones',
  documentos: '/servicios/prestador/documentos',
  credenciales: '/servicios/prestador/credenciales',
  resumen: '/servicios/prestador/resumen',
};

/**
 * «Ofrecer un servicio»: la puerta de la admisión de prestadores.
 *
 * TRES MOMENTOS EN UNA PANTALLA, según lo que diga el servidor:
 *
 *  - SIN POSTULACIÓN: qué es, qué se pide y qué revisa Z. Nada de precios, ni
 *    catálogo, ni reservas: eso no existe todavía y no se promete.
 *  - CON UNA EDITABLE (borrador o devuelta con correcciones): los pasos, cada
 *    uno marcado como listo SOLO si el servidor ya no pide nada de él, y lo
 *    que Z pidió corregir.
 *  - CON UNA EN MARCHA O DECIDIDA: el estado, el mensaje de Z y lo que se
 *    puede hacer ahora (retirarse, empezar otra), según `can_*`.
 *
 * NINGUNA CIFRA NI PLAZO INVENTADO: cuánto tarda una revisión no lo dice el
 * contrato, así que no se escribe aquí.
 */
export function ServiciosPrestadorScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f } = useTextosDeServicios();
  const { solicitud, cargando, fallo, ninguna, cargar } = useExpedienteDeServicios();
  const { ocupado, correr } = useCerrojo(cargar);

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const titulo = f('servicios.prestador.titulo');

  if (cargando && solicitud === null && !ninguna) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      </AppScreen>
    );
  }

  const tarjeta = [styles.tarjeta, { borderColor: colors.border }];

  /* ---------------------------------------------------------------- */
  /* Sin postulación: la explicación                                   */
  /* ---------------------------------------------------------------- */
  if (solicitud === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <Text variant="title">{f('servicios.intro.titulo')}</Text>
        <Text variant="secondary">{f('servicios.intro.cuerpo')}</Text>
        <View style={tarjeta}>
          <Text weight="700">{f('servicios.intro.pasosTitulo')}</Text>
          {PASOS.map((paso, i) => (
            <Text key={paso} variant="secondary">
              {`${i + 1}. ${f(`servicios.paso.${paso}`)}`}
            </Text>
          ))}
        </View>
        <View style={tarjeta}>
          <Text weight="700">{f('servicios.intro.revisionTitulo')}</Text>
          <Text variant="secondary">{f('servicios.intro.revisionCuerpo')}</Text>
        </View>
        <Text variant="caption" color={colors.textMuted}>
          {f('servicios.intro.privacidad')}
        </Text>
        <Button
          label={f('servicios.intro.empezar')}
          icon="arrow-right"
          onPress={() => router.push('/servicios/prestador/inicio' as never)}
        />
      </AppScreen>
    );
  }

  /* ---------------------------------------------------------------- */
  /* Con postulación                                                   */
  /* ---------------------------------------------------------------- */
  const pendientes = pasosPendientes(solicitud);
  const fecha = solicitud.decided_at ?? solicitud.last_submitted_at ?? solicitud.updated_at;

  const empezarOtra = () =>
    void correr(async () => {
      if (solicitud.status === 'rejected') {
        // Tras un RECHAZO, volver a postular lo decide la política vigente: se
        // pregunta al servidor en vez de suponerlo.
        await ServiceProviderRepository.iniciar({
          provider_type: solicitud.provider.provider_type,
          display_name: solicitud.provider.display_name,
        });
        toast(f('servicios.prestador.nuevaCreada'));
        await cargar();
        return;
      }
      router.push('/servicios/prestador/inicio' as never);
    });

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />

      <View style={tarjeta} accessibilityRole="summary">
        <Text variant="caption" color={colors.textMuted}>
          {f('servicios.prestador.estado')}
        </Text>
        <Text variant="titleMedium">{f(claveDelEstado(solicitud.status))}</Text>
        <Text variant="secondary">{f(claveDelCuerpoDelEstado(solicitud.status))}</Text>
        {fecha ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.prestador.fecha', { fecha: fechaCorta(fecha) })}
          </Text>
        ) : null}
      </View>

      {solicitud.applicant_message ? (
        <View style={[tarjeta, { borderColor: colors.primary }]}>
          <Text weight="700">{f('servicios.prestador.mensajeDeZ')}</Text>
          <Text>{solicitud.applicant_message}</Text>
          {solicitud.observed_fields.length > 0 ? (
            <Text variant="secondary">
              {f('servicios.prestador.camposPorCorregir', {
                campos: solicitud.observed_fields.map((c) => f(claveDelCampo(c))).join(', '),
              })}
            </Text>
          ) : null}
        </View>
      ) : null}

      {solicitud.editable ? (
        <View style={styles.seccion}>
          <SectionTitle title={f('servicios.prestador.pasos')} />
          {PASOS.map((paso) => {
            const listo = paso === 'resumen' ? solicitud.missing.length === 0 : !pendientes.has(paso);
            return (
              <ListRow
                key={paso}
                title={f(`servicios.paso.${paso}`)}
                subtitle={f(listo ? 'servicios.paso.listo' : 'servicios.paso.pendiente')}
                leftIcon={listo ? 'check-circle' : 'circle'}
                rightIcon="chevron-right"
                onPress={() => router.push(RUTA_DEL_PASO[paso] as never)}
              />
            );
          })}
          {solicitud.missing.length > 0 ? (
            <View style={tarjeta}>
              <Text weight="700">{f('servicios.prestador.faltan')}</Text>
              {solicitud.missing.map((codigo) => {
                const r = requisito(codigo);
                return (
                  <Text key={codigo} variant="secondary">
                    {`• ${f(r.clave, r.nombre ? { nombre: f(r.nombre) } : undefined)}`}
                  </Text>
                );
              })}
            </View>
          ) : null}
          <Button
            label={f(
              solicitud.status === 'changes_requested'
                ? 'servicios.prestador.revisarYReenviar'
                : 'servicios.prestador.revisarYEnviar',
            )}
            icon="send"
            onPress={() => router.push('/servicios/prestador/resumen' as never)}
          />
        </View>
      ) : null}

      {!solicitud.editable && !esFinal(solicitud.status) ? (
        <View style={tarjeta}>
          <Text variant="secondary">
            {f('servicios.prestador.resumenEnviado', {
              documentos: solicitud.documents.length,
              credenciales: solicitud.credentials.length,
            })}
          </Text>
        </View>
      ) : null}

      <View style={styles.seccion}>
        <ListRow
          title={f('servicios.historial.titulo')}
          leftIcon="clock"
          rightIcon="chevron-right"
          onPress={() => router.push('/servicios/prestador/historial' as never)}
        />
        {solicitud.can_withdraw ? (
          <ListRow
            title={f('servicios.retirar.titulo')}
            leftIcon="log-out"
            destructive
            onPress={() => router.push('/servicios/prestador/retirar' as never)}
          />
        ) : null}
      </View>

      {esFinal(solicitud.status) ? (
        <Button
          label={f('servicios.prestador.empezarOtra')}
          variant="secondary"
          icon="refresh-cw"
          loading={ocupado}
          disabled={ocupado}
          onPress={empezarOtra}
        />
      ) : null}
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.prestador.sinPlazos')}
      </Text>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  seccion: { gap: spacing.xs },
  tarjeta: { gap: spacing.sm, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
