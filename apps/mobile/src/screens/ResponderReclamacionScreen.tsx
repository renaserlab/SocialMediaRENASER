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
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  RESOLUCIONES,
  claveDeErrorDeIncidencias,
  claveDeLaResolucion,
  claveDelEstadoDeIncidencia,
  claveDelMotivo,
  claveDelPlazo,
  esIncidenciaApagada,
  historialPintable,
  horasQueLeQuedan,
  iconoDelEstadoDeIncidencia,
  type Incidencia,
} from '@/lib/incidencias';
import {
  claveDeErrorDeProductos,
  claveDeErrorPorEstado,
  esFaltaDeSesion,
} from '@/lib/productos';
import { ProductIncidentSellerRepository } from '@/repositories/ProductIncidentRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Responder a una reclamación de mi tienda. PROPONER NO ES RESOLVER.
 *
 * NO HAY BOTÓN DE RESOLVER Y NO PUEDE HABERLO. Las cinco salidas mueven dinero,
 * mueven mercancía o niegan la reclamación, y ninguna de las tres la decide en
 * solitario quien tiene el conflicto. Lo que se manda desde aquí es una
 * PROPUESTA; la decisión la registra Z. En el servidor tampoco existe la ruta:
 * hay una prueba que comprueba que ninguna de proveedor termina en `/resolve`.
 *
 * PEDIR MÁS PRUEBAS ES OTRO PASO, y no una de las salidas: un expediente al que
 * se le piden más pruebas no está resuelto, y contarlo como resuelto daría un
 * número falso. Además PARA EL RELOJ: no se le puede contar a quien vende el
 * tiempo que pasa esperando lo que él mismo pidió.
 *
 * LO QUE ESTA PANTALLA NO ENSEÑA:
 *
 *   * NADA DE QUIEN COMPRÓ más allá de lo que contó y las fotografías que
 *     colgó. Ni nombre, ni dirección, ni teléfono: la dirección se ve al
 *     preparar el paquete, que es donde hace falta, y no aquí.
 *   * NINGÚN IMPORTE. Ni el del pedido ni el de un reembolso: proponer
 *     «reembolsar en parte» no lleva cifra en esta versión.
 *   * NINGÚN PLAZO DE LA DECISIÓN DE Z.
 */
