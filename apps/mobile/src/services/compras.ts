/**
 * Comprar un curso, de principio a fin.
 *
 * Ata las tres piezas: que vende el servidor, que cobra la tienda y quien
 * concede el acceso. El orden NO es negociable:
 *
 *   1. Se le pregunta al SERVIDOR que producto corresponde a este curso en
 *      esta plataforma. Si no hay, se dice; no se inventa un boton.
 *   2. Se compra con el SDK de la tienda.
 *   3. Se le pide al SERVIDOR que sincronice. **El paso 3 es el unico que
 *      concede acceso.**
 *
 * ## Por que el paso 3 existe
 *
 * Porque el paso 2 ocurre en un telefono, y un telefono se puede modificar.
 * Que el SDK diga «comprado» es una pista, no una prueba: el servidor lo
 * comprueba contra RevenueCat con su clave secreta antes de abrir nada. Si el
 * paso 3 falla, la compra NO se pierde —esta en la tienda— y la siguiente
 * sincronizacion la recupera. Por eso el mensaje de error dice eso y no «no se
 * ha podido comprar», que seria mentira y ademas asustaria a quien acaba de
 * pagar.
 */

import { Platform } from 'react-native';

import { CommerceRepository } from '@/repositories/PaymentRepository';
import type { ProductoDisponible } from '@/repositories/PaymentRepository';
import { comprasHabilitadas } from '@/services/comprasConfig';
import * as revenueCat from '@/services/revenueCat';

export type PlataformaDeCompra = 'ios' | 'android' | 'web';

export function plataformaDeCompra(): PlataformaDeCompra {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return 'web';
}

export function esMovil(): boolean {
  return plataformaDeCompra() !== 'web';
}

/**
 * Lo que la pantalla necesita saber para pintar el bloque de compra.
 *
 * `motivo` viaja siempre que no se pueda comprar, porque la regla es que la
 * interfaz lo DIGA. Un botón desactivado sin explicación es lo mismo que un
 * botón muerto.
 */
export type OfertaDeCompra = {
  sePuedeComprar: boolean;
  /** Precio ya formateado para ensenar. De la TIENDA en movil, del catalogo en web. */
  precio: string | null;
  /** Identificador en la tienda, si lo hay. */
  productoDeTienda: string | null;
  motivo: string;
  plataforma: PlataformaDeCompra;
};

/** Los motivos que sabe explicar la pantalla, en castellano. */
export const MOTIVOS: Record<string, string> = {
  gratuito: 'Este curso es gratuito.',
  ya_comprado: 'Ya tienes este curso.',
  sin_producto:
    'La compra de este curso todavía no está disponible en esta plataforma.',
  pagos_apagados: 'Las compras no están disponibles ahora mismo.',
  no_publicado: 'Este curso todavía no está a la venta.',
  no_aprobado: 'Este curso todavía no está a la venta.',
  sin_tienda: 'Las compras no están disponibles en esta versión de la aplicación.',
  sin_precio: 'No se ha podido consultar el precio en la tienda.',
};

export function explicar(motivo: string): string {
  return MOTIVOS[motivo] ?? 'La compra no está disponible ahora mismo.';
}

function formatearPrecioDeCatalogo(minor: number, moneda: string): string {
  // Se divide al final y solo para pintar: los calculos de dinero se hacen en
  // enteros, porque los decimales en coma flotante acaban en descuadres.
  return `${(minor / 100).toFixed(2)} ${moneda}`;
}

/**
 * Que se le puede ofrecer a esta persona para este curso.
 *
 * En movil el precio sale del `StoreProduct` —localizado por la tienda, con su
 * moneda y sus impuestos—, NO de `price_minor`. Ensenar el del catalogo seria
 * ensenar un numero distinto del que se va a cobrar.
 */
export async function ofertaPara(courseId: string): Promise<OfertaDeCompra> {
  const plataforma = plataformaDeCompra();

  if (!comprasHabilitadas()) {
    return {
      sePuedeComprar: false,
      precio: null,
      productoDeTienda: null,
      motivo: 'pagos_apagados',
      plataforma,
    };
  }

  let producto: ProductoDisponible;
  try {
    producto = await CommerceRepository.product(courseId, plataforma);
  } catch {
    return {
      sePuedeComprar: false,
      precio: null,
      productoDeTienda: null,
      motivo: 'pagos_apagados',
      plataforma,
    };
  }

  if (!producto.available) {
    return {
      sePuedeComprar: false,
      precio: null,
      productoDeTienda: producto.productId,
      motivo: producto.reason || 'sin_producto',
      plataforma,
    };
  }

  if (plataforma === 'web') {
    return {
      sePuedeComprar: true,
      precio: formatearPrecioDeCatalogo(producto.priceMinor, producto.currency),
      productoDeTienda: null,
      motivo: '',
      plataforma,
    };
  }

  // Movil: hace falta el modulo nativo. En Expo Go no esta, y eso se dice.
  if (!revenueCat.tiendaDisponible()) {
    return {
      sePuedeComprar: false,
      precio: null,
      productoDeTienda: producto.productId,
      motivo: 'sin_tienda',
      plataforma,
    };
  }

  const enLaTienda = producto.productId
    ? await revenueCat.producto(producto.productId)
    : null;
  if (!enLaTienda) {
    // El producto esta dado de alta en nuestro servidor pero la tienda no lo
    // devuelve: suele ser que falta darlo de alta en Play Console o App Store
    // Connect, o que todavia no se ha propagado. Se dice; no se ensena un
    // boton que fallaria al pulsarlo.
    return {
      sePuedeComprar: false,
      precio: null,
      productoDeTienda: producto.productId,
      motivo: 'sin_precio',
      plataforma,
    };
  }

  return {
    sePuedeComprar: true,
    // EL PRECIO DE LA TIENDA, no `price_minor`.
    precio: enLaTienda.precio,
    productoDeTienda: enLaTienda.identificador,
    motivo: '',
    plataforma,
  };
}

