import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  RESOLUCIONES,
  claveDeErrorDeIncidencias,
  claveDeLaResolucion,
  claveDelEstadoDeIncidencia,
  claveDelMotivo,
  esIncidenciaApagada,
  historialPintable,
  iconoDelEstadoDeIncidencia,
  esperaRegistrarLaReposicion,
  quedaAlgoPendiente,
  type Incidencia,
} from '@/lib/incidencias';
import {
  claveDeErrorDeProductos,
  claveDeErrorPorEstado,
  esFaltaDeSesion,
} from '@/lib/productos';
import { ProductIncidentAdminRepository } from '@/repositories/ProductIncidentRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Decidir una reclamación. REGISTRAR LA DECISIÓN NO ES EJECUTARLA.
 *
 * LO QUE ESTE BOTÓN HACE, EXACTAMENTE: escribe en el expediente qué se acordó y
 * deja el efecto financiero PENDIENTE. NO devuelve dinero, NO repone unidades y
 * NO toca el almacén. Nadie ejecuta nada en esta versión, y la pantalla lo dice
 * antes y después de pulsar. Prometerlo aquí sería prometerlo en el único sitio
 * donde alguien está esperando su dinero.
 *
 * PEDIR MÁS PRUEBAS NO SALE EN ESTA LISTA, y no es un olvido: es un paso del
 * caso, no un desenlace. El servidor rechaza esa «resolución» con su propio
 * código, y contarla como resuelta daría un número falso de casos cerrados.
 *
 * LA EXPLICACIÓN ES OBLIGATORIA. La leen quien reclama y quien vende, y sin el
 * porqué el expediente no se puede revisar después. No se rellena con nada.
 *
 * SOLO `admin`, NO `is_admin`: moderación no decide sobre dinero ni mercancía.
 */
