/**
 * Las reglas del dinero de eventos, ejecutadas.
 *
 * Lo que se prueba aquí es lo que se rompe sin que se note mirando la pantalla:
 *
 *  1. Una comisión que nadie ha decidido, escrita como un número. Con
 *     `comision_configurada: false` no puede salir NI UNA cifra de comisión ni
 *     de neto —ni cero, ni `-1`, ni un porcentaje—, y el bruto sí tiene que
 *     salir: cuánto se vendió sí se sabe.
 *  2. `null` leído como cero. Un `?? 0` en el sitio equivocado convierte «nadie
 *     lo ha decidido» en «no te corresponde nada», y las dos frases se escriben
 *     igual: «0,00».
 *  3. `currency: null` pintado como «0,00». Sin moneda no hay ninguna venta:
 *     es un estado vacío, no un cero.
 *  4. Un código que el servidor añada mañana tumbando la pantalla. Ningún
 *     `claveDe…` puede reventar ni devolver el código crudo.
 *  5. Un botón que prometa pagar. `transfers/run` devuelve cero y una lista de
 *     bloqueos, y soltar una reserva no mueve dinero.
 *
 * Las dos últimas se comprueban además sobre el CÓDIGO de las pantallas,
 * porque no son funciones: son lo que está escrito.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BLOQUEOS_DE_TRANSFERENCIA,
  CODIGOS_DE_HALLAZGO,
  CONTADORES_DE_SALUD,
  CONTADORES_QUE_ESPERAN,
  DISPUTAS_VIVAS,
  EJEMPLOS_POR_CODIGO,
  ESTADOS_DE_DISPUTA,
  ESTADOS_DE_SALDO,
  LARGO_MAXIMO_DEL_MOTIVO,
  LARGO_MINIMO_DEL_MOTIVO,
  LIMITES,
  LIMITE_DE_CONCILIACION,
  LIMITE_INICIAL,
  MOTIVOS_DE_BLOQUEO,
  agruparHallazgos,
  bloqueaLaComision,
  cifraDeImporte,
  cifraDeLaComision,
  cifraDeLaComisionDelSaldo,
  cifraDelBruto,
  cifraDelNeto,
  cifraDelNetoDelSaldo,
  cifraQueDependeDeLaComision,
  claveDeBloqueo,
  claveDeBloqueoDeTransferencia,
  claveDeContador,
  claveDeErrorFinanciero,
  claveDeHallazgo,
  claveDeQueHacerConElBloqueo,
  claveDelAvisoDeSoltar,
  claveDelEstadoDeDisputa,
  claveDelEstadoDeSaldo,
  disputaViva,
  esFinanzasNoDisponible,
  esperaAlgo,
  filasDeSalud,
  importeConMoneda,
  leerMotivoDeSoltar,
  llegoAlTope,
  motivoQueManda,
  motivosVisibles,
  nadaSeMovio,
  plazoDePruebasVencido,
  saludNoDisponible,
  siguienteLimite,
  sinVentas,
  tieneReserva,
  tonoDelEstadoDeSaldo,
  type ResumenFinanciero,
  type SaldoDeVenta,
} from './finanzasDeEventos.ts';

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

function resumen(cambios: Partial<ResumenFinanciero> = {}): ResumenFinanciero {
  return {
    comision_configurada: true,
    ventas: 2,
    bruto_minor: 10000,
    comision_minor: 1000,
    neto_minor: 9000,
    retenido_minor: 9000,
    reservado_minor: 0,
    disponible_minor: 0,
    transferido_minor: 0,
    currency: 'PEN',
    motivos: [],
    ...cambios,
  };
}

function saldo(cambios: Partial<SaldoDeVenta> = {}): SaldoDeVenta {
  return {
    id: 'b1',
    event_id: 'e1',
    order_id: 'o1',
    gross_amount_minor: 5000,
    platform_fee_minor: 500,
    net_amount_minor: 4500,
    currency: 'PEN',
    status: 'pending',
    reserved_minor: 0,
    available_at: null,
    bloqueo: null,
    created_at: '2026-09-01T10:00:00Z',
    ...cambios,
  };
}

/** Cualquier cosa que se lea como una cantidad de dinero. */
function pareceUnNumero(texto: string): boolean {
  return /\d/.test(texto);
}

