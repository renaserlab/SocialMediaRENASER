import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { EstrellasDeResena } from '@/components/EstrellasDeResena';
import { InlineError } from '@/components/InlineError';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { esFaltaDeSesion } from '@/lib/productos';
import {
  EJES,
  LARGO_MAXIMO_DEL_COMENTARIO,
  type BorradorDeResena,
  type LineaValorable,
  borradorVacio,
  claveDeErrorDeResena,
  claveDelEje,
  cuerpoDeResena,
  esResenasApagadas,
  largoDelComentario,
  lineasPendientes,
  lineasYaValoradas,
  motivoDelRechazo,
  motivoParaNoEnviar,
  sePuedeEnviar,
} from '@/lib/resenasDeProductos';
import { ProductReviewRepository } from '@/repositories/ProductReviewRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Valorar lo que llegó, línea por línea.
 *
 * LA UNIDAD ES LA LÍNEA DEL PEDIDO y no el pedido entero: quien compró dos
 * cosas distintas puede haber quedado contento con una y no con la otra, y una
 * sola puntuación para las dos no dice ninguna de las dos verdades.
 *
 * EL FORMULARIO NO MANDA EL SELLO. Solo viajan cinco puntuaciones, un sí/no y
 * un texto; el producto, el pedido y las dos fechas que verifican la compra las
 * pone el servidor y la base las vuelve a comprobar.
 *
 * AQUÍ NO SE SUBEN FOTOGRAFÍAS, y se dice con palabras: si algo llegó mal, eso
 * es una reclamación y tiene su propio recorrido, con su plazo y su expediente.
 *
 * LAS SEIS RESPUESTAS SON OBLIGATORIAS. El botón está desactivado hasta que
 * estén, y encima dice cuál falta: un botón que no responde sin explicar por
 * qué se lee como una aplicación rota.
 */
