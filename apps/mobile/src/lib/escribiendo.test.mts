import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CADA_CUANTO_AVISAR_MS,
  CADUCA_A_LOS_MS,
  CONVERSACIONES_ATENDIDAS,
  NADIE,
  NADIE_EN_NINGUNA,
  PAUSA_DEL_TONO_MS,
  anotar,
  anotarEn,
  avisoDe,
  cambioDeAtendidas,
  esDeFiar,
  esDeFiarEnBandeja,
  faltaParaCaducar,
  faltaParaCaducarAlguna,
  fraseDeEscritura,
  lasQueSeAtienden,
  leerAviso,
  limpiar,
  limpiarTodas,
  nombreDePila,
  quienesEscriben,
  quitar,
  quitarDe,
  soloDe,
  suenaElTono,
  tocaAvisar,
  tocaAvisarQueParo,
} from './escribiendo.ts';

/*
  «Está escribiendo» (12/10/2026). Lo esencial: se avisa mientras se teclea,
  el aviso caduca solo, no se le cree a cualquiera y el tono suena una vez.
*/

const T = 1_000_000;

test('se avisa al empezar a teclear y después cada cierto rato, no en cada tecla', () => {
  assert.ok(tocaAvisar('h', T, undefined));
  assert.ok(!tocaAvisar('ho', T + 100, T));
  assert.ok(!tocaAvisar('hola', T + CADA_CUANTO_AVISAR_MS - 1, T));
  assert.ok(tocaAvisar('hola ', T + CADA_CUANTO_AVISAR_MS, T));
  // Un cuadro vacío, o solo con espacios, no es estar escribiendo.
  assert.ok(!tocaAvisar('', T, undefined));
  assert.ok(!tocaAvisar('   ', T, undefined));
});

test('al vaciar el cuadro se avisa de que se paró, y solo si se había avisado', () => {
  assert.ok(tocaAvisarQueParo('', T));
  assert.ok(tocaAvisarQueParo('  ', T));
  assert.ok(!tocaAvisarQueParo('', undefined));
  assert.ok(!tocaAvisarQueParo('sigo', T));
});

test('un aviso caduca solo: aguanta que se pierda uno, y no más', () => {
  // Con el ritmo de aviso, dos seguidos perdidos ya lo apagan.
  assert.ok(CADUCA_A_LOS_MS > CADA_CUANTO_AVISAR_MS * 2);
  assert.ok(CADUCA_A_LOS_MS < CADA_CUANTO_AVISAR_MS * 3);

  const lista = anotar(NADIE, 'ana', T);
  assert.deepEqual(quienesEscriben(lista, T), ['ana']);
  assert.deepEqual(quienesEscriben(lista, T + CADUCA_A_LOS_MS - 1), ['ana']);
  assert.deepEqual(quienesEscriben(lista, T + CADUCA_A_LOS_MS), []);
  assert.equal(faltaParaCaducar(lista, T), CADUCA_A_LOS_MS);
  assert.equal(faltaParaCaducar(lista, T + CADUCA_A_LOS_MS + 50), 0);
  assert.equal(faltaParaCaducar(NADIE, T), null);

  // Un aviso nuevo de la misma persona alarga el plazo.
  const renovada = anotar(lista, 'ana', T + 2000);
  assert.deepEqual(quienesEscriben(renovada, T + CADUCA_A_LOS_MS + 1000), ['ana']);
});

test('las listas no se cambian: es el estado que hay en pantalla', () => {
  const una = anotar(NADIE, 'ana', T);
  assert.deepEqual(NADIE, {});
  const dos = anotar(una, 'luis', T + 10);
  assert.deepEqual(Object.keys(una), ['ana']);
  assert.deepEqual(quienesEscriben(dos, T + 20), ['ana', 'luis']);

  // Quitar a quien no está, o limpiar sin nada caducado, devuelve LA MISMA
  // lista: así la pantalla no repinta por nada.
  assert.equal(quitar(dos, 'nadie'), dos);
  assert.equal(limpiar(dos, T + 20), dos);
  assert.deepEqual(quitar(dos, 'ana'), { luis: T + 10 + CADUCA_A_LOS_MS });
  assert.deepEqual(limpiar(dos, T + CADUCA_A_LOS_MS + 5), { luis: T + 10 + CADUCA_A_LOS_MS });
  // Un identificador raro no saca nada heredado del objeto.
  assert.equal(quitar(dos, 'constructor'), dos);
});

