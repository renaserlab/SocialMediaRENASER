/**
 * El inventario de quien vende, ejecutado.
 *
 * LO QUE SE PRUEBA AQUÍ ES, CASI ENTERO, LA DIFERENCIA ENTRE `null` Y CERO. No
 * es una sutileza de tipos: es la única forma que tiene quien vende de saber si
 * le falta cargar la primera entrada de un SKU o si se le agotó lo que tenía.
 * Las dos cosas se ven igual de mal escritas —un «0» grande— y significan lo
 * contrario:
 *
 *  1. `stock: null` ES «SIN EXISTENCIAS CARGADAS». Nadie ha cargado nada
 *     todavía. Lo que falta es una acción de quien vende, y la pantalla tiene
 *     que decirlo con palabras. Escribir «Agotado» ahí manda a alguien a buscar
 *     unas ventas que no existen.
 *  2. `available: 0` CON `stock` PRESENTE SÍ ES CERO. Se cargó, se vendió o se
 *     ajustó, y ahora no queda nada vendible. Ese sí es «agotado».
 *
 * Y la segunda regla: LO DISPONIBLE LO CALCULA EL SERVIDOR. Aquí no se resta
 * `on_hand - reserved` en ningún sitio, ni siquiera para comprobar. El día que
 * el servidor cambie esa definición, la pantalla que restara por su cuenta
 * seguiría enseñando la resta vieja sin que nada fallara.
 *
 * La tercera: LOS CINCO MOVIMIENTOS NO SON CINCO BOTONES. `reservation`,
 * `release` y `dispatch` existen en el servidor y funcionan, pero los provoca el
 * checkout, que todavía no existe. Ofrecerlos sería un botón que no lleva a
 * ninguna parte.
 *
 * NO SE COMPRUEBAN LOS DICCIONARIOS. Las claves `inventario.*` todavía no están
 * en `es.ts`: viajan aparte, en el fichero de traducciones del incremento, y
 * quien las integre las mete de una vez en los tres idiomas. Lo que sí se
 * comprueba es que las claves que produce el módulo tengan la forma que se
 * espera, porque un prefijo mal escrito no falla: enseña la clave en crudo.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MAXIMO_DEL_MOVIMIENTO,
  MOVIMIENTOS,
  MOVIMIENTOS_DEL_PROVEEDOR,
  ajusteImposible,
  ajusteValido,
  cantidadDelMovimiento,
  claveDeErrorDeInventario,
  claveDelEstado,
  claveDelMovimiento,
  claveDelMovimientoNuevo,
  disponibleDe,
  entradaValida,
  esInventarioApagado,
  estadoDeLaUnidad,
  iconoDelMovimiento,
  inventarioDisponible,
  inventarioVacio,
  tieneInventario,
  totalDisponible,
  unidadesCargadas,
  type Existencias,
  type Inventario,
  type Movimiento,
  type UnidadDeInventario,
} from './inventario.ts';

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

function existencias(campos: Partial<Existencias> = {}): Existencias {
  return { sku: 'SKU-1', on_hand: 10, reserved: 2, available: 8, ...campos };
}

function unidad(campos: Partial<UnidadDeInventario> = {}): UnidadDeInventario {
  return {
    variant_id: 'variante-1',
    sku: 'SKU-1',
    name: 'Grande',
    options: {},
    price_delta_minor: 0,
    stock: null,
    ...campos,
  };
}

function inventario(campos: Partial<Inventario> = {}): Inventario {
  return {
    product_id: 'producto-1',
    version_id: 'version-1',
    units: [],
    disponible: true,
    ...campos,
  };
}

function movimiento(campos: Partial<Movimiento> = {}): Movimiento {
  return {
    id: 'movimiento-1',
    sku: 'SKU-1',
    kind: 'intake',
    quantity: 10,
    on_hand_after: 10,
    reserved_after: 0,
    available_after: 10,
    reason: null,
    actor_id: 'persona-1',
    actor_role: 'seller',
    created_at: '2026-03-01T10:00:00Z',
    ...campos,
  };
}

/* ========================================================================== */
describe('`null` NO ES CERO, y es la regla que más pesa', () => {
  it('sin inventario cargado el estado es `sinCargar`, NUNCA `agotado`', () => {
    // Son dos cosas distintas: la primera es que falta hacer algo, la segunda
    // es que se vendió o se ajustó todo lo que había.
    const sinNada = unidad({ stock: null });
    assert.equal(estadoDeLaUnidad(sinNada), 'sinCargar');
    assert.notEqual(estadoDeLaUnidad(sinNada), 'agotado');
    assert.equal(tieneInventario(sinNada), false);
  });

  it('un cero de verdad SÍ es `agotado`, y no se confunde con el otro', () => {
    const vacia = unidad({ stock: existencias({ on_hand: 0, reserved: 0, available: 0 }) });
    assert.equal(estadoDeLaUnidad(vacia), 'agotado');
    assert.equal(tieneInventario(vacia), true);
    // Y los dos estados tienen texto propio: no comparten clave.
    assert.notEqual(claveDelEstado('sinCargar'), claveDelEstado('agotado'));
  });

  it('todo comprometido no es agotado: hay unidades, pero ninguna vendible', () => {
    const comprometida = unidad({
      stock: existencias({ on_hand: 5, reserved: 5, available: 0 }),
    });
    assert.equal(estadoDeLaUnidad(comprometida), 'comprometido');
  });

  it('`disponibleDe` devuelve `null`, y no cero, cuando no se sabe', () => {
    // Un cero aquí acabaría pintado como un número medido que nadie midió.
    assert.equal(disponibleDe(unidad({ stock: null })), null);
    assert.notEqual(disponibleDe(unidad({ stock: null })), 0);
    assert.equal(disponibleDe(unidad({ stock: existencias({ available: 0 }) })), 0);
    assert.equal(disponibleDe(unidad({ stock: existencias({ available: 8 }) })), 8);
  });

  it('LO DISPONIBLE LO MANDA EL SERVIDOR: aquí no se resta nada', () => {
    // `available` incoherente con la resta a propósito: si el módulo restara
    // por su cuenta, esto daría 7 en vez de los 3 que manda el servidor.
    const rara = unidad({ stock: existencias({ on_hand: 10, reserved: 3, available: 3 }) });
    assert.equal(disponibleDe(rara), 3);
  });

  it('las cuatro claves de estado cuelgan de su prefijo y no se repiten', () => {
    const claves = (['sinCargar', 'agotado', 'comprometido', 'disponible'] as const).map(
      claveDelEstado,
    );
    assert.equal(new Set(claves).size, 4);
    for (const clave of claves) assert.ok(clave.startsWith('inventario.estado.'), clave);
  });
});

