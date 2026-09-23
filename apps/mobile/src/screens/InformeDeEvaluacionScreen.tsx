import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import {
  claveDeDecision,
  claveDeDimension,
  claveDeTipoDeEvidencia,
  filasDelInforme,
  hayPuntuacion,
  momentoLegible,
  puntuacionLegible,
  esInformeApagado,
  esProductosApagado,
  type Informe,
} from '@/lib/productos';
import { ProductCatalogRepository } from '@/repositories/ProductCatalogRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * El informe que abre el sello: la decisión, la puntuación y la evidencia.
 *
 * LA PUNTUACIÓN VIAJA EN CENTÉSIMAS DE PUNTO: 9 000 son 90,00. El servidor no
 * manda un texto con coma a propósito —cómo se escribe un decimal depende del
 * idioma—, así que lo compone `puntuacionLegible`. Pintar el 9 000 en crudo
 * sería enseñar una puntuación de nueve mil sobre cien.
 *
 * `null` NO ES CERO. Sin puntuación registrada se dice eso; un cero se leería
 * como «lo evaluaron y sacó cero», que es una acusación, no un dato.
 *
 * SIN LA NOTA INTERNA DEL EVALUADOR. El contrato no la manda y esta pantalla no
 * la echa de menos: lo que se enseña es qué se miró en cada dimensión, que es
 * lo que hace comprobable el sello.
 *
 * LAS SEIS DIMENSIONES NO SE RELLENAN. Se pinta lo que el servidor mandó, en el
 * orden de la matriz; completar las que falten con ceros diría que se miraron
 * todas.
 */
export function InformeDeEvaluacionScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();
  const { productId } = useLocalSearchParams<{ productId: string }>();

  const [informe, setInforme] = useState<Informe | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noDisponible' | 'noEncontrado' | null
  >(null);

  const cargar = useCallback(async () => {
    if (!productId) return;
    setCargando(true);
    setFallo(null);
    try {
      setInforme(await ProductCatalogRepository.informe(productId));
    } catch (error) {
      if (error instanceof ApiError && esInformeApagado(error.code)) setFallo('noDisponible');
      else if (error instanceof ApiError && esProductosApagado(error.code)) setFallo('noDisponible');
      else if (error instanceof ApiError && error.status === 404) setFallo('noEncontrado');
      else if (error instanceof ApiError && esFalloDeRed(error.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, [productId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/productos' as never));

  if (cargando) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('productos.informe.titulo')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || informe === null) {
    const blando = fallo === 'noDisponible' || fallo === 'noEncontrado';
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('productos.informe.titulo')} onBack={volver} />
        {blando ? (
          <StateView
            state="empty"
            icon={fallo === 'noDisponible' ? 'clock' : 'file-text'}
            title={f(
              fallo === 'noDisponible'
                ? 'productos.informe.noDisponible'
                : 'productos.error.noEncontrado',
            )}
            description={f(
              fallo === 'noDisponible'
                ? 'productos.informe.noDisponibleCuerpo'
                : 'productos.error.noEncontradoCuerpo',
            )}
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

  const leido = informe;

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('productos.informe.titulo')} onBack={volver} />

      {/* El texto del sello, tal como lo manda el servidor. */}
      <Text variant="secondary" weight="700">
        {leido.seal}
      </Text>

      <View style={[styles.tarjeta, { borderColor: colors.border }]}>
        <Text variant="caption" color={colors.textMuted}>
          {f('productos.informe.decisionEtiqueta')}
        </Text>
        <Text variant="titleMedium">{f(claveDeDecision(leido.decision))}</Text>
        {/* CENTÉSIMAS DE PUNTO: 9 000 son 90,00. */}
        {hayPuntuacion(leido) ? (
          <Text variant="secondary">
            {f('productos.informe.puntuacion', {
              valor: puntuacionLegible(leido.score_total, f('productos.separadorDecimal')),
            })}
          </Text>
        ) : (
          <Text variant="caption" color={colors.textMuted}>
            {f('productos.informe.sinPuntuacion')}
          </Text>
        )}
        {leido.decided_at !== null ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('productos.informe.decidido', { momento: momentoLegible(leido.decided_at) })}
          </Text>
        ) : null}
      </View>

      <Text variant="titleMedium">{f('productos.informe.dimensiones')}</Text>
      {filasDelInforme(leido).length === 0 ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('productos.informe.sinDimensiones')}
        </Text>
      ) : (
        filasDelInforme(leido).map((fila) => (
          <View key={fila.dimension} style={[styles.tarjeta, { borderColor: colors.border }]}>
            <Text variant="secondary" weight="700">
              {f(claveDeDimension(fila.dimension))}
            </Text>
            {fila.score !== null ? (
              <Text variant="caption">
                {f('productos.informe.puntuacionDeDimension', { n: fila.score })}
              </Text>
            ) : (
              <Text variant="caption" color={colors.textMuted}>
                {f('productos.informe.sinPuntuacionDeDimension')}
              </Text>
            )}
            {fila.weight !== null ? (
              <Text variant="caption" color={colors.textMuted}>
                {f('productos.informe.peso', { n: fila.weight })}
              </Text>
            ) : null}
            {fila.evidencia.length === 0 ? (
              <Text variant="caption" color={colors.textMuted}>
                {f('productos.informe.sinEvidencia')}
              </Text>
            ) : (
              fila.evidencia.map((e, indice) => (
                <View key={`${fila.dimension}-${indice}`} style={styles.evidencia}>
                  <Text variant="caption" weight="700">
                    {f(claveDeTipoDeEvidencia(e.kind))}
                  </Text>
                  <Text variant="caption" color={colors.textMuted}>
                    {e.summary}
                  </Text>
                </View>
              ))
            )}
          </View>
        ))
      )}

      {/* Lo interno no sale de aquí, y se dice para que no se busque. */}
      <Text variant="caption" color={colors.textMuted}>
        {f('productos.informe.sinNotas')}
      </Text>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  tarjeta: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  evidencia: { gap: spacing.xs },
});