export type ResultadoDeCompraCompleta =
  /**
   * `concedidos` es CUÁNTOS accesos ha dado el servidor de verdad, y existe
   * porque sin ese número no se podía distinguir «restauré tus compras» de
   * «pregunté y no había ninguna». Las dos terminaban diciendo lo mismo.
   */
  | { estado: 'comprada'; concedidos: number }
  | { estado: 'cancelada' }
  | { estado: 'pendiente_de_sincronizar' }
  | { estado: 'error'; mensaje: string };

/**
 * Compra en movil y sincroniza con el servidor.
 *
 * **Cancelar no es un error** y se devuelve como tal, para que la pantalla no
 * ensene «algo ha ido mal» a quien simplemente se lo penso.
 */
export async function comprarEnTienda(
  productoDeTienda: string,
): Promise<ResultadoDeCompraCompleta> {
  const resultado = await revenueCat.comprar(productoDeTienda);
  if (resultado.estado === 'cancelada') return { estado: 'cancelada' };
  if (resultado.estado === 'error') {
    return { estado: 'error', mensaje: resultado.mensaje };
  }
  return sincronizar();
}

/**
 * Restaura las compras y reconstruye los accesos.
 *
 * Tiene que funcionar tras reinstalar, tras cambiar de telefono y tras cerrar
 * y volver a iniciar sesion, siempre con la misma cuenta de Z. Lo que lo hace
 * posible es que el `appUserID` sea el UUID de Supabase: no cambia nunca.
 */
export async function restaurarCompras(): Promise<ResultadoDeCompraCompleta> {
  if (!esMovil()) {
    return { estado: 'error', mensaje: 'Restaurar compras es solo para móvil.' };
  }
  const ok = await revenueCat.restaurar();
  if (!ok) {
    return {
      estado: 'error',
      mensaje: 'No se pudo contactar con la tienda. Inténtalo de nuevo.',
    };
  }
  return sincronizar();
}

/**
 * Le pide al servidor que reconcilie. Es lo unico que concede acceso.
 *
 * Si falla, la compra NO se ha perdido: esta en la tienda y la proxima
 * sincronizacion la recupera. El estado `pendiente_de_sincronizar` existe para
 * poder decir eso exactamente, en vez de «no se ha podido comprar».
 */
export async function sincronizar(): Promise<ResultadoDeCompraCompleta> {
  const plataforma = plataformaDeCompra();
  if (plataforma === 'web') return { estado: 'error', mensaje: 'Solo móvil.' };
  try {
    // SE MIRA LO QUE CONTESTA, no solo que no falle. El resultado se tiraba y
    // se devolvía «comprada» con que la petición no reventara, así que quien
    // pulsaba «Restaurar compras» sin ninguna compra en esa cuenta de la tienda
    // leía «Compras restauradas» y seguía viendo el botón de comprar: la
    // aplicación le decía que había hecho algo que no había hecho, y encima le
    // quitaba la única pista de que la cuenta de la tienda no era la suya.
    const { granted } = await CommerceRepository.nativeSync(plataforma);
    return { estado: 'comprada', concedidos: granted.length };
  } catch {
    return { estado: 'pendiente_de_sincronizar' };
  }
}

/**
 * Sincronizacion silenciosa al iniciar sesion.
 *
 * Es lo que hace que quien cambia de telefono encuentre sus cursos sin tener
 * que pulsar nada. No molesta si falla: se reintenta la proxima vez.
 */
export async function sincronizarAlEntrar(uuidDeSupabase: string): Promise<void> {
  if (!esMovil() || !comprasHabilitadas()) return;
  if (!revenueCat.tiendaDisponible()) return;
  await revenueCat.iniciarSesion(uuidDeSupabase);
  try {
    await CommerceRepository.nativeSync(plataformaDeCompra() as 'ios' | 'android');
  } catch {
    // Silencio a proposito: entrar en la aplicacion no puede depender de esto.
  }
}
