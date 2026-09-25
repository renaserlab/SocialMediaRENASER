import assert from 'node:assert/strict';
import { test } from 'node:test';

import { directoDelPush, rutaDelPush } from './rutaDelPush.ts';

const ID = '8f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';

test('un aviso de directo lleva al directo', () => {
  assert.equal(rutaDelPush({ type: 'live_started', liveId: ID }), `/live/${ID}`);
  assert.equal(directoDelPush({ type: 'live_started', liveId: ID }), ID);
});

test('los demas avisos siguen abriendo la aplicacion sin mas', () => {
  for (const datos of [
    { type: 'follow', profileId: ID },
    { type: 'like' },
    {},
    null,
    undefined,
    'live_started',
  ]) {
    assert.equal(rutaDelPush(datos), null, JSON.stringify(datos));
    assert.equal(directoDelPush(datos), null);
  }
});

test('un identificador que no es un UUID no acaba metido en una ruta', () => {
  for (const liveId of [
    '../admin',
    `${ID}/../../settings`,
    `${ID}?x=1`,
    'abc',
    '',
    42,
    null,
  ]) {
    assert.equal(
      rutaDelPush({ type: 'live_started', liveId }),
      null,
      `se aceptó ${String(liveId)}`,
    );
  }
});
