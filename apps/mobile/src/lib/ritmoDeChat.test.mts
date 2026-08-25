/**
 * La politica de ritmo del cliente en una emision.
 *
 * Lo que se fija aqui es que el freno sea EXACTAMENTE lo que dice ser: una
 * comodidad que avisa antes de escribir. No prueba —ni podria— que nadie abuse
 * del chat: eso lo decide el servidor con sus 409, y esta ventana se salta
 * hablando con la API sin pasar por la aplicacion.
 *
 * Lo que si conviene tener clavado es que no se pase de listo en la otra
 * direccion: una ventana mal calculada bloquea a quien escribe normal, y ese
 * fallo no da error en ningun sitio, simplemente hace que la aplicacion parezca
 * rota.
 *
 * Se ejecutan con `npm run test` (el runner de Node, sin dependencias).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  debeResumirReacciones,
  enviosVigentes,
  esperaRestanteMs,
  INTERVALO_DE_RESUMEN_MS,
  MENSAJES_POR_VENTANA,
  puedeEnviarMensaje,
  registrarEnvio,
  VENTANA_DE_MENSAJES_MS,
} from './ritmoDeChat.ts';

/** Reloj de mentira: la politica es pura, asi que el tiempo se pasa a mano. */
const T0 = 1_000_000;

/** Llena el cupo entero en el mismo instante. */
function cupoLleno(momento = T0): number[] {
  let envios: number[] = [];
  for (let i = 0; i < MENSAJES_POR_VENTANA; i += 1) {
    envios = registrarEnvio(envios, momento);
  }
  return envios;
}

describe('cuantos mensajes se dejan enviar', () => {
  it('deja escribir con el historial vacio', () => {
    assert.equal(puedeEnviarMensaje([], T0), true);
  });

  it('deja el cupo entero de golpe', () => {
    let envios: number[] = [];
    for (let i = 0; i < MENSAJES_POR_VENTANA; i += 1) {
      assert.equal(puedeEnviarMensaje(envios, T0), true, `el mensaje ${i + 1} deberia pasar`);
      envios = registrarEnvio(envios, T0);
    }
    assert.equal(envios.length, MENSAJES_POR_VENTANA);
  });

  it('frena el que se pasa del cupo', () => {
    assert.equal(puedeEnviarMensaje(cupoLleno(), T0), false);
  });

  it('vuelve a dejar escribir cuando caduca la ventana', () => {
    const envios = cupoLleno();
    assert.equal(puedeEnviarMensaje(envios, T0 + VENTANA_DE_MENSAJES_MS - 1), false);
    assert.equal(puedeEnviarMensaje(envios, T0 + VENTANA_DE_MENSAJES_MS), true);
  });

  it('no frena a quien escribe repartido en el tiempo', () => {
    // Un mensaje cada tres segundos es una conversacion normal, y no puede
    // acabar bloqueada por mucho rato que se lleve hablando.
    let envios: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      const ahora = T0 + i * 3_000;
      assert.equal(puedeEnviarMensaje(envios, ahora), true, `bloqueado en el mensaje ${i + 1}`);
      envios = registrarEnvio(envios, ahora);
    }
  });

  it('no acumula historial sin fin', () => {
    // `registrarEnvio` poda al apuntar: sin esto, una emision larga guardaria
    // un numero por cada mensaje escrito para siempre.
    let envios: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      envios = registrarEnvio(envios, T0 + i * 3_000);
    }
    assert.ok(
      envios.length <= MENSAJES_POR_VENTANA,
      `quedaron ${envios.length} envios apuntados`,
    );
  });
});

describe('cuanto hay que esperar', () => {
  it('no hace esperar a quien tiene cupo', () => {
    assert.equal(esperaRestanteMs([], T0), 0);
    assert.equal(esperaRestanteMs([T0], T0), 0);
  });

  it('dice el tiempo que queda de la ventana', () => {
    const envios = cupoLleno();
    assert.equal(esperaRestanteMs(envios, T0), VENTANA_DE_MENSAJES_MS);
    assert.equal(esperaRestanteMs(envios, T0 + 4_000), VENTANA_DE_MENSAJES_MS - 4_000);
  });

  it('mira el envio que libera sitio, no el mas antiguo de todos', () => {
    // Cuatro envios viejisimos que ya no cuentan y el cupo lleno hace un
    // segundo: la espera es la del cupo reciente.
    const viejos = [T0 - 60_000, T0 - 59_000, T0 - 58_000, T0 - 57_000];
    const envios = [...viejos, ...cupoLleno(T0)];
    assert.equal(esperaRestanteMs(envios, T0 + 1_000), VENTANA_DE_MENSAJES_MS - 1_000);
  });

  it('nunca devuelve un numero negativo', () => {
    assert.equal(esperaRestanteMs(cupoLleno(), T0 + VENTANA_DE_MENSAJES_MS * 3), 0);
  });
});

describe('los envios que siguen contando', () => {
  it('descarta los que ya salieron de la ventana', () => {
    const envios = [T0 - VENTANA_DE_MENSAJES_MS, T0 - 1_000, T0];
    assert.deepEqual(enviosVigentes(envios, T0), [T0 - 1_000, T0]);
  });
});

describe('cada cuanto se resume el acumulador de reacciones', () => {
  it('no manda un resumen por cada toque', () => {
    assert.equal(debeResumirReacciones(T0, T0), false);
    assert.equal(debeResumirReacciones(T0, T0 + INTERVALO_DE_RESUMEN_MS - 1), false);
  });

  it('manda al cumplirse el intervalo', () => {
    assert.equal(debeResumirReacciones(T0, T0 + INTERVALO_DE_RESUMEN_MS), true);
  });

  it('el intervalo es de segundos, no de milisegundos', () => {
    // Un descuido de tres ceros aqui devuelve el problema que este acumulador
    // existe para evitar: una peticion por reaccion.
    assert.ok(INTERVALO_DE_RESUMEN_MS >= 1_000, 'el resumen saldria demasiado seguido');
  });
});
