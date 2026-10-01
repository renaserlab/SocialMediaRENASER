import React, { useCallback, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

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
  EFECTOS_ECONOMICOS,
  LARGOS_DE_LA_ATENCION,
  RESULTADOS_DEL_CASO,
  claveDelEfectoEconomico,
  claveDelEfectoEnLaAtencion,
  claveDelEstadoDeLaReserva,
  claveDelResultado,
  efectosQueSeOfrecen,
  llavero,
  momentoLegible,
  peticionDeMensaje,
  peticionDeResolucion,
  puedeAdministrar,
  resolucionVacia,
  type Entrada,
  type ExpedienteAdmin,
  type FormularioDeResolucion,
} from '@/lib/serviciosAtencion';
import { useParametroDeRuta } from '@/hooks/useCatalogoDeServicios';
import { leerFallo, useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceCareRepository } from '@/repositories/ServiceCareRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * UN CASO, para administración: el expediente ENTERO (con las notas internas,
 * que no salen de aquí), un mensaje a las partes o una nota interna, y LA
 * RESOLUCIÓN.
 *
 * RESOLVER DICE TRES COSAS POR SEPARADO: qué se decidió, su efecto en la
 * atención y el efecto económico que se SOLICITA. El estado de ese efecto lo
 * pone el servidor («no aplica», «pendiente» o «bloqueado») y NUNCA es
 * «ejecutado»: aquí no se devuelve ni se transfiere nada.
 *
 * Quien es parte del caso no lo resuelve, y una apelación la resuelve otra
 * persona: el servidor lo impide y aquí se dice.
 */
export function AdminCasoDeServiciosScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const id = useParametroDeRuta('incidentId');
  const { f } = useTextosDeServicios('reserva');
  const [caso, setCaso] = useState<ExpedienteAdmin | null>(null);
  const [fallo, setFallo] = useState<FalloDeCarga | null>(null);
  const [mensaje, setMensaje] = useState('');
  const [interna, setInterna] = useState(false);
  const [resolucion, setResolucion] = useState<FormularioDeResolucion>(resolucionVacia);
  const llaves = useRef(llavero(nuevaClave)).current;

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setCaso(await ServiceCareRepository.casoParaAdministrar(id));
    } catch (error) {
      setFallo(leerFallo(error));
    }
  }, [id]);
  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );
  const { ocupado, correr } = useCerrojo(cargar, 'reserva');

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/admin/servicios/casos' as never));

  const anotar = () =>
    void correr(async () => {
      const { peticion, fallo: falta } = peticionDeMensaje(mensaje);
      if (peticion === null) {
        notify(f('servicios.noSePudo'), f(falta ?? 'servicios.atencion.error.vacio'));
        return;
      }
      const texto = String(peticion.body);
      setCaso(await ServiceCareRepository.anotarEnElCaso(id, texto, interna, llaves.de('anotar', { texto, interna })));
      llaves.hecho('anotar');
      setMensaje('');
    });

  const verEvidencia = (entrada: Entrada) =>
    void correr(async () => {
      const enlace = await ServiceCareRepository.verEvidenciaParaAdministrar(id, entrada.id);
      await Linking.openURL(enlace.url);
    });

  const resolver = () =>
    void correr(async () => {
      const { peticion, fallo: falta } = peticionDeResolucion(resolucion);
      if (peticion === null) {
        notify(f('servicios.noSePudo'), f(falta ?? 'servicios.atencion.error.resultado'));
        return;
      }
      const si = await confirm({
        title: f('servicios.atencion.admin.resolverTitulo'),
        message: f('servicios.atencion.admin.resolverAviso'),
        confirmLabel: f('servicios.atencion.admin.resolver'),
      });
      if (!si) return;
      setCaso(await ServiceCareRepository.resolver(id, peticion, llaves.de('resolver', peticion)));
      llaves.hecho('resolver');
      setResolucion(resolucionVacia());
      toast(f('servicios.atencion.admin.resuelto'));
    });

  // LO QUE SE PUEDE HACER LO DICE EL SERVIDOR: escribir a las partes mientras el caso
  // vive, y resolver solo quien puede (la apelación, otra persona) y con los efectos
  // que va a aceptar (una atención cerrada no se desmiente).
  const vivo = puedeAdministrar(caso, 'add_incident_entry');
  const resuelve = puedeAdministrar(caso, 'resolve_incident');
  const efectos = efectosQueSeOfrecen(caso);
  const tarjeta = [styles.tarjeta, { borderColor: colors.border }];

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('servicios.atencion.admin.caso')} onBack={volver} />
      {fallo !== null ? (
        <EstadoDeServicios fallo={fallo} onRetry={() => void cargar()} />
      ) : caso === null ? (
        <StateView state="loading" />
      ) : (
        <>
          <View style={tarjeta} accessibilityRole="summary">
            <Text weight="700">{`${caso.booking_code} · ${caso.title}`}</Text>
            <Text variant="secondary">{caso.provider_name}</Text>
            <Text variant="caption" color={colors.textMuted}>
              {`${momentoLegible(caso.starts_at)} · ${f(claveDelEstadoDeLaReserva(caso.booking_status))}`}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {f('servicios.atencion.admin.resoluciones', { n: caso.resolutions })}
            </Text>
          </View>

          <ExpedienteDelCaso caso={caso} ocupado={ocupado} alVer={verEvidencia} />

          <View style={tarjeta}>
            <Text weight="700">{f('servicios.atencion.admin.escribir')}</Text>
            <View style={styles.fila} accessibilityRole="radiogroup">
              <Chip
                rol="radio"
                label={f('servicios.atencion.admin.aLasPartes')}
                selected={!interna}
                disabled={!vivo}
                onPress={() => setInterna(false)}
              />
              <Chip
                rol="radio"
                label={f('servicios.atencion.admin.notaInterna')}
                selected={interna || !vivo}
                onPress={() => setInterna(true)}
              />
            </View>
            <Text variant="caption" color={colors.textMuted}>
              {f(interna || !vivo ? 'servicios.atencion.admin.notaInternaAyuda' : 'servicios.atencion.admin.aLasPartesAyuda')}
            </Text>
            <Input
              label={f('servicios.atencion.caso.mensaje')}
              value={mensaje}
              onChangeText={setMensaje}
              maxLength={LARGOS_DE_LA_ATENCION.entrada}
              multiline
            />
            <Button
              label={f('servicios.atencion.admin.guardarEntrada')}
              variant="secondary"
              loading={ocupado}
              disabled={ocupado || !mensaje.trim() || (!vivo && !interna)}
              onPress={anotar}
            />
          </View>

          {vivo && !resuelve ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('servicios.atencion.admin.otraPersona')}
            </Text>
          ) : null}
          {resuelve ? (
            <View style={[styles.tarjeta, { borderColor: colors.primary }]}>
              <Text weight="700">
                {f(caso.status === 'appealed' ? 'servicios.atencion.admin.resolverApelacion' : 'servicios.atencion.admin.resolver')}
              </Text>
              {caso.status === 'appealed' ? (
                <Text variant="caption" color={colors.textMuted}>
                  {f('servicios.atencion.admin.otraPersona')}
                </Text>
              ) : null}

              <Text weight="600">{f('servicios.atencion.admin.queSeDecide')}</Text>
              <View style={styles.fila} accessibilityRole="radiogroup">
                {RESULTADOS_DEL_CASO.map((r) => (
                  <Chip
                    key={r}
                    rol="radio"
                    label={f(claveDelResultado(r))}
                    selected={resolucion.resultado === r}
                    onPress={() => setResolucion((ya) => ({ ...ya, resultado: r }))}
                  />
                ))}
              </View>

              <Text weight="600">{f('servicios.atencion.admin.efectoEnLaAtencion')}</Text>
              <View style={styles.fila} accessibilityRole="radiogroup">
                {efectos.map((e) => (
                  <Chip
                    key={e}
                    rol="radio"
                    label={f(claveDelEfectoEnLaAtencion(e))}
                    selected={resolucion.efectoEnLaAtencion === e}
                    onPress={() => setResolucion((ya) => ({ ...ya, efectoEnLaAtencion: e }))}
                  />
                ))}
              </View>

              <Text variant="caption" color={colors.textMuted}>
                {f(efectos.length < 4 ? 'servicios.atencion.admin.atencionCerrada' : 'servicios.atencion.admin.efectoDefinitivo')}
              </Text>

              <Text weight="600">{f('servicios.atencion.admin.efectoEconomico')}</Text>
              <View style={styles.fila} accessibilityRole="radiogroup">
                {EFECTOS_ECONOMICOS.map((e) => (
                  <Chip
                    key={e}
                    rol="radio"
                    label={f(claveDelEfectoEconomico(e))}
                    selected={resolucion.efectoEconomico === e}
                    onPress={() => setResolucion((ya) => ({ ...ya, efectoEconomico: e }))}
                  />
                ))}
              </View>
              <Text variant="caption" color={colors.textMuted}>
                {f('servicios.atencion.admin.efectoEconomicoAyuda')}
              </Text>

              <Input
                label={f('servicios.atencion.admin.resolucion')}
                placeholder={f('servicios.atencion.admin.resolucionAyuda')}
                value={resolucion.texto}
                onChangeText={(texto) => setResolucion((ya) => ({ ...ya, texto }))}
                maxLength={LARGOS_DE_LA_ATENCION.entrada}
                multiline
              />
              <Input
                label={f('servicios.atencion.admin.notaInterna')}
                value={resolucion.notaInterna}
                onChangeText={(notaInterna) => setResolucion((ya) => ({ ...ya, notaInterna }))}
                maxLength={LARGOS_DE_LA_ATENCION.entrada}
                multiline
              />
              <Button
                label={f('servicios.atencion.admin.resolver')}
                icon="check"
                loading={ocupado}
                disabled={ocupado || resolucion.resultado === null || !resolucion.texto.trim()}
                onPress={resolver}
              />
            </View>
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
