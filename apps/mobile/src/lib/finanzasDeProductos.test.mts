/**
 * Las reglas del dinero de Productos, ejecutadas.
 *
 * Las que más importan son cinco, y las cinco se pueden romper sin que se note
 * mirando la aplicación:
 *
 *  1. Un `0,00` donde lo que pasa es que la empresa no ha decidido la comisión.
 *     Se lee como «vendiste y no cobraste», que es lo contrario de la verdad, y
 *     es la peor cosa que esta pantalla puede decirle a quien vende.
 *  2. Un importe sin su moneda. 19 900 soles y 19 900 dólares son el mismo
 *     número y distinto dinero, y con dos monedas en la misma cuenta un total
 *     sumado no existe.
 *  3. Una comisión calculada aquí. El porcentaje vive en el servidor y en la
 *     versión de reglas que congeló cada venta; recalcularlo con el de hoy
 *     reescribiría ventas históricas.
 *  4. Decir que el dinero volvió cuando solo se aprobó. `approved` es una
 *     decisión, `requested` una petición y `processing` una espera: ninguna de
 *     las tres es dinero devuelto.
 *  5. `available_at` nulo leído como «ya». No es «ya»: es que todavía no se
 *     sabe, porque el paquete no ha llegado o la política no fija el plazo.
 *
 * Las que no son funciones —lo que está escrito en las pantallas— se comprueban
 * sobre el código fuente.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { en } from '../i18n/en.ts';
import { es } from '../i18n/es.ts';
import { pt } from '../i18n/pt.ts';
import {
  BLOQUEOS,
  ESTADOS_DE_DEVOLUCION,
  ESTADOS_DE_DISPUTA,
  ESTADOS_DE_SALDO,
  MOTIVOS_DE_RETENCION,
  claveDeErrorFinanciero,
  claveDelBloqueo,
  claveDelEstadoDeDevolucion,
  claveDelEstadoDeDisputa,
  claveDelEstadoDeSaldo,
  claveDelMotivoDeRetencion,
  claveDeQueHacer,
  contadoresDelPanel,
  cuandoSeLibera,
  cursorDeLaPagina,
  desglose,
  disponibleLegible,
  elDineroYaVolvio,
  esBloqueoDeEspera,
  esBloqueoSuyo,
  esFinanzasApagadas,
  estaBloqueado,
  faltaDecidirLaComision,
  fusionarPaginas,
  hayBalance,
  hayMasPaginas,
  horasQueFaltan,
  importe,
  importeDeLaDevolucion,
  laCuentaEstaLista,
  motivoDelRechazo,
  puedeMoverDinero,
  queLeFaltaALaCuenta,
  queLeFaltaAlPanel,
  retenidoLegible,
  sePuedeAnular,
  sePuedeDarConformidad,
  sePuedePedir,
  sigueEnMarcha,
  topeDeLaDevolucion,
  yaDioLaConformidad,
} from './finanzasDeProductos.ts';

const RAIZ = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function fuente(...partes: string[]): string {
  return readFileSync(join(RAIZ, ...partes), 'utf8');
}

/** El código sin comentarios: un comentario que nombra un número no lo usa. */
function sinComentarios(codigo: string): string {
  return codigo
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');
}

const DICCIONARIOS: Array<Record<string, string>> = [
  es as unknown as Record<string, string>,
  en as unknown as Record<string, string>,
  pt as unknown as Record<string, string>,
];

const PANTALLAS = ['MiSaldoDeProductosScreen.tsx', 'FinanzasDeProductosScreen.tsx'];

const CON_VENTAS = {
  currency: 'PEN',
  gross_minor: 100_000,
  platform_fee_minor: 10_000,
  net_minor: 90_000,
  held_minor: 5_000,
  available_minor: 90_000,
  sales: 3,
  fee_configured: true,
  by_status: { pending: 2, eligible: 1 },
};

const SIN_COMISION = {
  currency: null,
  gross_minor: 0,
  platform_fee_minor: 0,
  net_minor: 0,
  held_minor: 0,
  available_minor: 0,
  sales: 0,
  fee_configured: false,
  by_status: {},
};

