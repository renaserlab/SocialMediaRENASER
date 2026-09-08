import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  convieneReintentar,
  estadoDeLaVuelta,
  ordenDeLaUrl,
  type EstadoDeLaVuelta,
} from './vueltaDelPago.ts';

/**
 * LA PANTALLA DE VUELTA DEL PAGO ES LA ÚNICA EN LA QUE EQUIVOCARSE SIGNIFICA
 * DECIRLE A UNA PERSONA QUE HA PAGADO SIN QUE SEA VERDAD.
 *
 * Antes de esto no existía: el checkout mandaba a `/pago`, una ruta que no
 * estaba en la aplicación, así que quien acababa de pagar caía en la pantalla
 * de «ruta no encontrada» de expo-router, sin saber si se le había cobrado y
 * sin ninguna salida.
 */
describe('qué se le dice a quien vuelve de pagar', () => {
  it('mientras no ha contestado el servidor, no se afirma nada', () => {
    assert.equal(estadoDeLaVuelta(null, null), 'verificando');
  });

  it('«confirmado» exige pagado Y con acceso', () => {
    /*
      Con solo `paid` la pantalla mandaría al curso a alguien que todavía no
      puede entrar, y ese viaje termina en un «no tienes acceso» justo después
      de pagar: el peor momento posible para ese mensaje. El acceso lo concede
      el aviso de la pasarela, y tarda segundos.
    */
    assert.equal(
      estadoDeLaVuelta({ status: 'paid', tieneAcceso: true }, null),
      'confirmado',
    );
    assert.equal(
      estadoDeLaVuelta({ status: 'paid', tieneAcceso: false }, null),
      'concediendo',
    );
  });

  it('cada estado del servidor tiene el suyo', () => {
    const casos: [string, EstadoDeLaVuelta][] = [
      ['pending', 'pendiente'],
      ['failed', 'rechazado'],
      ['cancelled', 'rechazado'],
      ['refunded', 'devuelto'],
    ];
    for (const [servidor, esperado] of casos) {
      assert.equal(
        estadoDeLaVuelta({ status: servidor, tieneAcceso: false }, null),
        esperado,
        `estado ${servidor}`,
      );
    }
  });

  it('un estado desconocido NO se lee como bueno', () => {
    // Si el servidor añade un estado que este cliente no conoce, la lectura
    // segura es «vuelve a mirar», nunca «enhorabuena».
    assert.equal(
      estadoDeLaVuelta({ status: 'algo_nuevo', tieneAcceso: true }, null),
      'pendiente',
    );
  });

  it('distingue no encontrada de fallo de red', () => {
    // No es lo mismo «esa orden no es tuya» que «no pude preguntar»: lo primero
    // no se arregla reintentando y lo segundo sí.
    assert.equal(estadoDeLaVuelta(null, 'no_encontrada'), 'no_encontrada');
    assert.equal(estadoDeLaVuelta(null, 'red'), 'error_recuperable');
  });
});

describe('cuándo vale la pena volver a preguntar', () => {
  it('solo lo que se resuelve solo en segundos', () => {
    assert.equal(convieneReintentar('concediendo'), true);
    assert.equal(convieneReintentar('pendiente'), true);
  });

  it('un rechazo no se reintenta', () => {
    // Repreguntar sobre un rechazo solo alarga la espera de alguien que ya
    // tiene una respuesta.
    for (const estado of [
      'confirmado',
      'rechazado',
      'devuelto',
      'no_encontrada',
      'error_recuperable',
    ] as EstadoDeLaVuelta[]) {
      assert.equal(convieneReintentar(estado), false, estado);
    }
  });
});

describe('el identificador que trae la URL', () => {
  it('se valida la forma antes de preguntar', () => {
    assert.equal(
      ordenDeLaUrl('0e2f7a1c-1111-2222-3333-444455556666'),
      '0e2f7a1c-1111-2222-3333-444455556666',
    );
  });

  it('lo que no es un identificador no llega al servidor', () => {
    // Lo que hay en la barra de direcciones es texto libre.
    for (const basura of ['', '   ', 'undefined', '1 OR 1=1', '../../admin', null, 42]) {
      assert.equal(ordenDeLaUrl(basura), null, String(basura));
    }
  });
});