describe('la comisión sin configurar no se escribe como un número', () => {
  it('con `comision_configurada: false` la comisión está pendiente, no vale cero', () => {
    const sinComision = resumen({
      comision_configurada: false,
      comision_minor: null,
      neto_minor: null,
    });
    assert.deepEqual(cifraDeLaComision(sinComision), {
      estado: 'pendienteDeConfiguracion',
    });
  });

  it('el neto también está pendiente, y no es cero', () => {
    const sinComision = resumen({
      comision_configurada: false,
      comision_minor: null,
      neto_minor: null,
    });
    assert.deepEqual(cifraDelNeto(sinComision), { estado: 'pendienteDeConfiguracion' });
  });

  it('el BRUTO sí se enseña: cuánto se vendió sí se sabe', () => {
    const sinComision = resumen({
      comision_configurada: false,
      comision_minor: null,
      neto_minor: null,
    });
    assert.deepEqual(cifraDelBruto(sinComision), {
      estado: 'cifra',
      texto: 'S/ 100.00 PEN',
    });
  });

  it('la bandera manda AUNQUE llegue un número: esa cifra la calculó nadie', () => {
    // El fallo que esto cierra: un servidor que mande la comisión calculada con
    // el `-1` de `platform_fee_bps` y una pantalla que se la crea.
    const raro = resumen({
      comision_configurada: false,
      comision_minor: 1234,
      neto_minor: 8766,
    });
    assert.deepEqual(cifraDeLaComision(raro), { estado: 'pendienteDeConfiguracion' });
    assert.deepEqual(cifraDelNeto(raro), { estado: 'pendienteDeConfiguracion' });
  });

  it('NUNCA sale una cifra de comisión ni de neto con la bandera en falso', () => {
    for (const comision of [null, 0, -1, 1234]) {
      for (const neto of [null, 0, -1, 9999]) {
        const caso = resumen({
          comision_configurada: false,
          comision_minor: comision,
          neto_minor: neto,
        });
        const comisionVista = cifraDeLaComision(caso);
        const netoVisto = cifraDelNeto(caso);
        assert.equal(comisionVista.estado, 'pendienteDeConfiguracion');
        assert.equal(netoVisto.estado, 'pendienteDeConfiguracion');
        assert.ok(!('texto' in comisionVista), `salió una cifra con ${comision}`);
        assert.ok(!('texto' in netoVisto), `salió una cifra con ${neto}`);
      }
    }
  });

  it('con la comisión configurada sí sale la cifra', () => {
    assert.deepEqual(cifraDeLaComision(resumen()), {
      estado: 'cifra',
      texto: 'S/ 10.00 PEN',
    });
    assert.deepEqual(cifraDelNeto(resumen()), {
      estado: 'cifra',
      texto: 'S/ 90.00 PEN',
    });
  });

  it('un cero de comisión CON la bandera puesta sí es un cero decidido', () => {
    const gratis = resumen({ comision_minor: 0, neto_minor: 10000 });
    assert.deepEqual(cifraDeLaComision(gratis), {
      estado: 'cifra',
      texto: 'S/ 0.00 PEN',
    });
  });
});

describe('`null` no se convierte en cero en ningún hueco', () => {
  it('una comisión `null` con la bandera puesta sigue estando pendiente', () => {
    assert.deepEqual(cifraQueDependeDeLaComision(null, 'PEN', true), {
      estado: 'pendienteDeConfiguracion',
    });
  });

  it('`undefined` tampoco es cero', () => {
    assert.deepEqual(cifraQueDependeDeLaComision(undefined, 'PEN', true), {
      estado: 'pendienteDeConfiguracion',
    });
  });

  it('un importe `null` no se escribe', () => {
    assert.equal(importeConMoneda(null, 'PEN'), null);
    assert.equal(importeConMoneda(undefined, 'PEN'), null);
  });

  it('un NaN o un infinito no son un importe', () => {
    assert.equal(importeConMoneda(Number.NaN, 'PEN'), null);
    assert.equal(importeConMoneda(Number.POSITIVE_INFINITY, 'PEN'), null);
  });

  it('el saldo sin comisión calculada está pendiente, no a cero', () => {
    const fila = saldo({ platform_fee_minor: null, net_amount_minor: null });
    assert.deepEqual(cifraDeLaComisionDelSaldo(fila), {
      estado: 'pendienteDeConfiguracion',
    });
    assert.deepEqual(cifraDelNetoDelSaldo(fila), {
      estado: 'pendienteDeConfiguracion',
    });
  });

  it('el saldo con comisión calculada sí la enseña', () => {
    assert.deepEqual(cifraDeLaComisionDelSaldo(saldo()), {
      estado: 'cifra',
      texto: 'S/ 5.00 PEN',
    });
    assert.deepEqual(cifraDelNetoDelSaldo(saldo()), {
      estado: 'cifra',
      texto: 'S/ 45.00 PEN',
    });
  });
});

