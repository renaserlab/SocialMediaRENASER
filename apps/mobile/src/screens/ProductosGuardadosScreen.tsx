import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { toast } from '@/lib/toast';
import {
  claveDeErrorDeProductos,
  claveDeErrorPorEstado,
  esFaltaDeSesion,
  esGuardadosApagado,
  esProductosApagado,
  type TarjetaDeProducto,
} from '@/lib/productos';
import { ProductCatalogRepository } from '@/repositories/ProductCatalogRepository';
import { CuadriculaDeProductos, useClaveDeProductos } from '@/screens/ProductosScreen';
import { spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * La bolsa: lo que guardé y SIGUE PUBLICADO.
 *
 * NO ES UN CARRITO Y NO RESERVA NADA. Guardar es un marcador; aquí no hay
 * cantidades, ni total, ni nada que lleve a pagar, porque en Z todavía no se
 * compran productos.
 *
 * UN PRODUCTO RETIRADO NO APARECE aunque lo guardaras: el servidor conserva la
 * fila —por si vuelve— pero la lista no promete algo que ya no está. Se dice en
 * una línea, para que no parezca que se perdió lo guardado.
 *
 * SIN SESIÓN NO HAY BOLSA. `GET /products/saved` contesta 401, y eso no es un
 * error que enseñar como avería: es que hay que entrar.
 */
export function ProductosGuardadosScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();

  const [items, setItems] = useState<TarjetaDeProducto[]>([]);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noDisponible' | 'sinSesion' | null
  >(null);
  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      setItems(await ProductCatalogRepository.guardados());
    } catch (error) {
      if (error instanceof ApiError && esFaltaDeSesion(error.status)) setFallo('sinSesion');
      else if (error instanceof ApiError && esProductosApagado(error.code)) setFallo('noDisponible');
      else if (error instanceof ApiError && esFalloDeRed(error.code)) setFallo('sinConexion');
      else setFallo('red');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

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

  /** Quitar de la bolsa. Lo quitado desaparece de la lista, que es la bolsa. */
  const quitar = (tarjeta: TarjetaDeProducto) => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    void (async () => {
      try {
        await ProductCatalogRepository.quitar(tarjeta.product_id);
        setItems((actuales) => actuales.filter((x) => x.product_id !== tarjeta.product_id));
        toast(f('productos.quitado'));
      } catch (error) {
        if (error instanceof ApiError && esGuardadosApagado(error.code)) {
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

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/productos' as never));

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('productos.guardados.titulo')} onBack={volver} />

      {cargando ? (
        <StateView state="loading" />
      ) : fallo === 'sinSesion' ? (
        <StateView
          state="empty"
          icon="lock"
          title={f('productos.error.sinSesion')}
          description={f('productos.error.sinSesionCuerpo')}
        />
      ) : fallo === 'noDisponible' ? (
        <StateView
          state="empty"
          icon="clock"
          title={f('productos.error.guardadosNoDisponibles')}
          description={f('productos.error.guardadosNoDisponiblesCuerpo')}
        />
      ) : fallo !== null ? (
        <StateView
          state={fallo === 'sinConexion' ? 'offline' : 'error'}
          description={fallo === 'sinConexion' ? undefined : t('common.loadFailed')}
          onRetry={() => void cargar()}
        />
      ) : items.length === 0 ? (
        <StateView
          state="empty"
          icon="bookmark"
          title={f('productos.guardados.vacio')}
          description={f('productos.guardados.vacioCuerpo')}
        />
      ) : (
        <>
          <Text variant="caption" color={colors.textMuted}>
            {f('productos.guardados.cuerpo')}
          </Text>
          {/* Lo retirado deja de aparecer: se dice para que no parezca perdido. */}
          <Text variant="caption" color={colors.textMuted}>
            {f('productos.guardados.retirado')}
          </Text>
          <CuadriculaDeProductos
            tarjetas={items}
            onAbrir={(id) => router.push(`/productos/${id}` as never)}
            onGuardar={quitar}
            ocupado={ocupado}
          />
        </>
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
});
