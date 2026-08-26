import assert from 'node:assert/strict';
import { test } from 'node:test';

import { miniaturaDePublicacion } from './miniaturaDePublicacion.ts';

/*
  Estas dos reglas son las que dejaban el perfil en negro, y por eso se fijan
  aqui y no en la vista: son una decision, no un dibujo.

  1. En una cuadricula, un video es su POSTER. Nunca el video.
  2. La clave de cache es la RUTA en Storage, no la URL firmada.
*/

const VIDEO = {
  mediaType: 'video' as const,
  mediaUrl: 'https://cdn/firmado/video.mp4?token=abc',
  mediaPath: 'uid/video.mp4',
  posterUrl: 'https://cdn/firmado/poster.jpg?token=abc',
  posterPath: 'uid/derived/1/poster.jpg',
};

test('un video en cuadricula da su poster, nunca el video', () => {
  const mini = miniaturaDePublicacion(VIDEO);
  assert.equal(mini?.uri, VIDEO.posterUrl);
  // Que no se cuele el video por ningun camino: descargarlo para una celda de
  // 120 pixeles es exactamente lo que hacia que el perfil tardara.
  assert.notEqual(mini?.uri, VIDEO.mediaUrl);
  assert.notEqual(mini?.cacheKey, VIDEO.mediaPath);
});

test('un video sin poster no cae al video: no da nada', () => {
  // Quien pinta la celda enseña su marcador con el simbolo de video. Caer al
  // archivo seria traer megas para una miniatura que ni siquiera se reproduce.
  const mini = miniaturaDePublicacion({ ...VIDEO, posterUrl: undefined, posterPath: undefined });
  assert.equal(mini, null);
});

test('la clave de cache es la ruta en Storage, no la firma', () => {
  const mini = miniaturaDePublicacion(VIDEO);
  assert.equal(mini?.cacheKey, VIDEO.posterPath);
  assert.ok(!mini?.cacheKey?.includes('token'), 'la clave no puede llevar la firma dentro');
});

test('refirmar no cambia la clave: la cuadricula sigue en disco', () => {
  /*
    Es EL caso. Las firmas caducan a la hora y cada nueva firma da una URL
    distinta. Si la clave saliera de la URL, volver a un perfil al rato
    encontraria la cache vacia y descargaria las sesenta miniaturas otra vez.
  */
  const antes = miniaturaDePublicacion(VIDEO);
  const despues = miniaturaDePublicacion({
    ...VIDEO,
    posterUrl: 'https://cdn/firmado/poster.jpg?token=OTRA-FIRMA-DISTINTA',
  });
  assert.notEqual(antes?.uri, despues?.uri, 'la URL si cambia, para eso esta firmada');
  assert.equal(antes?.cacheKey, despues?.cacheKey, 'la clave NO puede cambiar al refirmar');
});

test('una imagen usa el derivado del feed, que es lo que trae mediaPath', () => {
  const mini = miniaturaDePublicacion({
    mediaType: 'image',
    mediaUrl: 'https://cdn/firmado/feed.webp?token=abc',
    mediaPath: 'uid/derived/9/feed.webp',
  });
  assert.equal(mini?.uri, 'https://cdn/firmado/feed.webp?token=abc');
  assert.equal(mini?.cacheKey, 'uid/derived/9/feed.webp');
});

test('sin URL firmada no se inventa nada', () => {
  // Pasa de verdad: la sesion caduca y la firma en lote devuelve el mapa a
  // medias. La celda tiene que poder distinguirlo para pintar su marcador.
  assert.equal(miniaturaDePublicacion({ mediaType: 'image', mediaPath: 'uid/foto.jpg' }), null);
});

test('un audio no tiene miniatura', () => {
  // La cuadricula no los muestra: un cuadrado no dice nada de un audio.
  assert.equal(
    miniaturaDePublicacion({ mediaType: 'audio', mediaUrl: 'https://cdn/a.m4a', mediaPath: 'uid/a.m4a' }),
    null,
  );
});

test('una publicacion sin medio tampoco', () => {
  assert.equal(miniaturaDePublicacion({}), null);
});

/*
  Tercera regla, la que ahorra megas: una FOTO en una cuadricula es su
  miniatura de 400 px, no la imagen del feed de 1080. La celda mide 118 puntos.
  Con sesenta publicaciones, servir la del feed son varios megas para pintar
  sesenta cuadraditos, y ese es exactamente el rato que el perfil pasa en
  negro.
*/
test('una foto en la cuadricula usa la miniatura, no la imagen del feed', () => {
  const m = miniaturaDePublicacion({
    mediaType: 'image',
    mediaUrl: 'https://x/feed.webp?firma=1',
    mediaPath: 'uid/derived/1/feed.webp',
    posterUrl: 'https://x/thumb.webp?firma=1',
    posterPath: 'uid/derived/1/thumb.webp',
  });
  assert.equal(m?.uri, 'https://x/thumb.webp?firma=1');
  assert.equal(m?.cacheKey, 'uid/derived/1/thumb.webp');
});

test('sin miniatura, una foto sigue cayendo al derivado del feed', () => {
  // Lo publicado antes de que existiera la miniatura tiene que seguir
  // viendose igual que hasta hoy, no desaparecer.
  const m = miniaturaDePublicacion({
    mediaType: 'image',
    mediaUrl: 'https://x/feed.webp?firma=1',
    mediaPath: 'uid/derived/1/feed.webp',
  });
  assert.equal(m?.uri, 'https://x/feed.webp?firma=1');
  assert.equal(m?.cacheKey, 'uid/derived/1/feed.webp');
});
