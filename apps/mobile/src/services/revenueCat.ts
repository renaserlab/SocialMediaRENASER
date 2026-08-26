/**
 * RevenueCat: el SDK de compras de las tiendas.
 *
 * `react-native-purchases` es un modulo NATIVO y no viaja dentro de Expo Go.
 * Alli el `require` falla y, sin proteccion, la app se cae al arrancar con la
 * pantalla roja en cuanto algo importe este fichero. Se carga igual que
 * `mediaCompressor.ts` carga `react-native-compressor`: perezoso, en
 * `try/catch`, y comprobando la FORMA del modulo y no solo que el require
 * pasara —un modulo a medias fallaria despues, al comprar, que ya es un fallo
 * en caliente y con dinero de por medio—.
 *
 * ## Lo que este fichero NO decide
 *
 * No decide si alguien tiene acceso a un curso. Eso lo dice el backend, que lo
 * comprueba servidor a servidor contra RevenueCat con la clave secreta. Aqui
 * solo se compra y se avisa; un «exito» de este lado no abre ningun video.
 *
 * ## El `appUserID` es el UUID de Supabase. Nunca el correo.
 *
 * Un correo se cambia, y si el identificador cambia se pierden las compras: la
 * persona pagaria dos veces por lo mismo. El UUID no cambia nunca.
 */

import { Platform } from 'react-native';

import { claveDeRevenueCat, modoDeCompra } from '@/services/comprasConfig';
import type { Plataforma } from '@/services/comprasConfig';

/** La plataforma real. Vive aqui porque aqui SI se puede importar React Native. */
function plataformaActual(): Plataforma {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return 'web';
}

function clave(): string | null {
  return claveDeRevenueCat(plataformaActual());
}

/** Codigo de «la persona cerro el dialogo». NO es un error. */
const CANCELADO = '1';

export type ProductoDeTienda = {
  identificador: string;
  /** Precio YA formateado por la tienda, en la moneda del pais de la cuenta. */
  precio: string;
  /** Importe numerico, solo para comparar. Para mostrar se usa `precio`. */
  importe: number;
  moneda: string;
};

export type ResultadoDeCompra =
  | { estado: 'comprada'; identificador: string }
  | { estado: 'cancelada' }
  | { estado: 'error'; mensaje: string };

type ErrorDeCompra = {
  code?: string;
  message?: string;
  userCancelled?: boolean | null;
  userInfo?: { readableErrorCode?: string };
};

type PurchasesModule = {
  configure: (config: { apiKey: string; appUserID?: string | null }) => void;
  logIn: (appUserID: string) => Promise<unknown>;
  logOut: () => Promise<unknown>;
  getProducts: (ids: string[]) => Promise<
    {
      identifier: string;
      priceString: string;
      price: number;
      currencyCode: string;
    }[]
  >;
  purchaseStoreProduct: (producto: unknown) => Promise<{ productIdentifier: string }>;
  restorePurchases: () => Promise<unknown>;
  isConfigured?: () => Promise<boolean>;
};

let modulo: PurchasesModule | null | undefined;

/**
 * Carga el SDK, o `null` si no esta.
 *
 * `undefined` = todavia no se ha intentado; `null` = se intento y no esta. La
 * distincion evita repetir un `require` que ya sabemos que falla en cada
 * pantalla.
 */
function cargar(): PurchasesModule | null {
  if (modulo !== undefined) return modulo;
  if (Platform.OS === 'web') {
    // La web cobra con Stripe. Ni siquiera se intenta.
    modulo = null;
    return modulo;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-purchases') as { default?: unknown };
    const candidato = (mod?.default ?? mod) as Partial<PurchasesModule>;
    if (
      typeof candidato?.configure === 'function' &&
      typeof candidato?.purchaseStoreProduct === 'function' &&
      typeof candidato?.restorePurchases === 'function'
    ) {
      modulo = candidato as PurchasesModule;
    } else {
      modulo = null;
    }
  } catch {
    // Expo Go, o una build sin el modulo. La app sigue funcionando entera:
    // simplemente no se puede comprar, y la pantalla lo dira con palabras.
    modulo = null;
  }
  return modulo;
}

/** Si en ESTA build se puede comprar por tienda. */
export function tiendaDisponible(): boolean {
  return modoDeCompra() !== 'off' && cargar() !== null && clave() !== null;
}

let configuradoPara: string | null = null;

/**
 * Configura el SDK UNA sola vez, con la identidad de quien esta dentro.
 *
 * Llamar `configure` mas de una vez con la misma clave no aporta nada y en
 * algunas versiones reinicia el cache de `CustomerInfo`, asi que se recuerda
 * para quien se configuro y solo se vuelve a tocar si cambia la persona.
 */
