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
  assert.equal(
    interpretarPermiso({ granted: false, canAskAgain: true, status: 'denied' }),
    'denegado',
  );
});

test('no haber preguntado todavia NO es un rechazo', () => {
  /*
    Telefono recien instalado. `granted:false` y `canAskAgain:true` son los
    mismos valores que trae un rechazo reintentable, asi que sin mirar `status`
    los dos casos eran indistinguibles: la camara abria en el cartel de
    «Z necesita la camara» sin haber preguntado nunca, y no aparecia sola jamas.
  */
  assert.equal(
    interpretarPermiso({ granted: false, canAskAgain: true, status: 'undetermined' }),
    'sinPreguntar',
  );
});

test('si el sistema ya no pregunta, esta bloqueado aunque diga «sin preguntar»', () => {
  // El orden importa: da igual como se llegara ahi, la unica salida son los
  // ajustes, y ofrecer «Permitir» seria un boton que no hace nada.
  assert.equal(
    interpretarPermiso({ granted: false, canAskAgain: false, status: 'undetermined' }),
    'bloqueado',
  );
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

test('una respuesta sin `status` sigue leyendose como antes', () => {
  // Compatibilidad: el campo lo trae Expo siempre, pero si un dia faltara la
  // lectura tiene que seguir siendo la conservadora, no «sin preguntar»
  // (que volveria a lanzar el dialogo del sistema a quien ya dijo que no).
  assert.equal(interpretarPermiso({ granted: false, canAskAgain: true }), 'denegado');
});