/* ========================================================================== */
describe('el total: `null` si nadie cargó nada', () => {
  it('sin ninguna variante cargada NO HAY TOTAL, y no es cero', () => {
    // Sumar ceros de cosas que nadie cargó da un total que parece medido.
    const nada = inventario({ units: [unidad(), unidad({ variant_id: 'v2', sku: 'SKU-2' })] });
    assert.equal(totalDisponible(nada), null);
    assert.notEqual(totalDisponible(nada), 0);
    assert.equal(unidadesCargadas(nada), 0);
  });

  it('con algunas cargadas se suman ESAS, aunque falten otras', () => {
    const mezcla = inventario({
      units: [
        unidad({ stock: existencias({ available: 8 }) }),
        unidad({ variant_id: 'v2', sku: 'SKU-2', stock: null }),
        unidad({ variant_id: 'v3', sku: 'SKU-3', stock: existencias({ available: 4 }) }),
      ],
    });
    assert.equal(totalDisponible(mezcla), 12);
    // Y se sabe cuántas faltan, que es lo que la pantalla dice al lado.
    assert.equal(unidadesCargadas(mezcla), 2);
  });

  it('un total de cero con todo cargado SÍ es cero', () => {
    const agotado = inventario({
      units: [unidad({ stock: existencias({ on_hand: 0, reserved: 0, available: 0 }) })],
    });
    assert.equal(totalDisponible(agotado), 0);
  });

  it('sin inventario leído no se inventa ningún número', () => {
    assert.equal(totalDisponible(null), null);
    assert.equal(unidadesCargadas(null), 0);
  });

  it('sin variantes está vacío, y eso no es un error', () => {
    assert.equal(inventarioVacio(inventario()), true);
    assert.equal(inventarioVacio(null), true);
    assert.equal(inventarioVacio(inventario({ units: [unidad()] })), false);
  });

  it('«no disponible» es la migración sin aplicar, no una lista vacía', () => {
    assert.equal(inventarioDisponible(inventario()), true);
    assert.equal(inventarioDisponible(inventario({ disponible: false })), false);
    assert.equal(inventarioDisponible(null), false);
  });
});