// ========================================================================== //
// 1. Sin comisión decidida no hay balance, y no hay un cero
// ========================================================================== //
describe('sin comisión decidida no se inventa un balance', () => {
  it('no hay balance, y se distingue de «no has vendido»', () => {
    assert.equal(hayBalance(SIN_COMISION), false);
    assert.equal(faltaDecidirLaComision(SIN_COMISION), true);
    // CON COMISIÓN Y SIN VENTAS son dos cosas distintas, y se pintan distinto.
    const sinVentas = { ...CON_VENTAS, sales: 0 };
    assert.equal(hayBalance(sinVentas), false);
    assert.equal(faltaDecidirLaComision(sinVentas), false);
    assert.equal(hayBalance(CON_VENTAS), true);
  });

  it('no se pinta ningún importe, ni un 0,00', () => {
    assert.equal(disponibleLegible(SIN_COMISION), null);
    assert.equal(retenidoLegible(SIN_COMISION), null);
    assert.deepEqual(desglose(SIN_COMISION), []);
  });

  it('un importe que llegara con la bandera apagada tampoco se pinta', () => {
    // Defensa contra un servidor que mandara cifras residuales: sin comisión
    // decidida no existe ni un saldo, así que cualquier cifra sería inventada.
    const raro = { ...SIN_COMISION, net_minor: 90_000, currency: 'PEN', sales: 3 };
    assert.equal(disponibleLegible(raro), null);
    assert.deepEqual(desglose(raro), []);
  });

  it('con ventas de verdad sí se pinta, y con su moneda', () => {
    assert.equal(disponibleLegible(CON_VENTAS), '900.00 PEN');
    assert.equal(retenidoLegible(CON_VENTAS), '50.00 PEN');
    const filas = desglose(CON_VENTAS);
    assert.equal(filas.length, 3);
    assert.deepEqual(
      filas.map((x) => x.texto),
      ['1000.00 PEN', '100.00 PEN', '900.00 PEN'],
    );
  });

  it('lo retenido en cero no se pinta: no hay nada apartado', () => {
    assert.equal(retenidoLegible({ ...CON_VENTAS, held_minor: 0 }), null);
  });
});

// ========================================================================== //
// 2. Ni un importe sin su moneda
// ========================================================================== //
describe('ni un importe sin su moneda', () => {
  it('sin moneda, null', () => {
    assert.equal(importe(1000, null), null);
    assert.equal(importe(1000, undefined), null);
    assert.equal(importe(1000, ''), null);
    assert.equal(importe(1000, 'PE'), null, 'una moneda de dos letras no es una moneda');
  });

  it('sin importe, null', () => {
    assert.equal(importe(null, 'PEN'), null);
    assert.equal(importe(undefined, 'PEN'), null);
    assert.equal(importe(Number.NaN, 'PEN'), null);
  });

  it('con dos monedas distintas el servidor manda la moneda nula, y no se suma', () => {
    // El servidor lo hace a propósito; aquí lo que se comprueba es que la capa
    // no se inventa un total cuando llega así.
    const dos = { ...CON_VENTAS, currency: null };
    assert.equal(disponibleLegible(dos), null);
    assert.deepEqual(desglose(dos), []);
  });

  it('un cero DE VERDAD sí se pinta, porque cero dinero es un dato', () => {
    assert.equal(importe(0, 'PEN'), '0.00 PEN');
  });

  it('no se formatea con símbolos ni separadores locales', () => {
    // Eso es de la pantalla, que sabe el idioma. Aquí solo unidad y código.
    assert.equal(importe(123456, 'USD'), '1234.56 USD');
    assert.ok(!/[.,]\d{3}/.test(importe(123456789, 'USD') as string));
  });
});

// ========================================================================== //
// 3. Ninguna comisión calculada aquí
// ========================================================================== //
describe('la comisión vive en el servidor', () => {
  it('este fichero no multiplica por ningún porcentaje', () => {
    const codigo = sinComentarios(fuente('lib', 'finanzasDeProductos.ts'));
    // Ni la base de puntos básicos, ni una división por 10 000.
    assert.ok(!codigo.includes('10_000'), 'nombra la base de puntos básicos');
    assert.ok(!codigo.includes('10000'), 'nombra la base de puntos básicos');
    // `platform_fee_bps` SÍ aparece, pero solo como el NOMBRE de lo que falta
    // por configurar, dentro de una lista de cadenas. Lo que no puede aparecer
    // es leído de un objeto, que es la forma de usarlo para calcular.
    assert.ok(!/\.platform_fee_bps/.test(codigo), 'lee el porcentaje de un dato');
    assert.ok(!/\[.platform_fee_bps.\]/.test(codigo), 'lee el porcentaje de un dato');
    assert.ok(
      !/[*/]\s*bps|bps\s*[*/]/.test(codigo),
      'multiplica o divide por el porcentaje',
    );

    // CONTROL POSITIVO del segundo centinela también.
    assert.ok(/\.platform_fee_bps/.test(codigo + 'const p = salud.platform_fee_bps;'));

    // CONTROL POSITIVO: el centinela tiene que ver el cálculo si aparece.
    const roto = sinComentarios(codigo + 'const c = bruto * bps / 10_000;');
    assert.ok(roto.includes('10_000'), 'el centinela no ve el cálculo');
  });

  it('el repositorio tampoco calcula nada', () => {
    const codigo = sinComentarios(
      fuente('repositories', 'ProductFinanceRepository.ts'),
    );
    assert.ok(!codigo.includes('10_000'));
    assert.ok(!/\bbps\b/.test(codigo));
  });
});

