import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { vecinasDe } from './vecinasDeLaLeccion.ts';

const TEMARIO = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('la lección anterior y la siguiente', () => {
  it('en medio hay las dos', () => {
    assert.deepEqual(vecinasDe(TEMARIO, 'b'), { anterior: 'a', siguiente: 'c' });
  });

  it('la primera no tiene anterior', () => {
    assert.deepEqual(vecinasDe(TEMARIO, 'a'), { anterior: null, siguiente: 'b' });
  });

  it('la última no tiene siguiente', () => {
    assert.deepEqual(vecinasDe(TEMARIO, 'c'), { anterior: 'b', siguiente: null });
  });

  it('una lección que no está en el temario no tiene vecinas', () => {
    // Adivinarlas con la posición 0 o con la última es como se acaba mandando
    // a alguien a la lección de otro módulo.
    assert.deepEqual(vecinasDe(TEMARIO, 'z'), { anterior: null, siguiente: null });
  });

  it('un temario de una sola lección no ofrece nada', () => {
    assert.deepEqual(vecinasDe([{ id: 'a' }], 'a'), {
      anterior: null,
      siguiente: null,
    });
  });

  it('un temario vacío tampoco', () => {
    assert.deepEqual(vecinasDe([], 'a'), { anterior: null, siguiente: null });
  });
});