/* ========================================================================== */
describe('lo que se puede pedir: una entrada suma y nunca es cero', () => {
  it('cero NO es una entrada', () => {
    // Un movimiento de cero no es un movimiento: dejaría una línea de historial
    // que no cuenta nada.
    assert.equal(entradaValida(0), false);
  });

  it('una entrada negativa tampoco: para restar está el ajuste', () => {
    assert.equal(entradaValida(-1), false);
    assert.equal(entradaValida(-100), false);
  });

  it('los decimales no entran: las unidades son enteras', () => {
    assert.equal(entradaValida(1.5), false);
    assert.equal(entradaValida(0.9), false);
    assert.equal(entradaValida(10.0001), false);
  });

  it('lo que pasa del tope se rechaza aquí, igual que en el servidor', () => {
    assert.equal(MAXIMO_DEL_MOVIMIENTO, 1_000_000);
    assert.equal(entradaValida(MAXIMO_DEL_MOVIMIENTO), true);
    assert.equal(entradaValida(MAXIMO_DEL_MOVIMIENTO + 1), false);
  });

  it('lo que no es un número no es una entrada', () => {
    assert.equal(entradaValida(Number.NaN), false);
    assert.equal(entradaValida(Number.POSITIVE_INFINITY), false);
  });

  it('un entero positivo dentro del tope sí', () => {
    assert.equal(entradaValida(1), true);
    assert.equal(entradaValida(250), true);
  });
});

/* ========================================================================== */
describe('el ajuste: el único que resta, y el único que lleva motivo', () => {
  it('ACEPTA NEGATIVOS: es lo que lo distingue de una entrada', () => {
    assert.equal(ajusteValido(-3, 'rotura en el taller'), true);
    assert.equal(ajusteValido(-MAXIMO_DEL_MOVIMIENTO, 'recuento anual'), true);
  });

  it('pero nunca cero', () => {
    assert.equal(ajusteValido(0, 'no pasó nada'), false);
  });

  it('un motivo de menos de tres caracteres no es un motivo', () => {
    // Tres letras no describen nada, pero menos tampoco, y es lo mismo que
    // exige el servidor.
    assert.equal(ajusteValido(-3, ''), false);
    assert.equal(ajusteValido(-3, '  '), false);
    assert.equal(ajusteValido(-3, 'ok'), false);
    assert.equal(ajusteValido(-3, '  x  '), false);
    assert.equal(ajusteValido(-3, 'rot'), true);
  });

  it('los decimales y el tope valen igual que en la entrada', () => {
    assert.equal(ajusteValido(-1.5, 'rotura'), false);
    assert.equal(ajusteValido(MAXIMO_DEL_MOVIMIENTO + 1, 'recuento'), false);
    assert.equal(ajusteValido(-MAXIMO_DEL_MOVIMIENTO - 1, 'recuento'), false);
    assert.equal(ajusteValido(Number.NaN, 'recuento'), false);
  });

  it('un ajuste que dejaría la existencia NEGATIVA se detecta antes', () => {
    // Es cortesía para poder apagar el botón: la comprobación de verdad la hace
    // el servidor con la fila bloqueada, porque entre pintar y pulsar pasan cosas.
    const diez = unidad({ stock: existencias({ on_hand: 10, reserved: 2, available: 8 }) });
    assert.equal(ajusteImposible(diez, -11), true);
    assert.equal(ajusteImposible(diez, -10), false);
    assert.equal(ajusteImposible(diez, -3), false);
    assert.equal(ajusteImposible(diez, 5), false);
  });

  it('SE MIRA `on_hand`, no lo disponible: comprometer no es haber salido', () => {
    // Con 10 en existencia y 8 comprometidas quedan 2 disponibles, y aun así
    // restar 5 es posible: lo comprometido sigue estando en el almacén.
    const casiTodoReservado = unidad({
      stock: existencias({ on_hand: 10, reserved: 8, available: 2 }),
    });
    assert.equal(ajusteImposible(casiTodoReservado, -5), false);
  });

  it('sin inventario cargado no se puede decir que un ajuste sea imposible', () => {
    // No se sabe de cuánto se parte: lo dirá el servidor.
    assert.equal(ajusteImposible(unidad({ stock: null }), -100), false);
  });
});

/* ========================================================================== */
describe('la cantidad de un movimiento se lee con su signo', () => {
  it('lo que suma lleva `+`, para que la columna se lea de un vistazo', () => {
    assert.equal(cantidadDelMovimiento(movimiento({ quantity: 10 })), '+10');
    assert.equal(cantidadDelMovimiento(movimiento({ kind: 'adjustment', quantity: 3 })), '+3');
  });

  it('lo que resta lleva el menos, y solo el ajuste puede restar', () => {
    assert.equal(
      cantidadDelMovimiento(movimiento({ kind: 'adjustment', quantity: -4 })),
      '−4',
    );
    // El signo va delante y el número sale sin el suyo propio: nunca «−-4».
    assert.ok(!cantidadDelMovimiento(movimiento({ quantity: -4 })).includes('--'));
  });

  it('un cero se escribe como cero y no rompe la columna', () => {
    assert.equal(cantidadDelMovimiento(movimiento({ quantity: 0 })), '+0');
  });
});

