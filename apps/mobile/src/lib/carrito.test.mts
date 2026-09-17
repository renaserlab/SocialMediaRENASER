/**
 * La bolsa de Productos, ejecutada.
 *
 * Lo que se prueba aquí es, otra vez, LO QUE NO SE PUEDE DECIR. Un carrito es
 * la pantalla donde más barato sale mentir: basta con un cero, con un botón de
 * más que se deja pulsar o con una palabra —«Comprar»— para prometer algo que
 * Z todavía no hace. Seis reglas, todas copiadas de `carrito.ts` y de
 * `products/carts.py`:
 *
 *  1. UN CARRITO VACÍO NO ENSEÑA «0.00». `subtotal_minor` llega nulo cuando no
 *     hay nada comprable, y un cero con moneda se lee como una compra de cero.
 *  2. `available: null` NO ES CERO. Es «ese SKU no tiene inventario cargado»;
 *     convertirlo en cero diría «agotado», que manda a quien vende a buscar un
 *     problema que no existe.
 *  3. BAJAR DESDE 1 ES QUITAR. Es lo que la persona está pidiendo, y esconderlo
 *     detrás de otro botón obliga a pensar.
 *  4. UN PRECIO QUE CAMBIÓ SIGUE SIENDO COMPRABLE. `price_changed` avisa, no
 *     bloquea; tratarlo como un bloqueo dejaría la bolsa muerta por un céntimo.
 *  5. DOS CONTADORES, NO UNO. Unidades del carrito y productos guardados son
 *     cosas distintas: un solo número no querría decir nada concreto.
 *  6. NINGÚN BOTÓN DE COMPRAR. `purchasable` es hoy siempre `false` y no hay
 *     checkout, ni pedido, ni pago. Eso se comprueba sobre el CÓDIGO de la
 *     pantalla, que es donde vive la tentación.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Carrito, LineaDelCarrito } from './carrito.ts';

/**
 * EL ALIAS `@/` NO LO RESUELVE NODE, y `carrito.ts` lo usa de verdad.
 *
 * Los demás módulos de `lib/` solo importan del alias con `import type`, que el
 * quitatipos borra antes de ejecutar; `carrito.ts` importa VALORES
 * (`precioLegible`, `CLAVE_SIN_PRECIO`) de `@/lib/productos`, y eso el
 * ejecutor de pruebas no lo sabe encontrar: es Metro quien traduce el alias, y
 * aquí no hay Metro.
 *
 * Se traduce con un resolutor propio en vez de dejar la prueba roja o de tocar
 * el módulo: el alias se cambia por la ruta relativa que Node sí entiende. La
 * salida definitiva es de una línea y está en `carrito.ts` —importar
 * `'./productos.ts'` como hacen las pruebas— y mientras no se haga, esto
 * mantiene lo que de verdad importa: que la lógica de la bolsa se ejecute.
 */
registerHooks({
  resolve(especificador, contexto, siguiente) {
    if (especificador.startsWith('@/')) {
      return {
        url: new URL(`../${especificador.slice(2)}.ts`, import.meta.url).href,
        shortCircuit: true,
      };
    }
    return siguiente(especificador, contexto);
  },
});

// Dinámico A PROPÓSITO: un `import` estático se resuelve antes de que el
// resolutor de arriba exista, y volvería a fallar por el alias.
const {
  AVISOS_BLOQUEANTES,
  AVISOS_CONOCIDOS,
  CLAVE_SIN_IMPORTE,
  CLAVE_TODAVIA_NO_SE_COMPRA,
  MAXIMO_POR_LINEA,
  avisoDelCarrito,
  avisosOrdenados,
  cantidadTrasTocar,
  carritoDisponible,
  carritoVacio,
  claveDeErrorDelCarrito,
  claveDeLaPulsacion,
  claveDelAviso,
  contadorDeGuardados,
  contadorDeLaBolsa,
  esCarritoApagado,
  iconoDelAviso,
  lineaBloqueada,
  lineasBloqueadas,
  precioAnterior,
  precioDeLaLinea,
  sePuedeComprar,
  sePuedeRestar,
  sePuedeSumar,
  subtotalDelCarrito,
  topeDeLaLinea,
  totalDeLaLinea,
} = await import('./carrito.ts');