// ========================================================================== //
// 4. Aprobar no es pagar
// ========================================================================== //
describe('solo `confirmed` dice que el dinero volvió', () => {
  const de = (status: string) => ({
    id: 'r',
    order_id: 'o',
    amount_minor: 1000,
    currency: 'PEN',
    kind: 'partial',
    status,
    provider: 'none',
    decision_reason: 'x',
    created_at: 'x',
  });

  it('las tres que no son dinero devuelto', () => {
    for (const status of ['approved', 'requested', 'processing']) {
      assert.equal(elDineroYaVolvio(de(status)), false, status);
      assert.equal(sigueEnMarcha(de(status)), true, status);
    }
    assert.equal(elDineroYaVolvio(de('confirmed')), true);
    assert.equal(sigueEnMarcha(de('confirmed')), false);
    assert.equal(elDineroYaVolvio(de('failed')), false);
    assert.equal(elDineroYaVolvio(null), false);
  });

  it('una confirmada no se vuelve a pedir ni se anula', () => {
    assert.equal(sePuedePedir(de('confirmed')), false);
    assert.equal(sePuedeAnular(de('confirmed')), false);
    // UNA FALLIDA SÍ SE REINTENTA: el fallo puede ser de la pasarela.
    assert.equal(sePuedePedir(de('failed')), true);
    assert.equal(sePuedeAnular(de('failed')), false);
    assert.equal(sePuedePedir(de('approved')), true);
    assert.equal(sePuedeAnular(de('approved')), true);
  });

  it('el importe viaja con su moneda', () => {
    assert.equal(importeDeLaDevolucion(de('approved')), '10.00 PEN');
    assert.equal(importeDeLaDevolucion(null), null);
  });
});

// ========================================================================== //
// 5. `available_at` nulo no es «ya»
// ========================================================================== //
describe('el reloj de la protección', () => {
  const saldo = (available_at: string | null) => ({
    id: 's',
    order_id: 'o',
    status: 'pending',
    currency: 'PEN',
    gross_minor: 1000,
    platform_fee_minor: 100,
    provider_fee_minor: 0,
    net_minor: 900,
    fee_rules_version: 'v1',
    available_at,
    created_at: '2026-09-01T00:00:00Z',
  });

  it('nulo es «todavía no se sabe», y no cero horas', () => {
    assert.equal(cuandoSeLibera(saldo(null)), null);
    assert.equal(
      horasQueFaltan(saldo(null)),
      null,
      'un nulo leído como cero diría que ya se puede pagar',
    );
  });

  it('una fecha futura da las horas que faltan, redondeando hacia arriba', () => {
    const ahora = new Date('2026-09-22T00:00:00Z');
    assert.equal(horasQueFaltan(saldo('2026-09-22T10:30:00Z'), ahora), 11);
  });

  it('una fecha pasada da cero, que sí es cero', () => {
    const ahora = new Date('2026-09-22T00:00:00Z');
    assert.equal(horasQueFaltan(saldo('2026-09-21T00:00:00Z'), ahora), 0);
  });

  it('una fecha que no se entiende no se inventa', () => {
    assert.equal(horasQueFaltan(saldo('mañana')), null);
  });
});

