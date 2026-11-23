/**
 * La precarga de la primera pagina de Inicio: se entrega una vez, solo a quien
 * pide el mismo feed y para la misma cuenta, y nunca caducada.
 *
 * Se ejecutan con `npm run test` (el runner de Node, sin dependencias).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { crearPrecargaDeInicio } from './precargaDeInicio.ts';

const lote = (id: string) =>
  ({ items: [{ id }], hayMas: true, siguienteCursor: { desplazamiento: 1 } }) as never;

function conReloj() {
  let t = 0;
  return { ahora: () => t, avanzar: (ms: number) => { t += ms; } };
}

describe('precarga de Inicio', () => {
  it('entrega la carga lanzada a quien pide la misma firma', async () => {
    const p = crearPrecargaDeInicio();
    p.lanzar('paraTi:cronologico', null, async () => lote('a'));
    const tomada = p.tomar('paraTi:cronologico');
    assert.ok(tomada);
    assert.deepEqual((await tomada).items, [{ id: 'a' }]);
  });

  it('se entrega UNA sola vez: el reintento pide de verdad', () => {
    const p = crearPrecargaDeInicio();
    p.lanzar('paraTi:cronologico', null, async () => lote('a'));
    assert.ok(p.tomar('paraTi:cronologico'));
    assert.equal(p.tomar('paraTi:cronologico'), null);
  });

  it('no se entrega a otro feed (se inicio sesion entretanto) y se descarta', () => {
    const p = crearPrecargaDeInicio();
    p.lanzar('paraTi:cronologico', null, async () => lote('a'));
    assert.equal(p.tomar('paraTi:recomendado'), null);
    assert.equal(p.tomar('paraTi:cronologico'), null);
  });

  it('caducada no vale', () => {
    const reloj = conReloj();
    const p = crearPrecargaDeInicio({ ahora: reloj.ahora, vigenciaMs: 1000 });
    p.lanzar('f', null, async () => lote('a'));
    reloj.avanzar(1001);
    assert.equal(p.tomar('f'), null);
  });

  it('no lanza dos veces mientras haya una vigente', () => {
    const p = crearPrecargaDeInicio();
    let llamadas = 0;
    const cargar = async () => { llamadas += 1; return lote('a'); };
    assert.equal(p.lanzar('f', null, cargar), true);
    assert.equal(p.lanzar('f', null, cargar), false);
    assert.equal(llamadas, 1);
  });

  it('se descarta si cambia la cuenta, y se conserva si es la misma', () => {
    const p = crearPrecargaDeInicio();
    p.lanzar('f', 'u1', async () => lote('a'));
    p.descartarSiNoEsDe('u1');
    assert.ok(p.tomar('f'));

    p.lanzar('f', 'u1', async () => lote('a'));
    p.descartarSiNoEsDe(null);
    assert.equal(p.tomar('f'), null);
  });

  it('descartar la quita aunque sea de la misma cuenta', () => {
    const p = crearPrecargaDeInicio();
    p.lanzar('f', 'u1', async () => lote('a'));
    p.descartar();
    assert.equal(p.tomar('f'), null);
  });

  it('un fallo no queda como rechazo sin atender y llega a quien la tome', async () => {
    const p = crearPrecargaDeInicio();
    p.lanzar('f', null, async () => { throw new Error('sin red'); });
    const tomada = p.tomar('f');
    assert.ok(tomada);
    await assert.rejects(tomada, /sin red/);
  });

  it('un cargar que lanza en sincronico tampoco rompe el arranque', async () => {
    const p = crearPrecargaDeInicio();
    assert.doesNotThrow(() =>
      p.lanzar('f', null, () => { throw new Error('roto'); }),
    );
    await assert.rejects(p.tomar('f')!, /roto/);
  });
});