test('lo que llega por el canal se lee sin fiarse de nada', () => {
  assert.deepEqual(leerAviso(avisoDe('ana', true)), { usuarioId: 'ana', escribe: true });
  assert.deepEqual(leerAviso(avisoDe('ana', false)), { usuarioId: 'ana', escribe: false });
  for (const raro of [
    null,
    undefined,
    'ana',
    7,
    {},
    { u: 'ana' },
    { u: 'ana', e: 2 },
    { u: 'ana', e: true },
    { u: '', e: 1 },
    { u: '   ', e: 1 },
    { u: 7, e: 1 },
    { u: 'x'.repeat(65), e: 1 },
  ]) {
    assert.equal(leerAviso(raro), null, JSON.stringify(raro));
  }
  // No viaja ningún nombre: no se le podría creer.
  assert.deepEqual(Object.keys(avisoDe('ana', true)).sort(), ['e', 'u']);
});

test('solo se le cree a quien está en la conversación, y nunca a uno mismo', () => {
  assert.ok(esDeFiar('ana', 'yo', ['ana', 'luis']));
  assert.ok(!esDeFiar('yo', 'yo', ['ana', 'yo']));
  assert.ok(!esDeFiar('intruso', 'yo', ['ana', 'luis']));
  assert.ok(!esDeFiar('', 'yo', null));
  // Mientras no se sabe quién está, se acepta: lo peor es un aviso de más.
  assert.ok(esDeFiar('ana', 'yo', null));
  assert.ok(!esDeFiar('yo', 'yo', null));
});

test('la frase: sin nombre entre dos, con nombre en un grupo, contando si son muchos', () => {
  assert.equal(fraseDeEscritura([], true), null);
  assert.equal(fraseDeEscritura([], false), null);
  // En un chat de dos solo puede ser la otra persona.
  assert.deepEqual(fraseDeEscritura(['Ana'], false), { clave: 'solo' });
  assert.deepEqual(fraseDeEscritura(['Ana'], true), { clave: 'uno', nombre: 'Ana' });
  assert.deepEqual(fraseDeEscritura(['Ana', 'Luis'], true), { clave: 'dos', primero: 'Ana', segundo: 'Luis' });
  assert.deepEqual(fraseDeEscritura(['Ana', 'Luis', 'Rosa'], true), { clave: 'varios', cuantos: 3 });
  // A quien no se le conoce el nombre no se le inventa uno.
  assert.deepEqual(fraseDeEscritura([''], true), { clave: 'solo' });
  assert.deepEqual(fraseDeEscritura(['Ana', ' '], true), { clave: 'varios', cuantos: 2 });
});

test('el tono suena cuando alguien empieza, una vez, y solo si se está mirando', () => {
  const base = { seEstaMirando: true, silenciada: false, momento: T, ultimoTono: undefined };
  assert.ok(suenaElTono({ ...base, antes: 0, ahora: 1 }));
  // Los avisos siguientes de la misma persona, o una segunda que se suma, no.
  assert.ok(!suenaElTono({ ...base, antes: 1, ahora: 1 }));
  assert.ok(!suenaElTono({ ...base, antes: 1, ahora: 2 }));
  // Que dejen de escribir tampoco.
  assert.ok(!suenaElTono({ ...base, antes: 1, ahora: 0 }));
  // Con el chat detrás o la conversación silenciada, callado.
  assert.ok(!suenaElTono({ ...base, antes: 0, ahora: 1, seEstaMirando: false }));
  assert.ok(!suenaElTono({ ...base, antes: 0, ahora: 1, silenciada: true }));
  // Y con una pausa mínima: quien escribe a trompicones no lo hace sonar sin parar.
  assert.ok(!suenaElTono({ ...base, antes: 0, ahora: 1, ultimoTono: T - PAUSA_DEL_TONO_MS + 1 }));
  assert.ok(suenaElTono({ ...base, antes: 0, ahora: 1, ultimoTono: T - PAUSA_DEL_TONO_MS }));
});

/* ------------------------------------------------------------------------- */
/* EN LA BANDEJA (12/10/2026): «escribiendo…» sin entrar al chat             */
/* ------------------------------------------------------------------------- */

test('la bandeja atiende sus primeras conversaciones, no todas', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `c${i}`);
  const atendidas = lasQueSeAtienden(ids);
  assert.equal(atendidas.length, CONVERSACIONES_ATENDIDAS);
  // Las primeras: la bandeja llega ordenada por el último mensaje.
  assert.deepEqual(atendidas.slice(0, 3), ['c0', 'c1', 'c2']);
  // Muy por debajo de los cien canales que el proveedor deja por teléfono.
  assert.ok(CONVERSACIONES_ATENDIDAS <= 30);
  // Sin repetidos ni vacíos.
  assert.deepEqual(lasQueSeAtienden(['a', '', 'a', 'b']), ['a', 'b']);
  assert.deepEqual(lasQueSeAtienden([]), []);
});

