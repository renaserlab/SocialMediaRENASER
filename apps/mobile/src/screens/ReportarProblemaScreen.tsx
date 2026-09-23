import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
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
import { yaLlego } from '@/lib/envios';
import {
  DESCRIPCION_MAXIMA,
  DESCRIPCION_MINIMA,
  MOTIVOS,
  claveDeErrorDeIncidencias,
  claveDelMotivo,
  descripcionValida,
  pideLinea,
} from '@/lib/incidencias';
import { esPedidoApagado, type Pedido } from '@/lib/pedidos';
import {
  claveDeErrorDeProductos,
  claveDeErrorPorEstado,
  esFaltaDeSesion,
} from '@/lib/productos';
import { ProductIncidentRepository } from '@/repositories/ProductIncidentRepository';
import { ProductOrderRepository } from '@/repositories/ProductOrderRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Reportar que algo llegó mal. ABRIR UN CASO NO ES QUE TE DEN LA RAZÓN.
 *
 * Y EL TEXTO DE ARRIBA NO ES DECORACIÓN: esta es la pantalla donde más fácil
 * sería hacer creer que la reclamación ya está aceptada. Lo único que ocurre al
 * pulsar es que queda constancia de lo que alguien dice que pasó.
 *
 * LAS FOTOGRAFÍAS VAN EN EL PASO SIGUIENTE, y no es una comodidad: cuelgan del
 * caso, así que el caso tiene que existir antes. Por eso este formulario avisa
 * de que el proveedor todavía no recibe nada, y el aviso sale cuando se **envía**
 * el expediente desde la pantalla del caso.
 *
 * LO QUE ESTA PANTALLA NO ENSEÑA, Y ES DELIBERADO:
 *
 *   * NINGÚN IMPORTE. Ni cuánto se devolvería, ni el total del pedido junto al
 *     botón: un número ahí se lee como lo que te van a devolver.
 *   * NINGÚN PLAZO DE RESPUESTA DE Z. Las 48 horas que sí existen son las del
 *     proveedor, y se enseñan cuando el caso ya está enviado.
 *   * NINGUNA PROBABILIDAD, NINGÚN «SUELE RESOLVERSE EN». No hay datos.
 *
 * EL MOTIVO DECIDE SI HACE FALTA ELEGIR ARTÍCULO. «Consta entregado y no lo
 * recibí» habla del pedido entero: no hay una línea concreta de la que quejarse
 * porque no llegó nada. Lo vuelve a comprobar el servidor y lo impone un CHECK.
 */