const AQUI = fileURLToPath(new URL('.', import.meta.url));

function fuente(carpeta: string, nombre: string): string {
  return readFileSync(join(AQUI, '..', carpeta, nombre), 'utf8');
}

/** El código sin comentarios: lo que la pantalla HACE, no lo que explica. */
function sinComentarios(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('//'))
    .join('\n');
}

function linea(campos: Partial<LineaDelCarrito> = {}): LineaDelCarrito {
  return {
    item_id: 'linea-1',
    product_id: 'producto-1',
    version_id: 'version-1',
    variant_id: 'variante-1',
    name: 'Silla de madera',
    variant_name: 'Nogal',
    sku: 'SKU-1',
    seller_id: 'vendedor-1',
    seller_name: 'Taller Aroma',
    image_path: 'productos/silla.jpg',
    image_url: null,
    alt_text: null,
    quantity: 1,
    unit_price_minor: 4990,
    currency: 'PEN',
    line_total_minor: 4990,
    seen_price_minor: 4990,
    seen_currency: 'PEN',
    available: 5,
    issues: [],
    purchasable: true,
    ...campos,
  };
}

function carrito(campos: Partial<Carrito> = {}): Carrito {
  return {
    items: [],
    currency: null,
    subtotal_minor: null,
    units: 0,
    lines: 0,
    blocked_lines: 0,
    purchasable: false,
    disponible: true,
    ...campos,
  };
}

/* ========================================================================== */
describe('UN CARRITO VACÍO NO ENSEÑA «0.00»', () => {
  it('sin nada comprable no hay importe, y no se escribe un cero', () => {
    // `subtotal_minor` llega nulo a propósito. Un «0.00 PEN» se lee como una
    // compra de cero, que es un dato inventado con aspecto de dato real.
    const leido = subtotalDelCarrito(carrito());
    assert.deepEqual(leido, { configurado: false });
    assert.ok(!JSON.stringify(leido).includes('0.00'));
    assert.ok(!JSON.stringify(leido).includes('0'));
  });

  it('una bolsa que todavía no se ha leído tampoco vale cero', () => {
    assert.deepEqual(subtotalDelCarrito(null), { configurado: false });
  });

  it('sin moneda no hay subtotal, aunque venga el importe', () => {
    assert.deepEqual(subtotalDelCarrito(carrito({ subtotal_minor: 4990 })), {
      configurado: false,
    });
  });

  it('con las dos cosas, el subtotal lleva SU código de moneda', () => {
    assert.deepEqual(
      subtotalDelCarrito(carrito({ subtotal_minor: 9980, currency: 'PEN' })),
      { configurado: true, texto: '99.80 PEN' },
    );
  });

  it('un cero que el servidor calculó SÍ es un cero', () => {
    // Distinto de `null`: ahí el servidor sí sumó, y dio cero.
    assert.deepEqual(subtotalDelCarrito(carrito({ subtotal_minor: 0, currency: 'PEN' })), {
      configurado: true,
      texto: '0.00 PEN',
    });
  });

  it('el hueco del importe que falta no habla de gratis ni de cero', () => {
    assert.equal(CLAVE_SIN_IMPORTE, 'productos.sinPrecio');
    for (const prohibida of ['gratis', 'free', 'cero', 'zero', 'desde', 'oferta']) {
      assert.ok(!CLAVE_SIN_IMPORTE.toLowerCase().includes(prohibida), prohibida);
    }
  });

  it('el precio y el total de una línea se escriben, no se calculan', () => {
    // 3 × 49.90 = 149.70, pero el que se pinta es el que mandó el servidor: si
    // el cliente multiplicara, dos versiones instaladas darían dos totales.
    const tres = linea({ quantity: 3, line_total_minor: 14_970 });
    assert.deepEqual(precioDeLaLinea(tres), { configurado: true, texto: '49.90 PEN' });
    assert.deepEqual(totalDeLaLinea(tres), { configurado: true, texto: '149.70 PEN' });
  });

  it('una línea sin precio configurado no vale cero', () => {
    const sinPrecio = linea({ unit_price_minor: null, line_total_minor: null });
    assert.deepEqual(precioDeLaLinea(sinPrecio), { configurado: false });
    assert.deepEqual(totalDeLaLinea(sinPrecio), { configurado: false });
  });
});