test('si la bandeja se reordena, no se reabre ningún canal', () => {
  assert.deepEqual(cambioDeAtendidas(['a', 'b', 'c'], ['c', 'a', 'b']), { abrir: [], cerrar: [] });
  // Entra una conversación nueva y sale la última: un alta y una baja.
  assert.deepEqual(cambioDeAtendidas(['a', 'b', 'c'], ['d', 'a', 'b']), { abrir: ['d'], cerrar: ['c'] });
  assert.deepEqual(cambioDeAtendidas([], ['a']), { abrir: ['a'], cerrar: [] });
  assert.deepEqual(cambioDeAtendidas(['a'], []), { abrir: [], cerrar: ['a'] });
});

test('quién escribe se lleva por conversación', () => {
  let todas = NADIE_EN_NINGUNA;
  todas = anotarEn(todas, 'grupo', 'katy', 1_000);
  todas = anotarEn(todas, 'grupo', 'luis', 1_500);
  todas = anotarEn(todas, 'ana', 'ana', 2_000);
  assert.deepEqual(quienesEscriben(todas.grupo ?? NADIE, 2_000), ['katy', 'luis']);
  assert.deepEqual(quienesEscriben(todas.ana ?? NADIE, 2_000), ['ana']);

  // Quien paró sale; si era el último, la conversación entera.
  todas = quitarDe(todas, 'ana', 'ana');
  assert.equal('ana' in todas, false);
  todas = quitarDe(todas, 'grupo', 'katy');
  assert.deepEqual(Object.keys(todas.grupo ?? {}), ['luis']);
});

test('quitar a quien no estaba devuelve lo mismo: ninguna fila se repinta', () => {
  const todas = anotarEn(NADIE_EN_NINGUNA, 'grupo', 'katy', 1_000);
  assert.equal(quitarDe(todas, 'grupo', 'otro'), todas);
  assert.equal(quitarDe(todas, 'no-atendida', 'katy'), todas);
});

test('lo caducado se retira de todas, y sin cambios devuelve lo mismo', () => {
  let todas = anotarEn(NADIE_EN_NINGUNA, 'grupo', 'katy', 1_000);
  todas = anotarEn(todas, 'ana', 'ana', 5_000);
  assert.equal(limpiarTodas(todas, 2_000), todas);

  const tras = limpiarTodas(todas, 1_000 + CADUCA_A_LOS_MS + 1);
  assert.equal('grupo' in tras, false, 'el aviso de Katy caducó');
  assert.equal('ana' in tras, true);
  assert.deepEqual(limpiarTodas(tras, 99_999_999), {});
});

test('el reloj se arma para el primero que caduque, en la conversación que sea', () => {
  assert.equal(faltaParaCaducarAlguna(NADIE_EN_NINGUNA, 0), null);
  let todas = anotarEn(NADIE_EN_NINGUNA, 'grupo', 'katy', 1_000);
  todas = anotarEn(todas, 'ana', 'ana', 3_000);
  assert.equal(faltaParaCaducarAlguna(todas, 3_000), CADUCA_A_LOS_MS - 2_000);
});

test('al dejar de atender una conversación, se olvida quién escribía en ella', () => {
  let todas = anotarEn(NADIE_EN_NINGUNA, 'grupo', 'katy', 1_000);
  todas = anotarEn(todas, 'ana', 'ana', 1_000);
  assert.equal(soloDe(todas, ['grupo', 'ana', 'otra']), todas);
  assert.deepEqual(Object.keys(soloDe(todas, ['ana'])), ['ana']);
  assert.deepEqual(soloDe(todas, []), {});
});

test('en la bandeja, en un chat de dos solo se le cree a la otra persona', () => {
  const directo = { esGrupo: false, otroId: 'ana' };
  assert.ok(esDeFiarEnBandeja('ana', 'yo', directo, null));
  assert.ok(!esDeFiarEnBandeja('intruso', 'yo', directo, null));
  // Nunca a uno mismo: escribir desde otro teléfono no es «te están escribiendo».
  assert.ok(!esDeFiarEnBandeja('yo', 'yo', directo, null));
  assert.ok(!esDeFiarEnBandeja('', 'yo', directo, null));
});

test('en un grupo se acepta mientras no se sabe quién está, y después solo a los miembros', () => {
  const grupo = { esGrupo: true };
  assert.ok(esDeFiarEnBandeja('katy', 'yo', grupo, null));
  assert.ok(esDeFiarEnBandeja('katy', 'yo', grupo, ['yo', 'katy']));
  assert.ok(!esDeFiarEnBandeja('intruso', 'yo', grupo, ['yo', 'katy']));
  assert.ok(!esDeFiarEnBandeja('yo', 'yo', grupo, ['yo', 'katy']));
});

test('en la fila cabe el nombre de pila, no el nombre entero', () => {
  assert.equal(nombreDePila('Katy Béjar Román'), 'Katy');
  assert.equal(nombreDePila('  Luis  '), 'Luis');
  assert.equal(nombreDePila(''), '');
  assert.equal(nombreDePila(undefined), '');
});
