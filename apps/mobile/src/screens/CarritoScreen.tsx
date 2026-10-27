import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { Image as ExpoImage } from 'expo-image';

import { AppHeader } from '@/components/AppHeader';
import { AppScreen } from '@/components/AppScreen';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import { Text } from '@/components/Text';
import { confirm, notify } from '@/lib/confirm';
import { esFalloDeRed } from '@/lib/entradasDeEvento';
import { toast } from '@/lib/toast';
import {
  CLAVE_SIN_IMPORTE,
  CLAVE_TODAVIA_NO_SE_COMPRA,
  avisoDelCarrito,
  avisosOrdenados,
  cantidadTrasTocar,
  carritoVacio,
  claveDeErrorDelCarrito,
  claveDelAviso,
  esCarritoApagado,
  iconoDelAviso,
  lineaBloqueada,
  precioAnterior,
  precioDeLaLinea,
  sePuedeComprar,
  sePuedeRestar,
  sePuedeSumar,
  subtotalDelCarrito,
  topeDeLaLinea,
  totalDeLaLinea,
  type Carrito,
  type LineaDelCarrito,
} from '@/lib/carrito';
import {
  claveDeErrorDeProductos,
  claveDeErrorPorEstado,
  esFaltaDeSesion,
  sePuedeMostrarLaImagen,
} from '@/lib/productos';
import { ProductCartRepository } from '@/repositories/ProductCartRepository';
import { useClaveDeProductos } from '@/screens/ProductosScreen';
import { radius, spacing } from '@/theme/tokens';
import { useAppTheme } from '@/theme/useAppTheme';
import { useTranslation } from '@/i18n/useTranslation';
import { ApiError } from '@/services/api';

/**
 * Tu bolsa: lo que has ido metiendo, con sus cantidades y su subtotal.
 *
 * AQUÍ NO SE PAGA, Y EL BOTÓN NO LO DICE. Lo que hay es «continuar», que lleva
 * a revisar la dirección y las condiciones; cobrar ocurre después y fuera. Y
 * ese botón SOLO APARECE SI EL SERVIDOR DICE QUE SE PUEDE: cuando la venta está
 * apagada —cinco banderas, una clave de la pasarela y una política publicada—
 * el pie lo dice con palabras en vez de ofrecer un camino que termina en un
 * error. Un botón que prometa pagar sin recorrido detrás cuesta más confianza
 * que su ausencia, y este es el sitio de toda la aplicación donde más se nota.
 *
 * NINGÚN IMPORTE SE CALCULA AQUÍ. Ni el de una línea, ni el subtotal: vienen
 * calculados y esto solo los escribe. Si el cliente multiplicara cantidad por
 * precio, dos versiones instaladas en dos teléfonos podrían enseñar dos totales
 * del mismo carrito, y el que manda es el del servidor.
 *
 * UNA LÍNEA BLOQUEADA SE SIGUE VIENDO ENTERA. Se marca con borde e icono y se
 * explica por qué, pero no desaparece: quitar de la vista lo que no se puede
 * llevar es hacer que se pierda sin decirlo. Desde ahí se puede cambiar la
 * cantidad o quitarla, que es lo único que resuelve el problema.
 *
 * UN CARRITO VACÍO NO ENSEÑA «0.00». `subtotal_minor` llega nulo cuando no hay
 * nada comprable, y un cero con moneda se lee como una compra de cero.
 *
 * CADA MUTACIÓN DEVUELVE LA BOLSA ENTERA y se guarda tal cual. Recomponer aquí
 * la línea tocada y el total es exactamente donde el número que se ve deja de
 * ser el que el servidor calculó.
 */
