import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { EstrellasDeResena } from '@/components/EstrellasDeResena';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  type ResumenDeResenas,
  ajustadaLegible,
  anchoDeBarra,
  claveDelEje,
  comprasVerificadas,
  compraVerificada,
  cursorDeLaPagina,
  ejesDelResumen,
  esResenasApagadas,
  fusionarPaginas,
  hayMasPaginas,
  hayValoraciones,
  histogramaOrdenado,
  porcentajeLegible,
  promedioLegible,
  tieneRespuesta,
  usaReferenciaPorDefecto,
} from '@/lib/resenasDeProductos';
import {
  ProductReviewRepository,
  type ResenaDeProducto,
} from '@/repositories/ProductReviewRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Lo que opinan de un producto.
 *
 * SIN VALORACIONES NO SE PINTA UNA PUNTUACIÓN, y menos un cero: se escribe que
 * todavía no lo ha valorado nadie. Cinco estrellas vacías dicen que está mal
 * valorado, que es otra cosa y además es mentira.
 *
 * LA PUNTUACIÓN AJUSTADA LA CALCULA EL SERVIDOR, y cuando se apoya en la
 * referencia general —porque nadie ha decidido de dónde sale el promedio de
 * categoría— la pantalla lo dice. Enseñarla a secas daría a entender que Z
 * calculó algo que todavía no calcula.
 *
 * LA LISTA NO DICE DE QUÉ COMPRA SALE CADA OPINIÓN, y lo decide el servidor: el
 * pedido y la línea atan a una persona con un importe y una dirección. El sello
 * de compra verificada ya dice lo único que el lector necesita saber.
 */
