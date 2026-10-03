import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tocarConCerrojo } from './toqueConCerrojo.ts';

/**
 * El cerrojo del botón, probado de verdad.
 *
 * `Button` lo usa en TODA la aplicación: si deja pasar un segundo toque, algo
 * se guarda dos veces; si no se suelta, un botón queda muerto. Aquí no se lee
 * el código: se ejecuta.
 */

/** Una promesa que se resuelve o falla cuando la prueba quiere. */
function pendiente<T = void>() {
  let resolver!: (valor: T) => void;
  let rechazar!: (motivo: unknown) => void;
  const promesa = new Promise<T>((si, no) => {
    resolver = si;
    rechazar = no;
  });
  return { promesa, resolver, rechazar };
}

test('una acción que termina en el acto no cierra nada', () => {
  const cerrojo = { current: false };
  const cambios: boolean[] = [];
  let veces = 0;
  for (const devuelve of [undefined, null, 0, '', 'texto', {}, { then: 'no es una función' }]) {
    const vuelta = tocarConCerrojo(cerrojo, () => { veces += 1; return devuelve; }, (o) => cambios.push(o));
    assert.equal(vuelta, undefined);
  }
  assert.equal(veces, 7, 'cada toque ejecuta la acción');
  assert.equal(cerrojo.current, false);
  assert.deepEqual(cambios, [], 'el botón no llegó a enseñarse ocupado');
});

test('mientras la promesa sigue en curso, el segundo toque no hace nada', async () => {
  const cerrojo = { current: false };
  const cambios: boolean[] = [];
  const espera = pendiente();
  let veces = 0;
  const accion = () => { veces += 1; return espera.promesa; };

  const primera = tocarConCerrojo(cerrojo, accion, (o) => cambios.push(o));
  assert.equal(cerrojo.current, true, 'se cierra en el mismo toque, sin esperar a un render');
  assert.deepEqual(cambios, [true]);

  // Tres toques más, seguidos: ninguno llega a la acción.
  for (let i = 0; i < 3; i += 1) {
    assert.equal(tocarConCerrojo(cerrojo, accion, (o) => cambios.push(o)), undefined);
  }
  assert.equal(veces, 1, 'la acción se ejecutó UNA vez');
  assert.deepEqual(cambios, [true]);

  espera.resolver();
  await primera;
  assert.equal(cerrojo.current, false, 'al terminar se suelta');
  assert.deepEqual(cambios, [true, false]);

  // Y el botón vuelve a servir.
  const otra = tocarConCerrojo(cerrojo, () => { veces += 1; return Promise.resolve(); }, (o) => cambios.push(o));
  await otra;
  assert.equal(veces, 2);
  assert.deepEqual(cambios, [true, false, true, false]);
});

test('si la acción falla, el cerrojo se suelta y el fallo no se traga', async () => {
  const cerrojo = { current: false };
  const cambios: boolean[] = [];
  const espera = pendiente();
  const vuelta = tocarConCerrojo(cerrojo, () => espera.promesa, (o) => cambios.push(o));
  assert.equal(cerrojo.current, true);
  espera.rechazar(new Error('no se pudo guardar'));
  await assert.rejects(vuelta as Promise<void>, /no se pudo guardar/);
  assert.equal(cerrojo.current, false, 'un botón que falló no queda muerto');
  assert.deepEqual(cambios, [true, false]);
});

test('un «thenable» que no es una Promise también cierra', async () => {
  const cerrojo = { current: false };
  const cambios: boolean[] = [];
  const thenable = { then: (si: () => void) => { setTimeout(si, 0); } };
  const vuelta = tocarConCerrojo(cerrojo, () => thenable, (o) => cambios.push(o));
  assert.equal(cerrojo.current, true);
  await vuelta;
  assert.deepEqual(cambios, [true, false]);
});

test('`Button` usa este cerrojo y no otro', () => {
  const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const boton = readFileSync(join(SRC, 'components', 'Button.tsx'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(boton, /import \{ tocarConCerrojo \} from '@\/lib\/toqueConCerrojo';/);
  assert.match(boton, /tocarConCerrojo\(enCurso, onPress, /);
  // El cerrojo es una referencia (no espera a un render) y el estado solo lo enseña.
  assert.match(boton, /const enCurso = useRef\(false\);/);
  // Lo que se ve y lo que oye el lector de pantalla salen del mismo sitio.
  assert.match(boton, /const ocupado = loading \|\| pendiente;/);
  assert.match(boton, /disabled=\{disabled \|\| ocupado\}/);
  assert.match(boton, /accessibilityState=\{\{ disabled: disabled \|\| ocupado, busy: ocupado \}\}/);
  // Tras desmontarse la pantalla no se toca su estado.
  assert.match(boton, /if \(montado\.current\) setPendiente\(/);
});