describe('sin moneda no hay ninguna venta, y no hay ningún «0,00»', () => {
  it('`currency: null` es estado vacío', () => {
    assert.equal(sinVentas(resumen({ currency: null, ventas: 0 })), true);
  });

  it('cero ventas es estado vacío aunque llegue una moneda', () => {
    assert.equal(sinVentas(resumen({ ventas: 0 })), true);
  });

  it('con ventas y moneda no está vacío', () => {
    assert.equal(sinVentas(resumen()), false);
  });

  it('un importe sin moneda no se escribe: `$` es dólar y peso a la vez', () => {
    assert.equal(importeConMoneda(10000, null), null);
    assert.equal(importeConMoneda(10000, '   '), null);
  });

  it('sin moneda la cifra es `sinVentas`, que no es un número', () => {
    const cifra = cifraDeImporte(0, null);
    assert.deepEqual(cifra, { estado: 'sinVentas' });
    assert.ok(!('texto' in cifra));
  });

  it('el bruto sin moneda tampoco se escribe', () => {
    assert.deepEqual(cifraDelBruto(resumen({ currency: null, bruto_minor: 0 })), {
      estado: 'sinVentas',
    });
  });

  it('ninguna cifra sin moneda produce un texto con dígitos', () => {
    for (const moneda of [null, undefined, '', ' ']) {
      const cifra = cifraDeImporte(12345, moneda);
      assert.equal(cifra.estado, 'sinVentas');
      assert.ok(
        !('texto' in cifra) || !pareceUnNumero((cifra as { texto: string }).texto),
      );
    }
  });
});

describe('los importes se escriben con su moneda', () => {
  it('siempre con dos decimales y con el código', () => {
    assert.equal(importeConMoneda(4990, 'PEN'), 'S/ 49.90 PEN');
    assert.equal(importeConMoneda(100, 'USD'), '$ 1.00 USD');
    assert.equal(importeConMoneda(0, 'MXN'), '$ 0.00 MXN');
  });

  it('el código va aunque no haya símbolo conocido', () => {
    assert.equal(importeConMoneda(150000, 'COP'), '1500.00 COP');
  });

  it('la moneda en minúsculas se normaliza', () => {
    assert.equal(importeConMoneda(4990, 'pen'), 'S/ 49.90 PEN');
  });

  it('`USD` y `MXN` comparten símbolo, y por eso el código no es opcional', () => {
    assert.notEqual(importeConMoneda(1000, 'USD'), importeConMoneda(1000, 'MXN'));
  });

  it('un importe negativo no se escribe en negativo', () => {
    assert.equal(importeConMoneda(-500, 'PEN'), 'S/ 0.00 PEN');
  });
});

describe('el motivo del bloqueo es una frase, y es uno', () => {
  it('los diez códigos del backend tienen clave propia', () => {
    for (const codigo of MOTIVOS_DE_BLOQUEO) {
      assert.equal(claveDeBloqueo(codigo), `finanzasEvento.bloqueo.${codigo}`);
    }
  });

  it('son exactamente los de `finanzas.py`', () => {
    assert.deepEqual(
      [...MOTIVOS_DE_BLOQUEO].sort(),
      [
        'aftersale_case_open',
        'balance_not_pending',
        'dispute_open',
        'fee_not_configured',
        'hold_open',
        'hold_policy_not_configured',
        'organizer_missing',
        'payout_account_missing',
        'payout_account_not_ready',
        'reserve_held',
      ],
    );
  });

  it('un código que nadie ha visto no revienta ni sale crudo', () => {
    const clave = claveDeBloqueo('algo_que_el_servidor_invente_manana');
    assert.equal(clave, 'finanzasEvento.bloqueo.desconocido');
    assert.ok(!clave.includes('invente_manana'));
  });

  it('cada bloqueo tiene además qué hacer con él', () => {
    assert.equal(
      claveDeQueHacerConElBloqueo('reserve_held'),
      'finanzasEvento.bloqueoQueHacer.reserve_held',
    );
    assert.equal(
      claveDeQueHacerConElBloqueo('nada_de_esto'),
      'finanzasEvento.bloqueoQueHacer.desconocido',
    );
  });

  it('se enseña UNO: el primero que manda el servidor, sin reordenar', () => {
    assert.equal(
      motivoQueManda(['reserve_held', 'fee_not_configured']),
      'reserve_held',
    );
    assert.equal(
      motivoQueManda(['fee_not_configured', 'reserve_held']),
      'fee_not_configured',
    );
  });

  it('sin motivos no se dice ninguno', () => {
    assert.equal(motivoQueManda([]), null);
    assert.equal(motivoQueManda(null), null);
    assert.equal(motivoQueManda(undefined), null);
  });

  it('un motivo en blanco no es un motivo', () => {
    assert.equal(motivoQueManda(['   ', 'hold_open']), 'hold_open');
  });

  it('los motivos no se repiten ni se reordenan', () => {
    assert.deepEqual(
      motivosVisibles(['hold_open', 'hold_open', 'reserve_held', '']),
      ['hold_open', 'reserve_held'],
    );
    assert.deepEqual(motivosVisibles(null), []);
  });

  it('la comisión sin configurar se reconoce por su código', () => {
    assert.equal(bloqueaLaComision('fee_not_configured'), true);
    assert.equal(bloqueaLaComision('reserve_held'), false);
    assert.equal(bloqueaLaComision(null), false);
  });
});