export function ResenasDelProductoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();
  const { productId } = useLocalSearchParams<{ productId: string }>();

  const [resumen, setResumen] = useState<ResumenDeResenas | null>(null);
  const [resenas, setResenas] = useState<ResenaDeProducto[]>([]);
  const [cargando, setCargando] = useState(true);
  const [pidiendoMas, setPidiendoMas] = useState(false);
  const [hayMas, setHayMas] = useState(false);
  const [fallo, setFallo] = useState<'red' | 'sinConexion' | 'noDisponible' | null>(null);

  const cargar = useCallback(async () => {
    if (!productId) return;
    setCargando(true);
    setFallo(null);
    try {
      const [cabecera, primera] = await Promise.all([
        ProductReviewRepository.resumen(String(productId)),
        ProductReviewRepository.listar(String(productId)),
      ]);
      setResumen(cabecera);
      setResenas(primera);
      setHayMas(hayMasPaginas(primera.length));
    } catch (e) {
      if (e instanceof ApiError && esResenasApagadas(e.code)) setFallo('noDisponible');
      else if (e instanceof ApiError && esFalloDeRed(e.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, [productId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const verMas = async () => {
    const cursor = cursorDeLaPagina(resenas);
    if (!cursor || !productId) return;
    setPidiendoMas(true);
    try {
      const siguiente = await ProductReviewRepository.listar(String(productId), {
        before: cursor.before,
        beforeId: cursor.before_id,
      });
      setResenas((antes) => fusionarPaginas(antes, siguiente));
      setHayMas(hayMasPaginas(siguiente.length));
    } catch {
      /* UN FALLO AL PEDIR MÁS NO VACÍA LO QUE YA SE LEÍA. Se deja el botón
         para volver a intentarlo y nada más. */
      setHayMas(true);
    } finally {
      setPidiendoMas(false);
    }
  };

  const volver = () =>
    router.canGoBack()
      ? router.back()
      : router.replace(`/productos/${productId}` as never);

  const encabezado = (
    <AppHeader title={f('resenaDeProducto.lista.titulo')} onBack={volver} />
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
        {fallo === 'noDisponible' ? (
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

  if (!hayValoraciones(resumen)) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView
          state="empty"
          icon="star"
          title={f('resenaDeProducto.ficha.sinValoraciones')}
          description={f('resenaDeProducto.ficha.sinValoracionesAyuda')}
        />
      </AppScreen>
    );
  }

  const total = comprasVerificadas(resumen);
  const recomiendan = porcentajeLegible(resumen?.recommend_bps);

  return (
    <AppScreen contentStyle={styles.contenido}>
      {encabezado}
      <ScrollView contentContainerStyle={styles.cuerpo}>
        {/* LA CABECERA: la ajustada, cuántas compras verificadas y cuántos lo
            recomiendan. Es lo que pide el blueprint, en ese orden. */}
        <View style={[styles.tarjeta, { borderColor: colors.border }]}>
          <Text variant="display">{ajustadaLegible(resumen) ?? ''}</Text>
          <EstrellasDeResena
            valor={resumen?.adjusted ? Math.round(resumen.adjusted) : null}
            etiqueta={f('resenaDeProducto.ficha.titulo')}
            sufijo={f('resenaDeProducto.deCinco')}
          />
          <Text variant="caption" color="muted">
            {`${total} ${
              total === 1
                ? f('resenaDeProducto.ficha.unaCompraVerificada')
                : f('resenaDeProducto.ficha.comprasVerificadas')
            }`}
          </Text>
          {recomiendan !== null ? (
            <Text variant="caption" color="muted">
              {`${recomiendan} ${f('resenaDeProducto.ficha.loRecomienda')}`}
            </Text>
          ) : null}
          {promedioLegible(resumen) !== null ? (
            <Text variant="caption" color="muted">
              {`${f('resenaDeProducto.ficha.titulo')}: ${promedioLegible(resumen)}`}
            </Text>
          ) : null}
          {usaReferenciaPorDefecto(resumen) ? (
            <Text variant="caption" color="muted">
              {f('resenaDeProducto.ficha.referenciaPorDefecto')}
            </Text>
          ) : null}
        </View>

        {/* LA DISTRIBUCIÓN. */}
        <View style={styles.bloque}>
          {histogramaOrdenado(resumen).map((barra) => (
            <View key={barra.puntuacion} style={styles.barraFila}>
              <Text variant="caption" color="muted" style={styles.barraNumero}>
                {String(barra.puntuacion)}
              </Text>
              <View style={[styles.barraFondo, { backgroundColor: colors.border }]}>
                <View
                  style={[
                    styles.barra,
                    {
                      backgroundColor: colors.text,
                      width: anchoDeBarra(barra.cuantas, total),
                    },
                  ]}
                />
              </View>
              <Text variant="caption" color="muted" style={styles.barraNumero}>
                {String(barra.cuantas)}
              </Text>
            </View>
          ))}
        </View>

        {/* LOS CUATRO EJES. */}
        <View style={styles.bloque}>
          {ejesDelResumen(resumen).map(({ eje, valor, clave }) => (
            <View key={eje} style={styles.ejeFila}>
              <Text style={styles.ejeNombre}>{f(clave)}</Text>
              {valor !== null ? <Text>{valor.toFixed(1)}</Text> : null}
            </View>
          ))}
        </View>

        {/* LAS OPINIONES. */}
        {resenas.map((resena) => (
          <View
            key={resena.id}
            style={[styles.tarjeta, { borderColor: colors.border }]}
          >
            <EstrellasDeResena
              valor={resena.overall}
              etiqueta={f('resenaDeProducto.ficha.titulo')}
              sufijo={f('resenaDeProducto.deCinco')}
            />
            {/* EL SELLO SALE DEL CAMPO DEL SERVIDOR. No se deduce de que la
                reseña exista. */}
            {compraVerificada(resena) ? (
              <Text variant="caption" color="muted">
                {f('resenaDeProducto.lista.selloCompra')}
              </Text>
            ) : null}
            <Text variant="caption" color="muted">
              {resena.recommends
                ? f('resenaDeProducto.lista.recomienda')
                : f('resenaDeProducto.lista.noRecomienda')}
            </Text>
            {resena.comment ? <Text>{resena.comment}</Text> : null}
            {tieneRespuesta(resena) ? (
              <View style={[styles.respuesta, { borderColor: colors.border }]}>
                <Text variant="caption" color="muted">
                  {f('resenaDeProducto.lista.respuestaDelProveedor')}
                </Text>
                <Text>{resena.reply?.body}</Text>
              </View>
            ) : null}
          </View>
        ))}

        {hayMas ? (
          <Button
            label={f('resenaDeProducto.lista.verMas')}
            onPress={() => void verMas()}
            loading={pidiendoMas}
            disabled={pidiendoMas}
          />
        ) : null}
      </ScrollView>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { paddingHorizontal: 0 },
  cuerpo: { padding: spacing.md, gap: spacing.md, paddingBottom: spacing.xl },
  bloque: { gap: spacing.xs },
  tarjeta: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  barraFila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  barraNumero: { minWidth: 24, textAlign: 'center' },
  barraFondo: { flex: 1, height: 8, borderRadius: radius.sm, overflow: 'hidden' },
  barra: { height: 8, borderRadius: radius.sm },
  ejeFila: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  ejeNombre: { flex: 1 },
  respuesta: {
    borderLeftWidth: 2,
    paddingLeft: spacing.sm,
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
});
