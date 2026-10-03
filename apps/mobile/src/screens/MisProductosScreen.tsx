import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { toast } from '@/lib/toast';
import {
  accionesOfrecidas,
  claveDeAccionDeProducto,
  claveDeErrorDeProveedor,
  claveDeErrorPorEstado,
  claveDelBloqueo,
  claveDelCuerpoDelEstadoDeProducto,
  claveDelEstadoDeProducto,
  esProductosApagado,
  esProveedorActivo,
  etiquetaDeVersion,
  fechaLegible,
  hayQueRecargar,
  precioLegible,
  publicaAlEnviar,
  sePuedeEditarProducto,
  sePuedePostularProducto,
  sonCambiosDeUnPublicado,
  versionQueSeEnsena,
  type EstadoDelProveedor,
  type ProductoDelProveedor,
} from '@/lib/proveedorDeProductos';
import { ProductSellerRepository } from '@/repositories/ProductSellerRepository';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import type { TranslationKey } from '@/i18n';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Mis productos: en qué punto está cada uno y qué se puede hacer con él.
 *
 * LO QUE SE PUEDE HACER LO MANDA EL SERVIDOR. `acciones` viene de la máquina de
 * estados con el actor `seller`, y aquí solo se pintan las que además tienen una
 * ruta de proveedor: postular y retirar. «Editar» no está en esa lista porque no
 * es una transición: es `states.EDITABLES`, y vale solo en borrador. Un botón de
 * editar sobre un producto que alguien está evaluando cambiaría el objeto de la
 * evaluación a mitad de camino.
 *
 * EL BLOQUEO SE CUENTA, NO SE ESCONDE. `bloqueo` es un código —falta la
 * evaluación, faltan las tres razones, falta una fotografía— y se traduce tal
 * cual. Es lo que explica por qué un producto aprobado todavía no lleva el
 * sello, y ocultarlo dejaría a quien produce esperando sin saber qué falta.
 *
 * PUBLICAR NO ESTÁ AQUÍ, Y NO ES UN OLVIDO. Publicar exige una evaluación
 * aprobada de esa versión, sus tres razones respaldadas por evidencia y una
 * fotografía real, y lo hace administración. El sello de Z no se lo pone uno
 * mismo.
 *
 * Y NO HAY EXISTENCIAS, NI ENVÍOS, NI PEDIDOS, NI SALDOS. No existen todavía en
 * la API; una fila que dijera «0 pedidos» prometería una operación que no hay.
 */
