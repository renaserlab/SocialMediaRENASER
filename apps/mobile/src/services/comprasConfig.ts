/**
 * Configuracion de las compras: en que modo esta la app y con que clave.
 *
 * Fichero aparte de `revenueCat.ts` A PROPOSITO, y SIN UN SOLO `import` de
 * React Native: asi estas funciones se ejecutan tal cual en Node —en las
 * pruebas (`npm run test`) y en una comprobacion previa a compilar— sin
 * arrastrar el modulo nativo ni la cadena que acaba en supabase-js. Es lo que
 * permite que una release mal configurada falle ANTES de existir, en vez de
 * descubrirse cuando alguien intenta comprar.
 *
 * Por eso `claveDeRevenueCat` recibe la plataforma en vez de mirar
 * `Platform.OS`: leerla aqui obligaria a importar React Native y esta
 * comprobacion dejaria de poder ejecutarse fuera de la aplicacion.
 *
 * ## Los tres modos
 *
 * - `off` (POR DEFECTO): no hay compras. La pantalla de curso lo dice con
 *   palabras y no ensena ningun boton. Es el estado de hoy.
 * - `test`: RevenueCat **Test Store**. Compras de verdad contra el SDK de
 *   verdad, pero sin App Store ni Google Play de por medio. Es lo que se usa
 *   en desarrollo.
 * - `stores`: Google Play y App Store reales.
 *
 * ## Por que NO hay un cuarto modo «simulado»
 *
 * Porque ya lo hubo y hubo que quitarlo: una compra fingida en local siempre
 * acababa en «transaccion rechazada» y su boton de reintentar regalaba el
 * curso. Las tiendas rechazan los flujos de compra que no completan una
 * transaccion (directriz 2.1 de Apple). El Test Store de RevenueCat cubre esa
 * necesidad de verdad: entrega `CustomerInfo`, concede entitlements y aparece
 * en el panel, asi que el codigo que se prueba es el mismo que se publica.
 *
 * ## La regla que no se puede saltar
 *
 * **Una release de produccion con una clave de Test Store tiene que fallar una
 * validacion.** RevenueCat lo dice sin rodeos: nunca se sube a una tienda una
 * app configurada con la clave del Test Store. Aqui se comprueba con una lista
 * BLANCA —en `stores` la clave de Android tiene que empezar por `goog_` y la
 * de iOS por `appl_`— y no con una lista negra de prefijos prohibidos. La
 * diferencia importa: una lista negra deja pasar cualquier prefijo que
 * RevenueCat invente manana; la blanca solo deja pasar lo que sabemos que es
 * correcto.
 */

export type ModoDeCompra = 'off' | 'test' | 'stores';

const MODOS: readonly ModoDeCompra[] = ['off', 'test', 'stores'];

/** Prefijos documentados de las claves PUBLICAS del SDK. */
const PREFIJO_ANDROID = 'goog_';
const PREFIJO_IOS = 'appl_';
/** Las claves SECRETAS empiezan por esto. En el cliente NUNCA. */
const PREFIJO_SECRETO = 'sk_';

/**
 * Lo que se lee del entorno. Se recoge en un objeto para poder pasarle otro en
 * las pruebas: `process.env` no se puede reescribir de forma fiable, y una
 * comprobacion que solo se sabe ejecutar con las variables de la maquina no es
 * una comprobacion.
 */
export type EntornoDeCompras = {
  modo?: string;
  appEnv?: string;
  claveTest?: string;
  claveAndroid?: string;
  claveIos?: string;
};

export function entornoActual(): EntornoDeCompras {
  return {
    modo: process.env.EXPO_PUBLIC_PURCHASES_MODE,
    appEnv: process.env.EXPO_PUBLIC_APP_ENV,
    claveTest: process.env.EXPO_PUBLIC_REVENUECAT_TEST_API_KEY,
    claveAndroid: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY,
    claveIos: process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY,
  };
}

/**
 * El modo, siempre uno valido.
 *
 * Un valor que no reconocemos cae a `off` en vez de reventar: una variable mal
 * escrita no puede dejar la aplicacion sin arrancar, y `off` es el unico
 * estado en el que no se puede cobrar de mas.
 */
export function modoDeCompra(entorno: EntornoDeCompras = entornoActual()): ModoDeCompra {
  const bruto = (entorno.modo ?? '').trim().toLowerCase();
  return (MODOS as readonly string[]).includes(bruto) ? (bruto as ModoDeCompra) : 'off';
}

/** Si esta build puede comprar algo. */
export function comprasHabilitadas(entorno: EntornoDeCompras = entornoActual()): boolean {
  return modoDeCompra(entorno) !== 'off';
}

export type Plataforma = 'ios' | 'android' | 'web';