/* ========================================================================== */
describe('`available: null` NO SE CONVIERTE EN CERO', () => {
  it('sin inventario cargado no hay tope, y `null` no es `0`', () => {
    const tope = topeDeLaLinea(linea({ available: null }));
    assert.equal(tope, null);
    assert.notEqual(tope, 0);
  });

  it('lo que no es un número tampoco produce un tope', () => {
    assert.equal(topeDeLaLinea(linea({ available: undefined as unknown as null })), null);
    assert.equal(topeDeLaLinea(linea({ available: Number.NaN })), null);
    assert.equal(topeDeLaLinea(linea({ available: Number.POSITIVE_INFINITY })), null);
  });

  it('con inventario cargado, el tope es lo que hay', () => {
    assert.equal(topeDeLaLinea(linea({ available: 3 })), 3);
    assert.equal(topeDeLaLinea(linea({ available: 3.7 })), 3);
  });

  it('un cero de verdad sí es cero: está cargado y no queda ninguno', () => {
    assert.equal(topeDeLaLinea(linea({ available: 0 })), 0);
    assert.equal(topeDeLaLinea(linea({ available: -4 })), 0);
  });

  it('el tope técnico de la línea es el mismo que impone la 0075', () => {
    assert.equal(MAXIMO_POR_LINEA, 1000);
    assert.equal(topeDeLaLinea(linea({ available: 99_999 })), 1000);
  });
});

/* ========================================================================== */
describe('el «+» y el «−»: cuándo se pueden pulsar', () => {
  it('SIN INVENTARIO CARGADO no se puede sumar', () => {
    // Y la pantalla lo dice con esas palabras, no con «agotado».
    assert.equal(sePuedeSumar(linea({ available: null })), false);
  });

  it('llegado al tope tampoco', () => {
    assert.equal(sePuedeSumar(linea({ quantity: 3, available: 3 })), false);
    assert.equal(sePuedeSumar(linea({ quantity: 4, available: 3 })), false);
  });

  it('con existencias por debajo del tope, sí', () => {
    assert.equal(sePuedeSumar(linea({ quantity: 1, available: 3 })), true);
  });

  it('con cero existencias no se suma', () => {
    assert.equal(sePuedeSumar(linea({ quantity: 1, available: 0 })), false);
  });

  it('en 1 no se resta: bajar de 1 es quitar, y es otro botón', () => {
    assert.equal(sePuedeRestar(linea({ quantity: 1 })), false);
    assert.equal(sePuedeRestar(linea({ quantity: 2 })), true);
  });
});

/* ========================================================================== */
describe('la cantidad después de tocar', () => {
  it('BAJAR DESDE 1 DEVUELVE 0, que es QUITAR la línea', () => {
    assert.equal(cantidadTrasTocar(linea({ quantity: 1 }), -1), 0);
  });

  it('bajar desde más de 1 es una unidad menos', () => {
    assert.equal(cantidadTrasTocar(linea({ quantity: 3 }), -1), 2);
  });

  it('subir NO PASA DEL DISPONIBLE: se queda donde estaba', () => {
    assert.equal(cantidadTrasTocar(linea({ quantity: 3, available: 3 }), 1), 3);
    assert.equal(cantidadTrasTocar(linea({ quantity: 2, available: 5 }), 1), 3);
  });

  it('ni del tope técnico de la línea', () => {
    assert.equal(
      cantidadTrasTocar(linea({ quantity: 1000, available: 99_999 }), 1),
      1000,
    );
  });

  it('con `available` nulo la guardia es el botón, que no se puede pulsar', () => {
    // `cantidadTrasTocar` no tiene tope que aplicar cuando no hay inventario
    // cargado; quien impide subir es `sePuedeSumar`, y por eso la pantalla
    // deshabilita el «+» con esa función y no con esta.
    assert.equal(sePuedeSumar(linea({ quantity: 1, available: null })), false);
  });
});