/* ========================================================================== */
describe('LOS CINCO MOVIMIENTOS NO SON CINCO BOTONES', () => {
  it('quien vende solo provoca entrada y ajuste', () => {
    assert.deepEqual([...MOVIMIENTOS_DEL_PROVEEDOR], ['intake', 'adjustment']);
  });

  it('reservar, liberar y despachar NO están: los provoca el checkout', () => {
    // Existen en el servidor, funcionan y están probados, pero no hay checkout.
    // Un botón que no lleva a ninguna parte es peor que ningún botón.
    for (const delSistema of ['reservation', 'release', 'dispatch'] as const) {
      assert.ok(
        !MOVIMIENTOS_DEL_PROVEEDOR.includes(delSistema),
        `${delSistema} no lo provoca quien vende`,
      );
    }
  });

  it('pero los cinco se saben LEER: llegan en el historial', () => {
    assert.deepEqual(
      [...MOVIMIENTOS],
      ['intake', 'adjustment', 'reservation', 'release', 'dispatch'],
    );
    const claves = MOVIMIENTOS.map(claveDelMovimiento);
    assert.equal(new Set(claves).size, MOVIMIENTOS.length);
    for (const clave of claves) assert.ok(clave.startsWith('inventario.movimiento.'), clave);
  });

  it('un movimiento que no conocemos tiene su propio texto, no el de otro', () => {
    assert.equal(claveDelMovimiento('inventado'), 'inventario.movimiento.desconocido');
    assert.equal(claveDelMovimiento(''), 'inventario.movimiento.desconocido');
    assert.notEqual(claveDelMovimiento('inventado'), claveDelMovimiento('intake'));
  });

  it('y va SIN icono, en vez de con uno cualquiera', () => {
    assert.equal(iconoDelMovimiento('inventado'), null);
    for (const tipo of MOVIMIENTOS) {
      assert.ok(iconoDelMovimiento(tipo) !== null, tipo);
    }
    const iconos = MOVIMIENTOS.map(iconoDelMovimiento);
    assert.equal(new Set(iconos).size, MOVIMIENTOS.length);
  });
});

/* ========================================================================== */
describe('la clave de idempotencia y los errores', () => {
  it('la clave cambia con el momento y con el SKU', () => {
    // Una por pulsación: es lo que impide que un doble toque cargue el doble.
    assert.equal(claveDelMovimientoNuevo('SKU-1', 1_700_000_000_000), 'SKU-1:1700000000000');
    assert.notEqual(
      claveDelMovimientoNuevo('SKU-1', 1),
      claveDelMovimientoNuevo('SKU-2', 1),
    );
    assert.notEqual(
      claveDelMovimientoNuevo('SKU-1', 1),
      claveDelMovimientoNuevo('SKU-1', 2),
    );
  });

  it('un momento con decimales no produce dos claves distintas', () => {
    assert.equal(
      claveDelMovimientoNuevo('SKU-1', 1_700_000_000_000.7),
      claveDelMovimientoNuevo('SKU-1', 1_700_000_000_000),
    );
  });

  it('cada código del servidor tiene su mensaje, y ninguno se repite', () => {
    const codigos = [
      'product_inventory_not_available',
      'product_inventory_not_configured',
      'product_inventory_insufficient',
      'product_inventory_movement_invalid',
      'product_variant_not_found',
    ];
    const claves = codigos.map(claveDeErrorDeInventario);
    assert.ok(claves.every((x) => x !== null));
    assert.equal(new Set(claves).size, claves.length);
    for (const clave of claves) assert.ok(String(clave).startsWith('inventario.error.'), String(clave));
  });

  it('un código que no conocemos deja hablar al servidor', () => {
    assert.equal(claveDeErrorDeInventario('lo_que_sea'), null);
    assert.equal(claveDeErrorDeInventario(''), null);
    assert.equal(claveDeErrorDeInventario(null), null);
    assert.equal(claveDeErrorDeInventario(undefined), null);
  });

  it('el 503 de la migración no es una avería, y se distingue', () => {
    assert.equal(esInventarioApagado('product_inventory_not_available'), true);
    assert.equal(esInventarioApagado('product_inventory_not_configured'), false);
    assert.equal(esInventarioApagado('network_error'), false);
    assert.equal(esInventarioApagado(null), false);
  });
});