describe('el estado de un saldo', () => {
  it('los siete estados de la base tienen clave', () => {
    for (const estado of ESTADOS_DE_SALDO) {
      assert.equal(claveDelEstadoDeSaldo(estado), `finanzasEvento.estadoSaldo.${estado}`);
    }
  });

  it('un estado desconocido cae en «desconocido» sin romper nada', () => {
    assert.equal(claveDelEstadoDeSaldo('inventado'), 'finanzasEvento.estadoSaldo.desconocido');
  });

  it('solo lo transferido se pinta como terminado', () => {
    assert.equal(tonoDelEstadoDeSaldo('transferred'), 'bueno');
    assert.equal(tonoDelEstadoDeSaldo('eligible'), 'neutro');
    assert.equal(tonoDelEstadoDeSaldo('pending'), 'espera');
    assert.equal(tonoDelEstadoDeSaldo('frozen'), 'espera');
    assert.equal(tonoDelEstadoDeSaldo('transferring'), 'espera');
    assert.equal(tonoDelEstadoDeSaldo('failed'), 'malo');
    assert.equal(tonoDelEstadoDeSaldo('cancelled'), 'malo');
  });

  it('«elegible» NO es «cobrado»: son dos tonos distintos', () => {
    assert.notEqual(tonoDelEstadoDeSaldo('eligible'), tonoDelEstadoDeSaldo('transferred'));
  });

  it('reservado en cero no es una reserva pequeña: es ninguna', () => {
    assert.equal(tieneReserva(saldo({ reserved_minor: 0 })), false);
    assert.equal(tieneReserva(saldo({ reserved_minor: 1 })), true);
  });
});

describe('conciliar agrupa y cuenta, no corrige', () => {
  const hallazgos = [
    { codigo: 'amount_mismatch', entidad: 'balance', id: 'b1', detalle: null },
    { codigo: 'amount_mismatch', entidad: 'balance', id: 'b2', detalle: null },
    { codigo: 'amount_mismatch', entidad: 'balance', id: 'b3', detalle: null },
    { codigo: 'amount_mismatch', entidad: 'balance', id: 'b4', detalle: null },
    { codigo: 'duplicate_balance', entidad: 'order', id: 'o1', detalle: null },
  ];

  it('los diez códigos del backend tienen clave', () => {
    for (const codigo of CODIGOS_DE_HALLAZGO) {
      assert.equal(claveDeHallazgo(codigo), `finanzasEvento.hallazgo.${codigo}`);
    }
  });

  it('un código de hallazgo desconocido no revienta la pantalla', () => {
    assert.equal(claveDeHallazgo('lo_que_sea'), 'finanzasEvento.hallazgo.desconocido');
  });

  it('se agrupan por código, del más repetido al que menos', () => {
    const grupos = agruparHallazgos(hallazgos);
    assert.deepEqual(
      grupos.map((g) => [g.codigo, g.cuantos]),
      [
        ['amount_mismatch', 4],
        ['duplicate_balance', 1],
      ],
    );
  });

  it('se guardan unos pocos ejemplos, no la lista entera', () => {
    const grupos = agruparHallazgos(hallazgos);
    assert.equal(grupos[0].ejemplos.length, EJEMPLOS_POR_CODIGO);
    assert.deepEqual(grupos[0].ejemplos, ['b1', 'b2', 'b3']);
  });

  it('un código que el servidor añada mañana se cuenta igual', () => {
    // El fallo que esto cierra: un panel que se come lo que no conoce y dice
    // que todo cuadra.
    const grupos = agruparHallazgos([
      ...hallazgos,
      { codigo: 'algo_nuevo', entidad: 'x', id: 'x1', detalle: null },
    ]);
    assert.ok(grupos.some((g) => g.codigo === 'algo_nuevo'));
  });

  it('sin hallazgos no hay grupos', () => {
    assert.deepEqual(agruparHallazgos([]), []);
    assert.deepEqual(agruparHallazgos(null), []);
    assert.deepEqual(agruparHallazgos(undefined), []);
  });

  it('un hallazgo sin código no se cuenta como uno más', () => {
    assert.deepEqual(
      agruparHallazgos([{ codigo: '  ', entidad: 'x', id: 'x1', detalle: null }]),
      [],
    );
  });

  it('a igual número, el orden es estable por código', () => {
    const grupos = agruparHallazgos([
      { codigo: 'z_codigo', entidad: 'x', id: '1', detalle: null },
      { codigo: 'a_codigo', entidad: 'x', id: '2', detalle: null },
    ]);
    assert.deepEqual(grupos.map((g) => g.codigo), ['a_codigo', 'z_codigo']);
  });

  it('el tope de conciliación está dentro de lo que acepta el servidor', () => {
    assert.ok(LIMITE_DE_CONCILIACION >= 1 && LIMITE_DE_CONCILIACION <= 1000);
  });
});