export async function configurar(uuidDeSupabase: string | null): Promise<boolean> {
  const purchases = cargar();
  const apiKey = clave();
  if (!purchases || !apiKey) return false;

  try {
    if (configuradoPara === null) {
      purchases.configure({ apiKey, appUserID: uuidDeSupabase });
      configuradoPara = uuidDeSupabase ?? '';
      return true;
    }
    if (uuidDeSupabase && configuradoPara !== uuidDeSupabase) {
      // Cambio de cuenta sin reiniciar la app: se identifica a quien entra.
      await purchases.logIn(uuidDeSupabase);
      configuradoPara = uuidDeSupabase;
    }
    return true;
  } catch {
    return false;
  }
}

/** Al iniciar sesion: ata las compras de la tienda a esta cuenta de Z. */
export async function iniciarSesion(uuidDeSupabase: string): Promise<void> {
  const purchases = cargar();
  if (!purchases || !clave()) return;
  try {
    if (configuradoPara === null) {
      await configurar(uuidDeSupabase);
      return;
    }
    await purchases.logIn(uuidDeSupabase);
    configuradoPara = uuidDeSupabase;
  } catch {
    // Que no se pueda identificar no puede impedir entrar en la aplicacion.
    // La sincronizacion con el backend lo reintentara.
  }
}

/**
 * Al cerrar sesion: desata las compras de esta cuenta.
 *
 * Sin esto, quien inicie sesion despues en el mismo telefono heredaria el
 * `appUserID` anterior y con el las compras de otra persona.
 */
export async function cerrarSesion(): Promise<void> {
  const purchases = cargar();
  if (!purchases || configuradoPara === null) return;
  try {
    await purchases.logOut();
  } catch {
    // Ignorar: cerrar sesion en la app no puede fallar por esto.
  } finally {
    configuradoPara = '';
  }
}

/**
 * El producto tal y como lo vende la tienda, con su precio LOCALIZADO.
 *
 * Ese precio es el unico que se puede ensenar en un boton de compra nativo:
 * lleva la moneda del pais de la cuenta, sus impuestos y su formato. Mostrar
 * `price_minor` del catalogo en su lugar ensenaria un numero distinto del que
 * la persona va a pagar.
 */
export async function producto(identificador: string): Promise<ProductoDeTienda | null> {
  const purchases = cargar();
  if (!purchases) return null;
  try {
    const encontrados = await purchases.getProducts([identificador]);
    const primero = encontrados?.[0];
    if (!primero) return null;
    return {
      identificador: primero.identifier,
      precio: primero.priceString,
      importe: primero.price,
      moneda: primero.currencyCode,
    };
  } catch {
    return null;
  }
}

function esCancelacion(error: unknown): boolean {
  const e = error as ErrorDeCompra | null;
  if (!e) return false;
  // `userCancelled` esta marcado como deprecado en favor del codigo, asi que
  // se miran los dos: el codigo actual y el campo antiguo.
  if (e.userCancelled === true) return true;
  if (e.code === CANCELADO) return true;
  return e.userInfo?.readableErrorCode === 'PURCHASE_CANCELLED_ERROR';
}

/**
 * Compra un producto. **Cancelar NO es un error.**
 *
 * Que alguien abra el dialogo de la tienda y se lo piense es una decision
 * normal, no un fallo. Tratarla como error le ensenaria «algo ha ido mal» a
 * quien no ha hecho nada mal, y ademas ensuciaria los registros con fallos que
 * no lo son.
 */
export async function comprar(identificador: string): Promise<ResultadoDeCompra> {
  const purchases = cargar();
  if (!purchases) {
    return { estado: 'error', mensaje: 'Las compras no estan disponibles aqui.' };
  }
  try {
    const encontrados = await purchases.getProducts([identificador]);
    const producto = encontrados?.[0];
    if (!producto) {
      return {
        estado: 'error',
        mensaje: 'Este curso no esta disponible para comprar ahora mismo.',
      };
    }
    const resultado = await purchases.purchaseStoreProduct(producto);
    return { estado: 'comprada', identificador: resultado.productIdentifier };
  } catch (error) {
    if (esCancelacion(error)) return { estado: 'cancelada' };
    const mensaje =
      (error as ErrorDeCompra)?.message ?? 'No se pudo completar la compra.';
    return { estado: 'error', mensaje };
  }
}

/**
 * Restaura las compras de la cuenta de la tienda.
 *
 * Es OBLIGATORIO tenerlo en movil: sin un boton de restaurar, quien reinstale
 * o cambie de telefono no puede recuperar lo que pago, y las tiendas lo exigen.
 * Devuelve si la llamada salio bien; QUE se ha restaurado lo decide el backend
 * al sincronizar, no esto.
 */
export async function restaurar(): Promise<boolean> {
  const purchases = cargar();
  if (!purchases) return false;
  try {
    await purchases.restorePurchases();
    return true;
  } catch {
    return false;
  }
}

/** Solo para las pruebas: olvida el modulo y a quien se configuro. */
export function _reiniciar(): void {
  modulo = undefined;
  configuradoPara = null;
}