export function ResponderReclamacionScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();
  const { incidentId: bruto } = useLocalSearchParams<{ incidentId?: string }>();
  const casoId = typeof bruto === 'string' ? bruto : '';

  const [caso, setCaso] = useState<Incidencia | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinSesion' | 'noEncontrado' | 'noDisponible' | null
  >(null);

  const [propuesta, setPropuesta] = useState<string | null>(null);
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
      setCaso(await ProductIncidentSellerRepository.leer(casoId));
    } catch (e) {
      if (e instanceof ApiError && esFaltaDeSesion(e.status)) setFallo('sinSesion');
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

  /** El doble toque bloqueado con una referencia, no con el estado. */
  const mandar = async (
    operacion: () => Promise<Incidencia>,
    despues?: () => void,
  ) => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    setError(null);
    try {
      setCaso(await operacion());
      despues?.();
    } catch (e) {
      setError(textoDelError(e));
      if (e instanceof ApiError && e.status === 409) void cargar();
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const proponer = () => {
    if (propuesta === null) return;
    void mandar(
      () =>
        ProductIncidentSellerRepository.proponer(casoId, {
          proposal: propuesta,
          note: nota,
        }),
      () => {
        setPropuesta(null);
        setNota('');
      },
    );
  };

  /** Pedir pruebas SÍ lleva motivo: sin decir cuáles, nadie sabe qué mandar. */
  const pedirPruebas = () => {
    const limpia = nota.trim();
    if (limpia.length < 3) {
      setError(f('incidencia.error.faltaNota'));
      return;
    }
    void mandar(
      () => ProductIncidentSellerRepository.pedirMasEvidencia(casoId, limpia),
      () => setNota(''),
    );
  };

  const volver = () =>
    router.canGoBack()
      ? router.back()
      : router.replace('/proveedor/reclamaciones' as never);

  const encabezado = (
    <AppHeader title={f('incidencia.proveedor.detalleTitulo')} onBack={volver} />
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
            title={f('carrito.error.sinSesion')}
            description={f('carrito.error.sinSesionCuerpo')}
          />
        ) : fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon="clock"
            title={f('incidencia.error.noDisponible')}
            description={f('incidencia.falta.migration_0080')}
          />
        ) : fallo === 'noEncontrado' ? (
          /* 404 TAMBIÉN PARA LA AJENA: distinguirla contaría que existe una
             disputa sobre un pedido que no es de esta tienda. */
          <StateView
            state="empty"
            icon="alert-circle"
            title={f('incidencia.error.noEncontrado')}
            description={f('incidencia.proveedor.noEncontradoCuerpo')}
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
  const horas = horasQueLeQuedan(caso.seller_response_due_at);
  const pasos = historialPintable(caso.history);
  /* QUÉ PUEDO HACER LO DICE EL SERVIDOR. `SELLER_RESPONDED` en la lista
     significa que la pelota es mía; si no está, no se pinta el formulario. */
  const meToca = caso.available_transitions.includes('SELLER_RESPONDED');
  const puedoPedirPruebas =
    caso.available_transitions.includes('MORE_EVIDENCE_REQUESTED');

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

        {caso.seller_response_due_at !== null ? (
          <Text variant="caption" color="muted">
            {f(claveDelPlazo(caso.seller_response_due_at), {
              n: Math.max(0, horas ?? 0),
            })}
          </Text>
        ) : null}

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

        {/* YA PROPUSE ALGO: se enseña, y se dice que ahora decide Z. */}
        {caso.seller_proposal !== null
          ? bloque(
              f('incidencia.detalle.propuesta'),
              <>
                <Text>{f(claveDeLaResolucion(caso.seller_proposal))}</Text>
                <Text variant="caption" color="muted">
                  {f('incidencia.proveedor.yaRespondiste')}
                </Text>
              </>,
            )
          : null}

        {/* LA DECISIÓN, SI YA LA HAY. Y que nadie la ha ejecutado. */}
        {caso.resolution !== null
          ? bloque(
              f('incidencia.detalle.decision'),
              <>
                <Text>{f(claveDeLaResolucion(caso.resolution))}</Text>
                <Text variant="caption" color="muted">
                  {f('incidencia.resolverNoEsPagar')}
                </Text>
              </>,
            )
          : null}

        {meToca
          ? bloque(
              f('incidencia.proveedor.tuTurno'),
              <>
                <Text variant="caption" color="muted">
                  {f('incidencia.proveedor.proponerNoEsResolver')}
                </Text>
                <Text variant="titleMedium" style={styles.subtitulo}>
                  {f('incidencia.proveedor.queProponer')}
                </Text>
                <View
                  accessibilityRole="radiogroup"
                  accessibilityLabel={f('incidencia.proveedor.queProponer')}
                >
                  {RESOLUCIONES.map((salida) => {
                    const elegida = salida === propuesta;
                    return (
                      <Pressable
                        key={salida}
                        onPress={() => setPropuesta(salida)}
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
                        {/* EL ICONO ACOMPAÑA AL TEXTO: el color nunca es el
                            único portador de «esta es la elegida». */}
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
                <Input
                  value={nota}
                  onChangeText={setNota}
                  multiline
                  numberOfLines={3}
                  maxLength={1000}
                  accessibilityLabel={f('incidencia.proveedor.notaOpcional')}
                  placeholder={f('incidencia.proveedor.notaOpcional')}
                  style={styles.area}
                />
                <Button
                  label={f('incidencia.proveedor.proponer')}
                  onPress={proponer}
                  disabled={propuesta === null || ocupado}
                  loading={ocupado}
                />
              </>,
            )
          : null}

        {puedoPedirPruebas
          ? bloque(
              f('incidencia.proveedor.pedirTitulo'),
              <>
                <Text variant="caption" color="muted">
                  {f('incidencia.proveedor.pedirCuerpo')}
                </Text>
                <Input
                  value={nota}
                  onChangeText={setNota}
                  multiline
                  numberOfLines={3}
                  maxLength={1000}
                  accessibilityLabel={f('incidencia.proveedor.pedirQue')}
                  placeholder={f('incidencia.proveedor.pedirQue')}
                  style={styles.area}
                />
                <Button
                  label={f('incidencia.proveedor.pedir')}
                  variant="secondary"
                  onPress={pedirPruebas}
                  disabled={ocupado}
                  loading={ocupado}
                />
              </>,
            )
          : null}

        {/* EL ERROR VA EN LA PANTALLA: hay formularios abiertos y en iOS un
            diálogo encima de ellos no se ve. */}
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

        <Text variant="caption" color="muted">
          {f('incidencia.nadaVuelveAlAlmacen')}
        </Text>
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
  subtitulo: { marginTop: spacing.xs },
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