describe('los contadores de salud', () => {
  it('`{"disponible": 0}` no es «cero pedidos»: es que no hay dónde contarlos', () => {
    assert.equal(saludNoDisponible({ disponible: 0 }), true);
    assert.equal(saludNoDisponible(null), true);
    assert.equal(saludNoDisponible(undefined), true);
    assert.equal(saludNoDisponible({ disponible: 1 }), false);
  });

  it('`disponible` no se pinta como un contador', () => {
    const filas = filasDeSalud({ disponible: 1, pedidos_pagados: 3 });
    assert.deepEqual(filas.map((f) => f.clave), ['pedidos_pagados']);
  });

  it('los contadores salen en el orden conocido, no en el del JSON', () => {
    const filas = filasDeSalud({
      disponible: 1,
      disputas_abiertas: 2,
      pedidos_pagados: 9,
      entradas_vivas: 7,
    });
    assert.deepEqual(
      filas.map((f) => f.clave),
      ['pedidos_pagados', 'entradas_vivas', 'disputas_abiertas'],
    );
  });

  it('un contador nuevo del servidor se enseña, no desaparece', () => {
    const filas = filasDeSalud({ disponible: 1, contador_nuevo: 4 });
    assert.deepEqual(filas, [{ clave: 'contador_nuevo', valor: 4, conocido: false }]);
  });

  it('lo que no es un número no se pinta como uno', () => {
    assert.deepEqual(filasDeSalud({ disponible: 1, pedidos_pagados: 'muchos' }), []);
    assert.deepEqual(filasDeSalud({ disponible: 1, roto: Number.NaN }), []);
  });

  it('un contador en cero SÍ se enseña: cero es un dato', () => {
    assert.deepEqual(filasDeSalud({ disponible: 1, reservas_vivas: 0 }), [
      { clave: 'reservas_vivas', valor: 0, conocido: true },
    ]);
  });

  it('cada contador conocido tiene clave propia, y los otros una de respaldo', () => {
    for (const clave of CONTADORES_DE_SALUD) {
      assert.equal(claveDeContador(clave), `finanzasEvento.contador.${clave}`);
    }
    assert.equal(claveDeContador('otro'), 'finanzasEvento.contador.desconocido');
  });

  it('los que esperan algo son contadores que existen de verdad', () => {
    for (const clave of CONTADORES_QUE_ESPERAN) {
      assert.ok(
        (CONTADORES_DE_SALUD as readonly string[]).includes(clave),
        `${clave} no lo manda el servidor`,
      );
      assert.equal(esperaAlgo(clave), true);
    }
    assert.equal(esperaAlgo('pedidos_pagados'), false);
  });
});

describe('las disputas', () => {
  it('los seis estados de la base tienen clave', () => {
    for (const estado of ESTADOS_DE_DISPUTA) {
      assert.equal(claveDelEstadoDeDisputa(estado), `finanzasEvento.disputa.${estado}`);
    }
  });

  it('un estado desconocido no rompe nada', () => {
    assert.equal(claveDelEstadoDeDisputa('raro'), 'finanzasEvento.disputa.desconocido');
  });

  it('las vivas son las tres que cuenta el backend', () => {
    assert.deepEqual([...DISPUTAS_VIVAS], ['open', 'needs_response', 'under_review']);
    for (const estado of DISPUTAS_VIVAS) {
      assert.equal(disputaViva(estado), true);
      assert.ok((ESTADOS_DE_DISPUTA as readonly string[]).includes(estado));
    }
    for (const estado of ['won', 'lost', 'closed']) {
      assert.equal(disputaViva(estado), false);
    }
  });

  it('sin fecha de pruebas no se dice nada del plazo', () => {
    // NO SE INVENTA NINGÚN PLAZO: `null` es «no se sabe», no «se pasó».
    assert.equal(plazoDePruebasVencido(null), null);
    assert.equal(plazoDePruebasVencido(undefined), null);
    assert.equal(plazoDePruebasVencido('no es una fecha'), null);
  });

  it('con fecha se compara contra el momento dado, sin suponer ninguno', () => {
    const ahora = new Date('2026-09-11T00:00:00Z');
    assert.equal(plazoDePruebasVencido('2026-09-10T00:00:00Z', ahora), true);
    assert.equal(plazoDePruebasVencido('2026-09-12T00:00:00Z', ahora), false);
  });
});