export function CarritoScreen() {
  const { t } = useTranslation();
  const { colors } = useAppTheme();
  const router = useRouter();
  const f = useClaveDeProductos();

  const [carrito, setCarrito] = useState<Carrito | null>(null);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState<
    'red' | 'sinConexion' | 'noDisponible' | 'sinSesion' | null
  >(null);
  const [ocupado, setOcupado] = useState(false);
  // El cerrojo es una REFERENCIA, no un estado: `useState` se actualiza en el
  // siguiente render y dos toques seguidos pasarían los dos.
  const ocupadoRef = useRef(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setFallo(null);
    try {
      setCarrito(await ProductCartRepository.leer());
    } catch (error) {
      if (error instanceof ApiError && esFaltaDeSesion(error.status)) setFallo('sinSesion');
      else if (error instanceof ApiError && esCarritoApagado(error.code)) setFallo('noDisponible');
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
      // Primero los códigos de la bolsa, que son los que saben decir qué pasó
      // con ESTA línea; luego el camino genérico que ya usan las demás.
      const deLaBolsa = claveDeErrorDelCarrito(error.code);
      if (deLaBolsa !== null) return f(deLaBolsa);
      const porCodigo = claveDeErrorDeProductos(error.code);
      if (porCodigo !== null) return f(porCodigo);
      const porEstado = claveDeErrorPorEstado(error.status);
      if (porEstado !== null) return f(porEstado);
    }
    return error instanceof Error && error.message.trim() !== ''
      ? error.message
      : t('common.tryAgain');
  };

  /**
   * Una mutación de la bolsa, con el cerrojo cerrado ANTES del primer `await`.
   *
   * Lo que conteste el servidor se guarda entero y sin tocar: la respuesta ES
   * la bolsa, con su subtotal y sus avisos recalculados.
   */
  const mutar = (accion: () => Promise<Carrito>, exito?: string) => {
    if (ocupadoRef.current) return;
    ocupadoRef.current = true;
    setOcupado(true);
    void (async () => {
      try {
        setCarrito(await accion());
        if (exito !== undefined) toast(exito);
      } catch (error) {
        notify(f('carrito.noSePudo'), textoDelError(error));
      } finally {
        ocupadoRef.current = false;
        setOcupado(false);
      }
    })();
  };

  /** Tocar «+» o «−». Bajar desde 1 devuelve 0, y 0 QUITA la línea. */
  const tocar = (linea: LineaDelCarrito, paso: 1 | -1) => {
    const cantidad = cantidadTrasTocar(linea, paso);
    if (cantidad === linea.quantity) return;
    if (cantidad === 0) {
      mutar(() => ProductCartRepository.quitar(linea.item_id), f('carrito.quitado'));
      return;
    }
    mutar(() => ProductCartRepository.cambiarCantidad(linea.item_id, cantidad));
  };

  const quitar = (linea: LineaDelCarrito) =>
    mutar(() => ProductCartRepository.quitar(linea.item_id), f('carrito.quitado'));

  /**
   * Vaciar la bolsa, PREGUNTANDO ANTES.
   *
   * Se pregunta con `confirm()` directamente porque esta pantalla no abre
   * ninguna hoja: la trampa de los Modales anidados solo aparece cuando hay una
   * abierta, y entonces hay que cerrarla y esperar antes de preguntar.
   */
  const vaciar = () => {
    if (ocupadoRef.current) return;
    void (async () => {
      const acepta = await confirm({
        title: f('carrito.vaciarTitulo'),
        message: f('carrito.vaciarCuerpo'),
        confirmLabel: f('carrito.vaciarConfirmar'),
        destructive: true,
      });
      if (!acepta) return;
      mutar(() => ProductCartRepository.vaciar(), f('carrito.vaciada'));
    })();
  };

  const volver = () => (router.canGoBack() ? router.back() : router.replace('/productos' as never));

  const encabezado = <AppHeader title={f('carrito.titulo')} onBack={volver} />;

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
            title={f('carrito.error.sinSesion')}
            description={f('carrito.error.sinSesionCuerpo')}
          />
        ) : fallo === 'noDisponible' ? (
          /* La 0075 sin aplicar NO ES UNA AVERÍA: es que esto todavía no está. */
          <StateView
            state="empty"
            icon="clock"
            title={f('carrito.error.noDisponible')}
            description={f('carrito.error.noDisponibleCuerpo')}
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

  if (carritoVacio(carrito)) {
    return (
      <AppScreen contentStyle={styles.contenido}>
        {encabezado}
        <StateView
          state="empty"
          icon="shopping-bag"
          title={f('carrito.vacio')}
          description={f('carrito.vacioCuerpo')}
          onRetry={() => void cargar()}
        />
        {/* TAMBIÉN CON LA BOLSA VACÍA, que es justo como queda después de
            comprar: el servidor retira de la bolsa lo que se acaba de pedir.
            El pie de abajo dice «SIEMPRE, haya o no algo que comprar» y estaba
            dentro de la otra rama, así que quien acababa de pagar se quedaba
            sin ninguna puerta hacia su pedido. */}
        <Pressable
          onPress={() => router.push('/productos/pedidos' as never)}
          accessibilityRole="button"
          accessibilityLabel={f('pedidoDeProducto.accion.verPedidos')}
          style={({ pressed }) => [styles.vaciar, { opacity: pressed ? 0.7 : 1 }]}
        >
          <Feather name="package" size={14} color={colors.text} />
          <Text variant="caption" weight="700">
            {f('pedidoDeProducto.accion.verPedidos')}
          </Text>
        </Pressable>
      </AppScreen>
    );
  }

  const leido = carrito as Carrito;
  const subtotal = subtotalDelCarrito(leido);
  const avisoDeArriba = avisoDelCarrito(leido);

  /** Un botón redondo del control de cantidad. Área táctil de 44×44. */
  const paso = (
    linea: LineaDelCarrito,
    icono: 'plus' | 'minus',
    activo: boolean,
    etiqueta: string,
    alPulsar: () => void,
  ) => (
    <Pressable
      onPress={alPulsar}
      disabled={!activo || ocupado}
      accessibilityRole="button"
      accessibilityLabel={etiqueta}
      accessibilityState={{ disabled: !activo || ocupado }}
      style={({ pressed }) => [
        styles.paso,
        {
          borderColor: colors.border,
          // El apagado se ve también en el icono, que se pinta en el gris de lo
          // deshabilitado: el color nunca es el único que informa.
          opacity: !activo || ocupado ? 0.45 : pressed ? 0.7 : 1,
        },
      ]}
    >
      <Feather name={icono} size={16} color={!activo || ocupado ? colors.disabled : colors.text} />
    </Pressable>
  );

  const tarjeta = (linea: LineaDelCarrito) => {
    const bloqueada = lineaBloqueada(linea);
    const unidad = precioDeLaLinea(linea);
    const antes = precioAnterior(linea);
    const total = totalDeLaLinea(linea);
    const tope = topeDeLaLinea(linea);

    return (
      <View
        key={linea.item_id}
        style={[
          styles.linea,
          {
            borderColor: colors.border,
            // UNA LÍNEA BLOQUEADA SE MARCA CON BORDE, además del icono y del
            // texto que van dentro. Tres señales, ninguna de ellas el color.
            borderWidth: bloqueada ? 2 : 1,
          },
        ]}
      >
        <View style={styles.cabecera}>
          {/* La fotografía aprobada, con la URL que firmó el servidor. La caché
              se indexa por la RUTA, que no cambia en cada firma. */}
          <View
            style={[
              styles.miniatura,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            {sePuedeMostrarLaImagen(linea.image_url) ? (
              <ExpoImage
                source={{ uri: linea.image_url as string, cacheKey: linea.image_path ?? undefined }}
                style={styles.miniaturaImagen}
                contentFit="cover"
                transition={120}
                recyclingKey={linea.image_path ?? undefined}
                accessibilityLabel={linea.alt_text ?? linea.name}
              />
            ) : (
              <Feather name="image" size={20} color={colors.textMuted} />
            )}
          </View>

          <View style={styles.datos}>
            <Text variant="secondary" weight="700" numberOfLines={2}>
              {linea.name}
            </Text>
            <Text variant="caption" color={colors.textMuted} numberOfLines={1}>
              {f('carrito.proveedor', { nombre: linea.seller_name })}
            </Text>
            {linea.variant_name !== null ? (
              <Text variant="caption" numberOfLines={1}>
                {linea.variant_name}
              </Text>
            ) : null}
            {linea.sku !== null ? (
              <Text variant="caption" color={colors.textMuted} numberOfLines={1}>
                {f('carrito.sku', { sku: linea.sku })}
              </Text>
            ) : null}
          </View>
        </View>

        {/* El texto alternativo es un dato real: se enseña cuando no hay foto. */}
        {!sePuedeMostrarLaImagen(linea.image_url) ? (
          <Text variant="caption" color={colors.textMuted} numberOfLines={2}>
            {linea.alt_text ?? f('carrito.imagenSinTexto')}
          </Text>
        ) : null}

        {/* El precio de AHORA y, tachado, el que se veía al añadir. El anterior
            solo aparece si de verdad cambió: si no, es ruido que hace dudar. */}
        <View style={styles.precios}>
          <Text variant="secondary">
            {f('carrito.precioUnidad', {
              texto: unidad.configurado ? unidad.texto : f(CLAVE_SIN_IMPORTE),
            })}
          </Text>
          {antes.configurado ? (
            <Text variant="caption" color={colors.textMuted} style={styles.tachado}>
              {f('carrito.precioAnterior', { texto: antes.texto })}
            </Text>
          ) : null}
        </View>
        <Text variant="titleMedium">
          {f('carrito.totalLinea', {
            texto: total.configurado ? total.texto : f(CLAVE_SIN_IMPORTE),
          })}
        </Text>

        {/* LOS AVISOS: cada uno con su icono y su texto. Los bloqueantes van
            primero porque son los que hay que leer. */}
        {avisosOrdenados(linea).map((aviso) => {
          const icono = iconoDelAviso(aviso);
          return (
            <View key={aviso} style={styles.aviso}>
              {icono !== null ? (
                <Feather
                  name={icono as keyof typeof Feather.glyphMap}
                  size={14}
                  color={colors.text}
                />
              ) : null}
              <Text variant="caption" style={styles.avisoTexto}>
                {f(claveDelAviso(aviso))}
              </Text>
            </View>
          );
        })}

        {bloqueada ? (
          <View style={styles.aviso}>
            <Feather name="slash" size={14} color={colors.text} />
            <Text variant="caption" weight="700" style={styles.avisoTexto}>
              {f('carrito.bloqueada')}
            </Text>
          </View>
        ) : null}

        {/* La cantidad, y por qué el «+» está apagado cuando lo está. `null` no
            es «agotado»: es que ese SKU no tiene inventario cargado. */}
        <View style={styles.cantidad}>
          {paso(linea, 'minus', sePuedeRestar(linea), f('carrito.accion.restar'), () =>
            tocar(linea, -1),
          )}
          <Text
            variant="secondary"
            weight="700"
            style={styles.numero}
            accessibilityLabel={f('carrito.cantidad', { n: linea.quantity })}
          >
            {String(linea.quantity)}
          </Text>
          {paso(linea, 'plus', sePuedeSumar(linea), f('carrito.accion.sumar'), () =>
            tocar(linea, 1),
          )}

          <Pressable
            onPress={() => quitar(linea)}
            disabled={ocupado}
            accessibilityRole="button"
            accessibilityLabel={f('carrito.accion.quitar')}
            style={({ pressed }) => [
              styles.quitar,
              { borderColor: colors.border, opacity: ocupado ? 0.45 : pressed ? 0.7 : 1 },
            ]}
          >
            <Feather name="trash-2" size={14} color={colors.text} />
            <Text variant="caption" weight="700">
              {f('carrito.accion.quitar')}
            </Text>
          </Pressable>
        </View>

        {tope === null ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('carrito.sinExistenciasCargadas')}
          </Text>
        ) : linea.quantity >= tope ? (
          <Text variant="caption" color={colors.textMuted}>
            {f('carrito.enElTope', { n: tope })}
          </Text>
        ) : null}
      </View>
    );
  };

  return (
    <AppScreen scroll={false}>
      {encabezado}

      <ScrollView contentContainerStyle={styles.contenido} showsVerticalScrollIndicator={false}>
        <Text variant="caption" color={colors.textMuted}>
          {f('carrito.cuerpo')}
        </Text>

        {leido.items.map((linea) => tarjeta(linea))}

        {/* Vaciar es destructivo y va como texto, no como botón principal: lo
            principal de esta pantalla es lo que hay dentro. */}
        <Pressable
          onPress={vaciar}
          disabled={ocupado}
          accessibilityRole="button"
          accessibilityLabel={f('carrito.accion.vaciar')}
          style={({ pressed }) => [
            styles.vaciar,
            { opacity: ocupado ? 0.45 : pressed ? 0.7 : 1 },
          ]}
        >
          <Feather name="trash-2" size={14} color={colors.text} />
          <Text variant="caption" weight="700">
            {f('carrito.accion.vaciar')}
          </Text>
        </Pressable>
      </ScrollView>

      {/*
        EL PIE. El subtotal que calculó el servidor y, donde cualquier otra
        tienda pondría «Pagar», la verdad: en Z todavía no se compran productos.
        No hay botón, y no es un olvido.
      */}
      <View style={[styles.pie, { borderColor: colors.border }]}>
        {avisoDeArriba !== null ? (
          <View style={styles.aviso}>
            <Feather name="alert-triangle" size={14} color={colors.text} />
            <Text variant="caption" weight="700" style={styles.avisoTexto}>
              {f(avisoDeArriba)}
            </Text>
          </View>
        ) : null}
        <View style={styles.pieLinea}>
          <Text variant="secondary" color={colors.textMuted}>
            {f('carrito.subtotal')}
          </Text>
          <Text variant="titleMedium">
            {subtotal.configurado ? subtotal.texto : f(CLAVE_SIN_IMPORTE)}
          </Text>
        </View>
        {/*
          EL BOTON SOLO SI HAY RECORRIDO DETRAS. `purchasable` lo escribe la
          ruta, y para escribir `true` hacen falta cinco banderas encendidas y
          una politica publicada. Mientras no las haya, en vez del boton va la
          verdad: en Z todavia no se compran productos.

          Y NO DICE «PAGAR»: dice continuar, porque lo siguiente es revisar la
          direccion y leer las condiciones. Pagar ocurre despues y fuera.
        */}
        {sePuedeComprar(leido) ? (
          <Button
            label={f('carrito.accion.continuar')}
            onPress={() => router.push('/productos/checkout' as never)}
            disabled={ocupado}
            icon="arrow-right"
          />
        ) : (
          <Text variant="caption" color={colors.textMuted}>
            {f(CLAVE_TODAVIA_NO_SE_COMPRA)}
          </Text>
        )}
        {/* SIEMPRE, haya o no algo que comprar: quien ya pidio algo tiene que
            poder llegar a su pedido desde aqui, no solo escribiendo la URL. */}
        <Pressable
          onPress={() => router.push('/productos/pedidos' as never)}
          accessibilityRole="button"
          accessibilityLabel={f('pedidoDeProducto.accion.verPedidos')}
          style={({ pressed }) => [styles.vaciar, { opacity: pressed ? 0.7 : 1 }]}
        >
          <Feather name="package" size={14} color={colors.text} />
          <Text variant="caption" weight="700">
            {f('pedidoDeProducto.accion.verPedidos')}
          </Text>
        </Pressable>
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  contenido: { padding: spacing.lg, gap: spacing.md },
  linea: {
    gap: spacing.sm,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  cabecera: { flexDirection: 'row', gap: spacing.md },
  datos: { flex: 1, gap: 2 },
  miniaturaImagen: { width: '100%', height: '100%' },
  miniatura: {
    width: 64,
    height: 64,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  precios: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  // El precio de antes se TACHA: la forma dice que ya no vale, sin depender del
  // color para decirlo.
  tachado: { textDecorationLine: 'line-through' },
  aviso: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xs },
  avisoTexto: { flex: 1 },
  cantidad: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  paso: {
    minWidth: 44,
    minHeight: 44,
    borderWidth: 1,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  numero: { minWidth: 32, textAlign: 'center' },
  quitar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    minHeight: 44,
    marginLeft: 'auto',
  },
  vaciar: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    minHeight: 44,
  },
  pie: {
    gap: spacing.sm,
    borderTopWidth: 1,
    padding: spacing.lg,
  },
  pieLinea: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
});
