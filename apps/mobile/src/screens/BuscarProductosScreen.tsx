import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Input } from '@/components/Input';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { toast } from '@/lib/toast';
import {
  LARGO_MINIMO_DE_LA_BUSQUEDA,
  POR_PAGINA,
  categoriasOfrecidas,
  claveDeErrorDeProductos,
  claveDeErrorPorEstado,
  conGuardado,
  consultaUtil,
  esFaltaDeSesion,
  esGuardadosApagado,
  esProductosApagado,
  hayMasPaginas,
  sePuedeBuscar,
  unirPaginas,
  type Busqueda,
  type Categoria,
  type TarjetaDeProducto,
} from '@/lib/productos';
import { ProductCatalogRepository } from '@/repositories/ProductCatalogRepository';
import { CuadriculaDeProductos, useClaveDeProductos } from '@/screens/ProductosScreen';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Buscar en Productos Z, con filtro de categoría y paginación POR CURSOR.
 *
 * EL FILTRO LO APLICA EL SERVIDOR. Aquí solo se manda `q` y `category_id` y se
 * pinta lo que conteste: filtrar en el teléfono dejaría que una versión vieja
 * enseñara algo que Z retiró.
 *
 * CON UNA LETRA NO SE BUSCA, igual que en `catalog.buscar`: el servidor
 * devuelve la lista vacía y parecería un buscador roto. Se dice antes, con el
 * número exacto de letras que hacen falta.
 *
 * EL CURSOR NO ES UNA PÁGINA. Es el identificador del último producto de la
 * página anterior; paginar por desplazamiento repite filas y se salta otras
 * cuando alguien publica a mitad. Y aun así la página siguiente puede traer
 * algo repetido, así que se une SIN REPETIR.
 *
 * CATEGORÍAS VACÍAS NO ES UN FALLO: es que la empresa todavía no las ha
 * definido, y se dice así en vez de enseñar una barra de filtros vacía.
 */