describe('soltar una reserva: motivo obligatorio y nada de dinero', () => {
  it('los topes son los del servidor', () => {
    assert.equal(LARGO_MINIMO_DEL_MOTIVO, 3);
    assert.equal(LARGO_MAXIMO_DEL_MOTIVO, 500);
  });

  it('vacío o solo espacios no es un motivo', () => {
    assert.deepEqual(leerMotivoDeSoltar(''), { ok: false, falta: 'vacio' });
    assert.deepEqual(leerMotivoDeSoltar('   \n '), { ok: false, falta: 'vacio' });
    assert.deepEqual(leerMotivoDeSoltar(null), { ok: false, falta: 'vacio' });
  });

  it('menos de tres caracteres lo rechaza el servidor: se dice antes', () => {
    assert.deepEqual(leerMotivoDeSoltar('ok'), { ok: false, falta: 'corto' });
  });

  it('tres caracteres justos valen', () => {
    assert.deepEqual(leerMotivoDeSoltar('abc'), { ok: true, motivo: 'abc' });
  });

  it('se recorta a 500 en vez de provocar un 422 sobre lo ya escrito', () => {
    const leido = leerMotivoDeSoltar('a'.repeat(900));
    assert.ok(leido.ok);
    assert.equal(leido.ok && leido.motivo.length, 500);
  });

  it('los espacios de los extremos no cuentan como texto', () => {
    assert.deepEqual(leerMotivoDeSoltar('  hola  '), { ok: true, motivo: 'hola' });
  });

  it('las dos formas de soltar tienen su propio aviso, y son distintos', () => {
    assert.equal(claveDelAvisoDeSoltar(false), 'finanzasEvento.soltarLiberadaAviso');
    assert.equal(claveDelAvisoDeSoltar(true), 'finanzasEvento.soltarConsumidaAviso');
    assert.notEqual(claveDelAvisoDeSoltar(true), claveDelAvisoDeSoltar(false));
  });
});

describe('las transferencias no mueven nada hoy, y se dice', () => {
  it('cero ejecutadas es «no se movió nada»', () => {
    assert.equal(nadaSeMovio({ ejecutadas: 0, bloqueos: ['transfers_disabled'] }), true);
  });

  it('sin respuesta tampoco se ha movido nada', () => {
    assert.equal(nadaSeMovio(null), true);
    assert.equal(nadaSeMovio(undefined), true);
  });

  it('un número que no es un número no cuenta como pago hecho', () => {
    assert.equal(
      nadaSeMovio({ ejecutadas: Number.NaN, bloqueos: [] }),
      true,
    );
  });

  it('solo un número positivo dice que algo se ejecutó', () => {
    assert.equal(nadaSeMovio({ ejecutadas: 3, bloqueos: [] }), false);
  });

  it('los tres bloqueos que el servidor devuelve hoy tienen frase', () => {
    for (const codigo of BLOQUEOS_DE_TRANSFERENCIA) {
      assert.equal(
        claveDeBloqueoDeTransferencia(codigo),
        `finanzasEvento.bloqueoTransferencia.${codigo}`,
      );
    }
  });

  it('un bloqueo nuevo no se enseña crudo', () => {
    const clave = claveDeBloqueoDeTransferencia('algo_apagado');
    assert.equal(clave, 'finanzasEvento.bloqueoTransferencia.desconocido');
    assert.ok(!clave.includes('algo_apagado'));
  });
});

describe('el 503 de finanzas no es un error', () => {
  it('se reconoce por su código', () => {
    assert.equal(esFinanzasNoDisponible('event_finance_not_available'), true);
    assert.equal(esFinanzasNoDisponible('events_workflow_not_available'), false);
    assert.equal(esFinanzasNoDisponible(null), false);
    assert.equal(esFinanzasNoDisponible(undefined), false);
  });

  it('tiene su propio texto, que no es «algo falló»', () => {
    assert.equal(
      claveDeErrorFinanciero('event_finance_not_available'),
      'finanzasEvento.noDisponibleCuerpo',
    );
  });

  it('un código desconocido devuelve `null` para usar el del servidor', () => {
    assert.equal(claveDeErrorFinanciero('lo_que_sea'), null);
    assert.equal(claveDeErrorFinanciero(undefined), null);
  });
});

