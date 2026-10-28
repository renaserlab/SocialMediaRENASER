/**
 * Que lo que describe la instalación se pregunte una vez cada poco, no una
 * vez por pantalla (auditoría del 27/10, §6.4).
 *
 * Se ejecutan con `npm run test` (el runner de Node, sin dependencias).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { respuestaCompartida } from './respuestaCompartida.ts';

/** Una pregunta que se contesta cuando se le dice, y cuenta cuántas veces se hizo. */
function preguntaDeMentira() {
  let veces = 0;
  const pendientes: { bien: (v: number) => void; mal: (e: Error) => void }[] = [];
  const pedir = () => {
    veces += 1;
    return new Promise<number>((bien, mal) => pendientes.push({ bien, mal }));
  };
  return {
    pedir,
    veces: () => veces,
    contestar: (valor: number) => pendientes.shift()?.bien(valor),
    fallar: () => pendientes.shift()?.mal(new Error('sin red')),
  };
}

const vuelta = () => new Promise((r) => setImmediate(r));

describe('una respuesta compartida', () => {
  it('dos que preguntan a la vez esperan la misma respuesta', async () => {
    const p = preguntaDeMentira();
    const leer = respuestaCompartida(p.pedir, 60_000);
    const a = leer();
    const b = leer();
    p.contestar(7);
    assert.deepEqual(await Promise.all([a, b]), [7, 7]);
    assert.equal(p.veces(), 1);
  });

  it('la respuesta vale un rato y, pasado, se vuelve a preguntar', async () => {
    let reloj = 1_000;
    const p = preguntaDeMentira();
    const leer = respuestaCompartida(p.pedir, 60_000, () => reloj);
    const primera = leer();
    p.contestar(1);
    assert.equal(await primera, 1);
    await vuelta();
    reloj += 59_999;
    assert.equal(await leer(), 1);
    assert.equal(p.veces(), 1);
    // El plazo cuenta desde que contestó, no desde que se preguntó.
    reloj += 1;
    const otra = leer();
    assert.equal(p.veces(), 2);
    p.contestar(2);
    assert.equal(await otra, 2);
  });

  it('un fallo no se recuerda: la siguiente vuelve a preguntar', async () => {
    const p = preguntaDeMentira();
    const leer = respuestaCompartida(p.pedir, 60_000);
    const primera = leer();
    p.fallar();
    await assert.rejects(primera);
    await vuelta();
    const segunda = leer();
    assert.equal(p.veces(), 2);
    p.contestar(3);
    assert.equal(await segunda, 3);
  });
});

describe('enchufado: el chat y los temas comparten la pregunta', () => {
  const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const fuente = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
  const MENSAJES = fuente('repositories/MessageRepository.ts');
  const TEMAS = fuente('repositories/TemasRepository.ts');

  it('una sola puerta a `/conversations/availability`', () => {
    assert.equal(MENSAJES.match(/\$\{API_V1\}\/conversations\/availability`/g)?.length, 1);
    assert.match(MENSAJES, /export const leerDisponibilidadDelChat = respuestaCompartida\(/);
    assert.doesNotMatch(TEMAS, /\/conversations\/availability`/);
    assert.match(TEMAS, /await leerDisponibilidadDelChat\(\)/);
    // Cada una sigue respondiendo «no» ante la duda.
    assert.match(MENSAJES, /await leerDisponibilidadDelChat\(\)[\s\S]*?catch \{\s*return SIN_FUNCIONES;/);
    assert.match(TEMAS, /await leerDisponibilidadDelChat\(\)[\s\S]*?catch \{\s*return SIN_DISPONIBILIDAD;/);
  });
});
