/**
 * El dinero no admite «casi».
 *
 * La prueba que de verdad importa es `49.90 -> 4990`. Con el contrato anterior
 * daba 4900, cuarenta y nueve soles exactos, y nadie lo veia porque el precio
 * que se ensenaba se recalculaba desde el mismo numero equivocado.
 *
 * La segunda es `Number('49.90') * 100`, que en coma flotante da
 * 4989.999999999999. Truncar eso es perder un centimo por curso, siempre en la
 * direccion de cobrar de menos.
 *
 * Se ejecutan con `npm run test` (el runner de Node, sin dependencias).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  aCentavos,
  aTextoEditable,
  deCentavos,
  etiquetaDePrecio,
  importeConMoneda,
} from './dinero.ts';

function centavosDe(texto: string): number {
  const leido = aCentavos(texto);
  assert.ok(leido.ok, `"${texto}" deberia valer: ${leido.ok ? '' : leido.motivo}`);
  return leido.centavos;
}

describe('leer un precio escrito por una persona', () => {
  it('convierte los casos que pide el producto', () => {
    assert.equal(centavosDe('0'), 0);
    assert.equal(centavosDe('49'), 4900);
    assert.equal(centavosDe('49.9'), 4990);
    assert.equal(centavosDe('49.90'), 4990);
    assert.equal(centavosDe('0.50'), 50);
    assert.equal(centavosDe('1000.00'), 100000);
    assert.equal(centavosDe('999.99'), 99999);
  });

  it('no pierde el centimo de la coma flotante', () => {
    // Number('49.90') * 100 === 4989.999999999999
    assert.equal(centavosDe('49.90'), 4990);
    assert.equal(centavosDe('1.10'), 110);
    assert.equal(centavosDe('8.20'), 820);
  });

  it('acepta la coma, que es lo que produce el teclado en castellano', () => {
    assert.equal(centavosDe('49,90'), 4990);
  });

  it('tolera espacios alrededor', () => {
    assert.equal(centavosDe('  12.30  '), 1230);
  });

  it('rechaza lo que no es un precio', () => {
    for (const malo of ['', '   ', 'gratis', '49.999', '-5', '1e3', '4 9', '49.', '.5', '$49']) {
      assert.equal(aCentavos(malo).ok, false, `"${malo}" no deberia valer`);
    }
  });

  it('explica por que no vale, en vez de callarse', () => {
    const leido = aCentavos('abc');
    assert.equal(leido.ok, false);
    if (!leido.ok) assert.match(leido.motivo, /número/);
  });

  it('rechaza importes absurdos antes de mandarlos al servidor', () => {
    assert.equal(aCentavos('99999999').ok, false);
  });
});

describe('ensenar un precio', () => {
  it('siempre lleva los dos decimales', () => {
    assert.equal(deCentavos(4990, 'PEN'), 'S/ 49.90');
    assert.equal(deCentavos(4900, 'PEN'), 'S/ 49.00');
    assert.equal(deCentavos(50, 'PEN'), 'S/ 0.50');
    assert.equal(deCentavos(999, 'USD'), '$ 9.99');
  });

  it('gratis se dice «Gratis», no «S/ 0.00»', () => {
    assert.equal(etiquetaDePrecio(0), 'Gratis');
    assert.equal(etiquetaDePrecio(4990, 'PEN'), 'S/ 49.90');
  });

  it('una moneda desconocida no rompe la pantalla', () => {
    assert.equal(deCentavos(4990, 'XYZ'), '49.90');
  });
});

describe('ida y vuelta', () => {
  it('lo guardado se puede volver a editar sin cambiar de valor', () => {
    for (const centavos of [0, 50, 4990, 100000, 99999]) {
      const texto = aTextoEditable(centavos);
      if (centavos === 0) {
        assert.equal(texto, '');
        continue;
      }
      assert.equal(centavosDe(texto), centavos, `ida y vuelta de ${centavos}`);
    }
  });
});

describe('el importe de una constancia', () => {
  it('lleva el codigo, porque el simbolo no distingue', () => {
    // Es la prueba de cuanto se pago: «$ 49.90» no dice si son pesos o dolares.
    assert.equal(importeConMoneda(4990, 'MXN'), '$ 49.90 MXN');
    assert.equal(importeConMoneda(4990, 'USD'), '$ 49.90 USD');
    assert.notEqual(importeConMoneda(4990, 'MXN'), importeConMoneda(4990, 'USD'));
  });

  it('una moneda sin simbolo se lee igual', () => {
    assert.equal(importeConMoneda(4990, 'COP'), '49.90 COP');
  });

  it('sin moneda no se inventa ninguna', () => {
    // Ni el simbolo por defecto: poner «S/» donde el servidor no dijo nada
    // seria afirmar en que se cobro.
    assert.equal(importeConMoneda(4990, ''), '49.90');
  });
});