describe('las listas no paginan, y no fingen que lo hacen', () => {
  it('el tope sube hasta el máximo del servidor y ahí se para', () => {
    assert.equal(LIMITE_INICIAL, 50);
    assert.equal(siguienteLimite(50), 100);
    assert.equal(siguienteLimite(100), 200);
    assert.equal(siguienteLimite(200), null);
  });

  it('ningún tope pasa del máximo que acepta el servidor', () => {
    for (const limite of LIMITES) {
      assert.ok(limite >= 1 && limite <= 200, String(limite));
    }
  });

  it('tantos resultados como el tope significa que puede haber más', () => {
    assert.equal(llegoAlTope(50, 50), true);
    assert.equal(llegoAlTope(49, 50), false);
  });
});

describe('ningún traductor de códigos revienta con basura', () => {
  const traductores = [
    claveDeBloqueo,
    claveDeQueHacerConElBloqueo,
    claveDelEstadoDeSaldo,
    claveDeHallazgo,
    claveDeContador,
    claveDelEstadoDeDisputa,
    claveDeBloqueoDeTransferencia,
  ];

  it('todos contestan una clave de respaldo, y ninguno el código crudo', () => {
    for (const traducir of traductores) {
      for (const basura of ['', '  ', 'ñ', '../../etc', 'CODIGO_RARO', '42']) {
        const clave = traducir(basura);
        assert.ok(clave.endsWith('.desconocido'), `${traducir.name}: ${clave}`);
        assert.ok(clave.startsWith('finanzasEvento.'), clave);
      }
    }
  });
});

