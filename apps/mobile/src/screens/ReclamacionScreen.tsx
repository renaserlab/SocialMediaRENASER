import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
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
import {
  PermisoNegado,
  elegirEnNativo,
  elegirEnWeb,
} from '@/lib/elegirImagen';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { MAXIMO_BYTES, TIPOS_ADMITIDOS } from '@/lib/fotosDeProducto';
import {
  FOTOS_MAXIMAS,
  HORAS_PARA_APELAR,
  HORAS_PARA_RESPONDER,
  cabenMasFotos,
  claveDeErrorDeIncidencias,
  claveDeLaResolucion,
  claveDelEstadoDeIncidencia,
  claveDelMotivo,
  claveDelPlazo,
  claveDelRechazo,
  esIncidenciaApagada,
  fotosQueFaltan,
  historialPintable,
  horasQueLeQuedan,
  iconoDelEstadoDeIncidencia,
  porQueNoSePuedeAdjuntar,
  quedaAlgoPendiente,
  sePuedeApelar,
  sePuedeAportarEvidencia,
  sePuedeEnviar,
  sePuedeEscalar,
  sePuedeRetirar,
  type Incidencia,
} from '@/lib/incidencias';
import {
  claveDeErrorDeProductos,
  claveDeErrorPorEstado,
  esFaltaDeSesion,
} from '@/lib/productos';
import { ProductIncidentRepository } from '@/repositories/ProductIncidentRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * El expediente, para quien reclama: qué contó, qué colgó y en qué va.
 *
 * ABRIR NO ES APROBAR Y RESOLVER NO ES PAGAR, y las dos frases están escritas
 * en la pantalla, no solo aquí. Esta es la pantalla donde alguien espera dinero
 * de vuelta: cualquier texto ambiguo se lee como una promesa de reembolso.
 *
 * LO QUE ESTA PANTALLA NO ENSEÑA, Y ES DELIBERADO:
 *
 *   * NINGÚN IMPORTE. Ni cuánto se devuelve ni cuánto se pagó: la decisión de
 *     esta versión dice QUÉ se acordó, no CUÁNTO, y no hay ningún campo con un
 *     número en todo el contrato del servidor.
 *   * NINGUNA FECHA DE LA DECISIÓN DE Z. «Tres días hábiles» exige un
 *     calendario de festivos que nadie definió: se dice «en revisión».
 *   * NINGÚN «YA SE TE DEVOLVIÓ». Con la decisión delante, lo que hay es un
 *     efecto PENDIENTE: nadie lo ha ejecutado, y decirlo es lo honesto.
 *   * NINGÚN BOTÓN DE BORRAR UNA PRUEBA. Retirarla después de que la otra parte
 *     la haya visto es reescribir lo que se discutió, y lo impide además un
 *     disparador de la base.
 *
 * QUÉ BOTONES SE PINTAN, Y NINGUNO SE DEDUCE. Qué salto es legal lo dice el
 * servidor en `available_transitions`; aquí solo se pintan los que esa lista
 * ofrece. Si esta pantalla decidiera, bastaría una versión vieja instalada en
 * un teléfono para intentar apelar dos veces.
 *
 * LOS ERRORES VAN EN LA PROPIA PANTALLA, no en un diálogo: hay formularios
 * delante —la nota de cada paso— y un diálogo encima de ellos en iOS no se ve.
 * Lo que sí es un diálogo es retirar la reclamación, porque eso no se deshace.
 */
