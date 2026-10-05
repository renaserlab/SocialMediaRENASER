import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { avisar, registerToastHost, retirarAvisosDe, toast, type ToastRequest } from './toast.ts';

/**
 * UNA NOTIFICACIÓN PEDIDA ANTES DE QUE EXISTA QUIEN LA PINTA NO SE PIERDE.
 *
 * El aviso de «tienes mensajes sin leer» se pide al abrir la aplicación, y la
 * respuesta del servidor puede llegar antes de que la aplicación termine de
 * arrancar. Sin esto se descartaba en silencio (05/10/2026).
 */

const notificacion = (clave: string, message = clave): ToastRequest => ({
  tipo: 'notificacion',
  message,
  clave,
});

function host() {
  const pintados: ToastRequest[] = [];
  const retirados: string[] = [];
  return {
    pintados,
    retirados,
    presentar: (peticion: ToastRequest) => {
      pintados.push(peticion);
    },
    retirar: (esDeLaClave: (clave: string) => boolean) => {
      for (const clave of ['a', 'b', 'c']) if (esDeLaClave(clave)) retirados.push(clave);
    },
  };
}

describe('avisos pedidos antes de que el host exista', () => {
  beforeEach(() => {
    // Vacía lo que haya quedado en espera de la prueba anterior.
    registerToastHost(() => {});
    registerToastHost(null);
  });

  it('una notificación pedida sin host sale en cuanto el host se monta', () => {
    avisar(notificacion('pendientes:mensajes', 'Tienes 3 mensajes sin leer'));
    const h = host();
    registerToastHost(h.presentar, h.retirar);
    assert.deepEqual(h.pintados.map((p) => p.message), ['Tienes 3 mensajes sin leer']);
  });

  it('y sale UNA vez: un segundo montaje no la repite', () => {
    avisar(notificacion('a'));
    const primero = host();
    registerToastHost(primero.presentar);
    registerToastHost(null);
    const segundo = host();
    registerToastHost(segundo.presentar);
    assert.equal(primero.pintados.length, 1);
    assert.equal(segundo.pintados.length, 0);
  });

  it('con el host montado va directa, sin pasar por la espera', () => {
    const h = host();
    registerToastHost(h.presentar);
    avisar(notificacion('a'));
    assert.equal(h.pintados.length, 1);
    registerToastHost(null);
    registerToastHost(h.presentar);
    assert.equal(h.pintados.length, 1, 'se guardó además de pintarse');
  });

  it('una confirmación de éxito sin host se descarta, como siempre', () => {
    toast('Publicado');
    avisar({ message: 'Guardado' });
    avisar({ message: 'Sin red', tipo: 'error' });
    const h = host();
    registerToastHost(h.presentar);
    assert.deepEqual(h.pintados, []);
  });

  it('la misma clave es el mismo aviso: se queda la versión más reciente', () => {
    avisar(notificacion('pendientes:mensajes', 'Tienes 1 mensaje sin leer'));
    avisar(notificacion('pendientes:avisos', 'Tienes 2 notificaciones sin leer'));
    avisar(notificacion('pendientes:mensajes', 'Tienes 3 mensajes sin leer'));
    const h = host();
    registerToastHost(h.presentar);
    assert.deepEqual(
      h.pintados.map((p) => p.message),
      ['Tienes 2 notificaciones sin leer', 'Tienes 3 mensajes sin leer'],
    );
  });

  it('con tope: un arranque atascado no acumula una cola', () => {
    for (let n = 1; n <= 9; n += 1) avisar(notificacion(`clave-${n}`));
    const h = host();
    registerToastHost(h.presentar);
    assert.deepEqual(
      h.pintados.map((p) => p.clave),
      ['clave-6', 'clave-7', 'clave-8', 'clave-9'],
    );
  });

  it('retirar un aviso lo quita también de la espera', () => {
    // Llega el aviso de una conversación y la persona la abre antes de que la
    // aplicación termine de arrancar: ya no tiene sentido enseñarlo.
    avisar(notificacion('conversacion:1'));
    avisar(notificacion('pendientes:avisos'));
    retirarAvisosDe((clave) => clave === 'conversacion:1');
    const h = host();
    registerToastHost(h.presentar, h.retirar);
    assert.deepEqual(h.pintados.map((p) => p.clave), ['pendientes:avisos']);
  });

  it('y con host, retirar sigue llegando al host', () => {
    const h = host();
    registerToastHost(h.presentar, h.retirar);
    retirarAvisosDe((clave) => clave === 'b');
    assert.deepEqual(h.retirados, ['b']);
  });
});
