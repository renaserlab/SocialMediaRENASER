/**
 * El bug que fija este fichero, tal como se reporto:
 *
 *   «Un usuario reacciono a los videos en la seccion de Explorar y aparece con
 *   el corazon pintado, correcto. El bug esta en la vista Inicio, ya que esos
 *   videos (que son los mismos) deben seguir con el corazon pintado.»
 *
 * La causa era que cargar el muro hacia `likedPostIds = respuesta.likedIds`, o
 * sea sustituir la lista ENTERA con la de esa pagina. Todo lo que no viniera en
 * ella perdia su me gusta, y los videos de Inicio no vienen en la pagina del
 * muro.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mezclarReacciones, textoDeReacciones } from './reacciones.ts';

test('cargar una pantalla no apaga los me gusta de la otra', () => {
  // A esta persona le gustan un video (v1, que se ve en Inicio) y una foto
  // (p1, que se ve en el muro).
  const actuales = ['v1', 'p1'];
  // Llega la pagina del MURO: solo trae fotos. No dice nada de v1.
  const resultado = mezclarReacciones(actuales, ['p1', 'p2'], ['p1']);

  assert.ok(
    resultado.includes('v1'),
    'el me gusta del video se perdio al cargar el muro: es el bug reportado',
  );
  assert.ok(resultado.includes('p1'));
  assert.equal(resultado.includes('p2'), false);
});

test('el servidor manda sobre lo que ya teniamos', () => {
  // Teniamos p1 con me gusta, pero el servidor dice que ya no (se quito desde
  // otro dispositivo). Tiene que ganar el servidor.
  const resultado = mezclarReacciones(['p1'], ['p1', 'p2'], ['p2']);

  assert.equal(resultado.includes('p1'), false, 'quedarse con la union deja pegado un me gusta retirado');
  assert.ok(resultado.includes('p2'));
});

test('una tanda vacia no toca nada', () => {
  // Una respuesta sin publicaciones no es «no le gusta nada»: es que no hay
  // nada de lo que hablar.
  assert.deepEqual(mezclarReacciones(['v1', 'p1'], [], []), ['v1', 'p1']);
});

test('las paginas que se solapan no duplican ids', () => {
  // Dos paginas pueden traer la misma publicacion. Con duplicados dentro,
  // quitar el me gusta dejaria una copia y el corazon seguiria encendido.
  const resultado = mezclarReacciones(['p1'], ['p1', 'p1'], ['p1', 'p1']);
  assert.deepEqual(resultado, ['p1']);
});

test('lo que no venia en la tanda sobrevive aunque no tenga me gusta', () => {
  const resultado = mezclarReacciones(['v1'], ['p1'], []);
  assert.deepEqual(resultado, ['v1']);
});

test('reaccionar en Inicio y luego abrir Explorar mantiene el corazon', () => {
  // El caso completo, en el orden en que ocurre en la aplicacion.
  let likes: string[] = [];

  // 1. Inicio carga sus videos. Ninguno tiene me gusta todavia.
  likes = mezclarReacciones(likes, ['v1', 'v2'], []);
  assert.deepEqual(likes, []);

  // 2. La persona reacciona a v1 (lo hace el store, no esta funcion).
  likes = [...likes, 'v1'];

  // 3. Va a Explorar, que carga el muro: fotos y TAMBIEN v1, porque las dos
  //    pantallas enseñan lo mismo. El servidor ya sabe del me gusta.
  likes = mezclarReacciones(likes, ['p1', 'v1'], ['v1']);
  assert.ok(likes.includes('v1'), 'el corazon se apago al cambiar de pantalla');

  // 4. Vuelve a Inicio, que recarga sus videos.
  likes = mezclarReacciones(likes, ['v1', 'v2'], ['v1']);
  assert.ok(likes.includes('v1'), 'el corazon se apago al volver a Inicio');
});


// ---------------------------------------------------------------------------
// Como se lee un aviso de reacciones
// ---------------------------------------------------------------------------
//
// Lo que se pidio: que cien personas dando me gusta no llenen la pantalla de
// cien avisos, sino uno que diga «Edson y 99 personas mas reaccionaron a tu
// publicacion», con el numero REAL.

test('una sola persona se lee como siempre', () => {
  assert.equal(textoDeReacciones('Edson', 1), 'A Edson le gustó tu publicación');
});

test('varias personas se agrupan con el numero real', () => {
  assert.equal(
    textoDeReacciones('Edson', 100),
    'Edson y 99 personas más reaccionaron a tu publicación',
  );
});

test('dos personas usan el singular', () => {
  // «y 1 personas más» es justo el detalle que delata una plantilla mal hecha.
  assert.equal(
    textoDeReacciones('Edson', 2),
    'Edson y 1 persona más reaccionaron a tu publicación',
  );
});

test('sin el dato se cae al texto de siempre', () => {
  // Un backend anterior a este cambio no manda `group_count`. El aviso tiene
  // que seguir leyendose bien, no quedarse a medias.
  assert.equal(textoDeReacciones('Edson', undefined), 'A Edson le gustó tu publicación');
  assert.equal(textoDeReacciones('Edson', null), 'A Edson le gustó tu publicación');
});

test('cero reacciones no dice «y -1 personas»', () => {
  // Pasa de verdad: quitar un me gusta NO borra la notificacion, asi que el
  // aviso puede sobrevivir a la reaccion que lo provoco.
  assert.equal(textoDeReacciones('Edson', 0), 'A Edson le gustó tu publicación');
});