export function ReportarProblemaScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();
  const { orderId: bruto } = useLocalSearchParams<{ orderId?: string }>();
  const orderId = typeof bruto === 'string' ? bruto : '';

  const [pedido, setPedido] = useState<Pedido | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinSesion' | 'noEncontrado' | 'noDisponible' | null
  >(null);

  const [motivo, setMotivo] = useState<string>(MOTIVOS[0]);
  const [linea, setLinea] = useState<string | null>(null);
  const [descripcion, setDescripcion] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const cargar = useCallback(async () => {
    if (orderId === '') {
      setFallo('noEncontrado');
      setCargando(false);
      return;
    }
    setCargando(true);
    setFallo(null);
    try {
      setPedido(await ProductOrderRepository.leer(orderId));
    } catch (e) {
      if (e instanceof ApiError && esFaltaDeSesion(e.status)) setFallo('sinSesion');
      else if (e instanceof ApiError && esPedidoApagado(e.code)) setFallo('noDisponible');
      else if (e instanceof ApiError && e.status === 404) setFallo('noEncontrado');
      else if (e instanceof ApiError && esFalloDeRed(e.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, [orderId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  /** La primera línea, cuando el pedido trae una sola: elegirla es ruido. */
  useEffect(() => {
    if (pedido === null || linea !== null) return;
    if (pedido.items.length === 1) setLinea(pedido.items[0]?.id ?? null);
  }, [pedido, linea]);

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
   * Abre el caso y se va a él.
   *
   * EL DOBLE TOQUE ESTÁ BLOQUEADO con una referencia y no con el estado: un
   * `setState` no se ve hasta el siguiente render, y en ese hueco cabe el
   * segundo toque. Aquí el segundo toque chocaría contra el índice único del
   * servidor y devolvería «ya hay una reclamación abierta», que es verdad pero
   * suena a avería.
   */
  const continuar = async () => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    setError(null);
    try {
      const caso = await ProductIncidentRepository.abrir(orderId, {
        reason: motivo,
        description: descripcion.trim(),
        orderItemId: pideLinea(motivo) ? linea : null,
      });
      router.replace(`/productos/reclamaciones/${caso.id}` as never);
    } catch (e) {
      setError(textoDelError(e));
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const volver = () =>
    router.canGoBack()
      ? router.back()
      : router.replace(`/productos/pedidos/${orderId}` as never);

  const encabezado = <AppHeader title={f('incidencia.abrir.titulo')} onBack={volver} />;

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || pedido === null) {
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
            icon="package"
            title={f('pedidoDeProducto.error.noEncontrado')}
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

  /* NO SE RECLAMA SOBRE ALGO QUE NO CONSTA ENTREGADO. El servidor lo vuelve a
     comprobar; aquí se dice con palabras en vez de dejar pulsar y fallar. */
  if (!yaLlego(pedido.shipment)) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView
          state="empty"
          icon="truck"
          title={f('incidencia.error.nadaQueReclamar')}
          description={f('incidencia.enElPedido.soloEntregado')}
        />
      </AppScreen>
    );
  }

  const necesitaLinea = pideLinea(motivo);
  const listo =
    descripcionValida(descripcion) && (!necesitaLinea || linea !== null);

  return (
    <AppScreen contentStyle={styles.contenido}>
      {encabezado}
      <ScrollView
        contentContainerStyle={styles.cuerpo}
        keyboardShouldPersistTaps="handled"
      >
        {/* LO PRIMERO QUE SE LEE, Y NO AL FINAL EN LETRA PEQUEÑA. */}
        <View style={[styles.aviso, { backgroundColor: colors.surfaceAlt }]}>
          <Feather name="info" size={16} color={colors.textMuted} />
          <Text variant="caption" color="muted" style={styles.avisoTexto}>
            {f('incidencia.abrirNoEsAprobar')}
          </Text>
        </View>

        <Text variant="titleMedium" style={styles.titulo}>
          {f('incidencia.abrir.queMotivo')}
        </Text>
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={f('incidencia.abrir.queMotivo')}
        >
          {MOTIVOS.map((m) => {
            const elegido = m === motivo;
            return (
              <Pressable
                key={m}
                onPress={() => setMotivo(m)}
                accessibilityRole="radio"
                accessibilityState={{ selected: elegido }}
                accessibilityLabel={f(claveDelMotivo(m))}
                style={[
                  styles.opcion,
                  {
                    borderColor: elegido ? colors.primary : colors.border,
                    backgroundColor: elegido ? colors.surfaceAlt : 'transparent',
                  },
                ]}
              >
                {/* EL ICONO ACOMPAÑA AL TEXTO: el color nunca es el único
                    portador de «esta es la elegida». */}
                <Feather
                  name={elegido ? 'check-circle' : 'circle'}
                  size={18}
                  color={elegido ? colors.primary : colors.textMuted}
                />
                <Text style={styles.opcionTexto}>{f(claveDelMotivo(m))}</Text>
              </Pressable>
            );
          })}
        </View>

        {necesitaLinea ? (
          <>
            <Text variant="titleMedium" style={styles.titulo}>
              {f('incidencia.abrir.queArticulo')}
            </Text>
            <View
              accessibilityRole="radiogroup"
              accessibilityLabel={f('incidencia.abrir.queArticulo')}
            >
              {pedido.items.map((articulo) => {
                const elegido = articulo.id === linea;
                return (
                  <Pressable
                    key={articulo.id}
                    onPress={() => setLinea(articulo.id)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: elegido }}
                    accessibilityLabel={articulo.name}
                    style={[
                      styles.opcion,
                      {
                        borderColor: elegido ? colors.primary : colors.border,
                        backgroundColor: elegido ? colors.surfaceAlt : 'transparent',
                      },
                    ]}
                  >
                    <Feather
                      name={elegido ? 'check-circle' : 'circle'}
                      size={18}
                      color={elegido ? colors.primary : colors.textMuted}
                    />
                    <View style={styles.opcionTexto}>
                      <Text>{articulo.name}</Text>
                      {articulo.variant_name !== null ? (
                        <Text variant="caption" color="muted">
                          {articulo.variant_name}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </>
        ) : (
          <Text variant="caption" color="muted" style={styles.nota}>
            {f('incidencia.abrir.sinArticulo')}
          </Text>
        )}

        <Text variant="titleMedium" style={styles.titulo}>
          {f('incidencia.abrir.cuentanos')}
        </Text>
        <Text variant="caption" color="muted" style={styles.nota}>
          {f('incidencia.abrir.cuentanosAyuda', { min: DESCRIPCION_MINIMA })}
        </Text>
        <Input
          value={descripcion}
          onChangeText={(texto) => setDescripcion(texto.slice(0, DESCRIPCION_MAXIMA))}
          multiline
          numberOfLines={5}
          maxLength={DESCRIPCION_MAXIMA}
          accessibilityLabel={f('incidencia.abrir.cuentanos')}
          style={styles.area}
        />
        <Text variant="caption" color="muted" style={styles.contador}>
          {f('incidencia.abrir.contador', {
            n: descripcion.trim().length,
            min: DESCRIPCION_MINIMA,
          })}
        </Text>

        {/* EL ERROR VA EN LA PROPIA PANTALLA y no en un diálogo: hay un
            formulario abierto y en iOS los Modales no se apilan. */}
        {error !== null ? <InlineError message={error} /> : null}

        <Text variant="caption" color="muted" style={styles.nota}>
          {f('incidencia.abrir.despuesLasFotos')}
        </Text>
        <Button
          label={f('incidencia.abrir.continuar')}
          onPress={() => void continuar()}
          disabled={!listo || ocupado}
          loading={ocupado}
        />
      </ScrollView>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { paddingHorizontal: 0 },
  cuerpo: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl },
  aviso: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    alignItems: 'flex-start',
  },
  avisoTexto: { flex: 1 },
  titulo: { marginTop: spacing.md },
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
  nota: { marginBottom: spacing.xs },
  area: { minHeight: 120, textAlignVertical: 'top' },
  contador: { textAlign: 'right' },
});