export function ReclamacionScreen() {
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
      setCaso(await ProductIncidentRepository.leer(casoId));
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
      //: SE RECARGA TRAS UN CONFLICTO: el servidor sabe algo que esta pantalla
      //: no, y puede que el caso haya cambiado de manos mientras tanto.
      if (e instanceof ApiError && e.status === 409) void cargar();
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  /** Los pasos que llevan explicación. La nota no se rellena con nada. */
  const conNota = async (operacion: (texto: string) => Promise<Incidencia>) => {
    const limpia = nota.trim();
    if (limpia.length < 3) {
      setError(f('incidencia.error.faltaNota'));
      return;
    }
    await mandar(operacion.bind(null, limpia), () => setNota(''));
  };

  /**
   * Cuelga una fotografía.
   *
   * SE MIRA LO BARATO ANTES DE SUBIR —tipo y tamaño— para no gastar una subida
   * entera en algo que va a fallar. Quien decide de verdad es el servidor, que
   * abre la imagen: una cabecera de JPEG se pega delante de cualquier cosa.
   */
  const anadirFoto = async () => {
    if (ocupadoRef.current) return;
    setError(null);
    let elegido;
    try {
      elegido = Platform.OS === 'web' ? await elegirEnWeb() : await elegirEnNativo();
    } catch (e) {
      if (e instanceof PermisoNegado) {
        setError(f('fotos.permisoNegado'));
        return;
      }
      throw e;
    }
    if (elegido === null) return;

    const rechazo = porQueNoSePuedeAdjuntar({
      tipo: elegido.tipo,
      bytes: elegido.bytes,
      yaHay: caso?.evidence.length ?? 0,
      maximoBytes: MAXIMO_BYTES,
      tiposAdmitidos: TIPOS_ADMITIDOS,
    });
    if (rechazo !== null) {
      setError(f(claveDelRechazo(rechazo)));
      return;
    }
    await mandar(() =>
      ProductIncidentRepository.anadirPrueba(casoId, {
        archivo: elegido.archivo,
        nombre: elegido.nombre,
      }),
    );
  };

  /** Retirar no se deshace: se pregunta, y se dice qué implica. */
  const retirar = async () => {
    const limpia = nota.trim();
    if (limpia.length < 3) {
      setError(f('incidencia.error.faltaNota'));
      return;
    }
    const seguro = await confirm({
      title: f('incidencia.detalle.retirarConfirmar'),
      message: f('incidencia.detalle.retirarConfirmarCuerpo'),
      confirmLabel: f('incidencia.detalle.retirar'),
      cancelLabel: t('common.cancel'),
    });
    if (!seguro) return;
    await mandar(
      () => ProductIncidentRepository.retirar(casoId, limpia),
      () => setNota(''),
    );
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/productos/pedidos' as never);

  const encabezado = (
    <AppHeader title={f('incidencia.detalle.titulo')} onBack={volver} />
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
          /* 404 TAMBIÉN PARA EL AJENO. La pantalla no distingue los dos casos
             porque el servidor tampoco: distinguirlos contaría que alguien
             abrió una disputa sobre ese pedido. */
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
  const faltan = fotosQueFaltan(caso);
  const horas = horasQueLeQuedan(caso.seller_response_due_at);
  const pasos = historialPintable(caso.history);

  /** Una tarjeta con título y cuerpo. La usa cada bloque de la pantalla. */
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
        {/* EL ESTADO, CON ICONO Y TEXTO. El color no es el único portador. */}
        <View style={[styles.estado, { backgroundColor: colors.surfaceAlt }]}>
          {icono !== null ? (
            <Feather name={icono as never} size={20} color={colors.text} />
          ) : null}
          <View style={styles.estadoTexto}>
            <Text variant="titleMedium">{f(claveDelEstadoDeIncidencia(caso.status))}</Text>
            <Text variant="caption" color="muted">
              {f(claveDelMotivo(caso.reason))}
            </Text>
          </View>
        </View>

        {/* EL PLAZO DEL PROVEEDOR, DICHO COMO UN HECHO. Nunca «incumplió». */}
        {caso.status === 'OPEN' || caso.seller_response_due_at !== null ? (
          <Text variant="caption" color="muted">
            {f(claveDelPlazo(caso.seller_response_due_at), { n: Math.max(0, horas ?? 0) })}
          </Text>
        ) : null}

        {/* EN MANOS DE Z: SIN FECHA, y se dice por qué no la hay. */}
        {caso.status === 'MEDIATION' || caso.status === 'APPEALED' ? (
          <Text variant="caption" color="muted">
            {f('incidencia.sinPlazoDeDecision')}
          </Text>
        ) : null}

        {bloque(
          f('incidencia.detalle.loQueContaste'),
          <Text>{caso.description}</Text>,
        )}

        {bloque(
          f('incidencia.detalle.pruebas'),
          <>
            <Text variant="caption" color="muted">
              {f('incidencia.detalle.pruebasCuantas', {
                n: caso.evidence.length,
                max: FOTOS_MAXIMAS,
              })}
            </Text>
            {caso.evidence.length > 0 ? (
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
                    /* LA URL SE FIRMA AL PINTAR: si el almacenamiento no
                       contesta, el expediente se abre igual. La prueba sigue
                       guardada, y eso es lo que se dice. */
                    <View
                      key={prueba.id}
                      style={[styles.miniatura, styles.sinFoto, { borderColor: colors.border }]}
                    >
                      <Feather name="image" size={18} color={colors.textMuted} />
                    </View>
                  ),
                )}
              </View>
            ) : null}
            {caso.evidence.some((p) => p.url === null) ? (
              <Text variant="caption" color="muted">
                {f('incidencia.detalle.fotoSinVistaPrevia')}
              </Text>
            ) : null}
            {faltan > 0 ? (
              <Text variant="caption" color="muted">
                {f('incidencia.detalle.faltanFotos', { n: faltan })}
              </Text>
            ) : null}
            {cabenMasFotos(caso) ? (
              <>
                <Button
                  label={f('incidencia.detalle.anadirFoto')}
                  variant="secondary"
                  onPress={() => void anadirFoto()}
                  disabled={ocupado}
                />
                <Text variant="caption" color="muted">
                  {f('incidencia.detalle.fotoNoSeQuita')}
                </Text>
              </>
            ) : null}
          </>,
        )}

        {/* ENVIAR: aquí es donde el proveedor se entera y arranca su plazo. */}
        {caso.status === 'OPEN' && caso.seller_response_due_at === null
          ? bloque(
              f('incidencia.detalle.sinEnviar'),
              <>
                <Text variant="caption" color="muted">
                  {f('incidencia.detalle.enviarCuerpo', { n: HORAS_PARA_RESPONDER })}
                </Text>
                <Button
                  label={f('incidencia.detalle.enviar')}
                  onPress={() => void mandar(() => ProductIncidentRepository.enviar(casoId))}
                  disabled={!sePuedeEnviar(caso) || ocupado}
                  loading={ocupado}
                />
              </>,
            )
          : null}

        {/* LA PROPUESTA DEL PROVEEDOR NO ES LA DECISIÓN, y se dice así. */}
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

        {/* LA DECISIÓN REGISTRADA. Y QUE NADIE LA HA EJECUTADO. */}
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

        {/* LO QUE PUEDO HACER AHORA. Lo dice el servidor, no esta pantalla. */}
        {sePuedeAportarEvidencia(caso)
          ? bloque(
              f('incidencia.detalle.aportarTitulo'),
              <>
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
                  label={f('incidencia.detalle.aportar')}
                  onPress={() =>
                    void conNota((texto) =>
                      ProductIncidentRepository.responder(casoId, texto),
                    )
                  }
                  disabled={ocupado}
                  loading={ocupado}
                />
              </>,
            )
          : null}

        {sePuedeEscalar(caso)
          ? bloque(
              f('incidencia.detalle.escalarTitulo'),
              <>
                <Text variant="caption" color="muted">
                  {f('incidencia.sinPlazoDeDecision')}
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
                  label={f('incidencia.detalle.escalar')}
                  onPress={() =>
                    void conNota((texto) =>
                      ProductIncidentRepository.escalar(casoId, texto),
                    )
                  }
                  disabled={ocupado}
                  loading={ocupado}
                />
              </>,
            )
          : null}

        {sePuedeApelar(caso)
          ? bloque(
              f('incidencia.detalle.apelarTitulo'),
              <>
                <Text variant="caption" color="muted">
                  {f('incidencia.detalle.apelarCuerpo', { n: HORAS_PARA_APELAR })}
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
                  label={f('incidencia.detalle.apelar')}
                  onPress={() =>
                    void conNota((texto) =>
                      ProductIncidentRepository.apelar(casoId, texto),
                    )
                  }
                  disabled={ocupado}
                  loading={ocupado}
                />
              </>,
            )
          : null}

        {sePuedeRetirar(caso)
          ? bloque(
              f('incidencia.detalle.retirarTitulo'),
              <>
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
                  label={f('incidencia.detalle.retirar')}
                  variant="secondary"
                  onPress={() => void retirar()}
                  disabled={ocupado}
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
                  <Feather name={paso.icono as never} size={16} color={colors.textMuted} />
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
  galeria: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  miniatura: { width: 88, height: 88, borderRadius: radius.sm },
  sinFoto: {
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  area: { minHeight: 80, textAlignVertical: 'top' },
  paso: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  pasoTexto: { flex: 1 },
});