// ========================================================================== //
// 6. Los bloqueos, y qué hacer con cada uno
// ========================================================================== //
describe('cada bloqueo dice qué hacer, y a veces es «nada»', () => {
  it('los catorce tienen motivo y tienen qué hacer', () => {
    for (const bloqueo of BLOQUEOS) {
      assert.equal(claveDelBloqueo(bloqueo), `finanzaDeProducto.bloqueo.${bloqueo}`);
      assert.equal(claveDeQueHacer(bloqueo), `finanzaDeProducto.queHacer.${bloqueo}`);
    }
    assert.equal(claveDelBloqueo('xx'), 'finanzaDeProducto.bloqueo.desconocido');
    assert.equal(claveDeQueHacer('xx'), 'finanzaDeProducto.queHacer.desconocido');
  });

  it('solo los dos de la cuenta dependen de quien vende', () => {
    assert.equal(esBloqueoSuyo('payout_account_missing'), true);
    assert.equal(esBloqueoSuyo('payout_account_not_ready'), true);
    for (const otro of ['incident_open', 'dispute_open', 'fee_not_configured']) {
      assert.equal(esBloqueoSuyo(otro), false, otro);
    }
    assert.equal(esBloqueoSuyo(null), false);
  });

  it('y tres son «espera, no pasa nada»', () => {
    assert.equal(esBloqueoDeEspera('not_delivered'), true);
    assert.equal(esBloqueoDeEspera('protection_window_open'), true);
    assert.equal(esBloqueoDeEspera('reserve_held'), false);
  });

  it('un saldo sin bloqueo no está bloqueado', () => {
    assert.equal(estaBloqueado({ block: null } as never), false);
    assert.equal(estaBloqueado({ block: '' } as never), false);
    assert.equal(estaBloqueado({ block: 'incident_open' } as never), true);
  });
});

// ========================================================================== //
// 7. La conformidad no es confirmar que llegó
// ========================================================================== //
describe('la conformidad', () => {
  it('solo sobre algo entregado, una vez, y sin reclamación viva', () => {
    const llego = { status: 'DELIVERED', delivered_at: 'x', conformity_at: null };
    assert.equal(sePuedeDarConformidad(llego, false), true);
    assert.equal(sePuedeDarConformidad(llego, true), false, 'con reclamación viva, no');
    assert.equal(
      sePuedeDarConformidad({ ...llego, conformity_at: 'y' }, false),
      false,
      'dos veces, no',
    );
    assert.equal(
      sePuedeDarConformidad({ status: 'DISPATCHED', delivered_at: null }, false),
      false,
      'sin entrega, no',
    );
    assert.equal(sePuedeDarConformidad(null, false), false);
  });

  it('y no se deduce de haber confirmado que llegó', () => {
    // Son dos campos porque son dos afirmaciones distintas.
    assert.equal(yaDioLaConformidad({ conformity_at: 'x' }), true);
    assert.equal(yaDioLaConformidad({ conformity_at: null }), false);
    assert.equal(yaDioLaConformidad({}), false);
    const codigo = sinComentarios(fuente('lib', 'finanzasDeProductos.ts'));
    assert.ok(
      !/buyer_confirmed_at/.test(codigo),
      'la conformidad se deduce de haber confirmado la recepción',
    );
  });
});

// ========================================================================== //
// 8. La cuenta de cobro y el panel
// ========================================================================== //
describe('lo que falta se dice, y no se ofrece un botón que no hay', () => {
  it('la cuenta lista exige las cuatro cosas', () => {
    assert.equal(
      laCuentaEstaLista({
        configured: true,
        payouts_enabled: true,
        onboarding_status: 'active',
        missing: [],
      }),
      true,
    );
    assert.equal(
      laCuentaEstaLista({
        configured: true,
        payouts_enabled: true,
        onboarding_status: 'active',
        missing: ['stripe_connect_enabled'],
      }),
      false,
      'con algo por configurar no está lista',
    );
    assert.equal(laCuentaEstaLista(null), false);
  });

  it('lo que le falta sale del servidor y se traduce', () => {
    assert.deepEqual(
      queLeFaltaALaCuenta({ missing: ['payout_account', 'xx'] }),
      [
        'finanzaDeProducto.falta.payout_account',
        'finanzaDeProducto.falta.desconocido',
      ],
    );
    assert.deepEqual(queLeFaltaALaCuenta(null), []);
  });

  it('el panel no mueve dinero mientras falte algo', () => {
    assert.equal(
      puedeMoverDinero({
        fee_configured: true,
        transfers_enabled: true,
        refunds_enabled: true,
        missing: [],
      }),
      true,
    );
    assert.equal(
      puedeMoverDinero({
        fee_configured: true,
        transfers_enabled: true,
        refunds_enabled: true,
        missing: ['migration_0082'],
      }),
      false,
    );
    assert.equal(puedeMoverDinero({ fee_configured: true }), false);
    assert.equal(puedeMoverDinero(null), false);
  });

  it('los contadores del panel son cuentas de filas, y cero es cero', () => {
    const filas = contadoresDelPanel({ balances_pending: 3 });
    assert.equal(filas.length, 6);
    assert.equal(filas[0].cuantos, 3);
    // AQUÍ UN CERO SÍ SIGNIFICA CERO: es distinto de un importe sin moneda.
    assert.ok(filas.slice(1).every((x) => x.cuantos === 0));
    assert.deepEqual(
      contadoresDelPanel(null).map((x) => x.cuantos),
      [0, 0, 0, 0, 0, 0],
    );
  });

  it('y lo que le falta al panel se traduce', () => {
    assert.deepEqual(queLeFaltaAlPanel({ missing: ['platform_fee_bps'] }), [
      'finanzaDeProducto.falta.platform_fee_bps',
    ]);
  });
});