export function DecidirReclamacionScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();
  const { incidentId: bruto } = useLocalSearchParams<{ incidentId?: string }>();
  const casoId = typeof bruto === 'string' ? bruto : '';

  const [caso, setCaso] = useState<Incidencia | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    | 'red'
    | 'sinConexion'
    | 'sinSesion'
    | 'noEncontrado'
    | 'noDisponible'
    | 'sinPermiso'
    | null
  >(null);

  const [decision, setDecision] = useState<string | null>(null);
  const [nota, setNota] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const cargar = useCallback(async () => {
    if (casoId === '') {
      setFallo('noEncontrado');
      setCargando(false);
      return;
    }
    setCargando(true);
    setFallo(null);
    try {
      setCaso(await ProductIncidentAdminRepository.leer(casoId));
    } catch (e) {
      if (e instanceof ApiError && esFaltaDeSesion(e.status)) setFallo('sinSesion');
      else if (e instanceof ApiError && e.status === 403) setFallo('sinPermiso');
      else if (e instanceof ApiError && esIncidenciaApagada(e.code))
        setFallo('noDisponible');
      else if (e instanceof ApiError && e.status === 404) setFallo('noEncontrado');
      else if (e instanceof ApiError && esFalloDeRed(e.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, [casoId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const textoDelError = (e: unknown) => {
    if (e instanceof ApiError) {
      const deCasos = claveDeErrorDeIncidencias(e.code);
      if (deCasos !== null) return f(deCasos);
      const deProductos = claveDeErrorDeProductos(e.code);
      if (deProductos !== null) return f(deProductos);
      const porEstado = claveDeErrorPorEstado(e.status);
      if (porEstado !== null) return f(porEstado);
    }
    return e instanceof Error && e.message.trim() !== '' ? e.message : t('common.tryAgain');
  };

  /**
   * Registra la decisión. SE PREGUNTA ANTES, y se dice qué implica.
   *
   * Es un diálogo y no un aviso en la pantalla porque esto no se deshace: el
   * expediente no se reescribe, lo impide un disparador de la base.
   */
  const resolver = async () => {
    if (ocupadoRef.current || decision === null) return;
    const limpia = nota.trim();
    if (limpia.length < 3) {
      setError(f('incidencia.error.faltaNota'));
      return;
    }
    const seguro = await confirm({
      title: f('incidencia.admin.confirmar'),
      message: f('incidencia.admin.confirmarCuerpo'),
      confirmLabel: f('incidencia.admin.resolver'),
      cancelLabel: t('common.cancel'),
    });
    if (!seguro) return;

    ocupadoRef.current = true;
    setOcupado(true);
    setError(null);
    try {
      setCaso(
        await ProductIncidentAdminRepository.resolver(casoId, {
          resolution: decision,
          note: limpia,
        }),
      );
      setDecision(null);
      setNota('');
    } catch (e) {
      setError(textoDelError(e));
      if (e instanceof ApiError && e.status === 409) void cargar();
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  /**
   * Registra que la unidad de repuesto llegó. NO MUEVE UN CÉNTIMO.
   *
   * POR QUÉ ESTE BOTÓN EXISTE. Un caso resuelto retiene el dinero de esa venta
   * mientras su efecto no esté saldado, y lo único que lo saldaba era confirmar
   * una devolución de DINERO. Una reposición nunca tiene una: sin esto, quien
   * vende manda la unidad nueva, quien compró la recibe, y ese dinero no sale
   * de la cola nunca.
   *
   * SE PREGUNTA ANTES, como al resolver, y por lo mismo: el expediente no se
   * reescribe, lo impide un disparador de la base.
   */
  const registrarLaReposicion = async () => {
    if (ocupadoRef.current) return;
    const limpia = nota.trim();
    if (limpia.length < 3) {
      setError(f('incidencia.error.faltaNota'));
      return;
    }
    const seguro = await confirm({
      title: f('incidencia.admin.reposicionTitulo'),
      message: f('incidencia.admin.reposicionConfirmar'),
      confirmLabel: f('incidencia.admin.reposicionBoton'),
      cancelLabel: t('common.cancel'),
    });
    if (!seguro) return;

    ocupadoRef.current = true;
    setOcupado(true);
    setError(null);
    try {
      setCaso(
        await ProductIncidentAdminRepository.reposicionEntregada(casoId, limpia),
      );
      setNota('');
    } catch (e) {
      setError(textoDelError(e));
      if (e instanceof ApiError && e.status === 409) void cargar();
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const volver = () =>
    router.canGoBack()
      ? router.back()
      : router.replace('/admin/productos/reclamaciones' as never);

  const encabezado = (
    <AppHeader title={f('incidencia.admin.detalleTitulo')} onBack={volver} />
  );

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || caso === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        {fallo === 'sinSesion' ? (
          <StateView
            state="empty"
            icon="lock"
            title={f('sesion.entraParaVerlo')}
            description={f('sesion.entraParaVerloCuerpo')}
          />
        ) : fallo === 'sinPermiso' ? (
          <StateView
            state="empty"
            icon="shield"
            title={f('incidencia.admin.sinPermiso')}
            description={f('incidencia.admin.sinPermisoCuerpo')}
          />
        ) : fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon="clock"
            title={f('incidencia.error.noDisponible')}
            description={f('incidencia.falta.migration_0080')}
          />
        ) : fallo === 'noEncontrado' ? (
          <StateView
            state="empty"
            icon="alert-circle"
            title={f('incidencia.error.noEncontrado')}
            description={f('incidencia.detalle.noEncontradoCuerpo')}
          />
        ) : (
          <StateView
            state={fallo === 'sinConexion' ? 'offline' : 'error'}
            description={fallo === 'sinConexion' ? undefined : t('common.loadFailed')}
            onRetry={() => void cargar()}
          />
        )}
      </AppScreen>
    );
  }

  const icono = iconoDelEstadoDeIncidencia(caso.status);
  const pasos = historialPintable(caso.history);
  /* SE PINTA LO QUE EL SERVIDOR OFRECE. Si `RESOLVED` no está en la lista, este
     caso no está en manos de Z ahora mismo y el formulario no sale. */
  const puedoDecidir = caso.available_transitions.includes('RESOLVED');

  const bloque = (titulo: string, hijos: React.ReactNode) => (
    <View style={[styles.tarjeta, { borderColor: colors.border }]}>
      <Text variant="titleMedium" style={styles.tarjetaTitulo}>
        {titulo}
      </Text>
      {hijos}
    </View>
  );

  return (
    <AppScreen contentStyle={styles.contenido}>
      {encabezado}
      <ScrollView
        contentContainerStyle={styles.cuerpo}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.estado, { backgroundColor: colors.surfaceAlt }]}>
          {icono !== null ? (
            <Feather name={icono as never} size={20} color={colors.text} />
          ) : null}
          <View style={styles.estadoTexto}>
            <Text variant="titleMedium">
              {f(claveDelEstadoDeIncidencia(caso.status))}
            </Text>
            <Text variant="caption" color="muted">
              {f(claveDelMotivo(caso.reason))}
            </Text>
          </View>
        </View>

        {bloque(
          f('incidencia.proveedor.loQueDice'),
          <Text>{caso.description}</Text>,
        )}

        {caso.evidence.length > 0
          ? bloque(
              f('incidencia.detalle.pruebas'),
              <View style={styles.galeria}>
                {caso.evidence.map((prueba) =>
                  prueba.url !== null ? (
                    <Image
                      key={prueba.id}
                      source={{ uri: prueba.url }}
                      style={styles.miniatura}
                      contentFit="cover"
                      accessibilityLabel={f('incidencia.detalle.pruebas')}
                    />
                  ) : (
                    <View
                      key={prueba.id}
                      style={[
                        styles.miniatura,
                        styles.sinFoto,
                        { borderColor: colors.border },
                      ]}
                    >
                      <Feather name="image" size={18} color={colors.textMuted} />
                    </View>
                  ),
                )}
              </View>,
            )
          : null}

        {caso.seller_proposal !== null
          ? bloque(
              f('incidencia.detalle.propuesta'),
              <>
                <Text>{f(claveDeLaResolucion(caso.seller_proposal))}</Text>
                <Text variant="caption" color="muted">
                  {f('incidencia.detalle.propuestaNoEsDecision')}
                </Text>
              </>,
            )
          : null}

        {caso.resolution !== null
          ? bloque(
              f('incidencia.detalle.decision'),
              <>
                <Text>{f(claveDeLaResolucion(caso.resolution))}</Text>
                <Text variant="caption" color="muted">
                  {f('incidencia.resolverNoEsPagar')}
                </Text>
                {quedaAlgoPendiente(caso) ? (
                  <Text variant="caption" color="muted">
                    {f('incidencia.detalle.efectoPendiente')}
                  </Text>
                ) : null}
              </>,
            )
          : null}

        {/* LO QUE FALTABA PARA QUE EL DINERO NO SE QUEDE ATRAPADO. Solo sale
            con la reposición: las tres resoluciones de dinero se saldan
            devolviendo de verdad, y aceptarlas aquí dejaría desbloquear el
            cobro de un reembolso que nadie hizo. */}
        {esperaRegistrarLaReposicion(caso)
          ? bloque(
              f('incidencia.admin.reposicionTitulo'),
              <>
                <Text variant="caption" color="muted">
                  {f('incidencia.admin.reposicionCuerpo')}
                </Text>
                <Input
                  label={f('incidencia.admin.reposicionMotivo')}
                  value={nota}
                  onChangeText={setNota}
                  multiline
                  editable={!ocupado}
                />
                {error !== null ? <InlineError message={error} /> : null}
                <Button
                  label={f('incidencia.admin.reposicionBoton')}
                  onPress={() => void registrarLaReposicion()}
                  loading={ocupado}
                  disabled={ocupado || nota.trim().length < 3}
                />
              </>,
            )
          : null}

        {puedoDecidir
          ? bloque(
              f('incidencia.admin.queDecidir'),
              <>
                {/* LO QUE ESTE BOTÓN NO HACE, ANTES DE PULSARLO. */}
                <Text variant="caption" color="muted">
                  {f('incidencia.resolverNoEsPagar')}
                </Text>
                <Text variant="caption" color="muted">
                  {f('incidencia.nadaVuelveAlAlmacen')}
                </Text>
                <View
                  accessibilityRole="radiogroup"
                  accessibilityLabel={f('incidencia.admin.queDecidir')}
                >
                  {RESOLUCIONES.map((salida) => {
                    const elegida = salida === decision;
                    return (
                      <Pressable
                        key={salida}
                        onPress={() => setDecision(salida)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: elegida }}
                        accessibilityLabel={f(claveDeLaResolucion(salida))}
                        style={[
                          styles.opcion,
                          {
                            borderColor: elegida ? colors.primary : colors.border,
                            backgroundColor: elegida
                              ? colors.surfaceAlt
                              : 'transparent',
                          },
                        ]}
                      >
                        <Feather
                          name={elegida ? 'check-circle' : 'circle'}
                          size={18}
                          color={elegida ? colors.primary : colors.textMuted}
                        />
                        <Text style={styles.opcionTexto}>
                          {f(claveDeLaResolucion(salida))}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text variant="caption" color="muted">
                  {f('incidencia.admin.motivoObligatorio')}
                </Text>
                <Input
                  value={nota}
                  onChangeText={setNota}
                  multiline
                  numberOfLines={3}
                  maxLength={1000}
                  accessibilityLabel={f('incidencia.detalle.nota')}
                  placeholder={f('incidencia.detalle.nota')}
                  style={styles.area}
                />
                <Button
                  label={f('incidencia.admin.resolver')}
                  onPress={() => void resolver()}
                  disabled={decision === null || ocupado}
                  loading={ocupado}
                />
              </>,
            )
          : null}

        {error !== null ? <InlineError message={error} /> : null}

        {bloque(
          f('incidencia.detalle.historial'),
          <>
            {pasos.map((paso, i) => (
              <View key={`${paso.fecha}-${i}`} style={styles.paso}>
                {paso.icono !== null ? (
                  <Feather
                    name={paso.icono as never}
                    size={16}
                    color={colors.textMuted}
                  />
                ) : null}
                <View style={styles.pasoTexto}>
                  <Text variant="caption">{f(paso.clave)}</Text>
                  {paso.nota !== null ? (
                    <Text variant="caption" color="muted">
                      {paso.nota}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
          </>,
        )}
      </ScrollView>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { paddingHorizontal: 0 },
  cuerpo: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl },
  estado: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  estadoTexto: { flex: 1 },
  tarjeta: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  tarjetaTitulo: { marginBottom: spacing.xs },
  galeria: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  miniatura: { width: 88, height: 88, borderRadius: radius.sm },
  sinFoto: { borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  opcion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.xs,
    // 44 de alto: el área táctil mínima.
    minHeight: 44,
  },
  opcionTexto: { flex: 1 },
  area: { minHeight: 80, textAlignVertical: 'top' },
  paso: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  pasoTexto: { flex: 1 },
});