describe('lo que las pantallas tienen escrito', () => {
  const ventas = fuente('screens', 'VentasYSaldoScreen.tsx');
  const panel = fuente('screens', 'PanelFinancieroScreen.tsx');
  const repoOrganizador = fuente('repositories', 'EventFinanceRepository.ts');
  const repoAdmin = fuente('repositories', 'EventFinanceAdminRepository.ts');

  it('la pantalla del organizador lee la comisión por el estado, no con un `?? 0`', () => {
    const limpio = sinComentarios(ventas);
    assert.ok(limpio.includes('cifraDeLaComision('), 'falta la comisión con su estado');
    assert.ok(limpio.includes('cifraDelNeto('), 'falta el neto con su estado');
    assert.ok(
      limpio.includes("'finanzasEvento.pendienteDeConfiguracion'"),
      'sin este texto la comisión sin decidir acabaría escrita como un número',
    );
  });

  it('el bruto SÍ se enseña, que es lo que sí se sabe', () => {
    assert.ok(sinComentarios(ventas).includes('cifraDelBruto('));
  });

  it('el organizador no ve ninguna fecha de cobro inventada', () => {
    const limpio = sinComentarios(ventas);
    assert.ok(
      limpio.includes("'finanzasEvento.sinFechaDePago'"),
      'falta decir que no hay fecha',
    );
    assert.ok(!/en \{?\d+\}? d[íi]as/i.test(limpio), 'hay un plazo escrito a mano');
  });

  it('el organizador no puede mover dinero desde su pantalla', () => {
    const limpio = sinComentarios(ventas);
    assert.ok(!limpio.includes('EventFinanceAdminRepository'), 'usa administración');
    assert.ok(!limpio.includes('/admin/'), 'llama a una ruta de administración');
    for (const prohibido of ['soltarReserva(', 'conciliar(', 'ejecutarTransferencias(']) {
      assert.ok(!limpio.includes(prohibido), `${prohibido} no es suyo`);
    }
  });

  it('el motivo se enseña en frase y de uno en uno', () => {
    const limpio = sinComentarios(ventas);
    assert.ok(limpio.includes('motivoQueManda('), 'falta el motivo que manda');
    assert.ok(limpio.includes('claveDeBloqueo('), 'el código no se traduce');
    for (const codigo of MOTIVOS_DE_BLOQUEO) {
      assert.ok(!limpio.includes(`'${codigo}'`), `${codigo} escrito a mano`);
    }
  });

  it('las dos pantallas tienen los cinco estados: carga, vacío, error, 403 y 503', () => {
    for (const [nombre, codigo] of [
      ['VentasYSaldoScreen', ventas],
      ['PanelFinancieroScreen', panel],
    ] as const) {
      const limpio = sinComentarios(codigo);
      assert.ok(limpio.includes("state=\"loading\""), `${nombre} no dice que carga`);
      assert.ok(limpio.includes("state=\"empty\""), `${nombre} no tiene estado vacío`);
      assert.ok(limpio.includes('onRetry'), `${nombre} no ofrece reintentar`);
      assert.ok(limpio.includes('esFalloDeRed'), `${nombre} no distingue el sin red`);
      assert.ok(
        limpio.includes('error.status === 403'),
        `${nombre} no cuenta el acceso denegado`,
      );
      assert.ok(
        limpio.includes('esFinanzasNoDisponible'),
        `${nombre} no distingue el 503 del esquema sin desplegar`,
      );
      assert.ok(
        limpio.includes("'finanzasEvento.noDisponibleCuerpo'"),
        `${nombre} no explica el «todavía no»`,
      );
    }
  });

  it('el 503 se cuenta como «todavía no», no como un error rojo', () => {
    for (const codigo of [ventas, panel]) {
      const limpio = sinComentarios(codigo);
      const noDisponible = limpio.indexOf("fallo === 'noDisponible'");
      assert.ok(noDisponible > 0, 'el 503 no tiene su propia rama');
      assert.ok(
        limpio.includes("icon={fallo === 'noDisponible'") ||
          limpio.includes("fallo === 'noDisponible'\n                ? 'clock'"),
        'el 503 no se pinta distinto del error',
      );
    }
  });

  it('Atrás siempre tiene un respaldo a una ruta que existe', () => {
    for (const [nombre, codigo] of [
      ['VentasYSaldoScreen', ventas],
      ['PanelFinancieroScreen', panel],
    ] as const) {
      const limpio = sinComentarios(codigo);
      assert.ok(limpio.includes('router.canGoBack()'), nombre);
      assert.ok(limpio.includes('router.replace('), nombre);
    }
  });

  it('ninguna pantalla trae datos de ejemplo ni habla con Supabase', () => {
    for (const [nombre, codigo] of [
      ['VentasYSaldoScreen', ventas],
      ['PanelFinancieroScreen', panel],
    ] as const) {
      const limpio = sinComentarios(codigo);
      assert.ok(!/mockData|datosDeEjemplo|fixture/i.test(limpio), nombre);
      assert.ok(!/supabase/i.test(limpio), nombre);
    }
  });

  it('no hay ni un texto en duro: todo sale de `t`', () => {
    for (const [nombre, codigo] of [
      ['VentasYSaldoScreen', ventas],
      ['PanelFinancieroScreen', panel],
    ] as const) {
      const limpio = sinComentarios(codigo);
      for (const atributo of ['label=', 'title=', 'description=', 'placeholder=']) {
        const suelto = new RegExp(`${atributo}"[^"{]`);
        assert.ok(!suelto.test(limpio), `${nombre}: ${atributo} con texto escrito`);
      }
    }
  });

  it('el panel no pinta ningún botón que prometa pagar', () => {
    const limpio = sinComentarios(panel);
    assert.ok(limpio.includes('nadaSeMovio('), 'falta contar que no se movió nada');
    assert.ok(
      limpio.includes("'finanzasEvento.transferenciasCero'"),
      'el cero de transferencias no se dice',
    );
    assert.ok(
      limpio.includes('claveDeBloqueoDeTransferencia('),
      'los bloqueos no se traducen',
    );
  });

  it('soltar una reserva exige motivo y avisa de que no mueve dinero', () => {
    const limpio = sinComentarios(panel);
    assert.ok(limpio.includes('leerMotivoDeSoltar('), 'no se valida el motivo');
    assert.ok(limpio.includes('claveDelAvisoDeSoltar('), 'falta el aviso');
    assert.ok(limpio.includes('confirm('), 'se suelta sin confirmar');
    assert.ok(limpio.includes('ocupadoRef.current'), 'dos toques mandarían dos órdenes');
  });

  it('conciliar no ofrece corregir nada', () => {
    const limpio = sinComentarios(panel);
    assert.ok(limpio.includes('agruparHallazgos('), 'los hallazgos no se agrupan');
    assert.ok(!/corregir|arreglar|reparar/i.test(limpio), 'hay un botón de corregir');
  });

  it('el repositorio del organizador no sabe nada de administración', () => {
    const limpio = sinComentarios(repoOrganizador);
    assert.ok(!limpio.includes('/admin/'), 'el repositorio del organizador se ha manchado');
    for (const prohibido of ['release', 'reconcile', 'transfers']) {
      assert.ok(!limpio.includes(prohibido), `${prohibido} no es del organizador`);
    }
  });

  it('el repositorio de administración no declara ningún «marcar pagado»', () => {
    const limpio = sinComentarios(repoAdmin);
    assert.ok(!/marcarPagado|declararPagado|confirmarPago/i.test(limpio));
  });

  it('las rutas apuntan a las pantallas, sin lógica por medio', () => {
    const organizador = readFileSync(
      join(AQUI, '..', '..', 'app', 'finanzas', '[eventId].tsx'),
      'utf8',
    );
    const administracion = readFileSync(
      join(AQUI, '..', '..', 'app', 'admin', 'finanzas', 'index.tsx'),
      'utf8',
    );
    assert.ok(organizador.includes('VentasYSaldoScreen'));
    assert.ok(administracion.includes('PanelFinancieroScreen'));
  });
});