/**
 * La clave que le toca a esta plataforma y a este modo, o `null`.
 *
 * `null` no es un fallo: es «aqui no se compra con RevenueCat». En web siempre
 * devuelve `null` porque la web cobra con Stripe.
 */
export function claveDeRevenueCat(
  plataforma: Plataforma,
  entorno: EntornoDeCompras = entornoActual(),
): string | null {
  const modo = modoDeCompra(entorno);
  if (modo === 'off') return null;
  // La web no usa RevenueCat. Pedirle una clave seria pedirle un movil.
  if (plataforma === 'web') return null;
  if (modo === 'test') return entorno.claveTest?.trim() || null;
  const clave = plataforma === 'ios' ? entorno.claveIos : entorno.claveAndroid;
  return clave?.trim() || null;
}

/**
 * Todo lo que esta mal en esta configuracion, en castellano.
 *
 * Lista vacia = configuracion coherente. Se devuelven TODOS los problemas y no
 * solo el primero: quien esta arreglando un `.env` prefiere verlos juntos a
 * descubrirlos de uno en uno.
 */
export function problemasDeConfiguracion(
  entorno: EntornoDeCompras = entornoActual(),
): string[] {
  const problemas: string[] = [];
  const modo = modoDeCompra(entorno);
  const bruto = (entorno.modo ?? '').trim().toLowerCase();
  const esProduccion = (entorno.appEnv ?? '').trim().toLowerCase() === 'production';

  if (bruto && !(MODOS as readonly string[]).includes(bruto)) {
    problemas.push(
      `EXPO_PUBLIC_PURCHASES_MODE="${entorno.modo}" no es un modo valido ` +
        `(off | test | stores). Se ha usado "off".`,
    );
  }

  // Una clave secreta en el cliente es la peor de todas: va dentro del paquete
  // que se instala cualquiera, y con ella se conceden entitlements y se borran
  // subscriptores de TODO el proyecto.
  for (const [nombre, valor] of [
    ['EXPO_PUBLIC_REVENUECAT_TEST_API_KEY', entorno.claveTest],
    ['EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY', entorno.claveAndroid],
    ['EXPO_PUBLIC_REVENUECAT_IOS_API_KEY', entorno.claveIos],
  ] as const) {
    if (valor?.trim().startsWith(PREFIJO_SECRETO)) {
      problemas.push(
        `${nombre} contiene una clave SECRETA (sk_...). Las secretas solo viven ` +
          `en el backend; en el cliente va la publica.`,
      );
    }
  }

  if (modo === 'test') {
    if (!entorno.claveTest?.trim()) {
      problemas.push(
        'El modo "test" necesita EXPO_PUBLIC_REVENUECAT_TEST_API_KEY (clave del ' +
          'Test Store de RevenueCat).',
      );
    }
    if (esProduccion) {
      // ESTA es la validacion que impide publicar con el Test Store.
      problemas.push(
        'Una build de PRODUCCION no puede ir en modo "test": llevaria la clave ' +
          'del Test Store a la tienda. Usa EXPO_PUBLIC_PURCHASES_MODE=stores.',
      );
    }
  }

  if (modo === 'stores') {
    const android = entorno.claveAndroid?.trim() ?? '';
    const ios = entorno.claveIos?.trim() ?? '';
    if (!android && !ios) {
      problemas.push(
        'El modo "stores" necesita al menos una de ' +
          'EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY o EXPO_PUBLIC_REVENUECAT_IOS_API_KEY.',
      );
    }
    // Lista BLANCA: solo pasa lo que sabemos que es una clave de tienda. Una
    // clave del Test Store puesta en este hueco no empieza por `goog_`, asi
    // que cae aqui aunque manana RevenueCat cambie sus prefijos de pruebas.
    if (android && !android.startsWith(PREFIJO_ANDROID)) {
      problemas.push(
        `EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY no parece una clave de Google Play ` +
          `(deberia empezar por "${PREFIJO_ANDROID}"). Una release con la clave del ` +
          `Test Store no puede cobrar.`,
      );
    }
    if (ios && !ios.startsWith(PREFIJO_IOS)) {
      problemas.push(
        `EXPO_PUBLIC_REVENUECAT_IOS_API_KEY no parece una clave de la App Store ` +
          `(deberia empezar por "${PREFIJO_IOS}"). Una release con la clave del ` +
          `Test Store no puede cobrar.`,
      );
    }
  }

  if (esProduccion && modo === 'off') {
    // No es un error de seguridad, pero si una build que no vende nada. Se
    // avisa para que no se publique sin querer una version sin compras.
    problemas.push(
      'Build de produccion con las compras en "off": nadie podra comprar nada.',
    );
  }

  return problemas;
}