export function BuscarProductosScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();

  const [escrito, setEscrito] = useState('');
  const [categoria, setCategoria] = useState<string | null>(null);
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [items, setItems] = useState<TarjetaDeProducto[]>([]);
  const [pagina, setPagina] = useState<Busqueda | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<'red' | 'sinConexion' | 'noDisponible' | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const leerFallo = (error: unknown) => {
    if (error instanceof ApiError && esProductosApagado(error.code)) return 'noDisponible' as const;
    if (error instanceof ApiError && esFalloDeRed(error.code)) return 'sinConexion' as const;
    return 'red' as const;
  };

  const textoDelError = (error: unknown) => {
    if (error instanceof ApiError) {
      const porCodigo = claveDeErrorDeProductos(error.code);
      if (porCodigo !== null) return f(porCodigo);
      const porEstado = claveDeErrorPorEstado(error.status);
      if (porEstado !== null) return f(porEstado);
    }
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  /** La primera página de lo que hay escrito ahora. */
  const buscar = useCallback(
    async (texto: string, categoriaId: string | null) => {
      setCargando(true);
      setFallo(null);
      try {
        const leida = await ProductCatalogRepository.buscar({
          q: consultaUtil(texto),
          categoryId: categoriaId,
          limit: POR_PAGINA,
        });
        setItems(leida.items);
        setPagina(leida);
      } catch (error) {
        setFallo(leerFallo(error));
      } finally {
        setCargando(false);
      }
    },
    [],
  );

  useEffect(() => {
    void (async () => {
      try {
        setCategorias(categoriasOfrecidas(await ProductCatalogRepository.categorias()));
      } catch {
        // Sin categorías se busca igual: no es un error de la búsqueda.
        setCategorias([]);
      }
    })();
    void buscar('', null);
  }, [buscar]);

  /** La página siguiente, que se PEGA a lo que ya había sin repetir. */
  const verMas = () => {
    if (pagina === null || !hayMasPaginas(pagina) || ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    void (async () => {
      try {
        const siguiente = await ProductCatalogRepository.buscar({
          q: consultaUtil(escrito),
          categoryId: categoria,
          cursor: pagina.next_cursor,
          limit: POR_PAGINA,
        });
        setItems((actuales) => unirPaginas(actuales, siguiente.items));
        setPagina(siguiente);
      } catch (error) {
        notify(f('productos.noSePudo'), textoDelError(error));
      } finally {
        ocupadoRef.current = false;
        setOcupado(false);
      }
    })();
  };

  const alternarGuardado = (tarjeta: TarjetaDeProducto) => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    void (async () => {
      try {
        const resultado = tarjeta.saved
          ? await ProductCatalogRepository.quitar(tarjeta.product_id)
          : await ProductCatalogRepository.guardar(tarjeta.product_id);
        setItems((actuales) => conGuardado(actuales, tarjeta.product_id, resultado.saved));
        toast(f(resultado.saved ? 'productos.guardado' : 'productos.quitado'));
      } catch (error) {
        if (error instanceof ApiError && esFaltaDeSesion(error.status)) {
          notify(f('productos.error.sinSesion'), f('productos.error.sinSesionCuerpo'));
        } else if (error instanceof ApiError && esGuardadosApagado(error.code)) {
          notify(
            f('productos.error.guardadosNoDisponibles'),
            f('productos.error.guardadosNoDisponiblesCuerpo'),
          );
        } else {
          notify(f('productos.noSePudo'), textoDelError(error));
        }
      } finally {
        ocupadoRef.current = false;
        setOcupado(false);
      }
    })();
  };

  const elegirCategoria = (id: string | null) => {
    setCategoria(id);
    void buscar(escrito, id);
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/productos' as never));
  const puedeBuscar = sePuedeBuscar(escrito, categoria);
  const cortoDeLetras = escrito.trim() !== '' && consultaUtil(escrito) === null;

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('productos.buscar.titulo')} onBack={volver} />

      <Input
        label={f('productos.buscar.campo')}
        placeholder={f('productos.buscar.ayuda')}
        value={escrito}
        onChangeText={setEscrito}
        autoCorrect={false}
        returnKeyType="search"
        onSubmitEditing={() => {
          if (puedeBuscar) void buscar(escrito, categoria);
        }}
        editable={!ocupado}
      />
      {cortoDeLetras ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('productos.buscar.minimo', { n: LARGO_MINIMO_DE_LA_BUSQUEDA })}
        </Text>
      ) : null}
      <Button
        label={f('productos.buscar.boton')}
        icon="search"
        onPress={() => void buscar(escrito, categoria)}
        disabled={!puedeBuscar || ocupado}
      />

      {categorias.length === 0 ? (
        <Text variant="caption" color={colors.textMuted}>
          {f('productos.buscar.sinCategorias')}
        </Text>
      ) : (
        <View style={styles.chips}>
          <Chip
            label={f('productos.buscar.todasLasCategorias')}
            rol="radio"
            selected={categoria === null}
            disabled={ocupado}
            onPress={() => elegirCategoria(null)}
          />
          {categorias.map((c) => (
            <Chip
              key={c.id}
              label={c.name}
              rol="radio"
              selected={categoria === c.id}
              disabled={ocupado}
              onPress={() => elegirCategoria(c.id)}
            />
          ))}
        </View>
      )}

      {cargando ? (
        <StateView state="loading" />
      ) : fallo !== null ? (
        fallo === 'noDisponible' ? (
          <StateView
            state="empty"
            icon="clock"
            title={f('productos.noDisponible')}
            description={f('productos.noDisponibleCuerpo')}
          />
        ) : (
          <StateView
            state={fallo === 'sinConexion' ? 'offline' : 'error'}
            description={fallo === 'sinConexion' ? undefined : t('common.loadFailed')}
            onRetry={() => void buscar(escrito, categoria)}
          />
        )
      ) : items.length === 0 ? (
        <StateView
          state="empty"
          icon="search"
          title={f('productos.buscar.sinResultados')}
          description={f('productos.buscar.sinResultadosCuerpo')}
        />
      ) : (
        <>
          <CuadriculaDeProductos
            tarjetas={items}
            onAbrir={(id) => router.push(`/productos/${id}` as never)}
            onGuardar={alternarGuardado}
            ocupado={ocupado}
          />
          {hayMasPaginas(pagina) ? (
            <Button
              label={f('productos.buscar.masResultados')}
              variant="secondary"
              onPress={verMas}
              loading={ocupado}
              disabled={ocupado}
            />
          ) : (
            <Text variant="caption" color={colors.textMuted}>
              {f('productos.buscar.finDeLaLista')}
            </Text>
          )}
        </>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