/* ========================================================================== */
describe('qué bloquea una línea y qué solo avisa', () => {
  it('cada aviso bloqueante la bloquea, uno por uno', () => {
    for (const aviso of AVISOS_BLOQUEANTES) {
      assert.equal(lineaBloqueada(linea({ issues: [aviso] })), true, aviso);
    }
  });

  it('UN PRECIO QUE CAMBIÓ SIGUE SIENDO COMPRABLE', () => {
    // Avisar y bloquear no son lo mismo: lo que hay que hacer con un precio
    // nuevo es decirlo, no dejar la línea muerta.
    assert.equal(lineaBloqueada(linea({ issues: ['price_changed'] })), false);
    assert.ok(!(AVISOS_BLOQUEANTES as readonly string[]).includes('price_changed'));
  });

  it('una versión nueva tampoco bloquea: el producto sigue estando', () => {
    assert.equal(lineaBloqueada(linea({ issues: ['version_changed'] })), false);
  });

  it('sin avisos no hay nada bloqueado', () => {
    assert.equal(lineaBloqueada(linea()), false);
    assert.equal(lineasBloqueadas(carrito()), 0);
    assert.equal(lineasBloqueadas(null), 0);
  });

  it('un aviso desconocido no bloquea: no sabemos que impida nada', () => {
    assert.equal(lineaBloqueada(linea({ issues: ['lo_que_sea'] })), false);
  });

  it('LOS BLOQUEANTES SE LEEN PRIMERO', () => {
    assert.deepEqual(
      avisosOrdenados(linea({ issues: ['price_changed', 'insufficient_stock'] })),
      ['insufficient_stock', 'price_changed'],
    );
  });

  it('y dentro de cada grupo se respeta el orden del servidor', () => {
    assert.deepEqual(
      avisosOrdenados(
        linea({
          issues: ['version_changed', 'variant_missing', 'price_changed', 'product_unavailable'],
        }),
      ),
      ['variant_missing', 'product_unavailable', 'version_changed', 'price_changed'],
    );
  });

  it('ordenar no pierde ni inventa avisos', () => {
    const issues = ['price_changed', 'insufficient_stock', 'inventado'];
    assert.equal(avisosOrdenados(linea({ issues })).length, issues.length);
    assert.deepEqual([...avisosOrdenados(linea({ issues }))].sort(), [...issues].sort());
    assert.deepEqual(avisosOrdenados(linea()), []);
  });
});

/* ========================================================================== */
describe('el precio anterior solo se enseña si CAMBIÓ', () => {
  it('con `price_changed` se puede tachar lo que se veía al añadir', () => {
    assert.deepEqual(
      precioAnterior(linea({ issues: ['price_changed'], seen_price_minor: 3990 })),
      { configurado: true, texto: '39.90 PEN' },
    );
  });

  it('SIN ese aviso no hay precio anterior que enseñar', () => {
    // Enseñar el anterior cuando es el mismo es ruido, y encima hace dudar de
    // si cambió.
    assert.deepEqual(precioAnterior(linea({ seen_price_minor: 3990 })), {
      configurado: false,
    });
    assert.deepEqual(precioAnterior(linea({ issues: ['insufficient_stock'] })), {
      configurado: false,
    });
  });

  it('sin la moneda de entonces tampoco es un importe', () => {
    assert.deepEqual(
      precioAnterior(linea({ issues: ['price_changed'], seen_currency: '' })),
      { configurado: false },
    );
  });
});

