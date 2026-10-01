import React, { useCallback, useRef, useState } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EstadoDeServicios } from '@/components/EstadoDeServicios';
import { ExpedienteDelCaso } from '@/components/ExpedienteDelCaso';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { toast } from '@/lib/toast';
import { nuevaClave, type FalloDeCarga } from '@/lib/serviciosAdmision';
import {
  FORMATOS_DE_EVIDENCIA,
  LARGOS_DE_LA_ATENCION,
  MOTIVOS_DE_CADA_PARTE,
  motivosParaAbrir,
  PESO_MAXIMO_DE_EVIDENCIA,
  claveDelMotivoDelCaso,
  llavero,
  momentoLegible,
  peticionDeMensaje,
  peticionDelCaso,
  puede,
  puedeEnElCaso,
  type ConCuidado,
  type Entrada,
  type Expediente,
  type Parte,
} from '@/lib/serviciosAtencion';
import { rutaDeLaReserva, rutaDeLaReservaDelPrestador, type ReservaDetalle } from '@/lib/serviciosReserva';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { leerFallo, useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceCareRepository } from '@/repositories/ServiceCareRepository';
import { ApiError } from '@/services/api';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * EL CASO de una reserva: reportar un problema y seguir su expediente.
 *
 * Uno por reserva, lo abra quien lo abra. Las dos partes escriben y aportan
 * evidencias (PDF o foto, PRIVADAS: se miran con un enlace que caduca);
 * administración resuelve; y una de las partes puede apelar UNA vez.
 *
 * RESUELTO NO ES DEVUELTO: la resolución dice qué se decidió y, aparte, qué
 * se solicitó de dinero y en qué quedó. Lo que se puede hacer lo dice el
 * servidor (`available_actions`).
 */
