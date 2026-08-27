/**
 * Lo que se rompía al comentar, escrito como pruebas.
 *
 * El fallo grave era el primero: ante un 404 la pantalla CONSERVABA el
 * comentario optimista. O sea, enseñaba como publicado algo que el servidor
 * había rechazado, y quien lo escribió se iba creyendo que estaba ahí.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  anadirPagina,
  conOptimista,
  confirmarOptimista,
  descartarOptimista,
  enviarComentario,
  esOptimista,
  estadoInicial,
  primeraPagina,
  type Cursor,
} from './comentarios.ts';

type Comentario = { id: string; texto: string };

const c = (id: string, texto = `texto ${id}`): Comentario => ({ id, texto });
const CURSOR: Cursor = { createdAt: '2026-01-01T12:00:00Z', id: 'c20' };

/** Un servidor que siempre acepta. */
const aceptar = (id: string) => async (texto: string) => c(id, texto);
/** Un servidor que rechaza con el error que se le diga. */
const rechazar = (error: unknown) => async () => {
  throw error;
};

/** Imita a `ApiError`: lo que se miraba (mal) para decidir si borrar. */
class ErrorDeApi extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// 1. Un comentario aceptado se queda
// ---------------------------------------------------------------------------

test('el comentario que el servidor acepta se queda en la lista', async () => {
  const resultado = await enviarComentario<Comentario>({
    estado: primeraPagina([c('c1')], null),
    texto: 'Muy bueno',
    autorizar: async () => true,
    crear: aceptar('real-1'),
    optimista: (texto, id) => ({ id, texto }),
  });

  assert.equal(resultado.fallo, null);
  assert.deepEqual(
    resultado.estado.lista.map((x) => x.id),
    ['real-1', 'c1'],
    'el comentario nuevo va arriba y con el id que le dio el servidor',
  );
  assert.equal(resultado.texto, '', 'el campo se vacía cuando de verdad se publicó');
  assert.equal(resultado.delta, 1);
});

// ---------------------------------------------------------------------------
// 2. Un comentario rechazado desaparece. El motivo da igual.
// ---------------------------------------------------------------------------

test('un 404 no deja el comentario en pantalla', async () => {
  /*
    Este es el bug tal cual estaba escrito: `if (!(error instanceof ApiError &&
    error.status === 404))` filtraba el optimista, o sea que con un 404 NO lo
    filtraba y el comentario se quedaba. La publicación no existe y aun así se
    veía un comentario suyo.
  */
  const antes = primeraPagina([c('c1')], null);
  const resultado = await enviarComentario<Comentario>({
    estado: antes,
    texto: 'Muy bueno',
    autorizar: async () => true,
    crear: rechazar(new ErrorDeApi(404)),
    optimista: (texto, id) => ({ id, texto }),
  });

  assert.equal(resultado.fallo, 'servidor');
  assert.deepEqual(resultado.estado.lista.map((x) => x.id), ['c1']);
  assert.equal(resultado.estado.total, antes.total, 'el contador vuelve a donde estaba');
  assert.equal(resultado.texto, 'Muy bueno', 'no se pierde lo escrito: se puede reintentar');
});

test('un fallo de red tampoco deja el comentario en pantalla', async () => {
  // Sin `status` que mirar. Es el caso que ni siquiera se contemplaba.
  const resultado = await enviarComentario<Comentario>({
    estado: primeraPagina([c('c1')], null),
    texto: 'Muy bueno',
    autorizar: async () => true,
    crear: rechazar(new TypeError('Network request failed')),
    optimista: (texto, id) => ({ id, texto }),
  });

  assert.deepEqual(resultado.estado.lista.map((x) => x.id), ['c1']);
  assert.equal(resultado.delta, 0, 'no se sube un contador por algo que no se guardó');
});

test('un 500 y un 401 se tratan igual que los demás', async () => {
  for (const status of [401, 403, 500, 503]) {
    const resultado = await enviarComentario<Comentario>({
      estado: estadoInicial<Comentario>(),
      texto: 'Hola',
      autorizar: async () => true,
      crear: rechazar(new ErrorDeApi(status)),
      optimista: (texto, id) => ({ id, texto }),
    });
    assert.deepEqual(resultado.estado.lista, [], `el ${status} dejó basura en la lista`);
  }
});

// ---------------------------------------------------------------------------
// 3. Sin sesión: ni comentario falso ni texto perdido
// ---------------------------------------------------------------------------

test('sin cuenta no se publica nada y el texto sigue escrito', async () => {
  let sePidioAlServidor = false;
  const resultado = await enviarComentario<Comentario>({
    estado: primeraPagina([c('c1')], null),
    texto: 'Quiero comentar esto',
    autorizar: async () => false, // dijo «ahora no»
    crear: async () => {
      sePidioAlServidor = true;
      return c('no-deberia');
    },
    optimista: (texto, id) => ({ id, texto }),
  });

  assert.equal(sePidioAlServidor, false, 'se llamó al servidor sin sesión');
  assert.equal(resultado.fallo, 'sin-sesion');
  assert.deepEqual(
    resultado.estado.lista.map((x) => x.id),
    ['c1'],
    'apareció un comentario que nadie llegó a publicar',
  );
  assert.equal(
    resultado.texto,
    'Quiero comentar esto',
    'se vació el campo antes de pedir la cuenta: quien no se registra pierde lo escrito',
  );
  assert.equal(resultado.delta, 0);
});

