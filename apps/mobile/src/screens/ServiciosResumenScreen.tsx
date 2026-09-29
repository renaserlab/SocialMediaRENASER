import React, { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { ListRow } from '@/components/ListRow';
import { SectionTitle } from '@/components/SectionTitle';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import {
  claveDelEstadoDeCredencial,
  claveDelEstadoDeDocumento,
  claveDelTipoDeCredencial,
  claveDelTipoDeDocumento,
  claveDelTipoDePrestador,
  nuevaClave,
  requisito,
} from '@/lib/serviciosAdmision';
import { useCerrojo, useExpedienteDeServicios, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceProviderRepository } from '@/repositories/ServiceProviderRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * Pasos 6 y 7: el RESUMEN de lo que se va a enviar, la DECLARACIÓN DE
 * VERACIDAD y el envío (o el REENVÍO, si Z pidió correcciones).
 *
 * EL BOTÓN SOLO SE ACTIVA si el servidor dice que se puede (`can_submit` /
 * `can_resubmit`) y la declaración está marcada; si no, se enseña qué falta,
 * con palabras. La clave de idempotencia es del INTENTO: un reintento tras
 * perder la conexión no envía dos veces.
 */
export function ServiciosResumenScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f } = useTextosDeServicios();
  const { solicitud, cargando, fallo, ninguna, cargar } = useExpedienteDeServicios();
  const { ocupado, correr } = useCerrojo(cargar);
  const [declaro, setDeclaro] = useState(false);
  const clave = useRef(nuevaClave());

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/servicios/prestador' as never));
  const titulo = f('servicios.paso.resumen');

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

  const reenvio = solicitud.status === 'changes_requested';
  const puede = reenvio ? solicitud.can_resubmit : solicitud.can_submit;
  const p = solicitud.provider;
  const tarjeta = [styles.tarjeta, { borderColor: colors.border }];

  const enviar = () =>
    void correr(async () => {
      const si = await confirm({
        title: f(reenvio ? 'servicios.resumen.reenviarTitulo' : 'servicios.resumen.enviarTitulo'),
        message: f('servicios.resumen.enviarAviso'),
        confirmLabel: f(reenvio ? 'servicios.resumen.reenviar' : 'servicios.resumen.enviar'),
      });
      if (!si) return;
      if (reenvio) await ServiceProviderRepository.reenviar(clave.current);
      else await ServiceProviderRepository.enviar(clave.current);
      clave.current = nuevaClave();
      toast(f(reenvio ? 'servicios.resumen.reenviada' : 'servicios.resumen.enviada'));
      router.replace('/servicios/prestador' as never);
    });

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />

      <SectionTitle title={f('servicios.paso.datos')} />
      <View style={tarjeta}>
        <Text weight="600">{p.display_name}</Text>
        <Text variant="secondary">{f(claveDelTipoDePrestador(p.provider_type))}</Text>
        {p.legal_name ? <Text variant="secondary">{p.legal_name}</Text> : null}
        {p.country_code ? <Text variant="secondary">{p.country_code}</Text> : null}
        {p.tax_id ? <Text variant="secondary">{p.tax_id}</Text> : null}
        {p.representative_name ? <Text variant="secondary">{p.representative_name}</Text> : null}
        {solicitud.summary ? <Text>{solicitud.summary}</Text> : null}
        {solicitud.editable ? (
          <ListRow
            title={f('servicios.resumen.editar')}
            leftIcon="edit-3"
            onPress={() => router.push('/servicios/prestador/datos' as never)}
          />
        ) : null}
      </View>

      <SectionTitle title={f('servicios.paso.condiciones')} />
      <View style={tarjeta}>
        <Text variant="secondary">
          {solicitud.terms
            ? f('servicios.resumen.condicionesAceptadas', { version: solicitud.terms.version ?? '' })
            : f('servicios.falta.condicionesSinAceptar')}
        </Text>
      </View>

      <SectionTitle title={f('servicios.paso.documentos')} />
      <View style={tarjeta}>
        {solicitud.documents.length === 0 ? (
          <Text variant="secondary">{f('servicios.documentos.ninguno')}</Text>
        ) : (
          solicitud.documents.map((d) => (
            <Text key={d.id} variant="secondary">
              {`• ${f(claveDelTipoDeDocumento(d.kind))} · ${f(claveDelEstadoDeDocumento(d.review_status))}`}
            </Text>
          ))
        )}
      </View>

      <SectionTitle title={f('servicios.paso.credenciales')} />
      <View style={tarjeta}>
        {solicitud.credentials.length === 0 ? (
          <Text variant="secondary">{f('servicios.credenciales.ninguna')}</Text>
        ) : (
          solicitud.credentials.map((c) => (
            <Text key={c.id} variant="secondary">
              {`• ${c.title} (${f(claveDelTipoDeCredencial(c.kind))}) · ${f(claveDelEstadoDeCredencial(c.display_status))}`}
            </Text>
          ))
        )}
      </View>

      {!solicitud.editable ? (
        <StateView state="empty" icon="lock" title={f('servicios.error.noEditable')} />
      ) : (
        <>
          {solicitud.missing.length > 0 ? (
            <View style={[styles.tarjeta, { borderColor: colors.danger }]}>
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
          <Chip
            rol="checkbox"
            label={f('servicios.resumen.declaro')}
            selected={declaro}
            onPress={() => setDeclaro(!declaro)}
          />
          <Button
            label={f(reenvio ? 'servicios.resumen.reenviar' : 'servicios.resumen.enviar')}
            icon="send"
            loading={ocupado}
            disabled={!puede || !declaro || ocupado}
            onPress={enviar}
          />
        </>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: { gap: spacing.xs, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
});
