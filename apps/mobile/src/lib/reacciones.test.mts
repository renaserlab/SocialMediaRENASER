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

import { mezclarReacciones } from './reacciones.ts';

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