test('un campo vacío no molesta a nadie', async () => {
  let sePidioSesion = false;
  const resultado = await enviarComentario<Comentario>({
    estado: estadoInicial<Comentario>(),
    texto: '   ',
    autorizar: async () => {
      sePidioSesion = true;
      return true;
    },
    crear: aceptar('x'),
    optimista: (texto, id) => ({ id, texto }),
  });

  assert.equal(sePidioSesion, false, 'no se pide cuenta para no publicar nada');
  assert.deepEqual(resultado.estado.lista, []);
});

// ---------------------------------------------------------------------------
// 4. El contador
// ---------------------------------------------------------------------------

test('el contador sube uno al publicar y solo uno', async () => {
  // El muro decía que hay 7; se han cargado 3.
  const inicio = primeraPagina([c('a'), c('b'), c('c')], CURSOR, 7);
  assert.equal(inicio.total, 7);

  const resultado = await enviarComentario<Comentario>({
    estado: inicio,
    texto: 'octavo',
    autorizar: async () => true,
    crear: aceptar('real'),
    optimista: (texto, id) => ({ id, texto }),
  });

  assert.equal(resultado.estado.total, 8);
  assert.equal(resultado.estado.lista.length, 4, 'solo se cargaron cuatro, no ocho');
});

test('el contador nunca queda por debajo de lo que se está enseñando', () => {
  // Un contador viejo (0) con comentarios cargados: manda lo que se ve.
  const estado = primeraPagina([c('a'), c('b')], null, 0);
  assert.equal(estado.total, 2);
  assert.equal(descartarOptimista(estado, 'no-existe').total, 2);
});

test('el contador no baja de cero aunque se descarte de más', () => {
  const vacio = estadoInicial<Comentario>(0);
  assert.equal(descartarOptimista(vacio, 'fantasma').total, 0);
});

// ---------------------------------------------------------------------------
// 5. Paginación: sin duplicados y sin saltos
// ---------------------------------------------------------------------------

test('cien comentarios se recorren en páginas sin repetir ninguno', () => {
  const todos = Array.from({ length: 100 }, (_, i) => c(`c${i}`));
  let estado = estadoInicial<Comentario>(100);
  for (let inicio = 0; inicio < 100; inicio += 20) {
    estado = anadirPagina(estado, todos.slice(inicio, inicio + 20), CURSOR);
  }

  assert.equal(estado.lista.length, 100);
  assert.equal(new Set(estado.lista.map((x) => x.id)).size, 100);
  assert.deepEqual(estado.lista.map((x) => x.id), todos.map((x) => x.id), 'se descolocó el orden');
});

test('dos páginas que se solapan no duplican comentarios', () => {
  /*
    Pasa de verdad: si alguien comenta mientras se lee, la página siguiente
    puede volver a traer algo que ya se vio. Con offset pasa siempre; con
    cursor solo en los empates de fecha. Duplicado en pantalla, el mismo
    comentario parece dos comentarios iguales.
  */
  const primera = primeraPagina([c('c3'), c('c2')], CURSOR);
  const estado = anadirPagina(primera, [c('c2'), c('c1')], CURSOR);

  assert.deepEqual(estado.lista.map((x) => x.id), ['c3', 'c2', 'c1']);
  assert.equal(estado.total, 3);
});

test('una respuesta con duplicados dentro tampoco los cuela', () => {
  const estado = primeraPagina([c('c1'), c('c1'), c('c2')], null);
  assert.deepEqual(estado.lista.map((x) => x.id), ['c1', 'c2']);
});

test('la última página deja el cursor a null', () => {
  const estado = anadirPagina(primeraPagina([c('c2')], CURSOR), [c('c1')], null);
  assert.equal(estado.cursor, null);
});

// ---------------------------------------------------------------------------
// 6. Optimista y real no pueden convivir
// ---------------------------------------------------------------------------

test('el comentario no sale dos veces al llegar la respuesta real', () => {
  /*
    Secuencia: se escribe, se pinta el optimista, y ANTES de que conteste el
    POST entra una recarga que ya trae el comentario guardado. Al confirmar,
    sustituir sin mirar dejaba el real dos veces.
  */
  const conPendiente = conOptimista(primeraPagina([c('viejo')], null), c('pendiente-1', 'Hola'));
  const recargado = {
    ...conPendiente,
    lista: [c('real-1', 'Hola'), ...conPendiente.lista],
  };

  const final = confirmarOptimista(recargado, 'pendiente-1', c('real-1', 'Hola'));

  assert.deepEqual(final.lista.map((x) => x.id), ['real-1', 'viejo']);
  assert.equal(final.lista.filter((x) => x.id === 'real-1').length, 1);
});

test('confirmar no mueve el contador: ya subió al pintar el optimista', () => {
  const conPendiente = conOptimista(primeraPagina([c('viejo')], null), c('pendiente-1'));
  assert.equal(conPendiente.total, 2);
  assert.equal(confirmarOptimista(conPendiente, 'pendiente-1', c('real-1')).total, 2);
});

test('un id optimista se reconoce como tal', () => {
  assert.ok(esOptimista('pendiente-123-abc'));
  assert.equal(esOptimista('8f3a1c22-0000-4000-8000-000000000001'), false);
});