export function CasoDeLaReservaScreen({ rol }: { rol: Parte }) {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('bookingId');
  const { f } = useTextosDeServicios('reserva');
  const [reserva, setReserva] = useState<ConCuidado<ReservaDetalle> | null>(null);
  const [caso, setCaso] = useState<Expediente | null>(null);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);
  const [motivo, setMotivo] = useState<string | null>(null);
  const [descripcion, setDescripcion] = useState('');
  const [mensaje, setMensaje] = useState('');
  const [apelacion, setApelacion] = useState('');
  const llaves = useRef(llavero(nuevaClave)).current;

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      const fresca = await ServiceCareRepository.reserva(rol, id);
      setReserva(fresca);
      // Sin caso todavía no es un fallo: es el formulario para abrirlo.
      setCaso(fresca.care?.incident ? await ServiceCareRepository.caso(rol, id) : null);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'service_incident_not_found') setCaso(null);
      else setFallo(leerFallo(error));
    }
  }, [id, rol]);
  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );
  const { ocupado, correr } = useCerrojo(cargar, 'reserva');
  // Pasado el plazo ordinario solo queda el de seguridad: no se ofrece lo que el servidor rechazará.
  const motivos = motivosParaAbrir(rol, reserva?.care);

  const laReserva = rol === 'client' ? rutaDeLaReserva(id) : rutaDeLaReservaDelPrestador(id);
  const volver = () => (router.canGoBack() ? router.back() : router.replace(laReserva as never));
  const titulo = f('servicios.atencion.caso.titulo');

  const abrir = () =>
    void correr(async () => {
      const { peticion, fallo: falta } = peticionDelCaso(rol, motivo, descripcion);
      if (peticion === null) {
        notify(f('servicios.noSePudo'), f(falta ?? 'servicios.atencion.error.motivo'));
        return;
      }
      setCaso(await ServiceCareRepository.abrirCaso(rol, id, peticion, llaves.de('abrir', peticion)));
      llaves.hecho('abrir');
      setDescripcion('');
      toast(f('servicios.atencion.caso.abierto'));
    });

  const escribir = () =>
    void correr(async () => {
      const { peticion, fallo: falta } = peticionDeMensaje(mensaje);
      if (peticion === null) {
        notify(f('servicios.noSePudo'), f(falta ?? 'servicios.atencion.error.vacio'));
        return;
      }
      setCaso(await ServiceCareRepository.escribirEnElCaso(rol, id, peticion, llaves.de('escribir', peticion)));
      llaves.hecho('escribir');
      setMensaje('');
    });

  /** Elige el archivo y lo comprueba ANTES de subir: formato y peso. */
  const subirEvidencia = () =>
    void correr(async () => {
      const eleccion = await DocumentPicker.getDocumentAsync({
        type: [...FORMATOS_DE_EVIDENCIA],
        copyToCacheDirectory: true,
        multiple: false,
      });
      const elegido = eleccion.canceled ? undefined : eleccion.assets?.[0];
      if (elegido === undefined) return;
      const tipo = elegido.mimeType ?? 'application/octet-stream';
      if (!(FORMATOS_DE_EVIDENCIA as readonly string[]).includes(tipo)) {
        notify(f('servicios.noSePudo'), f('servicios.error.documentoFormato'));
        return;
      }
      if (typeof elegido.size === 'number' && elegido.size > PESO_MAXIMO_DE_EVIDENCIA) {
        notify(f('servicios.noSePudo'), f('servicios.error.documentoPesado'));
        return;
      }
      // EN EL TELÉFONO VIAJA COMO `{uri, name, type}`; en la web, el `File` de verdad.
      const archivo =
        Platform.OS === 'web' && elegido.file
          ? elegido.file
          : ({ uri: elegido.uri, name: elegido.name, type: tipo } as unknown as Blob);
      setCaso(await ServiceCareRepository.subirEvidencia(rol, id, { archivo, nombre: elegido.name }, nuevaClave()));
      toast(f('servicios.atencion.caso.evidenciaSubida'));
    });

  const verEvidencia = (entrada: Entrada) =>
    void correr(async () => {
      const enlace = await ServiceCareRepository.verEvidencia(rol, id, entrada.id);
      await Linking.openURL(enlace.url);
    });

  const retirar = () =>
    void correr(async () => {
      const si = await confirm({
        title: f('servicios.atencion.caso.retirarTitulo'),
        message: f('servicios.atencion.caso.retirarAviso'),
        confirmLabel: f('servicios.atencion.caso.retirar'),
        destructive: true,
      });
      if (!si) return;
      setCaso(await ServiceCareRepository.retirarCaso(rol, id, llaves.de('retirar')));
      llaves.hecho('retirar');
      toast(f('servicios.atencion.caso.retirado'));
    });

  const apelar = () =>
    void correr(async () => {
      const { peticion, fallo: falta } = peticionDeMensaje(apelacion, LARGOS_DE_LA_ATENCION.descripcionMinima);
      if (peticion === null) {
        notify(f('servicios.noSePudo'), f(falta ?? 'servicios.atencion.error.vacio'));
        return;
      }
      const si = await confirm({
        title: f('servicios.atencion.caso.apelarTitulo'),
        message: f('servicios.atencion.caso.apelarAviso'),
        confirmLabel: f('servicios.atencion.caso.apelar'),
      });
      if (!si) return;
      setCaso(await ServiceCareRepository.apelar(rol, id, peticion, llaves.de('apelar', peticion)));
      llaves.hecho('apelar');
      setApelacion('');
      toast(f('servicios.atencion.caso.apelado'));
    });

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />
      {fallo !== null ? (
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      ) : reserva === null ? (
        <StateView state="loading" />
      ) : caso === null ? (
        puede(reserva.care, 'open_incident') ? (
          <>
            <Text variant="secondary">{f('servicios.atencion.caso.intro')}</Text>
            <Text variant="caption" color={colors.textMuted}>
              {f('servicios.atencion.caso.hasta', { fecha: momentoLegible(reserva.care?.deadlines.incident_until) })}
            </Text>
            {motivos.length < MOTIVOS_DE_CADA_PARTE[rol].length ? (
              <Text variant="caption" color={colors.textMuted}>
                {f('servicios.atencion.caso.soloSeguridad')}
              </Text>
            ) : null}
            <Text weight="700">{f('servicios.atencion.caso.queSucedio')}</Text>
            <View style={styles.fila} accessibilityRole="radiogroup">
              {motivos.map((m) => (
                <Chip
                  key={m}
                  rol="radio"
                  label={f(claveDelMotivoDelCaso(m))}
                  selected={motivo === m}
                  onPress={() => setMotivo(m)}
                />
              ))}
            </View>
            <Input
              label={f('servicios.atencion.caso.descripcion')}
              placeholder={f('servicios.atencion.caso.descripcionAyuda')}
              value={descripcion}
              onChangeText={setDescripcion}
              maxLength={LARGOS_DE_LA_ATENCION.descripcion}
              multiline
            />
            <Text variant="caption" color={colors.textMuted}>
              {f('servicios.atencion.caso.privado')}
            </Text>
            <Button
              label={f('servicios.atencion.caso.enviar')}
              icon="send"
              loading={ocupado}
              disabled={ocupado || motivo === null}
              onPress={abrir}
            />
          </>
        ) : (
          <StateView
            state="empty"
            icon="inbox"
            title={f('servicios.atencion.caso.ninguno')}
            description={f('servicios.atencion.caso.ningunoCuerpo')}
            actionLabel={f('servicios.reserva.verReserva')}
            onAction={() => router.replace(laReserva as never)}
          />
        )
      ) : (
        <>
          <ExpedienteDelCaso caso={caso} ocupado={ocupado} alVer={verEvidencia} />

          {puedeEnElCaso(caso, 'add_incident_entry') ? (
            <View style={[styles.tarjeta, { borderColor: colors.border }]}>
              <Input
                label={f('servicios.atencion.caso.mensaje')}
                value={mensaje}
                onChangeText={setMensaje}
                maxLength={LARGOS_DE_LA_ATENCION.entrada}
                multiline
              />
              <Button
                label={f('servicios.atencion.caso.enviarMensaje')}
                icon="send"
                loading={ocupado}
                disabled={ocupado || !mensaje.trim()}
                onPress={escribir}
              />
              <Button
                label={f('servicios.atencion.caso.subirEvidencia')}
                variant="secondary"
                icon="paperclip"
                disabled={ocupado}
                onPress={subirEvidencia}
              />
              <Text variant="caption" color={colors.textMuted}>
                {f('servicios.atencion.caso.evidenciaAyuda')}
              </Text>
            </View>
          ) : null}

          {puedeEnElCaso(caso, 'appeal_incident') ? (
            <View style={[styles.tarjeta, { borderColor: colors.border }]}>
              <Text weight="700">{f('servicios.atencion.caso.apelarTitulo')}</Text>
              <Text variant="caption" color={colors.textMuted}>
                {f('servicios.atencion.caso.apelarHasta', { fecha: momentoLegible(caso.appeal_until) })}
              </Text>
              <Input
                label={f('servicios.atencion.caso.apelarPorQue')}
                value={apelacion}
                onChangeText={setApelacion}
                maxLength={LARGOS_DE_LA_ATENCION.entrada}
                multiline
              />
              <Button
                label={f('servicios.atencion.caso.apelar')}
                variant="secondary"
                loading={ocupado}
                disabled={ocupado || !apelacion.trim()}
                onPress={apelar}
              />
            </View>
          ) : null}

          {puedeEnElCaso(caso, 'withdraw_incident') ? (
            <Button
              label={f('servicios.atencion.caso.retirar')}
              variant="ghost"
              icon="corner-up-left"
              disabled={ocupado}
              onPress={retirar}
            />
          ) : null}
        </>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: { gap: spacing.sm, borderWidth: 1, borderRadius: radius.lg, padding: spacing.lg },
  fila: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
});
