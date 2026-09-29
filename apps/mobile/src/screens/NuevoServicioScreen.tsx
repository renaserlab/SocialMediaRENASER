import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { EstadoDelCatalogo } from '@/components/EstadoDelCatalogo';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { toast } from '@/lib/toast';
import { nuevaClave } from '@/lib/serviciosAdmision';
import {
  categoriasEnArbol,
  etiquetaDeCategoria,
  type Categoria,
  type FalloDelCatalogo,
} from '@/lib/serviciosCatalogo';
import { leerFalloDelCatalogo, useCerrojo, useTextosDeServicios } from '@/hooks/useServicios';
import { ServiceCatalogRepository } from '@/repositories/ServiceCatalogRepository';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';

/**
 * «Crear servicio»: se elige la categoría y nace un servicio con su primer
 * BORRADOR, que nadie ve.
 *
 * - Solo se ofrecen las categorías ACTIVAS; si Z aún no creó ninguna, se dice
 *   así en vez de enseñar un formulario que no se puede terminar.
 * - La clave de idempotencia es del INTENTO: un doble toque o un reintento sin
 *   conexión no crea dos servicios.
 * - Si la categoría es de otro país o dejó de estar activa, el servidor lo dice
 *   con palabras (no se adivina aquí).
 */
export function NuevoServicioScreen() {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { f, idioma } = useTextosDeServicios('catalogo');
  const [categorias, setCategorias] = useState<Categoria[] | null>(null);
  const [fallo, setFallo] = useState<FalloDelCatalogo | null>(null);
  const [elegida, setElegida] = useState<string | null>(null);
  const clave = useRef(nuevaClave());

  const cargar = useCallback(async () => {
    setFallo(null);
    try {
      setCategorias(await ServiceCatalogRepository.categorias());
    } catch (error) {
      setFallo(leerFalloDelCatalogo(error));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void cargar();
    }, [cargar]),
  );
  const { ocupado, correr } = useCerrojo(cargar, 'catalogo');

  const volver = () =>
    router.canGoBack() ? router.back() : router.replace('/servicios/prestador/catalogo' as never);

  const crear = () => {
    if (elegida === null) return;
    const categoria = elegida;
    void correr(async () => {
      const servicio = await ServiceCatalogRepository.crear(categoria, clave.current);
      clave.current = nuevaClave();
      toast(f('servicios.catalogo.nuevo.creado'));
      router.replace(`/servicios/prestador/catalogo/${servicio.id}/editar` as never);
    });
  };

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('servicios.catalogo.crear')} onBack={volver} />
      {fallo !== null ? (
        <EstadoDelCatalogo fallo={fallo} onRetry={() => void cargar()} />
      ) : categorias === null ? (
        <StateView state="loading" />
      ) : categorias.length === 0 ? (
        <StateView
          state="empty"
          icon="grid"
          title={f('servicios.catalogo.nuevo.sinCategorias')}
          description={f('servicios.catalogo.nuevo.sinCategoriasCuerpo')}
        />
      ) : (
        <>
          <Text variant="secondary">{f('servicios.catalogo.nuevo.intro')}</Text>
          <Text weight="600">{f('servicios.catalogo.campo.category')}</Text>
          <View style={styles.fila} accessibilityRole="radiogroup">
            {categoriasEnArbol(categorias).map((c) => (
              <Chip
                key={c.id}
                rol="radio"
                label={etiquetaDeCategoria(c, categorias, idioma)}
                selected={elegida === c.id}
                onPress={() => setElegida(c.id)}
              />
            ))}
          </View>
          <Text variant="caption" color={colors.textMuted}>
            {f('servicios.catalogo.nuevo.borradorPrivado')}
          </Text>
          <Button
            label={f('servicios.catalogo.nuevo.crearBorrador')}
            icon="arrow-right"
            loading={ocupado}
            disabled={elegida === null || ocupado}
            onPress={crear}
          />
        </>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  fila: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
