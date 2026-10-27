import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  MAXIMO_DEL_MOVIMIENTO,
  ajusteImposible,
  ajusteValido,
  cantidadDelMovimiento,
  claveDeErrorDeInventario,
  claveDelEstado,
  claveDelMovimiento,
  claveDelMovimientoNuevo,
  disponibleDe,
  entradaValida,
  esInventarioApagado,
  estadoDeLaUnidad,
  iconoDelMovimiento,
  inventarioVacio,
  tieneInventario,
  totalDisponible,
  unidadesCargadas,
  type EstadoDeLaUnidad,
  type Inventario,
  type Movimiento,
  type UnidadDeInventario,
} from '@/lib/inventario';
import { momentoLegible } from '@/lib/productos';
import { toast } from '@/lib/toast';
import { ProductInventoryRepository } from '@/repositories/ProductInventoryRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * El inventario de un producto del proveedor, SKU a SKU.
 *
 * LA REGLA QUE MANDA EN ESTA PANTALLA: **`stock: null` NO SE PINTA COMO CERO**.
 * Una variante sin inventario cargado no tiene cero unidades; tiene un
 * inventario que nadie ha cargado todavía. Escribir «0» o «Agotado» ahí manda a
 * quien vende a buscar unas existencias que se agotaron —a revisar pedidos, a
 * pensar que algo se vendió— cuando lo único que pasa es que falta cargar la
 * primera entrada. Por eso el estado sale siempre de `estadoDeLaUnidad`, que
 * distingue `sinCargar` de `agotado`, y el número solo se escribe cuando existe.
 *
 * LOS TRES NÚMEROS VAN JUNTOS. Disponibles, en existencia y comprometidas. Solo
 * «disponibles» esconde por qué hay diez en el almacén y ninguna vendible, y
 * solo «en existencia» promete como vendible lo que ya está comprometido.
 *
 * NADA SE CALCULA AQUÍ. `available` lo manda el servidor: no se resta
 * `on_hand - reserved` por nuestra cuenta, porque el día que el servidor cambie
 * esa definición la pantalla seguiría enseñando la resta vieja sin fallar.
 *
 * LA CLAVE DE IDEMPOTENCIA SE GENERA UNA VEZ POR PULSACIÓN y se reenvía en los
 * reintentos. Es lo único que impide que un doble toque —o un «vuelve a
 * intentarlo» tras un error de red que en realidad llegó— cargue el doble de
 * existencias. El `disabled` del botón no sirve para eso: cuando se pulsa dos
 * veces seguidas, la petición ya salió dos veces.
 *
 * NO HAY RESERVAR, LIBERAR NI DESPACHAR. Existen en el servidor y funcionan,
 * pero los provoca el checkout, que todavía no existe: un botón que no lleva a
 * ninguna parte es peor que ningún botón.
 *
 * Y NO HAY NINGÚN UMBRAL DE «QUEDAN POCAS» ni ningún plazo de reposición: el
 * contrato no manda ninguno y ponerlo aquí sería inventarse una regla de
 * negocio que nadie ha decidido.
 */

/** Lo que está abierto sobre un SKU: una entrada o un ajuste. */
type FormularioAbierto = { sku: string; tipo: 'entrada' | 'ajuste' };

/** El icono de cada estado. EL COLOR NO ES EL ÚNICO PORTADOR: icono y texto. */
const ICONO_DEL_ESTADO: Record<EstadoDeLaUnidad, keyof typeof Feather.glyphMap> = {
  sinCargar: 'help-circle',
  agotado: 'x-circle',
  comprometido: 'lock',
  disponible: 'check-circle',
};

/** Solo dígitos: una entrada suma unidades enteras. */
function soloEntero(texto: string): string {
  return texto.replace(/[^0-9]/g, '');
}

/** Dígitos con el signo delante: un ajuste es el único movimiento que resta. */
function soloEnteroConSigno(texto: string): string {
  const negativo = texto.trim().startsWith('-');
  const digitos = texto.replace(/[^0-9]/g, '');
  return negativo ? `-${digitos}` : digitos;
}

