/**
 * La configuracion de compras, y la validacion que impide una release rota.
 *
 * LO QUE SE FIJA AQUI, Y POR QUE ES CRITICO. RevenueCat lo dice sin rodeos:
 * nunca se sube a una tienda una app configurada con la clave del Test Store.
 * Una release asi se instala, arranca, ensena el boton de comprar... y no
 * cobra: el Test Store no existe para Google Play ni para la App Store. El
 * fallo aparece en manos de la gente, no en la maquina de quien compila.
 *
 * Por eso la regla no vive en la cabeza de nadie sino en
 * `problemasDeConfiguracion()`, y esta prueba comprueba que de verdad falla
 * cuando tiene que fallar.
 *
 * `comprasConfig.ts` no importa React Native precisamente para poder probarse
 * asi, en el runner de Node que usa este proyecto (`npm run test`), sin
 * arrastrar el modulo nativo.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  claveDeRevenueCat,
  comprasHabilitadas,
  modoDeCompra,
  problemasDeConfiguracion,
  type EntornoDeCompras,
} from './comprasConfig.ts';

const CLAVE_ANDROID = 'goog_unaClaveDePruebaQueNoVale';
const CLAVE_IOS = 'appl_unaClaveDePruebaQueNoVale';
const CLAVE_TEST = 'test_unaClaveDelTestStore';

describe('el modo de compra', () => {
  it('por defecto esta apagado', () => {
    // Sin variable ninguna. Es el estado de una maquina recien clonada.
    assert.equal(modoDeCompra({}), 'off');
    assert.equal(comprasHabilitadas({}), false);
  });

  it('un valor mal escrito cae a off en vez de reventar', () => {
    // Una variable con una errata no puede dejar la app sin arrancar, y `off`
    // es el unico estado en el que no se puede cobrar de mas.
    assert.equal(modoDeCompra({ modo: 'stroes' }), 'off');
    assert.equal(modoDeCompra({ modo: 'TEST' }), 'test');
  });

  it('reconoce los tres modos', () => {
    assert.equal(modoDeCompra({ modo: 'off' }), 'off');
    assert.equal(modoDeCompra({ modo: 'test' }), 'test');
    assert.equal(modoDeCompra({ modo: 'stores' }), 'stores');
  });
});

describe('que clave le toca a cada plataforma', () => {
  const entorno: EntornoDeCompras = {
    modo: 'stores',
    claveAndroid: CLAVE_ANDROID,
    claveIos: CLAVE_IOS,
    claveTest: CLAVE_TEST,
  };

  it('android e ios usan la suya', () => {
    assert.equal(claveDeRevenueCat('android', entorno), CLAVE_ANDROID);
    assert.equal(claveDeRevenueCat('ios', entorno), CLAVE_IOS);
  });

  it('la web NUNCA usa RevenueCat', () => {
    // La web cobra con Stripe. Pedirle RevenueCat seria pedirle un movil.
    assert.equal(claveDeRevenueCat('web', entorno), null);
  });

  it('en modo test manda la clave del Test Store', () => {
    const test = { ...entorno, modo: 'test' };
    assert.equal(claveDeRevenueCat('android', test), CLAVE_TEST);
    assert.equal(claveDeRevenueCat('ios', test), CLAVE_TEST);
  });

  it('apagado no hay clave para nadie', () => {
    assert.equal(claveDeRevenueCat('android', { ...entorno, modo: 'off' }), null);
  });
});

describe('la validacion que impide una release rota', () => {
  it('una release de PRODUCCION en modo test falla', () => {
    // ESTE es el caso que no puede compilarse en silencio.
    const problemas = problemasDeConfiguracion({
      modo: 'test',
      appEnv: 'production',
      claveTest: CLAVE_TEST,
    });
    assert.ok(problemas.length > 0, 'una release en modo test tiene que fallar');
    assert.ok(
      problemas.some((p) => p.includes('PRODUCCION')),
      `se esperaba un aviso sobre la build de produccion, salio: ${problemas}`,
    );
  });

  it('la clave del Test Store en el hueco de Google tambien falla', () => {
    // La otra forma de colarlo: modo `stores`, pero con la clave equivocada.
    const problemas = problemasDeConfiguracion({
      modo: 'stores',
      appEnv: 'production',
      claveAndroid: CLAVE_TEST,
    });
    assert.ok(
      problemas.some((p) => p.includes('ANDROID')),
      `se esperaba que rechazara la clave de Android, salio: ${problemas}`,
    );
  });

  it('y en el hueco de Apple', () => {
    const problemas = problemasDeConfiguracion({
      modo: 'stores',
      appEnv: 'production',
      claveIos: CLAVE_TEST,
    });
    assert.ok(problemas.some((p) => p.includes('IOS')));
  });

  it('una clave SECRETA en el cliente falla siempre', () => {
    // Es la peor de todas: viaja dentro del paquete que se instala cualquiera,
    // y con ella se conceden entitlements y se borran subscriptores de todo el
    // proyecto.
    const problemas = problemasDeConfiguracion({
      modo: 'stores',
      claveAndroid: 'sk_estoEsUnaClaveSecreta',
    });
    assert.ok(problemas.some((p) => p.includes('SECRETA')));
  });

  it('una configuracion de produccion correcta no da problemas', () => {
    assert.deepEqual(
      problemasDeConfiguracion({
        modo: 'stores',
        appEnv: 'production',
        claveAndroid: CLAVE_ANDROID,
        claveIos: CLAVE_IOS,
      }),
      [],
    );
  });

  it('desarrollo en modo test con su clave tampoco', () => {
    assert.deepEqual(
      problemasDeConfiguracion({
        modo: 'test',
        appEnv: 'development',
        claveTest: CLAVE_TEST,
      }),
      [],
    );
  });

  it('el modo test sin clave avisa', () => {
    const problemas = problemasDeConfiguracion({ modo: 'test', appEnv: 'development' });
    assert.ok(problemas.some((p) => p.includes('TEST_API_KEY')));
  });
});

describe('que falten variables no revienta nada', () => {
  it('ninguna funcion lanza con el entorno vacio', () => {
    // La app tiene que arrancar en una maquina sin configurar. Lo unico que
    // pasa es que no se puede comprar.
    assert.doesNotThrow(() => modoDeCompra({}));
    assert.doesNotThrow(() => comprasHabilitadas({}));
    assert.doesNotThrow(() => claveDeRevenueCat('android', {}));
    assert.doesNotThrow(() => problemasDeConfiguracion({}));
    assert.equal(claveDeRevenueCat('android', {}), null);
  });

  it('valores vacios o con espacios cuentan como ausentes', () => {
    assert.equal(
      claveDeRevenueCat('android', { modo: 'stores', claveAndroid: '   ' }),
      null,
    );
  });
});

describe('los perfiles de compilacion de eas.json', () => {
  const eas = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../eas.json', import.meta.url)), 'utf8'),
  ) as {
    build: Record<string, { env?: Record<string, string> }>;
  };

  it('el perfil de produccion no lleva compras de prueba', () => {
    // Se mira el FICHERO que gobierna la compilacion, no solo la funcion: la
    // validacion de arriba protege el codigo, esta protege la configuracion
    // con la que EAS construye el binario que se sube a la tienda.
    const env = eas.build.production?.env ?? {};
    const problemas = problemasDeConfiguracion({
      modo: env.EXPO_PUBLIC_PURCHASES_MODE,
      appEnv: env.EXPO_PUBLIC_APP_ENV,
      claveTest: env.EXPO_PUBLIC_REVENUECAT_TEST_API_KEY,
      claveAndroid: env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY,
      claveIos: env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY,
    });
    // Con las compras todavia sin configurar, el unico aviso admisible es
    // «esta build no vende nada». Cualquier otro significa que alguien ha
    // puesto una clave donde no debia.
    const graves = problemas.filter((p) => !p.includes('nadie podra comprar'));
    assert.deepEqual(
      graves,
      [],
      `El perfil de produccion de eas.json esta mal configurado: ${graves}`,
    );
  });

  it('ningun perfil lleva una clave secreta escrita', () => {
    for (const [nombre, perfil] of Object.entries(eas.build)) {
      for (const [clave, valor] of Object.entries(perfil.env ?? {})) {
        assert.ok(
          !String(valor).startsWith('sk_'),
          `El perfil "${nombre}" tiene una clave secreta en ${clave}.`,
        );
      }
    }
  });
});
