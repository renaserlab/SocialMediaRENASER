import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { ListRow } from '@/components/ListRow';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { claveDeLaModalidad } from '@/lib/serviciosCatalogo';
import { claveDelDia, claveDelEstadoDeLaAgenda, claveDelMotivo, diaDeLaSemana, fechaVisible } from '@/lib/serviciosAgenda';
import { useAgendaPropia } from '@/hooks/useAgendaDeServicio';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { useTextosDeServicios } from '@/hooks/useServicios';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * «Disponibilidad y agenda» de un servicio propio: el resumen.
 *
 * Zona, duración (la de la versión publicada o, sin ella, la que se prepara),
 * preparación y descanso, modalidad, estado y el próximo horario que vería una
 * persona. Y POR QUÉ EL PÚBLICO TODAVÍA NO LOS VE, con las palabras del
 * servidor (`issues`), nunca adivinado aquí.
 *
 * Desde aquí se llega a los ajustes, la semana, las excepciones, los bloqueos
 * y la vista previa. Nada de esto reserva nada.
 */
export function AgendaDelServicioScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('serviceId');
  const { f } = useTextosDeServicios('agenda');
  const { agenda, fallo, cargar } = useAgendaPropia(id);
  const ruta = `/servicios/prestador/catalogo/${id}/agenda`;

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace(`/servicios/prestador/catalogo/${id}` as never);
  const titulo = f('servicios.agenda.titulo');

  if (fallo !== null || agenda === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        {fallo !== null ? <EstadoDelCatalogo fallo={fallo} onRetry={() => void cargar()} /> : <StateView state="loading" />}
      </AppScreen>
    );
  }

  const a = agenda;
  const tarjeta = [styles.tarjeta, { borderColor: colors.border }];
  const motivos = a.issues.map(claveDelMotivo).filter((c): c is string => c !== null);

  if (!a.configured) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView
          state="empty"
          icon="calendar"
          title={f('servicios.agenda.sinConfigurar')}
          description={f('servicios.agenda.sinConfigurarCuerpo')}
          actionLabel={a.can_edit ? f('servicios.agenda.configurar') : undefined}
          onAction={a.can_edit ? () => router.push(`${ruta}/ajustes` as never) : undefined}
        />
      </AppScreen>
    );
  }

  const proximo = a.next_available;
  const minutos = (n: number) => f('servicios.agenda.minutos', { n });

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />

      <View style={tarjeta} accessibilityRole="summary">
        <Text variant="titleMedium">{a.service.title ?? f('servicios.catalogo.sinTitulo')}</Text>
        <Text weight="700">{f(claveDelEstadoDeLaAgenda(a.status))}</Text>
        <Text variant="secondary">{f('servicios.agenda.zona', { zona: a.timezone ?? '' })}</Text>
        <Text variant="secondary">
          {a.service.duration_minutes
            ? f('servicios.agenda.duracion', { n: a.service.duration_minutes })
            : f('servicios.agenda.sinDuracion')}
        </Text>
        <Text variant="secondary">
          {`${f('servicios.agenda.modalidad')}: ${f(claveDeLaModalidad(a.service.modality))}`}
        </Text>
        <Text variant="secondary">
          {f('servicios.agenda.separacion', {
            antes: minutos(a.buffer_before_minutes),
            despues: minutos(a.buffer_after_minutes),
          })}
        </Text>
        {a.slot_interval_minutes ? (
          <Text variant="secondary">{f('servicios.agenda.intervalo', { n: a.slot_interval_minutes })}</Text>
        ) : null}
        <Text variant="secondary">
          {proximo
            ? f('servicios.agenda.proximo', {
                dia: f(claveDelDia(diaDeLaSemana(proximo.date))),
                fecha: fechaVisible(proximo.date),
                hora: proximo.time,
              })
            : f('servicios.agenda.sinProximo', { n: a.limits.horizon_days })}
        </Text>
      </View>

      {motivos.length > 0 ? (
        <View style={[styles.tarjeta, { borderColor: colors.primary }]}>
          <Text weight="700">{f('servicios.agenda.porQueNoSeVe')}</Text>
          {motivos.map((clave) => (
            <Text key={clave} variant="secondary">
              {`• ${f(clave)}`}
            </Text>
          ))}
        </View>
      ) : (
        <Text variant="caption" color={colors.primary}>
          {f('servicios.agenda.seVe')}
        </Text>
      )}

      <View style={styles.seccion}>
        <ListRow
          title={f('servicios.agenda.ajustes')}
          subtitle={a.timezone ?? ''}
          leftIcon="settings"
          rightIcon="chevron-right"
          onPress={() => router.push(`${ruta}/ajustes` as never)}
        />
        <ListRow
          title={f('servicios.agenda.semanal')}
          subtitle={f('servicios.agenda.cuantasFranjas', { n: a.rules.filter((r) => r.active).length })}
          leftIcon="repeat"
          rightIcon="chevron-right"
          onPress={() => router.push(`${ruta}/semanal` as never)}
        />
        <ListRow
          title={f('servicios.agenda.excepciones')}
          subtitle={f('servicios.agenda.cuantasExcepciones', { n: a.exceptions.length })}
          leftIcon="calendar"
          rightIcon="chevron-right"
          onPress={() => router.push(`${ruta}/excepciones` as never)}
        />
        <ListRow
          title={f('servicios.agenda.bloqueos')}
          subtitle={f('servicios.agenda.cuantosBloqueos', { n: a.blocks.length })}
          leftIcon="slash"
          rightIcon="chevron-right"
          onPress={() => router.push(`${ruta}/bloqueos` as never)}
        />
        <ListRow
          title={f('servicios.agenda.vistaPrevia')}
          subtitle={f('servicios.agenda.vistaPreviaCuerpo')}
          leftIcon="eye"
          rightIcon="chevron-right"
          onPress={() => router.push(`${ruta}/vista-previa` as never)}
        />
      </View>
      {!a.can_edit ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('servicios.agenda.soloLectura')}
        </Text>
      ) : null}
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.agenda.sinReservas')}
      </Text>
      <Button label={f('servicios.agenda.volverAlServicio')} variant="ghost" icon="arrow-left" onPress={volver} />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  seccion: { gap: spacing.xs },
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
