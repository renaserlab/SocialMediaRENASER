/**
 * Que un mensaje no se pinte dos veces.
 *
 * Es el fallo tipico de un chat en vivo y ademas uno de los que peor se ven: la
 * burbuja aparece duplicada durante un instante y desaparece sola, asi que
 * cuesta reproducirlo a mano y es facil convencerse de que «ha sido cosa de la
 * red». No lo es: es que un mensaje propio llega por la respuesta del POST y
 * TAMBIEN por la suscripcion de Realtime, mientras en pantalla ya hay puesta una
 * burbuja optimista. Tres versiones de lo mismo.
 *
 * Lo que hace que esto se pueda probar de verdad es que la logica sea pura: el
 * orden de llegada —que en la aplicacion real depende de la red y no se puede
 * forzar— aqui se decide escribiendolo.
 *
 * Se ejecutan con `npm run test` (el runner de Node, sin dependencias).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  descartarEnvio,
  esTemporal,
  fusionar,
  instanteMasAntiguo,
  instanteMasReciente,
  nuevoIdTemporal,
  reconciliarEnvio,
  type MensajeFusionable,
} from './mensajesEnVivo.ts';

const mio = (id: string, text: string, createdAtIso?: string): MensajeFusionable => ({
  id,
  text,
  sender: 'me',
  createdAtIso,
});

const suyo = (id: string, text: string, createdAtIso?: string): MensajeFusionable => ({
  id,
  text,
  sender: 'them',
  createdAtIso,
});

describe('identificadores temporales', () => {
  it('se distinguen de los del servidor', () => {
    assert.ok(esTemporal(nuevoIdTemporal()));
    assert.equal(esTemporal('9f1c8b2e-0000-0000-0000-000000000001'), false);
  });

  it('dos seguidos no coinciden', () => {
    // Sin esto, escribir dos veces rapido daria la misma clave a dos burbujas y
    // la lista pintaria una sola.
    assert.notEqual(nuevoIdTemporal(1000), nuevoIdTemporal(1000));
  });
});

describe('un mensaje no puede salir dos veces', () => {
  it('el mismo identificador no se repite', () => {
    const lista = fusionar(
      [suyo('a', 'hola', '2026-08-25T10:00:00Z')],
      [suyo('a', 'hola', '2026-08-25T10:00:00Z')],
    );
    assert.equal(lista.length, 1);
  });

  it('gana la version que acaba de llegar', () => {
    // La del servidor sabe cosas que la optimista no: los adjuntos ya
    // registrados, la hora de verdad. Quedarse con la vieja las perderia.
    const lista = fusionar(
      [suyo('a', 'texto viejo', '2026-08-25T10:00:00Z')],
      [suyo('a', 'texto nuevo', '2026-08-25T10:00:00Z')],
    );
    assert.equal(lista[0]?.text, 'texto nuevo');
  });

  it('Realtime ANTES que la respuesta del POST no duplica la burbuja', () => {
    // EL CASO FRECUENTE, y el que peor se maneja si solo se mira el
    // identificador: Realtime suele adelantar a la respuesta HTTP. Cuando llega,
    // la burbuja optimista todavia tiene su identificador temporal y no coincide
    // con nada.
    const optimista = [mio('tmp-1', 'nos vemos luego')];
    const conRealtime = fusionar(optimista, [
      mio('real-1', 'nos vemos luego', '2026-08-25T10:00:01Z'),
    ]);

    assert.equal(conRealtime.length, 1, 'la burbuja se ha pintado dos veces');
    assert.equal(conRealtime[0]?.id, 'real-1');
  });

  it('y la respuesta del POST que llega despues tampoco anade otra', () => {
    const conRealtime = fusionar(
      [mio('tmp-1', 'nos vemos luego')],
      [mio('real-1', 'nos vemos luego', '2026-08-25T10:00:01Z')],
    );
    const final = reconciliarEnvio(
      conRealtime,
      'tmp-1',
      mio('real-1', 'nos vemos luego', '2026-08-25T10:00:01Z'),
    );
    assert.equal(final.length, 1);
    assert.equal(final[0]?.id, 'real-1');
  });

  it('la respuesta del POST ANTES que Realtime tampoco duplica', () => {
    // El otro orden posible. Aqui si coinciden los identificadores, asi que
    // basta la regla del identificador unico; se comprueba igual porque es la
    // mitad del caso y romperla seria igual de visible.
    const tras_post = reconciliarEnvio(
      [mio('tmp-1', 'vale')],
      'tmp-1',
      mio('real-1', 'vale', '2026-08-25T10:00:01Z'),
    );
    const tras_realtime = fusionar(tras_post, [
      mio('real-1', 'vale', '2026-08-25T10:00:01Z'),
    ]);
    assert.equal(tras_realtime.length, 1);
  });

  it('un mensaje AJENO con el mismo texto no se come mi burbuja pendiente', () => {
    // La regla del contenido solo vale para lo PROPIO. Si valiera para todo,
    // que la otra persona escriba «vale» a la vez borraria mi mensaje sin
    // enviar.
    const lista = fusionar(
      [mio('tmp-1', 'vale')],
      [suyo('real-9', 'vale', '2026-08-25T10:00:01Z')],
    );
    assert.equal(lista.length, 2);
    assert.ok(lista.some((m) => m.id === 'tmp-1'));
  });

  it('dos mensajes propios seguidos con el mismo texto se conservan los dos', () => {
    // «si», «si». Es de lo mas normal, y borrar por contenido sin cuidado
    // haria desaparecer uno de los dos.
    const dos = [mio('tmp-1', 'si'), mio('tmp-2', 'si')];
    const tras_primero = reconciliarEnvio(dos, 'tmp-1', mio('r1', 'si', '2026-08-25T10:00:01Z'));
    assert.equal(tras_primero.length, 2);
    const tras_segundo = reconciliarEnvio(
      tras_primero,
      'tmp-2',
      mio('r2', 'si', '2026-08-25T10:00:02Z'),
    );
    assert.equal(tras_segundo.length, 2);
    assert.deepEqual(
      tras_segundo.map((m) => m.id),
      ['r1', 'r2'],
    );
  });
});

describe('el orden', () => {
  it('manda el instante del servidor, no el de llegada', () => {
    // El historial que se trae al subir llega DESPUES pero es MAS ANTIGUO.
    const lista = fusionar(
      [suyo('c', 'tercero', '2026-08-25T10:00:03Z')],
      [
        suyo('a', 'primero', '2026-08-25T10:00:01Z'),
        suyo('b', 'segundo', '2026-08-25T10:00:02Z'),
      ],
    );
    assert.deepEqual(
      lista.map((m) => m.id),
      ['a', 'b', 'c'],
    );
  });

  it('lo que aun no ha llegado al servidor va al final', () => {
    // Es donde lo espera quien acaba de escribirlo. Ponerlo por instante seria
    // imposible: todavia no tiene.
    const lista = fusionar(
      [mio('tmp-1', 'pendiente')],
      [suyo('a', 'antiguo', '2026-08-25T10:00:01Z')],
    );
    assert.deepEqual(
      lista.map((m) => m.id),
      ['a', 'tmp-1'],
    );
  });

  it('dos mensajes con el mismo instante no bailan entre repintados', () => {
    // Sin desempate, `sort` puede devolverlos en cualquier orden y las burbujas
    // se moverian solas mientras alguien las lee.
    const uno = fusionar([], [suyo('b', 'b', '2026-08-25T10:00:00Z'), suyo('a', 'a', '2026-08-25T10:00:00Z')]);
    const otro = fusionar([], [suyo('a', 'a', '2026-08-25T10:00:00Z'), suyo('b', 'b', '2026-08-25T10:00:00Z')]);
    assert.deepEqual(uno.map((m) => m.id), otro.map((m) => m.id));
  });
});

describe('un envio que falla', () => {
  it('quita la burbuja y deja lo demas', () => {
    // Antes la burbuja desaparecia sin decir nada y quien escribia creia que su
    // mensaje se habia enviado; ahora la pantalla avisa, pero la burbuja tiene
    // que irse igual: dejarla mentiria al reves.
    const lista = descartarEnvio(
      [suyo('a', 'hola', '2026-08-25T10:00:00Z'), mio('tmp-1', 'no salio')],
      'tmp-1',
    );
    assert.deepEqual(lista.map((m) => m.id), ['a']);
  });
});

describe('los extremos del historial', () => {
  it('el mas reciente ignora lo que aun no tiene instante', () => {
    // Se manda como `after` para pedir lo que haya entrado desde entonces. Un
    // optimista no tiene instante: tomarlo por el ultimo dejaria el hueco sin
    // rellenar y se perderian mensajes.
    const reciente = instanteMasReciente([
      suyo('a', 'a', '2026-08-25T10:00:01Z'),
      suyo('b', 'b', '2026-08-25T10:00:05Z'),
      mio('tmp-1', 'pendiente'),
    ]);
    assert.equal(reciente, '2026-08-25T10:00:05Z');
  });

  it('el mas antiguo es lo que se manda para subir por el historial', () => {
    const antiguo = instanteMasAntiguo([
      suyo('b', 'b', '2026-08-25T10:00:05Z'),
      suyo('a', 'a', '2026-08-25T10:00:01Z'),
    ]);
    assert.equal(antiguo, '2026-08-25T10:00:01Z');
  });

  it('una lista vacia no tiene extremos', () => {
    // Con `undefined` quien llama sabe que tiene que pedir la primera pagina
    // sin filtro; con una fecha inventada pediria una ventana vacia para
    // siempre.
    assert.equal(instanteMasReciente([]), undefined);
    assert.equal(instanteMasAntiguo([]), undefined);
    assert.equal(instanteMasReciente([mio('tmp-1', 'x')]), undefined);
  });
});