export function ValorarCompraScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();
  const { orderId } = useLocalSearchParams<{ orderId: string }>();

  const [lineas, setLineas] = useState<LineaValorable[]>([]);
  const [elegida, setElegida] = useState<string | null>(null);
  const [borrador, setBorrador] = useState<BorradorDeResena>(borradorVacio());
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinSesion' | 'noDisponible' | null
  >(null);

  const cargar = useCallback(async () => {
    if (!orderId) return;
    setCargando(true);
    setFallo(null);
    try {
      const filas = await ProductReviewRepository.valorables(String(orderId));
      setLineas(filas);
      setElegida(lineasPendientes(filas)[0]?.order_item_id ?? null);
    } catch (e) {
      if (e instanceof ApiError && esFaltaDeSesion(e.status)) setFallo('sinSesion');
      else if (e instanceof ApiError && esResenasApagadas(e.code))
        setFallo('noDisponible');
      else if (e instanceof ApiError && esFalloDeRed(e.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, [orderId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const pendientes = useMemo(() => lineasPendientes(lineas), [lineas]);
  const valoradas = useMemo(() => lineasYaValoradas(lineas), [lineas]);
  const falta = motivoParaNoEnviar(borrador);
  /** Cuando solo queda una, se ensena sin preguntar. */
  const unica = pendientes.length === 1 ? pendientes[0] : undefined;

  const publicar = async () => {
    if (!elegida || !sePuedeEnviar(borrador)) return;
    setGuardando(true);
    setError(null);
    try {
      const resena = await ProductReviewRepository.valorar(
        elegida,
        cuerpoDeResena(borrador),
      );
      router.replace(`/productos/resenas/${resena.id}` as never);
    } catch (e) {
      if (e instanceof ApiError) {
        /* EL MOTIVO VIENE DENTRO DEL 409, como código: la pantalla lo traduce
           y así dice «podrás valorarlo cuando te llegue» en vez de un error
           genérico que no ayuda a nadie. */
        setError(motivoDelRechazo(e.details) ?? claveDeErrorDeResena(e.code));
      } else {
        setError('resenaDeProducto.error.desconocido');
      }
      void cargar();
    } finally {
      setGuardando(false);
    }
  };

  const volver = () =>
    router.canGoBack()
      ? router.back()
      : router.replace(`/productos/pedidos/${orderId}` as never);

  const encabezado = (
    <AppHeader title={f('resenaDeProducto.valorar.titulo')} onBack={volver} />
  );

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null) {
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
            title={f('resenaDeProducto.apagadas')}
            description={f('resenaDeProducto.apagadasCuerpo')}
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

  if (pendientes.length === 0) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView
          state="empty"
          icon="check-circle"
          title={f('resenaDeProducto.valorar.nadaQueValorar')}
          description={
            valoradas.length > 0 ? f('resenaDeProducto.valorar.yaValorada') : undefined
          }
        />
      </AppScreen>
    );
  }

  return (
    <AppScreen contentStyle={styles.contenido}>
      {encabezado}
      <ScrollView contentContainerStyle={styles.cuerpo} keyboardShouldPersistTaps="handled">
        <Text variant="caption" color="muted">
          {f('resenaDeProducto.valorar.explicacion')}
        </Text>

        {/* QUÉ SE VALORA. Con una sola línea no se pregunta: elegir entre uno
            es una pregunta que no lo es. */}
        {pendientes.length > 1 ? (
          <View style={styles.bloque}>
            <Text variant="titleMedium">{f('resenaDeProducto.valorar.elige')}</Text>
            {pendientes.map((linea) => (
              <Pressable
                key={linea.order_item_id}
                onPress={() => setElegida(linea.order_item_id)}
                accessibilityRole="radio"
                accessibilityState={{ selected: elegida === linea.order_item_id }}
                accessibilityLabel={linea.name}
                style={[
                  styles.fila,
                  {
                    borderColor:
                      elegida === linea.order_item_id ? colors.text : colors.border,
                  },
                ]}
              >
                <View style={styles.filaTexto}>
                  <Text>{linea.name}</Text>
                  {linea.variant_name ? (
                    <Text variant="caption" color="muted">
                      {linea.variant_name}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </View>
        ) : unica !== undefined ? (
          <View style={[styles.fila, { borderColor: colors.border }]}>
            <View style={styles.filaTexto}>
              <Text>{unica.name}</Text>
              {unica.variant_name ? (
                <Text variant="caption" color="muted">
                  {unica.variant_name}
                </Text>
              ) : null}
            </View>
          </View>
        ) : null}

        {/* LA GENERAL, Y QUE NO ES LA MEDIA. */}
        <View style={styles.bloque}>
          <Text variant="titleMedium">{f('resenaDeProducto.valorar.general')}</Text>
          <Text variant="caption" color="muted">
            {f('resenaDeProducto.valorar.generalAyuda')}
          </Text>
          <EstrellasDeResena
            valor={borrador.overall}
            onElegir={(n) => setBorrador((b) => ({ ...b, overall: n }))}
            etiqueta={f('resenaDeProducto.valorar.general')}
            sufijo={f('resenaDeProducto.deCinco')}
          />
        </View>

        {/* LOS CUATRO EJES. */}
        {EJES.map((eje) => (
          <View key={eje} style={styles.bloque}>
            <Text>{f(claveDelEje(eje))}</Text>
            <EstrellasDeResena
              valor={borrador[eje]}
              onElegir={(n) => setBorrador((b) => ({ ...b, [eje]: n }))}
              etiqueta={f(claveDelEje(eje))}
              sufijo={f('resenaDeProducto.deCinco')}
            />
          </View>
        ))}

        {/* ¿LO RECOMENDARÍAS? Obligatoria, y no se deduce de la puntuación. */}
        <View style={styles.bloque}>
          <Text variant="titleMedium">{f('resenaDeProducto.valorar.recomienda')}</Text>
          <View style={styles.opciones}>
            {[true, false].map((valor) => (
              <Pressable
                key={String(valor)}
                onPress={() => setBorrador((b) => ({ ...b, recommends: valor }))}
                accessibilityRole="radio"
                accessibilityState={{ selected: borrador.recommends === valor }}
                accessibilityLabel={
                  valor
                    ? f('resenaDeProducto.valorar.si')
                    : f('resenaDeProducto.valorar.no')
                }
                style={[
                  styles.opcion,
                  {
                    borderColor:
                      borrador.recommends === valor ? colors.text : colors.border,
                  },
                ]}
              >
                <Text>
                  {valor
                    ? f('resenaDeProducto.valorar.si')
                    : f('resenaDeProducto.valorar.no')}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* EL COMENTARIO, OPCIONAL. */}
        <View style={styles.bloque}>
          <Text variant="titleMedium">{f('resenaDeProducto.valorar.comentario')}</Text>
          <Text variant="caption" color="muted">
            {f('resenaDeProducto.valorar.comentarioAyuda')}
          </Text>
          <Input
            value={borrador.comment ?? ''}
            onChangeText={(texto) => setBorrador((b) => ({ ...b, comment: texto }))}
            multiline
            numberOfLines={4}
            maxLength={LARGO_MAXIMO_DEL_COMENTARIO}
            accessibilityLabel={f('resenaDeProducto.valorar.comentario')}
          />
          <Text variant="caption" color="muted">
            {`${largoDelComentario(borrador.comment)}/${LARGO_MAXIMO_DEL_COMENTARIO}`}
          </Text>
          <Text variant="caption" color="muted">
            {f('resenaDeProducto.valorar.sinFotos')}
          </Text>
        </View>

        {error !== null ? <InlineError message={f(error)} /> : null}
        {/* QUÉ FALTA, ESCRITO. Un botón apagado sin explicación se lee como una
            aplicación rota. */}
        {falta !== null ? (
          <Text variant="caption" color="muted">
            {f(falta)}
          </Text>
        ) : null}

        <Button
          label={f('resenaDeProducto.valorar.enviar')}
          onPress={() => void publicar()}
          disabled={falta !== null || guardando || !elegida}
          loading={guardando}
        />
      </ScrollView>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { paddingHorizontal: 0 },
  cuerpo: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
  bloque: { gap: spacing.xs },
  fila: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    // 44 de alto: el área táctil mínima.
    minHeight: 44,
  },
  filaTexto: { flex: 1 },
  opciones: { flexDirection: 'row', gap: spacing.sm },
  opcion: {
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 88,
    alignItems: 'center',
  },
});
