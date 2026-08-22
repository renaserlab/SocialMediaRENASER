import assert from 'node:assert/strict';
import { test } from 'node:test';

import { interpretarPermiso } from './estadoDePermiso.ts';

/*
  Por que estas pruebas y no otras: confundir «denegado» con «bloqueado» deja un
  boton que no hace absolutamente nada —el sistema ya no vuelve a preguntar— y
  es imposible de ver probando en un movil donde el permiso ya esta concedido.
*/

test('un permiso concedido es concedido', () => {
  assert.equal(interpretarPermiso({ granted: true }), 'concedido');
});

test('el acceso a unas fotos concretas no es acceso completo', () => {
  // iOS 14+: el selector abre, pero medio carrete no esta.
  assert.equal(
    interpretarPermiso({ granted: true, accessPrivileges: 'limited' }),
    'limitado',
  );
});

test('en Android y en la web no hay acceso parcial que valga', () => {
  // Ahi el campo ni siquiera llega.
  assert.equal(interpretarPermiso({ granted: true, accessPrivileges: 'all' }), 'concedido');
  assert.equal(interpretarPermiso({ granted: true, accessPrivileges: undefined }), 'concedido');
});

test('un rechazo que todavia se puede reintentar es denegado, no bloqueado', () => {
  assert.equal(interpretarPermiso({ granted: false, canAskAgain: true }), 'denegado');
});

test('cuando el sistema ya no volvera a preguntar, esta bloqueado', () => {
  // Es lo que distingue «pulsa permitir» de «ve a los ajustes».
  assert.equal(interpretarPermiso({ granted: false, canAskAgain: false }), 'bloqueado');
});

test('sin saber si se puede volver a preguntar, se supone que si', () => {
  // La suposicion que NO deja a nadie encerrado sin salida: dar por bloqueado
  // lo que no lo esta mandaria a los ajustes a quien solo tenia que aceptar.
  assert.equal(interpretarPermiso({ granted: false }), 'denegado');
});