/* ========================================================================== */
describe('lo que la pantalla tiene escrito', () => {
  const pantalla = sinComentarios(fuente('screens', 'InventarioDeProductoScreen.tsx'));

  it('NINGÚN `?? 0` SOBRE UNAS EXISTENCIAS: sería convertir `null` en cero', () => {
    for (const prohibido of [
      'stock ?? 0',
      'available ?? 0',
      'on_hand ?? 0',
      'reserved ?? 0',
      'disponible ?? 0',
      'totalDisponible(inventario) ?? 0',
    ]) {
      assert.ok(!pantalla.includes(prohibido), `la pantalla escribe «${prohibido}»`);
    }
  });

  it('el estado sale del módulo, no de un `if` escrito a mano', () => {
    assert.ok(pantalla.includes('estadoDeLaUnidad(unidad)'));
    assert.ok(pantalla.includes('claveDelEstado(estado)'));
    // Y no se mira `available` para decidir qué palabra poner.
    assert.ok(!pantalla.includes('available === 0 ?'));
    assert.ok(!pantalla.includes('available > 0 ?'));
  });

  it('NO SE RESTA NADA: lo disponible llega calculado', () => {
    assert.ok(!pantalla.includes('on_hand - '));
    assert.ok(!pantalla.includes('- reserved'));
  });

  it('ni un umbral de «quedan pocas» ni ningún plazo de reposición', () => {
    // El contrato no manda ninguno: ponerlo aquí sería inventarse una regla de
    // negocio que nadie ha decidido.
    for (const inventado of ['quedanPocas', 'stockBajo', 'lowStock', 'reposicion', 'restock']) {
      assert.ok(!pantalla.toLowerCase().includes(inventado.toLowerCase()), inventado);
    }
  });

  it('la clave de idempotencia se genera UNA VEZ y se reenvía', () => {
    assert.ok(pantalla.includes('claveDelMovimientoNuevo(unidad.sku, Date.now())'));
    // Se guarda en una referencia para que el reintento mande la misma.
    assert.ok(pantalla.includes('claveDelEnvio.current'));
    assert.ok(pantalla.includes('idempotency_key: clave'));
  });

  it('el doble toque está atado además con un cerrojo, cerrado antes del await', () => {
    const cerrojo = pantalla.slice(pantalla.indexOf('const conCerrojo'));
    const hasta = cerrojo.slice(0, cerrojo.indexOf('await trabajo()'));
    assert.ok(hasta.includes('if (ocupadoRef.current) return;'));
    assert.ok(!hasta.includes('await '));
  });

  it('tiene sus estados: carga, vacío, sin conexión, error con reintento y el 503', () => {
    assert.ok(pantalla.includes('state="loading"'));
    assert.ok(pantalla.includes('state="empty"'));
    assert.ok(pantalla.includes("'offline' : 'error'"));
    assert.ok(pantalla.includes('onRetry={() => void cargar()}'));
    assert.ok(pantalla.includes('esInventarioApagado('));
    assert.ok(pantalla.includes('esFalloDeRed('));
    assert.ok(pantalla.includes('inventarioVacio(inventario)'));
  });

  it('ningún texto en duro: todo pasa por el traductor', () => {
    for (const atributo of ['label="', 'title="', 'description="', 'placeholder="']) {
      assert.ok(!pantalla.includes(atributo), `lleva ${atributo}`);
    }
    for (const atributo of ["title: '", "message: '", "confirmLabel: '"]) {
      assert.ok(!pantalla.includes(atributo), `lleva ${atributo}`);
    }
  });

  it('no ofrece reservar, liberar ni despachar', () => {
    for (const prohibido of ['reservar(', 'liberar(', 'despachar(', '/reserve', '/dispatch']) {
      assert.ok(!pantalla.includes(prohibido), prohibido);
    }
  });

  it('la ruta de expo-router existe y monta la pantalla', () => {
    const ruta = readFileSync(
      join(AQUI, '..', '..', 'app', 'proveedor', 'productos', '[productId]', 'inventario.tsx'),
      'utf8',
    );
    assert.ok(ruta.includes('InventarioDeProductoScreen'));
  });

  it('se llega al inventario desde «Mis productos»', () => {
    const mios = sinComentarios(fuente('screens', 'MisProductosScreen.tsx'));
    assert.ok(mios.includes('/inventario'));
    assert.ok(mios.includes("f('inventario.acceso')"));
  });
});