/* ========================================================================== */
describe('DOS CONTADORES, y son dos funciones distintas', () => {
  it('cero no pinta contador en ninguno de los dos', () => {
    assert.equal(contadorDeLaBolsa(0), null);
    assert.equal(contadorDeGuardados(0), null);
  });

  it('uno o más, sí', () => {
    assert.equal(contadorDeLaBolsa(1), 1);
    assert.equal(contadorDeLaBolsa(12), 12);
    assert.equal(contadorDeGuardados(1), 1);
    assert.equal(contadorDeGuardados(7), 7);
  });

  it('lo raro no inventa un número', () => {
    for (const raro of [-3, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      assert.equal(contadorDeLaBolsa(raro as number), null, String(raro));
      assert.equal(contadorDeGuardados(raro as number), null, String(raro));
    }
  });

  it('NO SON LA MISMA FUNCIÓN: cuentan cosas distintas', () => {
    // Una cuenta UNIDADES del carrito y la otra PRODUCTOS marcados. Juntarlas
    // en un solo número haría que el contador no quisiera decir nada concreto,
    // y el día que una cambie de criterio la otra no puede arrastrarse.
    assert.notEqual(
      contadorDeLaBolsa as unknown as () => void,
      contadorDeGuardados as unknown as () => void,
    );
    assert.notEqual(contadorDeLaBolsa.name, contadorDeGuardados.name);
  });
});

/* ========================================================================== */
describe('EL BOTÓN SOLO CON PERMISO DEL SERVIDOR', () => {
  it('con `purchasable: false` no se puede comprar', () => {
    assert.equal(sePuedeComprar(carrito()), false);
  });

  it('y sin bolsa leída tampoco: `null` no se cuenta como que sí', () => {
    assert.equal(sePuedeComprar(null), false);
    assert.equal(sePuedeComprar(carrito({ purchasable: undefined as unknown as boolean })), false);
  });

  it('el pie dice SIEMPRE que todavía no se compra', () => {
    assert.equal(CLAVE_TODAVIA_NO_SE_COMPRA, 'carrito.todaviaNoSeCompra');
  });

  it('el aviso de cabecera distingue «nada» de «algo»', () => {
    assert.equal(avisoDelCarrito(carrito()), null);
    assert.equal(avisoDelCarrito(null), null);
    const todas = carrito({ items: [linea({ issues: ['variant_missing'] })] });
    assert.equal(avisoDelCarrito(todas), 'carrito.nadaComprable');
    const algunas = carrito({
      items: [linea({ issues: ['variant_missing'] }), linea({ item_id: 'linea-2' })],
    });
    assert.equal(avisoDelCarrito(algunas), 'carrito.algoNoSePuede');
    assert.equal(lineasBloqueadas(algunas), 1);
  });

  it('una bolsa sin líneas no avisa de nada: no hay nada de lo que avisar', () => {
    assert.equal(carritoVacio(carrito()), true);
    assert.equal(carritoVacio(null), true);
    assert.equal(carritoVacio(carrito({ items: [linea()] })), false);
  });

  it('`disponible: false` es la migración sin aplicar, no una bolsa vacía', () => {
    assert.equal(carritoDisponible(carrito()), true);
    assert.equal(carritoDisponible(carrito({ disponible: false })), false);
    assert.equal(carritoDisponible(null), false);
  });
});

/* ========================================================================== */
describe('los avisos tienen texto propio, y los desconocidos también', () => {
  it('LOS CÓDIGOS SON LOS DEL SERVIDOR, letra por letra', () => {
    // La lista literal es la de `products/carts.py`. Si allí se añade uno y
    // aquí no, esta prueba lo dice antes que una pantalla que se calla.
    assert.deepEqual(
      [...AVISOS_CONOCIDOS],
      [
        'price_changed',
        'version_changed',
        'product_unavailable',
        'variant_missing',
        'price_not_configured',
        'inventory_not_configured',
        'insufficient_stock',
      ],
    );
  });

  it('los bloqueantes son cinco de esos siete, y todos existen', () => {
    for (const aviso of AVISOS_BLOQUEANTES) {
      assert.ok((AVISOS_CONOCIDOS as readonly string[]).includes(aviso), aviso);
    }
    assert.equal(AVISOS_BLOQUEANTES.length, 5);
  });

  it('cada aviso conocido tiene su clave, y ninguna se repite', () => {
    const claves = AVISOS_CONOCIDOS.map(claveDelAviso);
    assert.equal(new Set(claves).size, claves.length);
    for (const clave of claves) assert.ok(clave.startsWith('carrito.aviso.'), clave);
  });

  it('UN CÓDIGO DESCONOCIDO NO SE CALLA: tiene su propia clave', () => {
    // Una línea que no se puede comprar y no dice por qué es peor que una
    // explicación imprecisa.
    assert.equal(claveDelAviso('lo_que_sea'), 'carrito.aviso.desconocido');
    assert.equal(claveDelAviso(''), 'carrito.aviso.desconocido');
    assert.notEqual(claveDelAviso('lo_que_sea'), null);
  });

  it('cada aviso conocido lleva icono: el color no es el único que informa', () => {
    for (const aviso of AVISOS_CONOCIDOS) {
      assert.ok(iconoDelAviso(aviso) !== null, aviso);
    }
  });

  it('uno que no conocemos va SIN icono, pero CON texto', () => {
    assert.equal(iconoDelAviso('inventado'), null);
    assert.equal(claveDelAviso('inventado'), 'carrito.aviso.desconocido');
  });
});

/* ========================================================================== */
describe('cuando algo sale mal', () => {
  it('cada código del carrito tiene su mensaje, y ninguno se repite', () => {
    const codigos = [
      'product_cart_not_available',
      'product_cart_item_not_found',
      'product_cart_currency_mismatch',
      'product_cart_quantity_invalid',
      'product_price_not_configured',
      'product_inventory_not_configured',
      'product_inventory_insufficient',
      'product_variant_not_found',
      'product_not_found',
    ];
    const claves = codigos.map(claveDeErrorDelCarrito);
    assert.ok(claves.every((x) => x !== null));
    assert.equal(new Set(claves).size, claves.length);
  });

  it('un código que no conocemos deja hablar al servidor', () => {
    assert.equal(claveDeErrorDelCarrito('lo_que_sea'), null);
    assert.equal(claveDeErrorDelCarrito(null), null);
    assert.equal(claveDeErrorDelCarrito('   '), null);
  });

  it('la 0075 sin aplicar NO ES UNA AVERÍA', () => {
    assert.equal(esCarritoApagado('product_cart_not_available'), true);
    assert.equal(esCarritoApagado('product_inventory_insufficient'), false);
    assert.equal(esCarritoApagado(null), false);
  });

  it('la clave de una pulsación distingue producto, variante y momento', () => {
    // Es lo que separa un doble toque —que no debe sumar dos— de dos toques.
    assert.equal(claveDeLaPulsacion('p1', 'v1', 1_700_000_000_000), 'p1:v1:1700000000000');
    assert.notEqual(
      claveDeLaPulsacion('p1', 'v1', 1),
      claveDeLaPulsacion('p1', 'v2', 1),
    );
    assert.notEqual(
      claveDeLaPulsacion('p1', 'v1', 1),
      claveDeLaPulsacion('p1', 'v1', 2),
    );
  });
});

/* ========================================================================== */
describe('lo que la pantalla de la bolsa tiene escrito', () => {
  const carritoSrc = sinComentarios(fuente('screens', 'CarritoScreen.tsx'));
  const fichaSrc = sinComentarios(fuente('screens', 'ProductoScreen.tsx'));
  const repositorio = sinComentarios(fuente('repositories', 'ProductCartRepository.ts'));

  /** Los nombres que llevan «compr» dentro y NO son un botón de comprar. */
  const sinLosNombresPermitidos = (codigo: string) =>
    codigo
      .toLowerCase()
      .split('sepuedecomprar')
      .join('')
      .split('nadacomprable')
      .join('')
      .split('todavianosecompra')
      .join('')
      .split('sincomprar')
      .join('')
      .split('compraprotegida')
      .join('');

  it('LA BOLSA NO PINTA NINGÚN BOTÓN DE PAGAR NI DE COMPRAR', () => {
    // Desde el Incremento 5 la bolsa SÍ lleva a algún sitio, pero ese sitio no
    // es un cobro: es revisar la dirección y leer las condiciones. Las palabras
    // que siguen prohibidas son las que prometen dinero.
    const bajo = sinLosNombresPermitidos(carritoSrc)
      .split('pedidodeproducto')
      .join('')
      .split('/productos/pedidos')
      .join('');
    for (const prohibido of [
      'comprar',
      'pagar',
      'finalizar',
      'tarjeta de credito',
      'paypal',
    ]) {
      assert.ok(!bajo.includes(prohibido), `la bolsa dice «${prohibido}»`);
    }
  });

  it('el botón solo existe si el servidor dice que hay algo que comprar', () => {
    // La condición se lee del carrito que devolvió el servidor, y ese campo lo
    // escribe la ruta: para que llegue en `true` hacen falta cinco banderas y
    // una política publicada. La pantalla no lo decide por su cuenta.
    assert.ok(carritoSrc.includes('sePuedeComprar(leido)'));
    assert.ok(carritoSrc.includes("carrito.accion.continuar"));
  });

  it('y cuando no lo hay, sigue diciendo en el pie que todavía no se compra', () => {
    assert.ok(carritoSrc.includes('CLAVE_TODAVIA_NO_SE_COMPRA'));
  });

  it('el subtotal que se pinta es el del servidor, no una suma del cliente', () => {
    assert.ok(carritoSrc.includes('subtotalDelCarrito('));
    for (const suma of ['reduce(', '* linea.quantity', 'quantity *']) {
      assert.ok(!carritoSrc.includes(suma), `la bolsa suma con «${suma}»`);
    }
  });

  it('y nunca escribe un «0.00» a mano', () => {
    assert.ok(!carritoSrc.includes('0.00'));
    assert.ok(!carritoSrc.includes('?? 0'));
    assert.ok(carritoSrc.includes('CLAVE_SIN_IMPORTE'));
  });

  it('el «+» y el «−» se apagan con las funciones del módulo', () => {
    assert.ok(carritoSrc.includes('sePuedeSumar('));
    assert.ok(carritoSrc.includes('sePuedeRestar('));
    assert.ok(carritoSrc.includes('cantidadTrasTocar('));
    // Y no se mira el inventario a mano, que es donde `null` se vuelve cero.
    assert.ok(!carritoSrc.includes('available ?? 0'));
    assert.ok(!carritoSrc.includes('available > 0'));
  });

  it('cada aviso va con su icono Y su texto, nunca con un color solo', () => {
    assert.ok(carritoSrc.includes('avisosOrdenados('));
    assert.ok(carritoSrc.includes('iconoDelAviso('));
    assert.ok(carritoSrc.includes('claveDelAviso('));
  });

  it('una línea bloqueada se marca, pero SIGUE EN LA LISTA', () => {
    assert.ok(carritoSrc.includes('lineaBloqueada('));
    // Filtrarla la haría desaparecer sin explicación, que es justo lo contrario
    // de avisar.
    for (const filtro of ['.filter((l) => !lineaBloqueada', 'items.filter(']) {
      assert.ok(!carritoSrc.includes(filtro), filtro);
    }
  });

  it('tiene sus estados: carga, sin sesión, 503, sin conexión, error y vacío', () => {
    assert.ok(carritoSrc.includes('state="loading"'));
    assert.ok(carritoSrc.includes('state="empty"'));
    assert.ok(carritoSrc.includes('esFaltaDeSesion('));
    assert.ok(carritoSrc.includes('esCarritoApagado('));
    assert.ok(carritoSrc.includes('esFalloDeRed('));
    assert.ok(carritoSrc.includes('onRetry'));
  });

  it('vaciar la bolsa se pregunta antes', () => {
    assert.ok(carritoSrc.includes('confirm('));
  });

  it('el doble toque está cerrado con un cerrojo, no con un estado', () => {
    // Un `useState` se actualiza en el siguiente render: dos toques seguidos
    // pasan los dos. La referencia se cierra antes del primer `await`.
    assert.ok(carritoSrc.includes('ocupadoRef'));
    assert.ok(carritoSrc.includes('ocupadoRef.current = true'));
  });

  it('ningún texto en duro: todo pasa por el traductor', () => {
    for (const atributo of ['label="', 'title="', 'description="', 'placeholder="']) {
      assert.ok(!carritoSrc.includes(atributo), atributo);
    }
  });

  it('EL BOTÓN DE LA FICHA AÑADE A LA BOLSA, y no dice comprar', () => {
    assert.ok(fichaSrc.includes("f('carrito.anadir')"));
    const bajo = sinLosNombresPermitidos(fichaSrc);
    for (const prohibido of ['comprar', 'checkout', 'pagar', 'pedido']) {
      assert.ok(!bajo.includes(prohibido), `la ficha dice «${prohibido}»`);
    }
  });

  it('y manda una clave de idempotencia generada UNA vez', () => {
    assert.ok(fichaSrc.includes('claveDeLaPulsacion('));
    assert.ok(fichaSrc.includes('ProductCartRepository.anadir('));
  });

  it('el repositorio de la bolsa no sabe pagar: no hay ruta que llamar', () => {
    for (const prohibido of ['/checkout', '/orders', '/payments', 'comprar(', 'pagar(']) {
      assert.ok(!repositorio.includes(prohibido), prohibido);
    }
  });
});