export function MisProductosScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();

  const f = useCallback(
    (clave: string, params?: Record<string, string | number>) =>
      t(clave as TranslationKey, params),
    [t],
  );

  const [productos, setProductos] = useState<ProductoDelProveedor[] | null>(null);
  const [estado, setEstado] = useState<EstadoDelProveedor | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'sinPermiso' | 'sinSesion' | 'noDisponible' | null
  >(null);

  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);

  const leerFallo = (error: unknown) => {
    if (error instanceof ApiError && esProductosApagado(error.code)) {
      return 'noDisponible' as const;
    }
    if (error instanceof ApiError && error.status === 401) return 'sinSesion' as const;
    if (error instanceof ApiError && error.status === 403) return 'sinPermiso' as const;
    if (error instanceof ApiError && esFalloDeRed(error.code)) return 'sinConexion' as const;
    return 'red' as const;
  };

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      /*
        LOS DOS, Y EN ESTE ORDEN. La lista llega vacía tanto si no hay productos
        como si todavía no hay capacidad comercial, y son dos pantallas
        distintas: la segunda tiene que llevar a postular, no decir «crea tu
        primer producto» a quien no puede crear ninguno.
      */
      const leido = await ProductSellerRepository.estado();
      setEstado(leido);
      setProductos(await ProductSellerRepository.misProductos());
    } catch (error) {
      setFallo(leerFallo(error));
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const textoDelError = (error: unknown) => {
    if (error instanceof ApiError) {
      const porCodigo = claveDeErrorDeProveedor(error.code);
      if (porCodigo !== null) return f(porCodigo);
      const porEstado = claveDeErrorPorEstado(error.status);
      if (porEstado !== null) return f(porEstado);
    }
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  const conCerrojo = async (trabajo: () => Promise<void>) => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    try {
      await trabajo();
    } catch (error) {
      notify(f('proveedorProductos.productos.noSePudo'), textoDelError(error));
      if (error instanceof ApiError && hayQueRecargar(error.status, error.code)) {
        await cargar();
      }
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  /** El texto del botón de enviar: postular, o publicar en modo flexible. */
  const etiquetaDeEnviar = (producto: ProductoDelProveedor) =>
    publicaAlEnviar(producto)
      ? f(
          sonCambiosDeUnPublicado(producto)
            ? 'proveedorProductos.productos.publicarCambios'
            : 'proveedorProductos.productos.publicar',
        )
      : f('proveedorProductos.marca.postula');

  /**
   * «Postula tu producto»: lo manda a admisión y deja de ser editable. En
   * MODO FLEXIBLE lo publica (o publica sus cambios) y sigue siendo editable.
   */
  const postular = (producto: ProductoDelProveedor) =>
    void conCerrojo(async () => {
      const publicaYa = publicaAlEnviar(producto);
      const aceptado = await confirm({
        title: publicaYa
          ? f('proveedorProductos.productos.publicarTitulo')
          : f('proveedorProductos.productos.postularTitulo'),
        // EL AVISO VA ANTES: al postular deja de poder editarse.
        message: publicaYa
          ? f('proveedorProductos.productos.publicarAviso')
          : f('proveedorProductos.productos.postularAviso'),
        confirmLabel: etiquetaDeEnviar(producto),
      });
      if (!aceptado) return;
      const resultado = await ProductSellerRepository.postularProducto(producto.id);
      toast(
        resultado.status === 'published'
          ? f('proveedorProductos.productos.publicadoAhora')
          : f('proveedorProductos.productos.postulado'),
      );
      await cargar();
    });

  /** Devolverlo a borrador. No es retirarlo del catálogo. */
  const retirar = (producto: ProductoDelProveedor) =>
    void conCerrojo(async () => {
      const aceptado = await confirm({
        title: f('proveedorProductos.productos.retirarTitulo'),
        message: f('proveedorProductos.productos.retirarAviso'),
        confirmLabel: f('proveedorProductos.accion.draft'),
        destructive: true,
      });
      if (!aceptado) return;
      await ProductSellerRepository.retirarProducto(producto.id);
      toast(f('proveedorProductos.productos.retirado'));
      await cargar();
    });

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/'));

  // A pantalla completa SOLO la primera vez. Postular o retirar un producto
  // vuelve a pedir la lista, y cambiarla entera por «Cargando…» la devolvía
  // arriba del todo después de cada acción.
  if (cargando && productos === null) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('proveedorProductos.productos.titulo')} onBack={volver} />
        <StateView state="loading" />
      </AppScreen>
    );
  }

  if (fallo !== null || productos === null) {
    const blando = fallo === 'noDisponible' || fallo === 'sinPermiso' || fallo === 'sinSesion';
    const titulo =
      fallo === 'noDisponible'
        ? f('proveedorProductos.error.noDisponible')
        : fallo === 'sinSesion'
          ? f('proveedorProductos.error.sinSesion')
          : f('proveedorProductos.error.sinPermiso');
    const cuerpo =
      fallo === 'noDisponible'
        ? f('proveedorProductos.error.noDisponibleCuerpo')
        : fallo === 'sinSesion'
          ? f('proveedorProductos.error.sinSesionCuerpo')
          : f('proveedorProductos.error.sinPermisoCuerpo');
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('proveedorProductos.productos.titulo')} onBack={volver} />
        {blando ? (
          <StateView
            state="empty"
            icon={fallo === 'noDisponible' ? 'clock' : 'lock'}
            title={titulo}
            description={cuerpo}
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

  /* TODAVÍA NO ES RESPONSABLE COMERCIAL. La lista vacía no se cuenta como
     «no tienes productos»: lo que falta es la admisión. */
  if (!esProveedorActivo(estado)) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        <AppHeader title={f('proveedorProductos.productos.titulo')} onBack={volver} />
        <StateView
          state="empty"
          icon="award"
          title={f('proveedorProductos.productos.sinCapacidad')}
          description={f('proveedorProductos.productos.sinCapacidadCuerpo')}
        />
        <Button
          label={f('proveedorProductos.marca.postula')}
          onPress={() => router.push('/proveedor/postular' as never)}
        />
      </AppScreen>
    );
  }

  /** Un producto, con su estado, su bloqueo y sus acciones. */
  const tarjeta = (producto: ProductoDelProveedor) => {
    const acciones = accionesOfrecidas(producto);
    const version = versionQueSeEnsena(producto);
    const bloqueo = claveDelBloqueo(producto.bloqueo);
    const precio = precioLegible(version);
    return (
      <View
        key={producto.id}
        style={[styles.tarjeta, { borderColor: colors.border }]}
        accessibilityLabel={f('proveedorProductos.productos.tarjeta', {
          nombre: version?.name ?? f('proveedorProductos.productos.sinNombre'),
          estado: f(claveDelEstadoDeProducto(producto.status)),
        })}
      >
        <View style={styles.linea}>
          <Text variant="secondary" weight="700">
            {version?.name ?? f('proveedorProductos.productos.sinNombre')}
          </Text>
          <Text variant="caption" color={colors.textMuted}>
            {f(claveDelEstadoDeProducto(producto.status))}
          </Text>
        </View>

        <Text variant="caption" color={colors.textMuted}>
          {f(claveDelCuerpoDelEstadoDeProducto(producto.status))}
        </Text>

        {version !== null && etiquetaDeVersion(version.version) !== '' ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('proveedorProductos.productos.version', {
              version: etiquetaDeVersion(version.version),
            })}
          </Text>
        ) : null}

        {/* SIN PRECIO NO ES GRATIS: es que todavía no se ha configurado. */}
        {precio !== null ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('proveedorProductos.productos.precio', { precio })}
          </Text>
        ) : (
          <Text variant="caption" color={colors.textMuted}>
            {f('proveedorProductos.productos.sinPrecio')}
          </Text>
        )}

        {version !== null ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('proveedorProductos.productos.contenido', {
              variantes: version.variants.length,
              fotos: version.gallery.length,
            })}
          </Text>
        ) : (
          <Text variant="caption" color={colors.textMuted}>
            {f('proveedorProductos.productos.sinBorrador')}
          </Text>
        )}

        {producto.published_at !== null ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('proveedorProductos.productos.publicadoEl', {
              fecha: fechaLegible(producto.published_at),
            })}
          </Text>
        ) : null}

        {producto.suspension_reason !== null ? (
          <Text variant="caption" color={colors.danger}>
            {f('proveedorProductos.productos.suspension', {
              motivo: producto.suspension_reason,
            })}
          </Text>
        ) : null}

        {/* POR QUÉ TODAVÍA NO SE PUEDE PUBLICAR, traducido. */}
        {bloqueo !== null ? (
          <View style={[styles.tarjeta, { borderColor: colors.border }]}>
            <Text variant="caption" weight="700">
              {f('proveedorProductos.productos.bloqueoTitulo')}
            </Text>
            <Text variant="caption" color={colors.textMuted}>
              {f(bloqueo)}
            </Text>
          </View>
        ) : null}

        {sePuedeEditarProducto(producto) ? (
          <Button
            label={f('proveedorProductos.productos.editar')}
            variant="secondary"
            icon="edit-2"
            onPress={() => router.push(`/proveedor/productos/${producto.id}` as never)}
            disabled={ocupado}
          />
        ) : (
          <Text variant="caption" color={colors.textMuted}>
            {f('proveedorProductos.productos.noEditable')}
          </Text>
        )}

        {/*
          EL INVENTARIO SE LLEVA AUNQUE EL PRODUCTO YA NO SE EDITE. Las
          existencias son de la variante, no del borrador: un producto publicado
          es justo el que más necesita que se puedan cargar y ajustar. Por eso el
          acceso está aquí y no en el editor, que se cierra en cuanto el producto
          sale de borrador.
        */}
        <Button
          label={f('inventario.acceso')}
          variant="secondary"
          icon="layers"
          onPress={() =>
            router.push(`/proveedor/productos/${producto.id}/inventario` as never)
          }
          disabled={ocupado}
        />

        {sePuedePostularProducto(producto) ? (
          <Button
            label={
              publicaAlEnviar(producto)
                ? etiquetaDeEnviar(producto)
                : f(claveDeAccionDeProducto('submitted'))
            }
            onPress={() => postular(producto)}
            disabled={ocupado}
          />
        ) : null}
        {acciones.includes('draft') ? (
          <Button
            label={f(claveDeAccionDeProducto('draft'))}
            variant="ghost"
            onPress={() => retirar(producto)}
            disabled={ocupado}
          />
        ) : null}
      </View>
    );
  };

  return (
    <AppScreen contentStyle={styles.contenido}>
      <AppHeader title={f('proveedorProductos.productos.titulo')} onBack={volver} />

      <View style={[styles.tarjeta, { borderColor: colors.border }]}>
        <Text variant="secondary" weight="700">
          {f('proveedorProductos.marca.creadores')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('proveedorProductos.productos.cuerpo')}
        </Text>
        <Text variant="caption" color={colors.textMuted}>
          {f('proveedorProductos.marca.evaluado')}
        </Text>
      </View>

      <Button
        label={f('proveedorProductos.productos.crear')}
        icon="plus"
        onPress={() => router.push('/proveedor/productos/nuevo' as never)}
        disabled={ocupado}
      />

      {/* LOS PEDIDOS DE MI TIENDA, DESDE AQUÍ.
          El acceso va en esta pantalla y no dentro de un producto porque un
          pedido puede llevar varios: colgarlo de uno haría que el mismo pedido
          apareciera dos veces y que quien tiene un producto nuevo sin vender no
          encontrara nunca la lista.

          Y SE ENSEÑA SIEMPRE, también sin pedidos: una ruta que solo funciona
          escribiendo la URL no está terminada, y la pantalla vacía explica que
          todavía no hay nada que preparar. */}
      <Button
        label={f('envio.proveedor.acceso')}
        icon="truck"
        variant="secondary"
        onPress={() => router.push('/proveedor/pedidos' as never)}
        disabled={ocupado}
      />

      {/* Y LAS RECLAMACIONES, AL LADO DE LOS PEDIDOS. Por lo mismo: una
          reclamación puede ser de cualquier producto, y se enseña siempre
          aunque no haya ninguna. Lo que se hace ahí es RESPONDER, no resolver:
          la decisión la registra Z. */}
      <Button
        label={f('incidencia.proveedor.acceso')}
        icon="alert-circle"
        variant="secondary"
        onPress={() => router.push('/proveedor/reclamaciones' as never)}
        disabled={ocupado}
      />

      {/* Y LO QUE OPINAN, AL LADO. Aqui solo se RESPONDE: no hay forma de
          cambiar ni de esconder lo que escribio quien compro, y la pantalla lo
          dice antes de entrar. */}
      <Button
        label={f('resenaDeProducto.tienda.titulo')}
        icon="star"
        variant="secondary"
        onPress={() => router.push('/proveedor/resenas' as never)}
        disabled={ocupado}
      />

      {/* Y SU SALDO. La pantalla explica que sin comision decidida no hay
          balance: preferimos no ensenar una cifra antes de que sea de verdad. */}
      <Button
        label={f('finanzaDeProducto.titulo')}
        icon="credit-card"
        variant="secondary"
        onPress={() => router.push('/proveedor/finanzas' as never)}
        disabled={ocupado}
      />

      {productos.length === 0 ? (
        <StateView
          state="empty"
          icon="package"
          title={f('proveedorProductos.productos.sinProductos')}
          description={f('proveedorProductos.productos.sinProductosCuerpo')}
          onRetry={() => void cargar()}
        />
      ) : (
        productos.map(tarjeta)
      )}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  linea: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    minHeight: 44,
  },
  tarjeta: {
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
});
