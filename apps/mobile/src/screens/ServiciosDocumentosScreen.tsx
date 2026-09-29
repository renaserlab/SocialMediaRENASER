import React, { useState } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { SectionTitle } from '@/components/SectionTitle';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import {
  FORMATOS_DE_DOCUMENTO,
  PESO_MAXIMO_DE_DOCUMENTO,
  TIPOS_DE_DOCUMENTO,
  claveDelEstadoDeDocumento,
  claveDelTipoDeDocumento,
  documentosQueFaltan,
  fechaCorta,
  pesoLegible,
  type DocumentoPrivado,
} from '@/lib/serviciosAdmision';
import { useCerrojo, useExpedienteDeServicios, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceProviderRepository } from '@/repositories/ServiceProviderRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

type Elegido = { archivo: Blob; nombre: string };

/**
 * Paso 4: los documentos, al DEPÓSITO PRIVADO.
 *
 * - LO QUE SE PIDE lo dice el servidor (`missing`): la identidad para una
 *   persona; además, la representación para una empresa; y lo que exijan las
 *   condiciones vigentes. No se inventa ningún papel.
 * - EL ARCHIVO VA A LA API, que decide su formato mirando los bytes y pone la
 *   ruta. El teléfono nunca ve la ruta ni guarda un enlace: MIRAR un documento
 *   pide uno nuevo, de dos minutos.
 * - Lo ya ENVIADO no se retira, se reemplaza: queda como evidencia.
 */