// ========================================================================== //
// 9. Paginación y errores
// ========================================================================== //
describe('la paginación y los errores', () => {
  const pagina = Array.from({ length: 20 }, (_, i) => ({
    id: `s${i}`,
    created_at: `2026-09-0${i % 9}T00:00:00Z`,
  }));

  it('el cursor son las dos partes, o ninguna', () => {
    const cursor = cursorDeLaPagina(pagina as never);
    assert.ok(cursor);
    assert.equal(cursor?.before_id, 's19');
    assert.equal(cursorDeLaPagina(pagina.slice(0, 3) as never), null);
  });

  it('y si al último le falta una de las dos, no hay cursor a medias', () => {
    // UN CURSOR A MEDIAS ES PEOR QUE NINGUNO: `before=undefined` se convierte
    // en un parámetro roto y el servidor contesta la primera página otra vez,
    // así que la lista se repetiría en bucle en vez de terminar.
    const sinFecha = [...pagina.slice(0, 19), { id: 's19' }];
    assert.equal(cursorDeLaPagina(sinFecha as never), null);
    const sinId = [...pagina.slice(0, 19), { created_at: '2026-09-09T00:00:00Z' }];
    assert.equal(cursorDeLaPagina(sinId as never), null);
    const vacio = [...pagina.slice(0, 19), { id: '', created_at: '' }];
    assert.equal(cursorDeLaPagina(vacio as never), null);
  });

  it('no pide más cuando la página vino corta', () => {
    assert.equal(hayMasPaginas(20), true);
    assert.equal(hayMasPaginas(3), false);
  });

  it('fusionar no repite', () => {
    const juntas = fusionarPaginas([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }]);
    assert.deepEqual(
      juntas.map((x) => x.id),
      ['a', 'b'],
    );
  });

  it('cada código del servidor tiene su texto', () => {
    assert.equal(
      claveDeErrorFinanciero('product_refund_not_allowed'),
      'finanzaDeProducto.error.product_refund_not_allowed',
    );
    assert.equal(claveDeErrorFinanciero('xx'), 'finanzaDeProducto.error.desconocido');
    assert.equal(claveDeErrorFinanciero(null), 'finanzaDeProducto.error.desconocido');
    assert.equal(esFinanzasApagadas('product_finance_not_available'), true);
    assert.equal(esFinanzasApagadas('otra'), false);
  });

  it('el motivo y el tope salen del detalle del 409', () => {
    assert.equal(
      motivoDelRechazo({ reason: 'amount_above_charge' }),
      'finanzaDeProducto.rechazo.amount_above_charge',
    );
    assert.equal(motivoDelRechazo({ reason: 'xx' }), 'finanzaDeProducto.rechazo.desconocido');
    assert.equal(motivoDelRechazo(null), null);
    assert.equal(topeDeLaDevolucion({ max_minor: 500 }), 500);
    assert.equal(topeDeLaDevolucion({}), null, 'el tope no se calcula aquí');
  });
});