/**
 * El número escrito, o `NaN` si no hay ninguno.
 *
 * `Number('')` vale cero, y cero es justo lo que no puede colarse aquí: un
 * campo vacío no es «cargar cero unidades». `NaN` lo rechazan `entradaValida` y
 * `ajusteValido` sin tener que repetir la comprobación.
 */
function numeroEscrito(texto: string): number {
  const limpio = texto.trim();
  if (limpio === '' || limpio === '-') return Number.NaN;
  return Number.parseInt(limpio, 10);
}

export function InventarioDeProductoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();
  const { productId } = useLocalSearchParams<{ productId?: string }>();
  const productoId = typeof productId === 'string' ? productId : '';

  const [inventario, setInventario] = useState<Inventario | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinSesion' | 'sinPermiso' | 'noEncontrado' | 'noDisponible' | null
  >(null);

  /** El formulario abierto, que es UNO en toda la pantalla. */
  const [formulario, setFormulario] = useState<FormularioAbierto | null>(null);
  const [cantidad, setCantidad] = useState('');
  const [motivo, setMotivo] = useState('');
  const [errorDelFormulario, setErrorDelFormulario] = useState<string | null>(null);

  /**
   * La clave de idempotencia del envío EN CURSO.
   *
   * Se genera una vez, antes de la llamada, y sobrevive al fallo: si hay que
   * reintentar, viaja la misma y el servidor reconoce el movimiento que quizá
   * ya guardó. Se limpia al terminar bien y al cerrar el formulario, porque a
   * partir de ahí lo siguiente ya es otro movimiento.
   */
  const claveDelEnvio = useRef<string | null>(null);

  /** El historial abierto, y lo leído de cada SKU. */
  const [historialAbierto, setHistorialAbierto] = useState<string | null>(null);
  const [historial, setHistorial] = useState<Record<string, Movimiento[]>>({});
  const [cargandoHistorial, setCargandoHistorial] = useState(false);
  const [falloDelHistorial, setFalloDelHistorial] = useState(false);

  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const leerFallo = (error: unknown) => {
    if (error instanceof ApiError && esInventarioApagado(error.code)) {
      return 'noDisponible' as const;
    }
    if (error instanceof ApiError && error.status === 503) return 'noDisponible' as const;
    if (error instanceof ApiError && error.status === 401) return 'sinSesion' as const;
    if (error instanceof ApiError && error.status === 403) return 'sinPermiso' as const;
    if (error instanceof ApiError && error.status === 404) return 'noEncontrado' as const;
    if (error instanceof ApiError && esFalloDeRed(error.code)) return 'sinConexion' as const;
    return 'red' as const;
  };

  const cargar = useCallback(async () => {
    if (productoId === '') {
      setFallo('noEncontrado');
      setCargando(false);
      return;
    }
    setCargando(true);
    setFallo(null);
    try {
      setInventario(await ProductInventoryRepository.leer(productoId));
    } catch (error) {
      setFallo(leerFallo(error));
    } finally {
      setCargando(false);
    }
  }, [productoId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const textoDelError = (error: unknown) => {
    if (error instanceof ApiError) {
      const porCodigo = claveDeErrorDeInventario(error.code);
      if (porCodigo !== null) return f(porCodigo);
      if (error.status === 401) return f('inventario.error.sinSesionCuerpo');
      if (error.status === 403) return f('inventario.error.sinPermisoCuerpo');
      if (error.status === 404) return f('inventario.error.noEncontradoCuerpo');
    }
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  /** El cerrojo, cerrado ANTES del primer `await`. */
  const conCerrojo = async (trabajo: () => Promise<void>) => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    try {
      await trabajo();
    } catch (error) {
      notify(f('inventario.noSePudo'), textoDelError(error));
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const cerrarFormulario = () => {
    setFormulario(null);
    setCantidad('');
    setMotivo('');
    setErrorDelFormulario(null);
    claveDelEnvio.current = null;
  };

  const abrirFormulario = (sku: string, tipo: 'entrada' | 'ajuste') => {
    setFormulario({ sku, tipo });
    setCantidad('');
    setMotivo('');
    setErrorDelFormulario(null);
    claveDelEnvio.current = null;
  };

  /**
   * Carga una entrada. ES LO ÚNICO QUE CREA la fila de inventario de un SKU.
   *
   * La clave sale de `claveDelMovimientoNuevo` una sola vez: si el envío falla y
   * se vuelve a pulsar, viaja la misma y no se carga dos veces.
   */
  const cargarEntrada = (unidad: UnidadDeInventario) => {
    const cuantas = numeroEscrito(cantidad);
    if (!entradaValida(cuantas)) {
      setErrorDelFormulario(f('inventario.entradaInvalida', { max: MAXIMO_DEL_MOVIMIENTO }));
      return;
    }
    setErrorDelFormulario(null);
    if (claveDelEnvio.current === null) {
      claveDelEnvio.current = claveDelMovimientoNuevo(unidad.sku, Date.now());
    }
    const clave = claveDelEnvio.current;
    void conCerrojo(async () => {
      await ProductInventoryRepository.cargar(productoId, {
        sku: unidad.sku,
        quantity: cuantas,
        idempotency_key: clave,
      });
      claveDelEnvio.current = null;
      cerrarFormulario();
      await cargar();
      await refrescarHistorialSiEstaAbierto(unidad.sku);
      toast(f('inventario.entradaHecha'));
    });
  };

  /** Ajusta con signo Y CON MOTIVO. */
  const ajustar = (unidad: UnidadDeInventario) => {
    const cuanto = numeroEscrito(cantidad);
    if (!ajusteValido(cuanto, motivo)) {
      setErrorDelFormulario(f('inventario.ajusteInvalido', { max: MAXIMO_DEL_MOVIMIENTO }));
      return;
    }
    setErrorDelFormulario(null);
    if (claveDelEnvio.current === null) {
      claveDelEnvio.current = claveDelMovimientoNuevo(unidad.sku, Date.now());
    }
    const clave = claveDelEnvio.current;
    void conCerrojo(async () => {
      await ProductInventoryRepository.ajustar(productoId, {
        sku: unidad.sku,
        quantity: cuanto,
        reason: motivo.trim(),
        idempotency_key: clave,
      });
      claveDelEnvio.current = null;
      cerrarFormulario();
      await cargar();
      await refrescarHistorialSiEstaAbierto(unidad.sku);
      toast(f('inventario.ajusteHecho'));
    });
  };

  /** Lee el historial de un SKU. SOLO SE AÑADE: nada se edita ni se borra. */
  const leerHistorial = async (sku: string) => {
    setCargandoHistorial(true);
    setFalloDelHistorial(false);
    try {
      const leidos = await ProductInventoryRepository.movimientos(productoId, sku);
      setHistorial((previos) => ({ ...previos, [sku]: leidos }));
    } catch {
      setFalloDelHistorial(true);
    } finally {
      setCargandoHistorial(false);
    }
  };

  /** Tras un movimiento, el historial abierto deja de estar al día. */
  const refrescarHistorialSiEstaAbierto = async (sku: string) => {
    if (historialAbierto === sku) await leerHistorial(sku);
  };

  const alternarHistorial = (sku: string) => {
    if (historialAbierto === sku) {
      setHistorialAbierto(null);
      return;
    }
    setHistorialAbierto(sku);
    if (historial[sku] === undefined) void leerHistorial(sku);
  };

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/proveedor/productos' as never);

  const titulo = f('inventario.titulo');

  // A pantalla completa SOLO la primera vez. Cada entrada y cada ajuste vuelven
  // a leer el inventario, y cambiar la lista entera por «Cargando…» la devolvía
  // arriba del todo y cerraba el historial que se estaba mirando.
  if (cargando && inventario === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
    const blando =
      fallo === 'noDisponible' ||
      fallo === 'sinPermiso' ||
      fallo === 'sinSesion' ||
      fallo === 'noEncontrado';
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        {blando ? (
          <StateView
            state="empty"
            icon={
              fallo === 'noDisponible' ? 'clock' : fallo === 'noEncontrado' ? 'inbox' : 'lock'
            }
            title={
              fallo === 'noDisponible'
                ? f('inventario.error.noDisponible')
                : fallo === 'sinSesion'
                  ? f('inventario.error.sinSesion')
                  : fallo === 'sinPermiso'
                    ? f('inventario.error.sinPermiso')
                    : f('inventario.error.noEncontrado')
            }
            description={
              fallo === 'noDisponible'
                ? f('inventario.error.noDisponibleCuerpo')
                : fallo === 'sinSesion'
                  ? f('inventario.error.sinSesionCuerpo')
                  : fallo === 'sinPermiso'
                    ? f('inventario.error.sinPermisoCuerpo')
                    : f('inventario.error.noEncontradoCuerpo')
            }
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

  /* SIN VARIANTES NO HAY NADA QUE INVENTARIAR, y no es un error. */
  if (inventarioVacio(inventario)) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={titulo} onBack={volver} />
        <StateView
          state="empty"
          icon="package"
          title={f('inventario.vacio')}
          description={f('inventario.vacioCuerpo')}
          onRetry={() => void cargar()}
        />
      </AppScreen>
    );
  }

  const unidades = inventario?.units ?? [];
  const total = totalDisponible(inventario);
  const cargadas = unidadesCargadas(inventario);

  /** El historial de un SKU, ya desplegado. */
  const pintarHistorial = (sku: string) => {
    const movimientos = historial[sku] ?? [];
    if (cargandoHistorial) return <StateView state="loading" />;
    if (falloDelHistorial) {
      return (
        <StateView
          state="error"
          description={t('common.loadFailed')}
          onRetry={() => void leerHistorial(sku)}
        />
      );
    }
    if (movimientos.length === 0) {
      return (
        <Text variant="caption" color={colors.textMuted}>
          {f('inventario.historialVacio')}
        </Text>
      );
    }
    return movimientos.map((movimiento) => {
      const icono = iconoDelMovimiento(movimiento.kind);
      const fecha = momentoLegible(movimiento.created_at);
      return (
        <View key={movimiento.id} style={[styles.paso, { borderColor: colors.border }]}>
          <View style={styles.cabecera}>
            {/* Un tipo que no conocemos va SIN icono, no con uno cualquiera. */}
            {icono !== null ? (
              <Feather
                name={icono as keyof typeof Feather.glyphMap}
                size={16}
                color={colors.textMuted}
              />
            ) : null}
            <View style={styles.crece}>
              <Text variant="secondary" weight="700">
                {f(claveDelMovimiento(movimiento.kind))}
              </Text>
              {fecha !== '' ? (
                <Text variant="caption" color={colors.textMuted}>
                  {fecha}
                </Text>
              ) : null}
            </View>
            {/* El signo ya viene puesto: aquí no se decide si suma o resta. */}
            <Text variant="secondary" weight="700">
              {cantidadDelMovimiento(movimiento)}
            </Text>
          </View>
          <Text variant="caption" color={colors.textMuted}>
            {f('inventario.comoQuedo', {
              existencia: movimiento.on_hand_after,
              comprometidas: movimiento.reserved_after,
              disponibles: movimiento.available_after,
            })}
          </Text>
          {movimiento.reason !== null && movimiento.reason.trim() !== '' ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('inventario.motivoDelMovimiento', { motivo: movimiento.reason })}
            </Text>
          ) : null}
        </View>
      );
    });
  };

  /** Una variante con lo que hay de su SKU. */
  const pintarUnidad = (unidad: UnidadDeInventario) => {
    const estado = estadoDeLaUnidad(unidad);
    const hayInventario = tieneInventario(unidad);
    const disponible = disponibleDe(unidad);
    const colorDelEstado =
      estado === 'agotado'
        ? colors.danger
        : estado === 'disponible'
          ? colors.text
          : colors.textMuted;
    const formularioAqui =
      formulario !== null && formulario.sku === unidad.sku ? formulario : null;
    const historialAqui = historialAbierto === unidad.sku;
    const cuanto = numeroEscrito(cantidad);
    /* Un ajuste que dejaría la existencia negativa no se manda: el servidor lo
       rechazaría igual, y decirlo antes ahorra el viaje y explica por qué. */
    const dejariaNegativo =
      formularioAqui?.tipo === 'ajuste' &&
      Number.isFinite(cuanto) &&
      ajusteImposible(unidad, cuanto);

    return (
      <View key={unidad.variant_id} style={[styles.fila, { borderColor: colors.border }]}>
        <View style={styles.cabecera}>
          <View style={styles.crece}>
            <Text variant="secondary" weight="700">
              {unidad.name}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {f('inventario.sku', { sku: unidad.sku })}
            </Text>
          </View>
          <Feather name={ICONO_DEL_ESTADO[estado]} size={18} color={colorDelEstado} />
        </View>

        {/* EL ESTADO, CON PALABRAS. `sinCargar` dice «sin existencias cargadas»
            y nunca «0» ni «agotado». */}
        <Text variant="secondary" color={colorDelEstado}>
          {f(claveDelEstado(estado))}
        </Text>

        {hayInventario && disponible !== null && unidad.stock !== null ? (
          <>
            {/* LOS TRES, SIEMPRE. `available` lo manda el servidor. */}
            <Text variant="secondary">
              {f('inventario.disponibles', { n: unidad.stock.available })}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {f('inventario.enExistencia', { n: unidad.stock.on_hand })}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {f('inventario.comprometidas', { n: unidad.stock.reserved })}
            </Text>
          </>
        ) : (
          /* NI UN NÚMERO AQUÍ. `disponibleDe` devuelve `null`, y un `null` no se
             escribe como cero: se cuenta con una frase. */
          <Text variant="caption" color={colors.textMuted}>
            {f('inventario.sinCargarCuerpo')}
          </Text>
        )}

        {formularioAqui === null ? (
          <View style={styles.acciones}>
            <Button
              label={f('inventario.cargarEntrada')}
              variant="secondary"
              icon="download"
              onPress={() => abrirFormulario(unidad.sku, 'entrada')}
              disabled={ocupado}
            />
            <Button
              label={f('inventario.ajustar')}
              variant="ghost"
              icon="edit-3"
              onPress={() => abrirFormulario(unidad.sku, 'ajuste')}
              disabled={ocupado}
            />
          </View>
        ) : (
          <View style={[styles.recuadro, { borderColor: colors.border }]}>
            <Text variant="secondary" weight="700">
              {formularioAqui.tipo === 'entrada'
                ? f('inventario.cargarEntrada')
                : f('inventario.ajustar')}
            </Text>

            {formularioAqui.tipo === 'entrada' ? (
              <>
                <Text variant="caption" color={colors.textMuted}>
                  {f('inventario.entradaCuerpo')}
                </Text>
                <Input
                  label={f('inventario.cantidadEntrada')}
                  placeholder={f('inventario.cantidadEntradaAyuda')}
                  value={cantidad}
                  onChangeText={(texto) => {
                    setCantidad(soloEntero(texto));
                    if (errorDelFormulario !== null) setErrorDelFormulario(null);
                  }}
                  keyboardType="number-pad"
                  maxLength={7}
                  disabled={ocupado}
                />
              </>
            ) : (
              <>
                {/* POR QUÉ UN AJUSTE LLEVA MOTIVO, dicho donde se escribe. */}
                <Text variant="caption" color={colors.textMuted}>
                  {f('inventario.porQueMotivo')}
                </Text>
                <Input
                  label={f('inventario.cantidadAjuste')}
                  placeholder={f('inventario.cantidadAjusteAyuda')}
                  value={cantidad}
                  onChangeText={(texto) => {
                    setCantidad(soloEnteroConSigno(texto));
                    if (errorDelFormulario !== null) setErrorDelFormulario(null);
                  }}
                  maxLength={8}
                  autoCapitalize="none"
                  autoCorrect={false}
                  disabled={ocupado}
                />
                <Input
                  label={f('inventario.motivoEtiqueta')}
                  placeholder={f('inventario.motivoAyuda')}
                  value={motivo}
                  onChangeText={(texto) => {
                    setMotivo(texto.slice(0, LARGO_DEL_MOTIVO));
                    if (errorDelFormulario !== null) setErrorDelFormulario(null);
                  }}
                  maxLength={LARGO_DEL_MOTIVO}
                  multiline
                  numberOfLines={2}
                  style={styles.campoLargo}
                  disabled={ocupado}
                />
              </>
            )}

            {dejariaNegativo ? (
              <Text variant="caption" color={colors.danger}>
                {f('inventario.dejariaNegativo')}
              </Text>
            ) : null}
            {errorDelFormulario !== null ? (
              <Text variant="caption" color={colors.danger}>
                {errorDelFormulario}
              </Text>
            ) : null}

            <Button
              label={f('inventario.mandar')}
              onPress={() =>
                formularioAqui.tipo === 'entrada' ? cargarEntrada(unidad) : ajustar(unidad)
              }
              loading={ocupado}
              disabled={ocupado || dejariaNegativo === true}
            />
            <Button
              label={t('common.cancel')}
              variant="ghost"
              onPress={cerrarFormulario}
              disabled={ocupado}
            />
          </View>
        )}

        <Pressable
          onPress={() => alternarHistorial(unidad.sku)}
          style={styles.enlace}
          accessibilityRole="button"
          accessibilityState={{ expanded: historialAqui }}
          accessibilityLabel={
            historialAqui ? f('inventario.cerrarHistorial') : f('inventario.verHistorial')
          }
        >
          <Feather
            name={historialAqui ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={colors.textMuted}
          />
          <Text variant="caption" color={colors.textMuted}>
            {historialAqui ? f('inventario.cerrarHistorial') : f('inventario.verHistorial')}
          </Text>
        </Pressable>

        {historialAqui ? (
          <View style={styles.bloque}>
            {/* EL HISTORIAL SOLO SE AÑADE, y se dice para que nadie busque
                dónde corregir una línea que no se puede corregir. */}
            <Text variant="caption" color={colors.textMuted}>
              {f('inventario.historialSoloSeAnade')}
            </Text>
            {pintarHistorial(unidad.sku)}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={titulo} onBack={volver} />

      <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
        <Feather name="package" size={16} color={colors.textMuted} />
        <View style={styles.crece}>
          <Text variant="secondary" weight="700">
            {f('inventario.titulo')}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {f('inventario.cuerpo')}
          </Text>
          {/* SIN NADA CARGADO NO HAY TOTAL: sumar ceros de cosas que nadie
              cargó daría un número que parece medido y no lo es. */}
          {total === null ? (
            <Text variant="caption" color={colors.textMuted}>
              {f('inventario.totalSinCargar')}
            </Text>
          ) : (
            <Text variant="secondary">{f('inventario.total', { n: total })}</Text>
          )}
          <Text variant="caption" color={colors.textMuted}>
            {f('inventario.cargadas', { n: cargadas, total: unidades.length })}
          </Text>
        </View>
      </View>

      {unidades.map(pintarUnidad)}
    </AppScreen>
  );
}

/** Lo que cabe en un motivo. El servidor recorta a 200 y aquí no se pasa. */
const LARGO_DEL_MOTIVO = 200;

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  crece: { flex: 1, gap: 4 },
  bloque: { gap: spacing.sm },
  acciones: { gap: spacing.sm },
  cabecera: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  aviso: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  fila: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  recuadro: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  paso: {
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  enlace: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
  },
  campoLargo: {
    minHeight: 72,
    textAlignVertical: 'top',
    paddingTop: spacing.sm,
  },
});