export function ServiciosDocumentosScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f } = useTextosDeServicios();
  const { solicitud, setSolicitud, cargando, fallo, ninguna, cargar } = useExpedienteDeServicios();
  const { ocupado, correr } = useCerrojo(cargar);
  const [otroTipo, setOtroTipo] = useState<string | null>(null);

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/servicios/prestador' as never));
  const titulo = f('servicios.paso.documentos');

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

  /** Elige el archivo y lo comprueba ANTES de subir: formato y peso. */
  const elegir = async (): Promise<Elegido | null> => {
    const eleccion = await DocumentPicker.getDocumentAsync({
      type: [...FORMATOS_DE_DOCUMENTO],
      copyToCacheDirectory: true,
      multiple: false,
    });
    const elegido = eleccion.canceled ? undefined : eleccion.assets?.[0];
    if (elegido === undefined) return null;
    const tipo = elegido.mimeType ?? 'application/octet-stream';
    if (!(FORMATOS_DE_DOCUMENTO as readonly string[]).includes(tipo)) {
      notify(f('servicios.noSePudo'), f('servicios.error.documentoFormato'));
      return null;
    }
    if (typeof elegido.size === 'number' && elegido.size > PESO_MAXIMO_DE_DOCUMENTO) {
      notify(f('servicios.noSePudo'), f('servicios.error.documentoPesado'));
      return null;
    }
    // EN EL TELÉFONO VIAJA COMO `{uri, name, type}`; en la web, el `File` de verdad.
    const archivo =
      Platform.OS === 'web' && elegido.file
        ? elegido.file
        : ({ uri: elegido.uri, name: elegido.name, type: tipo } as unknown as Blob);
    return { archivo, nombre: elegido.name };
  };

  const subir = (tipo: string) =>
    void correr(async () => {
      const elegido = await elegir();
      if (elegido === null) return;
      setSolicitud(await ServiceProviderRepository.subirDocumento({ ...elegido, tipo }));
      setOtroTipo(null);
      toast(f('servicios.documentos.subido'));
    });

  const reemplazar = (documento: DocumentoPrivado) =>
    void correr(async () => {
      const elegido = await elegir();
      if (elegido === null) return;
      setSolicitud(await ServiceProviderRepository.reemplazarDocumento(documento.id, elegido));
      toast(f('servicios.documentos.reemplazado'));
    });

  const retirar = (documento: DocumentoPrivado) =>
    void correr(async () => {
      const si = await confirm({
        title: f('servicios.documentos.retirarTitulo'),
        message: f('servicios.documentos.retirarAviso'),
        confirmLabel: f('servicios.documentos.retirar'),
        destructive: true,
      });
      if (!si) return;
      setSolicitud(await ServiceProviderRepository.retirarDocumento(documento.id));
      toast(f('servicios.documentos.retirado'));
    });

  const ver = (documento: DocumentoPrivado) =>
    void correr(async () => {
      const enlace = await ServiceProviderRepository.verDocumento(documento.id);
      await Linking.openURL(enlace.url);
    });

  const faltan = documentosQueFaltan(solicitud);
  const editable = solicitud.editable;

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      <Text variant="secondary">{f('servicios.documentos.intro')}</Text>
      <Text variant="caption" color={colors.textMuted}>
        {f('servicios.documentos.formatos')}
      </Text>

      {editable && faltan.length > 0 ? (
        <View style={styles.seccion}>
          <SectionTitle title={f('servicios.documentos.pedidos')} />
          {faltan.map((tipo) => (
            <View key={tipo} style={[styles.tarjeta, { borderColor: colors.border }]}>
              <Text weight="600">{f(claveDelTipoDeDocumento(tipo))}</Text>
              <Button
                label={f('servicios.documentos.subir')}
                variant="secondary"
                icon="upload"
                loading={ocupado}
                disabled={ocupado}
                onPress={() => subir(tipo)}
              />
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.seccion}>
        <SectionTitle title={f('servicios.documentos.tuyos')} />
        {solicitud.documents.length === 0 ? (
          <StateView state="empty" icon="file" title={f('servicios.documentos.ninguno')} />
        ) : (
          solicitud.documents.map((documento) => (
            <View key={documento.id} style={[styles.tarjeta, { borderColor: colors.border }]}>
              <Text weight="600">{f(claveDelTipoDeDocumento(documento.kind))}</Text>
              <Text
                variant="caption"
                color={documento.review_status === 'rejected' ? colors.danger : colors.textMuted}
              >
                {`${f(claveDelEstadoDeDocumento(documento.review_status))} · ${pesoLegible(documento.byte_size)} · ${fechaCorta(documento.created_at)}`}
              </Text>
              {documento.review_note ? (
                <Text variant="secondary">{f('servicios.documentos.nota', { nota: documento.review_note })}</Text>
              ) : null}
              <View style={styles.acciones}>
                <Button
                  label={f('servicios.documentos.ver')}
                  variant="ghost"
                  icon="external-link"
                  disabled={ocupado}
                  onPress={() => ver(documento)}
                />
                {documento.can_replace ? (
                  <Button
                    label={f('servicios.documentos.reemplazar')}
                    variant="ghost"
                    icon="refresh-cw"
                    disabled={ocupado}
                    onPress={() => reemplazar(documento)}
                  />
                ) : null}
                {documento.can_remove ? (
                  <Button
                    label={f('servicios.documentos.retirar')}
                    variant="ghost"
                    icon="trash-2"
                    disabled={ocupado}
                    onPress={() => retirar(documento)}
                  />
                ) : null}
              </View>
            </View>
          ))
        )}
      </View>

      {editable ? (
        <View style={styles.seccion}>
          <SectionTitle title={f('servicios.documentos.otro')} />
          <View style={styles.fila} accessibilityRole="radiogroup">
            {TIPOS_DE_DOCUMENTO.map((tipo) => (
              <Chip
                key={tipo}
                rol="radio"
                label={f(claveDelTipoDeDocumento(tipo))}
                selected={otroTipo === tipo}
                onPress={() => setOtroTipo(tipo)}
              />
            ))}
          </View>
          <Button
            label={f('servicios.documentos.elegirArchivo')}
            variant="secondary"
            icon="paperclip"
            loading={ocupado}
            disabled={ocupado || otroTipo === null}
            onPress={() => otroTipo && subir(otroTipo)}
          />
        </View>
      ) : null}

      <Button
        label={f('servicios.paso.credenciales')}
        icon="arrow-right"
        onPress={() => router.replace('/servicios/prestador/credenciales' as never)}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  seccion: { gap: spacing.sm },
  tarjeta: { gap: spacing.sm, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
  acciones: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  fila: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