// ========================================================================== //
// 10. Los diccionarios, y lo que dicen las pantallas
// ========================================================================== //
describe('lo que dice el servidor se traduce', () => {
  it('cada estado, bloqueo y motivo tiene texto en los tres idiomas', () => {
    for (const diccionario of DICCIONARIOS) {
      for (const estado of [...ESTADOS_DE_SALDO, 'desconocido']) {
        assert.ok(`finanzaDeProducto.estado.${estado}` in diccionario, estado);
      }
      for (const bloqueo of [...BLOQUEOS, 'desconocido']) {
        assert.ok(`finanzaDeProducto.bloqueo.${bloqueo}` in diccionario, bloqueo);
        assert.ok(`finanzaDeProducto.queHacer.${bloqueo}` in diccionario, bloqueo);
      }
      for (const estado of [...ESTADOS_DE_DEVOLUCION, 'desconocido']) {
        assert.ok(`finanzaDeProducto.devolucion.${estado}` in diccionario, estado);
      }
      for (const estado of [...ESTADOS_DE_DISPUTA, 'desconocido']) {
        assert.ok(`finanzaDeProducto.disputa.${estado}` in diccionario, estado);
      }
      for (const motivo of [...MOTIVOS_DE_RETENCION, 'desconocido']) {
        assert.ok(`finanzaDeProducto.retencion.${motivo}` in diccionario, motivo);
      }
    }
  });

  it('los tres diccionarios tienen EXACTAMENTE las mismas claves', () => {
    const claves = DICCIONARIOS.map((d) =>
      Object.keys(d)
        .filter((k) => k.startsWith('finanzaDeProducto.'))
        .sort(),
    );
    assert.ok(claves[0].length > 100, 'el espacio está casi vacío');
    assert.deepEqual(claves[1], claves[0]);
    assert.deepEqual(claves[2], claves[0]);
  });

  it('todo el texto de las pantallas pasa por el diccionario', () => {
    for (const pantalla of PANTALLAS) {
      const codigo = fuente('screens', pantalla);
      const usadas = [...codigo.matchAll(/f\('(finanzaDeProducto\.[^']+)'\)/g)].map(
        (m) => m[1],
      );
      assert.ok(usadas.length > 5, `${pantalla} usa ${usadas.length} claves`);
      for (const diccionario of DICCIONARIOS) {
        const faltan = usadas.filter((clave) => !(clave in diccionario));
        assert.deepEqual(faltan, [], `${pantalla}: ${faltan.join(', ')}`);
      }
    }
  });
});

// ========================================================================== //
// 11. Lo que las pantallas NO prometen
// ========================================================================== //
describe('las pantallas no prometen lo que no hay', () => {
  it('no hay ningún método ni botón que ejecute una transferencia', () => {
    const repo = sinComentarios(fuente('repositories', 'ProductFinanceRepository.ts'));
    for (const prohibido of ['transferir', 'transfer(', 'transfers/run']) {
      assert.ok(!repo.includes(prohibido), prohibido);
    }
    for (const pantalla of PANTALLAS) {
      const codigo = sinComentarios(fuente('screens', pantalla));
      assert.ok(!/transferir/i.test(codigo), pantalla);
    }
  });

  it('no hay ningún método que dé de alta la cuenta de cobro', () => {
    const repo = sinComentarios(fuente('repositories', 'ProductFinanceRepository.ts'));
    for (const prohibido of ['darDeAlta', 'crearCuenta', 'onboarding(']) {
      assert.ok(!repo.includes(prohibido), prohibido);
    }
  });

  it('el panel dice que no mueve dinero, y la del proveedor por qué no hay balance', () => {
    const panel = fuente('screens', 'FinanzasDeProductosScreen.tsx');
    assert.ok(panel.includes('finanzaDeProducto.panel.noMueveDinero'));
    assert.ok(panel.includes('finanzaDeProducto.panel.aprobarNoEsPagar'));
    assert.ok(panel.includes('finanzaDeProducto.panel.quienPaga'));
    const mio = fuente('screens', 'MiSaldoDeProductosScreen.tsx');
    assert.ok(mio.includes('finanzaDeProducto.sinConfigurarCuerpo'));
    // Y QUE NO HAY HISTORIAL DE TRANSFERENCIAS, dicho con palabras: una lista
    // vacía con ese título haría pensar que se perdieron.
    assert.ok(mio.includes('finanzaDeProducto.sinTransferencias'));
  });

  it('la pantalla del pedido distingue la conformidad de confirmar que llegó', () => {
    const codigo = fuente('screens', 'PedidoDeProductoScreen.tsx');
    assert.ok(codigo.includes('finanzaDeProducto.conformidad.noEsLoMismo'));
    assert.ok(codigo.includes('sePuedeDarConformidad'));
    assert.ok(codigo.includes('casoVivo(pedido.incidents)'));
  });
});
